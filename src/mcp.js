import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as core from './core.js';
import * as boards from './boards.js';
import * as schemas from './schemas.js';

const ok = (x) => ({ content: [{ type: 'text', text: core.toJson(x, 2) }] });
// Optional params also accept null (= not given); target_column keeps null (= disable).
const dropNulls = (a) => Object.fromEntries(Object.entries(a || {}).filter(([k, v]) => v !== null || k === 'target_column'));
const wrap = (fn) => async (a) => { try { return ok(await fn(dropNulls(a))); } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] }; } };
const nullable = (shape) => Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, s.safeParse(undefined).success ? s.nullable() : s]));

const metaList = z.array(z.object({ key: z.string(), value: z.any().optional(), column: z.string().nullish() }));
const metaAny = metaList.or(z.record(z.string(), z.any()));
const metadata = metaList.optional()
  .describe('replaces the metadata list; each entry is a constant {key, value} (JSON types kept; numeric/boolean/JSON strings are parsed) or {key, column} copied per row from a source column, nested path (a.b[0].c) or "source_row"');
const target_column = z.string().nullable().optional().describe('schema field (json/text) that stores the per-row metadata object; null to disable');
const mapping = z.record(z.string(), z.union([z.array(z.string()), z.string(), z.null()])).optional()
  .describe('schema field -> source column(s) or nested paths like "a.b[0].c" / "completions[*].overall_score". Omit to auto-suggest from column names.');
const overrides = z.record(z.string(), z.any()).optional().describe('schema field -> constant value for every row');
const field_options = z.record(z.string(), z.record(z.string(), z.any()).nullable()).optional()
  .describe('per-dataset changes to schema field properties, e.g. {"label": {"label_mode": "index"}, "options": {"gold_from": {"column": "labels", "map": {"1": 0, "0": 1}}}}');
const target = z.string().default('datasets.duckdb').describe('DuckDB file: bare name (inside the data dir) or path');
const mode = z.enum(['create', 'append']);
const where = z.string().optional().describe('DuckDB row filter over source columns, e.g. "label >= 0 AND length(text) < 2000"');
const write = {
  where,
  write_key: z.string().optional().describe('rows are replaced per (dataset_id, write_key), so one import can be written several times under different keys/tags'),
  splits: z.array(z.object({ tag: z.string(), n: z.number().int(), metadata: metaAny.nullish(), overrides: z.record(z.string(), z.any()).nullish(), mapping: mapping.nullable(), field_options: field_options.nullable() })).optional()
    .describe('cut one shuffled sample into disjoint parts; each part is written with write_key = tag (sample is ignored) and may change metadata, overrides, mapping and field_options'),
  exclude_dataset_ids: z.array(z.string()).optional().describe('skip source rows already written to the target by these dataset_ids'),
  exclude_same_source: z.boolean().optional().describe('skip source rows already written to the target from the same source (same HF repo/config/split or file)'),
  distinct_by: z.string().optional().describe('column or path: at most max_per_value rows per value in this write (all splits); rows where it is null are kept. With stratify_by/balance it applies within each stratum, so rare values are not lost. Order: where -> exclude_* -> distinct_by -> stratify/balance interleave -> splits'),
  max_per_value: z.number().int().positive().optional().describe('distinct_by: keep up to this many rows per value (default 1)'),
  balance: z.string().optional().describe('schema field (e.g. "label"): spread the sample evenly over its values, like stratify_by, computed in DuckDB from its value_from map (regex keys too) or its mapped source column. Not with stratify_by'),
  skip_unknown_labels: z.boolean().optional().describe('skip (and refill) rows whose label is not one of the non-empty options, instead of writing them (field option skip_unknown does the same per field)'),
  compact: z.boolean().optional().describe('after the write, rewrite the target file without the space left by replaced/deleted rows (see compact_target)'),
  stratify_by: z.string().optional().describe('column or path (e.g. "domain", "meta.lang", "items[0].kind"): spread the sample evenly over its values; values that run short are topped up from the rest. The result reports strata (rows written per value) per write and per split'),
};
const explode = z.union([z.string(), z.object({ column: z.string(), as: z.string().optional(), history: z.union([z.boolean(), z.number().int()]).optional(),
  extract: z.record(z.string(), z.string()).optional() })]).optional()
  .describe('one row per element of a list column or path, e.g. "actions" or {"column": "trajectory", "as": "turn", "history": 2, "extract": {"task": "trajectory[1].content"}}: the element goes into `as` (default: the column, or the last name of the path) and the list column itself is dropped; extract keeps values from the whole list as columns. explode_step (0-based), explode_steps and, with history (N = the preceding N elements, true = up to 100), explode_history are added, and step/steps go to meta. Done in DuckDB into a Parquet file; source_row = row * 1000 + step; at most 1000 steps per row and SIEVE_MAX_ROWS rows in total');
