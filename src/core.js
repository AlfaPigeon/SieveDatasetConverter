// Core pipeline: import -> map to a schema -> metadata -> sample & write to DuckDB.
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

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
function readerSql(file, format) {
  if (format === 'parquet') return `read_parquet(${q(file)})`;
  if (format === 'csv') return `read_csv_auto(${q(file)}, header=true)`;
  if (format === 'jsonl') return `read_json_auto(${q(file)}, format='newline_delimited')`;
  return `read_json_auto(${q(file)})`;
}

// Hugging Face: "owner/name", "hf://datasets/owner/name", or https://huggingface.co/datasets/owner/name[...]
function parseHf(url) {
  const m = url.match(/^(?:hf:\/\/datasets\/|https?:\/\/huggingface\.co\/datasets\/)?([\w.-]+\/[\w.-]+)\/?(?:$|[?#]|\/(?:viewer|tree)\b)/);
  if (!m || /^https?:\/\//.test(url) && !url.includes('huggingface.co/datasets/')) return null;
  if (/\.(csv|tsv|json|jsonl|ndjson|parquet)(\?|$)/i.test(url)) return null; // direct file
  return m[1];
}
const hfHeaders = () => (process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {});
async function hfApi(endpoint, repo) {
  const r = await fetch(`https://datasets-server.huggingface.co/${endpoint}?dataset=${encodeURIComponent(repo)}`, { headers: hfHeaders() });
  if (!r.ok) {
    const t = await r.text(); let m = t; try { m = JSON.parse(t).error || t; } catch {}
    throw new Error(`Hugging Face: ${String(m).slice(0, 200)}`);
  }
  return r.json();
}
// Configs and splits (with row counts when available) for a Hugging Face dataset.
export async function hfSplits(name) {
  const repo = parseHf(String(name).trim());
  if (!repo) throw new Error('Not a Hugging Face dataset name');
  const [sp, info] = await Promise.all([hfApi('splits', repo), hfApi('size', repo).catch(() => null)]);
  const rows = new Map((info?.size?.splits || []).map((x) => [`${x.config}/${x.split}`, x.num_rows]));
  return { dataset: repo, splits: sp.splits.map(({ config, split }) => ({ config, split, rows: rows.get(`${config}/${split}`) ?? null })) };
}
// Parquet shards for one config/split (default: first config, train split).
async function hfShards(repo, { config, split } = {}) {
  const files = (await hfApi('parquet', repo)).parquet_files || [];
  if (!files.length) throw new Error(`No parquet files for ${repo}`);
  const match = files.filter((f) => (!config || f.config === config) && (!split || f.split === split));
  if (!match.length) throw new Error(`No parquet for config=${config} split=${split}`);
  const first = match.find((f) => f.split === 'train') || match[0];
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

export async function importDataset(url, opts = {}) {
  url = String(url).trim();
  const id = crypto.randomUUID().slice(0, 8);
  const limit = parseLimit(opts.limit);
  let format = opts.format || detectFormat(url), hf = null, src, tables = null, table = null, file = null;
  const repo = fs.existsSync(url) ? null : parseHf(url);
  const c = await memConn();
  if (repo) {
    // Download shards one by one and stop once we have `limit` rows.
    hf = await hfShards(repo, opts); format = 'parquet';
    const files = []; let have = 0;
    for (const [i, u] of hf.urls.entries()) {
      const f = path.join(DL_DIR, `${id}-${i}.parquet`);
      await download(u, f, hfHeaders()); files.push(f);
      have += Number((await c.runAndReadAll(`SELECT count(*) n FROM read_parquet(${q(f)})`)).getRowObjectsJson()[0].n);
      if (limit && have >= limit) break;
    }
    hf.shards = `${files.length}/${hf.urls.length}`; delete hf.urls;
    src = `read_parquet([${files.map(q).join(', ')}])`;
  } else {
    if (!format) throw new Error('Cannot detect format; pass format (csv|json|jsonl|parquet|duckdb)');
    if (fs.existsSync(url)) file = path.resolve(url);
    else {
      file = path.join(DL_DIR, `${id}.${format}`);
      const u = url.includes('huggingface.co/') ? url.replace('/blob/', '/resolve/') : url;
      await download(u, file, u.includes('huggingface.co/') ? hfHeaders() : {});
    }
    src = readerSql(file, format);
    if (format === 'duckdb') {
      const alias = `src_${id}`;
      await c.run(`ATTACH ${q(file)} AS ${alias} (READ_ONLY)`);
      tables = (await c.runAndReadAll(`SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = ${q(alias)} ORDER BY 1, 2`))
        .getRowObjectsJson().map((t) => (t.schema_name === 'main' ? t.table_name : `${t.schema_name}.${t.table_name}`));
      if (!tables.length) throw new Error('No tables in DuckDB source');
      table = opts.table || tables[0];
      if (!tables.includes(table)) throw new Error(`Unknown table "${table}". Tables: ${tables.join(', ')}`);
      src = duckSrc(alias, table);
    }
  }
  src = limited(src, limit);
  const cols = (await c.runAndReadAll(`DESCRIBE SELECT * FROM ${src}`)).getRowObjectsJson().map((r) => ({ name: r.column_name, type: r.column_type }));
  const rowCount = Number((await c.runAndReadAll(`SELECT count(*) n FROM ${src}`)).getRowObjectsJson()[0].n);
  const isLocal = fs.existsSync(url);
  if (isLocal) url = path.basename(url); // keep local paths out of results
  const name = repo || path.basename(url.split('?')[0]).replace(/\.\w+$/, '');
  const st = {
    dataset_id: id, url, src, limit, tables, table, format, columns: cols, row_count: rowCount,
    hf: hf && { repo, config: hf.config, split: hf.split, shards: hf.shards },
    metadata: [{ key: 'name', value: name }, { key: 'domain', value: 'general' }, { key: 'source', value: url }],
    meta_column: null,
    schema: null, mapping: {}, overrides: {},
  };
  useSchema(st, opts.schema || 'default');
  datasets.set(id, st);
  return summary(st);
}

// Suggest source columns for each schema field from its name + aliases.
export function suggestMapping(schema, columnNames) {
  const lower = new Map(columnNames.map((n) => [n.toLowerCase(), n]));
  const used = new Set(); const m = {};
  for (const f of schema.fields) {
    if (['constant', 'metadata', 'meta'].includes(f.transform)) continue;
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
// Metadata is a list of {key, value} (constant) or {key, column} (copied per row from a source column).
function normMetadata(st, meta) {
  if (Array.isArray(meta)) {
    const names = st.columns.map((c) => c.name);
    return meta.filter((e) => e && String(e.key || '').trim()).map((e) => {
      const key = String(e.key).trim();
      if (e.column) { if (!names.includes(e.column)) throw new Error(`metadata ${key}: unknown column "${e.column}"`); return { key, column: e.column }; }
      return { key, value: e.value == null ? '' : String(e.value) };
    });
  }
  const list = st.metadata.map((e) => ({ ...e })); // object form: {key: value} merged into the list
  for (const [k, v] of Object.entries(meta || {})) {
    const i = list.findIndex((e) => e.key === k);
    if (i >= 0) list[i] = { key: k, value: String(v) }; else list.push({ key: k, value: String(v) });
  }
  return list;
}
const metaConst = (st) => Object.fromEntries(st.metadata.filter((e) => !e.column).map((e) => [e.key, e.value]));
function get(id) {
  const st = datasets.get(id);
  if (!st) throw new Error(`Unknown dataset_id ${id}. Call import_dataset first.`);
  return st;
}
function summary(st) {
  const { src, ...rest } = st; // never expose local paths
  return { ...rest, schema: rest.schema?.name };
}
export function listDatasets() { return [...datasets.values()].map(summary); }

export async function preview(id, n = 5) {
  const st = get(id);
  const c = await memConn();
  const raw = (await c.runAndReadAll(`SELECT * FROM ${st.src} LIMIT ${Math.min(+n || 5, 50)}`)).getRowObjectsJson();
  return { ...summary(st), raw, converted: raw.map((r, i) => convertRow(r, i, st)) };
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
  if (opts.mapping) {
    const names = st.columns.map((c) => c.name);
    for (let [field, cols] of Object.entries(opts.mapping)) {
      if (!st.schema.fields.some((f) => f.name === field)) throw new Error(`Schema has no field "${field}"`);
      cols = cols == null ? [] : Array.isArray(cols) ? cols : String(cols).split(',').map((x) => x.trim()).filter(Boolean);
      for (const c of cols) if (!names.includes(c)) throw new Error(`Unknown column "${c}"`);
      st.mapping[field] = cols;
    }
  }
  if (meta && (Array.isArray(meta) || Object.keys(meta).length)) st.metadata = normMetadata(st, meta);
  if (opts.target_column !== undefined) {
    const f = st.schema.fields.find((x) => x.name === opts.target_column);
    if (opts.target_column && (!f || !['json', 'text'].includes(f.type))) throw new Error(`target_column must be a json/text field of schema ${st.schema.name}`);
    st.meta_column = opts.target_column || null;
  }
  if (opts.overrides) Object.assign(st.overrides, opts.overrides);
  return summary(st);
}

// ---- Row conversion ----
const trunc = (s, n) => (s == null ? null : (s = String(s)).length > n ? s.slice(0, n) : s);
const asText = (v) => (v == null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
function asList(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return v.split(/\s*[|;]\s*/); } }
  if (Array.isArray(v)) return v.map(asText);
  if (typeof v === 'object') { // HF {text:[...], label:[...]} style
    const arr = v.text || v.choices || v.options || Object.values(v).find(Array.isArray);
    return Array.isArray(arr) ? arr.map(asText) : [JSON.stringify(v)];
  }
  return [String(v)];
}
function cast(v, f) {
  if (v == null || v === '') return null;
  switch (f.type) {
    case 'number': { const n = Number(v); return Number.isFinite(n) ? n : null; }
    case 'integer': { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
    case 'boolean': return typeof v === 'boolean' ? v : /^(true|1|yes|y)$/i.test(String(v));
    case 'list': {
      let l = asList(v);
      if (f.max_items) l = l.slice(0, f.max_items);
      if (f.item_max_chars) l = l.map((x) => trunc(x, f.item_max_chars));
      return l;
    }
    case 'json': return v;
    case 'text': if (typeof v === 'object') return JSON.stringify(v);
    default: return f.max_chars ? trunc(asText(v), f.max_chars) : asText(v);
  }
}
function convertRow(r, i, st) {
  const out = { id: `${st.dataset_id}-${r.__row ?? i}`, dataset_id: st.dataset_id, source_row: Number(r.__row ?? i) };
  const fields = st.schema.fields;
  const meta = Object.fromEntries(st.metadata.map((e) => [e.key, e.column ? asText(r[e.column]) : e.value]));
  const order = [...fields.filter((f) => f.transform !== 'label_to_option'), ...fields.filter((f) => f.transform === 'label_to_option')];
  for (const f of order) {
    const cols = st.mapping[f.name] || [];
    let v;
    if (f.name in st.overrides) v = st.overrides[f.name];
    else if (f.transform === 'constant') v = f.value;
    else if (f.transform === 'metadata') v = meta[f.value || f.name];
    else if (f.transform === 'meta') v = f.name === st.meta_column ? meta : null;
    else if (f.transform === 'join' && cols.length > 1) v = cols.map((c) => `${c}: ${asText(r[c]) ?? ''}`).join('\n');
    else v = cols.length ? r[cols[0]] : f.default ?? null;
    if (f.transform === 'label_to_option' && v != null) {
      const opts = out[f.option_field];
      const raw = st.mapping[f.option_field]?.length ? r[st.mapping[f.option_field][0]] : null;
      const label = asText(v);
      if (Array.isArray(opts) && !opts.includes(label)) {
        const keys = raw && Array.isArray(raw.label) ? raw.label.map(String) : null;
        const idx = keys && keys.includes(label) ? keys.indexOf(label)
          : /^\d+$/.test(label) ? +label : /^[A-Z]$/.test(label) ? label.charCodeAt(0) - 65 : -1;
        if (idx >= 0 && idx < opts.length) v = opts[idx];
      }
    }
    if (f.name === st.meta_column && f.transform !== 'meta') v = meta;
    v = cast(v, f);
    if (f.enum && v != null && !f.enum.includes(v)) throw new Error(`field ${f.name}: "${v}" not in ${f.enum}`);
    out[f.name] = v;
  }
  return out;
}
const SQLT = { text: 'VARCHAR', number: 'DOUBLE', integer: 'BIGINT', boolean: 'BOOLEAN', list: 'JSON', json: 'JSON' };
function ddl(schema) {
  const cols = schema.fields.map((f) => `"${f.name}" ${SQLT[f.type]}${f.required ? ' NOT NULL' : ''}`);
  return `CREATE TABLE IF NOT EXISTS datasets (
  dataset_id VARCHAR, schema_name VARCHAR, table_name VARCHAR, name VARCHAR, metadata JSON,
  url VARCHAR, format VARCHAR, source_rows BIGINT, rows_written INTEGER, sample_seed INTEGER,
  mapping JSON, written_at TIMESTAMP DEFAULT current_timestamp, PRIMARY KEY (dataset_id, table_name));
CREATE TABLE IF NOT EXISTS "${schema.table}" (id VARCHAR PRIMARY KEY, dataset_id VARCHAR, source_row BIGINT,
  ${cols.join(',\n  ')}, created_at TIMESTAMP DEFAULT current_timestamp);`;
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
export async function convertAndWrite(id, { sample = 500, target = 'datasets.duckdb', seed = 42, mode = 'append' } = {}) {
  if (!['create', 'append'].includes(mode)) throw new Error('mode must be create or append');
  const exists = fs.existsSync(resolveTarget(target));
  const shown = displayName(resolveTarget(target));
  if (mode === 'create' && exists) throw new Error(`${shown} already exists (use mode=append)`);
  if (mode === 'append' && !exists) throw new Error(`${shown} does not exist (use mode=create)`);
  const st = get(id);
  sample = Math.max(1, Math.floor(+sample || 500)); seed = Math.floor(+seed || 0);
  const c = await memConn();
  const src = st.src;
  // Seeded, reproducible sample: order by hash(row_number, seed).
  const raw = (await c.runAndReadAll(
    `SELECT * FROM (SELECT *, row_number() OVER () - 1 AS __row FROM ${src}) ORDER BY hash(__row, ${seed}) LIMIT ${sample}`
  )).getRowObjectsJson();
  const req = st.schema.fields.filter((f) => f.required).map((f) => f.name);
  const rows = raw.map((r, i) => convertRow(r, i, st)).filter((r) => req.every((k) => r[k] != null));
  const T = `"${st.schema.table}"`, F = st.schema.fields;
  const tpath = resolveTarget(target);
  fs.mkdirSync(path.dirname(tpath), { recursive: true });
  const inst = await DuckDBInstance.create(tpath);
  const conn = await inst.connect();
  try {
    await conn.run(ddl(st.schema));
    await conn.run('BEGIN');
    await conn.run(`DELETE FROM ${T} WHERE dataset_id = $1`, [st.dataset_id]);
    await conn.run('DELETE FROM datasets WHERE dataset_id = $1 AND table_name = $2', [st.dataset_id, st.schema.table]);
    const names = ['id', 'dataset_id', 'source_row', ...F.map((f) => f.name)];
    const ins = await conn.prepare(`INSERT INTO ${T} (${names.map((n) => `"${n}"`).join(',')}) VALUES (${names.map((_, i) => '$' + (i + 1)).join(',')})`);
    const enc = (f, v) => (v == null ? null : ['list', 'json'].includes(f.type) ? JSON.stringify(v) : v);
    for (const r of rows) {
      ins.bind([r.id, r.dataset_id, r.source_row, ...F.map((f) => enc(f, r[f.name]))]);
      await ins.run();
    }
    await conn.run('INSERT INTO datasets (dataset_id,schema_name,table_name,name,metadata,url,format,source_rows,rows_written,sample_seed,mapping) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [st.dataset_id, st.schema.name, st.schema.table, metaConst(st).name ?? null, JSON.stringify({ entries: st.metadata, column: st.meta_column }), st.url, st.format, st.row_count, rows.length, seed, JSON.stringify({ mapping: st.mapping, overrides: st.overrides })]);
    await conn.run('COMMIT');
    const total = Number((await conn.runAndReadAll(`SELECT count(*) n FROM ${T}`)).getRowObjectsJson()[0].n);
    return { mode, dataset_id: st.dataset_id, schema: st.schema.name, table: st.schema.table, target: displayName(tpath), rows_written: rows.length, total_rows_in_target: total, seed };
  } catch (e) {
    await conn.run('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    conn.closeSync?.(); inst.closeSync?.();
  }
}

// One shot: HF name/URL + schema -> download, auto-map, sample, write.
export async function runPipeline({ url, schema = 'default', config, split, format, table, limit, metadata, target_column, mapping, overrides, sample = 500, seed = 42, target, mode }) {
  const imp = await importDataset(url, { schema, config, split, format, table, limit });
  await setMetadata(imp.dataset_id, metadata, { mapping, overrides, target_column });
  const res = await convertAndWrite(imp.dataset_id, { sample, seed, target, mode: mode || (fs.existsSync(resolveTarget(target)) ? 'append' : 'create') });
  return { ...res, mapping: datasets.get(imp.dataset_id).mapping };
}
