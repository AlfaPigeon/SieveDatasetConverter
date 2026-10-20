// Boards: a saved canvas of source nodes (any import), mix nodes (weights, schema, where, stratify/balance) and
// target nodes (a .duckdb file). Stored as JSON in DATA_DIR/boards/<name>.json; previewed and run through core.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import * as core from './core.js';
import * as jobs from './jobs.js';
import { getSchema } from './schemas.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(path.resolve(ROOT, process.env.DATA_DIR || 'data'), 'boards');
const NAME = /^[\w][\w.-]{0,63}$/;
const TYPES = ['source', 'mix', 'target'];
const SOURCE_KEYS = ['url', 'target', 'config', 'split', 'table', 'format', 'limit', 'fetch', 'fetch_seed', 'columns', 'row_groups', 'max_rows_per_group', 'explode', 'mapping', 'field_options', 'metadata'];

const fileOf = (name) => {
  if (!NAME.test(String(name || ''))) throw new Error('board name: letters, digits, _ . - (max 64), e.g. "mix-v1"');
  return path.join(DIR, `${name}.json`);
};

// Check a board and fill defaults. nodes: [{id, type, x?, y?, ...}], edges: [{from, to, weight?, where?, ...}]
// (source -> mix carries the per-source settings; mix -> target says where the mix is written).
export function normBoard(b) {
  if (!b || typeof b !== 'object') throw new Error('board must be an object {name, nodes, edges}');
  fileOf(b.name);
  const nodes = Array.isArray(b.nodes) ? b.nodes : [], edges = Array.isArray(b.edges) ? b.edges : [];
  const byId = new Map();
  for (const n of nodes) {
    if (!n?.id || typeof n.id !== 'string') throw new Error('every node needs a string id');
    if (byId.has(n.id)) throw new Error(`duplicate node id "${n.id}"`);
    if (!TYPES.includes(n.type)) throw new Error(`node ${n.id}: type must be ${TYPES.join(' | ')}`);
    if (n.type === 'source' && !n.url && !n.target) throw new Error(`source ${n.id}: needs url (HF name, URL, path, dataset_id) or target (a .duckdb file in the data dir)`);
    if (n.type === 'mix' && n.n != null && !(Number.isInteger(+n.n) && +n.n > 0)) throw new Error(`mix ${n.id}: n must be a positive integer`);
    if (n.type === 'mix' && n.target_column != null && typeof n.target_column !== 'string') throw new Error(`mix ${n.id}: target_column must be a field name or null`);
    if (n.type === 'target' && n.mode != null && !['auto', 'create', 'append'].includes(n.mode)) throw new Error(`target ${n.id}: mode must be auto | create | append`);
    byId.set(n.id, n);
  }
  for (const e of edges) {
    const a = byId.get(e?.from), z = byId.get(e?.to);
    if (!a || !z) throw new Error(`edge ${e?.from} -> ${e?.to}: unknown node`);
    if (!(a.type === 'source' && z.type === 'mix') && !(a.type === 'mix' && z.type === 'target')) throw new Error(`edge ${e.from} -> ${e.to}: only source -> mix and mix -> target`);
    if (e.weight != null && !(Number.isFinite(+e.weight) && +e.weight >= 0)) throw new Error(`edge ${e.from} -> ${e.to}: weight must be a number >= 0`);
    const at = `edge ${e.from} -> ${e.to}`;
    if (e.mapping != null && (typeof e.mapping !== 'object' || Array.isArray(e.mapping) || Object.values(e.mapping).some((v) => v != null && typeof v !== 'string' && !(Array.isArray(v) && v.every((x) => typeof x === 'string')))))
      throw new Error(`${at}: mapping must be {field: ["column or path", ...]}`);
    if (Array.isArray(e.metadata) && e.metadata.some((m) => !m || typeof m.key !== 'string' || (m.column == null) === (m.value === undefined)))
      throw new Error(`${at}: metadata entries are {key, value} (fixed) or {key, column} (from a column or path)`);
    if (e.metadata != null && typeof e.metadata !== 'object') throw new Error(`${at}: metadata must be a list [{key, value | column}] or an object {key: value}`);
    if (e.target_column != null && typeof e.target_column !== 'string') throw new Error(`${at}: target_column must be a field name or null`);
  }
  if (new Set(edges.map((e) => `${e.from}>${e.to}`)).size < edges.length) throw new Error('duplicate edge');
  return { name: b.name, seed: Number.isInteger(+b.seed) ? +b.seed : 42, ...(b.description && { description: String(b.description) }), nodes, edges, ...(b.view && { view: b.view }) };
}

