# Sieve DatasetConverter

Pull a dataset from Hugging Face (or a CSV / JSON / JSONL / Parquet URL), map it onto a schema you define, sample N rows and write them into a DuckDB file. One-page web UI plus an MCP server, so AI agents can run the same pipeline.

```bash
npm install && npm start    # UI at http://localhost:3000, MCP (streamable HTTP) at /mcp
npm run mcp:stdio           # MCP over stdio
```
Node 20+, no Docker. Env: `PORT` (3000), `DATA_DIR` (`data`: downloads and `.duckdb` targets), `SCHEMAS_DIR` (`schemas`), `HF_TOKEN` (gated or private datasets).

## Flow
| | |
|---|---|
| **1. Dataset**: type `org/name` (optionally a config and split), pick a schema, Download. Hugging Face datasets resolve to Parquet through the datasets-server (`train` split by default). | ![](docs/screenshots/1-dataset.png) |
| **2. Mapping**: each schema field gets source columns suggested from its name and `aliases`. Change any of them. | ![](docs/screenshots/2-mapping.png) |
| **3. Metadata**: name, domain, source, notes. Preview shows converted rows. | ![](docs/screenshots/3-metadata.png) |
| **4. Sample & write**: seeded sample (default 500 rows, seed 42) into a new (`create`) or existing (`append`) `.duckdb` file. | ![](docs/screenshots/4-write.png) |
| **Schemas**: edit or create a schema as JSON from the page. | ![](docs/screenshots/5-schema-editor.png) |

## Schemas
Schemas are JSON files in `schemas/`. Each writes to its own table. `id`, `dataset_id`, `source_row` and `created_at` are added automatically, and every write also records a row in a `datasets` table (metadata, mapping, seed, row counts). Writing the same `dataset_id` again replaces its rows.

```json
{ "name": "qa_pair", "table": "qa_pair", "fields": [
  { "name": "question", "type": "text", "required": true, "max_chars": 300, "aliases": ["question"] },
  { "name": "answer",   "type": "text", "max_chars": 100, "aliases": ["answer", "answerkey"] },
  { "name": "domain",   "type": "text", "transform": "metadata", "value": "domain" } ] }
```
- **type**: `text`, `number`, `integer`, `boolean`, `list` (stored as JSON), `json`
- **transform**: `copy` (default), `join` (several columns as `col: value` lines), `first`, `constant` (`value`), `metadata` (`value` = name, domain, source or notes), `label_to_option` (turns an index, letter or HF `{label:[…]}` key into the option text from `option_field`)
- **limits**: `max_chars`, `max_items`, `item_max_chars`, plus `required`, `enum` and `default`

The built-in `default` schema holds decision rows: `domain`, `decision_type` (`choice` | `noul` | `score`), `input` (≤ 4000 chars), `options` (≤ 16, each ≤ 200 chars), `label` (≤ 500 chars) and `score`.

## MCP tools
`list_schemas`, `get_schema`, `save_schema`, `list_targets`, `import_dataset(url, schema, config?, split?)`, `preview`, `set_metadata(…, schema?, mapping?, overrides?)`, `convert_and_write(dataset_id, sample=500, target, mode=create|append, seed=42)`, `run_pipeline(url, schema, config?, split?, metadata?, sample, target, mode?)` (one shot), `list_datasets`.

Imported datasets live in memory for each process. The UI and `/mcp` share that state; a stdio process keeps its own.

## License
MIT
