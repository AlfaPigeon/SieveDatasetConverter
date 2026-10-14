// Core pipeline: import -> map to a schema -> metadata -> sample & write to DuckDB.
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const DL_DIR = path.join(DATA_DIR, 'downloads');
fs.mkdirSync(DL_DIR, { recursive: true });

import { getSchema } from './schemas.js';

const datasets = new Map(); // dataset_id -> state
let mem;
async function memConn() {
  if (!mem) mem = await (await DuckDBInstance.create(':memory:')).connect();
  return mem;
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function detectFormat(p) {
  const l = p.toLowerCase().split('?')[0];
  if (l.endsWith('.parquet')) return 'parquet';
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
async function hfParquetUrl(repo, { config, split } = {}) {
  const headers = process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};
  const r = await fetch(`https://datasets-server.huggingface.co/parquet?dataset=${encodeURIComponent(repo)}`, { headers });
  if (!r.ok) throw new Error(`HF datasets-server ${r.status}: ${await r.text()}`);
  const files = (await r.json()).parquet_files || [];
  if (!files.length) throw new Error(`No parquet files for ${repo}`);
  const match = files.filter((f) => (!config || f.config === config) && (!split || f.split === split));
  if (!match.length) throw new Error(`No parquet for config=${config} split=${split}`);
  const pick = match.find((f) => f.split === 'train') || match[0];
  return { url: pick.url, config: pick.config, split: pick.split, headers };
}
async function download(url, dest, headers = {}) {
  const r = await fetch(url, { headers, redirect: 'follow' });
  if (!r.ok) throw new Error(`Download failed ${r.status} for ${url}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

export async function importDataset(url, opts = {}) {
  url = String(url).trim();
  const id = crypto.randomUUID().slice(0, 8);
  let fileUrl = url, format = opts.format || detectFormat(url), hf = null, headers = {};
  const repo = parseHf(url);
  if (repo) {
    hf = await hfParquetUrl(repo, opts);
    fileUrl = hf.url; format = 'parquet'; headers = hf.headers;
  } else if (url.includes('huggingface.co/') && url.includes('/blob/')) {
    fileUrl = url.replace('/blob/', '/resolve/');
  }
  if (!format) throw new Error('Cannot detect format; pass format (csv|json|jsonl|parquet)');
  const local = fs.existsSync(url) ? path.resolve(url) : path.join(DL_DIR, `${id}.${format}`);
  if (!fs.existsSync(url)) await download(fileUrl, local, process.env.HF_TOKEN && fileUrl.includes('huggingface.co') ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : headers);
  const c = await memConn();
  const src = readerSql(local, format);
  const cols = (await c.runAndReadAll(`DESCRIBE SELECT * FROM ${src}`)).getRowObjectsJson().map((r) => ({ name: r.column_name, type: r.column_type }));
  const rowCount = Number((await c.runAndReadAll(`SELECT count(*) n FROM ${src}`)).getRowObjectsJson()[0].n);
  const name = repo || path.basename(url.split('?')[0]).replace(/\.\w+$/, '');
  const st = {
    dataset_id: id, url, file: local, format, columns: cols, row_count: rowCount,
    hf: hf && { repo, config: hf.config, split: hf.split },
    metadata: { name, domain: 'general', source: url, notes: '' },
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
    if (['constant', 'metadata'].includes(f.transform)) continue;
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
}
function get(id) {
  const st = datasets.get(id);
  if (!st) throw new Error(`Unknown dataset_id ${id}. Call import_dataset first.`);
  return st;
}
function summary(st) {
  const { file, ...rest } = st;
  return { ...rest, schema: rest.schema?.name };
}
export function listDatasets() { return [...datasets.values()].map(summary); }

export async function preview(id, n = 5) {
  const st = get(id);
  const c = await memConn();
  const raw = (await c.runAndReadAll(`SELECT * FROM ${readerSql(st.file, st.format)} LIMIT ${Math.min(+n || 5, 50)}`)).getRowObjectsJson();
  return { ...summary(st), raw, converted: raw.map((r, i) => convertRow(r, i, st)) };
}

// meta: {name, domain, source, notes}; opts: {schema, mapping: {field: [cols]}, overrides: {field: constant}}
export function setMetadata(id, meta = {}, opts = {}) {
  const st = get(id);
  for (const k of ['name', 'domain', 'source', 'notes']) if (meta[k] !== undefined) st.metadata[k] = String(meta[k]);
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
    default: return f.max_chars ? trunc(asText(v), f.max_chars) : asText(v);
  }
}
function convertRow(r, i, st) {
  const out = { id: `${st.dataset_id}-${r.__row ?? i}`, dataset_id: st.dataset_id, source_row: Number(r.__row ?? i) };
  const fields = st.schema.fields;
  const order = [...fields.filter((f) => f.transform !== 'label_to_option'), ...fields.filter((f) => f.transform === 'label_to_option')];
  for (const f of order) {
    const cols = st.mapping[f.name] || [];
    let v;
    if (f.name in st.overrides) v = st.overrides[f.name];
    else if (f.transform === 'constant') v = f.value;
    else if (f.transform === 'metadata') v = st.metadata[f.value || f.name];
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
  dataset_id VARCHAR, schema_name VARCHAR, table_name VARCHAR, name VARCHAR, domain VARCHAR, source VARCHAR, notes VARCHAR,
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
export function listTargets() {
  return fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.duckdb')).map((f) => {
    const st = fs.statSync(path.join(DATA_DIR, f));
    return { name: f, path: path.join(DATA_DIR, f), bytes: st.size, modified: st.mtime.toISOString() };
  });
}
export async function convertAndWrite(id, { sample = 500, target = 'datasets.duckdb', seed = 42, mode = 'append' } = {}) {
  if (!['create', 'append'].includes(mode)) throw new Error('mode must be create or append');
  const exists = fs.existsSync(resolveTarget(target));
  if (mode === 'create' && exists) throw new Error(`Target ${resolveTarget(target)} already exists (use mode=append)`);
  if (mode === 'append' && !exists) throw new Error(`Target ${resolveTarget(target)} does not exist (use mode=create)`);
  const st = get(id);
  sample = Math.max(1, Math.floor(+sample || 500)); seed = Math.floor(+seed || 0);
  const c = await memConn();
  const src = readerSql(st.file, st.format);
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
    const md = st.metadata;
    await conn.run('INSERT INTO datasets (dataset_id,schema_name,table_name,name,domain,source,notes,url,format,source_rows,rows_written,sample_seed,mapping) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [st.dataset_id, st.schema.name, st.schema.table, md.name, md.domain, md.source, md.notes, st.url, st.format, st.row_count, rows.length, seed, JSON.stringify({ mapping: st.mapping, overrides: st.overrides })]);
    await conn.run('COMMIT');
    const total = Number((await conn.runAndReadAll(`SELECT count(*) n FROM ${T}`)).getRowObjectsJson()[0].n);
    return { mode, dataset_id: st.dataset_id, schema: st.schema.name, table: st.schema.table, target: tpath, rows_written: rows.length, total_rows_in_target: total, seed };
  } catch (e) {
    await conn.run('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    conn.closeSync?.(); inst.closeSync?.();
  }
}

// One shot: HF name/URL + schema -> download, auto-map, sample, write.
export async function runPipeline({ url, schema = 'default', config, split, format, metadata = {}, mapping, overrides, sample = 500, seed = 42, target, mode }) {
  const imp = await importDataset(url, { schema, config, split, format });
  setMetadata(imp.dataset_id, metadata, { mapping, overrides });
  const res = await convertAndWrite(imp.dataset_id, { sample, seed, target, mode: mode || (fs.existsSync(resolveTarget(target)) ? 'append' : 'create') });
  return { ...res, mapping: datasets.get(imp.dataset_id).mapping };
}
