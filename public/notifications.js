/* =========================================================
   NOTIFICATIONS — the bell in the page header (see notifications.js on the server for what raises an alert).
   Polls every 60 seconds; shows a toast when new alerts arrive. Uses the dashboard's api, esc, showToast and openProjectModal.
   ========================================================= */
(function () {
  'use strict';
  const PAGE = 20;
  const N = { items: [], unread: 0, total: 0, lastUnread: null, open: false, busy: false };
  const $ = id => document.getElementById(id);
  const ICON = { 'event-overdue': 'bi-calendar-x', 'progress-behind': 'bi-graph-down-arrow' };

  const ago = s => {
    const t = Date.parse(String(s || '').replace(' ', 'T') + 'Z'); if (isNaN(t)) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60); if (h < 24) return h + ' h ago';
    const d = Math.round(h / 24); return d + ' day' + (d === 1 ? '' : 's') + ' ago';
  };
  const dmy = iso => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');
  const todayOman = () => new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
  const daysPast = iso => Math.round((Date.parse(todayOman() + 'T00:00:00Z') - Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z')) / 864e5);

  function badge() {
    const b = $('ntBadge'); if (!b) return;
    b.textContent = N.unread > 99 ? '99+' : N.unread; b.hidden = N.unread === 0;
    $('ntBell').title = N.unread ? `${N.unread} unread alert${N.unread === 1 ? '' : 's'}` : 'Alerts';
  }

  function itemHtml(n) {
    let extra = '';
    if (n.kind === 'event-overdue' && n.details && n.details.plannedEnd) { const d = daysPast(n.details.plannedEnd); if (d > 0) extra = ` · planned finish ${dmy(n.details.plannedEnd)} (${d} day${d === 1 ? '' : 's'} ago)`; }
    return `<div class="nt-item sev-${esc(n.severity)} ${n.read ? '' : 'unread'}" data-id="${n.id}" data-project="${n.projectId}" role="button" tabindex="0">
      <i class="bi ${ICON[n.kind] || 'bi-bell'}"></i>
      <div class="nt-body"><b>${esc(n.title)}</b><p>${esc(n.message)}</p><small>${esc(ago(n.createdAt))} · ${esc(n.projectCode || '')}${esc(extra)}</small></div>
      ${n.read ? '' : '<span class="nt-dot" title="Unread"></span>'}</div>`;
  }

  function draw() {
    const p = $('ntPanel'); if (!p) return;
    p.innerHTML = `<div class="nt-head"><b>Alerts</b><button type="button" id="ntAll" ${N.unread ? '' : 'disabled'}>Mark all read</button></div>
      <div class="nt-list">${N.items.length ? N.items.map(itemHtml).join('') : '<div class="nt-empty"><i class="bi bi-bell-slash"></i><br>No alerts. You will be told here when an event passes its planned finish date or a project falls more than 10 points behind plan.</div>'}</div>
      ${N.items.length < N.total ? `<div class="nt-foot"><button type="button" id="ntMore">Show more (${N.total - N.items.length})</button></div>` : ''}`;
    $('ntAll').addEventListener('click', markAll);
    const more = $('ntMore'); if (more) more.addEventListener('click', loadMore);
    p.querySelectorAll('.nt-item').forEach(el => {
      const go = () => openItem(Number(el.dataset.id), Number(el.dataset.project));
      el.addEventListener('click', go); el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
  }

  async function load(quiet) {
    if (N.busy) return; N.busy = true;
    try {
      const r = await api.get(`/api/notifications?limit=${Math.max(PAGE, N.items.length)}&offset=0`);
      N.items = r.items; N.total = r.total;
      if (N.lastUnread != null && r.unread > N.lastUnread && quiet) showToast(`${r.unread - N.lastUnread} new alert${r.unread - N.lastUnread === 1 ? '' : 's'} — see the bell at the top`);
      N.unread = N.lastUnread = r.unread;
      badge(); if (N.open) draw();
    } catch (e) { if (N.lastUnread == null && $('ntBell')) $('ntBell').closest('.nt-wrap').hidden = true; /* the bell is a convenience; hidden when this login cannot view projects */ }
    finally { N.busy = false; }
  }
  async function loadMore() {
    try { const r = await api.get(`/api/notifications?limit=${PAGE}&offset=${N.items.length}`); N.items = N.items.concat(r.items); N.total = r.total; draw(); } catch (e) { showToast(e.message, 'error'); }
  }
  async function markAll() {
    try { await api.post('/api/notifications/read', { all: true }); N.items.forEach(n => { n.read = true; }); N.unread = N.lastUnread = 0; badge(); draw(); } catch (e) { showToast(e.message, 'error'); }
  }
  async function openItem(id, projectId) {
    const n = N.items.find(x => x.id === id);
    if (n && !n.read) { n.read = true; N.unread = N.lastUnread = Math.max(0, N.unread - 1); badge(); api.post('/api/notifications/read', { ids: [id] }).catch(() => {}); }
    toggle(false);
    if (typeof openProjectModal === 'function') openProjectModal(projectId);
  }

  function toggle(open) {
    N.open = open === undefined ? !N.open : open;
    const p = $('ntPanel'); if (!p) return;
    p.hidden = !N.open; $('ntBell').setAttribute('aria-expanded', String(N.open));
    if (N.open) { draw(); load(false); }
  }

  function init() {
    const bell = $('ntBell'); if (!bell) return;
    bell.addEventListener('click', e => { e.stopPropagation(); toggle(); });
    document.addEventListener('click', e => { if (N.open && !e.target.closest('.nt-wrap')) toggle(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && N.open) toggle(false); });
    load(false); setInterval(() => load(true), 60000);
    window.addEventListener('focus', () => load(true));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.Notifications = { refresh: () => load(true) };
})();
