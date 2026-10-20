// Core pipeline: import -> map to a schema -> metadata -> sample & write to DuckDB.
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import os from 'node:os';
import zlib from 'node:zlib';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const DL_DIR = path.join(DATA_DIR, 'downloads');
fs.mkdirSync(DL_DIR, { recursive: true });

import { getSchema } from './schemas.js';

const datasets = new Map(); // dataset_id -> state
let mem;
async function memConn() {
  if (!mem) mem = await (await DuckDBInstance.create(':memory:')).connect();
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
    return e('gated', `${repo} is gated, private or doesn't exist (HTTP ${status}). If it is gated, request access on https://huggingface.co/datasets/${repo} with the account whose HF_TOKEN Sieve uses${process.env.HF_TOKEN ? '' : ' (HF_TOKEN is not set)'}.`);
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
  const [sp, info] = await Promise.all([hfApi('splits', repo), hfApi('size', repo).catch(() => null)]);
  const rows = new Map((info?.size?.splits || []).map((x) => [`${x.config}/${x.split}`, x.num_rows]));
  return { dataset: repo, splits: sp.splits.map(({ config, split }) => ({ config, split, rows: rows.get(`${config}/${split}`) ?? null })) };
}
// Parquet shards for one config/split (default: a config that has a train split).
// datasets-server first; if that fails, list the Hub's refs/convert/parquet branch directly.
async function hfShards(repo, opts = {}) {
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
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
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
    if (process.env.HF_TOKEN) await c.run(`CREATE OR REPLACE SECRET sieve_hf (TYPE http, SCOPE 'https://huggingface.co', EXTRA_HTTP_HEADERS MAP {'Authorization': ${q('Bearer ' + process.env.HF_TOKEN)}})`);
  })().catch((e) => { httpfsReady = null; throw e; });
  return httpfsReady;
}
const httpError = (repo, e) => { const m = String(e.message || e), s = +(m.match(/\b(401|403)\b/) || [])[1]; return s ? hfError(repo, s, m) : e; };
const seededShuffle = (arr, seed) => { const a = [...arr], r = rng(seed); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// Partial HF fetch into small local files, reading only the needed columns and row groups.
// fetch="random" (default): seeded random row groups from up to 16 shards (at least 8 groups when there are that many);
// fetch="head": the first `limit` rows.
async function fetchHfRemote(c, repo, urls, limit, id, { fetch: mode = 'random', seed = 42, columns } = {}) {
  await ensureHttpfs(c);
  const proj = columns?.length ? columns.map(ident).join(', ') : '* EXCLUDE (file_row_number)';
  const sel = (u, i, cond = '') => `SELECT ${proj}, file_row_number + ${i * SHARD} AS ${ROWCOL} FROM read_parquet(${q(u)}, file_row_number=true)${cond}`;
  const files = []; let have = 0;
  try {
    if (mode === 'head') {
      for (const [i, u] of urls.entries()) {
        const f = path.join(DL_DIR, `${id}-${i}.parquet`);
        await c.run(`COPY (${sel(u, i)} LIMIT ${limit - have}) TO ${q(f)} (FORMAT parquet)`);
        files.push(f); have += await countRows(c, f);
        if (have >= limit) break;
      }
      return files;
    }
    const shards = seededShuffle(urls.map((u, i) => ({ u, i })), seed).slice(0, 16);
    const groups = [];
    for (const { u, i } of shards) {
      let start = 0;
      for (const g of (await c.runAndReadAll(`SELECT row_group_id g, max(row_group_num_rows) n FROM parquet_metadata(${q(u)}) GROUP BY 1 ORDER BY 1`)).getRowObjectsJson())
        groups.push({ u, i, start: (start += +g.n) - +g.n, n: +g.n });
    }
    const avg = groups.reduce((a, g) => a + g.n, 0) / Math.max(1, groups.length);
    const per = Math.ceil(limit / Math.min(groups.length, Math.max(8, Math.ceil(limit / avg))));
    const take = [];
    for (const g of seededShuffle(groups, seed + 1)) {
      if (have >= limit) break;
      const n = Math.min(per, g.n, limit - have);
      take.push({ ...g, n }); have += n;
    }
    for (const i of [...new Set(take.map((g) => g.i))].sort((a, b) => a - b)) {
      const parts = take.filter((g) => g.i === i).sort((a, b) => a.start - b.start)
        .map((g) => `(${sel(g.u, i, ` WHERE file_row_number BETWEEN ${g.start} AND ${g.start + g.n - 1}`)})`);
      const f = path.join(DL_DIR, `${id}-${i}.parquet`);
      await c.run(`COPY (${parts.join(' UNION ALL ')}) TO ${q(f)} (FORMAT parquet)`);
      files.push(f);
    }
    return files;
  } catch (e) { throw httpError(repo, e); }
}
// Small limits: datasets-server /rows API, 100 rows per request (first rows).
async function fetchHfRows(c, repo, hf, limit, id) {
  const rows = [];
  for (let off = 0; off < limit; off += 100) {
    const j = await hfFetch(repo, `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(repo)}&config=${encodeURIComponent(hf.config)}&split=${encodeURIComponent(hf.split)}&offset=${off}&length=${Math.min(100, limit - off)}`);
    const page = j.rows || [];
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
const classNames = (t) => (!t ? null : Array.isArray(t) ? classNames(t[0]) : t._type === 'ClassLabel' ? t.names || null : t.feature ? classNames(t.feature) : null);
const classLabels = (features) => Object.fromEntries(Object.entries(features || {}).map(([k, t]) => [k, classNames(t)]).filter(([, n]) => n));
// Sidecar "<id>.origin.json" next to HF downloads, so re-importing a downloaded file keeps its HF origin and features.
const sidecarFor = (file) => {
  const m = path.basename(file).match(/^([0-9a-f]{8})-\d+\.parquet$/);
  const p = m && path.join(path.dirname(file), `${m[1]}.origin.json`);
  return p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

// Columns an import needs: explicit `columns`, else the roots of mapping/metadata column refs plus columns named in `where`.
function neededColumns(names, opts) {
  if (opts.columns?.length) {
    const bad = opts.columns.filter((x) => !names.includes(x));
    if (bad.length) throw new Error(`Unknown columns: ${bad.join(', ')}. Columns: ${names.join(', ')}`);
    return opts.columns;
  }
  const maps = [opts.mapping, ...(opts.splits || []).map((p) => p?.mapping)].filter(Boolean);
  const refs = [...maps.flatMap((m) => Object.values(m).flat()), ...(Array.isArray(opts.metadata) ? opts.metadata.map((e) => e?.column) : [])]
    .filter((x) => x != null && x !== 'source_row').map(String);
  if (!refs.length) return null;
  const used = new Set(refs.map((r) => (names.includes(r) ? r : r.split(/[.[]/)[0])).filter((n) => names.includes(n)));
  for (const p of [opts.where, ...(opts.splits || []).map((x) => x?.where)].filter(Boolean))
    for (const n of names) if (new RegExp(`(^|[^\\w])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w])`).test(p)) used.add(n);
  for (const fo of [opts.field_options, ...(opts.splits || []).map((p) => p?.field_options)].flatMap((x) => Object.values(x || {})))
    for (const g of [fo?.gold_from?.column].filter(Boolean).map((x) => String(x).split(/[.[]/)[0])) if (names.includes(g)) used.add(g);
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
    if (limit) {
      await ensureHttpfs(c);
      try {
        const names = (await c.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet(${q(hf.urls[0])})`)).getRowObjectsJson().map((r) => r.column_name);
        columns = neededColumns(names, opts);
      } catch (e) { if (opts.columns?.length || e.kind) throw e; }
    }
    const fetchOpts = { fetch: opts.fetch === 'head' ? 'head' : 'random', seed: intOr(opts.seed, 42), columns };
    const tries = limit ? [['httpfs', () => fetchHfRemote(c, repo, hf.urls, limit, id, fetchOpts)]] : [];
    if (limit && limit <= 1000 && fetchOpts.fetch === 'head') tries.push(['rows-api', () => fetchHfRows(c, repo, hf, limit, id)]);
    tries.push(['download', () => fetchHfFull(c, repo, hf.urls, limit, id)]);
    for (const [via, fn] of tries) {
      try { files = await fn(); hf.via = via; break; } catch (e) {
        ownFiles(id).forEach((f) => fs.rmSync(f, { force: true }));
        if (e.kind === 'gated' || via === 'download') throw e;
        hf.errors = [...(hf.errors || []), `${via}: ${String(e.message || e).slice(0, 200)}`];
      }
    }
    if (hf.via === 'httpfs') Object.assign(hf, { fetch: fetchOpts.fetch, ...(fetchOpts.fetch === 'random' && { seed: fetchOpts.seed }), ...(columns && { columns }) });
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
  let cols = (await c.runAndReadAll(`DESCRIBE SELECT * FROM ${src}`)).getRowObjectsJson().map((r) => ({ name: r.column_name, type: r.column_type }));
  const rowCol = cols.some((x) => x.name === ROWCOL);
  cols = cols.filter((x) => x.name !== ROWCOL);
  const rowCount = Number((await c.runAndReadAll(`SELECT count(*) n FROM ${src}`)).getRowObjectsJson()[0].n);
  if (origin) url = origin.url;
  const name = origin?.repo || path.basename(url.split('?')[0]).replace(/\.\w+$/, '');
  const st = {
    dataset_id: id, url, src, row_col: rowCol, limit, tables, table, format, columns: cols, row_count: rowCount, origin,
    source_key: origin ? `hf:${origin.repo}/${origin.config}/${origin.split}` : `${format}:${url}${table ? `#${table}` : ''}`,
    hf: hf && { repo, config: hf.config, split: hf.split, shards: hf.shards, via: hf.via, ...(hf.fetch && { fetch: hf.fetch }), ...(hf.seed != null && { seed: hf.seed }), ...(hf.columns && { columns: hf.columns }), ...(hf.listing && { listing: hf.listing }), ...(hf.errors && { fallback_errors: hf.errors }) },
    files, download_bytes: bytesOf(files), class_labels: classLabels(features),
    metadata: [{ key: 'name', value: name }, { key: 'domain', value: 'general' }, { key: 'source', value: url }],
    meta_column: null, field_options: {},
    schema: null, mapping: {}, overrides: {},
  };
  useSchema(st, opts.schema || 'default');
  if (opts.mapping) Object.assign(st.mapping, normMapping(st, opts.mapping));
  datasets.set(id, st);
  return summary(st);
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
  throw new Error(`${what}: unknown column "${ref}"`);
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
  return r.getRowObjectsJS().map((row) => { for (const k of js) if (typeof row[k] === 'string') { try { row[k] = JSON.parse(row[k]); } catch {} } return norm(row); });
};

export async function preview(id, n = 5, where) {
  const st = get(id);
  const c = await memConn();
  const raw = await readRows(c, `SELECT * FROM ${numbered(st)} WHERE ${whereSql(where)} LIMIT ${Math.min(+n || 5, 50)}`);
  return { ...summary(st), raw: raw.map(({ __row, ...r }) => r), converted: raw.map((r) => convertRow(r, st)) };
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
// Per-dataset (or per-split) changes to schema field properties, e.g. {label: {label_mode: "index"}, option_labels: {gold_from: {...}}}.
function normFieldOptions(st, fo) {
  const out = {};
  for (const [field, o] of Object.entries(fo || {})) {
    if (!st.schema.fields.some((f) => f.name === field)) throw new Error(`Schema has no field "${field}"`);
    if (o == null) { out[field] = {}; continue; }
    if (typeof o !== 'object' || 'name' in o || 'type' in o) throw new Error(`field_options.${field}: an object of field properties (not name/type)`);
    if (o.label_mode != null && !LABEL_MODES.includes(o.label_mode)) throw new Error(`field_options.${field}.label_mode must be one of ${LABEL_MODES}`);
    if (o.gold_from?.column) checkRef(st, o.gold_from.column, `field_options.${field}.gold_from`);
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
  if (opts.field_options) st.field_options = { ...st.field_options, ...normFieldOptions(st, opts.field_options) };
  if (Array.isArray(meta)) st.metadata = mergeMeta(st, [], meta);
  else if (meta && Object.keys(meta).length) st.metadata = mergeMeta(st, st.metadata, meta);
  if (opts.target_column !== undefined) {
    const f = st.schema.fields.find((x) => x.name === opts.target_column);
    if (opts.target_column && (!f || !['json', 'text'].includes(f.type))) throw new Error(`target_column must be a json/text field of schema ${st.schema.name}`);
    st.meta_column = opts.target_column || null;
  }
  if (opts.overrides) Object.assign(st.overrides, opts.overrides);
  return summary(st);
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
  return { probabilities: f.as === 'list' ? ids.map((id, i) => ({ id, p: r[i] })) : Object.fromEntries(ids.map((id, i) => [id, r[i]])) };
}
const argmax = (d, ids) => {
  const ps = Array.isArray(d.probabilities) ? d.probabilities.map((x) => x.p) : ids.map((id) => d.probabilities[id]);
  return ps.indexOf(Math.max(...ps));
};
function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const LATE = ['label_to_option', 'label_to_distribution', 'options_dict']; // need the options field first
function convertRow(r, st) {
  const row = Number(r.__row ?? 0);
  const F = st.schema.fields.map((f) => ({ ...f, ...st.field_options?.[f.name] }));
  const wk = st.write_key ? `${st.write_key}-` : '';
  const out = { id: `${st.dataset_id}-${wk}${row}`, dataset_id: st.dataset_id, source_row: row };
  const meta = Object.fromEntries(st.metadata.map((e) => [e.key, e.column ? pick(r, e.column) : e.value]));
  const raw = {}, gold = {}, cut = new Set(), explicit = {};
  const optionFields = new Set(F.filter((f) => LATE.includes(f.transform)).map((f) => f.option_field));
  const metaField = F.find((f) => f.name === st.meta_column);
  const order = [...F.filter((f) => f !== metaField && !LATE.includes(f.transform)), ...LATE.flatMap((t) => F.filter((f) => f !== metaField && f.transform === t)), ...(metaField ? [metaField] : [])];
  const ctxFor = (f, cols) => { // options context for label / distribution / options_dict fields
    const labelField = f.label_field || F.find((g) => g.transform === 'label_to_option' && g.option_field === f.option_field)?.name;
    const srcCol = (cols[0] || (f.transform !== 'label_to_option' && st.mapping[labelField]?.[0]) || '').split(/[.[]/)[0];
    const names = st.class_labels?.[srcCol] || null;
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
    else if (f.transform === 'constant') v = f.value;
    else if (f.transform === 'metadata') v = meta[f.value || f.name];
    else if (f.transform === 'meta') v = null;
    else if (f.transform === 'join' && cols.length > 1) v = cols.map((c) => `${c}: ${asText(pick(r, c)) ?? ''}`).join('\n');
    else if (f.transform === 'shuffle') { // gold = gold_from {column, map} (value -> item index or mapped column name), else the first item
      const items = cols.length > 1 ? cols.map((c) => pick(r, c)) : asList(cols.length ? pick(r, cols[0]) : null);
      let g = 0;
      if (f.gold_from?.column) {
        const gv = asText(pick(r, f.gold_from.column)), m = f.gold_from.map ? f.gold_from.map[gv] : gv;
        g = cols.length > 1 && typeof m === 'string' && cols.includes(m) ? cols.indexOf(m) : isNum(m) && Number.isInteger(+m) ? +m : -1;
        if (g >= (items?.length || 0)) g = -1;
      }
      if (items?.length) {
        const rand = rng(Math.imul((st.seed ?? 42) + 1, 2654435761) ^ row), perm = items.map((_, i) => i);
        for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
        v = perm.map((i) => items[i]);
        const gi = g >= 0 ? perm.indexOf(g) : null;
        if (f.gold_field) gold[f.gold_field] = gi; else meta.gold_index = gi;
      } else v = null;
    }
    else if (f.transform === 'options_dict') v = o.opts?.length ? (f.as === 'object' ? Object.fromEntries(o.ids.map((id, i) => [id, o.opts[i]])) : o.ids.map((id, i) => ({ id, text: o.opts[i] }))) : null;
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
  // A label that is missing or not an option takes the argmax option of its distribution (e.g. a binned score).
  for (const f of F.filter((x) => x.transform === 'label_to_option' && !(x.name in st.overrides))) {
    const d = F.find((g) => g.transform === 'label_to_distribution' && g.option_field === f.option_field && out[g.name]);
    const opts = out[f.option_field];
    const valid = (x) => opts?.some((op) => String(op) === String(x));
    const cur = out[f.name], parsed = (() => { try { return JSON.parse(cur); } catch { return null; } })();
    if (!d || !opts?.length || cur != null && (valid(cur) || Array.isArray(parsed) && parsed.length && parsed.every(valid))) continue;
    out[f.name] = cast(opts[argmax(out[d.name], optionIds(d, opts, explicit[f.option_field]))], f, (n) => cut.add(n));
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
export async function convertAndWrite(id, o = {}) {
  const { target = 'datasets.duckdb', mode = 'append', cleanup = false, where, exclude_dataset_ids = [], exclude_same_source = false } = o;
  if (!['create', 'append'].includes(mode)) throw new Error('mode must be create or append');
  const exists = fs.existsSync(resolveTarget(target));
  const shown = displayName(resolveTarget(target));
  if (mode === 'create' && exists) throw new Error(`${shown} already exists (use mode=append)`);
  if (mode === 'append' && !exists) throw new Error(`${shown} does not exist (use mode=create)`);
  const st = get(id);
  const seed = intOr(o.seed, 42);
  const parts = (o.splits?.length ? o.splits : [{ tag: o.write_key || '', n: o.sample }]).map((p) => ({ ...p, key: String(p.tag ?? ''), n: Math.max(1, intOr(p.n, 500)) }));
  if (new Set(parts.map((p) => p.key)).size < parts.length) throw new Error('split tags must be unique');
  const baseMeta = o.metadata ? mergeMeta(st, st.metadata, o.metadata) : st.metadata;
  const views = parts.map((p) => ({ ...st, seed, write_key: p.key, metadata: p.metadata ? mergeMeta(st, baseMeta, p.metadata) : baseMeta, overrides: { ...st.overrides, ...o.overrides, ...p.overrides },
    mapping: { ...st.mapping, ...normMapping(st, o.mapping), ...normMapping(st, p.mapping) },
    field_options: { ...st.field_options, ...normFieldOptions(st, o.field_options), ...normFieldOptions(st, p.field_options) } }));
  const T = `"${st.schema.table}"`, F = st.schema.fields;
  const filter = whereSql(where);
  const tg = await openTarget(target);
  const { conn } = tg;
  try {
    await prepareTarget(conn, st.schema);
    let excluded = [];
    if (exclude_dataset_ids.length || exclude_same_source) {
      const ids = exclude_dataset_ids.map(String);
      excluded = (await conn.runAndReadAll(`SELECT DISTINCT source_row r FROM ${T} WHERE (dataset_id IN (SELECT unnest(from_json($1, '["VARCHAR"]')))
        OR ($2 AND dataset_id IN (SELECT dataset_id FROM datasets WHERE source_key = $3 AND table_name = $4)))
        AND NOT (dataset_id = $5 AND coalesce(write_key, '') IN (SELECT unnest(from_json($6, '["VARCHAR"]'))))`,
        [`[${ids.map((x) => JSON.stringify(x)).join(',')}]`, !!exclude_same_source, st.source_key, st.schema.table, st.dataset_id, `[${parts.map((p) => JSON.stringify(p.key)).join(',')}]`]))
        .getRowObjectsJson().map((x) => Number(x.r));
    }
    const c = await memConn();
    const pool = `SELECT * FROM ${numbered(st)} WHERE ${filter}${excluded.length ? ` AND __row NOT IN (${excluded.join(',')})` : ''}`;
    const poolRows = Number((await c.runAndReadAll(`SELECT count(*) n FROM (${pool})`)).getRowObjectsJson()[0].n);
    // Seeded, reproducible sample: order by hash(row_number, seed).
    const raw = await readRows(c, `${pool} ORDER BY hash(__row, ${seed}) LIMIT ${parts.reduce((a, p) => a + p.n, 0)}`);
    const req = F.filter((f) => f.required).map((f) => f.name);
    let at = 0;
    const written = views.map((v, i) => {
      const chunk = raw.slice(at, (at += parts[i].n));
      return chunk.map((r) => convertRow(r, v)).filter((r) => req.every((k) => r[k] != null));
    });
    await conn.run('BEGIN');
    const names = ['id', 'dataset_id', 'write_key', 'source_row', ...F.map((f) => f.name)];
    const ins = await conn.prepare(`INSERT INTO ${T} (${names.map((n) => `"${n}"`).join(',')}) VALUES (${names.map((_, i) => '$' + (i + 1)).join(',')})`);
    const enc = (f, v) => (v == null ? null : ['list', 'json'].includes(f.type) ? JSON.stringify(v) : v);
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
    const total = Number((await conn.runAndReadAll(`SELECT count(*) n FROM ${T}`)).getRowObjectsJson()[0].n);
    const cleaned = cleanup ? await cleanupDownloads(st.dataset_id) : undefined;
    const rows_written = written.reduce((a, w) => a + w.length, 0);
    return { ...(cleaned && { cleanup: cleaned }), mode, dataset_id: st.dataset_id, schema: st.schema.name, table: st.schema.table, target: displayName(tg.tpath), rows_written, total_rows_in_target: total, seed,
      pool_rows: poolRows, ...(excluded.length && { excluded_rows: excluded.length }),
      ...(o.splits?.length ? { splits: parts.map((p, i) => ({ tag: p.key, requested: p.n, rows_written: written[i].length })) } : { write_key: parts[0].key }) };
  } catch (e) {
    await conn.run('ROLLBACK').catch(() => {});
    throw e;
  } finally { tg.close(); }
}

// Remove a dataset's rows (all write_keys, or one) and its datasets records from a target file.
export async function deleteDataset(id, { target = 'datasets.duckdb', write_key } = {}) {
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

// One shot: HF name/URL + schema -> download, auto-map, sample, write.
export async function runPipeline({ url, schema = 'default', config, split, format, table, limit, fetch, columns, fetch_seed, metadata, target_column, mapping, overrides, field_options, target, mode, ...write }) {
  const imp = await importDataset(url, { schema, config, split, format, table, limit, fetch, columns, seed: fetch_seed, mapping, metadata, where: write.where, splits: write.splits, field_options });
  await setMetadata(imp.dataset_id, metadata, { mapping, overrides, target_column, field_options });
  const res = await convertAndWrite(imp.dataset_id, { ...write, target, mode: mode || (fs.existsSync(resolveTarget(target)) ? 'append' : 'create') });
  return { ...res, download_bytes: imp.download_bytes, hf: imp.hf, mapping: datasets.get(imp.dataset_id).mapping };
}
