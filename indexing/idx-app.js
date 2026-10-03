/*
 * Wires the indexing model and view to the page: query controls, the step
 * timeline and playback, the live scoreboard, side panels and shortcuts.
 */
(function () {
  'use strict';

  const M = window.IdxModel;
  const { fmtMs, fmtInt, timesFaster } = M;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---------- Preferences (remembered in this browser only) ----------

  const PREFS_KEY = 'lecture-demos.indexing';
  const prefs = { method: 'scan', col: 'id', frames: 6, disk: 'hdd', limitOne: false, speed: 1, autoplay: true, sidebar: true, seed: 2026, scale: 3 };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY)) || {}); } catch (e) { /* storage unavailable */ }
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

  const el = {
    wrap: $('canvasWrap'),
    caption: $('caption'),
    captionText: $('captionText'),
    rules: $('rules'),
    toast: $('toast'),
    board: $('board'),
    col: $('colSelect'),
    val: $('valInput'),
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
    limitOne: $('limitOne'),
    scaleRange: $('scaleRange'),
    scaleOut: $('scaleOut'),
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

  const engine = new M.Engine({ seed: prefs.seed, frames: prefs.frames, disk: prefs.disk, limitOne: prefs.limitOne });
  const view = new IdxView($('canvas'));
  view.table = engine.table;
  view.diskKey = prefs.disk;

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
    view.table = engine.table;
    view.dirty = true;
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
    renderRules(step);
    renderLog();
    renderPseudo(step);
    refreshPlayer();
    view.insets = measureInsets();
    view.dirty = true;
    boardDirty = true;
  }

  function renderRules(step) {
    const d = M.DISKS[prefs.disk];
    el.rules.innerHTML =
      `<span><b>${M.ROWS}</b> rows · <b>${M.DATA_PAGES}</b> pages</span>` +
      `<span>RAM: <b>${step.ram.length}</b> pages</span>` +
      `<span>${d.short}: <b>≈${fmtMs(d.pageMs)}</b> / page</span>`;
  }

  function renderLog() {
    const op = opAt(T.cur);
    el.stepsTitle.textContent = op ? `· ${op.label}` : '';
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
        el.pseudo.innerHTML = '<p class="empty">Run a query to follow its pseudocode here.</p>';
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

  // Numbers tick up while a step animates, so the clock visibly runs during a disk read.
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

  function renderBoard(src) {
    boardDirty = false;
    const b = src.b;
    const d = M.DISKS[prefs.disk];
    const worst = M.DATA_PAGES * d.pageMs + M.ROWS * M.RAM_MS;
    const data = { scan: laneStats(src, 'scan'), index: laneStats(src, 'index') };
    const total = (x) => x.s.diskMs + x.s.ramMs;
    const max = Math.max(worst, ...['scan', 'index'].filter((k) => data[k]).map((k) => total(data[k])));

    ['scan', 'index'].forEach((k) => {
      const ln = lanes[k];
      const x = data[k];
      ln.root.classList.toggle('empty', !x);
      ln.root.classList.toggle('active', !!x && b.active === k && !x.lane.done);
      if (!x) {
        setText(ln, 'where', 'not run yet');
        ['reads', 'checks', 'time'].forEach((key) => setText(ln, key, '–'));
        setText(ln, 'checksSub', 'checked in RAM');
        setText(ln, 'split', 'time');
        ln.parts.bar.style.width = '0';
        setText(ln, 'tag', '');
        return;
      }
      const s = x.s;
      setText(ln, 'where', x.lane.where + (x.lane.limit && k === 'scan' ? ' LIMIT 1' : '') + (x.lane.fallback ? ' · index can’t help' : ''));
      setText(ln, 'reads', fmtInt(Math.floor(s.reads + 1e-6)));
      const rows = Math.floor(s.rows + 1e-6), keys = Math.floor(s.keys + 1e-6);
      setText(ln, 'checks', `${rows} row${rows === 1 ? '' : 's'}`);
      setText(ln, 'checksSub', keys ? `+ ${keys} index key${keys === 1 ? '' : 's'} in RAM` : 'checked in RAM');
      setText(ln, 'time', fmtMs(total(x)));
      setText(ln, 'split', `disk ${fmtMs(s.diskMs)} · RAM ${fmtMs(s.ramMs)}`);
      ln.parts.bar.style.width = `${(total(x) / max) * 100}%`;
    });

    // Verdict once both plans have finished the same query.
    const sc = data.scan, ix = data.index;
    let tag = '';
    if (sc && ix && sc.lane.done && ix.lane.done && sc.lane.where === ix.lane.where && !sc.lane.fallback) {
      const ts = total(sc), ti = total(ix);
      if (ix.s.reads === 0) tag = 'no disk reads at all';
      else if (ti < ts) tag = `${timesFaster(ts, ti)}× faster`;
    }
    setText(lanes.index, 'tag', tag);
    setText(lanes.scan, 'tag', '');
  }

  // ---------- "Bigger tables" panel ----------

  const SCALE_ROWS = [1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9];
  const SCALE_NAMES = ['1 thousand', '10 thousand', '100 thousand', '1 million', '10 million', '100 million', '1 billion'];

  function renderScale() {
    const i = clamp(prefs.scale, 0, SCALE_ROWS.length - 1);
    const rows = SCALE_ROWS[i];
    const d = M.DISKS[prefs.disk];
    const est = M.estimate(rows, prefs.disk);
    el.scaleRange.value = String(i);
    el.scaleOut.textContent = SCALE_NAMES[i];
    el.scaleIntro.innerHTML = `In the demo the gap is <b>${M.DATA_PAGES} pages vs 3</b>. Real tables are far bigger, and the gap grows with them:`;
    const pct = Math.max(0.6, (est.idxPages / est.scanPages) * 100);
    el.scaleTable.innerHTML =
      `<div class="sc-row sc-scan"><span class="sc-name">Full scan</span><span class="sc-val"><b>${fmtInt(est.scanPages)}</b> pages · ≈${fmtMs(est.scanMs)}</span><div class="sc-bar"><i style="width:100%"></i></div></div>` +
      `<div class="sc-row sc-index"><span class="sc-name">Index lookup</span><span class="sc-val"><b>${est.idxPages}</b> pages · ≈${fmtMs(est.idxMs)}</span><div class="sc-bar"><i style="width:${pct}%"></i></div></div>`;
    if (est.scanMs <= est.idxMs) {
      el.scaleVerdict.className = 'scale-verdict warn';
      el.scaleVerdict.textContent = `Small table: reading all ${fmtInt(est.scanPages)} pages in one sweep beats ${est.idxPages} scattered reads on ${d.short === 'HDD' ? 'a hard disk' : 'an SSD'}, the database may skip the index here.`;
    } else {
      el.scaleVerdict.className = 'scale-verdict';
      el.scaleVerdict.textContent = `${fmtInt(est.scanPages / est.idxPages)}× fewer page reads · ≈${timesFaster(est.scanMs, est.idxMs)}× faster`;
    }
  }

  // Free space for the scene (excludes the caption and the scoreboard).
  function measureInsets() {
    const w = el.wrap.getBoundingClientRect();
    const cap = el.caption.getBoundingClientRect();
    const bot = el.board.getBoundingClientRect();
    return { top: cap.bottom - w.top + 2, bottom: w.bottom - bot.top + 2, left: 0, right: 0 };
  }

  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2800);
  }

  // ---------- Commands ----------

  function readQuery() {
    const col = el.col.value;
    const raw = el.val.value.trim();
    if (col === 'id') {
      const n = Number(raw);
      if (!/^\d{1,3}$/.test(raw) || n < 1 || n > M.MAX_ID) {
        toast(`Type an id from 1 to ${M.MAX_ID}, or press the dice for one from the table.`);
        el.val.focus();
        return null;
      }
      return { col, val: n };
    }
    if (!/^[A-Za-z]{1,12}$/.test(raw)) {
      toast('Type a name, e.g. Nimal, or press the dice for one from the table.');
      el.val.focus();
      return null;
    }
    return { col, val: raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() };
  }

  function runQuery(fromButton) {
    const q = readQuery();
    if (!q) return;
    const steps = prefs.method === 'index' ? engine.runIndex(q) : engine.runScan(q);
    queue(steps[0].run.label, steps);
    if (fromButton) el.val.blur();
  }

  function compare() {
    const q = readQuery();
    if (!q) return;
    if (q.col !== 'id') {
      toast('The index is on id, so a name query can only use a full scan. Choose id to compare, or Run "Use index" to see the fallback.');
      return;
    }
    const where = `id = ${q.val}`;
    const steps = [
      ...engine.flush('Compare, round 1: empty RAM first, so the full scan starts from a cold cache.'),
      ...engine.runScan(q),
      ...engine.flush('Round 2: empty RAM again, so the index lookup also starts cold, a fair race.'),
      ...engine.runIndex(q),
    ];
    queue(`Compare · ${where}`, steps);
  }

  function flushRam() {
    queue('Empty RAM', engine.flush());
  }

  function tour() {
    const q = el.col.value === 'id' ? readQuery() : null;
    queue('Tour', engine.tour(q ? q.val : engine.sampleValue('id')));
  }

  function setMethod(m) {
    prefs.method = m;
    savePrefs();
    syncSegs();
  }

  function setColumn(col) {
    prefs.col = col;
    el.col.value = col;
    el.val.placeholder = col === 'id' ? `1–${M.MAX_ID}` : 'a name';
    el.val.value = String(engine.sampleValue(col));
  }

  function newData() {
    prefs.seed = 1 + Math.floor(Math.random() * 1e9);
    savePrefs();
    engine.newData(prefs.seed);
    setColumn(prefs.col);
    resetTimeline(`A new random table: ${M.ROWS} students in ${M.DATA_PAGES} pages, and a fresh index on id. RAM is empty.`);
  }

  // ---------- Wiring ----------

  $('btnRun').addEventListener('click', () => runQuery(true));
  $('btnCompare').addEventListener('click', compare);
  $('btnFlush').addEventListener('click', flushRam);
  $('btnTour').addEventListener('click', tour);
  $('btnDice').addEventListener('click', () => {
    el.val.value = String(engine.sampleValue(el.col.value, true));
    el.val.classList.remove('flash');
    void el.val.offsetWidth; // restart the animation
    el.val.classList.add('flash');
  });

  el.col.addEventListener('change', () => {
    setColumn(el.col.value);
    savePrefs();
    el.col.blur();
  });
  el.val.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runQuery(); }
    if (e.key === 'Escape') el.val.blur();
  });

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

  el.limitOne.checked = prefs.limitOne;
  el.limitOne.addEventListener('change', () => {
    prefs.limitOne = engine.opts.limitOne = el.limitOne.checked;
    savePrefs();
    el.limitOne.blur();
    toast(prefs.limitOne
      ? 'LIMIT 1: the full scan stops at the first match, on average it still reads half the table.'
      : 'The full scan reads every page, even after a match.');
  });

  // Segmented controls: method, disk type, RAM size.
  const segActions = {
    method: (v) => setMethod(v),
    disk: (v) => {
      prefs.disk = engine.opts.disk = v;
      view.diskKey = v;
      engine.clearBoard();
      renderScale();
      const d = M.DISKS[v];
      resetTimeline(v === 'ssd'
        ? `Storage: SSD. One page read now takes ≈${fmtMs(d.pageMs)}, 100× faster than a hard disk, but still about 1,000× slower than RAM. Fewer pages still means faster.`
        : `Storage: hard disk. One page read takes ≈${fmtMs(d.pageMs)}, about 100,000× slower than RAM.`);
    },
    frames: (v) => {
      prefs.frames = +v;
      engine.setFrames(+v);
      resetTimeline(`RAM now holds ${v} pages. It starts empty; once it is full, the least recently used page is evicted to make room.`);
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

  el.scaleRange.addEventListener('input', () => {
    prefs.scale = +el.scaleRange.value;
    savePrefs();
    renderScale();
  });
  $('btnNewData').addEventListener('click', newData);

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
      case 'Enter': case 'r': case 'R': runQuery(); break;
      case 's': case 'S': setMethod('scan'); break;
      case 'x': case 'X': setMethod('index'); break;
      case 'c': case 'C': compare(); break;
      case 'e': case 'E': flushRam(); break;
      case 'l': case 'L': el.limitOne.click(); break;
      case 't': case 'T': tour(); break;
      case 'i': case 'I': case '/': el.val.focus(); el.val.select(); break;
      case '?': openHelp(); break;
      default: return;
    }
    e.preventDefault();
  });

  // ---------- Start ----------

  applySidebar();
  syncSegs();
  setColumn(prefs.col);
  renderScale();
  resetTimeline(`The students table is stored on disk in ${M.DATA_PAGES} pages. To check a row, its page must first be copied into RAM, and that is slow. Press Tour for a quick introduction, or Run a query.`);
  requestAnimationFrame(loop);
})();
