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

  // Serpentine lane count, clamped to [2, 8]. Both the renderer and the
  // period table read it from here so the bounds can't drift.
  function serpentineLanes(item) {
    return Math.max(2, Math.min(8, Math.floor(item.lanes ?? 3)));
  }

  // Serpentine path geometry for an inner box (half-width W, half-height H),
  // N lanes, and a cornerRadius in [0,1]. Single source for the segment
  // lengths the renderer walks along the path.
  function serpentineGeom(W, H, N, cornerRadius) {
    const step = (2 * H) / (2 * N);
    const round = Math.min(1, Math.max(0, cornerRadius ?? 0));
    const r = Math.max(0, round * Math.min(step / 2, W / 2));
    const laneLen = Math.max(0, 2 * (W - r));
    const arcLen = (Math.PI / 2) * r;
    const turn1Len = 2 * arcLen + Math.max(0, step - 2 * r);
    const turn2Len = 2 * arcLen + Math.max(0, 2 * step - 2 * r);
    const totalLen = 2 * N * laneLen + (2 * N - 2) * turn2Len + 2 * turn1Len;
    return { step, r, laneLen, arcLen, turn1Len, turn2Len, totalLen };
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

  // Base moving-cycle duration for a continuous pattern: the time for one
  // full traversal, excluding any edge-linger dwell. The speed dial sets a
  // target ball pixel-speed, so the period is normalized by the pattern's
  // path length relative to the circle (periodFactor, built at load below) —
  // every pattern then sweeps at the same speed for a given dial. A per-item
  // `speed` overrides the global dial for that item; the transport speedMul
  // still scales it at runtime. Returns Infinity when paused.
  function baseCycleSec(item, ctx) {
    const userSpeed = item.speed ?? ctx.config.speed ?? 2;
    const cps = (Math.max(0, userSpeed) / 10) * (ctx.speedMul ?? 1);
    if (cps <= 0) return Infinity;
    return periodFactor(item) / cps;
  }

  // Fraction of the current cycle spent in each linger phase. 0 when
  // linger is disabled, when the pattern isn't linear, or when paused.
  function lingerFrac(item, ctx) {
    if (!isLinearPattern(item.pattern)) return 0;
    const sec = ctx.config.lingerSec ?? 0;
    if (sec <= 0) return 0;
    const base = baseCycleSec(item, ctx);
    if (!isFinite(base)) return 0;
    return sec / (base + 2 * sec);
  }

  // computeCycleSec returns how many seconds one full cycle of `item` takes,
  // given the user-facing speed config in ctx. The client's advance() uses
  // it to scale dt → t; the mirror uses it to extrapolate t forward between
  // state snapshots from the client.
  function computeCycleSec(item, ctx) {
    if (isSequencePattern(item.pattern)) {
      const userSpeed = Math.max(0, item.speed ?? ctx.config.speed ?? 2);
      const speedScale = (userSpeed / 2) * (ctx.speedMul ?? 1);
      if (speedScale <= 0) return Infinity;
      return sequenceCycleSec(item) / speedScale;
    }
    const base = baseCycleSec(item, ctx);
    if (!isFinite(base)) return Infinity;
    const linger = ctx.config.lingerSec ?? 0;
    return isLinearPattern(item.pattern) && linger > 0 ? base + 2 * linger : base;
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
      const { pos, sizeMul } = linearSchedule(t, lingerFrac(item, ctx), ctx);
      return { x: cx + amp * pos, y: cy, sizeMul };
    },

    'v-sweep': (t, item, vp, ctx) => {
      const m = ctx.config.ballSize / 2;
      const amp = (vp.h - 2 * m) / 2;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const { pos, sizeMul } = linearSchedule(t, lingerFrac(item, ctx), ctx);
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

    'serpentine': (t, item, vp, ctx) => {
      // Serpentine / boustrophedon. N down-lanes interleaved with N up-
      // lanes in the gaps, traversed as a continuous closed loop. The
      // path goes: row 0 (Start) → row 2 → … → row 2N-2 → row 2N-1
      // (Turn at the bottom) → row 2N-3 → … → row 1 → back to row 0.
      // startCorner mirrors x ('tl' vs 'tr'); direction reverses t
      // (cw=forward, ccw=backward); cornerRadius ∈ [0,1] rounds the
      // U-turns up to a half-circle. lanes is N (the number of down-
      // lanes; total rows = 2N).
      const m = ctx.config.ballSize / 2;
      const W = Math.max(1, (vp.w - 2 * m) / 2 - 8);
      const H = Math.max(1, (vp.h - 2 * m) / 2 - 8);
      const N = serpentineLanes(item);
      const { step, r, laneLen, arcLen, turn1Len, turn2Len, totalLen } =
        serpentineGeom(W, H, N, item.cornerRadius);
      const cx = vp.w / 2;
      const cy = vp.h / 2;

      const flipX = item.startCorner === 'tr' ? -1 : 1;
      const sign = item.direction === 'ccw' ? -1 : 1;
      let u = (sign * t) % 1;
      if (u < 0) u += 1;

      if (totalLen <= 0) return { x: cx, y: cy };

      let s = u * totalLen;
      for (let i = 0; i < 2 * N; i++) {
        const rowIdx = i < N ? 2 * i : 4 * N - 2 * i - 1;
        const ly = -H + (rowIdx + 0.5) * step;
        if (s < laneLen) {
          const uLane = s / laneLen;
          const goingRight = (i % 2 === 0);
          const dx = goingRight ? -(W - r) + uLane * 2 * (W - r) : (W - r) - uLane * 2 * (W - r);
          return { x: cx + flipX * dx, y: cy + ly };
        }
        s -= laneLen;

        const sideSign = (i % 2 === 0) ? 1 : -1;
        const sideX = sideSign * (W - r);
        const nextI = (i + 1) % (2 * N);
        const nextRowIdx = nextI < N ? 2 * nextI : 4 * N - 2 * nextI - 1;
        const nextLy = -H + (nextRowIdx + 0.5) * step;
        const turnLen = (i === N - 1 || i === 2 * N - 1) ? turn1Len : turn2Len;
        if (s < turnLen) {
          const ys = ly;
          const ye = nextLy;
          const dirSign = Math.sign(ye - ys) || 1;
          const straightLen = Math.max(0, Math.abs(ye - ys) - 2 * r);

          let dx, dy;
          if (s < arcLen) {
            const theta = (s / arcLen) * (Math.PI / 2);
            dx = sideX + sideSign * r * Math.sin(theta);
            dy = ys + dirSign * r * (1 - Math.cos(theta));
          } else if (s < arcLen + straightLen) {
            const ls = s - arcLen;
            dx = sideSign * W;
            dy = ys + dirSign * (r + ls);
          } else {
            const lambda = (s - arcLen - straightLen) / arcLen;
            dx = sideX + sideSign * r * Math.cos(lambda * Math.PI / 2);
            dy = (ye - dirSign * r) + dirSign * r * Math.sin(lambda * Math.PI / 2);
          }
          return { x: cx + flipX * dx, y: cy + dy };
        }
        s -= turnLen;
      }
      return { x: cx, y: cy };
    },

    'fig8-h': (t, item, vp, ctx) => {
      // True figure-8 from two tangent circles, side by side. Distinct
      // from infinity-h (which is a Lissajous lemniscate). The two
      // circles share a vertical tangent at the origin, so the ball
      // crosses twice per cycle moving along ±y — and the traversal is
      // smooth at every crossing (no cusp).
      const m = ctx.config.ballSize / 2;
      const r = Math.max(1, Math.min((vp.w - 2 * m - 16) / 4, (vp.h - 2 * m - 16) / 2));
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const sign = item.direction === 'ccw' ? -1 : 1;
      const half = t < 0.5 ? 0 : 1;
      const u = (t - 0.5 * half) * 2;
      let dx, dy;
      if (half === 0) {
        // Right lobe (center (+r, 0)); origin = angle π of that circle.
        const a = Math.PI - sign * TAU * u;
        dx = r + r * Math.cos(a);
        dy = r * Math.sin(a);
      } else {
        // Left lobe (center (-r, 0)); origin = angle 0.
        const a = sign * TAU * u;
        dx = -r + r * Math.cos(a);
        dy = r * Math.sin(a);
      }
      return { x: cx + dx, y: cy + dy };
    },

    'fig8-v': (t, item, vp, ctx) => {
      // True figure-8 from two tangent circles, stacked. Distinct from
      // infinity-v. Shared horizontal tangent at the origin; the ball
      // crosses twice per cycle moving along ±x. Smooth at all crossings.
      const m = ctx.config.ballSize / 2;
      const r = Math.max(1, Math.min((vp.w - 2 * m - 16) / 2, (vp.h - 2 * m - 16) / 4));
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const sign = item.direction === 'ccw' ? -1 : 1;
      const half = t < 0.5 ? 0 : 1;
      const u = (t - 0.5 * half) * 2;
      let dx, dy;
      if (half === 0) {
        // Top lobe (center (0, -r)); origin = angle π/2 of that circle.
        const a = Math.PI / 2 - sign * TAU * u;
        dx = r * Math.cos(a);
        dy = -r + r * Math.sin(a);
      } else {
        // Bottom lobe (center (0, +r)); origin = angle -π/2.
        const a = -Math.PI / 2 + sign * TAU * u;
        dx = r * Math.cos(a);
        dy = r + r * Math.sin(a);
      }
      return { x: cx + dx, y: cy + dy };
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
      const { pos, sizeMul } = linearSchedule(t, lingerFrac(item, ctx), ctx);
      return { x: cx + ampX * pos, y: cy + ampY * pos, sizeMul };
    },

    'diag-urbl': (t, item, vp, ctx) => {
      const m = ctx.config.ballSize / 2;
      const ampX = (vp.w - 2 * m) / 2;
      const ampY = (vp.h - 2 * m) / 2;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const { pos, sizeMul } = linearSchedule(t, lingerFrac(item, ctx), ctx);
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

  // ---- Ball-speed normalization ----------------------------------------
  // Each continuous pattern traces a different path length per cycle, so at a
  // fixed cycles-per-second a long path (serpentine) sweeps far faster than a
  // short one (circle). To make the speed dial mean ball pixel-speed instead,
  // baseCycleSec divides the period by periodFactor — the pattern's path
  // length relative to the circle. Lengths are walked once, here, on a fixed
  // 16:9 reference viewport rather than the live one, so the client and the
  // manager mirror derive identical periods and stay frame-synced. Exact on
  // 16:9; other aspect ratios keep a small residual no vp-independent period
  // can remove. The circle is the 1.0 anchor (its feel at a given dial is
  // unchanged). Serpentine's length grows with lanes, so it's keyed per lane.
  const SPEED_REF_VP = { w: 1920, h: 1080 };
  const SPEED_REF_CTX = {
    config: { ballSize: 80, lingerSec: 0 },
    speedMul: 1, repeatIdx: 0, bounceStart: { x: 960, y: 540 },
  };
  function refPathLen(item) {
    const fn = patterns[item.pattern];
    let prev = fn(0, item, SPEED_REF_VP, SPEED_REF_CTX), len = 0;
    for (let i = 1; i <= 4000; i++) {
      const p = fn(i / 4000, item, SPEED_REF_VP, SPEED_REF_CTX);
      len += Math.hypot(p.x - prev.x, p.y - prev.y);
      prev = p;
    }
    return len;
  }
  const PERIOD_FACTOR = (() => {
    const circleLen = refPathLen({ pattern: 'circle' });
    const f = { serpentine: {} };
    for (const name of Object.keys(patterns)) {
      if (name === 'serpentine' || isSequencePattern(name)) continue;
      f[name] = Math.max(1e-3, refPathLen({ pattern: name }) / circleLen);
    }
    for (let n = 2; n <= 8; n++) {
      f.serpentine[n] = Math.max(1e-3, refPathLen({ pattern: 'serpentine', lanes: n }) / circleLen);
    }
    return f;
  })();
  function periodFactor(item) {
    if (item.pattern === 'serpentine') return PERIOD_FACTOR.serpentine[serpentineLanes(item)];
    return PERIOD_FACTOR[item.pattern] ?? 1;
  }

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
