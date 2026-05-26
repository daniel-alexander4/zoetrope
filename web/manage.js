// manage.js: the /manage page — the hosting console. Lives between four
// in-page views (toggled by body class, no routing):
//   - view-landing: the entry card with two CTAs (Generate / Enter MI),
//     plus the sessions card surfacing minted URLs.
//   - view-admin: between-session work — Clients, Library, playlist
//     editor (also visible in session), Identity.
//   - view-session: during-call work — playlist editor, Audio, Files.
//   - view-client: per-client detail page (notes + sessions timeline).
// The single MI card grid hosts all cards; each carries data-views="..."
// so CSS filters which cards a given view shows (one DOM, one drag
// order — see styles.css for the filter rules). Client mode at the
// network level is meaningless here, so it redirects to the ball page.

(() => {
  'use strict';

  const state = {
    nmode: 'standalone',
    sessions: new Map(), // fp → { node, snap }
    view: 'landing',     // 'landing' | 'admin' | 'session' | 'client'
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
        flashSessionError(fp, verb.type + ' failed: ' + text);
      }
    } catch (err) {
      console.error('sendSessionVerb:', err);
      flashSessionError(fp, (verb && verb.type ? verb.type + ' failed: ' : 'verb failed: ') + (err.message || err));
    }
  }

  // flashSessionError shows a per-card inline error that auto-clears.
  // Replaces the silent console.warn so a misfire (verb during a
  // disconnect, server-side reject) is actually visible to the
  // practitioner.
  const SESSION_ERROR_TIMERS = new WeakMap();
  function flashSessionError(fp, message) {
    const entry = state.sessions.get(fp);
    if (!entry) return;
    const el = entry.node.querySelector('.session-error');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    const prev = SESSION_ERROR_TIMERS.get(el);
    if (prev) clearTimeout(prev);
    SESSION_ERROR_TIMERS.set(el, setTimeout(() => {
      el.hidden = true;
      el.textContent = '';
      SESSION_ERROR_TIMERS.delete(el);
    }, 4000));
  }

  // ---- Page state -----------------------------------------------------

  // setView toggles the in-page surface (Landing vs MI) by swapping body
  // classes. CSS does the show/hide; no DOM rebuild, no fetch. Idempotent —
  // calling it with the current view is a no-op. Leaving MI also clears
  // body.show-info so the identity card doesn't surprise the user on
  // their next MI visit.
  function setView(view) {
    state.view = view;
    document.body.classList.remove('view-landing', 'view-admin', 'view-session', 'view-client');
    document.body.classList.add('view-' + view);
    if (view !== 'admin') {
      // Show-info only makes sense in Admin (where Identity lives).
      document.body.classList.remove('show-info');
      const info = document.getElementById('btn-show-info');
      if (info) info.setAttribute('aria-pressed', 'false');
    }
    if (view !== 'client') {
      // Drop the per-view client cursor so re-entering Clients starts fresh.
      state.clientID = null;
    }
    const admin = document.getElementById('btn-show-admin');
    const session = document.getElementById('btn-show-session');
    if (admin) admin.setAttribute('aria-selected', view === 'admin' ? 'true' : 'false');
    if (session) session.setAttribute('aria-selected', view === 'session' ? 'true' : 'false');
    updateTopbarMintVisibility();
    // Card-visibility changed; recompute editor row-span so it covers
    // the cards currently visible in the new view.
    updateEditorSpan();
  }

  // Topbar mint button shows only inside the MI (Admin or Session view),
  // while hosting is engaged. Landing already has its own + Generate, so
  // showing it there would be redundant. Visibility flips on view changes
  // and on mode snapshots.
  function updateTopbarMintVisibility() {
    const btn = document.getElementById('topbar-mint-url');
    if (!btn) return;
    const hosting = state.nmode === 'manager';
    const inMI = state.view === 'admin' || state.view === 'session' || state.view === 'client';
    btn.hidden = !(hosting && inMI);
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
      const audioCard = document.getElementById('audio-card');
      if (audioCard) audioCard.hidden = false;
      const clientsCard = document.getElementById('clients-card');
      if (clientsCard) clientsCard.hidden = false;
      refreshClientsList();
      document.getElementById('practitioner-fp').dataset.full = snap.practitioner_fp || '';
      document.getElementById('practitioner-ep').textContent = snap.public_endpoint || '—';
      refreshIdentityDisplay();
      renderSessions(snap.sessions || []);
      // On first paint only, pick the view from session state: existing
      // sessions → Admin (the user is returning to a live setup; Admin
      // is the operational home, Session is one HUD click away); no
      // sessions → Landing (the user chose to start fresh). Subsequent
      // mode snapshots never auto-pivot — view changes are driven by
      // explicit clicks (Enter MI / ← Landing / Admin / Session) so
      // generating a URL from Landing doesn't yank the user away.
      if (!state.initialModeApplied) {
        setView((snap.sessions && snap.sessions.length) ? 'admin' : 'landing');
      }
    } else { // standalone
      library.hidden = true;
      editor.hidden = true;
      sessions.hidden = true;
      stopBtn.hidden = true;
      const audioCard = document.getElementById('audio-card');
      if (audioCard) audioCard.hidden = true;
      const clientsCard = document.getElementById('clients-card');
      if (clientsCard) clientsCard.hidden = true;
      // Leaving manager → hang up any in-flight call so we don't hold the
      // mic open or leak a live peer connection.
      if (window.zoetropeAudio && window.zoetropeAudio.getState().state !== 'idle') {
        window.zoetropeAudio.hangup();
      }
      state.sessions.clear();
      document.getElementById('sessions-list').innerHTML = '';
      document.getElementById('start-error').textContent = '';
      // Returning from manager → standalone always lands on Landing.
      setView('landing');
    }
    state.initialModeApplied = true;
    updateTopbarMintVisibility();
    // Card hidden states just changed; recompute the editor row-span so
    // it spans exactly the visible small siblings beside it.
    updateEditorSpan();
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

  let generatedBannerTimer = null;
  function flashGeneratedBanner() {
    const b = document.getElementById('generated-banner');
    b.textContent = 'Connection URL generated — copy it below and share with your client.';
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

  // resolveSessionLabel — single source of truth for "what to call this
  // session" on the card. Bound-to-a-client sessions get the client's name
  // (looked up against the cached state.clients list). Unbound sessions
  // fall back to a client-supplied hello label, or the fingerprint prefix.
  // Called from addSessionToList, setSessionLabel, and applyResolvedLabels
  // (which re-runs after refreshClientsList fetches fresh names).
  function resolveSessionLabel(snap) {
    if (snap.client_id) {
      const c = state.clients.find(c => c.id === snap.client_id);
      if (c && c.name) return c.name;
    }
    return snap.label || (snap.fingerprint || '').slice(0, 12);
  }
  function applyResolvedLabels() {
    for (const [, entry] of state.sessions) {
      entry.node.querySelector('.session-label').textContent = resolveSessionLabel(entry.snap);
    }
  }

  // Firewall-hint nudge: if a session URL has been minted for this long
  // without anyone connecting, the most likely cause is a local firewall
  // blocking inbound on 38130 (router-NAT a distant second). Halfway
  // through the URL's 10-minute lifetime so the hint still leaves time
  // to act on it. Compared against created_at so a page reload doesn't
  // restart the timer.
  const FIREWALL_HINT_MS = 5 * 60 * 1000;

  function armFirewallHint(entry) {
    if (entry.everConnected || entry.firewallTimer) return;
    if (entry.snap && entry.snap.connected) return;
    const created = entry.snap && entry.snap.created_at
      ? new Date(entry.snap.created_at).getTime()
      : Date.now();
    const elapsed = Date.now() - created;
    if (elapsed >= FIREWALL_HINT_MS) {
      showFirewallHint(entry);
      return;
    }
    entry.firewallTimer = setTimeout(() => {
      entry.firewallTimer = null;
      if (!entry.everConnected) showFirewallHint(entry);
    }, FIREWALL_HINT_MS - elapsed);
  }

  function clearFirewallHint(entry) {
    if (entry.firewallTimer) {
      clearTimeout(entry.firewallTimer);
      entry.firewallTimer = null;
    }
    const hint = entry.node.querySelector('.session-firewall-hint');
    if (hint) hint.hidden = true;
  }

  function showFirewallHint(entry) {
    const hint = entry.node.querySelector('.session-firewall-hint');
    if (hint) hint.hidden = false;
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
    node.querySelector('.session-label').textContent = resolveSessionLabel(snap);
    const statusEl = node.querySelector('.session-status');
    statusEl.textContent = snap.connected ? 'connected' : 'waiting';
    statusEl.dataset.status = snap.connected ? 'connected' : 'waiting';
    if (url) node.querySelector('.session-url').value = url;
    wireSessionNode(node, snap.fingerprint);
    wireFocusOnSessionNode(node, snap.fingerprint);
    list.appendChild(node);
    const entry = {
      node, snap,
      everConnected: !!snap.connected,
      firewallTimer: null,
      connectedAt: snap.connected ? performance.now() : null,
    };
    state.sessions.set(snap.fingerprint, entry);
    // Apply the disable-on-disconnect state for the freshly-rendered
    // controls so a waiting card shows its transport row grayed out.
    setSessionConnected(node, !!snap.connected);
    armFirewallHint(entry);
  }

  function removeSessionFromList(fp) {
    const entry = state.sessions.get(fp);
    if (!entry) return;
    clearFirewallHint(entry);
    entry.node.remove();
    state.sessions.delete(fp);
  }

  function updateSessionStatus(fp, status) {
    const entry = state.sessions.get(fp);
    if (!entry) return;
    const el = entry.node.querySelector('.session-status');
    el.textContent = status;
    el.dataset.status = status;
    // Keep entry.snap.connected synced so findLiveSessionForClient (in
    // the Files card) reflects connection changes without a full
    // /api/mode/state refetch.
    entry.snap.connected = (status === 'connected');
    setSessionConnected(entry.node, status === 'connected');
    updateFilesSendState();
    if (status === 'connected') {
      // First successful pair proves the route works; the firewall hint
      // is suppressed for this session for its remaining lifetime even
      // after a later disconnect (disconnect != firewall blocking).
      entry.everConnected = true;
      clearFirewallHint(entry);
    }
  }

  // setSessionConnected toggles the disabled state of every transport-style
  // control on a session card. When the client is disconnected, clicks
  // round-trip to the server and 400 because the WS isn't paired — the
  // practitioner can't tell anything happened. Disabling at the UI layer
  // is the honest signal that the controls aren't operative right now.
  function setSessionConnected(node, connected) {
    const controls = node.querySelectorAll(
      '.session-controls button[data-verb], .session-picker, .ctl-speed, .session-call, .session-attach'
    );
    for (const el of controls) {
      el.disabled = !connected;
    }
  }

  function setSessionLabel(fp, label) {
    const entry = state.sessions.get(fp);
    if (!entry || !label) return;
    // Stash the client-supplied hello label on the snapshot so a later
    // refreshClientsList that doesn't resolve a name still has this as
    // a better-than-fp-prefix fallback.
    entry.snap.label = label;
    entry.node.querySelector('.session-label').textContent = resolveSessionLabel(entry.snap);
  }

  function populateSessionPicker(fp, payload) {
    const entry = state.sessions.get(fp);
    if (!entry || !payload?.sequences) return;
    const sel = entry.node.querySelector('.session-picker');
    // Preserve the current selection across rebuilds so the "currently
    // playing" mark stays put when the sequences list re-arrives (e.g.,
    // on rejoin) with the same shape.
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

  function updateSessionDetail(fp, payload) {
    const entry = state.sessions.get(fp);
    if (!entry || !payload) return;
    const playing = payload.playing ? '▶' : '⏸';
    const idx = payload.item_idx ?? 0;
    const rep = payload.repeat_idx ?? 0;
    const pat = payload.pattern || '?';
    // Look up the item's repeat-total + percent through-the-cycle from
    // the manager's own config + the snapshot's `t`. Falls back to "rep N"
    // when config isn't loaded yet or item_idx is out of range.
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
    // Client-side safety pause: the practitioner needs to see this so
    // they understand their transport verbs are queued, not applied,
    // until the client resumes.
    if (payload.client_paused) {
      detail += ' · 🛑 client paused';
    }
    entry.node.querySelector('.session-detail').textContent = detail;
    setStepControlsMode(entry.node, pat === 'position-sequence');
    // Sync the Jump-to picker to the currently-playing item — single
    // source of truth for "what's playing" is the state event, so the
    // picker just reflects it.
    const picker = entry.node.querySelector('.session-picker');
    const wantValue = String(idx);
    if (picker && picker.value !== wantValue
        && Array.prototype.some.call(picker.options, o => o.value === wantValue)) {
      picker.value = wantValue;
    }
  }

  // setStepControlsMode swaps the back/advance buttons between playlist-
  // item level (continuous patterns) and position-step level (position-
  // sequence patterns). Same buttons, different labels + dispatched
  // verbs — the click handler in wireSessionNode reads dataset.verb at
  // click time so updating it here is enough.
  function setStepControlsMode(node, isSequence) {
    const back = node.querySelector('.ctl-back');
    const advance = node.querySelector('.ctl-advance');
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

  function wireSessionNode(node, fp) {
    node.querySelector('.session-remove').addEventListener('click', () => {
      confirmAction(
        'Remove this session? The connection URL becomes invalid and any connected client is disconnected.',
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
      // No reset-to-placeholder — the next state event will sync the
      // selection to whatever the client lands on. updateSessionDetail
      // is the SoT for "what's playing" in the picker.
    });
    // Speed slider: live tempo multiplier. Fires on 'change' (release),
    // not 'input' (drag), so we don't spam the WS with intermediate
    // values. Visual readout updates on 'input' for instant feedback.
    const speed = node.querySelector('.ctl-speed');
    const speedValue = node.querySelector('.ctl-speed-value');
    function renderSpeedValue() {
      const v = Number(speed.value);
      speedValue.textContent = (Number.isInteger(v) ? v : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')) + '×';
    }
    speed.addEventListener('input', renderSpeedValue);
    speed.addEventListener('change', () => {
      renderSpeedValue();
      const mul = Number(speed.value);
      if (Number.isFinite(mul) && mul > 0) {
        sendSessionVerb(fp, { type: 'set-speed', mul });
      }
    });
    renderSpeedValue();
    const inboxHost = node.querySelector('.session-inbox');
    const uploadURL = '/api/sessions/' + fp + '/transfer';
    async function sendFileForSession(file) {
      try {
        const res = await window.zoetropeTransfer.sendFile(uploadURL, file);
        if (res && res.transfer_id) {
          window.zoetropeTransfer.beginOutbound(inboxHost, {
            id: res.transfer_id,
            name: res.name || file.name,
            sizeBytes: res.size_bytes ?? file.size,
          });
        }
      } catch (err) {
        console.warn('send failed:', err);
        alert('Send failed: ' + err.message);
      }
    }
    const attachBtn = node.querySelector('.session-attach');
    attachBtn.addEventListener('click', async () => {
      attachBtn.disabled = true;
      try {
        const input = document.createElement('input');
        input.type = 'file';
        input.style.display = 'none';
        input.addEventListener('change', async () => {
          const file = input.files && input.files[0];
          input.remove();
          if (file) await sendFileForSession(file);
        }, { once: true });
        document.body.appendChild(input);
        input.click();
      } finally {
        attachBtn.disabled = false;
      }
    });
    window.zoetropeTransfer.attachDropTarget(node, sendFileForSession);
    const callBtn = node.querySelector('.session-call');
    callBtn.addEventListener('click', async () => {
      const audio = window.zoetropeAudio;
      if (!audio) return;
      const cur = audio.getState();
      if (cur.state !== 'idle') {
        alert('Already in a call (' + (cur.peerLabel || cur.peerFP || 'peer') + ').');
        return;
      }
      const entry = state.sessions.get(fp);
      const label = entry?.node.querySelector('.session-label').textContent || fp.slice(0, 12);
      try {
        await audio.startCall(fp, label);
        setView('session'); // Audio card lives in Session — flip the user there so they see status
      } catch (err) {
        console.warn('call failed:', err);
        alert('Call failed: ' + err.message);
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
      else alert('Generate connection URL failed: ' + msg);
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
  // Topbar mint: lets the practitioner mint another URL without leaving
  // their live-session context. URL is copied to the clipboard so it's
  // ready to paste into a chat/email — the new session is also tracked
  // via the same addSessionToList path and surfaces in Landing on next
  // visit.
  document.getElementById('topbar-mint-url').addEventListener('click', async e => {
    const btn = e.currentTarget;
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const { url, session } = await networkQuickstart();
      addSessionToList(session, url);
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
  document.getElementById('btn-enter-mi').addEventListener('click', async e => {
    if (state.nmode === 'manager') {
      setView('admin');
      return;
    }
    // Standalone → engage manager mode first, then pivot. Pre-set
    // initialModeApplied so applyMode's first-paint heuristic doesn't
    // overwrite our explicit setView('admin') with its session-count pick.
    const btn = e.currentTarget;
    const errEl = document.getElementById('start-error');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Engaging hosting…';
    errEl.textContent = '';
    state.initialModeApplied = true;
    try {
      const r = await csrfFetch('/api/mode/host', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!r.ok) throw new Error((await r.text()).trim() || 'host failed');
      setView('admin');
    } catch (err) {
      state.initialModeApplied = false;
      errEl.textContent = err.message || String(err);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
  document.getElementById('btn-show-gcs').addEventListener('click', () => {
    setView('landing');
  });
  document.getElementById('btn-show-admin').addEventListener('click', () => {
    setView('admin');
  });
  document.getElementById('btn-show-session').addEventListener('click', () => {
    setView('session');
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
  // Loopback (dev): engage manager mode with an in-process synthetic
  // client session, then surface the /?loopback URL the practitioner
  // pastes into a second tab to drive the client side. No public IP,
  // no cert pin, no port-forward — purely a development affordance.
  document.getElementById('btn-loopback').addEventListener('click', async e => {
    const btn = e.currentTarget;
    const errEl = document.getElementById('start-error');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Engaging…';
    errEl.textContent = '';
    state.initialModeApplied = true;
    try {
      const r = await csrfFetch('/api/mode/loopback', { method: 'POST' });
      if (!r.ok) throw new Error((await r.text()).trim() || 'loopback failed');
      const hint = document.getElementById('loopback-hint');
      const url = document.getElementById('loopback-url');
      const loopURL = window.location.origin + '/?loopback';
      url.textContent = loopURL;
      hint.hidden = false;
      setView('admin');
    } catch (err) {
      state.initialModeApplied = false;
      errEl.textContent = err.message || String(err);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
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
        addSessionToList(snap);
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
        // Start (or restart on rejoin) the per-card uptime counter so the
        // practitioner sees "connected for 8m 42s." Rejoin treats this as
        // a fresh counter — see the timer block below for the rationale.
        const entry = state.sessions.get(fp);
        if (entry) entry.connectedAt = performance.now();
        // BeginSession just migrated intake.md → SessionRecord.PreNotes.
        // If the prep card was showing that client's intake, the buffer
        // is now empty on disk — re-fetch so the textarea reflects that.
        if (entry && entry.snap && entry.snap.client_id && entry.snap.client_id === nextPrepClientID) {
          loadIntakeFor(nextPrepClientID);
        }
      } catch (err) {}
    });
    es.addEventListener('session-disconnected', e => {
      try {
        const ev = JSON.parse(e.data);
        const fp = ev.fingerprint;
        // Server tells us whether the peer closed cleanly ("left") or the
        // WS dropped ("dropped"). Fall back to "waiting" for older events
        // (or empty reason) so the pill never lands in an unknown state.
        const status = ev.reason === 'left' || ev.reason === 'dropped' ? ev.reason : 'waiting';
        updateSessionStatus(fp, status);
        dropMirrorSnapshot(fp);
        // Freeze the uptime display where it is; the timer's render loop
        // stops counting once connectedAt is null.
        const entry = state.sessions.get(fp);
        if (entry) entry.connectedAt = null;
      } catch (err) {}
    });
    es.addEventListener('session-removed', e => {
      try {
        const fp = JSON.parse(e.data).fingerprint;
        removeSessionFromList(fp);
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
        const entry = state.sessions.get(ev.source_fp);
        if (entry) {
          const host = entry.node.querySelector('.session-inbox');
          window.zoetropeTransfer.renderInboundNotification(host, ev);
        }
        // Refresh the Files card inbox when this is the client we're
        // currently viewing — keeps the list live without a manual refetch.
        if (ev.client_id && ev.client_id === filesInboxClientID) {
          refreshFilesInbox(ev.client_id);
        }
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
          const label = state.sessions.get(ev.fingerprint)?.snap?.label
            || state.sessions.get(ev.fingerprint)?.node.querySelector('.session-label').textContent
            || (ev.fingerprint || '').slice(0, 12);
          // On incoming offer to an idle practitioner, flip to MI so the
          // call surface is visible. Other verbs land in whatever view
          // the practitioner is already in. Audio surfaces live in
          // Session, so an incoming offer flips them there.
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
    document.getElementById('audio-idle-hint').hidden = !showIdle;
    document.getElementById('audio-idle-hint').textContent = (snap.state === 'outgoing-ringing')
      ? 'Calling ' + (snap.peerLabel || 'peer') + '…'
      : 'No active call. Use 📞 on a session card to start one.';
    document.getElementById('audio-incoming').hidden = !showIncoming;
    document.getElementById('audio-active').hidden = !showActive;
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
      renderFilesPicker();
      updateFilesSendState();
      renderNextPrepPicker();
      // Re-resolve session labels — newly-fetched client names may
      // promote fp-prefixes to "Alice" on cards rendered before the
      // fetch returned.
      applyResolvedLabels();
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

  function renderFilesPicker() {
    const sel = document.getElementById('files-client-picker');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = state.clients.length ? 'Pick a client…' : 'No clients yet';
    sel.appendChild(blank);
    for (const c of state.clients) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      sel.appendChild(opt);
    }
    if (prev && state.clients.some(c => c.id === prev)) sel.value = prev;
  }

  function findLiveSessionForClient(clientID) {
    for (const entry of state.sessions.values()) {
      const s = entry.snap;
      if (s && s.client_id === clientID && s.connected) return s.fingerprint;
    }
    return '';
  }

  function updateFilesSendState() {
    const sel = document.getElementById('files-client-picker');
    const input = document.getElementById('files-send-input');
    const btn = document.getElementById('files-send-btn');
    if (!sel || !input || !btn) return;
    const clientID = sel.value;
    if (!clientID) {
      btn.disabled = true;
      btn.title = 'Pick a client first';
      return;
    }
    if (!findLiveSessionForClient(clientID)) {
      btn.disabled = true;
      btn.title = 'No live session bound to this client';
      return;
    }
    const hasFile = input.files && input.files.length > 0;
    btn.disabled = !hasFile;
    btn.title = hasFile ? 'Send to active session' : 'Choose a file first';
  }

  async function refreshFilesInbox(clientID) {
    filesInboxClientID = clientID || null;
    const list = document.getElementById('files-inbox-list');
    const empty = document.getElementById('files-empty');
    if (!list || !empty) return;
    list.innerHTML = '';
    if (!clientID) {
      empty.hidden = false;
      empty.textContent = 'Pick a client to see received files.';
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
    const sel = document.getElementById('files-client-picker');
    const input = document.getElementById('files-send-input');
    const btn = document.getElementById('files-send-btn');
    const status = document.getElementById('files-send-status');
    const card = document.getElementById('files-card');
    if (!sel || !input || !btn || !status || !card) return;
    sel.addEventListener('change', () => refreshFilesInbox(sel.value));
    input.addEventListener('change', updateFilesSendState);
    async function sendFromFilesCard(file) {
      const clientID = sel.value;
      if (!clientID || !file) return;
      const fp = findLiveSessionForClient(clientID);
      if (!fp) {
        status.textContent = 'No live session bound to this client.';
        status.classList.add('error');
        return;
      }
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
    // First session that's both connected and has a snapshot.
    for (const [fp, snap] of state.mirrorSnapshots) {
      const entry = state.sessions.get(fp);
      if (!entry) continue;
      if (entry.node.querySelector('.session-status')?.dataset.status !== 'connected') continue;
      return { fp, snap };
    }
    return null;
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
    const hint = document.getElementById('mirror-hint');
    const target = pickMirrorTarget();

    if (!target) {
      c2d.fillStyle = '#000';
      c2d.fillRect(0, 0, w, h);
      hint.hidden = false;
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
      hint.hidden = false;
      hint.textContent = 'Connected, but playlist item out of range. Was the playlist edited?';
      status.textContent = 'live';
      status.dataset.state = 'connected';
      return;
    }

    hint.hidden = true;
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

  // ---- Focused session + keyboard shortcuts -------------------------
  //
  // Clicking inside a session card sets it as the keyboard-shortcut
  // target. Space toggles play/pause; ← / → step pattern or position
  // depending on the snapshot's pattern type. Bails when the user is
  // typing in an input/select/textarea so typing the session URL or a
  // text field doesn't move the ball.
  state.focusedSessionFP = null;
  function setFocusedSession(fp) {
    state.focusedSessionFP = fp;
    for (const [otherFp, entry] of state.sessions) {
      entry.node.classList.toggle('focused', otherFp === fp);
    }
  }
  function wireFocusOnSessionNode(node, fp) {
    node.addEventListener('mousedown', () => setFocusedSession(fp));
  }
  document.addEventListener('keydown', e => {
    if (!state.focusedSessionFP) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const fp = state.focusedSessionFP;
    const entry = state.sessions.get(fp);
    if (!entry || !entry.snap.connected) return;
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

  // ---- Session uptime timer -----------------------------------------
  //
  // One global setInterval at 1 Hz walks every session card and renders
  // elapsed time since the latest connect. Disconnects null out
  // connectedAt so the display freezes at the last value rather than
  // continuing to count.
  function formatUptime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
    const h = Math.floor(m / 60), rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  }
  setInterval(() => {
    const now = performance.now();
    for (const [, entry] of state.sessions) {
      const upEl = entry.node.querySelector('.session-uptime');
      if (!upEl) continue;
      if (entry.connectedAt) {
        upEl.textContent = formatUptime(now - entry.connectedAt);
        upEl.hidden = false;
      }
      // If disconnected, leave the last-rendered value in place (frozen).
      // Hide entirely only if we've never connected.
      else if (!upEl.textContent) {
        upEl.hidden = true;
      }
    }
  }, 1000);

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
    setupMICardDrag();
    wireFilesCard();
    setupMirror();
    startEventSource();
    heartbeat();
  }
  init();
})();
