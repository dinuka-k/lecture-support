/*
 * Canvas renderer for the query optimizer demo.
 *
 * A step's scene is one of
 *   list  — the SQL clauses as a stack of cards (parser),
 *   tree  — the logical query tree (rewriter),
 *   graph — tables and join conditions (planner),
 *   plan  — the physical execution plan.
 * Every card has an id that it keeps across scenes, so draw() can blend two
 * steps: a σ slides down the tree, a × turns into a ⋈, the tables walk from the
 * tree into the join graph and from there into the final plan.
 */
(function (global) {
  'use strict';

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const lerpRect = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });

  // Card metrics (world units).
  const PAD_L = 52, PAD_R = 14, PAD_T = 8, PAD_B = 8;
  const BADGE = 30;
  const MIN_W = 150;
  const LINE = { head: 21, code: 20, note: 17, foot: 18 };
  const GAP_X = 26, GAP_Y = 40, GAP_CHAIN = 24, GAP_PLAN = 52;

  const TONES = {
    scan: ['accent', 'accentSoft'],
    seq: ['accent', 'accentSoft'],
    index: ['teal', 'tealSoft'],
    select: ['orange', 'orangeSoft'],
    product: ['bad', 'badSoft'],
    join: ['violet', 'violetSoft'],
    project: ['teal', 'tealSoft'],
    agg: ['teal', 'tealSoft'],
    sort: ['ink2', 'panel2'],
    empty: ['good', 'goodSoft'],
  };
  const RING = { focus: 'accent', good: 'good', warn: 'warn', bad: 'bad' };

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Where the segment from the centre of r towards (tx, ty) leaves r.
  function borderPoint(r, tx, ty, pad) {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const hw = r.w / 2 + (pad || 0), hh = r.h / 2 + (pad || 0);
    const s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  class QoView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
      this.cache = new WeakMap();
      this.dirty = true;
      this.readTheme();
      this.resize();
    }

    // ---------- Setup ----------

    readTheme() {
      const cs = getComputedStyle(document.documentElement);
      const names = ['bg', 'panel', 'panel-2', 'ink', 'ink-2', 'muted', 'line', 'line-strong', 'accent', 'accent-soft',
        'on-strong', 'good', 'good-soft', 'warn', 'warn-soft', 'bad', 'bad-soft', 'violet', 'violet-soft',
        'teal', 'teal-soft', 'orange', 'orange-soft', 'key-bg', 'node-shadow', 'grid'];
      this.c = {};
      names.forEach((n) => { this.c[n.replace(/-(\w)/g, (_, ch) => ch.toUpperCase())] = cs.getPropertyValue('--' + n).trim(); });
      this.font = cs.getPropertyValue('--font').trim() || 'system-ui, sans-serif';
      this.mono = cs.getPropertyValue('--mono').trim() || 'monospace';
      this.dirty = true;
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = window.devicePixelRatio || 1;
      this.CW = Math.max(1, r.width);
      this.CH = Math.max(1, r.height);
      this.canvas.width = Math.round(this.CW * this.dpr);
      this.canvas.height = Math.round(this.CH * this.dpr);
      this.dirty = true;
    }

    fonts() {
      return {
        head: `700 15px ${this.font}`,
        code: `600 14px ${this.mono}`,
        note: `500 12.5px ${this.font}`,
        foot: `700 12.5px ${this.font}`,
        tag: `700 11px ${this.font}`,
        sym: `700 19px ${this.font}`,
        label: `600 12.5px ${this.mono}`,
        small: `700 11.5px ${this.font}`,
      };
    }

    // ---------- Measuring and layout ----------

    wrap(text, font, maxW) {
      const { ctx } = this;
      ctx.font = font;
      if (ctx.measureText(text).width <= maxW) return [text];
      const words = text.split(' ');
      const lines = [];
      let cur = '';
      words.forEach((w) => {
        const t = cur ? cur + ' ' + w : w;
        if (ctx.measureText(t).width <= maxW || !cur) cur = t;
        else {
          lines.push(cur);
          cur = w;
        }
      });
      if (cur) lines.push(cur);
      return lines;
    }

    measure(card, maxText) {
      const { ctx } = this;
      const F = this.fonts();
      const rows = [];
      let y = PAD_T;
      let tw = 0;
      const add = (kind, text, font) => {
        this.wrap(text, font, maxText).slice(0, kind === 'code' ? 4 : 2).forEach((ln) => {
          ctx.font = font;
          tw = Math.max(tw, ctx.measureText(ln).width);
          rows.push({ kind, text: ln, font, y: y + LINE[kind] * 0.72 });
          y += LINE[kind];
        });
      };
      if (card.head) add('head', card.head, F.head);
      (card.code || []).forEach((ln) => add('code', ln, F.code));
      if (card.note) add('note', card.note, F.note);
      if (card.foot) add('foot', card.foot, F.foot);
      let tagW = 0;
      if (card.tag) {
        ctx.font = F.tag;
        tagW = ctx.measureText(card.tag).width + 18;
      }
      const w = Math.max(MIN_W, PAD_L + tw + PAD_R + (tagW ? tagW + 4 : 0));
      const h = Math.max(BADGE + PAD_T * 2 - 2, y + PAD_B);
      // Single-line cards: centre the text on the badge.
      if (rows.length === 1) rows[0].y = h / 2 + 5;
      return { w, h, rows, tagW };
    }

    layout(scene) {
      if (!scene) return { boxes: new Map(), links: [], bounds: null };
      let L = this.cache.get(scene);
      if (L) return L;
      if (scene.kind === 'list') L = this.layoutList(scene);
      else if (scene.kind === 'graph') L = this.layoutGraph(scene);
      else L = this.layoutTree(scene);
      const bs = [...L.boxes.values()];
      if (bs.length) {
        const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
        const x1 = Math.max(...bs.map((b) => b.x + b.w)), y1 = Math.max(...bs.map((b) => b.y + b.h));
        L.bounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      } else L.bounds = null;
      this.cache.set(scene, L);
      return L;
    }

    layoutList(scene) {
      const boxes = new Map();
      const ms = scene.cards.map((c) => ({ card: c, m: this.measure(c, 560) }));
      const w = Math.max(...ms.map((x) => x.m.w));
      let y = 0;
      ms.forEach(({ card, m }) => {
        const indent = card.cont ? 36 : 0;
        boxes.set(card.id, { id: card.id, card, m, x: indent, y, w: w - indent, h: m.h });
        y += m.h + 12;
      });
      return { boxes, links: [] };
    }

    layoutTree(scene) {
      const boxes = new Map();
      const links = [];
      const plan = scene.kind === 'plan';
      const prep = (card, depth) => {
        const m = this.measure(card, 300);
        const kids = [...(card.kids || []), ...(card.sides || [])].map((k) => prep(k, depth + 1));
        const n = { card, m, kids, depth, sideFrom: (card.kids || []).length };
        const span = kids.reduce((s, k) => s + k.sw, 0) + GAP_X * Math.max(0, kids.length - 1);
        n.sw = Math.max(m.w, span);
        return n;
      };
      const roots = (scene.roots || []).map((r) => prep(r, 0));
      // Children of a node start below it; a single child (a chain of filters) sits closer.
      const place = (n, x0, y) => {
        const gap = n.kids.length === 1 ? (plan ? GAP_Y : GAP_CHAIN) : plan ? GAP_PLAN : GAP_Y;
        const below = y + n.m.h + gap;
        const span = n.kids.reduce((s, k) => s + k.sw, 0) + GAP_X * Math.max(0, n.kids.length - 1);
        let cx;
        if (n.kids.length) {
          let x = x0 + (n.sw - span) / 2;
          const centers = n.kids.map((k) => {
            const c = place(k, x, below);
            x += k.sw + GAP_X;
            return c;
          });
          const main = centers.slice(0, n.sideFrom);
          const cs = main.length ? main : centers;
          cx = (cs[0] + cs[cs.length - 1]) / 2;
        } else cx = x0 + n.sw / 2;
        boxes.set(n.card.id, { id: n.card.id, card: n.card, m: n.m, x: cx - n.m.w / 2, y, w: n.m.w, h: n.m.h });
        n.kids.forEach((k, i) => {
          const side = i >= n.sideFrom;
          const inner = plan && i === 1 ? n.card.innerTag : null;
          links.push({ id: `${n.card.id}>${k.card.id}`, from: k.card.id, to: n.card.id, side, rows: plan ? k.card.rows : null, tag: side ? 'IN' : inner });
        });
        return cx;
      };
      let x = 0;
      roots.forEach((r) => {
        place(r, x, 0);
        x += r.sw + GAP_X * 2;
      });
      return { boxes, links, plan };
    }

    layoutGraph(scene) {
      const boxes = new Map();
      const n = scene.nodes.length;
      const ms = scene.nodes.map((c) => ({ card: c, m: this.measure(c, 300) }));
      const maxW = Math.max(...ms.map((x) => x.m.w));
      const maxH = Math.max(...ms.map((x) => x.m.h));
      // Spread the tables on an ellipse; neighbours in the join graph sit next to each other.
      const rx = n <= 1 ? 0 : Math.max(maxW * 0.95 + 40, n * 70);
      const ry = n <= 2 ? 0 : Math.max(maxH * 1.15 + 30, n * 34);
      const start = n === 2 ? Math.PI : n === 3 ? -Math.PI / 2 - (2 * Math.PI) / 3 : Math.PI;
      ms.forEach(({ card, m }, i) => {
        const a = start + (i * 2 * Math.PI) / Math.max(1, n);
        const cx = Math.cos(a) * rx, cy = Math.sin(a) * ry;
        boxes.set(card.id, { id: card.id, card, m, x: cx - m.w / 2, y: cy - m.h / 2, w: m.w, h: m.h });
      });
      const links = scene.edges.map((e) => ({ id: e.id, from: e.a, to: e.b, graph: true, label: e.label, sub: e.sub, kind: e.kind }));
      return { boxes, links, graph: true };
    }

    // Scale and offset that fit a layout into the free part of the canvas.
    camera(L) {
      const ins = this.insets;
      const aw = Math.max(60, this.CW - ins.left - ins.right - 40);
      const ah = Math.max(60, this.CH - ins.top - ins.bottom - 40);
      if (!L || !L.bounds) return { z: 1, x: this.CW / 2, y: this.CH / 2 };
      const b = { ...L.bounds };
      if (L.graph) {
        // leave room for edge labels around the graph
        b.x -= 20; b.y -= 24; b.w += 40; b.h += 48;
      }
      const z = Math.min(aw / b.w, ah / b.h, 1.45);
      const x = ins.left + (this.CW - ins.left - ins.right - b.w * z) / 2 - b.x * z;
      const y = ins.top + (this.CH - ins.top - ins.bottom - b.h * z) / 2 - b.y * z;
      return { z, x, y };
    }

    // ---------- Drawing ----------

    // src = { a: step | null, b: step, p: 0..1, fwd: bool } — blend from step a to step b.
    draw(src, now, animating) {
      const b = src.b;
      const pulse = b && b.hl && Object.values(b.hl).some((v) => v === 'focus');
      if (!animating && !this.dirty && !pulse) return;
      this.dirty = false;
      this.now = now;
      this.paint(src, animating);
    }

    paint(src) {
      const { ctx, dpr } = this;
      const a = src.a && src.a !== src.b ? src.a : null;
      const b = src.b;
      const p = a ? ease(clamp(src.p, 0, 1)) : 1;
      const La = a ? this.layout(a.scene) : null;
      const Lb = this.layout(b.scene);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.CW, this.CH);

      if (!b.scene && !(a && a.scene)) {
        this.paintEmpty(b);
        return;
      }

      const ca = La && La.bounds ? this.camera(La) : null;
      const cb = Lb.bounds ? this.camera(Lb) : ca;
      const cam = ca && cb ? { z: lerp(ca.z, cb.z, p), x: lerp(ca.x, cb.x, p), y: lerp(ca.y, cb.y, p) } : cb || ca;
      this.cam = cam;
      ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.x, dpr * cam.y);

      // Interpolated boxes.
      const items = [];
      const ids = new Set([...(La ? La.boxes.keys() : []), ...Lb.boxes.keys()]);
      const hlA = (a && a.hl) || {}, hlB = b.hl || {};
      const fadeOut = clamp(1 - p * 1.8, 0, 1);
      const fadeIn = a ? clamp((p - 0.35) / 0.65, 0, 1) : 1;
      ids.forEach((id) => {
        const A = La ? La.boxes.get(id) : null;
        const B = Lb.boxes.get(id);
        const dimA = hlA[id] === 'dim' ? 0.35 : 1, dimB = hlB[id] === 'dim' ? 0.35 : 1;
        if (A && B) {
          items.push({ id, r: lerpRect(A, B, p), A, B, alpha: lerp(dimA, dimB, p), mix: p, moving: Math.abs(A.x - B.x) + Math.abs(A.y - B.y) > 2 });
        } else if (B) {
          items.push({ id, r: B, B, alpha: fadeIn * dimB, mix: 1 });
        } else {
          items.push({ id, r: A, A, alpha: fadeOut * dimA, mix: 0 });
        }
      });
      const rectOf = new Map(items.map((it) => [it.id, it]));

      // Links.
      const linkIds = new Map();
      if (La) La.links.forEach((l) => linkIds.set(l.id, { A: l }));
      Lb.links.forEach((l) => linkIds.set(l.id, { ...(linkIds.get(l.id) || {}), B: l }));
      const labels = [];
      linkIds.forEach(({ A, B }, id) => {
        const l = B || A;
        const f = rectOf.get(l.from), t = rectOf.get(l.to);
        if (!f || !t) return;
        let alpha = A && B ? 1 : B ? fadeIn : fadeOut;
        alpha *= Math.min(f.alpha, t.alpha) < 0.5 ? Math.max(0.25, Math.min(f.alpha, t.alpha)) : 1;
        const hl = (B ? hlB[id] : hlA[id]) || null;
        if (alpha <= 0.01) return;
        if (l.graph) labels.push(this.paintEdge(l, f.r, t.r, alpha, hl));
        else labels.push(this.paintLink(l, f.r, t.r, alpha, Lb.plan || (La && La.plan && !B)));
      });

      // Cards: dimmed first, highlighted and moving ones on top.
      const order = (it) => (it.alpha < 0.6 ? 0 : (hlB[it.id] || hlA[it.id]) ? 2 : it.moving ? 3 : 1);
      items.sort((x, y) => order(x) - order(y));
      items.forEach((it) => this.paintItem(it, hlA, hlB, p));
      labels.forEach((fn) => fn && fn());
    }

    paintEmpty(b) {
      const { ctx, c } = this;
      const ins = this.insets;
      const cx = (this.CW + ins.left - ins.right) / 2, cy = (this.CH + ins.top - ins.bottom) / 2;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = b && b.status === 'error' ? c.bad : c.muted;
      ctx.font = `700 18px ${this.font}`;
      ctx.fillText(b && b.status === 'error' ? 'The query could not be parsed' : 'Write a query and press Optimize', cx, cy - 10);
      ctx.font = `500 14px ${this.font}`;
      ctx.fillStyle = c.muted;
      ctx.fillText(b && b.status === 'error' ? 'Fix the highlighted part of the SQL and press Optimize again.' : 'The query tree will appear here.', cx, cy + 16);
    }

    // Tree edge: from the child's top to the parent's bottom; rows flow upwards.
    paintLink(l, f, t, alpha, plan) {
      const { ctx, c } = this;
      const x1 = f.x + f.w / 2, y1 = f.y;
      const x2 = t.x + t.w / 2, y2 = t.y + t.h;
      const my = (y1 + y2) / 2;
      const w = plan && l.rows != null ? clamp(1.6 + 1.5 * Math.log10(Math.max(1, l.rows)), 1.6, 11) : 2;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = l.side ? c.violet : plan ? c.lineStrong : c.lineStrong;
      ctx.lineWidth = w;
      ctx.lineCap = 'round';
      if (l.side) ctx.setLineDash([7, 6]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(x1, my, x2, my, x2, y2 + 7);
      ctx.stroke();
      ctx.setLineDash([]);
      // arrowhead into the parent (data flows up)
      const ah = 7 + w * 0.5;
      ctx.fillStyle = l.side ? c.violet : c.lineStrong;
      ctx.beginPath();
      ctx.moveTo(x2, y2 + 1);
      ctx.lineTo(x2 - ah * 0.7, y2 + ah + 2);
      ctx.lineTo(x2 + ah * 0.7, y2 + ah + 2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      const text = plan && l.rows != null ? `${global.QoEngine.fmtRows(l.rows)} row${Math.round(l.rows) <= 1 ? '' : 's'}` : null;
      const tag = l.tag;
      if (!text && !tag) return null;
      return () => {
        ctx.save();
        ctx.globalAlpha = alpha;
        const F = this.fonts();
        const mx = (x1 + x2) / 2 + (x1 === x2 ? 0 : 0), mY = my;
        let x = mx + w / 2 + 8;
        if (tag) {
          ctx.font = F.small;
          const tw = ctx.measureText(tag).width + 12;
          const tx = l.side ? mx - tw / 2 : x;
          roundRect(ctx, tx, mY - 10, tw, 20, 10);
          ctx.fillStyle = l.side ? c.violetSoft : c.panel2;
          ctx.fill();
          ctx.fillStyle = l.side ? c.violet : c.ink2;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(tag, tx + 6, mY + 0.5);
          if (!l.side) x += tw + 6;
        }
        if (text) {
          ctx.font = F.small;
          const tw = ctx.measureText(text).width + 14;
          roundRect(ctx, x, mY - 11, tw, 22, 11);
          ctx.fillStyle = c.panel;
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = c.line;
          ctx.stroke();
          ctx.fillStyle = c.ink2;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, x + 7, mY + 0.5);
        }
        ctx.restore();
      };
    }

    // Join-graph edge between two table cards, labelled with the join condition.
    paintEdge(l, f, t, alpha, hl) {
      const { ctx, c } = this;
      const fc = { x: f.x + f.w / 2, y: f.y + f.h / 2 }, tc = { x: t.x + t.w / 2, y: t.y + t.h / 2 };
      const p1 = borderPoint(f, tc.x, tc.y, 4), p2 = borderPoint(t, fc.x, fc.y, 4);
      const on = hl === 'focus';
      const dim = hl === 'dim';
      const col = l.kind === 'semi' ? c.violet : l.kind === 'theta' ? c.warn : on ? c.accent : c.lineStrong;
      ctx.save();
      ctx.globalAlpha = alpha * (dim ? 0.35 : 1);
      ctx.strokeStyle = col;
      ctx.lineWidth = on ? 4.5 : 3;
      ctx.lineCap = 'round';
      if (l.kind === 'semi') ctx.setLineDash([9, 7]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.restore();
      return () => {
        const F = this.fonts();
        const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
        const text = (l.kind === 'semi' ? '⋉ ' : '') + l.label;
        ctx.save();
        ctx.globalAlpha = alpha * (dim ? 0.45 : 1);
        ctx.font = F.label;
        const tw = ctx.measureText(text).width;
        let sw = 0;
        if (l.sub) {
          ctx.font = F.small;
          sw = ctx.measureText(l.sub).width;
        }
        const w = Math.max(tw, sw) + 18, h = l.sub ? 40 : 24;
        roundRect(ctx, mx - w / 2, my - h / 2, w, h, 9);
        ctx.fillStyle = c.panel;
        ctx.fill();
        ctx.lineWidth = on ? 2 : 1.2;
        ctx.strokeStyle = on ? c.accent : col;
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = F.label;
        ctx.fillStyle = c.ink;
        ctx.fillText(text, mx, my - (l.sub ? 8 : -0.5));
        if (l.sub) {
          ctx.font = F.small;
          ctx.fillStyle = c.muted;
          ctx.fillText(l.sub, mx, my + 10);
        }
        ctx.restore();
      };
    }

    paintItem(it, hlA, hlB, p) {
      const { ctx } = this;
      if (it.alpha <= 0.01) return;
      const r = it.r;
      const A = it.A, B = it.B;
      const ca = A ? A.card : null, cb = B ? B.card : null;
      const same = ca && cb && this.sameContent(ca, cb);
      const hl = p >= 0.5 ? hlB[it.id] || null : hlA[it.id] || null;
      const card = p >= 0.5 ? cb || ca : ca || cb;
      ctx.save();
      ctx.globalAlpha = it.alpha;
      this.paintBox(r, card, hl);
      if (same || !ca || !cb) {
        this.paintContent(r, (cb || ca), (cb || ca) === cb ? B.m : A.m, 1);
      } else {
        // Cross-fade between old and new content.
        const t = clamp((p - 0.25) / 0.5, 0, 1);
        if (t < 1) this.paintContent(r, ca, A.m, 1 - t);
        if (t > 0) this.paintContent(r, cb, B.m, t);
      }
      ctx.restore();
    }

    sameContent(a, b) {
      return a.head === b.head && a.note === b.note && a.foot === b.foot && a.tag === b.tag && a.tone === b.tone && a.sym === b.sym &&
        (a.code || []).join('\n') === (b.code || []).join('\n');
    }

    paintBox(r, card, hl) {
      const { ctx, c } = this;
      const [tone] = TONES[card.tone] || TONES.scan;
      ctx.save();
      ctx.shadowColor = c.nodeShadow;
      ctx.shadowBlur = 12 * this.dpr * (this.cam ? this.cam.z : 1);
      ctx.shadowOffsetY = 3;
      roundRect(ctx, r.x, r.y, r.w, r.h, 11);
      ctx.fillStyle = c.panel;
      ctx.fill();
      ctx.restore();
      roundRect(ctx, r.x, r.y, r.w, r.h, 11);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = card.tone === 'product' ? c.bad : c.lineStrong;
      if (card.tag === 'derived') ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      // coloured strip on the left
      ctx.save();
      roundRect(ctx, r.x, r.y, r.w, r.h, 11);
      ctx.clip();
      ctx.fillStyle = c[tone];
      ctx.fillRect(r.x, r.y, 4, r.h);
      ctx.restore();
      if (hl && RING[hl]) {
        const pulse = hl === 'focus' ? 0.55 + 0.45 * Math.sin((this.now || 0) / 260) : 1;
        ctx.save();
        ctx.globalAlpha *= pulse;
        roundRect(ctx, r.x - 4, r.y - 4, r.w + 8, r.h + 8, 14);
        ctx.lineWidth = 3;
        ctx.strokeStyle = c[RING[hl]];
        ctx.stroke();
        ctx.restore();
      }
    }

    paintContent(r, card, m, alpha) {
      const { ctx, c } = this;
      const F = this.fonts();
      const [tone, soft] = TONES[card.tone] || TONES.scan;
      ctx.save();
      ctx.globalAlpha *= alpha;
      // symbol badge
      const bx = r.x + 12, by = r.y + (m.rows.length === 1 ? (r.h - BADGE) / 2 : PAD_T);
      roundRect(ctx, bx, by, BADGE, BADGE, 8);
      ctx.fillStyle = c[soft];
      ctx.fill();
      ctx.fillStyle = c[tone];
      ctx.strokeStyle = c[tone];
      if (card.sym === 'table') this.tableIcon(bx + BADGE / 2, by + BADGE / 2);
      else {
        ctx.font = F.sym;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(card.sym || '', bx + BADGE / 2, by + BADGE / 2 + 1);
      }
      // text rows
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      const maxW = r.w - PAD_L - PAD_R - (m.tagW ? m.tagW + 4 : 0);
      m.rows.forEach((row) => {
        ctx.font = row.font;
        ctx.fillStyle = row.kind === 'head' ? c.ink : row.kind === 'code' ? c.ink : row.kind === 'note' ? c.muted : c[card.footTone ? (TONES[card.footTone] || TONES.scan)[0] : tone];
        this.fitText(row.text, r.x + PAD_L, r.y + row.y, row.kind === 'head' ? maxW : r.w - PAD_L - PAD_R);
      });
      if (card.tag) {
        ctx.font = F.tag;
        const tw = m.tagW;
        const tx = r.x + r.w - tw - 8, ty = r.y + 8;
        roundRect(ctx, tx, ty, tw, 19, 9.5);
        ctx.fillStyle = card.tag === 'derived' ? c.goodSoft : c.violetSoft;
        ctx.fill();
        ctx.fillStyle = card.tag === 'derived' ? c.good : c.violet;
        ctx.textBaseline = 'middle';
        ctx.fillText(card.tag, tx + 9, ty + 10);
      }
      ctx.restore();
    }

    tableIcon(cx, cy) {
      const { ctx } = this;
      const w = 18, h = 15;
      const x = cx - w / 2, y = cy - h / 2;
      ctx.lineWidth = 1.8;
      roundRect(ctx, x, y, w, h, 2.5);
      ctx.stroke();
      ctx.fillRect(x, y, w, 4.5);
      ctx.beginPath();
      ctx.moveTo(x, y + 9.5);
      ctx.lineTo(x + w, y + 9.5);
      ctx.moveTo(x + w / 2, y + 4.5);
      ctx.lineTo(x + w / 2, y + h);
      ctx.stroke();
    }

    fitText(text, x, y, maxW) {
      const { ctx } = this;
      const w = ctx.measureText(text).width;
      if (w <= maxW || maxW <= 0) {
        ctx.fillText(text, x, y);
        return;
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(maxW / w, 1);
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  }

  global.QoView = QoView;
})(window);
