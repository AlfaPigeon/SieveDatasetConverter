import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as core from './core.js';
import * as schemas from './schemas.js';

const ok = (x) => ({ content: [{ type: 'text', text: JSON.stringify(x, null, 2) }] });
const wrap = (fn) => async (a) => { try { return ok(await fn(a)); } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] }; } };
const metaList = z.array(z.object({ key: z.string(), value: z.any().optional(), column: z.string().optional() }));
const metadata = metaList.optional()
  .describe('replaces the metadata list; each entry is a constant {key, value} (JSON types kept; numeric/boolean/JSON strings are parsed) or {key, column} copied per row from a source column, nested path (a.b[0].c) or "source_row"');
const target_column = z.string().nullable().optional().describe('schema field (json/text) that stores the per-row metadata object; null to disable');
const mapping = z.record(z.string(), z.union([z.array(z.string()), z.string(), z.null()])).optional()
  .describe('schema field -> source column(s) or nested paths like "a.b[0].c" / "completions[*].overall_score". Omit to auto-suggest from column names.');
const overrides = z.record(z.string(), z.any()).optional().describe('schema field -> constant value for every row');
const target = z.string().default('datasets.duckdb').describe('DuckDB file: bare name (inside the data dir) or path');
const mode = z.enum(['create', 'append']);
const write = {
  where: z.string().optional().describe('DuckDB row filter over source columns, e.g. "label >= 0 AND length(text) < 2000"'),
  write_key: z.string().optional().describe('rows are replaced per (dataset_id, write_key), so one import can be written several times under different keys/tags'),
  splits: z.array(z.object({ tag: z.string(), n: z.number().int(), metadata: metaList.or(z.record(z.string(), z.any())).optional(), overrides: z.record(z.string(), z.any()).optional() })).optional()
    .describe('cut one shuffled sample into disjoint parts; each part is written with write_key = tag (sample is ignored)'),
  exclude_dataset_ids: z.array(z.string()).optional().describe('skip source rows already written to the target by these dataset_ids'),
  exclude_same_source: z.boolean().optional().describe('skip source rows already written to the target from the same source (same HF repo/config/split or file)'),
};
const cleanup = z.boolean().default(false).describe("after a successful write, delete this dataset's downloaded files in data/downloads");
const limit = z.union([z.number().int(), z.literal('all')]).optional()
  .describe('max rows to fetch (default 10000; "all" for everything). Hugging Face: reads only the first N rows remotely (DuckDB httpfs range reads, /rows API fallback for <= 1000), so a limit is the first N rows of the split, not a random subset; "all" downloads whole shards');

const FIELD_DOC = `Schema JSON: {name, table?, description?, fields:[{name, type: ${schemas.FIELD_TYPES.join('|')}, transform?: ${schemas.TRANSFORMS.join('|')}, required?, max_chars?, max_items?, item_max_chars?, aliases?:[column names for auto-mapping], value? (constant value, or metadata key for transform=metadata; transform=meta marks the default per-row metadata column), option_field? (options field for label_to_option | label_to_distribution | options_dict), label_field? (label_to_distribution without own columns reads this field's source; default: the label_to_option field), ids?: text|index (option ids for label_to_distribution/options_dict; default text), gold_field? (shuffle: field that receives the gold index), enum?, default?}]}. Transforms: label_to_distribution -> {probabilities:{id:p}} (one-hot from a label/index/letter/ClassLabel, uniform over a multi-label list, soft from a numeric value, or normalised over several numeric columns); options_dict -> {id: option}; shuffle -> seeded shuffle of the mapped columns/list where the first is the gold one, gold index goes to gold_field (or meta.gold_index). Columns id, dataset_id, source_row, created_at are added automatically.`;

