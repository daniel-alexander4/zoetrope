// manage.js: the /manage page — the hosting console. Hosting auto-engages
// when this page loads in standalone mode (the page IS the hosting
// surface; no Landing CTA). The bottom HUD has, left-to-right:
//   - mode pills (Standalone / Client / Hosting) — same component as on
//     the ball page; clicking a non-active pill flips network mode and
//     usually navigates away from /manage (only Hosting stays here).
//   - view tabs (Loopback / Admin / Session) — select which hosting
//     view is active (body class, no routing):
//   - view-loopback: dev-only synthetic session. body.loopback-split is
//     on; /?loopback shows in a right-half iframe; the left half shows
//     the same cards as view-session so the dev can drive the playlist
//     against the iframe client.
//   - view-admin: between-session work — Sessions, Clients, Library,
//     playlist editor (also visible in session), Identity.
//   - view-session: during-call work — mirror, playlist editor, Audio,
//     Files.
//   - view-client: per-client detail page (notes + sessions timeline).
// Loopback and real-hosting are mutually exclusive at the server (the
// loopback path nulls the listener). Switching the Loopback tab in or
// out of any real-hosting tab routes through standalone first; a confirm
// fires when real sessions are connected so the practitioner doesn't
// drop a live client by accident. The single MI card grid hosts all
// cards; each carries data-views="..." so CSS filters which cards a
// given view shows. Client mode at the network level is meaningless
// here, so it redirects to the ball page.

