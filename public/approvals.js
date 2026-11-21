/* =========================================================
   APPROVALS + PERSONAL ACCOUNTS (client side)
   Loaded after the main script in index.html, so it can use its globals (api, esc, showToast,
   fmtDate, fmtBinTime …). Provides:
     · currentUser / userReady                  who is signed in
     · mountApprovalPanel(host, type, id, opts)  the approval section inside a document
     · applyDocLock(root, locked)               freezes a document's form while Pending/Approved
     · approvalBadge(status)                    status pill for lists
     · renderMyApprovals / renderUserAccounts   the two new sidebar pages
     · change-password dialog (forced on first sign-in with a temporary password)
   ========================================================= */
let currentUser = null;
const userReady = fetch('/api/auth/me').then(r => (r.ok ? r.json() : null)).then(u => { currentUser = u; return u; }).catch(() => null);

/* ---------- small helpers ---------- */
const APPROVAL_LABEL = { None: 'Not submitted', Pending: 'Awaiting approval', Approved: 'Approved', Rejected: 'Rejected' };
const approvalLocked = status => status === 'Pending' || status === 'Approved';
function approvalBadge(status){
  if(!status || status === 'None') return '<span class="appr-pill appr-none">—</span>';
  const cls = { Pending: 'appr-pending', Approved: 'appr-approved', Rejected: 'appr-rejected' }[status] || 'appr-none';
  return `<span class="appr-pill ${cls}">${APPROVAL_LABEL[status] || esc(status)}</span>`;
}
const ROLE_LABEL = { approver: 'Approver only', read_only: 'Read only', project_manager: 'Project manager' };
const ROLE_HELP = {
  approver: 'Sees only the documents assigned to them for approval — nothing else.',
  read_only: 'Can view the projects granted to them, and change nothing.',
  project_manager: 'Can view and edit the projects granted to them. Cannot manage accounts, master data, the Activity Log or Recycle Bin.'
};
const STEP_LABEL = { Draft: 'Not submitted', Pending: 'Waiting', Approved: 'Approved', Rejected: 'Rejected', Voided: 'Cancelled' };

