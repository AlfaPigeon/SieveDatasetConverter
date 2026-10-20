// Core pipeline: import -> map to a schema -> metadata -> sample & write to DuckDB.
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import os from 'node:os';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const DL_DIR = path.join(DATA_DIR, 'downloads');
fs.mkdirSync(DL_DIR, { recursive: true });

import { getSchema } from './schemas.js';

const datasets = new Map(); // dataset_id -> state
// Memory guards. DuckDB gets a memory limit (SIEVE_DUCKDB_MEMORY, default 25% of RAM) and spills to DATA_DIR/.tmp;
// JS-side reads stop with a clean error when the process RSS passes SIEVE_MAX_RSS_MB (default 50% of RAM).
const GB = 1024 ** 3;
export const LIMITS = {
  duckdb_memory: process.env.SIEVE_DUCKDB_MEMORY || `${Math.max(1, Math.floor(os.totalmem() * 0.25 / GB))}GB`,
  max_rss_mb: +process.env.SIEVE_MAX_RSS_MB || Math.floor(os.totalmem() * 0.5 / 2 ** 20),
  max_rows: +process.env.SIEVE_MAX_ROWS || 5_000_000, // rows of one import (after explode)
};
function memoryGuard(what) {
  const mb = process.memoryUsage().rss / 2 ** 20;
  if (mb > LIMITS.max_rss_mb) throw Object.assign(new Error(`${what}: Sieve is using ${Math.round(mb)} MB (limit SIEVE_MAX_RSS_MB=${LIMITS.max_rss_mb}). Use fewer rows or columns, a smaller limit or a where filter.`), { kind: 'memory' });
}
const oomHint = (e) => {
  if (/Out of Memory/i.test(e?.message) && !e.kind) Object.assign(e, { kind: 'memory', message: `${e.message.split('\n')[0]} [DuckDB memory limit SIEVE_DUCKDB_MEMORY=${LIMITS.duckdb_memory}: use fewer rows or columns]` });
  return e;
};
let mem;
async function memConn() {
  if (!mem) {
    mem = await (await DuckDBInstance.create(':memory:')).connect();
    const tmp = path.join(DATA_DIR, '.tmp'); fs.mkdirSync(tmp, { recursive: true });
    await mem.run(`SET memory_limit = ${q(LIMITS.duckdb_memory)}`);
    await mem.run(`SET temp_directory = ${q(tmp)}`);
  }
  return mem;
}
const duckSrc = (alias, t) => `${alias}.${t.split('.').map((x) => `"${x.replace(/"/g, '""')}"`).join('.')}`;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function detectFormat(p) {
  const l = p.toLowerCase().split('?')[0];
  if (l.endsWith('.parquet')) return 'parquet';
  if (l.endsWith('.duckdb') || l.endsWith('.db')) return 'duckdb';
  if (l.endsWith('.csv') || l.endsWith('.tsv')) return 'csv';
  if (l.endsWith('.jsonl') || l.endsWith('.ndjson')) return 'jsonl';
  if (l.endsWith('.json')) return 'json';
  return null;
}
function readerSql(file, format, list = q(file)) {
  if (format === 'parquet') return `read_parquet(${list})`;
  if (format === 'csv') return `read_csv_auto(${list}, header=true)`;
  if (format === 'jsonl') return `read_json_auto(${list}, format='newline_delimited')`;
  return `read_json_auto(${list})`;
}

