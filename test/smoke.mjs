// Offline smoke test: node test/smoke.mjs (uses a temp DATA_DIR; no network).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sieve-test-'));
process.env.DATA_DIR = dir;
process.env.SCHEMAS_DIR = path.join(dir, 'schemas');
fs.mkdirSync(process.env.SCHEMAS_DIR);
fs.copyFileSync(new URL('../schemas/default.json', import.meta.url), path.join(process.env.SCHEMAS_DIR, 'default.json'));
const core = await import('../src/core.js');
const { DuckDBInstance } = await import('@duckdb/node-api');
const query = async (sql) => {
  const i = await DuckDBInstance.create(path.join(dir, 't.duckdb')); const c = await i.connect();
  try { return (await c.runAndReadAll(sql)).getRowObjectsJS(); } finally { c.closeSync(); i.closeSync(); }
};

const src = path.join(dir, 'src.jsonl');
fs.writeFileSync(src, Array.from({ length: 200 }, (_, i) => JSON.stringify({
  question: `q${i} ${'x'.repeat(i % 7 === 0 ? 5000 : 10)}`, choices: { text: ['yes', 'no', 'maybe'], label: ['A', 'B', 'C'] },
  answer: 'ABC'[i % 3], tox: (i % 10) / 10, info: { tags: [{ name: `t${i}` }] },
})).join('\n'));

const d = await core.importDataset(src, { limit: 'all' });
assert.equal(d.row_count, 200);
await core.setMetadata(d.dataset_id, [{ key: 'domain', value: 'test' }, { key: 'n', value: '3' }, { key: 'tag', column: 'info.tags[0].name' }, { key: 'row', column: 'source_row' }],
  { mapping: { input: ['question'], options: ['choices'], label: ['answer'] } });
const p = await core.preview(d.dataset_id, 1);
const r = p.converted[0];
assert.deepEqual(r.options, ['yes', 'no', 'maybe']);
assert.equal(r.label, 'yes');
assert.deepEqual(r.target, { probabilities: { yes: 1, no: 0, maybe: 0 } });
assert.equal(r.meta.n, 3); assert.equal(r.meta.tag, 't0'); assert.equal(r.meta.row, 0);
assert.equal(r.meta.truncated, true);

// splits are disjoint, where filters, write_key keeps writes apart
const w = await core.convertAndWrite(d.dataset_id, { target: 't', mode: 'create', where: "answer <> 'C'", splits: [{ tag: 'a', n: 40 }, { tag: 'b', n: 40, metadata: { use_case: 'b' } }] });
assert.deepEqual(w.splits.map((s) => s.rows_written), [40, 40]);
assert.equal((await query(`SELECT count(*) n FROM rows a JOIN rows b USING (source_row) WHERE a.write_key = 'a' AND b.write_key = 'b'`))[0].n, 0n);
assert.equal((await query(`SELECT count(*) n FROM rows WHERE label = 'maybe'`))[0].n, 0n);

// exclude_same_source skips rows written before
const d2 = await core.importDataset(src, { limit: 'all' });
const w2 = await core.convertAndWrite(d2.dataset_id, { target: 't', sample: 500, exclude_same_source: true, write_key: 'rest', overrides: { label: null } });
assert.equal(w2.rows_written, 120);

// soft target from a numeric column
await core.setMetadata(d2.dataset_id, {}, { mapping: { label: ['tox'] }, overrides: { options: ['clean', 'toxic'] } });
assert.deepEqual((await core.preview(d2.dataset_id, 4)).converted[3].target, { probabilities: { clean: 0.7, toxic: 0.3 } });

// delete_dataset, cleanup_downloads
assert.equal((await core.deleteDataset(d.dataset_id, { target: 't', write_key: 'a' })).rows_deleted, 40);
assert.equal((await core.deleteDataset(d2.dataset_id, { target: 't' })).rows_deleted, 120);
assert.deepEqual((await query('SELECT write_key, count(*)::INT n FROM rows GROUP BY 1')), [{ write_key: 'b', n: 40 }]);
assert.equal((await core.cleanupDownloads()).files_deleted, 0); // nothing downloaded (local source)
await assert.rejects(core.preview(d.dataset_id, 1, 'x; DROP TABLE y'), /where/);
await assert.rejects(core.preview(d.dataset_id, 1, "(SELECT 1) = 1"), /where/);