export function buildMcpServer() {
  const s = new McpServer({ name: 'sieve-dataset-converter', version: '0.1.0' });
  s.registerTool('list_schemas', { description: 'List available output schemas.', inputSchema: {} }, wrap(() => schemas.listSchemas()));
  s.registerTool('get_schema', { description: 'Get one schema definition.', inputSchema: { name: z.string() } }, wrap(({ name }) => schemas.getSchema(name)));
  s.registerTool('save_schema', { description: `Create or overwrite a schema. ${FIELD_DOC}`, inputSchema: { schema: z.record(z.string(), z.any()) } },
    wrap(({ schema }) => schemas.saveSchema(schema)));
  s.registerTool('list_targets', { description: 'List .duckdb target files in the data dir.', inputSchema: {} }, wrap(() => core.listTargets()));
  s.registerTool('hf_splits', { description: 'List configs and splits (with row counts) of a Hugging Face dataset.', inputSchema: { dataset: z.string() } },
    wrap(({ dataset }) => core.hfSplits(dataset)));
  s.registerTool('import_dataset', {
    description: 'Download a dataset: Hugging Face name (org/name) or URL, or a CSV/JSON/JSONL/Parquet/DuckDB URL or local path. Returns dataset_id, columns, row count and an auto-suggested mapping for the chosen schema.',
    inputSchema: { url: z.string(), schema: z.string().default('default'), config: z.string().optional(), split: z.string().optional(), format: z.enum(['csv', 'json', 'jsonl', 'parquet', 'duckdb']).optional(), table: z.string().optional().describe('table to read from a .duckdb source (default: first; see tables in the result)'), limit },
  }, wrap(({ url, ...o }) => core.importDataset(url, o)));
  s.registerTool('preview', {
    description: 'Show raw rows and how they convert with the current schema and mapping.',
    inputSchema: { dataset_id: z.string(), n: z.number().int().optional(), where: write.where },
  }, wrap(({ dataset_id, n, where }) => core.preview(dataset_id, n, where)));
  s.registerTool('set_metadata', {
    description: 'Set the metadata list and the column it is stored in, switch schema or DuckDB source table, or change the field mapping / constant overrides.',
    inputSchema: { dataset_id: z.string(), metadata, target_column, schema: z.string().optional(), table: z.string().optional().describe('switch table for .duckdb sources'), mapping, overrides },
  }, wrap(({ dataset_id, metadata, target_column, schema, table, mapping, overrides }) => core.setMetadata(dataset_id, metadata, { schema, table, mapping, overrides, target_column })));
  s.registerTool('convert_and_write', {
    description: 'Seeded sample of N rows (default 500), convert, and write into the target DuckDB (schema table + datasets metadata table). mode=create makes a new file, mode=append adds to an existing one. Re-writing the same dataset_id + write_key replaces its rows.',
    inputSchema: { dataset_id: z.string(), sample: z.number().int().default(500), target, mode: mode.default('append'), seed: z.number().int().default(42), cleanup, ...write,
      metadata: metaList.or(z.record(z.string(), z.any())).optional().describe('metadata for this write only, merged by key onto the dataset metadata (set_metadata is unchanged)'),
      overrides: z.record(z.string(), z.any()).optional().describe('field -> constant for this write only') },
  }, wrap(({ dataset_id, ...o }) => core.convertAndWrite(dataset_id, o)));
  s.registerTool('run_pipeline', {
    description: 'One shot: Hugging Face name (+ optional config/split) and schema -> download, auto-map, sample, write. mode defaults to append if the target exists, else create.',
    inputSchema: { url: z.string(), schema: z.string().default('default'), config: z.string().optional(), split: z.string().optional(), table: z.string().optional(), limit,
      metadata, target_column, mapping, overrides, sample: z.number().int().default(500), seed: z.number().int().default(42), target, mode: mode.optional(), cleanup, ...write },
  }, wrap((a) => core.runPipeline(a)));
  s.registerTool('delete_dataset', {
    description: 'Delete a dataset_id\'s rows (all write_keys, or only write_key) and its records in the datasets table of a target file.',
    inputSchema: { dataset_id: z.string(), target, write_key: z.string().optional() },
  }, wrap(({ dataset_id, ...o }) => core.deleteDataset(dataset_id, o)));
  s.registerTool('cleanup_downloads', {
    description: 'Delete downloaded source files in data/downloads: one dataset_id, or all when omitted. Returns files deleted and bytes freed.',
    inputSchema: { dataset_id: z.string().optional() },
  }, wrap(({ dataset_id }) => core.cleanupDownloads(dataset_id)));
  s.registerTool('list_datasets', { description: 'List datasets imported in this process.', inputSchema: {} }, wrap(() => core.listDatasets()));
  return s;
}