export function listBoards() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const p = path.join(DIR, f), st = fs.statSync(p);
    let b = {}; try { b = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    const count = (t) => (b.nodes || []).filter((n) => n.type === t).length;
    return { name: f.slice(0, -5), sources: count('source'), mixes: count('mix'), targets: count('target'), modified: st.mtime.toISOString() };
  });
}
export function getBoard(name) {
  const p = fileOf(name);
  if (!fs.existsSync(p)) throw new Error(`no board "${name}"`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
export function saveBoard(board) {
  const b = normBoard(board);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(fileOf(b.name), JSON.stringify(b, null, 2) + '\n');
  return { name: b.name, file: `boards/${b.name}.json`, nodes: b.nodes.length, edges: b.edges.length };
}
const boardOf = (a) => normBoard(a.board || getBoard(a.name));

// Largest remainder: n split by weights, floors first, the rest to the largest fractions (ties: input order).
export function splitByWeight(n, weights) {
  const W = weights.reduce((a, w) => a + w, 0);
  if (!(W > 0)) throw new Error('mix: the weights add up to 0');
  const raw = weights.map((w) => (n * w) / W), out = raw.map(Math.floor);
  let left = n - out.reduce((a, b) => a + b, 0);
  for (const i of raw.map((r, i) => i).sort((a, b) => (raw[b] - out[b]) - (raw[a] - out[a]) || a - b)) { if (!left) break; out[i]++; left--; }
  return out;
}

// One import per (source settings, schema), reused while it lives in this process (re-imported after a restart;
// a seeded random fetch gets the same rows again).
// fresh: import again even if cached (the canvas "Reload"). A schema file edited since the import is re-read.
const loaded = new Map(), schemaSeen = new Map();
async function sourceDataset(node, schema, seed, { fresh = false } = {}) {
  const o = Object.fromEntries(SOURCE_KEYS.filter((k) => node[k] != null).map((k) => [k, node[k]]));
  const url = o.target ? core.resolveTarget(o.target) : o.url;
  const { target: _t, url: _u, fetch_seed, metadata, ...imp } = o;
  const opts = { ...imp, schema, seed: fetch_seed ?? seed };
  const key = JSON.stringify([url, opts, metadata ?? null]);
  const id = loaded.get(key), sj = JSON.stringify(getSchema(schema));
  if (!fresh && id && core.listDatasets().some((d) => d.dataset_id === id && !d.cleaned)) {
    if (schemaSeen.get(id) !== sj) { core.reloadSchema(id); schemaSeen.set(id, sj); }
    return id;
  }
  const r = await core.importDataset(url, opts);
  if (metadata) await core.setMetadata(r.dataset_id, metadata);
  loaded.set(key, r.dataset_id); schemaSeen.set(r.dataset_id, sj);
  return r.dataset_id;
}

// A source card: row count, columns with types (profile) and a few preview rows.
export async function sourceInfo({ node, schema = 'default', seed = 42, rows = 3, fresh = false }) {
  if (!node?.url && !node?.target) throw new Error('source needs url or target');
  const id = await sourceDataset(node, schema, seed, { fresh });
  const d = core.listDatasets().find((x) => x.dataset_id === id);
  const prof = await core.profile(id, { top: 5 });
  const pv = await core.preview(id, Math.min(Math.max(+rows || 3, 0), 10));
  return { dataset_id: id, url: d.url, schema: d.schema, row_count: d.row_count, ...(d.hf && { hf: d.hf }), ...(d.tables && { tables: d.tables, table: d.table }),
    columns: prof.columns, mapping: d.mapping, preview: pv.raw, converted: pv.converted };
}

function mixOf(b, id) {
  const mixes = b.nodes.filter((n) => n.type === 'mix');
  const m = id ? mixes.find((n) => n.id === id) : mixes.length === 1 ? mixes[0] : null;
  if (!m) throw new Error(id ? `no mix "${id}"` : `pass mix: ${mixes.map((n) => n.id).join(', ') || '(no mix nodes)'}`);
  const inputs = b.edges.filter((e) => e.to === m.id).map((e) => ({ edge: e, node: b.nodes.find((n) => n.id === e.from) }));
  if (!inputs.length) throw new Error(`mix ${m.id} has no sources`);
  return { mix: m, inputs, weights: inputs.map(({ edge, node }) => +(edge.weight ?? node.weight ?? 1)) };
}
// Edge settings, as on the wizard's mapping and metadata steps, per source:
//   mapping {field: [column or path, ...]} over the import's suggestion (different sources can map different column
//   names to one schema); metadata: a list [{key, value} | {key, column}] replaces the source's metadata (an object
//   {key: value} adds to it); target_column: the json/text field that stores it per row (null = not stored);
//   field_options / overrides per field. meta always gets board and board_source.
const listMeta = (m) => (Array.isArray(m) ? m : Object.entries(m || {}).map(([key, value]) => ({ key, value })));
const normMap = (m) => Object.fromEntries(Object.entries(m || {}).map(([f, v]) => [f, v == null || v === '' ? [] : [v].flat().map(String)]));
const optsFor = (b, mix, { edge, node }, seed) => ({
  seed, ...(edge.where && { where: edge.where }),
  ...(mix.stratify_by && { stratify_by: mix.stratify_by }), ...(mix.balance && { balance: mix.balance }),
  ...(mix.distinct_by && { distinct_by: mix.distinct_by }), ...(mix.max_per_value && { max_per_value: mix.max_per_value }),
  ...(mix.skip_unknown_labels && { skip_unknown_labels: true }),
  overrides: { ...mix.overrides, ...edge.overrides }, field_options: { ...mix.field_options, ...edge.field_options },
  ...(edge.mapping && { mapping: normMap(edge.mapping) }),
  ...(edge.target_column !== undefined ? { target_column: edge.target_column || null } : mix.target_column !== undefined && { target_column: mix.target_column || null }),
  ...(Array.isArray(edge.metadata) && { replace_metadata: true }),
  metadata: [...listMeta(mix.metadata), ...listMeta(edge.metadata), { key: 'board', value: b.name }, { key: 'board_source', value: node.id }],
});
// What an edge maps to, and whether that is complete: fields the schema reads from source columns get ok, missing
// (required, nothing mapped), unmapped (optional) or unknown (a column the source does not have).
const MAPPABLE = (f) => !['constant', 'metadata', 'meta', 'options_dict'].includes(f.transform);
function effective(d, mix, edge) {
  const mapping = { ...d.mapping, ...normMap(edge.mapping) };
  const metadata = Array.isArray(edge.metadata) ? edge.metadata : [...d.metadata.filter((e) => !(e.key in (edge.metadata || {}))), ...listMeta(edge.metadata)];
  const tc = edge.target_column !== undefined ? edge.target_column : mix.target_column;
  return { mapping, metadata, target_column: tc !== undefined ? tc || null : d.meta_column };
}
// mix.balance makes its field required too: balancing by a field the source can't fill would fail
export function checkEdge(d, schema, eff, mix = {}) {
  const names = d.columns.map((c) => c.name);
  const known = (r) => r === 'source_row' || names.includes(r) || names.includes(String(r).split(/[.[]/)[0]);
  const fields = {}, missing = [], unknown = [];
  for (const f of schema.fields.filter(MAPPABLE)) {
    const cols = eff.mapping[f.name] || [], bad = cols.filter((c) => !known(c));
    fields[f.name] = bad.length ? 'unknown' : cols.length ? 'ok' : f.required || (mix.balance === f.name && !f.value_from) ? 'missing' : 'unmapped';
    if (bad.length) unknown.push(...bad.map((column) => ({ field: f.name, column })));
    if (fields[f.name] === 'missing') missing.push(f.name);
  }
  for (const e of eff.metadata.filter((x) => x.column && !known(x.column))) unknown.push({ metadata: e.key, column: e.column });
  const vals = Object.values(fields);
  // one-click fix for a missing required field: the first column no field uses, text columns first
  const used = new Set(Object.values(eff.mapping).flat().map((r) => String(r).split(/[.[]/)[0]));
  const rank = (c) => (/^VARCHAR/.test(c.type) ? 0 : 2) + (/(^|_)(id|key|uuid|hash)$/i.test(c.name) ? 1 : 0) - (/question|text|prompt|input|stem|sentence|content|query|instruction/i.test(c.name) ? 1 : 0);
  const free = [...d.columns].sort((a, b) => rank(a) - rank(b)).map((c) => c.name).filter((c) => !used.has(c) && c !== '_sieve_row');
  const fixes = Object.fromEntries(missing.map((f, i) => [f, free[i]]).filter(([, c]) => c));
  return { ok: !missing.length && !unknown.length, mapped: vals.filter((v) => v === 'ok').length, fields: vals.length, status: fields, missing, unknown, ...(missing.length && { fixes }) };
}
const datasetOf = (id) => core.listDatasets().find((x) => x.dataset_id === id);
const missingMsg = (ck) => `${ck.missing.join(', ')} not mapped`;
const unknownMsg = (ck) => `mapping: ${ck.unknown.map((u) => `${u.field || `metadata ${u.metadata}`} → unknown column "${u.column}"`).join(', ')}`;
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0; return h; };

// preview_mix: the combined seeded sample of a mix (n rows split over its sources by weight), each row tagged with
// its source node id in _source and interleaved in a seeded order. Nothing is written.
export async function previewMix(a = {}) {
  const b = boardOf(a), { mix, inputs, weights } = mixOf(b, a.mix);
  const seed = +(mix.seed ?? b.seed), schema = mix.schema || 'default';
  const n = Math.min(Math.max(+(a.n ?? 20) || 20, 1), 500), ks = splitByWeight(n, weights);
  const quotas = splitByWeight(+(mix.n ?? 500), weights); // what a write would ask of each source
  const sources = [], rows = [];
  for (const [i, inp] of inputs.entries()) {
    // a failing source is reported in its entry (error), the others still preview
    let id, check;
    try {
      jobs.progress(`Sampling ${inp.node.id}`, i, inputs.length, 'sources');
      id = await sourceDataset(inp.node, schema, b.seed);
      check = checkEdge(datasetOf(id), getSchema(schema), effective(datasetOf(id), mix, inp.edge), mix);
      if (check.unknown.length) { sources.push({ source: inp.node.id, dataset_id: id, weight: weights[i], requested: ks[i], rows: 0, quota: quotas[i], check, error: unknownMsg(check) }); continue; }
      // a required field without a column: every row of this source would be skipped on write
      if (check.missing.length) { sources.push({ source: inp.node.id, dataset_id: id, weight: weights[i], requested: ks[i], rows: 0, quota: quotas[i], check, rows_skipped: quotas[i], skip_reason: missingMsg(check) }); continue; }
      const r = await core.sampleRows(id, { ...optsFor(b, mix, inp, seed), sample: Math.max(ks[i], 1) });
      const got = r.rows.slice(0, ks[i]);
      sources.push({ source: inp.node.id, dataset_id: id, weight: weights[i], requested: ks[i], rows: got.length, pool_rows: r.pool_rows, quota: quotas[i], check,
        ...(r.pool_rows < quotas[i] && { short_by: quotas[i] - r.pool_rows }),
        ...(r.rows_skipped && { rows_skipped: r.rows_skipped, skip_reasons: r.skip_reasons }), ...(r.strata && { strata: r.strata }) });
      rows.push(...got.map((x) => ({ _source: inp.node.id, ...x })));
    } catch (e) {
      if (e.kind === 'cancelled') throw e;
      sources.push({ source: inp.node.id, ...(id && { dataset_id: id }), weight: weights[i], requested: ks[i], rows: 0, quota: quotas[i], ...(check && { check }), error: String(e.message || e) });
    }
  }
  rows.sort((x, y) => hash(`${seed}:${x.id}`) - hash(`${seed}:${y.id}`) || (x.id < y.id ? -1 : 1));
  return { board: b.name, mix: mix.id, schema, seed, n, rows_returned: rows.length, sources, rows };
}

// One source of a mix as the canvas mapping editor sees it: source columns, the schema, the import's suggested
// mapping, the effective mapping / metadata / target_column (edge settings over the suggestion), a check, and a few
// rows converted with exactly these settings (what a write would produce).
export async function edgeInfo(a = {}) {
  const b = boardOf(a), { mix, inputs } = mixOf(b, a.mix);
  const inp = inputs.find((x) => x.node.id === a.source);
  if (!inp) throw new Error(`source "${a.source}" is not an input of mix ${mix.id} (inputs: ${inputs.map((x) => x.node.id).join(', ')})`);
  const schemaName = mix.schema || 'default', seed = +(mix.seed ?? b.seed), schema = getSchema(schemaName);
  const id = await sourceDataset(inp.node, schemaName, b.seed), d = datasetOf(id);
  const eff = effective(d, mix, inp.edge), check = checkEdge(d, schema, eff, mix);
  let rows = [], error;
  if (check.unknown.length) error = unknownMsg(check);
  else if (check.missing.length) error = `Rows without ${check.missing.join(', ')} are skipped on write: required ${missingMsg(check)}`;
  else try { rows = (await core.sampleRows(id, { ...optsFor(b, mix, inp, seed), sample: Math.min(Math.max(+a.rows || 3, 1), 20) })).rows; } catch (e) { if (e.kind === 'cancelled') throw e; error = String(e.message || e); }
  return { mix: mix.id, source: inp.node.id, dataset_id: id, schema: { name: schema.name, table: schema.table, fields: schema.fields },
    columns: d.columns.map(({ name, type }) => ({ name, type })), suggested: d.mapping, ...eff,
    mix_metadata: listMeta(mix.metadata), edge_mapping: normMap(inp.edge.mapping), row_count: d.row_count,
    field_options: inp.edge.field_options || {}, overrides: inp.edge.overrides || {}, check, rows, ...(error && { error }) };
}

// run_board: write every mix that is connected to a target (or only `mix` / `target`). Each source is written with
// convert_and_write: n by weight (largest remainder), one shared write_key per mix (default "<board>-<mix>"), meta
// board/board_source. The run writes under a staging key and then replaces the rows of an earlier run under that
// write_key, so the same seed gives the same rows, and a failed or cancelled run leaves the earlier rows in place.
export async function runBoard(a = {}) {
  try { return await runBoardInner(a); } catch (e) {
    if (e.kind === 'cancelled' && !/^Cancelled,/.test(e.message)) e.message = 'Cancelled, nothing written (rows of an earlier run are unchanged)';
    throw e;
  }
}
async function runBoardInner(a) {
  const b = boardOf(a);
  const pairs = b.edges.filter((e) => b.nodes.find((n) => n.id === e.from)?.type === 'mix' && (!a.mix || e.from === a.mix) && (!a.target || e.to === a.target));
  if (!pairs.length) throw new Error('nothing to run: connect a mix to a target');
  const runs = [];
  for (const e of pairs) {
    const tnode = b.nodes.find((n) => n.id === e.to), { mix, inputs, weights } = mixOf(b, e.from);
    const target = tnode.target || 'datasets.duckdb', mode = tnode.mode || 'auto';
    const exists = fs.existsSync(core.resolveTarget(target));
    if (mode === 'create' && exists) throw new Error(`target ${tnode.id}: ${target} already exists (mode create)`);
    if (mode === 'append' && !exists) throw new Error(`target ${tnode.id}: ${target} does not exist (mode append)`);
    const seed = +(mix.seed ?? b.seed), schema = mix.schema || 'default', n = +(mix.n ?? 500), ks = splitByWeight(n, weights);
    const write_key = String(mix.write_key || `${b.name}-${mix.id}`), table = getSchema(schema).table;
    const ids = [];
    for (const [i, inp] of inputs.entries()) { // import and check all first: a failing source writes nothing
      jobs.progress(`Loading ${inp.node.id}`, i, inputs.length, 'sources');
      const id = await sourceDataset(inp.node, schema, b.seed), ck = checkEdge(datasetOf(id), getSchema(schema), effective(datasetOf(id), mix, inp.edge), mix);
      if (ck.unknown.length) throw new Error(`source ${inp.node.id}: ${unknownMsg(ck)}`);
      if (ck.missing.length) throw new Error(`source ${inp.node.id}: required ${missingMsg(ck)}; map ${ck.missing.length > 1 ? 'them' : 'it'} first`);
      ids.push(id);
    }
    const staging = `${write_key}~${crypto.randomUUID().slice(0, 8)}`;
    const sources = [];
    let last = null, replaced = 0;
    try {
      for (const [i, inp] of inputs.entries()) {
        if (!ks[i]) { sources.push({ source: inp.node.id, dataset_id: ids[i], weight: weights[i], requested: 0, rows_written: 0 }); continue; }
        jobs.progress(`Writing ${inp.node.id}`, i, inputs.length, 'sources');
        const r = await core.convertAndWrite(ids[i], { ...optsFor(b, mix, inp, seed), sample: ks[i], write_key: staging, target,
          mode: fs.existsSync(core.resolveTarget(target)) ? 'append' : 'create' });
        last = r;
        sources.push({ source: inp.node.id, dataset_id: ids[i], weight: weights[i], requested: ks[i], rows_written: r.rows_written, pool_rows: r.pool_rows,
          ...(r.rows_skipped && { rows_skipped: r.rows_skipped }), ...(r.strata && { strata: r.strata }) });
      }
      jobs.progress('Replacing the earlier run');
      replaced = (await core.replaceWriteKey(target, table, staging, write_key)).rows_deleted;
    } catch (err) {
      await core.deleteWriteKey(target, table, staging).catch(() => {});
      if (err.kind === 'cancelled') err.message = `Cancelled, nothing written to ${target} (rows of an earlier run are unchanged)`;
      throw err;
    }
    const written = sources.reduce((s, x) => s + x.rows_written, 0);
    const { total } = await core.targetRows(target, table);
    runs.push({ mix: mix.id, target: tnode.id, file: last?.target ?? target, table, schema, seed, write_key, requested: n, rows_written: written, created: !exists,
      ...(written < n && { short_by: n - written }), ...(replaced && { replaced_rows: replaced }), total_rows_in_target: total,
      ...(tnode.compact && { compact: await core.compactTarget(target) }), sources });
  }
  return { board: b.name, runs };
}
