/* Player screen (a student's phone): waits in the lobby, answers, sees the result. */
(function (global) {
  'use strict';

  const Net = global.QuizNet;
  const SHAPES = ['tri', 'dia', 'cir', 'sqr'];

  let root = null, banner = null, net = null, cb = {}, me = null;
  let current = null;     // the question on screen
  let open = false;       // a question is waiting for this player's answer
  let away = false;       // the page is hidden or lost focus during a question
  let startedAt = 0, tick = null;
  const drafts = {};      // typed queries, kept if the question is sent again

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function show(html, cls) {
    clearInterval(tick);
    open = false;
    root.className = 'p-screen ' + (cls || '');
    root.innerHTML = html;
  }

  function status(state, text) {
    if (state === 'open') {
      banner.hidden = true;
      net.send({ t: 'join', name: me.name, cid: me.cid });
    } else if (state === 'notfound') {
      exit(text);
    } else if (state === 'connecting') {
      if (!root.innerHTML) show('<div class="p-center"><div class="spinner"></div><p>Joining room <b>' + esc(me.code) + '</b></p></div>');
    } else {
      banner.textContent = text || 'Reconnecting';
      banner.hidden = false;
    }
  }

  function exit(reason) {
    stop();
    cb.onExit(reason);
  }

  function onMessage(msg) {
    switch (msg.t) {
      case 'joined':
        me.name = msg.name;
        cb.onScore(me.name, msg.score);
        break;
      case 'reject': exit(msg.reason); break;
      case 'kicked': exit('The host removed you from this game.'); break;
      case 'lobby': lobby(msg.reset); break;
      case 'question': question(msg); break;
      case 'locked': locked(msg.correct); break;
      case 'tryagain': tryAgain(msg); break;
      case 'extend':
        if (current && current.qi === msg.qi) { current.limit = msg.limit; startedAt = Date.now() - msg.elapsed; if (open) countdown(); }
        break;
      case 'result': result(msg); break;
      case 'final': final(msg); break;
    }
  }

  function lobby(reset) {
    if (reset) cb.onScore(me.name, 0);
    show('<div class="p-center">' +
      '<div class="p-badge"><svg class="icon"><use href="#i-check"/></svg></div>' +
      '<h2>You\'re in!</h2>' +
      '<p class="p-big-name">' + esc(me.name) + '</p>' +
      '<p class="muted">See your name on the big screen? The quiz starts soon.</p></div>', 'lobby');
  }

  function question(m) {
    current = m;
    startedAt = Date.now() - m.elapsed;
    const head = '<div class="p-head"><span>Q' + (m.qi + 1) + ' / ' + m.total + (m.topic ? ' · ' + esc(m.topic) : '') + '</span>' +
      '<div class="p-timer" id="pTimer"><svg viewBox="0 0 44 44"><circle class="t-bg" cx="22" cy="22" r="19"/><circle class="t-fg" id="pRing" cx="22" cy="22" r="19"/></svg><b id="pTimerNum"></b></div></div>' +
      '<p class="p-over" id="pOver" hidden>Time is up: you can still answer for 500 points</p>';
    const text = '<p class="p-q">' + esc(m.text) + '</p>' + (m.code ? '<pre class="q-code small">' + esc(m.code) + '</pre>' : '');
    let body;
    if (m.type === 'sql') {
      body = '<details class="p-schema"><summary>Tables</summary>' + (m.schema || []).map((t) =>
          '<div><b>' + esc(t.table) + '</b>(' + t.cols.map(esc).join(', ') + ')</div>').join('') + '</details>' +
        '<p class="p-wrong" id="pWrong"' + (m.retry ? '' : ' hidden') + '>Not correct yet. Edit your query and submit again.</p>' +
        '<textarea id="pSql" class="p-sql" rows="6" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="SELECT ..."></textarea>' +
        '<button class="btn btn-primary p-submit" id="pSubmit">Submit query</button>';
    } else {
      body = '<div class="p-opts' + (m.options.length === 2 ? ' two' : '') + '">' + m.options.map((o, i) =>
        '<button class="p-opt opt-' + i + '" data-i="' + i + '"><span class="shape s-' + SHAPES[i] + '"></span><span>' + esc(o) + '</span></button>').join('') + '</div>';
    }
    show(head + text + body, 'question');
    open = true;

    if (m.type === 'sql') {
      const ta = root.querySelector('#pSql');
      ta.value = drafts[m.qi] || '';
      // No pasting: block the paste and drop events, and undo any input that
      // adds a large chunk at once (some phone keyboards paste as typing).
      const blockPaste = (e) => { e.preventDefault(); flag('paste'); };
      ta.addEventListener('paste', blockPaste);
      ta.addEventListener('drop', blockPaste);
      ta.addEventListener('beforeinput', (e) => { if (/^insertFrom(Paste|Drop)/.test(e.inputType)) blockPaste(e); });
      ta.addEventListener('input', () => {
        if (ta.value.length - (drafts[m.qi] || '').length > 25) { ta.value = drafts[m.qi] || ''; flag('paste'); return; }
        drafts[m.qi] = ta.value;
      });
      root.querySelector('#pSubmit').addEventListener('click', () => {
        if (!ta.value.trim()) { ta.focus(); return; }
        answer(ta.value);
      });
    } else {
      root.querySelectorAll('.p-opt').forEach((b) => b.addEventListener('click', () => answer(+b.dataset.i)));
    }
    countdown();
    tick = setInterval(countdown, 250);
  }

  // Counts down the time limit on a draining ring, then counts the total time
  // taken: the question stays open until the host ends it.
  // ---------- Fair play ----------

  function flag(kind) {
    if (!net || !current) return;
    if (kind === 'paste' && open) {
      net.send({ t: 'flag', kind, qi: current.qi });
      warn('Pasting is not allowed', 'Type your answer yourself. The host has been notified.');
    } else if (kind === 'left' && open && !away) {
      away = true;
      net.send({ t: 'flag', kind, qi: current.qi });
    } else if (kind === 'back' && away) {
      away = false;
      net.send({ t: 'flag', kind, qi: current.qi });
      if (open) warn('You left the quiz page', 'Stay on this page until you answer. The host can see that you left.');
    }
  }

  function warn(title, text) {
    let w = document.getElementById('pWarn');
    if (!w) {
      w = document.createElement('div');
      w.id = 'pWarn';
      w.className = 'modal p-warn';
      w.innerHTML = '<div class="modal-card"><svg class="icon"><use href="#i-alert"/></svg><h2></h2><p></p><button class="btn btn-primary btn-big">OK</button></div>';
      w.querySelector('button').addEventListener('click', () => { w.hidden = true; });
      document.body.appendChild(w);
    }
    w.querySelector('h2').textContent = title;
    w.querySelector('p').textContent = text;
    w.hidden = false;
  }

  document.addEventListener('visibilitychange', () => flag(document.hidden ? 'left' : 'back'));
  global.addEventListener('blur', () => flag('left'));
  global.addEventListener('focus', () => flag('back'));
  // No copying the question text out of the page.
  ['copy', 'cut', 'contextmenu'].forEach((type) => document.addEventListener(type, (e) => {
    if (open && root.contains(e.target)) e.preventDefault();
  }));

  function countdown() {
    const elapsed = Date.now() - startedAt;
    const limit = current.limit * 1000;
    const left = Math.max(0, limit - elapsed);
    const t = root.querySelector('#pTimer');
    if (!t) return;
    const sec = left > 0 ? Math.ceil(left / 1000) : Math.floor(elapsed / 1000);
    root.querySelector('#pTimerNum').textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    root.querySelector('#pRing').style.strokeDashoffset = String(119.4 * (1 - left / limit));
    t.classList.toggle('low', left > 0 && left < 10000);
    t.classList.toggle('over', left <= 0);
    root.querySelector('#pOver').hidden = left > 0;
  }

  function answer(value) {
    if (!current) return;
    net.send({ t: 'answer', qi: current.qi, value });
    if (current.type !== 'sql') { locked(); return; }
    // The host checks the query and replies with locked (right) or tryagain (wrong).
    const btn = root.querySelector('#pSubmit');
    btn.disabled = true;
    btn.textContent = 'Checking';
    root.querySelector('#pSql').readOnly = true;
  }

  function tryAgain(m) {
    if (!current || current.qi !== m.qi || !root.querySelector('#pSql')) return;
    const ta = root.querySelector('#pSql');
    const btn = root.querySelector('#pSubmit');
    const note = root.querySelector('#pWrong');
    ta.readOnly = false;
    btn.textContent = 'Submit again';
    btn.disabled = false;
    note.textContent = 'Not correct yet (attempt ' + m.tries + '). Edit your query and submit again.';
    note.hidden = false;
    note.classList.remove('shake');
    void note.offsetWidth;
    note.classList.add('shake');
    ta.focus();
  }

  function locked(correctQuery) {
    show(correctQuery
      ? '<div class="p-center"><div class="p-badge"><svg class="icon"><use href="#i-check"/></svg></div><h2>Correct!</h2><p class="muted">Waiting for the others</p></div>'
      : '<div class="p-center"><div class="spinner"></div><h2>Answer sent</h2><p class="muted">Waiting for the others</p></div>', 'locked');
  }

  function result(m) {
    cb.onScore(me.name, m.score);
    const head = !m.answered
      ? '<div class="p-verdict none"><svg class="icon"><use href="#i-clock"/></svg><h2>No answer</h2></div>'
      : m.correct
        ? '<div class="p-verdict good"><svg class="icon"><use href="#i-check"/></svg><h2>Correct</h2><p class="p-gain">+' + m.gain + '</p></div>'
        : '<div class="p-verdict bad"><svg class="icon"><use href="#i-x"/></svg><h2>Not quite</h2></div>';
    show('<div class="p-center">' + head +
      (m.correct ? '' : '<p class="muted">Correct answer</p>' + (m.sql ? '<pre class="q-code small">' + esc(m.correctText) + '</pre>' : '<p class="p-answer">' + esc(m.correctText) + '</p>')) +
      '<p class="p-rank">You are <b>' + ordinal(m.rank) + '</b> of ' + m.players + ' · <b>' + m.score.toLocaleString() + '</b> points</p></div>',
      'result ' + (m.correct ? 'good' : 'bad'));
  }

  function final(m) {
    cb.onScore(me.name, m.score);
    const medal = m.rank <= 3 ? '<div class="p-medal m' + m.rank + '">' + m.rank + '</div>' : '';
    show('<div class="p-center">' + medal +
      '<h2>You finished ' + ordinal(m.rank) + '</h2>' +
      '<p class="p-rank"><b>' + m.score.toLocaleString() + '</b> points · ' + m.players + ' players</p>' +
      '<ol class="p-top">' + m.top.map((t) => '<li><b>' + esc(t.name) + '</b><span>' + t.score.toLocaleString() + '</span></li>').join('') + '</ol>' +
      '<p class="muted">Thanks for playing!</p></div>', 'final');
  }

  function stop() {
    clearInterval(tick);
    if (net) net.destroy();
    net = null;
  }

  global.QuizPlayer = {
    start(container, bannerEl, who, callbacks) {
      root = container;
      banner = bannerEl;
      me = who;
      cb = callbacks;
      root.innerHTML = '';
      if (!Net.available()) { exit('Could not load the connection library. Check the internet connection.'); return; }
      net = Net.createClient(who.code, { onStatus: status, onMessage });
    },
    stop,
  };
})(window);
