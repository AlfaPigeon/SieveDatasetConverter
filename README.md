# Sieve Dataset Converter

Pull a dataset from Hugging Face or a Parquet, CSV, JSON, JSONL or DuckDB file, map it onto a schema you define, sample N rows and write them to a DuckDB file. It comes as a one-page web UI and an MCP server, so AI agents can run the same pipeline.

```bash
npm install && npm start    # UI at http://localhost:3000 · MCP (streamable HTTP) at /mcp
npm run mcp:stdio           # MCP over stdio
```
Node 20+, no Docker. Env: `PORT` (3000), `DATA_DIR` (`data`: downloads and `.duckdb` targets), `SCHEMAS_DIR` (`schemas`), `HF_TOKEN` (gated or private HF datasets).

## Flow
**1 · Dataset**: type `org/name` and the config/split dropdown fills from the Hugging Face API. You can also paste a file URL or a local path. Choose a schema and how many rows to fetch (default 10,000, or `all`). Hugging Face Parquet shards download one at a time and stop as soon as the limit is reached.
![](docs/screenshots/1-dataset.png)

**2 · Mapping**: each schema field gets source columns suggested from its name and `aliases`. `join` fields take several columns, shown as chips.
![](docs/screenshots/2-mapping.png)

**3 · Metadata**: a key/value list. Each value is either a constant or copied per row from a source column. Choose the schema column it goes into (default `meta`). The table previews converted rows.
![](docs/screenshots/3-metadata.png)

**4 · Sample & write**: a seeded sample (500 rows, seed 42) goes into an existing `.duckdb` file (append) or a new one (create). Files are listed from `DATA_DIR`.
![](docs/screenshots/4-write.png)

**Schemas**: edit or create a schema as JSON from the page.
![](docs/screenshots/5-schema-editor.png)

## Sources
| source | how |
|---|---|
| Hugging Face | `org/name`, `https://huggingface.co/datasets/org/name`, plus optional `config` and `split` (default: `train`). Read via the datasets-server Parquet export |
| Parquet / CSV / TSV / JSON / JSONL | URL or local path, detected by extension (or pass `format`) |
| DuckDB | `.duckdb` / `.db` URL or local path, attached read-only. `tables` lists what's inside; choose one with `table` (default: the first) |

## Schemas
Schemas are JSON files in `schemas/`. Each one writes to its own table. `examples/schemas/qa_pair.json` shows a minimal one, and you can copy it into `schemas/` or post it through `save_schema`.

```json
{ "name": "qa_pair", "table": "qa_pair", "fields": [
  { "name": "question", "type": "text", "required": true, "max_chars": 300, "aliases": ["question"] },
  { "name": "answer",   "type": "text", "max_chars": 100, "aliases": ["answer", "answerkey"] },
  { "name": "domain",   "type": "text", "transform": "metadata", "value": "domain" } ] }
```
- **type**: `text`, `number`, `integer`, `boolean`, `list` (stored as JSON), `json`
- **transform**:
  - `copy` (default) and `first`
  - `join`: several columns as `col: value` lines
  - `constant`: uses `value`
  - `metadata`: the metadata entry whose key is `value`
  - `meta`: the default column for the per-row metadata object
  - `label_to_option`: turns an index, a letter or an HF `{label:[…]}` key into option text from `option_field`
- **limits and rules**: `max_chars`, `max_items`, `item_max_chars`, `required` (rows missing it are skipped), `enum`, `default`

The built-in `default` schema holds decision rows: `domain`, `decision_type` (`choice` | `noul` | `score`), `input` (≤ 4000 chars), `options` (≤ 16 × 200 chars), `label` (≤ 500 chars), `score` and `meta`.

## DuckDB layout
**`<schema.table>`** (e.g. `rows`): one row per sampled record
| column | type | |
|---|---|---|
| id | VARCHAR PK | `<dataset_id>-<source_row>` |
| dataset_id | VARCHAR | |
| source_row | BIGINT | row index in the source |
| *schema fields* | per `type` | `text`→VARCHAR, `number`→DOUBLE, `integer`→BIGINT, `boolean`→BOOLEAN, `list`/`json`→JSON |
| *metadata column* (e.g. `meta`) | JSON | `{key: value}` for every metadata entry; column-sourced values differ per row |
| created_at | TIMESTAMP | |

**`datasets`**: one row per dataset per table: `dataset_id, schema_name, table_name, name, metadata JSON ({entries, column}), url, format, source_rows, rows_written, sample_seed, mapping JSON, written_at`.

Writing the same `dataset_id` again replaces its rows. `create` fails if the file already exists, and `append` fails if it doesn't.

## MCP tools
| tool | params |
|---|---|
| `list_schemas` | – |
| `get_schema` | `name` |
| `save_schema` | `schema` (JSON as above; a new `name` creates a schema) |
| `hf_splits` | `dataset` → configs/splits with row counts |
| `list_targets` | – → `.duckdb` files in `DATA_DIR` |
| `import_dataset` | `url`, `schema="default"`, `config?`, `split?`, `table?` (DuckDB source), `format?`, `limit?` (10000 \| n \| `"all"`) |
| `preview` | `dataset_id`, `n?` |
| `set_metadata` | `dataset_id`, `metadata?: [{key, value} \| {key, column}]`, `target_column?` (null disables), `schema?`, `table?`, `mapping?: {field: [cols]}`, `overrides?: {field: value}` |
| `convert_and_write` | `dataset_id`, `sample=500`, `seed=42`, `target="datasets.duckdb"`, `mode="append"` \| `"create"` |
| `run_pipeline` | everything above in one call; `mode` defaults to append if the target exists, else create |
| `list_datasets` | – |

```json
{ "tool": "run_pipeline", "arguments": {
  "url": "allenai/ai2_arc", "config": "ARC-Easy", "split": "train", "limit": 5000,
  "metadata": [{ "key": "domain", "value": "science-qa" }, { "key": "question_id", "column": "id" }],
  "target_column": "meta", "sample": 500, "target": "science.duckdb", "mode": "create" } }
```
```json
{ "tool": "import_dataset", "arguments": { "url": "/data/zoo.duckdb", "table": "iris", "limit": "all" } }
```
Imported datasets live in memory for each process. The UI and `/mcp` share that state; a stdio process keeps its own.

## License
MIT
