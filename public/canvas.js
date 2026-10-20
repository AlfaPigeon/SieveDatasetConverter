// Sieve Canvas: a board of Source -> Mix -> Target nodes, laid out left to right. Plain JS; the board object is the
// JSON the API stores (data/boards/<name>.json). Settings live inside the nodes; mapping and metadata per source ->
// Mix edge are edited in the right-hand drawer (the wizard's controls, from sieve-ui.js). Write is the only filled button.
const $ = (id) => document.getElementById(id);
const esc = SieveUI.esc;
const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'));
const mb = (b) => (b / 2 ** 20).toFixed(b < 10 * 2 ** 20 ? 1 : 0);
// job: an id sent as x-sieve-job, so the server reports progress (GET /api/jobs/:id) and can cancel it
const api = async (u, body, job) => {
  const h = { ...(body && { 'content-type': 'application/json' }), ...(job && { 'x-sieve-job': job }) };
  const r = await fetch(u, body ? { method: 'POST', headers: h, body: JSON.stringify(body) } : { headers: h });
  const j = await r.json(); if (!r.ok) throw Object.assign(new Error(j.error), { kind: j.kind }); return j;
};
const jobId = () => Math.random().toString(36).slice(2, 10);
function track(job, onStatus) { // poll a job until stop()
  let on = true;
  (async () => { while (on) { await new Promise((r) => setTimeout(r, 350)); if (!on) break; try { onStatus(await api('/api/jobs/' + job)); } catch {} } })();
  return () => { on = false; };
}
const cancelJob = (job) => api(`/api/jobs/${job}/cancel`, {}).catch(() => {});
function toast(msg, action, bad) {
  const t = $('toast'); t.innerHTML = `${bad ? icon('alert') : ''}<span>${esc(msg)}</span>${action ? `<button class="lnk acc">${esc(action.label)}</button>` : ''}`;
  t.classList.toggle('bad', !!bad); icons(t);
  if (action) t.querySelector('button').onclick = () => { action.run(); t.classList.remove('show'); };
  t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), action ? 7000 : 2600);
}

// 1.5px stroke icons (no glyphs)
const P = {
  plus: 'M8 3v10M3 8h10', minus: 'M3 8h10', pencil: 'M3 13l1-3 6.5-6.5 2 2L6 12zM9.5 4.5l2 2', folder: 'M2 4.5h4l1.5 1.5H14v6.5H2z',
  save: 'M3 3h8l2 2v8H3zM5 3v3h5V3M5 13V9h6v4', reroll: 'M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5', fit: 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4',
  hf: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 0 0 0-11zM6 7h0M10 7h0M5.8 9.6c1.2 1.3 3.2 1.3 4.4 0', file: 'M4 2h5l3 3v9H4zM9 2v3h3',
  db: 'M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2zM3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2', mix: 'M3 4l4 4-4 4M8 4l4 4-4 4',
  down: 'M4 6l4 4 4-4', up: 'M4 10l4-4 4 4', more: 'M3.5 8h.01M8 8h.01M12.5 8h.01', check: 'M3 8.5l3 3 7-7', alert: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 0 0 0-11zM8 5v3.5M8 10.8h.01',
  x: 'M4 4l8 8M12 4l-8 8', back: 'M13 8H3M7 4L3 8l4 4', sliders: 'M2 5h7M12 5h2M2 11h2M7 11h7M9 3.5v3M4 9.5v3', search: 'M7 3a4 4 0 1 0 0 8a4 4 0 0 0 0-8zM10 10l3.5 3.5',
  swap: 'M3 5h9l-2.5-2.5M13 11H4l2.5 2.5', trash: 'M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 9h5.6l.7-9', copy: 'M5 5h8v8H5zM3 11V3h8', upload: 'M8 11V3M4.5 6.5L8 3l3.5 3.5M3 13h10',
  edit: 'M3 13l1-3 6.5-6.5 2 2L6 12z',
};
const icon = (k) => `<i data-icon="${k}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${k === 'more' ? 2.4 : 1.5}" stroke-linecap="round" stroke-linejoin="round"><path d="${P[k]}"/></svg></i>`;
const icons = (root) => root.querySelectorAll('i[data-icon]:empty').forEach((i) => { i.outerHTML = icon(i.dataset.icon); });

// Source tags: letters keep counting (A..Z, AA..), colors cycle A-F; the round (every 6) changes chip and wire style:
// 1st filled chip + solid wire, 2nd outlined chip + dashed wire, 3rd+ dotted chip + dotted wire.
const TAGS = ['#f2b45c', '#6fd0ff', '#a978e8', '#f78fc8', '#c9dc6a', '#d8c3a5'];
const color = (n) => TAGS[(n?.tag ?? 0) % TAGS.length];
const roundOf = (n) => Math.min(2, Math.floor((n?.tag ?? 0) / TAGS.length));
const letter = (n) => { let t = n?.tag ?? 0, s = ''; do { s = String.fromCharCode(65 + (t % 26)) + s; t = Math.floor(t / 26) - 1; } while (t >= 0); return s; };
const wireDash = (n) => ['', '6 4', '2 3'][roundOf(n)];
const tagChip = (n, sm) => {
  const c = color(n), r = roundOf(n), L = letter(n);
  const st = r === 0 ? `color:${c};background:color-mix(in srgb,${c} 18%,var(--card));border-color:color-mix(in srgb,${c} 55%,transparent)` : `color:${c};background:var(--card);border:1.5px ${r === 1 ? 'solid' : 'dotted'} ${c}`;
  return `<span class="tag${sm ? ' sm' : ''}${L.length > 1 ? ' wide' : ''}" style="${st}">${L}</span>`;
};
const tint = (c, p) => `color-mix(in srgb,${c} ${p}%,var(--card))`;

// ---- state ----
const COLX = { source: 0, mix: 420, target: 920 };
const NAME_RE = /^[\w][\w.-]{0,63}$/;
let B = { name: '', seed: 42, nodes: [], edges: [] };
let view = { x: 80, y: 60, k: 1 }, sel = new Set(), selEdge = null, rev = 0, saved = true;
// info: card data per source; loading: {job, st, pct}; errs: {msg, kind}; edgeI: drawer data per "mix:source"
const wnote = {}, info = {}, loading = {}, errs = {}, cancelledLoad = {}, mixPv = {}, runs = {}, writing = {}, schemaDefs = {}, edgeI = {};
let targets = [], schemas = [], drawer = null, menuFor = null;
const node = (id) => B.nodes.find((n) => n.id === id);
const srcs = () => B.nodes.filter((n) => n.type === 'source');
const mixes = () => B.nodes.filter((n) => n.type === 'mix');
const inputsOf = (m) => B.edges.filter((e) => e.to === m.id).map((e) => ({ e, s: node(e.from) })).filter((x) => x.s);
const edgeOf = (mixId, srcId) => B.edges.find((e) => e.from === srcId && e.to === mixId);
const mixOfTarget = (t) => node(B.edges.find((e) => e.to === t.id)?.from);
const schemaOfMix = (m) => schemaDefs[m?.schema || 'default'];
function split(n, ws) { // largest remainder, as on the server
  const tot = ws.reduce((a, w) => a + w, 0); if (!(tot > 0)) return ws.map(() => 0);
  const raw = ws.map((w) => (n * w) / tot), out = raw.map(Math.floor); let left = n - out.reduce((a, b) => a + b, 0);
  for (const i of raw.map((_, i) => i).sort((a, b) => (raw[b] - out[b]) - (raw[a] - out[a]) || a - b)) { if (!left) break; out[i]++; left--; }
  return out;
}
const shares = (m) => { const ins = inputsOf(m), ws = ins.map(({ e }) => Math.max(0, +(e.weight ?? 1) || 0)), t = ws.reduce((a, b) => a + b, 0), ns = split(+m.n || 500, ws); return ins.map((x, i) => ({ ...x, w: ws[i], share: t ? ws[i] / t : 0, n: ns[i] })); };
// mapping check of one edge (preview or drawer data, whichever is newer)
const checkOf = (mId, sId) => edgeI[`${mId}:${sId}`]?.check || mixPv[mId]?.sources?.find((x) => x.source === sId)?.check;
const problem = (ck) => (!ck || ck.ok ? null : ck.missing.length ? `${ck.missing.length} missing` : 'unknown column');
const blockers = (m) => (m ? inputsOf(m).filter(({ s }) => problem(checkOf(m.id, s.id))).map(({ s }) => s) : []);
// any upstream edit: unsaved, previews refresh, written targets go back to ready
function touch(ms) { rev++; saved = false; status(); (ms || mixes()).forEach((m) => m && schedulePreview(m.id)); if (drawer?.mode === 'map') scheduleEdge(); }

