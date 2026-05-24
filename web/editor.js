// editor.js — shared playlist + globals editor.
//
// Mutates the host page's `state.config` in place. The host page wires
// it up once with `init(state, opts)` and then calls `loadConfig()` to
// populate from /api/config. Cross-cutting concerns that touch the host
// page's animation engine (advancing the playing item, jumping by user
// click, resetting field-render state) are exposed as opts callbacks
// so this module stays free of animation knowledge.

(() => {
  'use strict';

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

  let state = null;
  let opts = null;
  let autoSaveTimer = null;

  function init(stateRef, options) {
    state = stateRef;
    opts = {
      onEnterItem: () => {},
      onJump: () => {},
      onFieldReset: () => {},
      onFieldLoopToggle: () => {},
      onSaveCloseEditor: () => {},
      ...(options || {}),
    };
    populateAddPattern();
    wireGlobalControls();
    wireTabHandlers();
    wireFieldHandlers();
    wireSaveRevert();
  }

  // ---- DOM rendering --------------------------------------------------

  function renderPlaylist() {
    const list = document.getElementById('playlist');
    if (!list) return;
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

      const titleBar = node.querySelector('.title-bar');
      titleBar.addEventListener('mousedown', e => {
        if (e.target.closest('.del')) return;
        node.draggable = true;
        document.addEventListener('mouseup', () => { node.draggable = false; }, { once: true });
      });
      titleBar.addEventListener('click', e => {
        if (e.target.closest('.del')) return;
        opts.onJump(+node.dataset.index);
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
  }

  function clearDropIndicators() {
    document.querySelectorAll('#playlist .item.drop-above, #playlist .item.drop-below')
      .forEach(el => el.classList.remove('drop-above', 'drop-below'));
  }

  function reorderItem(fromIdx, insertAt) {
    const arr = state.config.playlist;
    if (fromIdx < 0 || fromIdx >= arr.length) return;
    if (insertAt === fromIdx || insertAt === fromIdx + 1) return;
    const playing = arr[state.itemIdx ?? 0];
    const [moved] = arr.splice(fromIdx, 1);
    const adjusted = insertAt > fromIdx ? insertAt - 1 : insertAt;
    arr.splice(adjusted, 0, moved);
    if (state.itemIdx != null) state.itemIdx = arr.indexOf(playing);
    markDirty();
    renderPlaylist();
  }

  function deleteItem(i) {
    if (state.config.playlist.length <= 1) return;
    state.config.playlist.splice(i, 1);
    if (state.itemIdx != null) {
      if (state.itemIdx >= state.config.playlist.length) {
        opts.onEnterItem(0);
      } else if (state.itemIdx > i) {
        state.itemIdx -= 1;
      } else if (state.itemIdx === i) {
        opts.onEnterItem(state.itemIdx % state.config.playlist.length);
      }
    }
    markDirty();
    renderPlaylist();
  }

  function addItem(pattern) {
    if (!PATTERN_LABELS[pattern]) return;
    const defaults = PATTERN_DEFAULTS[pattern] || {};
    state.config.playlist.push({ pattern, repeats: 3, ...defaults });
    markDirty();
    renderPlaylist();
  }

  function populateAddPattern() {
    const sel = document.getElementById('add-pattern');
    if (!sel) return;
    // Defensive: don't double-populate if init is called twice.
    if (sel.options.length > 1) return;
    Object.entries(PATTERN_LABELS).forEach(([key, label]) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = label;
      sel.appendChild(opt);
    });
  }

  // ---- Dirty / save state --------------------------------------------

  function markDirty() {
    state.dirty = true;
    const el = document.getElementById('save-status');
    if (el) el.textContent = '● unsaved';
  }
  function markClean() {
    state.dirty = false;
    const el = document.getElementById('save-status');
    if (!el) return;
    el.textContent = 'saved';
    setTimeout(() => { if (!state.dirty) el.textContent = ''; }, 1500);
  }

  // ---- Load / save / replace ------------------------------------------

  async function loadConfig() {
    const r = await fetch('/config', { cache: 'no-store' });
    if (!r.ok) throw new Error('load config: ' + r.status);
    state.config = await r.json();
    opts.onEnterItem(0);
    syncFromConfig();
  }

  // applyConfig is called when an external source replaces the config
  // (e.g. a set-config push from a manager). Same end-state as
  // loadConfig but without the fetch.
  function applyConfig(newCfg) {
    state.config = newCfg;
    opts.onEnterItem(0);
    syncFromConfig();
  }

  function syncFromConfig() {
    setVal('bg-color', state.config.background || '#000000');
    setVal('ball-size', state.config.ballSize);
    setVal('speed-input', state.config.speed);
    setVal('linger-input', state.config.lingerSec);
    setVal('linger-lead-input', state.config.lingerLeadFrac ?? 0);
    if (state.config.field) {
      setVal('field-speed-input', state.config.field.speed ?? 3);
      setVal('field-palette-input', state.config.field.palette || 'Happy');
      setVal('field-shape-input', state.config.field.shape || 'circles');
      setChecked('field-shuffle-input', !!state.config.field.shuffleColors);
      setChecked('field-loop-input', !!state.config.field.loop);
      setVal('field-duration-input', state.config.field.shapeDurationSec ?? 12);
    }
    updateRegenVisibility();
    applyMode(state.config.mode || 'balls');
    renderPlaylist();
  }

  function setVal(id, v) {
    const el = document.getElementById(id);
    if (el && v !== undefined) el.value = v;
  }
  function setChecked(id, v) {
    const el = document.getElementById(id);
    if (el) el.checked = v;
  }

  function scheduleAutoSave() {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(autoSave, 300);
  }
  async function autoSave() {
    try {
      const r = await fetch('/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Zoetrope': '1' },
        body: JSON.stringify(state.config),
      });
      if (!r.ok) { console.warn('autosave failed:', r.status); return; }
      markClean();
    } catch (err) {
      console.warn('autosave failed:', err);
    }
  }

  async function saveConfig() {
    try {
      const r = await fetch('/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Zoetrope': '1' },
        body: JSON.stringify(state.config),
      });
      if (!r.ok) {
        const el = document.getElementById('save-status');
        if (el) el.textContent = 'save failed (' + r.status + ')';
        return;
      }
      markClean();
      opts.onSaveCloseEditor();
    } catch (err) {
      console.error('save failed:', err);
      const el = document.getElementById('save-status');
      if (el) el.textContent = 'save failed: ' + err.message + ' — server moved? try refreshing the page';
    }
  }

  // ---- Mode toggle + field visibility --------------------------------

  function updateRegenVisibility() {
    const f = state.config.field || {};
    const usesRandom = f.shape === 'random' || !!f.shuffleColors;
    const el = document.getElementById('field-shape-regen');
    if (el) el.style.display = usesRandom ? '' : 'none';
  }

  function ensureRandomSeed() {
    if (!state.config.field) return;
    if (!state.config.field.randomSeed) {
      state.config.field.randomSeed = (Math.random() * 0x7fffffff) | 0;
    }
  }

  function applyMode(mode) {
    state.config.mode = mode;
    document.body.classList.toggle('mode-balls', mode === 'balls');
    document.body.classList.toggle('mode-field', mode === 'field');
    const tb = document.getElementById('tab-balls');
    const tf = document.getElementById('tab-field');
    if (tb) tb.classList.toggle('active', mode === 'balls');
    if (tf) tf.classList.toggle('active', mode === 'field');
    if (mode === 'field') {
      opts.onFieldReset();
      opts.onSaveCloseEditor();
    }
  }

  // ---- Wiring ---------------------------------------------------------

  function wireGlobalControls() {
    bindInput('bg-color', e => { state.config.background = e.target.value; markDirty(); });
    bindInput('ball-size', e => { state.config.ballSize = +e.target.value; markDirty(); });
    bindInput('speed-input', e => { state.config.speed = +e.target.value; markDirty(); });
    bindInput('linger-input', e => { state.config.lingerSec = +e.target.value; markDirty(); });
    bindInput('linger-lead-input', e => { state.config.lingerLeadFrac = +e.target.value; markDirty(); });
  }

  function wireTabHandlers() {
    const tb = document.getElementById('tab-balls');
    const tf = document.getElementById('tab-field');
    if (tb) tb.addEventListener('click', () => {
      if (state.config.mode === 'balls') return;
      applyMode('balls');
      markDirty();
      scheduleAutoSave();
    });
    if (tf) tf.addEventListener('click', () => {
      if (state.config.mode === 'field') return;
      applyMode('field');
      markDirty();
      scheduleAutoSave();
    });
  }

  function wireFieldHandlers() {
    if (!state.config?.field && !document.getElementById('field-speed-input')) return;
    bindInput('field-speed-input', e => {
      ensureField();
      state.config.field.speed = +e.target.value;
      markDirty();
      scheduleAutoSave();
    });
    bindChange('field-palette-input', e => {
      ensureField();
      state.config.field.palette = e.target.value;
      markDirty();
      scheduleAutoSave();
    });
    bindChange('field-shape-input', e => {
      ensureField();
      state.config.field.shape = e.target.value;
      if (e.target.value === 'random') ensureRandomSeed();
      updateRegenVisibility();
      opts.onFieldReset();
      markDirty();
      scheduleAutoSave();
    });
    bindChange('field-shuffle-input', e => {
      ensureField();
      state.config.field.shuffleColors = e.target.checked;
      if (e.target.checked) ensureRandomSeed();
      updateRegenVisibility();
      opts.onFieldReset();
      markDirty();
      scheduleAutoSave();
    });
    bindClick('field-shape-regen', () => {
      ensureField();
      state.config.field.randomSeed = (Math.random() * 0x7fffffff) | 0;
      opts.onFieldReset();
      markDirty();
      scheduleAutoSave();
    });
    bindChange('field-loop-input', e => {
      ensureField();
      state.config.field.loop = e.target.checked;
      opts.onFieldLoopToggle(e.target.checked);
      markDirty();
      scheduleAutoSave();
    });
    bindInput('field-duration-input', e => {
      ensureField();
      state.config.field.shapeDurationSec = +e.target.value;
      markDirty();
      scheduleAutoSave();
    });
  }

  function ensureField() {
    if (!state.config.field) state.config.field = {};
  }

  function wireSaveRevert() {
    const sel = document.getElementById('add-pattern');
    if (sel) sel.addEventListener('change', e => {
      if (!e.target.value) return;
      addItem(e.target.value);
      e.target.value = '';
    });
    bindClick('btn-save', saveConfig);
    bindClick('btn-revert', () => loadConfig().then(markClean));
  }

  function bindInput(id, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', fn);
  }
  function bindChange(id, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', fn);
  }
  function bindClick(id, fn) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  }

  window.zoetropeEditor = {
    init,
    loadConfig,
    applyConfig,
    renderPlaylist,
    markClean,
    PATTERN_LABELS,
    PATTERN_DEFAULTS,
  };
})();