const cleanup = z.boolean().default(false).describe("after a successful write, delete this dataset's downloaded files in data/downloads");
const fetchParams = {
  limit: z.union([z.number().int(), z.literal('all')]).optional()
    .describe('max rows to fetch (default 10000; "all" downloads whole shards, or with columns reads only those columns of every shard). Hugging Face with a limit reads only the needed row groups and columns remotely. hf.network_bytes = bytes fetched over the network (all routes)'),
  fetch: z.enum(['random', 'head']).optional().describe('HF partial fetch: "random" (default) = seeded random rows from random row groups across shards; "head" = the first N rows'),
  max_rows_per_group: z.number().int().positive().optional().describe('fetch="random": at most this many rows from one row group (default ceil(limit/16), i.e. >= 16 groups). Lower = better spread, more bytes'),
  row_groups: z.number().int().positive().optional().describe('fetch="random": spread the sample over this many row groups (overrides max_rows_per_group)'),
  columns: z.array(z.string()).optional().describe('HF partial fetch: only read these columns (default: the columns used by mapping/metadata/where when a mapping is given, else all)'),
};

const FIELD_DOC = `Schema JSON: {name, table?, description?, fields:[{name, type: ${schemas.FIELD_TYPES.join('|')}, transform?: ${schemas.TRANSFORMS.join('|')}, required?, max_chars?, max_items?, item_max_chars?, aliases?:[column names for auto-mapping], value? (constant value, or metadata key for transform=metadata; transform=meta marks the default per-row metadata column), option_field? (options field for label_to_option | label_to_distribution | options_dict), label_field? (label_to_distribution without own columns reads this field's source; default: the label_to_option field), label_mode?: auto|text|index|numeric (how a label matches options; auto = text, then numeric value if all options are numbers, else index/letter), ids?: text|index (option ids; default the option text, duplicates get "#2", "#3"), as? (options_dict: list [{id,text}] (default) | object {id:text}; label_to_distribution: object {id:p} (default) | list [{id,p}]; objects are written with keys in option order), allow_empty? / allow_duplicates? (options/shuffle fields: keep rows with empty/whitespace-only items or repeated texts after trim; default false = the row is skipped and refilled), duplicates?: skip (default) | drop (shuffle: remove repeated non-gold items, keep the row) | keep, skip_unknown? (label_to_option: skip rows whose label is not an option), value_from? {column, map?} (any field: the column value through map: exact keys, then "/regex/flags" keys, then "*" = any other value, e.g. {"column": "type", "map": {"click": "true", "/^type|select$/": "input", "*": "false"}}), gold_field? and gold_from? {column, map?} | {argmax_of: [score paths, one per item], ties?: skip (default, row is skipped and replaced) | first} (shuffle), enum?, default?}]}. Options may also be given with explicit ids: [{id, text}] or {id: text}. Transforms: label_to_distribution -> {probabilities} (one-hot from a label, uniform over a multi-label list, soft from a numeric value in auto/numeric mode, or normalised over several numeric columns; sums to 1); a label_to_option field that is empty or not an option gets the distribution's argmax option; options_dict -> ordered [{id, text}]; shuffle -> seeded shuffle of the mapped columns/list; gold = gold_from (column value, optionally mapped to an item index or column name; or the item with the highest argmax_of score) or the first item; its index after shuffling goes to gold_field (or meta.gold_index). Columns id, dataset_id, write_key, source_row, created_at are added automatically.`;

const BOARD_DOC = 'Board JSON: {name, seed? (42), nodes: [{id, type: "source" | "mix" | "target", x?, y?, ...}], edges: [{from, to, ...}]}. source: url (HF name/URL, file path or glob, .duckdb path, dataset_id) or target (a .duckdb output file in the data dir), plus import options (config, split, table, format, limit, fetch, fetch_seed, columns, row_groups, explode, mapping, field_options, metadata). mix: schema ("default"), n (500), seed?, stratify_by? | balance?, distinct_by?, max_per_value?, skip_unknown_labels?, overrides?, field_options?, metadata?, write_key?. target: target (file, default datasets.duckdb), mode (auto | create | append), compact?. Edges source -> mix carry the per-source settings, like the wizard mapping and metadata steps: weight (1), where?, mapping? {schema field: [source column or path, ...]} over the auto-suggested mapping (each source can map its own column names to the one mix schema; [] unmaps a field), metadata? (a list [{key, value} | {key, column}] replaces the source\'s metadata; an object {key: value} adds to it), target_column? (json/text field that stores the metadata per row, null = not stored), overrides?, field_options?. map_board_source shows the result. Edges mix -> target say where a mix is written. stratify_by/balance apply within each source. Metadata always gets board and board_source.';

