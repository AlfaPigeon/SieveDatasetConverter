// Schema store: JSON files in ./schemas (override with SCHEMAS_DIR).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.resolve(ROOT, process.env.SCHEMAS_DIR || 'schemas');
fs.mkdirSync(DIR, { recursive: true });

export const FIELD_TYPES = ['text', 'number', 'integer', 'boolean', 'list', 'json'];
export const TRANSFORMS = ['copy', 'join', 'first', 'constant', 'metadata', 'meta', 'label_to_option', 'label_to_distribution', 'options_dict', 'shuffle'];
const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const RESERVED = ['id', 'dataset_id', 'write_key', 'source_row', 'created_at'];

export function validateSchema(s) {
  if (!s || typeof s !== 'object') throw new Error('schema must be an object');
  if (!NAME.test(s.name || '')) throw new Error('schema.name must match ' + NAME);
  s.table = s.table || s.name;
  if (!NAME.test(s.table)) throw new Error('schema.table must match ' + NAME);
  if (s.table === 'datasets') throw new Error('table name "datasets" is reserved');
  if (!Array.isArray(s.fields) || !s.fields.length) throw new Error('schema.fields must be a non-empty array');
  const seen = new Set();
  for (const f of s.fields) {
    if (!NAME.test(f.name || '')) throw new Error(`field name "${f.name}" must match ${NAME}`);
    if (RESERVED.includes(f.name)) throw new Error(`field name "${f.name}" is reserved`);
    if (seen.has(f.name)) throw new Error(`duplicate field "${f.name}"`);
    seen.add(f.name);
    f.type = f.type || 'text';
    f.transform = f.transform || 'copy';
    if (!FIELD_TYPES.includes(f.type)) throw new Error(`field ${f.name}: type must be one of ${FIELD_TYPES}`);
    if (!TRANSFORMS.includes(f.transform)) throw new Error(`field ${f.name}: transform must be one of ${TRANSFORMS}`);
  }
  for (const f of s.fields) {
    const has = (n) => s.fields.some((g) => g.name === n);
    if (['label_to_option', 'label_to_distribution', 'options_dict'].includes(f.transform) && !has(f.option_field))
      throw new Error(`field ${f.name}: option_field "${f.option_field}" not found`);
    if (f.label_field && !has(f.label_field)) throw new Error(`field ${f.name}: label_field "${f.label_field}" not found`);
    if (f.gold_field && !has(f.gold_field)) throw new Error(`field ${f.name}: gold_field "${f.gold_field}" not found`);
    if (f.ids && !['text', 'index'].includes(f.ids)) throw new Error(`field ${f.name}: ids must be text or index`);
    if (f.label_mode && !['auto', 'text', 'index', 'numeric'].includes(f.label_mode)) throw new Error(`field ${f.name}: label_mode must be auto, text, index or numeric`);
    if (f.as && !['object', 'list'].includes(f.as)) throw new Error(`field ${f.name}: as must be object or list`);
    if (f.gold_from && !f.gold_from.column && !Array.isArray(f.gold_from.argmax_of)) throw new Error(`field ${f.name}: gold_from needs column or argmax_of`);
    if (f.gold_from?.ties != null && !['skip', 'first'].includes(f.gold_from.ties)) throw new Error(`field ${f.name}: gold_from.ties must be skip or first`);
  }
  return s;
}
export function listSchemas() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => {
    const s = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    return { name: s.name, table: s.table || s.name, description: s.description || '', fields: s.fields.map((x) => x.name) };
  });
}
export function getSchema(name) {
  const p = path.join(DIR, `${name}.json`);
  if (!NAME.test(name) || !fs.existsSync(p)) throw new Error(`Unknown schema "${name}"`);
  return validateSchema(JSON.parse(fs.readFileSync(p, 'utf8')));
}
export function saveSchema(s) {
  if (typeof s === 'string') s = JSON.parse(s);
  validateSchema(s);
  fs.writeFileSync(path.join(DIR, `${s.name}.json`), JSON.stringify(s, null, 2) + '\n');
  return s;
}
