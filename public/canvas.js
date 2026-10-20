// Sieve Canvas: a board of Source -> Mix -> Target nodes, laid out left to right. Plain JS; the board object is the
// JSON the API stores (data/boards/<name>.json). Settings live inside the nodes; Write is the only filled button.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'));
const api = async (u, body) => {
  const r = await fetch(u, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json(); if (!r.ok) throw new Error(j.error); return j;
};
const toast = (msg) => { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); };

// 1.5px stroke icons (no glyphs)
const P = {
  plus: 'M8 3v10M3 8h10', minus: 'M3 8h10', pencil: 'M3 13l1-3 6.5-6.5 2 2L6 12zM9.5 4.5l2 2', folder: 'M2 4.5h4l1.5 1.5H14v6.5H2z',
  save: 'M3 3h8l2 2v8H3zM5 3v3h5V3M5 13V9h6v4', reroll: 'M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5', fit: 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4',
  hf: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 0 0 0-11zM6 7h0M10 7h0M5.8 9.6c1.2 1.3 3.2 1.3 4.4 0', file: 'M4 2h5l3 3v9H4zM9 2v3h3',
  db: 'M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2zM3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2', mix: 'M3 4l4 4-4 4M8 4l4 4-4 4',
  down: 'M4 6l4 4 4-4', up: 'M4 10l4-4 4 4', more: 'M3.5 8h.01M8 8h.01M12.5 8h.01', check: 'M3 8.5l3 3 7-7', alert: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 0 0 0-11zM8 5v3.5M8 10.8h.01',
};
const icon = (k) => `<i data-icon="${k}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${k === 'more' ? 2.4 : 1.5}" stroke-linecap="round" stroke-linejoin="round"><path d="${P[k]}"/></svg></i>`;
const icons = (root) => root.querySelectorAll('i[data-icon]:empty').forEach((i) => { i.outerHTML = icon(i.dataset.icon); });

// Source tags: A-F in the order sources are added (colors cycle, letters keep counting)
const TAGS = ['#f2b45c', '#6fd0ff', '#a978e8', '#f78fc8', '#c9dc6a', '#d8c3a5'];
const color = (n) => TAGS[(n?.tag ?? 0) % TAGS.length];
const letter = (n) => { let t = n?.tag ?? 0, s = ''; do { s = String.fromCharCode(65 + (t % 26)) + s; t = Math.floor(t / 26) - 1; } while (t >= 0); return s; };
const tagChip = (n, sm) => { const c = color(n); return `<span class="tag${sm ? ' sm' : ''}" style="color:${c};background:color-mix(in srgb,${c} 18%,var(--card));border-color:color-mix(in srgb,${c} 55%,transparent)">${letter(n)}</span>`; };
const tint = (c, p) => `color-mix(in srgb,${c} ${p}%,var(--card))`;

// ---- state ----
const COLX = { source: 0, mix: 420, target: 920 };
let B = { name: '', seed: 42, nodes: [], edges: [] };
let view = { x: 80, y: 60, k: 1 }, sel = new Set(), selEdge = null, rev = 0, saved = true;
const info = {}, loading = {}, errs = {}, mixPv = {}, runs = {}, writing = {}, schemaFields = {};
let targets = [], schemas = [];
const node = (id) => B.nodes.find((n) => n.id === id);
const srcs = () => B.nodes.filter((n) => n.type === 'source');
const inputsOf = (m) => B.edges.filter((e) => e.to === m.id).map((e) => ({ e, s: node(e.from) })).filter((x) => x.s);
const mixOfTarget = (t) => node(B.edges.find((e) => e.to === t.id)?.from);
function split(n, ws) { // largest remainder, as on the server
  const tot = ws.reduce((a, w) => a + w, 0); if (!(tot > 0)) return ws.map(() => 0);
  const raw = ws.map((w) => (n * w) / tot), out = raw.map(Math.floor); let left = n - out.reduce((a, b) => a + b, 0);
  for (const i of raw.map((_, i) => i).sort((a, b) => (raw[b] - out[b]) - (raw[a] - out[a]) || a - b)) { if (!left) break; out[i]++; left--; }
  return out;
}
const shares = (m) => { const ins = inputsOf(m), ws = ins.map(({ e }) => Math.max(0, +(e.weight ?? 1) || 0)), t = ws.reduce((a, b) => a + b, 0); return ins.map((x, i) => ({ ...x, w: ws[i], share: t ? ws[i] / t : 0, n: split(+m.n || 500, ws)[i] })); };
// any upstream edit: unsaved, previews refresh, written targets go back to ready
function touch(mixes) { rev++; saved = false; status(); (mixes || B.nodes.filter((n) => n.type === 'mix')).forEach((m) => m && schedulePreview(m.id)); }

