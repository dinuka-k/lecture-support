/*
 * Canvas renderer for the sorting demo: one bar per item, matched by id between
 * steps so swaps and moves glide. Merge sort gets a temporary row below the
 * array; heap sort also shows the array as a binary tree.
 */
(function (global) {
  'use strict';

  const GAP = 6;
  const MAX_H = 260;
  const AUX_GAP = 70;
  const SPLIT_GAP = 44; // extra space between the halves in merge sort's trust mode
  const CALLS_H = 56; // room above the bars for the recursive-call boxes

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

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

  class SortView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.insets = { top: 0, bottom: 0, left: 0, right: 0 };
      this.dirty = true;
      this.readTheme();
      this.resize();
    }

    readTheme() {
      const cs = getComputedStyle(document.documentElement);
      const names = ['bg', 'panel', 'panel-2', 'ink', 'ink-2', 'muted', 'line', 'line-strong', 'accent', 'accent-soft',
        'on-strong', 'good', 'good-soft', 'warn', 'warn-soft', 'bad', 'bad-soft', 'violet', 'violet-soft',
        'teal', 'teal-soft', 'orange', 'orange-soft', 'key-bg', 'node-shadow'];
      this.c = {};
      names.forEach((n) => { this.c[n.replace(/-(\w)/g, (_, ch) => ch.toUpperCase())] = cs.getPropertyValue('--' + n).trim(); });
      this.font = cs.getPropertyValue('--font').trim() || 'system-ui, sans-serif';
      this.dirty = true;
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = window.devicePixelRatio || 1;
      this.W = Math.max(1, r.width);
      this.H = Math.max(1, r.height);
      this.canvas.width = Math.round(this.W * this.dpr);
      this.canvas.height = Math.round(this.H * this.dpr);
      this.dirty = true;
    }

    // World layout for a step: bar width depends on n, rows stack vertically.
    geometry(step) {
      const n = step.main.length;
      const bw = n <= 12 ? 56 : n <= 20 ? 42 : 30;
      const maxV = Math.max(...step.main.concat(step.aux || []).filter(Boolean).map((it) => it.v), 1);
      const split = step.split != null ? step.split : null;
      const width = n * (bw + GAP) - GAP + (split != null ? SPLIT_GAP : 0);
      const xi = (i) => i * (bw + GAP) + (split != null && i > split ? SPLIT_GAP : 0);
      const xa = (i) => i * (bw + GAP) + (split != null ? SPLIT_GAP / 2 : 0); // temp row: one array, no gap
      const auxY = MAX_H + AUX_GAP;
      const heapY = MAX_H + 70;
      let height = MAX_H + 40;
      if (step.aux) height = auxY + MAX_H * 0.6 + 40;
      if (step.heap != null) height = heapY + this.treeHeight(n) + 20;
      if (step.calls) height += CALLS_H;
      return { n, bw, maxV, width, auxY, heapY, height, xi, xa, top: step.calls ? CALLS_H : 0 };
    }

    treeHeight(n) { return (Math.floor(Math.log2(Math.max(1, n))) + 1) * 64; }

    positions(step, g) {
      const pos = new Map();
      const place = (arr, row) => arr && arr.forEach((it, i) => {
        if (it) pos.set(it.id, { x: row ? g.xa(i) : g.xi(i), row, v: it.v });
      });
      place(step.main, 0);
      place(step.aux, 1);
      return pos;
    }

    draw(src, now, animating) {
      if (!animating && !this.dirty) return;
      this.dirty = false;
      const a = src.a && src.a !== src.b ? src.a : null;
      const b = src.b;
      const e = a ? ease(clamp(src.p, 0, 1)) : 1;
      const g = this.geometry(b);
      const ga = a ? this.geometry(a) : g;
      const { ctx, c, dpr } = this;

      // Fit the world into the free area.
      const ins = this.insets;
      const worldH = lerp(ga.height, g.height, e);
      const aw = Math.max(60, this.W - ins.left - ins.right - 60);
      const ah = Math.max(60, this.H - ins.top - ins.bottom - 50);
      const z = Math.min(aw / g.width, ah / worldH, 1.6);
      const ox = ins.left + (this.W - ins.left - ins.right - g.width * z) / 2;
      const oy = ins.top + (this.H - ins.top - ins.bottom - worldH * z) / 2 + 10;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.W, this.H);
      const top = lerp(ga.top, g.top, e);
      ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * ox, dpr * (oy + top * z));

      const showVals = g.n <= 24;
      const rowY = (row, h, geo) => (row === 0 ? MAX_H - h : geo.auxY + MAX_H * 0.6 - h * 0.6);
      const barH = (v, geo) => 16 + (v / geo.maxV) * (MAX_H - 16);

      // Range band (the part of the array the algorithm is working on).
      if (b.range) {
        const [lo, hi] = b.range;
        roundRect(ctx, g.xi(lo) - 4, -8, g.xi(hi) + g.bw - g.xi(lo) + 8, MAX_H + 40, 10);
        ctx.fillStyle = c.accentSoft;
        ctx.fill();
      }
      // Temp row slots for merge sort.
      if (b.aux) {
        ctx.fillStyle = c.muted;
        ctx.font = `700 14px ${this.font}`;
        ctx.textAlign = 'left';
        ctx.fillText('temp', 0, g.auxY - 12);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = c.lineStrong;
        for (let i = 0; i < g.n; i++) {
          const lo = b.range ? b.range[0] : 0, hi = b.range ? b.range[1] : g.n - 1;
          if (i < lo || i > hi) continue;
          roundRect(ctx, g.xa(i), g.auxY, g.bw, MAX_H * 0.6, 6);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
      // Baseline + indices.
      ctx.strokeStyle = c.lineStrong;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-6, MAX_H + 1);
      ctx.lineTo(g.width + 6, MAX_H + 1);
      ctx.stroke();
      ctx.fillStyle = c.muted;
      ctx.font = `600 12px ${this.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let i = 0; i < g.n; i++) ctx.fillText(String(i), g.xi(i) + g.bw / 2, MAX_H + 6);

      // Bars, blended by id.
      const pb = this.positions(b, g);
      const pa = a ? this.positions(a, ga) : pb;
      const done = new Set(b.done);
      pb.forEach((p, id) => {
        const q = pa.get(id) || p;
        const h = barH(p.v, g);
        const x = lerp(q.x, p.x, e);
        const y = lerp(rowY(q.row, h, g), rowY(p.row, h, g), e);
        const hh = lerp(q.row ? h * 0.6 : h, p.row ? h * 0.6 : h, e);
        const role = b.hl[id];
        let fill = c.keyBg, stroke = c.lineStrong, ink = c.ink;
        if (done.has(id)) { fill = c.goodSoft; stroke = c.good; }
        if (role === 'compare') { fill = c.warnSoft; stroke = c.warn; }
        else if (role === 'swap') { fill = c.orange; stroke = c.orange; ink = c.onStrong; }
        else if (role === 'min' || role === 'key') { fill = c.accent; stroke = c.accent; ink = c.onStrong; }
        else if (role === 'pivot') { fill = c.violet; stroke = c.violet; ink = c.onStrong; }
        else if (role === 'placed') { fill = c.teal; stroke = c.teal; ink = c.onStrong; }
        roundRect(ctx, x, y, g.bw, hh, 6);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = role === 'compare' ? 3 : 1.5;
        ctx.strokeStyle = stroke;
        ctx.stroke();
        if (showVals) {
          ctx.fillStyle = ink;
          ctx.font = `750 ${g.bw >= 42 ? 17 : 13}px ${this.font}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(String(p.v), x + g.bw / 2, y + 6);
        }
      });

      // Pointers (i, j, key …) under the array.
      b.marks.forEach((m, n) => {
        const x = g.xi(m.i) + g.bw / 2;
        const y = MAX_H + 26 + (n % 2) * 0;
        ctx.fillStyle = c.accent;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 8, y + 12);
        ctx.lineTo(x + 8, y + 12);
        ctx.closePath();
        ctx.fill();
        ctx.font = `750 13px ${this.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const same = b.marks.filter((o, k) => o.i === m.i && k < n).length;
        ctx.fillText(m.label, x, y + 14 + same * 15);
      });

      if (b.calls) this.calls(b, g);
      if (b.heap != null) this.tree(b, g, done);
    }


    // Merge sort, trust mode: each recursive call drawn as a labelled box above its half.
    calls(b, g) {
      const { ctx, c } = this;
      b.calls.forEach((call) => {
        const x0 = g.xi(call.lo) - 6, x1 = g.xi(call.hi) + g.bw + 6;
        const y = -CALLS_H + 4, h = 34;
        const col = call.state === 'sorted' ? c.good : call.state === 'running' ? c.accent : c.muted;
        const soft = call.state === 'sorted' ? c.goodSoft : call.state === 'running' ? c.accentSoft : c.panel;
        roundRect(ctx, x0, y, x1 - x0, h, 8);
        ctx.fillStyle = soft;
        ctx.fill();
        ctx.setLineDash(call.state === 'pending' ? [5, 4] : []);
        ctx.lineWidth = 2;
        ctx.strokeStyle = col;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col;
        ctx.font = `750 15px ${this.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label = `mergeSort(${call.lo}, ${call.hi})` + (call.state === 'sorted' ? '  ✓ sorted' : call.state === 'running' ? '  — trust it' : '');
        ctx.fillText(label, (x0 + x1) / 2, y + h / 2 + 0.5);
      });
    }

    // Heap sort: the array drawn as a binary tree (only the heap part is linked).
    tree(b, g, done) {
      const { ctx, c } = this;
      const n = g.n;
      const levels = Math.floor(Math.log2(Math.max(1, n))) + 1;
      const pos = (i) => {
        const d = Math.floor(Math.log2(i + 1));
        const first = 2 ** d - 1;
        const slots = 2 ** d;
        return { x: ((i - first + 0.5) / slots) * g.width, y: g.heapY + d * 64 + 20 };
      };
      ctx.fillStyle = c.muted;
      ctx.font = `700 14px ${this.font}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(`The same array as a binary tree — heap = positions 0–${Math.max(0, b.heap - 1)}`, 0, g.heapY - 8);
      ctx.lineWidth = 2;
      for (let i = 1; i < n; i++) {
        const p = pos(i), q = pos((i - 1) >> 1);
        ctx.strokeStyle = i < b.heap ? c.lineStrong : c.line;
        ctx.setLineDash(i < b.heap ? [] : [4, 4]);
        ctx.beginPath();
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      const r = Math.min(20, g.width / (2 ** (levels - 1)) / 2.4);
      b.main.forEach((it, i) => {
        const p = pos(i);
        const role = b.hl[it.id];
        let fill = c.panel, stroke = c.lineStrong, ink = c.ink;
        if (done.has(it.id)) { fill = c.goodSoft; stroke = c.good; }
        if (role === 'compare') { fill = c.warnSoft; stroke = c.warn; }
        else if (role === 'swap') { fill = c.orange; stroke = c.orange; ink = c.onStrong; }
        else if (role === 'pivot') { fill = c.violet; stroke = c.violet; ink = c.onStrong; }
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = stroke;
        ctx.stroke();
        ctx.fillStyle = ink;
        ctx.font = `750 ${Math.round(r * 0.8)}px ${this.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(it.v), p.x, p.y + 0.5);
      });
    }
  }

  global.SortView = SortView;
})(window);