// ---- source descriptions ----
const isHF = (u) => /^[\w.-]+\/[\w.-]+$/.test(u || '') && !/\.(parquet|csv|tsv|json|jsonl|ndjson|duckdb|db)$/i.test(u);
const isFile = (n) => !n.target && !isHF(n.url) && !info[n.id]?.hf;
function srcKind(n) {
  const i = info[n.id], u = n.url || n.target || '', base = u.split('/').pop(), dir = u.includes('/') ? u.split('/').slice(-2, -1)[0] + '/' : '';
  if (n.target || /\.(duckdb|db)$/i.test(u)) return { ic: 'db', k: `DuckDB · ${base}`, t: n.table || i?.table || base || 'New source' };
  if (isHF(u) || i?.hf) return { ic: 'hf', k: `Hugging Face${i?.hf ? ` · ${i.hf.config} / ${i.hf.split}` : ''}`, t: i?.hf?.repo || u };
  const ext = (base.match(/\.(\w+)$/) || [, 'file'])[1].toLowerCase(), kind = { parquet: 'Parquet', csv: 'CSV', tsv: 'TSV', json: 'JSON', jsonl: 'JSONL', ndjson: 'JSONL' }[ext] || 'Source';
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
const cell = (v) => (v == null ? '<span class="null">null</span>' : esc(Array.isArray(v) ? v.join(' · ') : typeof v === 'object' ? JSON.stringify(v) : v));

// ---- node templates ----
const port = (dir, key, c, full, top, extra = '', cls = '') => `<div class="port ${dir}${full ? ' full' : ''}${cls}" data-port="${key}" style="color:${c};border-color:${c};top:${top}px;${dir === 'out' ? 'right:-8px' : 'left:-8px'}${extra}"></div>`;
const moreBtn = `<button class="more" data-act="menu" title="More">${icon('more')}</button>`;
const header = (lead, kind, title, right = '') => `<div class="nh">${lead}<div class="t"><div class="k">${kind}</div><div class="tl"><b>${esc(title)}</b>${right}</div></div>${moreBtn}</div>`;
function progressHTML(st, label, cancelAct) {
  const done = st?.done, total = st?.total, unit = st?.unit;
  const amount = done != null && total ? (unit === 'bytes' ? `${mb(done)} / ${mb(total)} MB` : `${fmt(done)} / ${fmt(total)}${unit === 'rows' ? ' rows' : ''}`) : done != null && unit === 'bytes' ? `${mb(done)} MB` : '';
  const pct = total ? Math.min(100, (100 * done) / total) : null;
  const left = total && done > 0 && st.elapsed_ms > 1500 ? Math.round((st.elapsed_ms * (total - done)) / done / 1000) : null;
  return `<div class="pg"><div class="pl"><span>${esc(label)}</span><span class="mono">${amount}</span></div>
    <div class="prog${pct == null ? ' ind' : ''}"><span style="width:${pct ?? 30}%"></span></div>
    <div class="pl">${cancelAct ? `<button class="lnk u" data-act="${cancelAct}">Cancel</button>` : '<span></span>'}<small>${left != null && left > 1 ? `about ${left} s left` : ''}</small></div></div>`;
}
// load errors, by kind: a missing file offers Locate / Replace; HF and network errors their own fix
function errorHTML(n, e) {
  const u = n.url || n.target || '';
  let title = 'Can’t load this source', body = e.msg, acts = '<button class="btn ghost" data-act="load">Retry</button><button class="btn ghost" data-act="edit">Edit source</button>', hint = '';
  if (e.kind === 'not_found') {
    title = 'Can’t find this file'; body = `${u} was moved or renamed. Settings are kept.`;
    acts = `<button class="btn ghost" data-act="locate">${icon('search')} Locate file…</button><button class="btn ghost" data-act="replace">${icon('swap')} Replace…</button>`;
    hint = '<div class="foot"><button class="lnk bad" data-act="remove">Remove source</button><span class="grow"></span><small>mapping kept on Locate</small></div>';
  } else if (e.kind === 'gated' || /not found on Hugging Face/i.test(e.msg)) { title = /not found/i.test(e.msg) ? 'Dataset not found on the Hub' : 'No access to this dataset'; acts = '<button class="btn ghost" data-act="edit">Edit source</button><button class="btn ghost" data-act="load">Retry</button>'; }
  else if (/fetch failed|ENOTFOUND|ECONNRE|network/i.test(e.msg)) { title = 'Couldn’t reach Hugging Face'; acts = '<button class="btn ghost" data-act="load">Retry</button>'; }
  else if (/parquet|Invalid Input|not a valid|magic bytes/i.test(e.msg) && isFile(n)) { title = `Can’t read this file as ${srcKind(n).k.split(' ')[0]}`; acts = `<button class="btn ghost" data-act="replace">${icon('swap')} Replace…</button><button class="btn ghost" data-act="edit">Edit source</button>`; }
  return `<div class="nb"><div class="alert"><div><b>${icon('alert')} ${esc(title)}</b><span>${esc(body)}</span></div></div><div class="row acts">${acts}</div>${hint}</div>`;
}
function sourceHTML(n) {
  const d = srcKind(n), i = info[n.id], c = color(n), ld = loading[n.id];
  let body;
  if (ld) body = `<div class="nb">${progressHTML(ld.st, ld.pct != null ? `Uploading ${ld.pct}%` : ld.st?.phase || 'Starting', ld.job ? 'cancelload' : null)}</div>`;
  else if (errs[n.id] && !n._edit) body = errorHTML(n, errs[n.id]);
  else if (cancelledLoad[n.id] && !n._edit) body = `<div class="nb"><div>Load cancelled</div><div class="row acts"><button class="btn ghost" data-act="load">Load again</button><button class="btn ghost" data-act="edit">Edit source</button></div></div>`;
  else if (!i || n._edit) body = `<div class="nb">
      <label>Source<input data-f="url" class="mono" value="${esc(n.url || n.target || '')}" placeholder="org/name · path · uploads/file.parquet · .duckdb"></label>
      <div class="two"><label>Table<input data-f="table" value="${esc(n.table || '')}" placeholder="DuckDB only"></label><label>Rows<input data-f="limit" value="${esc(n.limit ?? '')}" placeholder="10000 · all"></label></div>
      <div class="hint" style="margin:0">Or drop a file on the canvas. Mapping is set per Mix input.</div>
      <div class="row acts"><button class="btn ghost" data-act="load">Load</button>${i ? '<button class="btn ghost" data-act="cancel">Cancel</button>' : ''}</div></div>`;
  else {
    const cols = realCols(i), col = pickCol(n);
    if (n.collapsed) body = `<div class="nb"><div class="foot">${cols.length} columns <span class="mono" style="color:${c};font-size:11px">${esc(col)}</span>${topBar(n, col, true)}<span class="grow"></span><button class="lnk" data-act="expand" title="Expand">${icon('down')}</button></div></div>`;
    else {
      const text = cols.find((x) => x.type === 'VARCHAR' && x.name !== col)?.name || cols[0].name;
      body = `<div class="nb">
        <div class="lbl">Columns<span class="grow"></span><span>${cols.length}</span></div>
        <div class="cols">${cols.slice(0, 6).map((x) => `<div>${esc(x.name)}<span>${esc(x.type.replace(/\(.*$/s, ''))}</span></div>`).join('')}${cols.length > 6 ? `<div style="color:var(--mute)">+${cols.length - 6} more</div>` : ''}</div>
        <div class="lbl">Top values <select class="pick" data-f="top_column" style="color:${c}">${cols.map((x) => `<option ${x.name === col ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
        ${topBar(n, col)}
        <div class="lbl">Sample<span class="grow"></span><span>${Math.min(2, i.preview.length)} of ${fmt(i.row_count)}</span></div>
        <div class="mini">${i.preview.slice(0, 2).map((r) => `<div><span>${cell(r[text])}</span><span>${cell(r[col])}</span></div>`).join('')}</div>
        <div class="foot"><button class="lnk" data-act="collapse">Collapse ${icon('up')}</button></div></div>`;
    }
  }
  const noData = !i || !!errs[n.id] || !!ld;
  return `${port('out', `out:${n.id}`, c, !noData, 21)}${header(tagChip(n), `${icon(d.ic)}${esc(d.k)}`, d.t, i && !ld ? `<span class="r">${fmt(i.row_count)} rows</span>` : '')}${body}`;
}
const spreadOf = (m) => (m.stratify_by != null ? 'stratify' : m.balance ? 'balance' : m._spread || 'none');
function advErr(m, re) { const e = mixPv[m.id]?.sources?.find((x) => x.error && re.test(x.error))?.error; return e ? `<div class="ferr">${icon('alert')}${esc(e.split('\n')[0].slice(0, 140))}</div>` : ''; }
function advancedHTML(m, fields) {
  const on = [m.stratify_by && `stratify ${m.stratify_by}`, m.balance && `balance ${m.balance}`, m.distinct_by && `distinct ${m.distinct_by}${+m.max_per_value > 1 ? ` ×${m.max_per_value}` : ''}`, m.skip_unknown_labels && 'skip unknown labels'].filter(Boolean);
  const head = `<button class="advh" data-act="adv">${icon('sliders')}<span class="lbl">Advanced</span><span class="mono sum">${esc(on.join(' · ') || 'none')}</span><span class="grow"></span>${icon(m._adv ? 'up' : 'down')}</button>`;
  if (!m._adv) return `<div class="adv">${head}</div>`;
  const sp = spreadOf(m), cols = [...new Set(inputsOf(m).flatMap(({ s }) => (info[s.id] ? realCols(info[s.id]).map((c) => c.name) : [])))];
  return `<div class="adv open">${head}<div class="advb">
    <span>Spread by</span><div class="toggle">${['none', 'stratify', 'balance'].map((v) => `<button data-act="spread" data-v="${v}" class="${sp === v ? 'on' : ''}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
    ${sp === 'stratify' ? `<span>Stratify column</span><div><input class="mono" data-f="stratify_by" list="cols-${esc(m.id)}" value="${esc(m.stratify_by || '')}" placeholder="column or path"><datalist id="cols-${esc(m.id)}">${cols.map((c) => `<option>${esc(c)}</option>`).join('')}</datalist>${advErr(m, /stratify/)}</div>` : ''}
    ${sp === 'balance' ? `<span>Balance field</span><div><select data-f="balance"><option value="">—</option>${fields.filter(SieveUI.mappable).map((f) => `<option ${f.name === m.balance ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select>${advErr(m, /balance/)}</div>` : ''}
    <span>Distinct by</span><div class="dist"><input class="mono" data-f="distinct_by" list="cols-${esc(m.id)}" value="${esc(m.distinct_by || '')}" placeholder="column or path"><span>max</span><input class="mono" data-f="max_per_value" value="${esc(m.max_per_value ?? 1)}" ${m.distinct_by ? '' : 'disabled'}>${sp !== 'stratify' ? `<datalist id="cols-${esc(m.id)}">${cols.map((c) => `<option>${esc(c)}</option>`).join('')}</datalist>` : ''}</div>
    ${advErr(m, /distinct/) ? `<span></span>${advErr(m, /distinct/)}` : ''}
    <label class="chk"><input type="checkbox" data-f="skip_unknown_labels" ${m.skip_unknown_labels ? 'checked' : ''}>Skip rows whose label is not an option</label></div></div>`;
}
function mixHTML(m) {
  const sh = shares(m), pv = mixPv[m.id], N = +m.n || 500, W = 380 - 32, sch = schemaOfMix(m), fields = sch?.fields || [];
  const ps = (s) => pv?.sources?.find((x) => x.source === s.id);
  const lack = (x) => { const p = ps(x.s), ck = checkOf(m.id, x.s.id); return { p, miss: !!problem(ck), short: p?.short_by } };
  const why = (x, l) => (l.miss ? ` · ${problem(checkOf(m.id, x.s.id))} (mapping)` : l.short ? ` · only ${fmt(l.p.pool_rows)} rows match` : '');
  const seg = sh.map((x) => { const l = lack(x); return `<span class="${l.miss || l.short ? 'short' : ''}" style="flex:${x.share || 0.0001};background:${color(x.s)}" title="${letter(x.s)} ${Math.round(x.share * 100)}% · ${fmt(x.n)} rows${why(x, l)}"></span>`; }).join('');
  const labels = sh.map((x) => { const l = lack(x), px = x.share * W, cnt = l.miss ? 0 : l.short ? l.p.pool_rows : x.n;
    return `<span style="flex:${x.share || 0.0001}" title="${letter(x.s)} ${Math.round(x.share * 100)}% · ${fmt(x.n)} rows${why(x, l)}"><b style="color:${color(x.s)}">${letter(x.s)}</b>${px >= 36 ? ` <em>${Math.round(x.share * 100)}%</em>` : ''}${px >= 70 || (l.miss && px >= 50) ? ` <small class="${l.miss || l.short ? 'bad' : ''}">${fmt(cnt)}</small>` : ''}</span>`; }).join('');
  const rows = sh.map((x) => { const p = ps(x.s), er = p?.error && !errs[x.s.id] && !p.check?.unknown?.length && !/stratify|balance|distinct/.test(p.error) ? p.error : null, ck = checkOf(m.id, x.s.id), pr = problem(ck);
    const act = drawer?.mode === 'map' && drawer.mix === m.id && drawer.src === x.s.id;
    const se = errs[x.s.id], chip = se ? `<span class="mchip bad" title="${esc(se.msg || '')}">${icon('alert')}${se.kind === 'not_found' ? 'File missing' : 'Load failed'}</span>` : !info[x.s.id] ? '' : !ck ? '<span class="mchip wait">…</span>' : `<button class="mchip ${pr ? 'bad' : 'ok'}${act ? ' act' : ''}" data-act="map" data-e="${esc(x.s.id)}" title="Mapping and metadata for this source">${icon(pr ? 'alert' : 'check')}${pr ? esc(pr) : 'Mapped'}</button>`;
    return `<div class="inrow${act ? ' act' : ''}">${port('in', `in:${m.id}:${x.s.id}`, color(x.s), true, 9, ';left:-24px')}${tagChip(x.s, true)}<span class="nm">${esc(srcKind(x.s).t)}</span>${chip}
      <input class="sm wt" data-e="${esc(x.s.id)}" data-f="weight" value="${esc(x.e.weight ?? 1)}" title="relative weight">
      <input class="sm wh${er ? ' bad' : ''}" data-e="${esc(x.s.id)}" data-f="where" value="${esc(x.e.where || '')}" placeholder="where ...">
      ${er ? `<div class="ferr">${icon('alert')}${esc(er.split('\n')[0].slice(0, 120))}</div>` : ''}</div>`; }).join('');
  const prow = (pv?.rows || []).slice(0, 5).map((r) => { const s = node(r._source); return `<div style="border-left-color:${color(s)}"><span style="color:${color(s)};font-weight:700">${letter(s)}</span><span>${cell(r.input)}</span><span>${cell(Array.isArray(r.label) ? r.label.join(', ') : r.label)}</span></div>`; }).join('');
  const skips = (pv?.sources || []).filter((x) => x.skip_reason || (x.error && x.check?.unknown?.length)).map((x) => { const s = node(x.source);
    return s ? `<div class="skip" style="border-left-color:${color(s)}"><span style="color:${color(s)};font-weight:700">${letter(s)}</span><span>${icon('alert')} ${x.skip_reason ? `${fmt(x.rows_skipped)} rows skipped: ${esc(x.skip_reason)}` : esc(x.error)}</span></div>` : ''; }).join('');
  return `${port('in', `in:${m.id}`, 'var(--mute)', false, 21, '', ' hid')}${port('out', `out:${m.id}`, 'var(--mute)', sh.length > 0, 21)}
    ${header(`<span class="ico">${icon('mix')}</span>`, 'Mix', m.label || m.id, `<span class="r">seed ${esc(m.seed ?? B.seed)}</span>`)}
    <div class="nb">
      <div class="schrow"><span>Schema</span><select data-f="schema">${schemas.map((s) => `<option ${s === (m.schema || 'default') ? 'selected' : ''}>${esc(s)}</option>`).join('')}<option value="__new__">+ New schema…</option></select><button class="btn ghost sm${drawer?.mode === 'schema' && drawer.mix === m.id ? ' act' : ''}" data-act="schema">${icon('edit')} Edit</button></div>
      <div class="lbl">Proportion<span class="grow"></span><span>Rows</span><input class="sm mono" style="width:76px" data-f="n" value="${N}"></div>
      ${sh.length ? `<div class="bar12">${seg}</div><div class="blabels">${labels}</div>` : '<div class="hint" style="margin:0">Drag a source’s port onto this node.</div>'}
      <div class="lbl">Inputs<span class="grow"></span><span>mapping · weight</span></div>${rows}
      ${advancedHTML(m, fields)}
      <div class="lbl">Preview<span class="grow"></span><span>${pv?.pending ? 'sampling…' : pv?.rows ? `${Math.min(5, pv.rows.length)} of ${fmt(N)}` : ''}</span></div>
      ${pv?.error ? `<div class="alert">${icon('alert')}<span>${esc(pv.error)}</span></div>` : prow || skips ? `<div class="pv"><div class="h"><span>src</span><span>input</span><span>label</span></div>${prow}${skips}</div>` : ''}
    </div>`;
}
function writeProgress(t, m) {
  const w = writing[t.id], st = w.st || {}, sh = shares(m), N = +m.n || 500;
  const cur = [...(st.phases || [])].reverse().map((p) => p.match(/^Writing (?!rows$)(.+)$/)?.[1]).find(Boolean);
  const idx = cur ? sh.findIndex((x) => x.s.id === cur) : -1;
  const before = sh.slice(0, Math.max(0, idx)).reduce((a, x) => a + x.n, 0);
  const now = idx < 0 ? 0 : st.phase === 'Converting rows' ? Math.min(st.done || 0, sh[idx].n) : /^(Writing rows|Replacing)/.test(st.phase) ? sh[idx].n : 0;
  const done = /^Replacing/.test(st.phase) ? N : before + now;
  const segs = sh.map((x, i) => { const f = i < idx || /^Replacing/.test(st.phase) ? 1 : i === idx ? now / Math.max(1, x.n) : 0; return `<span style="flex:${x.share || 0.0001}"><i style="width:${Math.round(f * 100)}%;background:${color(x.s)}"></i></span>`; }).join('');
  const label = idx >= 0 || /^Replacing/.test(st.phase) ? `Writing ${fmt(done)} / ${fmt(N)} rows` : st.phase ? st.phase.replace(/^Loading /, 'Loading ') : 'Starting';
  return `<div class="pl"><span>${esc(label)}</span><span>${idx >= 0 ? `${tagChip(sh[idx].s, true)} ${esc(srcKind(sh[idx].s).t)}` : ''}</span></div><div class="wprog">${segs}</div>
    <div class="pl"><button class="btn ghost sm" data-act="cancelwrite" ${st.cancelled ? 'disabled' : ''}>${st.cancelled ? 'Cancelling…' : 'Cancel write'}</button><small>nothing is kept</small></div>`;
}
function targetHTML(t) {
  const m = mixOfTarget(t), N = m ? +m.n || 500 : 0, run = runs[t.id], stale = run && run.rev !== rev, file = t.target || 'datasets.duckdb';
  const table = schemaOfMix(m)?.table || 'rows', mode = t.mode && t.mode !== 'auto' ? t.mode : targets.includes(file) ? 'append' : 'create';
  const files = [...new Set([...targets, file])], block = blockers(m);
  let action;
  if (writing[t.id]) action = writeProgress(t, m);
  else action = `<button class="btn wide${run && !stale ? ' ghost' : ''}" data-act="write" ${m && !block.length ? '' : 'disabled'} title="${block.length ? `Fix mapping for ${block.map(letter).join(', ')} first` : ''}">${run && !stale ? 'Write again' : `Write ${fmt(N)} rows`}</button>${wnote[t.id] && !block.length ? `<div class="wnote">${icon('x')}${esc(wnote[t.id])}</div>` : ''}${block.length ? `<div class="ferr">${icon('alert')}Fix mapping for ${block.map(letter).join(', ')} first</div>` : ''}`;
  const res = run ? `<div class="res${stale ? ' stale' : ''}"><h4>${icon('check')}${run.created ? 'Created' : 'Appended'} ${fmt(run.r.rows_written)} rows</h4>
      ${stale ? '<div class="hint" style="margin:0">Board changed since last write</div>' : ''}
      <div class="st"><div>Total in target<b>${fmt(run.r.total_rows_in_target)}</b></div><div>Written<b>${run.at}</b></div></div>
      ${run.r.sources.map((s) => { const sn = node(s.source), short = s.rows_written < s.requested; return `<div class="srow">${tagChip(sn, true)}<span>${esc(sn ? srcKind(sn).t : s.source)}</span><b class="${short ? 'bad' : ''}" title="${short ? `only ${fmt(s.rows_written)} of ${fmt(s.requested)}` : ''}">${fmt(s.rows_written)}</b><span class="sb" style="background:${color(sn)};width:${Math.round((100 * s.rows_written) / Math.max(1, run.r.requested))}%"></span></div>`; }).join('')}</div>` : '';
  return `${port('in', `in:${t.id}`, 'var(--mute)', !!m, 21)}
    ${header(`<span class="ico">${icon('db')}</span>`, 'Target · DuckDB', file)}
    <div class="nb">
      <div class="f2">File<select data-f="target">${files.map((f) => `<option ${f === file ? 'selected' : ''}>${esc(f)}</option>`).join('')}<option value="__new__">New file…</option></select>
        Mode<div class="toggle"><button data-act="mode" data-v="create" class="${mode === 'create' ? 'on' : ''}">New file</button><button data-act="mode" data-v="append" class="${mode === 'append' ? 'on' : ''}">Append</button></div>
        Table<input value="${esc(table)}" readonly></div>
      ${errs[t.id] ? `<div class="alert">${icon('alert')}<span>${esc(errs[t.id].msg)}</span></div>` : ''}
      ${action}${res}</div>`;
}

// ---- drawer: mapping + metadata per source -> Mix edge (wizard steps 2-3), or the Mix's schema ----
const dkey = () => `${drawer.mix}:${drawer.src}`;
const fill = (id, html) => { const el = $(id), ae = document.activeElement; if (!(el.contains(ae) && ae.matches('input,select,textarea'))) { el.innerHTML = html; icons(el); } };
function renderDrawer() {
  const D = $('drawer'); D.hidden = !drawer; $('stage').classList.toggle('drawer', !!drawer);
  if (!drawer) return;
  const m = node(drawer.mix); if (!m) { drawer = null; D.hidden = true; return; }
  $('dMap').hidden = drawer.mode !== 'map'; $('dSchema').hidden = drawer.mode !== 'schema';
  const sch = schemaOfMix(m), mixName = esc(m.label || m.id);
  if (drawer.mode === 'schema') {
    const name = drawer.newName || m.schema || 'default', ins = inputsOf(m);
    fill('dHead', `${drawer.back ? `<button class="ib" data-dact="back" title="Back to mapping">${icon('back')}</button>` : ''}<div class="t"><div class="k">Schema · used by ${mixName} mix</div><b class="mono">${esc(name)}</b></div><button class="ib" data-dact="close" title="Close (Esc)">${icon('x')}</button>`);
    if (!sch) return;
    fill('dSchInfo', `${sch.description ? `<p class="desc">${esc(sch.description)}</p>` : ''}<div class="kvl">Table <b class="mono">${esc(sch.table)}</b></div>
      <div class="lbl">Fields<span class="grow"></span><span>${sch.fields.length}</span></div>
      <div class="stbl"><div class="h"><span>field</span><span>type</span><span>filled by</span><span>per source</span></div>${sch.fields.map((f) => {
        const per = SieveUI.mappable(f) ? ins.map(({ s }) => checkOf(m.id, s.id)?.status?.[f.name]) : [];
        const okN = per.filter((x) => x === 'ok').length;
        return `<div><span class="mono">${esc(f.name)}${f.required ? '<em class="req">*</em>' : ''}</span><span>${esc(f.type || 'text')}</span><span>${esc(SieveUI.filledBy(f))}</span><span>${!per.length ? '' : okN === per.length ? icon('check') : `<b class="${per.some((x) => x === 'missing' || x === 'unknown') ? 'bad' : ''}">${okN}/${per.length}</b>`}</span></div>`; }).join('')}</div>`);
    if (!$('schemaJson').matches(':focus') && $('schemaJson').dataset.for !== `${m.id}:${name}:${drawer.v || 0}`) { $('schemaJson').value = drawer.json || ''; $('schemaJson').dataset.for = `${m.id}:${name}:${drawer.v || 0}`; }
    $('dSchFoot').textContent = `Saving re-checks mapping for all ${ins.length} source${ins.length === 1 ? '' : 's'}`;
    return;
  }
  const s = node(drawer.src), e = edgeOf(m.id, s?.id), ei = edgeI[dkey()];
  if (!s || !e) { closeDrawer(); return; }
  fill('dHead', `${tagChip(s)}<div class="t"><div class="k">Mapping</div><b>${esc(srcKind(s).t)}</b> <span class="into">into ${mixName} mix</span></div><button class="ib" data-dact="close" title="Close (Esc)">${icon('x')}</button>`);
  const ck = ei?.check, pr = ck && !ck.ok ? (ck.missing.length ? `${ck.missing.length} required field${ck.missing.length > 1 ? 's' : ''} missing` : `${ck.unknown.length} unknown column${ck.unknown.length > 1 ? 's' : ''}`) : null;
  fill('dSum', `<span>Schema</span><b class="mono acc">${esc(m.schema || 'default')}</b><button class="lnk" data-dact="editschema">${icon('edit')} Edit schema</button><span class="grow"></span>${ck ? `<span class="spill ${pr ? 'bad' : 'ok'}">${pr ? `${icon('alert')}${esc(pr)}` : `${icon('check')}All required fields mapped`}</span>` : ''}`);
  if (!ei) { fill('dFieldsH', `<div class="lbl">Fields</div>`); fill('dfields', `<div class="hint">${drawer.err ? `<span class="badtxt">${esc(drawer.err)}</span>` : info[s.id] ? 'Reading columns…' : 'Load the source first.'}</div>`); fill('dset', ''); fill('dMetaH', ''); fill('dmeta', ''); fill('dmetaMix', ''); fill('dprev', ''); $('dAddMeta').hidden = true; return; }
  $('dAddMeta').hidden = false;
  const cols = ei.columns.map((c) => c.name).filter((c) => c !== '_sieve_row');
  const mapFields = Object.fromEntries(sch.fields.filter(SieveUI.mappable).map((f) => [f.name, ei.mapping[f.name] || []]));
  fill('dFieldsH', `<div class="lbl">Fields<span class="grow"></span><span>${ck.mapped} of ${ck.fields} mapped</span></div>`);
  fill('dfields', SieveUI.mappingHTML(sch, cols, mapFields, {
    rows: true, status: ck.status,
    auto: (f) => (ei.suggested?.[f] || []).length > 0 && (mapFields[f] || []).join() === ei.suggested[f].join(),
    helper: (f) => (ck.status[f] === 'missing' ? `<div class="help"><b>Required.</b> ${ck.fixes?.[f] ? `Looks like text: <button class="fix" data-dact="fix" data-field="${esc(f)}" data-col="${esc(ck.fixes[f])}">${icon('plus')}${esc(ck.fixes[f])}</button>` : 'Pick a column.'}</div>`
      : ck.status[f] === 'unknown' ? `<div class="help"><b>Not in this source:</b> ${esc(ck.unknown.filter((u) => u.field === f).map((u) => u.column).join(', '))}</div>` : ''),
  }));
  const fixed = sch.fields.filter((f) => !SieveUI.mappable(f));
  fill('dset', fixed.length ? `<details ${drawer.setOpen ? 'open' : ''}><summary><span class="lbl">Set by schema</span><span class="mono">${esc(fixed.map((f) => f.name).join(', '))}</span><span class="grow"></span>${icon('down')}</summary>${fixed.map((f) => `<div class="setrow"><span class="mono">${esc(f.name)}</span><span>${esc(SieveUI.filledBy(f))}</span></div>`).join('')}</details>` : '');
  const store = m.target_column !== undefined ? m.target_column : ei.target_column;
  fill('dMetaH', `<div class="lbl">Metadata<span class="grow"></span><label class="storein">Store in<select data-dm="target_column">${SieveUI.metaColOptions(sch, store)}</select></label></div>`);
  fill('dmeta', SieveUI.metaRowsHTML(ei.metadata, cols));
  const mixMeta = [...(ei.mix_metadata || []), { key: 'board', value: B.name || '(board name)' }, { key: 'board_source', value: s.id }];
  fill('dmetaMix', mixMeta.map((x) => `<div class="kv mixkv"><input value="${esc(x.key)}" readonly><input value="${x.column != null ? 'from column' : 'constant'}" readonly><input value="${esc(x.column ?? (typeof x.value === 'object' ? JSON.stringify(x.value) : x.value))}" readonly><span class="mixtag">Mix</span></div>`).join(''));
  const pf = sch.fields.filter(SieveUI.mappable).map((f) => f.name), show = [...pf.slice(0, 2), ...(pf.includes('label') && !pf.slice(0, 2).includes('label') ? ['label'] : [])];
  fill('dprev', `<div class="lbl">Preview · this source<span class="grow"></span><span>${ei.rows.length} of ${fmt(ei.row_count)}</span></div>
    ${ei.rows.length ? `<div class="ptbl" style="grid-template-columns:${show.map(() => '1fr').join(' ')}"><span class="h">${show.map((k) => `<span>${esc(k)}</span>`).join('')}</span>${ei.rows.map((r) => `<span class="r">${show.map((k) => `<span>${cell(r[k])}</span>`).join('')}</span>`).join('')}</div>` : ''}
    ${ei.error ? `<div class="hint${ck.ok ? ' badtxt' : ''}">${esc(ei.error)}</div>` : ck.missing.length ? '' : ''}`);
}
const edgeSeq = {};
let edgeTimer;
function scheduleEdge() { clearTimeout(edgeTimer); edgeTimer = setTimeout(fetchEdge, 500); }
async function fetchEdge() {
  if (drawer?.mode !== 'map') return;
  const key = dkey(), my = (edgeSeq[key] = (edgeSeq[key] || 0) + 1), [mixId, srcId] = key.split(':');
  if (!info[srcId]) return renderDrawer();
  try { const r = await api('/api/boards/edge', { board: board(), mix: mixId, source: srcId, rows: 3 }); if (edgeSeq[key] === my) { edgeI[key] = r; drawer && (drawer.err = null); } }
  catch (e) { if (edgeSeq[key] === my && drawer) drawer.err = e.message; }
  renderDrawer(); render();
}
function openMap(mixId, srcId) {
  drawer = { mode: 'map', mix: mixId, src: srcId }; $('stage').classList.add('drawer');
  renderDrawer(); render(); fetchEdge();
}
async function openSchema(mixId, { back, fresh } = {}) {
  const m = node(mixId); if (!m) return;
  const cur = await SieveUI.schemaJSON(m.schema || 'default');
  drawer = { mode: 'schema', mix: mixId, back, json: fresh ? SieveUI.newSchemaJSON(cur) : cur, v: Date.now() };
  if (fresh) drawer.newName = JSON.parse(drawer.json).name;
  renderDrawer(); render(); $('schemaJson').focus();
}
function closeDrawer() { drawer = null; renderDrawer(); render(); }
async function saveSchema() {
  const m = node(drawer.mix); $('dSchErr').textContent = '';
  try {
    const s = await SieveUI.saveSchemaJSON($('schemaJson').value);
    schemas = (await api('/api/schemas')).map((x) => x.name); schemaDefs[s.name] = await api('/api/schemas/' + encodeURIComponent(s.name));
    m.schema = s.name; drawer.newName = null; drawer.json = JSON.stringify(schemaDefs[s.name], null, 2); drawer.v = Date.now();
    for (const k of Object.keys(edgeI)) if (k.startsWith(m.id + ':')) delete edgeI[k];
    touch([m]); render(); renderDrawer(); toast(`Schema “${s.name}” saved`);
  } catch (e) { $('dSchErr').textContent = e.message; }
}
// keep only the fields that differ from the server's auto-mapping, so the rest stays 'Auto'
function mapDiff(mp) {
  const sug = edgeI[dkey()]?.suggested || {}, out = {};
  for (const [f, v] of Object.entries(mp)) if ((v || []).join('\u0001') !== (sug[f] || []).join('\u0001')) out[f] = v;
  return Object.keys(out).length ? out : undefined;
}
function setEdge(patch) {
  const e = edgeOf(drawer.mix, drawer.src); if (!e) return;
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete e[k]; else e[k] = v;
  touch([node(drawer.mix)]); render();
}

// ---- render ----
function render() {
  const world = $('world'), ae = document.activeElement, active = ae?.matches?.('input,textarea,select') ? ae.closest('.n')?.dataset.id : null;
  for (const el of [...world.querySelectorAll('.n')]) if (!node(el.dataset.id)) el.remove();
  for (const n of B.nodes) {
    let el = world.querySelector(`.n[data-id="${CSS.escape(n.id)}"]`);
    if (!el) { el = document.createElement('div'); el.dataset.id = n.id; world.appendChild(el); }
    const run = runs[n.id];
    el.className = `n ${n.type}${sel.has(n.id) ? ' sel' : ''}${errs[n.id] ? ' err' : ''}${run && run.rev === rev ? ' done' : ''}${menuFor === n.id ? ' menu-on' : ''}${drawer && drawer.mix === n.id ? ' dfocus' : ''}`;
    el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
    if (n.id !== active) el.innerHTML = n.type === 'source' ? sourceHTML(n) : n.type === 'mix' ? mixHTML(n) : targetHTML(n);
  }
  icons(world); wires(); applyView(); emptyState(); groupUI();
  const has = srcs().length > 0; ['addMix', 'addTarget'].forEach((b) => { $(b).disabled = !has; });
  $('saveB').disabled = !has || !nameOk();
}
const applyView = () => { $('world').style.transform = `translate(${view.x}px,${view.y}px) scale(${view.k})`; $('zPct').textContent = `${Math.round(view.k * 100)}%`; };
const toWorld = (cx, cy) => { const r = $('stage').getBoundingClientRect(); return [(cx - r.left - view.x) / view.k, (cy - r.top - view.y) / view.k]; };
function portXY(key) { const el = document.querySelector(`[data-port="${CSS.escape(key)}"]`); if (!el) return null; const r = el.getBoundingClientRect(); return toWorld(r.left + r.width / 2, r.top + r.height / 2); }
function wires(draft) {
  const svg = $('wires'); let h = '', pills = '';
  const focus = drawer?.mode === 'map' ? `${drawer.mix}:${drawer.src}` : null;
  B.edges.forEach((e, idx) => {
    const a = node(e.from), z = node(e.to); if (!a || !z) return;
    if (a.type === 'source') {
      const p1 = portXY(`out:${a.id}`), p2 = portXY(`in:${z.id}:${a.id}`); if (!p1 || !p2) return;
      const sh = shares(z).find((x) => x.s.id === a.id)?.share ?? 0, dx = (p2[0] - p1[0]) * 0.55, c = color(a), r = roundOf(a);
      const noData = errs[a.id] || !info[a.id] || loading[a.id], pr = problem(checkOf(z.id, a.id));
      const dim = focus && focus !== `${z.id}:${a.id}` ? 0.35 : noData && r > 0 ? 0.35 : 0.9;
      const dash = noData && r === 0 ? '5 5' : wireDash(a);
      h += `<path class="w${selEdge === idx ? ' sel' : ''}" data-edge="${idx}" d="M${p1} C${p1[0] + dx},${p1[1]} ${p2[0] - dx},${p2[1]} ${p2}" stroke="${c}" stroke-width="${1.5 + 5 * sh}" style="opacity:${dim}" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
      const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2, label = `${Math.round(sh * 100)}%`;
      if (pr) { const w = 46 + pr.length * 6.2 + 26;
        pills += `<g class="pill bad" data-pill="${esc(z.id)}:${esc(a.id)}" style="opacity:${focus && focus !== `${z.id}:${a.id}` ? 0.45 : 1}"><rect x="${mx - w / 2}" y="${my - 10}" width="${w}" height="20" rx="10"/><text x="${mx - w / 2 + 19}" y="${my}" fill="${c}">${label}</text><line x1="${mx - w / 2 + 38}" x2="${mx - w / 2 + 38}" y1="${my - 6}" y2="${my + 6}"/><circle cx="${mx - w / 2 + 50}" cy="${my}" r="5"/><text class="ex" x="${mx - w / 2 + 50}" y="${my}">!</text><text class="msg" x="${mx - w / 2 + 60}" y="${my}">${esc(pr)}</text></g>`; }
      else pills += `<g class="pill" data-pill="${esc(z.id)}:${esc(a.id)}" style="opacity:${focus && focus !== `${z.id}:${a.id}` ? 0.45 : 1}"><rect x="${mx - 19}" y="${my - 10}" width="38" height="20" rx="10"/><text x="${mx}" y="${my}" fill="${c}">${label}</text></g>`;
    } else {
      const p1 = portXY(`out:${a.id}`), p2 = portXY(`in:${z.id}`); if (!p1 || !p2) return;
      const done = runs[z.id] && runs[z.id].rev === rev, label = `${fmt(+a.n || 500)} rows`, w = label.length * 6.4 + 16, mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
      h += `<path class="w out${selEdge === idx ? ' sel' : ''}" data-edge="${idx}" d="M${p1} L${p2}" ${done ? '' : 'stroke-dasharray="5 5"'}/>`;
      pills += `<g class="pill"><rect x="${mx - w / 2}" y="${my - 10}" width="${w}" height="20" rx="10"/><text x="${mx}" y="${my}" fill="var(--fg)">${label}</text></g>`;
    }
  });
  if (draft) h += `<path class="w" d="${draft.d}" stroke="${draft.c}" stroke-width="2" stroke-dasharray="5 5"/>`;
  svg.innerHTML = h + pills;
}
function emptyState() {
  const e = $('empty'); e.hidden = B.nodes.length > 0; if (!e.hidden && !e.innerHTML) {
    e.innerHTML = `<div style="position:relative;width:640px;height:270px">${[0, 1, 2].map((i) => `<div class="sk" style="left:-180px;top:${i * 96 - 20}px;width:140px;height:76px">Source</div>`).join('')}
      <div class="sk" style="left:690px;top:76px;width:140px;height:76px">Target</div>
      <div class="card0" style="position:absolute;left:120px;top:15px"><div class="tile"><svg viewBox="0 0 32 32" width="26" height="26"><g fill="var(--acc)"><circle cx="10" cy="11" r="2"/><circle cx="16" cy="11" r="2"/><circle cx="22" cy="11" r="2"/><circle cx="13" cy="17" r="2"/><circle cx="19" cy="17" r="2"/><circle cx="16" cy="23" r="2"/></g></svg></div>
      <h3>Start with a source</h3><p>Hugging Face, Parquet, CSV, JSON or DuckDB</p>
      <div class="row"><button id="e_add">${icon('plus')} Add source</button><button class="ghost" id="e_open">${icon('folder')} Open board</button></div>
      <p class="hint" style="margin-top:6px">or double-click the canvas, or drop files here</p></div></div>`;
    $('e_add').onclick = () => addNode('source'); $('e_open').onclick = (ev) => { ev.stopPropagation(); openMenu(); };
  }
}
const nameOk = () => NAME_RE.test($('bname').value.trim() || 'x');
const status = () => { $('saved').textContent = saved ? 'Saved' : 'Not saved'; };
// group outline + bar for 2+ selected nodes
function groupUI() {
  const g = $('group'), bar = $('groupBar'), ns = [...sel].map(node).filter(Boolean);
  if (ns.length < 2) { g.hidden = bar.hidden = true; return; }
  const box = ns.map((n) => [n.x, n.y, n.x + widthOf(n), n.y + heightOf(n)]);
  const x0 = Math.min(...box.map((b) => b[0])) - 10, y0 = Math.min(...box.map((b) => b[1])) - 10, x1 = Math.max(...box.map((b) => b[2])) + 10, y1 = Math.max(...box.map((b) => b[3])) + 10;
  Object.assign(g.style, { left: x0 + 'px', top: y0 + 'px', width: x1 - x0 + 'px', height: y1 - y0 + 'px' }); g.hidden = false;
  Object.assign(bar.style, { left: x1 + 16 + 'px', top: y0 + 'px' }); bar.hidden = false;
  bar.querySelector('b').textContent = `${ns.length} selected`;
}

// ---- layout ----
const widthOf = (n) => (n.type === 'mix' ? 380 : 300);
const heightOf = (n) => document.querySelector(`.n[data-id="${CSS.escape(n.id)}"]`)?.offsetHeight || (n.collapsed ? 100 : 160);
function place(n) { // stack in the type's column, ignoring nodes placed elsewhere (drops, drags)
  if (n.type === 'source') { const s = srcs().filter((x) => x !== n && x.x != null && Math.abs(x.x - COLX.source) < 60); n.x = COLX.source; n.y = s.length ? Math.max(...s.map((x) => x.y + heightOf(x))) + 28 : 0; }
  else { const others = B.nodes.filter((x) => x.type === n.type && x !== n && x.x != null && Math.abs(x.x - COLX[n.type]) < 60); n.x = COLX[n.type]; n.y = others.length ? Math.max(...others.map((x) => x.y + heightOf(x))) + 40 : 40; }
}
const nextTag = () => Math.max(-1, ...srcs().map((s) => s.tag ?? -1)) + 1;
function autoLayout() { // boards built elsewhere (MCP) get the same columns
  let tag = nextTag() - 1;
  srcs().forEach((s, i) => { if (s.tag == null) s.tag = ++tag; if (s.collapsed == null) s.collapsed = i > 0; });
  for (const n of B.nodes) if (n.x == null || n.y == null) { n._auto = true; place(n); }
}
function relayout() { // re-stack auto-placed nodes once loaded cards change height
  const auto = B.nodes.filter((n) => n._auto); if (!auto.length) return;
  for (const n of auto) n.x = n.y = null;
  for (const n of auto) place(n);
  render();
}
function fit(only) {
  const ns = only?.length ? only : B.nodes;
  if (!ns.length) { view = { x: 80, y: 60, k: 1 }; return applyView(); }
  const st = $('stage').getBoundingClientRect(), W = st.width - (drawer ? 476 : 0);
  const xs = ns.flatMap((n) => [n.x, n.x + widthOf(n)]), ys = ns.flatMap((n) => [n.y, n.y + heightOf(n)]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const k = Math.min(1, Math.max(0.25, Math.min((W - 120) / (x1 - x0), (st.height - 110) / (y1 - y0))));
  view = { k, x: (W - (x1 - x0) * k) / 2 - x0 * k, y: Math.max(40, (st.height - (y1 - y0) * k) / 2) - y0 * k }; applyView(); wires(); groupUI();
}

// ---- server calls (with progress + cancel) ----
const schemaOf = (s) => node(B.edges.find((e) => e.from === s.id)?.to)?.schema || 'default';
async function loadSource(n, { fresh = false } = {}) {
  if (!n.url && !n.target) { errs[n.id] = { msg: 'Enter a Hugging Face name, a file path or a .duckdb file' }; return render(); }
  const job = jobId();
  loading[n.id] = { job, st: null }; delete errs[n.id]; delete cancelledLoad[n.id]; delete n._edit; render();
  const stop = track(job, (st) => { if (loading[n.id]?.job === job) { loading[n.id].st = st; render(); } });
  try { info[n.id] = await api('/api/boards/source', { node: clean(n), schema: schemaOf(n), seed: B.seed, fresh }, job); }
  catch (e) { delete info[n.id]; if (e.kind === 'cancelled') cancelledLoad[n.id] = true; else errs[n.id] = { msg: e.message, kind: e.kind }; }
  finally {
    stop(); if (loading[n.id]?.job === job) delete loading[n.id];
    for (const k of Object.keys(edgeI)) if (k.endsWith(':' + n.id)) delete edgeI[k];
    render(); relayout(); B.edges.filter((e) => e.from === n.id).forEach((e) => schedulePreview(e.to));
    if (drawer?.src === n.id) fetchEdge();
  }
}
const timers = {};
function schedulePreview(id) { clearTimeout(timers[id]); timers[id] = setTimeout(() => previewMix(id), 500); }
async function previewMix(id) {
  const m = node(id); if (!m || !inputsOf(m).some(({ s }) => info[s.id])) return;
  const my = (mixPv[id] = { ...mixPv[id], pending: true }); render();
  try { const r = await api('/api/boards/preview', { board: board(), mix: id, n: 5 }); if (mixPv[id] === my) mixPv[id] = r; }
  catch (e) { if (mixPv[id] === my) mixPv[id] = { error: e.message }; }
  render(); if (drawer?.mix === id) renderDrawer();
}
async function write(t) {
  const job = jobId(), file = t.target || 'datasets.duckdb', mode = t.mode && t.mode !== 'auto' ? t.mode : targets.includes(file) ? 'append' : 'create';
  delete errs[t.id]; delete wnote[t.id]; writing[t.id] = { job, st: null }; render();
  const stop = track(job, (st) => { if (writing[t.id]?.job === job) { writing[t.id].st = st; render(); } });
  try {
    const r = await api('/api/boards/run', { board: board({ [t.id]: { mode } }), target: t.id }, job);
    const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    runs[t.id] = { r: r.runs[0], rev, at, created: r.runs[0].created ?? mode === 'create' };
    targets = (await api('/api/targets')).map((x) => x.name); t.mode = 'append'; // the file exists now
  } catch (e) { if (e.kind === 'cancelled') wnote[t.id] = e.message.replace(/ \(.*$/, ''); else errs[t.id] = { msg: e.message, kind: e.kind }; }
  finally { stop(); delete writing[t.id]; render(); }
}
const clean = (n) => Object.fromEntries(Object.entries(n).filter(([k]) => !k.startsWith('_')));
const board = (patch = {}) => ({ ...B, nodes: B.nodes.map((n) => ({ ...clean(n), ...patch[n.id] })) });
async function save() {
  if (!nameOk()) return;
  B.name = $('bname').value.trim() || 'untitled-board'; $('bname').value = B.name;
  await api('/api/boards', board()); saved = true; status(); history.replaceState(null, '', '?board=' + encodeURIComponent(B.name)); toast('Board saved');
}
async function openBoard(name) {
  const b = await api('/api/boards/' + encodeURIComponent(name));
  B = { ...b, nodes: b.nodes || [], edges: b.edges || [] }; sel.clear(); selEdge = null; drawer = null; renderDrawer();
  for (const o of [info, loading, errs, cancelledLoad, mixPv, runs, writing, edgeI]) for (const k in o) delete o[k];
  $('bname').value = B.name; $('seed').value = B.seed ?? 42; saved = true; status(); nameCheck();
  await Promise.all(mixes().map((m) => fields(m.schema || 'default')));
  render(); autoLayout(); render(); fit();
  history.replaceState(null, '', '?board=' + encodeURIComponent(name));
  await Promise.all(srcs().map((s) => loadSource(s))); fit();
  const bad = srcs().filter((s) => errs[s.id]);
  if (bad.length) toast(`${bad.length} source${bad.length > 1 ? 's need' : ' needs'} attention`, { label: 'Show', run: () => fit(bad) }, true);
}
async function fields(s) { if (schemaDefs[s]) return; schemaDefs[s] = await api('/api/schemas/' + encodeURIComponent(s)); }
async function openMenu() {
  const menu = $('openMenu'), l = await api('/api/boards');
  menu.innerHTML = l.length ? l.map((b) => `<button data-b="${esc(b.name)}">${esc(b.name)}</button>`).join('') : '<p class="hint">No saved boards yet</p>';
  menu.hidden = false;
  menu.querySelectorAll('button').forEach((b) => { b.onclick = () => { menu.hidden = true; openBoard(b.dataset.b).catch((e) => toast(e.message, null, true)); }; });
}

// ---- uploads: dropped or picked files go to the data dir (uploads/<name>) and become (or replace) sources ----
const OK_EXT = /\.(parquet|csv|tsv|json|jsonl|ndjson|duckdb|db)$/i;
function upload(file, onPct) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest(); x.open('POST', '/api/upload?name=' + encodeURIComponent(file.name));
    x.upload.onprogress = (e) => e.lengthComputable && onPct(Math.round((100 * e.loaded) / e.total));
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch {} x.status < 300 ? res(j) : rej(new Error(j.error || `Upload failed (${x.status})`)); };
    x.onerror = () => rej(new Error('Upload failed')); x.setRequestHeader('content-type', 'application/octet-stream'); x.send(file);
  });
}
async function uploadInto(n, file) { // a new source, or Locate / Replace on an existing one (mapping, weight and where are kept)
  loading[n.id] = { pct: 0 }; delete errs[n.id]; delete info[n.id]; render();
  try {
    const r = await upload(file, (p) => { if (loading[n.id]) { loading[n.id].pct = p; render(); } });
    delete loading[n.id]; delete n.target; n.url = r.url; if (/\.(duckdb|db)$/i.test(r.name)) delete n.table;
    touch(B.edges.filter((e) => e.from === n.id).map((e) => node(e.to))); await loadSource(n);
  } catch (e) { delete loading[n.id]; errs[n.id] = { msg: e.message }; render(); }
}
function addFiles(files, at) {
  const bad = files.filter((f) => !OK_EXT.test(f.name));
  if (bad.length) return toast(`Can’t add ${bad.map((f) => f.name).join(', ')}: use Parquet, CSV, JSON, JSONL or DuckDB`, null, true);
  const ms = mixes(), made = [];
  files.forEach((f, i) => {
    const n = addNode('source', at ? [Math.round(at[0]), Math.round(at[1] + i * 138)] : null, { quiet: true, connect: false });
    n.url = `uploads/${f.name}`; made.push(n);
    if (ms.length === 1) B.edges.push({ from: n.id, to: ms[0].id, weight: 1 });
    uploadInto(n, f);
  });
  sel = new Set(made.map((n) => n.id)); touch(); render();
}

// ---- editing inside nodes ----
function addNode(type, at, { quiet = false, connect = true } = {}) {
  let i = 1; while (node(`${type}${i}`)) i++;
  const n = { id: `${type}${i}`, type };
  if (type === 'source') { n.tag = nextTag(); n.collapsed = srcs().length > 0; n.limit = 10000; }
  if (type === 'mix') Object.assign(n, { schema: 'default', n: 500 });
  if (type === 'target') n.target = 'datasets.duckdb';
  B.nodes.push(n);
  if (at) [n.x, n.y] = at; else place(n);
  if (type === 'mix') { fields('default').then(render); if (connect) srcs().filter((s) => !B.edges.some((e) => e.from === s.id)).forEach((s) => B.edges.push({ from: s.id, to: n.id, weight: 1 })); }
  if (type === 'target' && connect) { const m = mixes().find((x) => !B.edges.some((e) => e.from === x.id)); if (m) B.edges.push({ from: m.id, to: n.id }); }
  if (quiet) return n;
  sel = new Set([n.id]); touch(); render();
  if (!at && view.k) { const r = $('stage').getBoundingClientRect(); const [wx, wy] = toWorld(r.left + r.width / 2, r.top + r.height / 2); if (Math.abs(wx - n.x) > r.width / view.k / 2 || Math.abs(wy - n.y) > r.height / view.k / 2) fit(); }
  return n;
}
// Duplicate copies the card only (no connections), 24px down and right; a source gets the next letter
function duplicate(ids) {
  const made = [];
  for (const id of ids) {
    const n = node(id); if (!n) continue;
    let i = 1; while (node(`${n.id}-copy${i > 1 ? i : ''}`)) i++;
    const c = { ...JSON.parse(JSON.stringify(clean(n))), id: `${n.id}-copy${i > 1 ? i : ''}`, x: n.x + 24, y: n.y + 24 };
    if (n.type === 'source') { c.tag = nextTag(); if (info[n.id]) info[c.id] = info[n.id]; }
    B.nodes.push(c); made.push(c);
  }
  sel = new Set(made.map((n) => n.id)); touch(); render();
}
function connect(from, to) {
  const a = node(from), z = node(to);
  if (!(a.type === 'source' && z.type === 'mix') && !(a.type === 'mix' && z.type === 'target')) return toast('Connect Source → Mix or Mix → Target');
  if (z.type === 'target') B.edges = B.edges.filter((e) => e.to !== z.id); // one mix per target
  if (!B.edges.some((e) => e.from === from && e.to === to)) B.edges.push(a.type === 'source' ? { from, to, weight: 1 } : { from, to });
  touch([z.type === 'mix' ? z : null]); render();
}
function removeNodes(ids) {
  B.nodes = B.nodes.filter((n) => !ids.includes(n.id)); B.edges = B.edges.filter((e) => !ids.includes(e.from) && !ids.includes(e.to));
  if (drawer && (ids.includes(drawer.mix) || ids.includes(drawer.src))) drawer = null;
  sel.clear(); selEdge = null; touch(); render(); renderDrawer();
}
function removeSelected() {
  if (selEdge != null) { B.edges.splice(selEdge, 1); selEdge = null; touch(); render(); if (drawer && !edgeOf(drawer.mix, drawer.src)) closeDrawer(); }
  else removeNodes([...sel]);
}
function setField(el, commit) {
  const n = node(el.closest('.n').dataset.id), f = el.dataset.f; let v = el.type === 'checkbox' ? el.checked : el.value;
  const obj = el.dataset.e ? B.edges.find((e) => e.from === el.dataset.e && e.to === n.id) : n;
  if (f === 'schema' && v === '__new__') { el.value = n.schema || 'default'; openSchema(n.id, { fresh: true }); return; }
  if (f === 'target' && v === '__new__') { const name = prompt('New file name', 'new-file.duckdb'); if (!name) return render(); v = name.endsWith('.duckdb') ? name : name + '.duckdb'; obj.mode = 'create'; }
  else if (f === 'target') obj.mode = targets.includes(v) ? 'append' : 'create';
  if (f === 'url') { delete obj.url; delete obj.target; if (/^[\w.-]+\.duckdb$/.test(v.trim()) && targets.includes(v.trim())) obj.target = v.trim(); else if (v.trim()) obj.url = v.trim(); }
  else if (['n', 'weight'].includes(f)) obj[f] = v === '' ? (f === 'n' ? 500 : 0) : Math.max(0, +v || 0);
  else if (f === 'max_per_value') { if (/^\d+$/.test(v) && +v > 1) obj[f] = +v; else delete obj[f]; }
  else if (f === 'limit') obj.limit = /^\d+$/.test(v) ? +v : v.trim() || undefined;
  else if (v === '' || v === false) delete obj[f]; else obj[f] = v;
  if (f === 'stratify_by' && v === '') obj.stratify_by = ''; // keep the Stratify mode while the field is empty
  if (f === 'top_column') { saved = false; status(); return render(); }
  if (n.type === 'source' && ['url', 'table', 'limit'].includes(f)) delete info[n.id];
  const ms = n.type === 'mix' ? [n] : n.type === 'source' ? B.edges.filter((e) => e.from === n.id).map((e) => node(e.to)) : [];
  if (n.type === 'target' && f === 'target') { saved = false; status(); } else touch(ms);
  if (f === 'schema') { for (const k of Object.keys(edgeI)) if (k.startsWith(n.id + ':')) delete edgeI[k]; fields(v).then(() => { render(); renderDrawer(); }); }
  if (commit) render(); else { const hold = document.activeElement; render(); hold?.focus?.(); wires(); }
}
const W_ = $('world');
W_.addEventListener('input', (ev) => { if (ev.target.dataset.f && ev.target.tagName === 'INPUT' && ev.target.type !== 'checkbox') setField(ev.target, false); });
W_.addEventListener('change', (ev) => { if (ev.target.dataset.f) { if (ev.target.tagName === 'INPUT' && ev.target.type !== 'checkbox') ev.target.blur(); setField(ev.target, true); } });
W_.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') { const n = node(ev.target.closest('.n')?.dataset.id); ev.target.blur(); if (!n) return; render(); if (n.type === 'source' && !info[n.id]) loadSource(n); } });
W_.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-act]'); if (!b || !b.closest('.n')) return;
  const n = node(b.closest('.n').dataset.id), a = b.dataset.act;
  if (a === 'load') loadSource(n);
  else if (a === 'edit') { n._edit = true; delete errs[n.id]; delete cancelledLoad[n.id]; render(); }
  else if (a === 'cancel') { delete n._edit; render(); }
  else if (a === 'collapse' || a === 'expand') { n.collapsed = a === 'collapse'; saved = false; status(); render(); relayout(); }
  else if (a === 'mode') { n.mode = b.dataset.v; saved = false; status(); render(); }
  else if (a === 'write') write(n);
  else if (a === 'cancelload') { const j = loading[n.id]?.job; if (j) { cancelJob(j); loading[n.id].st = { ...loading[n.id].st, phase: 'Cancelling…' }; render(); } }
  else if (a === 'cancelwrite') { const j = writing[n.id]?.job; if (j) { cancelJob(j); writing[n.id].st = { ...writing[n.id].st, cancelled: true }; render(); } }
  else if (a === 'map') { const s = b.dataset.e; drawer?.mode === 'map' && drawer.mix === n.id && drawer.src === s ? closeDrawer() : openMap(n.id, s); }
  else if (a === 'schema') { drawer?.mode === 'schema' && drawer.mix === n.id ? closeDrawer() : openSchema(n.id); }
  else if (a === 'adv') { n._adv = !n._adv; render(); }
  else if (a === 'spread') {
    const v = b.dataset.v; n._spread = v;
    if (v !== 'stratify') delete n.stratify_by; if (v !== 'balance') delete n.balance;
    if (v === 'stratify' && n.stratify_by == null) n.stratify_by = '';
    touch([n]); render();
  }
  else if (a === 'menu') { ev.stopPropagation(); showMenu(n, b); }
  else if (a === 'locate' || a === 'replace') pickFile(n);
  else if (a === 'remove') removeNodes([n.id]);
});

