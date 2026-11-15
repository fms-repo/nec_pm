/* =========================================================
   REPORT LIBRARY — what a report is made of.

   A report is an ordered list of BLOCKS. A block looks at the live data (through the context `c` that reports.js builds) and
   returns finished SECTIONS: plain JSON — KPI strips, tables, stacked bars, bullet lists, text. Nothing in a section is
   HTML, so the same finished report is drawn on screen / for print by public/report-render.js, written to Excel by
   reports-excel.js, and stored as-is in the archive (report_runs.snapshot).

   The nine catalogue reports (REPORTS) and the Custom Builder use exactly the same blocks.

   Section shapes
     { kind:'kpis',    title, items:[{ label, value, type, sub, tone }] }
     { kind:'table',   title, note, columns:[{ key, label, type, align }], rows:[{ key: value | {v, tone, sub} }], totals:{…}, empty }
     { kind:'stack',   title, note, segments:[{ label, value, tone }] }
     { kind:'bullets', title, items:[{ text, tone }] }
     { kind:'text',    title, text }
   Column / KPI types: text · int · money · pct · num1 · ratio · date · days.   Tones: good · warn · bad · info · muted.

   Block `needs` (checked for the person generating the report; the administrator passes everything):
     menus   – at least one of these sidebar menus      views – every one of these resources is viewable
     anyView – at least one of these resources           data  – a risks / issues / milestones resource AND its menu
     admin   – administrator only
   ========================================================= */
'use strict';
const PC = require('./public/progress-calc.js');

/* ---------- small helpers ---------- */
const ms = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const diff = (a, b) => Math.round((ms(b) - ms(a)) / 864e5);           // b − a, in days
const plus = (s, n) => new Date(ms(s) + n * 864e5).toISOString().slice(0, 10);
const day = s => (s ? String(s).slice(0, 10) : null);
const sum = (arr, f) => arr.reduce((t, x) => t + (Number(f(x)) || 0), 0);
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
const avg = (arr, f) => (arr.length ? r1(sum(arr, f) / arr.length) : null);
const inRange = (d, from, to) => !!d && d >= from && d <= to;
const cell = (v, tone, sub) => ({ v, tone, sub });
const HEALTH_TONE = { 'On Track': 'good', 'At Risk': 'warn', Critical: 'bad' };
const BAND_TONE = { Critical: 'bad', High: 'warn', Medium: 'info', Low: 'good' };
const PRIORITY_TONE = BAND_TONE;
const DONE_EVENT = e => e.status === 'Completed';
const OPEN_RISK = r => r.status !== 'Closed';
const OPEN_ISSUE = x => x.status !== 'Resolved' && x.status !== 'Closed';
const money = (title, v) => ({ label: title, value: v, type: 'money' });

const kpis = (title, items) => ({ kind: 'kpis', title, items });
const table = (title, columns, rows, o = {}) => ({ kind: 'table', title, columns, rows, totals: o.totals || null, note: o.note || '', empty: o.empty || 'Nothing to show for the selected projects.', pageBreak: !!o.pageBreak });
const stack = (title, segments, o = {}) => ({ kind: 'stack', title, segments, note: o.note || '' });
const bullets = (title, items) => ({ kind: 'bullets', title, items });
const text = (title, t) => ({ kind: 'text', title, text: t });
const col = (key, label, type = 'text', align) => ({ key, label, type, align: align || (['text'].includes(type) ? 'left' : type === 'date' ? 'center' : 'right') });

/* Who may use what. */
const DATA_MENUS = { risks: ['risks-crud', 'risks'], issues: ['issues-crud'], milestones: ['milestones-crud', 'milestones'] };
function userCan(user, needs) {
  if (user.isAdmin) return true;
  needs = needs || {};
  if (needs.admin) return false;
  const menus = new Set(user.menus || []), perms = user.permissions || {};
  const has = r => (perms[r] || []).includes('view');
  if (!has('projects')) return false;
  if (needs.menus && !needs.menus.some(m => menus.has(m))) return false;
  if (needs.views && !needs.views.every(has)) return false;
  if (needs.anyView && !needs.anyView.some(has)) return false;
  if (needs.data && !(has(needs.data) && DATA_MENUS[needs.data].some(m => menus.has(m)))) return false;
  return true;
}

/* =========================================================
   BLOCKS
   ========================================================= */
const BLOCKS = {};
const block = (key, group, title, description, needs, build) => { BLOCKS[key] = { key, group, title, description, needs, build }; };

/* ---------- Management ---------- */
block('portfolio-kpis', 'Management', 'Portfolio key figures', 'Projects, progress, health split, budget, spend and open risks / issues on one strip.',
  { menus: ['overview', 'portfolio', 'health', 'financial'] }, async c => {
    const P = await c.projects();
    const budget = sum(P, p => p.approvedBudget), actual = sum(P, p => p.actualCost), committed = sum(P, p => p.committedCost);
    const n = s => P.filter(p => p.health === s && p.status !== 'Completed').length;
    const items = [
      { label: 'Projects', value: P.length, type: 'int', sub: `${P.filter(p => p.status === 'Active').length} active · ${P.filter(p => p.status === 'Completed').length} completed` },
      { label: 'Actual progress', value: avg(P, p => p.actualPct), type: 'pct', sub: `planned ${avg(P, p => p.plannedPct)}%`, tone: (avg(P, p => p.actualPct) - avg(P, p => p.plannedPct)) < -10 ? 'bad' : (avg(P, p => p.actualPct) - avg(P, p => p.plannedPct)) < -3 ? 'warn' : 'good' },
      { label: 'Health', value: `${n('On Track')} / ${n('At Risk')} / ${n('Critical')}`, type: 'text', sub: 'on track / at risk / critical' },
      money('Approved budget', budget),
      { label: 'Actual cost', value: actual, type: 'money', sub: budget > 0 ? `${r1(actual / budget * 100)}% of budget` : '', tone: budget > 0 && actual / budget > 1 ? 'bad' : budget > 0 && actual / budget > 0.9 ? 'warn' : undefined },
      money('Committed cost', committed)
    ];
    if (c.allow.risks) { const R = (await c.risks()).filter(OPEN_RISK); items.push({ label: 'Open risks', value: R.length, type: 'int', sub: `${R.filter(r => r.severityBand === 'Critical' || r.isCritical).length} critical`, tone: R.some(r => r.severityBand === 'Critical' || r.isCritical) ? 'bad' : undefined }); }
    if (c.allow.issues) { const I = (await c.issues()).filter(OPEN_ISSUE); items.push({ label: 'Open issues', value: I.length, type: 'int', sub: `${I.filter(x => x.isBlocking).length} blocking`, tone: I.some(x => x.isBlocking) ? 'warn' : undefined }); }
    return [kpis('Portfolio at a glance', items)];
  });

block('attention', 'Management', 'Management attention points', 'Plain-language list of what needs attention now — worked out from the data, nothing typed in.',
  { menus: ['overview', 'portfolio', 'health', 'financial'] }, async c => {
    const P = await c.projects(), out = [], today = c.today;
    const names = arr => arr.slice(0, 4).map(p => p.name).join(', ') + (arr.length > 4 ? ` and ${arr.length - 4} more` : '');
    const crit = P.filter(p => p.health === 'Critical' && p.status !== 'Completed'), risk = P.filter(p => p.health === 'At Risk' && p.status !== 'Completed');
    if (crit.length) out.push({ tone: 'bad', text: `${crit.length} project${crit.length > 1 ? 's are' : ' is'} rated Critical: ${names(crit)}.` });
    if (risk.length) out.push({ tone: 'warn', text: `${risk.length} project${risk.length > 1 ? 's are' : ' is'} At Risk: ${names(risk)}.` });
    const events = await c.events();
    const late = events.filter(e => !DONE_EVENT(e) && e.plannedEnd && e.plannedEnd < today);
    if (late.length) {
      const by = {}; late.forEach(e => { by[e.projectName] = (by[e.projectName] || 0) + 1; });
      const worst = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
      out.push({ tone: late.length > 10 ? 'bad' : 'warn', text: `${late.length} task${late.length > 1 ? 's are' : ' is'} past the planned finish date (most in ${worst[0]}: ${worst[1]}).` });
    }
    const delayed = P.filter(p => p.expectedDelayDays > 0 && p.status !== 'Completed');
    if (delayed.length) out.push({ tone: 'warn', text: `${delayed.length} project${delayed.length > 1 ? 's forecast' : ' forecasts'} a later finish than planned (up to ${Math.max(...delayed.map(p => p.expectedDelayDays))} days).` });
    const over = P.filter(p => p.approvedBudget > 0 && p.actualCost > p.approvedBudget), near = P.filter(p => p.approvedBudget > 0 && p.actualCost / p.approvedBudget > 0.9 && p.actualCost <= p.approvedBudget);
    if (over.length) out.push({ tone: 'bad', text: `${over.length} project${over.length > 1 ? 's have' : ' has'} spent more than the approved budget: ${names(over)}.` });
    if (near.length) out.push({ tone: 'warn', text: `${near.length} project${near.length > 1 ? 's have' : ' has'} used over 90% of the approved budget: ${names(near)}.` });
    if (c.allow.risks) { const k = (await c.risks()).filter(r => OPEN_RISK(r) && (r.severityBand === 'Critical' || r.isCritical)); if (k.length) out.push({ tone: 'bad', text: `${k.length} critical risk${k.length > 1 ? 's are' : ' is'} open.` }); }
    if (c.allow.issues) { const k = (await c.issues()).filter(x => OPEN_ISSUE(x) && x.isBlocking); if (k.length) out.push({ tone: 'warn', text: `${k.length} blocking issue${k.length > 1 ? 's are' : ' is'} open.` }); }
    if (c.allow.milestones) { const k = (await c.milestones()).filter(m => m.status === 'Delayed' || (m.dueDate && m.dueDate < today && m.status !== 'On Track')); if (k.length) out.push({ tone: 'warn', text: `${k.length} milestone${k.length > 1 ? 's are' : ' is'} delayed or overdue.` }); }
    const wait = (await c.approvals()).filter(a => a.ageDays != null && a.ageDays > 7);
    if (wait.length) out.push({ tone: 'warn', text: `${wait.length} document${wait.length > 1 ? 's have' : ' has'} been waiting for approval for more than 7 days.` });
    if (!out.length) out.push({ tone: 'good', text: 'No exceptions: every project is within tolerance on schedule, cost, risk and approvals.' });
    return [bullets('Attention points', out)];
  });

