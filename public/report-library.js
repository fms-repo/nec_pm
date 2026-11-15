/* =========================================================
   REPORT LIBRARY page (sidebar: Report Library).
   Tabs: Catalogue · Builder · Scheduled · History · Templates · Access log (administrator).
   The page only asks the server to generate / list / schedule — every report is worked out on the server and stored as a
   snapshot (see reports.js), then opened in report-print.html. Uses the dashboard's api, esc and showToast helpers.
   ========================================================= */
(function () {
  'use strict';
  const RL = {
    el: null, cat: null, tab: 'catalogue', loadedAt: 0, openMs: null,
    scope: { businessUnitIds: [], projectIds: [], statuses: [], period: { preset: '', from: '', to: '' }, layout: '' },
    builder: { blocks: [], name: '', shared: false, editingId: null }, defs: null,
    hist: { q: '', reportKey: '', projectId: '', source: '', from: '', to: '', mine: false, inbox: false, offset: 0 }, histData: null,
    catFilter: '', scheds: null, log: { q: '', user: '', action: '', from: '', to: '', offset: 0 }, logData: null, recent: null, sm: null
  };
  const CAT_ORDER = ['Management', 'Progress & schedule', 'Financial', 'Risk & issues', 'Contractors', 'Handover & closeout', 'Governance'];
  const LOG_ACTIONS = { 'report-generated': 'Generated', 'report-viewed': 'Opened', 'report-downloaded': 'Downloaded (Excel)', 'report-printed': 'Printed / saved as PDF', 'report-schedule-created': 'Schedule created',
    'report-schedule-changed': 'Schedule changed', 'report-schedule-paused': 'Schedule paused', 'report-schedule-resumed': 'Schedule resumed', 'report-schedule-deleted': 'Schedule deleted' };
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const q = (sel, root) => (root || RL.el).querySelector(sel);
  const qa = (sel, root) => [...(root || RL.el).querySelectorAll(sel)];
  const pad = n => String(n).padStart(2, '0');
  const fD = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : '—'; };
  const fDT = s => { if (!s) return '—'; const d = new Date(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : String(s).replace(' ', 'T') + 'Z'); return isNaN(d) ? '—' : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const sleepy = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  /* ---------- entry point (called by the dashboard each time the page is shown) ---------- */
  async function render(el) {
    if (RL.el === el && RL.cat) { if (Date.now() - RL.loadedAt > 20000) refreshCatalogue(); return; }
    RL.el = el;
    el.innerHTML = `<div class="inv-empty-hint"><i class="bi bi-hourglass-split" style="font-size:1.4rem;"></i><br>Opening the Report Library…</div>`;
    try { RL.cat = await api.get('/api/reports/catalogue'); RL.loadedAt = Date.now(); }
    catch (e) { el.innerHTML = `<div class="inv-empty-hint">${esc(e.message)}</div>`; return; }
    if (!RL.cat.isAdmin && RL.tab === 'log') RL.tab = 'catalogue';
    draw();
  }
  async function refreshCatalogue() {
    try { RL.cat = await api.get('/api/reports/catalogue'); RL.loadedAt = Date.now(); } catch (e) { return; }
    const b = q('#rlInboxBadge'); if (b) { b.textContent = RL.cat.unread; b.hidden = !RL.cat.unread; }
  }

  function draw() {
    const c = RL.cat, tabs = [['catalogue', 'bi-grid-3x3-gap', 'Catalogue'], ['builder', 'bi-sliders', 'Builder'], ['scheduled', 'bi-calendar-check', 'Scheduled'], ['history', 'bi-clock-history', 'History'], ['templates', 'bi-file-earmark-richtext', 'Templates']];
    if (c.isAdmin) tabs.push(['log', 'bi-shield-check', 'Access log']);
    RL.el.innerHTML = `
      <div class="rl-head">
        <div><div class="section-title"><i class="bi bi-journal-text"></i>Report Library</div>
          <div class="rl-sub">Standard, scheduled and custom reports in one place. Every report is generated from live data, saved as it was on the day, and can be opened again, printed to PDF or downloaded as Excel.</div></div>
        <button type="button" class="sp-btn rl-inbox" id="rlInbox" title="Reports delivered to you by a schedule"><i class="bi bi-inbox"></i>Inbox <span class="rl-badge" id="rlInboxBadge" ${c.unread ? '' : 'hidden'}>${c.unread}</span></button>
      </div>
      <div class="rl-tabs">${tabs.map(t => `<button type="button" class="rl-tab ${RL.tab === t[0] ? 'active' : ''}" data-tab="${t[0]}"><i class="bi ${t[1]}"></i>${t[2]}</button>`).join('')}</div>
      <div id="rlBody"></div>`;
    qa('.rl-tab').forEach(b => b.addEventListener('click', () => { RL.tab = b.dataset.tab; RL.openMs = null; draw(); }));
    q('#rlInbox').addEventListener('click', () => { RL.tab = 'history'; RL.hist = { ...RL.hist, inbox: true, offset: 0 }; draw(); });
    ({ catalogue: drawCatalogue, builder: drawBuilder, scheduled: drawScheduled, history: drawHistory, templates: drawTemplates, log: drawLog }[RL.tab] || drawCatalogue)();
  }

  /* ---------- scope controls (shared by the page and the schedule form) ---------- */
  function msHtml(id, label, opts, sel, allText) {
    const n = sel.length, one = n === 1 ? opts.find(o => String(o.value) === String(sel[0])) : null;
    const text = n === 0 ? allText : n === 1 ? (one ? one.label : '1 selected') : `${n} selected`;
    return `<div class="rl-f"><label class="rl-l">${label}</label><div class="ms-dropdown" data-ms="${id}">
      <button type="button" class="ms-toggle"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(text)}</span><i class="bi bi-chevron-down"></i></button>
      <div class="ms-menu${RL.openMs === id ? ' show' : ''}" style="max-height:260px;overflow-y:auto;">
        ${opts.length ? opts.map(o => `<label><input type="checkbox" value="${esc(o.value)}" ${sel.map(String).includes(String(o.value)) ? 'checked' : ''}> ${esc(o.label)}</label>`).join('') : '<div class="rl-mut" style="padding:6px 8px;">Nothing to choose</div>'}
        <div class="ms-actions"><button type="button" data-clear>Clear</button><button type="button" data-done>Done</button></div></div></div></div>`;
  }
  function projectsIn(st) {
    return RL.cat.projects.filter(p => (!st.businessUnitIds.length || st.businessUnitIds.includes(p.businessUnitId || 0)) && (!st.statuses.length || st.statuses.includes(p.status)));
  }
  function inScope(st) { const base = projectsIn(st); return st.projectIds.length ? base.filter(p => st.projectIds.includes(p.id)) : base; }
  function scopeBarHtml(st, pre, o) {
    const c = RL.cat, projOpts = projectsIn(st).map(p => ({ value: p.id, label: `${p.code} — ${p.name}` }));
    const periods = c.periods.filter(p => !(o.relative && p.key === 'custom'));
    const n = inScope(st).length;
    return `${msHtml(pre + ':bu', 'Business unit', c.businessUnits.map(b => ({ value: b.id, label: `${b.name} (${b.projectCount})` })), st.businessUnitIds, 'All business units')}
      ${msHtml(pre + ':proj', 'Projects', projOpts, st.projectIds, `All projects (${projOpts.length})`)}
      ${msHtml(pre + ':st', 'Project status', c.statuses.map(s => ({ value: s, label: s })), st.statuses, 'Any status')}
      <div class="rl-f"><label class="rl-l">Period</label><select data-f="period">${o.deflt ? `<option value="" ${st.period.preset === '' ? 'selected' : ''}>Each report's own default</option>` : ''}${periods.map(p => `<option value="${p.key}" ${st.period.preset === p.key ? 'selected' : ''}>${p.label}</option>`).join('')}</select></div>
      ${st.period.preset === 'custom' ? `<div class="rl-f"><label class="rl-l">From</label><input type="date" data-f="from" value="${esc(st.period.from)}"></div><div class="rl-f"><label class="rl-l">To</label><input type="date" data-f="to" value="${esc(st.period.to)}"></div>` : ''}
      <div class="rl-f"><label class="rl-l">Layout</label><select data-f="layout"><option value="">Report's default</option>${c.layouts.map(l => `<option value="${l.key}" ${st.layout === l.key ? 'selected' : ''}>${l.title}</option>`).join('')}</select></div>
      <span class="rl-count-pill ${n ? '' : 'warn'}">${n ? `${n} project${n === 1 ? '' : 's'} in scope` : 'No projects match'}</span>`;
  }
  function wireScope(root, st, pre, onChange) {
    const set = (key, vals) => {
      if (key === 'bu') st.businessUnitIds = vals.map(Number);
      if (key === 'proj') st.projectIds = vals.map(Number);
      if (key === 'st') st.statuses = vals;
      const ok = new Set(projectsIn(st).map(p => p.id)); st.projectIds = st.projectIds.filter(id => ok.has(id));
      onChange();
    };
    qa('[data-ms]', root).forEach(box => {
      const id = box.dataset.ms, key = id.split(':')[1], menu = q('.ms-menu', box);
      menu.addEventListener('click', e => e.stopPropagation());
      q('.ms-toggle', box).addEventListener('click', e => { e.stopPropagation(); const open = menu.classList.contains('show'); document.querySelectorAll('.ms-menu.show').forEach(m => m.classList.remove('show')); menu.classList.toggle('show', !open); RL.openMs = open ? null : id; });
      qa('input[type=checkbox]', menu).forEach(cb => cb.addEventListener('change', () => set(key, qa('input[type=checkbox]', menu).filter(x => x.checked).map(x => x.value))));
      q('[data-clear]', menu).addEventListener('click', () => set(key, []));
      q('[data-done]', menu).addEventListener('click', () => { menu.classList.remove('show'); RL.openMs = null; });
    });
    const f = n => q(`[data-f="${n}"]`, root);
    if (f('period')) f('period').addEventListener('change', e => { st.period.preset = e.target.value; if (st.period.preset === 'custom' && !st.period.from) { const t = RL.cat.today; st.period.from = t.slice(0, 8) + '01'; st.period.to = t; } onChange(); });
    if (f('from')) f('from').addEventListener('change', e => { st.period.from = e.target.value; });
    if (f('to')) f('to').addEventListener('change', e => { st.period.to = e.target.value; });
    if (f('layout')) f('layout').addEventListener('change', e => { st.layout = e.target.value; });
  }
  const scopePayload = (st, extra) => Object.assign({ businessUnitIds: st.businessUnitIds, projectIds: st.projectIds, statuses: st.statuses, layout: st.layout || undefined, period: st.period.preset ? { ...st.period } : undefined }, extra);

  /* ---------- generate ---------- */
  async function generate(payload, btn) {
    const w = window.open('about:blank', '_blank'); // opened first so the browser's pop-up blocker allows it
    const label = btn && btn.innerHTML; if (btn) { btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i>Generating…'; }
    try {
      const run = await api.post('/api/reports/runs', payload);
      if (w) w.location.href = '/report-print.html?run=' + run.id; else showToast(`${run.ref} generated — open it from History`);
      afterGenerate();
    } catch (e) { if (w) w.close(); showToast(e.message, 'error'); }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = label; } }
  }
  function afterGenerate() { RL.recent = null; RL.histData = null; if (RL.tab === 'catalogue') loadRecent(); }

  /* ---------- Catalogue ---------- */
  function drawCatalogue() {
    const body = q('#rlBody'), c = RL.cat;
    const groups = CAT_ORDER.map(g => [g, c.reports.filter(r => r.category === g)]).filter(x => x[1].length);
    body.innerHTML = `
      <div class="rl-scope" id="rlScope">${scopeBarHtml(RL.scope, 'rlS', { deflt: true })}</div>
      <div class="rl-chips"><button type="button" class="rl-chip ${RL.catFilter ? '' : 'on'}" data-cat="">All reports <span>${c.reports.length}</span></button>${groups.map(([g, list]) => `<button type="button" class="rl-chip ${RL.catFilter === g ? 'on' : ''}" data-cat="${esc(g)}">${esc(g)} <span>${list.length}</span></button>`).join('')}</div>
      <div class="rl-grid">${c.reports.filter(r => !RL.catFilter || r.category === RL.catFilter).sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category)).map(cardHtml).join('')}</div>
      <div class="rl-recent"><div class="rl-cat-title">Recently generated</div><div id="rlRecent"><div class="rl-mut">Loading…</div></div></div>`;
    const rewire = () => { q('#rlScope').innerHTML = scopeBarHtml(RL.scope, 'rlS', { deflt: true }); wireScope(q('#rlScope'), RL.scope, 'rlS', rewire); };
    wireScope(q('#rlScope'), RL.scope, 'rlS', rewire);
    qa('[data-cat]').forEach(b => b.addEventListener('click', () => { RL.catFilter = b.dataset.cat; drawCatalogue(); }));
    qa('[data-gen]').forEach(b => b.addEventListener('click', () => {
      const card = b.closest('.rl-card'), opts = qa('[data-opt]:checked', card).map(x => x.dataset.opt);
      generate(scopePayload(RL.scope, { reportKey: b.dataset.gen, options: opts }), b);
    }));
    qa('[data-sched]').forEach(b => b.addEventListener('click', () => openSchedule({ reportKey: b.dataset.sched })));
    loadRecent();
  }
  function cardHtml(r) {
    return `<div class="rl-card ${r.available ? '' : 'off'}">
      <div class="rl-card-top"><div class="rl-ico"><i class="bi ${r.icon}"></i></div><div><div class="rl-eyebrow">${esc(r.category)}</div><h4>${esc(r.title)}</h4><span class="rl-tag">${esc(r.tag)}</span></div></div>
      <p>${esc(r.description)}</p>
      <div class="rl-inc"><b>Includes:</b> ${r.sections.map(esc).join(' · ')}</div>
      ${(r.optional || []).map(o => `<label class="rl-opt"><input type="checkbox" data-opt="${esc(o.key)}" ${r.available ? '' : 'disabled'}> ${esc(o.label)}</label>`).join('')}
      <div class="rl-card-foot"><span class="rl-aud"><i class="bi bi-people"></i> ${esc(r.audience)}</span>
        ${r.available ? `<button type="button" class="sp-btn" data-sched="${r.key}" title="Generate this report automatically"><i class="bi bi-calendar-plus"></i>Schedule</button>
        <button type="button" class="btn-add" data-gen="${r.key}"><i class="bi bi-file-earmark-bar-graph"></i>Generate</button>` : `<span class="rl-reason"><i class="bi bi-lock"></i> ${esc(r.reason)}</span>`}</div></div>`;
  }
  async function loadRecent() {
    const box = q('#rlRecent'); if (!box) return;
    try { RL.recent = RL.recent || (await api.get('/api/reports/runs?limit=5')); } catch (e) { box.innerHTML = `<div class="rl-mut">${esc(e.message)}</div>`; return; }
    box.innerHTML = RL.recent.runs.length ? runsTable(RL.recent.runs, true) : `<div class="rl-empty">Nothing generated yet. Pick a report above and press <b>Generate</b>.</div>`;
    wireRunActions(box);
  }

  /* ---------- run tables (History + Recent) ---------- */
  function runsTable(runs, compact) {
    return `<div class="rl-table-wrap"><table class="rl-table"><thead><tr><th>Reference</th><th>Report</th><th>Scope</th>${compact ? '' : '<th>Period</th>'}<th>Generated</th>${compact ? '' : '<th>Source</th><th>Size</th>'}<th></th></tr></thead><tbody>
      ${runs.map(r => `<tr>
        <td class="rl-ref">${r.unread ? '<span class="rl-dot" title="New"></span>' : ''}${esc(r.ref)}<small>v${r.version}</small></td>
        <td><b>${esc(r.title)}</b><div class="rl-mut">${esc(r.category || '')}</div></td>
        <td>${esc(r.scopeLabel)}<div class="rl-mut">${r.projectCount} project${r.projectCount === 1 ? '' : 's'}</div></td>
        ${compact ? '' : `<td class="rl-mut">${fD(r.periodFrom)} – ${fD(r.periodTo)}</td>`}
        <td>${fDT(r.generatedAt)}<div class="rl-mut">${esc(r.generatedBy || '')}</div></td>
        ${compact ? '' : `<td><span class="rl-pill ${r.source === 'scheduled' ? 'sched' : 'manual'}">${r.source === 'scheduled' ? 'Scheduled' : 'Manual'}</span></td><td class="rl-mut">${r.sizeKb} KB</td>`}
        <td class="rl-r"><a class="rl-ib" target="_blank" rel="noopener" href="/report-print.html?run=${r.id}"><i class="bi bi-box-arrow-up-right"></i>Open</a>
          <a class="rl-ib" href="/api/reports/runs/${r.id}/excel" title="Download Excel"><i class="bi bi-file-earmark-excel"></i></a>
          <button type="button" class="rl-ib" data-again="${r.id}" title="Generate again with the same settings and today's data (saved as a new version)"><i class="bi bi-arrow-repeat"></i>Run again</button></td></tr>`).join('')}
      </tbody></table></div>`;
  }
  function wireRunActions(root) {
    qa('[data-again]', root).forEach(b => b.addEventListener('click', () => {
      const all = [...(RL.recent ? RL.recent.runs : []), ...(RL.histData ? RL.histData.runs : [])], run = all.find(r => r.id === Number(b.dataset.again));
      if (run) generate(run.input, b);
    }));
    qa('a.rl-ib[href*="/excel"]', root).forEach(a => a.addEventListener('click', () => setTimeout(() => { RL.histData = null; }, 500)));
  }

  /* ---------- Builder ---------- */
  async function loadDefs() { try { RL.defs = await api.get('/api/reports/definitions'); } catch (e) { RL.defs = []; showToast(e.message, 'error'); } }
  async function drawBuilder() {
    const body = q('#rlBody'), c = RL.cat, B = RL.builder;
    if (!RL.defs) { body.innerHTML = '<div class="rl-mut">Loading…</div>'; await loadDefs(); if (RL.tab !== 'builder') return; }
    const groups = [...new Set(c.blocks.map(b => b.group))];
    const title = k => (c.blocks.find(b => b.key === k) || {}).title || k;
    body.innerHTML = `
      <div class="rl-scope" id="rlScope">${scopeBarHtml(RL.scope, 'rlS', { deflt: true })}</div>
      <div class="rl-builder">
        <div class="rl-panel"><h4>1 · Choose the sections</h4><p class="rl-hint">Tick what the report should contain. Each section is the same one the standard reports use, so the numbers always agree.</p>
          ${groups.map(g => `<div class="rl-blk-group">${esc(g)}</div>${c.blocks.filter(b => b.group === g).map(b => `
            <label class="rl-blk ${B.blocks.includes(b.key) ? 'on' : ''} ${b.available ? '' : 'off'}"><input type="checkbox" data-blk="${b.key}" ${B.blocks.includes(b.key) ? 'checked' : ''} ${b.available ? '' : 'disabled'}>
              <div><b>${esc(b.title)}</b><span>${esc(b.description)}${b.available ? '' : ' — not available to your login'}</span></div></label>`).join('')}`).join('')}</div>
        <div class="rl-panel" style="position:sticky;top:12px;"><h4>2 · Your report</h4><p class="rl-hint">Order, name and layout. Scope and period come from the bar above.</p>
          ${B.blocks.length ? `<ul class="rl-sel">${B.blocks.map((k, i) => `<li><span>${i + 1}. ${esc(title(k))}</span><button type="button" data-up="${i}" title="Move up" ${i ? '' : 'disabled'}><i class="bi bi-arrow-up"></i></button><button type="button" data-down="${i}" title="Move down" ${i < B.blocks.length - 1 ? '' : 'disabled'}><i class="bi bi-arrow-down"></i></button><button type="button" data-rm="${i}" title="Remove"><i class="bi bi-x-lg"></i></button></li>`).join('')}</ul>` : `<div class="rl-empty" style="margin-bottom:12px;">No sections chosen yet.</div>`}
          <div class="rl-form"><div><label class="rl-l">Report name</label><input type="text" id="rlName" maxlength="80" placeholder="e.g. Monthly board risk & progress pack" value="${esc(B.name)}"></div>
            <label class="rl-chk"><input type="checkbox" id="rlShared" ${B.shared ? 'checked' : ''}> Share this saved report with everyone who has the Report Library</label></div>
          <div class="rl-actions"><button type="button" class="btn-add" id="rlGen" ${B.blocks.length ? '' : 'disabled'}><i class="bi bi-file-earmark-bar-graph"></i>Generate</button>
            <button type="button" class="sp-btn" id="rlSave" ${B.blocks.length ? '' : 'disabled'}><i class="bi bi-bookmark-plus"></i>${B.editingId ? 'Update saved report' : 'Save'}</button>
            ${B.editingId ? '<button type="button" class="sp-btn" id="rlNew"><i class="bi bi-plus-lg"></i>Start new</button>' : ''}</div></div>
      </div>
      <div class="rl-cat-title">Saved reports</div>
      ${RL.defs.length ? `<div class="rl-table-wrap"><table class="rl-table"><thead><tr><th>Name</th><th>Sections</th><th>Saved by</th><th></th></tr></thead><tbody>${RL.defs.map(d => `<tr>
        <td><b>${esc(d.name)}</b>${d.shared ? ' <span class="rl-pill sched">Shared</span>' : ''}</td><td class="rl-mut">${d.blocks.map(k => esc(title(k))).join(' · ')}</td><td class="rl-mut">${esc(d.ownerName || d.owner)}</td>
        <td class="rl-r"><button class="rl-ib" data-defrun="${d.id}"><i class="bi bi-play-fill"></i>Run</button><button class="rl-ib" data-defsched="${d.id}"><i class="bi bi-calendar-plus"></i>Schedule</button>
        <button class="rl-ib" data-defedit="${d.id}"><i class="bi bi-pencil"></i>Edit</button><button class="rl-ib danger" data-defdel="${d.id}"><i class="bi bi-trash"></i></button></td></tr>`).join('')}</tbody></table></div>` : `<div class="rl-empty">Nothing saved yet. Build a report above and press <b>Save</b> to keep it, run it again later or schedule it.</div>`}`;
    const rewire = () => { q('#rlScope').innerHTML = scopeBarHtml(RL.scope, 'rlS', { deflt: true }); wireScope(q('#rlScope'), RL.scope, 'rlS', rewire); };
    wireScope(q('#rlScope'), RL.scope, 'rlS', rewire);
    const keep = () => { B.name = q('#rlName').value; B.shared = q('#rlShared').checked; };
    qa('[data-blk]').forEach(cb => cb.addEventListener('change', () => { keep(); const k = cb.dataset.blk; B.blocks = cb.checked ? [...B.blocks, k] : B.blocks.filter(x => x !== k); drawBuilder(); }));
    const move = (i, d) => { keep(); const j = i + d; if (j < 0 || j >= B.blocks.length) return; [B.blocks[i], B.blocks[j]] = [B.blocks[j], B.blocks[i]]; drawBuilder(); };
    qa('[data-up]').forEach(b => b.addEventListener('click', () => move(+b.dataset.up, -1)));
    qa('[data-down]').forEach(b => b.addEventListener('click', () => move(+b.dataset.down, 1)));
    qa('[data-rm]').forEach(b => b.addEventListener('click', () => { keep(); B.blocks.splice(+b.dataset.rm, 1); drawBuilder(); }));
    if (q('#rlNew')) q('#rlNew').addEventListener('click', () => { RL.builder = { blocks: [], name: '', shared: false, editingId: null }; drawBuilder(); });
    q('#rlGen').addEventListener('click', e => { keep(); generate(scopePayload(RL.scope, { reportKey: 'custom', blocks: B.blocks, title: B.name.trim() || undefined }), e.currentTarget); });
    q('#rlSave').addEventListener('click', async () => {
      keep(); if (!B.name.trim()) { showToast('Give the report a name first', 'error'); q('#rlName').focus(); return; }
      const body = { name: B.name.trim(), blocks: B.blocks, shared: B.shared, params: scopePayload(RL.scope, { title: B.name.trim() }) };
      try { if (B.editingId) await api.put('/api/reports/definitions/' + B.editingId, body); else B.editingId = (await api.post('/api/reports/definitions', body)).id; showToast('Report saved'); await loadDefs(); drawBuilder(); }
      catch (e) { showToast(e.message, 'error'); }
    });
    qa('[data-defrun]').forEach(b => b.addEventListener('click', () => { const d = RL.defs.find(x => x.id === +b.dataset.defrun); generate({ ...d.params, reportKey: 'custom', definitionId: d.id, blocks: d.blocks, title: d.name }, b); }));
    qa('[data-defsched]').forEach(b => b.addEventListener('click', () => openSchedule({ reportKey: 'custom', definitionId: +b.dataset.defsched })));
    qa('[data-defedit]').forEach(b => b.addEventListener('click', () => {
      const d = RL.defs.find(x => x.id === +b.dataset.defedit), p = d.params || {};
      RL.builder = { blocks: [...d.blocks], name: d.name, shared: d.shared, editingId: d.id };
      RL.scope = { businessUnitIds: p.businessUnitIds || [], projectIds: p.projectIds || [], statuses: p.statuses || [], period: { preset: (p.period && p.period.preset) || '', from: (p.period && p.period.from) || '', to: (p.period && p.period.to) || '' }, layout: p.layout || '' };
      drawBuilder(); window.scrollTo({ top: 0, behavior: 'smooth' });
    }));
    qa('[data-defdel]').forEach(b => b.addEventListener('click', async () => {
      const d = RL.defs.find(x => x.id === +b.dataset.defdel); if (!confirm(`Delete the saved report "${d.name}"? Reports already generated from it stay in History.`)) return;
      try { await api.del('/api/reports/definitions/' + d.id); if (RL.builder.editingId === d.id) RL.builder = { blocks: [], name: '', shared: false, editingId: null }; await loadDefs(); drawBuilder(); } catch (e) { showToast(e.message, 'error'); }
    }));
  }

  /* ---------- Scheduled ---------- */
  async function drawScheduled() {
    const body = q('#rlBody'); body.innerHTML = '<div class="rl-mut">Loading…</div>';
    try { RL.scheds = await api.get('/api/reports/schedules'); } catch (e) { body.innerHTML = `<div class="rl-empty">${esc(e.message)}</div>`; return; }
    if (RL.tab !== 'scheduled') return;
    const S = RL.scheds;
    body.innerHTML = `
      <div class="rl-head" style="margin-bottom:10px;"><div class="rl-sub" style="margin:0;">Scheduled reports generate themselves (Oman time) and appear in the recipients' Inbox and in History. A report missed while the server was off runs once when it is back.</div>
        <button type="button" class="btn-add" id="rlNewSched"><i class="bi bi-calendar-plus"></i>New schedule</button></div>
      ${S.length ? `<div class="rl-table-wrap"><table class="rl-table"><thead><tr><th>Schedule</th><th>When</th><th>Recipients</th><th>Next run</th><th>Last run</th><th>Status</th><th></th></tr></thead><tbody>${S.map(s => `<tr>
        <td><b>${esc(s.name)}</b><div class="rl-mut">${esc(s.reportTitle)} · by ${esc(s.createdBy)}</div></td>
        <td>${esc(s.when)}<div class="rl-mut">${esc(periodText(s.params))}</div></td>
        <td class="rl-mut">${s.recipients.length ? s.recipients.map(r => esc(r.name)).join(', ') : 'No one — kept in History only'}</td>
        <td>${s.active && s.nextRunAt ? fDT(s.nextRunAt) : '—'}</td>
        <td>${s.lastRunAt ? fDT(s.lastRunAt) : 'Never'}${s.lastRunId && !s.lastError ? ` <a href="/report-print.html?run=${s.lastRunId}" target="_blank" rel="noopener" class="rl-mut">open</a>` : ''}</td>
        <td>${s.lastError ? `<span class="rl-pill err" title="${esc(s.lastError)}">Failed</span>` : `<span class="rl-pill ${s.active ? 'on' : 'off'}">${s.active ? 'Active' : 'Paused'}</span>`}${s.lastError ? `<div class="rl-mut" style="max-width:220px;">${esc(s.lastError)}</div>` : ''}</td>
        <td class="rl-r">${s.mine ? `<button class="rl-ib" data-run="${s.id}" title="Generate now (does not change the next run)"><i class="bi bi-play-fill"></i>Run now</button>
          <button class="rl-ib" data-pause="${s.id}" data-on="${s.active ? 0 : 1}"><i class="bi bi-${s.active ? 'pause' : 'play'}-fill"></i>${s.active ? 'Pause' : 'Resume'}</button>
          <button class="rl-ib" data-edit="${s.id}"><i class="bi bi-pencil"></i></button><button class="rl-ib danger" data-del="${s.id}"><i class="bi bi-trash"></i></button>` : '<span class="rl-mut">Delivered to you</span>'}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="rl-empty"><i class="bi bi-calendar-check" style="font-size:1.4rem;"></i><br>No schedules yet. Create one — for example the Executive portfolio summary on the 1st of every month at 07:00.</div>`}`;
    q('#rlNewSched').addEventListener('click', () => openSchedule({}));
    qa('[data-run]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true; try { const r = await api.post(`/api/reports/schedules/${b.dataset.run}/run`, {}); showToast(`${r.ref} generated`); window.open('/report-print.html?run=' + r.id, '_blank'); } catch (e) { showToast(e.message, 'error'); } RL.histData = null; drawScheduled();
    }));
    qa('[data-pause]').forEach(b => b.addEventListener('click', async () => { try { await api.post(`/api/reports/schedules/${b.dataset.pause}/pause`, { active: b.dataset.on === '1' }); } catch (e) { showToast(e.message, 'error'); } drawScheduled(); }));
    qa('[data-edit]').forEach(b => b.addEventListener('click', () => openSchedule({ edit: S.find(s => s.id === +b.dataset.edit) })));
    qa('[data-del]').forEach(b => b.addEventListener('click', async () => { const s = S.find(x => x.id === +b.dataset.del); if (!confirm(`Delete the schedule "${s.name}"? Reports it already generated stay in History.`)) return; try { await api.del('/api/reports/schedules/' + s.id); } catch (e) { showToast(e.message, 'error'); } drawScheduled(); }));
  }
  function periodText(p) { const pr = p && p.period && p.period.preset; const m = RL.cat.periods.find(x => x.key === pr); return `Period: ${m ? m.label.toLowerCase() : "report's default"}`; }

  /* schedule form (a modal) */
  function ensureModal() {
    let m = document.getElementById('rlSchedModal');
    if (!m) { m = document.createElement('div'); m.className = 'modal fade'; m.id = 'rlSchedModal'; m.tabIndex = -1; m.innerHTML = `<div class="modal-dialog modal-lg modal-dialog-scrollable"><div class="modal-content"><div class="modal-header"><h5 class="modal-title" id="rlSmTitle">New schedule</h5><button type="button" class="btn-close" data-bs-dismiss="modal"></button></div><div class="modal-body rl-form" id="rlSmBody"></div><div class="modal-footer"><span class="rl-reason" id="rlSmErr" style="margin-right:auto;"></span><button type="button" class="sp-btn" data-bs-dismiss="modal">Cancel</button><button type="button" class="btn-add" id="rlSmSave"><i class="bi bi-check2"></i>Save schedule</button></div></div></div>`; document.body.appendChild(m); }
    return m;
  }
  function openSchedule(o) {
    const e = o.edit, p = (e && e.params) || {};
    RL.sm = { id: e ? e.id : null, name: e ? e.name : '', reportKey: e ? e.reportKey : (o.reportKey || 'executive'), definitionId: e ? e.definitionId : (o.definitionId || null),
      frequency: e ? e.frequency : 'monthly', weekday: e && e.weekday != null ? e.weekday : 0, monthDay: e && e.monthDay != null ? e.monthDay : 1, runTime: e ? e.runTime : '07:00',
      recipients: e ? e.recipients.map(r => r.username) : [], elig: [],
      scope: e ? { businessUnitIds: p.businessUnitIds || [], projectIds: p.projectIds || [], statuses: p.statuses || [], period: { preset: (p.period && p.period.preset) || '', from: '', to: '' }, layout: p.layout || '' }
        : { businessUnitIds: [...RL.scope.businessUnitIds], projectIds: [...RL.scope.projectIds], statuses: [...RL.scope.statuses], period: { preset: RL.scope.period.preset === 'custom' ? '' : RL.scope.period.preset, from: '', to: '' }, layout: RL.scope.layout } };
    if (!RL.sm.name) { const r = RL.cat.reports.find(x => x.key === RL.sm.reportKey); RL.sm.name = r ? r.title : 'Custom report'; }
    const m = ensureModal(); q('#rlSmTitle', m).textContent = e ? 'Edit schedule' : 'New schedule';
    drawSm(); loadElig(); bootstrap.Modal.getOrCreateInstance(m).show();
    q('#rlSmSave', m).onclick = saveSchedule;
  }
  function smSel() { const s = RL.sm; return s.reportKey === 'custom' ? 'def:' + s.definitionId : s.reportKey; }
  async function drawSm() {
    const s = RL.sm, m = document.getElementById('rlSmBody');
    if (!RL.defs) await loadDefs();
    const defOpts = RL.defs.map(d => `<option value="def:${d.id}" ${smSel() === 'def:' + d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
    m.innerHTML = `
      <div class="rl-row"><div><label class="rl-l">Report</label><select id="smReport">${RL.cat.reports.filter(r => r.available).map(r => `<option value="${r.key}" ${smSel() === r.key ? 'selected' : ''}>${esc(r.title)}</option>`).join('')}${defOpts ? `<optgroup label="Saved custom reports">${defOpts}</optgroup>` : ''}</select></div>
        <div><label class="rl-l">Schedule name</label><input type="text" id="smName" maxlength="100" value="${esc(s.name)}"></div></div>
      <div><label class="rl-l" style="display:block;margin-bottom:5px;">What it covers</label><div class="rl-scope" id="smScope" style="margin:0;box-shadow:none;">${scopeBarHtml(s.scope, 'smS', { relative: true, deflt: true })}</div></div>
      <div class="rl-row"><div><label class="rl-l">Repeat</label><select id="smFreq"><option value="daily" ${s.frequency === 'daily' ? 'selected' : ''}>Every day</option><option value="weekly" ${s.frequency === 'weekly' ? 'selected' : ''}>Every week</option><option value="monthly" ${s.frequency === 'monthly' ? 'selected' : ''}>Every month</option></select></div>
        ${s.frequency === 'weekly' ? `<div><label class="rl-l">On</label><select id="smWd">${DAYS.map((d, i) => `<option value="${i}" ${s.weekday === i ? 'selected' : ''}>${d}</option>`).join('')}</select></div>` : ''}
        ${s.frequency === 'monthly' ? `<div><label class="rl-l">On day</label><select id="smMd">${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}" ${s.monthDay === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}<option value="0" ${s.monthDay === 0 ? 'selected' : ''}>Last day of the month</option></select></div>` : ''}
        <div><label class="rl-l">At (Oman time)</label><input type="time" id="smTime" value="${esc(s.runTime)}"></div></div>
      <div class="rl-next" id="smNext"></div>
      <div><label class="rl-l" style="display:block;margin-bottom:5px;">Send to (Inbox)</label>
        <div class="rl-rec" id="smRec">${recHtml()}</div><div class="rl-mut" style="margin-top:5px;">Only people who can already see every project in this report, and the data in it, can be added. Delivery is in the dashboard Inbox — e-mail needs mail-server details and is not set up.</div></div>`;
    q('#smReport', m).addEventListener('change', e => { const v = e.target.value; if (v.startsWith('def:')) { s.reportKey = 'custom'; s.definitionId = +v.slice(4); } else { s.reportKey = v; s.definitionId = null; } s.name = s.name || ''; const r = RL.cat.reports.find(x => x.key === s.reportKey), d = RL.defs.find(x => x.id === s.definitionId); s.name = (r && r.title) || (d && d.name) || s.name; drawSm(); loadElig(); });
    q('#smName', m).addEventListener('input', e => { s.name = e.target.value; });
    q('#smFreq', m).addEventListener('change', e => { s.frequency = e.target.value; drawSm(); });
    if (q('#smWd', m)) q('#smWd', m).addEventListener('change', e => { s.weekday = +e.target.value; nextText(); });
    if (q('#smMd', m)) q('#smMd', m).addEventListener('change', e => { s.monthDay = +e.target.value; nextText(); });
    q('#smTime', m).addEventListener('change', e => { s.runTime = e.target.value || '07:00'; nextText(); });
    const rewire = () => { drawSm(); loadElig(); };
    wireScope(q('#smScope', m), s.scope, 'smS', rewire);
    wireRec(); nextText();
  }
  function nextText() {
    const s = RL.sm, t = s.runTime, box = document.getElementById('smNext'); if (!box) return;
    const txt = s.frequency === 'daily' ? `Every day at ${t}` : s.frequency === 'weekly' ? `Every ${DAYS[s.weekday]} at ${t}` : s.monthDay === 0 ? `On the last day of every month at ${t}` : `On day ${s.monthDay} of every month at ${t}`;
    box.innerHTML = `<i class="bi bi-clock"></i> ${esc(txt)} (Oman time). The period moves with the date — "last month" is always the month before the run.`;
  }
  function recHtml() {
    const s = RL.sm; if (!s.elig.length) return '<div class="rl-mut">Loading people…</div>';
    const none = !s.elig.some(a => a.eligible) ? '<div class="rl-mut" style="grid-column:1/-1;">Nobody can receive this report yet — narrow "What it covers" (for example to one business unit) so it matches the projects your colleagues can see.</div>' : '';
    return none + s.elig.map(a => `<label class="${a.eligible ? '' : 'dis'}"><input type="checkbox" value="${esc(a.username)}" ${s.recipients.includes(a.username) ? 'checked' : ''} ${a.eligible ? '' : 'disabled'}><span>${esc(a.name)}${a.reason ? `<small>${esc(a.reason)}</small>` : ''}</span></label>`).join('');
  }
  function wireRec() { qa('#smRec input', document.getElementById('rlSmBody')).forEach(cb => cb.addEventListener('change', () => { const s = RL.sm; s.recipients = cb.checked ? [...new Set([...s.recipients, cb.value])] : s.recipients.filter(u => u !== cb.value); })); }
  const loadElig = sleepy(async () => {
    const s = RL.sm; if (!s) return;
    try {
      s.elig = await api.post('/api/reports/schedules/recipients', { reportKey: s.reportKey, definitionId: s.definitionId, params: scopePayload(s.scope, {}) });
      const ok = new Set(s.elig.filter(a => a.eligible).map(a => a.username)); s.recipients = s.recipients.filter(u => ok.has(u));
    } catch (e) { s.elig = []; const r = document.getElementById('smRec'); if (r) r.innerHTML = `<div class="rl-reason">${esc(e.message)}</div>`; return; }
    const r = document.getElementById('smRec'); if (r) { r.innerHTML = recHtml(); wireRec(); }
  }, 250);
  async function saveSchedule() {
    const s = RL.sm, err = document.getElementById('rlSmErr'); err.textContent = '';
    const body = { name: s.name, reportKey: s.reportKey, definitionId: s.definitionId, frequency: s.frequency, weekday: s.weekday, monthDay: s.monthDay, runTime: s.runTime, recipients: s.recipients, active: true, params: scopePayload(s.scope, {}) };
    try { if (s.id) await api.put('/api/reports/schedules/' + s.id, body); else await api.post('/api/reports/schedules', body); }
    catch (e) { err.textContent = e.message; return; }
    bootstrap.Modal.getOrCreateInstance(document.getElementById('rlSchedModal')).hide(); showToast('Schedule saved');
    RL.tab = 'scheduled'; draw();
  }

  /* ---------- History ---------- */
  async function drawHistory() {
    const body = q('#rlBody'), H = RL.hist, c = RL.cat;
    body.innerHTML = `
      <div class="rl-filters">
        <div class="rl-f"><label>Search</label><input type="text" id="hQ" placeholder="Title, scope or person…" value="${esc(H.q)}"></div>
        <div class="rl-f"><label>Report</label><select id="hKey"><option value="">All reports</option>${c.reports.map(r => `<option value="${r.key}" ${H.reportKey === r.key ? 'selected' : ''}>${esc(r.title)}</option>`).join('')}<option value="custom" ${H.reportKey === 'custom' ? 'selected' : ''}>Custom reports</option></select></div>
        <div class="rl-f"><label>Project</label><select id="hProj"><option value="">All projects</option>${c.projects.map(p => `<option value="${p.id}" ${String(H.projectId) === String(p.id) ? 'selected' : ''}>${esc(p.code)} — ${esc(p.name.slice(0, 40))}</option>`).join('')}</select></div>
        <div class="rl-f"><label>Source</label><select id="hSrc"><option value="">Manual + scheduled</option><option value="adhoc" ${H.source === 'adhoc' ? 'selected' : ''}>Manual</option><option value="scheduled" ${H.source === 'scheduled' ? 'selected' : ''}>Scheduled</option></select></div>
        <div class="rl-f"><label>From</label><input type="date" id="hFrom" value="${esc(H.from)}"></div><div class="rl-f"><label>To</label><input type="date" id="hTo" value="${esc(H.to)}"></div>
        <div class="rl-f"><label>&nbsp;</label><span style="display:flex;gap:12px;"><label class="rl-chk" style="text-transform:none;font-size:.76rem;font-weight:600;"><input type="checkbox" id="hMine" ${H.mine ? 'checked' : ''}> Mine only</label>
          <label class="rl-chk" style="text-transform:none;font-size:.76rem;font-weight:600;"><input type="checkbox" id="hInbox" ${H.inbox ? 'checked' : ''}> Delivered to me</label></span></div>
      </div><div id="hList"><div class="rl-mut">Loading…</div></div>`;
    const apply = () => { Object.assign(H, { q: q('#hQ').value, reportKey: q('#hKey').value, projectId: q('#hProj').value, source: q('#hSrc').value, from: q('#hFrom').value, to: q('#hTo').value, mine: q('#hMine').checked, inbox: q('#hInbox').checked, offset: 0 }); loadHist(); };
    qa('#rlBody select, #rlBody input[type=date], #rlBody input[type=checkbox]').forEach(x => x.addEventListener('change', apply));
    q('#hQ').addEventListener('input', sleepy(apply, 350));
    loadHist();
  }
  async function loadHist() {
    const H = RL.hist, box = q('#hList'); if (!box) return;
    const qs = new URLSearchParams({ limit: 25, offset: H.offset }); ['q', 'reportKey', 'projectId', 'source', 'from', 'to'].forEach(k => { if (H[k]) qs.set(k, H[k]); }); if (H.mine) qs.set('mine', '1'); if (H.inbox) qs.set('inbox', '1');
    try { RL.histData = await api.get('/api/reports/runs?' + qs); } catch (e) { box.innerHTML = `<div class="rl-empty">${esc(e.message)}</div>`; return; }
    const d = RL.histData;
    if (!q('#hList')) return;
    box.innerHTML = d.runs.length ? `${runsTable(d.runs, false)}<div class="rl-pager"><span>${d.total} report${d.total === 1 ? '' : 's'}</span><span>${H.offset > 0 ? '<button class="rl-ib" id="hPrev">Previous</button> ' : ''}${H.offset + 25 < d.total ? '<button class="rl-ib" id="hNext">Next</button>' : ''}</span></div>`
      : `<div class="rl-empty"><i class="bi bi-clock-history" style="font-size:1.4rem;"></i><br>No reports match. Generated reports are kept here so they can be opened again exactly as they were.</div>`;
    wireRunActions(box);
    if (q('#hPrev')) q('#hPrev').addEventListener('click', () => { H.offset -= 25; loadHist(); });
    if (q('#hNext')) q('#hNext').addEventListener('click', () => { H.offset += 25; loadHist(); });
    if (H.inbox) { const r = await api.get('/api/reports/inbox').catch(() => null); if (r) { RL.cat.unread = r.unread; const b = q('#rlInboxBadge'); if (b) { b.textContent = r.unread; b.hidden = !r.unread; } } }
  }

  /* ---------- Templates ---------- */
  function drawTemplates() {
    const body = q('#rlBody'), c = RL.cat;
    const thumb = k => k === 'board' ? `<div class="rl-thumb"><div class="cv"><i class="t"></i><i style="width:40%"></i><i style="width:30%;margin-top:6px"></i></div><i style="width:80%"></i><i style="width:60%"></i></div>`
      : `<div class="rl-thumb"><i class="t"></i><i style="width:35%"></i><div class="k"><b></b><b></b><b></b><b></b></div><i></i><i></i><i style="width:70%"></i>${k === 'compact' ? '<i></i><i></i><i style="width:50%"></i>' : ''}</div>`;
    body.innerHTML = `
      <p class="rl-hint" style="font-size:.78rem;color:var(--muted);">Every report is laid out by one of these templates and carries the letterhead of its business unit. Pick a template in the scope bar on the Catalogue or Builder tab.</p>
      <div class="rl-tpl-grid">
        ${c.layouts.map(l => `<div class="rl-tpl">${thumb(l.key)}<h4>${esc(l.title)}</h4><p>${esc(l.description)}</p><div class="rl-actions" style="margin:0;"><button type="button" class="sp-btn" data-use="${l.key}"><i class="bi bi-check2-circle"></i>Use this layout</button></div></div>`).join('')}
        <div class="rl-tpl"><div class="rl-thumb" style="justify-content:center;align-items:center;"><i class="bi bi-file-earmark-excel" style="font-size:2.4rem;color:#1D6F42;background:none;height:auto;"></i></div><h4>Excel workbook</h4><p>A <b>Summary</b> sheet (scope, key figures, attention points) plus one sheet for every table, with real numbers and dates so it can be filtered, pivoted and charted. Download it from any report or from History.</p></div>
        <div class="rl-tpl"><div class="rl-thumb" style="justify-content:center;align-items:center;"><i class="bi bi-file-earmark-slides" style="font-size:2.4rem;color:#B7472A;background:none;height:auto;"></i></div><h4>PowerPoint</h4><p>Not included yet. It needs one extra software package on the server; once added, any stored report can be turned into a slide deck from its data — see the recommendation.</p></div>
      </div>
      <div class="rl-cat-title">Letterhead</div>
      <div class="rl-panel"><p class="rl-hint" style="margin:0 0 8px;">A report for one business unit carries that unit's name and logo; a report across several carries NEC's. Add or replace a logo under Master Data → Business Units.</p>
        <div class="rl-bu">${c.businessUnits.filter(b => b.id).map(b => `<span class="${b.logo ? 'ok' : 'no'}"><i class="bi bi-${b.logo ? 'check-circle' : 'dash-circle'}"></i> ${esc(b.name)} — ${b.logo ? 'logo set' : 'no logo yet (name only)'}</span>`).join('')}</div></div>`;
    qa('[data-use]').forEach(b => b.addEventListener('click', () => { RL.scope.layout = b.dataset.use; RL.tab = 'catalogue'; draw(); showToast('Layout chosen — it applies to the reports you generate next'); }));
  }

  /* ---------- Access log (administrator) ---------- */
  async function drawLog() {
    const body = q('#rlBody'), L = RL.log;
    body.innerHTML = `<p style="font-size:.78rem;color:var(--muted);margin:0 0 10px;">Who generated, opened, downloaded or printed which report, and when. Also recorded in the main Activity Log.</p>
      <div class="rl-filters"><div class="rl-f"><label>Search</label><input type="text" id="lQ" placeholder="Report or person…" value="${esc(L.q)}"></div>
        <div class="rl-f"><label>Person</label><select id="lUser"><option value="">Everyone</option></select></div>
        <div class="rl-f"><label>Action</label><select id="lAct"><option value="">All actions</option>${Object.entries(LOG_ACTIONS).map(([k, v]) => `<option value="${k}" ${L.action === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="rl-f"><label>From</label><input type="date" id="lFrom" value="${esc(L.from)}"></div><div class="rl-f"><label>To</label><input type="date" id="lTo" value="${esc(L.to)}"></div></div>
      <div id="lList"><div class="rl-mut">Loading…</div></div>`;
    const apply = () => { Object.assign(L, { q: q('#lQ').value, user: q('#lUser').value, action: q('#lAct').value, from: q('#lFrom').value, to: q('#lTo').value, offset: 0 }); loadLog(); };
    qa('#rlBody select, #rlBody input[type=date]').forEach(x => x.addEventListener('change', apply)); q('#lQ').addEventListener('input', sleepy(apply, 350));
    loadLog();
  }
  async function loadLog() {
    const L = RL.log, box = q('#lList'); if (!box) return;
    const qs = new URLSearchParams({ limit: 50, offset: L.offset }); ['q', 'user', 'action', 'from', 'to'].forEach(k => { if (L[k]) qs.set(k, L[k]); });
    let d; try { d = await api.get('/api/reports/access-log?' + qs); } catch (e) { box.innerHTML = `<div class="rl-empty">${esc(e.message)}</div>`; return; }
    const sel = q('#lUser'); if (sel && sel.options.length === 1) sel.innerHTML += d.users.map(u => `<option ${L.user === u ? 'selected' : ''}>${esc(u)}</option>`).join('');
    if (!q('#lList')) return;
    box.innerHTML = d.rows.length ? `<div class="rl-table-wrap"><table class="rl-table"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Report</th><th>From</th></tr></thead><tbody>${d.rows.map(r => `<tr>
      <td>${fDT(r.at)}</td><td><b>${esc(r.user || '—')}</b></td><td>${esc(LOG_ACTIONS[r.action] || r.action)}</td>
      <td>${r.runId && /^RPT-/.test(r.label || '') ? `<a href="/report-print.html?run=${r.runId}" target="_blank" rel="noopener">${esc(r.label)}</a>` : esc(r.label || '—')}${r.details && r.details.scope ? `<div class="rl-mut">${esc(r.details.scope)}</div>` : ''}${r.details && r.details.format ? `<div class="rl-mut">${esc(r.details.format)}</div>` : ''}</td>
      <td class="rl-mut">${esc(r.ip || '')}</td></tr>`).join('')}</tbody></table></div>
      <div class="rl-pager"><span>${d.total} event${d.total === 1 ? '' : 's'}</span><span>${L.offset > 0 ? '<button class="rl-ib" id="lPrev">Previous</button> ' : ''}${L.offset + 50 < d.total ? '<button class="rl-ib" id="lNext">Next</button>' : ''}</span></div>` : `<div class="rl-empty">No report activity matches.</div>`;
    if (q('#lPrev')) q('#lPrev').addEventListener('click', () => { L.offset -= 50; loadLog(); });
    if (q('#lNext')) q('#lNext').addEventListener('click', () => { L.offset += 50; loadLog(); });
  }

  window.ReportLibrary = { render };
})();
