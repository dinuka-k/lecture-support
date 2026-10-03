/*
 * Canvas renderer for the hashing demo.
 *
 * Each mode has a layout function that turns a step's snapshot into a "frame":
 * containers (slots, chain heads, pages, directory entries, buckets) keyed by a
 * stable id, key positions keyed by the key itself, and links between them.
 * draw() blends two frames, so keys fly into slots, move during splits and
 * rehashing, and the key being processed (the "ghost") travels from the hash
 * function panel to the buckets it visits.
 */
(function (global) {
  'use strict';

  const { bin, BITS } = global.HashAlgo;

  const KW = 46;
  const KH = 36;
  const FIT_MAX_Z = 1.5;

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const lerpRect = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });

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

  // ---------- Layouts: snapshot → frame ----------

  function newFrame() {
    return { containers: new Map(), keys: new Map(), links: [], texts: [], regions: [], marks: [] };
  }

  function finish(F) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const add = (x0, y0, x1, y1) => {
      minX = Math.min(minX, x0); minY = Math.min(minY, y0);
      maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1);
    };
    F.containers.forEach((c) => add(c.rect.x, c.rect.y - (c.top || 0), c.rect.x + c.rect.w, c.rect.y + c.rect.h + (c.bottom || 0)));
    F.regions.forEach((r) => add(r.rect.x, r.rect.y - 26, r.rect.x + r.rect.w, r.rect.y + r.rect.h));
    F.keys.forEach((k) => add(k.x - KW / 2, k.y - KH / 2, k.x + KW / 2, k.y + KH / 2 + (k.sub ? 18 : 0)));
    F.marks.forEach((m) => add(m.x - 30, m.y - 20, m.x + 30, m.y + 20));
    if (minX === Infinity) { minX = 0; minY = 0; maxX = 300; maxY = 100; }
    F.bounds = { minX, minY, maxX, maxY };
    return F;
  }

  // Open addressing: an array of slots, wrapped into rows when the table is big.
  function layoutOpen(s) {
    const F = newFrame();
    const SLOT = 66, GAP = 8, ROWGAP = 74;
    const perRow = s.m <= 23 ? s.m : Math.ceil(s.m / Math.ceil(s.m / 20));
    for (let i = 0; i < s.m; i++) {
      const r = Math.floor(i / perRow), c = i % perRow;
      const rect = { x: c * (SLOT + GAP), y: r * (SLOT + ROWGAP), w: SLOT, h: SLOT };
      const id = `s${s.m}_${i}`;
      const v = s.slots[i];
      F.containers.set(id, { id, kind: 'slot', rect, index: i, tomb: v === 'T', top: 50, bottom: 22, ghost: { x: rect.x + SLOT / 2, y: rect.y - 30 } });
      if (v != null && v !== 'T') F.keys.set(v, { x: rect.x + SLOT / 2, y: rect.y + SLOT / 2, c: id });
    }
    return finish(F);
  }

  // Separate chaining: bucket heads in a column, chains growing to the right.
  function layoutChain(s) {
    const F = newFrame();
    const HW = 64, HH = 46, ROW = 60, X0 = HW + 46, STEP = KW + 36;
    s.chains.forEach((chain, i) => {
      const y = i * ROW;
      const id = `c${s.m}_${i}`;
      const rect = { x: 0, y, w: HW, h: HH };
      const cy = y + HH / 2;
      F.containers.set(id, {
        id, kind: 'head', rect, index: i, count: chain.length,
        ghost: { x: X0 + chain.length * STEP + KW / 2, y: cy }, ghostSlot: true,
      });
      let prev = { c: id };
      chain.forEach((k, j) => {
        F.keys.set(k, { x: X0 + j * STEP + KW / 2, y: cy, c: id });
        F.links.push({ from: prev, to: { k }, kind: 'next' });
        prev = { k };
      });
      // Reserve room for the ghost at the end of the longest chain.
      F.marks.push({ x: X0 + chain.length * STEP + KW / 2, y: cy, invisible: true });
    });
    return finish(F);
  }

  // Bucket pages in columns, overflow pages hanging below (static and linear hashing).
  function layoutPages(s, mode) {
    const F = newFrame();
    const PW = 118, HEAD = 26, SLOT_H = 44, PAD = 8, COLGAP = 26, OVGAP = 38;
    const pageH = HEAD + s.cap * SLOT_H + PAD;
    const prefix = mode === 'disk' ? 'p' : 'L';
    let maxPages = 1;
    s.buckets.forEach((pages, b) => {
      const x = b * (PW + COLGAP);
      maxPages = Math.max(maxPages, pages.length);
      pages.forEach((p, j) => {
        const y = j * (pageH + OVGAP);
        const id = `${prefix}${b}_${j}`;
        const rect = { x, y, w: PW, h: pageH };
        let tint = null;
        if (mode === 'lin' && j === 0) tint = b >= s.Nl ? 'image' : b < s.next ? 'done' : null;
        F.containers.set(id, {
          id, kind: 'page', rect, bucket: b, page: j, cap: s.cap, tint,
          label: j === 0 ? `bucket ${b}` : `overflow ${j}`,
          sub: mode === 'lin' && j === 0 ? (b < s.next || b >= s.Nl ? `h${global.HashAlgo.sub(s.level + 1)}` : `h${global.HashAlgo.sub(s.level)}`) : null,
          ghost: { x: x + PW - 8, y: y - 6 },
        });
        p.forEach((k, i) => F.keys.set(k, { x: x + PW / 2, y: y + HEAD + i * SLOT_H + SLOT_H / 2 + 2, c: id }));
        if (j > 0) F.links.push({ from: { c: `${prefix}${b}_${j - 1}`, side: 'bottom' }, to: { c: id, side: 'top' }, kind: 'overflow' });
      });
    });
    const w = s.buckets.length * (PW + COLGAP) - COLGAP;
    const h = maxPages * (pageH + OVGAP) - OVGAP;
    if (mode === 'disk') {
      F.regions.push({ rect: { x: -20, y: -44, w: w + 40, h: h + 64 }, title: 'Disk — one page per bucket, overflow pages chained below' });
    } else {
      // The split pointer sits under bucket `next`.
      const nx = s.next * (PW + COLGAP) + PW / 2;
      F.marks.push({ x: nx, y: h + 40, kind: 'next', label: 'next' });
      F.regions.push({ rect: { x: -20, y: -44, w: w + 40, h: h + 104 }, title: `Buckets — level ${s.level}, N = ${s.Nl}` });
    }
    return finish(F);
  }

  // Extendible hashing: directory on the left, buckets on the right, arrows between.
  function layoutExt(s) {
    const F = newFrame();
    const EW = 104, EH = 34, EGAP = 6, BX = 300, SW = 58, BHEAD = 26, BH = BHEAD + 66, BGAP = 18;
    const entries = s.dir.length;
    const dirH = entries * (EH + EGAP) - EGAP;
    // Buckets sorted by the bit pattern they stand for (first directory entry pointing to them).
    const order = s.buckets.slice().sort((a, b) => s.dir.indexOf(a.id) - s.dir.indexOf(b.id));
    const bucketsH = order.length * (BH + BGAP) - BGAP;
    const top = Math.max(dirH, bucketsH);
    const dy0 = (top - dirH) / 2, by0 = (top - bucketsH) / 2;
    for (let i = 0; i < entries; i++) {
      const rect = { x: 0, y: dy0 + i * (EH + EGAP), w: EW, h: EH };
      F.containers.set(`e${i}`, { id: `e${i}`, kind: 'entry', rect, index: i, bits: s.gd ? bin(i, s.gd) : '·' });
      F.links.push({ from: { c: `e${i}`, side: 'right' }, to: { c: `B${s.dir[i]}`, side: 'left' }, kind: 'dir' });
    }
    order.forEach((b, n) => {
      const slots = Math.max(s.cap, b.keys.length);
      const rect = { x: BX, y: by0 + n * (BH + BGAP), w: 12 + slots * SW, h: BH };
      const id = `B${b.id}`;
      F.containers.set(id, {
        id, kind: 'bucket', rect, name: global.HashAlgo.letter(b.id), ld: b.ld, cap: s.cap, slots,
        ghost: { x: rect.x + rect.w + 34, y: rect.y + BH / 2 },
      });
      b.keys.forEach((k, i) => F.keys.set(k, {
        x: rect.x + 6 + i * SW + SW / 2, y: rect.y + BHEAD + 22, c: id, sub: bin(k, BITS), subHL: b.ld,
      }));
    });
    const widest = Math.max(BX + 12 + s.cap * SW, ...order.map((b) => BX + 12 + Math.max(s.cap, b.keys.length) * SW));
    F.regions.push({ rect: { x: -16, y: -16, w: EW + 32, h: top + 32 }, title: `Directory — global depth d = ${s.gd}` });
    F.regions.push({ rect: { x: BX - 16, y: -16, w: widest - BX + 32 + 70, h: top + 32 }, title: 'Buckets' });
    return finish(F);
  }

  function layout(step) {
    const s = step.snap;
    if (step.mode === 'table') return s.chains ? layoutChain(s) : layoutOpen(s);
    if (step.mode === 'disk') return layoutPages(s, 'disk');
    if (step.mode === 'lin') return layoutPages(s, 'lin');
    return layoutExt(s);
  }

  // ---------- The view ----------

  class HashView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.cache = new WeakMap();
      this.cam = { x: 0, y: 0, z: 1 };
      this.snapCamera = true;
      this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
      this.calcAnchor = null; // screen point next to the hash-function panel
      this.dirty = true;
      this.last = 0;
      this.readTheme();
      this.resize();
    }

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
      this.W = Math.max(1, r.width);
      this.H = Math.max(1, r.height);
      this.canvas.width = Math.round(this.W * this.dpr);
      this.canvas.height = Math.round(this.H * this.dpr);
      this.dirty = true;
    }

    frame(step) {
      let f = this.cache.get(step);
      if (!f) {
        f = layout(step);
        this.cache.set(step, f);
      }
      return f;
    }

    // A new mode or a reset: jump the camera instead of gliding.
    resetCamera() { this.snapCamera = true; this.dirty = true; }

    // ---------- Camera ----------

    fit(b) {
      const ins = this.insets;
      const aw = Math.max(80, this.W - ins.left - ins.right - 48);
      const ah = Math.max(80, this.H - ins.top - ins.bottom - 48);
      const z = clamp(Math.min(aw / (b.maxX - b.minX), ah / (b.maxY - b.minY)), 0.12, FIT_MAX_Z);
      const sx = ins.left + (this.W - ins.left - ins.right) / 2;
      const sy = ins.top + (this.H - ins.top - ins.bottom) / 2;
      return { x: (b.minX + b.maxX) / 2 - (sx - this.W / 2) / z, y: (b.minY + b.maxY) / 2 - (sy - this.H / 2) / z, z };
    }

    stepCamera(F, dt) {
      const t = this.fit(F.bounds);
      const c = this.cam;
      if (this.snapCamera) {
        Object.assign(c, t);
        this.snapCamera = false;
        return true;
      }
      const dz = Math.log(t.z / c.z);
      if (Math.abs(t.x - c.x) * c.z < 0.25 && Math.abs(t.y - c.y) * c.z < 0.25 && Math.abs(dz) < 0.002) return false;
      const k = 1 - Math.exp(-dt / 160);
      c.x += (t.x - c.x) * k;
      c.y += (t.y - c.y) * k;
      c.z *= Math.exp(dz * k);
      return true;
    }

    toWorld(sx, sy) {
      return { x: (sx - this.W / 2) / this.cam.z + this.cam.x, y: (sy - this.H / 2) / this.cam.z + this.cam.y };
    }

    calcPoint() {
      if (!this.calcAnchor) return { x: this.cam.x, y: this.cam.y };
      return this.toWorld(this.calcAnchor.x, this.calcAnchor.y);
    }

    ghostPoint(F, ghost) {
      if (!ghost) return null;
      if (ghost.at === 'calc') return this.calcPoint();
      const c = F.containers.get(ghost.at);
      return c && c.ghost ? c.ghost : this.calcPoint();
    }

    // ---------- Drawing ----------

    // src = { a: step | null, b: step, p: 0..1 }
    draw(src, now, animating) {
      const dt = this.last ? Math.min(64, now - this.last) : 16;
      this.last = now;
      const FB = this.frame(src.b);
      const FA = src.a && src.a !== src.b ? this.frame(src.a) : null;
      const moving = this.stepCamera(FB, dt);
      if (!animating && !moving && !this.dirty) return;
      this.dirty = false;
      this.paint(FA, FB, src.a, src.b, FA ? ease(clamp(src.p, 0, 1)) : 1);
    }

    paint(FA, FB, a, b, e) {
      const { ctx, cam, dpr, W, H } = this;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * (W / 2 - cam.x * cam.z), dpr * (H / 2 - cam.y * cam.z));

      // Regions (soft background boxes with a title).
      const regions = FA && e < 0.5 ? FA.regions : FB.regions;
      regions.forEach((r) => this.region(r));

      // Containers, blended by id.
      const geo = new Map();
      FB.containers.forEach((cb, id) => {
        const ca = FA && FA.containers.get(id);
        geo.set(id, { c: cb, rect: ca ? lerpRect(ca.rect, cb.rect, e) : cb.rect, alpha: ca || !FA ? 1 : e });
      });
      if (FA) {
        FA.containers.forEach((ca, id) => {
          if (!FB.containers.has(id)) geo.set(id, { c: ca, rect: ca.rect, alpha: 1 - e, gone: true });
        });
      }

      // Key positions, blended by value. New keys fly in from where the ghost was.
      const kpos = new Map();
      const ghostA = FA && a.ghost ? this.ghostPoint(FA, a.ghost) : null;
      FB.keys.forEach((kb, k) => {
        let ka = FA ? FA.keys.get(k) : kb;
        let alpha = 1;
        if (!ka) {
          if (ghostA && a.ghost.key === k) ka = ghostA;
          else { ka = kb; alpha = e; }
        }
        kpos.set(k, { x: lerp(ka.x, kb.x, e), y: lerp(ka.y, kb.y, e), alpha, sub: kb.sub, subHL: kb.subHL });
      });
      if (FA) {
        FA.keys.forEach((ka, k) => {
          if (!FB.keys.has(k)) kpos.set(k, { x: ka.x, y: ka.y - 18 * e, alpha: 1 - e, sub: ka.sub, subHL: ka.subHL, gone: true });
        });
      }

      geo.forEach((g) => this.container(g, b));
      this.links(FB, geo, kpos, e, FA);
      FB.marks.forEach((m) => this.mark(m, FA, e));
      kpos.forEach((p, k) => this.key(k, p, p.gone ? (a.kh[k] || null) : b.kh[k] || null));

      // The ghost: the key being inserted / searched.
      const gB = b.ghost ? this.ghostPoint(FB, b.ghost) : null;
      if (gB) {
        const from = ghostA && a.ghost.key === b.ghost.key ? ghostA : null;
        const pos = from ? { x: lerp(from.x, gB.x, e), y: lerp(from.y, gB.y, e) } : gB;
        const cont = b.ghost.at !== 'calc' ? FB.containers.get(b.ghost.at) : null;
        if (cont && cont.ghostSlot) this.ghostSlot(gB, from ? 1 : e);
        this.ghost(b.ghost.key, pos, from ? 1 : e);
      } else if (ghostA && !FB.keys.has(a.ghost.key)) {
        this.ghost(a.ghost.key, ghostA, 1 - e);
      }
    }

    region(r) {
      const { ctx, c } = this;
      roundRect(ctx, r.rect.x, r.rect.y, r.rect.w, r.rect.h, 16);
      ctx.fillStyle = c.panel2;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = c.line;
      ctx.stroke();
      ctx.fillStyle = c.muted;
      ctx.font = `700 14px ${this.font}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(r.title, r.rect.x + 4, r.rect.y - 10);
    }

    roleStyle(role) {
      const c = this.c;
      switch (role) {
        case 'target': return { stroke: c.accent, fill: null, w: 3 };
        case 'probe': return { stroke: c.warn, fill: c.warnSoft, w: 3 };
        case 'read': return { stroke: c.orange, fill: c.orangeSoft, w: 3 };
        case 'full': return { stroke: c.bad, fill: c.badSoft, w: 3 };
        case 'new': return { stroke: c.good, fill: c.goodSoft, w: 3 };
        case 'split': return { stroke: c.violet, fill: c.violetSoft, w: 3 };
        default: return null;
      }
    }

    container(g, b) {
      const { ctx, c } = this;
      const { rect: r } = g;
      const k = g.c;
      const role = g.gone ? null : b.hl[k.id] || null;
      const st = this.roleStyle(role);
      ctx.save();
      ctx.globalAlpha = g.alpha;
      const radius = k.kind === 'entry' ? 7 : 10;

      ctx.save();
      ctx.shadowColor = c.nodeShadow;
      ctx.shadowBlur = 8 * this.dpr;
      ctx.shadowOffsetY = 2 * this.dpr;
      roundRect(ctx, r.x, r.y, r.w, r.h, radius);
      ctx.fillStyle = st && st.fill ? st.fill : c.panel;
      ctx.fill();
      ctx.restore();

      // Header strip for pages and buckets.
      if (k.kind === 'page' || k.kind === 'bucket') {
        const hh = 26;
        ctx.save();
        roundRect(ctx, r.x, r.y, r.w, r.h, radius);
        ctx.clip();
        ctx.fillStyle = k.tint === 'image' ? c.goodSoft : k.tint === 'done' ? c.violetSoft : k.page > 0 ? c.panel2 : c.accentSoft;
        ctx.fillRect(r.x, r.y, r.w, hh);
        ctx.restore();
        ctx.font = `750 13px ${this.font}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillStyle = k.tint === 'image' ? c.good : k.tint === 'done' ? c.violet : k.page > 0 ? c.muted : c.accent;
        if (k.kind === 'page') {
          ctx.fillText(k.label, r.x + 9, r.y + hh / 2 + 0.5);
          if (k.sub) {
            ctx.font = `650 12px ${this.mono}`;
            ctx.textAlign = 'right';
            ctx.fillText(k.sub, r.x + r.w - 9, r.y + hh / 2 + 0.5);
          }
          // empty slot guides
          ctx.strokeStyle = c.line;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 4]);
          for (let i = 1; i < k.cap; i++) {
            const y = r.y + hh + i * ((r.h - hh - 8) / k.cap);
            ctx.beginPath();
            ctx.moveTo(r.x + 10, y);
            ctx.lineTo(r.x + r.w - 10, y);
            ctx.stroke();
          }
          ctx.setLineDash([]);
        } else {
          ctx.fillText(`${k.name}`, r.x + 10, r.y + hh / 2 + 0.5);
          ctx.font = `650 12px ${this.font}`;
          ctx.fillStyle = c.ink2;
          ctx.fillText(`local depth ${k.ld}`, r.x + 30, r.y + hh / 2 + 0.5);
          // slot outlines
          ctx.strokeStyle = c.line;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 4]);
          for (let i = 0; i < k.slots; i++) {
            roundRect(ctx, r.x + 6 + i * 58 + 4, r.y + hh + 4, 50, r.h - hh - 10, 6);
            ctx.stroke();
          }
          ctx.setLineDash([]);
        }
      }

      roundRect(ctx, r.x, r.y, r.w, r.h, radius);
      ctx.lineWidth = st ? st.w : 1.5;
      ctx.strokeStyle = st ? st.stroke : c.lineStrong;
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (k.kind === 'slot') {
        ctx.fillStyle = role === 'probe' || role === 'target' ? (role === 'probe' ? c.warn : c.accent) : c.muted;
        ctx.font = `700 14px ${this.font}`;
        ctx.fillText(String(k.index), r.x + r.w / 2, r.y + r.h + 14);
        if (k.tomb) {
          ctx.fillStyle = c.muted;
          ctx.font = `700 12px ${this.mono}`;
          ctx.fillText('deleted', r.x + r.w / 2, r.y + r.h / 2);
          ctx.strokeStyle = c.lineStrong;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(r.x + 10, r.y + r.h - 10);
          ctx.lineTo(r.x + r.w - 10, r.y + 10);
          ctx.stroke();
        }
      } else if (k.kind === 'head') {
        ctx.fillStyle = role ? c.accent : c.muted;
        ctx.font = `700 14px ${this.font}`;
        ctx.textAlign = 'right';
        ctx.fillText(String(k.index), r.x - 10, r.y + r.h / 2);
        ctx.textAlign = 'center';
        if (k.count) {
          ctx.beginPath();
          ctx.arc(r.x + r.w - 14, r.y + r.h / 2, 5, 0, Math.PI * 2);
          ctx.fillStyle = c.ink2;
          ctx.fill();
        } else {
          ctx.fillStyle = c.muted;
          ctx.font = `600 13px ${this.mono}`;
          ctx.fillText('null', r.x + r.w / 2, r.y + r.h / 2);
        }
      } else if (k.kind === 'entry') {
        ctx.fillStyle = role ? c.accent : c.ink;
        ctx.font = `750 16px ${this.mono}`;
        ctx.textAlign = 'left';
        ctx.fillText(k.bits, r.x + 12, r.y + r.h / 2 + 0.5);
        ctx.fillStyle = c.muted;
        ctx.font = `600 11.5px ${this.font}`;
        ctx.textAlign = 'right';
        ctx.fillText(String(k.index), r.x + r.w - 20, r.y + r.h / 2 + 0.5);
        ctx.beginPath();
        ctx.arc(r.x + r.w - 8, r.y + r.h / 2, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = c.ink2;
        ctx.fill();
      }
      ctx.restore();

      if (role === 'read' || role === 'new' || role === 'full' || role === 'split') {
        const text = { read: 'read · 1 I/O', new: 'new', full: 'full', split: 'split' }[role];
        const col = { read: c.orange, new: c.good, full: c.bad, split: c.violet }[role];
        const soft = { read: c.orangeSoft, new: c.goodSoft, full: c.badSoft, split: c.violetSoft }[role];
        ctx.globalAlpha = g.alpha;
        this.tag(r.x + (k.kind === 'bucket' ? r.w / 2 : 44), r.y - 13, text, col, soft);
        ctx.globalAlpha = 1;
      }
    }

    // Resolves a link endpoint to a point using the blended geometry.
    endpoint(ref, geo, kpos) {
      if (ref.k != null) {
        const p = kpos.get(ref.k);
        return p ? { x: p.x - KW / 2, y: p.y, alpha: p.alpha } : null;
      }
      const g = geo.get(ref.c);
      if (!g) return null;
      const r = g.rect;
      const side = ref.side || 'right';
      if (side === 'bottom') return { x: r.x + r.w / 2, y: r.y + r.h, alpha: g.alpha };
      if (side === 'top') return { x: r.x + r.w / 2, y: r.y, alpha: g.alpha };
      if (side === 'left') return { x: r.x, y: r.y + r.h / 2, alpha: g.alpha };
      if (g.c.kind === 'head') return { x: r.x + r.w - 14, y: r.y + r.h / 2, alpha: g.alpha };
      if (g.c.kind === 'entry') return { x: r.x + r.w - 8, y: r.y + r.h / 2, alpha: g.alpha };
      return { x: r.x + r.w, y: r.y + r.h / 2, alpha: g.alpha };
    }

    links(F, geo, kpos) {
      const { ctx, c } = this;
      F.links.forEach((l) => {
        const p = this.endpoint(l.from, geo, kpos);
        const q = this.endpoint(l.to, geo, kpos);
        if (!p || !q) return;
        ctx.save();
        ctx.globalAlpha = Math.min(p.alpha, q.alpha);
        ctx.strokeStyle = l.kind === 'dir' ? c.lineStrong : c.ink2;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = l.kind === 'dir' ? 1.6 : 2;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        let ang;
        if (l.kind === 'dir') {
          const mx = (p.x + q.x) / 2;
          ctx.bezierCurveTo(mx, p.y, mx, q.y, q.x - 2, q.y);
          ang = 0;
        } else if (l.kind === 'overflow') {
          ctx.lineTo(q.x, q.y - 2);
          ang = Math.PI / 2;
        } else {
          ctx.lineTo(q.x - 2, q.y);
          ang = Math.atan2(q.y - p.y, q.x - p.x);
        }
        ctx.stroke();
        const tx = l.kind === 'overflow' ? q.x : q.x - 1, ty = l.kind === 'overflow' ? q.y - 1 : q.y;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - 9 * Math.cos(ang - 0.45), ty - 9 * Math.sin(ang - 0.45));
        ctx.lineTo(tx - 9 * Math.cos(ang + 0.45), ty - 9 * Math.sin(ang + 0.45));
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      });
    }

    // The "next" split pointer of linear hashing (an arrow pointing up at its bucket).
    mark(m, FA, e) {
      if (m.invisible) return;
      const { ctx, c } = this;
      let x = m.x, y = m.y;
      if (FA) {
        const ma = FA.marks.find((o) => o.kind === m.kind);
        if (ma) { x = lerp(ma.x, m.x, e); y = lerp(ma.y, m.y, e); }
      }
      ctx.fillStyle = c.accent;
      ctx.beginPath();
      ctx.moveTo(x, y - 18);
      ctx.lineTo(x - 11, y);
      ctx.lineTo(x + 11, y);
      ctx.closePath();
      ctx.fill();
      ctx.font = `750 15px ${this.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(m.label, x, y + 4);
    }

    keyColors(role) {
      const c = this.c;
      switch (role) {
        case 'new': return { fill: c.accent, stroke: c.accent, ink: c.onStrong };
        case 'found': return { fill: c.good, stroke: c.good, ink: c.onStrong };
        case 'delete': return { fill: c.bad, stroke: c.bad, ink: c.onStrong };
        case 'move': return { fill: c.violet, stroke: c.violet, ink: c.onStrong };
        case 'compare': return { fill: c.warnSoft, stroke: c.warn, ink: c.ink };
        default: return { fill: c.keyBg, stroke: c.lineStrong, ink: c.ink };
      }
    }

    key(k, p, role) {
      const { ctx, c } = this;
      if (p.alpha <= 0.01) return;
      const col = this.keyColors(role);
      ctx.save();
      ctx.globalAlpha = p.alpha;
      roundRect(ctx, p.x - KW / 2, p.y - KH / 2, KW, KH, 7);
      ctx.fillStyle = col.fill;
      ctx.fill();
      ctx.lineWidth = role === 'compare' ? 2.5 : 1.2;
      ctx.strokeStyle = col.stroke;
      ctx.stroke();
      ctx.fillStyle = col.ink;
      ctx.font = `750 17px ${this.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(k), p.x, p.y + 0.5);
      if (p.sub) {
        // binary form under the key, with the bits that matter for its bucket highlighted
        ctx.font = `650 11.5px ${this.mono}`;
        const n = p.subHL || 0;
        const head = p.sub.slice(0, p.sub.length - n), tail = p.sub.slice(p.sub.length - n);
        const w = ctx.measureText(p.sub).width;
        let x = p.x - w / 2;
        ctx.textAlign = 'left';
        ctx.fillStyle = c.muted;
        ctx.fillText(head, x, p.y + KH / 2 + 11);
        x += ctx.measureText(head).width;
        ctx.fillStyle = c.accent;
        ctx.font = `800 11.5px ${this.mono}`;
        ctx.fillText(tail, x, p.y + KH / 2 + 11);
      }
      ctx.restore();
    }

    ghost(k, p, alpha) {
      const { ctx, c, dpr } = this;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 14 * dpr;
      ctx.shadowOffsetY = 4 * dpr;
      roundRect(ctx, p.x - KW / 2 - 2, p.y - KH / 2 - 2, KW + 4, KH + 4, 8);
      ctx.fillStyle = c.accent;
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = c.onStrong;
      ctx.font = `800 18px ${this.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(k), p.x, p.y + 0.5);
      ctx.restore();
    }

    // Dashed placeholder where a chained key will be appended.
    ghostSlot(p, alpha) {
      const { ctx, c } = this;
      ctx.save();
      ctx.globalAlpha = alpha * 0.8;
      ctx.setLineDash([4, 4]);
      roundRect(ctx, p.x - KW / 2 - 6, p.y - KH / 2 - 6, KW + 12, KH + 12, 10);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = c.accent;
      ctx.stroke();
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

  global.HashView = HashView;
})(window);
