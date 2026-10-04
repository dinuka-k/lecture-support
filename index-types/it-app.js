/*
 * Wires the index-types scenes and view to the page: scene switching, the step
 * timeline and playback, side panels and keyboard shortcuts.
 */
(function () {
  'use strict';

  const { SCENES } = window.ITScenes;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const PREFS_KEY = 'lecture-demos.index-types';
  const prefs = { scene: 'cluster', speed: 1, autoplay: false, sidebar: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY)) || {}); } catch (e) { /* storage unavailable */ }
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

  const el = {
    wrap: $('canvasWrap'), caption: $('caption'), captionText: $('captionText'), rules: $('rules'),
    stepLog: $('stepLog'), points: $('points'), play: $('btnPlay'), opLabel: $('opLabel'), stepLabel: $('stepLabel'),
    progress: $('progressFill'), speed: $('speed'), speedOut: $('speedOut'), autoplay: $('autoplay'), help: $('help'),
  };

  const view = new ITView($('canvas'));
  const seeds = {};
  const T = { steps: [], cur: 0, anim: null, playing: false, holdUntil: 0 };
  const holdMs = (s) => (s.status === 'info' ? 2600 : 3400) / prefs.speed;

  function load(scene, newSeed) {
    // A fixed first example per scene (repeatable in class); New data draws a fresh one.
    if (newSeed) seeds[scene] = 1 + Math.floor(Math.random() * 1e9);
    else if (!seeds[scene]) seeds[scene] = 20261004;
    prefs.scene = scene;
    savePrefs();
    T.steps = SCENES[scene].build(seeds[scene]);
    T.cur = 0;
    T.anim = null;
    T.playing = prefs.autoplay;
    T.holdUntil = performance.now() + holdMs(T.steps[0]);
    view.snapCam = true;
    document.querySelectorAll('#segScene button').forEach((b) => b.classList.toggle('on', b.dataset.v === scene));
    el.points.innerHTML = SCENES[scene].points.map((p) => `<li>${p}</li>`).join('');
    document.querySelectorAll('#cmp tr[data-v]').forEach((tr) => tr.classList.toggle('on', tr.dataset.v === scene));
    refresh();
  }

  function go(i) {
    i = clamp(i, 0, T.steps.length - 1);
    if (i === T.cur) return;
    const from = T.steps[T.cur];
    const fwd = i === T.cur + 1;
    T.cur = i;
    T.anim = { from, to: T.steps[i], t0: performance.now(), dur: (fwd ? 800 : 300) / prefs.speed };
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
    if (T.playing) T.playing = false;
    else {
      if (T.cur >= T.steps.length - 1) go(0);
      T.playing = true;
      T.holdUntil = 0;
    }
    refreshPlayer();
  }
  const stepBy = (d) => { T.playing = false; go(T.cur + d); refreshPlayer(); };

  function refresh() {
    const step = T.steps[T.cur];
    el.caption.dataset.status = step.status;
    el.captionText.textContent = step.msg;
    el.rules.innerHTML = step.stats.map((s) => `<span>${s}</span>`).join('');
    const frag = document.createDocumentFragment();
    for (let i = 0; i <= T.cur; i++) {
      const li = document.createElement('li');
      li.textContent = T.steps[i].msg;
      li.dataset.i = i;
      li.className = `s-${T.steps[i].status}${i === T.cur ? ' current' : ''}`;
      frag.appendChild(li);
    }
    el.stepLog.replaceChildren(frag);
    el.stepLog.scrollTop = el.stepLog.scrollHeight;
    refreshPlayer();
    const w = el.wrap.getBoundingClientRect(), cap = el.caption.getBoundingClientRect();
    view.insets = { top: cap.bottom - w.top + 10, bottom: 30, left: 0, right: 0 };
    view.dirty = true;
  }

  function refreshPlayer() {
    const last = T.steps.length - 1;
    el.play.querySelector('use').setAttribute('href', T.playing ? '#i-pause' : '#i-play');
    el.play.setAttribute('aria-label', T.playing ? 'Pause' : 'Play');
    $('btnStart').disabled = T.cur === 0;
    $('btnBack').disabled = T.cur === 0;
    $('btnNext').disabled = T.cur >= last;
    $('btnEnd').disabled = T.cur >= last;
    el.opLabel.textContent = SCENES[prefs.scene].name;
    el.stepLabel.textContent = `step ${T.cur + 1} of ${T.steps.length}`;
    el.progress.style.width = `${((T.cur + 1) / T.steps.length) * 100}%`;
  }

  // ---------- Wiring ----------

  document.querySelectorAll('#segScene button').forEach((b) => b.addEventListener('click', () => load(b.dataset.v)));
  document.querySelectorAll('#cmp tr[data-v]').forEach((tr) => tr.addEventListener('click', () => load(tr.dataset.v)));
  $('btnNew').addEventListener('click', () => load(prefs.scene, true));
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
    if (prefs.autoplay && !T.playing && T.cur < T.steps.length - 1) togglePlay();
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
  new ResizeObserver(() => { view.resize(); view.snapCam = true; refresh(); }).observe(el.wrap);

  const KEYS = ['cluster', 'dense', 'bitmap', 'gin', 'gist', 'brin'];
  document.addEventListener('keydown', (e) => {
    if (!el.help.hidden) {
      if (e.key === 'Escape' || e.key === '?') { closeHelp(); e.preventDefault(); }
      return;
    }
    if (e.target.matches('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
    if (e.target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[1-6]$/.test(e.key)) { load(KEYS[+e.key - 1]); e.preventDefault(); return; }
    switch (e.key) {
      case ' ': togglePlay(); break;
      case 'ArrowRight': stepBy(1); break;
      case 'ArrowLeft': stepBy(-1); break;
      case 'Home': T.playing = false; go(0); refreshPlayer(); break;
      case 'End': T.playing = false; go(T.steps.length - 1); refreshPlayer(); break;
      case 'n': case 'N': load(prefs.scene, true); break;
      case '?': openHelp(); break;
      default: return;
    }
    e.preventDefault();
  });

  applySidebar();
  load(SCENES[prefs.scene] ? prefs.scene : 'cluster');
  requestAnimationFrame(loop);
})();