(() => {
  'use strict';

  const state = {
    nmode: 'standalone',
    sessions: new Map(), // fp → { node, snap }
    view: 'admin',       // 'loopback' | 'admin' | 'session' | 'client'
    initialModeApplied: false,
    clientID: null,      // which client view-client is currently showing
    clients: [],         // cached summary list (refreshed on entering MI)
    notesTimer: null,    // autosave debounce for client-notes
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
      if (!r.ok) {
        const text = (await r.text()).trim() || ('HTTP ' + r.status);
        console.warn('verb', verb.type, r.status, text);
        showSessionBanner(verb.type + ' failed: ' + text, 'error');
      }
    } catch (err) {
      console.error('sendSessionVerb:', err);
      showSessionBanner((verb && verb.type ? verb.type + ' failed: ' : 'verb failed: ') + (err.message || err), 'error');
    }
  }

  // ---- Page state -----------------------------------------------------

  // setView toggles the active hosting view by swapping body classes.
  // CSS + per-card data-views filters do the show/hide; no DOM rebuild,
  // no fetch. Idempotent. Mode flips (loopback vs real) are owned by
  // the HUD tab handlers, which call setView after the server-side
  // mode change resolves.
  function setView(view) {
    state.view = view;
    document.body.classList.remove('view-loopback', 'view-admin', 'view-session', 'view-client');
    document.body.classList.add('view-' + view);
    if (view !== 'client') {
      state.clientID = null;
    }
    const loopback = document.getElementById('btn-show-loopback');
    const admin = document.getElementById('btn-show-admin');
    const session = document.getElementById('btn-show-session');
    if (loopback) loopback.setAttribute('aria-selected', view === 'loopback' ? 'true' : 'false');
    if (admin) admin.setAttribute('aria-selected', view === 'admin' ? 'true' : 'false');
    if (session) session.setAttribute('aria-selected', view === 'session' ? 'true' : 'false');
    updateMintButtonVisibility();
    updateModePills();
    updateEditorSpan();
  }

  // HUD mint button is visible whenever hosting (real or loopback) is
  // engaged. The click handler is context-aware: on view-loopback it
  // copies the /?loopback URL (the iframe's URL); on real-hosting views
  // it mints a fresh connection URL.
  function updateMintButtonVisibility() {
    const btn = document.getElementById('hud-mint-url');
    if (!btn) return;
    btn.hidden = state.nmode !== 'manager';
  }

  // Mode pills mirror the network mode; on /manage the Hosting pill is
  // the only one that's "you're already here" — the other two require
  // tearing hosting down before navigating away.
  const PILL_TO_MODE = { standalone: 'standalone', client: 'client', hosting: 'manager' };
  function updateModePills() {
    document.querySelectorAll('#mi-hud .mpill').forEach(p => {
      p.classList.toggle('active', PILL_TO_MODE[p.dataset.mode] === state.nmode);
    });
  }

  // isLoopbackEngaged peeks at sessions to detect the synthetic dev
  // session by its well-known fingerprint. Used by tab handlers to
  // decide whether a mode flip is required.
  function isLoopbackEngaged() {
    return state.sessions.has('loopback');
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
    // /manage IS the hosting surface. Once init() has settled and the
    // user explicitly stops hosting, there's nothing to show here —
    // redirect to the ball page. Two gates: initialModeApplied stops
    // the redirect during the pre-engage window of init(); flipping
    // stops it during a deliberate tab-driven mode swap that passes
    // through standalone on its way to the target mode.
    if (mode === 'standalone' && state.initialModeApplied && !state.flipping) {
      window.location.href = '/';
      return;
    }

    const library = document.getElementById('library-card');
    const editor = document.getElementById('editor-section');

    if (mode === 'manager') {
      library.hidden = false;
      editor.hidden = false;
      const audioCard = document.getElementById('audio-card');
      if (audioCard) audioCard.hidden = false;
      const filesCard = document.getElementById('files-card');
      if (filesCard) filesCard.hidden = false;
      const mirrorCard = document.getElementById('mirror-card');
      if (mirrorCard) mirrorCard.hidden = false;
      const clientsCard = document.getElementById('clients-card');
      if (clientsCard) clientsCard.hidden = false;
      refreshClientsList();
      document.getElementById('practitioner-fp').dataset.full = snap.practitioner_fp || '';
      document.getElementById('practitioner-ep').textContent = snap.public_endpoint || '—';
      refreshIdentityDisplay();
      loadSessions(snap.sessions || []);
      // First paint: settle on a default view that reflects current state.
      // Loopback session present → view-loopback (the iframe is already
      // engaged server-side; mirror that in the UI). Otherwise → Admin.
      // Subsequent mode snapshots never auto-pivot — view changes are
      // driven by explicit HUD tab clicks.
      if (!state.initialModeApplied) {
        setView(isLoopbackEngaged() ? 'loopback' : 'admin');
        if (isLoopbackEngaged()) showLoopbackIframe();
      }
    } else { // standalone
      library.hidden = true;
      editor.hidden = true;
      const audioCard = document.getElementById('audio-card');
      if (audioCard) audioCard.hidden = true;
      const filesCard = document.getElementById('files-card');
      if (filesCard) filesCard.hidden = true;
      const mirrorCard = document.getElementById('mirror-card');
      if (mirrorCard) mirrorCard.hidden = true;
      const clientsCard = document.getElementById('clients-card');
      if (clientsCard) clientsCard.hidden = true;
      if (window.zoetropeAudio && window.zoetropeAudio.getState().state !== 'idle') {
        window.zoetropeAudio.hangup();
      }
      state.sessions.clear();
      document.getElementById('start-error').textContent = '';
      hideLoopbackIframe();
    }
    state.initialModeApplied = true;
    updateMintButtonVisibility();
    updateModePills();
    renderSessionView();
    updateEditorSpan();
  }

  function showLoopbackIframe() {
    document.body.classList.add('loopback-split');
    const frame = document.getElementById('loopback-iframe');
    if (frame) {
      const url = window.location.origin + '/?loopback';
      if (frame.src !== url) frame.src = url;
      frame.hidden = false;
    }
  }

  function hideLoopbackIframe() {
    document.body.classList.remove('loopback-split');
    const frame = document.getElementById('loopback-iframe');
    if (frame) { frame.src = ''; frame.hidden = true; }
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

  // ---- "Connection URL generated" banner ------------------------------
  // The HUD mint button writes directly into #generated-banner with its
  // own message; this timer coordinates the auto-hide so a rapid
  // double-click doesn't leave a stale banner behind.

  let generatedBannerTimer = null;

  // ---- Sessions (state only) ----------------------------------------
  //
  // state.sessions is a Map<fp, { snap, url, firewallTimer }> — no DOM.
  // The Session view has ONE set of controls (#session-controls,
  // #audio-start-call, etc.) that target activeSessionFP(). Single-
  // client product: first connected real session wins; loopback is the
  // fallback when no real session is connected.

  function activeSessionFP() {
    for (const [fp, entry] of state.sessions) {
      if (fp === 'loopback') continue;
      if (entry.snap.connected) return fp;
    }
    const lb = state.sessions.get('loopback');
    return lb && lb.snap.connected ? 'loopback' : null;
  }

  function loadSessions(sessions) {
    for (const [, entry] of state.sessions) {
      if (entry.firewallTimer) clearTimeout(entry.firewallTimer);
    }
    state.sessions.clear();
    for (const sess of sessions || []) addSession(sess);
    renderSessionView();
  }

  // resolveSessionLabel — single source of truth for "what to call this
  // session" in banners / call dialogs. Bound-to-a-client sessions get
  // the client's name; unbound sessions fall back to the client-
  // supplied hello label, or the fingerprint prefix.
  function resolveSessionLabel(snap) {
    if (snap.client_id) {
      const c = state.clients.find(c => c.id === snap.client_id);
      if (c && c.name) return c.name;
    }
    return snap.label || (snap.fingerprint || '').slice(0, 12);
  }

  function addSession(snap, url) {
    const existing = state.sessions.get(snap.fingerprint);
    if (existing) {
      if (url) existing.url = url;
      existing.snap = snap;
      renderSessionView();
      return;
    }
    const entry = { snap, url, firewallTimer: null };
    state.sessions.set(snap.fingerprint, entry);
    if (!snap.connected && snap.fingerprint !== 'loopback') {
      armFirewallHint(entry);
    }
    renderSessionView();
  }

  function removeSession(fp) {
    const entry = state.sessions.get(fp);
    if (!entry) return;
    if (entry.firewallTimer) clearTimeout(entry.firewallTimer);
    state.sessions.delete(fp);
    clearSessionBanner('firewall:' + fp);
    renderSessionView();
    updateFilesSendState();
  }

  function setSessionLabel(fp, label) {
    const entry = state.sessions.get(fp);
    if (!entry || !label) return;
    entry.snap.label = label;
  }

  function updateSessionStatus(fp, status) {
    const entry = state.sessions.get(fp);
    if (!entry) return;
    entry.snap.status = status;
    entry.snap.connected = (status === 'connected');
    if (entry.snap.connected) {
      if (entry.firewallTimer) {
        clearTimeout(entry.firewallTimer);
        entry.firewallTimer = null;
      }
      clearSessionBanner('firewall:' + fp);
    }
    renderSessionView();
    updateFilesSendState();
  }

  // ---- Firewall hint --------------------------------------------------
  //
  // If a minted URL stays unconnected for 5 minutes, the most likely
  // cause is the local firewall blocking inbound on 38130. Surface it
  // in the session banner so the practitioner sees a concrete next
  // step rather than waiting indefinitely. Cleared on connect or
  // session removal.
  const FIREWALL_HINT_MS = 5 * 60 * 1000;
  function armFirewallHint(entry) {
    const created = entry.snap.created_at
      ? new Date(entry.snap.created_at).getTime()
      : Date.now();
    const elapsed = Date.now() - created;
    const fire = () => {
      entry.firewallTimer = null;
      if (entry.snap.connected) return;
      showSessionBanner(
        '5 minutes since this URL was generated and no client has connected. ' +
        'Most often this means your local firewall (Windows Defender / macOS / ufw) ' +
        'is blocking inbound on port 38130. Less commonly: the router NAT isn\'t ' +
        'forwarding 38130 to this machine.',
        'warning',
        { persistent: true, key: 'firewall:' + entry.snap.fingerprint },
      );
    };
    if (elapsed >= FIREWALL_HINT_MS) fire();
    else entry.firewallTimer = setTimeout(fire, FIREWALL_HINT_MS - elapsed);
  }

  // ---- Session banner -------------------------------------------------
  //
  // Single non-blocking message strip at the top of Session view.
  // Transient (errors) auto-clear after 4s; persistent (firewall hint)
  // stays until clearSessionBanner(key) is called.
  const SESSION_BANNER_TRANSIENT_MS = 4000;
  let sessionBannerTimer = null;
  let sessionBannerKey = null;
  function showSessionBanner(message, kind, opts) {
    const el = document.getElementById('session-banner');
    if (!el) return;
    el.textContent = message;
    el.dataset.kind = kind || 'info';
    el.hidden = false;
    if (sessionBannerTimer) clearTimeout(sessionBannerTimer);
    sessionBannerKey = (opts && opts.key) || null;
    if (opts && opts.persistent) {
      sessionBannerTimer = null;
      return;
    }
    sessionBannerTimer = setTimeout(() => {
      el.hidden = true;
      el.textContent = '';
      sessionBannerKey = null;
      sessionBannerTimer = null;
    }, SESSION_BANNER_TRANSIENT_MS);
  }
  function clearSessionBanner(key) {
    if (key && sessionBannerKey !== key) return;
    if (sessionBannerTimer) { clearTimeout(sessionBannerTimer); sessionBannerTimer = null; }
    sessionBannerKey = null;
    const el = document.getElementById('session-banner');
    if (el) { el.hidden = true; el.textContent = ''; }
  }

  // ---- Session view: "are we live?" --------------------------------
  //
  // Single owner of the connected-vs-not predicate. Disables the
  // singleton play controls + Start-call when no real client is
  // connected, drives the topbar label, and refreshes the Files-card
  // inbox onto the active client when the active session flips.
  // Called on every session add/remove/status change.
  let lastActiveFP = null;
  function renderSessionView() {
    const fp = activeSessionFP();
    const controls = document.getElementById('session-controls');
    if (controls) {
      for (const el of controls.querySelectorAll('button, select, input')) {
        el.disabled = !fp;
      }
    }
    const startCall = document.getElementById('audio-start-call');
    if (startCall) startCall.disabled = !fp;
    const label = document.getElementById('page-label');
    if (label) {
      label.textContent = state.nmode === 'manager'
        ? (fp ? 'Hosting session' : 'Awaiting client')
        : '';
    }
    if (fp !== lastActiveFP) {
      lastActiveFP = fp;
      refreshFilesInbox(activeClientID());
    }
  }

  // ---- Session detail + picker (from session-state SSE) -------------
  //
  // Both write the singleton DOM elements and only render when fp ===
  // activeSessionFP(); a stray non-active session-state event for a
  // second client (shouldn't happen in single-client mode but is
  // possible during disconnect/reconnect overlap) is ignored.

  function updateSessionDetail(fp, payload) {
    const entry = state.sessions.get(fp);
    if (!entry || !payload) return;
    if (fp !== activeSessionFP()) return;
    const playing = payload.playing ? '▶' : '⏸';
    const idx = payload.item_idx ?? 0;
    const rep = payload.repeat_idx ?? 0;
    const pat = payload.pattern || '?';
    let repText = `rep ${rep + 1}`;
    const playlists = state.config?.playlists || [];
    const active = playlists.find(p => p.name === state.config?.activePlaylist) || playlists[0];
    const item = active?.items?.[idx];
    if (item && item.repeats) repText = `rep ${rep + 1}/${item.repeats}`;
    const pct = Math.round(((payload.t ?? 0) % 1) * 100);
    let detail = `${playing} item ${idx + 1}, ${repText} · ${pct}%, pattern ${pat}`;
    if (payload.step_count) {
      const step = (payload.step_idx ?? 0) + 1;
      detail += `, step ${step}/${payload.step_count}`;
    }
    if (payload.client_paused) detail += ' · 🛑 client paused';
    const el = document.getElementById('session-detail');
    if (el) el.textContent = detail;
    setStepControlsMode(pat === 'position-sequence');
    const picker = document.getElementById('session-picker');
    const wantValue = String(idx);
    if (picker && picker.value !== wantValue
        && Array.prototype.some.call(picker.options, o => o.value === wantValue)) {
      picker.value = wantValue;
    }
  }

  // setStepControlsMode swaps the back/advance buttons between playlist-
  // item level (continuous patterns) and position-step level (position-
  // sequence patterns). The click handler in wireSessionControls reads
  // dataset.verb at click time, so updating it here is enough.
  function setStepControlsMode(isSequence) {
    const container = document.getElementById('session-controls');
    if (!container) return;
    const back = container.querySelector('.ctl-back');
    const advance = container.querySelector('.ctl-advance');
    if (!back || !advance) return;
    if (isSequence) {
      back.textContent = '← Prev pos';
      back.title = 'Previous position';
      back.dataset.verb = 'back-position';
      advance.textContent = 'Next pos →';
      advance.title = 'Next position';
      advance.dataset.verb = 'advance-position';
    } else {
      back.textContent = '◀';
      back.title = 'Start of current sequence';
      back.dataset.verb = 'back';
      advance.textContent = '▶▶';
      advance.title = 'Next sequence';
      advance.dataset.verb = 'advance';
    }
  }

  function populateSessionPicker(fp, payload) {
    if (fp !== activeSessionFP()) return;
    if (!payload?.sequences) return;
    const sel = document.getElementById('session-picker');
    if (!sel) return;
    const previous = sel.value;
    sel.innerHTML = '<option value="">Jump to…</option>';
    for (const seq of payload.sequences) {
      const opt = document.createElement('option');
      opt.value = String(seq.index);
      opt.textContent = `${seq.index + 1}. ${seq.label}`;
      sel.appendChild(opt);
    }
    if (previous !== '' && Array.prototype.some.call(sel.options, o => o.value === previous)) {
      sel.value = previous;
    }
  }

  // ---- Singleton session-control wiring ------------------------------
  //
  // Run once at init(). Buttons route their verb to activeSessionFP().
  // When no active session, renderSessionView disables them all so
  // clicks are impossible.

  function wireSessionControls() {
    const container = document.getElementById('session-controls');
    if (container) {
      container.querySelectorAll('button[data-verb]').forEach(btn => {
        btn.addEventListener('click', () => {
          const fp = activeSessionFP();
          if (!fp) return;
          sendSessionVerb(fp, { type: btn.dataset.verb });
        });
      });
    }
    const picker = document.getElementById('session-picker');
    if (picker) {
      picker.addEventListener('change', e => {
        const fp = activeSessionFP();
        if (!fp || e.target.value === '') return;
        const idx = parseInt(e.target.value, 10);
        if (Number.isInteger(idx)) sendSessionVerb(fp, { type: 'set-sequence', index: idx });
      });
    }
    const speed = document.getElementById('session-speed');
    const speedValue = document.getElementById('session-speed-value');
    if (speed && speedValue) {
      function renderSpeedValue() {
        const v = Number(speed.value);
        speedValue.textContent = (Number.isInteger(v) ? v : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')) + '×';
      }
      speed.addEventListener('input', renderSpeedValue);
      speed.addEventListener('change', () => {
        renderSpeedValue();
        const fp = activeSessionFP();
        if (!fp) return;
        const mul = Number(speed.value);
        if (Number.isFinite(mul) && mul > 0) sendSessionVerb(fp, { type: 'set-speed', mul });
      });
      renderSpeedValue();
    }
    const startCall = document.getElementById('audio-start-call');
    if (startCall) {
      startCall.addEventListener('click', async () => {
        const audio = window.zoetropeAudio;
        if (!audio) return;
        const fp = activeSessionFP();
        if (!fp) return;
        if (audio.getState().state !== 'idle') {
          alert('Already in a call.');
          return;
        }
        const entry = state.sessions.get(fp);
        const label = entry ? resolveSessionLabel(entry.snap) : fp.slice(0, 12);
        try {
          await audio.startCall(fp, label);
        } catch (err) {
          console.warn('call failed:', err);
          alert('Call failed: ' + err.message);
        }
      });
    }
    // Keyboard shortcuts targeting the active session: Space toggles
    // play/pause; ← / → step pattern or position depending on the
    // current pattern. Bails when the user is typing in an
    // input/select/textarea so a text-field keystroke doesn't move the
    // ball.
    document.addEventListener('keydown', e => {
      const fp = activeSessionFP();
      if (!fp) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const snap = state.mirrorSnapshots.get(fp);
      const isSeq = snap?.pattern === 'position-sequence';
      let verb = null;
      if (e.code === 'Space') {
        verb = snap?.playing ? 'pause' : 'play';
      } else if (e.code === 'ArrowLeft') {
        verb = isSeq ? 'back-position' : 'back';
      } else if (e.code === 'ArrowRight') {
        verb = isSeq ? 'advance-position' : 'advance';
      }
      if (verb) {
        e.preventDefault();
        sendSessionVerb(fp, { type: verb });
      }
    });
  }

  // ---- Generate / Stop ------------------------------------------------

  // HUD mint button: always visible while hosting. Context-aware — on
  // view-loopback it copies the /?loopback URL (the iframe's URL — the
  // only "link" that makes sense in that context); on real-hosting
  // views it mints a fresh connection URL and copies that.
  document.getElementById('hud-mint-url').addEventListener('click', async e => {
    const btn = e.currentTarget;
    const originalText = btn.textContent;
    if (state.view === 'loopback') {
      const url = window.location.origin + '/?loopback';
      try { await navigator.clipboard.writeText(url); } catch (_) {}
      const b = document.getElementById('generated-banner');
      b.textContent = 'Loopback URL copied to your clipboard.';
      b.hidden = false;
      if (generatedBannerTimer) clearTimeout(generatedBannerTimer);
      generatedBannerTimer = setTimeout(() => { b.hidden = true; }, 6000);
      return;
    }
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const { url, session } = await networkQuickstart();
      addSession(session, url);
      try { await navigator.clipboard.writeText(url); } catch (_) {}
      const b = document.getElementById('generated-banner');
      b.textContent = 'Connection URL minted — copied to your clipboard.';
      b.hidden = false;
      if (generatedBannerTimer) clearTimeout(generatedBannerTimer);
      generatedBannerTimer = setTimeout(() => { b.hidden = true; }, 6000);
    } catch (err) {
      alert('Generate connection URL failed: ' + (err.message || String(err)));
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
  // HUD tabs: Loopback / Admin / Session. Loopback and the real-hosting
  // tabs map to different server modes (mutually exclusive at the
  // server). switchHostingTab handles the mode flip if needed and only
  // setView()s after the server responds.
  async function switchHostingTab(target) {
    // target ∈ {'loopback', 'admin', 'session'}
    const wantLoopback = target === 'loopback';
    const haveLoopback = isLoopbackEngaged();
    // Same mode — just a view change.
    if (state.nmode === 'manager' && wantLoopback === haveLoopback) {
      setView(target);
      if (wantLoopback) showLoopbackIframe(); else hideLoopbackIframe();
      return;
    }
    // Mode flip required. Real → loopback with connected sessions →
    // confirm (we'll drop the real listener and any in-flight clients).
    const realSessionCount = Array.from(state.sessions.keys())
      .filter(fp => fp !== 'loopback').length;
    if (wantLoopback && realSessionCount > 0) {
      confirmAction(
        'Switch to Loopback? Any connected clients will be disconnected.',
        () => { flipMode(target); },
      );
      return;
    }
    flipMode(target);
  }

  async function flipMode(target) {
    const wantLoopback = target === 'loopback';
    state.flipping = true;
    try {
      state.initialModeApplied = true;
      if (state.nmode === 'manager') {
        await networkStandalone();
      }
      if (wantLoopback) {
        const r = await csrfFetch('/api/mode/loopback', { method: 'POST' });
        if (!r.ok) throw new Error((await r.text()).trim() || 'loopback failed');
      } else {
        const r = await csrfFetch('/api/mode/host', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!r.ok) throw new Error((await r.text()).trim() || 'host failed');
      }
      setView(target);
      if (wantLoopback) showLoopbackIframe(); else hideLoopbackIframe();
    } catch (err) {
      const msg = err.message || String(err);
      document.getElementById('start-error').textContent = msg;
    } finally {
      state.flipping = false;
    }
  }

  // Mode pills: navigate away from /manage when the user picks
  // Standalone or Client. We tear hosting down first when any sessions
  // are connected so the practitioner doesn't drop a live client
  // without confirming. Hosting is the active mode here — clicking it
  // is a no-op (highlight stays put).
  document.querySelectorAll('#mi-hud .mpill').forEach(p => {
    p.addEventListener('click', () => onModePillClick(p));
  });
  function onModePillClick(p) {
    const target = PILL_TO_MODE[p.dataset.mode];
    if (target === state.nmode) return; // already in this mode
    const hasRealSessions = Array.from(state.sessions.keys())
      .filter(fp => fp !== 'loopback').length > 0;
    const leave = (after) => {
      state.initialModeApplied = true;
      networkStandalone().then(() => { window.location.href = after; });
    };
    if (target === 'standalone') {
      if (hasRealSessions) {
        confirmAction('Stop hosting? Any connected clients will be disconnected.', () => leave('/'));
      } else {
        leave('/');
      }
      return;
    }
    if (target === 'client') {
      if (hasRealSessions) {
        confirmAction('Stop hosting and join a session as a client?', () => leave('/#join'));
      } else {
        leave('/#join');
      }
    }
  }

  document.getElementById('btn-show-loopback').addEventListener('click', () => switchHostingTab('loopback'));
  document.getElementById('btn-show-admin').addEventListener('click', () => switchHostingTab('admin'));
  document.getElementById('btn-show-session').addEventListener('click', () => switchHostingTab('session'));

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

  // Modal a11y: focus trap, Escape-to-cancel, restore previous focus.
  if (window.installModalA11y) {
    window.installModalA11y(document.getElementById('confirm-overlay'), {
      cancelSelector: '#confirm-cancel',
      initialSelector: '#confirm-ok',
    });
  }

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
      try {
        const snap = JSON.parse(e.data);
        addSession(snap);
        // Default the prep card to the freshly-minted client so the
        // practitioner can start drafting intake immediately.
        if (snap && snap.client_id) {
          const sel = document.getElementById('next-prep-client');
          if (sel && sel.value !== snap.client_id && state.clients.some(c => c.id === snap.client_id)) {
            sel.value = snap.client_id;
            loadIntakeFor(snap.client_id);
          }
        }
      } catch (err) {}
    });
    es.addEventListener('session-connected', e => {
      try {
        const fp = JSON.parse(e.data).fingerprint;
        updateSessionStatus(fp, 'connected');
        // BeginSession just migrated intake.md → SessionRecord.PreNotes.
        // If the prep card was showing that client's intake, the buffer
        // is now empty on disk — re-fetch so the textarea reflects that.
        const entry = state.sessions.get(fp);
        if (entry && entry.snap.client_id && entry.snap.client_id === nextPrepClientID) {
          loadIntakeFor(nextPrepClientID);
        }
      } catch (err) {}
    });
    es.addEventListener('session-disconnected', e => {
      try {
        const ev = JSON.parse(e.data);
        const fp = ev.fingerprint;
        const status = ev.reason === 'left' || ev.reason === 'dropped' ? ev.reason : 'waiting';
        updateSessionStatus(fp, status);
        dropMirrorSnapshot(fp);
      } catch (err) {}
    });
    es.addEventListener('session-removed', e => {
      try {
        const fp = JSON.parse(e.data).fingerprint;
        removeSession(fp);
        dropMirrorSnapshot(fp);
      } catch (err) {}
    });
    es.addEventListener('session-hello', e => {
      try { const ev = JSON.parse(e.data); setSessionLabel(ev.fingerprint, ev.label); } catch (err) {}
    });
    es.addEventListener('session-sequences', e => {
      try { const ev = JSON.parse(e.data); populateSessionPicker(ev.fingerprint, ev.payload); } catch (err) {}
    });
    es.addEventListener('session-state', e => {
      try {
        const ev = JSON.parse(e.data);
        updateSessionDetail(ev.fingerprint, ev.payload);
        captureMirrorSnapshot(ev.fingerprint, ev.payload);
      } catch (err) {}
    });
    es.addEventListener('file-received', e => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.direction !== 'from-session') return; // /manage only surfaces session→manager arrivals
        // Refresh the Files card inbox when this is the client we're
        // currently viewing — keeps the list live without a manual refetch.
        if (ev.client_id && ev.client_id === filesInboxClientID) {
          refreshFilesInbox(ev.client_id);
        }
        // Auto-expand the Files card so an inbound transfer is visible
        // even when the practitioner has the card collapsed.
        const det = document.getElementById('files-details');
        if (det) det.open = true;
      } catch (err) { console.error(err); }
    });
    // Sender-side lifecycle: route through zoetropeTransfer so the
    // matching outbound progress card updates. Unknown ids are ignored
    // inside handleLifecycle.
    for (const kind of ['progress', 'accepted', 'completed', 'failed']) {
      es.addEventListener('transfer-' + kind, e => {
        try { window.zoetropeTransfer.handleLifecycle(kind, JSON.parse(e.data)); }
        catch (err) { console.error(err); }
      });
    }
    for (const verb of ['audio-offer', 'audio-answer', 'audio-ice', 'audio-bye']) {
      es.addEventListener('session-' + verb, e => {
        try {
          const ev = JSON.parse(e.data);
          const payload = ev.payload || {};
          const entry = state.sessions.get(ev.fingerprint);
          const label = entry ? resolveSessionLabel(entry.snap) : (ev.fingerprint || '').slice(0, 12);
          // On incoming offer to an idle practitioner, flip to Session
          // so the audio card is visible. Other verbs land in whatever
          // view the practitioner is already in.
          if (verb === 'audio-offer' && window.zoetropeAudio.getState().state === 'idle') {
            setView('session');
          }
          window.zoetropeAudio.handleSignal(payload, ev.fingerprint, label);
        } catch (err) { console.error(err); }
      });
    }
    // Session capture: client's consent answer + mid-recording revoke.
    es.addEventListener('session-capture-response', e => {
      try {
        const ev = JSON.parse(e.data);
        const payload = ev.payload || {};
        onCaptureResponse(!!payload.allowed);
      } catch (err) { console.error(err); }
    });
    es.addEventListener('session-capture-revoke', e => {
      try { onCaptureRevoke(); } catch (err) { console.error(err); }
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

  // ---- Audio (shared module from audio.js) --------------------------
  window.zoetropeAudio.init({
    sendVerb: (verb, peerFP) => {
      if (!peerFP) return; // manager always knows its target
      sendSessionVerb(peerFP, verb);
    },
    onStateChange: renderAudioCard,
  });

  function renderAudioCard(snap) {
    const card = document.getElementById('audio-card');
    if (!card) return;
    // Show the card whenever we're in manager mode; hide otherwise. The
    // card itself swaps its internal sections by state.
    card.hidden = (state.nmode !== 'manager');
    const pill = document.getElementById('audio-state-pill');
    pill.textContent = snap.state;
    pill.dataset.state = snap.state;
    const showIdle = (snap.state === 'idle' || snap.state === 'outgoing-ringing');
    const showIncoming = (snap.state === 'incoming-ringing');
    const showActive = (snap.state === 'connecting' || snap.state === 'connected');
    document.getElementById('audio-idle').hidden = !showIdle;
    document.getElementById('audio-idle-hint').textContent = (snap.state === 'outgoing-ringing')
      ? 'Calling ' + (snap.peerLabel || 'peer') + '…'
      : 'No active call.';
    document.getElementById('audio-incoming').hidden = !showIncoming;
    document.getElementById('audio-active').hidden = !showActive;
    // Auto-expand the collapsed audio card on any non-idle state
    // (incoming / outgoing ring, connecting, connected) so the
    // practitioner doesn't miss a ringing call. Leaves the user's
    // choice alone otherwise — we only set open=true on transition.
    const details = document.getElementById('audio-details');
    if (details && snap.state !== 'idle') details.open = true;
    if (showIncoming) {
      document.getElementById('audio-incoming-label').textContent = snap.peerLabel || 'unknown peer';
    }
    if (showActive) {
      document.getElementById('audio-active-label').textContent = snap.peerLabel || 'peer';
      document.getElementById('audio-mic-mute').textContent = snap.micMuted ? '🎤 Muted' : '🎤 Mute';
      document.getElementById('audio-mic-mute').classList.toggle('active', snap.micMuted);
      document.getElementById('audio-volume').value = Math.round(snap.speakerVolume * 100);
    }
    // Capture button enable state tracks audio connectivity; refresh it
    // whenever the call state changes, but only when we're not mid-flow.
    // Wrapped in try because this fires once at init before the capture
    // block below initializes — TDZ access on the const otherwise throws.
    try {
      if (capture.state === 'idle') setCaptureState('idle');
    } catch (_) { /* capture not yet initialized */ }
  }
  document.getElementById('audio-accept').addEventListener('click', () => window.zoetropeAudio.acceptCall());
  document.getElementById('audio-decline').addEventListener('click', () => window.zoetropeAudio.declineCall());
  document.getElementById('audio-hangup').addEventListener('click', () => window.zoetropeAudio.hangup());
  document.getElementById('audio-mic-mute').addEventListener('click', () => {
    const cur = window.zoetropeAudio.getState();
    window.zoetropeAudio.setMicMuted(!cur.micMuted);
  });
  document.getElementById('audio-volume').addEventListener('input', e => {
    window.zoetropeAudio.setSpeakerVolume((+e.target.value) / 100);
  });
  // Initial render so the card shows the idle hint as soon as manager mode lights up.
  renderAudioCard(window.zoetropeAudio.getState());

  // ---- Session audio capture (host side) ----------------------------
  //
  // Three-state flow on the host:
  //   idle       — call active, button reads "🔴 Record"
  //   pending    — capture-request sent, waiting on client consent
  //   recording  — client allowed; MediaRecorder is running; Stop+save
  //                shown; running timer in capture-status
  //
  // A capture-revoke from the client at any point during `recording`
  // stops MediaRecorder and DISCARDS the blob (no upload, no file
  // written) — the conservative privacy default.

  const capture = {
    state: 'idle',           // 'idle' | 'pending' | 'recording'
    recorder: null,
    sessionFP: null,         // which session we're recording (peerFP)
    clientID: null,          // resolved at record-start
    sessionID: null,         // log id, resolved at record-start
    startedAt: 0,
    revoked: false,
    timerInterval: null,
  };

  function setCaptureState(next) {
    capture.state = next;
    const startBtn = document.getElementById('capture-start');
    const stopBtn = document.getElementById('capture-stop');
    const status = document.getElementById('capture-status');
    if (!startBtn || !stopBtn || !status) return;
    startBtn.hidden = (next !== 'idle');
    stopBtn.hidden = (next !== 'recording');
    if (next === 'idle') {
      startBtn.disabled = !canStartCapture();
      startBtn.title = startBtn.disabled
        ? 'Record requires a connected call to a client-bound session'
        : 'Record this session — requires client consent';
      status.textContent = '';
      status.classList.remove('error');
    } else if (next === 'pending') {
      status.textContent = 'Awaiting client consent…';
      status.classList.remove('error');
    } else if (next === 'recording') {
      status.classList.remove('error');
      tickCaptureTimer();
    }
  }

  function canStartCapture() {
    const a = window.zoetropeAudio.getState();
    if (a.state !== 'connected') return false;
    if (!a.peerFP) return false;
    const entry = state.sessions.get(a.peerFP);
    if (!entry || !entry.snap || !entry.snap.client_id) return false;
    return true;
  }

  function tickCaptureTimer() {
    const status = document.getElementById('capture-status');
    if (!status) return;
    const tick = () => {
      const sec = Math.floor((Date.now() - capture.startedAt) / 1000);
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      status.textContent = '🔴 Recording ' + mm + ':' + ss;
    };
    tick();
    capture.timerInterval = setInterval(tick, 1000);
  }

  function clearCaptureTimer() {
    if (capture.timerInterval) {
      clearInterval(capture.timerInterval);
      capture.timerInterval = null;
    }
  }

  async function resolveSessionLogID(clientID, sessionFP) {
    // The active session log id is server-side state (begin/end). Today
    // there's no API to query it, so the simplest correct shape is to
    // pick the most-recent session for the client and trust BeginSession
    // already opened it on connect.
    const r = await fetch('/api/clients/' + encodeURIComponent(clientID), { cache: 'no-store' });
    if (!r.ok) throw new Error('client lookup failed: ' + r.status);
    const view = await r.json();
    const sessions = view.sessions || [];
    // Sessions are returned newest-first; the in-progress one has no
    // endedAt and a matching session-cert-fp.
    for (const s of sessions) {
      if (s.sessionCertFP === sessionFP && !s.endedAt) return s.id;
    }
    if (sessions.length > 0) return sessions[0].id;
    throw new Error('no session log entry for this client');
  }

  async function startCaptureFlow() {
    if (capture.state !== 'idle') return;
    if (!canStartCapture()) return;
    const a = window.zoetropeAudio.getState();
    const entry = state.sessions.get(a.peerFP);
    capture.sessionFP = a.peerFP;
    capture.clientID = entry.snap.client_id;
    capture.revoked = false;
    setCaptureState('pending');
    try {
      capture.sessionID = await resolveSessionLogID(capture.clientID, capture.sessionFP);
      await sendSessionVerb(capture.sessionFP, { type: 'capture-request' });
    } catch (err) {
      const status = document.getElementById('capture-status');
      status.classList.add('error');
      status.textContent = err.message || String(err);
      setCaptureState('idle');
    }
  }

  function onCaptureResponse(allowed) {
    if (capture.state !== 'pending') return;
    if (!allowed) {
      const status = document.getElementById('capture-status');
      status.classList.add('error');
      status.textContent = 'Client declined.';
      setTimeout(() => setCaptureState('idle'), 3000);
      return;
    }
    try {
      capture.recorder = window.zoetropeCapture.start();
    } catch (err) {
      const status = document.getElementById('capture-status');
      status.classList.add('error');
      status.textContent = err.message || String(err);
      setCaptureState('idle');
      return;
    }
    capture.startedAt = Date.now();
    setCaptureState('recording');
    sendSessionVerb(capture.sessionFP, { type: 'capture-state', recording: true });
  }

  function onCaptureRevoke() {
    if (capture.state !== 'recording' || !capture.recorder) return;
    capture.revoked = true;
    capture.recorder.stop().then(() => {
      // Conservative privacy default: discard the blob entirely on
      // revoke. No file is written; no server call is made.
      const status = document.getElementById('capture-status');
      status.classList.add('error');
      status.textContent = 'Stopped by client — recording discarded.';
      clearCaptureTimer();
      setTimeout(() => setCaptureState('idle'), 4000);
      sendSessionVerb(capture.sessionFP, { type: 'capture-state', recording: false });
    });
  }

  async function stopCaptureFlow() {
    if (capture.state !== 'recording' || !capture.recorder) return;
    const blob = await capture.recorder.stop();
    clearCaptureTimer();
    if (capture.revoked) return; // already handled in onCaptureRevoke
    const filename = window.zoetropeCapture.captureFilename();
    const url = '/api/clients/' + encodeURIComponent(capture.clientID)
      + '/sessions/' + encodeURIComponent(capture.sessionID) + '/capture';
    const status = document.getElementById('capture-status');
    status.textContent = 'Saving ' + filename + '…';
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'X-Zoetrope': '1',
          'X-Capture-Filename': encodeURIComponent(filename),
          'Content-Type': blob.type || 'audio/webm',
        },
        body: blob,
      });
      if (!r.ok) throw new Error((await r.text()).trim() || 'HTTP ' + r.status);
      status.textContent = 'Saved as ' + filename;
    } catch (err) {
      status.classList.add('error');
      status.textContent = 'Save failed: ' + err.message;
    }
    sendSessionVerb(capture.sessionFP, { type: 'capture-state', recording: false });
    setTimeout(() => setCaptureState('idle'), 4000);
  }

  document.getElementById('capture-start').addEventListener('click', startCaptureFlow);
  document.getElementById('capture-stop').addEventListener('click', stopCaptureFlow);
  setCaptureState('idle');

  // ---- Client manager (Clients card + view-client) ------------------

  async function refreshClientsList() {
    try {
      const r = await fetch('/api/clients', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      state.clients = await r.json();
      renderClientsList();
      updateFilesSendState();
      renderNextPrepPicker();
    } catch (err) {
      console.warn('clients list:', err);
    }
  }

  // ---- Next session prep card (Admin view) --------------------------
  //
  // One per-client buffer (server-side: <clientDir>/intake.md). The
  // picker defaults to the most-recent minted session's client_id, but
  // is overridable so you can prep for any client at any time. On
  // session-connected for a bound session the server consumes the file
  // and migrates it into the new SessionRecord's PreNotes — when that
  // happens we clear the textarea here so the practitioner doesn't see
  // stale text that's already been recorded.

  let nextPrepClientID = null;
  let nextPrepSaveTimer = null;

  function renderNextPrepPicker() {
    const sel = document.getElementById('next-prep-client');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    if (!state.clients.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No clients yet';
      sel.appendChild(opt);
      return;
    }
    for (const c of state.clients) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      sel.appendChild(opt);
    }
    // Pick default: prior selection if it's still in the list; else the
    // most-recently-minted bound session's client; else the first.
    let pick = '';
    if (prev && state.clients.some(c => c.id === prev)) pick = prev;
    if (!pick) {
      const fresh = [...state.sessions.values()]
        .map(e => e.snap)
        .filter(s => s && s.client_id && !s.connected)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      if (fresh) pick = fresh.client_id;
    }
    if (!pick) pick = state.clients[0].id;
    sel.value = pick;
    loadIntakeFor(pick);
  }

  async function loadIntakeFor(clientID) {
    nextPrepClientID = clientID || null;
    const ta = document.getElementById('next-prep-text');
    const status = document.getElementById('next-prep-status');
    if (!ta || !status) return;
    ta.value = '';
    status.textContent = '';
    if (!clientID) return;
    try {
      const r = await fetch('/api/clients/' + encodeURIComponent(clientID) + '/intake', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const body = await r.json();
      ta.value = body.text || '';
    } catch (err) {
      status.textContent = 'load failed: ' + err.message;
    }
  }

  function wireNextPrepCard() {
    const sel = document.getElementById('next-prep-client');
    const ta = document.getElementById('next-prep-text');
    const status = document.getElementById('next-prep-status');
    if (!sel || !ta || !status) return;
    sel.addEventListener('change', () => loadIntakeFor(sel.value));
    ta.addEventListener('input', () => {
      if (!nextPrepClientID) return;
      clearTimeout(nextPrepSaveTimer);
      nextPrepSaveTimer = setTimeout(async () => {
        status.textContent = 'saving…';
        try {
          const r = await csrfFetch(
            '/api/clients/' + encodeURIComponent(nextPrepClientID) + '/intake',
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: ta.value }),
            },
          );
          if (!r.ok) throw new Error((await r.text()).trim() || 'HTTP ' + r.status);
          status.textContent = 'saved';
          setTimeout(() => { status.textContent = ''; }, 1500);
        } catch (err) {
          status.textContent = 'save failed: ' + err.message;
        }
      }, 400);
    });
  }
  wireNextPrepCard();

  function renderClientsList() {
    const list = document.getElementById('clients-list');
    if (!list) return;
    list.innerHTML = '';
    if (!state.clients.length) {
      const li = document.createElement('li');
      li.className = 'client-empty';
      li.textContent = 'No clients yet — click "+ New".';
      list.appendChild(li);
      return;
    }
    for (const c of state.clients) {
      const li = document.createElement('li');
      li.className = 'client-row';
      const name = document.createElement('span');
      name.className = 'client-name';
      name.textContent = c.name;
      const count = document.createElement('span');
      count.className = 'client-count';
      count.textContent = c.sessionCount + ' session' + (c.sessionCount === 1 ? '' : 's');
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Open';
      open.addEventListener('click', () => openClientDetail(c.id));
      li.appendChild(name);
      li.appendChild(count);
      li.appendChild(open);
      list.appendChild(li);
    }
  }

  document.getElementById('btn-new-client').addEventListener('click', () => {
    const row = document.getElementById('new-client-row');
    row.hidden = false;
    const inp = document.getElementById('new-client-name');
    inp.value = '';
    inp.focus();
  });
  document.getElementById('btn-new-client-cancel').addEventListener('click', () => {
    document.getElementById('new-client-row').hidden = true;
  });
  document.getElementById('btn-new-client-ok').addEventListener('click', async () => {
    const name = document.getElementById('new-client-name').value.trim();
    if (!name) return;
    try {
      const r = await csrfFetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) throw new Error((await r.text()).trim() || 'HTTP ' + r.status);
      document.getElementById('new-client-row').hidden = true;
      await refreshClientsList();
    } catch (err) {
      alert('Create failed: ' + err.message);
    }
  });
  document.getElementById('new-client-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('btn-new-client-ok').click(); }
    else if (e.key === 'Escape') { e.preventDefault(); document.getElementById('btn-new-client-cancel').click(); }
  });

  async function openClientDetail(id) {
    try {
      const r = await fetch('/api/clients/' + encodeURIComponent(id), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const view = await r.json();
      state.clientID = id;
      setView('client');
      // The section ships with [hidden] so it doesn't flash before any
      // client is loaded — clear it now that we have data to render.
      document.getElementById('client-detail').hidden = false;
      document.getElementById('client-detail-name').textContent = view.name;
      document.getElementById('client-notes').value = view.notes || '';
      document.getElementById('client-generated-url').hidden = true;
      document.getElementById('client-generated-url').textContent = '';
      renderClientSessions(view.sessions || []);
    } catch (err) {
      alert('Open client failed: ' + err.message);
    }
  }

  function renderClientSessions(sessions) {
    const list = document.getElementById('client-sessions-list');
    list.innerHTML = '';
    if (!sessions.length) {
      const li = document.createElement('li');
      li.className = 'session-empty';
      li.textContent = 'No sessions yet.';
      list.appendChild(li);
      return;
    }
    for (const s of sessions) {
      list.appendChild(buildSessionRow(s));
    }
  }

  // buildSessionRow renders one session in the client timeline with an
  // expand chevron that reveals pre/post-notes textareas. Each textarea
  // autosaves on debounced input via PUT /api/clients/{cid}/sessions/{sid}/notes;
  // both fields ride one request so a single keystroke can't leave the
  // server out of sync. A "📝" marker appears on the summary line when
  // either field is non-empty so you can spot recorded notes at a glance.
  function buildSessionRow(s) {
    const li = document.createElement('li');
    li.className = 'session-row';
    const started = new Date(s.startedAt);
    const date = started.toLocaleDateString();
    const time = started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dur = s.durationSec > 0 ? formatDuration(s.durationSec) : (s.endedAt ? '0s' : 'in progress');
    const hasNotes = (s.preNotes && s.preNotes.length) || (s.postNotes && s.postNotes.length);

    const summary = document.createElement('div');
    summary.className = 'session-summary';
    const chevron = document.createElement('span');
    chevron.className = 'session-chevron';
    chevron.textContent = '▸';
    summary.appendChild(chevron);
    const label = document.createElement('span');
    label.className = 'session-label-text';
    label.textContent = `${date} ${time} · ${dur}` + (hasNotes ? ' · 📝' : '');
    summary.appendChild(label);
    li.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'session-row-body';
    body.hidden = true;
    body.innerHTML =
      '<label class="session-notes-label">Pre-session notes' +
      '<textarea class="session-pre-notes" rows="3" placeholder="Intake / prep…"></textarea></label>' +
      '<label class="session-notes-label">Post-session notes' +
      '<textarea class="session-post-notes" rows="3" placeholder="What surfaced…"></textarea></label>' +
      '<span class="session-notes-status"></span>';
    const preEl = body.querySelector('.session-pre-notes');
    const postEl = body.querySelector('.session-post-notes');
    const statusEl = body.querySelector('.session-notes-status');
    preEl.value = s.preNotes || '';
    postEl.value = s.postNotes || '';
    li.appendChild(body);

    summary.addEventListener('click', () => {
      const open = body.hidden;
      body.hidden = !open;
      chevron.textContent = open ? '▾' : '▸';
    });

    let saveTimer = null;
    const debounceSave = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        if (!state.clientID) return;
        statusEl.textContent = 'saving…';
        try {
          const r = await csrfFetch(
            '/api/clients/' + encodeURIComponent(state.clientID) +
              '/sessions/' + encodeURIComponent(s.id) + '/notes',
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ preNotes: preEl.value, postNotes: postEl.value }),
            },
          );
          if (!r.ok) throw new Error((await r.text()).trim() || 'HTTP ' + r.status);
          statusEl.textContent = 'saved';
          setTimeout(() => { statusEl.textContent = ''; }, 1500);
          const nowHas = preEl.value.length || postEl.value.length;
          label.textContent = `${date} ${time} · ${dur}` + (nowHas ? ' · 📝' : '');
        } catch (err) {
          statusEl.textContent = 'save failed: ' + err.message;
        }
      }, 400);
    };
    preEl.addEventListener('input', debounceSave);
    postEl.addEventListener('input', debounceSave);
    return li;
  }

  function formatDuration(sec) {
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return mm ? `${h}h ${mm}m` : `${h}h`;
  }

  // Notes autosave: 400ms debounce after the last keystroke. Saves the full
  // textarea content — the server overwrites notes.md atomically.
  document.getElementById('client-notes').addEventListener('input', () => {
    if (!state.clientID) return;
    clearTimeout(state.notesTimer);
    state.notesTimer = setTimeout(saveClientNotes, 400);
  });
  async function saveClientNotes() {
    if (!state.clientID) return;
    const notes = document.getElementById('client-notes').value;
    const status = document.getElementById('client-notes-status');
    try {
      const r = await csrfFetch('/api/clients/' + encodeURIComponent(state.clientID) + '/notes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes }),
      });
      if (status) {
        if (r && r.ok === false) {
          status.textContent = 'save failed (' + r.status + ') — notes not on disk';
        } else {
          status.textContent = 'saved';
          setTimeout(() => { if (status.textContent === 'saved') status.textContent = ''; }, 1500);
        }
      }
    } catch (err) {
      if (status) status.textContent = 'save failed: ' + (err && err.message ? err.message : 'network error');
    }
  }

  document.getElementById('btn-back-to-mi').addEventListener('click', async () => {
    // Flush any pending autosave before leaving.
    clearTimeout(state.notesTimer);
    if (state.clientID) await saveClientNotes();
    setView('admin'); // Clients card lives in Admin
    refreshClientsList();
  });

  document.getElementById('btn-client-generate').addEventListener('click', async () => {
    if (!state.clientID) return;
    const btn = document.getElementById('btn-client-generate');
    const out = document.getElementById('client-generated-url');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Generating…';
    out.hidden = true;
    try {
      const r = await csrfFetch('/api/sessions/quickstart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: state.clientID }),
      });
      if (!r.ok) throw new Error((await r.text()).trim() || 'HTTP ' + r.status);
      const data = await r.json();
      out.textContent = data.url;
      out.hidden = false;
      navigator.clipboard.writeText(data.url).catch(() => {});
    } catch (err) {
      out.textContent = 'Generate failed: ' + err.message;
      out.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  // ---- Files card (per-client send + persistent inbox) --------------

  let filesInboxClientID = null;

  // activeClientID resolves the active session's bound client_id, if any.
  // The files + audio cards target this implicitly — no picker.
  function activeClientID() {
    const fp = activeSessionFP();
    if (!fp) return null;
    return state.sessions.get(fp)?.snap?.client_id || null;
  }

  function updateFilesSendState() {
    const input = document.getElementById('files-send-input');
    const btn = document.getElementById('files-send-btn');
    if (!input || !btn) return;
    const fp = activeSessionFP();
    if (!fp) {
      btn.disabled = true;
      btn.title = 'No connected client';
      return;
    }
    const hasFile = input.files && input.files.length > 0;
    btn.disabled = !hasFile;
    btn.title = hasFile ? 'Send to the connected client' : 'Choose a file first';
  }

  async function refreshFilesInbox(clientID) {
    filesInboxClientID = clientID || null;
    const list = document.getElementById('files-inbox-list');
    const empty = document.getElementById('files-empty');
    if (!list || !empty) return;
    list.innerHTML = '';
    if (!clientID) {
      empty.hidden = false;
      empty.textContent = 'No connected client. The inbox shows what the active client has sent you.';
      updateFilesSendState();
      return;
    }
    try {
      const r = await fetch('/api/clients/' + encodeURIComponent(clientID) + '/inbox', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const entries = await r.json();
      if (!entries.length) {
        empty.hidden = false;
        empty.textContent = 'No files received from this client yet.';
      } else {
        empty.hidden = true;
        const tmpl = document.getElementById('files-inbox-template');
        for (const e of entries) {
          list.appendChild(buildFilesEntry(clientID, e, tmpl, list, empty));
        }
      }
    } catch (err) {
      console.warn('inbox list:', err);
      empty.hidden = false;
      empty.textContent = 'Failed to load inbox.';
    }
    updateFilesSendState();
  }

  function buildFilesEntry(clientID, e, tmpl, list, empty) {
    const node = tmpl.content.firstElementChild.cloneNode(true);
    node.dataset.eid = e.id;
    node.querySelector('.files-entry-name').textContent = e.name || '(untitled)';
    node.querySelector('.files-entry-detail').textContent =
      window.zoetropeTransfer.formatBytes(e.size_bytes) + ' · ' + new Date(e.received_at).toLocaleString();
    const open = node.querySelector('.files-open');
    open.href = '/api/clients/' + encodeURIComponent(clientID) + '/inbox/' + encodeURIComponent(e.id);
    open.download = e.name || '';
    node.querySelector('.files-dismiss').addEventListener('click', async () => {
      try {
        await csrfFetch('/api/clients/' + encodeURIComponent(clientID) + '/inbox/' + encodeURIComponent(e.id), { method: 'DELETE' });
        node.remove();
        if (!list.children.length) {
          empty.hidden = false;
          empty.textContent = 'No files received from this client yet.';
        }
      } catch (err) { console.error('dismiss:', err); }
    });
    return node;
  }

  function wireFilesCard() {
    const input = document.getElementById('files-send-input');
    const btn = document.getElementById('files-send-btn');
    const status = document.getElementById('files-send-status');
    const card = document.getElementById('files-card');
    if (!input || !btn || !status || !card) return;
    input.addEventListener('change', updateFilesSendState);
    async function sendFromFilesCard(file) {
      const fp = activeSessionFP();
      if (!fp || !file) return;
      status.classList.remove('error');
      status.textContent = '';
      btn.disabled = true;
      try {
        const res = await window.zoetropeTransfer.sendFile('/api/sessions/' + encodeURIComponent(fp) + '/transfer', file);
        if (res && res.transfer_id) {
          window.zoetropeTransfer.beginOutbound(card, {
            id: res.transfer_id,
            name: res.name || file.name,
            sizeBytes: res.size_bytes ?? file.size,
          });
        }
        input.value = '';
      } catch (err) {
        status.classList.add('error');
        status.textContent = err.message || String(err);
      } finally {
        updateFilesSendState();
      }
    }
    btn.addEventListener('click', () => {
      const file = input.files && input.files[0];
      if (file) sendFromFilesCard(file);
    });
    window.zoetropeTransfer.attachDropTarget(card, sendFromFilesCard);
  }

  // ---- MI card drag-to-reorder --------------------------------------
  //
  // Each MI card's <header> is the drag handle (cursor: grab in CSS).
  // Pattern mirrors the playlist-item drag-and-drop in editor.js: HTML5
  // DnD, mousedown sets draggable=true, dragover marks drop-above /
  // drop-below by cursor-relative position, drop reorders by
  // insertBefore. Order persists in localStorage so the practitioner's
  // layout sticks across reloads. The dragover/drop handlers gate on
  // an MI card being mid-drag so they don't fire on nested playlist-item
  // drags inside the editor card.
  const MI_CARD_ORDER_KEY = 'zoetrope.mi.cardOrder';

  function setupMICardDrag() {
    const grid = document.querySelector('.card-grid.mi-only');
    if (!grid) return;
    restoreMICardOrder(grid);
    for (const card of grid.querySelectorAll(':scope > .card')) {
      wireMICardDrag(card);
    }
    updateEditorSpan();
  }

  // updateEditorSpan makes the Active-playlist editor card claim as many
  // grid rows as there are visible small cards beside it, so the small
  // cards stack tightly in one column while the editor extends down the
  // other. Without this, the editor's natural height forces its single
  // grid row to be tall and any small card sharing the row gets a gap
  // below it.
  //
  // Visibility check uses `offsetParent`: a card is "visible" iff it's
  // not display:none — which catches both the JS-controlled `hidden`
  // attribute AND the CSS `[data-views]` filter that hides cards not
  // in the current view (admin vs session).
  //
  // Triggers: init (after restore + wire), after each drop reorders DOM,
  // after applyMode flips hidden states, and after setView switches the
  // view (different cards become visible).
  function updateEditorSpan() {
    const grid = document.querySelector('.card-grid.mi-only');
    const editor = document.getElementById('editor-section');
    if (!grid || !editor) return;
    if (editor.offsetParent === null) { editor.style.gridRow = ''; return; }
    let n = 0;
    for (const c of grid.children) {
      if (c === editor) continue;
      if (c.id === 'identity-panel') continue; // spans full row via its own rule
      if (c.offsetParent === null) continue;
      n++;
    }
    editor.style.gridRow = n > 0 ? 'span ' + n : '';
  }

  function wireMICardDrag(card) {
    const handle = card.querySelector(':scope > header');
    if (!handle) return;
    handle.addEventListener('mousedown', e => {
      // Don't start a drag if the user clicked an interactive control
      // (button, select, input, etc.) inside the header — they want to
      // operate the control, not relocate the card.
      if (e.target.closest('button, input, select, textarea, a')) return;
      card.draggable = true;
      document.addEventListener('mouseup', () => { card.draggable = false; }, { once: true });
    });
    card.addEventListener('dragstart', e => {
      if (e.target !== card) return; // only the card itself, not nested items
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      card.draggable = false;
      clearMICardDropIndicators();
    });
    card.addEventListener('dragover', e => {
      // Only react when an MI card is being dragged. Without this guard the
      // playlist-item drags inside the editor card bubble up and light up
      // the card's drop indicators.
      if (!document.querySelector('.card-grid.mi-only > .card.dragging')) return;
      if (card.classList.contains('dragging')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = card.getBoundingClientRect();
      const above = (e.clientY - rect.top) < rect.height / 2;
      clearMICardDropIndicators();
      card.classList.add(above ? 'drop-above' : 'drop-below');
    });
    card.addEventListener('dragleave', e => {
      if (!card.contains(e.relatedTarget)) {
        card.classList.remove('drop-above', 'drop-below');
      }
    });
    card.addEventListener('drop', e => {
      if (!document.querySelector('.card-grid.mi-only > .card.dragging')) return;
      e.preventDefault();
      const fromID = e.dataTransfer.getData('text/plain');
      if (!fromID || fromID === card.id) { clearMICardDropIndicators(); return; }
      const from = document.getElementById(fromID);
      if (!from || from.parentElement !== card.parentElement) {
        clearMICardDropIndicators();
        return;
      }
      const rect = card.getBoundingClientRect();
      const above = (e.clientY - rect.top) < rect.height / 2;
      const grid = card.parentElement;
      if (above) grid.insertBefore(from, card);
      else grid.insertBefore(from, card.nextSibling);
      clearMICardDropIndicators();
      saveMICardOrder(grid);
      updateEditorSpan();
    });
  }

  function clearMICardDropIndicators() {
    document.querySelectorAll('.card-grid.mi-only > .card.drop-above, .card-grid.mi-only > .card.drop-below')
      .forEach(el => el.classList.remove('drop-above', 'drop-below'));
  }

  function saveMICardOrder(grid) {
    const ids = [...grid.querySelectorAll(':scope > .card')].map(c => c.id).filter(Boolean);
    try {
      localStorage.setItem(MI_CARD_ORDER_KEY, JSON.stringify(ids));
    } catch (err) {
      console.warn('save MI card order:', err);
    }
  }

  function restoreMICardOrder(grid) {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(MI_CARD_ORDER_KEY) || '[]');
    } catch (err) {
      return;
    }
    if (!Array.isArray(saved)) return;
    // Re-append in saved order. Cards present in DOM but not in saved
    // (e.g., added in a later build) get left at the end in their HTML
    // source order. IDs in saved that no longer match a card are ignored.
    for (const id of saved) {
      const card = document.getElementById(id);
      if (card && card.parentElement === grid) {
        grid.appendChild(card);
      }
    }
  }

  // ---- Mirror card --------------------------------------------------
  //
  // Live preview of the client's ball, driven by `session-state` SSE
  // events plus local-rAF extrapolation between them. The shared pattern
  // engine in `web/patterns.js` does the actual math; the mirror just
  // supplies a ctx that points at the practitioner's config and the
  // current snapshot's repeatIdx, so the same `(t, item, vp, ctx)`
  // contract that drives the client renders the same shape here.
  //
  // For multi-session futures: today the mirror targets the first
  // connected session with a snapshot. A per-session focus picker is a
  // follow-on once real multi-session work surfaces it.
  const MIRROR_SIZE_KEY = 'zoetrope.mirror.size';
  state.mirrorSnapshots = new Map(); // fp → { pattern, item_idx, repeat_idx, t, playing, wallclock }

  function captureMirrorSnapshot(fp, payload) {
    if (!payload) return;
    state.mirrorSnapshots.set(fp, {
      pattern:    payload.pattern,
      item_idx:   payload.item_idx ?? 0,
      repeat_idx: payload.repeat_idx ?? 0,
      t:          payload.t ?? 0,
      playing:    !!payload.playing,
      wallclock:  performance.now(),
    });
  }
  function dropMirrorSnapshot(fp) {
    state.mirrorSnapshots.delete(fp);
  }

  function pickMirrorTarget() {
    // Active session — first connected real session, or loopback when
    // dev mode is the only thing engaged. Returns null if there's no
    // session to mirror.
    const fp = activeSessionFP();
    if (!fp) return null;
    const snap = state.mirrorSnapshots.get(fp);
    return snap ? { fp, snap } : null;
  }

  function mirrorTick() {
    requestAnimationFrame(mirrorTick);
    const card = document.getElementById('mirror-card');
    if (!card || card.offsetParent === null) return; // not in current view

    const canvas = document.getElementById('mirror-canvas');
    const stage = canvas.parentElement;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const c2d = canvas.getContext('2d');

    const status = document.getElementById('mirror-status');
    const target = pickMirrorTarget();

    if (!target) {
      c2d.fillStyle = '#000';
      c2d.fillRect(0, 0, w, h);
      status.textContent = 'idle';
      status.dataset.state = 'idle';
      return;
    }

    const playlists = state.config?.playlists || [];
    const active = playlists.find(p => p.name === state.config?.activePlaylist) || playlists[0];
    const items = active?.items || [];
    const item = items[target.snap.item_idx];
    const fn = item && window.zoetropePatterns.patterns[target.snap.pattern];
    if (!item || !fn) {
      c2d.fillStyle = state.config?.background || '#000';
      c2d.fillRect(0, 0, w, h);
      status.textContent = 'live';
      status.dataset.state = 'connected';
      return;
    }

    status.textContent = target.snap.playing ? 'live' : 'paused';
    status.dataset.state = target.snap.playing ? 'connected' : 'idle';

    // Ball proportional to the smaller mirror dimension so the trajectory
    // looks right at any card size — using the absolute config.ballSize
    // (sized for the full client viewport) would make the ball comically
    // large in a 300×200 thumbnail.
    const mirrorBallSize = Math.max(8, Math.min(w, h) * 0.08);
    const mirrorCtx = {
      config: { ...state.config, ballSize: mirrorBallSize },
      speedMul: 1,
      repeatIdx: target.snap.repeat_idx,
      bounceStart: { x: w / 2, y: h / 2 },
    };
    const cycleSec = window.zoetropePatterns.computeCycleSec(item, mirrorCtx);
    const elapsedSec = target.snap.playing
      ? (performance.now() - target.snap.wallclock) / 1000
      : 0;
    let t = target.snap.t ?? 0;
    if (target.snap.playing && isFinite(cycleSec) && cycleSec > 0) {
      t += elapsedSec / cycleSec;
      t = ((t % 1) + 1) % 1;
    }

    c2d.fillStyle = state.config?.background || '#000';
    c2d.fillRect(0, 0, w, h);

    const { x, y, sizeMul = 1 } = fn(t, item, { w, h }, mirrorCtx);
    c2d.beginPath();
    c2d.arc(x, y, Math.max(2, mirrorBallSize / 2 * sizeMul), 0, Math.PI * 2);
    c2d.fillStyle = item.color || '#fff';
    c2d.fill();
  }

  function setupMirror() {
    const card = document.getElementById('mirror-card');
    if (!card) return;
    // Restore the practitioner's last-set size.
    try {
      const saved = JSON.parse(localStorage.getItem(MIRROR_SIZE_KEY) || 'null');
      if (saved && saved.w && saved.h) {
        card.style.width = saved.w + 'px';
        card.style.height = saved.h + 'px';
      }
    } catch (err) { /* corrupted — keep default size */ }

    // Persist size after the user finishes resizing. ResizeObserver fires
    // on every pixel-change; debounce 500 ms so we don't hammer
    // localStorage during a drag.
    let saveTimer = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const rect = card.getBoundingClientRect();
        try {
          localStorage.setItem(MIRROR_SIZE_KEY, JSON.stringify({
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          }));
        } catch (err) { /* quota / disabled — silent */ }
      }, 500);
    });
    ro.observe(card);

    requestAnimationFrame(mirrorTick);
  }

  // ---- Init -----------------------------------------------------------

  async function init() {
    // Subscribe to SSE BEFORE the auto-engage POST below. The event bus
    // has no replay buffer (see bridge.go), so any mode-change published
    // by the host transition is lost if we subscribe after the POST
    // returns — leaving the page stuck on its initial standalone view
    // and the HUD mint button hidden.
    startEventSource();
    try {
      const r = await fetch('/api/mode/state', { cache: 'no-store' });
      if (r.ok) applyMode(await r.json());
    } catch (err) {
      console.warn('initial mode load failed:', err);
    }
    // /manage IS the hosting surface. If we're standalone, engage
    // hosting now so the user lands directly in the Admin tab instead
    // of an empty page. Errors surface via #start-error.
    if (state.nmode === 'standalone') {
      try {
        state.initialModeApplied = true;
        const r = await csrfFetch('/api/mode/host', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!r.ok) {
          state.initialModeApplied = false;
          const msg = (await r.text()).trim() || 'host failed';
          document.getElementById('start-error').textContent = msg;
        }
      } catch (err) {
        state.initialModeApplied = false;
        document.getElementById('start-error').textContent = err.message || String(err);
      }
    }
    // Load the practitioner's saved config so the editor has something to
    // show the moment Hosting mode lights up.
    window.zoetropeEditor.loadConfig().catch(err => {
      console.warn('editor loadConfig failed:', err);
    });
    setupMICardDrag();
    wireFilesCard();
    setupMirror();
    wireSessionControls();
    heartbeat();
  }
  init();
})();
