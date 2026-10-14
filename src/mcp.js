import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as core from './core.js';
import * as schemas from './schemas.js';

const ok = (x) => ({ content: [{ type: 'text', text: JSON.stringify(x, null, 2) }] });
const wrap = (fn) => async (a) => { try { return ok(await fn(a)); } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] }; } };
const metadata = z.array(z.object({ key: z.string(), value: z.string().optional(), column: z.string().optional() })).optional()
  .describe('replaces the metadata list; each entry is a constant {key, value} or {key, column} copied per row from a source column');
const target_column = z.string().nullable().optional().describe('schema field (json/text) that stores the per-row metadata object; null to disable');
const mapping = z.record(z.string(), z.union([z.array(z.string()), z.string(), z.null()])).optional()
  .describe('schema field -> source column(s). Omit to auto-suggest from column names.');
const overrides = z.record(z.string(), z.any()).optional().describe('schema field -> constant value for every row');
const target = z.string().default('datasets.duckdb').describe('DuckDB file: bare name (inside the data dir) or path');
const mode = z.enum(['create', 'append']);

const FIELD_DOC = `Schema JSON: {name, table?, description?, fields:[{name, type: ${schemas.FIELD_TYPES.join('|')}, transform?: ${schemas.TRANSFORMS.join('|')}, required?, max_chars?, max_items?, item_max_chars?, aliases?:[column names for auto-mapping], value? (constant value, or metadata key for transform=metadata; transform=meta marks the default per-row metadata column), option_field? (for label_to_option), enum?, default?}]}. Columns id, dataset_id, source_row, created_at are added automatically.`;

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
    inputSchema: { url: z.string(), schema: z.string().default('default'), config: z.string().optional(), split: z.string().optional(), format: z.enum(['csv', 'json', 'jsonl', 'parquet', 'duckdb']).optional(), table: z.string().optional().describe('table to read from a .duckdb source (default: first; see tables in the result)'), limit: z.union([z.number().int(), z.literal('all')]).optional().describe('max rows to fetch (default 10000; "all" for everything). HF shards stop downloading once reached') },
  }, wrap(({ url, ...o }) => core.importDataset(url, o)));
  s.registerTool('preview', {
    description: 'Show raw rows and how they convert with the current schema and mapping.',
    inputSchema: { dataset_id: z.string(), n: z.number().int().optional() },
  }, wrap(({ dataset_id, n }) => core.preview(dataset_id, n)));
  s.registerTool('set_metadata', {
    description: 'Set the metadata list and the column it is stored in, switch schema or DuckDB source table, or change the field mapping / constant overrides.',
    inputSchema: { dataset_id: z.string(), metadata, target_column, schema: z.string().optional(), table: z.string().optional().describe('switch table for .duckdb sources'), mapping, overrides },
  }, wrap(({ dataset_id, metadata, target_column, schema, table, mapping, overrides }) => core.setMetadata(dataset_id, metadata, { schema, table, mapping, overrides, target_column })));
  s.registerTool('convert_and_write', {
    description: 'Seeded sample of N rows (default 500), convert, and write into the target DuckDB (schema table + datasets metadata table). mode=create makes a new file, mode=append adds to an existing one. Re-writing the same dataset_id replaces its rows.',
    inputSchema: { dataset_id: z.string(), sample: z.number().int().default(500), target, mode: mode.default('append'), seed: z.number().int().default(42) },
  }, wrap(({ dataset_id, ...o }) => core.convertAndWrite(dataset_id, o)));
  s.registerTool('run_pipeline', {
    description: 'One shot: Hugging Face name (+ optional config/split) and schema -> download, auto-map, sample, write. mode defaults to append if the target exists, else create.',
    inputSchema: { url: z.string(), schema: z.string().default('default'), config: z.string().optional(), split: z.string().optional(), table: z.string().optional(), limit: z.union([z.number().int(), z.literal('all')]).optional().describe('max rows to fetch (default 10000; "all" for everything). HF shards stop downloading once reached'),
      metadata, target_column, mapping, overrides, sample: z.number().int().default(500), seed: z.number().int().default(42), target, mode: mode.optional() },
  }, wrap((a) => core.runPipeline(a)));
  s.registerTool('list_datasets', { description: 'List datasets imported in this process.', inputSchema: {} }, wrap(() => core.listDatasets()));
  return s;
}
