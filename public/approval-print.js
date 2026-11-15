/* Shared by the VOWD / change request / completion certificate print previews:
   fills each signature block from the approval workflow (name, designation, electronic signature
   stamp) and, for the person whose turn it is, shows an Approve / Reject bar above the document. */
(function(){
  const css = document.createElement('style');
  css.textContent = `
    .sign-block .sig-space{min-height:40px; display:flex; align-items:flex-end;}
    .sign-block .sig-space + .line{margin-top:4px !important;}
    .sign-block .title{font-size:.72rem; color:#6B7C85;}
    .sig-stamp{font-size:.68rem; line-height:1.35; padding:3px 8px; border-radius:6px; border:1px solid; -webkit-print-color-adjust:exact; print-color-adjust:exact;}
    .sig-stamp.ok{color:#1E7A4D; border-color:#1E7A4D; background:#EAF6EF;}
    .sig-stamp.wait{color:#9A6A00; border-color:#D9A93A; background:#FFF6E0;}
    .sig-stamp.bad{color:#B3261E; border-color:#B3261E; background:#FDECEA;}
    .approval-bar{max-width:920px; margin:0 auto 14px; padding:12px 16px; background:#FFF6E0; border:1px solid #D9A93A; border-radius:10px; font-family:inherit;}
    .approval-bar strong{display:block; margin-bottom:6px;}
    .approval-bar textarea{width:100%; border:1px solid #C9D3D8; border-radius:6px; padding:6px 8px; font:inherit; font-size:.85rem;}
    .approval-bar .row{display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; align-items:center;}
    .approval-bar button{border:0; border-radius:6px; padding:7px 16px; font-weight:700; cursor:pointer; font:inherit; font-weight:700;}
    .approval-bar .ok{background:#1E7A4D; color:#fff;} .approval-bar .no{background:#fff; color:#B3261E; border:1px solid #B3261E;}
    .approval-bar .msg{font-size:.8rem; color:#B3261E;}
    .approval-banner{max-width:920px; margin:0 auto 10px; font-size:.8rem; color:#6B7C85; text-align:center;}
    @media print{ .approval-bar,.approval-banner{display:none !important;} }
  `;
  document.head.appendChild(css);

  const pad = n => String(n).padStart(2, '0');
  function stamp(ts){
    const d = new Date(String(ts).replace(' ', 'T') + 'Z');
    return isNaN(d) ? ts : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function load(type, id){
    try{
      const r = await fetch(`/api/approvals/${type}/${id}`);
      if(!r.ok) return null;
      const state = await r.json();
      state.byRole = {};
      const steps = state.locked ? state.current : state.draft;
      steps.forEach(s => { state.byRole[s.roleKey] = s; });
      return state;
    }catch(e){ return null; }
  }

  // One signature block. An approver assigned through the workflow replaces the typed-in name.
  function signBlock(state, key, role, fallbackName, fallbackTitle){
    const step = state && state.byRole[key];
    const name = step ? step.name : fallbackName, title = step ? step.designation : fallbackTitle;
    let st = '';
    if(step && state.locked){
      if(step.status === 'Approved') st = `<div class="sig-stamp ok">&#10003; Approved electronically<br>${escape(stamp(step.actedAt))} &middot; ${escape(step.actedBy || '')}</div>`;
      else if(step.status === 'Rejected') st = `<div class="sig-stamp bad">Rejected ${escape(stamp(step.actedAt))}</div>`;
      else st = '<div class="sig-stamp wait">Awaiting signature</div>';
    }
    return `<div class="sign-block"><div class="sig-space">${st}</div><div class="line"></div><div class="role">${escape(role)}</div>
      <div class="who">${escape(name || '')}</div>${title ? `<div class="title">${escape(title)}</div>` : ''}</div>`;
  }

  // Approve / Reject bar for the person whose turn it is; a short status line for everyone else.
  function mountBar(state){
    if(!state) return;
    const sheet = document.querySelector('.sheet');
    if(!sheet) return;
    if(state.status === 'Pending' && !state.canAct && state.waitingOn){
      const b = document.createElement('div');
      b.className = 'approval-banner';
      b.textContent = `Awaiting approval — waiting for ${state.waitingOn.name} (${state.waitingOn.roleLabel}).`;
      sheet.parentNode.insertBefore(b, sheet);
    }
    if(!state.canAct) return;
    const role = state.current.find(s => s.id === state.activeStepId).roleLabel;
    const bar = document.createElement('div');
    bar.className = 'approval-bar';
    bar.innerHTML = `<strong>Your approval is needed — ${escape(role)}</strong>
      <textarea rows="2" placeholder="Comment (optional for approval, required to reject)"></textarea>
      <div class="row"><button class="ok">Approve</button><button class="no">Reject</button><span class="msg"></span></div>`;
    sheet.parentNode.insertBefore(bar, sheet);
    const msg = bar.querySelector('.msg'), box = bar.querySelector('textarea');
    const act = async verb => {
      const comment = box.value.trim();
      if(verb === 'reject' && comment.length < 3){ msg.textContent = 'Write the reason for rejecting.'; return; }
      if(!confirm(verb === 'approve' ? 'Approve this document? Your approval is recorded with your name and the time.' : 'Reject this document and return it to its author?')) return;
      bar.querySelectorAll('button').forEach(b => b.disabled = true);
      try{
        const r = await fetch(`/api/approvals/${state.docType}/${state.docId}/steps/${state.activeStepId}/${verb}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comment })
        });
        if(!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not record your decision');
        location.reload();
      }catch(e){ msg.textContent = e.message; bar.querySelectorAll('button').forEach(b => b.disabled = false); }
    };
    bar.querySelector('.ok').addEventListener('click', () => act('approve'));
    bar.querySelector('.no').addEventListener('click', () => act('reject'));
  }

  window.ApprovalPrint = { load, signBlock, mountBar };
})();
