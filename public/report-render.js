/* Report Library — draws a finished report (the JSON snapshot stored in the archive) as HTML.
   Used by report-print.html (viewer / print / Save as PDF). The section shapes are described at the top of reports-blocks.js.
   Nothing here calculates anything: every number was fixed on the server when the report was generated. */
(function (root) {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (v, d) => Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const date = v => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : (v ? esc(v) : ''); };
  const raw = c => (c && typeof c === 'object' && 'v' in c ? c.v : c);
  const toneOf = c => (c && typeof c === 'object' ? c.tone : undefined);
  const subOf = c => (c && typeof c === 'object' ? c.sub : undefined);

  function fmt(type, v) {
    if (v === null || v === undefined || v === '') return '—';
    switch (type) {
      case 'money': return nf(v, 3);
      case 'pct': return nf(v, 1) + '%';
      case 'num1': return nf(v, 1);
      case 'ratio': return nf(v, 2);
      case 'int': case 'days': return nf(v, 0);
      case 'date': return date(v);
      default: return esc(v);
    }
  }
  function cellHtml(col, c) {
    const v = raw(c), tone = toneOf(c), sub = subOf(c);
    if (v === null || v === undefined || v === '') return '<span class="rd-nil">—</span>';
    const text = fmt(col.type, v);
    if (tone && (col.type === 'text' || sub)) return `<span class="rd-chip t-${tone}">${text}${sub ? ` <small>${esc(sub)}</small>` : ''}</span>`;
    if (tone) return `<span class="rd-tone t-${tone}">${text}</span>`;
    return text;
  }

  function kpisHtml(s) {
    return `<div class="rd-kpis">${s.items.map(i => `<div class="rd-kpi${i.tone ? ' t-' + i.tone : ''}">
      <div class="rd-kpi-v">${fmt(i.type, i.value)}</div><div class="rd-kpi-l">${esc(i.label)}</div>${i.sub ? `<div class="rd-kpi-s">${esc(i.sub)}</div>` : ''}</div>`).join('')}</div>`;
  }
  function tableHtml(s) {
    if (!s.rows.length) return `<div class="rd-empty">${esc(s.empty)}</div>${s.note ? `<div class="rd-note">${esc(s.note)}</div>` : ''}`;
    const head = `<tr>${s.columns.map(c => `<th class="a-${c.align || 'left'}">${esc(c.label)}</th>`).join('')}</tr>`;
    const row = (r, cls) => `<tr class="${cls || ''}">${s.columns.map(c => `<td class="a-${c.align || 'left'}">${cellHtml(c, r[c.key])}</td>`).join('')}</tr>`;
    return `<table class="rd-table"><thead>${head}</thead><tbody>${s.rows.map(r => row(r)).join('')}${s.totals ? row(s.totals, 'rd-total') : ''}</tbody></table>${s.note ? `<div class="rd-note">${esc(s.note)}</div>` : ''}`;
  }
  function stackHtml(s) {
    const total = s.segments.reduce((t, g) => t + (Number(g.value) || 0), 0);
    if (!total) return `<div class="rd-empty">None.</div>`;
    return `<div class="rd-stack">${s.segments.filter(g => g.value > 0).map(g => `<span class="t-${g.tone || 'muted'}" style="flex:${g.value}" title="${esc(g.label)}: ${g.value}">${g.value}</span>`).join('')}</div>
      <div class="rd-legend">${s.segments.map(g => `<span><i class="t-${g.tone || 'muted'}"></i>${esc(g.label)} <b>${nf(g.value, 0)}</b></span>`).join('')}</div>${s.note ? `<div class="rd-note">${esc(s.note)}</div>` : ''}`;
  }
  function sectionHtml(s, i) {
    const cls = `rd-sec k-${s.kind}${s.pageBreak ? ' rd-break' : ''}`;
    let body = '';
    if (s.kind === 'kpis') body = kpisHtml(s);
    else if (s.kind === 'table') body = tableHtml(s);
    else if (s.kind === 'stack') body = stackHtml(s);
    else if (s.kind === 'bullets') body = `<ul class="rd-bullets">${s.items.map(b => `<li class="t-${b.tone || 'muted'}"><i></i><span>${esc(b.text)}</span></li>`).join('')}</ul>`;
    else if (s.kind === 'text') body = `<p class="rd-text${s.tone ? ' t-' + s.tone : ''}">${esc(s.text)}</p>`;
    return `<section class="${cls}" id="sec-${i}"><h2>${esc(s.title || '')}</h2>${body}</section>`;
  }

  function metaLine(doc, meta) {
    const bits = [`<b>Scope</b> ${esc(doc.scope.label)}`, `<b>Period</b> ${date(doc.period.from)} – ${date(doc.period.to)}`, `<b>Position as at</b> ${date(doc.today)}`];
    return bits.join('<span class="rd-sep">·</span>');
  }
  function genLine(doc, meta) {
    const d = new Date(doc.generatedAt), p = n => String(n).padStart(2, '0');
    const when = isNaN(d) ? '' : `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    return `Generated ${when} by ${esc(doc.generatedBy)}${meta ? ` · ${esc(meta.ref)} · version ${meta.version}` : ''}`;
  }
  function brandHtml(doc) {
    return `<div class="rd-brand">${doc.brand && doc.brand.logoUrl ? `<img src="${esc(doc.brand.logoUrl)}" alt="" onerror="this.remove()">` : ''}<span>${esc(doc.brand ? doc.brand.name : 'NEC')}</span></div>`;
  }

  function renderDoc(doc, meta) {
    const titled = doc.sections.map((s, i) => ({ s, i })).filter(x => x.s.title && x.s.kind !== 'kpis' || (x.s.kind === 'kpis' && x.s.title));
    const board = doc.layout === 'board';
    const cover = board ? `
      <section class="rd-cover">
        ${brandHtml(doc)}
        <div class="rd-cover-mid">
          <div class="rd-eyebrow">${esc(doc.category || 'Report')}</div>
          <h1>${esc(doc.title)}</h1>
          <div class="rd-cover-scope">${esc(doc.scope.label)}</div>
          <div class="rd-cover-meta">Period ${date(doc.period.from)} – ${date(doc.period.to)}<br>Position as at ${date(doc.today)}</div>
        </div>
        <div class="rd-contents"><h3>Contents</h3><ol>${titled.map(x => `<li><a href="#sec-${x.i}">${esc(x.s.title)}</a></li>`).join('')}</ol></div>
        <div class="rd-cover-foot">${genLine(doc, meta)}<br>Confidential — for internal use</div>
      </section>` : `
      <header class="rd-head">
        ${brandHtml(doc)}
        <div class="rd-head-main"><div class="rd-eyebrow">${esc(doc.category || 'Report')}</div><h1>${esc(doc.title)}</h1><div class="rd-meta">${metaLine(doc, meta)}</div><div class="rd-gen">${genLine(doc, meta)}</div></div>
      </header>`;
    const projects = doc.scope.projects || [];
    const scopeBox = `<section class="rd-sec rd-scope"><h2>Scope of this report</h2>
      <div class="rd-scope-grid"><div><b>${doc.scope.projectCount}</b> project${doc.scope.projectCount === 1 ? '' : 's'}</div><div>${esc(doc.scope.businessUnits.join(' · '))}</div>${doc.scope.statuses && doc.scope.statuses.length ? `<div>Status: ${esc(doc.scope.statuses.join(', '))}</div>` : ''}</div>
      ${projects.length ? `<div class="rd-projects">${projects.map(p => `<span title="${esc(p.name)}">${esc(p.code)} ${esc(p.name)}</span>`).join('')}${doc.scope.projectCount > projects.length ? `<span>+${doc.scope.projectCount - projects.length} more</span>` : ''}</div>` : ''}</section>`;
    const omitted = doc.omitted && doc.omitted.length ? `<section class="rd-sec"><h2>Not included</h2><div class="rd-note">These sections are not shown because they are not available to the login that generated this report: ${doc.omitted.map(o => esc(o.title)).join(', ')}.</div></section>` : '';
    return `<article class="rd-doc layout-${esc(doc.layout)}">${cover}${board ? '' : ''}<div class="rd-body">${board ? '' : ''}${scopeBox}${doc.sections.map(sectionHtml).join('')}${omitted}</div></article>`;
  }

  root.ReportRender = { renderDoc, esc, fmt, date };
})(typeof window !== 'undefined' ? window : globalThis);
