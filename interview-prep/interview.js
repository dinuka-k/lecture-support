/* Interview prep deck: slide and build navigation, outline, speaker notes, scaling. */
(function () {
  'use strict';

  const W = 1280;
  const H = 720;
  const stage = document.getElementById('stage');
  const deck = document.getElementById('deck');
  const slides = Array.from(deck.querySelectorAll('.slide'));
  const builds = slides.map((s) => Array.from(s.querySelectorAll('.f')));
  const caption = document.getElementById('caption');
  const counter = document.getElementById('counter');
  const progress = document.getElementById('progress');
  const notesPanel = document.getElementById('notesPanel');
  const outline = document.getElementById('outline');
  const outlineList = document.getElementById('outlineList');
  const help = document.getElementById('help');
  const btnPrev = document.getElementById('btnPrev');
  const btnNext = document.getElementById('btnNext');
  const btnNotes = document.getElementById('btnNotes');
  const btnOutline = document.getElementById('btnOutline');

  const UI_KEY = 'interview-prep.ui';
  let ui = { notes: false, outline: false };
  try { Object.assign(ui, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); } catch (e) { /* storage unavailable */ }
  function saveUi() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* storage unavailable */ } }

  let cur = 0;   // slide index
  let step = 0;  // how many builds of the current slide are shown

  /* ---------- Scaling ---------- */

  function fit() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    const pad = w < 700 ? 8 : 24;
    const s = Math.min((w - pad * 2) / W, (h - pad * 2) / H);
    const edge = Math.min(w / W, h / H);
    // In fullscreen or on small screens, use every pixel.
    const useEdge = !!document.fullscreenElement || w < 700;
    deck.style.setProperty('--scale', String(useEdge ? edge : s));
    stage.classList.toggle('edge', useEdge);
  }
  new ResizeObserver(fit).observe(stage);
  document.addEventListener('fullscreenchange', fit);

  /* ---------- Rendering ---------- */

  function titleOf(i) { return slides[i].dataset.title || ''; }

  function render() {
    slides.forEach((s, i) => {
      s.classList.toggle('on', i === cur);
      s.classList.toggle('past', i < cur);
      s.setAttribute('aria-hidden', i === cur ? 'false' : 'true');
    });
    builds[cur].forEach((el, k) => el.classList.toggle('shown', k < step));
    // Slides you have left keep everything visible, so going back looks complete.
    slides.forEach((s, i) => {
      if (i !== cur) builds[i].forEach((el) => el.classList.toggle('shown', i < cur));
    });

    const total = builds[cur].length;
    const part = slides[cur].dataset.part || '';
    caption.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = part;
    caption.append(b, document.createTextNode(titleOf(cur) + (total ? '  ·  point ' + step + ' of ' + total : '')));
    counter.textContent = (cur + 1) + ' / ' + slides.length;
    const done = cur + (total ? step / total : 1);
    progress.style.width = (100 * done / slides.length) + '%';
    btnPrev.disabled = cur === 0 && step === 0;
    btnNext.disabled = cur === slides.length - 1 && step === total;

    const notes = slides[cur].querySelector('.notes');
    notesPanel.innerHTML = '<h4>Speaker notes · ' + (cur + 1) + '</h4>' + (notes ? notes.innerHTML : '<p>No notes for this slide.</p>');
    notesPanel.hidden = !ui.notes;
    btnNotes.classList.toggle('on', ui.notes);

    outline.hidden = !ui.outline;
    btnOutline.classList.toggle('on', ui.outline);
    outlineList.querySelectorAll('button').forEach((btn) => {
      const on = Number(btn.dataset.i) === cur;
      btn.classList.toggle('on', on);
      if (on && ui.outline) btn.scrollIntoView({ block: 'nearest' });
    });

    const hash = '#' + (cur + 1);
    if (location.hash !== hash) history.replaceState(null, '', hash);
    fit();
  }

  /* ---------- Navigation ---------- */

  function go(i, showAll) {
    cur = Math.max(0, Math.min(slides.length - 1, i));
    step = showAll ? builds[cur].length : 0;
    render();
  }
  function next() {
    if (step < builds[cur].length) { step++; render(); }
    else if (cur < slides.length - 1) go(cur + 1);
  }
  function prev() {
    if (step > 0) { step--; render(); }
    else if (cur > 0) go(cur - 1, true);
  }

  btnNext.addEventListener('click', next);
  btnPrev.addEventListener('click', prev);
  btnNotes.addEventListener('click', () => { ui.notes = !ui.notes; saveUi(); render(); });
  btnOutline.addEventListener('click', () => { ui.outline = !ui.outline; saveUi(); render(); });

  /* ---------- Outline ---------- */

  let lastPart = '';
  slides.forEach((s, i) => {
    const part = s.dataset.part || '';
    if (part !== lastPart) {
      const h = document.createElement('li');
      h.className = 'part';
      h.textContent = part;
      outlineList.appendChild(h);
      lastPart = part;
    }
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.dataset.i = String(i);
    btn.innerHTML = '<span class="n"></span><span class="t"></span>';
    btn.querySelector('.n').textContent = String(i + 1);
    btn.querySelector('.t').textContent = titleOf(i);
    btn.addEventListener('click', () => go(i, true));
    li.appendChild(btn);
    outlineList.appendChild(li);
  });

  /* ---------- Help ---------- */

  function openHelp() { help.hidden = false; }
  function closeHelp() { help.hidden = true; }
  document.getElementById('btnHelp').addEventListener('click', openHelp);
  document.getElementById('btnHelpClose').addEventListener('click', closeHelp);
  help.addEventListener('click', (e) => { if (e.target === help) closeHelp(); });

  /* ---------- Keyboard, swipe ---------- */

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!help.hidden) {
      if (e.key === 'Escape' || e.key === '?') { closeHelp(); e.preventDefault(); }
      return;
    }
    switch (e.key) {
      case 'ArrowRight': case ' ': case 'PageDown': case 'Enter': next(); break;
      case 'ArrowLeft': case 'PageUp': case 'Backspace': prev(); break;
      case 'ArrowDown': go(cur + 1); break;
      case 'ArrowUp': go(cur - 1, true); break;
      case 'Home': go(0); break;
      case 'End': go(slides.length - 1, true); break;
      case 'n': case 'N': btnNotes.click(); break;
      case 'o': case 'O': btnOutline.click(); break;
      case 't': case 'T': document.getElementById('btnTheme').click(); break;
      case 'f': case 'F': document.getElementById('btnFull').click(); break;
      case '?': openHelp(); break;
      default: return;
    }
    e.preventDefault();
  });

  let touchX = null;
  stage.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) (dx < 0 ? next : prev)();
  });

  window.addEventListener('hashchange', () => {
    const n = parseInt(location.hash.slice(1), 10);
    if (n >= 1 && n <= slides.length && n - 1 !== cur) go(n - 1, true);
  });

  DemoShell.initThemeToggle(document.getElementById('btnTheme'));
  DemoShell.initFullscreen(document.getElementById('btnFull'));

  const start = parseInt(location.hash.slice(1), 10);
  if (start >= 1 && start <= slides.length) go(start - 1, start > 1);
  else go(0);
})();