// Hugging Face: "owner/name", "hf://datasets/owner/name", or https://huggingface.co/datasets/owner/name[...]
function parseHf(url) {
  const m = url.match(/^(?:hf:\/\/datasets\/|https?:\/\/huggingface\.co\/datasets\/)?([\w.-]+\/[\w.-]+)\/?(?:$|[?#]|\/(?:viewer|tree)\b)/);
  if (!m || /^https?:\/\//.test(url) && !url.includes('huggingface.co/datasets/')) return null;
  if (/\.(csv|tsv|json|jsonl|ndjson|parquet)(\?|$)/i.test(url)) return null; // direct file
  return m[1];
}
const hfHeaders = () => (process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {});
// Clear errors for the usual failures: gated/private repos and script-only datasets.
function hfError(repo, status, msg = '') {
  const e = (kind, m) => Object.assign(new Error(m), { kind });
  if (/script|arbitrary python/i.test(msg))
    return e('script', `${repo} is built by a loading script and has no Parquet export (refs/convert/parquet), so Sieve can't read it. Point Sieve at the dataset's data files by URL instead.`);
  if (status === 401 || status === 403 || /gated|restricted|without authentication/i.test(msg))
    return e('gated', `${repo} is gated or private and HF_TOKEN has no access (HTTP ${status}). If it is gated, request access on https://huggingface.co/datasets/${repo} with the account whose HF_TOKEN Sieve uses${process.env.HF_TOKEN ? '' : ' (HF_TOKEN is not set)'}.`);
  return e('other', `Hugging Face (${repo}): ${String(msg || `HTTP ${status}`).slice(0, 200)}`);
}
async function hfFetch(repo, url) {
  const r = await fetch(url, { headers: hfHeaders() });
  if (!r.ok) {
    const t = await r.text(); let m = t; try { m = JSON.parse(t).error || t; } catch {}
    throw hfError(repo, r.status, String(m));
  }
  return r.json();
}
const hfApi = (endpoint, repo) => hfFetch(repo, `https://datasets-server.huggingface.co/${endpoint}?dataset=${encodeURIComponent(repo)}`);
// Configs and splits (with row counts when available) for a Hugging Face dataset.
export async function hfSplits(name) {
  const repo = parseHf(String(name).trim());
  if (!repo) throw new Error('Not a Hugging Face dataset name');
  const [sp, info] = await withAccess(repo, () => Promise.all([hfApi('splits', repo), hfApi('size', repo).catch(() => null)]));
  const rows = new Map((info?.size?.splits || []).map((x) => [`${x.config}/${x.split}`, x.num_rows]));
  return { dataset: repo, splits: sp.splits.map(({ config, split }) => ({ config, split, rows: rows.get(`${config}/${split}`) ?? null })) };
}
// Parquet shards for one config/split (default: a config that has a train split).
// datasets-server first; if that fails, list the Hub's refs/convert/parquet branch directly.
// HF auth-check first: a gated repo without access fails here the same way whatever config/split was asked
// (the datasets-server answers 404 for some and file reads 403 for others).
async function hfAccess(repo) {
  let r; try { r = await fetch(`https://huggingface.co/api/datasets/${repo}/auth-check`, { headers: hfHeaders() }); } catch { return false; }
  if (r.ok) return true;
  const t = await r.text().catch(() => ''); let m = t; try { m = JSON.parse(t).error || t; } catch {}
  if (r.status === 401 || r.status === 403) throw Object.assign(hfError(repo, r.status, String(m)), { access: true, status: r.status });
  if (r.status === 404) throw Object.assign(new Error(`${repo} was not found on Hugging Face (or it is private and HF_TOKEN has no access${process.env.HF_TOKEN ? '' : '; HF_TOKEN is not set'}).`), { kind: 'gated', access: true, status: 404 });
}
// Run an HF call after the access check. A "private or gated" answer from the datasets-server after access
// passed means the dataset has no viewer data, not missing access.
async function withAccess(repo, fn) {
  const checked = await hfAccess(repo);
  try { return await fn(); } catch (e) {
    if (checked && e.kind === 'gated' && !e.access) throw Object.assign(new Error(`Hugging Face has no viewer/Parquet data for ${repo} (${String(e.message).slice(0, 160)})`), { kind: 'other' });
    throw e;
  }
}
async function hfShards(repo, opts = {}) {
  return withAccess(repo, () => hfShardsAny(repo, opts));
}
async function hfShardsAny(repo, opts = {}) {
  try { return await hfShardsApi(repo, opts); } catch (e) {
    try { return await hfShardsHub(repo, opts); } catch (e2) {
      throw e2.kind === 'gated' || e.kind === 'other' && e2.kind !== 'other' ? e2 : e;
    }
  }
}
async function hfShardsHub(repo, { config, split } = {}) {
  const tree = async (p) => {
    try { return await hfFetch(repo, `https://huggingface.co/api/datasets/${repo}/tree/refs%2Fconvert%2Fparquet${p}`); } catch (e) {
      if (e.kind === 'other') throw hfError(repo, 0, 'no Parquet export: the dataset may use a loading script');
      throw e;
    }
  };
  const dirs = (l) => l.filter((x) => x.type === 'directory').map((x) => x.path.split('/').pop());
  const configs = dirs(await tree(''));
  if (config && !configs.includes(config)) throw new Error(`No parquet for config=${config}`);
  // Prefer "default", then the first config that has the wanted split (train by default).
  const order = config ? [config] : [...configs.filter((x) => x === 'default'), ...configs.filter((x) => x !== 'default')].slice(0, 20);
  for (const cfg of order) {
    const splits = dirs(await tree(`/${encodeURIComponent(cfg)}`));
    const sp = split || (splits.includes('train') ? 'train' : config || order.length === 1 ? splits[0] : null);
    if (!sp || !splits.includes(sp)) continue;
    const files = (await tree(`/${encodeURIComponent(cfg)}/${encodeURIComponent(sp)}`)).filter((x) => x.path.endsWith('.parquet')).map((x) => x.path).sort();
    if (files.length) return { config: cfg, split: sp, urls: files.map((f) => `https://huggingface.co/datasets/${repo}/resolve/refs%2Fconvert%2Fparquet/${f}`), listing: 'hub' };
  }
  throw new Error(`No parquet for config=${config || '(any)'} split=${split || 'train'}`);
}
async function hfShardsApi(repo, { config, split } = {}) {
  const files = (await hfApi('parquet', repo)).parquet_files || [];
  if (!files.length) throw hfError(repo, 0, 'no Parquet export: the dataset may use a loading script');
  const match = files.filter((f) => (!config || f.config === config) && (!split || f.split === split));
  if (!match.length) throw new Error(`No parquet for config=${config} split=${split}`);
  const first = match.find((f) => f.split === 'train' && f.config === 'default') || match.find((f) => f.split === 'train') || match[0];
  const shards = match.filter((f) => f.config === first.config && f.split === first.split);
  return { config: first.config, split: first.split, urls: shards.map((f) => f.url) };
}
const parseLimit = (l) => (l == null || l === '' ? 10000 : String(l).toLowerCase() === 'all' ? null : Math.max(1, parseInt(l, 10) || 10000));
const limited = (src, limit) => (limit ? `(SELECT * FROM ${src} LIMIT ${limit})` : src);
async function download(url, dest, headers = {}) {
  const r = await fetch(url, { headers, redirect: 'follow' });
  if (!r.ok) throw new Error(`Download failed ${r.status} for ${url}`);
  // streamed to disk (a shard can be GBs)
  try { await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(dest)); } catch (e) { fs.rmSync(dest, { force: true }); throw e; }
}
const countRows = async (c, f) => Number((await c.runAndReadAll(`SELECT count(*) n FROM read_parquet(${q(f)})`)).getRowObjectsJson()[0].n);
const ident = (n) => `"${String(n).replace(/"/g, '""')}"`;
// source_row of HF rows = shard * SHARD + row within the shard: stable across imports, limits and fetch modes.
const SHARD = 1e9;
const ROWCOL = '_sieve_row';

// DuckDB httpfs: lets read_parquet() fetch only the row groups it needs over HTTP range requests.
// If the extension isn't installed, fetch it ourselves (DuckDB's own installer can hang behind some proxies).
let httpfsReady;
function ensureHttpfs(c) {
  httpfsReady ||= (async () => {
    try { await c.run('LOAD httpfs'); } catch {
      const { v, p } = (await c.runAndReadAll('SELECT version() v, (SELECT platform FROM pragma_platform()) p')).getRowObjectsJson()[0];
      const r = await fetch(`https://extensions.duckdb.org/${v}/${p}/httpfs.duckdb_extension.gz`);
      if (!r.ok) throw new Error(`httpfs download failed (${r.status})`);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sieve-ext-')), f = path.join(dir, 'httpfs.duckdb_extension');
      fs.writeFileSync(f, zlib.gunzipSync(Buffer.from(await r.arrayBuffer())));
      await c.run(`INSTALL ${q(f)}`); await c.run('LOAD httpfs');
    }
    await c.run('SET parquet_metadata_cache = true');
    await c.run("CALL enable_logging('HTTP')").catch(() => {}); // to report network_bytes of partial fetches
    if (process.env.HF_TOKEN) await c.run(`CREATE OR REPLACE SECRET sieve_hf (TYPE http, SCOPE 'https://huggingface.co', EXTRA_HTTP_HEADERS MAP {'Authorization': ${q('Bearer ' + process.env.HF_TOKEN)}})`);
  })().catch((e) => { httpfsReady = null; throw e; });
  return httpfsReady;
}
const httpError = (repo, e) => { const m = String(e.message || e), s = +(m.match(/\b(401|403)\b/) || [])[1]; return s ? hfError(repo, s, m) : e; };
const seededShuffle = (arr, seed) => { const a = [...arr], r = rng(seed); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// Partial HF fetch into small local files, reading only the needed columns and row groups.
// fetch="random" (default): seeded random rows from seeded random row groups of up to 16 shards. Each group gives at most
// max_rows_per_group rows (default ceil(limit/16), so >= 16 groups when there are that many), or the sample is spread
// over `row_groups` groups. More groups = better spread but more bytes (a group's column chunks are read whole).
// fetch="head": the first `limit` rows.
async function fetchHfRemote(c, repo, urls, limit, id, { fetch: mode = 'random', seed = 42, columns, row_groups, max_rows_per_group, info } = {}) {
  await ensureHttpfs(c);
  await c.run('CALL truncate_duckdb_logs()').catch(() => {});
  try { return await fetchHfRemoteInner(c, repo, urls, limit, id, { mode, seed, columns, row_groups, max_rows_per_group, info }); } finally {
    if (info) {
      info.network_bytes = await c.runAndReadAll(`SELECT coalesce(sum(TRY_CAST(response.headers['content-length'] AS BIGINT)), 0)::BIGINT n
        FROM duckdb_logs_parsed('HTTP') WHERE request.type = 'GET'`).then((r) => Number(r.getRowObjectsJson()[0].n)).catch(() => undefined);
      // DuckDB keeps remote blocks in memory, so a re-import in the same process downloads little or nothing:
      // data_bytes = compressed column chunks the read needed (Parquet metadata), cached_bytes = the part not downloaded.
      if (info.data_bytes != null && info.network_bytes != null) info.cached_bytes = Math.max(0, info.data_bytes - info.network_bytes);
    }
  }
}
async function fetchHfRemoteInner(c, repo, urls, limit, id, { mode, seed, columns, row_groups, max_rows_per_group, info }) {
  const proj = columns?.length ? columns.map(ident).join(', ') : '* EXCLUDE (file_row_number)';
  const sel = (u, i, cond = '') => `SELECT ${proj}, file_row_number + ${i * SHARD} AS ${ROWCOL} FROM read_parquet(${q(u)}, file_row_number=true)${cond}`;
  const files = []; let have = 0;
  // row groups of a shard: rows and compressed bytes of the fetched columns
  const groupsOf = async (u) => (await c.runAndReadAll(`SELECT row_group_id g, max(row_group_num_rows) n,
      sum(total_compressed_size) FILTER (WHERE ${columns?.length ? `split_part(path_in_schema, ', ', 1) IN (${columns.map(q).join(', ')})` : 'TRUE'})::BIGINT bytes
      FROM parquet_metadata(${q(u)}) GROUP BY 1 ORDER BY 1`)).getRowObjectsJson().map((g) => ({ n: +g.n, bytes: +g.bytes || 0 }));
  if (info) info.data_bytes = 0;
  try {
    if (mode === 'head') {
      for (const [i, u] of urls.entries()) {
        const f = path.join(DL_DIR, `${id}-${i}.parquet`);
        await c.run(`COPY (${sel(u, i)} LIMIT ${limit - have}) TO ${q(f)} (FORMAT parquet)`);
        files.push(f); const got = await countRows(c, f); have += got;
        if (info) { let r = 0; for (const g of await groupsOf(u)) { if (r >= got) break; r += g.n; info.data_bytes += g.bytes; } }
        if (have >= limit) break;
      }
      return files;
    }
    const shards = seededShuffle(urls.map((u, i) => ({ u, i })), seed).slice(0, 16);
    const groups = [];
    for (const { u, i } of shards) {
      let start = 0;
      for (const g of await groupsOf(u)) groups.push({ u, i, start: (start += g.n) - g.n, n: g.n, bytes: g.bytes });
    }
    const G = Math.min(groups.length, Math.max(1, row_groups > 0 ? +row_groups : Math.ceil(limit / (max_rows_per_group > 0 ? +max_rows_per_group : Math.ceil(limit / 16)))));
    const per = Math.ceil(limit / G);
    const take = [];
    for (const [k, g] of seededShuffle(groups, seed + 1).entries()) {
      if (have >= limit) break;
      const n = Math.min(per, g.n, limit - have);
      // a seeded random subset of the group's rows (all of them when n = group size)
      const rows = n >= g.n ? null : seededShuffle(Array.from({ length: g.n }, (_, j) => g.start + j), seed + 2 + k).slice(0, n).sort((a, b) => a - b);
      take.push({ ...g, size: g.n, n, rows }); have += n;
    }
    if (info) { info.row_groups = take.length; info.data_bytes = take.reduce((a, g) => a + g.bytes, 0); }
    for (const i of [...new Set(take.map((g) => g.i))].sort((a, b) => a - b)) {
      const parts = take.filter((g) => g.i === i).sort((a, b) => a.start - b.start)
        .map((g) => `(${sel(g.u, i, ` WHERE file_row_number BETWEEN ${g.start} AND ${g.start + g.size - 1}${g.rows ? ` AND file_row_number IN (${g.rows.join(',')})` : ''}`)})`);
      const f = path.join(DL_DIR, `${id}-${i}.parquet`);
      await c.run(`COPY (${parts.join(' UNION ALL ')}) TO ${q(f)} (FORMAT parquet)`);
      files.push(f);
    }
    return files;
  } catch (e) { throw httpError(repo, e); }
}
// Small limits: datasets-server /rows API, 100 rows per request (first rows).
async function fetchHfRows(c, repo, hf, limit, id, info = {}) {
  const rows = []; info.rows_api_bytes = 0;
  for (let off = 0; off < limit; off += 100) {
    const j = await hfFetch(repo, `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(repo)}&config=${encodeURIComponent(hf.config)}&split=${encodeURIComponent(hf.split)}&offset=${off}&length=${Math.min(100, limit - off)}`);
    const page = j.rows || []; info.rows_api_bytes += Buffer.byteLength(JSON.stringify(j));
    hf.features ||= Object.fromEntries((j.features || []).map((x) => [x.name, x.type]));
    rows.push(...page.map((x) => ({ ...x.row, [ROWCOL]: x.row_idx })));
    if (page.length < 100) break;
  }
  if (!rows.length) throw new Error('rows API returned no rows');
  const tmp = path.join(DL_DIR, `${id}-rows.jsonl`), f = path.join(DL_DIR, `${id}-0.parquet`);
  fs.writeFileSync(tmp, rows.map((x) => JSON.stringify(x)).join('\n'));
  try { await c.run(`COPY (SELECT * FROM read_json_auto(${q(tmp)}, format='newline_delimited')) TO ${q(f)} (FORMAT parquet)`); } finally { fs.rmSync(tmp, { force: true }); }
  return [f];
}
// Full shards, one at a time, stopping once `limit` rows are on disk (limit=all, or when remote reads fail).
async function fetchHfFull(c, repo, urls, limit, id) {
  const files = []; let have = 0;
  for (const [i, u] of urls.entries()) {
    const f = path.join(DL_DIR, `${id}-${i}.parquet`);
    try { await download(u, f, hfHeaders()); } catch (e) { const s = +(String(e.message).match(/\b(401|403)\b/) || [])[1]; throw s ? hfError(repo, s) : e; }
    files.push(f);
    have += await countRows(c, f);
    if (limit && have >= limit) break;
  }
  return files;
}
// Files this process downloaded for a dataset (everything in DL_DIR named "<id>-*" or "<id>.*").
const ownFiles = (id) => fs.readdirSync(DL_DIR).filter((f) => (id ? f.startsWith(`${id}-`) || f.startsWith(`${id}.`) : true)).map((f) => path.join(DL_DIR, f));
const bytesOf = (files) => files.reduce((n, f) => n + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
// Delete downloads of one dataset (or all). Datasets that read from them can no longer be previewed/written.
export async function cleanupDownloads(id) {
  const files = ownFiles(id), bytes = bytesOf(files);
  const c = await memConn();
  for (const st of datasets.values()) {
    if (!st.src.includes(path.join(DL_DIR, id || ''))) continue; // reads from the deleted files
    if (st.format === 'duckdb') await c.run(`DETACH DATABASE IF EXISTS src_${st.dataset_id}`).catch(() => {});
    st.cleaned = true;
  }
  for (const f of files) fs.rmSync(f, { force: true });
  return { dataset_id: id || null, files_deleted: files.length, bytes_freed: bytes };
}

// HF dataset features (ClassLabel names etc.): parquet "huggingface" key-value metadata, or the /rows API's feature list.
async function parquetFeatures(c, fileOrUrl) {
  try {
    const r = (await c.runAndReadAll(`SELECT decode(value) v FROM parquet_kv_metadata(${q(fileOrUrl)}) WHERE decode(key) = 'huggingface' LIMIT 1`)).getRowObjectsJson();
    return r.length ? JSON.parse(r[0].v).info?.features || null : null;
  } catch { return null; }
}
// ClassLabel names by column path, also inside structs and lists ("answers.label" for answers: {label: ClassLabel}).
const classLabels = (features) => {
  const out = {};
  const walk = (t, p) => {
    if (!t || typeof t !== 'object') return;
    if (Array.isArray(t)) return walk(t[0], p);
    if (t._type === 'ClassLabel') { if (t.names) out[p] = t.names; return; }
    if (t._type) return walk(t.feature, p); // Sequence / List / LargeList
    for (const [k, v] of Object.entries(t)) walk(v, p ? `${p}.${k}` : k);
  };
  walk(features, '');
  return out;
};
const labelsFor = (st, ref) => { // ClassLabel names for a column ref: full path without indexes, then the root
  const p = String(ref || '').replace(/\[(\d+|\*)\]/g, '');
  return st.class_labels?.[p] || st.class_labels?.[p.split('.')[0]] || null;
};
// Sidecar "<id>.origin.json" next to HF downloads, so re-importing a downloaded file keeps its HF origin and features.
const sidecarFor = (file) => {
  const m = path.basename(file).match(/^([0-9a-f]{8})-\d+\.parquet$/);
  const p = m && path.join(path.dirname(file), `${m[1]}.origin.json`);
  return p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

// Column refs given to an import (mapping, metadata, field_options sources), for column pruning and explode.extract.
const importRefs = (opts) => [...[opts.mapping, ...(opts.splits || []).map((p) => p?.mapping)].filter(Boolean).flatMap((m) => Object.values(m).flat()),
  ...(Array.isArray(opts.metadata) ? opts.metadata.map((e) => e?.column) : []),
  ...[opts.field_options, ...(opts.splits || []).map((p) => p?.field_options)].flatMap((x) => Object.values(x || {}))
    .flatMap((fo) => [fo?.gold_from?.column, fo?.value_from?.column, ...(fo?.gold_from?.argmax_of || [])])]
  .filter((x) => x != null && x !== 'source_row').map(String);
// Columns an import needs: explicit `columns`, else the roots of mapping/metadata column refs plus columns named in `where`.
function neededColumns(names, opts) {
  if (opts.columns?.length) {
    const bad = opts.columns.filter((x) => !names.includes(x));
    if (bad.length) throw new Error(`Unknown columns: ${bad.join(', ')}. Columns: ${names.join(', ')}`);
    return opts.columns;
  }
  const maps = [opts.mapping, ...(opts.splits || []).map((p) => p?.mapping)].filter(Boolean);
  const ex = opts.explode && (typeof opts.explode === 'string' ? opts.explode : opts.explode.column);
  const refs = [...maps.flatMap((m) => Object.values(m).flat()), ...(Array.isArray(opts.metadata) ? opts.metadata.map((e) => e?.column) : []), ...(ex ? [ex] : [])]
    .filter((x) => x != null && x !== 'source_row').map(String);
  if (!refs.length) return null;
  const used = new Set(refs.map((r) => (names.includes(r) ? r : r.split(/[.[]/)[0])).filter((n) => names.includes(n)));
  for (const p of [opts.where, ...(opts.splits || []).map((x) => x?.where)].filter(Boolean))
    for (const n of names) if (new RegExp(`(^|[^\\w])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w])`).test(p)) used.add(n);
  for (const fo of [opts.field_options, ...(opts.splits || []).map((p) => p?.field_options)].flatMap((x) => Object.values(x || {})))
    for (const g of [fo?.gold_from?.column, fo?.value_from?.column, ...(fo?.gold_from?.argmax_of || [])].filter(Boolean).map((x) => String(x).split(/[.[]/)[0])) if (names.includes(g)) used.add(g);
  return used.size ? [...used] : null;
}
// Local files to re-import: a dataset_id (its files in data/downloads) or a glob pattern.
async function localFiles(c, url) {
  if (/^[0-9a-f]{8}$/.test(url)) {
    const f = ownFiles(url).filter((x) => /-\d+\.parquet$/.test(x)).sort((a, b) => +a.match(/-(\d+)\.parquet$/)[1] - +b.match(/-(\d+)\.parquet$/)[1]);
    if (!f.length) throw new Error(`No downloaded files for dataset_id ${url} in data/downloads`);
    return f;
  }
  if (/[*?]/.test(url) && !/^https?:/.test(url)) {
    const f = (await c.runAndReadAll(`SELECT file FROM glob(${q(path.resolve(url))}) ORDER BY 1`)).getRowObjectsJson().map((x) => x.file);
    if (!f.length) throw new Error(`No files match ${url}`);
    return f;
  }
  return fs.existsSync(url) ? [path.resolve(url)] : null;
}
const fileList = (files) => (files.length > 1 ? `[${files.map(q).join(', ')}]` : q(files[0]));

export async function importDataset(url, opts = {}) {
  url = String(url).trim();
  const id = crypto.randomUUID().slice(0, 8);
  const limit = parseLimit(opts.limit);
  const c = await memConn();
  const local = await localFiles(c, url);
  let format = opts.format || detectFormat(local ? local[0] : url), hf = null, src, tables = null, table = null, files = [], origin = null, features = null;
  const repo = local ? null : parseHf(url);
  if (repo) {
    // limit: read only the needed rows remotely (httpfs; /rows API for <= 1000); else (or on failure) download whole shards.
    hf = await hfShards(repo, opts); format = 'parquet';
    let columns = null;
    // limit "all" with explicit columns: read just those columns of every shard remotely, not whole shards
    const remoteAll = !limit && opts.columns?.length;
    if (limit || remoteAll) {
      await ensureHttpfs(c);
      try {
        const names = (await c.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet(${q(hf.urls[0])})`)).getRowObjectsJson().map((r) => r.column_name);
        columns = neededColumns(names, opts);
      } catch (e) { if (opts.columns?.length || e.kind) throw e; }
    }
    const fetchOpts = { fetch: opts.fetch === 'head' ? 'head' : 'random', seed: intOr(opts.seed, 42), columns, row_groups: intOr(opts.row_groups, 0), max_rows_per_group: intOr(opts.max_rows_per_group, 0), info: {} };
    if (remoteAll) fetchOpts.fetch = 'head';
    const tries = limit || remoteAll ? [['httpfs', () => fetchHfRemote(c, repo, hf.urls, limit || Number.MAX_SAFE_INTEGER, id, fetchOpts)]] : [];
    if (limit && limit <= 1000 && fetchOpts.fetch === 'head') tries.push(['rows-api', () => fetchHfRows(c, repo, hf, limit, id, fetchOpts.info)]);
    tries.push(['download', () => fetchHfFull(c, repo, hf.urls, limit, id)]);
    for (const [via, fn] of tries) {
      try { files = await fn(); hf.via = via; break; } catch (e) {
        ownFiles(id).forEach((f) => fs.rmSync(f, { force: true }));
        oomHint(e); // a bigger route would not fit either
        if (e.kind === 'gated' || e.kind === 'memory' || via === 'download') throw e;
        hf.errors = [...(hf.errors || []), `${via}: ${String(e.message || e).slice(0, 200)}`];
      }
    }
    // network_bytes is reported for every route: httpfs = HTTP response bytes, rows-api = response bodies, download = files
    if (hf.via === 'download') hf.network_bytes = bytesOf(files);
    if (hf.via === 'rows-api') hf.network_bytes = fetchOpts.info.rows_api_bytes;
    if (hf.via === 'httpfs') Object.assign(hf, { fetch: fetchOpts.fetch, ...(fetchOpts.fetch === 'random' && { seed: fetchOpts.seed, row_groups: fetchOpts.info.row_groups }), network_bytes: fetchOpts.info.network_bytes, data_bytes: fetchOpts.info.data_bytes, cached_bytes: fetchOpts.info.cached_bytes, ...(columns && { columns }) });
    features = hf.features || await parquetFeatures(c, files[0]) || (hf.via === 'httpfs' && await parquetFeatures(c, hf.urls[0]));
    hf.shards = `${new Set(files.map((f) => f.match(/-(\d+)\.parquet$/)[1])).size}/${hf.urls.length}`;
    origin = { repo, config: hf.config, split: hf.split, url: `https://huggingface.co/datasets/${repo}`, limit };
    fs.writeFileSync(path.join(DL_DIR, `${id}.origin.json`), JSON.stringify({ origin, features }));
    src = hf.via === 'download' // whole shards: number rows per shard like the partial path
      ? `(${files.map((f) => `SELECT * EXCLUDE (file_row_number), file_row_number + ${+f.match(/-(\d+)\.parquet$/)[1] * SHARD} AS ${ROWCOL} FROM read_parquet(${q(f)}, file_row_number=true)`).join(' UNION ALL BY NAME ')})`
      : `read_parquet([${files.map(q).join(', ')}], union_by_name=true)`;
  } else {
    if (!format) throw new Error('Cannot detect format; pass format (csv|json|jsonl|parquet|duckdb)');
    let list = local;
    if (!list) {
      const file = path.join(DL_DIR, `${id}.${format}`); list = files = [file];
      const u = url.includes('huggingface.co/') ? url.replace('/blob/', '/resolve/') : url;
      await download(u, file, u.includes('huggingface.co/') ? hfHeaders() : {});
    }
    src = format === 'parquet' ? `read_parquet(${fileList(list)}, union_by_name=true)` : readerSql(list.length > 1 ? null : list[0], format, fileList(list));
    if (format === 'parquet') {
      const side = sidecarFor(list[0]); // a file Sieve downloaded from HF earlier
      origin = side?.origin || null; features = side?.features || await parquetFeatures(c, list[0]);
    }
    if (format === 'duckdb') {
      const alias = `src_${id}`;
      await c.run(`ATTACH ${q(list[0])} AS ${alias} (READ_ONLY)`);
      tables = (await c.runAndReadAll(`SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = ${q(alias)} ORDER BY 1, 2`))
        .getRowObjectsJson().map((t) => (t.schema_name === 'main' ? t.table_name : `${t.schema_name}.${t.table_name}`));
      if (!tables.length) throw new Error('No tables in DuckDB source');
      table = opts.table || tables[0];
      if (!tables.includes(table)) throw new Error(`Unknown table "${table}". Tables: ${tables.join(', ')}`);
      src = duckSrc(alias, table);
    }
    if (local) url = local.length > 1 ? `${path.basename(local[0])} (+${local.length - 1} files)` : path.basename(local[0]); // keep local paths out of results
  }
  src = limited(src, limit);
  const describe = async (x) => (await c.runAndReadAll(`DESCRIBE SELECT * FROM ${x}`)).getRowObjectsJson().map((r) => ({ name: r.column_name, type: r.column_type }));
  let cols = await describe(src);
  let explode = null;
  if (opts.explode) {
    const e = await explodeFiles(c, src, cols, opts.explode, path.join(DL_DIR, `${id}-explode`), importRefs(opts));
    explode = { ...e.explode, batches: e.files.length, file_bytes: bytesOf(e.files) };
    src = `read_parquet([${e.files.map(q).join(', ')}], union_by_name=true)`; cols = await describe(src);
  }
  const rowCol = cols.some((x) => x.name === ROWCOL);
  cols = cols.filter((x) => x.name !== ROWCOL);
  const rowCount = Number((await c.runAndReadAll(`SELECT count(*) n FROM ${src}`)).getRowObjectsJson()[0].n);
  if (origin) url = origin.url;
  const name = origin?.repo || path.basename(url.split('?')[0]).replace(/\.\w+$/, '');
  const st = {
    dataset_id: id, url, src, row_col: rowCol, limit, tables, table, format, columns: cols, row_count: rowCount, origin,
    source_key: origin ? `hf:${origin.repo}/${origin.config}/${origin.split}` : `${format}:${url}${table ? `#${table}` : ''}`,
    hf: hf && { repo, config: hf.config, split: hf.split, shards: hf.shards, via: hf.via, ...(hf.fetch && { fetch: hf.fetch }), ...(hf.seed != null && { seed: hf.seed }), ...(hf.row_groups && { row_groups: hf.row_groups }), ...(hf.network_bytes != null && { network_bytes: hf.network_bytes, data_bytes: hf.data_bytes, cached_bytes: hf.cached_bytes }), ...(hf.columns && { columns: hf.columns }), ...(hf.listing && { listing: hf.listing }), ...(hf.errors && { fallback_errors: hf.errors }) },
    files, download_bytes: bytesOf(files), class_labels: classLabels(features),
    metadata: [{ key: 'name', value: name }, { key: 'domain', value: 'general' }, { key: 'source', value: url }],
    meta_column: null, field_options: {}, ...(explode && { explode }),
    schema: null, mapping: {}, overrides: {},
  };
  useSchema(st, opts.schema || 'default');
  if (opts.mapping) Object.assign(st.mapping, normMapping(st, opts.mapping));
  if (opts.field_options) st.field_options = normFieldOptions(st, opts.field_options);
  datasets.set(id, st);
  return summary(st);
}

// explode: one row per element of a list column or path, materialised by DuckDB into "<id>-explode.parquet".
// The element goes into `as` (default: the column, or the path's last name); the list itself is dropped. Added columns:
// explode_step (0-based), explode_steps, and with `history` (N, or true = up to EXPLODE_HISTORY) explode_history = the
// preceding N elements. `extract: {name: path}` keeps values of the source row (e.g. the first message) as columns.
// source_row = source row × 1000 + step (lists are cut at 1000 elements).
const EXPLODE_MAX = 1000, EXPLODE_HISTORY = 100;
const EXPLODE_BATCH_BYTES = (+process.env.SIEVE_EXPLODE_BATCH_MB || 4) * 2 ** 20;
async function explodeFiles(c, src, cols, ex, outBase, refs = []) {
  ex = typeof ex === 'string' ? { column: ex } : ex || {};
  if (!ex.column) throw new Error('explode needs a column or path');
  const st = { columns: cols.filter((x) => x.name !== ROWCOL), src };
  const ref = checkRef(st, ex.column, 'explode'), root = ref.split(/[.[]/)[0];
  let list = await pathExpr(c, st, ref, 'explode', { list: true });
  const as = ex.as || (ref === root ? root : ref.split(/[.[\]]/).filter((t) => t && !/^\d+$/.test(t)).pop());
  const h = Math.min(ex.history === true ? EXPLODE_HISTORY : Math.max(0, intOr(ex.history, 0)), EXPLODE_HISTORY);
  const extract = Object.entries(ex.extract || {});
  // refs of the import's mapping/metadata into the dropped list (e.g. "trajectory[1].content") are extracted under their own name
  if (as !== root) for (const r of new Set(refs)) if (r.split(/[.[]/)[0] === root && !r.includes('[*]') && !extract.some(([k]) => k === r)) extract.push([r, r]);
  const ex2 = [];
  for (const [name, p] of extract) ex2.push(`${await pathExpr(c, st, p, `explode.extract.${name}`, { raw: true })} AS ${ident(name)}`);
  const hasRow = cols.some((x) => x.name === ROWCOL);
  const keep = st.columns.map((x) => x.name).filter((n) => n !== root && n !== as && !extract.some(([k]) => k === n));
  const total = Number((await c.runAndReadAll(`SELECT coalesce(sum(least(len(${list}), ${EXPLODE_MAX})), 0)::BIGINT n FROM ${src}`)).getRowObjectsJson()[0].n);
  if (total > LIMITS.max_rows) throw Object.assign(new Error(`explode would make ${total.toLocaleString()} rows (limit SIEVE_MAX_ROWS=${LIMITS.max_rows.toLocaleString()}). Use a smaller limit or a where filter.`), { kind: 'memory' });
  // 1) stage: the kept columns, extracts and the (cut) list, one row per source row, in small row groups (streamed)
  // 2) explode in batches of source rows (so the history window and ordering only ever hold one batch)
  const stage = `${outBase}.stage.parquet`;
  await c.run(`COPY (SELECT ${[...keep.map(ident), ...ex2, `list_slice(${list}, 1, ${EXPLODE_MAX}) AS __l`, `${hasRow ? ROWCOL : 'row_number() OVER () - 1'} AS __b`, 'row_number() OVER () AS __k'].join(', ')} FROM ${src}) TO ${q(stage)} (FORMAT parquet, ROW_GROUP_SIZE 2048)`);
  const files = [];
  try {
    const n = Number((await c.runAndReadAll(`SELECT count(*) n FROM read_parquet(${q(stage)})`)).getRowObjectsJson()[0].n);
    const per = Math.max(1, Math.floor(n * EXPLODE_BATCH_BYTES / Math.max(1, fs.statSync(stage).size))); // ~4 MB of compressed lists per batch
    for (let lo = 1, k = 0; lo <= n; lo += per, k++) {
      const steps = `SELECT * EXCLUDE (__l, __k), unnest(__l) AS __e, generate_subscripts(__l, 1) AS __i, len(__l) AS __n FROM read_parquet(${q(stage)}) WHERE __k BETWEEN ${lo} AND ${lo + per - 1}`;
      const hist = h ? `, list(__e) OVER (PARTITION BY __b ORDER BY __i ROWS BETWEEN ${h} PRECEDING AND 1 PRECEDING) AS __h` : '';
      const sql = `SELECT * EXCLUDE (__e, __i, __n, __b${h ? ', __h' : ''}), __e AS ${ident(as)}, (__i - 1)::BIGINT AS explode_step, __n::BIGINT AS explode_steps${h ? ', coalesce(__h, []) AS explode_history' : ''},
        (__b * ${EXPLODE_MAX} + __i - 1)::BIGINT AS ${ROWCOL} FROM (SELECT *${hist} FROM (${steps})) ORDER BY __b, __i`;
      const f = `${outBase}.${k}.parquet`; // not "-N.parquet": those are the source shards
      await c.run(`COPY (${sql}) TO ${q(f)} (FORMAT parquet, ROW_GROUP_SIZE 10000)`);
      files.push(f);
    }
  } catch (e) { files.forEach((f) => fs.rmSync(f, { force: true })); throw oomHint(e); } finally { fs.rmSync(stage, { force: true }); }
  return { files, rows: total, explode: { column: ref, as, ...(as !== root && { dropped: root }), ...(h && { history: h }), ...(extract.length && { extract: Object.fromEntries(extract) }) } };
}

// Column profile over the imported rows: type, nulls, distinct values and the top values (text cut at 80 chars).
export async function profile(id, { top = 5, where } = {}) {
  const st = get(id);
  const c = await memConn();
  const from = `${numbered(st)} WHERE ${whereSql(where)}`;
  const k = Math.min(Math.max(intOr(top, 5), 0), 50);
  const n = Number((await c.runAndReadAll(`SELECT count(*) n FROM ${from}`)).getRowObjectsJson()[0].n);
  const columns = [];
  for (const col of st.columns) {
    const e = `CAST(${ident(col.name)} AS VARCHAR)`;
    const [a] = (await c.runAndReadAll(`SELECT count(*) FILTER (WHERE ${ident(col.name)} IS NULL)::BIGINT nn, count(DISTINCT ${e})::BIGINT nd FROM ${from}`)).getRowObjectsJson();
    const tv = k ? (await c.runAndReadAll(`SELECT left(${e}, 80) AS "v", count(*)::BIGINT AS "n" FROM ${from} AND ${ident(col.name)} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${k}`)).getRowObjectsJson() : [];
    columns.push({ name: col.name, type: col.type, nulls: +a.nn, distinct: +a.nd, top: tv.map((x) => ({ value: x.v, count: +x.n })) });
  }
  return { dataset_id: id, rows: n, columns };
}

// Suggest source columns for each schema field from its name + aliases.
export function suggestMapping(schema, columnNames) {
  const lower = new Map(columnNames.map((n) => [n.toLowerCase(), n]));
  const used = new Set(); const m = {};
  for (const f of schema.fields) {
    if (['constant', 'metadata', 'meta', 'options_dict'].includes(f.transform)) continue;
    const hit = [f.name, ...(f.aliases || [])].map((a) => lower.get(a.toLowerCase())).find((c) => c && !used.has(c));
    if (hit) { used.add(hit); m[f.name] = [hit]; } else m[f.name] = [];
  }
  if (schema.fields.some((f) => f.required && !m[f.name]?.length)) {
    const free = columnNames.filter((c) => !used.has(c));
    for (const f of schema.fields) if (f.required && !m[f.name]?.length && free.length) m[f.name] = [free.shift()];
  }
  return m;
}
function useSchema(st, name) {
  st.schema = getSchema(name);
  st.mapping = suggestMapping(st.schema, st.columns.map((c) => c.name));
  st.overrides = {};
  st.meta_column = st.schema.fields.find((f) => f.transform === 'meta')?.name || null;
}
// Column references: a column name, a nested path like "a.b[0].c" / "completions[*].rating", or "source_row".
function checkRef(st, ref, what) {
  ref = String(ref);
  const names = st.columns.map((c) => c.name);
  if (ref === 'source_row' || names.includes(ref) || names.includes(ref.split(/[.[]/)[0])) return ref;
  const root = ref.split(/[.[]/)[0];
  if (st.explode?.dropped === root) throw new Error(`${what}: "${ref}": explode dropped the list column ${root}; keep values from it with explode.extract {name: path} (or give the path in the import's mapping)`);
  throw new Error(`${what}: unknown column "${ref}"`);
}
// A column or path (a.b[0].c, source_row) as a DuckDB expression, for value counts, stratify_by, distinct_by and explode.
// Structs and lists are walked natively; once the path reaches a JSON or text value it continues as JSON, and JSON text
// nested inside JSON (e.g. tool_calls[0].function.arguments.command) is parsed on the way, as mapping does.
// Default result is text (JSON strings unwrapped); {raw} keeps JSON values; {list} returns a DuckDB list.
const jsonStep = (j) => `(CASE WHEN json_type(${j}) = 'VARCHAR' THEN TRY_CAST(json_extract_string(${j}, '$') AS JSON) ELSE ${j} END)`;
async function pathExpr(c, st, ref, what, { list = false, raw = false } = {}) {
  ref = checkRef(st, ref, what);
  if (ref === 'source_row') return '__row';
  const toks = st.columns.some((x) => x.name === ref) ? [ref] : [...ref.matchAll(/([^.[\]]+)|\[(\d+|\*)\]/g)].map((m) => m[1] ?? m[2]);
  if (toks.includes('*')) throw new Error(`${what}: [*] paths are not supported here`);
  const typeOf = async (e) => (await c.runAndReadAll(`DESCRIBE SELECT ${e} AS x FROM ${st.src} LIMIT 0`)).getRowObjectsJson()[0].column_type;
  const [root, ...rest] = toks;
  let e = ident(root), type = st.columns.find((x) => x.name === root).type, json = false;
  for (const t of rest) {
    if (!json && /^(JSON|VARCHAR)$/.test(type)) { json = true; e = `TRY_CAST(${e} AS JSON)`; }
    if (json) { e = `json_extract(${jsonStep(e)}, ${q(/^\d+$/.test(t) ? `$[${t}]` : `$.${JSON.stringify(t)}`)})`; continue; }
    if (/^\d+$/.test(t)) { if (!/\]$/.test(type)) throw new Error(`${what}: ${ref}: [${t}] on a non-list (${type})`); e = `${e}[${+t + 1}]`; }
    else { if (!/^STRUCT/.test(type)) throw new Error(`${what}: ${ref}: .${t} on a non-struct (${type})`); e = `struct_extract(${e}, ${q(t)})`; }
    type = await typeOf(e);
  }
  if (list) {
    if (!json && /^(JSON|VARCHAR)$/.test(type)) { json = true; e = `TRY_CAST(${e} AS JSON)`; }
    if (json) return `json_extract(${jsonStep(e)}, '$[*]')`;
    if (!/\]$/.test(type)) throw new Error(`${what}: ${ref} is not a list (${type})`);
    return e;
  }
  if (json) return raw ? e : `json_extract_string(${e}, '$')`;
  return e;
}
function pick(r, ref) {
  if (ref === 'source_row') return r.__row ?? null;
  if (ref in r) return r[ref];
  const toks = [...ref.matchAll(/([^.[\]]+)|\[(\d+|\*)\]/g)].map((m) => m[1] ?? m[2]);
  const walk = (v, [t, ...rest]) => {
    if (t === undefined || v == null) return v ?? null;
    if (typeof v === 'string' && /^\s*[[{]/.test(v)) { try { v = JSON.parse(v); } catch {} }
    if (t === '*') return Array.isArray(v) ? v.map((x) => walk(x, rest)) : null;
    return walk(v[Array.isArray(v) ? +t : t], rest);
  };
  return walk(r, toks);
}
// Constants keep JSON types: "3" -> 3, "true" -> true, "[1,2]" -> [1,2]; other strings stay strings.
function typed(v) {
  if (typeof v !== 'string') return v ?? '';
  try { const p = JSON.parse(v); return typeof p === 'string' ? v : p; } catch { return v; }
}
// Metadata is a list of {key, value} (constant) or {key, column} (copied per row from a source column or path).
function metaEntry(st, e) {
  const key = String(e.key).trim();
  return e.column ? { key, column: checkRef(st, e.column, `metadata ${key}`) } : { key, value: typed(e.value) };
}
function mergeMeta(st, list, meta) { // merge entries ({key: value} object or [{key,...}] list) into list by key
  const out = list.map((e) => ({ ...e }));
  const entries = Array.isArray(meta) ? meta : Object.entries(meta || {}).map(([key, value]) => ({ key, value }));
  for (const e of entries.filter((x) => x && String(x.key || '').trim()).map((x) => metaEntry(st, x))) {
    const i = out.findIndex((x) => x.key === e.key);
    if (i >= 0) out[i] = e; else out.push(e);
  }
  return out;
}
const metaConst = (st) => Object.fromEntries(st.metadata.filter((e) => !e.column).map((e) => [e.key, e.value]));
function get(id) {
  const st = datasets.get(id);
  if (!st) throw new Error(`Unknown dataset_id ${id}. Call import_dataset first.`);
  if (st.cleaned) throw new Error(`Downloads of ${id} were cleaned up; import it again.`);
  return st;
}
function summary(st) {
  const { src, files, ...rest } = st; // never expose local paths
  return { ...rest, schema: rest.schema?.name };
}
export function listDatasets() { return [...datasets.values()].map(summary); }

// `where`: a DuckDB boolean expression over source columns, e.g. "label >= 0 AND length(premise) < 200".
function whereSql(w) {
  if (w == null || !String(w).trim()) return 'TRUE';
  const bare = String(w).replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  if (/;|--|\/\*/.test(bare) || /\b(select|from|attach|detach|copy|install|load|pragma|create|drop|insert|update|delete|alter|export|import|set|call|read_\w+|glob|getenv|query|query_table|parquet_\w+)\b/i.test(bare))
    throw new Error('where must be a plain row expression over source columns (no statements, subqueries or file functions)');
  return `(${w})`;
}
// DuckDB values -> plain JSON values (BIGINT -> number, DATE -> ISO string, BLOB -> placeholder).
const norm = (v) => (typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : String(v))
  : v instanceof Date ? v.toISOString() : v instanceof Uint8Array ? `<${v.length} bytes>`
  : Array.isArray(v) ? v.map(norm) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)])) : v);
const numbered = (st) => (st.row_col ? `(SELECT * EXCLUDE (${ROWCOL}), ${ROWCOL} AS __row FROM ${st.src})` : `(SELECT *, row_number() OVER () - 1 AS __row FROM ${st.src})`);
const readRows = async (c, sql) => { // JSON-typed columns (mixed-type JSON input) come back as text: parse them
  const r = await c.runAndReadAll(sql);
  const js = r.columnNames().filter((n, i) => r.columnTypes()[i].alias === 'JSON');
  memoryGuard('read');
  return r.getRowObjectsJS().map((row) => { for (const k of js) if (typeof row[k] === 'string') { try { row[k] = JSON.parse(row[k]); } catch {} } return norm(row); });
};

// preview: n rows (max 50) from `offset`, or a seeded random sample (random: true); value_counts: {column, top?, where?}
// counts values of a column/path over all imported rows (top 20 by default).
export async function preview(id, n = 5, where, o = {}) {
  const st = get(id);
  const c = await memConn();
  const order = o.random ? ` ORDER BY hash(__row, ${intOr(o.seed, 42)}), __row` : '';
  const raw = await readRows(c, `SELECT * FROM ${numbered(st)} WHERE ${whereSql(where)}${order} LIMIT ${Math.min(Math.max(intOr(n, 5), 0), 50)} OFFSET ${Math.max(intOr(o.offset, 0), 0)}`);
  const out = { ...summary(st), raw: raw.map(({ __row, ...r }) => r), converted: raw.map((r) => convertRow(r, st)) };
  if (o.value_counts) { // counted over rows matching both preview's where and value_counts.where
    const vc = typeof o.value_counts === 'string' ? { column: o.value_counts } : o.value_counts;
    out.value_counts = await valueCounts(c, st, { ...vc, where: [where, vc.where] });
  }
  return out;
}
async function valueCounts(c, st, { column, top = 20, where } = {}) {
  if (!column) throw new Error('value_counts needs a column');
  const e = await pathExpr(c, st, column, 'value_counts');
  const from = `${numbered(st)} WHERE ${[].concat(where ?? []).map(whereSql).join(' AND ') || 'TRUE'}`;
  const [t] = (await c.runAndReadAll(`SELECT count(*)::BIGINT n_rows, count(DISTINCT CAST(${e} AS VARCHAR))::BIGINT n_distinct FROM ${from}`)).getRowObjectsJson();
  const values = (await c.runAndReadAll(`SELECT CAST(${e} AS VARCHAR) AS "value", count(*)::BIGINT AS "count" FROM ${from} GROUP BY 1 ORDER BY 2 DESC, 1 NULLS LAST LIMIT ${Math.min(Math.max(intOr(top, 20), 1), 1000)}`)).getRowObjectsJson();
  return { column, rows: +t.n_rows, distinct_values: +t.n_distinct, values: values.map((x) => ({ value: x.value, count: +x.count })) };
}

function normMapping(st, mapping) {
  const out = {};
  for (let [field, cols] of Object.entries(mapping || {})) {
    if (!st.schema.fields.some((f) => f.name === field)) throw new Error(`Schema has no field "${field}"`);
    cols = cols == null ? [] : Array.isArray(cols) ? cols : String(cols).split(',').map((x) => x.trim()).filter(Boolean);
    out[field] = cols.map((c) => checkRef(st, c, `mapping ${field}`));
  }
  return out;
}
const goldFromCheck = (g, at) => {
  if (!g.column && !Array.isArray(g.argmax_of)) throw new Error(`${at}: needs column or argmax_of: [paths]`);
  if (g.ties != null && !['skip', 'first'].includes(g.ties)) throw new Error(`${at}.ties must be skip or first`);
};
// Per-dataset (or per-split) changes to schema field properties, e.g. {label: {label_mode: "index"}, option_labels: {gold_from: {...}}}.
function normFieldOptions(st, fo) {
  const out = {};
  for (const [field, o] of Object.entries(fo || {})) {
    if (!st.schema.fields.some((f) => f.name === field)) throw new Error(`Schema has no field "${field}"`);
    if (o == null) { out[field] = {}; continue; }
    if (o.duplicates != null && !['skip', 'drop', 'keep'].includes(o.duplicates)) throw new Error(`field_options.${field}.duplicates must be skip, drop or keep`);
    for (const k of Object.keys(o.value_from?.map || {})) { const re = reKey(k); if (re) try { new RegExp(re[1], re[2]); } catch (e) { throw new Error(`field_options.${field}.value_from.map: bad regex ${k}: ${e.message}`); } }
    if (typeof o !== 'object' || 'name' in o || 'type' in o) throw new Error(`field_options.${field}: an object of field properties (not name/type)`);
    if (o.label_mode != null && !LABEL_MODES.includes(o.label_mode)) throw new Error(`field_options.${field}.label_mode must be one of ${LABEL_MODES}`);
    if (o.gold_from?.column) checkRef(st, o.gold_from.column, `field_options.${field}.gold_from`);
    if (o.gold_from) goldFromCheck(o.gold_from, `field_options.${field}.gold_from`);
    if (o.value_from) { if (!o.value_from.column) throw new Error(`field_options.${field}.value_from needs a column`); checkRef(st, o.value_from.column, `field_options.${field}.value_from`); }
    for (const p of o.gold_from?.argmax_of || []) checkRef(st, p, `field_options.${field}.gold_from.argmax_of`);
    out[field] = o;
  }
  return out;
}

// meta: [{key, value} | {key, column}] (or {key: value} to merge); opts: {target_column, {schema, mapping: {field: [cols]}, overrides: {field: constant}}
export async function setMetadata(id, meta = {}, opts = {}) {
  const st = get(id);
  if (opts.table && st.format === 'duckdb' && opts.table !== st.table) {
    if (!st.tables.includes(opts.table)) throw new Error(`Unknown table "${opts.table}". Tables: ${st.tables.join(', ')}`);
    st.table = opts.table; st.src = limited(duckSrc(`src_${st.dataset_id}`, opts.table), st.limit);
    const c = await memConn();
    st.columns = (await c.runAndReadAll(`DESCRIBE SELECT * FROM ${st.src}`)).getRowObjectsJson().map((r) => ({ name: r.column_name, type: r.column_type }));
    st.row_count = Number((await c.runAndReadAll(`SELECT count(*) n FROM ${st.src}`)).getRowObjectsJson()[0].n);
    useSchema(st, opts.schema || st.schema.name);
  }
  if (opts.schema && opts.schema !== st.schema.name) useSchema(st, opts.schema);
  if (opts.mapping) Object.assign(st.mapping, normMapping(st, opts.mapping));
  // overrides / field_options set here are kept for every later write (per-write ones in convert_and_write apply to that
  // write only). clear_overrides / clear_field_options: true drops the stored ones first (so clear + new = replace);
  // a null value drops one field's entry.
  if (opts.clear_field_options) st.field_options = {};
  if (opts.field_options) {
    const n = normFieldOptions(st, Object.fromEntries(Object.entries(opts.field_options).filter(([, v]) => v !== null)));
    st.field_options = { ...st.field_options, ...n };
    for (const [k, v] of Object.entries(opts.field_options)) if (v === null) delete st.field_options[k];
  }
  if (Array.isArray(meta)) st.metadata = mergeMeta(st, [], meta);
  else if (meta && Object.keys(meta).length) st.metadata = mergeMeta(st, st.metadata, meta);
  if (opts.target_column !== undefined) {
    const f = st.schema.fields.find((x) => x.name === opts.target_column);
    if (opts.target_column && (!f || !['json', 'text'].includes(f.type))) throw new Error(`target_column must be a json/text field of schema ${st.schema.name}`);
    st.meta_column = opts.target_column || null;
  }
  if (opts.clear_overrides) st.overrides = {};
  for (const [k, v] of Object.entries(opts.overrides || {})) {
    if (!st.schema.fields.some((f) => f.name === k)) throw new Error(`overrides: schema ${st.schema.name} has no field "${k}"`);
    if (v === null) delete st.overrides[k]; else st.overrides[k] = v;
  }
  return summary(st);
}

// ---- Ordered JSON ----
// JS objects list integer-like keys ("0", "1") first. Objects built with ordered() remember their key order
// (non-enumerable), and toJson() writes them in that order. Used for DuckDB JSON values and API responses.
const ORDER = Symbol('order');
const ordered = (pairs) => Object.defineProperty(Object.fromEntries(pairs), ORDER, { value: pairs.map(([k]) => String(k)) });
export function toJson(v, step = 0, ind = '') {
  if (v != null && typeof v.toJSON === 'function') v = v.toJSON();
  if (v === undefined || typeof v === 'function') return undefined;
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  const inner = ind + ' '.repeat(step), nl = step ? '\n' + inner : '', end = step ? '\n' + ind : '';
  if (Array.isArray(v)) return v.length ? `[${v.map((x) => nl + (toJson(x, step, inner) ?? 'null')).join(',')}${end}]` : '[]';
  const keys = v[ORDER] ? [...v[ORDER], ...Object.keys(v).filter((k) => !v[ORDER].includes(k))] : Object.keys(v);
  const e = keys.map((k) => [k, toJson(v[k], step, inner)]).filter(([, x]) => x !== undefined);
  return e.length ? `{${e.map(([k, x]) => `${nl}${JSON.stringify(k)}:${step ? ' ' : ''}${x}`).join(',')}${end}}` : '{}';
}

// ---- Row conversion ----
const asText = (v) => (v == null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
function asList(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return v.split(/\s*[|;]\s*/); } }
  const item = (x) => (x != null && typeof x === 'object' ? JSON.stringify(x) : x); // numbers/bools keep their type
  if (Array.isArray(v)) return v.map(item);
  if (typeof v === 'object') { // HF {text:[...], label:[...]} style
    const arr = v.text || v.choices || v.options || Object.values(v).find(Array.isArray);
    return Array.isArray(arr) ? arr.map(item) : [JSON.stringify(v)];
  }
  return [v];
}
// Options with explicit ids: [{id, text}, ...] or {id: text, ...} (objects reorder integer-like keys; use the list form for those).
function explicitOptions(v) {
  if (typeof v === 'string' && /^\s*[[{]/.test(v)) { try { v = JSON.parse(v); } catch { return null; } }
  let pairs = null;
  if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && 'id' in x && 'text' in x)) pairs = v.map((x) => [x.id, x.text]);
  else if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length && Object.values(v).every((x) => x == null || typeof x !== 'object')) pairs = Object.entries(v);
  if (!pairs) return null;
  const ids = pairs.map(([id]) => String(id));
  if (new Set(ids).size < ids.length) throw new Error(`duplicate option ids: ${ids.join(', ')}`);
  return { ids, texts: pairs.map(([, t]) => t) };
}
// Option ids: explicit, index ("0","1",…), or the option text made unique ("a", "a#2").
function optionIds(f, opts, explicit) {
  if (explicit && explicit.length === opts.length) return explicit;
  if (f.ids === 'index') return opts.map((_, i) => String(i));
  const seen = new Map();
  return opts.map((o) => { const s = String(o), n = (seen.get(s) || 0) + 1; seen.set(s, n); return n > 1 ? `${s}#${n}` : s; });
}
function cast(v, f, cut) {
  if (v == null || v === '') return null;
  const trunc = (s, n) => (typeof s === 'string' && s.length > n ? (cut(f.name), s.slice(0, n)) : s);
  switch (f.type) {
    case 'number': { const n = Number(v); return Number.isFinite(n) ? n : null; }
    case 'integer': { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
    case 'boolean': return typeof v === 'boolean' ? v : /^(true|1|yes|y)$/i.test(String(v));
    case 'list': {
      let l = asList(v);
      if (f.max_items && l.length > f.max_items) { cut(f.name); l = l.slice(0, f.max_items); }
      if (f.item_max_chars) l = l.map((x) => trunc(x, f.item_max_chars));
      return l;
    }
    case 'json': return v;
    default: return f.max_chars ? trunc(asText(v), f.max_chars) : asText(v);
  }
}
const LABEL_MODES = ['auto', 'text', 'index', 'numeric'];
const isNum = (x) => x !== '' && x != null && typeof x !== 'boolean' && Number.isFinite(Number(x));
// Index of a label among the options. label_mode:
//   text: option text, option id, HF choice key ({label:[A,B..]}) or ClassLabel name;  index: 0-based integer or letter;
//   numeric: numerically equal option;  auto (default): text, then numeric if all options are numbers, else index.
function optionIndex(x, o) {
  const s = asText(x), { opts, ids, keys, names } = o, mode = o.mode || 'auto';
  if (s == null || !opts?.length) return -1;
  let i = -1;
  if (mode === 'auto' || mode === 'text') {
    i = opts.findIndex((v) => String(v) === s);
    if (i < 0) i = ids.indexOf(s);
    if (i < 0 && keys) i = keys.indexOf(s);
    if (i < 0 && names && /^\d+$/.test(s) && names[+s] != null) i = opts.findIndex((v) => String(v) === names[+s]);
  }
  const numericOpts = opts.every(isNum);
  if (i < 0 && (mode === 'numeric' || mode === 'auto' && numericOpts) && isNum(s)) i = opts.findIndex((v) => isNum(v) && Number(v) === Number(s));
  else if (i < 0 && (mode === 'index' || mode === 'auto' && !numericOpts)) {
    if (/^\d+$/.test(s)) i = +s; else if (/^[A-Z]$/.test(s)) i = s.charCodeAt(0) - 65;
  }
  return i >= 0 && i < opts.length ? i : -1;
}
// {probabilities: {id: p}} (or [{id, p}] with "as": "list"): one-hot from a label, uniform over a multi-label list;
// soft from a number (numeric/auto modes): between the neighbouring numeric options, or p(second option) for two options and a value in [0,1];
// several numeric columns (one per option) -> normalised.
function distribution(f, val, multi, o) {
  const { opts, ids } = o, mode = o.mode || 'auto';
  if (!opts?.length || val == null) return null;
  const P = opts.map(() => 0);
  if (multi) {
    const n = val.slice(0, P.length).map(Number);
    const sum = n.reduce((a, b) => a + b, 0);
    if (n.some((x) => !Number.isFinite(x) || x < 0) || !sum) return null;
    n.forEach((x, i) => (P[i] = x / sum));
  } else {
    const list = Array.isArray(val) ? val : [val];
    const idx = list.map((x) => optionIndex(x, o));
    if (list.length && idx.every((i) => i >= 0)) idx.forEach((i) => (P[i] += 1 / idx.length));
    else if (Array.isArray(val) || !isNum(val) || !['auto', 'numeric'].includes(mode)) return null;
    else if (opts.every(isNum) && opts.length > 1) {
      const num = Number(val), order = opts.map((x, i) => [Number(x), i]).sort((a, b) => a[0] - b[0]);
      const k = order.findIndex(([x]) => x >= num);
      if (k <= 0) P[order[k < 0 ? order.length - 1 : 0][1]] = 1;
      else { const [[a, ia], [b, ib]] = [order[k - 1], order[k]]; P[ib] = (num - a) / (b - a); P[ia] = 1 - P[ib]; }
    } else if (opts.length === 2 && +val >= 0 && +val <= 1) { P[0] = 1 - val; P[1] = +val; } else return null;
  }
  const r = P.map((p) => Math.round(p * 1e6) / 1e6);
  const fix = 1 - r.reduce((a, b) => a + b, 0); // keep the sum exactly 1 after rounding
  if (fix) { const m = r.indexOf(Math.max(...r)); r[m] = Math.round((r[m] + fix) * 1e6) / 1e6; }
  return { probabilities: f.as === 'list' ? ids.map((id, i) => ({ id, p: r[i] })) : ordered(ids.map((id, i) => [id, r[i]])) };
}
const argmax = (d, ids) => {
  const ps = Array.isArray(d.probabilities) ? d.probabilities.map((x) => x.p) : ids.map((id) => d.probabilities[id]);
  return ps.indexOf(Math.max(...ps));
};
function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// value_from map lookup: exact key, then "/regex/flags" keys in order, then "*", else null.
const reKey = (k) => k.match(/^\/(.+)\/([a-z]*)$/s);
function mapValue(m, x) {
  if (x == null) return Object.hasOwn(m, '*') ? m['*'] : null;
  if (Object.hasOwn(m, x)) return m[x];
  for (const k of Object.keys(m)) { const re = reKey(k); if (re && new RegExp(re[1], re[2]).test(x)) return m[k]; }
  return Object.hasOwn(m, '*') ? m['*'] : null;
}
const LATE = ['label_to_option', 'label_to_distribution', 'options_dict']; // need the options field first
function convertRow(r, st) {
  const row = Number(r.__row ?? 0);
  const F = st.schema.fields.map((f) => ({ ...f, ...st.field_options?.[f.name] }));
  const wk = st.write_key ? `${st.write_key}-` : '';
  const out = { id: `${st.dataset_id}-${wk}${row}`, dataset_id: st.dataset_id, source_row: row };
  const meta = { ...(st.explode && { step: r.explode_step ?? null, steps: r.explode_steps ?? null }), ...Object.fromEntries(st.metadata.map((e) => [e.key, e.column ? pick(r, e.column) : e.value])) };
  const raw = {}, gold = {}, cut = new Set(), explicit = {};
  const optionFields = new Set(F.filter((f) => LATE.includes(f.transform)).map((f) => f.option_field));
  const metaField = F.find((f) => f.name === st.meta_column);
  const order = [...F.filter((f) => f !== metaField && !LATE.includes(f.transform)), ...LATE.flatMap((t) => F.filter((f) => f !== metaField && f.transform === t)), ...(metaField ? [metaField] : [])];
  const ctxFor = (f, cols) => { // options context for label / distribution / options_dict fields
    const labelField = f.label_field || F.find((g) => g.transform === 'label_to_option' && g.option_field === f.option_field)?.name;
    const names = labelsFor(st, cols[0] || (f.transform !== 'label_to_option' && st.mapping[labelField]?.[0]) || '');
    if (!out[f.option_field]?.length && names) out[f.option_field] = names; // ClassLabel names as options
    const opts = out[f.option_field];
    const optCols = st.mapping[f.option_field] || [];
    const o = optCols.length ? pick(r, optCols[0]) : null;
    const lf = F.find((g) => g.name === labelField);
    return { labelField, opts, names, keys: o && Array.isArray(o.label) ? o.label.map(String) : null,
      ids: optionIds(f, opts || [], explicit[f.option_field]), mode: f.label_mode || lf?.label_mode || 'auto' };
  };
  for (const f of order) {
    const cols = st.mapping[f.name] || [];
    let v, o;
    if (LATE.includes(f.transform)) o = ctxFor(f, cols);
    if (f.name in st.overrides) v = st.overrides[f.name];
    else if (f.name in gold) v = gold[f.name];
    else if (f === metaField) { if (cut.size) Object.assign(meta, { truncated: true, truncated_fields: [...cut] }); v = meta; }
    else if (f.value_from?.column) { // value -> mapped value ("*" = any other value)
      const x = asText(pick(r, f.value_from.column)), m = f.value_from.map;
      v = !m ? x : mapValue(m, x);
    }
    else if (f.transform === 'constant') v = f.value;
    else if (f.transform === 'metadata') v = meta[f.value || f.name];
    else if (f.transform === 'meta') v = null;
    else if (f.transform === 'join' && cols.length > 1) v = cols.map((c) => `${c}: ${asText(pick(r, c)) ?? ''}`).join('\n');
    else if (f.transform === 'shuffle') { // gold = gold_from {column, map} (value -> item index or mapped column name) or {argmax_of}, else the first item
      const items = cols.length > 1 ? cols.map((c) => pick(r, c)) : asList(cols.length ? pick(r, cols[0]) : null);
      let g = 0;
      if (f.gold_from?.argmax_of) { // gold = item with the highest score; ties (or no scores): skip the row, or take the first
        const sc = f.gold_from.argmax_of.map((p) => { const x = pick(r, p); return isNum(x) ? Number(x) : -Infinity; });
        const best = Math.max(...sc), n = sc.filter((x) => x === best).length;
        g = best === -Infinity ? -1 : sc.indexOf(best);
        if ((n > 1 || g < 0) && (f.gold_from.ties || 'skip') === 'skip') out._skipped = n > 1 && g >= 0 ? 'gold tie' : 'no gold score';
      } else if (f.gold_from?.column) {
        const gv = asText(pick(r, f.gold_from.column)), m = f.gold_from.map ? f.gold_from.map[gv] : gv;
        g = cols.length > 1 && typeof m === 'string' && cols.includes(m) ? cols.indexOf(m) : isNum(m) && Number.isInteger(+m) ? +m : -1;
        if (g >= (items?.length || 0)) g = -1;
      }
      if (items?.length && f.duplicates === 'drop') { // drop repeated items (after trim), keeping the gold one
        const key = (x) => (typeof x === 'string' ? x.trim() : asText(x)), gk = g >= 0 ? key(items[g]) : undefined, seen = new Set();
        const keepIdx = items.map((x, i) => i).filter((i) => { const k = key(items[i]); if (k === gk ? i !== g : seen.has(k)) return false; seen.add(k); return true; });
        g = g >= 0 ? keepIdx.indexOf(g) : g;
        items.splice(0, items.length, ...keepIdx.map((i) => items[i]));
      }
      if (items?.length) {
        const rand = rng(Math.imul((st.seed ?? 42) + 1, 2654435761) ^ row), perm = items.map((_, i) => i);
        for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
        v = perm.map((i) => items[i]);
        const gi = g >= 0 ? perm.indexOf(g) : null;
        if (f.gold_field) gold[f.gold_field] = gi; else meta.gold_index = gi;
      } else v = null;
    }
    else if (f.transform === 'options_dict') v = o.opts?.length ? (f.as === 'object' ? ordered(o.ids.map((id, i) => [id, o.opts[i]])) : o.ids.map((id, i) => ({ id, text: o.opts[i] }))) : null;
    else if (f.transform === 'label_to_distribution') {
      v = cols.length > 1 ? distribution(f, cols.map((c) => pick(r, c)), true, o)
        : distribution(f, cols.length ? pick(r, cols[0]) : raw[o.labelField] ?? null, false, o);
    }
    else v = cols.length ? pick(r, cols[0]) : f.default ?? null;
    if (optionFields.has(f.name)) { const ex = explicitOptions(v); if (ex) { explicit[f.name] = ex.ids; v = ex.texts; } }
    raw[f.name] = v;
    if (f.transform === 'label_to_option' && v != null) {
      const one = (x) => { const i = optionIndex(x, o); return i >= 0 ? o.opts[i] : o.mode !== 'index' && o.names && /^\d+$/.test(asText(x)) && o.names[+x] != null ? o.names[+x] : x; };
      v = Array.isArray(v) ? v.map(one) : one(v);
    }
    v = cast(v, f, (n) => cut.add(n));
    if (f.enum && v != null && !f.enum.includes(v)) throw new Error(`field ${f.name}: "${v}" not in ${f.enum}`);
    out[f.name] = v;
  }
  // Options / shuffle items that are empty or whitespace-only count as missing, and repeated texts (after trim) make the
  // choice ambiguous: such rows are skipped (allow_empty / allow_duplicates: true keep them).
  for (const f of F.filter((x) => (x.transform === 'shuffle' || optionFields.has(x.name)) && !(x.name in st.overrides)))
  {
    const l = out[f.name];
    if (!Array.isArray(l)) continue;
    if (!f.allow_empty && l.some((x) => x == null || (typeof x === 'string' && !x.trim()))) out._skipped ||= `empty option in ${f.name}`;
    const t = l.map((x) => (typeof x === 'string' ? x.trim() : asText(x)));
    if (!f.allow_duplicates && !['keep', 'drop'].includes(f.duplicates) && new Set(t).size < t.length) out._skipped ||= `duplicate options in ${f.name}`;
  }
  // A label that is missing or not an option takes the argmax option of its distribution (e.g. a binned score).
  for (const f of F.filter((x) => x.transform === 'label_to_option' && !(x.name in st.overrides))) {
    const d = F.find((g) => g.transform === 'label_to_distribution' && g.option_field === f.option_field && out[g.name]);
    const opts = out[f.option_field];
    const valid = (x) => opts?.some((op) => String(op) === String(x));
    const cur = out[f.name], parsed = (() => { try { return JSON.parse(cur); } catch { return null; } })();
    if (!d || !opts?.length || cur != null && (valid(cur) || Array.isArray(parsed) && parsed.length && parsed.every(valid))) continue;
    out[f.name] = cast(opts[argmax(out[d.name], optionIds(d, opts, explicit[f.option_field]))], f, (n) => cut.add(n));
  }
  // skip_unknown (field option) / skip_unknown_labels (write option): a label that is not one of the non-empty options
  // skips the row (it is refilled) instead of being written with a null or out-of-options target.
  for (const f of F.filter((x) => x.transform === 'label_to_option' && !(x.name in st.overrides) && (x.skip_unknown ?? st.skip_unknown_labels))) {
    const opts = (out[f.option_field] || []).filter((x) => x != null && String(x).trim()).map(String);
    const cur = out[f.name], parsed = (() => { try { return typeof cur === 'string' && cur.startsWith('[') ? JSON.parse(cur) : null; } catch { return null; } })();
    const vals = Array.isArray(cur) ? cur : Array.isArray(parsed) ? parsed : [cur];
    if (!vals.length || vals.some((x) => x == null || !opts.includes(String(x)))) out._skipped ||= `unknown label in ${f.name}`;
  }
  return out;
}
const SQLT = { text: 'VARCHAR', number: 'DOUBLE', integer: 'BIGINT', boolean: 'BOOLEAN', list: 'JSON', json: 'JSON' };
const DATASETS_COLS = `dataset_id VARCHAR, write_key VARCHAR DEFAULT '', schema_name VARCHAR, table_name VARCHAR, name VARCHAR, metadata JSON,
  url VARCHAR, origin JSON, source_key VARCHAR, format VARCHAR, source_rows BIGINT, rows_written INTEGER, sample_seed INTEGER, filter VARCHAR,
  mapping JSON, written_at TIMESTAMP DEFAULT current_timestamp, PRIMARY KEY (dataset_id, table_name, write_key)`;
// Create tables; bring files written by older versions up to date (new datasets columns/key, new schema fields).
async function prepareTarget(conn, schema) {
  const cols = async (t) => (await conn.runAndReadAll('SELECT column_name FROM duckdb_columns() WHERE table_name = $1 AND schema_name = \'main\'', [t])).getRowObjectsJson().map((x) => x.column_name);
  const old = await cols('datasets');
  if (old.length && !old.includes('write_key')) {
    await conn.run(`CREATE TABLE datasets_v2 (${DATASETS_COLS})`);
    await conn.run(`INSERT INTO datasets_v2 (${old.join(',')}) SELECT ${old.join(',')} FROM datasets`);
    await conn.run('DROP TABLE datasets'); await conn.run('ALTER TABLE datasets_v2 RENAME TO datasets');
  }
  await conn.run(`CREATE TABLE IF NOT EXISTS datasets (${DATASETS_COLS})`);
  const fields = schema.fields.map((f) => `"${f.name}" ${SQLT[f.type]}${f.required ? ' NOT NULL' : ''}`);
  await conn.run(`CREATE TABLE IF NOT EXISTS "${schema.table}" (id VARCHAR PRIMARY KEY, dataset_id VARCHAR, write_key VARCHAR DEFAULT '', source_row BIGINT,
  ${fields.join(',\n  ')}, created_at TIMESTAMP DEFAULT current_timestamp)`);
  const have = await cols(schema.table);
  for (const [n, t] of [['write_key', "VARCHAR DEFAULT ''"], ...schema.fields.map((f) => [f.name, SQLT[f.type]])])
    if (!have.includes(n)) await conn.run(`ALTER TABLE "${schema.table}" ADD COLUMN "${n}" ${t}`);
}

// Targets: .duckdb files in DATA_DIR. A bare name resolves inside DATA_DIR; paths are used as given.
export function resolveTarget(t = 'datasets.duckdb') {
  t = String(t).trim();
  if (!t.endsWith('.duckdb')) t += '.duckdb';
  return t.includes('/') ? path.resolve(t) : path.join(DATA_DIR, t);
}
const displayName = (p) => (p.startsWith(DATA_DIR + path.sep) ? path.relative(DATA_DIR, p) : p);
export function listTargets() {
  return fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.duckdb')).map((f) => {
    const st = fs.statSync(path.join(DATA_DIR, f));
    return { name: f, bytes: st.size, modified: st.mtime.toISOString() };
  });
}
async function openTarget(target) {
  const tpath = resolveTarget(target);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  const inst = await DuckDBInstance.create(tpath);
  return { tpath, inst, conn: await inst.connect(), close() { this.conn.closeSync?.(); this.inst.closeSync?.(); } };
}
const intOr = (v, d) => (Number.isFinite(+v) && v !== '' && v != null ? Math.floor(+v) : d);

// Seeded sample -> convert -> write. Rows are replaced per (dataset_id, write_key).
// splits: [{tag, n, metadata?, overrides?}] cuts one shuffled sample into disjoint parts, each written with write_key = tag.
// exclude_dataset_ids / exclude_same_source skip source rows already written to the target table.
export const convertAndWrite = (id, o = {}) => withCompact(o, () => writeRows(id, o));
export const copyRows = (o = {}) => withCompact(o, () => copyRowsInner(o));
export const deleteDataset = (id, o = {}) => withCompact(o, () => deleteInner(id, o));
// The same seeded sample a write would take, converted but not written (for previews, e.g. a board's mix).
export const sampleRows = (id, o = {}) => writeRows(id, { ...o, dry_run: true });
async function writeRows(id, o) {
  const { target = 'datasets.duckdb', mode = 'append', cleanup = false, where, exclude_dataset_ids = [], exclude_same_source = false } = o;
  const dry = !!o.dry_run;
  if (!['create', 'append'].includes(mode)) throw new Error('mode must be create or append');
  const exists = !dry && fs.existsSync(resolveTarget(target));
  const shown = displayName(resolveTarget(target));
  if (!dry && mode === 'create' && exists) throw new Error(`${shown} already exists (use mode=append)`);
  if (!dry && mode === 'append' && !exists) throw new Error(`${shown} does not exist (use mode=create)`);
  const st = get(id);
  const seed = intOr(o.seed, 42);
  const parts = (o.splits?.length ? o.splits : [{ tag: o.write_key || '', n: o.sample }]).map((p) => ({ ...p, key: String(p.tag ?? ''), n: Math.max(1, intOr(p.n, 500)) }));
  if (new Set(parts.map((p) => p.key)).size < parts.length) throw new Error('split tags must be unique');
  const baseMeta = o.metadata ? mergeMeta(st, st.metadata, o.metadata) : st.metadata;
  const views = parts.map((p) => ({ ...st, seed, write_key: p.key, metadata: p.metadata ? mergeMeta(st, baseMeta, p.metadata) : baseMeta, overrides: { ...st.overrides, ...o.overrides, ...p.overrides },
    mapping: { ...st.mapping, ...normMapping(st, o.mapping), ...normMapping(st, p.mapping) },
    field_options: { ...st.field_options, ...normFieldOptions(st, o.field_options), ...normFieldOptions(st, p.field_options) },
    skip_unknown_labels: !!o.skip_unknown_labels }));
  const T = `"${st.schema.table}"`, F = st.schema.fields;
  const filter = whereSql(where);
  // check stratify_by / distinct_by / balance before a target file is created
  if (o.stratify_by && o.balance) throw new Error('use stratify_by (a source column) or balance (a schema field), not both');
  const c = await memConn();
  const strat = o.stratify_by ? await pathExpr(c, st, o.stratify_by, 'stratify_by') : o.balance ? await balanceExpr(c, views[0], o.balance) : null;
  const dist = o.distinct_by ? await pathExpr(c, st, o.distinct_by, 'distinct_by') : null;
  const perValue = Math.max(1, intOr(o.max_per_value, 1));
  let P = null; // temp table with the ordered pool
  const tg = dry ? null : await openTarget(target);
  const conn = tg?.conn;
  try {
    if (!dry) await prepareTarget(conn, st.schema);
    let excluded = [];
    if (!dry && (exclude_dataset_ids.length || exclude_same_source)) {
      const ids = exclude_dataset_ids.map(String);
      excluded = (await conn.runAndReadAll(`SELECT DISTINCT source_row r FROM ${T} WHERE (dataset_id IN (SELECT unnest(from_json($1, '["VARCHAR"]')))
        OR ($2 AND dataset_id IN (SELECT dataset_id FROM datasets WHERE source_key = $3 AND table_name = $4)))
        AND NOT (dataset_id = $5 AND coalesce(write_key, '') IN (SELECT unnest(from_json($6, '["VARCHAR"]'))))`,
        [`[${ids.map((x) => JSON.stringify(x)).join(',')}]`, !!exclude_same_source, st.source_key, st.schema.table, st.dataset_id, `[${parts.map((p) => JSON.stringify(p.key)).join(',')}]`]))
        .getRowObjectsJson().map((x) => Number(x.r));
    }
    // Order of operations: where -> exclude_* -> distinct_by (per stratum when stratify_by/balance is set, up to
    // max_per_value rows per value) -> stratified interleave (rank 1 of every value, then rank 2, ...) -> seeded order ->
    // convert, skipping and refilling bad rows -> splits take consecutive rows. All of it runs in DuckDB; JS only
    // holds one batch of rows at a time.
    P = `sieve_pool_${process.pid}_${++poolSeq}`;
    let base = `SELECT *${strat ? `, CAST(${strat} AS VARCHAR) AS __stratum` : ''} FROM ${numbered(st)} WHERE ${filter}${excluded.length ? ` AND __row NOT IN (${excluded.join(',')})` : ''}`;
    if (dist) base = `SELECT * EXCLUDE (__d, __dn) FROM (SELECT *, CAST(${dist} AS VARCHAR) AS __d, row_number() OVER (PARTITION BY ${strat ? '__stratum, ' : ''}CAST(${dist} AS VARCHAR) ORDER BY hash(__row, ${seed}), __row) AS __dn FROM (${base})) WHERE __d IS NULL OR __dn <= ${perValue}`;
    const pool = strat ? `SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY __stratum ORDER BY hash(__row, ${seed}), __row) AS __rank FROM (${base}))` : base;
    const orderBy = strat ? `__rank, hash(__stratum, ${seed}), hash(__row, ${seed}), __row` : `hash(__row, ${seed}), __row`;
    // The ordered pool is kept as keys only (row, stratum, position); batches of <= 1000 rows are read back by key.
    await c.run(`CREATE TEMP TABLE ${P} AS SELECT __row${strat ? ', __stratum' : ''}, row_number() OVER (ORDER BY ${orderBy}) AS __ord FROM (${pool})`);
    const poolRows = Number((await c.runAndReadAll(`SELECT count(*) n FROM ${P}`)).getRowObjectsJson()[0].n);
    const want = parts.reduce((a, p) => a + p.n, 0);
    let buf = [], off = 0, done = false;
    const next = async () => {
      if (!buf.length && !done) {
        const b = Math.min(Math.max(want - off, 0) + 200, 1000);
        buf = await readRows(c, `SELECT s.*${strat ? ', p.__stratum' : ''} FROM (SELECT * FROM ${P} WHERE __ord > ${off} AND __ord <= ${off + b}) p JOIN ${numbered(st)} s USING (__row) ORDER BY p.__ord`);
        off += buf.length; done = buf.length < b;
      }
      return buf.shift();
    };
    const req = F.filter((f) => f.required).map((f) => f.name);
    const bad = (x) => x._skipped || !req.every((k) => x[k] != null);
    const nextRow = next;
    const written = [], skipped = [], strata = [], reasons = {};
    for (const [i, v] of views.entries()) {
      const rows = [], per = {}; let sk = 0, seen = 0;
      while (rows.length < parts[i].n) {
        const r = await nextRow(); if (!r) break;
        if (++seen % 1000 === 0) memoryGuard('write');
        const { __stratum, __rank, ...src } = r;
        const x = convertRow(src, v);
        if (bad(x)) { sk++; const why = x._skipped || 'missing required field'; reasons[why] = (reasons[why] || 0) + 1; } else { rows.push(x); if (strat) per[__stratum ?? 'null'] = (per[__stratum ?? 'null'] || 0) + 1; }
      }
      written.push(rows); skipped.push(sk); strata.push(per);
    }
    const top = (m) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 100));
    const allStrata = strata.reduce((a, m) => { for (const [k, n] of Object.entries(m)) a[k] = (a[k] || 0) + n; return a; }, {});
    if (dry) {
      await c.run(`DROP TABLE IF EXISTS ${P}`);
      return { dataset_id: st.dataset_id, schema: st.schema.name, seed, pool_rows: poolRows, rows: written.flat(),
        ...(skipped.some(Boolean) && { rows_skipped: skipped.reduce((a, b) => a + b, 0), skip_reasons: top(reasons) }),
        ...(strat && { strata: top(allStrata) }) };
    }
    await conn.run('BEGIN');
    const names = ['id', 'dataset_id', 'write_key', 'source_row', ...F.map((f) => f.name)];
    const ins = await conn.prepare(`INSERT INTO ${T} (${names.map((n) => `"${n}"`).join(',')}) VALUES (${names.map((_, i) => '$' + (i + 1)).join(',')})`);
    const enc = (f, v) => (v == null ? null : ['list', 'json'].includes(f.type) ? toJson(v) : v);
    for (const [i, v] of views.entries()) {
      await conn.run(`DELETE FROM ${T} WHERE dataset_id = $1 AND coalesce(write_key, '') = $2`, [st.dataset_id, v.write_key]);
      await conn.run('DELETE FROM datasets WHERE dataset_id = $1 AND table_name = $2 AND write_key = $3', [st.dataset_id, st.schema.table, v.write_key]);
      for (const r of written[i]) {
        ins.bind([r.id, r.dataset_id, v.write_key, r.source_row, ...F.map((f) => enc(f, r[f.name]))]);
        await ins.run();
      }
      await conn.run('INSERT INTO datasets (dataset_id,write_key,schema_name,table_name,name,metadata,url,origin,source_key,format,source_rows,rows_written,sample_seed,filter,mapping) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
        [st.dataset_id, v.write_key, st.schema.name, st.schema.table, asText(metaConst(v).name), JSON.stringify({ entries: v.metadata, column: st.meta_column }), st.url, st.origin ? JSON.stringify(st.origin) : null,
          st.source_key, st.format, st.row_count, written[i].length, seed, where ? String(where) : null, JSON.stringify({ mapping: v.mapping, overrides: v.overrides, field_options: v.field_options })]);
    }
    await conn.run('COMMIT');
    await c.run(`DROP TABLE IF EXISTS ${P}`);
    const total = Number((await conn.runAndReadAll(`SELECT count(*) n FROM ${T}`)).getRowObjectsJson()[0].n);
    const cleaned = cleanup ? await cleanupDownloads(st.dataset_id) : undefined;
    const rows_written = written.reduce((a, w) => a + w.length, 0);
    return { ...(cleaned && { cleanup: cleaned }), mode, dataset_id: st.dataset_id, schema: st.schema.name, table: st.schema.table, target: displayName(tg.tpath), rows_written, total_rows_in_target: total, seed,
      pool_rows: poolRows, ...(excluded.length && { excluded_rows: excluded.length }),
      ...(skipped.some(Boolean) && { rows_skipped: skipped.reduce((a, b) => a + b, 0), skip_reasons: top(reasons) }),
      ...(strat && { [o.balance ? 'balance' : 'stratify_by']: o.balance || o.stratify_by, strata_values: Object.keys(allStrata).length, strata: top(allStrata) }),
      ...(dist && { distinct_by: o.distinct_by, max_per_value: perValue }),
      ...(o.splits?.length ? { splits: parts.map((p, i) => ({ tag: p.key, requested: p.n, rows_written: written[i].length, ...(skipped[i] && { rows_skipped: skipped[i] }), ...(strat && { strata: top(strata[i]) }) })) } : { write_key: parts[0].key }) };
  } catch (e) {
    await conn?.run('ROLLBACK').catch(() => {});
    if (P) await c.run(`DROP TABLE IF EXISTS ${P}`).catch(() => {});
    throw oomHint(e);
  } finally { tg?.close(); }
}

let poolSeq = 0;

// compact: rewrite a target file without the space left by deleted/replaced rows. The file is checkpointed, copied
// table by table into a new file (COPY FROM DATABASE) and swapped in. Also run by compact: true on writes/copies/deletes.
export async function compactTarget(target = 'datasets.duckdb') {
  const p = resolveTarget(target);
  if (!fs.existsSync(p)) throw new Error(`${displayName(p)} does not exist`);
  const size = () => [p, `${p}.wal`].reduce((a, f) => a + (fs.existsSync(f) ? fs.statSync(f).size : 0), 0);
  const before = size(), tmp = `${p}.compact-${process.pid}`;
  for (const f of [tmp, `${tmp}.wal`]) fs.rmSync(f, { force: true });
  const inst = await DuckDBInstance.create(':memory:', { temp_directory: path.join(DATA_DIR, '.tmp') }), conn = await inst.connect();
  try {
    await conn.run(`ATTACH ${q(p)} AS sieve_old`); await conn.run('CHECKPOINT sieve_old'); await conn.run('DETACH sieve_old');
    await conn.run(`ATTACH ${q(p)} AS sieve_old (READ_ONLY)`);
    await conn.run(`ATTACH ${q(tmp)} AS sieve_new`);
    await conn.run('COPY FROM DATABASE sieve_old TO sieve_new');
    await conn.run('DETACH sieve_old'); await conn.run('CHECKPOINT sieve_new'); await conn.run('DETACH sieve_new');
  } catch (e) { for (const f of [tmp, `${tmp}.wal`]) fs.rmSync(f, { force: true }); throw e; } finally { conn.closeSync?.(); inst.closeSync?.(); }
  fs.rmSync(`${tmp}.wal`, { force: true });
  fs.renameSync(tmp, p); fs.rmSync(`${p}.wal`, { force: true });
  const after = size();
  return { target: displayName(p), bytes_before: before, bytes_after: after, bytes_saved: before - after };
}
async function withCompact(o, fn) {
  if (o.compact != null && typeof o.compact !== 'boolean') throw new Error('compact must be true or false');
  const r = await fn();
  return o.compact ? { ...r, compact: await compactTarget(o.target || 'datasets.duckdb') } : r;
}

// balance: the field's value as SQL, so balancing is stratification in DuckDB. Supported: value_from (the map as a
// CASE, regex keys included) or a field mapped to source columns (first non-null). Fixed/derived fields can't be balanced.
async function balanceExpr(c, v, field) {
  const f = v.schema.fields.find((x) => x.name === field);
  if (!f) throw new Error(`balance: schema ${v.schema.name} has no field "${field}"`);
  if (field in v.overrides) throw new Error(`balance: ${field} is an override (one value)`);
  const fo = { ...f, ...v.field_options?.[field] };
  if (fo.value_from?.column) {
    const x = `CAST(${await pathExpr(c, v, fo.value_from.column, 'balance')} AS VARCHAR)`, m = fo.value_from.map;
    if (!m) return x;
    const lit = (y) => (y == null ? 'NULL' : q(typeof y === 'string' ? y : JSON.stringify(y)));
    const keys = Object.keys(m).filter((k) => k !== '*');
    const exact = keys.filter((k) => !reKey(k)), res = keys.filter((k) => reKey(k));
    const whens = [...exact.map((k) => `WHEN ${x} = ${q(k)} THEN ${lit(m[k])}`),
      ...res.map((k) => { const [, p, fl] = reKey(k), opt = fl.replace(/[^imsx]/g, ''); return `WHEN regexp_matches(${x}, ${q(p)}${opt ? `, ${q(opt)}` : ''}) THEN ${lit(m[k])}`; })];
    const star = lit(m['*'] ?? null);
    return whens.length ? `(CASE WHEN ${x} IS NULL THEN ${star} ${whens.join(' ')} ELSE ${star} END)` : star;
  }
  const cols = v.mapping[field] || [];
  if (!cols.length) throw new Error(`balance: ${field} is not mapped to a source column (map it, give it value_from, or use stratify_by)`);
  const es = [];
  for (const col of cols) es.push(`CAST(${await pathExpr(c, v, col, 'balance')} AS VARCHAR)`);
  return es.length > 1 ? `coalesce(${es.join(', ')})` : es[0];
}

// Copy written rows from one target file to another (rows keep id, source_row, meta, write_key, created_at), with their
// datasets records. where filters the source table; n takes a seeded sample. Rows with the same id are replaced.
async function copyRowsInner({ source_target, table, target, where, n, seed = 42 } = {}) {
  if (!source_target || !target) throw new Error('copy_rows needs source_target and target');
  const sp = resolveTarget(source_target);
  if (!fs.existsSync(sp)) throw new Error(`${displayName(sp)} does not exist`);
  if (sp === resolveTarget(target)) throw new Error('source_target and target are the same file');
  const tg = await openTarget(target);
  const { conn } = tg;
  try {
    await conn.run(`ATTACH ${q(sp)} AS sieve_src (READ_ONLY)`);
    const tables = (await conn.runAndReadAll("SELECT table_name t FROM duckdb_tables() WHERE database_name = 'sieve_src' AND table_name <> 'datasets' ORDER BY 1")).getRowObjectsJson().map((x) => x.t);
    if (!table && tables.length !== 1) throw new Error(`pass table: ${tables.join(', ') || '(no tables)'}`);
    table ||= tables[0];
    if (!tables.includes(table)) throw new Error(`Unknown table "${table}". Tables: ${tables.join(', ')}`);
    const T = ident(table), hasRecs = (await conn.runAndReadAll("SELECT count(*)::INT n FROM duckdb_tables() WHERE database_name = 'sieve_src' AND table_name = 'datasets'")).getRowObjectsJson()[0].n > 0;
    const schemaName = hasRecs ? (await conn.runAndReadAll('SELECT any_value(schema_name) s FROM sieve_src.datasets WHERE table_name = $1', [table])).getRowObjectsJson()[0]?.s : null;
    let schema = null; try { schema = schemaName && getSchema(schemaName); } catch {}
    if (schema && schema.table === table) { // create/upgrade the target like a write (prepareTarget looks at main.* only)
      await conn.run('DETACH sieve_src'); await prepareTarget(conn, schema); await conn.run(`ATTACH ${q(sp)} AS sieve_src (READ_ONLY)`);
    } else await conn.run(`CREATE TABLE IF NOT EXISTS ${T} AS SELECT * FROM sieve_src.${T} LIMIT 0`);
    const sel = `SELECT * FROM sieve_src.${T} WHERE ${whereSql(where)} ORDER BY hash(id, ${intOr(seed, 42)}), id${n != null ? ` LIMIT ${Math.max(0, intOr(n, 0))}` : ''}`;
    await conn.run('BEGIN');
    await conn.run(`CREATE TEMP TABLE sieve_copy AS ${sel}`);
    await conn.run(`DELETE FROM ${T} WHERE id IN (SELECT id FROM sieve_copy)`);
    await conn.run(`INSERT INTO ${T} BY NAME SELECT * FROM sieve_copy`);
    const copied = Number((await conn.runAndReadAll('SELECT count(*) n FROM sieve_copy')).getRowObjectsJson()[0].n);
    let records = 0;
    if (hasRecs && (await conn.runAndReadAll("SELECT count(*)::INT n FROM duckdb_tables() WHERE database_name = current_database() AND table_name = 'datasets'")).getRowObjectsJson()[0].n) {
      const inKeys = (a) => `EXISTS (SELECT 1 FROM sieve_copy k WHERE k.dataset_id = ${a}.dataset_id AND coalesce(k.write_key, '') = coalesce(${a}.write_key, ''))`;
      await conn.run(`DELETE FROM datasets d WHERE table_name = $1 AND ${inKeys('d')}`, [table]);
      await conn.run(`INSERT INTO datasets BY NAME SELECT * FROM sieve_src.datasets d WHERE table_name = $1 AND ${inKeys('d')}`, [table]);
      await conn.run(`UPDATE datasets d SET rows_written = (SELECT count(*) FROM ${T} r WHERE r.dataset_id = d.dataset_id AND coalesce(r.write_key, '') = coalesce(d.write_key, '')) WHERE table_name = $1 AND ${inKeys('d')}`, [table]);
      records = Number((await conn.runAndReadAll(`SELECT count(*) n FROM datasets d WHERE table_name = $1 AND ${inKeys('d')}`, [table])).getRowObjectsJson()[0].n);
    }
    await conn.run('DROP TABLE sieve_copy');
    await conn.run('COMMIT');
    const total = Number((await conn.runAndReadAll(`SELECT count(*) n FROM ${T}`)).getRowObjectsJson()[0].n);
    return { source_target: displayName(sp), target: displayName(tg.tpath), table, rows_copied: copied, records_copied: records, total_rows_in_target: total };
  } catch (e) { await conn.run('ROLLBACK').catch(() => {}); throw e; } finally { tg.close(); }
}

// Remove a dataset's rows (all write_keys, or one) and its datasets records from a target file.
async function deleteInner(id, { target = 'datasets.duckdb', write_key } = {}) {
  if (!fs.existsSync(resolveTarget(target))) throw new Error(`${displayName(resolveTarget(target))} does not exist`);
  const tg = await openTarget(target);
  try {
    const recs = (await tg.conn.runAndReadAll('SELECT DISTINCT table_name t FROM datasets WHERE dataset_id = $1', [id])).getRowObjectsJson();
    const wk = write_key == null ? null : String(write_key);
    let rows = 0, records = 0;
    await tg.conn.run('BEGIN');
    for (const { t } of recs) {
      const has = (await tg.conn.runAndReadAll('SELECT count(*) n FROM duckdb_columns() WHERE table_name = $1 AND column_name = \'write_key\'', [t])).getRowObjectsJson()[0].n > 0;
      const cond = wk != null && has ? ` AND coalesce(write_key, '') = ${q(wk)}` : '';
      rows += Number((await tg.conn.runAndReadAll(`SELECT count(*) n FROM "${t}" WHERE dataset_id = $1${cond}`, [id])).getRowObjectsJson()[0].n);
      await tg.conn.run(`DELETE FROM "${t}" WHERE dataset_id = $1${cond}`, [id]);
    }
    const has = (await tg.conn.runAndReadAll('SELECT count(*) n FROM duckdb_columns() WHERE table_name = \'datasets\' AND column_name = \'write_key\'')).getRowObjectsJson()[0].n > 0;
    const cond = wk != null && has ? ` AND write_key = ${q(wk)}` : '';
    records = Number((await tg.conn.runAndReadAll(`SELECT count(*) n FROM datasets WHERE dataset_id = $1${cond}`, [id])).getRowObjectsJson()[0].n);
    await tg.conn.run(`DELETE FROM datasets WHERE dataset_id = $1${cond}`, [id]);
    await tg.conn.run('COMMIT');
    return { dataset_id: id, write_key: wk, target: displayName(tg.tpath), rows_deleted: rows, records_deleted: records };
  } catch (e) { await tg.conn.run('ROLLBACK').catch(() => {}); throw e; } finally { tg.close(); }
}
// Delete every row written under one write_key in a table (any dataset_id) and its datasets records; used by boards,
// whose write_key owns its rows, so a re-run replaces the previous run even when sources were re-imported.
export async function deleteWriteKey(target, table, write_key) {
  if (!fs.existsSync(resolveTarget(target))) return { rows_deleted: 0 };
  const tg = await openTarget(target);
  try {
    const has = async (t) => (await tg.conn.runAndReadAll("SELECT count(*)::INT n FROM duckdb_columns() WHERE schema_name = 'main' AND table_name = $1 AND column_name = 'write_key'", [t])).getRowObjectsJson()[0].n > 0;
    if (!(await has(table))) return { rows_deleted: 0 };
    await tg.conn.run('BEGIN');
    const rows = Number((await tg.conn.runAndReadAll(`SELECT count(*) n FROM ${ident(table)} WHERE write_key = $1`, [String(write_key)])).getRowObjectsJson()[0].n);
    await tg.conn.run(`DELETE FROM ${ident(table)} WHERE write_key = $1`, [String(write_key)]);
    if (await has('datasets')) await tg.conn.run('DELETE FROM datasets WHERE table_name = $1 AND write_key = $2', [table, String(write_key)]);
    await tg.conn.run('COMMIT');
    return { rows_deleted: rows };
  } catch (e) { await tg.conn.run('ROLLBACK').catch(() => {}); throw e; } finally { tg.close(); }
}

// One shot: HF name/URL + schema -> download, auto-map, sample, write.
export async function runPipeline({ url, schema = 'default', config, split, format, table, limit, fetch, columns, fetch_seed, row_groups, max_rows_per_group, explode, metadata, target_column, mapping, overrides, field_options, target, mode, ...write }) {
  const imp = await importDataset(url, { schema, config, split, format, table, limit, fetch, columns, seed: fetch_seed, row_groups, max_rows_per_group, explode, mapping, metadata, where: write.where, splits: write.splits, field_options });
  await setMetadata(imp.dataset_id, metadata, { mapping, target_column, field_options });
  const res = await convertAndWrite(imp.dataset_id, { ...write, overrides, target, mode: mode || (fs.existsSync(resolveTarget(target)) ? 'append' : 'create') });
  return { ...res, download_bytes: imp.download_bytes, hf: imp.hf, mapping: datasets.get(imp.dataset_id).mapping };
}
