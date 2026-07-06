(() => {
  'use strict';

  const TAU = Math.PI * 2;

  // PATTERN_LABELS lives on window.zoetropeEditor.
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
  // The pattern engine itself lives in web/patterns.js (single source of
  // truth for kinematics). Pull the bits this module needs into local
  // names so the animation loop below reads cleanly.
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
        const pl = currentPlaylist();
        const atLastItem = state.itemIdx + 1 >= pl.items.length;
        if (atLastItem && pl.loop === false) {
          // Non-looping playlist finished: rewind to the first item's
          // start and stop. Re-engage play to run it again.
          enterItem(0);
          pause();
          return;
        }
        enterItem((state.itemIdx + 1) % pl.items.length);
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
  // Reused across frames for the fixed (non-random) shapes so the hot field
  // loop doesn't allocate a descriptor every frame; params stays {} (the
  // renderer reads only random-shape params, all via ?? fallbacks).
  const fixedShapeResolved = { shape: 'circles', params: {} };
  function resolveShape() {
    const shape = state.config.field?.shape || 'circles';
    if (shape !== 'random') {
      fixedShapeResolved.shape = shape;
      return fixedShapeResolved;
    }
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
    const speed = Math.max(0, f.speed ?? 2) / 10;
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

  function setPlayIcon(icon) {
    document.getElementById('btn-play').textContent = icon;
  }

  // Called every frame; only touches the DOM when the displayed values
  // actually change. Comparing primitives (not a rebuilt key string) keeps
  // the steady-state path allocation-free on the hot loop.
  const nowPlaying = { i: -1, r: -1, total: -1, label: null };
  function updateNowPlaying() {
    const el = document.getElementById('now-playing');
    const item = currentItem();
    if (!item) {
      if (nowPlaying.i !== null) { nowPlaying.i = null; el.textContent = ''; }
      return;
    }
    const total = currentPlaylist()?.items?.length || 0;
    const label = item.name || PATTERN_LABELS[item.pattern] || item.pattern;
    if (nowPlaying.i === state.itemIdx && nowPlaying.r === state.repeatIdx &&
        nowPlaying.total === total && nowPlaying.label === label) return;
    nowPlaying.i = state.itemIdx;
    nowPlaying.r = state.repeatIdx;
    nowPlaying.total = total;
    nowPlaying.label = label;
    el.textContent = `${state.itemIdx + 1}/${total} · ${label} · rep ${state.repeatIdx + 1}/${item.repeats}`;
  }

  function updatePlayingHighlight() {
    const lis = document.querySelectorAll('#playlist .item');
    lis.forEach((li, i) => li.classList.toggle('playing', i === state.itemIdx));
  }

  // ---- Dispatch ---------------------------------------------------------
  // Single entry point for transport actions. Local UI handlers (buttons,
  // keyboard, editor jump) route through here.

  function dispatch(verb) {
    switch (verb.type) {
      case 'play':    play(); break;
      case 'pause':   pause(); break;
      case 'toggle':  togglePlay(); break;
      case 'advance': nextPattern(); break;
      case 'back':    seekPatternStart(); break;
      case 'reset':   seekPlaylistStart(); break;
      case 'jump':
        if (Number.isInteger(verb.index)) jumpToItem(verb.index);
        break;
      default:
        console.warn('unknown verb:', verb);
    }
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
  // Editor wiring lives in editor.js. Initialize
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

  window.zoetropeEditor.loadConfig().then(() => {
    heartbeat();
    play();
    requestAnimationFrame(frame);
  }).catch(err => {
    console.error(err);
    document.body.innerText = 'Failed to load config: ' + err.message;
  });
})();