block('health-summary', 'Management', 'Project health', 'Health split (on track / at risk / critical) and what drives each project\'s rating.',
  { menus: ['health', 'overview', 'portfolio'] }, async c => {
    const P = await c.projects();
    const n = s => P.filter(p => p.health === s).length;
    const rows = [...P].sort((a, b) => ({ Critical: 0, 'At Risk': 1, 'On Track': 2 }[a.health] - { Critical: 0, 'At Risk': 1, 'On Track': 2 }[b.health]) || a.name.localeCompare(b.name)).map(p => ({
      project: p.name, bu: p.businessUnit || '—', status: p.status, actual: p.actualPct, variance: cell(p.variance, p.variance < -10 ? 'bad' : p.variance < -3 ? 'warn' : 'good'),
      cost: cell(p.costUtilization, p.costUtilization > 100 ? 'bad' : p.costUtilization > 90 ? 'warn' : undefined), risks: cell(p.criticalRisks, p.criticalRisks ? 'bad' : undefined),
      issues: cell(p.openIssues, p.openIssues > 3 ? 'warn' : undefined), delay: p.expectedDelayDays, health: cell(p.health, HEALTH_TONE[p.health])
    }));
    return [
      stack('Health split', [{ label: 'On Track', value: n('On Track'), tone: 'good' }, { label: 'At Risk', value: n('At Risk'), tone: 'warn' }, { label: 'Critical', value: n('Critical'), tone: 'bad' }]),
      table('Health by project', [col('project', 'Project'), col('bu', 'Business unit'), col('status', 'Status'), col('actual', 'Progress %', 'pct'), col('variance', 'Variance (pts)', 'num1'),
        col('cost', 'Cost used %', 'pct'), col('risks', 'Critical risks', 'int'), col('issues', 'Open issues', 'int'), col('delay', 'Delay (days)', 'int'), col('health', 'Health', 'text', 'center')], rows,
      { note: 'Health follows the dashboard rule: points for progress behind plan, cost over 90% / 100% of budget, critical risks, more than 3 open issues and a Delayed status — 2+ points is At Risk, 4+ is Critical.' })
    ];
  });

block('by-business-unit', 'Management', 'Roll-up by business unit', 'Subsidiary consolidation: each business unit side by side, with a group total.',
  { menus: ['portfolio', 'overview', 'health', 'financial'] }, async c => {
    const P = await c.projects(), groups = new Map();
    P.forEach(p => { const k = p.businessUnit || 'Unassigned'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); });
    const line = (name, L) => ({
      bu: name, projects: L.length, budget: sum(L, p => p.approvedBudget), actual: sum(L, p => p.actualCost),
      used: sum(L, p => p.approvedBudget) > 0 ? r1(sum(L, p => p.actualCost) / sum(L, p => p.approvedBudget) * 100) : null,
      progress: avg(L, p => p.actualPct), atRisk: cell(L.filter(p => p.health === 'At Risk').length, L.some(p => p.health === 'At Risk') ? 'warn' : undefined),
      critical: cell(L.filter(p => p.health === 'Critical').length, L.some(p => p.health === 'Critical') ? 'bad' : undefined), issues: sum(L, p => p.openIssues)
    });
    const rows = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, L]) => line(k, L));
    return [table('Business units', [col('bu', 'Business unit'), col('projects', 'Projects', 'int'), col('budget', 'Approved budget (OMR)', 'money'), col('actual', 'Actual cost (OMR)', 'money'),
      col('used', 'Cost used %', 'pct'), col('progress', 'Avg progress %', 'pct'), col('atRisk', 'At risk', 'int'), col('critical', 'Critical', 'int'), col('issues', 'Open issues', 'int')],
      rows, { totals: groups.size > 1 ? line('Group total', P) : null, note: 'All amounts are in OMR. A subsidiary that reports in another currency has to be converted before it is entered.' })];
  });

/* ---------- Progress & schedule ---------- */
block('progress-table', 'Progress & schedule', 'Progress by project', 'Planned vs actual progress, forecast finish, delay and task counts — per project, with a consolidated total row.',
  { menus: ['progress', 'gantt', 'overview', 'portfolio'] }, async c => {
    const P = await c.projects(), E = await c.events();
    const rowOf = p => {
      const ev = E.filter(e => e.projectId === p.id), late = ev.filter(e => !DONE_EVENT(e) && e.plannedEnd && e.plannedEnd < c.today).length;
      return { project: p.name, bu: p.businessUnit || '—', status: p.status, planned: p.plannedPct, actual: p.actualPct, variance: cell(p.variance, p.variance < -10 ? 'bad' : p.variance < -3 ? 'warn' : 'good'),
        tasks: `${ev.filter(DONE_EVENT).length} / ${ev.length}`, late: cell(late, late ? 'warn' : undefined), start: p.startDate, end: p.endDate, revised: p.revisedCompletionDate, delay: cell(p.expectedDelayDays, p.expectedDelayDays > 0 ? 'warn' : undefined), pm: p.projectManager || '—', _late: late, _done: ev.filter(DONE_EVENT).length, _n: ev.length };
    };
    const rows = P.map(rowOf);
    const totals = P.length > 1 ? { project: 'Consolidated', planned: avg(P, p => p.plannedPct), actual: avg(P, p => p.actualPct), variance: r1(avg(P, p => p.actualPct) - avg(P, p => p.plannedPct)),
      tasks: `${sum(rows, r => r._done)} / ${sum(rows, r => r._n)}`, late: sum(rows, r => r._late), delay: Math.max(0, ...P.map(p => p.expectedDelayDays)) } : null;
    rows.forEach(r => { delete r._late; delete r._done; delete r._n; });
    return [table('Progress by project', [col('project', 'Project'), col('bu', 'Business unit'), col('status', 'Status'), col('planned', 'Planned %', 'pct'), col('actual', 'Actual %', 'pct'), col('variance', 'Variance (pts)', 'num1'),
      col('tasks', 'Tasks done', 'text', 'right'), col('late', 'Overdue tasks', 'int'), col('start', 'Start', 'date'), col('end', 'Planned finish', 'date'), col('revised', 'Forecast finish', 'date'), col('delay', 'Delay (days)', 'int'), col('pm', 'Project manager')],
      rows, { totals, note: 'Planned % is time elapsed; actual % weights each task\'s progress by its planned duration. The consolidated row averages the projects and shows the longest delay.' })];
  });

block('period-activity', 'Progress & schedule', 'Activity in the period', 'What happened between the report dates: tasks finished, change requests, risks / issues raised, milestones due.',
  { menus: ['progress', 'gantt', 'overview', 'portfolio'] }, async c => {
    const { from, to } = c.period, P = await c.projects(), E = await c.events();
    const crs = c.allow.changes ? await c.crs() : null;
    const R = c.allow.risks ? await c.risks() : null, I = c.allow.issues ? await c.issues() : null, M = c.allow.milestones ? await c.milestones() : null, C = c.allow.certificates ? await c.certs() : null;
    const per = p => {
      const ev = E.filter(e => e.projectId === p.id);
      const o = { project: p.name, finished: ev.filter(e => inRange(day(e.actualEnd), from, to)).length, started: ev.filter(e => inRange(day(e.actualStart), from, to)).length };
      if (crs) o.crs = crs.filter(x => x.projectId === p.id && inRange(day(x.dateSubmitted), from, to)).length;
      if (R) o.risks = R.filter(x => x.projectId === p.id && inRange(day(x.identifiedDate), from, to)).length;
      if (I) { o.issuesNew = I.filter(x => x.projectId === p.id && inRange(day(x.raisedDate), from, to)).length; o.issuesDone = I.filter(x => x.projectId === p.id && inRange(day(x.actualResolutionDate), from, to)).length; }
      if (M) o.milestones = M.filter(x => x.projectId === p.id && inRange(day(x.dueDate), from, to)).length;
      if (C) o.certs = C.filter(x => x.projectId === p.id && inRange(day(x.completionDate), from, to)).length;
      return o;
    };
    const rows = P.map(per);
    const cols = [col('project', 'Project'), col('finished', 'Tasks finished', 'int'), col('started', 'Tasks started', 'int')];
    const items = [{ label: 'Tasks finished', value: sum(rows, r => r.finished), type: 'int' }, { label: 'Tasks started', value: sum(rows, r => r.started), type: 'int' }];
    if (crs) { cols.push(col('crs', 'Change requests raised', 'int')); items.push({ label: 'Change requests raised', value: sum(rows, r => r.crs), type: 'int' }); }
    if (R) { cols.push(col('risks', 'Risks raised', 'int')); items.push({ label: 'Risks raised', value: sum(rows, r => r.risks), type: 'int' }); }
    if (I) { cols.push(col('issuesNew', 'Issues raised', 'int'), col('issuesDone', 'Issues resolved', 'int')); items.push({ label: 'Issues raised', value: sum(rows, r => r.issuesNew), type: 'int' }, { label: 'Issues resolved', value: sum(rows, r => r.issuesDone), type: 'int' }); }
    if (M) { cols.push(col('milestones', 'Milestones due', 'int')); items.push({ label: 'Milestones due', value: sum(rows, r => r.milestones), type: 'int' }); }
    if (C) { cols.push(col('certs', 'Completion certificates', 'int')); items.push({ label: 'Completion certificates', value: sum(rows, r => r.certs), type: 'int' }); }
    const totals = P.length > 1 ? Object.fromEntries([['project', 'Total'], ...cols.slice(1).map(k => [k.key, sum(rows, r => r[k.key])])]) : null;
    return [kpis(`Activity ${c.period.label}`, items), table('Activity by project', cols, rows, { totals, note: `Counted by date between ${c.period.from} and ${c.period.to}.` })];
  });

