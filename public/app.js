const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let D = null, schema = null, targets = [];
const NEW = '__new__';

const api = async (u, body) => {
  const r = await fetch(u, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
};
const toast = (msg) => { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); };
function alertIn(sec, msg) {
  document.querySelectorAll('.alert').forEach((a) => a.remove());
  if (msg) $(sec).insertAdjacentHTML('beforeend', `<div class="alert">${esc(msg)}</div>`);
}
const run = (sec, f) => async (e) => {
  const b = e?.currentTarget; if (b?.tagName === 'BUTTON') b.disabled = true;
  try { alertIn(sec); await f(e); } catch (err) { alertIn(sec, err.message); } finally { if (b?.tagName === 'BUTTON') b.disabled = false; }
};
const steps = (on) => ['s2', 's3', 's4'].forEach((s) => $(s).classList.toggle('off', !on));

// --- step 1: source, schema, HF splits ---
async function loadSchemas(pick) {
  const list = await api('/api/schemas');
  $('schema').innerHTML = list.map((s) => `<option title="${esc(s.description)}">${esc(s.name)}</option>`).join('');
  $('schema').value = pick || $('schema').value || 'default';
  schema = await api('/api/schemas/' + $('schema').value);
}
let splitTimer;
$('url').addEventListener('input', () => {
  clearTimeout(splitTimer); $('split').hidden = true; $('table').hidden = true;
  const v = $('url').value.trim();
  if (!/^([\w.-]+\/[\w.-]+)$|huggingface\.co\/datasets\//.test(v) || /\.\w+$/.test(v.split('?')[0]) && !v.includes('/datasets/')) return;
  splitTimer = setTimeout(async () => {
    try {
      const { splits } = await api('/api/hf/splits?dataset=' + encodeURIComponent(v));
      $('split').innerHTML = splits.map((s) => `<option value="${esc(s.config)}|${esc(s.split)}">${esc(s.config)} / ${esc(s.split)}${s.rows ? ` · ${s.rows.toLocaleString()}` : ''}</option>`).join('');
      const train = splits.findIndex((s) => s.split === 'train'); if (train >= 0) $('split').selectedIndex = train;
      $('split').hidden = false;
    } catch { /* not an HF dataset */ }
  }, 450);
});
$('editBtn').onclick = run('s1', async () => {
  $('editor').hidden = !$('editor').hidden;
  if (!$('editor').hidden) $('schemaJson').value = JSON.stringify(schema, null, 2);
});
$('schema').onchange = run('s1', async () => {
  schema = await api('/api/schemas/' + $('schema').value);
  if (!$('editor').hidden) $('schemaJson').value = JSON.stringify(schema, null, 2);
  if (D) { fill(await api(`/api/datasets/${D.dataset_id}/metadata`, { schema: schema.name })); await preview(); }
});
$('saveSchema').onclick = run('s1', async () => {
  const s = await api('/api/schemas', JSON.parse($('schemaJson').value));
  await loadSchemas(s.name); toast(`Schema “${s.name}” saved`);
});
$('dl').onclick = run('s1', async () => {
  $('info').textContent = 'Downloading…';
  try { await doImport(); } catch (e) { $('info').textContent = D ? $('info').dataset.last : ''; throw e; }
});
async function doImport() {
  const b = { url: $('url').value, schema: $('schema').value, limit: $('limit').value };
  if (!$('split').hidden) [b.config, b.split] = $('split').value.split('|');
  fill(await api('/api/import', b)); await preview(); toast('Dataset ready');
}
$('table').onchange = run('s1', async () => { fill(await api(`/api/datasets/${D.dataset_id}/metadata`, { table: $('table').value })); await preview(); });

// --- step 2: mapping (select per field; chips for multi-column "join" fields) ---
function fill(d) {
  D = d; steps(true);
  const src = d.hf ? `${d.hf.config} / ${d.hf.split} · ${d.hf.via === 'download' ? `${d.hf.shards} shards` : d.hf.via}${d.download_bytes ? ` · ${(d.download_bytes / 1e6).toFixed(1)} MB` : ''}` : d.table ? `table ${d.table}` : d.format;
  $('info').textContent = $('info').dataset.last = `${d.row_count.toLocaleString()} rows fetched${d.limit ? ` (limit ${d.limit.toLocaleString()})` : ''} · ${src} · ${d.columns.length} columns`;
  if (d.tables) { $('table').innerHTML = d.tables.map((t) => `<option>${esc(t)}</option>`).join(''); $('table').value = d.table; $('table').hidden = false; }
  const cols = d.columns.map((c) => c.name);
  const opts = (sel, ph) => `<option value="">${ph}</option>` + cols.filter((c) => !sel.includes(c) || ph === '—').map((c) => `<option ${sel.includes(c) && ph === '—' ? 'selected' : ''}>${esc(c)}</option>`).join('');
  $('map').innerHTML = Object.entries(d.mapping).map(([f, sel]) => {
    const def = schema.fields.find((x) => x.name === f) || {};
    if (def.transform === 'join') return `<label>${esc(f)}<div class="chips" data-f="${esc(f)}">${sel.map((c) => `<span class="chip" data-c="${esc(c)}">${esc(c)}<button type="button" title="Remove">×</button></span>`).join('')}<select>${opts(sel, '+ add column')}</select></div></label>`;
    return `<label>${esc(f)}<select data-f="${esc(f)}">${opts(sel, '—')}</select></label>`;
  }).join('');
  $('meta').innerHTML = d.metadata.map((e) => metaRow(e, cols)).join('');
  const jf = schema.fields.filter((f) => ['json', 'text'].includes(f.type)).map((f) => f.name);
  $('metaCol').innerHTML = `<option value="">— not stored per row</option>` + jf.map((f) => `<option ${f === d.meta_column ? 'selected' : ''}>${esc(f)}</option>`).join('');
}
const metaRow = (e, cols) => `<div class="kv"><input class="k" placeholder="key" value="${esc(e.key || '')}">
  <select class="m"><option value="value">constant</option><option value="column" ${e.column ? 'selected' : ''}>from column</option></select>
  ${e.column != null ? `<select class="v">${cols.map((c) => `<option ${c === e.column ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>` : `<input class="v" placeholder="value" value="${esc(e.value || '')}">`}
  <button class="ghost del" title="Remove">×</button></div>`;
const metadata = () => [...document.querySelectorAll('#meta .kv')].map((r) => {
  const key = r.querySelector('.k').value, v = r.querySelector('.v').value;
  return r.querySelector('.m').value === 'column' ? { key, column: v } : { key, value: v };
}).filter((e) => e.key.trim());
const cols = () => D.columns.map((c) => c.name);
$('addMeta').onclick = () => $('meta').insertAdjacentHTML('beforeend', metaRow({ key: '', value: '' }, cols()));
$('meta').addEventListener('click', (e) => { if (e.target.closest('.del')) e.target.closest('.kv').remove(); });
$('meta').addEventListener('change', (e) => {
  if (!e.target.classList.contains('m')) return;
  const row = e.target.closest('.kv'), key = row.querySelector('.k').value;
  row.outerHTML = metaRow(e.target.value === 'column' ? { key, column: cols()[0] } : { key, value: '' }, cols());
});
const mapping = () => {
  const m = {};
  document.querySelectorAll('#map select[data-f]').forEach((s) => (m[s.dataset.f] = s.value ? [s.value] : []));
  document.querySelectorAll('#map .chips').forEach((c) => (m[c.dataset.f] = [...c.querySelectorAll('.chip')].map((x) => x.dataset.c)));
  return m;
};
$('map').addEventListener('click', run('s2', async (e) => {
  if (!e.target.closest('.chip button')) return;
  e.target.closest('.chip').remove(); await save(); await preview();
}));
$('map').addEventListener('change', run('s2', async (e) => {
  const chips = e.target.closest('.chips');
  if (chips) chips.insertAdjacentHTML('afterbegin', `<span class="chip" data-c="${esc(e.target.value)}"></span>`);
  await save(); await preview();
}));
const save = async () => fill(await api(`/api/datasets/${D.dataset_id}/metadata`, {
  metadata: metadata(), target_column: $('metaCol').value || null, mapping: mapping() }));

// --- step 3: preview table ---
async function preview() {
  const { converted } = await api(`/api/datasets/${D.dataset_id}/preview?n=4`);
  const keys = schema.fields.map((f) => f.name);
  const cell = (v) => (v == null ? '<td class="null">null</td>' : `<td title="${esc(typeof v === 'object' ? JSON.stringify(v) : v)}">${esc(Array.isArray(v) ? v.join(' · ') : typeof v === 'object' ? JSON.stringify(v) : v)}</td>`);
  $('preview').innerHTML = `<table><tr>${keys.map((k) => `<th>${esc(k)}</th>`).join('')}</tr>${converted.map((r) => `<tr>${keys.map((k) => cell(r[k])).join('')}</tr>`).join('')}</table>`;
}
$('prevBtn').onclick = run('s3', async () => { await save(); await preview(); });

// --- step 4: target + write ---
async function loadTargets(pick) {
  targets = (await api('/api/targets')).map((t) => t.name);
  $('target').innerHTML = targets.map((t) => `<option>${esc(t)}</option>`).join('') + `<option value="${NEW}">+ New file…</option>`;
  $('target').value = pick && targets.includes(pick) ? pick : targets[0] || NEW;
  setMode();
}
function setMode() {
  const isNew = $('target').value === NEW;
  $('newTarget').hidden = !isNew; if (isNew && !$('newTarget').value) $('newTarget').value = 'datasets.duckdb';
  $('mode').textContent = isNew ? 'create' : 'append'; $('mode').className = 'badge ' + (isNew ? 'create' : 'append');
}
$('target').onchange = setMode;
$('writeBtn').onclick = run('s4', async () => {
  await save();
  const isNew = $('target').value === NEW;
  const r = await api(`/api/datasets/${D.dataset_id}/convert`, {
    sample: +$('n').value, seed: +$('seed').value, target: isNew ? $('newTarget').value : $('target').value, mode: isNew ? 'create' : 'append', cleanup: $('cleanup').checked });
  $('result').innerHTML = `<div class="card"><h3>${r.mode === 'create' ? 'Created' : 'Appended to'} ${esc(r.target)}</h3><div class="stats">
    <div><span>Rows written</span><b>${r.rows_written.toLocaleString()}</b></div><div><span>Total in target</span><b>${r.total_rows_in_target.toLocaleString()}</b></div>
    <div><span>Schema</span><b>${esc(r.schema)}</b></div><div><span>Table</span><b>${esc(r.table)}</b></div><div><span>Seed</span><b>${r.seed}</b></div></div></div>`;
  toast(`${r.rows_written} rows → ${r.target}`);
  if (r.cleanup) { steps(false); $('info').textContent = `Downloads deleted (${(r.cleanup.bytes_freed / 1e6).toFixed(1)} MB). Download again to write more.`; }
  await loadTargets(r.target); $('mode').textContent = 'append'; // future writes append
});

loadSchemas().then(() => loadTargets()).catch((e) => alertIn('s1', e.message));