// option ids: duplicates get '#2', explicit ids, label modes, argmax label for soft targets, re-import by id
const src3 = path.join(dir, 'src3.jsonl');
fs.writeFileSync(src3, [
  { q: 'a', opts: ['yes', 'no', 'yes'], ans: 'no', stars: 2 },
  { q: 'b', opts: ['1', '2', '3'], ans: 2, stars: 2 },
  { q: 'c', opts: ['x', 'y'], ans: null, soft: 0.8, stars: 1 },
].map((x) => JSON.stringify(x)).join('\n'));
const d3 = await core.importDataset(src3, { limit: 'all', mapping: { input: ['q'], options: ['opts'], label: ['ans'] } });
const rows3 = async () => (await core.preview(d3.dataset_id, 3)).converted.sort((a, b) => a.source_row - b.source_row);
let c3 = await rows3();
assert.deepEqual(Object.keys(c3[0].target.probabilities), ['yes', 'no', 'yes#2']);
assert.equal(Object.values(c3[0].target.probabilities).reduce((a, b) => a + b, 0), 1);
assert.equal(c3[1].label, '2'); // numeric options: auto mode matches the value, no index fallback
await core.setMetadata(d3.dataset_id, {}, { field_options: { label: { label_mode: 'index' } } });
assert.equal((await rows3())[1].label, '3');
await core.setMetadata(d3.dataset_id, {}, { mapping: { target: ['soft'] }, field_options: { label: { label_mode: 'auto' } } });
c3 = await rows3();
assert.deepEqual(c3[2].target, { probabilities: { x: 0.2, y: 0.8 } });
assert.equal(c3[2].label, 'y'); // label missing -> argmax option of the distribution
fs.writeFileSync(src3, JSON.stringify({ q: 'd', opts: { true: 'Yes', false: 'No' }, ans: 'true' }));
const d4 = await core.importDataset(src3, { limit: 'all', mapping: { input: ['q'], options: ['opts'], label: ['ans'] } });
const c4 = (await core.preview(d4.dataset_id, 1)).converted[0]; // explicit ids {id: text}
assert.equal(c4.label, 'Yes'); assert.deepEqual(c4.target, { probabilities: { true: 1, false: 0 } });

// ordered JSON: {id: …} objects keep option order (integer-like keys are not moved first); argmax_of gold with ties
const schemas = await import('../src/schemas.js');
schemas.saveSchema({ name: 'pick', table: 'pick', fields: [
  { name: 'prompt', type: 'text' },
  { name: 'options', type: 'list', transform: 'shuffle', gold_field: 'label', gold_from: { argmax_of: ['s1', 's2', 's3'] } },
  { name: 'label', type: 'integer' },
  { name: 'opts', type: 'json', transform: 'options_dict', option_field: 'options', as: 'object' },
  { name: 'target', type: 'json', transform: 'label_to_distribution', option_field: 'options', ids: 'index', label_field: 'label' },
  { name: 'meta', type: 'json', transform: 'meta' }] });
const src5 = path.join(dir, 'src5.jsonl');
fs.writeFileSync(src5, Array.from({ length: 30 }, (_, i) => JSON.stringify({ p: `p${i}`, a: 'b', b: '10', c: '2', s1: i % 3 ? 1 : 5, s2: i % 3 === 1 ? 9 : 1, s3: 1 })).join('\n'));
const d5 = await core.importDataset(src5, { limit: 'all', schema: 'pick', mapping: { prompt: ['p'], options: ['a', 'b', 'c'] } });
const w5 = await core.convertAndWrite(d5.dataset_id, { target: 'p', mode: 'create', sample: 15 });
assert.equal(w5.rows_written, 15); assert.ok(w5.rows_skipped > 0); // i % 3 === 2 rows are ties (1, 1, 1) and get replaced
const pq = async (sql) => { const i = await DuckDBInstance.create(path.join(dir, 'p.duckdb')); const c = await i.connect(); try { return (await c.runAndReadAll(sql)).getRowObjectsJS(); } finally { c.closeSync(); i.closeSync(); } };
const rows5 = await pq('SELECT source_row, options::VARCHAR o, label, opts::VARCHAR d FROM pick');
for (const x of rows5) {
  const o = JSON.parse(x.o);
  assert.equal(o[Number(x.label)], Number(x.source_row) % 3 === 0 ? 'b' : '10'); // gold = the item with the highest score
  assert.equal(x.d, `{${o.map((t) => `${JSON.stringify(t)}:${JSON.stringify(t)}`).join(',')}}`); // stored in option order
}
assert.ok(rows5.some((x) => x.d.startsWith('{"b"')));
const w6 = await core.convertAndWrite(d5.dataset_id, { target: 'p', write_key: 'first', sample: 30, field_options: { options: { gold_from: { argmax_of: ['s1', 's2', 's3'], ties: 'first' } } } });
assert.equal(w6.rows_written, 30); assert.equal(w6.rows_skipped, undefined);