block('stage-progress', 'Progress & schedule', 'Progress by stage', 'Tasks and progress for each project stage (mobilization … closure).',
  { menus: ['progress', 'gantt', 'overview'] }, async c => {
    const E = await c.events();
    const rows = c.STAGES.map(s => {
      const ev = E.filter(e => e.stage === s); if (!ev.length) return null;
      const late = ev.filter(e => !DONE_EVENT(e) && e.plannedEnd && e.plannedEnd < c.today).length;
      return { stage: s, tasks: ev.length, done: ev.filter(DONE_EVENT).length, doing: ev.filter(e => e.status === 'In Progress').length, todo: ev.filter(e => e.status === 'Not Started').length, late: cell(late, late ? 'warn' : undefined), progress: avg(ev, e => (DONE_EVENT(e) ? 100 : e.progressPct)) };
    }).filter(Boolean);
    const totals = rows.length > 1 ? { stage: 'All stages', tasks: sum(rows, r => r.tasks), done: sum(rows, r => r.done), doing: sum(rows, r => r.doing), todo: sum(rows, r => r.todo), late: sum(rows, r => r.late.v), progress: avg(E, e => (DONE_EVENT(e) ? 100 : e.progressPct)) } : null;
    return [table('Progress by stage', [col('stage', 'Stage'), col('tasks', 'Tasks', 'int'), col('done', 'Completed', 'int'), col('doing', 'In progress', 'int'), col('todo', 'Not started', 'int'), col('late', 'Overdue', 'int'), col('progress', 'Avg progress %', 'pct')],
      rows, { totals, empty: 'No tasks have been planned for the selected projects.' })];
  });

block('late-tasks', 'Progress & schedule', 'Late and upcoming tasks', 'Tasks past their planned finish (worst first) and tasks due in the next 14 days.',
  { menus: ['gantt', 'progress'] }, async c => {
    const E = await c.events(), top = c.opts.top || 30, today = c.today;
    const late = E.filter(e => !DONE_EVENT(e) && e.plannedEnd && e.plannedEnd < today).map(e => ({ e, d: diff(e.plannedEnd, today) })).sort((a, b) => b.d - a.d);
    const soon = E.filter(e => !DONE_EVENT(e) && e.plannedEnd && e.plannedEnd >= today && e.plannedEnd <= plus(today, 14)).sort((a, b) => a.plannedEnd.localeCompare(b.plannedEnd));
    const cols = [col('project', 'Project'), col('stage', 'Stage'), col('task', 'Task'), col('end', 'Planned finish', 'date'), col('days', 'Days', 'int'), col('status', 'Status'), col('progress', 'Progress %', 'pct'), col('who', 'Assigned to')];
    const row = (e, d, tone) => ({ project: e.projectName, stage: e.stage, task: e.eventName, end: e.plannedEnd, days: cell(d, tone), status: e.status, progress: DONE_EVENT(e) ? 100 : e.progressPct || 0, who: e.assignedTo || '—' });
    const cut = (arr, label) => (arr.length > top ? `Showing the ${top} ${label} of ${arr.length}.` : '');
    return [
      table('Tasks past their planned finish date', cols.map(k => (k.key === 'days' ? { ...k, label: 'Days late' } : k)), late.slice(0, top).map(x => row(x.e, x.d, x.d > 30 ? 'bad' : 'warn')),
        { empty: 'No task is past its planned finish date.', note: [cut(late, 'latest'), 'The programme holds no task-dependency data, so this is a list of late and imminent tasks — not a calculated critical path.'].filter(Boolean).join(' ') }),
      table('Tasks due in the next 14 days', cols.map(k => (k.key === 'days' ? { ...k, label: 'Days left' } : k)), soon.slice(0, top).map(e => row(e, diff(today, e.plannedEnd), diff(today, e.plannedEnd) <= 3 ? 'warn' : undefined)),
        { empty: 'No task is due in the next 14 days.', note: cut(soon, 'soonest') })
    ];
  });

block('project-pages', 'Progress & schedule', 'A page for each project', 'One page per project: key figures, stage progress and late tasks. (Up to 12 projects.)',
  { menus: ['progress', 'gantt'] }, async c => {
    const P = (await c.projects()).slice(0, 12), E = await c.events(), out = [];
    P.forEach((p, i) => {
      const ev = E.filter(e => e.projectId === p.id), late = ev.filter(e => !DONE_EVENT(e) && e.plannedEnd && e.plannedEnd < c.today).sort((a, b) => a.plannedEnd.localeCompare(b.plannedEnd));
      const k = kpis(`${p.code} — ${p.name}`, [
        { label: 'Status', value: p.status, type: 'text', sub: p.businessUnit || '' }, { label: 'Actual progress', value: p.actualPct, type: 'pct', sub: `planned ${p.plannedPct}%`, tone: p.variance < -10 ? 'bad' : p.variance < -3 ? 'warn' : 'good' },
        { label: 'Health', value: p.health, type: 'text', tone: HEALTH_TONE[p.health] }, { label: 'Tasks done', value: `${ev.filter(DONE_EVENT).length} / ${ev.length}`, type: 'text', sub: `${late.length} overdue`, tone: late.length ? 'warn' : undefined },
        { label: 'Planned finish', value: p.endDate, type: 'date', sub: p.expectedDelayDays > 0 ? `forecast ${p.revisedCompletionDate} (+${p.expectedDelayDays} d)` : 'on plan', tone: p.expectedDelayDays > 0 ? 'warn' : undefined },
        { label: 'Project manager', value: p.projectManager || '—', type: 'text' }]);
      k.pageBreak = i > 0;
      const stages = c.STAGES.map(s => { const x = ev.filter(e => e.stage === s); return x.length ? { stage: s, tasks: x.length, done: x.filter(DONE_EVENT).length, late: x.filter(e => !DONE_EVENT(e) && e.plannedEnd && e.plannedEnd < c.today).length, progress: avg(x, e => (DONE_EVENT(e) ? 100 : e.progressPct)) } : null; }).filter(Boolean);
      out.push(k,
        table('Stage progress', [col('stage', 'Stage'), col('tasks', 'Tasks', 'int'), col('done', 'Completed', 'int'), col('late', 'Overdue', 'int'), col('progress', 'Avg progress %', 'pct')], stages, { empty: 'No tasks planned.' }),
        ...(late.length ? [table('Overdue tasks', [col('task', 'Task'), col('stage', 'Stage'), col('end', 'Planned finish', 'date'), col('days', 'Days late', 'int'), col('who', 'Assigned to')],
          late.slice(0, 8).map(e => ({ task: e.eventName, stage: e.stage, end: e.plannedEnd, days: cell(diff(e.plannedEnd, c.today), 'warn'), who: e.assignedTo || '—' })), { note: late.length > 8 ? `Showing the 8 longest overdue of ${late.length}.` : '' })] : []));
    });
    return out;
  });

