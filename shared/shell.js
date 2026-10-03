/* Small helpers shared by every demo page: theme toggle, fullscreen, focus handling. */
(function (global) {
  'use strict';

  // Shown as a watermark on every demo and in each page's credits.
  const AUTHOR = 'Dinuka Kodithuwakku';
  const THEME_KEY = 'lecture-demos.theme';
  const darkQuery = global.matchMedia('(prefers-color-scheme: dark)');

  function effectiveTheme() {
    return document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');
  }

  function notifyTheme() {
    global.dispatchEvent(new CustomEvent('themechange', { detail: effectiveTheme() }));
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* storage unavailable */ }
    notifyTheme();
  }

  function initThemeToggle(button) {
    button.addEventListener('click', () => setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'));
    darkQuery.addEventListener('change', notifyTheme);
  }

  function initFullscreen(button) {
    if (!document.documentElement.requestFullscreen) {
      button.hidden = true;
      return;
    }
    button.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    });
    document.addEventListener('fullscreenchange', () => button.classList.toggle('on', !!document.fullscreenElement));
  }

  // Mouse clicks shouldn't leave focus on a button: otherwise Space / arrow-key
  // shortcuts would re-trigger the last clicked button during a lecture.
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) e.preventDefault();
  });

  // Any element marked data-author gets the author's name.
  document.querySelectorAll('[data-author]').forEach((n) => { n.textContent = AUTHOR; });

  // Watermark: a small, semi-transparent signature in the bottom-right corner
  // of the drawing area (the element marked data-watermark-host, else the
  // canvas's container, else the page). It ignores the mouse so it never
  // blocks a control. Pages can opt out with <body data-no-watermark>.
  if (!document.body.hasAttribute('data-no-watermark')) {
    const canvas = document.querySelector('canvas');
    const host = document.querySelector('[data-watermark-host]') || (canvas && canvas.parentElement);
    const mark = document.createElement('div');
    mark.className = 'author-watermark' + (host ? '' : ' fixed');
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = '<span class="aw-dot"></span><span class="aw-by">by</span> <span class="aw-name"></span>';
    mark.querySelector('.aw-name').textContent = AUTHOR;
    if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative';
    (host || document.body).appendChild(mark);
  }

  global.DemoShell = { AUTHOR, THEME_KEY, effectiveTheme, setTheme, initThemeToggle, initFullscreen };
})(window);
