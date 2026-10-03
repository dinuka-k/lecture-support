/*
 * Wires the sorting algorithms and view to the page: data generation, the
 * step timeline and playback, side panels and keyboard shortcuts.
 */
(function () {
  'use strict';

  const S = window.SortAlgo;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const PREFS_KEY = 'lecture-demos.sorting';
  const prefs = { mergeMode: 'trust', algo: 'bubble', data: 'random', n: 10, speed: 1, autoplay: true, sidebar: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY)) || {}); } catch (e) { /* storage unavailable */ }
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

  const el = {
    wrap: $('canvasWrap'), caption: $('caption'), captionText: $('captionText'), rules: $('rules'), toast: $('toast'),
    data: $('dataSelect'), size: $('sizeInput'), custom: $('customInput'),
    stepLog: $('stepLog'), pseudo: $('pseudo'), cx: $('cx').querySelector('tbody'),
    play: $('btnPlay'), opLabel: $('opLabel'), stepLabel: $('stepLabel'), progress: $('progressFill'),
    speed: $('speed'), speedOut: $('speedOut'), autoplay: $('autoplay'), help: $('help'),
  };

  const view = new SortView($('canvas'));
  let items = []; // the unsorted starting array
  let nextId = 1;
  const T = { steps: [], cur: 0, anim: null, playing: false, holdUntil: 0, sorted: false };
  const holdMs = (step) => (step.status === 'info' ? 550 : 1400) / prefs.speed;

  // ---------- Data ----------

  function makeData(kind, n) {
    let vals;
    if (kind === 'reversed') vals = Array.from({ length: n }, (_, i) => Math.round(95 - (i * 85) / Math.max(1, n - 1)));
    else if (kind === 'nearly') {
      vals = Array.from({ length: n }, (_, i) => Math.round(10 + (i * 85) / Math.max(1, n - 1)));
      for (let s = 0; s < Math.max(1, Math.floor(n / 6)); s++) {
        const i = Math.floor(Math.random() * (n - 1));
        [vals[i], vals[i + 1]] = [vals[i + 1], vals[i]];
      }
    } else if (kind === 'few') {
      const pool = [20, 45, 70, 90];
      vals = Array.from({ length: n }, () => pool[Math.floor(Math.random() * pool.length)]);
    } else vals = Array.from({ length: n }, () => 5 + Math.floor(Math.random() * 95));
    return vals;
  }

  function setItems(vals, msg) {
    items = vals.map((v) => ({ id: nextId++, v }));
    reset(msg);
  }

  // Back to the unsorted array with the chosen algorithm.
  function reset(msg) {
    const A = S.ALGOS[prefs.algo];
    T.steps = [S.idle(items, prefs.algo, msg || `${A.name}: ${A.idea} Press Sort to start.`)];
    T.cur = 0;
    T.anim = null;
    T.playing = false;
    T.sorted = false;
    view.dirty = true;
    refresh();
  }

  function sort() {
    if (T.sorted) {
      T.playing = true;
      if (T.cur >= T.steps.length - 1) go(1);
      refreshPlayer();
      return;
    }
    T.steps = S.record(prefs.algo, items, { trust: prefs.mergeMode === 'trust' });
    T.cur = 0;
    T.sorted = true;
    if (prefs.autoplay) T.playing = true;
    else go(1);
    refresh();
  }

  // ---------- Playback ----------

  function go(i) {
    i = clamp(i, 0, T.steps.length - 1);
    if (i === T.cur) return;
    const from = T.steps[T.cur];
    const fwd = i === T.cur + 1;
    T.cur = i;
    T.anim = { from, to: T.steps[i], t0: performance.now(), dur: (fwd ? 600 : 300) / prefs.speed };
    refresh();
  }

  function tick(now) {
    if (T.anim && now - T.anim.t0 >= T.anim.dur) {
      T.anim = null;
      T.holdUntil = now + holdMs(T.steps[T.cur]);
      view.dirty = true;
    }
    if (T.playing && !T.anim && now >= T.holdUntil) {
      if (T.cur < T.steps.length - 1) go(T.cur + 1);
      else { T.playing = false; refreshPlayer(); }
    }
  }

  function loop(now) {
    tick(now);
    const src = T.anim ? { a: T.anim.from, b: T.anim.to, p: (now - T.anim.t0) / T.anim.dur } : { a: null, b: T.steps[T.cur], p: 1 };
    view.draw(src, now, !!T.anim);
    requestAnimationFrame(loop);
  }

  function togglePlay() {
    if (!T.sorted) return sort();
    if (T.playing) T.playing = false;
    else {
      if (T.cur >= T.steps.length - 1) go(0);
      T.playing = true;
    }
    refreshPlayer();
  }

  const stepBy = (d) => {
    T.playing = false;
    if (!T.sorted && d > 0) {
      T.steps = S.record(prefs.algo, items, { trust: prefs.mergeMode === 'trust' });
      T.sorted = true;
    }
    go(T.cur + d);
    refreshPlayer();
  };

  // ---------- Panels ----------

  function refresh() {
    const step = T.steps[T.cur];
    const A = S.ALGOS[step.algo];
    el.caption.dataset.status = step.status;
    el.captionText.textContent = step.msg;
    el.rules.innerHTML =
      `<span>n = <b>${step.main.length}</b></span>` +
      `<span>comparisons: <b>${step.stats.cmp}</b></span>` +
      `<span>${step.algo === 'merge' ? 'moves' : 'swaps'}: <b>${step.stats.swp}</b></span>` +
      `<span>${A.name}: <b>${A.avg}</b> average</span>`;
    renderLog();
    renderPseudo(step);
    renderComplexity();
    refreshPlayer();
    const w = el.wrap.getBoundingClientRect(), cap = el.caption.getBoundingClientRect();
    view.insets = { top: cap.bottom - w.top, bottom: 30, left: 0, right: 0 };
    view.dirty = true;
  }

  function renderLog() {
    const frag = document.createDocumentFragment();
    const from = Math.max(0, T.cur - 40);
    for (let i = from; i <= T.cur; i++) {
      const li = document.createElement('li');
      li.textContent = T.steps[i].msg;
      li.dataset.i = i;
      li.value = i + 1;
      li.className = `s-${T.steps[i].status}${i === T.cur ? ' current' : ''}`;
      frag.appendChild(li);
    }
    el.stepLog.replaceChildren(frag);
    el.stepLog.scrollTop = el.stepLog.scrollHeight;
  }

  let shownAlgo;
  function renderPseudo(step) {
    if (step.algo !== shownAlgo) {
      shownAlgo = step.algo;
      el.pseudo.replaceChildren();
      S.ALGOS[step.algo].code.forEach((line) => {
        const div = document.createElement('div');
        div.className = 'ln';
        const [code, comment] = line.split('▹');
        div.style.setProperty('--indent', `${code.length - code.trimStart().length}ch`);
        div.textContent = code.trim();
        if (comment) {
          const span = document.createElement('span');
          span.className = 'cm';
          span.textContent = (code.trim() ? ' ▹ ' : '▹ ') + comment.trim();
          div.appendChild(span);
        }
        el.pseudo.appendChild(div);
      });
    }
    [...el.pseudo.children].forEach((div, i) => div.classList.toggle('on', i === step.line));
  }

  function renderComplexity() {
    el.cx.innerHTML = Object.entries(S.ALGOS).map(([k, A]) =>
      `<tr data-v="${k}" class="${k === prefs.algo ? 'on' : ''}"><td>${A.name.replace(' sort', '')}</td><td>${A.best}</td><td>${A.avg}</td><td>${A.worst}</td><td>${A.space}</td><td>${A.stable ? 'yes' : 'no'}</td></tr>`).join('');
  }

  function refreshPlayer() {
    const last = T.steps.length - 1;
    el.play.querySelector('use').setAttribute('href', T.playing ? '#i-pause' : '#i-play');
    el.play.setAttribute('aria-label', T.playing ? 'Pause' : 'Play');
    $('btnStart').disabled = T.cur === 0;
    $('btnBack').disabled = T.cur === 0;
    $('btnNext').disabled = T.sorted && T.cur >= last;
    $('btnEnd').disabled = !T.sorted || T.cur >= last;
    el.opLabel.textContent = T.sorted ? S.ALGOS[prefs.algo].name : 'Ready';
    el.stepLabel.textContent = T.sorted ? `step ${T.cur + 1} of ${T.steps.length}` : '';
    el.progress.style.width = T.sorted ? `${((T.cur + 1) / T.steps.length) * 100}%` : '0';
  }

  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2800);
  }

  // ---------- Commands ----------

  function setAlgo(algo) {
    if (!S.ALGOS[algo]) return;
    prefs.algo = algo;
    savePrefs();
    document.querySelectorAll('#segAlgo button').forEach((b) => b.classList.toggle('on', b.dataset.v === algo));
    syncMerge();
    reset(`${S.ALGOS[algo].name}: ${S.ALGOS[algo].idea} Same starting array as before — press Sort.`);
  }

  function newArray() {
    const n = clamp(parseInt(el.size.value, 10) || 10, 4, 32);
    el.size.value = n;
    prefs.n = n;
    prefs.data = el.data.value;
    savePrefs();
    setItems(makeData(prefs.data, n));
  }

  function customArray() {
    const parts = el.custom.value.split(/[\s,;]+/).filter(Boolean);
    const vals = parts.map(Number);
    if (vals.length < 2 || vals.length > 32 || vals.some((v) => !Number.isInteger(v) || v < 1 || v > 99)) {
      toast('Type 2–32 whole numbers from 1 to 99, e.g. 5, 3, 8, 1');
      return;
    }
    el.custom.blur();
    setItems(vals);
  }

  function syncMerge() {
    $('segMerge').hidden = prefs.algo !== 'merge';
    document.querySelectorAll('#segMerge button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.mergeMode));
  }

  // ---------- Wiring ----------

  document.querySelectorAll('#segMerge button').forEach((b) => b.addEventListener('click', () => {
    if (prefs.mergeMode === b.dataset.v) return;
    prefs.mergeMode = b.dataset.v;
    savePrefs();
    syncMerge();
    reset(prefs.mergeMode === 'trust'
      ? 'Trust the recursion: split the array, assume the two recursive calls return sorted halves, and watch the merge step in detail. Press Sort.'
      : 'Full trace: follow every recursive call down to single elements, then every merge on the way back up. Press Sort.');
  }));

  document.querySelectorAll('#segAlgo button').forEach((b) => b.addEventListener('click', () => setAlgo(b.dataset.v)));
  $('btnSort').addEventListener('click', sort);
  $('btnNew').addEventListener('click', newArray);
  el.data.value = prefs.data;
  el.size.value = prefs.n;
  el.data.addEventListener('change', () => { newArray(); el.data.blur(); });
  el.size.addEventListener('change', newArray);
  el.custom.addEventListener('keydown', (e) => { if (e.key === 'Enter') customArray(); if (e.key === 'Escape') el.custom.blur(); });
  el.cx.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-v]'); if (tr) setAlgo(tr.dataset.v); });

  $('btnStart').addEventListener('click', () => { T.playing = false; go(0); refreshPlayer(); });
  $('btnBack').addEventListener('click', () => stepBy(-1));
  el.play.addEventListener('click', togglePlay);
  $('btnNext').addEventListener('click', () => stepBy(1));
  $('btnEnd').addEventListener('click', () => { T.playing = false; go(T.steps.length - 1); refreshPlayer(); });
  el.stepLog.addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) { T.playing = false; go(+li.dataset.i); refreshPlayer(); } });

  el.speed.value = String(prefs.speed);
  el.speedOut.textContent = `${prefs.speed}×`;
  el.speed.addEventListener('input', () => { prefs.speed = +el.speed.value; el.speedOut.textContent = `${prefs.speed}×`; savePrefs(); });
  el.speed.addEventListener('change', () => el.speed.blur());
  el.autoplay.checked = prefs.autoplay;
  el.autoplay.addEventListener('change', () => {
    prefs.autoplay = el.autoplay.checked;
    savePrefs();
    el.autoplay.blur();
    toast(prefs.autoplay ? 'Auto-play on.' : 'Step mode: press → (or Next) to advance each step.');
  });

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
  $('btnSidebar').addEventListener('click', () => { prefs.sidebar = !prefs.sidebar; savePrefs(); applySidebar(); });

  const onResize = () => { view.resize(); refresh(); };
  new ResizeObserver(onResize).observe(el.wrap);

  const ALGO_KEYS = ['bubble', 'selection', 'insertion', 'merge', 'quick', 'heap'];
  document.addEventListener('keydown', (e) => {
    if (!el.help.hidden) {
      if (e.key === 'Escape' || e.key === '?') { closeHelp(); e.preventDefault(); }
      return;
    }
    const t = e.target;
    if (t.matches('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
    if (t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[1-6]$/.test(e.key)) { setAlgo(ALGO_KEYS[+e.key - 1]); e.preventDefault(); return; }
    switch (e.key) {
      case ' ': togglePlay(); break;
      case 'ArrowRight': stepBy(1); break;
      case 'ArrowLeft': stepBy(-1); break;
      case 'Home': T.playing = false; go(0); refreshPlayer(); break;
      case 'End': if (T.sorted) { T.playing = false; go(T.steps.length - 1); refreshPlayer(); } break;
      case 'Enter': case 's': case 'S': sort(); break;
      case 'n': case 'N': newArray(); break;
      case '?': openHelp(); break;
      default: return;
    }
    e.preventDefault();
  });

  // ---------- Start ----------

  applySidebar();
  syncMerge();
  document.querySelectorAll('#segAlgo button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.algo));
  setItems(makeData(prefs.data, prefs.n));
  requestAnimationFrame(loop);
})();