block('progress-performance', 'Progress & schedule', 'Progress performance (SPI, days, forecast)', 'Planned vs actual progress, SPI, days ahead / behind, activities completed this period and forecast finish - per project and combined, with the S-curve figures.',
  { menus: ['progress', 'gantt', 'overview', 'portfolio'] }, async c => {
    const P = await c.projects(), E = await c.events();
    const an = PC.analyse(P, E, { today: c.today, from: c.period.from, to: c.period.to }), T = an.portfolio, tone = v => (v == null ? undefined : v >= 0.95 ? 'good' : v >= 0.85 ? 'warn' : 'bad');
    const vt = v => (v < -10 ? 'bad' : v < -3 ? 'warn' : 'good');
    const rows = an.rows.map(r => ({ project: r.name, bu: r.businessUnit || '—', planned: r.planned, actual: r.actual, variance: cell(r.variance, vt(r.variance)), spi: cell(r.spi, tone(r.spi)),
      sv: r.svDays == null ? cell('not started', 'muted') : cell(r.svDays, r.svDays >= 0 ? 'good' : r.svDays > -14 ? 'warn' : 'bad'), tasks: `${r.done} / ${r.tasks}`, overdue: cell(r.overdue, r.overdue ? 'warn' : undefined),
      baseline: r.baseline, forecast: r.forecast, delay: r.forecastDelay == null ? null : cell(r.forecastDelay, r.forecastDelay > 0 ? 'bad' : r.forecastDelay < 0 ? 'good' : undefined) }));
    const curve = PC.curve(an, { points: 14 });
    const curveRows = curve.dates.map((d, i) => ({ date: d, planned: curve.planned[i], actual: curve.actual[i], earned: curve.earned[i] }));
    return [
      kpis('Progress at a glance', [
        { label: 'Actual progress', value: T.actual, type: 'pct', sub: `planned ${T.planned}% · ${T.variance > 0 ? '+' : ''}${T.variance} pts`, tone: vt(T.variance) },
        { label: 'Schedule performance (SPI)', value: T.spi, type: 'ratio', tone: tone(T.spi), sub: T.projects > 1 ? 'budget-weighted' : 'actual ÷ planned' },
        { label: 'Days ahead (+) / behind (−)', value: T.svDays, type: 'int', tone: T.svDays == null ? undefined : T.svDays >= 0 ? 'good' : T.svDays > -14 ? 'warn' : 'bad', sub: `${T.ahead} ahead · ${T.behind} behind` },
        { label: `Activities finished ${c.period.label}`, value: T.finishedInPeriod, type: 'int', sub: T.dueInPeriod ? `${T.dueDonePct}% of ${T.dueInPeriod} due` : 'none were due' },
        { label: 'Forecast completion', value: T.forecastLatest, type: 'date', sub: T.baselineLatest ? `baseline ${T.baselineLatest.split('-').reverse().join('/')} · ${T.forecastLate} forecast late` : '', tone: T.forecastLate ? 'warn' : undefined }]),
      table('Progress performance by project', [col('project', 'Project'), col('bu', 'Business unit'), col('planned', 'Planned %', 'pct'), col('actual', 'Actual %', 'pct'), col('variance', 'Variance (pts)', 'num1'), col('spi', 'SPI', 'ratio'),
        col('sv', 'Days ahead (+) / behind (−)', 'int'), col('tasks', 'Tasks done', 'text', 'right'), col('overdue', 'Overdue', 'int'), col('baseline', 'Baseline finish', 'date'), col('forecast', 'Forecast finish', 'date'), col('delay', 'Forecast delay (days)', 'int')], rows,
      { totals: P.length > 1 ? { project: 'Combined', planned: T.planned, actual: T.actual, variance: T.variance, spi: T.spi, sv: T.svDays, tasks: `${T.done} / ${T.tasks}`, overdue: T.overdue } : null,
        note: "Planned % = how much of the task schedule should be finished today; actual % = weighted task progress. SPI = actual / planned. Days use earned schedule (the date the plan reached today's actual %). Forecast = current pace carried to the end. Combined figures average the projects (SPI is budget-weighted)." }),
      table('Cumulative progress over time (S-curve figures)', [col('date', 'Date', 'date'), col('planned', 'Planned %', 'pct'), col('actual', 'Actual %', 'pct'), ...(curve.many ? [col('earned', 'Earned % (budget-weighted)', 'pct')] : [])], curveRows,
        { note: "Actual values before today are rebuilt from the recorded actual start / finish dates, so they are an estimate; today's value is exact.", empty: 'No scheduled tasks.' })
    ];
  });

block('slippage-recovery', 'Progress & schedule', 'Slippage and recovery', 'Which projects lost or recovered schedule during the period, month-by-month slippage, and the activities now overdue.',
  { menus: ['progress', 'gantt', 'overview', 'portfolio'] }, async c => {
    const P = await c.projects(), E = await c.events();
    const an = PC.analyse(P, E, { today: c.today, from: c.period.from, to: c.period.to }), then = PC.stateAt(an, plus(c.period.from, -1));
    const rows = an.rows.map(r => {
      const b = then[r.id], before = b && b.svDays != null ? b.svDays : null, now = r.svDays;
      const ch = before != null && now != null ? now - before : null;
      return { project: r.name, before, now, change: ch == null ? null : cell(ch, ch > 0 ? 'good' : ch < 0 ? 'bad' : undefined), verdict: ch == null ? cell('not measurable', 'muted') : ch > 0 ? cell('Recovered', 'good') : ch < 0 ? cell('Slipped', 'bad') : cell('No change', 'muted'),
        overdue: cell(r.overdue, r.overdue ? 'warn' : undefined), forecast: r.forecast, delay: r.forecastDelay == null ? null : cell(r.forecastDelay, r.forecastDelay > 0 ? 'bad' : undefined) };
    }).sort((a, b) => ((a.change && a.change.v) || 0) - ((b.change && b.change.v) || 0));
    const w = PC.slippage(an, 6);
    const late = PC.measurement(an).filter(m => m.overdue).sort((a, b) => b.daysLate - a.daysLate).slice(0, c.opts.top || 20);
    const slipped = rows.filter(r => r.verdict.v === 'Slipped').length, rec = rows.filter(r => r.verdict.v === 'Recovered').length;
    return [
      kpis(`Schedule movement ${c.period.label}`, [{ label: 'Projects that slipped', value: slipped, type: 'int', tone: slipped ? 'bad' : 'good' }, { label: 'Projects that recovered', value: rec, type: 'int', tone: rec ? 'good' : undefined },
        { label: 'Days ahead (+) / behind (−) now', value: an.portfolio.svDays, type: 'int', sub: 'average of the projects', tone: an.portfolio.svDays == null ? undefined : an.portfolio.svDays >= 0 ? 'good' : 'warn' }, { label: 'Overdue activities', value: an.portfolio.overdue, type: 'int', tone: an.portfolio.overdue ? 'warn' : 'good' }]),
      table('Slippage and recovery by project', [col('project', 'Project'), col('before', 'Days at start of period', 'int'), col('now', 'Days now', 'int'), col('change', 'Gained (+) / lost (−)', 'int'), col('verdict', 'Result', 'text', 'center'),
        col('overdue', 'Overdue tasks', 'int'), col('forecast', 'Forecast finish', 'date'), col('delay', 'Forecast delay (days)', 'int')], rows,
      { note: 'Days = earned schedule: positive is ahead of plan, negative behind. The start-of-period position is rebuilt from the recorded actual dates, so it is an estimate.', empty: 'No projects.' }),
      table('Slippage by month (combined)', [col('asAt', 'As at', 'date'), col('sv', 'Days ahead (+) / behind (−)', 'int'), col('change', 'Gained (+) / lost (−) in the month', 'int')],
        w.steps.map(s => ({ asAt: s.asAt, sv: s.sv, change: s.change == null ? null : cell(s.change, s.change > 0 ? 'good' : s.change < 0 ? 'bad' : undefined) })), { note: 'The first row is the opening position; each later row shows what that month added or took away.' }),
      table('Most overdue activities', [col('project', 'Project'), col('stage', 'Stage'), col('task', 'Activity'), col('plannedEnd', 'Planned finish', 'date'), col('daysLate', 'Days late', 'int'), col('status', 'Status'), col('actual', 'Progress %', 'pct'), col('owner', 'Owner')],
        late.map(m => ({ project: m.project, stage: m.stage, task: m.task, plannedEnd: m.plannedEnd, daysLate: cell(m.daysLate, m.daysLate > 30 ? 'bad' : 'warn'), status: m.status, actual: m.actual, owner: m.owner || '—' })), { empty: 'No activity is overdue.' })
    ];
  });

