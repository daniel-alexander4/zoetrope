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
  // Each pattern is a pure function (t, item, vp) -> {x, y}, where
  // t in [0, 1) represents one full cycle. cx, cy = canvas center.
  // margin keeps the ball inside the visible area.

  const patterns = {
    'h-sweep': (t, item, vp) => {
      const m = state.config.ballSize / 2;
      const amp = (vp.w - 2 * m) / 2;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const pos = -Math.cos(TAU * t);
      return { x: cx + amp * pos, y: cy };
    },

    'v-sweep': (t, item, vp) => {
      const m = state.config.ballSize / 2;
      const amp = (vp.h - 2 * m) / 2;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const pos = -Math.cos(TAU * t);
      return { x: cx, y: cy + amp * pos };
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
      const pos = -Math.cos(TAU * t);
      return { x: cx + ampX * pos, y: cy + ampY * pos };
    },

    'diag-urbl': (t, item, vp) => {
      // Upper-right ↔ bottom-left diagonal sweep.
      const m = state.config.ballSize / 2;
      const ampX = (vp.w - 2 * m) / 2;
      const ampY = (vp.h - 2 * m) / 2;
      const cx = vp.w / 2;
      const cy = vp.h / 2;
      const pos = -Math.cos(TAU * t);
      return { x: cx - ampX * pos, y: cy + ampY * pos };
    },

    'bounce': (t, item, vp) => {
      // t spans one "cycle"; in one cycle the ball travels max(w,h) of
      // unfolded distance. Reflections folded via triangle wave.
      const m = state.config.ballSize / 2;
      const innerW = vp.w - 2 * m;
      const innerH = vp.h - 2 * m;
      const speed = Math.max(vp.w, vp.h); // per cycle
      const angle = ((item.angleDeg ?? 37) * Math.PI) / 180;
      const dx = Math.cos(angle) * speed * t;
      const dy = Math.sin(angle) * speed * t;
      // Cumulative time elapsed within the current item should be
      // (repeatIdx + t) * 1 (one cycle worth of unfolded travel). The
      // caller advances repeatIdx, but for bounce we want the path to be
      // continuous across repeats. So we use a "total t" derived from
      // state.repeatIdx + t.
      const totalT = (state.repeatIdx + t);
      const ux = Math.cos(angle) * speed * totalT;
      const uy = Math.sin(angle) * speed * totalT;
      const x = state.bounceStart.x + ux - m;
      const y = state.bounceStart.y + uy - m;
      return {
        x: triangleFold(x, innerW) + m,
        y: triangleFold(y, innerH) + m,
      };
      // dx/dy unused but kept above for clarity of derivation
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
    const cps = (Math.max(0, state.config.speed ?? 5) / 10) * state.speedMul;
    state.t += dt * cps;
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
    const { x, y } = fn(state.t, item, vp);

    ctx.beginPath();
    ctx.arc(x, y, (state.config.ballSize || 24) / 2, 0, TAU);
    ctx.fillStyle = item.color || '#fff';
    ctx.fill();
  }

  function frame(nowMs) {
    if (!state.lastFrameMs) state.lastFrameMs = nowMs;
    const dt = (nowMs - state.lastFrameMs) / 1000;
    state.lastFrameMs = nowMs;
    if (state.playing) advance(dt);
    render();
    updateNowPlaying();
    updatePlayingHighlight();
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
    if (!state.config.ballSize) state.config.ballSize = 24;
    if (state.config.speed == null) state.config.speed = 5;
    enterItem(0);
    document.getElementById('bg-color').value = state.config.background || '#000000';
    document.getElementById('ball-size').value = state.config.ballSize;
    document.getElementById('speed-input').value = state.config.speed;
    renderEditor();
  }

  async function saveConfig() {
    try {
      const r = await fetch('/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
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
      document.getElementById('save-status').textContent = 'save failed: ' + err.message;
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
  });

  loadConfig().then(() => {
    play();
    requestAnimationFrame(frame);
  }).catch(err => {
    console.error(err);
    document.body.innerText = 'Failed to load config: ' + err.message;
  });
})();
