/* Peer-to-peer link between the host screen and the players' phones (PeerJS / WebRTC).
   The host's browser is the game server; PeerJS's public broker only introduces
   the two sides, then messages flow directly between browsers. */
(function (global) {
  'use strict';

  const PREFIX = 'dk-lecture-quiz-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function randomCode(len) {
    let s = '';
    for (let i = 0; i < (len || 5); i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }

  function available() {
    return typeof global.Peer === 'function';
  }

  // Host side. handlers: onOpen(), onIdTaken(), onError(text),
  // onMessage(conn, msg), onClose(conn).
  function createHost(code, handlers) {
    const peer = new global.Peer(PREFIX + code, { debug: 0 });
    let dead = false;

    peer.on('open', () => handlers.onOpen());
    peer.on('connection', (conn) => {
      conn.on('data', (msg) => { if (msg && typeof msg === 'object') handlers.onMessage(conn, msg); });
      conn.on('close', () => handlers.onClose(conn));
      conn.on('error', () => handlers.onClose(conn));
    });
    peer.on('disconnected', () => { if (!dead) setTimeout(() => { if (!dead && !peer.destroyed) peer.reconnect(); }, 1500); });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') handlers.onIdTaken();
      else if (err.type === 'peer-unavailable') { /* a player left mid-handshake */ }
      else handlers.onError(describe(err));
    });

    return {
      send(conn, msg) { if (conn && conn.open) conn.send(msg); },
      destroy() { dead = true; peer.destroy(); },
    };
  }

  // Player side. handlers: onStatus('connecting' | 'open' | 'lost' | 'notfound', text),
  // onMessage(msg). Reconnects by itself while the page stays open.
  function createClient(code, handlers) {
    let peer = null, conn = null, dead = false, retry = null, everOpen = false;

    function start() {
      handlers.onStatus('connecting');
      peer = new global.Peer({ debug: 0 });
      peer.on('open', connect);
      peer.on('disconnected', () => { if (!dead && !peer.destroyed) peer.reconnect(); });
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') {
          if (everOpen) scheduleRetry();
          else handlers.onStatus('notfound', 'No room with code ' + code + '. Check the code on the big screen.');
        } else {
          handlers.onStatus('lost', describe(err));
          scheduleRetry();
        }
      });
    }

    function connect() {
      if (dead) return;
      conn = peer.connect(PREFIX + code, { reliable: true });
      conn.on('open', () => { everOpen = true; handlers.onStatus('open'); });
      conn.on('data', (msg) => { if (msg && typeof msg === 'object') handlers.onMessage(msg); });
      conn.on('close', () => { if (!dead) { handlers.onStatus('lost', 'Connection lost. Reconnecting.'); scheduleRetry(); } });
    }

    function scheduleRetry() {
      if (dead || retry) return;
      retry = setTimeout(() => {
        retry = null;
        if (dead) return;
        if (!peer || peer.destroyed) start();
        else if (peer.disconnected) peer.reconnect();
        else connect();
      }, 2000);
    }

    start();
    return {
      send(msg) { if (conn && conn.open) conn.send(msg); },
      destroy() { dead = true; clearTimeout(retry); if (peer) peer.destroy(); },
    };
  }

  function describe(err) {
    switch (err && err.type) {
      case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
        return 'Cannot reach the connection server. Check the internet connection.';
      case 'browser-incompatible': return 'This browser does not support WebRTC.';
      default: return 'Connection problem' + (err && err.type ? ' (' + err.type + ')' : '') + '.';
    }
  }

  global.QuizNet = { randomCode, available, createHost, createClient };
})(window);