/* ---------- Financial ---------- */
block('financial-evm', 'Financial', 'Earned value (EVM) by project', 'Budget, planned value, earned value, actual cost, CPI / SPI and forecast at completion for each project.',
  { menus: ['financial'] }, async c => {
    const P = await c.projects();
    const calc = L => {
      const BAC = sum(L, p => p.approvedBudget), PV = sum(L, p => p.approvedBudget * p.plannedPct / 100), EV = sum(L, p => p.approvedBudget * p.actualPct / 100), AC = sum(L, p => p.actualCost);
      const CPI = AC > 0 ? r2(EV / AC) : null, SPI = PV > 0 ? r2(EV / PV) : null, EAC = CPI ? r3(BAC / CPI) : null;
      return { BAC, PV: r3(PV), EV: r3(EV), AC: r3(AC), CPI, SPI, EAC, VAC: EAC != null ? r3(BAC - EAC) : null, CV: r3(EV - AC), SV: r3(EV - PV) };
    };
    const tone = v => (v == null ? undefined : v >= 0.95 ? 'good' : v >= 0.85 ? 'warn' : 'bad');
    const line = (name, L, extra) => { const m = calc(L); return { project: name, ...extra, bac: m.BAC, pv: m.PV, ev: m.EV, ac: m.AC, committed: sum(L, p => p.committedCost), cpi: cell(m.CPI, tone(m.CPI)), spi: cell(m.SPI, tone(m.SPI)), eac: m.EAC, vac: cell(m.VAC, m.VAC != null && m.VAC < 0 ? 'bad' : undefined) }; };
    const T = calc(P);
    return [
      kpis('Portfolio earned value', [money('Budget at completion (BAC)', T.BAC), money('Planned value (PV)', T.PV), money('Earned value (EV)', T.EV), money('Actual cost (AC)', T.AC),
        { label: 'Cost performance (CPI)', value: T.CPI, type: 'ratio', tone: tone(T.CPI), sub: T.CPI == null ? 'no actual cost recorded yet' : T.CPI >= 1 ? 'under budget for the work done' : 'over budget for the work done' },
        { label: 'Schedule performance (SPI)', value: T.SPI, type: 'ratio', tone: tone(T.SPI), sub: T.SPI == null ? 'no planned value yet' : T.SPI >= 1 ? 'ahead of plan' : 'behind plan' },
        { label: 'Forecast at completion (EAC)', value: T.EAC, type: 'money', sub: T.EAC == null ? 'needs actual cost' : `variance ${T.VAC < 0 ? '−' : ''}${Math.abs(T.VAC).toLocaleString('en-US', { maximumFractionDigits: 0 })} OMR` }]),
      table('Earned value by project', [col('project', 'Project'), col('bac', 'BAC (OMR)', 'money'), col('pv', 'PV (OMR)', 'money'), col('ev', 'EV (OMR)', 'money'), col('ac', 'AC (OMR)', 'money'), col('committed', 'Committed (OMR)', 'money'),
        col('cpi', 'CPI', 'ratio'), col('spi', 'SPI', 'ratio'), col('eac', 'EAC (OMR)', 'money'), col('vac', 'VAC (OMR)', 'money')],
      P.map(p => line(p.name, [p])), { totals: P.length > 1 ? line('Portfolio', P) : null,
        note: 'BAC = approved budget. PV = BAC × planned %. EV = BAC × actual %. AC = recorded actual cost (consumed materials + crew actual quantities). CPI = EV ÷ AC; SPI = EV ÷ PV; EAC = BAC ÷ CPI. CPI shows "—" until actual cost has been recorded; ≥ 0.95 green, ≥ 0.85 amber, below red.' })
    ];
  });

block('cost-by-stage', 'Financial', 'Cost by project stage', 'Material and crew / labour cost — committed and actual — for each stage.',
  { menus: ['financial'] }, async c => {
    const { materials, crews } = await c.costLines(), by = {};
    const get = s => (by[s] ||= { stage: s, mp: 0, ma: 0, cp: 0, ca: 0 });
    materials.forEach(m => { const g = get(m.stage); g.mp += (m.planned_qty || 0) * (m.unit_rate || 0); g.ma += (m.consumed_qty || 0) * (m.unit_rate || 0); });
    crews.forEach(k => { const g = get(k.stage); g.cp += c.crewLineCost(k.quantity, k.rate_basis, k.unit_rate, k.allocated_days); g.ca += c.crewLineCost(k.actual_qty, k.rate_basis, k.unit_rate, k.allocated_days); });
    const row = g => ({ stage: g.stage, mp: r3(g.mp), ma: r3(g.ma), cp: r3(g.cp), ca: r3(g.ca), committed: r3(g.mp + g.cp), actual: r3(g.ma + g.ca) });
    const stages = [...c.STAGES, ...Object.keys(by).filter(s => !c.STAGES.includes(s))].filter(s => by[s]).map(s => row(by[s]));
    const T = { stage: 'All stages', mp: sum(stages, r => r.mp), ma: sum(stages, r => r.ma), cp: sum(stages, r => r.cp), ca: sum(stages, r => r.ca), committed: sum(stages, r => r.committed), actual: sum(stages, r => r.actual) };
    return [table('Cost by stage', [col('stage', 'Stage'), col('mp', 'Materials planned', 'money'), col('ma', 'Materials actual', 'money'), col('cp', 'Crew planned', 'money'), col('ca', 'Crew actual', 'money'), col('committed', 'Committed total', 'money'), col('actual', 'Actual total', 'money')],
      stages, { totals: stages.length > 1 ? T : null, empty: 'No material or crew lines have been entered yet.', note: 'Amounts in OMR, from the project cost statements (Material Consumption and Crew / Labour lines).' })];
  });

block('change-cost', 'Financial', 'Change requests and cost impact', 'Where each change request stands (analysis → decision) and the approved cost impact per project.',
  { views: ['change_requests'] }, async c => {
    const P = await c.projects(), K = await c.crs(), today = c.today;
    const stage = k => (k.decision || (k.analysisCount > 0 ? 'Awaiting decision' : 'Awaiting analysis'));
    const per = p => { const L = K.filter(k => k.projectId === p.id); return { project: p.name, total: L.length, wa: L.filter(k => stage(k) === 'Awaiting analysis').length, wd: L.filter(k => stage(k) === 'Awaiting decision').length,
      ok: L.filter(k => k.decision === 'Approved').length, no: L.filter(k => k.decision === 'Rejected' || k.decision === 'Deferred').length, cost: r3(sum(L.filter(k => k.decision === 'Approved'), k => k.costImpact)) }; };
    const rows = P.map(per);
    const open = K.filter(k => !k.decision).sort((a, b) => (a.dateSubmitted || '').localeCompare(b.dateSubmitted || ''));
    const pn = Object.fromEntries(P.map(p => [p.id, p.name]));
    return [
      stack('Change request pipeline', [{ label: 'Awaiting analysis', value: K.filter(k => stage(k) === 'Awaiting analysis').length, tone: 'warn' }, { label: 'Awaiting decision', value: K.filter(k => stage(k) === 'Awaiting decision').length, tone: 'info' },
        { label: 'Approved', value: K.filter(k => k.decision === 'Approved').length, tone: 'good' }, { label: 'Rejected / deferred', value: K.filter(k => k.decision === 'Rejected' || k.decision === 'Deferred').length, tone: 'muted' }]),
      table('Change requests by project', [col('project', 'Project'), col('total', 'Requests', 'int'), col('wa', 'Awaiting analysis', 'int'), col('wd', 'Awaiting decision', 'int'), col('ok', 'Approved', 'int'), col('no', 'Rejected / deferred', 'int'), col('cost', 'Approved cost impact (OMR)', 'money')],
        rows, { totals: P.length > 1 ? { project: 'Total', total: sum(rows, r => r.total), wa: sum(rows, r => r.wa), wd: sum(rows, r => r.wd), ok: sum(rows, r => r.ok), no: sum(rows, r => r.no), cost: r3(sum(rows, r => r.cost)) } : null, empty: 'No change requests.' }),
      table('Change requests still open', [col('code', 'Reference'), col('project', 'Project'), col('type', 'Type'), col('source', 'Raised by'), col('submitted', 'Submitted', 'date'), col('age', 'Age (days)', 'int'), col('stage', 'Stage'), col('cost', 'Cost impact (OMR)', 'money')],
        open.slice(0, 25).map(k => ({ code: k.crCode, project: pn[k.projectId], type: k.crType, source: k.crSource, submitted: k.dateSubmitted, age: k.dateSubmitted ? cell(diff(day(k.dateSubmitted), today), diff(day(k.dateSubmitted), today) > 30 ? 'warn' : undefined) : null, stage: stage(k), cost: k.costImpact })),
        { empty: 'Every change request has a decision.', note: open.length > 25 ? `Showing the 25 oldest of ${open.length}.` : '' })
    ];
  });

block('billing', 'Financial', 'Invoices and VOWD statements', 'Invoices by status and the VOWD statements issued / awaiting approval.',
  { menus: ['financial'], anyView: ['invoices', 'vowd'] }, async c => {
    const out = [];
    if (c.allow.invoices) {
      const I = await c.invoices(), by = {};
      I.forEach(i => { const g = (by[i.status] ||= { status: i.status, n: 0, total: 0 }); g.n++; g.total += Number(i.grand_total) || 0; });
      const rows = Object.values(by).map(g => ({ status: g.status, n: g.n, total: r3(g.total) }));
      out.push(table('Invoices by status', [col('status', 'Status'), col('n', 'Invoices', 'int'), col('total', 'Value incl. VAT (OMR)', 'money')], rows, { totals: rows.length > 1 ? { status: 'Total', n: sum(rows, r => r.n), total: r3(sum(rows, r => r.total)) } : null, empty: 'No invoices.' }));
    }
    if (c.allow.vowd) {
      const V = await c.vowds(), by = {};
      V.forEach(v => { const g = (by[v.status] ||= { status: v.status, n: 0, wait: 0 }); g.n++; if (v.approval_status === 'Pending') g.wait++; });
      out.push(table('VOWD statements by status', [col('status', 'Status'), col('n', 'Statements', 'int'), col('wait', 'Awaiting approval', 'int')], Object.values(by), { empty: 'No VOWD statements.' }));
    }
    return out;
  });

