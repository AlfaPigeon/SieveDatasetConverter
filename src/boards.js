// Boards: a saved canvas of source nodes (any import), mix nodes (weights, schema, where, stratify/balance) and
// target nodes (a .duckdb file). Stored as JSON in DATA_DIR/boards/<name>.json; previewed and run through core.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from './core.js';

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
    if (n.type === 'target' && n.mode != null && !['auto', 'create', 'append'].includes(n.mode)) throw new Error(`target ${n.id}: mode must be auto | create | append`);
    byId.set(n.id, n);
  }
  for (const e of edges) {
    const a = byId.get(e?.from), z = byId.get(e?.to);
    if (!a || !z) throw new Error(`edge ${e?.from} -> ${e?.to}: unknown node`);
    if (!(a.type === 'source' && z.type === 'mix') && !(a.type === 'mix' && z.type === 'target')) throw new Error(`edge ${e.from} -> ${e.to}: only source -> mix and mix -> target`);
    if (e.weight != null && !(Number.isFinite(+e.weight) && +e.weight >= 0)) throw new Error(`edge ${e.from} -> ${e.to}: weight must be a number >= 0`);
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
const loaded = new Map();
async function sourceDataset(node, schema, seed) {
  const o = Object.fromEntries(SOURCE_KEYS.filter((k) => node[k] != null).map((k) => [k, node[k]]));
  const url = o.target ? core.resolveTarget(o.target) : o.url;
  const { target: _t, url: _u, fetch_seed, metadata, ...imp } = o;
  const opts = { ...imp, schema, seed: fetch_seed ?? seed };
  const key = JSON.stringify([url, opts, metadata ?? null]);
  const id = loaded.get(key);
  if (id && core.listDatasets().some((d) => d.dataset_id === id && !d.cleaned)) return id;
  const r = await core.importDataset(url, opts);
  if (metadata) await core.setMetadata(r.dataset_id, metadata);
  loaded.set(key, r.dataset_id);
  return r.dataset_id;
}

// A source card: row count, columns with types (profile) and a few preview rows.
export async function sourceInfo({ node, schema = 'default', seed = 42, rows = 3 }) {
  if (!node?.url && !node?.target) throw new Error('source needs url or target');
  const id = await sourceDataset(node, schema, seed);
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
// Write/sample options of one source in a mix: the mix's settings, then the edge's (where, overrides, mapping, ...).
const optsFor = (b, mix, { edge, node }, seed) => ({
  seed, ...(edge.where && { where: edge.where }),
  ...(mix.stratify_by && { stratify_by: mix.stratify_by }), ...(mix.balance && { balance: mix.balance }),
  ...(mix.distinct_by && { distinct_by: mix.distinct_by }), ...(mix.max_per_value && { max_per_value: mix.max_per_value }),
  ...(mix.skip_unknown_labels && { skip_unknown_labels: true }),
  overrides: { ...mix.overrides, ...edge.overrides }, field_options: { ...mix.field_options, ...edge.field_options },
  ...(edge.mapping && { mapping: edge.mapping }),
  metadata: { ...mix.metadata, ...edge.metadata, board: b.name, board_source: node.id },
});
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
    try {
      const id = await sourceDataset(inp.node, schema, b.seed);
      const r = await core.sampleRows(id, { ...optsFor(b, mix, inp, seed), sample: Math.max(ks[i], 1) });
      const got = r.rows.slice(0, ks[i]);
      sources.push({ source: inp.node.id, dataset_id: id, weight: weights[i], requested: ks[i], rows: got.length, pool_rows: r.pool_rows, quota: quotas[i],
        ...(r.pool_rows < quotas[i] && { short_by: quotas[i] - r.pool_rows }),
        ...(r.rows_skipped && { rows_skipped: r.rows_skipped, skip_reasons: r.skip_reasons }), ...(r.strata && { strata: r.strata }) });
      rows.push(...got.map((x) => ({ _source: inp.node.id, ...x })));
    } catch (e) {
      sources.push({ source: inp.node.id, weight: weights[i], requested: ks[i], rows: 0, quota: quotas[i], error: String(e.message || e) });
    }
  }
  rows.sort((x, y) => hash(`${seed}:${x.id}`) - hash(`${seed}:${y.id}`) || (x.id < y.id ? -1 : 1));
  return { board: b.name, mix: mix.id, schema, seed, n, rows_returned: rows.length, sources, rows };
}

// run_board: write every mix that is connected to a target (or only `mix` / `target`). Each source is written with
// convert_and_write: n by weight (largest remainder), one shared write_key per mix (default "<board>-<mix>"), meta
// board/board_source. Rows of an earlier run under that write_key are replaced, so the same seed gives the same rows.
export async function runBoard(a = {}) {
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
    const write_key = String(mix.write_key || `${b.name}-${mix.id}`);
    const ids = [];
    for (const inp of inputs) ids.push(await sourceDataset(inp.node, schema, b.seed)); // import all first: a failing source writes nothing
    const { getSchema } = await import('./schemas.js');
    const replaced = (await core.deleteWriteKey(target, getSchema(schema).table, write_key)).rows_deleted;
    const sources = [];
    let last = null;
    for (const [i, inp] of inputs.entries()) {
      if (!ks[i]) { sources.push({ source: inp.node.id, dataset_id: ids[i], weight: weights[i], requested: 0, rows_written: 0 }); continue; }
      const r = await core.convertAndWrite(ids[i], { ...optsFor(b, mix, inp, seed), sample: ks[i], write_key, target,
        mode: fs.existsSync(core.resolveTarget(target)) ? 'append' : 'create' });
      last = r;
      sources.push({ source: inp.node.id, dataset_id: ids[i], weight: weights[i], requested: ks[i], rows_written: r.rows_written, pool_rows: r.pool_rows,
        ...(r.rows_skipped && { rows_skipped: r.rows_skipped }), ...(r.strata && { strata: r.strata }) });
    }
    const written = sources.reduce((s, x) => s + x.rows_written, 0);
    runs.push({ mix: mix.id, target: tnode.id, file: last?.target ?? target, table: last?.table, schema, seed, write_key, requested: n, rows_written: written,
      ...(written < n && { short_by: n - written }), ...(replaced && { replaced_rows: replaced }), total_rows_in_target: last?.total_rows_in_target,
      ...(tnode.compact && { compact: await core.compactTarget(target) }), sources });
  }
  return { board: b.name, runs };
}
