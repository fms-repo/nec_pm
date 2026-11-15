/* Project Progress — the Excel "progress measurement sheet": planned vs actual for every activity, plus the project, work-package,
   S-curve, slippage and look-ahead figures behind the Project Progress page (all from public/progress-calc.js). */
'use strict';
const ExcelJS = require('exceljs');
const PC = require('./public/progress-calc.js');

const TEAL = 'FF1B7A8C';
const date = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };

function buildProgressWorkbook(an, o) {
  o = o || {};
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NEC Project Management Dashboard'; wb.created = new Date(); wb.title = 'Progress measurement sheet';
  const sheet = (name, title, note, headers, rows, fmt) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 4 }] });
    ws.mergeCells(1, 1, 1, Math.max(3, headers.length)); ws.getCell(1, 1).value = title; ws.getCell(1, 1).font = { bold: true, size: 14 };
    ws.mergeCells(2, 1, 2, Math.max(3, headers.length)); ws.getCell(2, 1).value = note; ws.getCell(2, 1).font = { italic: true, color: { argb: 'FF5F6B73' } };
    ws.getRow(4).values = headers.map(h => h.label);
    ws.getRow(4).eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } }; c.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }; });
    ws.getRow(4).height = 32;
    headers.forEach((h, i) => { ws.getColumn(i + 1).width = h.width || 14; if (h.fmt) ws.getColumn(i + 1).numFmt = h.fmt; });
    rows.forEach(r => { const row = ws.addRow(headers.map(h => (h.date ? date(r[h.key]) : r[h.key] == null ? null : r[h.key]))); if (fmt) fmt(row, r); });
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: headers.length } };
    return ws;
  };
  const tint = (cell, ok) => { cell.font = { bold: true, color: { argb: ok ? 'FF1F6B43' : 'FF9E2B2B' } }; };
  const D = 'dd/mm/yyyy', P1 = '0.0', header = `Position as at ${PC.iso(PC.num(an.today))}`;

  const m = PC.measurement(an);
  sheet('Measurement', 'Progress measurement sheet — planned vs actual by activity',
    `${header}. Planned % = share of the activity the schedule says should be finished by today; Actual % = recorded progress. Weight = planned duration in days.`,
    [{ key: 'code', label: 'Project code', width: 11 }, { key: 'project', label: 'Project', width: 38 }, { key: 'stage', label: 'Work package (stage)', width: 24 }, { key: 'seq', label: '#', width: 6 }, { key: 'task', label: 'Activity', width: 44 },
      { key: 'plannedStart', label: 'Planned start', date: true, fmt: D, width: 12 }, { key: 'plannedEnd', label: 'Planned finish', date: true, fmt: D, width: 12 }, { key: 'plannedDays', label: 'Planned days', width: 9, fmt: '#,##0' },
      { key: 'actualStart', label: 'Actual start', date: true, fmt: D, width: 12 }, { key: 'actualEnd', label: 'Actual finish', date: true, fmt: D, width: 12 },
      { key: 'planned', label: 'Planned % to date', width: 11, fmt: P1 }, { key: 'actual', label: 'Actual %', width: 9, fmt: P1 }, { key: 'variance', label: 'Variance (pts)', width: 10, fmt: P1 },
      { key: 'weight', label: 'Weight (days)', width: 9, fmt: '#,##0' }, { key: 'status', label: 'Status', width: 13 }, { key: 'daysLate', label: 'Days late', width: 9, fmt: '#,##0' }, { key: 'owner', label: 'Owner', width: 20 }],
    m, (row, r) => { if (r.variance < 0) tint(row.getCell(13), false); else if (r.variance > 0) tint(row.getCell(13), true); if (r.overdue) tint(row.getCell(16), false); });

  sheet('By project', 'Progress by project', `${header}. SPI = actual ÷ planned. Schedule (days) = earned schedule: negative is behind. Forecast = current pace carried to the end.`,
    [{ key: 'code', label: 'Code', width: 11 }, { key: 'name', label: 'Project', width: 42 }, { key: 'businessUnit', label: 'Business unit', width: 14 }, { key: 'status', label: 'Status', width: 12 },
      { key: 'planned', label: 'Planned %', width: 10, fmt: P1 }, { key: 'actual', label: 'Actual %', width: 10, fmt: P1 }, { key: 'variance', label: 'Variance (pts)', width: 10, fmt: P1 }, { key: 'spi', label: 'SPI', width: 8, fmt: '0.00' },
      { key: 'svDays', label: 'Schedule (days, − behind)', width: 14, fmt: '#,##0' }, { key: 'done', label: 'Tasks done', width: 9 }, { key: 'tasks', label: 'Tasks', width: 8 }, { key: 'overdue', label: 'Overdue', width: 9 },
      { key: 'baseline', label: 'Baseline finish', date: true, fmt: D, width: 13 }, { key: 'forecast', label: 'Forecast finish', date: true, fmt: D, width: 13 }, { key: 'forecastDelay', label: 'Forecast delay (days)', width: 12, fmt: '#,##0' }],
    an.rows, (row, r) => { tint(row.getCell(7), r.variance >= 0); if (r.forecastDelay > 0) tint(row.getCell(15), false); });

  sheet('By work package', 'Progress by work package (project stage)', `${header}.`,
    [{ key: 'stage', label: 'Work package', width: 30 }, { key: 'tasks', label: 'Tasks', width: 9 }, { key: 'done', label: 'Done', width: 9 }, { key: 'overdue', label: 'Overdue', width: 9 }, { key: 'planned', label: 'Planned %', width: 10, fmt: P1 }, { key: 'actual', label: 'Actual %', width: 10, fmt: P1 }],
    PC.workPackages(an, o.stages || []));

  const c = PC.curve(an, { points: 60 });
  sheet('S-curve', 'Cumulative progress (S-curve data)', `${header}. Past actual values are rebuilt from the recorded actual dates; earned is budget-weighted (several projects only).`,
    [{ key: 'date', label: 'Date', date: true, fmt: D, width: 13 }, { key: 'planned', label: 'Planned %', width: 11, fmt: P1 }, { key: 'actual', label: 'Actual %', width: 11, fmt: P1 }, { key: 'earned', label: 'Earned % (budget-weighted)', width: 14, fmt: P1 }],
    c.dates.map((d, i) => ({ date: d, planned: c.planned[i], actual: c.actual[i], earned: c.earned[i] })));

  const w = PC.slippage(an, 6);
  sheet('Slippage', 'Slippage by month', `${header}. Days ahead (+) / behind (−) schedule at each month end (average of the projects) and what each month gained or lost.`,
    [{ key: 'asAt', label: 'As at', date: true, fmt: D, width: 13 }, { key: 'sv', label: 'Days ahead (+) / behind (−)', width: 16, fmt: '#,##0' }, { key: 'change', label: 'Gained (+) / lost (−) in the month', width: 18, fmt: '#,##0' }], w.steps);

  sheet('Look-ahead', 'Look-ahead — next 4 weeks', `${header}. Activities due to finish, or to start, in the next four weeks.`,
    [{ key: 'code', label: 'Project code', width: 11 }, { key: 'project', label: 'Project', width: 38 }, { key: 'stage', label: 'Stage', width: 24 }, { key: 'task', label: 'Activity', width: 44 },
      { key: 'plannedStart', label: 'Planned start', date: true, fmt: D, width: 12 }, { key: 'plannedEnd', label: 'Planned finish', date: true, fmt: D, width: 12 }, { key: 'daysToFinish', label: 'Due in (days)', width: 10, fmt: '#,##0' },
      { key: 'owner', label: 'Owner', width: 20 }, { key: 'status', label: 'Status', width: 13 }, { key: 'progress', label: 'Progress %', width: 10, fmt: P1 }, { key: 'kind', label: 'Finishes / starts', width: 12 }],
    PC.lookahead(an, 4));
  return wb;
}
module.exports = { buildProgressWorkbook };
