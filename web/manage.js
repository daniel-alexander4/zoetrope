// manage.js: the /manage page — a single-purpose hosting console.
// Standalone state shows a prominent "Generate connection string" CTA.
// Manager state shows the identity panel + sessions list. Client mode
// is meaningless here, so it redirects to the ball page.

(() => {
  'use strict';

  const state = {
    nmode: 'standalone',
    sessions: new Map(), // fp → { node, snap }
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

    const startCard = document.getElementById('start-card');
    const identity = document.getElementById('identity-panel');
    const editor = document.getElementById('editor-section');
    const sessions = document.getElementById('sessions');
    const stopBtn = document.getElementById('btn-stop-hosting');

    if (mode === 'manager') {
      startCard.hidden = true;
      identity.hidden = false;
      editor.hidden = false;
      sessions.hidden = false;
      stopBtn.hidden = false;
      document.getElementById('practitioner-fp').textContent = snap.practitioner_fp || '—';
      document.getElementById('practitioner-ep').textContent = snap.public_endpoint || '—';
      renderSessions(snap.sessions || []);
    } else { // standalone
      startCard.hidden = false;
      identity.hidden = true;
      editor.hidden = true;
      sessions.hidden = true;
      stopBtn.hidden = true;
      state.sessions.clear();
      document.getElementById('sessions-list').innerHTML = '';
      document.getElementById('start-error').textContent = '';
    }
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
    // No animation engine on /manage — these hooks are no-ops.
    onEnterItem: () => {},
    onJump: () => {},
    onFieldReset: () => {},
    onFieldLoopToggle: () => {},
    // No drawer to close after save — the editor is in the page flow.
    onSaveCloseEditor: () => {},
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
