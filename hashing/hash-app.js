/*
 * Wires the hashing models and view to the page: the four modes (each with its
 * own structure and timeline), commands, playback, the hash-function panel,
 * settings and keyboard shortcuts.
 */
(function () {
  'use strict';

  const A = window.HashAlgo;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

  // ---------- Preferences (remembered in this browser only) ----------

  const PREFS_KEY = 'lecture-demos.hashing';
  const prefs = {
    mode: 'table', speed: 1, autoplay: true, sidebar: true,
    table: { m: 11, strategy: 'linear', autoRehash: false },
    disk: { N: 4, cap: 2 },
    ext: { cap: 2 },
    lin: { N0: 4, cap: 2 },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    ['table', 'disk', 'ext', 'lin'].forEach((m) => Object.assign(prefs[m], saved[m] || {}));
    ['mode', 'speed', 'autoplay', 'sidebar'].forEach((k) => { if (saved[k] != null) prefs[k] = saved[k]; });
  } catch (e) { /* storage unavailable */ }
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

  const el = {
    wrap: $('canvasWrap'), caption: $('caption'), captionText: $('captionText'), rules: $('rules'),
    calc: $('calc'), calcFormula: $('calcFormula'), calcLines: $('calcLines'), calcIo: $('calcIo'),
    toast: $('toast'), input: $('keyInput'), randomCount: $('randomCount'),
    stepLog: $('stepLog'), stepsTitle: $('stepsTitle'), pseudo: $('pseudo'),
    play: $('btnPlay'), opLabel: $('opLabel'), stepLabel: $('stepLabel'), queueLabel: $('queueLabel'),
    progress: $('progressFill'), speed: $('speed'), speedOut: $('speedOut'), autoplay: $('autoplay'),
    autoRehash: $('autoRehash'), help: $('help'),
  };

  // ---------- Modes: one model + timeline each ----------

  const INTRO = {
    table: (m) => `Hash table with m = ${m.m} slots: h(k) = k mod m sends a key straight to a slot. Type keys and press Insert, or press Example.`,
    disk: (m) => `A static hash index on disk: N = ${m.N} buckets, each a page of ${m.cap} keys. h(k) = k mod ${m.N} names the bucket, so a lookup reads about one page. Type keys and press Insert, or press Example.`,
    ext: () => 'Extendible hashing: a directory of 2^d pointers, indexed by the last d bits of the key. Insert keys and watch buckets split and the directory double. Try Example.',
    lin: (m) => `Linear hashing: no directory. ${m.N0} buckets to start; they split one at a time in order, pointed to by next, whenever a page overflows. Try Example.`,
  };
  const CLASSES = { table: A.HashTable, disk: A.StaticHash, ext: A.Extendible, lin: A.LinearHash };
  const LIMIT = { table: () => (modes.table.model.open ? modes.table.model.m : 2 * modes.table.model.m), disk: () => 30, ext: () => 24, lin: () => 30 };

  const modes = {};
  Object.keys(CLASSES).forEach((name) => {
    const model = new CLASSES[name](prefs[name]);
    modes[name] = { model, T: null };
  });
  const cur = () => modes[prefs.mode];

  const view = new HashView($('canvas'));
  const holdMs = (step) => (step.status === 'info' ? 650 : 1400) / prefs.speed;

  function resetTimeline(msg, status) {
    const md = cur();
    const step = A.idleStep(md.model, msg || INTRO[prefs.mode](md.model));
    if (status) step.status = status;
    md.T = { steps: [step], ops: [], cur: 0, anim: null, playing: false, holdUntil: 0 };
    view.dirty = true;
    refresh();
  }

  const T = () => cur().T;

  function go(i) {
    const t = T();
    i = clamp(i, 0, t.steps.length - 1);
    if (i === t.cur) return;
    const from = t.steps[t.cur];
    const fwd = i === t.cur + 1;
    t.cur = i;
    const to = t.steps[i];
    t.anim = { from, to, t0: performance.now(), dur: fwd ? (to.dur || 700) / prefs.speed : 320 };
    refresh();
  }

  const opAt = (i) => T().ops.find((o) => i >= o.start && i < o.end) || null;

  function queue(label, steps) {
    if (!steps.length) return;
    const t = T();
    const wasAtEnd = t.cur === t.steps.length - 1;
    const start = t.steps.length;
    t.steps.push(...steps);
    t.ops.push({ label, start, end: t.steps.length });
    if (prefs.autoplay) t.playing = true;
    else if (wasAtEnd) go(start);
    refresh();
  }

  // ---------- Playback ----------

  function tick(now) {
    const t = T();
    if (t.anim && now - t.anim.t0 >= t.anim.dur) {
      t.anim = null;
      t.holdUntil = now + holdMs(t.steps[t.cur]);
      view.dirty = true;
    }
    if (t.playing && !t.anim && now >= t.holdUntil) {
      if (t.cur < t.steps.length - 1) go(t.cur + 1);
      else { t.playing = false; refreshPlayer(); }
    }
  }

  function loop(now) {
    tick(now);
    const t = T();
    const src = t.anim ? { a: t.anim.from, b: t.anim.to, p: (now - t.anim.t0) / t.anim.dur } : { a: null, b: t.steps[t.cur], p: 1 };
    view.draw(src, now, !!t.anim);
    requestAnimationFrame(loop);
  }

  function togglePlay() {
    const t = T();
    if (t.playing) t.playing = false;
    else {
      if (t.cur >= t.steps.length - 1) {
        const op = opAt(t.cur);
        if (!op) return;
        go(op.start);
      }
      t.playing = true;
    }
    refreshPlayer();
  }

  function stepBy(d) { T().playing = false; go(T().cur + d); refreshPlayer(); }

  function toStart() {
    const t = T();
    t.playing = false;
    const op = opAt(t.cur);
    if (!op) return go(0);
    if (t.cur > op.start) return go(op.start);
    const prev = t.ops[t.ops.indexOf(op) - 1];
    go(prev ? prev.start : 0);
  }

  function toEnd() { T().playing = false; go(T().steps.length - 1); refreshPlayer(); }

  // ---------- Panels ----------

  function refresh() {
    const t = T();
    const step = t.steps[t.cur];
    el.caption.dataset.status = step.status;
    el.captionText.textContent = step.msg;
    el.rules.innerHTML = step.rules.map((r) => `<span>${r}</span>`).join('');
    renderCalc(step);
    renderLog();
    renderPseudo(step);
    refreshPlayer();
    layoutOverlays();
    view.dirty = true;
  }

  const mark = (line) => esc(line).replace(/\[\[(.+?)\]\]/g, '<b>$1</b>');

  function renderCalc(step) {
    el.calcFormula.innerHTML = step.calc.formula.map((f) => `<div>${esc(f)}</div>`).join('');
    const lines = step.calc.lines;
    el.calcLines.innerHTML = lines.map((l, i) => `<li${i === lines.length - 1 ? ' class="cur"' : ''}>${mark(l)}</li>`).join('');
    const io = step.mode === 'disk' && (step.io.reads || step.io.writes);
    el.calcIo.hidden = !io;
    if (io) el.calcIo.textContent = `Disk I/O this operation: ${step.io.reads} read${step.io.reads === 1 ? '' : 's'} · ${step.io.writes} write${step.io.writes === 1 ? '' : 's'}`;
  }

  function renderLog() {
    const t = T();
    const op = opAt(t.cur);
    el.stepsTitle.textContent = op ? `· ${op.label}` : '';
    const from = op ? op.start : t.cur;
    const frag = document.createDocumentFragment();
    for (let i = from; i <= t.cur; i++) {
      const li = document.createElement('li');
      li.textContent = t.steps[i].msg;
      li.dataset.i = i;
      li.className = `s-${t.steps[i].status}${i === t.cur ? ' current' : ''}`;
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
      if (!step.code) el.pseudo.innerHTML = '<p class="empty">Run an operation to follow its pseudocode here.</p>';
      else {
        step.code.forEach((line) => {
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
    }
    [...el.pseudo.children].forEach((div, i) => div.classList.toggle('on', i === step.line));
  }

  function refreshPlayer() {
    const t = T();
    const last = t.steps.length - 1;
    const op = opAt(t.cur);
    el.play.querySelector('use').setAttribute('href', t.playing ? '#i-pause' : '#i-play');
    el.play.setAttribute('aria-label', t.playing ? 'Pause' : 'Play');
    el.play.disabled = !t.playing && t.cur >= last && !op;
    $('btnStart').disabled = t.cur === 0;
    $('btnBack').disabled = t.cur === 0;
    $('btnNext').disabled = t.cur >= last;
    $('btnEnd').disabled = t.cur >= last;
    if (op) {
      const n = op.end - op.start, i = t.cur - op.start + 1;
      el.opLabel.textContent = op.label;
      el.stepLabel.textContent = `step ${i} of ${n}`;
      el.progress.style.width = `${(i / n) * 100}%`;
    } else {
      el.opLabel.textContent = 'Ready';
      el.stepLabel.textContent = '';
      el.progress.style.width = '0';
    }
    const queued = t.ops.filter((o) => o.start > t.cur).length;
    el.queueLabel.textContent = queued ? `+${queued} queued` : '';
  }

  // The hash-function panel sits under the caption; the scene fits around both.
  function layoutOverlays() {
    const w = el.wrap.getBoundingClientRect();
    const cap = el.caption.getBoundingClientRect();
    el.calc.style.top = `${cap.bottom - w.top + 10}px`;
    const c = el.calc.getBoundingClientRect();
    view.insets = { top: cap.bottom - w.top, bottom: 40, left: c.right - w.left, right: 0 };
    view.calcAnchor = { x: c.right - w.left + 36, y: c.top - w.top + 40 };
  }

  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2800);
  }

  // ---------- Commands ----------

  function parseKeys(text) {
    const keys = [], bad = [];
    text.split(/[\s,;]+/).filter(Boolean).forEach((p) => {
      if (/^\d{1,2}$/.test(p)) keys.push(+p);
      else bad.push(p);
    });
    return { keys, bad };
  }

  function command(type, fromButton) {
    const { keys, bad } = parseKeys(el.input.value);
    if (bad.length) return toast(`Keys must be whole numbers from 0 to ${A.MAX_KEY}, couldn't read “${bad.join(' ')}”.`);
    if (!keys.length) { toast('Type a key first, e.g. 42, or several: 7, 18, 29'); el.input.focus(); return; }
    const m = cur().model;
    keys.forEach((k) => queue(`${type[0].toUpperCase()}${type.slice(1)} ${k}`, m[type](k)));
    el.input.value = '';
    if (fromButton) el.input.blur();
  }

  function rangeQuery() {
    const mt = el.input.value.trim().match(/^(\d{1,2})\s*(?:-|–|\.\.|to|\s)\s*(\d{1,2})$/);
    if (!mt) { toast('Type a range such as 10-30, then press Range.'); el.input.focus(); return; }
    let lo = +mt[1], hi = +mt[2];
    if (lo > hi) [lo, hi] = [hi, lo];
    queue(`Range ${lo}–${hi}`, cur().model.range(lo, hi));
    el.input.value = '';
    el.input.blur();
  }

  // Rebuilds the current mode's structure with new settings, keeping its keys.
  function rebuild(keys) {
    const name = prefs.mode;
    const old = cur().model;
    const ks = keys || old.keys();
    const model = new CLASSES[name](prefs[name]);
    ks.forEach((k) => model.insert(k, false));
    cur().model = model;
    return model;
  }

  function randomFill() {
    const max = LIMIT[prefs.mode]();
    const n = clamp(parseInt(el.randomCount.value, 10) || 8, 1, max);
    el.randomCount.value = n;
    const pool = new Set();
    while (pool.size < n) pool.add(Math.floor(Math.random() * (A.MAX_KEY + 1)));
    const keys = [...pool];
    rebuild([]);
    keys.forEach((k) => cur().model.insert(k, false));
    view.resetCamera();
    resetTimeline(`Filled instantly with ${n} random keys: ${keys.join(', ')}. Now insert, search or delete to see the steps.`);
  }

  function example() {
    const ex = cur().model.example();
    Object.assign(prefs[prefs.mode], ex.settings);
    savePrefs();
    syncSettings();
    rebuild(ex.keys);
    view.resetCamera();
    el.input.value = ex.next;
    el.input.classList.remove('flash');
    void el.input.offsetWidth;
    el.input.classList.add('flash');
    resetTimeline(`${ex.msg} (The keys to insert are already typed in, press Insert.)`);
  }

  function clearAll() {
    rebuild([]);
    view.resetCamera();
    resetTimeline();
  }

  function setMode(name) {
    if (!modes[name]) return;
    prefs.mode = name;
    savePrefs();
    if (!cur().T) resetTimeline();
    syncMode();
    view.resetCamera();
    refresh();
  }

  function syncMode() {
    document.querySelectorAll('#segMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.mode));
    $('btnRange').hidden = prefs.mode !== 'disk';
    $('btnRehash').hidden = false;
    document.querySelectorAll('[data-mode]').forEach((n) => { n.hidden = !n.dataset.mode.split(' ').includes(prefs.mode); });
    el.input.placeholder = prefs.mode === 'disk' ? 'Key(s) 0–99, or a range like 10-30' : 'Key(s) 0–99, e.g. 42 or 7, 18, 29';
  }

  function syncSettings() {
    document.querySelectorAll('[data-mode-prop]').forEach((seg) => {
      const [m, prop] = seg.dataset.modeProp.split('.');
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(prefs[m][prop]) === b.dataset.v));
    });
    el.autoRehash.checked = !!prefs.table.autoRehash;
  }

  const STRATEGY = { chain: 'separate chaining', linear: 'linear probing', quadratic: 'quadratic probing', double: 'double hashing' };

  // ---------- Wiring ----------

  $('btnInsert').addEventListener('click', () => command('insert', true));
  $('btnSearch').addEventListener('click', () => command('search', true));
  $('btnDelete').addEventListener('click', () => command('delete', true));
  $('btnRange').addEventListener('click', rangeQuery);
  $('btnExample').addEventListener('click', example);
  $('btnRandom').addEventListener('click', randomFill);
  $('btnClear').addEventListener('click', clearAll);
  $('btnRehash').addEventListener('click', () => queue('Rehash', cur().model.rehash()));
  el.randomCount.addEventListener('keydown', (e) => { if (e.key === 'Enter') randomFill(); });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (prefs.mode === 'disk' && /\d\s*(-|–|\.\.)\s*\d/.test(el.input.value)) rangeQuery();
      else command('insert');
    }
    if (e.key === 'Escape') el.input.blur();
  });

  document.querySelectorAll('#segMode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.v)));

  document.querySelectorAll('[data-mode-prop]').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      const [m, prop] = seg.dataset.modeProp.split('.');
      const v = prop === 'strategy' ? b.dataset.v : +b.dataset.v;
      if (prefs[m][prop] === v) return;
      prefs[m][prop] = v;
      savePrefs();
      syncSettings();
      const n = rebuild().keys().length;
      view.resetCamera();
      const again = n ? ` The ${n} keys were re-inserted with the new setting.` : '';
      const what = prop === 'strategy' ? `Collision handling: ${STRATEGY[v]}.`
        : prop === 'm' ? `Table size m = ${v}: h(k) = k mod ${v}.`
          : prop === 'N' ? `N = ${v} buckets: h(k) = k mod ${v}.`
            : prop === 'N0' ? `Linear hashing starts with N₀ = ${v} buckets.`
              : `Each ${m === 'ext' ? 'bucket' : 'page'} now holds ${v} keys.`;
      resetTimeline(what + again);
    });
  });

  el.autoRehash.addEventListener('change', () => {
    prefs.table.autoRehash = el.autoRehash.checked;
    modes.table.model.autoRehash = el.autoRehash.checked;
    savePrefs();
    el.autoRehash.blur();
    toast(el.autoRehash.checked ? 'Auto-rehash on: the table grows to the next prime ≥ 2m when α passes 0.75.' : 'Auto-rehash off.');
  });

  $('btnStart').addEventListener('click', toStart);
  $('btnBack').addEventListener('click', () => stepBy(-1));
  el.play.addEventListener('click', togglePlay);
  $('btnNext').addEventListener('click', () => stepBy(1));
  $('btnEnd').addEventListener('click', toEnd);
  el.stepLog.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    T().playing = false;
    go(+li.dataset.i);
    refreshPlayer();
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

  const onResize = () => { view.resize(); layoutOverlays(); };
  new ResizeObserver(onResize).observe(el.wrap);
  new ResizeObserver(onResize).observe(el.caption);
  new ResizeObserver(onResize).observe(el.calc);

  document.addEventListener('keydown', (e) => {
    if (!el.help.hidden) {
      if (e.key === 'Escape' || e.key === '?') { closeHelp(); e.preventDefault(); }
      return;
    }
    const t = e.target;
    if (t.matches('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
    if (t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case ' ': togglePlay(); break;
      case 'ArrowRight': stepBy(1); break;
      case 'ArrowLeft': stepBy(-1); break;
      case 'Home': toStart(); break;
      case 'End': toEnd(); break;
      case '1': setMode('table'); break;
      case '2': setMode('disk'); break;
      case '3': setMode('ext'); break;
      case '4': setMode('lin'); break;
      case 'e': case 'E': example(); break;
      case 'i': case 'I': case '/': el.input.focus(); break;
      case '?': openHelp(); break;
      default: return;
    }
    e.preventDefault();
  });

  // ---------- Start ----------

  applySidebar();
  syncSettings();
  syncMode();
  resetTimeline();
  requestAnimationFrame(loop);
})();
