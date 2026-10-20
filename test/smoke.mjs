// Offline smoke test: node test/smoke.mjs (uses a temp DATA_DIR; no network).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sieve-test-'));
process.env.DATA_DIR = dir;
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

fs.rmSync(dir, { recursive: true, force: true });
console.log('smoke test passed');