// preview: offset, random sample, value_counts (column or path, top, where)
const pv = await core.preview(d.dataset_id, 3, null, { offset: 10 });
assert.deepEqual(pv.converted.map((x) => x.source_row), [10, 11, 12]);
const pr = await core.preview(d.dataset_id, 5, null, { random: true, seed: 1 });
assert.notDeepEqual(pr.converted.map((x) => x.source_row), [0, 1, 2, 3, 4]);
assert.deepEqual(pr, await core.preview(d.dataset_id, 5, null, { random: true, seed: 1 }));
const vc = await core.preview(d.dataset_id, 0, null, { value_counts: { column: 'answer' } });
assert.equal(vc.converted.length, 0);
assert.deepEqual(vc.value_counts, { column: 'answer', rows: 200, distinct_values: 3, values: [{ value: 'A', count: 67 }, { value: 'B', count: 67 }, { value: 'C', count: 66 }] });
const vp = (await core.preview(d.dataset_id, 0, null, { value_counts: { column: 'choices.label[2]', top: 1, where: "answer = 'A'" } })).value_counts;
assert.deepEqual(vp.values, [{ value: 'C', count: 67 }]);

// empty / whitespace option text: the row is skipped and refilled; allow_empty keeps it
const src7 = path.join(dir, 'src7.jsonl');
fs.writeFileSync(src7, Array.from({ length: 40 }, (_, i) => JSON.stringify({ q: `q${i}`, opts: i % 4 ? ['x', 'y'] : ['x', '  '], ans: 0, grp: i < 30 ? 'big' : i < 37 ? 'mid' : 'small' })).join('\n'));
const d7 = await core.importDataset(src7, { limit: 'all', mapping: { input: ['q'], options: ['opts'], label: ['ans'] } });
assert.equal((await core.preview(d7.dataset_id, 1)).converted[0]._skipped, 'empty option in options');
const w7 = await core.convertAndWrite(d7.dataset_id, { target: 'e', mode: 'create', sample: 20 });
assert.equal(w7.rows_written, 20); assert.ok(w7.rows_skipped > 0);
const w8 = await core.convertAndWrite(d7.dataset_id, { target: 'e', write_key: 'all', sample: 40, field_options: { options: { allow_empty: true } } });
assert.equal(w8.rows_written, 40);

// stratify_by: even spread over values, top-up when a value runs short, per split counts
const w9 = await core.convertAndWrite(d7.dataset_id, { target: 'e', field_options: { options: { allow_empty: true } }, stratify_by: 'grp',
  splits: [{ tag: 's1', n: 9 }, { tag: 's2', n: 12 }] });
assert.deepEqual(w9.splits[0].strata, { big: 3, mid: 3, small: 3 });
assert.deepEqual(w9.strata, { big: 11, mid: 7, small: 3 }); // small has 3 rows, mid 7: the rest is topped up from big

// explode: one row per list element, step/steps in meta, history; profile; value_from + balance; distinct_by; duplicates; copy_rows
const src8 = path.join(dir, 'src8.jsonl');
fs.writeFileSync(src8, Array.from({ length: 12 }, (_, i) => JSON.stringify({ task: `t${i % 6}`, actions: Array.from({ length: 1 + (i % 3) }, (_, k) => ({ op: k ? 'type' : 'click', v: `a${k}` })) })).join('\n'));
const d8 = await core.importDataset(src8, { limit: 'all', explode: { column: 'actions', as: 'action', history: true }, mapping: { input: ['task'], label: ['action.op'] } });
assert.equal(d8.row_count, 24); // 4 × (1 + 2 + 3)
assert.ok(['action', 'explode_step', 'explode_steps', 'explode_history'].every((n) => d8.columns.some((c) => c.name === n)));
const e8 = (await core.preview(d8.dataset_id, 3)).converted;
assert.deepEqual(e8.map((x) => [x.source_row, x.meta.step, x.meta.steps]), [[0, 0, 1], [1000, 0, 2], [1001, 1, 2]]);
const h8 = (await core.preview(d8.dataset_id, 1, 'explode_step = 2')).raw[0];
assert.deepEqual(h8.explode_history.map((x) => x.v), ['a0', 'a1']);
const pf = await core.profile(d8.dataset_id, { top: 2 });
assert.equal(pf.rows, 24);
assert.deepEqual(pf.columns.find((c) => c.name === 'explode_steps'), { name: 'explode_steps', type: 'BIGINT', nulls: 0, distinct: 3, top: [{ value: '3', count: 12 }, { value: '2', count: 8 }] });
// value_from on the label + balance on it: 8 click rows vs 16 type rows -> 6/6
const wb = await core.convertAndWrite(d8.dataset_id, { target: 'x', mode: 'create', sample: 12, balance: 'label', overrides: { options: ['true', 'false'] },
  field_options: { label: { value_from: { column: 'action.op', map: { click: 'true', '*': 'false' } } } } });
