const $ = (id) => document.getElementById(id);
let D = null;
const api = async (u, body) => {
  const r = await fetch(u, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
};
const show = (x) => { $('out').className = ''; $('out').textContent = typeof x === 'string' ? x : JSON.stringify(x, null, 2); };
const run = (f) => async () => { try { await f(); } catch (e) { show('Error: ' + e.message); $('out').className = 'err'; } };
const steps = (on) => ['s2', 's3', 's4'].forEach((s) => $(s).classList.toggle('off', !on));

async function loadLists() {
  const [sc, tg] = await Promise.all([api('/api/schemas'), api('/api/targets')]);
  const cur = $('schema').value;
  $('schema').innerHTML = sc.map((s) => `<option title="${s.description}">${s.name}</option>`).join('');
  if (cur) $('schema').value = cur;
  $('targets').innerHTML = tg.map((t) => `<option value="${t.name}">`).join('');
  if (!$('target').value) $('target').value = tg[0]?.name || 'datasets.duckdb';
  setMode();
}
function setMode() { $('mode').value = [...$('targets').options].some((o) => o.value === $('target').value) ? 'append' : 'create'; }
$('target').addEventListener('input', setMode);

window.toggleEditor = run(async () => {
  const ed = $('editor'); ed.hidden = !ed.hidden;
  if (!ed.hidden) $('schemaJson').value = JSON.stringify(await api('/api/schemas/' + $('schema').value), null, 2);
});
$('schema').addEventListener('change', run(async () => {
  if (!$('editor').hidden) $('schemaJson').value = JSON.stringify(await api('/api/schemas/' + $('schema').value), null, 2);
  if (D) { fill(await api(`/api/datasets/${D.dataset_id}/metadata`, { schema: $('schema').value })); await prev(); }
}));
window.saveSchema = run(async () => { const s = await api('/api/schemas', JSON.parse($('schemaJson').value)); await loadLists(); $('schema').value = s.name; show(`Saved schema "${s.name}"`); });

function fill(d) {
  D = d; steps(true);
  $('info').textContent = `${d.row_count.toLocaleString()} rows · ${d.format}${d.hf ? ` · ${d.hf.config}/${d.hf.split}` : ''} · ${d.columns.length} columns`;
  const cols = d.columns.map((c) => c.name);
  $('map').innerHTML = Object.entries(d.mapping).map(([f, sel]) => `<label>${f}<select data-f="${f}" ${f === 'input' ? 'multiple size="3"' : ''}>
    <option value="">—</option>${cols.map((c) => `<option ${sel.includes(c) ? 'selected' : ''}>${c}</option>`).join('')}</select></label>`).join('');
  for (const k of ['name', 'domain', 'source', 'notes']) $(k).value = d.metadata[k];
}
const mapping = () => Object.fromEntries([...document.querySelectorAll('#map select')].map((s) => [s.dataset.f, [...s.selectedOptions].map((o) => o.value).filter(Boolean)]));
const save = async () => fill(await api(`/api/datasets/${D.dataset_id}/metadata`, {
  name: $('name').value, domain: $('domain').value, source: $('source').value, notes: $('notes').value, mapping: mapping() }));

window.imp = run(async () => {
  show('Downloading…'); const b = { url: $('url').value, schema: $('schema').value };
  if ($('config').value) b.config = $('config').value; if ($('split').value) b.split = $('split').value;
  fill(await api('/api/import', b)); await prev();
});
window.prev = run(async () => { await save(); const p = await api(`/api/datasets/${D.dataset_id}/preview?n=3`); show(p.converted); });
window.write_ = run(async () => {
  await save(); show('Writing…');
  show(await api(`/api/datasets/${D.dataset_id}/convert`, { sample: +$('n').value, seed: +$('seed').value, target: $('target').value, mode: $('mode').value }));
  await loadLists();
});
loadLists();