// ---- node "..." menu (also on right-click) ----
function showMenu(n, anchor, at) {
  const m = $('nodeMenu'), r = $('stage').getBoundingClientRect();
  const items = n.type === 'source'
    ? [['edit', 'Edit source', 'E', 'edit'], ['reload', 'Reload', 'R', 'reroll'], ['dup', 'Duplicate', 'Ctrl D', 'copy'], ...(isFile(n) ? [['replace', 'Replace file…', '', 'swap']] : []), '-', ['remove', 'Remove', 'Del', 'trash']]
    : n.type === 'mix' ? [['schema', 'Edit schema', '', 'edit'], ['dup', 'Duplicate', 'Ctrl D', 'copy'], '-', ['remove', 'Remove', 'Del', 'trash']]
      : [['dup', 'Duplicate', 'Ctrl D', 'copy'], '-', ['remove', 'Remove', 'Del', 'trash']];
  m.innerHTML = items.map((x) => (x === '-' ? '<hr>' : `<button data-m="${x[0]}" class="${x[0] === 'remove' ? 'bad' : ''}">${icon(x[3])}<span>${x[1]}</span><kbd>${x[2]}</kbd></button>`)).join('');
  icons(m);
  const p = at || (() => { const a = anchor.getBoundingClientRect(); return [a.right - 216, a.bottom + 4]; })();
  m.style.left = Math.max(8, p[0] - r.left) + 'px'; m.style.top = p[1] - r.top + 'px'; m.hidden = false; menuFor = n.id; render();
  m.querySelectorAll('button').forEach((b) => { b.onclick = () => { hideMenu(); nodeAction(n, b.dataset.m); }; });
}
function hideMenu() { if (!$('nodeMenu').hidden) { $('nodeMenu').hidden = true; menuFor = null; render(); } }
function nodeAction(n, a) {
  if (a === 'edit') { n._edit = true; delete errs[n.id]; render(); }
  else if (a === 'reload') loadSource(n, { fresh: true });
  else if (a === 'dup') duplicate([n.id]);
  else if (a === 'replace') pickFile(n);
  else if (a === 'remove') removeNodes([n.id]);
  else if (a === 'schema') openSchema(n.id);
}
let pickFor = null;
function pickFile(n) { pickFor = n.id; $('filePick').value = ''; $('filePick').click(); }
$('filePick').onchange = () => { const f = $('filePick').files[0], n = node(pickFor); if (!f || !n) return; if (!OK_EXT.test(f.name)) return toast(`Can’t add ${f.name}: use Parquet, CSV, JSON, JSONL or DuckDB`, null, true); uploadInto(n, f); };

