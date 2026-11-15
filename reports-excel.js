/* Report Library — Excel version of a finished report (the stored snapshot, see reports-blocks.js for the section shapes).
   Sheet "Summary" holds the title block, key figures, bullet lists and notes; every table section becomes its own sheet,
   with real numbers and dates (not text) so the workbook can be filtered, pivoted and charted. */
'use strict';
const ExcelJS = require('exceljs');

const TEAL = 'FF1B7A8C';
const FILL = { good: 'FFE3F4EA', warn: 'FFFCF0D6', bad: 'FFF8E0E0', info: 'FFE0F0F5', muted: 'FFEDEFF1' };
const FONT = { good: 'FF1F6B43', warn: 'FF8A5A00', bad: 'FF9E2B2B', info: 'FF1B6A7A', muted: 'FF5F6B73' };
const NUM_FMT = { money: '#,##0.000', pct: '0.0"%"', num1: '0.0', ratio: '0.00', int: '#,##0', days: '#,##0', date: 'dd/mm/yyyy' };
const unwrap = c => (c && typeof c === 'object' && 'v' in c ? c.v : c);
const toneOf = c => (c && typeof c === 'object' ? c.tone : undefined);

function excelValue(type, v) {
  if (v === null || v === undefined || v === '') return null;
  if (type === 'date') { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v)); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : String(v); }
  if (NUM_FMT[type] && type !== 'date') { const n = Number(v); return Number.isFinite(n) ? n : String(v); }
  return v;
}
function tint(cell, tone) { if (FILL[tone]) { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[tone] } }; cell.font = { ...(cell.font || {}), color: { argb: FONT[tone] }, bold: tone === 'bad' || tone === 'warn' }; } }
function sheetName(wb, base) {
  let n = String(base).replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 31) || 'Sheet', i = 2;
  while (wb.getWorksheet(n)) n = n.slice(0, 28) + ' ' + i++;
  return n;
}

