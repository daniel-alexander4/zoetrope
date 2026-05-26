// manage.js: the /manage page — the hosting console. Lives between two
// in-page views (toggled by body class, no routing):
//   - view-landing: the entry card with two CTAs (Generate / Enter MI),
//     plus the sessions card surfacing minted URLs.
//   - view-mi: the Management Interface — identity, sessions, editor
//     cards in a grid. Future audio / file-transfer / other panels join
//     the same grid as cards.
// Client mode is meaningless here, so it redirects to the ball page.

(() => {
  'use strict';

  const state = {
    nmode: 'standalone',
    sessions: new Map(), // fp → { node, snap }
    view: 'landing',     // 'landing' | 'mi'
    initialModeApplied: false,
  };

  async function csrfFetch(path, options = {}) {
    const headers = { ...(options.headers || {}), 'X-Zoetrope': '1' };
    return fetch(path, { ...options, headers });
  }

  async function networkStandalone() {
    return csrfFetch('/api/mode/standalone', { method: 'POST' });
  }
  async function networkQuickstart() {
    const r = await csrfFetch('/api/sessions/quickstart', { method: 'POST' });
    if (!r.ok) throw new Error((await r.text()).trim() || 'quickstart failed');
    return r.json();
  }
  async function sendSessionVerb(fp, verb) {
    try {
      const r = await csrfFetch('/api/sessions/' + fp + '/verb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(verb),
      });
      if (!r.ok) console.warn('verb', r.status, await r.text());
    } catch (err) {
      console.error('sendSessionVerb:', err);
    }
  }

  // ---- Page state -----------------------------------------------------

  // setView toggles the in-page surface (Landing vs MI) by swapping body
  // classes. CSS does the show/hide; no DOM rebuild, no fetch. Idempotent —
  // calling it with the current view is a no-op. Leaving MI also clears
  // body.show-info so the identity card doesn't surprise the user on
  // their next MI visit.
  function setView(view) {
    state.view = view;
    document.body.classList.remove('view-landing', 'view-mi');
    document.body.classList.add('view-' + view);
    if (view !== 'mi') {
      document.body.classList.remove('show-info');
      const info = document.getElementById('btn-show-info');
      if (info) info.setAttribute('aria-pressed', 'false');
    }
  }

  function applyMode(snap) {
    const mode = snap.mode || 'standalone';
    state.nmode = mode;
    document.body.classList.remove('nmode-standalone', 'nmode-client', 'nmode-manager');
    document.body.classList.add('nmode-' + mode);

    if (mode === 'client') {
      // /manage is purely for hosting. A client doesn't belong here —
      // their experience is the ball page.
      window.location.href = '/';
      return;
    }

    const landing = document.getElementById('landing-card');
    const library = document.getElementById('library-card');
    const editor = document.getElementById('editor-section');
    const sessions = document.getElementById('sessions');
    const stopBtn = document.getElementById('btn-stop-hosting');
    const enterMiBtn = document.getElementById('btn-enter-mi');

    // landing-card is always present in the DOM; the view-class on body
    // is what hides it in MI view. Sessions card is landing-only (CSS),
    // so we only manage its hidden attribute for "has any URL been
    // minted yet" — landing hides it visually until the first session.
    landing.hidden = false;

    if (mode === 'manager') {
      library.hidden = false;
      editor.hidden = false;
      sessions.hidden = false;
      stopBtn.hidden = false;
      enterMiBtn.disabled = false;
      enterMiBtn.title = 'Open the Management Interface';
      document.getElementById('practitioner-fp').dataset.full = snap.practitioner_fp || '';
      document.getElementById('practitioner-ep').textContent = snap.public_endpoint || '—';
      refreshIdentityDisplay();
      renderSessions(snap.sessions || []);
      // On first paint only, pick the view from session state: existing
      // sessions → MI (the user is returning to a live setup); no
      // sessions → Landing (the user chose to start fresh). Subsequent
      // mode snapshots never auto-pivot — view changes are driven by
      // explicit clicks (Enter MI / ← Landing) so generating a URL from
      // Landing doesn't yank the user out of Landing.
      if (!state.initialModeApplied) {
        setView((snap.sessions && snap.sessions.length) ? 'mi' : 'landing');
      }
    } else { // standalone
      library.hidden = true;
      editor.hidden = true;
      sessions.hidden = true;
      stopBtn.hidden = true;
      enterMiBtn.disabled = true;
      enterMiBtn.title = 'Generate a connection string first to engage hosting';
      state.sessions.clear();
      document.getElementById('sessions-list').innerHTML = '';
      document.getElementById('start-error').textContent = '';
      // Returning from manager → standalone always lands on Landing.
      setView('landing');
    }
    state.initialModeApplied = true;
  }

  // ---- Identity collapse / expand ------------------------------------
  //
  // The fingerprint is 64 hex chars — useful for verification but visually
  // overwhelming when the practitioner first lands in manager mode. Show
  // a 12-char head + ellipsis + 4-char tail by default; one click reveals
  // the full hex. Endpoint is short enough to render in full always.

  function refreshIdentityDisplay() {
    const fpEl = document.getElementById('practitioner-fp');
    const collapsed = document.getElementById('identity-panel').dataset.collapsed === 'true';
    const full = fpEl.dataset.full || '';
    if (!full) { fpEl.textContent = '—'; return; }
    fpEl.textContent = collapsed ? truncateHash(full, 12, 4) : full;
  }

  function truncateHash(s, head, tail) {
    if (s.length <= head + tail + 1) return s;
    return s.slice(0, head) + '…' + s.slice(-tail);
  }

  function setIdentityCollapsed(collapsed) {
    const panel = document.getElementById('identity-panel');
    const toggle = document.getElementById('identity-toggle');
    panel.dataset.collapsed = collapsed ? 'true' : 'false';
    toggle.textContent = collapsed ? 'Show full' : 'Hide full';
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    refreshIdentityDisplay();
  }

  document.getElementById('identity-toggle').addEventListener('click', () => {
    const cur = document.getElementById('identity-panel').dataset.collapsed === 'true';
    setIdentityCollapsed(!cur);
  });

  // ---- "Connection string generated" banner --------------------------

  let generatedBannerTimer = null;
  function flashGeneratedBanner() {
    const b = document.getElementById('generated-banner');
    b.textContent = 'Connection string generated — copy it below and share with your client.';
    b.hidden = false;
    if (generatedBannerTimer) clearTimeout(generatedBannerTimer);
    generatedBannerTimer = setTimeout(() => { b.hidden = true; }, 6000);
  }

  // ---- Sessions list -------------------------------------------------

  function renderSessions(sessions) {
    const list = document.getElementById('sessions-list');
    list.innerHTML = '';
    state.sessions.clear();
    for (const sess of sessions) addSessionToList(sess);
  }

  function addSessionToList(snap, url) {
    const existing = state.sessions.get(snap.fingerprint);
    if (existing) {
      if (url) existing.node.querySelector('.session-url').value = url;
      return;
    }
    const list = document.getElementById('sessions-list');
    const tmpl = document.getElementById('session-template');
    const node = tmpl.content.firstElementChild.cloneNode(true);
    node.dataset.fp = snap.fingerprint;
    node.querySelector('.session-label').textContent = snap.label || snap.fingerprint.slice(0, 12);
    const statusEl = node.querySelector('.session-status');
    statusEl.textContent = snap.connected ? 'connected' : 'waiting';
    statusEl.dataset.status = snap.connected ? 'connected' : 'waiting';
    if (url) node.querySelector('.session-url').value = url;
    wireSessionNode(node, snap.fingerprint);
    list.appendChild(node);
    state.sessions.set(snap.fingerprint, { node, snap });
  }

  function removeSessionFromList(fp) {
    const entry = state.sessions.get(fp);
    if (!entry) return;
    entry.node.remove();
    state.sessions.delete(fp);
  }

  function updateSessionStatus(fp, status) {
    const entry = state.sessions.get(fp);
    if (!entry) return;
    const el = entry.node.querySelector('.session-status');
    el.textContent = status;
    el.dataset.status = status;
  }

  function setSessionLabel(fp, label) {
    const entry = state.sessions.get(fp);
    if (!entry || !label) return;
    entry.node.querySelector('.session-label').textContent = label;
  }

  function populateSessionPicker(fp, payload) {
    const entry = state.sessions.get(fp);
    if (!entry || !payload?.sequences) return;
    const sel = entry.node.querySelector('.session-picker');
    sel.innerHTML = '<option value="">Jump to…</option>';
    for (const seq of payload.sequences) {
      const opt = document.createElement('option');
      opt.value = String(seq.index);
      opt.textContent = `${seq.index + 1}. ${seq.label}`;
      sel.appendChild(opt);
    }
  }

  function updateSessionDetail(fp, payload) {
    const entry = state.sessions.get(fp);
    if (!entry || !payload) return;
    const playing = payload.playing ? '▶' : '⏸';
    const idx = payload.item_idx ?? 0;
    const rep = payload.repeat_idx ?? 0;
    const pat = payload.pattern || '?';
    entry.node.querySelector('.session-detail').textContent =
      `${playing} item ${idx + 1}, rep ${rep + 1}, pattern ${pat}`;
  }

  function wireSessionNode(node, fp) {
    node.querySelector('.session-remove').addEventListener('click', () => {
      confirmAction(
        'Remove this session? The connection string becomes invalid and any connected client is disconnected.',
        () => csrfFetch('/api/sessions/' + fp, { method: 'DELETE' }).catch(()=>{}),
      );
    });
    node.querySelector('.session-copy').addEventListener('click', () => {
      const ta = node.querySelector('.session-url');
      if (!ta.value) return;
      ta.select();
      navigator.clipboard.writeText(ta.value).catch(()=>{});
    });
    node.querySelectorAll('.session-controls button[data-verb]').forEach(btn => {
      btn.addEventListener('click', () => sendSessionVerb(fp, { type: btn.dataset.verb }));
    });
    node.querySelector('.session-picker').addEventListener('change', e => {
      if (e.target.value === '') return;
      const idx = parseInt(e.target.value, 10);
      if (Number.isInteger(idx)) sendSessionVerb(fp, { type: 'set-sequence', index: idx });
      e.target.value = '';
    });
    const attachBtn = node.querySelector('.session-attach');
    attachBtn.addEventListener('click', async () => {
      attachBtn.disabled = true;
      try {
        await window.zoetropeTransfer.pickAndSend('/api/sessions/' + fp + '/transfer');
      } catch (err) {
        console.warn('attach failed:', err);
        alert('Send failed: ' + err.message);
      } finally {
        attachBtn.disabled = false;
      }
    });
  }

  // ---- Generate / Stop ------------------------------------------------

  async function generateConnectionString(triggerEl, errEl) {
    const originalText = triggerEl.textContent;
    triggerEl.disabled = true;
    triggerEl.textContent = 'Detecting public IP…';
    if (errEl) errEl.textContent = '';
    try {
      const { url, session } = await networkQuickstart();
      addSessionToList(session, url);
      flashGeneratedBanner();
    } catch (err) {
      const msg = err.message || String(err);
      if (errEl) errEl.textContent = msg;
      else alert('Generate connection string failed: ' + msg);
    } finally {
      triggerEl.disabled = false;
      triggerEl.textContent = originalText;
    }
  }

  document.getElementById('btn-start').addEventListener('click', e => {
    generateConnectionString(e.currentTarget, document.getElementById('start-error'));
  });
  document.getElementById('btn-new-session').addEventListener('click', e => {
    generateConnectionString(e.currentTarget, null);
  });
  document.getElementById('btn-enter-mi').addEventListener('click', () => {
    if (state.nmode !== 'manager') return; // disabled gates this; defense in depth
    setView('mi');
  });
  document.getElementById('btn-show-gcs').addEventListener('click', () => {
    setView('landing');
  });
  document.getElementById('btn-show-info').addEventListener('click', e => {
    const on = !document.body.classList.contains('show-info');
    document.body.classList.toggle('show-info', on);
    e.currentTarget.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  document.getElementById('btn-stop-hosting').addEventListener('click', () => {
    confirmAction(
      'Stop hosting? Any connected clients will be disconnected.',
      () => { networkStandalone(); },
    );
  });

  // ---- Confirm overlay -----------------------------------------------

  let pendingConfirm = null;
  function confirmAction(message, onConfirm) {
    pendingConfirm = onConfirm;
    document.querySelector('#confirm-overlay .confirm-message').textContent = message;
    document.getElementById('confirm-overlay').hidden = false;
  }
  document.getElementById('confirm-cancel').addEventListener('click', () => {
    pendingConfirm = null;
    document.getElementById('confirm-overlay').hidden = true;
  });
  document.getElementById('confirm-ok').addEventListener('click', () => {
    const fn = pendingConfirm;
    pendingConfirm = null;
    document.getElementById('confirm-overlay').hidden = true;
    if (fn) fn();
  });

  // ---- Copy buttons (identity panel) ---------------------------------

  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.copy);
      if (!target) return;
      navigator.clipboard.writeText(target.textContent).catch(()=>{});
      const old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = old; }, 1200);
    });
  });

  // ---- SSE subscriber -----------------------------------------------

  function startEventSource() {
    const es = new EventSource('/api/session/events');
    es.addEventListener('mode-change', e => {
      try { applyMode(JSON.parse(e.data)); } catch (err) { console.error(err); }
    });
    es.addEventListener('session-created', e => {
      try { addSessionToList(JSON.parse(e.data)); } catch (err) {}
    });
    es.addEventListener('session-connected', e => {
      try { updateSessionStatus(JSON.parse(e.data).fingerprint, 'connected'); } catch (err) {}
    });
    es.addEventListener('session-disconnected', e => {
      try { updateSessionStatus(JSON.parse(e.data).fingerprint, 'waiting'); } catch (err) {}
    });
    es.addEventListener('session-removed', e => {
      try { removeSessionFromList(JSON.parse(e.data).fingerprint); } catch (err) {}
    });
    es.addEventListener('session-hello', e => {
      try { const ev = JSON.parse(e.data); setSessionLabel(ev.fingerprint, ev.label); } catch (err) {}
    });
    es.addEventListener('session-sequences', e => {
      try { const ev = JSON.parse(e.data); populateSessionPicker(ev.fingerprint, ev.payload); } catch (err) {}
    });
    es.addEventListener('session-state', e => {
      try { const ev = JSON.parse(e.data); updateSessionDetail(ev.fingerprint, ev.payload); } catch (err) {}
    });
    es.addEventListener('file-received', e => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.direction !== 'from-session') return; // /manage only surfaces session→manager arrivals
        const entry = state.sessions.get(ev.source_fp);
        if (!entry) return;
        const host = entry.node.querySelector('.session-inbox');
        window.zoetropeTransfer.renderInboundNotification(host, ev);
      } catch (err) { console.error(err); }
    });
  }

  // ---- Heartbeat ------------------------------------------------------
  // Same 5 s cadence as the ball page. Keeps the binary alive in
  // standalone mode when only the manage tab is open.

  function heartbeat() {
    fetch('/heartbeat', { method: 'POST' }).catch(()=>{});
  }
  setInterval(heartbeat, 5000);

  // ---- Editor (shared module from editor.js) ------------------------

  window.zoetropeEditor.init(state, {
    // No animation engine on /manage — these hooks are no-ops. Saves
    // now propagate live to connected sessions (server-side broadcast
    // on configStore.Set), so no post-save warning is needed here.
    onEnterItem: () => {},
    onJump: () => {},
    onFieldReset: () => {},
    onFieldLoopToggle: () => {},
    onSaveCloseEditor: () => {},
    onConfirm: confirmAction,
  });

  // ---- Init -----------------------------------------------------------

  async function init() {
    try {
      const r = await fetch('/api/mode/state', { cache: 'no-store' });
      if (r.ok) applyMode(await r.json());
    } catch (err) {
      console.warn('initial mode load failed:', err);
    }
    // Load the practitioner's saved config so the editor has something to
    // show the moment Hosting mode lights up. Run in parallel with the
    // SSE bus startup; either order is safe.
    window.zoetropeEditor.loadConfig().catch(err => {
      console.warn('editor loadConfig failed:', err);
    });
    startEventSource();
    heartbeat();
  }
  init();
})();