export function buildMcpServer() {
  const s = new McpServer({ name: 'sieve-dataset-converter', version: '0.1.0' });
  const tool = (name, description, shape, fn) => s.registerTool(name, { description, inputSchema: nullable(shape) }, wrap(fn));
  tool('list_schemas', 'List available output schemas.', {}, () => schemas.listSchemas());
  tool('get_schema', 'Get one schema definition.', { name: z.string() }, ({ name }) => schemas.getSchema(name));
  tool('save_schema', `Create or overwrite a schema. ${FIELD_DOC}`, { schema: z.record(z.string(), z.any()) }, ({ schema }) => schemas.saveSchema(schema));
  tool('list_targets', 'List .duckdb target files in the data dir.', {}, () => core.listTargets());
  tool('hf_splits', 'List configs and splits (with row counts) of a Hugging Face dataset.', { dataset: z.string() }, ({ dataset }) => core.hfSplits(dataset));
  tool('import_dataset', 'Fetch a dataset: Hugging Face name (org/name) or URL; a CSV/JSON/JSONL/Parquet/DuckDB URL or local path; a glob of local files; or the dataset_id of an earlier HF import (re-reads its files in data/downloads, keeping the HF origin). Returns dataset_id, columns, row count and an auto-suggested mapping for the chosen schema.',
    { url: z.string(), schema: z.string().default('default'), config: z.string().optional(), split: z.string().optional(), format: z.enum(['csv', 'json', 'jsonl', 'parquet', 'duckdb']).optional(),
      table: z.string().optional().describe('table to read from a .duckdb source (default: first; see tables in the result)'), ...fetchParams,
      seed: z.number().int().optional().describe('seed for fetch="random" (default 42)'), explode,
      mapping: mapping.describe('optional mapping, applied after import and used to pick columns to fetch'),
      field_options: field_options.describe('optional field options, applied after import (gold_from columns are fetched too)') },
    ({ url, ...o }) => core.importDataset(url, o));
  tool('preview', 'Show raw rows and how they convert with the current schema and mapping (max 50 rows), from an offset or as a seeded random sample. value_counts counts the values of a column/path over all imported rows. Rows that a write would skip carry _skipped.',
    { dataset_id: z.string(), n: z.number().int().optional().describe('rows to show (default 5, max 50; 0 = only value_counts)'), where,
      offset: z.number().int().optional().describe('skip this many rows first'), random: z.boolean().optional().describe('seeded random rows instead of the first ones'), seed: z.number().int().optional(),
      value_counts: z.object({ column: z.string().describe('column or path; JSON text inside is parsed, e.g. "turn.tool_calls[0].function.arguments.command"'), top: z.number().int().optional().describe('default 20, max 1000'), where: z.string().optional().describe('extra filter for the counts (combined with the top-level where)') }).optional() },
    ({ dataset_id, n, where: w, ...o }) => core.preview(dataset_id, n, w, o));
  tool('set_metadata', 'Set the metadata list and the column it is stored in, switch schema or DuckDB source table, or change the field mapping, constant overrides or field options. Overrides and field options set here stay for every later write (merged by field; a null value removes one); for one write only, pass them to convert_and_write.',
    { dataset_id: z.string(), metadata, target_column, schema: z.string().optional(), table: z.string().optional().describe('switch table for .duckdb sources'), mapping,
      overrides: overrides.describe('schema field -> constant value for every later write; null removes that field\'s override'), field_options,
      clear_overrides: z.boolean().optional().describe('drop all stored overrides first (with overrides = replace them)'),
      clear_field_options: z.boolean().optional().describe('drop all stored field options first (with field_options = replace them)') },
    ({ dataset_id, metadata: m, ...o }) => core.setMetadata(dataset_id, m, o));
  tool('convert_and_write', 'Seeded sample of N rows (default 500), convert, and write into the target DuckDB (schema table + datasets metadata table). mode=create makes a new file, mode=append adds to an existing one. Re-writing the same dataset_id + write_key replaces its rows.',
    { dataset_id: z.string(), sample: z.number().int().default(500), target, mode: mode.default('append'), seed: z.number().int().default(42), cleanup, ...write,
      metadata: metaAny.optional().describe('metadata for this write only, merged by key onto the dataset metadata (set_metadata is unchanged)'),
      overrides: z.record(z.string(), z.any()).optional().describe('field -> constant for this write only'),
      mapping: mapping.describe('mapping changes for this write only'), field_options: field_options.describe('field option changes for this write only') },
    ({ dataset_id, ...o }) => core.convertAndWrite(dataset_id, o));
  tool('run_pipeline', 'One shot: Hugging Face name (+ optional config/split) and schema -> fetch, map, sample, write. With a mapping, only the columns it uses are fetched. mode defaults to append if the target exists, else create.',
    { url: z.string(), schema: z.string().default('default'), config: z.string().optional(), split: z.string().optional(), table: z.string().optional(), ...fetchParams,
      fetch_seed: z.number().int().optional().describe('seed for fetch="random" (default 42)'), explode,
      metadata, target_column, mapping, overrides, field_options, sample: z.number().int().default(500), seed: z.number().int().default(42), target, mode: mode.optional(), cleanup, ...write },
    (a) => core.runPipeline(a));
  tool('delete_dataset', "Delete a dataset_id's rows (all write_keys, or only write_key) and its records in the datasets table of a target file.",
    { dataset_id: z.string(), target, write_key: z.string().optional(), compact: z.boolean().optional().describe('then compact the file (see compact_target)') }, ({ dataset_id, ...o }) => core.deleteDataset(dataset_id, o));
  tool('compact_target', 'Rewrite a target .duckdb file without the space left by deleted or replaced rows (checkpoint, copy every table into a new file, swap). Returns bytes before/after.',
    { target }, ({ target: t }) => core.compactTarget(t));
  tool('cleanup_downloads', 'Delete downloaded source files in data/downloads: one dataset_id, or all when omitted. Returns files deleted and bytes freed.',
    { dataset_id: z.string().optional() }, ({ dataset_id }) => core.cleanupDownloads(dataset_id));
  tool('list_datasets', 'List datasets imported in this process.', {}, () => core.listDatasets());
  tool('profile', 'Profile the imported rows: for every column its type, null count, distinct count and top values (text cut at 80 chars).',
    { dataset_id: z.string(), top: z.number().int().optional().describe('top values per column (default 5, max 50)'), where }, ({ dataset_id, ...o }) => core.profile(dataset_id, o));
  tool('copy_rows', 'Copy written rows from one target .duckdb file into another, keeping id, source_row, meta, write_key and created_at, with their datasets records. Rows with the same id are replaced.',
    { source_target: z.string().describe('.duckdb file to copy from'), table: z.string().optional().describe('table to copy (default: the only one besides datasets)'), target,
      where: z.string().optional().describe('filter on the table columns, e.g. "write_key = \'a\'" or "meta->>\'lang\' = \'en\'"'), n: z.number().int().optional().describe('seeded sample of n rows (default all)'), seed: z.number().int().optional(), compact: z.boolean().optional().describe('then compact the target file') },
    (a) => core.copyRows(a));
  // boards: a canvas of sources -> mixes -> targets, saved as data/boards/<name>.json
  const boardRef = { name: z.string().optional().describe('saved board name'), board: z.record(z.string(), z.any()).optional().describe('or an unsaved board object') };
  tool('save_board', `Save a board (create or overwrite data/boards/<name>.json). ${BOARD_DOC}`, { board: z.record(z.string(), z.any()) }, ({ board }) => boards.saveBoard(board));
  tool('get_board', 'Get a saved board.', { name: z.string() }, ({ name }) => boards.getBoard(name));
  tool('list_boards', 'List saved boards with their node counts.', {}, () => boards.listBoards());
  tool('preview_mix', 'Preview a mix of a board: a combined seeded sample of n rows (default 20, max 500) split over its sources by weight (largest remainder), converted to the mix schema, each row tagged with its source node in _source. Nothing is written. Reports per-source requested/rows/pool_rows and a mapping check (ok, missing required fields, unknown columns); a source with unknown columns reports an error instead of rows.',
    { ...boardRef, mix: z.string().optional().describe('mix node id (default: the only mix)'), n: z.number().int().optional() }, (a) => boards.previewMix(a));
  tool('run_board', 'Run a board: every mix connected to a target (or only mix / target) is written with convert_and_write per source, n by weight, one shared write_key per mix (default "<board>-<mix>"); the run writes under a staging key and then replaces the rows of an earlier run under that write_key (so the same seed gives the same rows, and a failed run leaves the earlier rows in place). Sources whose mapping names unknown columns stop the run before anything is written. Reports per-source counts.',
    { ...boardRef, mix: z.string().optional(), target: z.string().optional().describe('target node id') }, (a) => boards.runBoard(a));
  tool('map_board_source', 'One source of a mix as the canvas mapping editor shows it: the source columns, the mix schema, the suggested mapping, the effective mapping / metadata / target_column (edge settings over the suggestion), a check (status per field: ok | missing | unmapped | unknown) and a few rows converted with exactly these settings. Set the mapping on the edge (save_board) and call again to verify.',
    { ...boardRef, mix: z.string().optional().describe('mix node id (default: the only mix)'), source: z.string().describe('source node id'), rows: z.number().int().optional().describe('converted rows (default 3, max 20)') }, (a) => boards.edgeInfo(a));
  return s;
}