block('procurement', 'Financial', 'Procurement and supply status', 'Materials by status, planned vs consumed value, top suppliers and deliveries that are overdue.',
  { menus: ['financial', 'progress'] }, async c => {
    const { materials } = await c.costLines(), pn = Object.fromEntries((await c.projects()).map(p => [p.id, p.name])), today = c.today;
    const val = (q, m) => (q || 0) * (m.unit_rate || 0);
    const status = {}; materials.forEach(m => { const g = (status[m.status] ||= { status: m.status, n: 0, planned: 0, used: 0 }); g.n++; g.planned += val(m.planned_qty, m); g.used += val(m.consumed_qty, m); });
    const sup = {}; materials.forEach(m => { const k = m.supplier || '(no supplier)'; const g = (sup[k] ||= { supplier: k, n: 0, planned: 0 }); g.n++; g.planned += val(m.planned_qty, m); });
    const lateM = materials.filter(m => m.delivery_date && m.delivery_date < today && m.status === 'Ordered').sort((a, b) => a.delivery_date.localeCompare(b.delivery_date));
    const planned = sum(materials, m => val(m.planned_qty, m)), used = sum(materials, m => val(m.consumed_qty, m));
    return [
      kpis('Supply position', [{ label: 'Material lines', value: materials.length, type: 'int' }, money('Planned value', r3(planned)), money('Consumed value', r3(used)),
        { label: 'Overdue deliveries', value: lateM.length, type: 'int', tone: lateM.length ? 'bad' : 'good', sub: 'ordered, delivery date passed' }]),
      table('Materials by status', [col('status', 'Status'), col('n', 'Lines', 'int'), col('planned', 'Planned value (OMR)', 'money'), col('used', 'Consumed value (OMR)', 'money')], Object.values(status).map(g => ({ ...g, planned: r3(g.planned), used: r3(g.used) })), { empty: 'No material lines have been entered.' }),
      table('Top suppliers by planned value', [col('supplier', 'Supplier'), col('n', 'Lines', 'int'), col('planned', 'Planned value (OMR)', 'money')], Object.values(sup).sort((a, b) => b.planned - a.planned).slice(0, 10).map(g => ({ ...g, planned: r3(g.planned) })), { empty: 'No suppliers recorded.' }),
      table('Overdue deliveries', [col('project', 'Project'), col('material', 'Material'), col('supplier', 'Supplier'), col('due', 'Delivery date', 'date'), col('days', 'Days late', 'int')],
        lateM.slice(0, 25).map(m => ({ project: pn[m.project_id], material: m.material_name, supplier: m.supplier || '—', due: m.delivery_date, days: cell(diff(m.delivery_date, today), 'bad') })), { empty: 'No delivery is overdue.', note: lateM.length > 25 ? `Showing 25 of ${lateM.length}.` : '' })
    ];
  });

/* ---------- Risk & issues ---------- */
block('risk-register', 'Risk & issues', 'Risk register', 'Open risks by rating and the highest-scoring risks with owner, response and target date.',
  { data: 'risks' }, async c => {
    const all = await c.risks(), R = all.filter(OPEN_RISK), top = c.opts.top || 15, today = c.today;
    const band = b => R.filter(r => r.severityBand === b).length;
    const overdue = R.filter(r => r.mitigationTarget && r.mitigationTarget < today);
    return [
      kpis('Risks', [{ label: 'Open risks', value: R.length, type: 'int', sub: `${all.length - R.length} closed` }, { label: 'Critical', value: band('Critical'), type: 'int', tone: band('Critical') ? 'bad' : undefined },
        { label: 'High', value: band('High'), type: 'int', tone: band('High') ? 'warn' : undefined }, { label: 'Mitigation overdue', value: overdue.length, type: 'int', tone: overdue.length ? 'warn' : undefined, sub: 'target date passed' },
        { label: 'Average score', value: avg(R, r => r.inherentScore), type: 'num1', sub: 'probability × impact (max 25)' }]),
      stack('Open risks by rating', [{ label: 'Critical', value: band('Critical'), tone: 'bad' }, { label: 'High', value: band('High'), tone: 'warn' }, { label: 'Medium', value: band('Medium'), tone: 'info' }, { label: 'Low', value: band('Low'), tone: 'good' }],
        { note: 'Rating by score: Critical 16–25, High 10–15, Medium 5–9, Low 1–4.' }),
      table('Highest-scoring open risks', [col('project', 'Project'), col('title', 'Risk'), col('category', 'Category'), col('owner', 'Owner'), col('score', 'Score', 'int'), col('residual', 'Residual', 'int'), col('status', 'Status'), col('target', 'Mitigation target', 'date')],
        [...R].sort((a, b) => b.inherentScore - a.inherentScore).slice(0, top).map(r => ({ project: r.projectName, title: r.title, category: r.category, owner: r.owner || '—', score: cell(r.inherentScore, BAND_TONE[r.severityBand], r.severityBand), residual: r.residualScore, status: r.status,
          target: r.mitigationTarget ? cell(r.mitigationTarget, r.mitigationTarget < today ? 'warn' : undefined) : null })),
        { empty: 'No open risks on the register for the selected projects.', note: R.length > top ? `Showing the ${top} highest of ${R.length} open risks.` : '' })
    ];
  });

block('issue-log', 'Risk & issues', 'Issue log', 'Open issues by priority, blocking and overdue issues, ageing and the issue list.',
  { data: 'issues' }, async c => {
    const all = await c.issues(), I = all.filter(OPEN_ISSUE), top = c.opts.top || 20, today = c.today;
    const age = x => (x.raisedDate ? diff(day(x.raisedDate), today) : null);
    const pr = p => I.filter(x => x.priority === p).length;
    const rank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    const sorted = [...I].sort((a, b) => (b.isBlocking - a.isBlocking) || (rank[a.priority] - rank[b.priority]) || ((age(b) || 0) - (age(a) || 0)));
    return [
      kpis('Issues', [{ label: 'Open issues', value: I.length, type: 'int', sub: `${all.length - I.length} resolved / closed` }, { label: 'Blocking', value: I.filter(x => x.isBlocking).length, type: 'int', tone: I.some(x => x.isBlocking) ? 'bad' : undefined },
        { label: 'Overdue', value: I.filter(x => x.isOverdue).length, type: 'int', tone: I.some(x => x.isOverdue) ? 'warn' : undefined, sub: 'target date passed' }, { label: 'Average age', value: I.length ? Math.round(sum(I, x => age(x) || 0) / I.length) : null, type: 'days' },
        { label: 'Resolved in period', value: all.filter(x => inRange(day(x.actualResolutionDate), c.period.from, c.period.to)).length, type: 'int', sub: c.period.label }]),
      stack('Open issues by priority', [{ label: 'Critical', value: pr('Critical'), tone: 'bad' }, { label: 'High', value: pr('High'), tone: 'warn' }, { label: 'Medium', value: pr('Medium'), tone: 'info' }, { label: 'Low', value: pr('Low'), tone: 'good' }]),
      table('Open issues', [col('project', 'Project'), col('title', 'Issue'), col('priority', 'Priority'), col('who', 'Assigned to'), col('status', 'Status'), col('raised', 'Raised', 'date'), col('target', 'Target', 'date'), col('age', 'Age (days)', 'int'), col('blocking', 'Blocking', 'text', 'center')],
        sorted.slice(0, top).map(x => ({ project: x.projectName, title: x.title, priority: cell(x.priority, PRIORITY_TONE[x.priority]), who: x.assignedTo || '—', status: x.status, raised: x.raisedDate, target: x.targetResolutionDate ? cell(x.targetResolutionDate, x.isOverdue ? 'warn' : undefined) : null,
          age: age(x), blocking: x.isBlocking ? cell('BLOCKING', 'bad') : '' })),
        { empty: 'No open issues for the selected projects.', note: I.length > top ? `Showing ${top} of ${I.length} open issues (blocking first, then priority, then oldest).` : '' })
    ];
  });

/* ---------- Contractors ---------- */
block('contractor-scorecards', 'Contractors', 'Subcontractor performance scorecards', 'Ranked scorecard: on-time delivery, cost adherence and overall rating (the same scoring as the Subcontractor Performance page).',
  { menus: ['contractors'] }, async c => {
    const facts = await c.subcontractorFacts(), SP = c.SubPerf;
    const results = SP.compute(facts, { asOf: c.today, from: SP.periodFrom('all', c.today), projectIds: new Set(c.ids) }).sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1) || a.name.localeCompare(b.name));
    const port = SP.portfolio(results);
    const tone = r => ({ green: 'good', amber: 'warn', red: 'bad' }[r] || 'muted');
    const rows = results.map((r, i) => ({
      rank: r.overall != null ? i + 1 : null, name: r.name, projects: r.projectCount, contracts: r.activeContracts, value: r.contractValue, due: r.delivery.due, ontime: r.delivery.ontime, late: r.delivery.late + r.delivery.overdue,
      delivery: r.scores.delivery != null ? cell(r.scores.delivery, tone(SP.ragOf(r.scores.delivery))) : null, cost: r.scores.cost != null ? cell(r.scores.cost, tone(SP.ragOf(r.scores.cost))) : null,
      overall: r.overall != null ? cell(r.overall, tone(r.rag)) : null, rating: r.overall != null ? cell(SP.RAG_LABEL[r.rag], tone(r.rag)) : cell('Not enough data', 'muted')
    }));
    return [
      kpis('Subcontractor portfolio', [{ label: 'Subcontractors', value: port.contractors, type: 'int', sub: `${port.scored} scored` }, { label: 'Average overall score', value: port.overall, type: 'num1', tone: tone(port.rag), sub: port.overall == null ? 'not enough data yet' : SP.RAG_LABEL[port.rag] },
        { label: 'On-time delivery', value: port.delivery, type: 'pct', sub: `${port.deliveryOntime} of ${port.deliveryDue} deliverables due` }, { label: 'Cost adherence', value: port.cost, type: 'num1', sub: facts.withheld.vowd && facts.withheld.changes ? 'values withheld for your access' : '' },
        { label: 'Active contracts', value: port.activeContracts, type: 'int' }]),
      table('Scorecard', [col('rank', '#', 'int'), col('name', 'Subcontractor'), col('projects', 'Projects', 'int'), col('contracts', 'Active contracts', 'int'), col('value', 'Contract value (OMR)', 'money'), col('due', 'Deliverables due', 'int'), col('ontime', 'On time', 'int'), col('late', 'Late / overdue', 'int'),
        col('delivery', 'Delivery score', 'num1'), col('cost', 'Cost score', 'num1'), col('overall', 'Overall', 'num1'), col('rating', 'Rating', 'text', 'center')], rows,
      { empty: 'No subcontractor is linked to the selected projects.',
        note: 'Weights: delivery 30 · cost 25 · quality 20 · HSE 15 · responsiveness 10. Only delivery and cost are measured today; unmeasured KPIs are dropped and the weights re-spread, and an overall score needs at least two measured KPIs. Rating: 80+ On target, 60+ Watch, below Action needed. Quality, HSE, responsiveness and NCR / rework are not captured yet.' })
    ];
  });

