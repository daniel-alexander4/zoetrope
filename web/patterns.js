// patterns.js — single source of truth for the ball's animation kinematics.
//
// Each pattern is a pure function (t, item, vp, ctx) -> {x, y, sizeMul?}
// where t in [0, 1) is the cycle fraction, item is the playlist entry,
// vp is {w, h} of the target canvas, and ctx carries the runtime state
// the patterns need (config, speedMul, repeatIdx, bounceStart).
//
// Both the client animation loop (web/app.js) and the manager mirror
// (web/manage.js) call into here — there is no parallel position
// computation anywhere else. The signature takes ctx explicitly so the
// mirror can render the client's state into a different-sized canvas
// without sharing the client's locals.

(() => {
  'use strict';

  const TAU = Math.PI * 2;
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
  function lingerFrac(pattern, ctx) {
    if (!isLinearPattern(pattern)) return 0;
    const sec = ctx.config.lingerSec ?? 0;
    if (sec <= 0) return 0;
    const cps = (Math.max(0, ctx.config.speed ?? 2) / 10) * (ctx.speedMul ?? 1);
    if (cps <= 0) return 0;
    const baseCycle = 1 / cps;
    return sec / (baseCycle + 2 * sec);
  }

  // computeCycleSec returns how many seconds one full cycle of `item` takes,
  // given the user-facing speed config in ctx. The client's advance() uses
  // it to scale dt → t; the mirror uses it to extrapolate t forward between
  // state snapshots from the client.
  function computeCycleSec(item, ctx) {
    const userSpeed = Math.max(0, ctx.config.speed ?? 2);
    const speedMul = ctx.speedMul ?? 1;
    if (isSequencePattern(item.pattern)) {
      const speedScale = (userSpeed / 2) * speedMul;
      if (speedScale <= 0) return Infinity;
      return sequenceCycleSec(item) / speedScale;
    }
    const cps = (userSpeed / 10) * speedMul;
    if (cps <= 0) return Infinity;
    const linger = ctx.config.lingerSec ?? 0;
    const baseCycle = 1 / cps;
    return isLinearPattern(item.pattern) && linger > 0
      ? baseCycle + 2 * linger
      : baseCycle;
  }

  // For linear patterns: map cycle fraction t to a position in [-1, +1]
  // and a size multiplier, inserting a dwell-and-pulse at each extreme.
  // L is the fraction of one cycle taken by *each* linger phase. The size
  // pulse extends `lead` past the dwell on each side so growth begins
  // during the approach and shrink finishes during the departure.
  function linearSchedule(t, L, ctx) {
    if (L <= 0 || L >= 0.5) {
      return { pos: -Math.cos(TAU * t), sizeMul: 1 };
    }
    const half = (1 - 2 * L) / 2; // each moving phase fraction
    const leadFrac = Math.max(0, ctx.config.lingerLeadFrac ?? 0);
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

  function triangleFold(v, span) {
    if (span <= 0) return 0;
    const period = 2 * span;
    let m = ((v % period) + period) % period;
    if (m > span) m = period - m;
    return m;
  }

  const patterns = {
    'h-sweep': (t, item, vp, ctx) => {
      const m = ctx.config.ballSize / 2;
      const amp = (vp.w - 2 * m) / 2;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const { pos, sizeMul } = linearSchedule(t, lingerFrac('h-sweep', ctx), ctx);
      return { x: cx + amp * pos, y: cy, sizeMul };
    },

    'v-sweep': (t, item, vp, ctx) => {
      const m = ctx.config.ballSize / 2;
      const amp = (vp.h - 2 * m) / 2;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const { pos, sizeMul } = linearSchedule(t, lingerFrac('v-sweep', ctx), ctx);
      return { x: cx, y: cy + amp * pos, sizeMul };
    },

    'circle': (t, item, vp, ctx) => {
      const m = ctx.config.ballSize / 2;
      const r = Math.min(vp.w, vp.h) / 2 - m - 8;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const dir = item.direction === 'ccw' ? -1 : 1;
      const a = dir * TAU * t;
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    },

    'infinity-v': (t, item, vp, ctx) => {
      // Vertical infinity (8 standing up — lobes stacked).
      const m = ctx.config.ballSize / 2;
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

    'infinity-h': (t, item, vp, ctx) => {
      // Horizontal infinity (∞ on its side — lobes side by side).
      const m = ctx.config.ballSize / 2;
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

    'diag-ulbr': (t, item, vp, ctx) => {
      const m = ctx.config.ballSize / 2;
      const ampX = (vp.w - 2 * m) / 2;
      const ampY = (vp.h - 2 * m) / 2;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const { pos, sizeMul } = linearSchedule(t, lingerFrac('diag-ulbr', ctx), ctx);
      return { x: cx + ampX * pos, y: cy + ampY * pos, sizeMul };
    },

    'diag-urbl': (t, item, vp, ctx) => {
      const m = ctx.config.ballSize / 2;
      const ampX = (vp.w - 2 * m) / 2;
      const ampY = (vp.h - 2 * m) / 2;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const { pos, sizeMul } = linearSchedule(t, lingerFrac('diag-urbl', ctx), ctx);
      return { x: cx - ampX * pos, y: cy + ampY * pos, sizeMul };
    },

    'bounce': (t, item, vp, ctx) => {
      // Straight-line travel folded off the inner walls. bounceStart is
      // the per-canvas anchor where the trajectory starts at this item's
      // first frame; the mirror uses its own canvas center.
      const m = ctx.config.ballSize / 2;
      const innerW = vp.w - 2 * m;
      const innerH = vp.h - 2 * m;
      const speed = Math.max(vp.w, vp.h);
      const angle = ((item.angleDeg ?? 37) * Math.PI) / 180;
      const totalT = (ctx.repeatIdx ?? 0) + t;
      const ux = Math.cos(angle) * speed * totalT;
      const uy = Math.sin(angle) * speed * totalT;
      const start = ctx.bounceStart ?? { x: vp.w / 2, y: vp.h / 2 };
      return {
        x: triangleFold(start.x + ux - m, innerW) + m,
        y: triangleFold(start.y + uy - m, innerH) + m,
      };
    },

    'position-sequence': (t, item, vp /*, ctx */) => {
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

      const next = steps[(idx + 1) % steps.length];
      const to = positionToCanvas(next.position, vp);
      const u = (into - dwell) / transit;
      const e = 0.5 - 0.5 * Math.cos(Math.PI * u);
      return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
    },
  };

  window.zoetropePatterns = {
    patterns,
    GAZE_POSITIONS,
    POSITION_LABELS,
    POSITION_INSET,
    isLinearPattern,
    isSequencePattern,
    sequenceCycleSec,
    computeCycleSec,
    positionToCanvas,
  };
})();
