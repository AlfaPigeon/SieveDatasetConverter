// Shared by the wizard (app.js) and the canvas (canvas.js): the mapping grid (one select per schema field, chips for
// multi-column "join" fields), metadata rows (fixed value or from a column, plus the field that stores them) and the
// schema editor (JSON; save under a new name to create a schema).
const SieveUI = (() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // fields a source column can feed (the others are constants, metadata, the meta object or derived)
  const mappable = (f) => !['constant', 'metadata', 'meta', 'options_dict'].includes(f.transform || 'copy');
  // short note on what a field does with its column: "→ options" for labels matched against an option field, etc.
  function fieldNote(def = {}) {
    const t = def.transform || 'copy';
    if (t === 'join') return 'one or more columns, joined';
    if (t === 'label_to_option') return `label → one of ${def.option_field}`;
    if (t === 'label_to_distribution') return `distribution over ${def.option_field}`;
    if (t === 'shuffle') return 'options, shuffled';
    if (t === 'first') return 'first non-empty column';
    return def.type && def.type !== 'text' ? def.type : '';
  }
  // type line for a field: "text · joined", "list", "text · option", "json · distribution"
  const typeLine = (def = {}) => `${def.type || 'text'}${{ join: ' · joined', label_to_option: ' · option', label_to_distribution: ' · distribution', shuffle: ' · shuffled', first: ' · first' }[def.transform] || ''}`;
  // how a field is filled (schema overview)
  function filledBy(def = {}) {
    const t = def.transform || 'copy';
    return { constant: `constant: ${def.value ?? ''}`, metadata: `metadata: ${def.value || def.name}`, meta: 'metadata column', options_dict: `options of ${def.option_field}`,
      join: 'mapped, joined', label_to_option: 'mapped, to option', label_to_distribution: 'mapped / from label', shuffle: 'mapped, shuffled', first: 'mapped, first non-empty' }[t] || 'mapped';
  }
  // mapping: {field: [cols]} (the import's suggestion or an edited copy); columns: source column names.
  // o.status: {field: ok | missing | unmapped | unknown} marks fields; o.notes: show what each field does.
  function mappingHTML(schema, columns, mapping, o = {}) {
    const fields = Object.keys(mapping).map((f) => schema.fields.find((x) => x.name === f) || { name: f });
    return fields.map((def) => {
      const f = def.name, sel = mapping[f] || [], st = o.status?.[f] || '';
      const extra = sel.filter((c) => !columns.includes(c)); // a path or a column this source does not have
      const opts = (ph, multi) => `<option value="">${ph}</option>` + [...columns, ...(multi ? [] : extra)].filter((c) => !(multi && sel.includes(c))).map((c) => `<option ${!multi && sel.includes(c) ? 'selected' : ''}>${esc(c)}</option>`).join('');
      if (o.rows) { // drawer layout: name + type line on the left, control (+ AUTO badge) on the right, helper below
        const ctl = def.transform === 'join'
          ? `<div class="chips" data-f="${esc(f)}">${sel.map((c) => `<span class="chip${columns.includes(c) ? '' : ' bad'}" data-c="${esc(c)}">${esc(c)}<button type="button" title="Remove">×</button></span>`).join('')}<select>${opts('+ add column', true)}</select></div>`
          : `<select data-f="${esc(f)}">${opts('—')}</select>`;
        return `<div class="mrow ${st}" data-field="${esc(f)}"><div class="mname"><span>${esc(f)}${def.required ? '<em class="req">*</em>' : ''}</span><small>${esc(typeLine(def))}</small></div>
          <div class="mctl">${ctl}${o.auto?.(f) ? '<span class="badge auto">Auto</span>' : ''}</div>${o.helper?.(f) || ''}</div>`;
      }
      const note = o.notes ? fieldNote(def) : '';
      const head = `${esc(f)}${def.required ? '<em class="req" title="required">*</em>' : ''}${note ? `<small class="fnote">${esc(note)}</small>` : ''}`;
      if (def.transform === 'join') return `<label class="mf ${st}" data-field="${esc(f)}">${head}<div class="chips" data-f="${esc(f)}">${sel.map((c) => `<span class="chip${columns.includes(c) ? '' : ' bad'}" data-c="${esc(c)}">${esc(c)}<button type="button" title="Remove">×</button></span>`).join('')}<select>${opts('+ add column', true)}</select></div></label>`;
      return `<label class="mf ${st}" data-field="${esc(f)}">${head}<select data-f="${esc(f)}">${opts('—')}</select></label>`;
    }).join('');
  }
  function readMapping(root) {
    const m = {};
    root.querySelectorAll('select[data-f]').forEach((s) => (m[s.dataset.f] = s.value ? [s.value] : []));
    root.querySelectorAll('.chips').forEach((c) => (m[c.dataset.f] = [...c.querySelectorAll('.chip')].map((x) => x.dataset.c)));
    return m;
  }
  // chip remove / add and select changes; onChange(mapping) after each edit
  function bindMapping(root, onChange) {
    root.addEventListener('click', (e) => {
      if (!e.target.closest('.chip button')) return;
      e.target.closest('.chip').remove(); onChange(readMapping(root), e);
    });
    root.addEventListener('change', (e) => {
      if (!e.target.closest('select')) return;
      const chips = e.target.closest('.chips');
      if (chips && e.target.value) chips.insertAdjacentHTML('afterbegin', `<span class="chip" data-c="${esc(e.target.value)}"></span>`);
      onChange(readMapping(root), e);
    });
  }
  const metaRowHTML = (e, cols) => `<div class="kv"><input class="k" placeholder="key" value="${esc(e.key || '')}">
    <select class="m"><option value="value">constant</option><option value="column" ${e.column != null ? 'selected' : ''}>from column</option></select>
    ${e.column != null ? `<select class="v">${[...new Set([...cols, e.column].filter(Boolean))].map((c) => `<option ${c === e.column ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>` : `<input class="v" placeholder="value" value="${esc(typeof e.value === 'object' && e.value !== null ? JSON.stringify(e.value) : e.value ?? '')}">`}
    <button class="ghost del" title="Remove">×</button></div>`;
  const metaRowsHTML = (list, cols) => list.map((e) => metaRowHTML(e, cols)).join('');
  function readMetadata(root) {
    return [...root.querySelectorAll('.kv')].map((r) => {
      const key = r.querySelector('.k').value, v = r.querySelector('.v').value;
      return r.querySelector('.m').value === 'column' ? { key, column: v } : { key, value: v };
    }).filter((e) => e.key.trim());
  }
  const addMetaRow = (root, cols) => root.insertAdjacentHTML('beforeend', metaRowHTML({ key: '', value: '' }, cols));
  // remove / constant <-> column switch; onChange(list) after removes, switches and committed edits (change events)
  function bindMetadata(root, cols, onChange = () => {}) {
    root.addEventListener('click', (e) => { if (e.target.closest('.del')) { e.target.closest('.kv').remove(); onChange(readMetadata(root), e); } });
    root.addEventListener('change', (e) => {
      if (e.target.classList.contains('m')) {
        const row = e.target.closest('.kv'), key = row.querySelector('.k').value, c = typeof cols === 'function' ? cols() : cols;
        row.outerHTML = metaRowHTML(e.target.value === 'column' ? { key, column: c[0] } : { key, value: '' }, c);
      }
      onChange(readMetadata(root), e);
    });
  }
  // "Store in": json/text fields of the schema that can hold the metadata object
  const metaColOptions = (schema, current) => `<option value="">— not stored per row</option>` +
    schema.fields.filter((f) => ['json', 'text'].includes(f.type)).map((f) => `<option ${f.name === current ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
  // schema editor: the schema as JSON; saving under a new name creates a schema
  const api = async (u, body) => {
    const r = await fetch(u, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
  };
  const schemaJSON = async (name) => JSON.stringify(await api('/api/schemas/' + encodeURIComponent(name)), null, 2);
  async function saveSchemaJSON(text) {
    let s; try { s = JSON.parse(text); } catch (e) { throw new Error(`Schema JSON: ${e.message}`); }
    return api('/api/schemas', s);
  }
  const newSchemaJSON = (from) => { const s = JSON.parse(from); s.name = `${s.name}_copy`; s.table = s.name; return JSON.stringify(s, null, 2); };
  return { esc, mappable, fieldNote, typeLine, filledBy, mappingHTML, readMapping, bindMapping, metaRowHTML, metaRowsHTML, readMetadata, addMetaRow, bindMetadata, metaColOptions, schemaJSON, saveSchemaJSON, newSchemaJSON };
})();