// ---- drawer events ----
$('drawer').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-dact]'); if (!b) return;
  const a = b.dataset.dact;
  if (a === 'close') closeDrawer();
  else if (a === 'back') openMap(drawer.mix, drawer.back);
  else if (a === 'editschema') openSchema(drawer.mix, { back: drawer.src });
  else if (a === 'savesch') saveSchema();
  else if (a === 'reset') { setEdge({ mapping: undefined, metadata: undefined }); fetchEdge(); }
  else if (a === 'fix') { setEdge({ mapping: mapDiff({ ...SieveUI.readMapping($('dfields')), [b.dataset.field]: [b.dataset.col] }) }); fetchEdge(); }
  else if (a === 'addmeta') SieveUI.addMetaRow($('dmeta'), edgeI[dkey()]?.columns.map((c) => c.name) || []);
});
$('dset').addEventListener('toggle', (ev) => { if (drawer) drawer.setOpen = ev.target.open; }, true);
SieveUI.bindMapping($('dfields'), (mp) => setEdge({ mapping: mapDiff(mp) }));
SieveUI.bindMetadata($('dmeta'), () => edgeI[dkey()]?.columns.map((c) => c.name) || [], (list) => setEdge({ metadata: list }));
$('dMetaH').addEventListener('change', (ev) => { if (ev.target.dataset.dm === 'target_column') { node(drawer.mix).target_column = ev.target.value || null; touch([node(drawer.mix)]); render(); } });

