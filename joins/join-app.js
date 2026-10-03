/*
 * Wires the joins model and view to the page: algorithm controls, the step
 * timeline and playback, the live scoreboard, side panels and shortcuts.
 */
(function () {
  'use strict';

  const M = window.JoinModel;
  const { fmtMs, fmtInt, timesFaster } = M;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---------- Preferences (remembered in this browser only) ----------

  const PREFS_KEY = 'lecture-demos.joins';
  const prefs = { algo: 'nl', size: 'm', buckets: 4, speed: 1, autoplay: true, sidebar: true, seed: 2026, scaleN: 4, scaleM: 2 };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY)) || {}); } catch (e) { /* storage unavailable */ }
  if (!M.SIZES[prefs.size]) prefs.size = 'm';
  if (![2, 4, 8].includes(prefs.buckets)) prefs.buckets = 4;
  if (!M.ALGOS[prefs.algo]) prefs.algo = 'nl';
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

  const el = {
    wrap: $('canvasWrap'),
    caption: $('caption'),
    captionText: $('captionText'),
    rules: $('rules'),
    toast: $('toast'),
    board: $('board'),
    stepLog: $('stepLog'),
    stepsTitle: $('stepsTitle'),
    pseudo: $('pseudo'),
    play: $('btnPlay'),
    opLabel: $('opLabel'),
    stepLabel: $('stepLabel'),
    queueLabel: $('queueLabel'),
    progress: $('progressFill'),
    speed: $('speed'),
    speedOut: $('speedOut'),
    autoplay: $('autoplay'),
    scaleN: $('scaleN'),
    scaleM: $('scaleM'),
    scaleNOut: $('scaleNOut'),
    scaleMOut: $('scaleMOut'),
    scaleIntro: $('scaleIntro'),
    scaleTable: $('scaleTable'),
    scaleVerdict: $('scaleVerdict'),
    help: $('help'),
  };

  const lanes = {};
  el.board.querySelectorAll('.lane').forEach((ln) => {
    const parts = {};
    ln.querySelectorAll('[data-k]').forEach((n) => { parts[n.dataset.k] = n; });
    lanes[ln.dataset.lane] = { root: ln, parts, shown: {} };
  });

  // ---------- Model, view, timeline ----------

  const engine = new M.Engine({ seed: prefs.seed, size: prefs.size, buckets: prefs.buckets });
  const view = new JoinView($('canvas'));
  view.algo = prefs.algo;

  // All recorded steps, across runs. `cur` is the step on screen (or being animated to).
  const T = { steps: [], ops: [], cur: 0, anim: null, playing: false, holdUntil: 0 };
  const holdMs = (step) => (step.hold != null ? step.hold : step.status === 'info' ? 600 : 1700) / prefs.speed;

  function go(i) {
    i = clamp(i, 0, T.steps.length - 1);
    if (i === T.cur) return;
    const from = T.steps[T.cur];
    const fwd = i === T.cur + 1;
    T.cur = i;
    const to = T.steps[i];
    // Stepping forward plays the step's own animation; jumps and rewinds just cross-fade.
    T.anim = { from, to, fwd, t0: performance.now(), dur: fwd ? to.dur / prefs.speed : 320 };
    refresh();
  }

  function resetTimeline(msg, status) {
    T.steps = [engine.idle(msg, status)];
    T.ops = [];
    T.cur = 0;
    T.anim = null;
    T.playing = false;
    view.setTables(engine.t, prefs.buckets);
    refresh();
  }

  const opAt = (i) => T.ops.find((o) => i >= o.start && i < o.end) || null;

  function queue(label, steps) {
    const wasAtEnd = T.cur === T.steps.length - 1;
    const start = T.steps.length;
    T.steps.push(...steps);
    T.ops.push({ label, start, end: T.steps.length });
    if (prefs.autoplay) T.playing = true;
    else if (wasAtEnd) go(start);
    refresh();
  }

  // ---------- Playback ----------

  function tick(now) {
    if (T.anim && now - T.anim.t0 >= T.anim.dur) {
      T.anim = null;
      T.holdUntil = now + holdMs(T.steps[T.cur]);
      view.dirty = true;
      boardDirty = true;
    }
    if (T.playing && !T.anim && now >= T.holdUntil) {
      if (T.cur < T.steps.length - 1) go(T.cur + 1);
      else {
        T.playing = false;
        refreshPlayer();
      }
    }
  }

  let boardDirty = true;
  function loop(now) {
    tick(now);
    const src = T.anim
      ? { a: T.anim.from, b: T.anim.to, p: (now - T.anim.t0) / T.anim.dur, fwd: T.anim.fwd }
      : { a: null, b: T.steps[T.cur], p: 1, fwd: false };
    view.draw(src, now, !!T.anim);
    if (T.anim || boardDirty) renderBoard(src);
    requestAnimationFrame(loop);
  }

  function togglePlay() {
    if (T.playing) {
      T.playing = false;
    } else {
      if (T.cur >= T.steps.length - 1) {
        // At the end: replay the last run from its first step.
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
    el.board.classList.toggle('spot', step.spot === 'board');
    renderRules();
    renderLog();
    renderPseudo(step);
    refreshPlayer();
    view.insets = measureInsets();
    view.dirty = true;
    boardDirty = true;
  }

  function renderRules() {
    const t = engine.t;
    el.rules.innerHTML =
      `<span><b>${t.n}</b> students × <b>${t.m}</b> departments = <b>${t.n * t.m}</b> pairs</span>` +
      `<span>hash: <b>k mod ${prefs.buckets}</b></span>`;
  }

  function renderLog() {
    const op = opAt(T.cur);
    el.stepsTitle.textContent = op ? `— ${op.label}` : '';
    const from = op ? op.start : T.cur;
    const frag = document.createDocumentFragment();
    for (let i = from; i <= T.cur; i++) {
      const s = T.steps[i];
      const li = document.createElement('li');
      li.textContent = s.msg;
      li.dataset.i = i;
      li.className = `s-${s.status} k-${s.kind}${i === T.cur ? ' current' : ''}`;
      frag.appendChild(li);
    }
    el.stepLog.replaceChildren(frag);
    el.stepLog.scrollTop = el.stepLog.scrollHeight;
  }

  let shownCode;
  function renderPseudo(step) {
    const code = step.run.code;
    if (code !== shownCode) {
      shownCode = code;
      el.pseudo.replaceChildren();
      if (!code) {
        el.pseudo.innerHTML = '<p class="empty">Run a join to follow its pseudocode here.</p>';
      } else {
        code.forEach((line) => {
          // Indentation becomes padding so long lines wrap with a hanging indent.
          const div = document.createElement('div');
          div.className = 'ln';
          const [text, comment] = line.split('▹');
          div.style.setProperty('--indent', `${text.length - text.trimStart().length}ch`);
          div.textContent = text.trim();
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

  // ---------- Scoreboard ----------

  // Numbers tick up while a step animates.
  function laneStats(src, k) {
    const lb = src.b.board[k];
    if (!lb) return null;
    const la = src.a && src.a.board[k];
    if (!src.a || !src.fwd || !la || la.run !== lb.run) return { lane: lb, s: lb.stats };
    const p = clamp(src.p, 0, 1);
    const s = {};
    Object.keys(lb.stats).forEach((key) => { s[key] = lerp(la.stats[key], lb.stats[key], p); });
    return { lane: lb, s };
  }

  function setText(ln, key, text) {
    if (ln.shown[key] === text) return;
    ln.shown[key] = text;
    ln.parts[key].textContent = text;
  }

  const total = (s) => s.cmp + s.hash + s.sort;
  const floorInt = (v) => fmtInt(Math.floor(v + 1e-6));
  const EXTRA = {
    nl: { key: null, sub: 'no extra work' },
    hash: { key: 'hash', sub: 'hash computations' },
    merge: { key: 'sort', sub: 'sort comparisons' },
  };

  function renderBoard(src) {
    boardDirty = false;
    const b = src.b;
    const t = engine.t;
    const data = {};
    M.LANES.forEach((k) => { data[k] = laneStats(src, k); });
    const max = Math.max(t.n * t.m, ...M.LANES.filter((k) => data[k]).map((k) => total(data[k].s)));
    const nl = data.nl && data.nl.lane.done ? total(data.nl.s) : null;

    M.LANES.forEach((k) => {
      const ln = lanes[k];
      const x = data[k];
      ln.root.classList.toggle('empty', !x);
      ln.root.classList.toggle('active', !!x && b.active === k && !x.lane.done);
      if (!x) {
        setText(ln, 'sub', 'not run yet');
        ['cmp', 'extra', 'total'].forEach((key) => setText(ln, key, '–'));
        setText(ln, 'extraSub', EXTRA[k].sub);
        ln.parts.bar.style.width = '0';
        setText(ln, 'tag', '');
        return;
      }
      const s = x.s;
      const how = k === 'nl' ? 'every pair' : k === 'hash' ? `${x.lane.B} buckets` : 'sort, then merge';
      setText(ln, 'sub', `${how} · ${floorInt(s.out)} rows out`);
      setText(ln, 'cmp', floorInt(s.cmp));
      setText(ln, 'extra', EXTRA[k].key ? floorInt(s[EXTRA[k].key]) : '0');
      setText(ln, 'extraSub', EXTRA[k].sub);
      setText(ln, 'total', floorInt(total(s)));
      ln.parts.bar.style.width = `${(total(s) / max) * 100}%`;
      let tag = '';
      if (k !== 'nl' && nl && x.lane.done && total(s) < nl / 1.05) tag = `${timesFaster(nl, total(s))}× less work`;
      setText(ln, 'tag', tag);
    });
  }

  // ---------- "Bigger tables" panel ----------

  const SCALE_ROWS = [100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8];
  const SCALE_NAMES = ['100', '1 thousand', '10 thousand', '100 thousand', '1 million', '10 million', '100 million'];

  function renderScale() {
    const iN = clamp(prefs.scaleN, 0, SCALE_ROWS.length - 1);
    const iM = clamp(prefs.scaleM, 0, SCALE_ROWS.length - 1);
    const n = SCALE_ROWS[iN], m = SCALE_ROWS[iM];
    const t = engine.t;
    el.scaleN.value = String(iN);
    el.scaleM.value = String(iM);
    el.scaleNOut.textContent = SCALE_NAMES[iN];
    el.scaleMOut.textContent = SCALE_NAMES[iM];
    el.scaleIntro.innerHTML = `Here a nested loop makes <b>${t.n} × ${t.m} = ${t.n * t.m}</b> comparisons — no big deal. With real table sizes the gap explodes:`;
    const est = M.estimate(n, m);
    const rows = [
      ['nl', 'Nested loop', est.nl],
      ['hash', 'Hash join', est.hash],
      ['merge', 'Merge join (sort + merge)', est.merge],
      ['sorted', 'Merge join, already sorted', est.sorted],
    ];
    const max = Math.max(...rows.map((r) => r[2]));
    el.scaleTable.innerHTML = rows.map(([k, name, ops]) =>
      `<div class="sc-row sc-${k}"><span class="sc-name">${name}</span>` +
      `<span class="sc-val"><b>${fmtInt(ops)}</b> ops · ≈${fmtMs((ops * M.OP_NS) / 1e6)}</span>` +
      `<div class="sc-bar"><i style="width:${Math.max(0.6, (ops / max) * 100)}%"></i></div></div>`).join('');
    const best = Math.min(est.hash, est.merge);
    if (est.nl <= best) {
      el.scaleVerdict.className = 'scale-verdict warn';
      el.scaleVerdict.textContent = 'One table is tiny: a nested loop is as good as anything here.';
    } else {
      el.scaleVerdict.className = 'scale-verdict';
      el.scaleVerdict.textContent = `Hash join: ≈${timesFaster(est.nl, est.hash)}× less work than a nested loop`;
    }
  }

  // Free space for the scene (excludes the caption, the scoreboard and the author watermark above it).
  function measureInsets() {
    const w = el.wrap.getBoundingClientRect();
    const cap = el.caption.getBoundingClientRect();
    const mark = el.wrap.querySelector('.author-watermark');
    const bot = Math.min(el.board.getBoundingClientRect().top, mark ? mark.getBoundingClientRect().top - 4 : Infinity);
    return { top: cap.bottom - w.top + 2, bottom: w.bottom - bot + 2, left: 0, right: 0 };
  }

  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2800);
  }

  // ---------- Commands ----------

  const RUN = { nl: () => engine.runNested(), hash: () => engine.runHash(), merge: () => engine.runMerge() };

  function run() {
    const steps = RUN[prefs.algo]();
    queue(steps[0].run.label, steps);
  }

  function compareAll() {
    queue('Compare all', [...engine.runNested(), ...engine.runHash(), ...engine.runMerge()]);
  }

  function tour() {
    queue('Tour', engine.tour());
  }

  function setAlgo(a) {
    prefs.algo = a;
    view.algo = a;
    view.dirty = true;
    savePrefs();
    syncSegs();
  }

  function newData() {
    prefs.seed = 1 + Math.floor(Math.random() * 1e9);
    savePrefs();
    engine.newData(prefs.seed);
    const t = engine.t;
    resetTimeline(`New random tables: ${t.n} students and ${t.m} departments. Pick an algorithm and press Run — or Compare all.`);
  }

  // ---------- Wiring ----------

  $('btnRun').addEventListener('click', run);
  $('btnCompare').addEventListener('click', compareAll);
  $('btnTour').addEventListener('click', tour);
  $('btnNewData').addEventListener('click', newData);

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
    toast(prefs.autoplay ? 'Auto-play on: runs animate on their own.' : 'Step mode: press → (or Next) to advance each step.');
  });

  // Segmented controls: algorithm, table size, hash buckets.
  const segActions = {
    algo: (v) => setAlgo(v),
    size: (v) => {
      prefs.size = v;
      engine.setSize(v);
      const s = M.SIZES[v];
      resetTimeline(`${s.name} tables: ${s.n} students × ${s.m} departments = ${s.n * s.m} possible pairs.`);
      renderScale();
    },
    buckets: (v) => {
      prefs.buckets = +v;
      engine.setBuckets(+v);
      resetTimeline(+v === 2
        ? 'Hash table with 2 buckets: h(k) = k mod 2. Many departments share a bucket, so each probe compares more keys.'
        : `Hash table with ${v} buckets: h(k) = k mod ${v}. More buckets → fewer departments per bucket → fewer comparisons per probe.`);
    },
  };
  document.querySelectorAll('.seg[data-prop]').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-v]');
      if (!btn || String(prefs[seg.dataset.prop]) === btn.dataset.v) return;
      segActions[seg.dataset.prop](btn.dataset.v);
      savePrefs();
      syncSegs();
    });
  });
  function syncSegs() {
    document.querySelectorAll('.seg[data-prop]').forEach((seg) => {
      seg.querySelectorAll('button').forEach((btn) => btn.classList.toggle('on', String(prefs[seg.dataset.prop]) === btn.dataset.v));
    });
  }

  [['scaleN', el.scaleN], ['scaleM', el.scaleM]].forEach(([key, input]) => {
    input.addEventListener('input', () => {
      prefs[key] = +input.value;
      savePrefs();
      renderScale();
    });
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
  $('btnSidebar').addEventListener('click', () => {
    prefs.sidebar = !prefs.sidebar;
    savePrefs();
    applySidebar();
  });

  const onResize = () => {
    view.resize();
    view.insets = measureInsets();
  };
  new ResizeObserver(onResize).observe(el.wrap);
  new ResizeObserver(onResize).observe(el.caption);
  new ResizeObserver(onResize).observe(el.board);

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
      case 'Enter': case 'r': case 'R': run(); break;
      case '1': case 'n': case 'N': setAlgo('nl'); break;
      case '2': case 'h': case 'H': setAlgo('hash'); break;
      case '3': case 'm': case 'M': setAlgo('merge'); break;
      case 'c': case 'C': compareAll(); break;
      case 'd': case 'D': newData(); break;
      case 't': case 'T': tour(); break;
      case '?': openHelp(); break;
      default: return;
    }
    e.preventDefault();
  });

  // ---------- Start ----------

  applySidebar();
  syncSegs();
  renderScale();
  resetTimeline('Two tables, one question: which student belongs to which department? A join pairs the rows whose s.dept equals d.id. Press Tour for a quick introduction, or pick an algorithm and Run.');
  requestAnimationFrame(loop);
})();
