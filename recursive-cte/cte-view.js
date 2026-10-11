/*
 * Draws one recursive-CTE run: the SQL text, a picture of the data, the base
 * table, the working table and the growing result. The static parts (SQL,
 * base table, graph) are built once per query; render() only flips classes
 * and rebuilds the two tables that change.
 */
(function (global) {
  'use strict';

  const SVG = 'http://www.w3.org/2000/svg';
  const NROUNDS = 6; // distinct round colours (it0 .. it5), reused beyond that

  const h = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const s = (tag, attrs) => {
    const n = document.createElementNS(SVG, tag);
    Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, attrs[k]));
    return n;
  };
  const cell = (v) => (v === null ? 'NULL' : String(v));
  const roundClass = (r) => 'it' + (r % NROUNDS);

  // Very small SQL colouring: comments, strings, keywords, numbers.
  const TOKEN = /(--.*$)|('[^']*')|\b(WITH RECURSIVE|AS|SELECT|FROM|WHERE|JOIN|ON|UNION ALL|UNION|IS NULL)\b|\b(\d+)\b/g;
  function colourSql(text, parent) {
    let last = 0;
    text.replace(TOKEN, (m, com, str, kw, num, at) => {
      if (at > last) parent.appendChild(document.createTextNode(text.slice(last, at)));
      parent.appendChild(h('span', com ? 'tk-c' : str ? 'tk-s' : kw ? 'tk-k' : 'tk-n', m));
      last = at + m.length;
      return m;
    });
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  class CteView {
    constructor(els) {
      this.el = els;
      this.scn = null;
      this.sqlLines = [];
      this.baseRows = new Map();
      this.nodes = new Map();
      this.edges = new Map();
    }

    // Build everything that stays the same for the whole run.
    setScenario(scn, lines) {
      this.scn = scn;
      const { el } = this;

      el.sql.replaceChildren();
      this.sqlLines = lines.map((l) => {
        const div = h('div', 'ln');
        colourSql(l.t || ' ', div);
        el.sql.appendChild(div);
        return div;
      });

      el.baseName.textContent = scn.base ? scn.base.name : 'No base table';
      el.baseInfo.textContent = scn.base ? 'never changes' : '';
      el.resName.textContent = 'Result: ' + scn.resultName;
      el.cardBase.classList.toggle('none', !scn.base);
      el.baseTbl.replaceChildren();
      this.baseRows = new Map();
      if (scn.base) {
        const t = h('table', 'tbl');
        const head = h('tr');
        scn.base.cols.forEach((c) => head.appendChild(h('th', null, c)));
        t.appendChild(h('thead')).appendChild(head);
        const body = h('tbody');
        scn.base.rows.forEach((r) => {
          const tr = h('tr');
          r.vals.forEach((v) => tr.appendChild(h('td', v === null ? 'null' : null, cell(v))));
          body.appendChild(tr);
          this.baseRows.set(r.id, tr);
        });
        t.appendChild(body);
        el.baseTbl.appendChild(t);
      } else {
        el.baseTbl.appendChild(h('p', 'no-base', scn.baseNote));
      }

      this.buildGraph(scn.graph);
    }

    buildGraph(g) {
      const { graph } = this.el;
      this.el.graphTitle.textContent = g.title;
      graph.replaceChildren();
      graph.setAttribute('viewBox', `0 0 ${g.w} ${g.h}`);
      this.nodes = new Map();
      this.edges = new Map();

      const defs = s('defs');
      ['', '-new', '-rej'].forEach((suffix) => {
        const m = s('marker', { id: 'ar' + suffix, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
        m.appendChild(s('path', { d: 'M0 0L10 5L0 10z', class: 'ah' + suffix }));
        defs.appendChild(m);
      });
      graph.appendChild(defs);

      const pos = new Map(g.nodes.map((n) => [n.key, n]));
      const hw = g.nw / 2;
      const hh = 14;
      g.edges.forEach(([a, b, kind]) => {
        const A = pos.get(a);
        const B = pos.get(b);
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
        const pad = 4 / Math.hypot(dx, dy);
        const u = t + pad;
        const line = s('line', {
          x1: A.x + dx * u, y1: A.y + dy * u, x2: B.x - dx * u, y2: B.y - dy * u,
          class: 'edge' + (kind ? ' ' + kind : ''), 'marker-end': 'url(#ar)',
        });
        graph.appendChild(line);
        this.edges.set(a + '>' + b, line);
      });

      g.nodes.forEach((n) => {
        const grp = s('g', { class: 'node', transform: `translate(${n.x} ${n.y})` });
        grp.appendChild(s('rect', { x: -hw, y: -hh, width: g.nw, height: hh * 2, rx: 7 }));
        const label = s('text', { y: 1, class: 'nl' });
        label.textContent = n.label;
        grp.appendChild(label);
        const badge = s('text', { x: hw - 2, y: -hh - 3, class: 'nb' });
        grp.appendChild(badge);
        graph.appendChild(grp);
        this.nodes.set(n.key, { grp, badge });
      });
    }

    render(step) {
      const { el, scn } = this;

      this.sqlLines.forEach((ln, i) => ln.classList.toggle('on', step.sql.includes(i)));

      const hit = new Set(step.base);
      this.baseRows.forEach((tr, id) => tr.classList.toggle('hit', hit.has(id)));

      // Picture: a node takes the colour of the round that first found it.
      const found = new Map();
      step.result.forEach((r) => {
        const k = scn.nodeKey(r.vals);
        const f = found.get(k);
        if (!f) found.set(k, { round: r.round, n: 1 });
        else f.n += 1;
      });
      this.nodes.forEach((n, key) => {
        const f = found.get(key);
        n.grp.setAttribute('class', 'node' + (f ? ' found ' + roundClass(f.round) : '') + (key === step.hotNode ? ' hot' : ''));
        n.badge.textContent = f && f.n > 1 ? '×' + f.n : '';
      });
      const isNew = new Set(step.edgesNew);
      const isRej = new Set(step.edgesRej);
      const used = new Set(step.used);
      this.edges.forEach((line, key) => {
        const kind = isNew.has(key) ? 'new' : isRej.has(key) ? 'rej' : used.has(key) ? 'used' : '';
        const base = line.getAttribute('class').split(' ').filter((c) => c === 'back');
        line.setAttribute('class', ['edge'].concat(base, kind || []).join(' '));
        line.setAttribute('marker-end', kind === 'new' ? 'url(#ar-new)' : kind === 'rej' ? 'url(#ar-rej)' : 'url(#ar)');
      });

      // Working table.
      el.workInfo.textContent = step.work.length
        ? `rows from round ${step.workRound} · ${step.work.length}`
        : 'empty';
      el.workTbl.replaceChildren(this.table(scn.cols, step.work.map((v, i) => ({ vals: v, cls: i === step.workHot ? 'hot' : '' })), null));

      // Result table: the last `fresh` rows were just added.
      const total = step.result.length;
      const rows = step.result.map((r, i) => ({
        vals: r.vals,
        round: r.round,
        cls: i >= total - step.fresh ? 'fresh' : '',
      }));
      step.rejected.forEach((r) => rows.push({ vals: r.vals, round: null, cls: 'rej', why: r.why }));
      el.resInfo.textContent = total ? `${total} ${total === 1 ? 'row' : 'rows'}` : 'empty';
      el.resTbl.replaceChildren(this.table(scn.cols, rows, true));
      el.resTbl.scrollTop = el.resTbl.scrollHeight;

      el.caption.dataset.status = step.status;
      el.captionText.textContent = step.text;
    }

    table(cols, rows, withRound) {
      if (!rows.length) return h('p', 'empty-tbl', '(no rows)');
      const t = h('table', 'tbl');
      const head = h('tr');
      if (withRound) {
        const th = h('th', 'rd-h', 'round');
        th.title = 'Added by this demo: which round produced the row. Not a real column.';
        head.appendChild(th);
      }
      cols.forEach((c) => head.appendChild(h('th', null, c)));
      t.appendChild(h('thead')).appendChild(head);
      const body = h('tbody');
      rows.forEach((r) => {
        const tr = h('tr', r.cls || '');
        if (withRound) {
          const td = h('td', 'rd');
          if (r.round === null) td.appendChild(h('span', 'rej-tag', 'dropped'));
          else td.appendChild(h('span', 'rd-pill ' + roundClass(r.round), String(r.round)));
          tr.appendChild(td);
        }
        r.vals.forEach((v) => tr.appendChild(h('td', null, cell(v))));
        if (r.why) tr.title = r.why;
        body.appendChild(tr);
      });
      t.appendChild(body);
      return t;
    }
  }

  global.CteView = CteView;
  global.CteView.NROUNDS = NROUNDS;
})(window);