async function buildWorkbook(doc, meta = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NEC Project Management Dashboard'; wb.created = new Date(); wb.title = doc.title;
  const ws = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 34 }, { width: 22 }, { width: 60 }];
  const put = (r, a, b, c, o = {}) => { const row = ws.getRow(r); row.getCell(1).value = a; if (b !== undefined) row.getCell(2).value = b; if (c !== undefined) row.getCell(3).value = c; return row; };
  let r = 1;
  ws.mergeCells(r, 1, r, 3); ws.getCell(r, 1).value = doc.brand ? doc.brand.name : 'NEC'; ws.getCell(r, 1).font = { bold: true, color: { argb: TEAL }, size: 11 }; r++;
  ws.mergeCells(r, 1, r, 3); ws.getCell(r, 1).value = doc.title; ws.getCell(r, 1).font = { bold: true, size: 18 }; ws.getRow(r).height = 26; r++;
  const meta1 = [['Scope', doc.scope.label], ['Business units', doc.scope.businessUnits.join(', ')], ['Period', `${doc.period.from} to ${doc.period.to}`], ['Position as at', doc.today],
    ['Generated', `${String(doc.generatedAt).replace('T', ' ').slice(0, 16)} UTC by ${doc.generatedBy}`], ['Reference', `${meta.ref || ''}${meta.version ? ` · version ${meta.version}` : ''}`]];
  meta1.forEach(([k, v]) => { put(r, k, v).getCell(1).font = { bold: true, color: { argb: 'FF5F6B73' } }; ws.mergeCells(r, 2, r, 3); r++; });
  r++;
  const heading = t => { const c = ws.getCell(r, 1); c.value = t; c.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } }; for (let i = 1; i <= 3; i++) ws.getCell(r, i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } }; r++; };
  let n = 0;
  for (const s of doc.sections) {
    if (s.kind === 'kpis') {
      heading(s.title || 'Key figures');
      s.items.forEach(it => { const row = put(r, it.label, excelValue(it.type, it.value), it.sub || ''); const c = row.getCell(2); if (NUM_FMT[it.type]) c.numFmt = NUM_FMT[it.type]; c.alignment = { horizontal: 'right' }; tint(c, it.tone); r++; });
      r++;
    } else if (s.kind === 'bullets') {
      heading(s.title);
      s.items.forEach(it => { ws.mergeCells(r, 1, r, 3); const c = ws.getCell(r, 1); c.value = '• ' + it.text; c.alignment = { wrapText: true, vertical: 'top' }; ws.getRow(r).height = Math.max(16, Math.ceil(it.text.length / 110) * 15); tint(c, it.tone); r++; });
      r++;
    } else if (s.kind === 'text') {
      heading(s.title); ws.mergeCells(r, 1, r, 3); ws.getCell(r, 1).value = s.text; ws.getCell(r, 1).alignment = { wrapText: true, vertical: 'top' }; ws.getRow(r).height = 32; r += 2;
    } else if (s.kind === 'stack') {
      heading(s.title);
      s.segments.forEach(g => { const row = put(r, g.label, g.value); row.getCell(2).alignment = { horizontal: 'right' }; tint(row.getCell(1), g.tone); r++; });
      if (s.note) { ws.mergeCells(r, 1, r, 3); ws.getCell(r, 1).value = s.note; ws.getCell(r, 1).font = { italic: true, color: { argb: 'FF5F6B73' } }; r++; }
      r++;
    } else if (s.kind === 'table') {
      n++;
      const t = wb.addWorksheet(sheetName(wb, `${n} ${s.title}`), { views: [{ state: 'frozen', ySplit: 3, showGridLines: true }] });
      t.mergeCells(1, 1, 1, Math.max(2, s.columns.length)); t.getCell(1, 1).value = `${doc.title} — ${s.title}`; t.getCell(1, 1).font = { bold: true, size: 13 };
      t.getRow(3).values = s.columns.map(c => c.label);
      t.getRow(3).eachCell(c => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } }; c.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }; });
      t.getRow(3).height = 30;
      const widths = s.columns.map(c => Math.max(10, String(c.label).length * 0.9));
      const addRow = (row, bold) => {
        const xr = t.addRow(s.columns.map(c => excelValue(c.type, unwrap(row[c.key]))));
        s.columns.forEach((c, i) => {
          const cell = xr.getCell(i + 1), v = unwrap(row[c.key]);
          if (NUM_FMT[c.type]) cell.numFmt = NUM_FMT[c.type];
          cell.alignment = { horizontal: c.align === 'center' ? 'center' : c.type === 'text' ? 'left' : 'right', vertical: 'top', wrapText: c.type === 'text' };
          tint(cell, toneOf(row[c.key]));
          if (bold) { cell.font = { ...(cell.font || {}), bold: true }; cell.border = { top: { style: 'thin' } }; }
          widths[i] = Math.min(60, Math.max(widths[i], String(v == null ? '' : v instanceof Date ? 'dd/mm/yyyy' : v).length + 2));
        });
      };
      s.rows.forEach(row => addRow(row, false));
      if (s.totals && s.rows.length) addRow(s.totals, true);
      if (!s.rows.length) { t.getRow(4).getCell(1).value = s.empty; t.getRow(4).getCell(1).font = { italic: true, color: { argb: 'FF5F6B73' } }; }
      t.columns.forEach((c, i) => { c.width = widths[i]; });
      if (s.note) { const nr = t.addRow([]); const rr = t.addRow([s.note]); t.mergeCells(rr.number, 1, rr.number, Math.max(2, s.columns.length)); rr.getCell(1).alignment = { wrapText: true, vertical: 'top' }; rr.getCell(1).font = { italic: true, color: { argb: 'FF5F6B73' } }; rr.height = Math.max(18, Math.ceil(s.note.length / 120) * 15); }
      ws.getCell(r, 1).value = `Sheet "${t.name}" — ${s.rows.length} row${s.rows.length === 1 ? '' : 's'}`; ws.getCell(r, 1).font = { color: { argb: 'FF5F6B73' } }; r++;
    }
  }
  if (doc.omitted && doc.omitted.length) {
    r++; heading('Not included for your access level');
    doc.omitted.forEach(o => { put(r, o.title, o.reason); r++; });
  }
  return wb;
}

module.exports = { buildWorkbook };