// ---- canvas interaction: marquee select, pan (Space / middle drag), drag nodes, connect ports ----
let drag = null, space = false;
$('stage').addEventListener('mousedown', (ev) => {
  $('openMenu').hidden = true; if (!ev.target.closest('#dropMenu')) $('dropMenu').hidden = true;
  if (!ev.target.closest('#nodeMenu')) hideMenu();
  if (ev.target.closest('#empty .card0, .zoom, #dropMenu, #nodeMenu, #drawer, #groupBar')) return;
  const p = ev.target.closest('.port.out'), nd = ev.target.closest('.n'), edge = ev.target.closest('[data-edge]'), pill = ev.target.closest('[data-pill]');
  if (ev.button === 1 || (space && ev.button === 0)) { drag = { pan: true, sx: ev.clientX - view.x, sy: ev.clientY - view.y }; $('stage').classList.add('panning'); ev.preventDefault(); return; }
  if (ev.button !== 0) return;
  if (pill) { const [mId, sId] = pill.dataset.pill.split(':'); openMap(mId, sId); return; }
  if (!nd && !edge) { // marquee: nodes it touches are selected live (Shift adds to the selection)
    const [wx, wy] = toWorld(ev.clientX, ev.clientY);
    if (!ev.shiftKey) { sel.clear(); selEdge = null; render(); }
    drag = { box: true, x0: wx, y0: wy, base: new Set(sel) }; ev.preventDefault(); return;
  }
  if (edge) { selEdge = +edge.dataset.edge; sel.clear(); render(); return; }
  if (p) { drag = { wire: nd.dataset.id }; document.body.classList.add('wiring'); ev.preventDefault(); return; }
  const id = nd.dataset.id; selEdge = null;
  if (ev.shiftKey) { sel.has(id) ? sel.delete(id) : sel.add(id); } else if (!sel.has(id)) sel = new Set([id]);
  document.querySelectorAll('.n').forEach((el) => el.classList.toggle('sel', sel.has(el.dataset.id))); groupUI();
  if (ev.target.closest('.nh') && !ev.target.closest('button')) { const [wx, wy] = toWorld(ev.clientX, ev.clientY); drag = { move: [...sel].map((s) => ({ n: node(s), dx: wx - node(s).x, dy: wy - node(s).y })), moved: false }; }
});
window.addEventListener('mousemove', (ev) => {
  if (!drag) return;
  if (drag.pan) { view.x = ev.clientX - drag.sx; view.y = ev.clientY - drag.sy; applyView(); return; }
  const [wx, wy] = toWorld(ev.clientX, ev.clientY);
  if (drag.box) {
    const x0 = Math.min(drag.x0, wx), y0 = Math.min(drag.y0, wy), x1 = Math.max(drag.x0, wx), y1 = Math.max(drag.y0, wy);
    Object.assign($('marquee').style, { left: x0 + 'px', top: y0 + 'px', width: x1 - x0 + 'px', height: y1 - y0 + 'px' }); $('marquee').hidden = false;
    sel = new Set(drag.base);
    for (const n of B.nodes) if (n.x < x1 && n.x + widthOf(n) > x0 && n.y < y1 && n.y + heightOf(n) > y0) sel.add(n.id);
    document.querySelectorAll('.n').forEach((el) => el.classList.toggle('sel', sel.has(el.dataset.id))); groupUI();
    return;
  }
  if (drag.move) {
    drag.moved = true;
    for (const m of drag.move) { delete m.n._auto; m.n.x = Math.round(wx - m.dx); m.n.y = Math.round(wy - m.dy); const el = document.querySelector(`.n[data-id="${CSS.escape(m.n.id)}"]`); el.style.left = m.n.x + 'px'; el.style.top = m.n.y + 'px'; }
    wires(); groupUI(); return;
  }
  const a = node(drag.wire), p1 = portXY(`out:${a.id}`), dx = (wx - p1[0]) * 0.55, c = a.type === 'source' ? color(a) : 'var(--mute)';
  wires({ d: `M${p1} C${p1[0] + dx},${p1[1]} ${wx - dx},${wy} ${wx},${wy}`, c });
  const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.n'), ok = over && ((a.type === 'source' && over.classList.contains('mix')) || (a.type === 'mix' && over.classList.contains('target')));
  document.querySelectorAll('.port.hot').forEach((x) => x.classList.remove('hot')); document.querySelectorAll('.plabel').forEach((x) => x.remove());
  if (ok) { const pt = over.querySelector(`[data-port="in:${over.dataset.id}"]`); pt.classList.add('hot'); pt.insertAdjacentHTML('afterend', `<span class="plabel" style="left:-84px;top:18px">${a.type === 'source' ? 'Mix input' : 'Target input'}</span>`); }
});
window.addEventListener('mouseup', (ev) => {
  if (drag?.wire) {
    document.body.classList.remove('wiring');
    document.querySelectorAll('.port.hot').forEach((x) => x.classList.remove('hot')); document.querySelectorAll('.plabel').forEach((x) => x.remove());
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.n');
    if (over && over.dataset.id !== drag.wire) connect(drag.wire, over.dataset.id);
    else if (!over && ev.target.closest('#stage')) dropMenu(drag.wire, ev); else wires();
  }
  if (drag?.box) { $('marquee').hidden = true; render(); }
  if (drag?.move && drag.moved) { saved = false; status(); }
  drag = null; $('stage').classList.remove('panning');
});
$('stage').addEventListener('contextmenu', (ev) => { const nd = ev.target.closest('.n'); if (!nd || ev.target.closest('input,textarea,select')) return; ev.preventDefault(); sel = new Set([nd.dataset.id]); showMenu(node(nd.dataset.id), null, [ev.clientX, ev.clientY]); });
function dropMenu(from, ev) { // dropped a wire on empty canvas: add the next node there
  const a = node(from), types = a.type === 'source' ? ['mix', 'target'] : ['target'], m = $('dropMenu'), r = $('stage').getBoundingClientRect(), at = toWorld(ev.clientX, ev.clientY);
  m.style.left = ev.clientX - r.left + 'px'; m.style.top = ev.clientY - r.top + 'px';
  m.innerHTML = types.map((t) => `<button data-t="${t}">Add ${t[0].toUpperCase() + t.slice(1)} here</button>`).join(''); m.hidden = false;
  m.querySelectorAll('button').forEach((b) => { b.onclick = () => { m.hidden = true; const n = addNode(b.dataset.t, [Math.round(at[0]), Math.round(at[1] - 20)]); if (b.dataset.t === 'mix' || a.type === 'mix') connect(from, n.id); render(); }; });
  wires();
}
$('groupBar').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (!b) return; if (b.dataset.g === 'dup') duplicate([...sel]); else removeNodes([...sel]); });
$('stage').addEventListener('dblclick', (ev) => { if (!ev.target.closest('.n,.zoom,#empty .card0,#drawer,#groupBar')) { const at = toWorld(ev.clientX, ev.clientY); addNode('source', [Math.round(at[0]), Math.round(at[1])]); } });
const zoomAt = (k, cx, cy) => { k = Math.min(2, Math.max(0.25, k)); view.x = cx - ((cx - view.x) * k) / view.k; view.y = cy - ((cy - view.y) * k) / view.k; view.k = k; applyView(); };
$('stage').addEventListener('wheel', (ev) => { if (ev.target.closest('#drawer')) return; ev.preventDefault(); const r = $('stage').getBoundingClientRect(); zoomAt(view.k * Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top); }, { passive: false });
const zc = (f) => () => { const r = $('stage').getBoundingClientRect(); zoomAt(view.k * f, r.width / 2, r.height / 2); };
$('zIn').onclick = zc(1.2); $('zOut').onclick = zc(1 / 1.2); $('zFit').onclick = () => fit();
window.addEventListener('keydown', (ev) => {
  const typing = ev.target.closest?.('input,textarea,select'), mod = ev.ctrlKey || ev.metaKey;
  if (ev.key === 'Escape') {
    if (!$('nodeMenu').hidden) return hideMenu();
    if (typing && ev.target.id !== 'bname') return ev.target.blur();
    if (drawer) return closeDrawer();
    sel.clear(); selEdge = null; return render();
  }
  if (typing) return;
  if (ev.code === 'Space') { space = true; ev.preventDefault(); return; }
  if (['Delete', 'Backspace'].includes(ev.key) && (sel.size || selEdge != null)) return removeSelected();
  if (mod && ev.key.toLowerCase() === 'a') { ev.preventDefault(); sel = new Set(B.nodes.map((n) => n.id)); return render(); }
  if (mod && ev.key.toLowerCase() === 'd' && sel.size) { ev.preventDefault(); return duplicate([...sel]); }
  const one = sel.size === 1 ? node([...sel][0]) : null;
  if (!mod && one?.type === 'source' && ev.key.toLowerCase() === 'e') return nodeAction(one, 'edit');
  if (!mod && one?.type === 'source' && ev.key.toLowerCase() === 'r') return nodeAction(one, 'reload');
  const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
  if (d && sel.size) { ev.preventDefault(); const s = ev.shiftKey ? 24 : 8; for (const id of sel) { const n = node(id); delete n._auto; n.x += d[0] * s; n.y += d[1] * s; } saved = false; status(); render(); }
});
window.addEventListener('keyup', (ev) => { if (ev.code === 'Space') space = false; });

