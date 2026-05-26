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
    'h-sweep':          'Horizontal sweep',
    'v-sweep':          'Vertical sweep',
    'diag-ulbr':        'Diagonal ↘ (UL↔BR)',
    'diag-urbl':        'Diagonal ↙ (UR↔BL)',
    'bounce':           'Bounce',
    'circle':           'Circle',
    'infinity-h':       'Infinity ∞',
    'infinity-v':       'Infinity 8 (vertical)',
    'position-sequence':'Position sequence',
  };
  const PATTERN_DEFAULTS = {
    'h-sweep':          { color: '#f5e0dc' },
    'v-sweep':          { color: '#f9e2af' },
    'diag-ulbr':        { color: '#fab387' },
    'diag-urbl':        { color: '#eba0ac' },
    'bounce':           { color: '#f38ba8', angleDeg: 37 },
    'circle':           { color: '#a6e3a1', direction: 'cw' },
    'infinity-h':       { color: '#89b4fa', direction: 'cw' },
    'infinity-v':       { color: '#cba6f7', direction: 'cw' },
    'position-sequence':{
      color: '#b4befe', dwellSec: 1.5, transitSec: 0.8,
      steps: [{ position: 'center' }, { position: 'lateral-l' }, { position: 'center' }, { position: 'lateral-r' }],
    },
  };
  const POSITION_KEYS = ['center', 'up', 'up-l', 'up-r', 'lateral-l', 'lateral-r', 'down', 'down-l', 'down-r'];
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
      onConfirm: (msg, fn) => { if (window.confirm(msg)) fn(); },
      ...(options || {}),
    };
    populateAddPattern();
    wireGlobalControls();
    wireTabHandlers();
    wireFieldHandlers();
    wirePlaylistLibrary();
    wireSaveRevert();
  }

  // currentPlaylist resolves state.config.activePlaylist against the
  // library; falls back to playlists[0] when the active name is missing
  // (renamed, deleted, or never set) so the engine always has something
  // to render. Returns undefined only when the library itself is empty.
  function currentPlaylist() {
    const cfg = state?.config;
    const playlists = cfg?.playlists || [];
    return playlists.find(p => p.name === cfg?.activePlaylist) || playlists[0];
  }
  function currentItems() {
    return currentPlaylist()?.items || [];
  }

  // ---- DOM rendering --------------------------------------------------

  function renderPlaylist() {
    const list = document.getElementById('playlist');
    if (!list) return;
    list.innerHTML = '';
    const tmpl = document.getElementById('item-template');
    currentItems().forEach((item, i) => {
      const node = tmpl.content.firstElementChild.cloneNode(true);
      node.dataset.pattern = item.pattern;
      node.dataset.index = String(i);
      const nameEl = node.querySelector('.pattern-name');
      nameEl.textContent = item.name || PATTERN_LABELS[item.pattern] || item.pattern;
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

      if (item.pattern === 'position-sequence') {
        wireSequenceEditor(node, item, nameEl);
      }

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

  function wireSequenceEditor(node, item, nameEl) {
    const nameInput = node.querySelector('.iemt-name');
    const dwellInput = node.querySelector('.dwell-sec');
    const transitInput = node.querySelector('.transit-sec');
    if (nameInput) {
      nameInput.value = item.name || '';
      nameInput.addEventListener('input', e => {
        const v = e.target.value.trim();
        if (v) item.name = v; else delete item.name;
        nameEl.textContent = item.name || PATTERN_LABELS[item.pattern];
        markDirty();
      });
    }
    if (dwellInput) {
      dwellInput.value = item.dwellSec ?? 1.5;
      dwellInput.addEventListener('input', e => { item.dwellSec = +e.target.value; markDirty(); });
    }
    if (transitInput) {
      transitInput.value = item.transitSec ?? 0.8;
      transitInput.addEventListener('input', e => { item.transitSec = +e.target.value; markDirty(); });
    }
    renderSteps(node, item);
    const addSel = node.querySelector('.add-step');
    if (addSel) {
      populatePositionSelect(addSel, '+ Position…', null);
      addSel.addEventListener('change', e => {
        if (!e.target.value) return;
        if (!item.steps) item.steps = [];
        item.steps.push({ position: e.target.value });
        markDirty();
        renderSteps(node, item);
        e.target.value = '';
      });
    }
  }

  function renderSteps(node, item) {
    const list = node.querySelector('.step-list');
    if (!list) return;
    list.innerHTML = '';
    const steps = item.steps || [];
    steps.forEach((step, i) => {
      const li = document.createElement('li');
      li.className = 'step';

      const sel = document.createElement('select');
      sel.className = 'step-pos';
      populatePositionSelect(sel, null, step.position);
      sel.addEventListener('change', e => { step.position = e.target.value; markDirty(); });
      li.appendChild(sel);

      li.appendChild(makeStepBtn('↑', 'Move up', i === 0, () => {
        [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
        markDirty();
        renderSteps(node, item);
      }));
      li.appendChild(makeStepBtn('↓', 'Move down', i === steps.length - 1, () => {
        [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]];
        markDirty();
        renderSteps(node, item);
      }));
      li.appendChild(makeStepBtn('×', 'Remove step', false, () => {
        steps.splice(i, 1);
        markDirty();
        renderSteps(node, item);
      }, 'step-del'));

      list.appendChild(li);
    });
  }

  function makeStepBtn(text, title, disabled, fn, extraClass) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    if (extraClass) b.className = extraClass;
    if (disabled) b.disabled = true;
    b.addEventListener('click', fn);
    return b;
  }

  function populatePositionSelect(sel, placeholder, selected) {
    sel.innerHTML = '';
    if (placeholder) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = placeholder; opt.disabled = true; opt.selected = true;
      sel.appendChild(opt);
    }
    for (const key of POSITION_KEYS) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = POSITION_LABELS[key];
      if (key === selected) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function reorderItem(fromIdx, insertAt) {
    const pl = currentPlaylist();
    if (!pl) return;
    const arr = pl.items;
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
    const pl = currentPlaylist();
    if (!pl) return;
    pl.items.splice(i, 1);
    if (state.itemIdx != null) {
      if (state.itemIdx >= pl.items.length) {
        opts.onEnterItem(0);
      } else if (state.itemIdx > i) {
        state.itemIdx -= 1;
      } else if (state.itemIdx === i) {
        opts.onEnterItem(pl.items.length === 0 ? 0 : state.itemIdx % pl.items.length);
      }
    }
    markDirty();
    renderPlaylist();
  }

  function addItem(pattern) {
    if (!PATTERN_LABELS[pattern]) return;
    const pl = currentPlaylist();
    if (!pl) return;
    const defaults = PATTERN_DEFAULTS[pattern] || {};
    pl.items.push({ pattern, repeats: 3, ...defaults });
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

  // ---- Playlist library (picker + CRUD) -------------------------------

  let libraryEditMode = null; // 'new' | 'rename' | null

  function renderPlaylistLibrary() {
    const sel = document.getElementById('playlist-picker');
    if (!sel) return;
    sel.innerHTML = '';
    const playlists = state.config.playlists || [];
    // Group by category, preserving first-appearance order so the picker
    // shows whatever order Dan has the library in rather than alphabetical.
    const order = [];
    const groups = new Map();
    for (const pl of playlists) {
      const cat = pl.category || 'Other';
      if (!groups.has(cat)) { groups.set(cat, []); order.push(cat); }
      groups.get(cat).push(pl);
    }
    for (const cat of order) {
      const grp = document.createElement('optgroup');
      grp.label = cat;
      for (const pl of groups.get(cat)) {
        const opt = document.createElement('option');
        opt.value = pl.name;
        opt.textContent = pl.name;
        if (pl.name === state.config.activePlaylist) opt.selected = true;
        grp.appendChild(opt);
      }
      sel.appendChild(grp);
    }
    const del = document.getElementById('lib-del');
    if (del) del.disabled = playlists.length <= 1;
  }

  function distinctCategories() {
    const set = new Set();
    for (const pl of state.config.playlists || []) {
      if (pl.category) set.add(pl.category);
    }
    return [...set];
  }

  function populateCategorySelect(sel, selectedCategory) {
    sel.innerHTML = '';
    for (const cat of distinctCategories()) {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      if (cat === selectedCategory) opt.selected = true;
      sel.appendChild(opt);
    }
    const opt = document.createElement('option');
    opt.value = '__new__';
    opt.textContent = '+ New category…';
    sel.appendChild(opt);
  }

  // uniquePlaylistName resolves rename/new collisions by suffixing
  // " (2)", " (3)" until free. `exclude` is the playlist being renamed
  // (so it doesn't collide with itself); pass null for new-playlist.
  function uniquePlaylistName(name, exclude) {
    const taken = new Set();
    for (const pl of state.config.playlists || []) {
      if (pl !== exclude) taken.add(pl.name);
    }
    if (!taken.has(name)) return name;
    for (let n = 2; ; n++) {
      const candidate = `${name} (${n})`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  function openLibraryEdit(mode) {
    libraryEditMode = mode;
    const box = document.getElementById('library-edit');
    if (!box) return;
    const nameInput = document.getElementById('lib-name');
    const catSel = document.getElementById('lib-category');
    const cur = currentPlaylist();
    if (mode === 'rename' && cur) {
      nameInput.value = cur.name;
      populateCategorySelect(catSel, cur.category);
    } else {
      nameInput.value = '';
      populateCategorySelect(catSel, cur?.category || 'Custom');
    }
    box.classList.remove('hidden');
    nameInput.focus();
    nameInput.select();
  }

  function closeLibraryEdit() {
    libraryEditMode = null;
    const box = document.getElementById('library-edit');
    if (box) box.classList.add('hidden');
  }

  function applyLibraryEdit() {
    if (!libraryEditMode) return;
    const name = (document.getElementById('lib-name').value || '').trim();
    if (!name) return;
    const catSel = document.getElementById('lib-category');
    let category = catSel.value;
    if (category === '__new__') {
      const nc = (window.prompt('New category name:') || '').trim();
      if (!nc) return;
      category = nc;
    }
    if (libraryEditMode === 'new') {
      const unique = uniquePlaylistName(name, null);
      state.config.playlists.push({ name: unique, category, items: [] });
      state.config.activePlaylist = unique;
    } else if (libraryEditMode === 'rename') {
      const cur = currentPlaylist();
      if (!cur) return;
      const unique = uniquePlaylistName(name, cur);
      cur.name = unique;
      cur.category = category;
      state.config.activePlaylist = unique;
    }
    markDirty();
    closeLibraryEdit();
    renderPlaylistLibrary();
    renderPlaylist();
    opts.onEnterItem(0);
  }

  function duplicatePlaylist() {
    const cur = currentPlaylist();
    if (!cur) return;
    const name = uniquePlaylistName(`${cur.name} (copy)`, null);
    state.config.playlists.push({
      name,
      category: cur.category,
      items: JSON.parse(JSON.stringify(cur.items || [])),
    });
    state.config.activePlaylist = name;
    markDirty();
    renderPlaylistLibrary();
    renderPlaylist();
    opts.onEnterItem(0);
  }

  function deletePlaylist() {
    const playlists = state.config.playlists || [];
    if (playlists.length <= 1) return;
    const cur = currentPlaylist();
    if (!cur) return;
    opts.onConfirm(`Delete playlist "${cur.name}"?`, () => {
      const idx = playlists.indexOf(cur);
      playlists.splice(idx, 1);
      state.config.activePlaylist = playlists[0].name;
      markDirty();
      renderPlaylistLibrary();
      renderPlaylist();
      opts.onEnterItem(0);
    });
  }

  function wirePlaylistLibrary() {
    bindChange('playlist-picker', e => {
      state.config.activePlaylist = e.target.value;
      markDirty();
      renderPlaylist();
      opts.onEnterItem(0);
    });
    bindClick('lib-new', () => openLibraryEdit('new'));
    bindClick('lib-rename', () => openLibraryEdit('rename'));
    bindClick('lib-dup', duplicatePlaylist);
    bindClick('lib-del', deletePlaylist);
    bindClick('lib-ok', applyLibraryEdit);
    bindClick('lib-cancel', closeLibraryEdit);
    const nameInput = document.getElementById('lib-name');
    if (nameInput) {
      nameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); applyLibraryEdit(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeLibraryEdit(); }
      });
    }
    const catSel = document.getElementById('lib-category');
    if (catSel) {
      catSel.addEventListener('change', e => {
        if (e.target.value !== '__new__') return;
        const nc = (window.prompt('New category name:') || '').trim();
        if (!nc) { populateCategorySelect(catSel, currentPlaylist()?.category); return; }
        const opt = document.createElement('option');
        opt.value = nc;
        opt.textContent = nc;
        catSel.insertBefore(opt, catSel.querySelector('option[value="__new__"]'));
        opt.selected = true;
      });
    }
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
    setChecked('show-position-labels', !!state.config.showPositionLabels);
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
    closeLibraryEdit();
    renderPlaylistLibrary();
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
    bindChange('show-position-labels', e => { state.config.showPositionLabels = e.target.checked; markDirty(); });
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
