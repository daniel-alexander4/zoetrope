// manage.js: the /manage page — pills as the mode switcher, identity
// panel, sessions list. Shares the SSE bus + REST endpoints with the
// ball page; no shared JS — they're physically separate apps with
// distinct paradigms (canvas vs admin lists).

(() => {
  'use strict';

  const state = {
    nmode: 'standalone',
    sessions: new Map(), // fp → { node, snap }
  };

  // 'hosting' is the user-facing pill name; 'manager' is the system mode.
  const PILL_TO_MODE = { standalone: 'standalone', client: 'client', hosting: 'manager' };
  const MODE_TO_PILL = { standalone: 'standalone', client: 'client', manager: 'hosting' };

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

  // ---- Mode application + pill state ---------------------------------

  function applyMode(snap) {
    const mode = snap.mode || 'standalone';
    state.nmode = mode;
    document.body.classList.remove('nmode-standalone', 'nmode-client', 'nmode-manager');
    document.body.classList.add('nmode-' + mode);

    document.querySelectorAll('.mpill').forEach(p => {
      p.classList.toggle('active', PILL_TO_MODE[p.dataset.mode] === mode);
    });

    const identity = document.getElementById('identity-panel');
    const list = document.getElementById('sessions-list');
    const empty = document.getElementById('sessions-empty');
    const newBtn = document.getElementById('btn-new-session');

    if (mode === 'manager') {
      identity.hidden = false;
      document.getElementById('practitioner-fp').textContent = snap.practitioner_fp || '—';
      document.getElementById('practitioner-ep').textContent = snap.public_endpoint || '—';
      renderSessions(snap.sessions || []);
      newBtn.hidden = false;
      if (state.sessions.size === 0) {
        empty.innerHTML = 'No sessions yet. Click <strong>+ Generate connection string</strong> to mint one.';
        empty.style.display = '';
      } else {
        empty.style.display = 'none';
      }
    } else {
      identity.hidden = true;
      state.sessions.clear();
      list.innerHTML = '';
      newBtn.hidden = true;
      empty.style.display = '';
      if (mode === 'client') {
        empty.innerHTML = 'Currently connected as a client. Open <a href="/">Ball view</a> to see the animation.';
      } else {
        empty.innerHTML = 'Not hosting yet. Click <strong>Hosting</strong> above to detect your public IP and mint a connection string.';
      }
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
    document.getElementById('sessions-empty').style.display = 'none';
  }

  function removeSessionFromList(fp) {
    const entry = state.sessions.get(fp);
    if (!entry) return;
    entry.node.remove();
    state.sessions.delete(fp);
    if (state.sessions.size === 0 && state.nmode === 'manager') {
      const empty = document.getElementById('sessions-empty');
      empty.innerHTML = 'No sessions yet. Click <strong>+ Generate connection string</strong> to mint one.';
      empty.style.display = '';
    }
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

  // ---- Quickstart from the "+ Generate connection string" button -----

  async function generateConnectionString(triggerEl) {
    const originalText = triggerEl.textContent;
    triggerEl.disabled = true;
    triggerEl.textContent = 'Detecting public IP…';
    try {
      const { url, session } = await networkQuickstart();
      addSessionToList(session, url);
    } catch (err) {
      alert('Generate connection string failed: ' + (err.message || err));
    } finally {
      triggerEl.disabled = false;
      triggerEl.textContent = originalText;
    }
  }
  document.getElementById('btn-new-session').addEventListener('click', e => {
    generateConnectionString(e.currentTarget);
  });

  // ---- Pill clicks ---------------------------------------------------

  document.querySelectorAll('.mpill').forEach(p => {
    p.addEventListener('click', () => onPillClick(p));
  });

  function onPillClick(p) {
    const target = PILL_TO_MODE[p.dataset.mode];
    if (target === state.nmode) return;

    if (target === 'standalone') {
      if (state.nmode === 'manager') {
        confirmAction('Stop hosting? Any connected clients will be disconnected.', networkStandalone);
      } else {
        networkStandalone();
      }
      return;
    }
    if (target === 'client') {
      // Joining lives on the ball page (that's where the animation
      // renders). Hop to / with a #join hash so app.js pops the dialog.
      if (state.nmode === 'manager') {
        confirmAction('Stop hosting and switch to client mode?', () => {
          networkStandalone().then(() => { window.location.href = '/#join'; });
        });
      } else {
        window.location.href = '/#join';
      }
      return;
    }
    if (target === 'manager') {
      if (state.nmode === 'standalone') {
        generateConnectionString(p);
      } else if (state.nmode === 'client') {
        confirmAction('Leave the current session and start hosting?', () => {
          networkStandalone().then(() => generateConnectionString(p));
        });
      }
    }
  }

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
  // Same 5 s cadence as app.js. Keeps the binary alive in standalone
  // mode when only the manage tab is open.

  function heartbeat() {
    fetch('/heartbeat', { method: 'POST' }).catch(()=>{});
  }
  setInterval(heartbeat, 5000);

  // ---- Init -----------------------------------------------------------

  async function init() {
    try {
      const r = await fetch('/api/mode/state', { cache: 'no-store' });
      if (r.ok) applyMode(await r.json());
    } catch (err) {
      console.warn('initial mode load failed:', err);
    }
    startEventSource();
    heartbeat();
  }
  init();
})();
