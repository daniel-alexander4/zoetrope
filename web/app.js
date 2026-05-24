(() => {
  'use strict';

  const TAU = Math.PI * 2;

  const PATTERN_LABELS = {
    'h-sweep':    'Horizontal sweep',
    'v-sweep':    'Vertical sweep',
    'diag-ulbr':  'Diagonal ↘ (UL↔BR)',
    'diag-urbl':  'Diagonal ↙ (UR↔BL)',
    'bounce':     'Bounce',
    'circle':     'Circle',
    'infinity-h': 'Infinity ∞',
    'infinity-v': 'Infinity 8 (vertical)',
  };

  const PATTERN_DEFAULTS = {
    'h-sweep':    { color: '#f5e0dc' },
    'v-sweep':    { color: '#f9e2af' },
    'diag-ulbr':  { color: '#fab387' },
    'diag-urbl':  { color: '#eba0ac' },
    'bounce':     { color: '#f38ba8', angleDeg: 37 },
    'circle':     { color: '#a6e3a1', direction: 'cw' },
    'infinity-h': { color: '#89b4fa', direction: 'cw' },
    'infinity-v': { color: '#cba6f7', direction: 'cw' },
  };

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
  };

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
  // L is the fraction of one cycle taken by *each* linger phase.
  function linearSchedule(t, L) {
    if (L <= 0 || L >= 0.5) {
      return { pos: -Math.cos(TAU * t), sizeMul: 1 };
    }
    const half = (1 - 2 * L) / 2; // each moving phase fraction
    if (t < half) {
      const u = t / half;
      return { pos: -Math.cos(Math.PI * u), sizeMul: 1 };
    }
    if (t < half + L) {
      const u = (t - half) / L;
      return { pos: 1, sizeMul: 1 + (LINGER_PEAK - 1) * Math.sin(Math.PI * u) };
    }
    if (t < 2 * half + L) {
      const u = (t - half - L) / half;
      return { pos: Math.cos(Math.PI * u), sizeMul: 1 };
    }
    const u = (t - 2 * half - L) / L;
    return { pos: -1, sizeMul: 1 + (LINGER_PEAK - 1) * Math.sin(Math.PI * u) };
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
    // Speed is on a 0-10 user scale; 10 = 1 cycle/sec.
    // Nullish coalescing (??) — `|| 5` would treat speed=0 as the default.
    const cps = (Math.max(0, state.config.speed ?? 2) / 10) * state.speedMul;
    if (cps <= 0) return;
    // Linger extends each cycle by 2 * lingerSec on linear patterns —
    // the moving-portion pace stays constant regardless of dwell time.
    const linger = state.config.lingerSec ?? 0;
    const baseCycle = 1 / cps;
    const cycleSec = isLinearPattern(item.pattern) && linger > 0
      ? baseCycle + 2 * linger
      : baseCycle;
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
    const { x, y, sizeMul = 1 } = fn(state.t, item, vp);

    ctx.beginPath();
    ctx.arc(x, y, (state.config.ballSize || 80) / 2 * sizeMul, 0, TAU);
    ctx.fillStyle = item.color || '#fff';
    ctx.fill();
  }

  let lastHighlightIdx = -1;
  function frame(nowMs) {
    if (!state.lastFrameMs) state.lastFrameMs = nowMs;
    const dt = (nowMs - state.lastFrameMs) / 1000;
    state.lastFrameMs = nowMs;
    if (state.playing) advance(dt);
    render();
    updateNowPlaying();
    if (state.itemIdx !== lastHighlightIdx) {
      updatePlayingHighlight();
      lastHighlightIdx = state.itemIdx;
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
  function stop() { pause(); seekPlaylistStart(); }
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

  // ---- Editor -----------------------------------------------------------

  function renderEditor() {
    const list = document.getElementById('playlist');
    list.innerHTML = '';
    const tmpl = document.getElementById('item-template');
    state.config.playlist.forEach((item, i) => {
      const node = tmpl.content.firstElementChild.cloneNode(true);
      node.dataset.pattern = item.pattern;
      node.dataset.index = String(i);
      node.querySelector('.pattern-name').textContent = PATTERN_LABELS[item.pattern] || item.pattern;
      node.querySelector('.color').value = item.color || '#ffffff';
      node.querySelector('.repeats').value = item.repeats ?? 1;
      node.querySelector('.direction').value = item.direction || 'cw';
      node.querySelector('.angle').value = item.angleDeg ?? 37;

      node.querySelector('.color').addEventListener('input', e => {
        item.color = e.target.value;
        markDirty();
      });
      node.querySelector('.repeats').addEventListener('input', e => {
        item.repeats = +e.target.value;
        markDirty();
      });
      node.querySelector('.direction').addEventListener('change', e => {
        item.direction = e.target.value;
        markDirty();
      });
      node.querySelector('.angle').addEventListener('input', e => {
        item.angleDeg = +e.target.value;
        markDirty();
      });

      // Drag-to-reorder: title bar activates the LI's draggable state on
      // mousedown so inputs inside the body row remain freely interactive.
      // A one-shot mouseup listener resets draggable in case the user
      // clicks without actually dragging.
      const titleBar = node.querySelector('.title-bar');
      titleBar.addEventListener('mousedown', e => {
        if (e.target.closest('.del')) return;  // don't drag when clicking ×
        node.draggable = true;
        document.addEventListener('mouseup', () => { node.draggable = false; }, { once: true });
      });
      titleBar.addEventListener('click', e => {
        if (e.target.closest('.del')) return;  // delete handles its own click
        jumpToItem(+node.dataset.index);
      });

      node.addEventListener('dragstart', e => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', node.dataset.index);
        node.classList.add('dragging');
      });
      node.addEventListener('dragend', () => {
        node.classList.remove('dragging');
        node.draggable = false;
        clearDropIndicators();
      });
      node.addEventListener('dragover', e => {
        if (node.classList.contains('dragging')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = node.getBoundingClientRect();
        const above = (e.clientY - rect.top) < rect.height / 2;
        clearDropIndicators();
        node.classList.add(above ? 'drop-above' : 'drop-below');
      });
      node.addEventListener('dragleave', e => {
        if (!node.contains(e.relatedTarget)) {
          node.classList.remove('drop-above', 'drop-below');
        }
      });
      node.addEventListener('drop', e => {
        e.preventDefault();
        const fromIdx = +e.dataTransfer.getData('text/plain');
        const toIdx = +node.dataset.index;
        const rect = node.getBoundingClientRect();
        const above = (e.clientY - rect.top) < rect.height / 2;
        reorderItem(fromIdx, above ? toIdx : toIdx + 1);
      });

      node.querySelector('.del').addEventListener('click', () => deleteItem(i));

      list.appendChild(node);
    });
    updatePlayingHighlight();
  }

  function clearDropIndicators() {
    document.querySelectorAll('#playlist .item.drop-above, #playlist .item.drop-below')
      .forEach(el => el.classList.remove('drop-above', 'drop-below'));
  }

  function reorderItem(fromIdx, insertAt) {
    const arr = state.config.playlist;
    if (fromIdx < 0 || fromIdx >= arr.length) return;
    if (insertAt === fromIdx || insertAt === fromIdx + 1) return;
    const playing = arr[state.itemIdx];
    const [moved] = arr.splice(fromIdx, 1);
    const adjusted = insertAt > fromIdx ? insertAt - 1 : insertAt;
    arr.splice(adjusted, 0, moved);
    state.itemIdx = arr.indexOf(playing);
    markDirty();
    renderEditor();
  }

  function deleteItem(i) {
    if (state.config.playlist.length <= 1) return;
    state.config.playlist.splice(i, 1);
    if (state.itemIdx >= state.config.playlist.length) {
      enterItem(0);
    } else if (state.itemIdx > i) {
      state.itemIdx -= 1;
    } else if (state.itemIdx === i) {
      enterItem(state.itemIdx % state.config.playlist.length);
    }
    markDirty();
    renderEditor();
  }

  function addItem(pattern) {
    if (!PATTERN_LABELS[pattern]) return;
    const defaults = PATTERN_DEFAULTS[pattern] || {};
    state.config.playlist.push({
      pattern,
      repeats: 3,
      ...defaults,
    });
    markDirty();
    renderEditor();
  }

  function populateAddPattern() {
    const sel = document.getElementById('add-pattern');
    Object.entries(PATTERN_LABELS).forEach(([key, label]) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = label;
      sel.appendChild(opt);
    });
  }

  function markDirty() {
    state.dirty = true;
    document.getElementById('save-status').textContent = '● unsaved';
  }

  function markClean() {
    state.dirty = false;
    document.getElementById('save-status').textContent = 'saved';
    setTimeout(() => {
      if (!state.dirty) document.getElementById('save-status').textContent = '';
    }, 1500);
  }

  async function loadConfig() {
    const r = await fetch('/config', { cache: 'no-store' });
    if (!r.ok) throw new Error('load config: ' + r.status);
    state.config = await r.json();
    enterItem(0);
    document.getElementById('bg-color').value = state.config.background || '#000000';
    document.getElementById('ball-size').value = state.config.ballSize;
    document.getElementById('speed-input').value = state.config.speed;
    document.getElementById('linger-input').value = state.config.lingerSec;
    renderEditor();
  }

  async function saveConfig() {
    try {
      const r = await fetch('/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Zoetrope': '1',
        },
        body: JSON.stringify(state.config),
      });
      if (!r.ok) {
        document.getElementById('save-status').textContent = 'save failed (' + r.status + ')';
        return;
      }
      markClean();
      document.getElementById('editor').classList.add('hidden');
      hideHud();
    } catch (err) {
      console.error('save failed:', err);
      document.getElementById('save-status').textContent =
        'save failed: ' + err.message + ' — server moved? try refreshing the page';
    }
  }

  // ---- Wiring -----------------------------------------------------------

  document.getElementById('btn-pl-start').addEventListener('click', seekPlaylistStart);
  document.getElementById('btn-pat-start').addEventListener('click', seekPatternStart);
  document.getElementById('btn-play').addEventListener('click', togglePlay);
  document.getElementById('btn-stop').addEventListener('click', stop);
  document.getElementById('btn-next').addEventListener('click', nextPattern);
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
      closeTimer = setTimeout(() => {
        if (!state.dirty) editor.classList.add('hidden');
      }, 500);
    });
    editor.addEventListener('mouseenter', () => {
      clearTimeout(closeTimer);
    });
  }
  populateAddPattern();
  document.getElementById('add-pattern').addEventListener('change', e => {
    if (!e.target.value) return;
    addItem(e.target.value);
    e.target.value = '';
  });
  document.getElementById('btn-save').addEventListener('click', saveConfig);
  document.getElementById('btn-revert').addEventListener('click', () => loadConfig().then(markClean));
  document.getElementById('bg-color').addEventListener('input', e => {
    state.config.background = e.target.value;
    markDirty();
  });
  document.getElementById('ball-size').addEventListener('input', e => {
    state.config.ballSize = +e.target.value;
    markDirty();
  });
  document.getElementById('speed-input').addEventListener('input', e => {
    state.config.speed = +e.target.value;
    markDirty();
  });
  document.getElementById('linger-input').addEventListener('input', e => {
    state.config.lingerSec = +e.target.value;
    markDirty();
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
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowLeft') seekPatternStart();
    if (e.code === 'ArrowRight') nextPattern();
    if (e.code === 'Home') seekPlaylistStart();
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

  loadConfig().then(() => {
    heartbeat();
    play();
    requestAnimationFrame(frame);
  }).catch(err => {
    console.error(err);
    document.body.innerText = 'Failed to load config: ' + err.message;
  });
})();
