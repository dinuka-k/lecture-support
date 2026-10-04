/*
 * Wires the B+ tree model and view to the page: commands, the step timeline and
 * playback, the key tray, drag & drop, side panels and keyboard shortcuts.
 */
(function () {
  'use strict';

  const { BTree, stats } = window.BTreeAlgo;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---------- Preferences (remembered in this browser only) ----------

  const PREFS_KEY = 'lecture-demos.bplustree';
  const prefs = { order: 4, splitBias: 'left', deleteWith: 'predecessor', speed: 1, autoplay: true, sidebar: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY)) || {}); } catch (e) { /* storage unavailable */ }
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

  const el = {
    wrap: $('canvasWrap'),
    caption: $('caption'),
    captionText: $('captionText'),
    rules: $('rules'),
    toast: $('toast'),
    input: $('keyInput'),
    order: $('orderSelect'),
    randomCount: $('randomCount'),
    tray: $('tray'),
    trayBox: $('trayBox'),
    trayInput: $('trayInput'),
    bottom: $('bottomOverlay'),
    viewCtrls: $('viewCtrls'),
    zoneSearch: $('zoneSearch'),
    zoneDelete: $('zoneDelete'),
    zoneDeleteLabel: $('zoneDeleteLabel'),
    stepLog: $('stepLog'),
    stepsTitle: $('stepsTitle'),
    pseudo: $('pseudo'),
    formula: $('formula'),
    biasNote: $('biasNote'),
    play: $('btnPlay'),
    opLabel: $('opLabel'),
    stepLabel: $('stepLabel'),
    queueLabel: $('queueLabel'),
    progress: $('progressFill'),
    speed: $('speed'),
    speedOut: $('speedOut'),
    autoplay: $('autoplay'),
    fit: $('btnFit'),
    help: $('help'),
  };

  // ---------- Model, view, timeline ----------

  const tree = new BTree(prefs.order, prefs);
  let present = []; // keys in the tree, in insertion order — used to rebuild when m changes

  const view = new BPlusView($('canvas'), {
    onKeyDragStart: (key, e) => dragStart(key, 'tree', e),
    onKeyDragMove: (key, e) => dragMove(e),
    onKeyDragEnd: (key, e, cancelled) => dragEnd(e, cancelled),
    onKeyClick: (key) => {
      el.input.value = String(key);
      el.input.classList.remove('flash');
      void el.input.offsetWidth; // restart the animation
      el.input.classList.add('flash');
    },
    onAutoFit: (on) => el.fit.classList.toggle('on', on),
  });

  // All recorded steps, across operations. `cur` is the step on screen (or being animated to).
  const T = { steps: [], ops: [], cur: 0, anim: null, playing: false, holdUntil: 0 };
  const animMs = () => 720 / prefs.speed;
  const holdMs = (step) => (step.status === 'info' ? 650 : 1100) / prefs.speed;

  function stateStep(msg, status = 'info') {
    return {
      op: 'idle', label: '', code: null, tree: tree.snapshot(), msg, status, line: -1,
      nodes: {}, keys: {}, edges: {}, ghost: null, origin: null, into: null,
    };
  }

  function animateTo(from, to) {
    T.anim = from && from !== to ? { from, to, t0: performance.now(), dur: animMs() } : null;
  }

  function go(i) {
    i = clamp(i, 0, T.steps.length - 1);
    if (i === T.cur) return;
    const from = T.steps[T.cur];
    T.cur = i;
    animateTo(from, T.steps[i]);
    refresh();
  }

  function resetTimeline(msg, status) {
    const shown = T.steps[T.cur];
    T.steps = [stateStep(msg, status)];
    T.ops = [];
    T.cur = 0;
    T.playing = false;
    animateTo(shown, T.steps[0]);
    refresh();
  }

  const opAt = (i) => T.ops.find((o) => i >= o.start && i < o.end) || null;

  // Runs an operation on the model now and queues its steps for playback.
  function run(type, key, from, hi) {
    const had = tree.has(key);
    const before = present.slice();
    const steps = type === 'range' ? tree.range(key, hi) : tree[type](key);
    if (from && steps[0].ghost) steps[0].ghost.from = from;
    const has = tree.has(key);
    if (!had && has) present.push(key);
    else if (had && !has) present = present.filter((k) => k !== key);
    if (type === 'insert') trayRemove(key);
    steps.forEach((s) => { if (s.origin) view.inheritOffsets(s.origin); });

    const wasAtEnd = T.cur === T.steps.length - 1;
    const start = T.steps.length;
    T.steps.push(...steps);
    T.ops.push({ type, key, label: steps[0].label, start, end: T.steps.length, before });
    if (prefs.autoplay) T.playing = true;
    else if (wasAtEnd) go(start);
    refresh();
  }

  function undo() {
    const op = T.ops.pop();
    if (!op) return toast('Nothing to undo.');
    const shown = T.steps[T.cur];
    T.steps.length = op.start;
    tree.load(T.steps[op.start - 1].tree);
    present = op.before;
    T.playing = false;
    T.cur = Math.min(T.cur, T.steps.length - 1);
    animateTo(shown, T.steps[T.cur]);
    refresh();
    toast(`Undid “${op.label}”.`);
  }

  // ---------- Playback ----------

  function tick(now) {
    if (T.anim && now - T.anim.t0 >= T.anim.dur) {
      T.anim = null;
      T.holdUntil = now + holdMs(T.steps[T.cur]);
      view.dirty = true;
    }
    if (T.playing && !T.anim && now >= T.holdUntil) {
      if (T.cur < T.steps.length - 1) go(T.cur + 1);
      else {
        T.playing = false;
        refreshPlayer();
      }
    }
  }

  function loop(now) {
    tick(now);
    const src = T.anim
      ? { a: T.anim.from, b: T.anim.to, p: (now - T.anim.t0) / T.anim.dur }
      : { a: null, b: T.steps[T.cur], p: 1 };
    view.draw(src, now, !!T.anim);
    requestAnimationFrame(loop);
  }

  function togglePlay() {
    if (T.playing) {
      T.playing = false;
    } else {
      if (T.cur >= T.steps.length - 1) {
        // At the end: replay the last operation from its first step.
        const op = opAt(T.cur);
        if (!op) return;
        go(op.start);
      }
      T.playing = true;
    }
    refreshPlayer();
  }

  function stepBy(d) {
    T.playing = false;
    go(T.cur + d);
    refreshPlayer();
  }

  function toStart() {
    T.playing = false;
    const op = opAt(T.cur);
    if (!op) return go(0);
    if (T.cur > op.start) return go(op.start);
    const prev = T.ops[T.ops.indexOf(op) - 1];
    go(prev ? prev.start : 0);
  }

  function toEnd() {
    T.playing = false;
    go(T.steps.length - 1);
    refreshPlayer();
  }

  // ---------- Panels ----------

  function refresh() {
    const step = T.steps[T.cur];
    el.caption.dataset.status = step.status;
    el.captionText.textContent = step.msg;
    renderRules(step);
    renderLog();
    renderPseudo(step);
    refreshPlayer();
    view.insets = measureInsets();
    view.dirty = true;
  }

  function renderRules(step) {
    const s = stats(step.tree);
    const min = tree.minKeys;
    el.rules.innerHTML =
      `<span>order <b>m = ${tree.order}</b></span>` +
      `<span title="Maximum keys in any node (m − 1)">max <b>${tree.maxKeys}</b> keys</span>` +
      `<span title="Minimum keys in a leaf except the root (⌈(m−1)/2⌉)">leaf min <b>${tree.minLeaf}</b></span>` +
      `<span title="Minimum keys in an internal node except the root (⌈m/2⌉ − 1)">internal min <b>${min}</b></span>` +
      `<span><b>${s.leaves}</b> leaves</span>` +
      `<span>height <b>${s.height}</b></span>` +
      `<span><b>${s.keys}</b> keys · <b>${s.nodes}</b> nodes</span>`;
  }

  function renderLog() {
    const op = opAt(T.cur);
    el.stepsTitle.textContent = op ? `· ${op.label}` : '';
    const from = op ? op.start : T.cur;
    const frag = document.createDocumentFragment();
    for (let i = from; i <= T.cur; i++) {
      const li = document.createElement('li');
      li.textContent = T.steps[i].msg;
      li.dataset.i = i;
      li.className = `s-${T.steps[i].status}${i === T.cur ? ' current' : ''}`;
      frag.appendChild(li);
    }
    el.stepLog.replaceChildren(frag);
    el.stepLog.scrollTop = el.stepLog.scrollHeight;
  }

  let shownCode;
  function renderPseudo(step) {
    if (step.code !== shownCode) {
      shownCode = step.code;
      el.pseudo.replaceChildren();
      if (!step.code) {
        el.pseudo.innerHTML = '<p class="empty">Run an operation to follow its pseudocode here.</p>';
      } else {
        step.code.forEach((line) => {
          // Indentation becomes padding so long lines wrap with a hanging indent.
          const div = document.createElement('div');
          div.className = 'ln';
          const [code, comment] = line.split('▹');
          div.style.setProperty('--indent', `${code.length - code.trimStart().length}ch`);
          div.textContent = code.trim();
          if (comment) {
            const span = document.createElement('span');
            span.className = 'cm';
            span.textContent = ' ▹ ' + comment.trim();
            div.appendChild(span);
          }
          el.pseudo.appendChild(div);
        });
      }
    }
    [...el.pseudo.children].forEach((div, i) => div.classList.toggle('on', i === step.line));
  }

  function renderFormula() {
    const m = tree.order;
    el.formula.innerHTML =
      `<dt>Max children</dt><dd>m = <b>${m}</b></dd>` +
      `<dt>Max keys per node</dt><dd>m − 1 = <b>${tree.maxKeys}</b></dd>` +
      `<dt>Min keys in a leaf</dt><dd>⌈(m−1)/2⌉ = <b>${tree.minLeaf}</b></dd>` +
      `<dt>Min keys, internal</dt><dd>⌈m/2⌉ − 1 = <b>${tree.minKeys}</b></dd>` +
      `<dt>Min keys in root</dt><dd><b>1</b></dd>`;
    const odd = m % 2 === 1;
    $('segBias').classList.toggle('disabled', odd);
    el.biasNote.textContent = odd
      ? `m = ${m} is odd, so a full node (${m} keys) has a single middle key.`
      : `A full internal node has ${m} keys, which of the two middle keys moves up? (Leaves split ⌈n/2⌉ | ⌊n/2⌋ and copy the first right key.)`;
  }

  function refreshPlayer() {
    const last = T.steps.length - 1;
    const op = opAt(T.cur);
    el.play.querySelector('use').setAttribute('href', T.playing ? '#i-pause' : '#i-play');
    el.play.setAttribute('aria-label', T.playing ? 'Pause' : 'Play');
    el.play.disabled = !T.playing && T.cur >= last && !op;
    $('btnStart').disabled = T.cur === 0;
    $('btnBack').disabled = T.cur === 0;
    $('btnNext').disabled = T.cur >= last;
    $('btnEnd').disabled = T.cur >= last;
    $('btnUndo').disabled = T.ops.length === 0;
    if (op) {
      const n = op.end - op.start, i = T.cur - op.start + 1;
      el.opLabel.textContent = op.label;
      el.stepLabel.textContent = `step ${i} of ${n}`;
      el.progress.style.width = `${(i / n) * 100}%`;
    } else {
      el.opLabel.textContent = 'Ready';
      el.stepLabel.textContent = '';
      el.progress.style.width = '0';
    }
    const queued = T.ops.filter((o) => o.start > T.cur).length;
    el.queueLabel.textContent = queued ? `+${queued} queued` : '';
  }

  // Free space for the camera to fit the tree into (excludes the overlays).
  function measureInsets() {
    const w = el.wrap.getBoundingClientRect();
    const cap = el.caption.getBoundingClientRect();
    const bot = el.bottom.getBoundingClientRect();
    const vc = el.viewCtrls.getBoundingClientRect();
    return { top: cap.bottom - w.top + 8, bottom: w.bottom - bot.top + 8, left: 8, right: w.right - vc.left + 4 };
  }

  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }

  // ---------- Commands ----------

  function parseKeys(text) {
    const keys = [], bad = [];
    text.split(/[\s,;]+/).filter(Boolean).forEach((p) => {
      if (/^-?\d{1,4}$/.test(p)) keys.push(parseInt(p, 10));
      else bad.push(p);
    });
    return { keys, bad };
  }

  function command(type, fromButton) {
    const { keys, bad } = parseKeys(el.input.value);
    if (bad.length) return toast(`Keys must be whole numbers from −9999 to 9999, couldn't read “${bad.join(' ')}”.`);
    if (!keys.length) {
      toast('Type a key first, e.g. 42, or several: 10, 20, 5');
      el.input.focus();
      return;
    }
    if (type === 'range') {
      if (keys.length !== 2) return toast('Type two keys for a range, e.g. 20 60');
      run('range', Math.min(...keys), null, Math.max(...keys));
    } else keys.forEach((k) => run(type, k));
    el.input.value = '';
    // Hand the keyboard back to the player shortcuts (Space, arrows).
    if (fromButton) el.input.blur();
  }

  function randomTree() {
    const n = clamp(parseInt(el.randomCount.value, 10) || 15, 1, 150);
    el.randomCount.value = n;
    const pool = new Set();
    const max = Math.max(99, n * 4);
    while (pool.size < n) pool.add(1 + Math.floor(Math.random() * max));
    const keys = [...pool];
    tree.clear();
    keys.forEach((k) => tree.insert(k, false));
    present = keys;
    view.tidy();
    const list = keys.length > 20 ? keys.slice(0, 20).join(', ') + ', …' : keys.join(', ');
    resetTimeline(`Built a random B+ tree of order ${tree.order} by inserting ${n} keys: ${list}. Try deleting some of them.`);
  }

  function clearTree() {
    tree.clear();
    present = [];
    view.tidy();
    resetTimeline('The tree is empty. Type a key and press Insert, or drag a number from the tray onto the canvas.');
  }

  function setOrder(m) {
    prefs.order = m;
    savePrefs();
    tree.order = m;
    tree.clear();
    present.forEach((k) => tree.insert(k, false));
    view.tidy();
    renderFormula();
    resetTimeline(present.length
      ? `Order changed to m = ${m}: at most ${tree.maxKeys} keys per node; leaves keep at least ${tree.minLeaf}, internal nodes at least ${tree.minKeys} (except the root). The tree was rebuilt by reinserting its ${present.length} keys in their original order.`
      : `Order m = ${m}: every node holds at most ${tree.maxKeys} keys; leaves keep at least ${tree.minLeaf} and internal nodes at least ${tree.minKeys} (except the root). All keys live in the leaves.`);
  }

  // ---------- Key tray ----------

  let trayKeys = [10, 20, 5, 6, 12, 30, 7, 17];

  function renderTray() {
    el.tray.replaceChildren();
    if (!trayKeys.length) {
      el.tray.innerHTML = '<span class="tray-empty">Empty: add numbers or roll the dice →</span>';
      return;
    }
    trayKeys.forEach((k) => {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.textContent = k;
      chip.dataset.key = k;
      chip.title = `Drag ${k} into the tree, or click to insert`;
      el.tray.appendChild(chip);
    });
  }

  function trayAdd(keys) {
    keys.forEach((k) => { if (!trayKeys.includes(k)) trayKeys.push(k); });
    renderTray();
  }

  function trayRemove(key) {
    const i = trayKeys.indexOf(key);
    if (i < 0) return;
    trayKeys.splice(i, 1);
    renderTray();
  }

  function trayRandom() {
    const taken = new Set([...tree.keys(), ...trayKeys]);
    const fresh = [];
    for (let guard = 0; fresh.length < 8 && guard < 2000; guard++) {
      const k = 1 + Math.floor(Math.random() * 99);
      if (!taken.has(k)) { taken.add(k); fresh.push(k); }
    }
    trayAdd(fresh);
  }

  function chipCenter(chip) {
    const r = chip.getBoundingClientRect();
    return view.clientToWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  el.tray.addEventListener('pointerdown', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || e.button !== 0) return;
    e.preventDefault();
    const key = +chip.dataset.key;
    const x0 = e.clientX, y0 = e.clientY;
    let dragging = false;
    chip.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
        dragging = true;
        chip.classList.add('lifted');
        dragStart(key, 'tray', ev);
      }
      dragMove(ev);
    };
    const end = (ev, cancelled) => {
      chip.removeEventListener('pointermove', move);
      chip.removeEventListener('pointerup', up);
      chip.removeEventListener('pointercancel', cancel);
      chip.classList.remove('lifted');
      if (dragging) dragEnd(ev, cancelled);
      else if (!cancelled) run('insert', key, chipCenter(chip));
    };
    const up = (ev) => end(ev, false);
    const cancel = (ev) => end(ev, true);
    chip.addEventListener('pointermove', move);
    chip.addEventListener('pointerup', up);
    chip.addEventListener('pointercancel', cancel);
  });

  // ---------- Drag & drop (shared by tray chips and keys picked out of the tree) ----------

  const drag = { key: null, source: null, chip: null, target: null };
  const ACTIONS = {
    tray: { canvas: 'Insert', search: 'Search', delete: 'Discard' },
    tree: { search: 'Search', delete: 'Delete' },
  };

  const inside = (node, x, y) => {
    const r = node.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  function dropTargetAt(x, y) {
    if (inside(el.zoneSearch, x, y)) return 'search';
    if (inside(el.zoneDelete, x, y)) return 'delete';
    if (inside(el.trayBox, x, y)) return 'tray';
    if (inside(el.wrap, x, y)) return 'canvas';
    return null;
  }

  function dragStart(key, source, e) {
    drag.key = key;
    drag.source = source;
    drag.target = undefined;
    drag.chip = document.createElement('div');
    drag.chip.className = `drag-chip ${source}`;
    drag.chip.innerHTML = '<span class="num"></span><span class="hint"></span>';
    drag.chip.querySelector('.num').textContent = key;
    document.body.appendChild(drag.chip);
    document.body.classList.add('dragging');
    el.zoneDeleteLabel.textContent = source === 'tray' ? 'Discard' : 'Delete';
    dragMove(e);
  }

  function dragMove(e) {
    if (!drag.chip) return;
    drag.chip.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    const t = dropTargetAt(e.clientX, e.clientY);
    if (t === drag.target) return;
    drag.target = t;
    el.zoneSearch.classList.toggle('hover', t === 'search');
    el.zoneDelete.classList.toggle('hover', t === 'delete');
    el.wrap.classList.toggle('drop-insert', drag.source === 'tray' && t === 'canvas');
    const action = ACTIONS[drag.source][t] || '';
    drag.chip.querySelector('.hint').textContent = action;
    drag.chip.dataset.action = action.toLowerCase();
  }

  function dragEnd(e, cancelled) {
    if (!drag.chip) return;
    const target = cancelled ? null : dropTargetAt(e.clientX, e.clientY);
    const { key, source } = drag;
    drag.chip.remove();
    drag.chip = null;
    document.body.classList.remove('dragging');
    el.zoneSearch.classList.remove('hover');
    el.zoneDelete.classList.remove('hover');
    el.wrap.classList.remove('drop-insert');
    el.zoneDeleteLabel.textContent = 'Delete';

    if (source === 'tray') {
      if (target === 'canvas') run('insert', key, view.clientToWorld(e.clientX, e.clientY));
      else if (target === 'search') run('search', key);
      else if (target === 'delete') trayRemove(key);
    } else if (target === 'delete') {
      run('delete', key);
    } else if (target === 'search') {
      run('search', key);
    }
  }

  // ---------- Wiring ----------

  $('btnInsert').addEventListener('click', () => command('insert', true));
  $('btnSearch').addEventListener('click', () => command('search', true));
  $('btnRange').addEventListener('click', () => command('range', true));
  $('btnDelete').addEventListener('click', () => command('delete', true));
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); command('insert'); }
    if (e.key === 'Escape') el.input.blur();
    // With nothing typed, the player keys still work while the box has focus.
    if (el.input.value === '' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const act = { ArrowRight: () => stepBy(1), ArrowLeft: () => stepBy(-1), ' ': togglePlay }[e.key];
      if (act) { e.preventDefault(); act(); }
    }
  });

  el.order.value = String(prefs.order);
  el.order.addEventListener('change', () => { setOrder(+el.order.value); el.order.blur(); });
  $('btnRandomTree').addEventListener('click', randomTree);
  el.randomCount.addEventListener('keydown', (e) => { if (e.key === 'Enter') randomTree(); });
  $('btnUndo').addEventListener('click', undo);
  $('btnClear').addEventListener('click', clearTree);

  $('btnStart').addEventListener('click', toStart);
  $('btnBack').addEventListener('click', () => stepBy(-1));
  el.play.addEventListener('click', togglePlay);
  $('btnNext').addEventListener('click', () => stepBy(1));
  $('btnEnd').addEventListener('click', toEnd);

  el.stepLog.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    T.playing = false;
    go(+li.dataset.i);
  });

  el.speed.value = String(prefs.speed);
  el.speedOut.textContent = `${prefs.speed}×`;
  el.speed.addEventListener('input', () => {
    prefs.speed = +el.speed.value;
    el.speedOut.textContent = `${prefs.speed}×`;
    savePrefs();
  });
  el.speed.addEventListener('change', () => el.speed.blur());

  el.autoplay.checked = prefs.autoplay;
  el.autoplay.addEventListener('change', () => {
    prefs.autoplay = el.autoplay.checked;
    savePrefs();
    el.autoplay.blur();
    toast(prefs.autoplay ? 'Auto-play on: operations animate on their own.' : 'Step mode: press → (or Next) to advance each step.');
  });

  document.querySelectorAll('.seg').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      prefs[seg.dataset.prop] = b.dataset.v;
      tree[seg.dataset.prop] = b.dataset.v;
      savePrefs();
      syncSegs();
    });
  });
  function syncSegs() {
    document.querySelectorAll('.seg').forEach((seg) => {
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', prefs[seg.dataset.prop] === b.dataset.v));
    });
  }

  $('btnZoomIn').addEventListener('click', () => view.zoomBy(1.25));
  $('btnZoomOut').addEventListener('click', () => view.zoomBy(0.8));
  el.fit.addEventListener('click', () => view.setAutoFit(true));
  $('btnTidy').addEventListener('click', () => view.tidy());

  el.trayInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const { keys, bad } = parseKeys(el.trayInput.value);
    if (bad.length) return toast(`Keys must be whole numbers from −9999 to 9999, couldn't read “${bad.join(' ')}”.`);
    trayAdd(keys);
    el.trayInput.value = '';
  });
  $('btnTrayRandom').addEventListener('click', trayRandom);
  $('btnTrayClear').addEventListener('click', () => { trayKeys = []; renderTray(); });

  const openHelp = () => { el.help.hidden = false; $('btnHelpClose').focus(); };
  const closeHelp = () => { el.help.hidden = true; };
  $('btnHelp').addEventListener('click', openHelp);
  $('btnHelpClose').addEventListener('click', closeHelp);
  el.help.addEventListener('click', (e) => { if (e.target === el.help) closeHelp(); });

  DemoShell.initThemeToggle($('btnTheme'));
  DemoShell.initFullscreen($('btnFullscreen'));
  window.addEventListener('themechange', () => view.readTheme());

  function applySidebar() {
    document.body.classList.toggle('no-sidebar', !prefs.sidebar);
    $('btnSidebar').classList.toggle('on', prefs.sidebar);
  }
  $('btnSidebar').addEventListener('click', () => {
    prefs.sidebar = !prefs.sidebar;
    savePrefs();
    applySidebar();
  });

  new ResizeObserver(() => {
    view.resize();
    view.insets = measureInsets();
  }).observe(el.wrap);

  document.addEventListener('keydown', (e) => {
    if (!el.help.hidden) {
      if (e.key === 'Escape' || e.key === '?') { closeHelp(); e.preventDefault(); }
      return;
    }
    const t = e.target;
    if (t.matches('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
    if (t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { undo(); e.preventDefault(); return; }
    if (mod || e.altKey) return;
    switch (e.key) {
      case ' ': togglePlay(); break;
      case 'ArrowRight': stepBy(1); break;
      case 'ArrowLeft': stepBy(-1); break;
      case 'Home': toStart(); break;
      case 'End': toEnd(); break;
      case 'f': case 'F': view.setAutoFit(true); break;
      case 't': case 'T': view.tidy(); break;
      case '+': case '=': view.zoomBy(1.25); break;
      case '-': case '_': view.zoomBy(0.8); break;
      case 'i': case 'I': case '/': el.input.focus(); break;
      case '?': openHelp(); break;
      default: return;
    }
    e.preventDefault();
  });

  // ---------- Start ----------

  applySidebar();
  syncSegs();
  renderFormula();
  renderTray();
  resetTimeline('The tree is empty. Type a key and press Insert, or drag a number from the tray onto the canvas.');
  requestAnimationFrame(loop);
})();