// ---- drop files onto the canvas ----
let dragDepth = 0;
const hasFiles = (ev) => [...(ev.dataTransfer?.types || [])].includes('Files');
const OK_MIME = ['', 'text/csv', 'text/tab-separated-values', 'application/json', 'application/x-ndjson', 'application/jsonl', 'application/octet-stream', 'application/vnd.apache.parquet', 'application/x-parquet', 'text/plain'];
function overlay(ev) {
  const items = [...(ev.dataTransfer?.items || [])].filter((i) => i.kind === 'file'), k = items.length;
  const bad = items.some((i) => !OK_MIME.includes(i.type));
  const tgt = k === 1 && document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.n.source'), tn = tgt && node(tgt.dataset.id);
  const o = $('dropOv'); o.hidden = false; o.classList.toggle('bad', bad);
  const t0 = nextTag(), chips = Array.from({ length: k }, (_, i) => tagChip({ tag: t0 + i }, true)).join(' ');
  const key = `${k}|${bad}|${tn?.id || ''}`; if (o.dataset.k === key) return; o.dataset.k = key;
  o.innerHTML = `<div class="frame"><div class="mid"><div class="up">${icon('upload')}</div>
    <h3>${bad ? 'Can’t add this file' : tn && isFile(tn) ? `Drop to replace ${esc(srcKind(tn).t)}` : `Drop to add ${k} source${k === 1 ? '' : 's'}`}</h3>
    <p>${bad ? 'Use Parquet, CSV, JSON, JSONL or DuckDB' : tn && isFile(tn) ? 'mapping is re-checked' : 'Parquet, CSV, JSON, JSONL or DuckDB'}</p>
    ${!bad && !(tn && isFile(tn)) ? `<div class="fchips">${chips}</div><p class="small">Next letter${k === 1 ? '' : 's'} reserved for ${k === 1 ? 'this file' : 'these files'}</p>` : ''}</div></div>`;
  icons(o);
}
window.addEventListener('dragenter', (ev) => { if (!hasFiles(ev)) return; dragDepth++; overlay(ev); ev.preventDefault(); });
window.addEventListener('dragover', (ev) => { if (!hasFiles(ev)) return; ev.preventDefault(); overlay(ev); });
window.addEventListener('dragleave', (ev) => { if (!hasFiles(ev)) return; if (--dragDepth <= 0) { dragDepth = 0; $('dropOv').hidden = true; $('dropOv').dataset.k = ''; } });
window.addEventListener('drop', (ev) => {
  if (!hasFiles(ev)) return; ev.preventDefault(); dragDepth = 0; $('dropOv').hidden = true; $('dropOv').dataset.k = '';
  const files = [...ev.dataTransfer.files]; if (!files.length) return;
  const tgt = files.length === 1 && document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.n.source'), tn = tgt && node(tgt.dataset.id);
  if (tn && isFile(tn)) { if (!OK_EXT.test(files[0].name)) return toast(`Can’t add ${files[0].name}`, null, true); return uploadInto(tn, files[0]); }
  addFiles(files, toWorld(ev.clientX, ev.clientY));
});

