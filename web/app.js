(() => {
  'use strict';

  const TAU = Math.PI * 2;

  // PATTERN_LABELS lives on window.zoetropeEditor (shared with /manage).
  const PATTERN_LABELS = window.zoetropeEditor.PATTERN_LABELS;

  const state = {
    config: null,
    itemIdx: 0,
    repeatIdx: 0,
    t: 0,
    playing: false,
    speedMul: 1,
    lastFrameMs: 0,
    bounceStart: { x: 0, y: 0 },
    dirty: false,
    field: { t: 0, introT: 0, loopT: 0 },
    loopback: false, // /?loopback dev mode pins this tab to client view
    // Client-side safety pause: when true, dispatch ignores transport
    // verbs from the manager so the ball stays frozen until the client
    // explicitly resumes. managerPlayIntent tracks the manager's last
    // wish so Resume restores it.
    clientPaused: false,
    managerPlayIntent: true,
  };

  // ---- Field palettes ---------------------------------------------------
  // Each palette is a cyclic list of colors. The last entry MUST equal the
  // first so interpolation wraps seamlessly.
  const FIELD_PALETTES = {
    Happy: ['#fde68a', '#fb7185', '#f472b6', '#a78bfa', '#60a5fa', '#34d399', '#fde68a'],
    Calm:  ['#1e3a8a', '#3b82f6', '#06b6d4', '#10b981', '#a7f3d0', '#3b82f6', '#1e3a8a'],
    Neon:  ['#ff006e', '#fb5607', '#ffbe0b', '#8338ec', '#3a86ff', '#ff006e'],
    Fire:  ['#3b0a0a', '#991b1b', '#ea580c', '#f59e0b', '#fde047', '#fff7ed', '#3b0a0a'],
    Ocean: ['#0c4a6e', '#0369a1', '#0ea5e9', '#67e8f9', '#cffafe', '#0c4a6e'],
  };

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  const FIELD_PALETTES_RGB = Object.fromEntries(
    Object.entries(FIELD_PALETTES).map(([k, v]) => [k, v.map(hexToRgb)])
  );

  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function viewport() {
    return { w: window.innerWidth, h: window.innerHeight };
  }

  // ---- Patterns ---------------------------------------------------------
  // The pattern engine itself lives in web/patterns.js so the manager
  // mirror (web/manage.js) can call into the same kinematics with its
  // own canvas. Pull the bits this module needs into local names so the
  // animation loop below reads the same as before.
  const {
    patterns,
    GAZE_POSITIONS,
    POSITION_LABELS,
    positionToCanvas,
    isSequencePattern,
    computeCycleSec,
  } = window.zoetropePatterns;

  // ---- Animation --------------------------------------------------------

  function currentPlaylist() {
    const cfg = state.config;
    const playlists = cfg?.playlists || [];
    return playlists.find(p => p.name === cfg?.activePlaylist) || playlists[0];
  }

  function currentItem() {
    return currentPlaylist()?.items?.[state.itemIdx];
  }

  function enterItem(idx) {
    state.itemIdx = idx;
    state.repeatIdx = 0;
    state.t = 0;
    const vp = viewport();
    state.bounceStart = { x: vp.w / 2, y: vp.h / 2 };
  }

  function advance(dt) {
    const item = currentItem();
    if (!item) return;
    // Speed is on a 0-10 user scale. For continuous patterns it means cps
    // (10 = 1 cycle/sec). For position-sequence patterns it's a tempo
    // multiplier where speed=2 honors the configured dwell/transit, higher
    // = faster, lower = slower. Same gate either way: speed=0 → paused.
    const cycleSec = computeCycleSec(item, state);
    if (!isFinite(cycleSec)) return; // paused
    state.t += dt / cycleSec;
    while (state.t >= 1) {
      state.t -= 1;
      state.repeatIdx += 1;
      if (state.repeatIdx >= (item.repeats || 1)) {
        const next = (state.itemIdx + 1) % currentPlaylist().items.length;
        enterItem(next);
        return;
      }
    }
  }

  function render() {
    const vp = viewport();
    ctx.fillStyle = state.config?.background || '#000';
    ctx.fillRect(0, 0, vp.w, vp.h);

    const item = currentItem();
    if (!item) return;
    const fn = patterns[item.pattern];
    if (!fn) return;

    if (state.config.showPositionLabels && isSequencePattern(item.pattern)) {
      drawPositionLabels(vp);
    }

    const { x, y, sizeMul = 1 } = fn(state.t, item, vp, state);
    ctx.beginPath();
    ctx.arc(x, y, (state.config.ballSize || 80) / 2 * sizeMul, 0, TAU);
    ctx.fillStyle = item.color || '#fff';
    ctx.fill();
  }

  function drawPositionLabels(vp) {
    ctx.save();
    ctx.fillStyle = 'rgba(205, 214, 244, 0.45)'; // var(--text) at low alpha
    ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const name of Object.keys(GAZE_POSITIONS)) {
      const pos = positionToCanvas(name, vp);
      ctx.fillText(POSITION_LABELS[name], pos.x, pos.y);
    }
    ctx.restore();
  }

  // ---- Field (psychedelic) renderer -------------------------------------
  // Offscreen low-res canvas that we draw the field into, then upscale to
  // the main canvas. Resolution grows over the intro phase so it visibly
  // "resolves" from chunky blocks to a smooth HD gradient.
  const FIELD_RES_STAGES = [8, 16, 32, 64, 128, 320];
  const FIELD_INTRO_SEC = 1.0; // intro duration at normalized speed 1.0 (= speed 10)
  // Loop cycle: 0..LOOP_RES_END resolving, LOOP_RES_END..LOOP_HOLD_END HD hold,
  // LOOP_HOLD_END..1.0 de-resolving. Fractions are of one shapeDurationSec cycle.
  const LOOP_RES_END = 0.15;
  const LOOP_HOLD_END = 0.85;

  // Seeded PRNG so a given randomSeed always produces the same random shape.
  function mulberry32(seed) {
    let a = seed | 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let cachedShufflePal = null;
  let cachedShuffleKey = null;
  function resolvePalette() {
    const palName = state.config.field?.palette || 'Happy';
    const pal = FIELD_PALETTES_RGB[palName] || FIELD_PALETTES_RGB.Happy;
    if (!state.config.field?.shuffleColors) return pal;
    const seed = state.config.field?.randomSeed | 0;
    const key = palName + ':' + seed;
    if (cachedShuffleKey === key && cachedShufflePal) return cachedShufflePal;
    // Drop wrap duplicate, shuffle inner colors with a seed-derived stream,
    // then re-append the new first color so cyclic interpolation still wraps.
    const inner = pal.slice(0, -1);
    const rng = mulberry32((seed * 0x9E3779B1) | 0 || 1);
    for (let i = inner.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = inner[i]; inner[i] = inner[j]; inner[j] = tmp;
    }
    inner.push(inner[0]);
    cachedShufflePal = inner;
    cachedShuffleKey = key;
    return cachedShufflePal;
  }

  let cachedRandomSeed = null;
  let cachedRandomResolved = null;
  function resolveShape() {
    const shape = state.config.field?.shape || 'circles';
    if (shape !== 'random') return { shape, params: {} };
    const seed = state.config.field?.randomSeed | 0;
    if (cachedRandomSeed === seed && cachedRandomResolved) return cachedRandomResolved;
    // "Random" generates a novel pattern from the seed by sampling parameters
    // for a multi-term trig interference field — every seed yields a distinct
    // shape, not a re-selection of the geometric presets.
    const rng = mulberry32(seed || 1);
    cachedRandomResolved = {
      shape: 'random',
      params: {
        rotation: rng() * Math.PI,
        a: 2 + rng() * 6,        // x freq term 1
        b: 2 + rng() * 6,        // y freq term 1
        c: 2 + rng() * 6,        // x freq term 2
        d: 2 + rng() * 6,        // y freq term 2
        e: rng() * TAU,          // phase 1
        f: rng() * TAU,          // phase 2
        radialFreq: 0.5 + rng() * 2.5, // radial-quadratic term frequency
        scale: 0.6 + rng() * 1.4,      // overall canvas → pattern scale
      },
    };
    cachedRandomSeed = seed;
    return cachedRandomResolved;
  }
  let fieldCanvas = null;
  let fieldCtx = null;
  let fieldImageData = null;

  function ensureFieldOffscreen(w, h) {
    if (!fieldCanvas) {
      fieldCanvas = document.createElement('canvas');
      fieldCtx = fieldCanvas.getContext('2d');
    }
    if (fieldCanvas.width !== w || fieldCanvas.height !== h) {
      fieldCanvas.width = w;
      fieldCanvas.height = h;
      fieldImageData = fieldCtx.createImageData(w, h);
    }
  }

  function advanceField(dt) {
    const f = state.config.field || {};
    const speed = Math.max(0, f.speed ?? 3) / 10;
    state.field.t += dt * speed;

    if (f.loop) {
      const dur = Math.max(3, f.shapeDurationSec ?? 12);
      state.field.loopT = (state.field.loopT || 0) + dt / dur;
      while (state.field.loopT >= 1) {
        state.field.loopT -= 1;
        // New cycle — reroll the seed so random / shuffle vary.
        // (Fixed shapes like 'circles' simply re-resolve identically.)
        const usesSeed = f.shape === 'random' || f.shuffleColors;
        if (usesSeed) {
          state.config.field.randomSeed = (Math.random() * 0x7fffffff) | 0;
        }
      }
      const lt = state.field.loopT;
      if (lt < LOOP_RES_END) {
        state.field.introT = lt / LOOP_RES_END;
      } else if (lt < LOOP_HOLD_END) {
        state.field.introT = 1;
      } else {
        state.field.introT = 1 - (lt - LOOP_HOLD_END) / (1 - LOOP_HOLD_END);
      }
    } else if (state.field.introT < 1) {
      const introRate = Math.max(0.05, speed) / FIELD_INTRO_SEC;
      state.field.introT = Math.min(1, state.field.introT + dt * introRate);
    }
  }

  function renderField() {
    const vp = viewport();
    const stages = FIELD_RES_STAGES.length;
    const stageIdx = Math.min(stages - 1, Math.floor(state.field.introT * stages));
    const isHD = stageIdx === stages - 1;
    const resW = FIELD_RES_STAGES[stageIdx];
    const aspect = vp.h / vp.w;
    const resH = Math.max(2, Math.round(resW * aspect));
    ensureFieldOffscreen(resW, resH);

    const pal = resolvePalette();
    const palLast = pal.length - 1;

    const cx = (resW - 1) / 2;
    const cy = (resH - 1) / 2;
    const maxDist = Math.sqrt(cx * cx + cy * cy);
    const bands = 2.5; // visible color bands across the radius
    const invWavelength = bands / maxDist;
    const t = state.field.t;

    const { shape, params } = resolveShape();
    const rot = params.rotation || 0;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const arms = params.arms ?? 2;
    const tightness = params.tightness ?? 1;
    const points = params.points ?? 5;
    const sharpness = params.sharpness ?? 0.5;
    const spiralK = arms * tightness * maxDist / TAU;

    // Random (trig interference) precomputes.
    const rA = params.a ?? 3;
    const rB = params.b ?? 3;
    const rC = params.c ?? 3;
    const rD = params.d ?? 3;
    const rE = params.e ?? 0;
    const rF = params.f ?? 0;
    const rRadial = params.radialFreq ?? 1;
    const rScale = params.scale ?? 1;
    const rNormK = rScale * 4 / maxDist; // maps pixel coords to roughly [-2, +2]

    const data = fieldImageData.data;
    let p = 0;
    for (let y = 0; y < resH; y++) {
      const dy = y - cy;
      for (let x = 0; x < resW; x++) {
        const dx = x - cx;
        // Rotate the sample point so each shape can pick up an arbitrary
        // orientation (used by the random shape).
        const rx = rot ? cosR * dx + sinR * dy : dx;
        const ry = rot ? -sinR * dx + cosR * dy : dy;
        let metric;
        switch (shape) {
          case 'squares':  metric = Math.max(Math.abs(rx), Math.abs(ry)); break;
          case 'diamonds': metric = Math.abs(rx) + Math.abs(ry); break;
          case 'stripes':  metric = Math.abs(rx); break;
          case 'spiral': {
            const r = Math.sqrt(rx * rx + ry * ry);
            metric = r + Math.atan2(ry, rx) * spiralK;
            break;
          }
          case 'star': {
            const r = Math.sqrt(rx * rx + ry * ry);
            metric = r * (1 + sharpness * Math.cos(points * Math.atan2(ry, rx)));
            break;
          }
          case 'random': {
            const px = rx * rNormK;
            const py = ry * rNormK;
            const r2 = px * px + py * py;
            let m = Math.sin(rA * px + Math.cos(rB * py + rE))
                  + Math.cos(rC * px + Math.sin(rD * py + rF))
                  + Math.sin(rRadial * r2) * 0.6;
            // m is roughly in [-2.6, 2.6]; shift+scale to a maxDist-ish range
            metric = (m + 2.6) * maxDist / 10.4;
            break;
          }
          default: metric = Math.sqrt(rx * rx + ry * ry); // circles
        }
        let phase = t - metric * invWavelength;
        phase = phase - Math.floor(phase); // wrap to [0,1)
        const fIdx = phase * palLast;
        const i = fIdx | 0;
        const f = fIdx - i;
        const a = pal[i];
        const b = pal[i + 1];
        data[p++] = a[0] + (b[0] - a[0]) * f;
        data[p++] = a[1] + (b[1] - a[1]) * f;
        data[p++] = a[2] + (b[2] - a[2]) * f;
        data[p++] = 255;
      }
    }
    fieldCtx.putImageData(fieldImageData, 0, 0);

    ctx.imageSmoothingEnabled = isHD;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, vp.w, vp.h);
    ctx.drawImage(fieldCanvas, 0, 0, vp.w, vp.h);
  }

  function resetField() {
    state.field.t = 0;
    state.field.introT = 0;
    state.field.loopT = 0;
  }

  let lastHighlightIdx = -1;
  function frame(nowMs) {
    if (!state.lastFrameMs) state.lastFrameMs = nowMs;
    const dt = (nowMs - state.lastFrameMs) / 1000;
    state.lastFrameMs = nowMs;
    const mode = state.config?.mode || 'balls';
    if (mode === 'field') {
      if (state.playing) advanceField(dt);
      renderField();
    } else {
      if (state.playing) advance(dt);
      render();
      updateNowPlaying();
      if (state.itemIdx !== lastHighlightIdx) {
        updatePlayingHighlight();
        lastHighlightIdx = state.itemIdx;
      }
    }
    requestAnimationFrame(frame);
  }

  // ---- Transport --------------------------------------------------------

  function play() {
    state.playing = true;
    setPlayIcon('⏸');
  }
  function pause() {
    state.playing = false;
    setPlayIcon('▶');
  }
  function togglePlay() { state.playing ? pause() : play(); }
  function seekPlaylistStart() {
    state.lastFrameMs = 0;
    enterItem(0);
  }
  function seekPatternStart() {
    state.lastFrameMs = 0;
    state.t = 0;
    state.repeatIdx = 0;
    const vp = viewport();
    state.bounceStart = { x: vp.w / 2, y: vp.h / 2 };
  }
  function nextPattern() {
    state.lastFrameMs = 0;
    const len = currentPlaylist()?.items?.length || 1;
    enterItem((state.itemIdx + 1) % len);
  }
  function jumpToItem(i) {
    const items = currentPlaylist()?.items || [];
    if (i < 0 || i >= items.length) return;
    state.lastFrameMs = 0;
    enterItem(i);
  }

  // ---- Position-sequence step controls (IEMT manual override) ---------
  // The position-sequence engine derives the current step from
  // floor(state.t * steps.length). Snapping to a step boundary parks the
  // ball at that position's dwell — used by "hold" (pause + snap) and by
  // the step-level prev/next controls the manager UI sends as
  // advance-position / back-position verbs.

  function snapToCurrentStep() {
    const item = currentItem();
    if (!item || !isSequencePattern(item.pattern)) return;
    const total = (item.steps || []).length;
    if (total === 0) return;
    const idx = Math.floor(state.t * total) % total;
    state.t = idx / total;
    state.lastFrameMs = 0;
  }

  function stepByPositions(delta) {
    const item = currentItem();
    if (!item || !isSequencePattern(item.pattern)) return;
    const total = (item.steps || []).length;
    if (total === 0) return;
    const cur = Math.floor(state.t * total) % total;
    const next = ((cur + delta) % total + total) % total;
    state.t = next / total;
    state.lastFrameMs = 0;
  }

  function setPlayIcon(icon) {
    document.getElementById('btn-play').textContent = icon;
  }

  function updateNowPlaying() {
    const el = document.getElementById('now-playing');
    const item = currentItem();
    if (!item) { el.textContent = ''; return; }
    const total = currentPlaylist()?.items?.length || 0;
    el.textContent = `${state.itemIdx + 1}/${total} · ${item.pattern} · rep ${state.repeatIdx + 1}/${item.repeats}`;
  }

  function updatePlayingHighlight() {
    const lis = document.querySelectorAll('#playlist .item');
    lis.forEach((li, i) => li.classList.toggle('playing', i === state.itemIdx));
  }

  // ---- Dispatch ---------------------------------------------------------
  // Single entry point for transport actions. Local UI handlers and (when
  // present) inbound network verbs both route through here, so standalone
  // and client modes share one mutation path.

  function dispatch(verb) {
    // Track the manager's last play/pause intent before any client-pause
    // gating, so Resume on the client side restores what the manager
    // most-recently wanted instead of stale state. Navigation verbs
    // (advance/back/jump/reset) don't change play intent.
    switch (verb.type) {
      case 'play':
      case 'resume':
      case 'release':
        state.managerPlayIntent = true;
        break;
      case 'pause':
      case 'stop':
      case 'hold':
        state.managerPlayIntent = false;
        break;
      case 'toggle':
        state.managerPlayIntent = !state.managerPlayIntent;
        break;
    }
    // While the client has self-paused, drop all transport verbs so the
    // manager can't override the client's clinical "I need a moment."
    // Config / file / audio / capture verbs still apply — they aren't
    // transport, and the practitioner often needs voice during a pause.
    if (state.clientPaused) {
      switch (verb.type) {
        case 'play': case 'pause': case 'resume': case 'toggle':
        case 'advance': case 'back': case 'reset': case 'stop':
        case 'hold': case 'release':
        case 'advance-position': case 'back-position':
        case 'jump': case 'set-sequence':
        case 'set-speed':
          return; // queued in managerPlayIntent / dropped
      }
    }
    switch (verb.type) {
      case 'play':         play(); break;
      case 'pause':        pause(); break;
      case 'resume':       play(); break;
      case 'toggle':       togglePlay(); break;
      case 'advance':      nextPattern(); break;
      case 'back':         seekPatternStart(); break;
      case 'reset':        seekPlaylistStart(); break;
      case 'stop':         pause(); seekPlaylistStart(); break;
      case 'hold':            pause(); snapToCurrentStep(); break;
      case 'release':         play(); break;
      case 'advance-position': stepByPositions(+1); break;
      case 'back-position':    stepByPositions(-1); break;
      case 'jump':
      case 'set-sequence':
        if (Number.isInteger(verb.index)) jumpToItem(verb.index);
        break;
      case 'set-speed': {
        // Practitioner-dialed runtime tempo. Honors the same 0-4× shape
        // as the standalone speed-select; advance() multiplies into
        // userSpeed/2 so the cycle scales smoothly.
        const m = Number(verb.mul);
        if (Number.isFinite(m) && m > 0) state.speedMul = m;
        break;
      }
      case 'set-config':
        if (verb.config) applyPushedConfig(verb.config);
        break;
      case 'capture-request':
        showCaptureConsent();
        break;
      case 'capture-state':
        setRecPillVisible(!!verb.recording);
        break;
      default:
        console.warn('unknown verb:', verb);
    }
    // In client mode, push the resulting state back so the manager UI
    // reflects what the ball is actually doing.
    if (state.nmode === 'client') schedulePushClientState();
  }

  // Apply a config pushed by the manager on session-connect. Back up
  // the local config on first push so we can restore on session end;
  // delegate the editor-side re-render to the editor module.
  function applyPushedConfig(cfg) {
    if (state.sessionConfigBackup == null) {
      state.sessionConfigBackup = JSON.parse(JSON.stringify(state.config));
    }
    // maxTransferBytes is sticky on the receiver: the practitioner doesn't
    // dictate what files the client will accept. Preserve the local value
    // so the editor + Go-side caps stay in sync with config.json on disk.
    cfg.maxTransferBytes = state.config.maxTransferBytes;
    window.zoetropeEditor.applyConfig(cfg);
    enterItem(0);
  }

  // ---- Wiring -----------------------------------------------------------

  document.getElementById('btn-pl-start').addEventListener('click', () => dispatch({ type: 'reset' }));
  document.getElementById('btn-pat-start').addEventListener('click', () => dispatch({ type: 'back' }));
  document.getElementById('btn-play').addEventListener('click', () => dispatch({ type: 'toggle' }));
  document.getElementById('btn-next').addEventListener('click', () => dispatch({ type: 'advance' }));
  document.getElementById('speed').addEventListener('change', e => {
    state.speedMul = +e.target.value;
  });
  document.getElementById('btn-toggle-editor').addEventListener('click', () => {
    document.getElementById('editor').classList.toggle('hidden');
  });
  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen().catch(err => {
        console.error('fullscreen failed:', err);
      });
    }
  }

  // Auto-close the editor 1s after the mouse leaves it, but only if
  // there are no unsaved changes — never throw away pending edits.
  {
    const editor = document.getElementById('editor');
    let closeTimer = null;
    editor.addEventListener('mouseleave', () => {
      clearTimeout(closeTimer);
      if (state.dirty) return;
      // Don't arm the close timer while a playlist item is mid-drag. HTML5
      // drag-and-drop can fire mouseleave on the editor as the drag preview
      // crosses its boundary, and sliding the drawer shut mid-drag kills the
      // drop targets and aborts the reorder.
      if (document.querySelector('#playlist .item.dragging')) return;
      closeTimer = setTimeout(() => {
        if (state.dirty) return;
        if (document.querySelector('#playlist .item.dragging')) return;
        editor.classList.add('hidden');
      }, 500);
    });
    editor.addEventListener('mouseenter', () => {
      clearTimeout(closeTimer);
    });
  }
  // Editor wiring lives in editor.js (shared with /manage). Initialize
  // it with hooks back into the animation engine — jumping to a
  // playlist item, resetting field render state, closing the drawer
  // after save.
  window.zoetropeEditor.init(state, {
    onEnterItem: enterItem,
    onJump: (idx) => dispatch({ type: 'jump', index: idx }),
    onFieldReset: resetField,
    onFieldLoopToggle: (checked) => {
      if (checked) state.field.loopT = LOOP_RES_END;
      else state.field.introT = 1;
    },
    onSaveCloseEditor: () => {
      document.getElementById('editor').classList.add('hidden');
      hideHud();
    },
    onConfirm: confirmAction,
  });

  // ---- Auto-hide HUD when mouse is idle --------------------------------
  const hud = document.getElementById('hud');
  const IDLE_MS = 300;
  let idleTimer = null;
  let mouseOverHud = false;

  function hideHud() {
    clearTimeout(idleTimer);
    hud.classList.add('idle');
    document.body.style.cursor = 'none';
  }
  function showHud() {
    hud.classList.remove('idle');
    document.body.style.cursor = '';
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!mouseOverHud) hideHud();
    }, IDLE_MS);
  }
  document.addEventListener('mousemove', showHud);
  document.addEventListener('mousedown', showHud);
  hud.addEventListener('mouseenter', () => { mouseOverHud = true; showHud(); });
  hud.addEventListener('mouseleave', () => { mouseOverHud = false; showHud(); });
  showHud();

  document.addEventListener('keydown', e => {
    showHud();
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); dispatch({ type: 'toggle' }); }
    if (e.code === 'ArrowLeft') dispatch({ type: 'back' });
    if (e.code === 'ArrowRight') dispatch({ type: 'advance' });
    if (e.code === 'Home') dispatch({ type: 'reset' });
    if (e.code === 'KeyF') toggleFullscreen();
  });

  // Heartbeat: tell the server we're still here. If the tab closes (or
  // browser crashes, or network drops) heartbeats stop and the server
  // shuts itself down after a few missed beats.
  function heartbeat() {
    fetch('/heartbeat', { method: 'POST' }).catch(() => {});
  }
  setInterval(heartbeat, 5000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) heartbeat();
  });

  fetch('/version', { cache: 'no-store' })
    .then(r => r.text())
    .then(v => { document.getElementById('version').textContent = v.trim(); })
    .catch(() => {});

  // ---- Network mode (standalone / client) -----------------------------
  //
  // The ball page handles standalone and client modes. Hosting lives on
  // /manage; the Hosting pill here is purely a nav affordance.

  state.nmode = 'standalone';
  let clientStatePushTimer = null;

  const PILL_TO_MODE = { standalone: 'standalone', client: 'client', hosting: 'manager' };

  async function csrfFetch(path, options = {}) {
    const headers = { ...(options.headers || {}), 'X-Zoetrope': '1' };
    return fetch(path, { ...options, headers });
  }

  function applyNetworkMode(snap) {
    // Loopback pins the UI to client view; ignore subsequent mode-change
    // events which would otherwise flip the page back to whatever the
    // backend reports (manager mode, in the loopback case).
    if (state.loopback) return;
    const prev = state.nmode;
    state.nmode = snap.mode || 'standalone';
    document.body.classList.remove('nmode-standalone', 'nmode-manager', 'nmode-client');
    document.body.classList.add('nmode-' + state.nmode);

    document.querySelectorAll('.mpill').forEach(p => {
      p.classList.toggle('active', PILL_TO_MODE[p.dataset.mode] === state.nmode);
    });

    if (state.nmode === 'client') {
      setClientPill('connected');
      pushClientHello();
      pushClientSequences();
      pushClientState();
    }

    // Leaving client mode: restore the local config the manager
    // replaced via set-config, if any. Never write to /api/config —
    // the backup is in-memory and the persisted config was never
    // touched.
    if (prev === 'client' && state.nmode !== 'client' && state.sessionConfigBackup) {
      window.zoetropeEditor.applyConfig(state.sessionConfigBackup);
      enterItem(0);
      state.sessionConfigBackup = null;
    }
    // Leaving client mode → hang up any in-flight call so we don't keep
    // the mic open or leak a live peer connection.
    if (prev === 'client' && state.nmode !== 'client'
        && window.zoetropeAudio && window.zoetropeAudio.getState().state !== 'idle') {
      window.zoetropeAudio.hangup();
    }
  }

  function setClientPill(status) {
    const pill = document.getElementById('client-pill');
    pill.dataset.state = status;
    pill.textContent = ({
      connected: 'Connected',
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      disconnected: 'Disconnected',
      error: 'Connection error',
    }[status]) || status;
  }

  // ---- Client-side pushes ---------------------------------------------

  function schedulePushClientState() {
    if (state.nmode !== 'client') return;
    if (clientStatePushTimer) clearTimeout(clientStatePushTimer);
    clientStatePushTimer = setTimeout(pushClientState, 100);
  }

  function pushClientHello() {
    return csrfFetch('/api/network/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'hello' }),
    }).catch(()=>{});
  }

  function pushClientSequences() {
    const seqs = (currentPlaylist()?.items || []).map((item, idx) => ({
      index: idx,
      pattern: item.pattern,
      label: item.name || PATTERN_LABELS[item.pattern] || item.pattern,
    }));
    return csrfFetch('/api/network/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'sequences', sequences: seqs }),
    }).catch(()=>{});
  }

  function pushClientState() {
    const item = currentItem();
    const isSeq = item && isSequencePattern(item.pattern);
    const stepCount = isSeq ? (item.steps || []).length : null;
    const stepIdx = isSeq && stepCount > 0
      ? Math.floor(state.t * stepCount) % stepCount
      : null;
    return csrfFetch('/api/network/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'state',
        playing: state.playing,
        item_idx: state.itemIdx,
        repeat_idx: state.repeatIdx,
        pattern: item?.pattern || null,
        step_idx: stepIdx,
        step_count: stepCount,
        // Cycle fraction at the moment of capture. Manager's mirror uses
        // this + receipt-wallclock to extrapolate forward between state
        // events, so the canvas stays smooth even without a state push
        // every frame.
        t: state.t,
        // Client-side safety pause: while true, the practitioner-side
        // session card surfaces "🛑 client paused" and the practitioner
        // knows their transport verbs are queued, not applied.
        client_paused: state.clientPaused,
      }),
    }).catch(()=>{});
  }

  // ---- Mode actions ---------------------------------------------------

  async function networkJoin(url, label) {
    const r = await csrfFetch('/api/mode/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, label: label || '' }),
    });
    if (!r.ok) throw new Error((await r.text()).trim() || 'join failed');
  }

  async function networkStandalone() {
    await csrfFetch('/api/mode/standalone', { method: 'POST' }).catch(()=>{});
  }

  // ---- Join dialog ----------------------------------------------------

  const joinDialog = document.getElementById('join-dialog');
  function openJoinDialog() {
    joinDialog.classList.add('open');
    document.getElementById('join-error').textContent = '';
    document.getElementById('join-url').focus();
  }
  document.getElementById('join-cancel').addEventListener('click', () => {
    joinDialog.classList.remove('open');
  });
  document.getElementById('join-confirm').addEventListener('click', async () => {
    const url = document.getElementById('join-url').value.trim();
    const errEl = document.getElementById('join-error');
    if (!url) { errEl.textContent = 'Session URL is required'; return; }
    setClientPill('connecting');
    try {
      await networkJoin(url);
      joinDialog.classList.remove('open');
    } catch (err) {
      setClientPill('error');
      errEl.textContent = err.message || String(err);
    }
  });

  document.getElementById('btn-leave').addEventListener('click', networkStandalone);

  // ---- Client-side safety pause ---------------------------------------
  // While clientPaused, dispatch ignores manager transport verbs (see
  // dispatch()'s gate). Resume restores the manager's last play intent.
  const btnClientPause = document.getElementById('btn-client-pause');
  function refreshClientPauseButton() {
    if (state.clientPaused) {
      btnClientPause.textContent = '▶ Resume';
      btnClientPause.classList.add('active');
    } else {
      btnClientPause.textContent = '⏸ Pause';
      btnClientPause.classList.remove('active');
    }
  }
  refreshClientPauseButton();
  btnClientPause.addEventListener('click', () => {
    state.clientPaused = !state.clientPaused;
    if (state.clientPaused) {
      state.playing = false;
    } else {
      // Resume to the manager's last intended state. If they wanted Play,
      // we start playing; if Pause, we stay paused and they can hit Play
      // again to set us in motion.
      state.playing = !!state.managerPlayIntent;
    }
    refreshClientPauseButton();
    schedulePushClientState();
  });

  // ---- File transfer (client → manager) -------------------------------
  async function sendClientFile(file) {
    try {
      const res = await window.zoetropeTransfer.sendFile('/api/network/transfer', file);
      if (res && res.transfer_id) {
        const host = document.getElementById('client-inbox');
        window.zoetropeTransfer.beginOutbound(host, {
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
  document.getElementById('btn-client-attach').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const input = document.createElement('input');
      input.type = 'file';
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.remove();
        if (file) await sendClientFile(file);
      }, { once: true });
      document.body.appendChild(input);
      input.click();
    } finally {
      btn.disabled = false;
    }
  });
  // Drag-and-drop sender on the client-side overlay so a file dropped
  // anywhere in #client-status (URL row + Leave button + inbox area) goes
  // to the manager. Scoped to that element to avoid hijacking drops
  // anywhere else on the canvas.
  const clientStatus = document.getElementById('client-status');
  if (clientStatus) window.zoetropeTransfer.attachDropTarget(clientStatus, sendClientFile);

  // ---- Session capture (client side) --------------------------------
  //
  // Two flows live on this side:
  //   1. Practitioner-initiated record: SSE delivers a `capture-request`
  //      verb → show consent prompt → reply with `capture-response`.
  //      When the host begins recording, `capture-state{recording:true}`
  //      lights up a persistent REC pill with a "Revoke" link.
  //   2. Client-initiated local record: 🎙 button on the overlay starts
  //      a MediaRecorder over the same call streams the practitioner
  //      could record; the resulting Blob downloads to the client's
  //      Downloads folder. No protocol traffic — the host doesn't see
  //      this happening.

  function showCaptureConsent() {
    const el = document.getElementById('capture-consent');
    if (el) el.hidden = false;
  }
  function hideCaptureConsent() {
    const el = document.getElementById('capture-consent');
    if (el) el.hidden = true;
  }

  function setRecPillVisible(on) {
    const pill = document.getElementById('client-rec-pill');
    if (pill) pill.hidden = !on;
  }

  function sendNetworkVerb(payload) {
    return csrfFetch('/api/network/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }

  document.getElementById('capture-consent-allow').addEventListener('click', () => {
    hideCaptureConsent();
    sendNetworkVerb({ type: 'capture-response', allowed: true });
  });
  document.getElementById('capture-consent-deny').addEventListener('click', () => {
    hideCaptureConsent();
    sendNetworkVerb({ type: 'capture-response', allowed: false });
  });
  document.getElementById('client-rec-revoke').addEventListener('click', (e) => {
    e.preventDefault();
    sendNetworkVerb({ type: 'capture-revoke' });
    setRecPillVisible(false);
  });

  // Local-only client capture: records the same mixed call audio via
  // capture.js, then triggers a browser download. No server, no peer
  // notification — the host doesn't know this happened.
  let clientRecorder = null;
  document.getElementById('btn-client-record').addEventListener('click', () => {
    try {
      clientRecorder = window.zoetropeCapture.start();
      document.getElementById('btn-client-record').hidden = true;
      document.getElementById('btn-client-record-stop').hidden = false;
    } catch (err) {
      alert(err.message || String(err));
    }
  });
  document.getElementById('btn-client-record-stop').addEventListener('click', async () => {
    if (!clientRecorder) return;
    const blob = await clientRecorder.stop();
    clientRecorder = null;
    window.zoetropeCapture.downloadBlob(blob, window.zoetropeCapture.captureFilename());
    document.getElementById('btn-client-record').hidden = false;
    document.getElementById('btn-client-record-stop').hidden = true;
  });

  // ---- Voice call (bidirectional) -------------------------------------
  //
  // audio.js owns the RTCPeerConnection lifecycle. We give it a sendVerb
  // that posts to /api/network/send (manager is the only peer in client
  // mode, so peerFP is ignored) and a state-change callback that renders
  // the controls block under #client-status.
  window.zoetropeAudio.init({
    sendVerb: (verb /*, peerFP — unused, manager is the only peer */) => {
      csrfFetch('/api/network/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(verb),
      }).catch(err => console.warn('audio send:', err));
    },
    onStateChange: renderClientAudio,
  });

  function renderClientAudio(snap) {
    const wrap = document.getElementById('client-audio');
    const incoming = document.getElementById('client-audio-incoming');
    const active = document.getElementById('client-audio-active');
    const stateEl = document.getElementById('client-audio-state');
    const micBtn = document.getElementById('client-audio-mic');
    const vol = document.getElementById('client-audio-volume');
    wrap.hidden = (snap.state === 'idle');
    incoming.hidden = (snap.state !== 'incoming-ringing');
    active.hidden = !(snap.state === 'outgoing-ringing' || snap.state === 'connecting' || snap.state === 'connected');
    if (!active.hidden) {
      stateEl.textContent = ({
        'outgoing-ringing': 'Calling…',
        'connecting':       'Connecting…',
        'connected':        'Connected',
      }[snap.state]) || snap.state;
      micBtn.textContent = snap.micMuted ? '🎤 Muted' : '🎤 Mute';
      micBtn.classList.toggle('active', snap.micMuted);
      vol.value = Math.round(snap.speakerVolume * 100);
    }
    // The 🎙 Record button is meaningful only while a call is active.
    // Stop button stays hidden until a recording is in flight; the
    // record-click handler swaps the visibility itself.
    const recBtn = document.getElementById('btn-client-record');
    const recStop = document.getElementById('btn-client-record-stop');
    const callConnected = (snap.state === 'connected');
    if (recBtn) {
      recBtn.hidden = !callConnected || !recStop.hidden;
    }
    if (!callConnected && recStop && !recStop.hidden) {
      // Call dropped mid-recording — close the recorder and let the
      // resulting blob still download so the user doesn't lose work.
      if (clientRecorder) {
        clientRecorder.stop().then(blob => {
          window.zoetropeCapture.downloadBlob(blob, window.zoetropeCapture.captureFilename());
          clientRecorder = null;
        });
      }
      recStop.hidden = true;
    }
  }
  renderClientAudio(window.zoetropeAudio.getState());

  document.getElementById('btn-client-call').addEventListener('click', async () => {
    const cur = window.zoetropeAudio.getState();
    if (cur.state !== 'idle') return; // ignore double-clicks
    try {
      await window.zoetropeAudio.startCall(null, 'practitioner');
    } catch (err) {
      console.warn('call failed:', err);
      alert('Call failed: ' + err.message);
    }
  });
  document.getElementById('client-audio-accept').addEventListener('click', () => window.zoetropeAudio.acceptCall());
  document.getElementById('client-audio-decline').addEventListener('click', () => window.zoetropeAudio.declineCall());
  document.getElementById('client-audio-hangup').addEventListener('click', () => window.zoetropeAudio.hangup());
  document.getElementById('client-audio-mic').addEventListener('click', () => {
    const cur = window.zoetropeAudio.getState();
    window.zoetropeAudio.setMicMuted(!cur.micMuted);
  });
  document.getElementById('client-audio-volume').addEventListener('input', e => {
    window.zoetropeAudio.setSpeakerVolume((+e.target.value) / 100);
  });

  // ---- Pill clicks ----------------------------------------------------

  document.querySelectorAll('.mpill').forEach(p => {
    p.addEventListener('click', () => onPillClick(p));
  });

  function onPillClick(p) {
    const target = PILL_TO_MODE[p.dataset.mode];
    if (target === state.nmode) {
      // Active pill — already in this mode. Hosting pill is an exception
      // since hosting lives on /manage; clicking it navigates there.
      if (target === 'manager') window.location.href = '/manage';
      return;
    }
    if (target === 'standalone') {
      if (state.nmode === 'manager') {
        confirmAction('Stop hosting? Any connected clients will be disconnected.', networkStandalone);
      } else {
        networkStandalone();
      }
      return;
    }
    if (target === 'client') {
      if (state.nmode === 'manager') {
        confirmAction('Stop hosting and switch to client mode?', () => {
          networkStandalone().then(openJoinDialog);
        });
      } else {
        openJoinDialog();
      }
      return;
    }
    if (target === 'manager') {
      // Navigate to /manage. If currently a client, confirm first.
      if (state.nmode === 'client') {
        confirmAction('Leave the current session and start hosting?', () => {
          networkStandalone().then(() => { window.location.href = '/manage'; });
        });
      } else {
        window.location.href = '/manage';
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

  // ---- SSE subscriber -------------------------------------------------

  function startEventSource() {
    const es = new EventSource('/api/session/events');
    es.addEventListener('mode-change', e => {
      try { applyNetworkMode(JSON.parse(e.data)); } catch (err) { console.error(err); }
    });
    es.addEventListener('network-verb', e => {
      try {
        const ev = JSON.parse(e.data);
        if (!ev.frame) return;
        // Audio signaling is owned by audio.js — don't run it through the
        // transport dispatch (which would log "unknown verb").
        if (ev.frame.type === 'audio-offer' || ev.frame.type === 'audio-answer'
            || ev.frame.type === 'audio-ice' || ev.frame.type === 'audio-bye') {
          window.zoetropeAudio.handleSignal(ev.frame, null, 'practitioner');
          return;
        }
        dispatch(ev.frame);
      } catch (err) { console.error(err); }
    });
    es.addEventListener('network-disconnected', () => {
      if (state.nmode === 'client') setClientPill('disconnected');
    });
    es.addEventListener('file-received', e => {
      try {
        const ev = JSON.parse(e.data);
        // / surfaces files received from the manager. session→manager
        // arrivals are handled on /manage.
        if (ev.direction !== 'from-manager') return;
        const host = document.getElementById('client-inbox');
        window.zoetropeTransfer.renderInboundNotification(host, ev);
      } catch (err) { console.error(err); }
    });
    // Sender-side lifecycle for client → manager uploads. Routed through
    // zoetropeTransfer so the matching outbound progress card updates.
    for (const kind of ['progress', 'accepted', 'completed', 'failed']) {
      es.addEventListener('transfer-' + kind, e => {
        try { window.zoetropeTransfer.handleLifecycle(kind, JSON.parse(e.data)); }
        catch (err) { console.error(err); }
      });
    }
  }

  async function initNetworkMode() {
    // Dev-only loopback: when /?loopback is set, the backend is in
    // manager mode with a synthetic in-process session and this tab
    // plays the client role for testing. Skip /api/mode/state (its
    // snap.mode would say "manager" and pull the UI the wrong way) and
    // pin the client UI directly. SSE network-verb events still fire
    // because Loopback() publishes them on the same bus this tab
    // subscribes to.
    if (new URLSearchParams(window.location.search).has('loopback')) {
      state.loopback = true;
      state.nmode = 'client';
      document.body.classList.remove('nmode-standalone', 'nmode-manager', 'nmode-client');
      document.body.classList.add('nmode-client');
      const pill = document.getElementById('client-pill');
      pill.dataset.state = 'loopback';
      pill.textContent = 'LOOPBACK (dev)';
      pushClientHello();
      pushClientSequences();
      pushClientState();
      startEventSource();
      return;
    }
    try {
      const r = await fetch('/api/mode/state', { cache: 'no-store' });
      if (r.ok) applyNetworkMode(await r.json());
    } catch (err) {
      console.warn('initial mode load failed:', err);
    }
    startEventSource();
    // The /manage page sends users here with #join to open the join
    // dialog. Honor it once, then clear the hash so a refresh doesn't
    // re-open the dialog.
    if (window.location.hash === '#join') {
      history.replaceState(null, '', window.location.pathname);
      openJoinDialog();
    }
  }

  window.zoetropeEditor.loadConfig().then(() => {
    heartbeat();
    play();
    requestAnimationFrame(frame);
    initNetworkMode();
  }).catch(err => {
    console.error(err);
    document.body.innerText = 'Failed to load config: ' + err.message;
  });
})();
