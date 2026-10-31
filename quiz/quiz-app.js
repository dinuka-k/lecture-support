/* DBMS quiz: the join screen and the switch between the host and player views.
   Typing "admin" as the nickname asks for the admin password and opens the host screen. */
(function () {
  'use strict';

  const D = window.QuizData;
  const SALT = 'lsquiz:';
  // Default admin password "dbms@2026"; changing it in the app stores a new hash on that device.
  const DEFAULT_HASH = '212dfcd7d155f8263901798b905015b4f05ac9f50271b67daac53324233ec612';
  const HASH_KEY = 'lecture-demos.quiz.adminHash';
  const ADMIN_SESSION = 'lecture-demos.quiz.admin';
  const PLAYER_SESSION = 'lecture-demos.quiz.player';
  const NAME_KEY = 'lecture-demos.quiz.name';

  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const form = $('loginForm');
  const inRoom = $('inRoom'), inName = $('inName'), inPass = $('inPass');
  const err = $('loginErr');

  function get(store, key) { try { return store.getItem(key); } catch (e) { return null; } }
  function set(store, key, v) { try { if (v == null) store.removeItem(key); else store.setItem(key, v); } catch (e) { /* storage unavailable */ } }

  function adminHash() { return get(localStorage, HASH_KEY) || DEFAULT_HASH; }
  const isAdminName = (s) => s.trim().toLowerCase() === 'admin';

  let toastTimer = null;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function setView(v) {
    app.dataset.view = v;
    $('scrLogin').hidden = v !== 'login';
    $('scrHost').hidden = v !== 'host';
    $('scrPlayer').hidden = v !== 'player';
  }

  // ---------- Join screen ----------

  function updateLoginMode() {
    const admin = isAdminName(inName.value);
    $('pwWrap').hidden = !admin;
    $('roomWrap').hidden = admin;
    $('btnJoin').textContent = admin ? 'Open host screen' : 'Join';
    inPass.required = admin;
    inRoom.required = !admin;
  }

  function showLogin(reason) {
    setView('login');
    err.textContent = reason || '';
    err.hidden = !reason;
    updateLoginMode();
    setTimeout(() => (inRoom.value && !isAdminName(inName.value) ? inName : inRoom.value ? inName : inRoom).focus(), 50);
  }

  inName.addEventListener('input', updateLoginMode);
  inRoom.addEventListener('input', () => {
    const v = inRoom.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    if (v !== inRoom.value) inRoom.value = v;
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.hidden = true;
    const name = inName.value.replace(/\s+/g, ' ').trim();
    if (isAdminName(name)) {
      if (D.sha256(SALT + inPass.value) !== adminHash()) {
        err.textContent = 'Wrong password.';
        err.hidden = false;
        form.classList.remove('shake');
        void form.offsetWidth;
        form.classList.add('shake');
        inPass.select();
        return;
      }
      inPass.value = '';
      set(sessionStorage, ADMIN_SESSION, '1');
      startHost();
      return;
    }
    const code = inRoom.value.trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) { err.textContent = 'Enter the 5-character room code from the big screen.'; err.hidden = false; inRoom.focus(); return; }
    if (!name) { err.textContent = 'Pick a nickname.'; err.hidden = false; inName.focus(); return; }
    set(localStorage, NAME_KEY, name);
    const prev = JSON.parse(get(sessionStorage, PLAYER_SESSION) || 'null');
    const cid = prev && prev.code === code && prev.name === name ? prev.cid : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const who = { code, name: name.slice(0, 16), cid };
    set(sessionStorage, PLAYER_SESSION, JSON.stringify(who));
    startPlayer(who);
  });

  // ---------- Host ----------

  let hostStarted = false;

  function startHost() {
    setView('host');
    history.replaceState(null, '', location.pathname);
    if (hostStarted) return;
    hostStarted = true;
    window.QuizEditor.init($('editor'), () => window.QuizHost.getQuestions(), (list) => window.QuizHost.setQuestions(list));
    window.QuizHost.start($('scrHost'), {
      status(state, text) {
        const dot = $('netDot');
        dot.dataset.state = state;
        dot.title = text || '';
        $('netText').textContent = state === 'online' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Offline';
        if (state === 'offline' && text) toast(text);
      },
      toast,
      editQuestions: () => window.QuizEditor.open(),
      phase(p) {
        $('roomCode').textContent = JSON.parse(get(localStorage, 'lecture-demos.quiz.room') || '"-"');
        $('btnNewGame').hidden = p === 'lobby';
      },
    });
  }

  $('btnQuestions').addEventListener('click', () => window.QuizEditor.open());
  $('btnNewGame').addEventListener('click', () => {
    if (window.QuizHost.inGame() && !confirm('End this game and go back to the lobby? Scores are reset; players stay connected.')) return;
    window.QuizHost.newGame();
  });
  $('btnLogout').addEventListener('click', () => {
    if (!confirm('Close the host screen? Players stay in the room until you open it again.')) return;
    set(sessionStorage, ADMIN_SESSION, null);
    location.reload();
  });

  // ---------- Change password ----------

  const pwModal = $('pwModal');
  $('btnPassword').addEventListener('click', () => {
    $('pwForm').reset();
    $('pwErr').hidden = true;
    pwModal.hidden = false;
    $('pwOld').focus();
  });
  $('btnPwCancel').addEventListener('click', () => { pwModal.hidden = true; });
  $('pwForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const fail = (t) => { $('pwErr').textContent = t; $('pwErr').hidden = false; };
    if (D.sha256(SALT + $('pwOld').value) !== adminHash()) return fail('The current password is wrong.');
    if ($('pwNew').value.length < 4) return fail('Use at least 4 characters.');
    if ($('pwNew').value !== $('pwNew2').value) return fail('The two new passwords differ.');
    set(localStorage, HASH_KEY, D.sha256(SALT + $('pwNew').value));
    pwModal.hidden = true;
    toast('Password changed on this device.');
  });

  // ---------- Player ----------

  function startPlayer(who) {
    setView('player');
    $('meName').textContent = who.name;
    $('meScore').textContent = '0';
    window.QuizPlayer.start($('pBody'), $('pBanner'), who, {
      onExit(reason) {
        set(sessionStorage, PLAYER_SESSION, null);
        inRoom.value = who.code;
        inName.value = who.name;
        showLogin(reason);
      },
      onScore(name, score) {
        $('meName').textContent = name;
        $('meScore').textContent = (score || 0).toLocaleString();
      },
    });
  }

  $('btnLeave').addEventListener('click', () => {
    if (!confirm('Leave the quiz? You can rejoin with the same nickname.')) return;
    window.QuizPlayer.stop();
    set(sessionStorage, PLAYER_SESSION, null);
    showLogin();
  });

  // ---------- Help, theme, fullscreen ----------

  const help = $('help');
  $('btnHelp').addEventListener('click', () => { help.hidden = false; });
  $('btnHelpClose').addEventListener('click', () => { help.hidden = true; });
  [help, pwModal].forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { help.hidden = true; pwModal.hidden = true; }
    else if (e.key === '?' && !e.target.closest('input, textarea')) help.hidden = !help.hidden;
  });
  window.DemoShell.initThemeToggle($('btnTheme'));
  window.DemoShell.initFullscreen($('btnFullscreen'));

  // ---------- Start ----------

  const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  inRoom.value = urlRoom;
  inName.value = get(localStorage, NAME_KEY) || '';

  const saved = JSON.parse(get(sessionStorage, PLAYER_SESSION) || 'null');
  if (get(sessionStorage, ADMIN_SESSION) === '1') startHost();
  else if (saved && (!urlRoom || urlRoom === saved.code)) startPlayer(saved);
  else showLogin();
})();