assert.deepEqual(wb.strata, { true: 6, false: 6 });
const wd = await core.convertAndWrite(d8.dataset_id, { target: 'x', write_key: 'd', sample: 24, distinct_by: 'task' });
assert.equal(wd.rows_written, 6);
// copy_rows keeps source_row and meta; n samples; records follow
const cr = await core.copyRows({ source_target: 'x', target: 'y', where: "write_key = 'd'", n: 4 });
assert.equal(cr.rows_copied, 4); assert.equal(cr.records_copied, 1);
const yq = async (sql) => { const i = await DuckDBInstance.create(path.join(dir, 'y.duckdb')); const c = await i.connect(); try { return (await c.runAndReadAll(sql)).getRowObjectsJS(); } finally { c.closeSync(); i.closeSync(); } };
const xq = async (sql) => { const i = await DuckDBInstance.create(path.join(dir, 'x.duckdb')); const c = await i.connect(); try { return (await c.runAndReadAll(sql)).getRowObjectsJS(); } finally { c.closeSync(); i.closeSync(); } };
const ys = await yq('SELECT id, source_row, meta::VARCHAR m FROM rows ORDER BY id'), xs = await xq('SELECT id, source_row, meta::VARCHAR m FROM rows ORDER BY id');
assert.ok(ys.every((y) => xs.some((x) => x.id === y.id && x.source_row === y.source_row && x.m === y.m)));
assert.equal(Number((await yq("SELECT rows_written FROM datasets"))[0].rows_written), 4);
// duplicate option texts (after trim) skip the row unless allow_duplicates
const src9 = path.join(dir, 'src9.jsonl');
fs.writeFileSync(src9, [{ q: 'a', o: ['x', 'x '] }, { q: 'b', o: ['x', 'y'] }].map((x) => JSON.stringify(x)).join('\n'));
const d9 = await core.importDataset(src9, { limit: 'all', mapping: { input: ['q'], options: ['o'], label: [] } });
assert.equal((await core.preview(d9.dataset_id, 1)).converted[0]._skipped, 'duplicate options in options');
await core.setMetadata(d9.dataset_id, {}, { field_options: { options: { allow_duplicates: true } } });
assert.equal((await core.preview(d9.dataset_id, 1)).converted[0]._skipped, undefined);


