/* =========================================================
   SUBCONTRACTOR PERFORMANCE — scoring rules, in one place.

   Pure functions, no DOM and no network: the dashboard page, the printable scorecard and the Excel export
   all load THIS file (the browser as window.SubPerf, the server through require), so a contractor can never
   show one score on screen and another on paper.

   Input is the "facts" document served by GET /api/subcontractor-performance:
     events    one row per (event, contractor) — the contractor is the one named on the event's Crew / Labour lines
     contracts one row per (project, contractor) — planned value from the crew lines, awarded value from the latest VOWD
     changes   the Subcontractor-type change requests (variations) with their decision and cost impact

   What is scored today (everything else is shown as "not measured", never as 0 or 100):
     On-time delivery  share of due events finished on or before their planned end date
     Cost adherence    how much the contract grew through approved variations, and how often variations were raised
   Quality, HSE and Responsiveness need records the system does not hold yet. A KPI with no data is left out and
   its weight is shared out over the KPIs that do have data, so a contractor is never marked down for what is
   simply not recorded. An overall score needs at least two KPIs with data: a single one (typically "no variations
   yet" on a job where nothing has fallen due) is shown, but never turned into a rating.
   ========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SubPerf = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KPIS = [
    { key: 'delivery',       label: 'On-time delivery', short: 'Delivery',       weight: 30, live: true },
    { key: 'cost',           label: 'Cost adherence',   short: 'Cost',           weight: 25, live: true },
    { key: 'quality',        label: 'Quality',          short: 'Quality',        weight: 20, live: false, needs: 'NCR, rework, snag and inspection records' },
    { key: 'hse',            label: 'HSE performance',  short: 'HSE',            weight: 15, live: false, needs: 'incident, safety observation and compliance records' },
    { key: 'responsiveness', label: 'Responsiveness',   short: 'Responsiveness', weight: 10, live: false, needs: 'RFI and submittal turnaround records' }
  ];
  const CONFIG = {
    ragGreen: 80,         // overall >= 80  -> green
    ragAmber: 60,         // overall >= 60  -> amber, below -> red
    minKpis: 2,           // an overall score needs at least this many KPIs with data (one lone KPI — e.g. "no variations yet" — proves nothing)
    minEvents: 3,         // fewer due events than this -> the delivery score is flagged "low confidence"
    growthCapPct: 20,     // approved variations worth 20% of the contract (or more) score 0 on variation growth
    freqCap: 5,           // 5 or more variation requests per contract score 0 on variation frequency
    costGrowthShare: 0.6  // cost adherence = 60% variation growth + 40% variation frequency
  };
  const RAG_LABEL = { green: 'On target', amber: 'Watch', red: 'Action needed', none: 'Not scored' };
  const RAG_COLOR = { green: '#2E8B57', amber: '#D99A22', red: '#C94C4C', none: '#8A97A0' };

  /* ---------- dates (ISO 'YYYY-MM-DD' strings, handled as calendar days — no timezone arithmetic) ---------- */
  const dayNum = iso => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null;
  };
  const daysBetween = (a, b) => dayNum(b) - dayNum(a);
  const pad2 = n => String(n).padStart(2, '0');
  const fromDayNum = n => { const d = new Date(n * 86400000); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  function addMonths(iso, n) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    const t = (+m[1]) * 12 + (+m[2] - 1) + n;
    const y = Math.floor(t / 12), mo = t % 12;
    const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    return `${y}-${pad2(mo + 1)}-${pad2(Math.min(+m[3], last))}`;
  }
  const monthEnd = iso => { const m = /^(\d{4})-(\d{2})/.exec(iso); return fromDayNum(Date.UTC(+m[1], +m[2], 0) / 86400000); };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabel = iso => `${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(2, 4)}`;

  const PERIODS = [
    { key: 'all', label: 'All time' },
    { key: '12m', label: 'Last 12 months' },
    { key: '6m',  label: 'Last 6 months' },
    { key: '3m',  label: 'Last 3 months' },
    { key: 'ytd', label: 'Year to date' }
  ];
  function periodFrom(key, asOf) {
    if (key === '12m') return addMonths(asOf, -12);
    if (key === '6m') return addMonths(asOf, -6);
    if (key === '3m') return addMonths(asOf, -3);
    if (key === 'ytd') return asOf.slice(0, 4) + '-01-01';
    return null;
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const r1 = v => Math.round(v * 10) / 10;
  const ragOf = score => score == null ? 'none' : score >= CONFIG.ragGreen ? 'green' : score >= CONFIG.ragAmber ? 'amber' : 'red';

  /* ---------- delivery: where does an event stand on `asOf`? ----------
     ontime   finished on or before its planned end
     late     finished after its planned end
     overdue  not finished and the planned end has passed
     pending  not finished, not yet due           (not counted)
     nodate   no planned end date                 (not counted)
     nofinish marked Completed but no actual end  (not counted — we cannot tell when it finished) */
  function classifyEvent(e, asOf) {
    if (!e.plannedEnd) return { state: 'nodate', days: 0 };
    if (e.actualEnd && e.actualEnd <= asOf) {
      const late = daysBetween(e.plannedEnd, e.actualEnd);
      return late > 0 ? { state: 'late', days: late } : { state: 'ontime', days: 0 };
    }
    if (!e.actualEnd && e.status === 'Completed') return { state: 'nofinish', days: 0 };
    if (e.plannedEnd < asOf) return { state: 'overdue', days: daysBetween(e.plannedEnd, asOf) };
    return { state: 'pending', days: 0 };
  }

  /* ---------- the scorecards ----------
     opts: asOf (default today), from (start of the scoring period, default none), projectIds (Set — the projects in scope) */
  function compute(facts, opts) {
    opts = opts || {};
    const asOf = opts.asOf || todayISO();
    const from = opts.from || null;
    const inScope = opts.projectIds ? (id => opts.projectIds.has(id)) : (() => true);
    const projectName = {};
    (facts.projects || []).forEach(p => { projectName[p.id] = p; });

    const byId = new Map();
    (facts.contractors || []).forEach(c => byId.set(c.id, {
      id: c.id, name: c.name, contracts: [], events: [], changes: [],
      delivery: null, cost: null, scores: { delivery: null, cost: null, quality: null, hse: null, responsiveness: null },
      overall: null, rag: 'none', kpisUsed: [], coverage: 0, contractValue: 0, activeContracts: 0, projectCount: 0
    }));

    // changes -> per (project, contractor)
    const pair = new Map();
    const pairOf = (p, c) => { const k = p + ':' + c; if (!pair.has(k)) pair.set(k, { vo: 0, requests: 0, approved: 0 }); return pair.get(k); };
    (facts.changes || []).forEach(ch => {
      const r = byId.get(ch.contractorId);
      if (!r || !inScope(ch.projectId)) return;
      if (ch.dateSubmitted > asOf || (from && ch.dateSubmitted < from)) return;
      const approved = ch.decision === 'Approved' && ch.decisionDate && ch.decisionDate <= asOf;
      const status = ch.decision && ch.decisionDate && ch.decisionDate <= asOf ? ch.decision : (ch.analysed ? 'Under Analysis' : 'Submitted');
      const p = pairOf(ch.projectId, ch.contractorId);
      p.requests++;
      if (approved) { p.approved++; p.vo += Number(ch.costImpact) || 0; }
      r.changes.push({ ...ch, status, approved, project: projectName[ch.projectId] || null });
    });

    // contracts
    (facts.contracts || []).forEach(k => {
      const r = byId.get(k.contractorId);
      if (!r || !inScope(k.projectId)) return;
      const base = k.awarded > 0 ? k.awarded : (k.plannedValue || 0);
      const p = pair.get(k.projectId + ':' + k.contractorId) || { vo: 0, requests: 0, approved: 0 };
      const project = projectName[k.projectId] || {};
      const active = project.status !== 'Completed';
      r.contracts.push({
        ...k, project, base, baseSource: k.awarded > 0 ? 'VOWD awarded value' : 'Planned crew / labour value',
        variationValue: p.vo, requests: p.requests, approvedRequests: p.approved,
        contractValue: base + p.vo, active, events: { ontime: 0, late: 0, overdue: 0 }
      });
    });

    // events
    (facts.events || []).forEach(e => {
      const r = byId.get(e.contractorId);
      if (!r || !inScope(e.projectId)) return;
      if (from && e.plannedEnd && e.plannedEnd < from) return;
      const c = classifyEvent(e, asOf);
      r.events.push({ ...e, state: c.state, daysLate: c.days, project: projectName[e.projectId] || null });
      const k = r.contracts.find(x => x.projectId === e.projectId);
      if (k && k.events[c.state] != null) k.events[c.state]++;
    });

    const out = [];
    byId.forEach(r => {
      if (!r.contracts.length && !r.events.length && !r.changes.length) return;
      r.projectCount = new Set(r.contracts.map(k => k.projectId)).size;
      r.activeContracts = r.contracts.filter(k => k.active).length;
      r.contractValue = r.contracts.reduce((s, k) => s + k.contractValue, 0);

      // --- delivery
      const n = st => r.events.filter(e => e.state === st).length;
      const ontime = n('ontime'), late = n('late'), overdue = n('overdue');
      const due = ontime + late + overdue;
      const lateEvents = r.events.filter(e => e.state === 'late' || e.state === 'overdue');
      r.delivery = {
        due, ontime, late, overdue, pending: n('pending'), nodate: n('nodate'), nofinish: n('nofinish'),
        avgLateDays: lateEvents.length ? r1(lateEvents.reduce((s, e) => s + e.daysLate, 0) / lateEvents.length) : 0,
        score: due ? r1(ontime / due * 100) : null,
        lowSample: due > 0 && due < CONFIG.minEvents
      };
      r.scores.delivery = r.delivery.score;

      // --- cost: only contracts with a known value can be judged
      const priced = r.contracts.filter(k => k.base > 0);
      if (priced.length) {
        const base = priced.reduce((s, k) => s + k.base, 0);
        const vo = priced.reduce((s, k) => s + k.variationValue, 0);
        const requests = priced.reduce((s, k) => s + k.requests, 0);
        const growthPct = Math.max(0, vo / base * 100);
        const perContract = requests / priced.length;
        const growthScore = 100 * (1 - Math.min(1, growthPct / CONFIG.growthCapPct));
        const freqScore = 100 * (1 - Math.min(1, perContract / CONFIG.freqCap));
        r.cost = {
          score: r1(CONFIG.costGrowthShare * growthScore + (1 - CONFIG.costGrowthShare) * freqScore),
          base, variationValue: vo, growthPct: r1(growthPct), requests, approved: priced.reduce((s, k) => s + k.approvedRequests, 0),
          perContract: r1(perContract), growthScore: r1(growthScore), freqScore: r1(freqScore), contracts: priced.length
        };
        r.scores.cost = r.cost.score;
      }

      // --- overall: weights of the KPIs that have data, re-spread over those KPIs
      const used = KPIS.filter(k => r.scores[k.key] != null);
      const wsum = used.reduce((s, k) => s + k.weight, 0);
      r.kpisUsed = used.map(k => k.key);
      r.coverage = wsum;                                  // share (out of 100) of the full weighting that is backed by data
      r.partial = used.length > 0 && used.length < CONFIG.minKpis; // has some data, but not enough to call a score
      r.overall = used.length >= CONFIG.minKpis ? r1(used.reduce((s, k) => s + r.scores[k.key] * k.weight, 0) / wsum) : null;
      r.rag = ragOf(r.overall);
      out.push(r);
    });

    out.sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1) || b.contractValue - a.contractValue || a.name.localeCompare(b.name));
    let rank = 0;
    out.forEach(r => { r.rank = r.overall == null ? null : ++rank; });
    return out;
  }

  /* ---------- programme-level figures for the KPI cards ---------- */
  function portfolio(results) {
    const scored = results.filter(r => r.overall != null);
    const mean = arr => arr.length ? r1(arr.reduce((s, v) => s + v, 0) / arr.length) : null;
    const due = results.reduce((s, r) => s + r.delivery.due, 0);
    const ontime = results.reduce((s, r) => s + r.delivery.ontime, 0);
    const costed = results.filter(r => r.cost);
    const active = results.reduce((s, r) => s + r.activeContracts, 0);
    const activeValue = results.reduce((s, r) => s + r.contracts.filter(k => k.active).reduce((t, k) => t + k.contractValue, 0), 0);
    const overall = mean(scored.map(r => r.overall));
    return {
      contractors: results.length, scored: scored.length, overall, rag: ragOf(overall),
      delivery: due ? r1(ontime / due * 100) : null, deliveryDue: due, deliveryOntime: ontime,
      cost: mean(costed.map(r => r.cost.score)),
      activeContracts: active, activeValue,
      ragCounts: { green: results.filter(r => r.rag === 'green').length, amber: results.filter(r => r.rag === 'amber').length,
        red: results.filter(r => r.rag === 'red').length, none: results.filter(r => r.rag === 'none').length }
    };
  }

  /* ---------- trend: the same scoring, repeated "as at" each month end ---------- */
  function trend(facts, opts, months) {
    opts = opts || {};
    const asOf = opts.asOf || todayISO();
    const n = months || 12;
    const asOfs = [];
    for (let i = n - 1; i >= 0; i--) asOfs.push(i === 0 ? asOf : monthEnd(addMonths(asOf, -i)));
    const series = {}, portfolioSeries = [], deliverySeries = [];
    asOfs.forEach((t, idx) => {
      // A contract has no start date, so a month only counts for a contractor once something has actually happened
      // (an event fell due, or a variation was raised) — otherwise early months would all read a flat, meaningless 100.
      const res = compute(facts, { asOf: t, projectIds: opts.projectIds }).filter(r => r.delivery.due > 0 || r.changes.length > 0);
      res.forEach(r => { (series[r.id] ??= new Array(asOfs.length).fill(null))[idx] = r.overall; });
      const p = portfolio(res);
      portfolioSeries.push(p.overall);
      deliverySeries.push(p.delivery);
    });
    return { labels: asOfs.map(monthLabel), asOfs, series, portfolio: portfolioSeries, delivery: deliverySeries };
  }

  return { KPIS, CONFIG, PERIODS, RAG_LABEL, RAG_COLOR, compute, portfolio, trend, classifyEvent, ragOf, periodFrom,
    todayISO, addMonths, monthEnd, monthLabel, daysBetween };
});
