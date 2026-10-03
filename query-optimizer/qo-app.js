/*
 * Wires the optimizer engine, the canvas view and the decision board to the
 * page: the SQL editor, examples, step timeline and playback, the stage strip,
 * side panels (steps, pseudocode, statistics & indexes) and shortcuts.
 */
(function () {
  'use strict';

  const Q = window.QoSql;
  const E = window.QoEngine;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

  const EXAMPLES = [
    {
      name: 'Three tables: join order',
      sql: 'SELECT s.name, c.title, e.grade\nFROM students s, enrollments e, courses c\nWHERE s.id = e.student_id\n  AND e.course_id = c.id\n  AND c.dept_id = 7\n  AND s.year = 4',
    },
    {
      name: 'Two tables: push filters down',
      sql: "SELECT s.name, d.name\nFROM students s, departments d\nWHERE s.dept_id = d.id\n  AND d.building = 'Science'\n  AND s.year = 2",
    },
    {
      name: 'Constants & redundant conditions',
      sql: 'SELECT name, gpa\nFROM students\nWHERE gpa > 1.5 * 2\n  AND 1 = 1\n  AND gpa > 2.5\n  AND NOT (year < 4)',
    },
    {
      name: 'Impossible condition → empty result',
      sql: 'SELECT s.name\nFROM students s JOIN enrollments e ON e.student_id = s.id\nWHERE s.year = 1\n  AND s.year = 3',
    },
    {
      name: 'Transitive condition + indexes',
      sql: 'SELECT s.name, e.grade\nFROM students s JOIN enrollments e ON s.id = e.student_id\nWHERE s.id = 42',
    },
    {
      name: 'Index ignored: not selective',
      sql: 'SELECT *\nFROM students\nWHERE year = 2',
    },
    {
      name: 'Subquery → semi join',
      sql: "SELECT s.name\nFROM students s\nWHERE s.year = 3\n  AND s.id IN (SELECT e.student_id\n               FROM enrollments e\n               WHERE e.grade = 'A')",
    },
    {
      name: 'Four tables: join order',
      sql: "SELECT s.name, c.title, e.grade\nFROM enrollments e, students s, courses c, departments d\nWHERE e.student_id = s.id\n  AND e.course_id = c.id\n  AND c.dept_id = d.id\n  AND d.name = 'Physics'\n  AND s.year = 4",
    },
    {
      name: 'GROUP BY, ORDER BY, LIMIT',
      sql: 'SELECT d.name, COUNT(*) AS total\nFROM students s JOIN departments d ON s.dept_id = d.id\nWHERE s.gpa >= 3.5\nGROUP BY d.name\nORDER BY total DESC\nLIMIT 5',
    },
    {
      name: 'Missing join condition',
      sql: 'SELECT s.name, c.title\nFROM students s, courses c\nWHERE c.credits = 4',
    },
  ];

  const PHASES = ['parse', 'rewrite', 'plan', 'done'];
  const PHASE_NAME = { parse: 'Parser', rewrite: 'Rewriter', plan: 'Planner', done: 'Plan' };

  // ---------- Preferences (remembered in this browser only) ----------

  const PREFS_KEY = 'lecture-demos.optimizer';
  const prefs = { sql: null, speed: 1, autoplay: true, sidebar: window.innerWidth >= 1500, compact: window.innerHeight < 860, catalog: null };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY)) || {}); } catch (e) { /* storage unavailable */ }
  const savePrefs = () => {
    prefs.catalog = cat.save();
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
  };

  const cat = new Q.Catalog(prefs.catalog);

  const el = {
    wrap: $('canvasWrap'),
    caption: $('caption'),
    captionText: $('captionText'),
    captionStep: $('captionStep'),
    toast: $('toast'),
    board: $('board'),
    sql: $('sql'),
    hl: $('hl'),
    editor: $('editor'),
    optimize: $('btnOptimize'),
    examples: $('exampleSelect'),
    pipeline: $('pipeline'),
    stepLog: $('stepLog'),
    stepsTitle: $('stepsTitle'),
    pseudo: $('pseudo'),
    play: $('btnPlay'),
    opLabel: $('opLabel'),
    stepLabel: $('stepLabel'),
    progress: $('progressFill'),
    speed: $('speed'),
    speedOut: $('speedOut'),
    autoplay: $('autoplay'),
    catalog: $('catalog'),
    help: $('help'),
  };

  const view = new QoView($('canvas'));

  // ---------- Timeline ----------

  const idleStep = { phase: '', status: 'info', msg: 'Write a SQL query (or pick an example) and press Optimize.', board: { kind: 'intro' }, scene: null, hl: {}, line: -1, title: '' };
  const T = { run: null, steps: [idleStep], cur: 0, anim: null, playing: false, holdUntil: 0, sql: null };

  const holdMs = (s) => (s.hold != null ? s.hold : clamp(1400 + s.msg.length * 30, 2600, 8000)) / prefs.speed;

  function go(i, opts) {
    i = clamp(i, 0, T.steps.length - 1);
    if (i === T.cur && !(opts && opts.force)) return;
    const from = T.steps[T.cur];
    const fwd = i === T.cur + 1;
    T.cur = i;
    const to = T.steps[i];
    T.anim = { from, to, fwd, t0: performance.now(), dur: (fwd ? to.dur : 450) / prefs.speed };
    refresh(fwd);
  }

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
      ? { a: T.anim.from, b: T.anim.to, p: (now - T.anim.t0) / T.anim.dur, fwd: T.anim.fwd }
      : { a: null, b: T.steps[T.cur], p: 1, fwd: false };
    view.draw(src, now, !!T.anim);
    requestAnimationFrame(loop);
  }

  function togglePlay() {
    if (!T.run) return;
    if (T.playing) T.playing = false;
    else {
      if (T.cur >= T.steps.length - 1) go(0);
      T.playing = true;
      T.holdUntil = performance.now() + 250;
    }
    refreshPlayer();
  }

  function stepBy(d) {
    T.playing = false;
    go(T.cur + d);
    refreshPlayer();
  }

  function toStart() { T.playing = false; go(0); refreshPlayer(); }
  function toEnd() { T.playing = false; go(T.steps.length - 1); refreshPlayer(); }

  function jumpPhase(ph) {
    if (!T.run || T.run.phaseStart[ph] == null) return;
    T.playing = false;
    go(T.run.phaseStart[ph]);
    refreshPlayer();
  }

  // ---------- Running the optimizer ----------

  function optimize(opts) {
    opts = opts || {};
    const sql = el.sql.value;
    let run;
    try {
      run = E.optimize(sql, cat);
    } catch (err) {
      console.error(err);
      toast('Something went wrong while optimizing this query.');
      return;
    }
    T.run = run;
    T.sql = sql;
    T.steps = run.steps;
    T.anim = null;
    T.playing = false;
    const start = opts.startPhase && run.phaseStart[opts.startPhase] != null ? run.phaseStart[opts.startPhase] : 0;
    T.cur = -1;
    renderLogList();
    go(start, { force: true });
    T.anim = null;
    view.dirty = true;
    prefs.sql = sql;
    savePrefs();
    updateEditor();
    if (run.error) {
      T.playing = false;
      go(T.steps.length - 1, { force: true });
    } else if (prefs.autoplay && opts.play !== false) {
      T.playing = true;
      T.holdUntil = performance.now() + holdMs(T.steps[T.cur]) * 0.6;
    }
    refreshPlayer();
  }

  // Statistics changed: rewriting is unaffected, so continue from the planner.
  function replan(why) {
    renderCatalog();
    savePrefs();
    if (!T.run || T.run.error || T.sql == null) return;
    const saved = el.sql.value;
    el.sql.value = T.sql;
    optimize({ startPhase: 'plan' });
    el.sql.value = saved;
    updateEditor();
    toast(`${why} — re-planning. The parser and rewriter steps are unchanged: rules never look at statistics.`);
  }

  // ---------- Panels ----------

  function refresh(animateBoard) {
    const step = T.steps[T.cur];
    if (!step) return;
    el.caption.dataset.status = step.status;
    el.captionText.textContent = step.msg;
    const chip = step.title && step.title.includes(' · ') && step.phase === 'rewrite' ? step.title.split(' · ')[0] : PHASE_NAME[step.phase] || '';
    el.captionStep.textContent = chip;
    QoBoard.render(el.board, step, !!animateBoard);
    el.board.scrollTop = 0;
    renderLogState();
    renderPseudo(step);
    renderPipeline(step);
    refreshPlayer();
    view.insets = measureInsets();
    view.dirty = true;
  }

  function renderLogList() {
    const frag = document.createDocumentFragment();
    let ph = null;
    T.steps.forEach((s, i) => {
      if (s.phase !== ph) {
        ph = s.phase;
        const h = document.createElement('li');
        h.className = 'ph';
        h.textContent = { parse: 'Parser', rewrite: 'Rewriter · RBO', plan: 'Planner · CBO', done: 'Execution plan' }[ph] || '';
        frag.appendChild(h);
      }
      const li = document.createElement('li');
      li.className = `st s-${s.status}`;
      li.dataset.i = i;
      li.title = s.msg;
      li.innerHTML = `<i>${i + 1}</i><span>${esc(s.title || '')}</span>`;
      frag.appendChild(li);
    });
    el.stepLog.replaceChildren(frag);
    el.stepsTitle.textContent = T.run ? `— ${T.steps.length}` : '';
  }

  function renderLogState() {
    let curLi = null;
    el.stepLog.querySelectorAll('.st').forEach((li) => {
      const i = +li.dataset.i;
      li.classList.toggle('current', i === T.cur);
      li.classList.toggle('future', i > T.cur);
      if (i === T.cur) curLi = li;
    });
    if (curLi) {
      const box = el.stepLog;
      const top = curLi.offsetTop - box.offsetTop;
      if (top < box.scrollTop + 20 || top > box.scrollTop + box.clientHeight - 40) box.scrollTop = top - box.clientHeight / 2;
    }
  }

  function renderPseudoLines() {
    el.pseudo.replaceChildren();
    E.PSEUDO.forEach((line) => {
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

  function renderPseudo(step) {
    [...el.pseudo.children].forEach((div, i) => div.classList.toggle('on', i === step.line));
  }

  function renderPipeline(step) {
    const run = T.run;
    const curIdx = PHASES.indexOf(step.phase);
    el.pipeline.querySelectorAll('button[data-phase]').forEach((btn) => {
      const ph = btn.dataset.phase;
      const i = PHASES.indexOf(ph);
      const has = run && run.phaseStart[ph] != null;
      btn.disabled = !has;
      btn.classList.toggle('active', i === curIdx && step.status !== 'error');
      btn.classList.toggle('error', i === curIdx && step.status === 'error');
      btn.classList.toggle('done', has && i < curIdx);
      btn.classList.toggle('skipped', !!run && !has);
    });
  }

  function refreshPlayer() {
    const last = T.steps.length - 1;
    el.play.querySelector('use').setAttribute('href', T.playing ? '#i-pause' : '#i-play');
    el.play.setAttribute('aria-label', T.playing ? 'Pause' : 'Play');
    el.play.disabled = !T.run;
    $('btnStart').disabled = T.cur <= 0;
    $('btnBack').disabled = T.cur <= 0;
    $('btnNext').disabled = T.cur >= last;
    $('btnEnd').disabled = T.cur >= last;
    const step = T.steps[T.cur];
    if (T.run) {
      el.opLabel.textContent = step.title || '';
      el.stepLabel.textContent = `step ${T.cur + 1} of ${T.steps.length}`;
      el.progress.style.width = `${((T.cur + 1) / T.steps.length) * 100}%`;
    } else {
      el.opLabel.textContent = 'Ready';
      el.stepLabel.textContent = '';
      el.progress.style.width = '0';
    }
  }

  // Free space for the scene (below the caption).
  function measureInsets() {
    const w = el.wrap.getBoundingClientRect();
    const cap = el.caption.getBoundingClientRect();
    return { top: cap.bottom - w.top + 4, bottom: 0, left: 0, right: 0 };
  }

  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 4200);
  }

  // ---------- SQL editor with highlighting ----------

  const HL_RE = /(--[^\n]*)|('(?:[^']|'')*'?)|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([^\sA-Za-z0-9_']+)/g;

  function highlight(src, err) {
    const toks = [];
    let m;
    HL_RE.lastIndex = 0;
    while ((m = HL_RE.exec(src))) {
      let cls = '';
      if (m[1]) cls = 'cm';
      else if (m[2]) cls = 'str';
      else if (m[3]) cls = 'num';
      else if (m[4]) cls = Q.KEYWORDS.has(m[4].toUpperCase()) || Q.AGGS.has(m[4].toUpperCase()) ? 'kw' : '';
      else if (m[6]) cls = 'op';
      toks.push({ s: m.index, e: m.index + m[0].length, cls });
    }
    let out = '';
    toks.forEach((t) => {
      const cuts = [t.s, t.e];
      if (err) {
        if (err.s > t.s && err.s < t.e) cuts.push(err.s);
        if (err.e > t.s && err.e < t.e) cuts.push(err.e);
      }
      cuts.sort((a, b) => a - b);
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i], b = cuts[i + 1];
        if (a === b) continue;
        const inErr = err && a >= err.s && b <= err.e && /\S/.test(src.slice(a, b));
        const cls = [t.cls, inErr ? 'err' : ''].filter(Boolean).join(' ');
        const text = esc(src.slice(a, b));
        out += cls ? `<span class="${cls}">${text}</span>` : text;
      }
    });
    if (err && err.s >= src.trimEnd().length) out += '<span class="err">&nbsp;&nbsp;</span>';
    return out + '\n';
  }

  function updateEditor() {
    const src = el.sql.value;
    const err = T.run && T.run.error && src === T.sql ? T.run.error : null;
    el.hl.innerHTML = highlight(src, err);
    const lines = src.split('\n').length;
    el.sql.rows = clamp(lines, 3, 7);
    el.hl.scrollTop = el.sql.scrollTop;
    const dirty = T.sql != null && src !== T.sql;
    el.editor.classList.toggle('dirty', dirty);
    el.optimize.classList.toggle('pulse', dirty);
    const ex = EXAMPLES.findIndex((x) => x.sql === src);
    el.examples.value = ex >= 0 ? String(ex) : 'custom';
  }

  function loadExample(i) {
    i = ((i % EXAMPLES.length) + EXAMPLES.length) % EXAMPLES.length;
    el.sql.value = EXAMPLES[i].sql;
    updateEditor();
    optimize();
  }

  // ---------- Statistics & indexes panel ----------

  function renderCatalog() {
    el.catalog.innerHTML = cat.tables().map((t) => {
      const changed = cat.rows(t) !== cat.defaultRows(t);
      const chips = cat.columns(t).map((c) => {
        const pk = cat.pk(t) === c;
        const on = cat.isIndexed(t, c);
        const rg = cat.range(t, c);
        const info = `${c}: ${cat.ndv(t, c).toLocaleString('en-US')} distinct values${rg ? `, ${rg[0]} … ${rg[1]}` : ' (text)'}. ${pk ? 'Primary key: always indexed.' : on ? 'Click to drop the index.' : 'Click to create an index.'}`;
        return `<button class="cat-col${on ? ' on' : ''}${pk ? ' pk' : ''}" data-t="${t}" data-c="${c}" title="${esc(info)}"><span>${c}</span>${on ? `<i>${pk ? 'PK' : 'index'}</i>` : ''}</button>`;
      }).join('');
      return `<div class="cat-table">
        <div class="cat-head"><b>${t}</b><label>rows <input class="input cat-rows${changed ? ' changed' : ''}" data-t="${t}" type="number" min="1" max="100000000" step="1" value="${cat.rows(t)}" aria-label="Rows in ${t}"></label></div>
        <div class="cat-cols">${chips}</div>
      </div>`;
    }).join('');
    document.querySelectorAll('#segStorage button').forEach((b) => b.classList.toggle('on', b.dataset.v === cat.storage));
  }

  el.catalog.addEventListener('click', (e) => {
    const b = e.target.closest('.cat-col');
    if (!b) return;
    const { t, c } = b.dataset;
    if (cat.pk(t) === c) {
      toast(`${t}.${c} is the primary key — its index can’t be dropped.`);
      return;
    }
    const had = cat.isIndexed(t, c);
    cat.toggleIndex(t, c);
    replan(had ? `Index on ${t}.${c} dropped` : `Index on ${t}.${c} created`);
  });

  el.catalog.addEventListener('change', (e) => {
    const inp = e.target.closest('.cat-rows');
    if (!inp) return;
    const n = Math.round(+inp.value);
    if (!(n >= 1 && n <= 1e8)) {
      inp.value = cat.rows(inp.dataset.t);
      toast('Rows must be between 1 and 100,000,000.');
      return;
    }
    cat.setRows(inp.dataset.t, n);
    replan(`${inp.dataset.t} now has ${n.toLocaleString('en-US')} rows`);
  });
  el.catalog.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('cat-rows')) e.target.blur();
  });

  $('segStorage').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b || b.dataset.v === cat.storage) return;
    cat.storage = b.dataset.v;
    replan(cat.storage === 'ssd' ? 'SSD: a random page read now costs 1.1 instead of 4.0' : 'Hard disk: a random page read costs 4.0');
  });

  $('btnResetStats').addEventListener('click', () => {
    cat.reset();
    replan('Statistics and indexes reset');
  });

  // ---------- Wiring ----------

  const group = document.createElement('optgroup');
  group.label = 'Example queries';
  EXAMPLES.forEach((x, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = x.name;
    group.appendChild(o);
  });
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = 'Your own query';
  custom.disabled = true;
  el.examples.append(custom, group);

  el.examples.addEventListener('change', () => {
    if (el.examples.value !== 'custom') loadExample(+el.examples.value);
    el.examples.blur();
  });

  el.sql.addEventListener('input', updateEditor);
  el.sql.addEventListener('scroll', () => { el.hl.scrollTop = el.sql.scrollTop; });
  el.sql.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      optimize();
    } else if (e.key === 'Escape') {
      el.sql.blur();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      el.sql.setRangeText('  ', el.sql.selectionStart, el.sql.selectionEnd, 'end');
      updateEditor();
    }
  });
  el.optimize.addEventListener('click', () => optimize());

  el.pipeline.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-phase]');
    if (b) jumpPhase(b.dataset.phase);
  });

  $('btnStart').addEventListener('click', toStart);
  $('btnBack').addEventListener('click', () => stepBy(-1));
  el.play.addEventListener('click', togglePlay);
  $('btnNext').addEventListener('click', () => stepBy(1));
  $('btnEnd').addEventListener('click', toEnd);

  el.stepLog.addEventListener('click', (e) => {
    const li = e.target.closest('li.st');
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
    el.board.style.setProperty('--dur', `${Math.round(600 / prefs.speed)}ms`);
    savePrefs();
  });
  el.speed.addEventListener('change', () => el.speed.blur());
  el.board.style.setProperty('--dur', `${Math.round(600 / prefs.speed)}ms`);

  el.autoplay.checked = prefs.autoplay;
  el.autoplay.addEventListener('change', () => {
    prefs.autoplay = el.autoplay.checked;
    savePrefs();
    el.autoplay.blur();
    if (!prefs.autoplay) T.playing = false;
    refreshPlayer();
    toast(prefs.autoplay ? 'Auto-play on: Optimize plays all steps on its own.' : 'Step mode: press → (or Next) to advance one step at a time.');
  });

  const openHelp = () => { el.help.hidden = false; $('btnHelpClose').focus(); };
  const closeHelp = () => { el.help.hidden = true; };
  $('btnHelp').addEventListener('click', openHelp);
  $('btnHelpClose').addEventListener('click', closeHelp);
  el.help.addEventListener('click', (e) => { if (e.target === el.help) closeHelp(); });

  DemoShell.initThemeToggle($('btnTheme'));
  DemoShell.initFullscreen($('btnFullscreen'));
  window.addEventListener('themechange', () => view.readTheme());

  // Compact: the editor shows only the query's first line until it is clicked.
  function applyCompact() {
    document.querySelector('.querybar').classList.toggle('compact', prefs.compact);
    $('btnCompact').querySelector('span').textContent = prefs.compact ? 'More' : 'Less';
  }
  function toggleCompact() {
    prefs.compact = !prefs.compact;
    savePrefs();
    applyCompact();
    if (prefs.compact) el.sql.blur();
  }
  $('btnCompact').addEventListener('click', toggleCompact);

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
  el.sql.addEventListener('blur', () => { el.sql.scrollTop = 0; el.hl.scrollTop = 0; });

  document.addEventListener('keydown', (e) => {
    if (!el.help.hidden) {
      if (e.key === 'Escape' || e.key === '?') { closeHelp(); e.preventDefault(); }
      return;
    }
    const t = e.target;
    if (t.matches('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
    if (t.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { optimize(); e.preventDefault(); }
      return;
    }
    switch (e.key) {
      case ' ': togglePlay(); break;
      case 'ArrowRight': stepBy(1); break;
      case 'ArrowLeft': stepBy(-1); break;
      case 'Home': toStart(); break;
      case 'End': toEnd(); break;
      case '1': case '2': case '3': case '4': jumpPhase(PHASES[+e.key - 1]); break;
      case 'e': case 'E': case '/': el.sql.focus(); break;
      case 'q': case 'Q': toggleCompact(); break;
      case 'x': case 'X': {
        const i = EXAMPLES.findIndex((x) => x.sql === el.sql.value);
        loadExample(i + 1);
        break;
      }
      case '?': openHelp(); break;
      default: return;
    }
    e.preventDefault();
  });

  // ---------- Start ----------

  applySidebar();
  applyCompact();
  renderPseudoLines();
  renderCatalog();
  el.sql.value = prefs.sql != null && prefs.sql.trim() ? prefs.sql : EXAMPLES[0].sql;
  updateEditor();
  refresh(false);
  optimize({ play: false });
  requestAnimationFrame(loop);
})();