// explode drops the list column, extract keeps values of the whole list; row cap errors cleanly
assert.ok(!d8.columns.some((c) => c.name === 'actions'));
const d8x = await core.importDataset(src8, { limit: 'all', explode: { column: 'actions', as: 'action', history: 1, extract: { first_op: 'actions[0].op' } } });
const x8 = (await core.preview(d8x.dataset_id, 2, 'explode_step = 1')).raw[0];
assert.equal(x8.first_op, 'click'); assert.equal(x8.explode_history.length, 1); assert.equal(x8.actions, undefined);
const d8m = await core.importDataset(src8, { limit: 'all', explode: { column: 'actions', as: 'action' }, mapping: { input: ['actions[0].op'], label: ['action.op'] } });
assert.equal((await core.preview(d8m.dataset_id, 1)).converted[0].input, 'click');
await assert.rejects(core.setMetadata(d8m.dataset_id, {}, { mapping: { input: ['actions[1].op'] } }), /explode dropped the list column actions; keep values from it with explode.extract/);
core.LIMITS.max_rows = 10;
await assert.rejects(core.importDataset(src8, { limit: 'all', explode: 'actions' }), /explode would make 24 rows \(limit SIEVE_MAX_ROWS/);
core.LIMITS.max_rows = 5_000_000;

// balance in SQL with a regex value_from key; distinct_by applies within each stratum; max_per_value
const vf = { label: { value_from: { column: 'action.op', map: { '/^CL/i': 'true', '*': 'false' } } } };
const wr = await core.convertAndWrite(d8.dataset_id, { target: 'x', write_key: 'r', sample: 12, balance: 'label', overrides: { options: ['true', 'false'] }, field_options: vf });
assert.deepEqual(wr.strata, { true: 6, false: 6 });
// every task has a click step; only t1, t2, t4, t5 have type steps: distinct first would have lost clicks, per stratum keeps them
const wdb = await core.convertAndWrite(d8.dataset_id, { target: 'x', write_key: 'db', sample: 20, balance: 'label', distinct_by: 'task', overrides: { options: ['true', 'false'] }, field_options: vf });
assert.deepEqual(wdb.strata, { true: 6, false: 4 });
const wm = await core.convertAndWrite(d8.dataset_id, { target: 'x', write_key: 'm', sample: 24, distinct_by: 'task', max_per_value: 2 });
assert.equal(wm.rows_written, 12);
await assert.rejects(core.convertAndWrite(d8.dataset_id, { target: 'x', write_key: 'z', sample: 5, balance: 'domain' }), /balance: domain is not mapped/);

// per-write overrides stay in that write; set_metadata overrides can be removed (null) or cleared
assert.notDeepEqual((await core.preview(d8.dataset_id, 1)).converted[0].options, ['true', 'false']);
await core.setMetadata(d8.dataset_id, {}, { overrides: { options: ['p', 'q'], decision_type: 'score' } });
assert.deepEqual((await core.preview(d8.dataset_id, 1)).converted[0].options, ['p', 'q']);
await core.setMetadata(d8.dataset_id, {}, { overrides: { options: null } });
let c8 = (await core.preview(d8.dataset_id, 1)).converted[0];
assert.notDeepEqual(c8.options, ['p', 'q']); assert.equal(c8.decision_type, 'score');
await core.setMetadata(d8.dataset_id, {}, { clear_overrides: true });
assert.equal((await core.preview(d8.dataset_id, 1)).converted[0].decision_type, 'choice');

// value_counts: JSON text inside a struct path; preview's where applies to the counts
const srcJ = path.join(dir, 'srcj.jsonl');
fs.writeFileSync(srcJ, Array.from({ length: 10 }, (_, i) => JSON.stringify({ k: i % 2, turn: { calls: [{ args: JSON.stringify({ command: i < 7 ? 'view' : 'edit', n: i }) }] } })).join('\n'));
const dJ = await core.importDataset(srcJ, { limit: 'all' });
const vj = (await core.preview(dJ.dataset_id, 0, 'k = 0', { value_counts: { column: 'turn.calls[0].args.command' } })).value_counts;
assert.equal(vj.rows, 5); assert.deepEqual(vj.values, [{ value: 'view', count: 4 }, { value: 'edit', count: 1 }]);
const vj2 = (await core.preview(dJ.dataset_id, 0, 'k = 0', { value_counts: { column: 'turn.calls[0].args.command', where: 'len(turn.calls) = 1 AND k + 0 = 0' } })).value_counts;
assert.equal(vj2.rows, 5);

// skip_unknown_labels: a label that is not an option is skipped and refilled
const srcU = path.join(dir, 'srcu.jsonl');
fs.writeFileSync(srcU, Array.from({ length: 20 }, (_, i) => JSON.stringify({ q: `q${i}`, o: ['a', 'b'], l: i % 4 ? 'a' : 'zzz' })).join('\n'));
const dU = await core.importDataset(srcU, { limit: 'all', mapping: { input: ['q'], options: ['o'], label: ['l'] } });
const wu = await core.convertAndWrite(dU.dataset_id, { target: 'u', mode: 'create', sample: 15, skip_unknown_labels: true });
assert.equal(wu.rows_written, 15); assert.ok(wu.rows_skipped >= 1); assert.deepEqual(Object.keys(wu.skip_reasons), ['unknown label in label']);
const uq = async (sql) => { const i = await DuckDBInstance.create(path.join(dir, 'u.duckdb')); const c = await i.connect(); try { return (await c.runAndReadAll(sql)).getRowObjectsJS(); } finally { c.closeSync(); i.closeSync(); } };
assert.deepEqual((await uq('SELECT DISTINCT label FROM rows')).map((x) => x.label), ['a']);

// compact after delete: the file shrinks, rows stay
const big = path.join(dir, 'big.jsonl');
fs.writeFileSync(big, Array.from({ length: 3000 }, (_, i) => JSON.stringify({ q: `q${i} ${'lorem ipsum '.repeat(40)}`, o: ['a', 'b'], l: 'a' })).join('\n'));
const dB = await core.importDataset(big, { limit: 'all', mapping: { input: ['q'], options: ['o'], label: ['l'] } });
await core.convertAndWrite(dB.dataset_id, { target: 'u', write_key: 'big', sample: 3000 });
const del = await core.deleteDataset(dB.dataset_id, { target: 'u', compact: true });
assert.equal(del.rows_deleted, 3000); assert.ok(del.compact.bytes_after < del.compact.bytes_before, JSON.stringify(del.compact));
assert.equal(Number((await uq('SELECT count(*) n FROM rows'))[0].n), 15);
const cp = await core.compactTarget('u');
assert.ok(cp.bytes_after > 0);

// nested ClassLabel names (HF features inside a struct) become the options
const pqf = path.join(dir, 'cl.parquet');
const hfMeta = JSON.stringify({ info: { features: { q: { dtype: 'string', _type: 'Value' }, ann: { label: { names: ['neg', 'pos'], _type: 'ClassLabel' }, who: { dtype: 'string', _type: 'Value' } } } } });
{ const i = await DuckDBInstance.create(); const c = await i.connect();
  await c.run(`COPY (SELECT 'q' || x AS q, {'label': x % 2, 'who': 'w'} AS ann FROM range(6) t(x)) TO '${pqf}' (FORMAT parquet, KV_METADATA {huggingface: '${hfMeta}'})`); c.closeSync(); i.closeSync(); }
const dC = await core.importDataset(pqf, { limit: 'all', mapping: { input: ['q'], label: ['ann.label'], options: [] } });
const cC = (await core.preview(dC.dataset_id, 2)).converted;
assert.deepEqual(cC.map((x) => [x.options, x.label]), [[['neg', 'pos'], 'neg'], [['neg', 'pos'], 'pos']]);

// shuffle duplicates: "drop" removes repeated non-gold items and keeps the row
schemas.saveSchema({ name: 'pick2', table: 'pick2', fields: [
  { name: 'prompt', type: 'text' },
  { name: 'options', type: 'list', transform: 'shuffle', gold_field: 'label', gold_from: { column: 'g' } },
  { name: 'label', type: 'integer' }] });
const srcD = path.join(dir, 'srcd.jsonl');
fs.writeFileSync(srcD, JSON.stringify({ p: 'p', a: 'x', b: 'x ', c: 'y', g: 1 }));
const dD = await core.importDataset(srcD, { limit: 'all', schema: 'pick2', mapping: { prompt: ['p'], options: ['a', 'b', 'c'] } });
assert.equal((await core.preview(dD.dataset_id, 1)).converted[0]._skipped, 'duplicate options in options');
await core.setMetadata(dD.dataset_id, {}, { field_options: { options: { duplicates: 'drop' } } });
const cD = (await core.preview(dD.dataset_id, 1)).converted[0];
assert.equal(cD._skipped, undefined); assert.equal(cD.options.length, 2); assert.equal(cD.options[cD.label], 'x ');


// boards: a parquet file, a jsonl file and a duckdb table mixed by weight; preview tags rows; runs are reproducible
const boards = await import('../src/boards.js');
assert.deepEqual(boards.splitByWeight(10, [1, 1, 1]), [4, 3, 3]);
assert.deepEqual(boards.splitByWeight(7, [3, 1]), [5, 2]);
const bq = path.join(dir, 'bq.parquet'), bdb = path.join(dir, 'bsrc.duckdb'), bj = path.join(dir, 'bj.jsonl');
{ const i = await DuckDBInstance.create(); const c = await i.connect();
  await c.run(`COPY (SELECT 'pq ' || x AS question, ['yes', 'no'] AS choices, x % 2 AS answer FROM range(300) t(x)) TO '${bq}' (FORMAT parquet)`);
  await c.run(`ATTACH '${bdb}' AS b; CREATE TABLE b.items AS SELECT 'db ' || x AS question, ['yes', 'no'] AS choices, 0 AS answer, x % 3 AS grp FROM range(200) t(x); DETACH b`);
  c.closeSync(); i.closeSync(); }
fs.writeFileSync(bj, Array.from({ length: 50 }, (_, i) => JSON.stringify({ question: `js ${i}`, choices: ['yes', 'no'], answer: 1 })).join('\n'));
const board = { name: 'mix-test', seed: 7, nodes: [
  { id: 'pq', type: 'source', url: bq, limit: 'all' }, { id: 'db', type: 'source', url: bdb, table: 'items', limit: 'all' }, { id: 'js', type: 'source', url: bj, limit: 'all' },
  { id: 'm', type: 'mix', schema: 'default', n: 60, stratify_by: 'answer' }, { id: 't', type: 'target', target: 'boardout.duckdb' }],
  edges: [{ from: 'pq', to: 'm', weight: 3 }, { from: 'db', to: 'm', weight: 2, where: 'grp > 0' }, { from: 'js', to: 'm', weight: 1 }, { from: 'm', to: 't' }] };
assert.throws(() => boards.saveBoard({ ...board, edges: [{ from: 'pq', to: 't' }] }), /only source -> mix and mix -> target/);
assert.deepEqual(boards.saveBoard(board), { name: 'mix-test', file: 'boards/mix-test.json', nodes: 5, edges: 4 });
assert.equal(boards.listBoards()[0].sources, 3);
const si = await boards.sourceInfo({ node: board.nodes[1] });
assert.equal(si.row_count, 200); assert.ok(si.columns.some((c) => c.name === 'grp' && c.type === 'BIGINT')); assert.equal(si.preview.length, 3);
const pm = await boards.previewMix({ name: 'mix-test', n: 12 });
assert.deepEqual(pm.sources.map((x) => [x.source, x.requested, x.rows]), [['pq', 6, 6], ['db', 4, 4], ['js', 2, 2]]);
assert.ok(pm.rows.every((r) => r.input.startsWith(r._source)));
assert.equal(pm.sources[1].pool_rows, 133); // where grp > 0
const pm2 = await boards.previewMix({ name: 'mix-test', n: 12 });
assert.deepEqual(pm2.rows.map((r) => r.id), pm.rows.map((r) => r.id));
const rb = await boards.runBoard({ name: 'mix-test' });
assert.deepEqual(rb.runs[0].sources.map((x) => [x.source, x.rows_written]), [['pq', 30], ['db', 20], ['js', 10]]);
assert.equal(rb.runs[0].write_key, 'mix-test-m'); assert.equal(rb.runs[0].total_rows_in_target, 60);
const oq = async (sql) => { const i = await DuckDBInstance.create(path.join(dir, 'boardout.duckdb')); const c = await i.connect(); try { return (await c.runAndReadAll(sql)).getRowObjectsJS(); } finally { c.closeSync(); i.closeSync(); } };
const snap = async () => (await oq("SELECT meta->>'board_source' s, source_row, input FROM rows ORDER BY 1, 2")).map((x) => `${x.s}:${x.source_row}:${x.input}`);
const first = await snap();
const rb2 = await boards.runBoard({ name: 'mix-test' });
assert.equal(rb2.runs[0].replaced_rows, 60); assert.equal(rb2.runs[0].total_rows_in_target, 60);
assert.deepEqual(await snap(), first);

// edges map their own column names to the one mix schema, with metadata entries and target_column, as in the wizard
const bk = path.join(dir, 'bk.jsonl');
fs.writeFileSync(bk, Array.from({ length: 40 }, (_, i) => JSON.stringify({ prompt_text: `kq ${i}`, opts: ['red', 'blue'], gold: i % 2, lang: i % 4 ? 'en' : 'de' })).join('\n'));
const kb = { name: 'map-test', seed: 3, nodes: [
  { id: 'pq', type: 'source', url: bq, limit: 'all' }, { id: 'k', type: 'source', url: bk, limit: 'all' },
  { id: 'm', type: 'mix', schema: 'default', n: 20 }, { id: 't', type: 'target', target: 'mapout.duckdb' }],
  edges: [{ from: 'pq', to: 'm' }, { from: 'k', to: 'm' }, { from: 'm', to: 't' }] };
let ei = await boards.edgeInfo({ board: kb, source: 'k' });
assert.deepEqual(ei.columns.map((c) => c.name), ['prompt_text', 'opts', 'gold', 'lang']);
assert.equal(ei.check.status.options, 'unmapped'); assert.equal(ei.check.status.label, 'unmapped');
kb.edges[1] = { from: 'k', to: 'm', mapping: { input: ['prompt_text'], options: ['opts'], label: 'gold' },
  metadata: [{ key: 'domain', value: 'colors' }, { key: 'lang', column: 'lang' }], target_column: 'meta' };
ei = await boards.edgeInfo({ board: kb, source: 'k', rows: 4 });
assert.ok(ei.check.ok); assert.equal(ei.check.status.label, 'ok'); assert.deepEqual(ei.mapping.label, ['gold']);
assert.ok(ei.rows.every((r) => ['red', 'blue'].includes(r.label) && r.domain === 'colors' && ['en', 'de'].includes(r.meta.lang) && r.meta.board_source === 'k' && !('name' in r.meta)));
const kp = await boards.previewMix({ board: kb, n: 10 });
assert.ok(kp.sources.every((x) => x.check.ok && x.rows === 5));
assert.ok(kp.rows.filter((r) => r._source === 'k').every((r) => r.input.startsWith('kq') && r.options[0] === 'red'));
assert.ok(kp.rows.filter((r) => r._source === 'pq').every((r) => r.input.startsWith('pq') && r.options[0] === 'yes'));
const kr = await boards.runBoard({ board: kb });
assert.deepEqual(kr.runs[0].sources.map((x) => x.rows_written), [10, 10]);
// an unknown column: reported per source in the preview, and the run stops before writing anything
const kbBad = { ...kb, edges: kb.edges.map((e) => (e.from === 'k' ? { ...e, mapping: { ...e.mapping, label: ['nope'] } } : e)) };
assert.deepEqual((await boards.edgeInfo({ board: kbBad, source: 'k' })).check.unknown, [{ field: 'label', column: 'nope' }]);
assert.match((await boards.previewMix({ board: kbBad })).sources[1].error, /unknown column "nope"/);
await assert.rejects(boards.runBoard({ board: kbBad }), /source k: mapping: label → unknown column "nope"/);
assert.throws(() => boards.saveBoard({ ...kb, edges: [{ from: 'k', to: 'm', metadata: [{ key: 'x' }] }] }), /metadata entries/);
// a required field without a column: flagged with a one-click fix, skipped in the preview, and the run refuses
const kbMiss = { ...kb, edges: kb.edges.map((e) => (e.from === 'k' ? { ...e, mapping: { ...e.mapping, input: [] } } : e)) };
const em = await boards.edgeInfo({ board: kbMiss, source: 'k' });
assert.deepEqual(em.check.missing, ['input']); assert.deepEqual(em.check.fixes, { input: 'prompt_text' }); assert.equal(em.check.status.score, 'unmapped');
const pmm = (await boards.previewMix({ board: kbMiss, n: 10 })).sources[1];
assert.deepEqual([pmm.rows, pmm.rows_skipped, pmm.skip_reason], [0, 10, 'input not mapped']);
await assert.rejects(boards.runBoard({ board: kbMiss }), /source k: required input not mapped/);
// balancing by a field makes it required for every input (here: label), with a fix suggestion
const kbBal = { ...kb, nodes: kb.nodes.map((n) => (n.id === 'm' ? { ...n, balance: 'label' } : n)), edges: kb.edges.map((e) => (e.from === 'k' ? { ...e, mapping: { ...e.mapping, label: [] } } : e)) };
const eb = await boards.edgeInfo({ board: kbBal, source: 'k' });
assert.deepEqual([eb.check.missing, eb.check.status.label], [['label'], 'missing']); assert.ok(eb.check.fixes.label);
assert.equal((await boards.previewMix({ board: kbBal, n: 10 })).sources[1].skip_reason, 'label not mapped');
// Store in (target_column) is a mix setting
assert.equal((await boards.edgeInfo({ board: { ...kb, nodes: kb.nodes.map((n) => (n.id === 'm' ? { ...n, target_column: null } : n)), edges: kb.edges.map((e) => { const { target_column, ...x } = e; return x; }) }, source: 'k' })).rows[0].meta, null);
// target_column null: metadata is not stored per row
const kn = await boards.edgeInfo({ board: { ...kb, edges: kb.edges.map((e) => (e.from === 'k' ? { ...e, target_column: null } : e)) }, source: 'k' });
assert.equal(kn.target_column, null); assert.equal(kn.rows[0].meta, null);
// an edited schema file is picked up by the cached import; mappings of kept fields stay
const schemasMod = await import('../src/schemas.js');
schemasMod.saveSchema({ name: 'mini', table: 'mini', fields: [{ name: 'input', required: true }, { name: 'label' }] });
const kbm = { ...kb, nodes: kb.nodes.map((n) => (n.id === 'm' ? { ...n, schema: 'mini' } : n)) };
assert.deepEqual((await boards.edgeInfo({ board: kbm, source: 'k' })).schema.fields.map((f) => f.name), ['input', 'label']);
schemasMod.saveSchema({ name: 'mini', table: 'mini', fields: [{ name: 'input', required: true }, { name: 'label' }, { name: 'lang', aliases: ['lang'] }] });
ei = await boards.edgeInfo({ board: kbm, source: 'k' });
assert.deepEqual(ei.schema.fields.map((f) => f.name), ['input', 'label', 'lang']); assert.deepEqual(ei.mapping.lang, ['lang']); assert.deepEqual(ei.mapping.label, ['gold']);

// cancel: a cancelled run leaves the earlier rows in place and no staging rows behind
const jobs = await import('../src/jobs.js');
const before = await snap();
const j1 = jobs.runJob('c1', () => boards.runBoard({ name: 'mix-test' })); jobs.cancel('c1');
await assert.rejects(j1, /Cancelled, nothing written/);
const j2 = jobs.runJob('c2', () => boards.runBoard({ name: 'mix-test' }));
const poll = setInterval(() => { if (jobs.status('c2').phases.includes('Writing js')) jobs.cancel('c2'); }, 0);
await assert.rejects(j2, /Cancelled/); clearInterval(poll);
assert.ok(jobs.status('c2').phases.includes('Writing db'));
assert.deepEqual(await snap(), before);
assert.equal((await oq("SELECT count(*)::INT n FROM rows WHERE write_key LIKE '%~%'"))[0].n, 0);
assert.equal((await boards.runBoard({ name: 'mix-test' })).runs[0].replaced_rows, 60); // still runs after a cancel

// uploads (canvas file drop) land in DATA_DIR/uploads and are read relative to the data dir; missing files are explained
const { Readable } = await import('node:stream');
const up = await core.saveUpload('my file.parquet', Readable.from([fs.readFileSync(bq)]), fs.statSync(bq).size);
assert.deepEqual([up.name, up.url], ['my_file.parquet', 'uploads/my_file.parquet']);
assert.ok((await core.saveUpload('my file.parquet', Readable.from([fs.readFileSync(bq)]))).reused);
assert.equal((await core.saveUpload('my file.parquet', Readable.from([Buffer.from('other')]))).name, 'my_file-2.parquet');
await assert.rejects(core.saveUpload('x.exe', Readable.from([Buffer.from('a')])), /Upload a \.parquet/);
assert.equal((await core.importDataset('uploads/my_file.parquet', { limit: 'all' })).row_count, 300);
await assert.rejects(core.importDataset('/nope/missing.parquet'), /File not found: missing\.parquet/);
await assert.rejects(core.importDataset('data/nope.csv'), /File not found: nope\.csv.*uploads\/nope\.csv/);

fs.rmSync(dir, { recursive: true, force: true });
console.log('smoke test passed');