// ---- source descriptions ----
const isHF = (u) => /^[\w.-]+\/[\w.-]+$/.test(u || '') && !/\.(parquet|csv|tsv|json|jsonl|duckdb|db)$/i.test(u);
function srcKind(n) {
  const i = info[n.id], u = n.url || n.target || '', base = u.split('/').pop(), dir = u.includes('/') ? u.split('/').slice(-2, -1)[0] + '/' : '';
  if (n.target || /\.(duckdb|db)$/i.test(u)) return { ic: 'db', k: `DuckDB · ${base}`, t: n.table || i?.table || base };
  if (isHF(u) || i?.hf) return { ic: 'hf', k: `Hugging Face${i?.hf ? ` · ${i.hf.config} / ${i.hf.split}` : ''}`, t: i?.hf?.repo || u };
  const ext = (base.match(/\.(\w+)$/) || [, 'file'])[1].toLowerCase(), kind = { parquet: 'Parquet', csv: 'CSV', tsv: 'TSV', json: 'JSON', jsonl: 'JSONL' }[ext] || 'File';
  return { ic: 'file', k: `${kind}${dir ? ` · ${dir}` : ''}`, t: base || 'New source' };
}
const realCols = (i) => i.columns.filter((c) => c.name !== '_sieve_row');
function pickCol(n) {
  const i = info[n.id], cols = realCols(i);
  if (n.top_column && cols.some((c) => c.name === n.top_column)) return n.top_column;
  const lab = (i.mapping?.label || [])[0]?.split(/[.[]/)[0];
  if (lab && cols.some((c) => c.name === lab)) return lab;
  return (cols.filter((c) => c.distinct > 1 && c.top?.length).sort((a, b) => a.distinct - b.distinct)[0] || cols[0])?.name;
}
function topBar(n, col, thin) {
  const i = info[n.id], c = i.columns.find((x) => x.name === col), top = (c?.top || []).slice(0, 5), rows = i.row_count || 1, k = color(n), T = [100, 72, 50, 32, 22];
  const bar = `<div class="tv${thin ? ' thin' : ''}">${top.map((t, j) => `<span title="${esc(t.value)}: ${fmt(t.count)}" style="flex:${t.count / rows};background:${tint(k, T[j])}"></span>`).join('')}<span style="flex:${Math.max(0, 1 - top.reduce((a, t) => a + t.count, 0) / rows)}"></span></div>`;
  if (thin) return bar;
  return bar + `<div class="legend">${top.map((t, j) => `<span><i style="background:${tint(k, T[j])}"></i>${esc(String(t.value).slice(0, 18))} ${Math.round((100 * t.count) / rows)}%</span>`).join('')}</div>`;
}

// ---- node templates ----
const port = (dir, key, c, full, top, extra = '') => `<div class="port ${dir}${full ? ' full' : ''}" data-port="${key}" style="color:${c};border-color:${c};top:${top}px;${dir === 'out' ? 'right:-8px' : 'left:-8px'}${extra}"></div>`;
function sourceHTML(n) {
  const d = srcKind(n), i = info[n.id], c = color(n);
  let body;
  if (loading[n.id]) body = `<div class="nb"><div>Fetching rows…</div><div class="prog"><span style="width:38%"></span></div><div class="skel" style="width:80%"></div><div class="skel" style="width:55%"></div></div>`;
  else if (errs[n.id] && !n._edit) body = `<div class="nb"><div class="alert">${icon('alert')}<span>${esc(errs[n.id])}</span></div><div class="row" style="margin:0"><button class="btn ghost" data-act="load">Retry</button><button class="btn ghost" data-act="edit">Edit source</button></div></div>`;
  else if (!i || n._edit) body = `<div class="nb">
      <label>Source<input data-f="url" class="mono" value="${esc(n.url || n.target || '')}" placeholder="org/name · path · .parquet .csv .jsonl .duckdb"></label>
      <div class="two"><label>Table<input data-f="table" value="${esc(n.table || '')}" placeholder="DuckDB only"></label><label>Rows<input data-f="limit" value="${esc(n.limit ?? '')}" placeholder="10000 · all"></label></div>
      <label>Mapping <input data-f="mapping" class="mono" value="${esc(n.mapping ? JSON.stringify(n.mapping) : '')}" placeholder='optional {"input": ["col"], "label": ["col"]}'></label>
      <div class="row" style="margin:0"><button class="btn ghost" data-act="load">Load</button>${i ? '<button class="btn ghost" data-act="cancel">Cancel</button>' : ''}</div></div>`;
  else {
    const cols = realCols(i), col = pickCol(n);
    if (n.collapsed) body = `<div class="nb"><div class="foot">${cols.length} columns <span class="mono" style="color:${c};font-size:11px">${esc(col)}</span>${topBar(n, col, true)}<span class="grow"></span><button class="lnk" data-act="expand" title="Expand">${icon('down')}</button></div></div>`;
    else {
      const text = cols.find((x) => x.type === 'VARCHAR' && x.name !== col)?.name || cols[0].name;
      body = `<div class="nb">
        <div class="lbl">Columns<span class="grow"></span><span>${cols.length}</span></div>
        <div class="cols">${cols.slice(0, 6).map((x) => `<div>${esc(x.name)}<span>${esc(x.type.replace(/\(.*$/s, '').replace(/\[\]$/, '[]'))}</span></div>`).join('')}${cols.length > 6 ? `<div style="color:var(--mute)">+${cols.length - 6} more</div>` : ''}</div>
        <div class="lbl">Top values <select class="pick" data-f="top_column" style="color:${c}">${cols.map((x) => `<option ${x.name === col ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
        ${topBar(n, col)}
        <div class="lbl">Sample<span class="grow"></span><span>${Math.min(2, i.preview.length)} of ${fmt(i.row_count)}</span></div>
        <div class="mini">${i.preview.slice(0, 2).map((r) => `<div><span>${esc(typeof r[text] === 'object' ? JSON.stringify(r[text]) : r[text])}</span><span>${esc(typeof r[col] === 'object' ? JSON.stringify(r[col]) : r[col])}</span></div>`).join('')}</div>
        <div class="foot"><button class="lnk" data-act="collapse">Collapse ${icon('up')}</button><span class="grow"></span><button class="lnk" data-act="edit" title="Edit source">${icon('more')}</button></div></div>`;
    }
  }
  return `${port('out', `out:${n.id}`, c, !!i && !errs[n.id], 21)}
    <div class="nh">${tagChip(n)}<div class="t"><div class="k">${icon(d.ic)}${esc(d.k)}</div><b>${esc(d.t)}</b></div>${i ? `<span class="r">${fmt(i.row_count)} rows</span>` : ''}</div>${body}`;
}
function mixHTML(m) {
  const sh = shares(m), pv = mixPv[m.id], N = +m.n || 500, W = 380 - 32, fields = schemaFields[m.schema || 'default'] || [];
  const ps = (s) => pv?.sources?.find((x) => x.source === s.id);
  const seg = sh.map((x) => { const p = ps(x.s), short = p?.short_by; return `<span class="${short ? 'short' : ''}" style="flex:${x.share || 0.0001};background:${color(x.s)}" title="${letter(x.s)} ${Math.round(x.share * 100)}% · ${fmt(x.n)} rows${short ? ` · only ${fmt(p.pool_rows)} rows match` : ''}"></span>`; }).join('');
  const labels = sh.map((x) => { const p = ps(x.s), px = x.share * W, short = p?.short_by;
    return `<span style="flex:${x.share || 0.0001}" title="${letter(x.s)} ${Math.round(x.share * 100)}% · ${fmt(x.n)} rows${short ? ` · only ${fmt(p.pool_rows)} rows match` : ''}"><b style="color:${color(x.s)}">${letter(x.s)}</b>${px >= 36 ? ` <em>${Math.round(x.share * 100)}%</em>` : ''}${px >= 70 ? ` <small class="${short ? 'bad' : ''}">${fmt(short ? p.pool_rows : x.n)}</small>` : ''}</span>`; }).join('');
  const rows = sh.map((x) => { const p = ps(x.s), er = p?.error;
    return `<div class="inrow">${port('in', `in:${m.id}:${x.s.id}`, color(x.s), true, 9, ';left:-24px')}${tagChip(x.s, true)}<span class="nm">${esc(srcKind(x.s).t)}</span>
      <input class="sm wt" data-e="${esc(x.s.id)}" data-f="weight" value="${esc(x.e.weight ?? 1)}" title="relative weight">
      <input class="sm wh${er ? ' bad' : ''}" data-e="${esc(x.s.id)}" data-f="where" value="${esc(x.e.where || '')}" placeholder="where ...">
      ${er ? `<div class="ferr">${icon('alert')}${esc(er.split('\n')[0].slice(0, 120))}</div>` : ''}</div>`; }).join('');
  const prow = (pv?.rows || []).slice(0, 5).map((r) => { const s = node(r._source); return `<div style="border-left-color:${color(s)}"><span style="color:${color(s)};font-weight:700">${letter(s)}</span><span>${esc(r.input)}</span><span>${esc(Array.isArray(r.label) ? r.label.join(', ') : r.label ?? '')}</span></div>`; }).join('');
  return `${port('in', `in:${m.id}`, 'var(--mute)', sh.length > 0, 21)}${port('out', `out:${m.id}`, 'var(--mute)', sh.length > 0, 21)}
    <div class="nh"><span class="ico">${icon('mix')}</span><div class="t"><div class="k">Mix</div><b>${esc(m.label || m.id)}</b></div><span class="r">seed ${esc(m.seed ?? B.seed)}</span></div>
    <div class="nb">
      <div class="lbl">Proportion<span class="grow"></span><span>Rows</span><input class="sm mono" style="width:76px" data-f="n" value="${N}"></div>
      ${sh.length ? `<div class="bar12">${seg}</div><div class="blabels">${labels}</div>` : '<div class="hint" style="margin:0">Drag a source’s port onto this node.</div>'}
      <div class="lbl">Inputs<span class="grow"></span><span>weight</span></div>${rows}
      <div class="two"><label>Schema<select data-f="schema">${schemas.map((s) => `<option ${s === (m.schema || 'default') ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
        <label>Balance by<select data-f="balance"><option value="">none</option>${fields.map((f) => `<option ${f === m.balance ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label></div>
      <div class="lbl">Preview<span class="grow"></span><span>${pv?.pending ? 'sampling…' : pv?.rows ? `${Math.min(5, pv.rows.length)} of ${fmt(N)}` : ''}</span></div>
      ${pv?.error ? `<div class="alert">${icon('alert')}<span>${esc(pv.error)}</span></div>` : prow ? `<div class="pv"><div class="h"><span>src</span><span>input</span><span>label</span></div>${prow}</div>` : ''}
    </div>`;
}
function targetHTML(t) {
  const m = mixOfTarget(t), N = m ? +m.n || 500 : 0, run = runs[t.id], stale = run && run.rev !== rev, file = t.target || 'datasets.duckdb';
  const table = schemaFieldsTable[m?.schema || 'default'] || 'rows', mode = t.mode || (targets.includes(file) ? 'append' : 'create');
  const files = [...new Set([...targets, file])];
  let action;
  if (writing[t.id]) action = `<div>Writing ${fmt(N)} rows…</div><div class="prog">${m ? shares(m).map((x) => `<span style="flex:${x.share};background:${color(x.s)};opacity:.6"></span>`).join('') : ''}</div>`;
  else action = `<button class="btn wide${run && !stale ? ' ghost' : ''}" data-act="write" ${m ? '' : 'disabled'}>${run && !stale ? 'Write again' : `Write ${fmt(N)} rows`}</button>`;
  const res = run ? `<div class="res${stale ? ' stale' : ''}"><h4>${icon('check')}${run.created ? 'Created' : 'Appended'} ${fmt(run.r.rows_written)} rows</h4>
      ${stale ? '<div class="hint" style="margin:0">Board changed since last write</div>' : ''}
      <div class="st"><div>Total in target<b>${fmt(run.r.total_rows_in_target)}</b></div><div>Written<b>${run.at}</b></div></div>
      ${run.r.sources.map((s) => { const sn = node(s.source), short = s.rows_written < s.requested; return `<div class="srow">${tagChip(sn, true)}<span>${esc(sn ? srcKind(sn).t : s.source)}</span><b class="${short ? 'bad' : ''}" title="${short ? `only ${fmt(s.rows_written)} of ${fmt(s.requested)}` : ''}">${fmt(s.rows_written)}</b><span class="sb" style="background:${color(sn)};width:${Math.round((100 * s.rows_written) / Math.max(1, run.r.requested))}%"></span></div>`; }).join('')}</div>` : '';
  return `${port('in', `in:${t.id}`, 'var(--mute)', !!m, 21)}
    <div class="nh"><span class="ico">${icon('db')}</span><div class="t"><div class="k">Target · DuckDB</div><b>${esc(file)}</b></div></div>
    <div class="nb">
      <div class="f2">File<select data-f="target">${files.map((f) => `<option ${f === file ? 'selected' : ''}>${esc(f)}</option>`).join('')}<option value="__new__">New file…</option></select>
        Mode<div class="toggle"><button data-act="mode" data-v="create" class="${mode === 'create' ? 'on' : ''}">New file</button><button data-act="mode" data-v="append" class="${mode === 'append' ? 'on' : ''}">Append</button></div>
        Table<input value="${esc(table)}" readonly></div>
      ${errs[t.id] ? `<div class="alert">${icon('alert')}<span>${esc(errs[t.id])}</span></div>` : ''}
      ${action}${res}</div>`;
}
const schemaFieldsTable = {};

// ---- render ----
function render() {
  const world = $('world'), ae = document.activeElement, active = ae?.matches?.('input,textarea,select') ? ae.closest('.n')?.dataset.id : null;
  for (const el of [...world.querySelectorAll('.n')]) if (!node(el.dataset.id)) el.remove();
  for (const n of B.nodes) {
    let el = world.querySelector(`.n[data-id="${CSS.escape(n.id)}"]`);
    if (!el) { el = document.createElement('div'); el.dataset.id = n.id; world.appendChild(el); }
    const run = runs[n.id];
    el.className = `n ${n.type}${sel.has(n.id) ? ' sel' : ''}${errs[n.id] ? ' err' : ''}${run && run.rev === rev ? ' done' : ''}`;
    el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
    if (n.id !== active) el.innerHTML = n.type === 'source' ? sourceHTML(n) : n.type === 'mix' ? mixHTML(n) : targetHTML(n);
  }
  icons(world); wires(); applyView(); emptyState();
  const has = srcs().length > 0; ['addMix', 'addTarget', 'saveB'].forEach((b) => { $(b).disabled = !has; });
}
const applyView = () => { $('world').style.transform = `translate(${view.x}px,${view.y}px) scale(${view.k})`; $('zPct').textContent = `${Math.round(view.k * 100)}%`; };
const toWorld = (cx, cy) => { const r = $('stage').getBoundingClientRect(); return [(cx - r.left - view.x) / view.k, (cy - r.top - view.y) / view.k]; };
function portXY(key) { const el = document.querySelector(`[data-port="${CSS.escape(key)}"]`); if (!el) return null; const r = el.getBoundingClientRect(); return toWorld(r.left + r.width / 2, r.top + r.height / 2); }
function wires(draft) {
  const svg = $('wires'); let h = '';
  B.edges.forEach((e, idx) => {
    const a = node(e.from), z = node(e.to); if (!a || !z) return;
    if (a.type === 'source') {
      const p1 = portXY(`out:${a.id}`), p2 = portXY(`in:${z.id}:${a.id}`); if (!p1 || !p2) return;
      const sh = shares(z).find((x) => x.s.id === a.id)?.share ?? 0, dx = (p2[0] - p1[0]) * 0.55, c = color(a);
      const errd = errs[a.id] || !info[a.id];
      h += `<path class="w${selEdge === idx ? ' sel' : ''}" data-edge="${idx}" d="M${p1} C${p1[0] + dx},${p1[1]} ${p2[0] - dx},${p2[1]} ${p2}" stroke="${c}" stroke-width="${1.5 + 5 * sh}" ${errd ? 'stroke-dasharray="5 5"' : ''}/>`;
      const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2, label = `${Math.round(sh * 100)}%`;
      h += `<g class="pill"><rect x="${mx - 19}" y="${my - 10}" width="38" height="20" rx="10"/><text x="${mx}" y="${my}" fill="${c}">${label}</text></g>`;
    } else {
      const p1 = portXY(`out:${a.id}`), p2 = portXY(`in:${z.id}`); if (!p1 || !p2) return;
      const done = runs[z.id] && runs[z.id].rev === rev, label = `${fmt(+a.n || 500)} rows`, w = label.length * 6.4 + 16, mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
      h += `<path class="w out${selEdge === idx ? ' sel' : ''}" data-edge="${idx}" d="M${p1} L${p2}" ${done ? '' : 'stroke-dasharray="5 5"'}/>`;
      h += `<g class="pill"><rect x="${mx - w / 2}" y="${my - 10}" width="${w}" height="20" rx="10"/><text x="${mx}" y="${my}" fill="var(--fg)">${label}</text></g>`;
    }
  });
  if (draft) h += `<path class="w" d="${draft.d}" stroke="${draft.c}" stroke-width="2" stroke-dasharray="5 5"/>`;
  svg.innerHTML = h;
}
function emptyState() {
  const e = $('empty'); e.hidden = B.nodes.length > 0; if (!e.hidden && !e.innerHTML) {
    e.innerHTML = `<div style="position:relative;width:640px;height:270px">${[0, 1, 2].map((i) => `<div class="sk" style="left:-180px;top:${i * 96 - 20}px;width:140px;height:76px">Source</div>`).join('')}
      <div class="sk" style="left:690px;top:76px;width:140px;height:76px">Target</div>
      <div class="card0" style="position:absolute;left:120px;top:15px"><div class="tile"><svg viewBox="0 0 32 32" width="26" height="26"><g fill="var(--acc)"><circle cx="10" cy="11" r="2"/><circle cx="16" cy="11" r="2"/><circle cx="22" cy="11" r="2"/><circle cx="13" cy="17" r="2"/><circle cx="19" cy="17" r="2"/><circle cx="16" cy="23" r="2"/></g></svg></div>
      <h3>Start with a source</h3><p>Hugging Face, Parquet, CSV, JSON or DuckDB</p>
      <div class="row"><button id="e_add">${icon('plus')} Add source</button><button class="ghost" id="e_open">${icon('folder')} Open board</button></div>
      <p class="hint" style="margin-top:6px">or double-click anywhere on the canvas</p></div></div>`;
    $('e_add').onclick = () => addNode('source'); $('e_open').onclick = (ev) => { ev.stopPropagation(); openMenu(); };
  }
}
const status = () => { $('saved').textContent = saved ? 'Saved' : 'Not saved'; };

// ---- layout ----
const heightOf = (n) => document.querySelector(`.n[data-id="${CSS.escape(n.id)}"]`)?.offsetHeight || (n.collapsed ? 100 : 160);
function place(n) {
  if (n.type === 'source') { const s = srcs().filter((x) => x !== n && x.x != null); n.x = COLX.source; n.y = s.length ? Math.max(...s.map((x) => x.y + heightOf(x))) + 28 : 0; }
  else { const others = B.nodes.filter((x) => x.type === n.type && x !== n && x.x != null); n.x = COLX[n.type]; n.y = others.length ? Math.max(...others.map((x) => x.y + heightOf(x))) + 40 : 40; }
}
function autoLayout() { // boards built elsewhere (MCP) get the same columns
  let tag = Math.max(-1, ...srcs().map((s) => s.tag ?? -1));
  srcs().forEach((s, i) => { if (s.tag == null) s.tag = ++tag; if (s.collapsed == null) s.collapsed = i > 0; });
  for (const n of B.nodes) if (n.x == null || n.y == null) { n._auto = true; place(n); }
}
function relayout() { // re-stack auto-placed nodes once loaded cards change height
  const auto = B.nodes.filter((n) => n._auto); if (!auto.length) return;
  for (const n of auto) n.x = n.y = null;
  for (const n of auto) place(n);
  render();
}
function fit() {
  if (!B.nodes.length) { view = { x: 80, y: 60, k: 1 }; return applyView(); }
  const st = $('stage').getBoundingClientRect();
  const xs = B.nodes.flatMap((n) => [n.x, n.x + (n.type === 'mix' ? 380 : 300)]), ys = B.nodes.flatMap((n) => [n.y, n.y + heightOf(n)]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const k = Math.min(1, Math.max(0.25, Math.min((st.width - 120) / (x1 - x0), (st.height - 110) / (y1 - y0))));
  view = { k, x: (st.width - (x1 - x0) * k) / 2 - x0 * k, y: Math.max(40, (st.height - (y1 - y0) * k) / 2) - y0 * k }; applyView(); wires();
}

// ---- server calls ----
const schemaOf = (s) => node(B.edges.find((e) => e.from === s.id)?.to)?.schema || 'default';
async function loadSource(n) {
  if (!n.url && !n.target) { errs[n.id] = 'Enter a Hugging Face name, a file path or a .duckdb file'; return render(); }
  loading[n.id] = true; delete errs[n.id]; delete n._edit; render();
  try { info[n.id] = await api('/api/boards/source', { node: clean(n), schema: schemaOf(n), seed: B.seed }); }
  catch (e) { errs[n.id] = e.message; delete info[n.id]; }
  finally { delete loading[n.id]; render(); relayout(); B.edges.filter((e) => e.from === n.id).forEach((e) => schedulePreview(e.to)); }
}
const timers = {};
function schedulePreview(id) { clearTimeout(timers[id]); timers[id] = setTimeout(() => previewMix(id), 500); }
async function previewMix(id) {
  const m = node(id); if (!m || !inputsOf(m).some(({ s }) => info[s.id])) return;
  const my = (mixPv[id] = { ...mixPv[id], pending: true }); render();
  try { const r = await api('/api/boards/preview', { board: board(), mix: id, n: 5 }); if (mixPv[id] === my) mixPv[id] = r; }
  catch (e) { if (mixPv[id] === my) mixPv[id] = { error: e.message }; }
  render();
}
async function write(t) {
  delete errs[t.id]; writing[t.id] = true; render();
  const file = t.target || 'datasets.duckdb', mode = t.mode || (targets.includes(file) ? 'append' : 'create');
  try {
    const r = await api('/api/boards/run', { board: board({ [t.id]: { mode } }), target: t.id });
    const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    runs[t.id] = { r: r.runs[0], rev, at, created: mode === 'create' };
    targets = (await api('/api/targets')).map((x) => x.name); t.mode = 'append'; // the file exists now
  } catch (e) { errs[t.id] = e.message; } finally { delete writing[t.id]; render(); }
}
const clean = (n) => Object.fromEntries(Object.entries(n).filter(([k]) => !k.startsWith('_')));
const board = (patch = {}) => ({ ...B, nodes: B.nodes.map((n) => ({ ...clean(n), ...patch[n.id] })) });
async function save() {
  B.name = $('bname').value.trim() || 'untitled-board'; $('bname').value = B.name;
  await api('/api/boards', board()); saved = true; status(); history.replaceState(null, '', '?board=' + encodeURIComponent(B.name)); toast('Board saved');
}
async function openBoard(name) {
  const b = await api('/api/boards/' + encodeURIComponent(name));
  B = { ...b, nodes: b.nodes || [], edges: b.edges || [] }; sel.clear(); selEdge = null;
  for (const o of [info, loading, errs, mixPv, runs, writing]) for (const k in o) delete o[k];
  $('bname').value = B.name; $('seed').value = B.seed ?? 42; saved = true; status();
  await Promise.all(B.nodes.filter((n) => n.type === 'mix').map((m) => fields(m.schema || 'default')));
  render(); autoLayout(); render(); fit();
  history.replaceState(null, '', '?board=' + encodeURIComponent(name));
  await Promise.all(srcs().map(loadSource)); fit();
}
async function fields(s) { if (schemaFields[s]) return; const j = await api('/api/schemas/' + encodeURIComponent(s)); schemaFields[s] = j.fields.map((f) => f.name); schemaFieldsTable[s] = j.table; }
async function openMenu() {
  const menu = $('openMenu'), l = await api('/api/boards');
  menu.innerHTML = l.length ? l.map((b) => `<button data-b="${esc(b.name)}">${esc(b.name)}</button>`).join('') : '<p class="hint">No saved boards yet</p>';
  menu.hidden = false;
  menu.querySelectorAll('button').forEach((b) => { b.onclick = () => { menu.hidden = true; openBoard(b.dataset.b).catch((e) => toast(e.message)); }; });
}

// ---- editing inside nodes ----
function addNode(type, at) {
  let i = 1; while (node(`${type}${i}`)) i++;
  const n = { id: `${type}${i}`, type };
  if (type === 'source') { n.tag = Math.max(-1, ...srcs().map((s) => s.tag ?? -1)) + 1; n.collapsed = srcs().length > 0; n.limit = 10000; }
  if (type === 'mix') Object.assign(n, { schema: 'default', n: 500 });
  if (type === 'target') n.target = 'datasets.duckdb';
  B.nodes.push(n);
  if (at) [n.x, n.y] = at; else place(n);
  if (type === 'mix') { fields('default').then(render); srcs().filter((s) => !B.edges.some((e) => e.from === s.id)).forEach((s) => B.edges.push({ from: s.id, to: n.id, weight: 1 })); }
  if (type === 'target') { const m = B.nodes.filter((x) => x.type === 'mix').find((x) => !B.edges.some((e) => e.from === x.id)); if (m) B.edges.push({ from: m.id, to: n.id }); }
  sel = new Set([n.id]); touch(); render();
  if (!at && view.k) { const r = $('stage').getBoundingClientRect(); const [wx, wy] = toWorld(r.left + r.width / 2, r.top + r.height / 2); if (Math.abs(wx - n.x) > r.width / view.k / 2 || Math.abs(wy - n.y) > r.height / view.k / 2) fit(); }
  return n;
}
function connect(from, to) {
  const a = node(from), z = node(to);
  if (!(a.type === 'source' && z.type === 'mix') && !(a.type === 'mix' && z.type === 'target')) return toast('Connect Source → Mix or Mix → Target');
  if (z.type === 'target') B.edges = B.edges.filter((e) => e.to !== z.id); // one mix per target
  if (!B.edges.some((e) => e.from === from && e.to === to)) B.edges.push(a.type === 'source' ? { from, to, weight: 1 } : { from, to });
  touch([z.type === 'mix' ? z : null]); render();
}
function removeSelected() {
  if (selEdge != null) B.edges.splice(selEdge, 1);
  else { B.nodes = B.nodes.filter((n) => !sel.has(n.id)); B.edges = B.edges.filter((e) => !sel.has(e.from) && !sel.has(e.to)); }
  sel.clear(); selEdge = null; touch(); render();
}
function setField(el, commit) {
  const n = node(el.closest('.n').dataset.id), f = el.dataset.f; let v = el.value;
  const obj = el.dataset.e ? B.edges.find((e) => e.from === el.dataset.e && e.to === n.id) : n;
  if (f === 'target' && v === '__new__') { const name = prompt('New file name', 'new-file.duckdb'); if (!name) return render(); v = name.endsWith('.duckdb') ? name : name + '.duckdb'; obj.mode = 'create'; }
  else if (f === 'target') obj.mode = targets.includes(v) ? 'append' : 'create';
  if (f === 'mapping') { if (!v.trim()) delete obj.mapping; else try { obj.mapping = JSON.parse(v); el.classList.remove('bad'); } catch { el.classList.add('bad'); return; } }
  else if (f === 'url') { delete obj.url; delete obj.target; if (/^[\w.-]+\.duckdb$/.test(v.trim()) && targets.includes(v.trim())) obj.target = v.trim(); else if (v.trim()) obj.url = v.trim(); }
  else if (['n', 'weight'].includes(f)) obj[f] = v === '' ? (f === 'n' ? 500 : 0) : Math.max(0, +v || 0);
  else if (f === 'limit') obj.limit = /^\d+$/.test(v) ? +v : v.trim() || undefined;
  else if (v === '') delete obj[f]; else obj[f] = v;
  if (f === 'top_column') { saved = false; status(); return render(); }
  if (n.type === 'source' && ['url', 'table', 'limit', 'mapping'].includes(f)) delete info[n.id];
  const mixes = n.type === 'mix' ? [n] : n.type === 'source' ? B.edges.filter((e) => e.from === n.id).map((e) => node(e.to)) : [];
  touch(mixes);
  if (f === 'schema') fields(v).then(render);
  if (commit) render(); else { const hold = document.activeElement; render(); hold?.focus?.(); wires(); }
}
const W_ = $('world');
W_.addEventListener('input', (ev) => { if (ev.target.dataset.f && ev.target.tagName === 'INPUT') setField(ev.target, false); });
W_.addEventListener('change', (ev) => { if (ev.target.dataset.f) { if (ev.target.tagName === 'INPUT') ev.target.blur(); setField(ev.target, true); } });
W_.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') { const n = node(ev.target.closest('.n')?.dataset.id); ev.target.blur(); if (!n) return; render(); if (n.type === 'source' && !info[n.id]) loadSource(n); } });
W_.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-act]'); if (!b) return;
  const n = node(b.closest('.n').dataset.id), a = b.dataset.act;
  if (a === 'load') loadSource(n);
  else if (a === 'edit') { n._edit = true; delete errs[n.id]; render(); }
  else if (a === 'cancel') { delete n._edit; render(); }
  else if (a === 'collapse' || a === 'expand') { n.collapsed = a === 'collapse'; saved = false; status(); render(); relayout(); }
  else if (a === 'mode') { n.mode = b.dataset.v; saved = false; status(); render(); }
  else if (a === 'write') write(n);
});

// ---- canvas interaction: pan, zoom, drag nodes, connect ports ----
let drag = null, space = false;
$('stage').addEventListener('mousedown', (ev) => {
  $('openMenu').hidden = true; if (!ev.target.closest('#dropMenu')) $('dropMenu').hidden = true;
  if (ev.target.closest('#empty .card0, .zoom, #dropMenu')) return;
  const p = ev.target.closest('.port.out'), nd = ev.target.closest('.n'), edge = ev.target.closest('[data-edge]');
  if (ev.button === 1 || space || (!nd && !edge && ev.button === 0)) {
    if (!nd && !edge && !space && ev.button === 0) { sel.clear(); selEdge = null; render(); }
    drag = { pan: true, sx: ev.clientX - view.x, sy: ev.clientY - view.y }; $('stage').classList.add('panning'); ev.preventDefault(); return;
  }
  if (edge) { selEdge = +edge.dataset.edge; sel.clear(); render(); return; }
  if (p) { drag = { wire: nd.dataset.id }; ev.preventDefault(); return; }
  const id = nd.dataset.id; selEdge = null;
  if (ev.shiftKey) { sel.has(id) ? sel.delete(id) : sel.add(id); } else if (!sel.has(id)) sel = new Set([id]);
  document.querySelectorAll('.n').forEach((el) => el.classList.toggle('sel', sel.has(el.dataset.id)));
  if (ev.target.closest('.nh')) { const [wx, wy] = toWorld(ev.clientX, ev.clientY); drag = { move: [...sel].map((s) => ({ n: node(s), dx: wx - node(s).x, dy: wy - node(s).y })), moved: false }; }
});
window.addEventListener('mousemove', (ev) => {
  if (!drag) return;
  if (drag.pan) { view.x = ev.clientX - drag.sx; view.y = ev.clientY - drag.sy; applyView(); return; }
  const [wx, wy] = toWorld(ev.clientX, ev.clientY);
  if (drag.move) {
    drag.moved = true;
    for (const m of drag.move) { delete m.n._auto; m.n.x = Math.round(wx - m.dx); m.n.y = Math.round(wy - m.dy); const el = document.querySelector(`.n[data-id="${CSS.escape(m.n.id)}"]`); el.style.left = m.n.x + 'px'; el.style.top = m.n.y + 'px'; }
    wires(); return;
  }
  const a = node(drag.wire), p1 = portXY(`out:${a.id}`), dx = (wx - p1[0]) * 0.55, c = a.type === 'source' ? color(a) : 'var(--mute)';
  wires({ d: `M${p1} C${p1[0] + dx},${p1[1]} ${wx - dx},${wy} ${wx},${wy}`, c });
  const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.n'), ok = over && ((a.type === 'source' && over.classList.contains('mix')) || (a.type === 'mix' && over.classList.contains('target')));
  document.querySelectorAll('.port.hot').forEach((x) => x.classList.remove('hot')); document.querySelectorAll('.plabel').forEach((x) => x.remove());
  if (ok) { const pt = over.querySelector(`[data-port="in:${over.dataset.id}"]`); pt.classList.add('hot'); pt.insertAdjacentHTML('afterend', `<span class="plabel" style="left:-84px;top:18px">${a.type === 'source' ? 'Mix input' : 'Target input'}</span>`); }
});
window.addEventListener('mouseup', (ev) => {
  if (drag?.wire) {
    document.querySelectorAll('.port.hot').forEach((x) => x.classList.remove('hot')); document.querySelectorAll('.plabel').forEach((x) => x.remove());
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.n');
    if (over && over.dataset.id !== drag.wire) connect(drag.wire, over.dataset.id);
    else if (!over && ev.target.closest('#stage')) dropMenu(drag.wire, ev); else wires();
  }
  if (drag?.move && drag.moved) { saved = false; status(); }
  drag = null; $('stage').classList.remove('panning');
});
function dropMenu(from, ev) { // dropped a wire on empty canvas: add the next node there
  const a = node(from), types = a.type === 'source' ? ['mix', 'target'] : ['target'], m = $('dropMenu'), r = $('stage').getBoundingClientRect(), at = toWorld(ev.clientX, ev.clientY);
  m.style.left = ev.clientX - r.left + 'px'; m.style.top = ev.clientY - r.top + 'px';
  m.innerHTML = types.map((t) => `<button data-t="${t}">Add ${t[0].toUpperCase() + t.slice(1)} here</button>`).join(''); m.hidden = false;
  m.querySelectorAll('button').forEach((b) => { b.onclick = () => { m.hidden = true; const n = addNode(b.dataset.t, [Math.round(at[0]), Math.round(at[1] - 20)]); if (b.dataset.t === 'mix' || a.type === 'mix') connect(from, n.id); render(); }; });
  wires();
}
$('stage').addEventListener('dblclick', (ev) => { if (!ev.target.closest('.n,.zoom,#empty .card0')) { const at = toWorld(ev.clientX, ev.clientY); addNode('source', [Math.round(at[0]), Math.round(at[1])]); } });
const zoomAt = (k, cx, cy) => { k = Math.min(2, Math.max(0.25, k)); view.x = cx - ((cx - view.x) * k) / view.k; view.y = cy - ((cy - view.y) * k) / view.k; view.k = k; applyView(); };
$('stage').addEventListener('wheel', (ev) => { ev.preventDefault(); const r = $('stage').getBoundingClientRect(); zoomAt(view.k * Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top); }, { passive: false });
const zc = (f) => () => { const r = $('stage').getBoundingClientRect(); zoomAt(view.k * f, r.width / 2, r.height / 2); };
$('zIn').onclick = zc(1.2); $('zOut').onclick = zc(1 / 1.2); $('zFit').onclick = fit;
window.addEventListener('keydown', (ev) => {
  const typing = ev.target.closest?.('input,textarea,select');
  if (ev.code === 'Space' && !typing) { space = true; ev.preventDefault(); }
  if (['Delete', 'Backspace'].includes(ev.key) && !typing && (sel.size || selEdge != null)) removeSelected();
});
window.addEventListener('keyup', (ev) => { if (ev.code === 'Space') space = false; });

// ---- top bar ----
$('addSource').onclick = () => addNode('source'); $('addMix').onclick = () => addNode('mix'); $('addTarget').onclick = () => addNode('target');
$('bname').oninput = () => { B.name = $('bname').value.trim(); saved = false; status(); };
$('seed').onchange = () => { B.seed = +$('seed').value || 0; touch(); render(); };
$('reroll').onclick = () => { $('seed').value = Math.floor(Math.random() * 100000); $('seed').onchange(); };
$('saveB').onclick = () => save().catch((e) => toast(e.message));
$('openB').onclick = (ev) => { ev.stopPropagation(); $('openMenu').hidden ? openMenu() : ($('openMenu').hidden = true); };
document.addEventListener('mousedown', (ev) => { if (!ev.target.closest('.menuwrap')) $('openMenu').hidden = true; });
icons(document.body);
(async () => {
  schemas = (await api('/api/schemas')).map((s) => s.name); targets = (await api('/api/targets')).map((t) => t.name);
  await fields('default');
  const q = new URLSearchParams(location.search).get('board');
  saved = false; status(); render();
  if (q) await openBoard(q).catch((e) => toast(e.message));
})();