/* ---------- Handover & closeout ---------- */
block('milestones', 'Handover & closeout', 'Milestones', 'Milestones due, with status and days to go.',
  { data: 'milestones' }, async c => {
    const M = await c.milestones(), today = c.today;
    const rows = [...M].sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999')).map(m => {
      const d = m.dueDate ? diff(today, m.dueDate) : null;
      return { project: m.projectName, milestone: m.milestone, due: m.dueDate, days: d == null ? null : cell(d, d < 0 && m.status !== 'On Track' ? 'bad' : d < 0 ? 'warn' : undefined), status: cell(m.status, { 'On Track': 'good', 'At Risk': 'warn', Delayed: 'bad' }[m.status]) };
    });
    const overdue = M.filter(m => m.dueDate && m.dueDate < today).length;
    return [
      kpis('Milestones', [{ label: 'Milestones', value: M.length, type: 'int' }, { label: 'On track', value: M.filter(m => m.status === 'On Track').length, type: 'int', tone: 'good' }, { label: 'At risk', value: M.filter(m => m.status === 'At Risk').length, type: 'int', tone: M.some(m => m.status === 'At Risk') ? 'warn' : undefined },
        { label: 'Delayed', value: M.filter(m => m.status === 'Delayed').length, type: 'int', tone: M.some(m => m.status === 'Delayed') ? 'bad' : undefined }, { label: 'Due date passed', value: overdue, type: 'int', sub: 'milestones have no "completed" status' }]),
      table('Milestone schedule', [col('project', 'Project'), col('milestone', 'Milestone'), col('due', 'Due', 'date'), col('days', 'Days to go', 'int'), col('status', 'Status', 'text', 'center')], rows.slice(0, 60),
        { empty: 'No milestones have been entered for the selected projects.', note: rows.length > 60 ? `Showing the first 60 of ${rows.length}, by due date.` : '' })
    ];
  });

block('closeout', 'Handover & closeout', 'Handover and closeout readiness', 'Completion certificate, defects-liability period and a closeout checklist worked out from the records, per project.',
  { views: ['certificates'] }, async c => {
    const P = await c.projects(), C = await c.certs(), E = await c.events(), I = c.allow.issues ? await c.issues() : null, today = c.today;
    const tick = (ok, na) => (na ? cell('n/a', 'muted') : cell(ok ? '✔' : '✘', ok ? 'good' : 'bad'));
    const rows = P.map(p => {
      const cs = C.filter(x => x.projectId === p.id).sort((a, b) => b.id - a.id), cert = cs[0] || null, ev = E.filter(e => e.projectId === p.id);
      const outstanding = cert && cert.outstandingItems ? cert.outstandingItems.split(/\n+/).filter(s => s.trim()).length : 0;
      const items = [!!cert && cert.status === 'Issued', ev.length > 0 && ev.every(DONE_EVENT), I ? !I.some(x => x.projectId === p.id && OPEN_ISSUE(x)) : null, !!cert && cert.finalCost > 0, !!cert && !!cert.defectsLiabilityEnd];
      const measured = items.filter(v => v != null), score = measured.length ? Math.round(measured.filter(Boolean).length / measured.length * 100) : null;
      return { project: p.name, cert: cert ? `${cert.certificateNumber} (${cert.certificateType})` : '—', cstatus: cert ? cell(cert.status, cert.status === 'Issued' ? 'good' : 'warn') : cell('None', 'muted'), done: cert ? cert.completionDate : null, dlp: cert ? cert.defectsLiabilityEnd : null,
        outstanding: cell(outstanding, outstanding ? 'warn' : undefined), contract: cert ? cert.contractValue : null, final: cert ? cert.finalCost : null,
        c1: tick(items[0]), c2: tick(items[1]), c3: tick(items[2], items[2] == null), c4: tick(items[3]), c5: tick(items[4]), ready: score == null ? null : cell(score, score >= 80 ? 'good' : score >= 50 ? 'warn' : 'bad') };
    });
    return [table('Closeout readiness', [col('project', 'Project'), col('cert', 'Latest certificate'), col('cstatus', 'Status', 'text', 'center'), col('done', 'Completion date', 'date'), col('dlp', 'Defects liability ends', 'date'), col('outstanding', 'Outstanding items', 'int'),
      col('contract', 'Contract value (OMR)', 'money'), col('final', 'Final cost (OMR)', 'money'), col('c1', 'Certificate issued', 'text', 'center'), col('c2', 'All tasks done', 'text', 'center'), col('c3', 'No open issues', 'text', 'center'), col('c4', 'Final cost recorded', 'text', 'center'),
      col('c5', 'DLP set', 'text', 'center'), col('ready', 'Ready %', 'pct')], rows, { empty: 'No projects.',
      note: 'The checklist is derived from records already in the dashboard (certificate, tasks, issues, final cost, defects-liability dates). NEC\'s formal closeout checklist can replace it once the items are agreed.' })];
  });

/* ---------- Governance ---------- */
block('approvals-status', 'Governance', 'Approvals and sign-off status', 'Documents awaiting approval (who has it, for how long) and how many are approved, pending or returned.',
  { anyView: ['vowd', 'change_requests', 'certificates'] }, async c => {
    const A = await c.approvals(), counts = await c.approvalCounts();
    const label = { vowd: 'VOWD statement', change_request: 'Change request', certificate: 'Completion certificate' };
    const pn = Object.fromEntries((await c.projects()).map(p => [p.id, p.name]));
    return [
      table('Approval status by document type', [col('type', 'Document'), col('none', 'Not submitted', 'int'), col('pending', 'Awaiting approval', 'int'), col('approved', 'Approved', 'int'), col('rejected', 'Returned', 'int')],
        counts.map(x => ({ type: label[x.type], none: x.None || 0, pending: cell(x.Pending || 0, x.Pending ? 'warn' : undefined), approved: x.Approved || 0, rejected: cell(x.Rejected || 0, x.Rejected ? 'warn' : undefined) })), { empty: 'No documents.' }),
      table('Documents awaiting approval', [col('type', 'Document'), col('ref', 'Reference'), col('project', 'Project'), col('who', 'With'), col('role', 'Role'), col('since', 'Submitted', 'date'), col('age', 'Waiting (days)', 'int')],
        A.slice(0, 30).map(a => ({ type: label[a.type], ref: a.ref, project: pn[a.projectId], who: a.approver || '—', role: a.role || '—', since: a.submittedDay, age: a.ageDays == null ? null : cell(a.ageDays, a.ageDays > 14 ? 'bad' : a.ageDays > 7 ? 'warn' : undefined) })),
        { empty: 'Nothing is waiting for approval.', note: A.length > 30 ? `Showing the 30 longest-waiting of ${A.length}.` : '' })
    ];
  });

block('audit-activity', 'Governance', 'Activity and access audit', 'Administrator only: what was created, changed, deleted, generated and downloaded in the period, and failed sign-ins.',
  { admin: true }, async c => {
    const rows = await c.auditSummary();
    const failed = rows.filter(r => r.action === 'login_failed').reduce((s, r) => s + r.n, 0);
    const byAction = {}; rows.forEach(r => { byAction[r.action] = (byAction[r.action] || 0) + r.n; });
    return [
      kpis('Activity in the period', [{ label: 'Recorded actions', value: sum(rows, r => r.n), type: 'int' }, { label: 'Records created', value: byAction.create || 0, type: 'int' }, { label: 'Records changed', value: byAction.update || 0, type: 'int' },
        { label: 'Records deleted', value: byAction.delete || 0, type: 'int', tone: byAction.delete ? 'warn' : undefined }, { label: 'Failed sign-ins', value: failed, type: 'int', tone: failed ? 'warn' : 'good' }]),
      table('Actions by type of record', [col('entity', 'Record'), col('action', 'Action'), col('n', 'Count', 'int')], rows.filter(r => r.action !== 'login' && r.action !== 'logout' && r.action !== 'login_failed').map(r => ({ entity: r.entity || '—', action: r.action, n: r.n })), { empty: 'No activity recorded in this period.' })
    ];
  });

