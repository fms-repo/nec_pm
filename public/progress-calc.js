/* =========================================================
   PROJECT PROGRESS — the calculations, in one file.
   Loaded by the dashboard page (window.ProgressCalc), the Excel export and the Report Library (require() on the server),
   so the page, the sheet and the reports can never disagree.

   Everything works from the Sequence of Events of each project (planned start / end, actual start / end, status, progress %):
     · every task carries a weight = its planned duration in days (the same weighting the project's own "actual progress" uses);
     · PLANNED % at a date = how much of the weighted work the schedule says should be finished by then (a task is spread evenly
       from its planned start to its planned end — which is what gives the S shape);
     · ACTUAL % at a date = the weighted progress of the tasks. Only today's progress is stored, so earlier dates are
       reconstructed from the recorded actual start / finish dates (a finished task counts from its actual finish; one in
       progress accrues evenly from its actual start up to its current progress). It is an estimate for the past, exact for today;
     · EARNED (portfolio only) = the same actual progress but weighted by each project's approved budget, so a big project counts
       more — for one project it is identical to ACTUAL;
     · SPI = actual % ÷ planned % today. EARNED SCHEDULE = the date on which the plan had reached today's actual %; so
       days ahead / behind = earned-schedule date − today, and the schedule-based SPI(t) = elapsed time at that date ÷ elapsed time today;
     · FORECAST finish = start + planned duration ÷ SPI(t) (the standard earned-schedule forecast); compared with the baseline
       finish (the project's planned end date).
   Tasks without BOTH a planned start and a planned end cannot be placed on the plan, so they are left out of every planned / actual
   figure (they are still counted as tasks, and reported as "unscheduled"); a project with no scheduled task has no progress figures.
   A project that is 100% complete is measured against its actual finish: days ahead = planned finish - actual finish.
   Dates are ISO 'YYYY-MM-DD' strings handled as calendar days.
   ========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProgressCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DAY = 864e5;
  // the dashboard turns project dates into Date objects (built from the 'YYYY-MM-DD' text, so at UTC midnight); other callers pass the text
  const num = s => { if (s instanceof Date) return isNaN(s) ? null : Math.round(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) / DAY); const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY) : null; };
  const iso = n => new Date(n * DAY).toISOString().slice(0, 10);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r1 = v => Math.round(v * 10) / 10;
  const r2 = v => Math.round(v * 100) / 100;
  const todayISO = () => new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10); // Oman time
  const addMonths = (s, m) => { const d = new Date(num(s) * DAY); d.setUTCMonth(d.getUTCMonth() + m, 1); return iso(Math.round(d.getTime() / DAY)); };
  const monthEnd = s => { const d = new Date(num(s) * DAY); return iso(Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0) / DAY)); };

  /* ---------- one task ---------- */
  function prep(e) {
    const ps = num(e.plannedStart), pe = num(e.plannedEnd);
    const done = e.status === 'Completed' || (Number(e.progressPct) || 0) >= 100;
    return { id: e.id, ps, pe, sched: ps != null && pe != null, as: num(e.actualStart), ae: num(e.actualEnd), prog: clamp(Number(e.progressPct) || 0, 0, 100), done,
      w: ps != null && pe != null && pe >= ps ? pe - ps + 1 : 1, raw: e };
  }
  function plannedFrac(n, t) {
    if (n.pe == null) return 0;
    if (n.ps == null) return t >= n.pe ? 1 : 0;
    if (t < n.ps) return 0;
    if (t >= n.pe) return 1;
    return (t - n.ps + 1) / (n.pe - n.ps + 1);
  }
  function actualFrac(n, t, today) {
    const p = n.done ? 1 : n.prog / 100;
    if (p <= 0) return 0;
    let s = n.as != null ? n.as : n.ps;
    if (n.done) {
      let f = n.ae != null ? n.ae : (n.pe != null ? Math.min(n.pe, today) : today);
      if (s == null || s > f) s = f;
      if (t >= f) return 1;
      if (t < s) return 0;
      return (t - s + 1) / (f - s + 1);
    }
    if (s == null) s = today;
    if (t < s) return 0;
    if (t >= today || today <= s) return p;
    return p * (t - s + 1) / (today - s + 1);
  }
  const pctOf = (tasks, t, today, kind) => {
    let sw = 0, sv = 0;
    for (const n of tasks) { sw += n.w; sv += n.w * (kind === 'planned' ? plannedFrac(n, t) : actualFrac(n, t, today)); }
    return sw ? 100 * sv / sw : 0;
  };

  /* ---------- one project ---------- */
  function build(projects, events) {
    const by = new Map(); projects.forEach(p => by.set(p.id, []));
    events.forEach(e => { if (by.has(e.projectId)) by.get(e.projectId).push(prep(e)); });
    return projects.map(p => {
      const tasks = by.get(p.id), sched = tasks.filter(n => n.sched);
      return { p, tasks, sched, start: sched.length ? Math.min(...sched.map(n => n.ps)) : null, finish: sched.length ? Math.max(...sched.map(n => n.pe)) : null, baseline: num(p.endDate), budget: Number(p.approvedBudget) || 0 };
    });
  }
  // the day on which the PLAN had reached `target` % (bisection — the planned curve never goes down)
  function earnedScheduleDay(P, target, today) {
    if (P.start == null || P.finish == null) return null;
    if (target <= 0.0001) return P.start - 1;
    if (target >= pctOf(P.sched, P.finish, today, 'planned') - 0.0001) return P.finish;
    let lo = P.start - 1, hi = P.finish;
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (pctOf(P.sched, mid, today, 'planned') >= target) hi = mid; else lo = mid; }
    return hi;
  }
  function state(P, t, today) { // the position of one project "as at" day t (t <= today)
    if (!P.sched.length) return { measurable: false, planned: null, actual: null, variance: null, spi: null, svDays: null, spiT: null, es: null, complete: false };
    const planned = pctOf(P.sched, t, today, 'planned'), actual = pctOf(P.sched, t, today, 'actual');
    const o = { measurable: true, planned: r1(planned), actual: r1(actual), variance: r1(actual - planned), spi: planned > 0.05 ? r2(actual / planned) : null, svDays: null, spiT: null, es: null, complete: false };
    if (t < P.start) return o;
    if (actual >= 99.95) { // finished: measured against the actual finish, not against the plan curve
      const ends = P.sched.map(n => n.ae).filter(v => v != null && v <= t), fin = Math.min(t, ends.length ? Math.max(...ends) : t);
      o.complete = true; o.fin = fin; o.svDays = Math.round(P.finish - fin); o.spiT = r2((P.finish - P.start + 1) / Math.max(1, fin - P.start + 1)); o.es = P.finish;
      return o;
    }
    const es = earnedScheduleDay(P, actual, today);
    o.es = es; o.svDays = Math.round(es - t);
    o.spiT = r2(Math.max(0, es - P.start + 1) / (t - P.start + 1));
    return o;
  }
  function forecastDay(P, st, today) {
    if (!st.measurable || P.finish == null || P.start == null) return null;
    if (st.complete) return st.fin;
    if (today < P.start) return P.finish;
    if (!st.spiT || st.spiT < 0.05) return null; // no measurable progress yet: no trend to extend
    const dur = P.finish - P.start + 1;
    return Math.min(P.start + Math.ceil(dur / st.spiT) - 1, P.finish + dur * 2);
  }

  /* ---------- the page / sheet / report numbers ---------- */
  function analyse(projects, events, o) {
    o = o || {};
    const today = num(o.today || todayISO()), from = num(o.from), to = num(o.to);
    const built = build(projects, events);
    const rows = built.map(P => {
      const st = state(P, today, today), fc = forecastDay(P, st, today);
      const done = P.tasks.filter(n => n.done).length, overdue = P.tasks.filter(n => !n.done && n.pe != null && n.pe < today).length;
      const due = from != null ? P.tasks.filter(n => n.pe != null && n.pe >= from && n.pe <= to) : [];
      const finished = from != null ? P.tasks.filter(n => n.done && n.ae != null && n.ae >= from && n.ae <= to) : [];
      return { id: P.p.id, code: P.p.code, name: P.p.name, businessUnit: P.p.businessUnit || '', status: P.p.status, ...st,
        baseline: P.baseline != null ? iso(P.baseline) : null, scheduleFinish: P.finish != null ? iso(P.finish) : null, forecast: fc != null ? iso(fc) : null,
        forecastDelay: fc != null && P.baseline != null ? fc - P.baseline : null, tasks: P.tasks.length, scheduled: P.sched.length, unscheduled: P.tasks.length - P.sched.length, done, overdue,
        dueInPeriod: due.length, dueDone: due.filter(n => n.done).length, finishedInPeriod: finished.length, budget: P.budget, _P: P };
    });
    const meas = rows.filter(r => r.measurable), n = meas.length, mean = f => (n ? r1(meas.reduce((s, r) => s + f(r), 0) / n) : null);
    const planned = mean(r => r.planned), actual = mean(r => r.actual);
    const svRows = rows.filter(r => r.svDays != null);
    const bsum = meas.reduce((s, r) => s + r.budget, 0);
    const earned = n ? r1(bsum > 0 ? meas.reduce((s, r) => s + r.budget * r.actual, 0) / bsum : actual) : null;
    const plannedB = n ? r1(bsum > 0 ? meas.reduce((s, r) => s + r.budget * r.planned, 0) / bsum : planned) : null;
    const due = rows.reduce((s, r) => s + r.dueInPeriod, 0), dueDone = rows.reduce((s, r) => s + r.dueDone, 0);
    const fcRows = rows.filter(r => r.forecast);
    const late = fcRows.filter(r => r.forecastDelay > 0);
    const out = {
      today: iso(today), rows: rows.map(r => { const c = { ...r }; delete c._P; return c; }),
      portfolio: { projects: rows.length, measured: n, unmeasured: rows.length - n, planned, actual, variance: n ? r1(actual - planned) : null, earned, plannedBudgetWeighted: plannedB,
        spi: plannedB > 0.05 ? r2(earned / plannedB) : null, // portfolio SPI is budget-weighted (earned ÷ planned value)
        svDays: svRows.length ? Math.round(svRows.reduce((s, r) => s + r.svDays, 0) / svRows.length) : null,
        ahead: meas.filter(r => r.variance > 0).length, behind: meas.filter(r => r.variance < 0).length,
        tasks: rows.reduce((s, r) => s + r.tasks, 0), unscheduled: rows.reduce((s, r) => s + r.unscheduled, 0), done: rows.reduce((s, r) => s + r.done, 0), overdue: rows.reduce((s, r) => s + r.overdue, 0),
        finishedInPeriod: rows.reduce((s, r) => s + r.finishedInPeriod, 0), dueInPeriod: due, dueDone: dueDone, dueDonePct: due ? r1(dueDone / due * 100) : null,
        forecastLatest: fcRows.length ? fcRows.map(r => r.forecast).sort().pop() : null, baselineLatest: fcRows.map(r => r.baseline).filter(Boolean).sort().pop() || null,
        forecastLate: late.length, forecastKnown: fcRows.length, forecastNone: meas.filter(r => !r.forecast).length, worstSlip: late.length ? Math.max(...late.map(r => r.forecastDelay)) : 0 }
    };
    out._built = built; // for curve() / slippage() / lookahead() — not for serialising
    return out;
  }

  /* ---------- S-curve: planned vs actual vs earned, cumulative % over time ---------- */
  function curve(an, o) {
    o = o || {};
    const today = num(an.today), built = an._built.filter(P => P.sched.length);
    if (!built.length) return { labels: [], dates: [], planned: [], actual: [], earned: [], todayIndex: -1 };
    const starts = built.map(P => P.start).filter(v => v != null), ends = built.map(P => P.finish).filter(v => v != null);
    if (!starts.length || !ends.length) return { labels: [], dates: [], planned: [], actual: [], earned: [], todayIndex: -1 };
    const a = Math.min(...starts), b = Math.max(Math.max(...ends), today);
    const pts = clamp(o.points || 40, 8, 80), step = Math.max(1, Math.ceil((b - a) / pts));
    const days = []; for (let t = a; t < b; t += step) days.push(t); days.push(b);
    if (!days.includes(today) && today > a && today < b) { days.push(today); days.sort((x, y) => x - y); }
    const bsum = built.reduce((s, P) => s + P.budget, 0), many = built.length > 1;
    const out = { dates: days.map(iso), planned: [], actual: [], earned: [], todayIndex: days.indexOf(today), many };
    days.forEach(t => {
      const pl = built.map(P => pctOf(P.sched, t, today, 'planned')), ac = built.map(P => pctOf(P.sched, t, today, 'actual'));
      out.planned.push(r1(pl.reduce((s, v) => s + v, 0) / built.length));
      out.actual.push(t <= today ? r1(ac.reduce((s, v) => s + v, 0) / built.length) : null);
      out.earned.push(t <= today && many ? r1(bsum > 0 ? built.reduce((s, P, i) => s + P.budget * ac[i], 0) / bsum : ac.reduce((s, v) => s + v, 0) / built.length) : null);
    });
    out.labels = out.dates.map(d => d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(2, 4));
    return out;
  }

  /* ---------- progress by work package (project stage) ---------- */
  function workPackages(an, stages) {
    const today = num(an.today), by = {};
    an._built.forEach(P => P.tasks.forEach(n => { const s = n.raw.stage || 'Other'; (by[s] ||= []).push(n); }));
    const sc = t => t.filter(n => n.sched);
    const order = [...(stages || []), ...Object.keys(by).filter(s => !(stages || []).includes(s))];
    return order.filter(s => by[s]).map(s => {
      const t = by[s];
      return { stage: s, tasks: t.length, done: t.filter(n => n.done).length, overdue: t.filter(n => !n.done && n.pe != null && n.pe < today).length,
        planned: r1(pctOf(sc(t), today, today, 'planned')), actual: r1(pctOf(sc(t), today, today, 'actual')) };
    });
  }

  /* ---------- slippage waterfall: where schedule was gained / lost, month on month ---------- */
  function slippage(an, months) {
    const today = an.today, n = months || 6, built = an._built, todayN = num(today);
    const asAt = []; for (let i = n - 1; i >= 1; i--) asAt.push(monthEnd(addMonths(today, -i)));
    asAt.push(today);
    const sv = asAt.map(d => {
      const t = num(d), vals = built.map(P => state(P, t, todayN)).filter(s => s.measurable && s.svDays != null).map(s => s.svDays);
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    });
    const steps = sv.map((v, i) => ({ asAt: asAt[i], sv: v, change: i ? v - sv[i - 1] : null }));
    return { steps, opening: sv[0], closing: sv[sv.length - 1] };
  }

  /* ---------- the position of every project "as at" an earlier date (for recovery / slippage over a period) ---------- */
  function stateAt(an, dateISO) {
    const t = num(dateISO), today = num(an.today), m = {};
    an._built.forEach(P => { m[P.p.id] = state(P, Math.min(t, today), today); });
    return m;
  }

  /* ---------- look-ahead: what is due (or due to start) in the next N weeks ---------- */
  function lookahead(an, weeks, nameOf) {
    const today = num(an.today), end = today + 7 * clamp(weeks || 3, 1, 12), out = [];
    an._built.forEach(P => P.tasks.forEach(n => {
      if (n.done) return;
      const finishes = n.pe != null && n.pe >= today && n.pe <= end, starts = n.ps != null && n.ps >= today && n.ps <= end && !(n.prog > 0);
      if (!finishes && !starts) return;
      const e = n.raw;
      out.push({ projectId: P.p.id, project: P.p.name, code: P.p.code, stage: e.stage, task: e.eventName, plannedStart: e.plannedStart, plannedEnd: e.plannedEnd, owner: e.assignedTo || '', status: e.status,
        progress: n.prog, daysToFinish: n.pe != null ? n.pe - today : null, kind: finishes ? 'finishing' : 'starting' });
    }));
    return out.sort((a, b) => (a.plannedEnd || '9').localeCompare(b.plannedEnd || '9') || a.project.localeCompare(b.project));
  }

  /* ---------- the activity-by-activity measurement list ---------- */
  function measurement(an) {
    const today = num(an.today), out = [];
    an._built.forEach(P => {
      const stages = []; P.tasks.forEach(n => { if (!stages.includes(n.raw.stage)) stages.push(n.raw.stage); });
      P.tasks.slice().sort((a, b) => (a.raw.seqNo || 0) - (b.raw.seqNo || 0)).forEach(n => {
        const e = n.raw, planned = n.sched ? r1(100 * plannedFrac(n, today)) : null, actual = r1(n.done ? 100 : n.prog);
        out.push({ projectId: P.p.id, eventId: e.id, code: P.p.code, project: P.p.name, stage: e.stage, seq: e.seqNo, task: e.eventName, plannedStart: e.plannedStart, plannedEnd: e.plannedEnd, plannedDays: n.ps != null && n.pe != null ? n.pe - n.ps + 1 : null,
          actualStart: e.actualStart, actualEnd: e.actualEnd, planned, actual, variance: planned == null ? null : r1(actual - planned), weight: n.sched ? n.w : null, status: e.status, owner: e.assignedTo || '',
          daysLate: !n.done && n.pe != null && n.pe < today ? today - n.pe : (n.done && n.ae != null && n.pe != null && n.ae > n.pe ? n.ae - n.pe : 0), overdue: !n.done && n.pe != null && n.pe < today });
      });
    });
    return out;
  }

  /* ---------- filter events by subcontractor and / or event name ----------
     subs = { eventId: [[contractorId, name], …] } (from the crew / labour lines); subcontractorId 0 = "no subcontractor assigned".
     An event carried by several subcontractors matches when ANY of them is selected; both filters must match. */
  function filterEvents(events, subs, f) {
    f = f || {};
    const ids = (f.subcontractorIds || []).map(Number), names = f.eventNames || [];
    if (!ids.length && !names.length) return events;
    return events.filter(e => {
      if (names.length && !names.includes(e.eventName)) return false;
      if (!ids.length) return true;
      const s = subs && subs[e.id];
      return s && s.length ? s.some(x => ids.includes(Number(x[0]))) : ids.includes(0);
    });
  }

  /* ---------- line progress: Sequence of Events material / crew lines ----------
     A line's Progress % = Actual Qty / Planned Qty (capped 0-100), unless a person typed a value instead (override).
     A line with no planned quantity and no override cannot be measured (null) and is left out. An event's Progress % is the
     simple average of its measurable lines. Used by the project form and by the server on save, so they always agree. */
  function lineProgress(planned, actual, override) {
    if (override != null && String(override).trim() !== '' && isFinite(Number(override))) return r1(clamp(Number(override), 0, 100));
    const p = Number(planned) || 0;
    if (p <= 0) return null;
    return r1(clamp((Number(actual) || 0) / p * 100, 0, 100));
  }
  function averageProgress(values) {
    const v = (values || []).filter(x => x != null);
    return v.length ? r1(v.reduce((s, x) => s + x, 0) / v.length) : null;
  }

  return { analyse, filterEvents, lineProgress, averageProgress, curve, workPackages, slippage, lookahead, measurement, stateAt, num, iso, todayISO, addMonths, monthEnd };
});
