/* Host screen (the lecturer): lobby, questions, reveal, leaderboard, final podium.
   The host's browser keeps the whole game state and scores every answer. */
(function (global) {
  'use strict';

  const D = global.QuizData;
  const Net = global.QuizNet;
  const Q_KEY = 'lecture-demos.quiz.questions';
  const ROOM_KEY = 'lecture-demos.quiz.room';
  const GAME_KEY = 'lecture-demos.quiz.game';
  const SHAPES = ['tri', 'dia', 'cir', 'sqr'];
  const TF = ['True', 'False'];

  let root = null;        // #scrHost
  let ui = {};            // callbacks into the app: status(state, text), toast(text)
  let net = null;
  let questions = [];     // the editable bank (saved in localStorage)
  let G = null;           // the running game
  let conns = {};         // cid -> PeerJS connection (not saved)
  let tick = null;
  let idRetries = 0;

  // ---------- Storage ----------

  function store(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ } }
  function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }

  function loadQuestions() {
    const q = load(Q_KEY);
    return Array.isArray(q) && q.length ? q : D.cloneDefaults();
  }
  function saveQuestions() { store(Q_KEY, questions); }
  function saveGame() { if (G) store(GAME_KEY, G); }

  function freshGame(code, keep) {
    const players = {};
    if (keep) {
      Object.values(keep).forEach((p) => {
        if (p.online) players[p.cid] = { cid: p.cid, name: p.name, score: 0, prev: 0, gain: 0, answers: {}, online: true };
      });
    }
    return { code, phase: 'lobby', qi: -1, questions: [], players, banned: [], overrides: {}, startedAt: 0 };
  }

  // ---------- Start / connection ----------

  function start(container, callbacks) {
    root = container;
    ui = callbacks;
    questions = loadQuestions();

    let code = load(ROOM_KEY);
    if (typeof code !== 'string' || !/^[A-Z0-9]{5}$/.test(code)) code = Net.randomCode();
    store(ROOM_KEY, code);

    const saved = load(GAME_KEY);
    if (saved && saved.code === code && saved.players) {
      G = saved;
      Object.values(G.players).forEach((p) => { p.online = false; });
      if (G.phase === 'question') finishQuestion();
    } else {
      G = freshGame(code);
    }
    saveGame();
    openPeer();
    render();
    document.addEventListener('keydown', onKey);
  }

  function openPeer() {
    if (net) net.destroy();
    if (!Net.available()) {
      ui.status('offline', 'PeerJS did not load: the host needs an internet connection.');
      return;
    }
    ui.status('connecting', 'Opening room ' + G.code);
    net = Net.createHost(G.code, {
      onOpen() { idRetries = 0; ui.status('online', 'Room ' + G.code + ' is open'); },
      onIdTaken() {
        // After a refresh the broker may still hold our old id for a few seconds.
        if (idRetries++ < 4) { setTimeout(openPeer, 2500); return; }
        idRetries = 0;
        G.code = Net.randomCode();
        store(ROOM_KEY, G.code);
        saveGame();
        render();
        openPeer();
      },
      onError(text) { ui.status('offline', text); },
      onMessage,
      onClose(conn) {
        const p = G.players[conn.cid];
        if (p && conns[p.cid] === conn) {
          delete conns[p.cid];
          p.online = false;
          refreshCounts();
        }
      },
    });
  }

  function send(p, msg) { if (net && conns[p.cid]) net.send(conns[p.cid], msg); }
  function online() { return Object.values(G.players).filter((p) => p.online); }

  // ---------- Messages from players ----------

  function onMessage(conn, msg) {
    if (msg.t === 'join') onJoin(conn, msg);
    else if (msg.t === 'answer') onAnswer(conn, msg);
  }

  function reject(conn, reason) {
    net.send(conn, { t: 'reject', reason });
    setTimeout(() => conn.close(), 500);
  }

  function onJoin(conn, msg) {
    const name = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
    const cid = String(msg.cid || '').slice(0, 40);
    if (!name || !cid) return reject(conn, 'Please enter a nickname.');
    if (name.toLowerCase() === 'admin') return reject(conn, 'That nickname is reserved.');
    if (G.banned.indexOf(cid) >= 0) return reject(conn, 'The host removed you from this game.');

    let p = G.players[cid];
    if (!p) {
      if (G.phase === 'final') return reject(conn, 'This quiz has finished.');
      const taken = Object.values(G.players).some((o) => o.name.toLowerCase() === name.toLowerCase());
      if (taken) return reject(conn, 'Someone already uses "' + name + '". Pick another nickname.');
      p = G.players[cid] = { cid, name, score: 0, prev: 0, gain: 0, answers: {}, online: true };
    }
    if (conns[cid] && conns[cid] !== conn) conns[cid].close();
    conn.cid = cid;
    conns[cid] = conn;
    p.online = true;
    net.send(conn, { t: 'joined', name: p.name, score: p.score });
    sendState(p);
    saveGame();
    if (G.phase === 'lobby') renderLobbyPlayers();
    refreshCounts();
  }

  // A player is done with the question: any choice, or a query that was accepted.
  // A wrong query can be edited and sent again until the time runs out.
  function done(p) {
    const a = p.answers[G.qi];
    return !!a && (G.questions[G.qi].type !== 'sql' || a.auto);
  }

  function onAnswer(conn, msg) {
    const p = G.players[conn.cid];
    if (!p || G.phase !== 'question' || msg.qi !== G.qi || done(p)) return;
    const q = G.questions[G.qi];
    const prev = p.answers[G.qi];
    const a = { ms: Date.now() - G.startedAt, tries: (prev ? prev.tries : 0) + 1 };
    if (q.type === 'sql') {
      a.value = String(msg.value || '').slice(0, 2000);
      a.norm = D.normSql(a.value);
      a.auto = D.checkSql(a.value, q);
    } else {
      a.value = Math.max(0, Math.min(optionsOf(q).length - 1, msg.value | 0));
      a.auto = a.value === q.correct;
    }
    p.answers[G.qi] = a;
    if (q.type === 'sql' && !a.auto) send(p, { t: 'tryagain', qi: G.qi, tries: a.tries });
    else send(p, { t: 'locked', qi: G.qi, correct: q.type === 'sql' });
    saveGame();
    refreshCounts();
    const on = online();
    if (on.length && on.every(done)) setTimeout(() => { if (G.phase === 'question') finishQuestion(); }, 600);
  }

  // ---------- Scoring ----------

  function optionsOf(q) { return q.type === 'tf' ? TF : (q.options || []); }

  function isCorrect(a, qi) {
    if (!a) return false;
    const o = G.overrides[qi];
    if (o && a.norm != null && Object.prototype.hasOwnProperty.call(o, a.norm)) return o[a.norm];
    return a.auto;
  }

  // Kahoot-style: up to 1000 points, falling to 500 for an answer at the last second.
  function points(a, qi) {
    if (!isCorrect(a, qi)) return 0;
    const limit = G.questions[qi].limit * 1000;
    return Math.round(1000 * (1 - 0.5 * Math.min(a.ms / limit, 1)));
  }

  function recompute() {
    Object.values(G.players).forEach((p) => {
      let prev = 0;
      for (let i = 0; i < G.qi; i++) prev += points(p.answers[i], i);
      p.prev = prev;
      p.gain = G.qi >= 0 ? points(p.answers[G.qi], G.qi) : 0;
      p.score = prev + p.gain;
    });
  }

  function ranking(key) {
    return Object.values(G.players).sort((a, b) => (b[key || 'score'] - a[key || 'score']) || a.name.localeCompare(b.name));
  }

  function correctText(q) {
    if (q.type === 'sql') return q.model || (q.answers || [])[0] || '';
    return optionsOf(q)[q.correct];
  }

  function resultFor(p, rankMap) {
    const q = G.questions[G.qi];
    const a = p.answers[G.qi];
    return {
      t: 'result', qi: G.qi, answered: !!a, correct: isCorrect(a, G.qi), gain: p.gain, score: p.score,
      rank: rankMap[p.cid], players: Object.keys(G.players).length,
      correctText: correctText(q), sql: q.type === 'sql',
    };
  }

  function rankMap() {
    const m = {};
    ranking().forEach((p, i) => { m[p.cid] = i + 1; });
    return m;
  }

  function sendResults() {
    const m = rankMap();
    online().forEach((p) => send(p, resultFor(p, m)));
  }

  function finalFor(p, m) {
    return {
      t: 'final', rank: m[p.cid], score: p.score, players: Object.keys(G.players).length,
      top: ranking().slice(0, 3).map((o) => ({ name: o.name, score: o.score })),
    };
  }

  function questionMsg() {
    const q = G.questions[G.qi];
    return {
      t: 'question', qi: G.qi, total: G.questions.length, type: q.type, topic: q.topic || '',
      text: q.text, code: q.code || '', options: q.type === 'sql' ? [] : optionsOf(q),
      limit: q.limit, remaining: Math.max(0, G.startedAt + q.limit * 1000 - Date.now()),
      schema: q.type === 'sql' ? D.SCHEMA : null,
    };
  }

  function sendState(p) {
    switch (G.phase) {
      case 'lobby': send(p, { t: 'lobby' }); break;
      case 'question':
        if (done(p)) send(p, { t: 'locked', qi: G.qi, correct: G.questions[G.qi].type === 'sql' });
        else send(p, Object.assign(questionMsg(), { retry: !!p.answers[G.qi] }));
        break;
      case 'reveal': case 'board': send(p, resultFor(p, rankMap())); break;
      case 'final': send(p, finalFor(p, rankMap())); break;
    }
  }

  // ---------- Game flow ----------

  function primary() {
    switch (G.phase) {
      case 'lobby': return startGame();
      case 'question': return finishQuestion();
      case 'reveal': G.phase = 'board'; saveGame(); return render();
      case 'board': return G.qi + 1 < G.questions.length ? nextQuestion() : finishGame();
    }
  }

  function startGame() {
    if (!questions.length) { ui.toast('Add at least one question first.'); return; }
    G.questions = JSON.parse(JSON.stringify(questions));
    G.overrides = {};
    G.qi = -1;
    Object.values(G.players).forEach((p) => { p.answers = {}; p.score = p.prev = p.gain = 0; });
    nextQuestion();
  }

  function nextQuestion() {
    G.qi++;
    G.phase = 'question';
    G.startedAt = Date.now();
    saveGame();
    const msg = questionMsg();
    online().forEach((p) => send(p, msg));
    render();
    clearInterval(tick);
    tick = setInterval(updateTimer, 200);
  }

  function finishQuestion() {
    clearInterval(tick);
    G.phase = 'reveal';
    recompute();
    saveGame();
    sendResults();
    if (root) render();
  }

  function finishGame() {
    G.phase = 'final';
    saveGame();
    const m = rankMap();
    online().forEach((p) => send(p, finalFor(p, m)));
    render();
  }

  function newGame() {
    clearInterval(tick);
    G = freshGame(G.code, G.players);
    saveGame();
    online().forEach((p) => send(p, { t: 'lobby', reset: true }));
    render();
  }

  function kick(cid) {
    const p = G.players[cid];
    if (!p) return;
    send(p, { t: 'kicked' });
    if (conns[cid]) setTimeout(() => conns[cid] && conns[cid].close(), 400);
    G.banned.push(cid);
    delete G.players[cid];
    saveGame();
    renderLobbyPlayers();
  }

  // An answer group on a "write a query" reveal was marked right or wrong by hand.
  function toggleGroup(norm) {
    const o = G.overrides[G.qi] || (G.overrides[G.qi] = {});
    const sample = Object.values(G.players).map((p) => p.answers[G.qi]).find((a) => a && a.norm === norm);
    if (!sample) return;
    o[norm] = !isCorrect(sample, G.qi);
    recompute();
    saveGame();
    sendResults();
    render();
  }

  function onKey(e) {
    if (!root || root.hidden || e.defaultPrevented) return;
    if (document.querySelector('.modal:not([hidden])')) return;
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
      if (G.phase === 'final') return;
      e.preventDefault();
      primary();
    }
  }

  // ---------- Rendering ----------

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function joinUrl() {
    const base = location.href.split(/[?#]/)[0].replace(/index\.html$/, '');
    return base + '?room=' + G.code;
  }

  function bar(info, label, extra) {
    return '<footer class="host-bar"><div class="host-info">' + info + '</div>' + (extra || '') +
      (label ? '<button class="btn btn-primary btn-big" data-act="primary">' + label + '<svg class="icon"><use href="#i-next"/></svg></button>' : '') +
      '</footer>';
  }

  function render() {
    if (!root) return;
    const fns = { lobby: renderLobby, question: renderQuestion, reveal: renderQuestion, board: renderBoard, final: renderFinal };
    root.dataset.phase = G.phase;
    fns[G.phase]();
    ui.phase && ui.phase(G.phase);
  }

  function renderLobby() {
    const url = joinUrl();
    const isWeb = /^https?:/.test(url);
    root.innerHTML =
      '<div class="lobby">' +
        '<div class="join-card">' +
          '<p class="join-step">Join on your phone</p>' +
          '<div class="qr" id="qr"></div>' +
          (isWeb ? '<p class="join-url">' + esc(url.replace(/^https?:\/\//, '').replace(/\?.*$/, '')) + '</p>'
                 : '<p class="join-url muted">Open this page from the website to get a link and QR code.</p>') +
          '<p class="join-code-label">Room code</p>' +
          '<div class="join-code">' + esc(G.code) + '</div>' +
        '</div>' +
        '<div class="lobby-players">' +
          '<div class="lobby-head"><h2><b id="playerCount">0</b> <span id="playerWord">players</span></h2>' +
          '<span class="muted">Click a name to remove it</span></div>' +
          '<div class="chips" id="chips"></div>' +
          '<p class="lobby-empty" id="lobbyEmpty">Waiting for players to join</p>' +
        '</div>' +
      '</div>' +
      bar('<b>' + questions.length + '</b> questions ready', 'Start quiz',
        '<button class="btn" data-act="edit"><svg class="icon"><use href="#i-edit"/></svg>Edit questions</button>');

    const qr = root.querySelector('#qr');
    if (isWeb && global.QRCode) {
      new global.QRCode(qr, { text: url, width: 220, height: 220, colorDark: '#000000', colorLight: '#ffffff', correctLevel: global.QRCode.CorrectLevel.M });
    } else {
      qr.hidden = true;
    }
    renderLobbyPlayers();
  }

  function renderLobbyPlayers() {
    const chips = root && root.querySelector('#chips');
    if (!chips) return;
    const list = Object.values(G.players);
    chips.innerHTML = list.map((p) =>
      '<button class="chip' + (p.online ? '' : ' off') + '" data-kick="' + esc(p.cid) + '" title="Remove ' + esc(p.name) + '">' + esc(p.name) + '</button>'
    ).join('');
    root.querySelector('#playerCount').textContent = list.length;
    root.querySelector('#playerWord').textContent = list.length === 1 ? 'player' : 'players';
    root.querySelector('#lobbyEmpty').hidden = list.length > 0;
  }

  function schemaHtml() {
    return '<aside class="schema"><h3>Tables</h3>' + D.SCHEMA.map((t) =>
      '<div class="schema-t"><b>' + t.table + '</b><span>' + t.cols.map(esc).join(', ') + '</span></div>').join('') + '</aside>';
  }

  function renderQuestion() {
    const q = G.questions[G.qi];
    const reveal = G.phase === 'reveal';
    const ps = Object.values(G.players);
    const answers = ps.map((p) => p.answers[G.qi]).filter(Boolean);
    let body = '';

    if (q.type === 'sql') {
      body = reveal ? sqlReveal(q, ps) : '<div class="sql-wait"><svg class="icon"><use href="#i-keyboard"/></svg>Write your query on your phone</div>';
    } else {
      const opts = optionsOf(q);
      const counts = opts.map((_, i) => answers.filter((a) => a.value === i).length);
      const max = Math.max(1, ...counts);
      body = '<div class="opts' + (opts.length === 2 ? ' two' : '') + (reveal ? ' revealed' : '') + '">' + opts.map((o, i) =>
        '<div class="opt opt-' + i + (reveal ? (i === q.correct ? ' right' : ' wrong') : '') + '">' +
          '<span class="shape s-' + SHAPES[i] + '"></span>' +
          '<span class="opt-text">' + esc(o) + '</span>' +
          (reveal ? '<span class="opt-count"><i style="--w:' + (counts[i] / max) + '"></i><b>' + counts[i] + '</b></span>' : '') +
          (reveal && i === q.correct ? '<svg class="icon opt-tick"><use href="#i-check"/></svg>' : '') +
        '</div>').join('') + '</div>';
    }

    const nRight = ps.filter((p) => isCorrect(p.answers[G.qi], G.qi)).length;
    const head =
      '<div class="q-head">' +
        '<span class="q-num">Question ' + (G.qi + 1) + ' <small>of ' + G.questions.length + '</small></span>' +
        (q.topic ? '<span class="q-topic">' + esc(q.topic) + '</span>' : '') +
        '<span class="q-type">' + (q.type === 'sql' ? 'Write a query' : q.type === 'tf' ? 'True or false' : 'Multiple choice') + '</span>' +
        '<span class="q-answers"><b id="ansCount">' + (reveal ? answers.length : ps.filter(done).length) + '</b> / <span id="ansOf">' + ps.length + '</span> ' +
          (q.type === 'sql' && !reveal ? 'solved' : 'answered') + '</span>' +
        (reveal ? '<span class="q-right">' + nRight + ' correct</span>'
                : '<div class="timer" id="timer"><svg viewBox="0 0 44 44"><circle class="t-bg" cx="22" cy="22" r="19"/><circle class="t-fg" id="timerRing" cx="22" cy="22" r="19"/></svg><b id="timerNum"></b></div>') +
      '</div>';

    root.innerHTML =
      '<div class="q-view' + (q.type === 'sql' ? ' with-schema' : '') + '">' + head +
        '<div class="q-body"><div class="q-main">' +
          '<h2 class="q-text">' + esc(q.text) + '</h2>' +
          (q.code ? '<pre class="q-code">' + esc(q.code) + '</pre>' : '') +
          body +
        '</div>' + (q.type === 'sql' ? schemaHtml() : '') + '</div>' +
      '</div>' +
      (reveal
        ? bar(q.type === 'sql' ? 'Click an answer group to mark it right or wrong' : '', 'Leaderboard')
        : bar('', 'Show answer'));
    if (!reveal) updateTimer();
  }

  function sqlReveal(q, ps) {
    const groups = {};
    ps.forEach((p) => {
      const a = p.answers[G.qi];
      if (!a) return;
      const g = groups[a.norm] || (groups[a.norm] = { norm: a.norm, text: a.value, n: 0, ok: isCorrect(a, G.qi), manual: false });
      g.n++;
    });
    const o = G.overrides[G.qi] || {};
    const list = Object.values(groups).sort((a, b) => (b.ok - a.ok) || (b.n - a.n));
    list.forEach((g) => { g.manual = Object.prototype.hasOwnProperty.call(o, g.norm); });
    return '<div class="sql-reveal">' +
      '<div class="model"><span class="model-label"><svg class="icon"><use href="#i-check"/></svg>Model answer</span><pre>' + esc(q.model || (q.answers || [])[0]) + '</pre></div>' +
      '<div class="groups">' + (list.length ? list.map((g) =>
        '<button class="grp ' + (g.ok ? 'ok' : 'bad') + '" data-norm="' + esc(g.norm) + '" title="' + (g.ok ? 'Mark as wrong' : 'Accept as correct') + '">' +
          '<span class="grp-n">' + g.n + '×</span><code>' + esc(g.text) + '</code>' +
          '<span class="grp-tag">' + (g.ok ? 'Correct' : 'Wrong') + (g.manual ? ' · by host' : '') + '</span>' +
        '</button>').join('') : '<p class="muted">No answers.</p>') +
      '</div></div>';
  }

  function updateTimer() {
    if (G.phase !== 'question' || !root) return;
    const q = G.questions[G.qi];
    const left = Math.max(0, G.startedAt + q.limit * 1000 - Date.now());
    const num = root.querySelector('#timerNum');
    const ring = root.querySelector('#timerRing');
    if (num) num.textContent = Math.ceil(left / 1000);
    if (ring) ring.style.strokeDashoffset = String(119.4 * (1 - left / (q.limit * 1000)));
    const t = root.querySelector('#timer');
    if (t) t.classList.toggle('low', left < 5000);
    if (left <= 0) finishQuestion();
  }

  function refreshCounts() {
    if (!root) return;
    if (G.phase === 'lobby') return renderLobbyPlayers();
    const c = root.querySelector('#ansCount');
    const of = root.querySelector('#ansOf');
    if (c) c.textContent = Object.values(G.players).filter(G.phase === 'question' ? done : (p) => p.answers[G.qi]).length;
    if (of) of.textContent = Object.keys(G.players).length;
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function renderBoard() {
    const now = ranking();
    const before = {};
    ranking('prev').forEach((p, i) => { before[p.cid] = i; });
    const top = now.slice(0, 5);
    const max = Math.max(1, top.length ? top[0].score : 1);
    const last = G.qi + 1 >= G.questions.length;
    root.innerHTML =
      '<div class="board-view"><h2 class="board-title">Leaderboard <small>after question ' + (G.qi + 1) + ' of ' + G.questions.length + '</small></h2>' +
      '<ol class="lb">' + (top.length ? top.map((p, i) => {
        const moved = before[p.cid] - i;
        return '<li style="--i:' + i + '">' +
          '<span class="lb-rank">' + (i + 1) + '</span>' +
          '<span class="lb-name">' + esc(p.name) + (moved > 0 ? '<span class="lb-up">▲ ' + moved + '</span>' : '') + '</span>' +
          '<span class="lb-bar"><i style="--w:' + (p.score / max) + '"></i></span>' +
          '<span class="lb-gain">' + (p.gain ? '+' + p.gain : '') + '</span>' +
          '<b class="lb-score">' + p.score.toLocaleString() + '</b></li>';
      }).join('') : '<p class="muted">No players yet.</p>') + '</ol></div>' +
      bar(now.length + (now.length === 1 ? ' player' : ' players'), last ? 'Final results' : 'Next question');
  }

  function renderFinal() {
    const r = ranking();
    const slot = (p, place) => p
      ? '<div class="pod pod-' + place + '"><span class="pod-name">' + esc(p.name) + '</span><span class="pod-score">' + p.score.toLocaleString() + '</span><div class="pod-block"><b>' + place + '</b></div></div>'
      : '<div class="pod pod-' + place + ' empty"><div class="pod-block"><b>' + place + '</b></div></div>';
    root.innerHTML =
      '<div class="final-view"><h2 class="board-title">Final results</h2>' +
        '<div class="podium">' + slot(r[1], 2) + slot(r[0], 1) + slot(r[2], 3) + '</div>' +
        (r.length > 3 ? '<ol class="rest" start="4">' + r.slice(3, 15).map((p, i) =>
          '<li><span>' + ordinal(i + 4) + '</span><b>' + esc(p.name) + '</b><em>' + p.score.toLocaleString() + '</em></li>').join('') + '</ol>' : '') +
      '</div>' +
      bar(r.length + (r.length === 1 ? ' player' : ' players') + ' · ' + G.questions.length + ' questions', '',
        '<button class="btn btn-primary btn-big" data-act="new"><svg class="icon"><use href="#i-restart"/></svg>New game</button>');
  }

  // ---------- Clicks ----------

  function onClick(e) {
    const t = e.target.closest('[data-act], [data-kick], [data-norm]');
    if (!t || !root.contains(t)) return;
    if (t.dataset.act === 'primary') primary();
    else if (t.dataset.act === 'edit') ui.editQuestions();
    else if (t.dataset.act === 'new') newGame();
    else if (t.dataset.kick) kick(t.dataset.kick);
    else if (t.dataset.norm != null) toggleGroup(t.dataset.norm);
  }

  // ---------- Public API ----------

  global.QuizHost = {
    start(container, callbacks) {
      container.addEventListener('click', onClick);
      start(container, callbacks);
    },
    getQuestions() { return questions; },
    setQuestions(list) {
      questions = list;
      saveQuestions();
      if (G && G.phase === 'lobby') render();
    },
    resetQuestions() { return D.cloneDefaults(); },
    inGame() { return G && G.phase !== 'lobby' && G.phase !== 'final'; },
    newGame() { if (G) newGame(); },
    stop() { if (net) net.destroy(); clearInterval(tick); },
  };
})(window);
