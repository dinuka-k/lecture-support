/*
 * Wires the recursive-CTE model and view to the page: scenario and UNION
 * controls, step playback, the step list, pseudocode and shortcuts.
 */
(function () {
  'use strict';

  const M = window.CteModel;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---------- Preferences (remembered in this browser only) ----------

  const PREFS_KEY = 'lecture-demos.recursive-cte';
  const prefs = { scenario: 'count', distinct: false, speed: 1, sidebar: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY)) || {}); } catch (e) { /* storage unavailable */ }
  if (!M.SCENARIOS[prefs.scenario]) prefs.scenario = 'count';
  prefs.distinct = !!prefs.distinct;
  prefs.speed = clamp(Number(prefs.speed) || 1, 0.25, 4);
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

  const BASE_DELAY = 1800; // ms per step at 1x; the speed slider scales it evenly

  const el = {
    caption: $('caption'),
    captionText: $('captionText'),
    sql: $('sql'),
    graph: $('graph'),
    graphTitle: $('graphTitle'),
    cardBase: $('cardBase'),
    baseName: $('baseName'),
    baseInfo: $('baseInfo'),
    baseTbl: $('baseTbl'),
    workInfo: $('workInfo'),
    workTbl: $('workTbl'),
    resName: $('resName'),
    resInfo: $('resInfo'),
    resTbl: $('resTbl'),
  };
  const view = new CteView(el);

  const ui = {
    stepLog: $('stepLog'),
    stepsTitle: $('stepsTitle'),
    pseudo: $('pseudo'),
    legend: $('legend'),
    play: $('btnPlay'),
    opLabel: $('opLabel'),
    stepLabel: $('stepLabel'),
    progress: $('progressFill'),
    speed: $('speed'),
    speedOut: $('speedOut'),
    help: $('help'),
  };

  // ---------- Run + playback ----------

  let run = null;
  let cur = 0;
  let timer = null;

  function rebuild() {
    stop();
    const scn = M.SCENARIOS[prefs.scenario];
    run = M.run(scn, prefs.distinct);
    view.setScenario(scn, run.lines);
    buildStepLog();
    buildPseudo();
    buildLegend();
    syncControls();
    show(0);
  }

  function show(i) {
    cur = clamp(i, 0, run.steps.length - 1);
    const step = run.steps[cur];
    view.render(step);

    const lis = ui.stepLog.children;
    for (let k = 0; k < lis.length; k += 1) lis[k].classList.toggle('current', k === cur);
    const li = lis[cur];
    if (li) {
      const box = ui.stepLog;
      if (li.offsetTop < box.scrollTop) box.scrollTop = li.offsetTop - 4;
      else if (li.offsetTop + li.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = li.offsetTop + li.offsetHeight - box.clientHeight + 4;
    }

    [...ui.pseudo.children].forEach((div, k) => div.classList.toggle('on', step.pseudo.includes(k)));

    ui.opLabel.textContent = `${M.SCENARIOS[prefs.scenario].title} · ${prefs.distinct ? 'UNION' : 'UNION ALL'}`;
    ui.stepLabel.textContent = `Step ${cur + 1} of ${run.steps.length}`;
    ui.progress.style.width = `${(cur / Math.max(1, run.steps.length - 1)) * 100}%`;
    $('btnBack').disabled = $('btnStart').disabled = cur === 0;
    $('btnNext').disabled = $('btnEnd').disabled = cur === run.steps.length - 1;
  }

  function buildStepLog() {
    const frag = document.createDocumentFragment();
    run.steps.forEach((st, i) => {
      const li = document.createElement('li');
      li.textContent = st.short;
      li.className = 's-' + st.status;
      li.addEventListener('click', () => { stop(); show(i); });
      frag.appendChild(li);
    });
    ui.stepLog.replaceChildren(frag);
    ui.stepsTitle.textContent = `(${run.steps.length})`;
  }

  function buildPseudo() {
    ui.pseudo.replaceChildren();
    run.pseudo.forEach((l) => {
      const div = document.createElement('div');
      div.className = 'ln';
      div.style.setProperty('--indent', `${l.i * 2}ch`);
      div.appendChild(document.createTextNode(l.t));
      if (l.cm) {
        const cm = document.createElement('span');
        cm.className = 'cm';
        cm.textContent = '  # ' + l.cm;
        div.appendChild(cm);
      }
      ui.pseudo.appendChild(div);
    });
  }

  function buildLegend() {
    const frag = document.createDocumentFragment();
    const maxRound = Math.min(5, run.steps[run.steps.length - 1].result.reduce((m, r) => Math.max(m, r.round), 0));
    for (let r = 0; r <= maxRound; r += 1) {
      const li = document.createElement('li');
      const sw = document.createElement('span');
      sw.className = 'rd-pill ' + 'it' + (r % CteView.NROUNDS);
      sw.textContent = String(r);
      li.appendChild(sw);
      li.appendChild(document.createTextNode(r === 0 ? 'Anchor' : 'Round ' + r));
      frag.appendChild(li);
    }
    ui.legend.replaceChildren(frag);
  }

  function step(d) { stop(); show(cur + d); }

  function play() {
    if (timer) return;
    if (cur >= run.steps.length - 1) show(0);
    ui.play.innerHTML = '<svg class="icon"><use href="#i-pause"/></svg>';
    ui.play.setAttribute('aria-label', 'Pause');
    const tick = () => {
      if (cur >= run.steps.length - 1) { stop(); return; }
      show(cur + 1);
      timer = setTimeout(tick, BASE_DELAY / prefs.speed);
    };
    timer = setTimeout(tick, BASE_DELAY / prefs.speed);
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    ui.play.innerHTML = '<svg class="icon"><use href="#i-play"/></svg>';
    ui.play.setAttribute('aria-label', 'Play');
  }

  // ---------- Controls ----------

  function syncControls() {
    document.querySelectorAll('#segScenario button').forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.scenario));
    document.querySelectorAll('#segUnion button').forEach((b) => b.classList.toggle('on', (b.dataset.v === 'distinct') === prefs.distinct));
    ui.speed.value = prefs.speed;
    ui.speedOut.textContent = prefs.speed + '×';
    document.body.classList.toggle('no-sidebar', !prefs.sidebar);
  }

  function setScenario(id) {
    if (!M.SCENARIOS[id] || id === prefs.scenario) return;
    prefs.scenario = id;
    savePrefs();
    rebuild();
  }

  function setDistinct(v) {
    if (v === prefs.distinct) return;
    prefs.distinct = v;
    savePrefs();
    rebuild();
  }

  $('segScenario').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setScenario(b.dataset.v); });
  $('segUnion').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setDistinct(b.dataset.v === 'distinct'); });
  $('btnStart').addEventListener('click', () => { stop(); show(0); });
  $('btnBack').addEventListener('click', () => step(-1));
  $('btnNext').addEventListener('click', () => step(1));
  $('btnEnd').addEventListener('click', () => { stop(); show(run.steps.length - 1); });
  ui.play.addEventListener('click', () => (timer ? stop() : play()));
  ui.speed.addEventListener('input', () => {
    prefs.speed = Number(ui.speed.value);
    ui.speedOut.textContent = prefs.speed + '×';
    savePrefs();
  });
  $('btnSidebar').addEventListener('click', () => { prefs.sidebar = !prefs.sidebar; savePrefs(); syncControls(); });

  DemoShell.initThemeToggle($('btnTheme'));
  DemoShell.initFullscreen($('btnFullscreen'));

  // Help dialog
  const openHelp = () => { ui.help.hidden = false; };
  const closeHelp = () => { ui.help.hidden = true; };
  $('btnHelp').addEventListener('click', openHelp);
  $('btnHelpClose').addEventListener('click', closeHelp);
  ui.help.addEventListener('click', (e) => { if (e.target === ui.help) closeHelp(); });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') { closeHelp(); return; }
    if (e.key === '?') { ui.help.hidden ? openHelp() : closeHelp(); return; }
    if (!ui.help.hidden) return;
    const k = e.key.toLowerCase();
    if (e.key === ' ') { e.preventDefault(); timer ? stop() : play(); }
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'Home') { stop(); show(0); }
    else if (e.key === 'End') { stop(); show(run.steps.length - 1); }
    else if (k === 'u') setDistinct(!prefs.distinct);
    else if (k >= '1' && k <= '3') setScenario(M.ORDER[Number(k) - 1]);
  });

  rebuild();
})();
