/*
 * Canvas renderer for the joins demo.
 *
 * The scene is drawn in a fixed-width "world" that is scaled to fit the canvas:
 * the students table on the left, a matrix of every (student, department) pair
 * next to it, the join engine in the middle (SQL, the comparison being made and
 * each algorithm's own machinery: loops, the index, buckets or sorted lists), and
 * the departments table above the result
 * on the right. draw() blends two recorded steps, so comparisons light up one
 * after another, rows slide while they are sorted and joined rows fly into the
 * result.
 */
(function (global) {
  'use strict';

  const { cellKey, plural } = global.JoinModel;

  // ---------- World geometry ----------

  const W = 1320;
  const BODY = 86; // first table row, from the card top
  const RBODY = 76; // first result row, from the card top
  const AREA_Y = 222; // algorithm area inside the join engine card
  const HASH_TOP = 124; // first bucket row, from the algorithm area top
  const BUCKET_H = 46;

  // The height of the world depends on the table sizes and the number of hash buckets.
  function makeLayout(n, m, B) {
    const dRowH = m > 5 ? 40 : m > 4 ? 44 : 48;
    const dH = BODY + m * dRowH + 10;
    const H = Math.max(620, BODY + n * 48 + 58, dH + 16 + RBODY + n * 27 + 14, AREA_Y + HASH_TOP + B * BUCKET_H + 18);
    const SC = { x: 0, y: 0, w: 296, h: H };
    const MX = { x: 312, y: 0, w: 240, h: H };
    const WS = { x: 568, y: 0, w: 424, h: H };
    const DC = { x: 1008, y: 0, w: 312, h: dH };
    const RC = { x: 1008, y: dH + 16, w: 312, h: H - dH - 16 };
    const cw = Math.min(40, (MX.w - 40) / m);
    return {
      n, m, B, H, SC, MX, WS, DC, RC, dRowH, cw,
      sRowH: Math.min(60, (H - BODY - 58) / n),
      resRowH: Math.min(34, (RC.h - RBODY - 14) / n),
      mx0: MX.x + (MX.w - cw * m) / 2,
      PANEL: { x: WS.x + 18, y: WS.y + 112, w: WS.w - 36, h: 90 },
      AREA: { x: WS.x + 18, y: WS.y + AREA_Y, w: WS.w - 36, h: H - AREA_Y - 18 },
    };
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const lerpRect = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });
  const grow = (r, d) => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d });

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    addRoundRect(ctx, x, y, w, h, r);
  }

  // Adds a rounded rectangle to the current path (e.g. to cut a hole in it).
  function addRoundRect(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Which comparisons of a step's sequence are visible at progress p.
  // seq.t0..t1 is the part of the step during which they are revealed.
  function reveal(seq, p, live) {
    if (!seq) return null;
    const n = seq.items.length;
    if (!live) return { items: seq.items, cur: null };
    if (p < seq.t0) return { items: [], cur: null };
    const span = Math.max(1e-6, seq.t1 - seq.t0);
    const k = clamp(Math.floor(((p - seq.t0) / span) * n) + 1, 1, n);
    return { items: seq.items.slice(0, k), cur: seq.items[k - 1] };
  }
  const revealAt = (seq, idx) => seq.t0 + ((seq.t1 - seq.t0) * idx) / seq.items.length;

  const isSorted = (keys) => keys.every((k, i) => i === 0 || keys[i - 1] <= k);

  class JoinView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.t = null;
      this.L = makeLayout(8, 5, 4);
      this.algo = 'nl';
      this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
      this.dirty = true;
      this.inv = new WeakMap();
      this.readTheme();
      this.resize();
    }

    // ---------- Setup ----------

    setTables(t, B) {
      this.t = t;
      this.L = makeLayout(t.n, t.m, B);
      const sizes = Array(B).fill(0);
      t.depts.forEach((d) => sizes[d.key % B]++);
      this.maxBucket = Math.max(4, ...sizes);
      this.dirty = true;
    }

    readTheme() {
      const cs = getComputedStyle(document.documentElement);
      const names = ['bg', 'panel', 'panel-2', 'ink', 'ink-2', 'muted', 'line', 'line-strong', 'accent', 'accent-soft',
        'on-strong', 'good', 'good-soft', 'warn', 'warn-soft', 'bad', 'bad-soft', 'violet', 'violet-soft',
        'teal', 'teal-soft', 'orange', 'orange-soft', 'key-bg', 'node-shadow'];
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

    // Scale and offset that fit the whole world into the free part of the canvas.
    camera() {
      const ins = this.insets;
      const H = this.L.H;
      const aw = Math.max(60, this.CW - ins.left - ins.right - 24);
      const ah = Math.max(60, this.CH - ins.top - ins.bottom - 24);
      const z = Math.min(aw / W, ah / H, 1.7);
      const x = ins.left + (this.CW - ins.left - ins.right - W * z) / 2;
      const y = ins.top + (this.CH - ins.top - ins.bottom - H * z) / 2;
      return { z, x, y };
    }

    hue(type) {
      const c = this.c;
      if (type === 'inl') return [c.accent, c.accentSoft];
      return type === 'nl' ? [c.orange, c.orangeSoft] : type === 'hash' ? [c.violet, c.violetSoft] : type === 'merge' ? [c.teal, c.tealSoft] : [c.ink, c.panel2];
    }

    // ---------- Geometry helpers ----------

    sRect(pos) {
      const L = this.L, h = L.sRowH;
      return { x: L.SC.x + 14, y: L.SC.y + BODY + pos * h, w: L.SC.w - 28, h: h - 8 };
    }

    dRect(pos) {
      const L = this.L, h = L.dRowH;
      return { x: L.DC.x + 14, y: L.DC.y + BODY + pos * h, w: L.DC.w - 28, h: h - 8 };
    }

    resRect(k) {
      const L = this.L, h = L.resRowH;
      return { x: L.RC.x + 14, y: L.RC.y + RBODY + k * h, w: L.RC.w - 28, h: h - 4 };
    }

    cellRect(sp, dp) {
      const L = this.L;
      const r = this.sRect(sp);
      const w = L.cw - 6;
      const h = Math.min(r.h, w + 8);
      return { x: L.mx0 + dp * L.cw + 3, y: r.y + (r.h - h) / 2, w, h };
    }

    sKeyRect(r) { return { x: r.x + r.w - 52, y: r.y + 6, w: 42, h: r.h - 12 }; }
    dKeyRect(r) { return { x: r.x + 8, y: r.y + 5, w: 42, h: r.h - 10 }; }

    // A row of key chips in the algorithm area (nested loop and merge join).
    strip(y, slots) {
      const A = this.L.AREA, gap = 6;
      const cw = Math.min(46, (A.w - gap * (slots - 1)) / slots);
      return { x: A.x, y, cw, gap, h: 40 };
    }

    chipAt(g, pos) { return { x: g.x + pos * (g.cw + g.gap), y: g.y, w: g.cw, h: g.h }; }

    bucketRect(k) {
      const A = this.L.AREA;
      return { x: A.x, y: A.y + HASH_TOP + k * BUCKET_H, w: A.w, h: BUCKET_H - 8 };
    }

    bucketChip(k, idx) {
      const r = this.bucketRect(k);
      const x0 = r.x + 54, gap = 6, per = this.maxBucket;
      const w = Math.min(86, (r.x + r.w - 8 - x0 - gap * (per - 1)) / per);
      return { x: x0 + idx * (w + gap), y: r.y + 5, w, h: r.h - 10 };
    }

    // Position of every row in a display order (cached per recorded order array).
    pos(order) {
      let inv = this.inv.get(order);
      if (!inv) {
        inv = [];
        order.forEach((idx, p) => { inv[idx] = p; });
        this.inv.set(order, inv);
      }
      return inv;
    }

    // ---------- Drawing ----------

    // src = { a: step | null, b: step, p: 0..1, fwd: bool } — blend from step a to step b.
    draw(src, now, animating) {
      this.now = now;
      if (!animating && !this.dirty && !src.b.spot && !src.b.fetch) return;
      this.dirty = false;
      if (!this.t) return;
      this.paint(src, animating);
    }

    // Everything the painters need to know about this moment of the animation.
    frame(src, animating) {
      const a = src.a && src.a !== src.b ? src.a : null;
      const b = src.b;
      const p = a ? clamp(src.p, 0, 1) : 1;
      const live = !!a && animating && src.fwd;
      const e = ease(p);
      const sameRun = !!a && a.run.id === b.run.id;
      const sA = this.pos(a ? a.sOrder : b.sOrder), sB = this.pos(b.sOrder);
      const dA = this.pos(a ? a.dOrder : b.dOrder), dB = this.pos(b.dOrder);
      const rv = reveal(b.seq, p, live);
      const cur = live ? rv && rv.cur : b.seq && b.seq.items.length === 1 ? b.seq.items[0] : null;
      const cells = new Map(Object.entries(b.cells));
      if (rv) rv.items.forEach((it) => cells.set(cellKey(it.si, it.di), it.res));
      // Rows added by this step fly in as their comparison is revealed.
      const prevLen = live && sameRun ? a.result.length : b.result.length;
      const results = b.result.map((r, k) => {
        if (k < prevLen) return { r, k, f: 1, glow: 0 };
        const idx = b.seq ? b.seq.items.findIndex((it) => it.si === r.si && it.di === r.di && it.res === 'yes') : -1;
        const at = idx >= 0 ? revealAt(b.seq, idx) : 0.4;
        return { r, k, f: clamp((p - at) / 0.22, 0, 1), glow: clamp(1 - (p - at - 0.22) / 0.5, 0, 1) };
      });
      return {
        a, b, p, e, live, sameRun, rv, cur, cells, results,
        sPos: (i) => lerp(sA[i], sB[i], e),
        sMoving: (i) => sA[i] !== sB[i] && p < 1,
        dPos: (i) => lerp(dA[i], dB[i], e),
        dMoving: (i) => dA[i] !== dB[i] && p < 1,
        // -1..1 while a row moves: rows moving down/right swing one way, up/left the other.
        sSwing: (i) => Math.sign(sB[i] - sA[i]) * Math.sin(Math.PI * e),
        dSwing: (i) => Math.sign(dB[i] - dA[i]) * Math.sin(Math.PI * e),
        // A student's ✓ / ✗ appears at the end of the step that decided it.
        mark: (i) => {
          const res = b.marks[i];
          if (!res) return null;
          const fresh = live && (!sameRun || !a.marks[i]);
          return { res, alpha: fresh ? clamp((p - 0.82) / 0.18, 0, 1) : 1 };
        },
      };
    }

    paint(src, animating) {
      const { ctx, dpr } = this;
      const cam = this.camera();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.CW, this.CH);
      ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.x, dpr * cam.y);

      const F = this.frame(src, animating);
      this.paintStudents(F);
      this.paintMatrix(F);
      this.paintWork(F);
      this.paintDepts(F);
      this.paintResult(F);
      this.paintFlights(F);
      this.paintSpot(F);
    }

    // ----- Shared pieces -----

    card(r, title, sub, tint, mono) {
      const { ctx, c } = this;
      ctx.save();
      ctx.shadowColor = c.nodeShadow;
      ctx.shadowBlur = 14 * this.dpr;
      ctx.shadowOffsetY = 3 * this.dpr;
      roundRect(ctx, r.x, r.y, r.w, r.h, 16);
      ctx.fillStyle = c.panel;
      ctx.fill();
      ctx.restore();
      roundRect(ctx, r.x, r.y, r.w, r.h, 16);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = c.lineStrong;
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `750 19px ${mono ? this.mono : this.font}`;
      ctx.fillStyle = tint;
      ctx.fillText(title, r.x + 18, r.y + 34);
      if (sub) {
        const tw = ctx.measureText(title).width;
        ctx.font = `500 13.5px ${this.font}`;
        ctx.fillStyle = c.muted;
        this.fitText(sub, r.x + 30 + tw, r.y + 33, r.w - 48 - tw);
      }
    }

    colHead(text, x, y, align) {
      const { ctx, c } = this;
      ctx.font = `700 11.5px ${this.font}`;
      ctx.fillStyle = c.muted;
      ctx.textAlign = align || 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(text.toUpperCase(), x, y);
      ctx.textAlign = 'left';
    }

    // Draws text, shrinking it horizontally if needed so it fits in maxW.
    fitText(text, x, y, maxW) {
      const { ctx } = this;
      const w = ctx.measureText(text).width;
      if (w <= maxW || maxW <= 0) {
        ctx.fillText(text, x, y);
        return;
      }
      const align = ctx.textAlign;
      const ox = align === 'center' ? -maxW / 2 : align === 'right' ? -maxW : 0;
      ctx.save();
      ctx.translate(x + ox, y);
      ctx.scale(maxW / w, 1);
      ctx.textAlign = 'left';
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }

    // Splits text into lines no wider than maxW.
    wrap(text, maxW) {
      const words = text.split(' ');
      const lines = [];
      let line = '';
      words.forEach((w) => {
        const t = line ? line + ' ' + w : w;
        if (line && this.ctx.measureText(t).width > maxW) {
          lines.push(line);
          line = w;
        } else line = t;
      });
      if (line) lines.push(line);
      return lines;
    }

    // A rounded chip holding a key. o: { fill, stroke, lw, color, fs, alpha }
    keyChip(r, key, o) {
      const { ctx, c } = this;
      o = o || {};
      ctx.save();
      if (o.alpha != null) ctx.globalAlpha *= o.alpha;
      roundRect(ctx, r.x, r.y, r.w, r.h, 7);
      ctx.fillStyle = o.fill || c.accentSoft;
      ctx.fill();
      if (o.stroke) {
        ctx.lineWidth = o.lw || 2.5;
        ctx.strokeStyle = o.stroke;
        ctx.stroke();
      }
      ctx.font = `750 ${o.fs || clamp(r.h * 0.48, 11, 18)}px ${this.font}`;
      ctx.fillStyle = o.color || c.accent;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(key), r.x + r.w / 2, r.y + r.h / 2 + 0.5);
      ctx.textAlign = 'left';
      ctx.restore();
    }

    // Chip colours for a key: hl = 'good' | 'warn' | null, res = 'yes' | 'no' | null.
    chipStyle(hl, res, dim) {
      const c = this.c;
      if (hl === 'good') return { fill: c.goodSoft, stroke: c.good, color: c.good };
      if (hl === 'warn') return { fill: c.warnSoft, stroke: c.warn, color: c.ink };
      if (res === 'yes') return { fill: c.goodSoft, color: c.good };
      if (res === 'no') return { fill: c.panel2, color: c.muted, stroke: c.line, lw: 1 };
      return { fill: c.accentSoft, color: c.accent, alpha: dim ? 0.45 : 1 };
    }

    verdictBadge(x, y, v, r) {
      const { ctx, c } = this;
      const col = v === 'yes' ? c.good : v === 'no' ? c.muted : c.teal;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = c.panel;
      ctx.lineWidth = r * 0.22;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const s = r * 0.42;
      if (v === 'yes') {
        ctx.moveTo(x - s, y);
        ctx.lineTo(x - s * 0.25, y + s * 0.75);
        ctx.lineTo(x + s, y - s * 0.7);
      } else if (v === 'no') {
        ctx.moveTo(x - s * 0.8, y - s * 0.8);
        ctx.lineTo(x + s * 0.8, y + s * 0.8);
        ctx.moveTo(x + s * 0.8, y - s * 0.8);
        ctx.lineTo(x - s * 0.8, y + s * 0.8);
      } else if (v === 'down') {
        ctx.moveTo(x, y - s);
        ctx.lineTo(x, y + s);
        ctx.moveTo(x - s * 0.7, y + s * 0.3);
        ctx.lineTo(x, y + s);
        ctx.lineTo(x + s * 0.7, y + s * 0.3);
      } else {
        const dir = v === 'left' ? -1 : 1; // 'left' or 'right'
        ctx.moveTo(x - s * dir, y);
        ctx.lineTo(x + s * dir, y);
        ctx.moveTo(x + s * 0.3 * dir, y - s * 0.7);
        ctx.lineTo(x + s * dir, y);
        ctx.lineTo(x + s * 0.3 * dir, y + s * 0.7);
      }
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';
    }

    pill(text, x, y, col, bg, align) {
      const { ctx } = this;
      ctx.font = `700 12.5px ${this.font}`;
      const w = ctx.measureText(text).width + 20;
      const x0 = align === 'right' ? x - w : x;
      roundRect(ctx, x0, y, w, 24, 12);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.fillStyle = col;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(text, x0 + 10, y + 12.5);
      return w;
    }

    tag(x, y, text, col, bg) {
      const { ctx } = this;
      ctx.font = `700 11.5px ${this.font}`;
      const w = ctx.measureText(text).width + 14;
      roundRect(ctx, x - w / 2, y - 9, w, 18, 9);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = col;
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y + 0.5);
      ctx.textAlign = 'left';
    }

    // A small triangle under a chip, with a label: a loop or merge pointer.
    pointer(r, label, col, alpha) {
      const { ctx } = this;
      const cx = r.x + r.w / 2, y = r.y + r.h + 5;
      ctx.save();
      ctx.globalAlpha *= alpha == null ? 1 : alpha;
      ctx.beginPath();
      ctx.moveTo(cx, y);
      ctx.lineTo(cx - 7, y + 10);
      ctx.lineTo(cx + 7, y + 10);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.font = `750 14px ${this.mono}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(label, cx, y + 26);
      ctx.restore();
    }

    rowBox(r, hl, lift) {
      const { ctx, c } = this;
      if (lift) {
        ctx.save();
        ctx.shadowColor = c.nodeShadow;
        ctx.shadowBlur = 18 * this.dpr;
        ctx.shadowOffsetY = 6 * this.dpr;
        roundRect(ctx, r.x, r.y, r.w, r.h, 9);
        ctx.fillStyle = c.panel;
        ctx.fill();
        ctx.restore();
      }
      roundRect(ctx, r.x, r.y, r.w, r.h, 9);
      ctx.fillStyle = hl === 'good' ? c.goodSoft : hl === 'warn' ? c.warnSoft : lift ? c.panel : c.panel2;
      ctx.fill();
      ctx.lineWidth = hl ? 2.5 : 1;
      ctx.strokeStyle = hl === 'good' ? c.good : hl === 'warn' ? c.warn : c.line;
      ctx.stroke();
    }

    // ----- Students -----

    studentSub(b) {
      const t = this.t;
      switch (b.run.type) {
        case 'nl':
        case 'inl': return 'outer loop';
        case 'hash': return 'probe side';
        case 'merge': return isSorted(b.sOrder.map((i) => t.students[i].key)) && b.kind !== 'plan' ? 'sorted by dept' : 'not sorted yet';
        default: return `${t.n} rows`;
      }
    }

    // Which row of a table the current comparison or loop is on.
    studentHl(F, i) {
      if (F.cur && F.cur.si === i) return F.cur.res === 'yes' ? 'good' : 'warn';
      return F.b.sCur === i ? 'warn' : null;
    }

    paintStudents(F) {
      const { ctx, c, L, t } = this;
      this.card(L.SC, 'students', this.studentSub(F.b), c.accent, true);
      const r0 = this.sRect(0);
      this.colHead('name', r0.x + 14, BODY - 12);
      const kr = this.sKeyRect(r0);
      this.colHead('dept', kr.x + kr.w / 2, BODY - 12, 'center');

      const moving = [];
      t.students.forEach((st) => {
        if (F.sMoving(st.i)) moving.push(st);
        else this.studentRow(st, this.sRect(F.sPos(st.i)), { hl: this.studentHl(F, st.i), mark: F.mark(st.i) });
      });
      moving.forEach((st) => {
        const r = this.sRect(F.sPos(st.i));
        r.x += 10 * F.sSwing(st.i);
        this.studentRow(st, r, { lift: true, mark: F.mark(st.i) });
      });

      ctx.font = `500 12.5px ${this.font}`;
      ctx.fillStyle = c.muted;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(`${t.n} rows · join column: dept`, L.SC.x + 18, L.SC.y + L.SC.h - 22);
    }

    studentRow(st, r, o) {
      const { ctx, c } = this;
      this.rowBox(r, o.hl, o.lift);
      const mk = o.mark;
      const fs = clamp(r.h * 0.36, 12, 17);
      ctx.save();
      if (mk && mk.res === 'no') ctx.globalAlpha = 1 - 0.5 * mk.alpha;
      ctx.font = `650 ${fs}px ${this.font}`;
      ctx.fillStyle = c.ink;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      this.fitText(st.name, r.x + 14, r.y + r.h / 2 + 0.5, r.w - 100);
      this.keyChip(this.sKeyRect(r), st.key, { fs: clamp(r.h * 0.4, 12, 18) });
      ctx.restore();
      if (mk && mk.alpha > 0) {
        ctx.save();
        ctx.globalAlpha = mk.alpha;
        this.verdictBadge(r.x + r.w - 70, r.y + r.h / 2, mk.res, 9);
        ctx.restore();
      }
    }

    // ----- Comparison matrix -----

    paintMatrix(F) {
      const { ctx, c, L, t } = this;
      const b = F.b;
      const M = L.MX;
      this.card(M, 'pairs', '1 cell = 1 comparison', c.ink);
      const merge = b.run.type === 'merge';

      // Column headers: the department ids, in the departments' current order.
      this.colHead('d.id', M.x + 18, BODY - 30);
      t.depts.forEach((d) => {
        const x = L.mx0 + F.dPos(d.i) * L.cw + 3;
        const on = F.cur && F.cur.di === d.i;
        this.keyChip({ x, y: BODY - 26, w: L.cw - 6, h: 22 }, d.key, on ? this.chipStyle(F.cur.res === 'yes' ? 'good' : 'warn') : { fs: 12.5 });
      });

      // Band behind the student row that is being worked on.
      const rowSi = F.cur ? F.cur.si : b.sCur;
      if (rowSi >= 0) {
        const r = this.sRect(F.sPos(rowSi));
        roundRect(ctx, M.x + 8, r.y - 2, M.w - 16, r.h + 4, 8);
        ctx.fillStyle = c.warnSoft;
        ctx.fill();
      }

      t.students.forEach((st) => {
        const sp = F.sPos(st.i);
        t.depts.forEach((d) => {
          const r = this.cellRect(sp, F.dPos(d.i));
          const res = F.cells.get(cellKey(st.i, d.i));
          roundRect(ctx, r.x, r.y, r.w, r.h, 6);
          if (!res) {
            ctx.fillStyle = c.panel;
            ctx.fill();
            ctx.setLineDash([3, 3]);
            ctx.lineWidth = 1;
            ctx.strokeStyle = c.lineStrong;
            ctx.stroke();
            ctx.setLineDash([]);
            return;
          }
          ctx.fillStyle = res === 'yes' ? c.good : c.line;
          ctx.fill();
          // Merge join: the arrows trace its staircase walk (↓ next student, → next department).
          const glyph = res === 'yes' ? '✓' : merge && res === 'lt' ? '↓' : merge && res === 'gt' ? '→' : '';
          if (glyph) {
            ctx.font = `800 ${clamp(r.w * 0.5, 11, 17)}px ${this.font}`;
            ctx.fillStyle = res === 'yes' ? c.onStrong : c.ink2;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(glyph, r.x + r.w / 2, r.y + r.h / 2 + 1);
            ctx.textAlign = 'left';
          }
        });
      });

      if (F.cur) {
        const r = this.cellRect(F.sPos(F.cur.si), F.dPos(F.cur.di));
        roundRect(ctx, r.x - 3, r.y - 3, r.w + 6, r.h + 6, 8);
        ctx.lineWidth = 3;
        ctx.strokeStyle = F.cur.res === 'yes' ? c.good : c.warn;
        ctx.stroke();
      }

      // Footer: how many of the pairs were compared.
      const total = t.n * t.m;
      const done = F.cells.size;
      const y = M.y + M.h - 44;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.font = `750 17px ${this.font}`;
      ctx.fillStyle = c.ink;
      const txt = `${done}`;
      ctx.fillText(txt, M.x + 18, y);
      const tw = ctx.measureText(txt).width;
      ctx.font = `500 13px ${this.font}`;
      ctx.fillStyle = c.muted;
      ctx.fillText(` of ${total} pairs compared`, M.x + 18 + tw, y);
      roundRect(ctx, M.x + 18, y + 10, M.w - 36, 8, 4);
      ctx.fillStyle = c.line;
      ctx.fill();
      if (done) {
        roundRect(ctx, M.x + 18, y + 10, Math.max(8, (M.w - 36) * (done / total)), 8, 4);
        ctx.fillStyle = this.hue(b.run.type)[0];
        ctx.fill();
      }
    }

    // ----- Join engine -----

    paintWork(F) {
      const { ctx, c, L } = this;
      const b = F.b;
      const WS = L.WS;
      this.card(WS, 'join engine', '', c.ink);
      const type = b.run.type;
      if (type === 'nl' || type === 'inl' || type === 'hash' || type === 'merge') {
        const [col, soft] = this.hue(type);
        this.pill(b.run.lane === 'hash' ? `Hash join · ${b.run.B} buckets` : b.run.label, WS.x + WS.w - 18, WS.y + 15, col, soft, 'right');
      }

      // SQL
      const x = WS.x + 20;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.font = `600 14.5px ${this.mono}`;
      ctx.fillStyle = c.ink;
      ctx.fillText('SELECT * FROM students s', x, WS.y + 66);
      const p1 = 'JOIN departments d ON ';
      ctx.fillText(p1, x, WS.y + 88);
      const w1 = ctx.measureText(p1).width;
      ctx.fillStyle = c.accent;
      ctx.font = `750 14.5px ${this.mono}`;
      ctx.fillText('s.dept = d.id', x + w1, WS.y + 88);
      const w2 = ctx.measureText('s.dept = d.id').width;
      ctx.fillStyle = c.ink;
      ctx.font = `600 14.5px ${this.mono}`;
      ctx.fillText(';', x + w1 + w2, WS.y + 88);

      this.paintPanel(F);
      if (type === 'nl') this.paintNL(F);
      else if (type === 'inl') this.paintIndexNL(F);
      else if (type === 'hash') this.paintHash(F);
      else if (type === 'merge') this.paintMerge(F);
      else this.paintMenu(F);
    }

    // What the comparison panel shows right now.
    panelContent(F) {
      const b = F.b, t = this.t;
      if (b.kind === 'idle' || b.kind === 'tour') return { text: 'ready', sub: 'pick an algorithm and press Run', idle: true };
      if (F.live && b.kind === 'probe' && F.p < (b.seq ? b.seq.t0 : 0.32)) {
        const h = b.hashing;
        return { text: `h(${h.key}) = ${h.key} mod ${b.run.B} = ${h.b}`, sub: `search only bucket ${h.b}` };
      }
      if (F.live && b.kind === 'merge' && F.p < b.seq.t0) {
        const it = b.seq.items[0];
        return { text: `${t.students[it.si].key} ? ${t.depts[it.di].key}`, sub: 'compare s.dept with d.id' };
      }
      if (F.live && b.kind === 'lookup') {
        const key = t.students[b.sCur].key;
        if (!F.cur) return { text: `find ${key}`, sub: 'start at the root of the index' };
        return { text: F.cur.text, sub: F.cur.note, verdict: F.cur.res === 'yes' ? 'yes' : F.cur.dir };
      }
      if (F.live && F.cur && b.kind !== 'merge') {
        const st = t.students[F.cur.si], d = t.depts[F.cur.di];
        return { text: `${st.key} = ${d.key} ?`, sub: `${st.name}.dept vs ${d.name}.id`, verdict: F.cur.res };
      }
      return b.panel || { text: '', sub: '' };
    }

    paintPanel(F) {
      const { ctx, c, L } = this;
      const P = L.PANEL;
      const pc = this.panelContent(F);
      roundRect(ctx, P.x, P.y, P.w, P.h, 12);
      ctx.fillStyle = c.panel2;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.line;
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      this.colHead('now', P.x + 16, P.y + 22);
      ctx.font = `750 27px ${this.mono}`;
      ctx.fillStyle = pc.idle ? c.muted : pc.verdict === 'yes' ? c.good : c.ink;
      const right = pc.verdict ? 56 : 18;
      this.fitText(pc.text, P.x + 16, P.y + 55, P.w - 16 - right);
      ctx.font = `500 13.5px ${this.font}`;
      ctx.fillStyle = c.ink2;
      this.fitText(pc.sub || '', P.x + 16, P.y + 77, P.w - 16 - right);
      if (pc.verdict) this.verdictBadge(P.x + P.w - 32, P.y + P.h / 2, pc.verdict, 16);
    }

    areaLabel(text, x, y) {
      this.colHead(text, x, y);
    }

    // Nested loop: the outer pointer walks the students, the inner one sweeps all departments each time.
    paintNL(F) {
      const { ctx, c, L, t } = this;
      const b = F.b, A = L.AREA;
      const [col] = this.hue('nl');
      const slots = Math.max(t.n, t.m);

      this.areaLabel('outer loop · students', A.x, A.y + 10);
      const g1 = this.strip(A.y + 22, slots);
      t.students.forEach((st) => {
        const mk = F.mark(st.i);
        const hl = b.sCur === st.i ? (F.cur && F.cur.res === 'yes' ? 'good' : 'warn') : null;
        this.keyChip(this.chipAt(g1, F.sPos(st.i)), st.key, this.chipStyle(hl, mk && mk.alpha > 0.5 ? mk.res : null));
      });
      if (b.sCur >= 0) this.pointer(this.chipAt(g1, F.sPos(b.sCur)), 's', col);

      this.areaLabel('inner loop · departments', A.x, A.y + 110);
      const g2 = this.strip(A.y + 122, slots);
      const seen = new Map((F.rv ? F.rv.items : []).map((it) => [it.di, it.res]));
      t.depts.forEach((d) => {
        const on = F.cur && F.cur.di === d.i;
        const hl = on ? (F.cur.res === 'yes' ? 'good' : 'warn') : null;
        this.keyChip(this.chipAt(g2, F.dPos(d.i)), d.key, this.chipStyle(hl, seen.get(d.i)));
      });
      if (F.cur) this.pointer(this.chipAt(g2, F.dPos(F.cur.di)), 'd', col);

      // Counter: the work is n × m, whatever the data.
      const box = { x: A.x, y: A.y + 222, w: A.w, h: 118 };
      roundRect(ctx, box.x, box.y, box.w, box.h, 12);
      ctx.fillStyle = c.panel2;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.line;
      ctx.stroke();
      const done = F.cells.size, total = t.n * t.m;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `750 34px ${this.font}`;
      ctx.fillStyle = col;
      ctx.fillText(String(done), box.x + 18, box.y + 48);
      const tw = ctx.measureText(String(done)).width;
      ctx.font = `600 16px ${this.font}`;
      ctx.fillStyle = c.ink2;
      ctx.fillText(`/ ${total} comparisons`, box.x + 26 + tw, box.y + 47);
      roundRect(ctx, box.x + 18, box.y + 62, box.w - 36, 10, 5);
      ctx.fillStyle = c.line;
      ctx.fill();
      if (done) {
        roundRect(ctx, box.x + 18, box.y + 62, Math.max(10, (box.w - 36) * (done / total)), 10, 5);
        ctx.fillStyle = col;
        ctx.fill();
      }
      ctx.font = `500 13.5px ${this.font}`;
      ctx.fillStyle = c.muted;
      this.fitText(`${t.n} students × ${t.m} departments: every pair is compared`, box.x + 18, box.y + 98, box.w - 36);
    }

    // Index nested loop: the outer loop over students, and for each one a descent
    // through the B+ tree on departments.id (root → one leaf → one row).
    paintIndexNL(F) {
      const { ctx, c, L, t } = this;
      const b = F.b, A = L.AREA;
      const [col, soft] = this.hue('inl');

      this.areaLabel('outer loop · students', A.x, A.y + 10);
      const g1 = this.strip(A.y + 22, Math.max(t.n, t.m));
      t.students.forEach((st) => {
        const mk = F.mark(st.i);
        const hl = b.sCur === st.i ? (F.cur && F.cur.res === 'yes' ? 'good' : 'warn') : null;
        this.keyChip(this.chipAt(g1, F.sPos(st.i)), st.key, this.chipStyle(hl, mk && mk.alpha > 0.5 ? mk.res : null));
      });
      if (b.sCur >= 0) this.pointer(this.chipAt(g1, F.sPos(b.sCur)), 's', col);

      this.areaLabel('index on departments.id · B+ tree', A.x, A.y + 110);
      const G = this.indexGeom();
      const { root, leaves } = t.index;
      const seen = F.rv ? F.rv.items : [];
      const leafOn = seen.find((it) => it.node === 'leaf');
      const rootDone = seen.filter((it) => it.node === 'root').length;
      const target = leafOn ? leafOn.leaf : null;

      // Edges root → leaves, labelled with the key range each leaf holds.
      leaves.forEach((lf, i) => {
        const from = G.childAt(i), to = G.leaf(i);
        const on = target === i;
        ctx.strokeStyle = on ? col : c.lineStrong;
        ctx.lineWidth = on ? 3 : 1.5;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.bezierCurveTo(from.x, from.y + 22, to.x + to.w / 2, to.y - 24, to.x + to.w / 2, to.y);
        ctx.stroke();
        const last = i === root.keys.length;
        const range = i === 0 ? `< ${root.keys[0]}` : last ? `≥ ${root.keys[i - 1]}` : `${root.keys[i - 1]}–${root.keys[i] - 1}`;
        ctx.font = `700 13px ${this.mono}`;
        ctx.fillStyle = on ? col : c.muted;
        ctx.textAlign = i === 0 ? 'right' : last ? 'left' : 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(range, from.x + (i === 0 ? -12 : last ? 12 : 0), from.y + (i === 0 || last ? 10 : 30));
        ctx.textAlign = 'left';
      });

      // Root
      const R = G.root;
      roundRect(ctx, R.x, R.y, R.w, R.h, 9);
      ctx.fillStyle = c.panel;
      ctx.fill();
      ctx.lineWidth = rootDone && !leafOn ? 2.5 : 1.5;
      ctx.strokeStyle = rootDone && !leafOn ? col : c.lineStrong;
      ctx.stroke();
      root.keys.forEach((k, i) => {
        const done = seen.find((it) => it.node === 'root' && it.ki === i);
        const on = F.cur && F.cur.node === 'root' && F.cur.ki === i;
        this.keyChip(G.rootKey(i), k, on ? { fill: c.warnSoft, stroke: c.warn, color: c.ink } : done ? { fill: soft, color: col } : { fill: c.keyBg, color: c.ink });
      });
      ctx.font = `700 11px ${this.font}`;
      ctx.fillStyle = c.muted;
      ctx.textBaseline = 'middle';
      ctx.fillText('ROOT', R.x - 40, R.y + R.h / 2);

      // Leaves: key → row in the departments table.
      leaves.forEach((lf, i) => {
        const r = G.leaf(i);
        const on = target === i;
        roundRect(ctx, r.x, r.y, r.w, r.h, 9);
        ctx.fillStyle = on ? soft : c.panel;
        ctx.fill();
        ctx.lineWidth = on ? 2.5 : 1.5;
        ctx.strokeStyle = on ? col : c.lineStrong;
        ctx.stroke();
        lf.entries.forEach((en, j) => {
          const it = seen.find((x) => x.node === 'leaf' && x.leaf === i && x.ki === j);
          const cur = F.cur && F.cur.node === 'leaf' && F.cur.leaf === i && F.cur.ki === j;
          const hl = cur ? (F.cur.res === 'yes' ? 'good' : 'warn') : it && it.res === 'yes' ? 'good' : null;
          this.leafEntry(G.entry(i, j), en, this.chipStyle(hl, it ? it.res : null));
        });
      });
      ctx.font = `700 11px ${this.font}`;
      ctx.fillStyle = c.muted;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText('LEAVES', A.x, G.leaf(0).y - 10);

      // Counter: a few comparisons per student instead of m.
      const box = { x: A.x, y: A.y + 290, w: A.w, h: 76 };
      roundRect(ctx, box.x, box.y, box.w, box.h, 12);
      ctx.fillStyle = c.panel2;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.line;
      ctx.stroke();
      const cmp = b.stats.cmp - (b.seq ? b.seq.items.length : 0) + seen.length;
      const looks = b.stats.look - (b.kind === 'lookup' && F.live && F.p < 0.95 ? 1 : 0);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = `750 28px ${this.font}`;
      ctx.fillStyle = col;
      ctx.fillText(String(cmp), box.x + 18, box.y + 34);
      const tw = ctx.measureText(String(cmp)).width;
      ctx.font = `600 15px ${this.font}`;
      ctx.fillStyle = c.ink2;
      ctx.fillText(`comparisons in ${plural(Math.max(0, looks), 'lookup')}`, box.x + 26 + tw, box.y + 33);
      const total = t.n * t.m;
      roundRect(ctx, box.x + 18, box.y + 44, box.w - 36, 8, 4);
      ctx.fillStyle = c.line;
      ctx.fill();
      if (cmp) {
        roundRect(ctx, box.x + 18, box.y + 44, Math.max(8, (box.w - 36) * Math.min(1, cmp / total)), 8, 4);
        ctx.fillStyle = col;
        ctx.fill();
      }
      ctx.font = `500 13px ${this.font}`;
      ctx.fillStyle = c.muted;
      this.fitText(`a nested loop needs ${total} · here ≈ log₂ m per student`, box.x + 18, box.y + 67, box.w - 36);
    }

    // Where the parts of the index sit inside the algorithm area.
    indexGeom() {
      const A = this.L.AREA;
      const { root, leaves } = this.t.index;
      const kw = 46, rw = 24 + root.keys.length * kw;
      const R = { x: A.x + (A.w - rw) / 2, y: A.y + 126, w: rw, h: 40 };
      const gap = 14, nl = leaves.length;
      const lw = (A.w - gap * (nl - 1)) / nl;
      const per = this.t.index.leaves.reduce((mx, lf) => Math.max(mx, lf.entries.length), 1);
      const leaf = (i) => ({ x: A.x + i * (lw + gap), y: A.y + 210, w: lw, h: 62 });
      return {
        root: R,
        rootKey: (i) => ({ x: R.x + 12 + i * kw, y: R.y + 6, w: kw - 6, h: R.h - 12 }),
        childAt: (i) => ({ x: R.x + 8 + (i * (R.w - 16)) / root.keys.length, y: R.y + R.h }),
        leaf,
        entry: (i, j) => {
          const r = leaf(i), ew = (r.w - 12 - 6 * (per - 1)) / per;
          return { x: r.x + 6 + j * (ew + 6), y: r.y + 6, w: ew, h: r.h - 12 };
        },
      };
    }

    // A leaf entry of the index: the key, and the row it points to.
    leafEntry(r, en, o) {
      const { ctx, c } = this;
      roundRect(ctx, r.x, r.y, r.w, r.h, 7);
      ctx.fillStyle = o.fill;
      ctx.fill();
      if (o.stroke) {
        ctx.lineWidth = o.lw || 2.5;
        ctx.strokeStyle = o.stroke;
        ctx.stroke();
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `800 18px ${this.font}`;
      ctx.fillStyle = o.color;
      ctx.fillText(String(en.key), r.x + r.w / 2, r.y + r.h * 0.36);
      ctx.font = `600 11.5px ${this.font}`;
      ctx.fillStyle = c.muted;
      ctx.fillText(`→ row ${en.di + 1}`, r.x + r.w / 2, r.y + r.h * 0.76);
      ctx.textAlign = 'left';
    }

    // Hash join: the hash function and the buckets of the hash table.
    paintHash(F) {
      const { ctx, c, L, t } = this;
      const b = F.b, A = L.AREA, B = b.run.B;
      const [col, soft] = this.hue('hash');

      // Phase pills
      const building = b.kind === 'plan' || b.kind === 'build';
      const probing = b.kind === 'phase' || b.kind === 'probe';
      let px = A.x;
      px += this.pill('1 · build (departments)', px, A.y, building ? c.onStrong : c.muted, building ? col : c.panel2) + 8;
      this.pill('2 · probe (students)', px, A.y, probing ? c.onStrong : c.muted, probing ? col : c.panel2);

      // Hash function
      const hb = { x: A.x, y: A.y + 38, w: A.w, h: 56 };
      roundRect(ctx, hb.x, hb.y, hb.w, hb.h, 12);
      ctx.fillStyle = c.panel2;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.line;
      ctx.stroke();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = `750 19px ${this.mono}`;
      ctx.fillStyle = col;
      ctx.fillText(`h(k) = k mod ${B}`, hb.x + 16, hb.y + hb.h / 2);
      const h = b.hashing;
      if (h) {
        const k = F.live ? clamp(F.p / 0.2, 0, 1) : 1;
        ctx.save();
        ctx.globalAlpha = k;
        ctx.font = `750 19px ${this.mono}`;
        ctx.fillStyle = c.ink;
        ctx.textAlign = 'right';
        ctx.fillText(`h(${h.key}) = ${h.b}`, hb.x + hb.w - 16, hb.y + hb.h / 2);
        ctx.restore();
      }

      this.areaLabel('hash table in RAM', A.x, A.y + HASH_TOP - 12);
      const seen = new Map((F.rv ? F.rv.items : []).map((it) => [it.di, it.res]));
      const landing = F.live && b.kind === 'build' ? h.idx : -1;
      b.buckets.forEach((list, k) => {
        const r = this.bucketRect(k);
        const probed = b.probe === k;
        const target = h && h.b === k && (!F.live || F.p > 0.2);
        roundRect(ctx, r.x, r.y, r.w, r.h, 10);
        ctx.fillStyle = probed ? soft : c.panel2;
        ctx.fill();
        ctx.lineWidth = probed || target ? 2.5 : 1;
        ctx.strokeStyle = probed || target ? col : c.line;
        ctx.stroke();
        this.keyChip({ x: r.x + 6, y: r.y + 5, w: 40, h: r.h - 10 }, k, { fill: probed ? col : soft, color: probed ? c.onStrong : col, fs: 16 });
        list.forEach((di, idx) => {
          if (di === landing) return; // drawn as a flight
          const on = F.cur && F.cur.di === di;
          const hl = on ? (F.cur.res === 'yes' ? 'good' : 'warn') : null;
          this.deptChip(this.bucketChip(k, idx), t.depts[di], this.chipStyle(hl, probed ? seen.get(di) : null));
        });
        if (!list.length || (list.length === 1 && list[0] === landing)) {
          ctx.font = `500 13px ${this.font}`;
          ctx.fillStyle = c.muted;
          ctx.textBaseline = 'middle';
          ctx.fillText('empty', r.x + 60, r.y + r.h / 2);
        }
      });
    }

    // A department as a chip: its id and (if there is room) its name.
    deptChip(r, d, o) {
      const { ctx, c } = this;
      o = o || {};
      ctx.save();
      if (o.alpha != null) ctx.globalAlpha *= o.alpha;
      roundRect(ctx, r.x, r.y, r.w, r.h, 7);
      ctx.fillStyle = o.fill || c.accentSoft;
      ctx.fill();
      if (o.stroke) {
        ctx.lineWidth = o.lw || 2.5;
        ctx.strokeStyle = o.stroke;
        ctx.stroke();
      }
      const fs = clamp(r.h * 0.46, 11, 15);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = `800 ${fs}px ${this.font}`;
      ctx.fillStyle = o.color || c.accent;
      ctx.fillText(String(d.key), r.x + 8, r.y + r.h / 2 + 0.5);
      const kw = ctx.measureText(String(d.key)).width;
      if (r.w > 44) {
        ctx.font = `500 ${fs * 0.88}px ${this.font}`;
        ctx.fillStyle = c.ink2;
        this.fitText(d.name, r.x + 14 + kw, r.y + r.h / 2 + 0.5, r.w - 20 - kw);
      }
      ctx.restore();
    }

    // Merge join: both tables as sorted strips, with a pointer into each.
    paintMerge(F) {
      const { ctx, c, L, t } = this;
      const b = F.b, A = L.AREA;
      const [col] = this.hue('merge');
      const slots = Math.max(t.n, t.m) + 1; // + an "end" slot
      const sSorted = b.kind !== 'plan' && isSorted(b.sOrder.map((i) => t.students[i].key));
      const dSorted = b.kind !== 'plan' && isSorted(b.dOrder.map((i) => t.depts[i].key));
      const ptr = this.mergePtr(F);

      this.areaLabel(sSorted ? 'students · sorted by dept' : 'students', A.x, A.y + 10);
      const g1 = this.strip(A.y + 22, slots);
      this.endSlot(this.chipAt(g1, t.n));
      t.students.forEach((st) => {
        const mk = F.mark(st.i);
        const on = F.cur && F.cur.si === st.i;
        const hl = on ? (F.cur.res === 'yes' && (!F.live || F.p >= b.seq.t0) ? 'good' : 'warn') : null;
        const r = this.chipAt(g1, F.sPos(st.i));
        r.y -= 14 * F.sSwing(st.i);
        this.keyChip(r, st.key, this.chipStyle(hl, mk && mk.alpha > 0.5 ? mk.res : null));
      });
      if (ptr) this.pointer(this.chipAt(g1, ptr.i), 's', col, ptr.alpha);

      this.areaLabel(dSorted ? 'departments · sorted by id' : 'departments', A.x, A.y + 110);
      const g2 = this.strip(A.y + 122, slots);
      this.endSlot(this.chipAt(g2, t.m));
      t.depts.forEach((d) => {
        const on = F.cur && F.cur.di === d.i;
        const hl = on ? (F.cur.res === 'yes' && (!F.live || F.p >= b.seq.t0) ? 'good' : 'warn') : null;
        const passed = b.ptr && b.dOrder.indexOf(d.i) < b.ptr.j;
        const r = this.chipAt(g2, F.dPos(d.i));
        r.y -= 14 * F.dSwing(d.i);
        this.keyChip(r, d.key, this.chipStyle(hl, passed ? 'no' : null));
      });
      if (ptr) this.pointer(this.chipAt(g2, ptr.j), 'd', col, ptr.alpha);

      // Work so far: sorting + merging.
      const box = { x: A.x, y: A.y + 222, w: A.w, h: 118 };
      roundRect(ctx, box.x, box.y, box.w, box.h, 12);
      ctx.fillStyle = c.panel2;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.line;
      ctx.stroke();
      const sortN = F.live && b.kind === 'sort' ? (F.a && F.sameRun ? F.a.stats.sort : 0) + Math.round((b.stats.sort - (F.a && F.sameRun ? F.a.stats.sort : 0)) * F.e) : b.stats.sort;
      const rows = [
        ['sort', `${sortN} comparisons`, 'n log n, free if the input is already sorted'],
        ['merge', `${F.cells.size} comparisons`, `at most n + m = ${t.n + t.m}: pointers never go back`],
      ];
      rows.forEach(([name, val, note], k) => {
        const y = box.y + 30 + k * 50;
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.font = `750 13px ${this.font}`;
        ctx.fillStyle = c.muted;
        ctx.fillText(name.toUpperCase(), box.x + 18, y);
        ctx.font = `750 17px ${this.font}`;
        ctx.fillStyle = col;
        ctx.fillText(val, box.x + 82, y);
        ctx.font = `500 12.5px ${this.font}`;
        ctx.fillStyle = c.muted;
        this.fitText(note, box.x + 82, y + 19, box.w - 100);
      });
    }

    endSlot(r) {
      const { ctx, c } = this;
      roundRect(ctx, r.x, r.y, r.w, r.h, 7);
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.lineStrong;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `600 ${clamp(r.w * 0.28, 9, 12)}px ${this.font}`;
      ctx.fillStyle = c.muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('end', r.x + r.w / 2, r.y + r.h / 2);
      ctx.textAlign = 'left';
    }

    // Merge pointer positions: they slide to their new place at the start of each step.
    mergePtr(F) {
      const b = F.b, a = F.a;
      if (!b.ptr) return null;
      if (!a || !F.sameRun || !a.ptr) return { i: b.ptr.i, j: b.ptr.j, alpha: a && F.sameRun && !a.ptr ? F.e : 1 };
      const k = F.live ? ease(clamp(F.p / 0.28, 0, 1)) : F.e;
      return { i: lerp(a.ptr.i, b.ptr.i, k), j: lerp(a.ptr.j, b.ptr.j, k), alpha: 1 };
    }

    // Before any run: the four algorithms at a glance.
    paintMenu() {
      const { ctx, c, L } = this;
      const A = L.AREA;
      const items = [
        ['nl', 'Nested loop', 'Compare every student with every department.', 'n × m'],
        ['inl', 'Index nested loop', 'Look each student up in the index on departments.id.', 'n × log m'],
        ['hash', 'Hash join', 'Put the departments into buckets, then search one bucket per student.', '≈ n + m'],
        ['merge', 'Merge join', 'Sort both tables, then walk down them together once.', 'sort + (n + m)'],
      ];
      this.areaLabel('four ways to compute the same join', A.x, A.y + 10);
      items.forEach(([key, name, desc, cost], k) => {
        const [col, soft] = this.hue(key);
        const r = { x: A.x, y: A.y + 24 + k * 86, w: A.w, h: 76 };
        const on = this.algo === key;
        roundRect(ctx, r.x, r.y, r.w, r.h, 12);
        ctx.fillStyle = on ? soft : c.panel2;
        ctx.fill();
        ctx.lineWidth = on ? 2.5 : 1;
        ctx.strokeStyle = on ? col : c.line;
        ctx.stroke();
        roundRect(ctx, r.x, r.y, 6, r.h, 3);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.font = `750 17px ${this.font}`;
        ctx.fillStyle = col;
        ctx.fillText(name, r.x + 20, r.y + 26);
        ctx.font = `700 14px ${this.mono}`;
        ctx.textAlign = 'right';
        ctx.fillText(cost, r.x + r.w - 16, r.y + 26);
        ctx.textAlign = 'left';
        ctx.font = `500 13.5px ${this.font}`;
        ctx.fillStyle = c.ink2;
        this.wrap(desc, r.w - 40).slice(0, 2).forEach((ln, i) => ctx.fillText(ln, r.x + 20, r.y + 48 + i * 18));
      });
    }

    // ----- Departments -----

    deptSub(b) {
      const t = this.t;
      switch (b.run.type) {
        case 'nl': return 'inner loop';
        case 'inl': return 'indexed on id';
        case 'hash': return 'build side (smaller)';
        case 'merge': return isSorted(b.dOrder.map((i) => t.depts[i].key)) && b.kind !== 'plan' ? 'sorted by id' : 'not sorted yet';
        default: return `${t.m} rows · id is unique`;
      }
    }

    paintDepts(F) {
      const { ctx, c, L, t } = this;
      const b = F.b;
      this.card(L.DC, 'departments', this.deptSub(b), c.accent, true);
      const r0 = this.dRect(0);
      const kr = this.dKeyRect(r0);
      this.colHead('id', kr.x + kr.w / 2, BODY - 12, 'center');
      this.colHead('name', kr.x + kr.w + 14, BODY - 12);

      const seen = new Map((F.rv ? F.rv.items : []).map((it) => [it.di, it.res]));
      const where = {};
      if (b.buckets) b.buckets.forEach((list, k) => list.forEach((di) => { where[di] = k; }));
      const moving = [];
      t.depts.forEach((d) => {
        if (F.dMoving(d.i)) { moving.push(d); return; }
        let hl = null;
        if (b.run.type === 'inl') hl = seen.get(d.i) === 'yes' ? 'good' : null; // keys are compared in the index, not here
        else if (F.cur && F.cur.di === d.i) hl = F.cur.res === 'yes' ? 'good' : 'warn';
        else if (seen.get(d.i) === 'yes') hl = 'good';
        else if (b.dCur === d.i) hl = 'warn';
        const passed = b.run.type === 'merge' && b.ptr && b.dOrder.indexOf(d.i) < b.ptr.j;
        let bucket = where[d.i];
        if (F.live && b.kind === 'build' && b.hashing.idx === d.i && F.p < 0.9) bucket = undefined;
        this.deptRow(d, this.dRect(F.dPos(d.i)), { hl, dim: passed, bucket, rowNo: b.run.type === 'inl' ? d.i + 1 : null });
      });
      moving.forEach((d) => {
        const r = this.dRect(F.dPos(d.i));
        r.x += 10 * F.dSwing(d.i);
        this.deptRow(d, r, { lift: true });
      });
    }

    deptRow(d, r, o) {
      const { ctx, c } = this;
      ctx.save();
      if (o.dim) ctx.globalAlpha = 0.5;
      this.rowBox(r, o.hl, o.lift);
      this.keyChip(this.dKeyRect(r), d.key, { fs: clamp(r.h * 0.44, 12, 18) });
      const fs = clamp(r.h * 0.42, 12, 16);
      ctx.font = `600 ${fs}px ${this.font}`;
      ctx.fillStyle = c.ink;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      this.fitText(d.name, r.x + 64, r.y + r.h / 2 + 0.5, r.w - 150);
      if (o.bucket != null) this.tag(r.x + r.w - 44, r.y + r.h / 2, `bucket ${o.bucket}`, c.violet, c.violetSoft);
      if (o.rowNo != null) this.tag(r.x + r.w - 34, r.y + r.h / 2, `row ${o.rowNo}`, c.accent, c.accentSoft);
      ctx.restore();
    }

    // ----- Result -----

    paintResult(F) {
      const { ctx, c, L } = this;
      const shown = F.results.filter((x) => x.f >= 1).length;
      const idle = !F.b.run.lane;
      this.card(L.RC, 'result', idle ? 'one row per matching pair' : `${shown} row${shown === 1 ? '' : 's'}`, c.good, true);
      const r0 = this.resRect(0);
      this.colHead('student', r0.x + 10, L.RC.y + RBODY - 10);
      this.colHead('dept', r0.x + 141, L.RC.y + RBODY - 10, 'center');
      this.colHead('department', r0.x + 168, L.RC.y + RBODY - 10);
      F.results.forEach((x) => {
        if (x.f >= 1) this.resultRow(x.r, this.resRect(x.k), { glow: F.live ? x.glow : 0 });
      });
      if (!F.results.some((x) => x.f > 0)) {
        ctx.font = `500 13.5px ${this.font}`;
        ctx.fillStyle = c.muted;
        ctx.textBaseline = 'middle';
        ctx.fillText(idle ? 'Run a join to fill it.' : '(no rows yet)', r0.x + 10, r0.y + 14);
      }
    }

    resultRow(res, r, o) {
      const { ctx, c, t } = this;
      const st = t.students[res.si], d = t.depts[res.di];
      if (o.lift) this.rowBox(r, null, true);
      roundRect(ctx, r.x, r.y, r.w, r.h, 7);
      ctx.fillStyle = c.goodSoft;
      ctx.fill();
      ctx.lineWidth = o.glow ? 1 + 2 * o.glow : 1;
      ctx.strokeStyle = o.glow ? c.good : c.line;
      ctx.stroke();
      const fs = clamp(r.h * 0.52, 11, 15);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = `650 ${fs}px ${this.font}`;
      ctx.fillStyle = c.ink;
      this.fitText(st.name, r.x + 10, r.y + r.h / 2 + 0.5, 104);
      this.keyChip({ x: r.x + 126, y: r.y + 3, w: 30, h: r.h - 6 }, st.key, { fs: fs * 0.95, fill: c.panel, color: c.accent });
      ctx.font = `500 ${fs}px ${this.font}`;
      ctx.fillStyle = c.ink2;
      ctx.textBaseline = 'middle';
      this.fitText(d.name, r.x + 168, r.y + r.h / 2 + 0.5, r.w - 176);
    }

    // ----- Things in flight, drawn on top -----

    paintFlights(F) {
      const { L, t } = this;
      const b = F.b;
      this.paintFetch(F);
      if (!F.live) return;

      // Hash build: the department's id flies from its row into its bucket.
      if (b.kind === 'build') {
        const h = b.hashing;
        const d = t.depts[h.idx];
        const from = this.dKeyRect(this.dRect(F.dPos(d.i)));
        const to = this.bucketChip(h.b, b.buckets[h.b].indexOf(d.i));
        const k = clamp((F.p - 0.25) / 0.6, 0, 1);
        const r = lerpRect(from, to, ease(k));
        r.y -= Math.sin(k * Math.PI) * 40;
        this.ctx.save();
        this.ctx.shadowColor = this.c.nodeShadow;
        this.ctx.shadowBlur = 16 * this.dpr;
        this.ctx.shadowOffsetY = 6 * this.dpr;
        this.deptChip(r, d, this.chipStyle(k < 1 ? 'warn' : null));
        this.ctx.restore();
      }

      // Joined rows fly from the comparison panel into the result.
      F.results.forEach((x) => {
        if (x.f <= 0 || x.f >= 1) return;
        const to = this.resRect(x.k);
        const P = L.PANEL;
        const from = { x: P.x + (P.w - to.w) / 2, y: P.y + P.h - to.h - 8, w: to.w, h: to.h };
        const r = lerpRect(from, to, ease(x.f));
        r.y -= Math.sin(x.f * Math.PI) * 30;
        this.resultRow(x.r, r, { lift: true, glow: 1 });
      });
    }

    // Index nested loop: a dashed pointer from the leaf entry to the one department row it names.
    paintFetch(F) {
      const b = F.b;
      if (b.run.type !== 'inl' || !b.fetch || !b.seq) return;
      const { ctx } = this;
      const idx = b.seq.items.findIndex((it) => it.res === 'yes');
      const k = F.live ? clamp((F.p - revealAt(b.seq, idx) - 0.04) / 0.15, 0, 1) : 1;
      if (k <= 0) return;
      const G = this.indexGeom();
      const e = G.entry(b.fetch.leaf, b.fetch.ki);
      const d = this.dRect(F.dPos(b.fetch.di));
      const WS = this.L.WS;
      // Route around the tree: down out of the entry, along the gap under the leaves,
      // up the right edge of the join engine card, then across into the row.
      const from = { x: e.x + e.w / 2, y: e.y + e.h };
      const laneY = G.leaf(0).y + G.leaf(0).h + 9;
      const laneX = WS.x + WS.w - 8;
      const to = { x: d.x - 6, y: d.y + d.h / 2 };
      const pts = [from, { x: from.x, y: laneY }, { x: laneX, y: laneY }, { x: laneX, y: to.y }, to];
      const col = this.hue('inl')[0];
      ctx.save();
      ctx.globalAlpha = k;
      ctx.strokeStyle = col;
      ctx.lineWidth = 3;
      ctx.setLineDash([9, 7]);
      ctx.lineDashOffset = -(this.now || 0) / 30;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) ctx.arcTo(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, 10);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - 12, to.y - 6);
      ctx.lineTo(to.x - 12, to.y + 6);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(from.x, from.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // ----- Tour spotlight -----

    spotRect(name) {
      const L = this.L;
      switch (name) {
        case 's': return grow(L.SC, 6);
        case 'd': return grow(L.DC, 6);
        case 'result': return grow(L.RC, 6);
        case 'matrix': return grow(L.MX, 6);
        case 'work': return grow(L.WS, 6);
        case 'sql': return { x: L.WS.x + 8, y: L.WS.y + 44, w: L.WS.w - 16, h: 56 };
        default: return null;
      }
    }

    paintSpot(F) {
      const { a, b, p } = F;
      const spotA = a && a.spot ? this.spotRect(a.spot) : null;
      const spotB = b.spot ? this.spotRect(b.spot) : null;
      const boardOnly = b.spot === 'board';
      if (!spotA && !spotB && !boardOnly && !(a && a.spot)) return;
      const { ctx, c } = this;
      const H = this.L.H;
      const e = ease(p);
      let hole = null, alpha = 1;
      if (spotA && spotB) hole = lerpRect(spotA, spotB, e);
      else if (spotB) { hole = spotB; alpha = a && a.spot ? 1 : e; }
      else if (boardOnly) { hole = null; alpha = 1; }
      else { hole = spotA; alpha = 1 - e; }
      ctx.save();
      ctx.globalAlpha = alpha * (boardOnly ? 0.7 : 0.78);
      ctx.beginPath();
      ctx.rect(-2000, -2000, W + 4000, H + 4000);
      if (hole) addRoundRect(ctx, hole.x, hole.y, hole.w, hole.h, 18);
      ctx.fillStyle = c.bg;
      ctx.fill('evenodd');
      ctx.restore();
      if (hole) {
        const pulse = 0.55 + 0.45 * Math.sin((this.now || 0) / 260);
        ctx.save();
        ctx.globalAlpha = alpha * pulse;
        roundRect(ctx, hole.x, hole.y, hole.w, hole.h, 18);
        ctx.lineWidth = 4;
        ctx.strokeStyle = c.accent;
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  global.JoinView = JoinView;
})(window);
