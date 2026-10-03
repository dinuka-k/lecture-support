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

  global.DemoShell = { AUTHOR, THEME_KEY, effectiveTheme, setTheme, initThemeToggle, initFullscreen };
})(window);
