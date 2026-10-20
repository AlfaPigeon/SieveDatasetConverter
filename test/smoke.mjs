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

fs.rmSync(dir, { recursive: true, force: true });
console.log('smoke test passed');
