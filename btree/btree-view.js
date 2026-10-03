/*
 * Canvas renderer and pointer interaction for the B-tree demo.
 *
 * draw() blends two recorded steps: nodes and keys are matched by id / value, so a
 * median visibly flies up on a split, a separator drops down on a merge, and so on.
 * The user can pan (drag background), zoom (wheel / pinch), move nodes (drag a
 * node's border, or Shift-drag anywhere on it) and pick up keys (drag a key).
 */
(function (global) {
  'use strict';

  // World geometry, in pixels at zoom 1.
  const CELL = 46;
  const CELL_H = 40;
  const PAD = 6;
  const NODE_H = CELL_H + PAD * 2;
  const KEY_W = CELL - 6;
  const KEY_H = CELL_H - 6;
  const LEVEL = 104;
  const GAP = 28;
  const GHOST_Y = 38;
  const MIN_Z = 0.15;
  const MAX_Z = 3;
  const FIT_MAX_Z = 1.6;

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const nodeWidth = (keyCount) => PAD * 2 + Math.max(keyCount, 1) * CELL;
  const pick = (map, id) => (map && map[id] != null ? map[id] : null);

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Tidy layout: every subtree gets a horizontal band as wide as it needs and each
  // parent sits centred above its children. Root top-centre is at (0, 0).
  function layout(root) {
    const out = new Map();
    if (!root) return out;
    const span = new Map();
    const measure = (n) => {
      let kids = 0;
      n.children.forEach((c, i) => { kids += measure(c) + (i ? GAP : 0); });
      const s = Math.max(nodeWidth(n.keys.length), kids);
      span.set(n.id, s);
      return s;
    };
    const place = (n, left, depth) => {
      const s = span.get(n.id);
      const w = nodeWidth(n.keys.length);
      let cx = left + s / 2;
      if (n.children.length) {
        const kids = n.children.reduce((a, c, i) => a + span.get(c.id) + (i ? GAP : 0), 0);
        let x = left + (s - kids) / 2;
        const centers = n.children.map((c) => {
          const cc = place(c, x, depth + 1);
          x += span.get(c.id) + GAP;
          return cc;
        });
        cx = clamp((centers[0] + centers[centers.length - 1]) / 2, left + w / 2, left + s - w / 2);
      }
      out.set(n.id, { id: n.id, keys: n.keys, kids: n.children.map((c) => c.id), cx, y: depth * LEVEL, w });
      return cx;
    };
    measure(root);
    place(root, -span.get(root.id) / 2, 0);
    return out;
  }

  // Positions of every node, key, parent link and the ghost for one step.
  function buildFrame(step, offsets) {
    const nodes = layout(step.tree);
    if (step.tree) {
      // Manual drags move a node together with its subtree.
      const shift = (n, dx, dy) => {
        const o = offsets.get(n.id);
        if (o) { dx += o.dx; dy += o.dy; }
        const g = nodes.get(n.id);
        g.cx += dx;
        g.y += dy;
        n.children.forEach((c) => shift(c, dx, dy));
      };
      shift(step.tree, 0, 0);
    }

    const keys = new Map();
    const links = new Map();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach((g) => {
      const left = g.cx - g.w / 2 + PAD;
      g.keys.forEach((k, j) => keys.set(k, { x: left + j * CELL + CELL / 2, y: g.y + PAD + CELL_H / 2 }));
      g.kids.forEach((cid, j) => links.set(cid, { parent: g.id, idx: j }));
      minX = Math.min(minX, g.cx - g.w / 2);
      maxX = Math.max(maxX, g.cx + g.w / 2);
      minY = Math.min(minY, g.y);
      maxY = Math.max(maxY, g.y + NODE_H);
    });
    if (minX === Infinity) { minX = -130; maxX = 130; minY = 0; maxY = NODE_H; } // empty-tree placeholder

    let ghost = null;
    if (step.ghost) {
      const g = step.ghost.node != null ? nodes.get(step.ghost.node) : null;
      ghost = g
        ? { key: step.ghost.key, x: g.cx - g.w / 2 + PAD + step.ghost.gap * CELL, y: g.y - GHOST_Y }
        : { key: step.ghost.key, x: 0, y: -GHOST_Y };
      ghost.from = step.ghost.from || null;
      minX = Math.min(minX, ghost.x - KEY_W);
      maxX = Math.max(maxX, ghost.x + KEY_W);
      minY = Math.min(minY, ghost.y - KEY_H);
    }
    return { step, nodes, keys, links, ghost, bounds: { minX, minY, maxX, maxY } };
  }

  class BTreeView {
    constructor(canvas, hooks = {}, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.hooks = hooks;
      this.watermark = options.watermark || '';
      this.cam = { x: 0, y: 30, z: 1 };
      this.autoFit = true;
      this.snapCamera = true;
      this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
      this.offsets = new Map(); // node id -> manual {dx, dy}
      this.offsetVer = 0;
      this.cache = new WeakMap(); // step -> frame
      this.lifted = null; // key currently being dragged out of the tree
      this.hit = { keys: [], nodes: [] };
      this.pointers = new Map();
      this.drag = null;
      this.lastFrame = null;
      this.dirty = true;
      this.last = 0;
      this.readTheme();
      this.resize();
      this.bind();
    }

    // ---------- Setup ----------

    readTheme() {
      const cs = getComputedStyle(document.documentElement);
      const names = ['panel', 'ink', 'muted', 'line-strong', 'accent', 'on-strong', 'good', 'warn', 'warn-soft',
        'bad', 'bad-soft', 'violet', 'teal', 'orange', 'key-bg', 'grid', 'node-shadow'];
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

    frame(step) {
      let f = this.cache.get(step);
      if (!f || f.ver !== this.offsetVer) {
        f = buildFrame(step, this.offsets);
        f.ver = this.offsetVer;
        this.cache.set(step, f);
      }
      return f;
    }

    // A node created by a split keeps the manual offset of the node it came from.
    inheritOffsets(origin) {
      Object.keys(origin).forEach((nid) => {
        const o = this.offsets.get(origin[nid]);
        if (o && !this.offsets.has(+nid)) this.offsets.set(+nid, { dx: o.dx, dy: o.dy });
      });
      this.offsetVer++;
    }

    tidy() {
      this.offsets.clear();
      this.offsetVer++;
      this.setAutoFit(true);
    }

    setAutoFit(on) {
      if (this.autoFit !== on) {
        this.autoFit = on;
        if (this.hooks.onAutoFit) this.hooks.onAutoFit(on);
      }
      this.dirty = true;
    }

    // ---------- Camera ----------

    toWorld(sx, sy) {
      return [(sx - this.W / 2) / this.cam.z + this.cam.x, (sy - this.H / 2) / this.cam.z + this.cam.y];
    }

    clientToWorld(clientX, clientY) {
      const r = this.canvas.getBoundingClientRect();
      const [x, y] = this.toWorld(clientX - r.left, clientY - r.top);
      return { x, y };
    }

    fitCamera(b) {
      const ins = this.insets;
      const aw = Math.max(80, this.W - ins.left - ins.right - 40);
      const ah = Math.max(80, this.H - ins.top - ins.bottom - 40);
      const z = clamp(Math.min(aw / (b.maxX - b.minX), ah / (b.maxY - b.minY)), MIN_Z, FIT_MAX_Z);
      const sx = ins.left + (this.W - ins.left - ins.right) / 2;
      const sy = ins.top + (this.H - ins.top - ins.bottom) / 2;
      return {
        x: (b.minX + b.maxX) / 2 - (sx - this.W / 2) / z,
        y: (b.minY + b.maxY) / 2 - (sy - this.H / 2) / z,
        z,
      };
    }

    // Eases the camera towards the fitted view. Returns true while still moving.
    stepCamera(F, dt) {
      if (!this.autoFit || (this.drag && this.drag.mode === 'node')) return false;
      const t = this.fitCamera(F.bounds);
      const c = this.cam;
      if (this.snapCamera) {
        Object.assign(c, t);
        this.snapCamera = false;
        return true;
      }
      const dz = Math.log(t.z / c.z);
      if (Math.abs(t.x - c.x) * c.z < 0.25 && Math.abs(t.y - c.y) * c.z < 0.25 && Math.abs(dz) < 0.002) return false;
      const k = 1 - Math.exp(-dt / 150);
      c.x += (t.x - c.x) * k;
      c.y += (t.y - c.y) * k;
      c.z *= Math.exp(dz * k);
      return true;
    }

    zoomAt(sx, sy, factor) {
      const [wx, wy] = this.toWorld(sx, sy);
      const z = clamp(this.cam.z * factor, MIN_Z, MAX_Z);
      this.cam.z = z;
      this.cam.x = wx - (sx - this.W / 2) / z;
      this.cam.y = wy - (sy - this.H / 2) / z;
      this.setAutoFit(false);
    }

    zoomBy(factor) { this.zoomAt(this.W / 2, this.H / 2, factor); }

    // ---------- Drawing ----------

    // src = { a: step | null, b: step, p: 0..1 } — blend from step a to step b.
    draw(src, now, animating) {
      const dt = this.last ? Math.min(64, now - this.last) : 16;
      this.last = now;
      const FB = this.frame(src.b);
      const FA = src.a && src.a !== src.b ? this.frame(src.a) : null;
      const moving = this.stepCamera(FB, dt);
      if (!animating && !moving && !this.dirty) return;
      this.dirty = false;
      this.lastFrame = FB;
      this.paint(FA, FB, FA ? ease(clamp(src.p, 0, 1)) : 1);
    }

    paint(FA, FB, e) {
      const { ctx, c, cam, dpr, W, H } = this;
      const a = FA ? FA.step : null;
      const b = FB.step;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      this.paintGrid();
      this.paintWatermark();
      ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * (W / 2 - cam.x * cam.z), dpr * (H / 2 - cam.y * cam.z));

      // 1. Blend node geometry between the two frames.
      const geo = new Map();
      FB.nodes.forEach((gb, id) => {
        let ga = FA ? FA.nodes.get(id) : gb;
        let alpha = 1;
        if (!ga) {
          // A new node grows out of the node it was split from (or merged into, when rewinding).
          const srcId = pick(b.origin, id) ?? pick(a.into, id);
          ga = (srcId != null && FA.nodes.get(srcId)) || { cx: gb.cx, y: gb.y - 24, w: gb.w };
          alpha = e;
        }
        geo.set(id, { cx: lerp(ga.cx, gb.cx, e), y: lerp(ga.y, gb.y, e), w: lerp(ga.w, gb.w, e), alpha, n: gb.keys.length });
      });
      if (FA) {
        FA.nodes.forEach((ga, id) => {
          if (FB.nodes.has(id)) return;
          // A vanishing node slides into the node it merges with (or back into its split origin).
          const dstId = pick(b.into, id) ?? pick(a.origin, id);
          const to = (dstId != null && FB.nodes.get(dstId)) || { cx: ga.cx, y: ga.y + 16, w: ga.w };
          geo.set(id, { cx: lerp(ga.cx, to.cx, e), y: lerp(ga.y, to.y, e), w: lerp(ga.w, to.w, e), alpha: 1 - e, n: ga.keys.length });
        });
      }

      this.paintEmpty(FA, FB, e);
      this.paintEdges(FA, FB, geo, e);

      // 2. Node boxes.
      this.hit.nodes = [];
      geo.forEach((g, id) => {
        if (g.alpha <= 0.01) return;
        const x = g.cx - g.w / 2;
        ctx.save();
        ctx.globalAlpha = g.alpha;
        ctx.shadowColor = c.nodeShadow;
        ctx.shadowBlur = 10 * dpr;
        ctx.shadowOffsetY = 2 * dpr;
        roundRect(ctx, x, g.y, g.w, NODE_H, 10);
        ctx.fillStyle = c.panel;
        ctx.fill();
        ctx.restore();
        ctx.globalAlpha = g.alpha;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = c.lineStrong;
        ctx.stroke();
        if (a && a.nodes[id]) this.paintNodeRole(a.nodes[id], x, g, g.alpha * (1 - e));
        if (b.nodes[id]) this.paintNodeRole(b.nodes[id], x, g, g.alpha * e);
        if (g.n === 0) {
          ctx.globalAlpha = g.alpha;
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = c.muted;
          ctx.lineWidth = 1.5;
          roundRect(ctx, x + PAD + 3, g.y + PAD + 3, CELL - 6, CELL_H - 6, 7);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        if (g.alpha > 0.5) this.hit.nodes.push({ id, x, y: g.y, w: g.w, h: NODE_H });
      });

      // 3. Keys — matched by value, so a key that changes node flies to its new place.
      this.hit.keys = [];
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const ghostA = FA ? FA.ghost : null;
      FB.keys.forEach((kb, key) => {
        const ka = FA && FA.keys.get(key);
        let x = kb.x, y = kb.y, alpha = 1, scale = 1;
        let roleA = a ? a.keys[key] : undefined;
        if (ka) {
          x = lerp(ka.x, kb.x, e);
          y = lerp(ka.y, kb.y, e);
        } else if (FA && ghostA && ghostA.key === key) {
          // The floating key lands in its leaf.
          x = lerp(ghostA.x, kb.x, e);
          y = lerp(ghostA.y, kb.y, e);
          roleA = 'new';
        } else if (FA) {
          alpha = e;
          scale = 0.6 + 0.4 * e;
        }
        this.paintKey(key, x, y, alpha, scale, roleA, b.keys[key], e, key === this.lifted);
        if (alpha > 0.5) this.hit.keys.push({ key, x, y });
      });
      if (FA) {
        FA.keys.forEach((ka, key) => {
          if (FB.keys.has(key) || (FB.ghost && FB.ghost.key === key)) return;
          this.paintKey(key, ka.x, ka.y + 10 * e, 1 - e, 1 - 0.3 * e, a.keys[key], undefined, 0, false);
        });
      }

      this.paintGhosts(FA, FB, e);
      ctx.globalAlpha = 1;
    }

    paintGrid() {
      const { ctx, cam, W, H } = this;
      let s = 32;
      while (s * cam.z < 18) s *= 2;
      const sp = s * cam.z;
      const ox = (((W / 2 - cam.x * cam.z) % sp) + sp) % sp;
      const oy = (((H / 2 - cam.y * cam.z) % sp) + sp) % sp;
      const r = 1.6;
      ctx.fillStyle = this.c.grid;
      for (let x = ox; x < W; x += sp) {
        for (let y = oy; y < H; y += sp) ctx.fillRect(x - r / 2, y - r / 2, r, r);
      }
    }

    // Author credit in screen space, just above the bottom overlays; drawn before the
    // tree so nodes pass over it rather than under it.
    paintWatermark() {
      if (!this.watermark) return;
      const { ctx, W, H } = this;
      const y = H - this.insets.bottom + 2;
      ctx.save();
      ctx.font = `650 15px ${this.font}`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0.04em';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = this.c.muted;
      ctx.globalAlpha = 0.55;
      ctx.fillText(this.watermark, W - 16, y);
      ctx.restore();
    }

    paintEmpty(FA, FB, e) {
      const emptyB = !FB.step.tree;
      const emptyA = FA ? !FA.step.tree : emptyB;
      const alpha = emptyB ? (emptyA ? 1 : e) : emptyA && FA ? 1 - e : 0;
      if (alpha <= 0.01) return;
      const { ctx, c } = this;
      ctx.globalAlpha = alpha;
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = c.lineStrong;
      roundRect(ctx, -130, 0, 260, NODE_H, 12);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = c.muted;
      ctx.font = `500 15px ${this.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Empty tree — drop a key here', 0, NODE_H / 2);
    }

    paintEdges(FA, FB, geo, e) {
      const { ctx, c } = this;
      const a = FA ? FA.step : null;
      const b = FB.step;
      const slotX = (g, idx) => g.cx - g.w / 2 + PAD + idx * CELL;
      const ids = new Set(FB.links.keys());
      if (FA) FA.links.forEach((_, id) => ids.add(id));
      ctx.lineCap = 'round';

      ids.forEach((cid) => {
        const child = geo.get(cid);
        if (!child) return;
        const lb = FB.links.get(cid);
        const la = FA ? FA.links.get(cid) : null;
        let sx, sy, alpha;
        if (lb && (la || !FA) && (!la || la.parent === lb.parent)) {
          const p = geo.get(lb.parent);
          sx = slotX(p, la ? lerp(la.idx, lb.idx, e) : lb.idx);
          sy = p.y + NODE_H;
          alpha = Math.min(p.alpha, child.alpha);
        } else if (lb && la) {
          // Re-parented child (merge / borrow between internal nodes).
          const pa = FA.nodes.get(la.parent), pb = FB.nodes.get(lb.parent);
          sx = lerp(slotX(pa, la.idx), slotX(pb, lb.idx), e);
          sy = lerp(pa.y, pb.y, e) + NODE_H;
          alpha = child.alpha;
        } else if (lb) {
          const p = geo.get(lb.parent);
          sx = slotX(p, lb.idx);
          sy = p.y + NODE_H;
          alpha = Math.min(p.alpha, child.alpha, e);
        } else {
          const p = geo.get(la.parent);
          if (!p) return;
          sx = slotX(p, la.idx);
          sy = p.y + NODE_H;
          alpha = Math.min(p.alpha, child.alpha, 1 - e);
        }
        if (alpha <= 0.01) return;

        const ex = child.cx, ey = child.y, my = (sy + ey) / 2;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(sx, my, ex, my, ex, ey);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = c.lineStrong;
        ctx.lineWidth = 1.8;
        ctx.stroke();
        const hl = Math.min(1, (b.edges[cid] ? e : 0) + (a && a.edges[cid] ? 1 - e : 0));
        if (hl > 0.01) {
          ctx.globalAlpha = alpha * hl;
          ctx.strokeStyle = c.accent;
          ctx.lineWidth = 3.5;
          ctx.stroke();
        }
        ctx.globalAlpha = alpha;
        ctx.fillStyle = hl > 0.5 ? c.accent : c.lineStrong;
        ctx.beginPath();
        ctx.arc(sx, sy, 3.2, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    nodeStyle(role) {
      const c = this.c;
      switch (role) {
        case 'visit': return { stroke: c.accent };
        case 'found': case 'new': case 'merged': case 'fixed': return { stroke: c.good };
        case 'overflow': return { stroke: c.bad, fill: c.badSoft };
        case 'underflow': return { stroke: c.bad, fill: c.badSoft, dash: true };
        case 'split': return { stroke: c.violet };
        case 'sibling': return { stroke: c.teal };
        default: return null;
      }
    }

    paintNodeRole(role, x, g, alpha) {
      const s = this.nodeStyle(role);
      if (!s || alpha <= 0.01) return;
      const ctx = this.ctx;
      ctx.save();
      roundRect(ctx, x, g.y, g.w, NODE_H, 10);
      if (s.fill) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = s.fill;
        ctx.fill();
      }
      ctx.strokeStyle = s.stroke;
      ctx.globalAlpha = alpha * 0.18;
      ctx.lineWidth = 9;
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 2.75;
      if (s.dash) ctx.setLineDash([7, 5]);
      ctx.stroke();
      ctx.restore();
    }

    keyStyle(role) {
      const c = this.c;
      switch (role) {
        case 'compare': return { fill: c.warnSoft, stroke: c.warn, text: c.ink };
        case 'found': return { fill: c.good, text: c.onStrong };
        case 'new': return { fill: c.accent, text: c.onStrong };
        case 'median': return { fill: c.violet, text: c.onStrong };
        case 'delete': return { fill: c.bad, text: c.onStrong };
        case 'pred': case 'borrow': return { fill: c.teal, text: c.onStrong };
        case 'separator': return { fill: c.orange, text: c.onStrong };
        default: return null;
      }
    }

    // Draws one key cell, cross-fading from roleA's colours to roleB's as e goes 0 → 1.
    paintKey(key, x, y, alpha, scale, roleA, roleB, e, lifted) {
      if (alpha <= 0.01) return;
      const { ctx, c } = this;
      const dim = lifted ? 0.25 : 1;
      const w = KEY_W * scale, h = KEY_H * scale;
      roundRect(ctx, x - w / 2, y - h / 2, w, h, 7 * scale);
      ctx.globalAlpha = alpha * dim;
      ctx.fillStyle = c.keyBg;
      ctx.fill();
      const sa = roleA ? this.keyStyle(roleA) : null;
      const sb = roleB ? this.keyStyle(roleB) : null;
      const layer = (s, k) => {
        if (!s || k <= 0.01) return;
        ctx.globalAlpha = alpha * k * dim;
        ctx.fillStyle = s.fill;
        ctx.fill();
        if (s.stroke) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = s.stroke;
          ctx.stroke();
        }
      };
      layer(sa, 1 - e);
      layer(sb, e);
      if (lifted) {
        ctx.globalAlpha = alpha;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = c.accent;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const s = e >= 0.5 ? sb : sa;
      ctx.globalAlpha = alpha * (lifted ? 0.4 : 1);
      ctx.fillStyle = s ? s.text : c.ink;
      this.keyText(String(key), x, y, scale);
    }

    keyText(text, x, y, scale) {
      const ctx = this.ctx;
      let size = 18 * scale;
      ctx.font = `700 ${size}px ${this.font}`;
      const max = (KEY_W - 8) * scale;
      const w = ctx.measureText(text).width;
      if (w > max) {
        size *= max / w;
        ctx.font = `700 ${size}px ${this.font}`;
      }
      ctx.fillText(text, x, y + scale);
    }

    paintGhosts(FA, FB, e) {
      const ga = FA ? FA.ghost : null;
      const gb = FB.ghost;
      const same = ga && gb && ga.key === gb.key;
      if (gb) {
        let x = gb.x, y = gb.y, alpha = 1;
        const keyA = FA && !FB.keys.has(gb.key) ? FA.keys.get(gb.key) : null;
        if (same) {
          x = lerp(ga.x, gb.x, e);
          y = lerp(ga.y, gb.y, e);
        } else if (FA && gb.from) {
          x = lerp(gb.from.x, gb.x, e);
          y = lerp(gb.from.y, gb.y, e);
        } else if (keyA) {
          // Rewinding an insertion: the key lifts back out of its leaf.
          x = lerp(keyA.x, gb.x, e);
          y = lerp(keyA.y, gb.y, e);
        } else if (FA) {
          y = gb.y - 30 * (1 - e);
          alpha = e;
        }
        this.paintGhost(gb.key, FB.step.op, x, y, alpha);
      }
      if (ga && !same) {
        const landsInTree = FB.keys.has(ga.key) && !FA.keys.has(ga.key);
        if (!landsInTree) this.paintGhost(ga.key, FA.step.op, ga.x, ga.y - 20 * e, 1 - e);
      }
    }

    paintGhost(key, op, x, y, alpha) {
      if (alpha <= 0.01) return;
      const { ctx, c, dpr } = this;
      const color = op === 'delete' ? c.bad : op === 'search' ? c.warn : c.accent;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
      ctx.shadowBlur = 12 * dpr;
      ctx.shadowOffsetY = 3 * dpr;
      ctx.fillStyle = color;
      roundRect(ctx, x - KEY_W / 2, y - KEY_H / 2, KEY_W, KEY_H, 8);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.beginPath();
      ctx.moveTo(x - 6, y + KEY_H / 2 - 1);
      ctx.lineTo(x + 6, y + KEY_H / 2 - 1);
      ctx.lineTo(x, y + KEY_H / 2 + 7);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = c.onStrong;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      this.keyText(String(key), x, y, 1);
      ctx.restore();
    }

    // ---------- Interaction ----------

    hitKey(wx, wy) {
      for (let i = this.hit.keys.length - 1; i >= 0; i--) {
        const h = this.hit.keys[i];
        if (Math.abs(wx - h.x) <= KEY_W / 2 && Math.abs(wy - h.y) <= KEY_H / 2) return h.key;
      }
      return null;
    }

    hitNode(wx, wy) {
      for (let i = this.hit.nodes.length - 1; i >= 0; i--) {
        const h = this.hit.nodes[i];
        if (wx >= h.x && wx <= h.x + h.w && wy >= h.y && wy <= h.y + h.h) return h.id;
      }
      return null;
    }

    local(e) {
      const r = this.canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    bind() {
      const cv = this.canvas;
      cv.addEventListener('pointerdown', (e) => this.onDown(e));
      cv.addEventListener('pointermove', (e) => this.onMove(e));
      cv.addEventListener('pointerup', (e) => this.onUp(e, false));
      cv.addEventListener('pointercancel', (e) => this.onUp(e, true));
      cv.addEventListener('lostpointercapture', (e) => { if (this.pointers.has(e.pointerId)) this.onUp(e, true); });
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const [sx, sy] = this.local(e);
        this.zoomAt(sx, sy, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
      }, { passive: false });
      cv.addEventListener('dblclick', (e) => {
        const [wx, wy] = this.toWorld(...this.local(e));
        const id = this.hitNode(wx, wy);
        if (id != null) this.resetNode(id);
        else this.setAutoFit(true);
      });
    }

    // Double-clicking a node puts it (and its subtree) back where the layout wants it.
    resetNode(id) {
      const F = this.lastFrame;
      if (!F) return;
      const clear = (nid) => {
        this.offsets.delete(nid);
        const g = F.nodes.get(nid);
        if (g) g.kids.forEach(clear);
      };
      clear(id);
      this.offsetVer++;
      this.dirty = true;
    }

    updateCursor(sx, sy, shift) {
      const [wx, wy] = this.toWorld(sx, sy);
      let cursor = '';
      if (this.hitKey(wx, wy) != null) cursor = shift ? 'move' : 'grab';
      else if (this.hitNode(wx, wy) != null) cursor = 'move';
      this.canvas.style.cursor = cursor;
    }

    onDown(e) {
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
      this.canvas.setPointerCapture(e.pointerId);
      const [sx, sy] = this.local(e);
      this.pointers.set(e.pointerId, { sx, sy });

      if (this.pointers.size === 2) {
        // Second finger: switch to pinch-zoom (cancelling any key drag in progress).
        const d = this.drag;
        if (d && d.mode === 'key' && d.moved) {
          this.lifted = null;
          this.hooks.onKeyDragEnd(d.key, e, true);
        }
        const [p, q] = [...this.pointers.values()];
        const [wx, wy] = this.toWorld((p.sx + q.sx) / 2, (p.sy + q.sy) / 2);
        this.drag = { mode: 'pinch', d0: Math.max(10, Math.hypot(p.sx - q.sx, p.sy - q.sy)), z0: this.cam.z, wx, wy };
        this.setAutoFit(false);
        return;
      }
      if (this.pointers.size > 2) return;

      const [wx, wy] = this.toWorld(sx, sy);
      const key = e.button === 0 ? this.hitKey(wx, wy) : null;
      const node = e.button === 0 ? this.hitNode(wx, wy) : null;
      let mode = 'pan';
      if (key != null && !e.shiftKey) mode = 'key';
      else if (node != null) mode = 'node';
      this.drag = { mode, key, node, x0: sx, y0: sy, lx: sx, ly: sy, moved: false };
      if (mode === 'pan') this.canvas.style.cursor = 'grabbing';
    }

    onMove(e) {
      const [sx, sy] = this.local(e);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { sx, sy });
      const d = this.drag;
      if (!d) {
        if (e.pointerType === 'mouse') this.updateCursor(sx, sy, e.shiftKey);
        return;
      }

      if (d.mode === 'pinch') {
        const pts = [...this.pointers.values()];
        if (pts.length < 2) return;
        const [p, q] = pts;
        const z = clamp((d.z0 * Math.hypot(p.sx - q.sx, p.sy - q.sy)) / d.d0, MIN_Z, MAX_Z);
        this.cam.z = z;
        this.cam.x = d.wx - ((p.sx + q.sx) / 2 - this.W / 2) / z;
        this.cam.y = d.wy - ((p.sy + q.sy) / 2 - this.H / 2) / z;
        this.dirty = true;
        return;
      }
      if (d.mode === 'none') return;

      if (!d.moved) {
        if (Math.hypot(sx - d.x0, sy - d.y0) < 5) return;
        d.moved = true;
        if (d.mode === 'key') {
          this.lifted = d.key;
          this.dirty = true;
          this.hooks.onKeyDragStart(d.key, e);
        }
        if (d.mode === 'node') this.canvas.style.cursor = 'move';
      }

      const dx = sx - d.lx, dy = sy - d.ly;
      d.lx = sx;
      d.ly = sy;
      if (d.mode === 'key') {
        this.hooks.onKeyDragMove(d.key, e);
      } else if (d.mode === 'node') {
        const o = this.offsets.get(d.node) || { dx: 0, dy: 0 };
        o.dx += dx / this.cam.z;
        o.dy += dy / this.cam.z;
        this.offsets.set(d.node, o);
        this.offsetVer++;
        this.dirty = true;
      } else {
        this.cam.x -= dx / this.cam.z;
        this.cam.y -= dy / this.cam.z;
        this.setAutoFit(false);
      }
    }

    onUp(e, cancelled) {
      if (!this.pointers.delete(e.pointerId)) return;
      const d = this.drag;
      if (!d) return;
      if (d.mode === 'pinch' || d.mode === 'none') {
        this.drag = this.pointers.size ? { mode: 'none' } : null;
        return;
      }
      this.drag = null;
      this.canvas.style.cursor = '';
      if (d.mode === 'key') {
        if (d.moved) {
          this.lifted = null;
          this.dirty = true;
          this.hooks.onKeyDragEnd(d.key, e, cancelled);
        } else if (!cancelled) {
          this.hooks.onKeyClick(d.key);
        }
      }
    }
  }

  global.BTreeView = BTreeView;
})(window);