block('data-quality', 'Governance', 'Data completeness checks', 'Projects missing key information (manager, business unit, budget, dates, task plan) — a quick audit of how reliable the numbers are.',
  { menus: ['portfolio', 'overview', 'progress', 'financial'] }, async c => {
    const P = await c.projects(), E = await c.events();
    const checks = [['No project manager', p => !p.projectManager], ['No business unit', p => !p.businessUnit], ['No approved budget', p => !(p.approvedBudget > 0)], ['No start / end date', p => !p.startDate || !p.endDate],
      ['No tasks planned', p => !E.some(e => e.projectId === p.id)], ['Tasks without planned dates', p => E.some(e => e.projectId === p.id && (!e.plannedStart || !e.plannedEnd))], ['No contractor', p => !p.contractor]];
    const rows = checks.map(([label, f]) => { const bad = P.filter(f); return { check: label, n: cell(bad.length, bad.length ? 'warn' : 'good'), which: bad.length ? bad.slice(0, 5).map(p => p.name).join(', ') + (bad.length > 5 ? ` +${bad.length - 5} more` : '') : '—' }; });
    return [table('Data completeness', [col('check', 'Check'), col('n', 'Projects affected', 'int'), col('which', 'Projects')], rows)];
  });

/* =========================================================
   CATALOGUE — the standard reports
   `blocks` entries are a key or [key, options]. `optional` blocks are extras the person can switch on.
   `menus`: anyone who can open one of these pages may run the report (the same menus the administrator already
   switches on / off per login — so Executive, PMO, PM and Finance roles need no separate setup).
   ========================================================= */
const REPORTS = [
  { key: 'executive', category: 'Management', icon: 'bi-bank', title: 'Executive portfolio summary', tag: 'Board pack',
    description: 'One board-ready pack: key figures, attention points, business-unit roll-up, project health, top risks and milestones.',
    menus: ['overview', 'portfolio', 'health'], layout: 'board', period: 'last-month', audience: 'Executive · PMO',
    blocks: ['portfolio-kpis', 'attention', 'by-business-unit', 'health-summary', ['risk-register', { top: 5 }], 'milestones'] },
  { key: 'progress', category: 'Progress & schedule', icon: 'bi-bar-chart-steps', title: 'Monthly project progress report', tag: 'Monthly',
    description: 'Planned vs actual progress, activity in the month, stage progress and late tasks — per project and consolidated.',
    menus: ['progress', 'gantt', 'overview'], layout: 'standard', period: 'last-month', audience: 'PMO · Project managers',
    blocks: ['progress-performance', 'period-activity', 'stage-progress', ['late-tasks', { top: 15 }]], optional: [{ key: 'project-pages', label: 'Add a page for each project' }] },
  { key: 'slippage', category: 'Progress & schedule', icon: 'bi-graph-down-arrow', title: 'Slippage and recovery report', tag: 'Recovery',
    description: 'Which projects lost or regained schedule in the period, month-by-month slippage and the most overdue activities.',
    menus: ['progress', 'gantt', 'overview'], layout: 'standard', period: 'this-month', audience: 'PMO · Project managers',
    blocks: ['slippage-recovery'] },
  { key: 'schedule', category: 'Progress & schedule', icon: 'bi-kanban', title: 'Schedule and Gantt status', tag: 'Schedule',
    description: 'Stage progress, every task past its planned finish and everything due in the next 14 days.',
    menus: ['gantt', 'progress'], layout: 'standard', period: 'this-month', audience: 'PMO · Project managers',
    blocks: ['stage-progress', 'late-tasks'] },
  { key: 'financial', category: 'Financial', icon: 'bi-cash-coin', title: 'Financial, EVM and cost report', tag: 'Finance',
    description: 'Budget, earned value (CPI / SPI / EAC), cost by stage, change-request cost impact, invoices and VOWD statements.',
    menus: ['financial'], layout: 'standard', period: 'last-month', audience: 'Finance · PMO',
    blocks: ['financial-evm', 'cost-by-stage', 'change-cost', 'billing'] },
  { key: 'procurement', category: 'Financial', icon: 'bi-box-seam', title: 'Procurement and supply status', tag: 'Supply',
    description: 'Material lines by status, planned vs consumed value, top suppliers and deliveries that are overdue.',
    menus: ['financial', 'progress'], layout: 'standard', period: 'this-month', audience: 'Finance · Project managers',
    blocks: ['procurement'] },
  { key: 'risk', category: 'Risk & issues', icon: 'bi-shield-exclamation', title: 'Risk and issue report', tag: 'RAID',
    description: 'Risk ratings and the top open risks, plus open issues by priority with blocking and overdue items.',
    menus: ['risks-crud', 'issues-crud', 'risks'], layout: 'standard', period: 'last-month', audience: 'PMO · Project managers',
    blocks: ['risk-register', 'issue-log'] },
  { key: 'contractor', category: 'Contractors', icon: 'bi-people', title: 'Contractor performance scorecards', tag: 'SCM',
    description: 'Ranked subcontractor scorecard — on-time delivery, cost adherence and overall rating — for renewals and pre-qualification.',
    menus: ['contractors'], layout: 'standard', period: 'this-month', audience: 'SCM · PMO',
    blocks: ['contractor-scorecards'] },
  { key: 'handover', category: 'Handover & closeout', icon: 'bi-clipboard2-check', title: 'Milestone, handover and closeout report', tag: 'Closeout',
    description: 'Milestone schedule, completion certificates, defects-liability dates and a closeout-readiness checklist per project.',
    menus: ['milestones-crud', 'milestones', 'progress'], layout: 'standard', period: 'this-month', audience: 'PMO · Project managers',
    blocks: ['milestones', 'closeout'] },
  { key: 'compliance', category: 'Governance', icon: 'bi-patch-check', title: 'Compliance and governance report', tag: 'Audit',
    description: 'Approvals awaiting sign-off, change-request governance and data completeness; administrators can add the activity audit.',
    menus: ['portfolio', 'overview', 'financial', 'contractors'], layout: 'standard', period: 'last-month', audience: 'Audit · SCM · PMO',
    blocks: ['approvals-status', 'change-cost', 'data-quality'], optional: [{ key: 'audit-activity', label: 'Add the activity and access audit (administrator only)' }] }
];

const LAYOUTS = [
  { key: 'standard', title: 'Standard report', description: 'Letterhead, scope line, sections one after another. Best for everyday reports.' },
  { key: 'board', title: 'Board pack', description: 'Cover page, contents list and page numbers. Best for committee and board papers.' },
  { key: 'compact', title: 'Compact', description: 'Dense tables, no cover — fewer pages for long lists.' }
];

const PERIODS = [
  { key: 'this-week', label: 'This week' }, { key: 'last-week', label: 'Last week' },
  { key: 'this-month', label: 'This month' }, { key: 'last-month', label: 'Last month' }, { key: 'this-quarter', label: 'This quarter' }, { key: 'last-quarter', label: 'Last quarter' },
  { key: 'ytd', label: 'Year to date' }, { key: 'last-30', label: 'Last 30 days' }, { key: 'custom', label: 'Custom dates' }
];

function resolvePeriod(preset, from, to, today) {
  const y = +today.slice(0, 4), m = +today.slice(5, 7) - 1, iso = d => d.toISOString().slice(0, 10);
  const monthStart = (yy, mm) => iso(new Date(Date.UTC(yy, mm, 1))), monthEnd = (yy, mm) => iso(new Date(Date.UTC(yy, mm + 1, 0)));
  const q = Math.floor(m / 3);
  const wd = (new Date(ms(today)).getUTCDay() + 6) % 7, monday = plus(today, -wd); // weeks run Monday - Sunday
  switch (preset) {
    case 'this-week': return { from: monday, to: plus(monday, 6), label: 'this week' };
    case 'last-week': return { from: plus(monday, -7), to: plus(monday, -1), label: 'last week' };
    case 'this-month': return { from: monthStart(y, m), to: monthEnd(y, m), label: 'this month' };
    case 'last-month': return { from: monthStart(y, m - 1), to: monthEnd(y, m - 1), label: 'last month' };
    case 'this-quarter': return { from: monthStart(y, q * 3), to: monthEnd(y, q * 3 + 2), label: 'this quarter' };
    case 'last-quarter': return { from: monthStart(y, q * 3 - 3), to: monthEnd(y, q * 3 - 1), label: 'last quarter' };
    case 'ytd': return { from: `${y}-01-01`, to: today, label: 'year to date' };
    case 'last-30': return { from: plus(today, -29), to: today, label: 'last 30 days' };
    case 'custom': if (/^\d{4}-\d{2}-\d{2}$/.test(from || '') && /^\d{4}-\d{2}-\d{2}$/.test(to || '') && from <= to) return { from, to, label: 'for the chosen dates' }; return null;
    default: return null;
  }
}

module.exports = { BLOCKS, REPORTS, LAYOUTS, PERIODS, userCan, resolvePeriod, DATA_MENUS, diff, plus, day };