// ---- top bar: board name (click to edit, Enter keeps the name, Esc reverts), seed, open, save ----
$('addSource').onclick = () => addNode('source'); $('addMix').onclick = () => addNode('mix'); $('addTarget').onclick = () => addNode('target');
let nameBefore = '';
function nameCheck(suggest) {
  const v = $('bname').value.trim(), ok = nameOk(), fix = v.replace(/[\s/\\]+/g, '-').replace(/[^\w.-]/g, '').replace(/^[.-]+/, '');
  $('bname').classList.toggle('bad', !ok);
  $('bnameErr').hidden = ok;
  $('bnameErr').innerHTML = ok ? '' : `Use letters, digits, _ . - (no spaces)${suggest && fix && NAME_RE.test(fix) ? ` · <button class="lnk acc" id="bnameFix">use “${esc(fix)}”</button>` : ''}`;
  if ($('bnameFix')) $('bnameFix').onmousedown = (e) => { e.preventDefault(); $('bname').value = fix; B.name = fix; nameCheck(); render(); };
  $('saveB').disabled = !srcs().length || !ok;
}
$('bname').onfocus = () => { nameBefore = $('bname').value; setTimeout(() => $('bname').select(), 0); };
$('bname').oninput = () => { nameCheck(); };
$('bname').onkeydown = (e) => { if (e.key === 'Enter') $('bname').blur(); if (e.key === 'Escape') { $('bname').value = nameBefore; nameCheck(); $('bname').blur(); } };
$('bname').onblur = () => { const v = $('bname').value.trim(); if (v !== (B.name || '')) { B.name = v; saved = false; status(); } nameCheck(true); };
$('seed').onchange = () => { B.seed = +$('seed').value || 0; touch(); render(); };
$('reroll').onclick = () => { $('seed').value = Math.floor(Math.random() * 100000); $('seed').onchange(); };
$('saveB').onclick = () => save().catch((e) => toast(e.message, null, true));
$('openB').onclick = (ev) => { ev.stopPropagation(); $('openMenu').hidden ? openMenu() : ($('openMenu').hidden = true); };
document.addEventListener('mousedown', (ev) => { if (!ev.target.closest('.menuwrap')) $('openMenu').hidden = true; });
icons(document.body);
(async () => {
  schemas = (await api('/api/schemas')).map((s) => s.name); targets = (await api('/api/targets')).map((t) => t.name);
  await fields('default');
  const q = new URLSearchParams(location.search).get('board');
  saved = false; status(); render();
  if (q) await openBoard(q).catch((e) => toast(e.message, null, true));
})();
