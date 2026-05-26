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
  // Each pattern is a pure function (t, item, vp) -> {x, y, sizeMul?},
  // where t in [0, 1) represents one full cycle. cx, cy = canvas
  // center. margin keeps the ball inside the visible area. sizeMul
  // (default 1) lets a pattern scale the ball — used by linear sweeps
  // when "edge linger" is on to pulse the ball at each extreme.

  const LINGER_PEAK = 2; // ball grows to 2× baseline at the linger midpoint

  function isLinearPattern(p) {
    return p === 'h-sweep' || p === 'v-sweep' || p === 'diag-ulbr' || p === 'diag-urbl';
  }

  function isSequencePattern(p) {
    return p === 'position-sequence';
  }

  // ---- Gaze grid (position-sequence patterns) ---------------------------
  // Named targets on a 3×3 grid: 8 cardinals/diagonals + center. Coordinates
  // are normalized to [-1, +1]; the actual pixel position is computed per
  // frame from the live viewport so the grid scales with window resize.
  const GAZE_POSITIONS = {
    'center':    { ux:  0, uy:  0 },
    'up':        { ux:  0, uy: -1 },
    'up-l':      { ux: -1, uy: -1 },
    'up-r':      { ux:  1, uy: -1 },
    'lateral-l': { ux: -1, uy:  0 },
    'lateral-r': { ux:  1, uy:  0 },
    'down':      { ux:  0, uy:  1 },
    'down-l':    { ux: -1, uy:  1 },
    'down-r':    { ux:  1, uy:  1 },
  };
  const POSITION_LABELS = {
    'center':    'Center',
    'up':        'Up',
    'up-l':      'Up-L',
    'up-r':      'Up-R',
    'lateral-l': 'Lateral-L',
    'lateral-r': 'Lateral-R',
    'down':      'Down',
    'down-l':    'Down-L',
    'down-r':    'Down-R',
  };
  const POSITION_INSET = 80; // px margin from viewport edge

  function positionToCanvas(name, vp) {
    const pos = GAZE_POSITIONS[name] || GAZE_POSITIONS.center;
    return {
      x: vp.w / 2 + pos.ux * (vp.w / 2 - POSITION_INSET),
      y: vp.h / 2 + pos.uy * (vp.h / 2 - POSITION_INSET),
    };
  }

  function sequenceCycleSec(item) {
    const steps = item.steps || [];
    if (steps.length === 0) return 0.1;
    const dwell = Math.max(0, item.dwellSec ?? 1.5);
    const transit = Math.max(0, item.transitSec ?? 0.8);
    return Math.max(0.1, steps.length * (dwell + transit));
  }

  // Fraction of the current cycle spent in each linger phase. 0 when
  // linger is disabled, when the pattern isn't linear, or when paused.
  function lingerFrac(pattern) {
    if (!isLinearPattern(pattern)) return 0;
    const sec = state.config.lingerSec ?? 0;
    if (sec <= 0) return 0;
    const cps = (Math.max(0, state.config.speed ?? 2) / 10) * state.speedMul;
    if (cps <= 0) return 0;
    const baseCycle = 1 / cps;
    return sec / (baseCycle + 2 * sec);
  }

  // For linear patterns: map cycle fraction t to a position in [-1, +1]
  // and a size multiplier, inserting a dwell-and-pulse at each extreme.
  // L is the fraction of one cycle taken by *each* linger phase. The size
  // pulse extends `lead` past the dwell on each side so growth begins
  // during the approach and shrink finishes during the departure.
  function linearSchedule(t, L) {
    if (L <= 0 || L >= 0.5) {
      return { pos: -Math.cos(TAU * t), sizeMul: 1 };
    }
    const half = (1 - 2 * L) / 2; // each moving phase fraction
    const leadFrac = Math.max(0, state.config.lingerLeadFrac ?? 0);
    const lead = Math.min(L, half) * leadFrac;
    const pulseLen = L + 2 * lead;

    let pos;
    if (t < half) {
      pos = -Math.cos(Math.PI * (t / half));
    } else if (t < half + L) {
      pos = 1;
    } else if (t < 2 * half + L) {
      pos = Math.cos(Math.PI * ((t - half - L) / half));
    } else {
      pos = -1;
    }

    // One sine pulse per edge, centered on its dwell midpoint but widened
    // by `lead` into both adjacent motion phases. The −1 pulse wraps the
    // cycle boundary (trailing half lives in the next cycle's start).
    let u = -1;
    if (t >= half - lead && t < half + L + lead) {
      u = (t - (half - lead)) / pulseLen;
    } else if (t >= 1 - L - lead) {
      u = (t - (1 - L - lead)) / pulseLen;
    } else if (t < lead) {
      u = (t + L + lead) / pulseLen;
    }
    const sizeMul = u >= 0
      ? 1 + (LINGER_PEAK - 1) * Math.sin(Math.PI * u)
      : 1;

    return { pos, sizeMul };
  }

  const patterns = {
    'h-sweep': (t, item, vp) => {
      const m = state.config.ballSize / 2;
      const amp = (vp.w - 2 * m) / 2;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const { pos, sizeMul } = linearSchedule(t, lingerFrac('h-sweep'));
      return { x: cx + amp * pos, y: cy, sizeMul };
    },

    'v-sweep': (t, item, vp) => {
      const m = state.config.ballSize / 2;
      const amp = (vp.h - 2 * m) / 2;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const { pos, sizeMul } = linearSchedule(t, lingerFrac('v-sweep'));
      return { x: cx, y: cy + amp * pos, sizeMul };
    },

    'circle': (t, item, vp) => {
      const m = state.config.ballSize / 2;
      const r = Math.min(vp.w, vp.h) / 2 - m - 8;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const dir = item.direction === 'ccw' ? -1 : 1;
      const a = dir * TAU * t;
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    },

    'infinity-v': (t, item, vp) => {
      // Vertical infinity (8 standing up — lobes stacked).
      const m = state.config.ballSize / 2;
      const ampX = (vp.w - 2 * m) / 2 - 8;
      const ampY = (vp.h - 2 * m) / 2 - 8;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const sign = item.direction === 'ccw' ? -1 : 1;
      return {
        x: cx + sign * ampX * Math.sin(TAU * 2 * t),
        y: cy + ampY * Math.sin(TAU * t),
      };
    },

    'infinity-h': (t, item, vp) => {
      // Horizontal infinity (∞ on its side — lobes side by side).
      const m = state.config.ballSize / 2;
      const ampX = (vp.w - 2 * m) / 2 - 8;
      const ampY = (vp.h - 2 * m) / 2 - 8;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const sign = item.direction === 'ccw' ? -1 : 1;
      return {
        x: cx + ampX * Math.sin(TAU * t),
        y: cy + sign * ampY * Math.sin(TAU * 2 * t),
      };
    },

    'diag-ulbr': (t, item, vp) => {
      // Upper-left ↔ bottom-right diagonal sweep.
      const m = state.config.ballSize / 2;
      const ampX = (vp.w - 2 * m) / 2;
      const ampY = (vp.h - 2 * m) / 2;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const { pos, sizeMul } = linearSchedule(t, lingerFrac('diag-ulbr'));
      return { x: cx + ampX * pos, y: cy + ampY * pos, sizeMul };
    },

    'diag-urbl': (t, item, vp) => {
      // Upper-right ↔ bottom-left diagonal sweep.
      const m = state.config.ballSize / 2;
      const ampX = (vp.w - 2 * m) / 2;
      const ampY = (vp.h - 2 * m) / 2;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const { pos, sizeMul } = linearSchedule(t, lingerFrac('diag-urbl'));
      return { x: cx - ampX * pos, y: cy + ampY * pos, sizeMul };
    },

    'bounce': (t, item, vp) => {
      // The ball travels in a straight line at constant speed; reflections
      // off the inner-rectangle walls are folded via a triangle wave so
      // the trajectory is continuous across repeats.
      const m = state.config.ballSize / 2;
      const innerW = vp.w - 2 * m;
      const innerH = vp.h - 2 * m;
      const speed = Math.max(vp.w, vp.h); // unfolded distance per cycle
      const angle = ((item.angleDeg ?? 37) * Math.PI) / 180;
      const totalT = state.repeatIdx + t;
      const ux = Math.cos(angle) * speed * totalT;
      const uy = Math.sin(angle) * speed * totalT;
      return {
        x: triangleFold(state.bounceStart.x + ux - m, innerW) + m,
        y: triangleFold(state.bounceStart.y + uy - m, innerH) + m,
      };
    },

    'position-sequence': (t, item, vp) => {
      // Step the ball through item.steps, dwelling per step and smoothly
      // pursuing to the next. Cycle length is derived from steps × (dwell +
      // transit) and is what advance() uses to scale dt — so t here is the
      // [0, 1) progress through one full sequence.
      const steps = item.steps || [];
      if (steps.length === 0) return { x: vp.w / 2, y: vp.h / 2 };
      const dwell = Math.max(0, item.dwellSec ?? 1.5);
      const transit = Math.max(0, item.transitSec ?? 0.8);
      const stepLen = dwell + transit;
      if (stepLen <= 0) return positionToCanvas(steps[0].position, vp);

      const elapsed = t * steps.length * stepLen;
      const idx = Math.min(steps.length - 1, Math.floor(elapsed / stepLen));
      const into = elapsed - idx * stepLen;
      const from = positionToCanvas(steps[idx].position, vp);
      if (into < dwell || transit === 0) return from;

      // Smooth-pursuit transit toward the next step (wraps to step 0 on
      // the last step). Cosine ease-in-out: 0 velocity at both ends so the
      // ball arrives at and leaves each position cleanly.
      const next = steps[(idx + 1) % steps.length];
      const to = positionToCanvas(next.position, vp);
      const u = (into - dwell) / transit;
      const e = 0.5 - 0.5 * Math.cos(Math.PI * u);
      return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
    },
  };

  function triangleFold(v, span) {
    if (span <= 0) return 0;
    const period = 2 * span;
    let m = ((v % period) + period) % period;
    if (m > span) m = period - m;
    return m;
  }

  // ---- Animation --------------------------------------------------------

  function currentItem() {
    return state.config?.playlist?.[state.itemIdx];
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
    const userSpeed = Math.max(0, state.config.speed ?? 2);
    const speedScale = (userSpeed / 2) * state.speedMul;
    if (speedScale <= 0) return;

    let cycleSec;
    if (isSequencePattern(item.pattern)) {
      cycleSec = sequenceCycleSec(item) / speedScale;
    } else {
      const cps = (userSpeed / 10) * state.speedMul;
      const linger = state.config.lingerSec ?? 0;
      const baseCycle = 1 / cps;
      cycleSec = isLinearPattern(item.pattern) && linger > 0
        ? baseCycle + 2 * linger
        : baseCycle;
    }
    state.t += dt / cycleSec;
    while (state.t >= 1) {
      state.t -= 1;
      state.repeatIdx += 1;
      if (state.repeatIdx >= (item.repeats || 1)) {
        const next = (state.itemIdx + 1) % state.config.playlist.length;
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

    const { x, y, sizeMul = 1 } = fn(state.t, item, vp);
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
    const len = state.config?.playlist?.length || 1;
    enterItem((state.itemIdx + 1) % len);
  }
  function jumpToItem(i) {
    if (i < 0 || i >= state.config.playlist.length) return;
    state.lastFrameMs = 0;
    enterItem(i);
  }

  function setPlayIcon(icon) {
    document.getElementById('btn-play').textContent = icon;
  }

  function updateNowPlaying() {
    const el = document.getElementById('now-playing');
    const item = currentItem();
    if (!item) { el.textContent = ''; return; }
    const total = state.config.playlist.length;
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
    switch (verb.type) {
      case 'play':         play(); break;
      case 'pause':        pause(); break;
      case 'resume':       play(); break;
      case 'toggle':       togglePlay(); break;
      case 'advance':      nextPattern(); break;
      case 'back':         seekPatternStart(); break;
      case 'reset':        seekPlaylistStart(); break;
      case 'stop':         pause(); seekPlaylistStart(); break;
      case 'hold':         /* IEMT only: freeze at current position */ break;
      case 'release':      /* IEMT only: resume auto-advance */ break;
      case 'jump':
      case 'set-sequence':
        if (Number.isInteger(verb.index)) jumpToItem(verb.index);
        break;
      case 'set-config':
        if (verb.config) applyPushedConfig(verb.config);
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
    const seqs = (state.config?.playlist || []).map((item, idx) => ({
      index: idx,
      pattern: item.pattern,
      label: PATTERN_LABELS[item.pattern] || item.pattern,
    }));
    return csrfFetch('/api/network/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'sequences', sequences: seqs }),
    }).catch(()=>{});
  }

  function pushClientState() {
    const item = currentItem();
    return csrfFetch('/api/network/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'state',
        playing: state.playing,
        item_idx: state.itemIdx,
        repeat_idx: state.repeatIdx,
        pattern: item?.pattern || null,
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
        if (ev.frame) dispatch(ev.frame);
      } catch (err) { console.error(err); }
    });
    es.addEventListener('network-disconnected', () => {
      if (state.nmode === 'client') setClientPill('disconnected');
    });
  }

  async function initNetworkMode() {
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
