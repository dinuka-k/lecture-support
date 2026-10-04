/*
 * Canvas renderer for the index-types demo. Draws a step's objects (boxes with
 * rows, rectangles, dots, arrows, labels) and blends two steps by object id.
 */
(function (global) {
  'use strict';

  const HEAD = 26;
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const boxH = (b) => HEAD + b.rows.length * b.rowH + 6;

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

  class ITView {
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
      this.mono = cs.getPropertyValue('--mono').trim() || 'monospace';
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

    bounds(objs) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const add = (a, b, c, d) => { x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, c); y1 = Math.max(y1, d); };
      objs.forEach((o) => {
        if (o.t === 'box') add(o.x, o.y - 22, o.x + o.w, o.y + boxH(o));
        else if (o.t === 'rect') add(o.x, o.y - 20, o.x + o.w, o.y + o.h);
        else if (o.t === 'dot') add(o.x - 10, o.y - 10, o.x + 10, o.y + 20);
        else if (o.t === 'label') {
          const w = o.text.length * (o.size || 15) * 0.55;
          const lx = o.align === 'center' ? o.x - w / 2 : o.x;
          add(lx, o.y - 18, lx + w, o.y + 6);
        }
      });
      return x0 === Infinity ? { x0: 0, y0: 0, x1: 100, y1: 100 } : { x0, y0, x1, y1 };
    }

    draw(src, now, animating) {
      if (!animating && !this.dirty) return;
      this.dirty = false;
      const a = src.a && src.a !== src.b ? src.a : null;
      const b = src.b;
      const e = a ? ease(clamp(src.p, 0, 1)) : 1;
      const { ctx, dpr } = this;

      // Blend object positions by id.
      const prev = new Map(a ? a.objs.map((o) => [o.id, o]) : []);
      const objs = b.objs.map((o) => {
        const q = prev.get(o.id);
        const m = Object.assign({}, o, { alpha: q || !a ? 1 : e });
        if (q && (o.t === 'box' || o.t === 'rect' || o.t === 'dot')) {
          m.x = lerp(q.x, o.x, e);
          m.y = lerp(q.y, o.y, e);
          if (o.t === 'rect') { m.w = lerp(q.w, o.w, e); m.h = lerp(q.h, o.h, e); }
        }
        return m;
      });
      if (a) a.objs.forEach((o) => { if (!b.objs.some((x) => x.id === o.id)) objs.push(Object.assign({}, o, { alpha: 1 - e })); });

      // Fit to the target step's bounds.
      const bb = this.bounds(b.objs);
      const ins = this.insets;
      const aw = Math.max(60, this.W - ins.left - ins.right - 60);
      const ah = Math.max(60, this.H - ins.top - ins.bottom - 50);
      const z = Math.min(aw / (bb.x1 - bb.x0), ah / (bb.y1 - bb.y0), 1.5);
      const target = {
        z,
        x: ins.left + (this.W - ins.left - ins.right - (bb.x1 - bb.x0) * z) / 2 - bb.x0 * z,
        y: ins.top + (this.H - ins.top - ins.bottom - (bb.y1 - bb.y0) * z) / 2 - bb.y0 * z,
      };
      if (!this.cam || this.snapCam) { this.cam = target; this.snapCam = false; }
      else {
        const k = animating ? 0.18 : 1;
        this.cam = { z: lerp(this.cam.z, target.z, k), x: lerp(this.cam.x, target.x, k), y: lerp(this.cam.y, target.y, k) };
        if (k < 1) this.dirty = true;
      }
      const cam = this.cam;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.W, this.H);
      ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.x, dpr * cam.y);

      const boxes = new Map(objs.filter((o) => o.t === 'box').map((o) => [o.id, o]));
      objs.filter((o) => o.t === 'rect').sort((p, q) => ({ frame: 0, outer: 1, inner: 2, query: 3 }[p.kind] - { frame: 0, outer: 1, inner: 2, query: 3 }[q.kind])).forEach((o) => this.rect(o));
      objs.filter((o) => o.t === 'box').forEach((o) => this.box(o));
      objs.filter((o) => o.t === 'arrow').forEach((o) => this.arrow(o, boxes));
      objs.filter((o) => o.t === 'dot').forEach((o) => this.dot(o));
      objs.filter((o) => o.t === 'label').forEach((o) => this.label(o));
    }

    rowStyle(hl) {
      const c = this.c;
      switch (hl) {
        case 'hit': return { fill: c.goodSoft, stroke: c.good, ink: c.ink };
        case 'key': return { fill: c.accent, stroke: c.accent, ink: c.onStrong };
        case 'cmp': return { fill: c.warnSoft, stroke: c.warn, ink: c.ink };
        case 'on': return { fill: c.tealSoft, stroke: c.teal, ink: c.ink };
        default: return null;
      }
    }

    box(o) {
      const { ctx, c } = this;
      const h = boxH(o);
      const tint = { table: [c.accentSoft, c.accent], index: [c.violetSoft, c.violet], idx2: [c.tealSoft, c.teal] }[o.tint] || [c.panel2, c.ink2];
      const role = o.role;
      ctx.save();
      ctx.globalAlpha = o.alpha * (role === 'skip' ? 0.35 : 1);
      ctx.save();
      ctx.shadowColor = c.nodeShadow;
      ctx.shadowBlur = 8 * this.dpr;
      ctx.shadowOffsetY = 2 * this.dpr;
      roundRect(ctx, o.x, o.y, o.w, h, 8);
      ctx.fillStyle = role === 'read' ? c.orangeSoft : c.panel;
      ctx.fill();
      ctx.restore();
      ctx.save();
      roundRect(ctx, o.x, o.y, o.w, h, 8);
      ctx.clip();
      ctx.fillStyle = tint[0];
      ctx.fillRect(o.x, o.y, o.w, HEAD);
      ctx.restore();
      roundRect(ctx, o.x, o.y, o.w, h, 8);
      ctx.lineWidth = role === 'read' || role === 'target' ? 3 : 1.3;
      ctx.strokeStyle = role === 'read' ? c.orange : role === 'target' ? c.accent : c.lineStrong;
      ctx.stroke();
      ctx.fillStyle = tint[1];
      ctx.font = `750 12.5px ${this.font}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      this.fit(o.title, o.x + 9, o.y + HEAD / 2 + 0.5, o.w - 18);
      o.rows.forEach((row, i) => {
        const y = o.y + HEAD + 3 + i * o.rowH;
        const st = this.rowStyle(row.hl);
        if (st) {
          roundRect(ctx, o.x + 4, y + 1, o.w - 8, o.rowH - 2, 4);
          ctx.fillStyle = st.fill;
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = st.stroke;
          ctx.stroke();
        }
        ctx.fillStyle = st ? st.ink : c.ink;
        ctx.font = `600 ${Math.min(14, o.rowH * 0.56)}px ${this.mono}`;
        ctx.textAlign = row.center ? 'center' : 'left';
        this.fit(row.text, row.center ? o.x + o.w / 2 : o.x + 10, y + o.rowH / 2 + 0.5, o.w - 20);
      });
      if (role === 'read') this.tag(o.x + o.w - 30, o.y - 9, 'read', c.orange, c.orangeSoft);
      ctx.restore();
    }

    fit(text, x, y, maxW) {
      const { ctx } = this;
      const w = ctx.measureText(text).width;
      if (w <= maxW) { ctx.fillText(text, x, y); return; }
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(maxW / w, 1);
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }

    rect(o) {
      const { ctx, c } = this;
      ctx.save();
      ctx.globalAlpha = o.alpha * (o.role === 'skip' ? 0.35 : 1);
      roundRect(ctx, o.x, o.y, o.w, o.h, o.kind === 'frame' ? 14 : 8);
      if (o.kind === 'frame') { ctx.fillStyle = c.panel2; ctx.fill(); ctx.strokeStyle = c.line; ctx.lineWidth = 1.2; ctx.stroke(); }
      else if (o.kind === 'query') {
        ctx.fillStyle = c.accentSoft; ctx.globalAlpha *= 0.75; ctx.fill(); ctx.globalAlpha /= 0.75;
        ctx.setLineDash([8, 5]); ctx.strokeStyle = c.accent; ctx.lineWidth = 2.5; ctx.stroke(); ctx.setLineDash([]);
      } else {
        const col = o.role === 'target' ? c.good : o.kind === 'outer' ? c.violet : c.teal;
        ctx.strokeStyle = col;
        ctx.lineWidth = o.role === 'target' ? 3 : 2;
        ctx.setLineDash(o.kind === 'outer' ? [] : [5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = o.kind === 'query' ? c.accent : o.kind === 'outer' ? c.violet : o.kind === 'inner' ? c.teal : c.muted;
      ctx.font = `750 ${o.kind === 'inner' ? 12 : 14}px ${this.font}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(o.label, o.x + 6, o.kind === 'frame' ? o.y - 8 : o.y - 5);
      ctx.restore();
    }

    dot(o) {
      const { ctx, c } = this;
      ctx.save();
      ctx.globalAlpha = o.alpha;
      ctx.beginPath();
      ctx.arc(o.x, o.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = o.hl === 'hit' ? c.good : o.hl === 'cmp' ? c.warn : c.ink2;
      ctx.fill();
      ctx.fillStyle = c.ink;
      ctx.font = `700 13px ${this.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(o.label, o.x, o.y + 9);
      ctx.restore();
    }

    label(o) {
      const { ctx, c } = this;
      ctx.save();
      ctx.globalAlpha = o.alpha;
      ctx.fillStyle = c[o.color] || c.muted;
      ctx.font = `${o.bold ? 750 : 650} ${o.size}px ${o.bold ? this.mono : this.font}`;
      ctx.textAlign = o.align;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(o.text, o.x, o.y);
      ctx.restore();
    }

    point(ref, boxes) {
      if (ref.x != null) return { x: ref.x, y: ref.y };
      const b = boxes.get(ref.box);
      if (!b) return null;
      const h = boxH(b);
      const ry = ref.row != null ? b.y + HEAD + 3 + ref.row * b.rowH + b.rowH / 2 : b.y + h / 2;
      if (ref.side === 'top') return { x: b.x + b.w / 2, y: b.y };
      if (ref.side === 'bottom') return { x: b.x + b.w / 2, y: b.y + h };
      if (ref.side === 'left') return { x: b.x, y: ry };
      return { x: b.x + b.w, y: ry };
    }

    arrow(o, boxes) {
      const { ctx, c } = this;
      const p = this.point(o.from, boxes), q = this.point(o.to, boxes);
      if (!p || !q) return;
      const col = { accent: c.accent, violet: c.violet, muted: c.lineStrong, teal: c.teal, good: c.good, faint: c.line }[o.color] || c.accent;
      ctx.save();
      ctx.globalAlpha = o.alpha;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = o.color === 'faint' ? 1 : o.color === 'muted' ? 1.5 : 2.2;
      if (o.dash) ctx.setLineDash([6, 5]);
      const vertical = (o.from.side === 'top' || o.from.side === 'bottom' || o.from.x != null) && (o.to.side === 'top' || o.to.side === 'bottom');
      const c1 = vertical ? { x: p.x, y: (p.y + q.y) / 2 } : { x: (p.x + q.x) / 2, y: p.y };
      const c2 = vertical ? { x: q.x, y: (p.y + q.y) / 2 } : { x: (p.x + q.x) / 2, y: q.y };
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, q.x, q.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (o.color !== 'faint') {
        const ang = Math.atan2(q.y - c2.y, q.x - c2.x);
        ctx.beginPath();
        ctx.moveTo(q.x, q.y);
        ctx.lineTo(q.x - 9 * Math.cos(ang - 0.45), q.y - 9 * Math.sin(ang - 0.45));
        ctx.lineTo(q.x - 9 * Math.cos(ang + 0.45), q.y - 9 * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    tag(x, y, text, col, bg) {
      const { ctx } = this;
      ctx.font = `750 11.5px ${this.font}`;
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
    }
  }

  global.ITView = ITView;
})(window);