// Generic modal: resolves with the value returned by onConfirm(modalEl), or null when dismissed.
function appDialog({ title, html, confirmText = 'OK', cancelText = 'Cancel', danger = false, onConfirm, hideCancel = false, dismissible = true, size = '' }){
  return new Promise(resolve => {
    const el = document.createElement('div');
    el.className = 'modal fade';
    el.tabIndex = -1;
    if(!dismissible){ el.setAttribute('data-bs-backdrop', 'static'); el.setAttribute('data-bs-keyboard', 'false'); }
    el.innerHTML = `
      <div class="modal-dialog modal-dialog-centered ${size}"><div class="modal-content appr-dialog">
        <div class="modal-header"><h5 class="modal-title">${esc(title)}</h5>${dismissible ? '<button type="button" class="btn-close" data-bs-dismiss="modal"></button>' : ''}</div>
        <div class="modal-body">${html}<div class="appr-dialog-error" hidden></div></div>
        <div class="modal-footer">
          ${hideCancel ? '' : `<button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">${esc(cancelText)}</button>`}
          ${onConfirm || confirmText ? `<button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} appr-confirm">${esc(confirmText)}</button>` : ''}
        </div>
      </div></div>`;
    document.body.appendChild(el);
    const modal = new bootstrap.Modal(el);
    let result = null, busy = false;
    const errBox = el.querySelector('.appr-dialog-error');
    el.querySelector('.appr-confirm')?.addEventListener('click', async () => {
      if(busy) return;
      busy = true; errBox.hidden = true;
      const btn = el.querySelector('.appr-confirm'); btn.disabled = true;
      try{
        result = onConfirm ? await onConfirm(el) : true;
        if(result === undefined) result = true;
        modal.hide();
      }catch(err){
        errBox.textContent = err.message; errBox.hidden = false; btn.disabled = false; busy = false;
      }
    });
    el.addEventListener('hidden.bs.modal', () => { el.remove(); resolve(result); });
    modal.show();
    setTimeout(() => el.querySelector('input,textarea')?.focus(), 350);
  });
}

/* ---------- change password ---------- */
function openChangePassword(forced = false){
  return appDialog({
    title: forced ? 'Set your own password' : 'Change password',
    dismissible: !forced, hideCancel: forced, confirmText: 'Change password',
    html: `
      ${forced ? '<div class="appr-note">You signed in with a temporary password. Choose your own password to continue.</div>' : ''}
      <label class="form-label-sm">Current password</label><input type="password" class="form-control mb-2" id="cpCurrent" autocomplete="current-password">
      <label class="form-label-sm">New password <span style="font-weight:400;text-transform:none;color:var(--muted);">(at least 10 characters, letters and numbers)</span></label>
      <input type="password" class="form-control mb-2" id="cpNew" autocomplete="new-password">
      <label class="form-label-sm">Confirm new password</label><input type="password" class="form-control" id="cpConfirm" autocomplete="new-password">`,
    onConfirm: async el => {
      const v = id => el.querySelector('#' + id).value;
      if(v('cpNew') !== v('cpConfirm')) throw new Error('The two new passwords do not match');
      await api.post('/api/auth/change-password', { currentPassword: v('cpCurrent'), newPassword: v('cpNew') });
      showToast('Password changed');
      if(forced) location.reload();
      return true;
    }
  });
}

/* ---------- document lock ---------- */
function applyDocLock(root, status){
  if(!root || !approvalLocked(status)) return;
  const msg = status === 'Pending'
    ? 'Awaiting approval — this document is locked until it is approved, rejected or withdrawn.'
    : 'Approved — this document is locked.';
  const banner = document.createElement('div');
  banner.className = 'appr-lock-banner';
  banner.innerHTML = `<i class="bi bi-lock-fill"></i> ${msg}`;
  root.prepend(banner);
  root.querySelectorAll('input, select, textarea, button').forEach(el => {
    if(el.closest('.approval-panel, .keep-enabled') || el.classList.contains('allow-locked')) return;
    el.disabled = true;
  });
}

/* ---------- the approval panel inside a document ---------- */
async function mountApprovalPanel(host, type, id, opts = {}){
  if(!host) return;
  host.classList.add('approval-panel');
  host.innerHTML = '<div class="appr-muted">Loading approval status…</div>';
  let state, user;
  try{ [user, state] = await Promise.all([userReady, api.get(`/api/approvals/${type}/${id}`)]); }
  catch(err){ host.innerHTML = `<div class="appr-error">${esc(err.message)}</div>`; return; }
  const changed = async () => { if(opts.onChange) await opts.onChange(state); };
  const rerender = () => mountApprovalPanel(host, type, id, opts);
  const fail = err => showToast(err.message, 'error');

  const head = `<div class="appr-head"><span><i class="bi bi-patch-check"></i> Approval</span>${approvalBadge(state.status)}</div>`;
  const stepRow = (s, activeId) => `
    <li class="appr-step appr-step-${s.status.toLowerCase()} ${s.id === activeId ? 'appr-step-active' : ''}">
      <span class="appr-step-no">${s.stepNo}</span>
      <div class="appr-step-main">
        <div class="appr-step-role">${esc(s.roleLabel)}</div>
        <div class="appr-step-who"><strong>${esc(s.name)}</strong>${s.designation ? ` <span class="appr-muted">· ${esc(s.designation)}</span>` : ''}</div>
        ${s.actedAt ? `<div class="appr-step-when">${s.status === 'Approved' ? 'Approved' : s.status === 'Rejected' ? 'Rejected' : ''} ${fmtBinTime(s.actedAt)}${s.actedBy ? ` by ${esc(s.actedBy)}` : ''}</div>` : ''}
        ${s.comment ? `<div class="appr-step-comment">“${esc(s.comment)}”</div>` : ''}
      </div>
      <span class="appr-step-status">${s.id === activeId ? 'Awaiting signature' : STEP_LABEL[s.status] || esc(s.status)}</span>
    </li>`;
  const historyHtml = state.history.length ? `
    <details class="appr-history"><summary>Earlier rounds (${state.history.length})</summary>
      ${state.history.map(h => `<div class="appr-history-round"><div class="appr-muted">Round ${h.round}</div><ol class="appr-steps">${h.steps.map(s => stepRow(s, null)).join('')}</ol></div>`).join('')}
    </details>` : '';
  const printLink = `<a class="btn btn-outline-secondary btn-sm allow-locked" href="${state.printUrl}" target="_blank" rel="noopener"><i class="bi bi-printer"></i> Preview / print</a>`;

  /* --- Pending / Approved: the signing timeline --- */
  if(state.locked){
    const canWithdraw = state.status === 'Pending' && user && (user.isAdmin || state.current.some(s => s.submittedBy === user.username));
    host.innerHTML = `${head}
      <ol class="appr-steps">${state.current.map(s => stepRow(s, state.activeStepId)).join('')}</ol>
      ${state.status === 'Pending' && !state.canAct && state.waitingOn ? `<div class="appr-note">Waiting for <strong>${esc(state.waitingOn.name)}</strong> (${esc(state.waitingOn.roleLabel)}).</div>` : ''}
      ${state.status === 'Approved' ? '<div class="appr-note appr-note-ok"><i class="bi bi-check-circle-fill"></i> Every approver has signed. The document is locked.</div>' : ''}
      ${state.canAct ? `
        <div class="appr-act">
          <div class="appr-act-title"><i class="bi bi-pencil-square"></i> It's your turn — ${esc(state.current.find(s => s.id === state.activeStepId).roleLabel)}</div>
          <textarea class="form-control" id="apprComment" rows="2" placeholder="Comment (optional for approval, required to reject)"></textarea>
          <div class="appr-act-buttons">
            <button type="button" class="btn btn-success" id="apprApprove"><i class="bi bi-check-lg"></i> Approve</button>
            <button type="button" class="btn btn-outline-danger" id="apprReject"><i class="bi bi-x-lg"></i> Reject</button>
            ${printLink}
          </div>
        </div>` : `<div class="appr-buttons">${printLink}
          ${canWithdraw ? '<button type="button" class="btn btn-outline-secondary btn-sm allow-locked" id="apprWithdraw"><i class="bi bi-arrow-counterclockwise"></i> Withdraw from approval</button>' : ''}
          ${state.status === 'Approved' && user && user.isAdmin ? '<button type="button" class="btn btn-outline-danger btn-sm allow-locked" id="apprReopen"><i class="bi bi-unlock"></i> Reopen for revision</button>' : ''}
        </div>`}
      ${historyHtml}`;
    const act = async (verb, body) => {
      try{ await api.post(`/api/approvals/${type}/${id}/steps/${state.activeStepId}/${verb}`, body); showToast(verb === 'approve' ? 'Approved' : 'Rejected — returned to the author'); await changed(); await rerender(); refreshApprovalBadge(); }
      catch(err){ fail(err); }
    };
    host.querySelector('#apprApprove')?.addEventListener('click', () => act('approve', { comment: host.querySelector('#apprComment').value }));
    host.querySelector('#apprReject')?.addEventListener('click', () => {
      const c = host.querySelector('#apprComment').value.trim();
      if(c.length < 3){ showToast('Write the reason for rejecting in the comment box', 'error'); host.querySelector('#apprComment').focus(); return; }
      act('reject', { comment: c });
    });
    host.querySelector('#apprWithdraw')?.addEventListener('click', async () => {
      if(!confirm('Withdraw this document from approval? Signatures given so far in this round are cancelled and it becomes editable again.')) return;
      try{ await api.post(`/api/approvals/${type}/${id}/withdraw`, {}); showToast('Withdrawn from approval'); await changed(); await rerender(); refreshApprovalBadge(); }catch(err){ fail(err); }
    });
    host.querySelector('#apprReopen')?.addEventListener('click', async () => {
      await appDialog({
        title: 'Reopen for revision', confirmText: 'Reopen', danger: true,
        html: '<div class="appr-note">This removes the approval and makes the document editable. It must be approved again afterwards. The reason is kept in the Activity Log.</div><label class="form-label-sm">Reason</label><textarea class="form-control" id="reopenReason" rows="3"></textarea>',
        onConfirm: async el => { await api.post(`/api/approvals/${type}/${id}/reopen`, { reason: el.querySelector('#reopenReason').value }); showToast('Document reopened'); }
      }).then(async ok => { if(ok){ await changed(); await rerender(); refreshApprovalBadge(); } });
    });
    return;
  }

  /* --- None / Rejected: choose approvers, then submit --- */
  let people = [];
  try{ people = await api.get('/api/approvals/approvers'); }catch(err){ fail(err); }
  const chosen = Object.fromEntries(state.draft.map(s => [s.roleKey, s.teamMemberId]));
  const rejected = state.status === 'Rejected' ? state.lastRejected.find(s => s.status === 'Rejected') : null;
  host.innerHTML = `${head}
    ${rejected ? `<div class="appr-note appr-note-bad"><i class="bi bi-arrow-return-left"></i> Rejected by <strong>${esc(rejected.name)}</strong> (${esc(rejected.roleLabel)}) ${fmtBinTime(rejected.actedAt)}.
      <div class="appr-step-comment">“${esc(rejected.comment || '')}”</div>Make the changes asked for, then submit again.</div>` : ''}
    <div class="appr-muted" style="margin-bottom:8px;">Choose who signs this document. They sign in this order, each with their own login, and appear on the printed document.</div>
    ${people.length ? '' : '<div class="appr-note appr-note-bad">No team member has a login yet. The administrator can create logins under Administration → User Accounts.</div>'}
    <div class="appr-assign">
      ${state.roles.map((r, i) => `
        <div class="appr-assign-row">
          <span class="appr-step-no">${i + 1}</span>
          <label class="appr-assign-label" for="apprRole_${r.key}">${esc(r.label)}</label>
          <select class="form-select" id="apprRole_${r.key}" data-role="${r.key}">
            <option value="">— not part of approval —</option>
            ${people.map(p => `<option value="${p.teamMemberId}" ${chosen[r.key] === p.teamMemberId ? 'selected' : ''}>${esc(p.name)}${p.designation ? ' — ' + esc(p.designation) : ''}</option>`).join('')}
          </select>
        </div>`).join('')}
    </div>
    <div class="appr-buttons">
      <button type="button" class="btn btn-outline-secondary btn-sm" id="apprSave"><i class="bi bi-save"></i> Save approvers</button>
      <button type="button" class="btn btn-primary btn-sm" id="apprSubmit"><i class="bi bi-send"></i> Submit for approval</button>
      ${printLink}
    </div>
    <div class="appr-muted" style="margin-top:6px;">Submitting locks the document exactly as last saved. Save any edits first.</div>
    ${historyHtml}`;
  const selection = () => [...host.querySelectorAll('select[data-role]')].filter(s => s.value).map(s => ({ roleKey: s.dataset.role, teamMemberId: Number(s.value) }));
  host.querySelector('#apprSave').addEventListener('click', async () => {
    try{ await api.put(`/api/approvals/${type}/${id}/approvers`, { approvers: selection() }); showToast('Approvers saved'); await rerender(); }catch(err){ fail(err); }
  });
  host.querySelector('#apprSubmit').addEventListener('click', async () => {
    const sel = selection();
    if(!sel.length){ showToast('Choose at least one approver first', 'error'); return; }
    if(!confirm('Submit for approval? The document will be locked exactly as last saved until it is approved, rejected or withdrawn.')) return;
    try{
      await api.put(`/api/approvals/${type}/${id}/approvers`, { approvers: sel });
      await api.post(`/api/approvals/${type}/${id}/submit`, {});
      showToast('Submitted for approval');
      await changed(); await rerender(); refreshApprovalBadge();
    }catch(err){ fail(err); }
  });
}

/* ---------- sidebar badge ---------- */
async function refreshApprovalBadge(){
  const badgeEl = document.getElementById('approvalsNavBadge');
  if(!badgeEl) return;
  try{
    const data = await fetch('/api/my-approvals').then(r => (r.ok ? r.json() : null));
    const n = data ? data.awaiting.length : 0;
    badgeEl.textContent = n; badgeEl.hidden = n === 0;
  }catch(e){ /* the badge is a convenience */ }
}

/* ---------- My Approvals page ---------- */
let myApprovalsData = null;
async function renderMyApprovals(){
  const el = document.getElementById('tab-my-approvals');
  if(!el.dataset.built){
    el.dataset.built = '1';
    el.innerHTML = `
      <div class="section-title"><i class="bi bi-patch-check"></i>My Approvals</div>
      <div class="chart-sub" style="margin:-6px 0 14px;">Documents waiting for your signature, in the order they must be signed. Open the preview to read the full document, then approve or reject.</div>
      <div id="myApprovalsBody"><div class="appr-muted">Loading…</div></div>`;
  }
  await loadMyApprovals();
}
async function loadMyApprovals(){
  const body = document.getElementById('myApprovalsBody');
  try{ myApprovalsData = await api.get('/api/my-approvals'); }catch(err){ body.innerHTML = `<div class="appr-error">${esc(err.message)}</div>`; return; }
  const d = myApprovalsData;
  const table = (rows, kind) => rows.length ? `
    <div class="table-card"><table class="dash-table appr-table"><thead><tr>
      <th>Document</th><th>Project</th><th>Your role</th><th>${kind === 'decided' ? 'Decision' : 'Submitted'}</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td><div class="appr-doc-type">${esc(r.docLabel)}</div><strong>${esc(r.number || '')}</strong>${r.title ? `<div class="appr-muted appr-clip">${esc(r.title)}</div>` : ''}</td>
        <td><strong>${esc(r.projectCode || '')}</strong><div class="appr-muted appr-clip">${esc(r.projectName || '')}</div></td>
        <td>${esc(r.roleLabel)}</td>
        <td>${kind === 'decided'
          ? `${r.stepStatus === 'Approved' ? '<span class="appr-pill appr-approved">Approved</span>' : '<span class="appr-pill appr-rejected">Rejected</span>'}<div class="appr-muted">${fmtBinTime(r.actedAt)}</div>${r.comment ? `<div class="appr-muted appr-clip">“${esc(r.comment)}”</div>` : ''}`
          : `${fmtBinTime(r.submittedAt)}<div class="appr-muted">by ${esc(r.submittedBy || '—')}</div>`}</td>
        <td class="row-actions" style="white-space:nowrap;">
          <a class="btn btn-outline-secondary btn-sm" href="${r.printUrl}" target="_blank" rel="noopener"><i class="bi bi-eye"></i> Review</a>
          ${kind === 'awaiting' ? `<button class="btn btn-success btn-sm" onclick="quickDecide('${r.docType}',${r.docId},${r.stepId},'approve')"><i class="bi bi-check-lg"></i> Approve</button>
          <button class="btn btn-outline-danger btn-sm" onclick="quickDecide('${r.docType}',${r.docId},${r.stepId},'reject')"><i class="bi bi-x-lg"></i> Reject</button>` : ''}
          ${kind === 'upcoming' ? `<span class="appr-muted">Waiting for ${esc(r.waitingOn || '—')}</span>` : ''}
          ${kind === 'overview' ? `<span class="appr-muted">With ${esc(r.waitingOn || '—')}</span>` : ''}
        </td></tr>`).join('')}
    </tbody></table></div>` : '';
  const section = (title, count, content, empty) => `<div class="appr-section"><div class="appr-section-title">${title}${count ? `<span class="appr-count">${count}</span>` : ''}</div>${content || `<div class="empty-state">${empty}</div>`}</div>`;
  if(d.isAdmin){
    body.innerHTML = `<div class="appr-note">You are signed in with the shared administrator login, which has no approvals of its own — approvals are signed by the assigned person with their own account. This is what is in progress across all projects.</div>`
      + section('In progress', d.overview.length, table(d.overview, 'overview'), 'Nothing is waiting for approval.');
  }else{
    body.innerHTML = section('Waiting for you', d.awaiting.length, table(d.awaiting, 'awaiting'), 'Nothing is waiting for your signature.')
      + (d.upcoming.length ? section('Coming up — waiting for someone before you', d.upcoming.length, table(d.upcoming, 'upcoming')) : '')
      + section('Recently decided by you', 0, table(d.decided, 'decided'), 'You have not approved or rejected anything yet.');
  }
  refreshApprovalBadge();
}
async function quickDecide(type, docId, stepId, verb){
  const reject = verb === 'reject';
  const ok = await appDialog({
    title: reject ? 'Reject this document' : 'Approve this document', confirmText: reject ? 'Reject' : 'Approve', danger: reject,
    html: `<div class="appr-note">${reject ? 'The document returns to its author, who can correct it and submit it again.' : 'Your approval is recorded with your name, the time and your IP address.'}</div>
      <label class="form-label-sm">Comment ${reject ? '(required)' : '(optional)'}</label><textarea class="form-control" id="qdComment" rows="3"></textarea>`,
    onConfirm: async el => {
      const comment = el.querySelector('#qdComment').value;
      if(reject && comment.trim().length < 3) throw new Error('Write the reason for rejecting');
      await api.post(`/api/approvals/${type}/${docId}/steps/${stepId}/${verb}`, { comment });
    }
  });
  if(ok){ showToast(reject ? 'Rejected — returned to the author' : 'Approved'); loadMyApprovals(); }
}

/* ---------- User Accounts page (administrator) ---------- */
async function renderUserAccounts(){
  const el = document.getElementById('tab-user-accounts');
  const user = await userReady;
  if(!user || !user.isAdmin){ el.innerHTML = '<div class="empty-state">Only the administrator can manage user accounts.</div>'; return; }
  el.innerHTML = `
    <div class="section-title"><i class="bi bi-people"></i>User Accounts</div>
    <div class="chart-sub" style="margin:-6px 0 14px;">Give team members their own login so they can sign approvals. A new login gets a one-time temporary password, which the person must replace when they first sign in. Team members are added under Master Data → Team Members.</div>
    <div id="userAccountsBody"><div class="appr-muted">Loading…</div></div>`;
  await loadUserAccounts();
}
async function loadUserAccounts(){
  const body = document.getElementById('userAccountsBody');
  let accounts;
  try{ accounts = await api.get('/api/user-accounts'); }catch(err){ body.innerHTML = `<div class="appr-error">${esc(err.message)}</div>`; return; }
  const byMember = new Map(accounts.map(a => [a.teamMemberId, a]));
  const members = [...teamMembersMaster].sort((a, b) => a.name.localeCompare(b.name));
  body.innerHTML = `<div class="table-card"><table class="dash-table"><thead><tr>
      <th>Team member</th><th>Username</th><th>Role template</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>
    ${members.map(m => {
      const a = byMember.get(m.id);
      const status = !a ? '<span class="appr-pill appr-none">No login</span>'
        : a.locked ? '<span class="appr-pill appr-rejected">Locked</span>'
        : !a.active ? '<span class="appr-pill appr-none">Disabled</span>'
        : a.mustChangePassword ? '<span class="appr-pill appr-pending">Temporary password</span>' : '<span class="appr-pill appr-approved">Active</span>';
      return `<tr>
        <td><strong>${esc(m.name)}</strong><div class="appr-muted">${esc(m.designation || '')}</div></td>
        <td>${a ? esc(a.username) : '—'}</td>
        <td>${a ? `<select class="form-select appr-role-select" onchange="setAccountRole(${m.id}, this.value)">
              ${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${a.role === k ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
            ${a.role === 'approver' ? '' : `<div class="acct-access">
              <button class="btn btn-link btn-sm p-0" onclick="editAccess(${m.id})"><i class="bi bi-shield-lock"></i> <strong>Access</strong> · change</button>
              <div class="appr-muted acct-access-sum">
                <a href="#" onclick="editAccess(${m.id}, 'menus'); return false;">Menus: ${a.menus ? `${a.menus.length} of ${sidebarMenus().length}` : 'all'}</a> ·
                <a href="#" onclick="editAccess(${m.id}, 'permissions'); return false;">Permissions: ${a.permissions ? 'custom' : 'role template'}</a> ·
                <a href="#" onclick="editAccess(${m.id}, 'projects'); return false;">${a.projectIds.length ? `${a.projectIds.length} project${a.projectIds.length === 1 ? '' : 's'}` : '<span style="color:var(--red);">No projects yet</span>'}</a>
              </div></div>`}` : '—'}</td>
        <td>${status}</td>
        <td>${a && a.lastLoginAt ? fmtBinTime(a.lastLoginAt) : '—'}</td>
        <td class="row-actions" style="white-space:nowrap;">
          ${!a ? `<button class="btn btn-primary btn-sm" onclick="createAccount(${m.id})"><i class="bi bi-person-plus"></i> Create login</button>` : `
            <button class="btn btn-outline-secondary btn-sm" onclick="renameAccount(${m.id}, '${esc(a.username)}')">Rename</button>
            <button class="btn btn-outline-secondary btn-sm" onclick="resetAccountPassword(${m.id})"><i class="bi bi-key"></i> Reset password</button>
            <button class="btn btn-outline-${a.active ? 'danger' : 'success'} btn-sm" onclick="setAccountActive(${m.id}, ${!a.active})">${a.active ? 'Disable' : 'Enable'}</button>`}
        </td></tr>`;
    }).join('')}
    </tbody></table></div>`;
}
function suggestUsername(m){
  const base = (m.email ? m.email.split('@')[0] : m.name.trim().toLowerCase().replace(/\s+/g, '.')).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return base.slice(0, 40);
}
function showTemporaryPassword(name, username, password){
  return appDialog({
    title: 'Temporary password', hideCancel: true, confirmText: 'Done', dismissible: false,
    html: `<div class="appr-note appr-note-bad"><i class="bi bi-exclamation-triangle"></i> This password is shown <strong>only once</strong>. Give it to ${esc(name)} privately; they must choose their own when they first sign in.</div>
      <div class="appr-cred"><div><span class="appr-muted">Username</span><div class="appr-cred-val">${esc(username)}</div></div>
      <div><span class="appr-muted">Temporary password</span><div class="appr-cred-val" id="tmpPw">${esc(password)}</div></div></div>
      <button type="button" class="btn btn-outline-secondary btn-sm" onclick="navigator.clipboard.writeText(document.getElementById('tmpPw').textContent).then(()=>showToast('Copied'))"><i class="bi bi-clipboard"></i> Copy password</button>`
  });
}
async function createAccount(memberId){
  const m = teamMembersMaster.find(x => x.id === memberId);
  const res = await appDialog({
    title: `Create login for ${m.name}`, confirmText: 'Create login',
    html: `<label class="form-label-sm">Username</label><input class="form-control" id="acctUsername" value="${esc(suggestUsername(m))}" autocomplete="off">
      <div class="appr-muted" style="margin-top:6px;">3–40 characters: letters, numbers, dot, dash or underscore.</div>
      <label class="form-label-sm" style="margin-top:12px;">Start from (role template)</label>
      <select class="form-select" id="acctRole" onchange="document.getElementById('acctRoleHelp').textContent = ROLE_HELP[this.value]">
        ${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
      </select>
      <div class="appr-role-help" id="acctRoleHelp">${ROLE_HELP.approver}</div>
      <div class="appr-role-help">This only sets the starting point. Afterwards use Projects, Menus and Permissions on the account row to control exactly what this person can see and do.</div>`,
    onConfirm: el => api.post(`/api/team-members/${memberId}/account`, { username: el.querySelector('#acctUsername').value, role: el.querySelector('#acctRole').value })
  });
  if(res && res.temporaryPassword){ await showTemporaryPassword(m.name, res.account.username, res.temporaryPassword); }
  loadUserAccounts();
}
async function setAccountRole(memberId, role){
  try{
    await api.put(`/api/team-members/${memberId}/account/access`, { role });
    showToast(`Role template set to ${ROLE_LABEL[role]}. It takes effect within a minute.`);
  }catch(err){ showToast(err.message, 'error'); }
  loadUserAccounts();
}
// The grantable menus, read from the sidebar itself so this list can never drift from what is on screen.
function sidebarMenus(){
  const out = []; let group = '';
  document.querySelectorAll('#sidebarNav > *').forEach(el => {
    if(el.classList.contains('nav-section-label')){ group = el.textContent.trim(); return; }
    const key = el.dataset && el.dataset.tab;
    if(!key || key === 'my-approvals' || el.hasAttribute('data-admin-only')) return;
    out.push({ key, group, label: el.textContent.replace(/\d+$/, '').trim() });
  });
  return out;
}
/* =========================================================
   ACCESS — everything about what one login may see and do, in ONE dialog with one Save:
     Menus          which sidebar menus the person sees
     Permissions    what they may do with each kind of record, as a tree: the project tabs sit under Projects (view / create / edit / delete,
                    and "actual qty only" on the Sequence of Events)
     Projects       which projects they can reach
   Only what was changed is sent. The account row's links open this same dialog on the matching tab.
   (The server still understands per-project overrides — user_project_access.permissions — but nothing sets them from here.)
   ========================================================= */
const ACT_LABEL = { view: 'View', actuals: 'Actual qty only', create: 'Create', edit: 'Edit', delete: 'Delete' };
const accJson = v => JSON.stringify(v);
const accNormMatrix = m => (m ? Object.fromEntries(Object.keys(m).sort().filter(k => (m[k] || []).length).map(k => [k, [...m[k]].sort()])) : null);

function accessMenusHtml(acct, name){
  const menus = sidebarMenus(), chosen = new Set(acct.menus || menus.map(x => x.key));
  let lastGroup = '';
  return `<div class="appr-note">Choose which menus ${esc(name)} sees. My Approvals is always available. Hiding Risk Register / Risk Analytics, Issue Log or Milestones also blocks that data on the server; other menus are hidden from the screen.</div>
    <label class="appr-proj-list" style="display:flex;margin:0 0 6px;"><input type="checkbox" id="maDefault" ${acct.menus ? '' : 'checked'}> <span><strong>Use the role default</strong> — every menu</span></label>
    <div class="appr-proj-list" id="maList">${menus.map(x => {
      const head = x.group !== lastGroup ? `<div class="appr-muted" style="margin-top:8px;font-weight:700;text-transform:uppercase;">${esc(x.group)}</div>` : '';
      lastGroup = x.group;
      return `${head}<label><input type="checkbox" value="${x.key}" ${chosen.has(x.key) ? 'checked' : ''} ${acct.menus ? '' : 'disabled'}> <span>${esc(x.label)}</span></label>`;
    }).join('')}</div>`;
}
/* The Permissions grid as a tree: the project tabs sit under Projects, the master-data lists under Master Data. A record the catalogue
   knows about but this list does not mention is added at the end, so a new permission can never go missing from the screen. */
const ACCESS_TREE = [
  { key: 'projects', label: 'Projects', hint: 'Project Brief tab',
    children: [['events', 'Sequence of Events', 'materials, crew / contractor'], ['team', 'Resources', 'team members, external parties, resource groups'], ['cost', 'Cost Statement', ''],
      ['documents', 'Attachments', 'project documents'], ['change_requests', 'Change Requests', 'analyses, decisions'], ['certificates', 'Completion Certificates', ''],
      ['vowd', 'VOWD Statements', ''], ['invoices', 'Invoices', '']] },
  { key: 'risks', label: 'Risks' }, { key: 'issues', label: 'Issues' }, { key: 'milestones', label: 'Milestones' },
  { group: 'Master Data', children: [['locations', 'Locations', ''], ['project_types', 'Project Types', ''], ['contractors', 'Contractors', ''], ['business_units', 'Business Units', ''], ['team_members', 'Team Members', '']] },
  { key: 'reports', label: 'Report Library', hint: 'generate reports, saved reports, schedules' }
];
function accessPermissionRows(cat, cellsOf){
  const byKey = new Map(cat.resources.map(r => [r.key, r])), used = new Set();
  const name = (label, hint) => `${esc(label)}${hint ? ` <span class="pm-hint">${esc(hint)}</span>` : ''}`;
  const row = (r, label, hint, cls) => { used.add(r.key); return `<tr class="${cls}"><td>${name(label, hint)}</td>${cellsOf(r)}</tr>`; };
  const out = [];
  ACCESS_TREE.forEach(node => {
    const kids = (node.children || []).filter(c => byKey.has(c[0]));
    if(node.group){
      if(!kids.length) return;
      out.push(`<tr class="pm-group"><td colspan="${cat.actions.length + 2}">${esc(node.group)}</td></tr>`);
      kids.forEach((c, i) => out.push(row(byKey.get(c[0]), c[1], c[2], `pm-child${i === kids.length - 1 ? ' pm-last' : ''}`)));
      return;
    }
    if(!byKey.has(node.key)) return;
    out.push(row(byKey.get(node.key), node.label, node.hint, kids.length ? 'pm-parent' : 'pm-top'));
    kids.forEach((c, i) => out.push(row(byKey.get(c[0]), c[1], c[2], `pm-child${i === kids.length - 1 ? ' pm-last' : ''}`)));
  });
  cat.resources.filter(r => !used.has(r.key)).forEach(r => out.push(row(r, r.label, '', 'pm-top')));
  return out.join('');
}
function accessPermissionsHtml(acct, cat, name){
  // the grid shows what the login really has: for a custom matrix that includes rows the stored matrix does not list (they follow other rows)
  const start = acct.effectivePermissions || cat.templates[acct.role] || {};
  // not every record has every action (only the Sequence of Events has "Actual qty only"; the Cost Statement can only be viewed)
  const cell = (r, a) => (r.actions.includes(a) ? `<td class="text-center"><input type="checkbox" data-r="${r.key}" data-a="${a}" ${(start[r.key] || []).includes(a) ? 'checked' : ''} ${acct.permissions ? '' : 'disabled'}></td>` : '<td></td>');
  return `<div class="appr-note">Tick what ${esc(name)} may do with each kind of record. Project records are further limited to the projects granted to them. Approvals are separate: a document assigned to them for approval can always be opened and signed.<br><strong>Actual qty only</strong> on the Sequence of Events lets them record Actual / Consumed quantities (and dated entries) and change nothing else; <strong>Edit</strong> includes it.</div>
    <label class="appr-proj-list" style="display:flex;margin:0 0 8px;"><input type="checkbox" id="pmDefault" ${acct.permissions ? '' : 'checked'}> <span><strong>Use the role template</strong> (${esc(ROLE_LABEL[acct.role])})</span></label>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;" id="pmFill">
      <span class="appr-muted" style="align-self:center;">Fill from:</span>
      <button type="button" class="btn btn-outline-secondary btn-sm" data-fill="read_only">Read only</button>
      <button type="button" class="btn btn-outline-secondary btn-sm" data-fill="project_manager">Project manager</button>
      <button type="button" class="btn btn-outline-secondary btn-sm" data-fill="none">Nothing</button>
    </div>
    <div class="table-responsive"><table class="dash-table" id="pmGrid"><thead><tr><th>Records</th>${cat.actions.map(a => `<th class="text-center">${ACT_LABEL[a]}</th>`).join('')}<th class="text-center">All</th></tr></thead><tbody>
    ${accessPermissionRows(cat, r => `${cat.actions.map(a => cell(r, a)).join('')}<td class="text-center"><input type="checkbox" data-row="${r.key}" ${acct.permissions ? '' : 'disabled'}></td>`)}
    </tbody></table></div>`;
}
function accessProjectsHtml(acct){
  const chosen = new Set(acct.projectIds), list = [...projects].sort((a, b) => String(a.code).localeCompare(String(b.code)));
  return `<div class="appr-note">${esc(ROLE_LABEL[acct.role])}: can ${acct.role === 'read_only' ? 'view' : 'view and edit'} only the projects ticked here. Remove a project to hide it from this person completely.</div>
    <div style="display:flex;gap:8px;align-items:center;">
      <input class="form-control" id="paSearch" placeholder="Search projects…">
      <button type="button" class="btn btn-outline-secondary btn-sm" id="paAll">Select shown</button>
      <button type="button" class="btn btn-outline-secondary btn-sm" id="paNone">Clear shown</button>
    </div>
    <div class="appr-proj-list" id="paList">${list.map(p => `<label data-q="${esc((p.code + ' ' + p.name).toLowerCase())}"><input type="checkbox" value="${p.id}" ${chosen.has(p.id) ? 'checked' : ''}> <span><strong>${esc(p.code)}</strong> — ${esc(p.name)}</span></label>`).join('')}</div>`;
}
async function editAccess(memberId, startTab = 'menus'){
  const m = teamMembersMaster.find(x => x.id === memberId);
  const [accounts, cat] = await Promise.all([api.get('/api/user-accounts'), api.get('/api/user-accounts/acl-catalog')]);
  const acct = accounts.find(a => a.teamMemberId === memberId);
  if(!acct || acct.role === 'approver'){ showToast('An approver-only login has no menus, permissions or projects. Change its role first.', 'error'); return; }
  const TABS = [
    ['menus', 'Menus', acct.menus ? `${acct.menus.length} of ${sidebarMenus().length}` : 'all'],
    ['permissions', 'Permissions', acct.permissions ? 'custom' : 'role template'],
    ['projects', 'Projects', acct.projectIds.length ? String(acct.projectIds.length) : 'none']
  ];
  const panes = { menus: accessMenusHtml(acct, m.name), permissions: accessPermissionsHtml(acct, cat, m.name), projects: accessProjectsHtml(acct) };
  const res = await appDialog({
    title: `Access — ${m.name}`, confirmText: 'Save access', size: 'modal-lg',
    html: `<div class="ac-tabs" id="acTabs">${TABS.map(([k, label, note]) => `<button type="button" class="ac-tab ${k === startTab ? 'on' : ''}" data-ac="${k}">${label}<small>${esc(note)}</small></button>`).join('')}</div>
      ${TABS.map(([k]) => `<div class="ac-pane" data-ac-pane="${k}" ${k === startTab ? '' : 'hidden'}>${panes[k]}</div>`).join('')}`,
    onConfirm: el => {
      const body = {};
      const menusNow = el.querySelector('#maDefault').checked ? null : [...el.querySelectorAll('#maList input:checked')].map(i => i.value).sort();
      if(accJson(menusNow) !== accJson(acct.menus ? [...acct.menus].sort() : null)) body.menus = menusNow;
      let permsNow = null;
      if(!el.querySelector('#pmDefault').checked){ permsNow = {}; el.querySelectorAll('#pmGrid input[data-r]:checked').forEach(i => { (permsNow[i.dataset.r] ||= []).push(i.dataset.a); }); }
      // custom matrices are compared with what the login effectively has today; switching from the role template to a custom matrix is always sent
      if(permsNow === null ? acct.permissions !== null : (acct.permissions === null || accJson(accNormMatrix(permsNow)) !== accJson(accNormMatrix(acct.effectivePermissions)))) body.permissions = permsNow;
      const idsNow = [...el.querySelectorAll('#paList input:checked')].map(i => Number(i.value));
      if(accJson([...idsNow].sort((a, b) => a - b)) !== accJson([...acct.projectIds].sort((a, b) => a - b))) body.projectIds = idsNow;
      if(!Object.keys(body).length) return Promise.resolve({ unchanged: true });
      return api.put(`/api/team-members/${memberId}/account/access`, body);
    }
  });
  if(res && !res.unchanged){ showToast('Access saved. It takes effect within a minute.'); loadUserAccounts(); }
}
// the old entry points (links on the account row) now open the one dialog on the matching tab
const editMenuAccess = id => editAccess(id, 'menus');
const editPermissions = id => editAccess(id, 'permissions');
const editProjectAccess = id => editAccess(id, 'projects');

/* ---- the dialog's own behaviour (event delegation — the dialog is created on demand) ---- */
function accShowTab(key){
  document.querySelectorAll('#acTabs .ac-tab').forEach(b => b.classList.toggle('on', b.dataset.ac === key));
  document.querySelectorAll('.ac-pane').forEach(p => { p.hidden = p.dataset.acPane !== key; });
}
document.addEventListener('click', e => {
  const t = e.target.closest && e.target.closest('.ac-tab');
  if(t) accShowTab(t.dataset.ac);
});
document.addEventListener('change', async e => {
  const t = e.target;
  if(t.id === 'pmDefault'){
    document.querySelectorAll('#pmGrid input').forEach(i => { i.disabled = t.checked; });
  }else if(t.dataset && t.dataset.row){
    document.querySelectorAll(`#pmGrid input[data-r="${t.dataset.row}"]`).forEach(i => { i.checked = t.checked; });
  }else if(t.id === 'maDefault'){
    document.querySelectorAll('#maList input').forEach(i => { i.disabled = t.checked; if(t.checked) i.checked = true; });
  }
});
document.addEventListener('click', async e => {
  const fill = e.target.dataset && e.target.dataset.fill;
  if(!fill) return;
  const cat = await api.get('/api/user-accounts/acl-catalog');
  const tpl = fill === 'none' ? {} : cat.templates[fill];
  document.getElementById('pmDefault').checked = false;
  document.querySelectorAll('#pmGrid input').forEach(i => { i.disabled = false; });
  document.querySelectorAll('#pmGrid input[data-r]').forEach(i => { i.checked = (tpl[i.dataset.r] || []).includes(i.dataset.a); });
});
document.addEventListener('input', e => {
  if(e.target.id !== 'paSearch') return;
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('#paList label').forEach(l => { l.style.display = !q || l.dataset.q.includes(q) ? '' : 'none'; });
});
document.addEventListener('click', e => {
  if(e.target.id !== 'paAll' && e.target.id !== 'paNone') return;
  document.querySelectorAll('#paList label').forEach(l => { if(l.style.display !== 'none') l.querySelector('input').checked = e.target.id === 'paAll'; });
});

async function renameAccount(memberId, current){
  const m = teamMembersMaster.find(x => x.id === memberId);
  const res = await appDialog({
    title: `Change username — ${m.name}`, confirmText: 'Save',
    html: `<label class="form-label-sm">Username</label><input class="form-control" id="acctUsername" value="${esc(current)}" autocomplete="off">`,
    onConfirm: el => api.post(`/api/team-members/${memberId}/account`, { username: el.querySelector('#acctUsername').value })
  });
  if(res){ showToast('Username changed'); loadUserAccounts(); }
}
async function resetAccountPassword(memberId){
  const m = teamMembersMaster.find(x => x.id === memberId);
  const res = await appDialog({
    title: `Reset password — ${m.name}`, confirmText: 'Reset password', danger: true,
    html: '<div class="appr-note">Their current password stops working immediately and a new temporary password is generated.</div>',
    onConfirm: () => api.post(`/api/team-members/${memberId}/account/reset-password`, {})
  });
  if(res && res.temporaryPassword) await showTemporaryPassword(m.name, res.account.username, res.temporaryPassword);
  loadUserAccounts();
}
async function setAccountActive(memberId, active){
  const m = teamMembersMaster.find(x => x.id === memberId);
  if(!active && !confirm(`Disable ${m.name}'s login? They are signed out and cannot approve anything until it is enabled again.`)) return;
  try{
    const res = await api.put(`/api/team-members/${memberId}/account`, { active });
    if(!active && res.pendingApprovals) showToast(`Disabled — note: ${res.pendingApprovals} document(s) are still waiting for ${m.name}. Withdraw and re-assign them.`, 'error');
    else showToast(active ? 'Login enabled' : 'Login disabled');
    loadUserAccounts();
  }catch(err){ showToast(err.message, 'error'); }
}

/* ---------- menu access: hide what the administrator hasn't granted, and block navigating to it ---------- */
function applyMenus(allowed){
  document.querySelectorAll('#sidebarNav .side-link').forEach(b => {
    const key = b.dataset.tab;
    if(key === 'my-approvals' || b.hasAttribute('data-admin-only')) return;
    b.hidden = !allowed.has(key);
  });
  // a section heading with nothing left under it goes too
  document.querySelectorAll('#sidebarNav .nav-section-label').forEach(label => {
    let el = label.nextElementSibling, any = false;
    while(el && !el.classList.contains('nav-section-label')){ if(el.classList.contains('side-link') && !el.hidden) any = true; el = el.nextElementSibling; }
    label.style.display = any ? '' : 'none';
  });
  const original = window.goToTab;
  window.goToTab = function(tabId, ...rest){
    if(tabId !== 'my-approvals' && !allowed.has(tabId)){ showToast('You do not have access to this menu', 'error'); return; }
    return original.call(this, tabId, ...rest);
  };
}

/* ---------- what each page lets this login do (from its permission matrix) ----------
   Each page that creates / edits / deletes records is tied to a row of the matrix. A page is marked crud-nocreate / crud-noedit /
   crud-nodelete when the login lacks that action (CSS hides the matching buttons, and keeps them hidden when the page redraws);
   a page whose "View" is missing disappears from the sidebar. The server refuses the action anyway — this only stops the buttons
   from being offered. The Projects register is the exception for Edit / Delete: those follow the project's own per-project rights. */
const CRUD_PAGES = { 'master-governorates': 'locations', 'master-types': 'project_types', 'master-contractors': 'contractors', 'master-business-units': 'business_units',
  'master-team-members': 'team_members', 'risks-crud': 'risks', 'issues-crud': 'issues', 'milestones-crud': 'milestones', 'master-projects': 'projects', 'reports': 'reports' };
function canOnProject(resource, action, projectId){
  const u = currentUser; if(!u || u.isAdmin) return true;
  const o = (u.projectPerms || {})[projectId], own = u.permissions || {};
  return ((o && o[resource] !== undefined ? o[resource] : own[resource]) || []).includes(action);
}
function applyCrudGates(user){
  if(!user || user.isAdmin) return;
  const perms = user.permissions || {};
  Object.entries(CRUD_PAGES).forEach(([tab, resource]) => {
    const has = a => (perms[resource] || []).includes(a), pane = document.getElementById('tab-' + tab);
    if(pane){
      pane.classList.toggle('crud-nocreate', !has('create'));
      if(tab !== 'master-projects'){ pane.classList.toggle('crud-noedit', !has('edit')); pane.classList.toggle('crud-nodelete', !has('delete')); }
    }
    const link = document.querySelector(`#sidebarNav .side-link[data-tab="${tab}"]`);
    if(link && !has('view')) link.hidden = true;
  });
  document.querySelectorAll('#sidebarNav .nav-section-label').forEach(label => {
    let el = label.nextElementSibling, any = false;
    while(el && !el.classList.contains('nav-section-label')){ if(el.classList.contains('side-link') && !el.hidden) any = true; el = el.nextElementSibling; }
    label.style.display = any ? '' : 'none';
  });
}

/* ---------- start-up: who am I, nav visibility, forced password change ---------- */
userReady.then(user => {
  if(!user) return;
  document.querySelectorAll('[data-admin-only]').forEach(el => { el.hidden = !user.isAdmin; });
  const pw = document.getElementById('btnChangePassword');
  if(pw){ pw.hidden = user.userType !== 'user'; pw.addEventListener('click', () => openChangePassword(false)); }
  const nameEl = document.getElementById('sidebarUsername');
  if(nameEl && user.displayName) nameEl.textContent = user.displayName + (user.isAdmin ? ' (admin)' : ` · ${ROLE_LABEL[user.role] || ''}`);
  if(user.mustChangePassword){ openChangePassword(true); return; }
  const allowedMenus = user.isAdmin ? null : new Set(user.menus || []);
  if(allowedMenus) applyMenus(allowedMenus);
  applyCrudGates(user);
  if(user.role === 'approver' || (allowedMenus && allowedMenus.size === 0)){
    // Nothing but their worklist: the dashboard data is never loaded for them.
    document.body.classList.add('role-approver');
    goToTab('my-approvals');
  }else{
    const canWrite = Object.values(user.permissions || {}).some(list => list.some(a => a !== 'view'));
    if(!user.isAdmin && !canWrite) document.body.classList.add('role-readonly');
    if(allowedMenus && !allowedMenus.has('overview')){
      const first = sidebarMenus().find(x => allowedMenus.has(x.key));
      if(first) goToTab(first.key);
    }
    window.bootDashboard();
  }
  refreshApprovalBadge(); setInterval(refreshApprovalBadge, 60000);
});
userReady.then(user => { if(!user && window.bootDashboard) window.bootDashboard(); }); // not signed in: let the normal redirect happen
