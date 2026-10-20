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

fs.rmSync(dir, { recursive: true, force: true });
console.log('smoke test passed');
