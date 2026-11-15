/* =========================================================
   PROJECT PROGRESS page (sidebar: Project Progress).
   All numbers come from progress-calc.js (shared with the Excel sheet and the Report Library) using the projects and tasks
   the dashboard has already loaded. Uses the dashboard's chart helpers (makeLine / makeBar), esc, fmtDate, showToast and api.
   ========================================================= */
(function () {
  'use strict';
  const PC = window.ProgressCalc;
  const S = { scope: '', period: 'Month', weeks: 3, laLimit: 40 };
  const COLORS = { planned: '#8A97A0', actual: '#1B7A8C', earned: '#C9A15A', good: '#2E8B57', bad: '#C94C4C' };
  const sign = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v);
  const fd = s => (s ? fmtDate(s) : '—');
  const toneVar = v => (v == null ? '' : v < -10 ? 'bad' : v < -3 ? 'warn' : 'good');
  const toneSpi = v => (v == null ? '' : v >= 0.95 ? 'good' : v >= 0.85 ? 'warn' : 'bad');
  const daysText = d => (d == null ? '—' : d === 0 ? 'on schedule' : d > 0 ? `${d} day${d === 1 ? '' : 's'} ahead` : `${-d} day${d === -1 ? '' : 's'} behind`);
  const periodWord = { Week: 'week', Month: 'month', Quarter: 'quarter' };
  const periodPreset = { Week: 'this-week', Month: 'this-month', Quarter: 'this-quarter' };

  function scopeProjects(list) { return S.scope ? list.filter(p => String(p.id) === String(S.scope)) : list; }
  function periodIso() { const b = periodBounds(S.period, null); return { from: toDateInput(b.start), to: toDateInput(b.end) }; }

  function render(list) {
    const el = document.getElementById('tab-progress');
    if (S.scope && !list.some(p => String(p.id) === String(S.scope))) S.scope = '';
    const sp = scopeProjects(list), ids = new Set(sp.map(p => p.id));
    const ev = events.filter(e => ids.has(e.projectId)), per = periodIso();
    const an = PC.analyse(sp, ev, { from: per.from, to: per.to });
    const P = an.portfolio, single = sp.length === 1;
    const canReports = !!document.querySelector('.side-link[data-tab="reports"]');

    el.innerHTML = `
      <div class="pg-head">
        <div><div class="section-title" style="margin:0;"><i class="bi bi-graph-up-arrow"></i>Project Progress</div>
          <div class="pg-sub">Physical and schedule progress — how far ${single ? 'this project has' : 'each project has'} actually advanced against the plan. Position as at ${fd(an.today)}.</div></div>
        <div class="pg-actions">
          <a class="sp-btn" id="pgXlsx" href="#" title="Planned vs actual for every activity"><i class="bi bi-file-earmark-excel"></i>Measurement sheet</a>
          ${canReports ? `<button type="button" class="sp-btn" id="pgRepProgress" title="Weekly / monthly progress report — opens a printable PDF"><i class="bi bi-file-earmark-pdf"></i>Progress report</button>
          <button type="button" class="sp-btn" id="pgRepSlip" title="Where schedule was lost and recovered"><i class="bi bi-file-earmark-pdf"></i>Slippage report</button>` : ''}
        </div>
      </div>
      <div class="pg-bar">
        <div class="pg-f"><label>Show</label><select id="pgScope"><option value="">All projects in the current filters (${list.length})</option>${list.map(p => `<option value="${p.id}" ${String(p.id) === String(S.scope) ? 'selected' : ''}>${esc(p.code)} — ${esc(p.name.length > 60 ? p.name.slice(0, 58) + '…' : p.name)}</option>`).join('')}</select></div>
        <div class="pg-f"><label>Activity period</label><select id="pgPeriod">${['Week', 'Month', 'Quarter'].map(t => `<option ${S.period === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <span class="pg-note"><i class="bi bi-info-circle"></i> This ${periodWord[S.period]}: ${fd(per.from)} – ${fd(per.to)}</span>
      </div>
      ${sp.length ? `
      ${P.unmeasured || P.unscheduled ? `<div class="pg-warn"><i class="bi bi-exclamation-triangle"></i> ${[P.unmeasured ? `${P.unmeasured} of ${P.projects} project${P.unmeasured === 1 ? ' has' : 's have'} no scheduled tasks, so ${P.unmeasured === 1 ? 'it is' : 'they are'} not measured` : '', P.unscheduled ? `${P.unscheduled} task${P.unscheduled === 1 ? ' has' : 's have'} no planned start / finish date and ${P.unscheduled === 1 ? 'is' : 'are'} left out of the figures` : ''].filter(Boolean).join('; ')}. Add the dates in the project's Sequence of Events.</div>` : ''}
      <div class="pg-kpis" id="pgKpis"></div>
      <div class="chart-card" style="margin-top:16px;"><div class="chart-title">Progress S-curve</div>
        <div class="chart-sub">Cumulative % complete over time — planned from the task schedule, actual from recorded start / finish dates and progress${P.projects > 1 ? ', earned weighted by project budget' : ''}. The larger dot is today.</div>
        <div style="height:340px;"><canvas id="pgScurve"></canvas></div></div>
      <div class="chart-row cols-2" style="margin-top:14px;">
        <div class="chart-card tall"><div class="chart-title">Planned vs actual by project</div><div class="chart-sub">Side by side, with the variance in points</div><canvas id="pgByProject"></canvas></div>
        <div class="chart-card tall"><div class="chart-title">Progress by work package</div><div class="chart-sub">Each project stage (WBS level 1): planned vs actual completion today</div><canvas id="pgByStage"></canvas></div>
      </div>
      <div class="chart-card" style="margin-top:14px;"><div class="chart-title">Slippage waterfall</div>
        <div class="chart-sub">Days ahead (+) or behind (−) schedule at each month end, and how much each month gained (green) or lost (red) — reconstructed from the recorded dates.</div>
        <div style="height:300px;"><canvas id="pgWaterfall"></canvas></div></div>
      <div class="section-title" style="margin-top:22px;"><i class="bi bi-binoculars"></i>Look-ahead
        <span class="pg-seg" id="pgWeeks">${[2, 3, 4].map(w => `<button type="button" data-w="${w}" class="${S.weeks === w ? 'on' : ''}">${w} weeks</button>`).join('')}</span></div>
      <div class="table-card" id="pgLook"></div>
      <div class="section-title" style="margin-top:22px;"><i class="bi bi-list-check"></i>Progress detail</div>
      <div class="table-card" style="overflow-x:auto;"><table class="dash-table"><thead><tr><th>Project</th><th class="r">Planned</th><th class="r">Actual</th><th class="r">Variance</th><th class="r">SPI</th><th>Schedule</th><th class="r">Activities done</th><th class="r">Overdue</th><th>Baseline finish</th><th>Forecast finish</th></tr></thead>
        <tbody id="pgRows"></tbody></table></div>
      <div class="pg-how"><b>How this is measured.</b> Each task is weighted by its planned duration. <i>Planned %</i> is how much of the work the schedule says should be done by today; <i>actual %</i> is the weighted progress of the tasks. <i>SPI</i> = actual ÷ planned. Days ahead / behind use earned schedule: the date on which the plan had reached today's actual %. <i>Forecast finish</i> extends the current pace to the end (planned duration ÷ SPI). Earlier months are rebuilt from the recorded actual start / finish dates, so past values are an estimate; today's are exact. This differs from the calendar-based "Planned %" on the Project Portfolio, which only measures time elapsed.</div>`
      : `<div class="empty-state" style="margin-top:20px;">No projects match your filters.</div>`}`;

    document.getElementById('pgScope').addEventListener('change', e => { S.scope = e.target.value; render(list); });
    document.getElementById('pgPeriod').addEventListener('change', e => { S.period = e.target.value; render(list); });
    if (!sp.length) return;
    const q = new URLSearchParams({ projects: sp.map(p => p.id).join(','), from: per.from, to: per.to });
    document.getElementById('pgXlsx').href = '/api/progress/export?' + q;
    if (canReports) {
      document.getElementById('pgRepProgress').addEventListener('click', e => makeReport(e.currentTarget, 'progress', sp, single ? ['project-pages'] : []));
      document.getElementById('pgRepSlip').addEventListener('click', e => makeReport(e.currentTarget, 'slippage', sp, []));
    }
    kpis(an, P, list, sp);
    scurve(an);
    byProject(an);
    byStage(an);
    waterfall(an);
    look(an);
    document.querySelectorAll('#pgWeeks button').forEach(b => b.addEventListener('click', () => { S.weeks = +b.dataset.w; document.querySelectorAll('#pgWeeks button').forEach(x => x.classList.toggle('on', x === b)); look(an); }));
    table(an);
  }

  function kpis(an, P, list, sp) {
    const card = (icon, label, value, sub, tone, onClick, id) => `<div class="pg-kpi ${tone ? 't-' + tone : ''} ${onClick ? 'click' : ''}" data-k="${id || ''}"><div class="pg-ico"><i class="bi ${icon}"></i></div><div class="pg-v">${value}</div><div class="pg-l">${label}</div><div class="pg-s">${sub}</div></div>`;
    const per = periodWord[S.period], f = P.forecastLatest;
    const html = [
      card('bi-speedometer', 'Actual progress', P.actual == null ? '—' : P.actual + '%', P.actual == null ? 'no scheduled tasks yet' : `Planned ${P.planned}% · ${sign(P.variance)} pts`, toneVar(P.variance), true, 'all'),
      card('bi-activity', 'Schedule performance (SPI)', P.spi == null ? '—' : P.spi.toFixed(2), P.spi == null ? 'no planned work yet' : (P.projects > 1 ? 'budget-weighted · ' : '') + (P.spi >= 1 ? 'at or ahead of plan' : 'behind plan'), toneSpi(P.spi)),
      card('bi-arrow-left-right', 'Progress variance', P.svDays == null ? '—' : (P.svDays === 0 ? 'On time' : Math.abs(P.svDays) + ' days'), P.svDays == null ? 'not started yet' : `${P.svDays > 0 ? 'ahead of' : P.svDays < 0 ? 'behind' : 'on'} schedule · ${P.ahead} ahead / ${P.behind} behind`, P.svDays == null ? '' : P.svDays >= 0 ? 'good' : P.svDays > -14 ? 'warn' : 'bad', true, 'behind'),
      card('bi-check2-square', 'Activities complete', `${P.finishedInPeriod}`, `finished this ${per} · ${P.dueInPeriod ? P.dueDonePct + '% of ' + P.dueInPeriod + ' due' : 'none were due'} · ${P.done} of ${P.tasks} overall`, P.dueInPeriod && P.dueDonePct < 50 ? 'warn' : ''),
      card('bi-calendar-event', 'Forecast completion', f ? fd(f) : '—', f ? `latest of ${P.forecastKnown} project${P.forecastKnown === 1 ? '' : 's'} (baseline ${fd(P.baselineLatest)}) · ${P.forecastLate} forecast late${P.worstSlip ? ' (up to +' + P.worstSlip + ' d)' : ''}${P.forecastNone ? ' · ' + P.forecastNone + ' with no measurable progress yet' : ''}` : 'no project has measurable progress yet', P.forecastLate ? 'warn' : f ? 'good' : '')
    ].join('');
    const box = document.getElementById('pgKpis'); box.innerHTML = html;
    box.querySelector('[data-k="all"]').addEventListener('click', () => drilldownProjects('Project progress', `Actual ${P.actual}% against ${P.planned}% planned`, sp));
    const bh = box.querySelector('[data-k="behind"]'); if (bh) bh.addEventListener('click', () => drilldownProjects('Behind schedule', 'Projects with negative progress variance', sp.filter(p => an.rows.find(r => r.id === p.id && r.variance < 0))));
  }

  function scurve(an) {
    const c = PC.curve(an, { points: 44 }), many = c.many;
    if (!c.labels.length) { document.getElementById('pgScurve').parentNode.innerHTML = '<div class="empty-state">No scheduled tasks to draw a curve from.</div>'; return; }
    const ti = c.todayIndex, ds = [
      { label: 'Planned %', data: c.planned, borderColor: COLORS.planned, borderDash: [6, 4], backgroundColor: 'transparent', tension: .35, pointRadius: 0 },
      { label: 'Actual %', data: c.actual, borderColor: COLORS.actual, backgroundColor: 'rgba(27,122,140,.12)', fill: true, tension: .35, pointRadius: ctx => (ctx.dataIndex === ti ? 6 : 0), pointBackgroundColor: COLORS.actual, spanGaps: false }
    ];
    if (many) ds.push({ label: 'Earned % (budget-weighted)', data: c.earned, borderColor: COLORS.earned, backgroundColor: 'transparent', tension: .35, pointRadius: ctx => (ctx.dataIndex === ti ? 6 : 0), pointBackgroundColor: COLORS.earned });
    makeLine('pgScurve', c.labels, ds, { scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }, x: { ticks: { maxTicksLimit: 10, maxRotation: 0 } } },
      interaction: { mode: 'index', intersect: false }, elements: { point: { radius: 0 } }, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } }, tooltip: { callbacks: { label: ctx => ctx.parsed.y == null ? null : `${ctx.dataset.label.replace(' %', '')}: ${ctx.parsed.y}%` } } } });
  }

  function byProject(an) {
    const rows = an.rows.filter(r => r.measurable).sort((a, b) => a.variance - b.variance).slice(0, 16);
    makeBar('pgByProject', rows.map(r => `${r.name.length > 34 ? r.name.slice(0, 32) + '…' : r.name}  (${sign(r.variance)})`), [
      { label: 'Planned %', data: rows.map(r => r.planned), backgroundColor: COLORS.planned, borderRadius: 4 },
      { label: 'Actual %', data: rows.map(r => r.actual), backgroundColor: COLORS.actual, borderRadius: 4 }],
    { horizontal: true, chartOpts: { scales: { x: { min: 0, max: 100, ticks: { callback: v => v + '%' } }, y: { ticks: { font: { size: 9 } } } }, maintainAspectRatio: false }, onClick: (i) => { const r = rows[i]; if (r) openProjectModal(r.id); } });
  }
  function byStage(an) {
    const wp = PC.workPackages(an, STAGES);
    makeBar('pgByStage', wp.map(w => w.stage), [
      { label: 'Planned %', data: wp.map(w => w.planned), backgroundColor: COLORS.planned, borderRadius: 4 },
      { label: 'Actual %', data: wp.map(w => w.actual), backgroundColor: COLORS.actual, borderRadius: 4 }],
    { chartOpts: { scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }, x: { ticks: { font: { size: 9 }, maxRotation: 40, autoSkip: false } } }, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10 } }, tooltip: { callbacks: { afterBody: items => { const w = wp[items[0].dataIndex]; return `${w.done} of ${w.tasks} tasks done${w.overdue ? ' · ' + w.overdue + ' overdue' : ''}`; } } } } } });
  }
  function waterfall(an) {
    const w = PC.slippage(an, 6), s = w.steps, mon = d => new Date(d + 'T00:00:00Z').toLocaleString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    const labels = ['Opening ' + mon(s[0].asAt)], data = [[0, s[0].sv]], colors = ['#8A97A0'];
    for (let i = 1; i < s.length; i++) { labels.push(i === s.length - 1 ? 'To date' : mon(s[i].asAt)); data.push([s[i - 1].sv, s[i].sv]); colors.push(s[i].change >= 0 ? COLORS.good : COLORS.bad); }
    labels.push('Now'); data.push([0, w.closing]); colors.push(w.closing >= 0 ? COLORS.actual : '#0F4C5C');
    makeBar('pgWaterfall', labels, [{ label: 'Days', data, backgroundColor: colors, borderRadius: 3 }], { chartOpts: { maintainAspectRatio: false,
      scales: { y: { title: { display: true, text: 'days ahead (+) / behind (−)' }, grid: { display: true } }, x: { grid: { display: false } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => { const i = ctx.dataIndex; if (i === 0 || i === labels.length - 1) return `${daysText(ctx.raw[1])}`; const ch = s[i].change; return `${ch >= 0 ? 'Gained' : 'Lost'} ${Math.abs(ch)} day${Math.abs(ch) === 1 ? '' : 's'} → ${daysText(s[i].sv)}`; } } } } } });
  }

  function look(an) {
    const items = PC.lookahead(an, S.weeks), box = document.getElementById('pgLook');
    if (!items.length) { box.innerHTML = `<div class="empty-state">Nothing is due to finish or start in the next ${S.weeks} weeks.</div>`; return; }
    const shown = items.slice(0, S.laLimit);
    box.innerHTML = `<div style="overflow-x:auto;"><table class="dash-table"><thead><tr><th>Project</th><th>Stage</th><th>Activity</th><th>Planned start</th><th>Planned finish</th><th class="r">Due in</th><th>Owner</th><th>Status</th></tr></thead><tbody>
      ${shown.map(x => `<tr class="no-click"><td>${esc(x.project)}</td><td>${esc(x.stage)}</td><td><b>${esc(x.task)}</b></td><td>${fd(x.plannedStart)}</td><td>${fd(x.plannedEnd)}</td>
        <td class="r">${x.daysToFinish == null ? '—' : x.daysToFinish === 0 ? 'today' : x.daysToFinish + ' d'}</td><td>${esc(x.owner || '—')}</td>
        <td><span class="pg-chip ${x.kind}">${x.kind === 'starting' ? 'Starts' : 'Finishes'}</span> ${esc(x.status)}${x.progress ? ` · ${x.progress}%` : ''}</td></tr>`).join('')}</tbody></table></div>
      <div class="pg-more">${items.length > shown.length ? `Showing ${shown.length} of ${items.length}. <a href="#" id="pgMore">Show more</a>` : `${items.length} activit${items.length === 1 ? 'y' : 'ies'}`}</div>`;
    const more = document.getElementById('pgMore'); if (more) more.addEventListener('click', e => { e.preventDefault(); S.laLimit += 60; look(an); });
  }

  function table(an) {
    const rows = [...an.rows].sort((a, b) => (a.variance == null) - (b.variance == null) || a.variance - b.variance), tone = (t, txt) => `<span class="pg-tone t-${t}">${txt}</span>`;
    document.getElementById('pgRows').innerHTML = rows.map(r => `<tr data-id="${r.id}">
      <td><b>${esc(r.name)}</b><div class="rl-mut" style="font-size:.7rem;color:var(--muted);">${esc(r.code)}${r.businessUnit ? ' · ' + esc(r.businessUnit) : ''}</div></td>
      ${r.measurable ? `<td class="r">${r.planned}%</td><td class="r">${r.actual}%</td><td class="r">${tone(toneVar(r.variance) || 'good', sign(r.variance) + '%')}</td>` : `<td class="r pg-mut" colspan="3">no scheduled tasks</td>`}
      <td class="r">${r.spi == null ? '—' : tone(toneSpi(r.spi), r.spi.toFixed(2))}</td><td>${r.svDays == null ? '<span class="pg-mut">' + (r.measurable ? 'not started' : '—') + '</span>' : tone(r.svDays >= 0 ? 'good' : r.svDays > -14 ? 'warn' : 'bad', r.complete ? (r.svDays === 0 ? 'finished on time' : `finished ${Math.abs(r.svDays)} day${Math.abs(r.svDays) === 1 ? '' : 's'} ${r.svDays > 0 ? 'early' : 'late'}`) : daysText(r.svDays))}</td>
      <td class="r">${r.done} / ${r.tasks}${r.unscheduled ? `<div class="pg-mut" style="font-size:.66rem;">${r.unscheduled} undated</div>` : ''}</td><td class="r">${r.overdue ? tone('warn', r.overdue) : 0}</td><td>${fd(r.baseline)}</td>
      <td>${r.forecast ? fd(r.forecast) + (r.forecastDelay > 0 ? ` ${tone('bad', '+' + r.forecastDelay + ' d')}` : r.forecastDelay < 0 ? ` ${tone('good', r.forecastDelay + ' d')}` : '') : '<span class="pg-mut">—</span>'}</td></tr>`).join('');
    document.querySelectorAll('#pgRows tr[data-id]').forEach(tr => tr.addEventListener('click', () => openProjectModal(Number(tr.dataset.id))));
  }

  async function makeReport(btn, key, sp, options) {
    const w = window.open('about:blank', '_blank'), old = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i>Generating…';
    try {
      const run = await api.post('/api/reports/runs', { reportKey: key, projectIds: sp.map(p => p.id), options, period: { preset: periodPreset[S.period] } });
      if (w) w.location.href = '/report-print.html?run=' + run.id; else showToast(`${run.ref} generated — find it in Report Library → History`);
    } catch (e) { if (w) w.close(); showToast(e.message, 'error'); }
    finally { btn.disabled = false; btn.innerHTML = old; }
  }

  window.ProgressPage = { render };
})();
