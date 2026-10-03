/*
 * Canvas renderer for the indexing demo.
 *
 * The scene is drawn in a fixed "world" (W × H) that is scaled to fit the canvas:
 * the CPU and RAM (buffer pool) on top, the disk with the table file and the index
 * file below, and the bus between them. draw() blends two recorded steps, so a page
 * read from disk visibly flies up into its RAM frame, an evicted page leaves, and
 * rows are checked one after another.
 */
(function (global) {
  'use strict';

  const { pageName, fmtMs, DISKS, RAM_MS } = global.IdxModel;

  // ---------- World geometry ----------

  const W = 1320;
  const H = 722;
  const CPU = { x: 0, y: 0, w: 316, h: 262 };
  const RAM = { x: 346, y: 0, w: 974, h: 262 };
  const DISK = { x: 0, y: 332, w: 1320, h: 390 };
  const BUS = { x: RAM.x + 90, y: RAM.y + RAM.h, w: RAM.w - 180, h: DISK.y - RAM.h - RAM.y };
  const GRID = { x: 22, y: DISK.y + 100, cols: 8, w: 100, h: 104, gx: 8, gy: 14 };
  const IDX = { x: 906, y: DISK.y + 100, w: 394, rootW: 200, rootH: 58, leafY: DISK.y + 198, leafH: 172, gap: 8 };
  const FR = { y: RAM.y + 72, h: RAM.h - 86, pad: 16, gap: 12 };

  const SPOTS = {
    disk: { x: DISK.x - 6, y: DISK.y - 6, w: DISK.w + 12, h: DISK.h + 12 },
    data: { x: GRID.x - 12, y: GRID.y - 34, w: GRID.cols * (GRID.w + GRID.gx) - GRID.gx + 24, h: 2 * GRID.h + GRID.gy + 70 },
    ram: { x: RAM.x - 6, y: RAM.y - 6, w: RAM.w + 12, h: RAM.h + 12 },
    bus: { x: BUS.x - 10, y: BUS.y - 14, w: BUS.w + 20, h: BUS.h + 28 },
    cpu: { x: CPU.x - 6, y: CPU.y - 6, w: CPU.w + 12, h: CPU.h + 12 },
    index: { x: IDX.x - 12, y: IDX.y - 34, w: IDX.w + 24, h: IDX.leafY + IDX.leafH - IDX.y + 46 },
  };

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const lerpRect = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });
  const inset = (r, d) => ({ x: r.x + d, y: r.y + d, w: r.w - 2 * d, h: r.h - 2 * d });

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

  function diskRect(pg) {
    if (pg.kind === 'data') {
      const c = pg.no % GRID.cols, r = Math.floor(pg.no / GRID.cols);
      return { x: GRID.x + c * (GRID.w + GRID.gx), y: GRID.y + r * (GRID.h + GRID.gy), w: GRID.w, h: GRID.h };
    }
    if (pg.kind === 'leaf') {
      const lw = (IDX.w - IDX.gap * 3) / 4;
      return { x: IDX.x + pg.no * (lw + IDX.gap), y: IDX.leafY, w: lw, h: IDX.leafH };
    }
    return { x: IDX.x + (IDX.w - IDX.rootW) / 2, y: IDX.y, w: IDX.rootW, h: IDX.rootH };
  }

  function frameRect(i, n) {
    const fw = (RAM.w - FR.pad * 2 - FR.gap * (n - 1)) / n;
    return { x: RAM.x + FR.pad + i * (fw + FR.gap), y: FR.y, w: fw, h: FR.h };
  }

  const slotRect = (i, n) => inset(frameRect(i, n), 5);
  const headH = (r) => clamp(r.h * 0.17, 15, 30);

  // Which items of a step's sequence (rows checked, keys compared) are visible at progress p.
  function reveal(seq, p, live) {
    if (!seq) return null;
    const n = seq.items.length;
    if (!live) return { items: seq.items, cur: -1, last: seq.items[n - 1] };
    const k = clamp(Math.floor(p * n) + 1, 1, n);
    return { items: seq.items.slice(0, k), cur: seq.items[k - 1].i, last: seq.items[k - 1] };
  }

  class IdxView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.table = null;
      this.insets = { top: 0, right: 0, bottom: 0, left: 0 };
      this.diskKey = 'hdd';
      this.dirty = true;
      this.spin = 0;
      this.flow = 0;
      this.last = 0;
      this.readTheme();
      this.resize();
    }

    // ---------- Setup ----------

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
      const aw = Math.max(60, this.CW - ins.left - ins.right - 24);
      const ah = Math.max(60, this.CH - ins.top - ins.bottom - 24);
      const z = Math.min(aw / W, ah / H, 1.7);
      const x = ins.left + (this.CW - ins.left - ins.right - W * z) / 2;
      const y = ins.top + (this.CH - ins.top - ins.bottom - H * z) / 2;
      return { z, x, y };
    }

    // ---------- Drawing ----------

    // src = { a: step | null, b: step, p: 0..1, fwd: bool } — blend from step a to step b.
    draw(src, now, animating) {
      const dt = this.last ? Math.min(64, now - this.last) : 16;
      this.last = now;
      const b = src.b;
      const reading = animating && src.fwd && b.kind === 'read';
      if (reading) {
        this.spin += dt * 0.012;
        this.flow += dt * 0.06;
      }
      const pulse = !!b.spot || (b.ptr && !animating);
      if (!animating && !this.dirty && !pulse) return;
      this.dirty = false;
      this.now = now;
      this.paint(src, animating, reading);
    }

    paint(src, animating, reading) {
      const { ctx, dpr } = this;
      const a = src.a && src.a !== src.b ? src.a : null;
      const b = src.b;
      const p = a ? clamp(src.p, 0, 1) : 1;
      const live = !!a && animating && src.fwd;
      const cam = this.camera();
      this.cam = cam;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, this.CW, this.CH);
      ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, dpr * cam.x, dpr * cam.y);

      this.paintCpu(b, src, live, p);
      this.paintRamBox(b);
      this.paintBus(b, reading);
      this.paintDisk(a, b, live, p, reading);
      this.paintFrames(a, b, live, p);
      this.paintPointer(a, b, live, p);
      this.paintSpot(a, b, p);
    }

    // ----- Boxes -----

    box(r, title, sub, tint) {
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
      ctx.fillStyle = tint;
      ctx.font = `750 20px ${this.font}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(title, r.x + 20, r.y + 34);
      if (sub) {
        const tw = ctx.measureText(title).width;
        ctx.fillStyle = c.muted;
        ctx.font = `500 13.5px ${this.font}`;
        ctx.fillText(sub, r.x + 30 + tw, r.y + 33);
      }
    }

    paintCpu(b, src, live, p) {
      const { ctx, c } = this;
      this.box(CPU, 'CPU', 'query engine', c.ink);
      const run = b.run;
      const x = CPU.x + 20;

      // SQL text
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      const sql = run.sql || ['SELECT * FROM students', 'WHERE …'];
      ctx.font = `600 15px ${this.mono}`;
      ctx.fillStyle = run.sql ? c.ink : c.muted;
      this.fitText(sql[0], x, CPU.y + 68, CPU.w - 40);
      this.fitText(sql[1], x, CPU.y + 90, CPU.w - 40);

      // Plan chip
      const plan = run.type === 'scan' ? (run.fallback ? 'Full table scan (no index on name)' : 'Full table scan')
        : run.type === 'index' ? 'Index lookup' : null;
      if (plan) {
        const col = run.type === 'scan' ? c.orange : c.violet;
        const soft = run.type === 'scan' ? c.orangeSoft : c.violetSoft;
        ctx.font = `700 12.5px ${this.font}`;
        const tw = ctx.measureText(plan).width;
        roundRect(ctx, x, CPU.y + 102, tw + 20, 24, 12);
        ctx.fillStyle = soft;
        ctx.fill();
        ctx.fillStyle = col;
        ctx.fillText(plan, x + 10, CPU.y + 118.5);
      }

      // Activity panel
      const ar = { x, y: CPU.y + 136, w: CPU.w - 40, h: 58 };
      roundRect(ctx, ar.x, ar.y, ar.w, ar.h, 10);
      ctx.fillStyle = c.panel2;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.line;
      ctx.stroke();
      const act = this.activity(b, src, live, p);
      let tx = ar.x + 14;
      if (act.wait) {
        // Spinner: the CPU is idle while the disk works.
        const cx = ar.x + 24, cy = ar.y + ar.h / 2, t = (this.now || 0) / 140;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.strokeStyle = c.line;
        ctx.beginPath();
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = c.warn;
        ctx.beginPath();
        ctx.arc(cx, cy, 10, t, t + (live ? 1.8 : 0.0001));
        ctx.stroke();
        ctx.lineCap = 'butt';
        tx = ar.x + 46;
      }
      ctx.fillStyle = act.wait ? c.warn : c.ink;
      ctx.font = `700 16px ${this.font}`;
      ctx.textBaseline = 'middle';
      this.fitText(act.text, tx, ar.y + (act.sub ? 22 : ar.h / 2), ar.x + ar.w - tx - (act.verdict ? 34 : 10));
      if (act.sub) {
        ctx.fillStyle = c.muted;
        ctx.font = `500 12.5px ${this.font}`;
        ctx.fillText(act.sub, tx, ar.y + 41);
      }
      if (act.verdict) this.verdictBadge(ar.x + ar.w - 22, ar.y + ar.h / 2, act.verdict, 11);

      // Result
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = c.muted;
      ctx.font = `700 12px ${this.font}`;
      ctx.fillText('RESULT', x, CPU.y + 222);
      const res = b.result;
      ctx.font = `650 14.5px ${this.font}`;
      if (!res.length) {
        ctx.fillStyle = c.muted;
        ctx.fillText(run.q ? '(no rows yet)' : '—', x + 64, CPU.y + 222);
      } else {
        const shown = res.slice(0, 2).map((r) => `${r.id} · ${r.name} (p${r.page + 1})`);
        ctx.fillStyle = c.good;
        ctx.fillText(shown[0], x + 64, CPU.y + 222);
        if (shown[1]) ctx.fillText(shown[1] + (res.length > 2 ? `  +${res.length - 2}` : ''), x + 64, CPU.y + 244);
      }
    }

    // What the CPU is doing right now, for the activity panel.
    activity(b, src, live, p) {
      const q = b.run.q;
      if (b.kind === 'read') {
        return live
          ? { text: 'Waiting for the disk…', sub: `CPU idle · ≈${fmtMs(DISKS[this.diskKey].pageMs)} per page`, wait: true }
          : { text: `${pageName(this.table.pages[b.read.pid])} is now in RAM`, sub: 'copied from disk' };
      }
      if (b.kind === 'hit') return { text: 'Already in RAM', sub: 'buffer hit · no disk read', verdict: 'yes' };
      if (b.seq && live && (b.kind === 'scan' || b.kind === 'probe' || b.kind === 'fetch')) {
        const rv = reveal(b.seq, p, live);
        const it = rv.last;
        const pg = this.table.pages[b.seq.pid];
        if (pg.kind === 'data') {
          const r = pg.rows[it.i];
          const v = q.col === 'id' ? r.id : `'${r.name}'`;
          const want = q.col === 'id' ? q.val : `'${q.val}'`;
          if (b.kind === 'fetch') return { text: `Row ${r.id} · ${r.name}`, sub: `slot ${it.i + 1} — no searching needed`, verdict: 'yes' };
          return { text: `${q.col} ${v} = ${want} ?`, sub: `row ${it.i + 1} of ${pg.rows.length} · ≈${fmtMs(RAM_MS)} each`, verdict: it.res };
        }
        if (pg.kind === 'root') {
          return { text: `${q.val} in ${pg.ranges[it.i]} ?`, sub: it.res === 'go' ? `yes → open leaf ${it.i + 1}` : 'no — next range', verdict: it.res === 'go' ? 'go' : 'no' };
        }
        const key = pg.entries[it.i].key;
        const sub = it.res === 'yes' ? 'found the entry' : it.res === 'right' ? 'too small → look right' : 'too big → look left';
        return { text: `${q.val} vs ${key}`, sub, verdict: it.res === 'yes' ? 'yes' : it.res };
      }
      const sub = b.kind === 'done' ? `${b.result.length} row${b.result.length === 1 ? '' : 's'} returned`
        : b.kind === 'scan' ? `${b.seq.items.length} rows checked in RAM`
          : b.kind === 'probe' ? `${b.seq.items.length} key${b.seq.items.length === 1 ? '' : 's'} compared in RAM` : '';
      return { text: b.cpu.act || 'Waiting for a query', sub, verdict: b.cpu.verdict };
    }

    verdictBadge(x, y, v, r) {
      const { ctx, c } = this;
      const col = v === 'yes' ? c.good : v === 'go' ? c.violet : v === 'no' ? c.muted : c.warn;
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
      } else {
        // arrow: go (down into a child), right (higher keys), left (lower keys)
        const dir = v === 'left' ? -1 : 1;
        if (v === 'go') {
          ctx.moveTo(x, y - s);
          ctx.lineTo(x, y + s);
          ctx.moveTo(x - s * 0.7, y + s * 0.3);
          ctx.lineTo(x, y + s);
          ctx.lineTo(x + s * 0.7, y + s * 0.3);
        } else {
          ctx.moveTo(x - s * dir, y);
          ctx.lineTo(x + s * dir, y);
          ctx.moveTo(x + s * 0.3 * dir, y - s * 0.7);
          ctx.lineTo(x + s * dir, y);
          ctx.lineTo(x + s * 0.3 * dir, y + s * 0.7);
        }
      }
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'miter';
    }

    // Draws text, shrinking the font if needed so it fits in maxW.
    fitText(text, x, y, maxW) {
      const { ctx } = this;
      const w = ctx.measureText(text).width;
      if (w <= maxW) {
        ctx.fillText(text, x, y);
        return;
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(maxW / w, 1);
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }

    paintRamBox(b) {
      const { ctx, c } = this;
      const n = b.ram.length;
      this.box(RAM, 'RAM', `buffer pool · fast (≈100 ns) · small: only ${n} pages fit`, c.accent);
      const used = b.ram.filter(Boolean).length;
      ctx.font = `700 13px ${this.font}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = used === n ? c.warn : c.muted;
      ctx.fillText(`${used} / ${n} frames used`, RAM.x + RAM.w - 20, RAM.y + 33);
      ctx.textAlign = 'left';
      // CPU ↔ RAM link
      const y = CPU.y + 165;
      ctx.strokeStyle = c.lineStrong;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(CPU.x + CPU.w + 2, y);
      ctx.lineTo(RAM.x - 2, y);
      ctx.stroke();
    }

    paintBus(b, reading) {
      const { ctx, c } = this;
      const r = BUS;
      const col = reading ? c.warn : c.lineStrong;
      // two rails with dashes flowing upwards while a page is being read
      const rails = [r.x + r.w * 0.36, r.x + r.w * 0.64];
      ctx.lineWidth = 4;
      rails.forEach((x) => {
        ctx.strokeStyle = c.line;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x, r.y);
        ctx.lineTo(x, r.y + r.h);
        ctx.stroke();
        ctx.strokeStyle = col;
        ctx.setLineDash([8, 9]);
        ctx.lineDashOffset = this.flow;
        ctx.beginPath();
        ctx.moveTo(x, r.y);
        ctx.lineTo(x, r.y + r.h);
        ctx.stroke();
      });
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;

      // label pill
      const d = DISKS[this.diskKey];
      const text = `disk → RAM: ≈${fmtMs(d.pageMs)} per page`;
      ctx.font = `700 14px ${this.font}`;
      const tw = ctx.measureText(text).width;
      const pw = tw + 30, ph = 30;
      const px = r.x + r.w / 2 - pw / 2, py = r.y + r.h / 2 - ph / 2;
      ctx.save();
      if (reading) {
        ctx.shadowColor = c.warn;
        ctx.shadowBlur = 16 * this.dpr;
      }
      roundRect(ctx, px, py, pw, ph, 15);
      ctx.fillStyle = reading ? c.warnSoft : c.panel;
      ctx.fill();
      ctx.restore();
      roundRect(ctx, px, py, pw, ph, 15);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = reading ? c.warn : c.lineStrong;
      ctx.stroke();
      ctx.fillStyle = reading ? c.warn : c.ink2;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, px + pw / 2, py + ph / 2 + 0.5);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }

    // ----- Disk -----

    paintDisk(a, b, live, p, reading) {
      const { ctx, c } = this;
      const d = DISKS[this.diskKey];
      this.box(DISK, '', '', c.ink);
      this.platter(DISK.x + 46, DISK.y + 44, 25, reading);
      ctx.textAlign = 'left';
      ctx.fillStyle = c.ink;
      ctx.font = `750 20px ${this.font}`;
      const title = this.diskKey === 'ssd' ? 'Disk (SSD)' : 'Hard disk';
      ctx.fillText(title, DISK.x + 86, DISK.y + 40);
      ctx.fillStyle = c.muted;
      ctx.font = `500 13.5px ${this.font}`;
      ctx.fillText('permanent · large · cheap · slow', DISK.x + 86, DISK.y + 60);

      // speed badge (right)
      const bt = `${d.short}: ≈${fmtMs(d.pageMs)} to read one page`;
      ctx.font = `700 13px ${this.font}`;
      const bw = ctx.measureText(bt).width + 24;
      roundRect(ctx, DISK.x + DISK.w - bw - 18, DISK.y + 22, bw, 28, 14);
      ctx.fillStyle = c.warnSoft;
      ctx.fill();
      ctx.fillStyle = c.warn;
      ctx.textAlign = 'center';
      ctx.fillText(bt, DISK.x + DISK.w - 18 - bw / 2, DISK.y + 41);
      ctx.textAlign = 'left';

      // file labels
      this.fileLabel(GRID.x, GRID.y - 14, 'students.dat', '— the table · rows in insertion order (not sorted)', c.accent);
      this.fileLabel(IDX.x, IDX.y - 14, 'students_id_idx', '— index on id (sorted)', c.violet);
      ctx.fillStyle = c.muted;
      ctx.font = `500 12.5px ${this.font}`;
      const gb = GRID.y + 2 * GRID.h + GRID.gy;
      const T = global.IdxModel;
      ctx.fillText(`${T.DATA_PAGES} pages × ${T.ROWS_PER_PAGE} rows = ${T.ROWS} rows. A full scan must read every page.`, GRID.x, gb + 26);

      const t = this.table;
      const found = new Set(b.result.map((r) => r.id));
      const readPid = b.kind === 'read' ? b.read.pid : null;

      // index tree edges (root pointers → leaves)
      const rr = diskRect(t.root);
      const chosen = b.ptr && t.pages[b.ptr.pid].kind === 'leaf' ? b.ptr.pid : null;
      t.leaves.forEach((lf, i) => {
        const lr = diskRect(lf);
        const sx = rr.x + rr.w * ((i + 0.5) / t.leaves.length);
        const on = chosen === lf.id;
        ctx.strokeStyle = on ? c.violet : c.lineStrong;
        ctx.lineWidth = on ? 3 : 1.5;
        ctx.beginPath();
        ctx.moveTo(sx, rr.y + rr.h - 4);
        ctx.bezierCurveTo(sx, rr.y + rr.h + 22, lr.x + lr.w / 2, lr.y - 24, lr.x + lr.w / 2, lr.y);
        ctx.stroke();
      });

      Object.values(t.pages).forEach((pg) => {
        const r = diskRect(pg);
        const st = {
          disk: true,
          reading: pg.id === readPid,
          inRam: b.ram.includes(pg.id),
          visited: b.visited.includes(pg.id),
          target: b.ptr && b.ptr.pid === pg.id,
          found,
        };
        this.page(pg, r, st);
      });
    }

    fileLabel(x, y, name, rest, col) {
      const { ctx, c } = this;
      ctx.font = `750 14px ${this.mono}`;
      ctx.fillStyle = col;
      ctx.fillText(name, x, y);
      const w = ctx.measureText(name).width;
      ctx.font = `500 13px ${this.font}`;
      ctx.fillStyle = c.ink2;
      ctx.fillText(rest, x + w + 8, y);
    }

    platter(cx, cy, r, busy) {
      const { ctx, c } = this;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = c.panel2;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = c.lineStrong;
      ctx.stroke();
      if (this.diskKey === 'ssd') {
        // a chip instead of a spinning platter
        ctx.fillStyle = busy ? c.warn : c.lineStrong;
        roundRect(ctx, cx - 11, cy - 11, 22, 22, 4);
        ctx.fill();
        for (let i = -1; i <= 1; i++) {
          ctx.fillRect(cx + i * 7 - 1.5, cy - 17, 3, 5);
          ctx.fillRect(cx + i * 7 - 1.5, cy + 12, 3, 5);
        }
        return;
      }
      // rotating sector shows the platter spinning
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(this.spin);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r - 3, -0.4, 0.4);
      ctx.closePath();
      ctx.fillStyle = busy ? c.warnSoft : c.line;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = c.lineStrong;
      ctx.fill();
      // read/write arm
      ctx.strokeStyle = busy ? c.warn : c.muted;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx + r + 6, cy + r - 2);
      ctx.lineTo(cx + 6, cy - 8);
      ctx.stroke();
      ctx.lineCap = 'butt';
      // activity LED
      ctx.beginPath();
      ctx.arc(cx + r + 6, cy - r + 2, 4, 0, Math.PI * 2);
      ctx.fillStyle = busy && Math.floor((this.now || 0) / 120) % 2 ? c.warn : c.line;
      ctx.fill();
    }

    // ----- Pages -----

    // Draws a page (data, index leaf or index root) into rect r.
    // st: { disk, reading, inRam, visited, target, found, marks, cur, faded, alpha, focus, hit }
    page(pg, r, st) {
      const { ctx, c } = this;
      const isData = pg.kind === 'data';
      const hue = isData ? c.accent : c.violet;
      const hueSoft = isData ? c.accentSoft : c.violetSoft;
      const hh = headH(r);
      ctx.save();
      ctx.globalAlpha = st.alpha == null ? 1 : st.alpha;

      if (st.reading || st.flying) {
        ctx.save();
        ctx.shadowColor = st.flying ? c.nodeShadow : c.warn;
        ctx.shadowBlur = (st.flying ? 22 : 10 + 8 * Math.sin((this.now || 0) / 110)) * this.dpr;
        ctx.shadowOffsetY = st.flying ? 8 * this.dpr : 0;
        roundRect(ctx, r.x, r.y, r.w, r.h, 7);
        ctx.fillStyle = c.panel;
        ctx.fill();
        ctx.restore();
      }

      roundRect(ctx, r.x, r.y, r.w, r.h, 7);
      ctx.fillStyle = c.panel;
      ctx.fill();
      // header strip
      ctx.save();
      roundRect(ctx, r.x, r.y, r.w, r.h, 7);
      ctx.clip();
      ctx.fillStyle = st.visited && st.disk ? c.warnSoft : hueSoft;
      ctx.fillRect(r.x, r.y, r.w, hh);
      ctx.restore();

      roundRect(ctx, r.x, r.y, r.w, r.h, 7);
      ctx.lineWidth = st.reading ? 3 : st.focus ? 3 : 1.2;
      ctx.strokeStyle = st.reading ? c.warn : st.focus ? hue : c.lineStrong;
      ctx.stroke();

      // header text
      const hf = hh * 0.6;
      ctx.font = `750 ${hf}px ${this.font}`;
      ctx.fillStyle = st.visited && st.disk ? c.warn : hue;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const label = pageName(pg) + (st.disk ? '' : isData ? ' · students' : ' · index');
      this.fitText(label, r.x + hh * 0.35, r.y + hh / 2 + 0.5, r.w - hh * 1.6);
      if (st.disk && st.inRam) {
        // small "in RAM" marker
        const s = hh * 0.36;
        ctx.beginPath();
        ctx.arc(r.x + r.w - hh * 0.5, r.y + hh / 2, s, 0, Math.PI * 2);
        ctx.fillStyle = c.accent;
        ctx.fill();
      }

      const body = { x: r.x, y: r.y + hh, w: r.w, h: r.h - hh };
      if (pg.kind === 'data') this.dataRows(pg, body, st);
      else if (pg.kind === 'leaf') this.leafEntries(pg, body, st);
      else this.rootBody(pg, r, body, st);
      ctx.restore();

      if (st.target) {
        ctx.save();
        ctx.setLineDash([6, 5]);
        ctx.lineDashOffset = -(this.now || 0) / 40;
        roundRect(ctx, r.x - 5, r.y - 5, r.w + 10, r.h + 10, 10);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = c.violet;
        ctx.stroke();
        ctx.restore();
      }
      if (st.hit) {
        roundRect(ctx, r.x - 4, r.y - 4, r.w + 8, r.h + 8, 10);
        ctx.lineWidth = 3;
        ctx.strokeStyle = c.good;
        ctx.globalAlpha = st.hit;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // Row / entry background according to its check result.
    markBg(x, y, w, h, res, cur, faded) {
      const { ctx, c } = this;
      if (!res && !cur) return;
      const col = res === 'yes' ? c.goodSoft : res === 'go' ? c.violetSoft : res === 'no' ? null : c.warnSoft;
      ctx.save();
      if (faded) ctx.globalAlpha *= 0.6;
      if (col) {
        roundRect(ctx, x, y, w, h, 4);
        ctx.fillStyle = col;
        ctx.fill();
      }
      if (cur) {
        roundRect(ctx, x, y, w, h, 4);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = res === 'yes' ? c.good : res === 'go' ? c.violet : c.warn;
        ctx.stroke();
      }
      ctx.restore();
    }

    dataRows(pg, body, st) {
      const { ctx, c } = this;
      const n = pg.rows.length;
      const pad = body.h * 0.04;
      const rh = (body.h - pad * 2) / n;
      const fs = clamp(Math.min(rh * 0.5, body.w / 6.6), 6, 17);
      pg.rows.forEach((row, i) => {
        const y = body.y + pad + i * rh;
        const res = st.marks ? st.marks.get(i) : null;
        const fadedRes = !res && st.faded ? st.faded.get(i) : null;
        const isFound = st.found && st.found.has(row.id) && (st.disk || res === 'yes' || fadedRes === 'yes' || !st.marks);
        const bx = body.x + 3, bw = body.w - 6;
        if (isFound && !res) this.markBg(bx, y + 1, bw, rh - 2, 'yes', false, false);
        this.markBg(bx, y + 1, bw, rh - 2, res || fadedRes, st.cur === i, !res);
        const dim = (res || fadedRes) === 'no';
        ctx.globalAlpha = (st.alpha == null ? 1 : st.alpha) * (dim ? 0.45 : 1);
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.font = `750 ${fs}px ${this.font}`;
        ctx.fillStyle = c.ink;
        const tx = body.x + fs * 0.55;
        ctx.fillText(String(row.id), tx, y + rh / 2 + 0.5);
        const iw = ctx.measureText('00').width + fs * 0.45;
        ctx.font = `500 ${fs}px ${this.font}`;
        ctx.fillStyle = c.ink2;
        const markW = (res || fadedRes) && !st.disk ? fs * 1.3 : 0;
        this.fitText(row.name, tx + iw, y + rh / 2 + 0.5, body.w - (tx - body.x) - iw - fs * 0.4 - markW);
        ctx.globalAlpha = st.alpha == null ? 1 : st.alpha;
        if ((res || fadedRes) && !st.disk) this.verdictBadge(body.x + body.w - fs * 0.85, y + rh / 2, res || fadedRes, fs * 0.5);
      });
    }

    leafEntries(pg, body, st) {
      const { ctx, c } = this;
      const per = pg.entries.length / 2;
      const pad = body.h * 0.03;
      const lh = (body.h - pad * 2) / per;
      const cw = body.w / 2;
      const fs = clamp(Math.min(lh * 0.62, cw / 3.1), 6, 15);
      const range = st.range; // [lo, hi] still possible during a binary search
      pg.entries.forEach((en, i) => {
        const col = Math.floor(i / per), line = i % per;
        const x = body.x + col * cw, y = body.y + pad + line * lh;
        const marks = st.marks || st.faded;
        const res = marks ? marks.get(i) : null;
        this.markBg(x + 2, y + 0.5, cw - 4, lh - 1, res, st.cur === i, !st.marks);
        const out = range && (i < range[0] || i > range[1]) && !res;
        ctx.globalAlpha = (st.alpha == null ? 1 : st.alpha) * (out ? 0.3 : 1);
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.font = `750 ${fs}px ${this.font}`;
        ctx.fillStyle = res === 'yes' ? c.good : c.ink;
        ctx.fillText(String(en.key), x + fs * 0.45, y + lh / 2 + 0.5);
        ctx.font = `${res === 'yes' ? 750 : 500} ${fs * 0.82}px ${this.font}`;
        ctx.fillStyle = res === 'yes' ? c.violet : c.muted;
        ctx.textAlign = 'right';
        ctx.fillText(`p${en.page + 1}`, x + cw - fs * 0.55, y + lh / 2 + 0.5);
        ctx.textAlign = 'left';
        ctx.globalAlpha = st.alpha == null ? 1 : st.alpha;
      });
      // column divider
      ctx.strokeStyle = c.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(body.x + cw, body.y + pad);
      ctx.lineTo(body.x + cw, body.y + body.h - pad);
      ctx.stroke();
    }

    // The root is wide and short on disk (keys in a row) but tall in a RAM frame
    // (one line per range); while flying, the two layouts cross-fade.
    rootBody(pg, r, body, st) {
      const { ctx } = this;
      const wide = clamp((r.w / r.h - 1.3) / 1.2, 0, 1);
      const base = st.alpha == null ? 1 : st.alpha;
      if (wide > 0) {
        ctx.globalAlpha = base * wide;
        this.rootWide(pg, body, st);
      }
      if (wide < 1) {
        ctx.globalAlpha = base * (1 - wide);
        this.rootTall(pg, body, st);
      }
      ctx.globalAlpha = base;
    }

    rootWide(pg, body, st) {
      const { ctx, c } = this;
      const n = pg.keys.length;
      const cw = Math.min(46, body.w / (n + 1.2));
      const ch = body.h * 0.62;
      const x0 = body.x + (body.w - n * cw) / 2;
      const y = body.y + (body.h - ch) / 2;
      const fs = clamp(ch * 0.55, 6, 15);
      pg.keys.forEach((k, i) => {
        roundRect(ctx, x0 + i * cw + 2, y, cw - 4, ch, 4);
        ctx.fillStyle = c.keyBg;
        ctx.fill();
        ctx.font = `750 ${fs}px ${this.font}`;
        ctx.fillStyle = c.ink;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(k), x0 + i * cw + cw / 2, y + ch / 2 + 0.5);
      });
      ctx.textAlign = 'left';
    }

    rootTall(pg, body, st) {
      const { ctx, c } = this;
      const n = pg.ranges.length;
      const pad = body.h * 0.05;
      const lh = (body.h - pad * 2) / n;
      const fs = clamp(Math.min(lh * 0.42, body.w / 7.4), 5, 16);
      const marks = st.marks || st.faded;
      pg.ranges.forEach((txt, i) => {
        const y = body.y + pad + i * lh;
        const res = marks ? marks.get(i) : null;
        this.markBg(body.x + 3, y + 2, body.w - 6, lh - 4, res, st.cur === i, !st.marks);
        ctx.globalAlpha = (st.alpha == null ? 1 : st.alpha) * (res === 'no' ? 0.45 : 1);
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.font = `750 ${fs}px ${this.font}`;
        ctx.fillStyle = res === 'go' ? c.violet : c.ink;
        ctx.fillText(`id ${txt}`, body.x + fs * 0.6, y + lh * 0.36);
        ctx.font = `500 ${fs * 0.88}px ${this.font}`;
        ctx.fillStyle = c.muted;
        ctx.fillText(`→ leaf ${i + 1}`, body.x + fs * 0.6, y + lh * 0.7);
        ctx.globalAlpha = st.alpha == null ? 1 : st.alpha;
      });
    }

    // Where item i of a page sits inside rect r (used for the pointer arrows).
    itemPoint(pg, r, i) {
      const hh = headH(r);
      const body = { x: r.x, y: r.y + hh, w: r.w, h: r.h - hh };
      if (pg.kind === 'root') {
        const pad = body.h * 0.05, lh = (body.h - pad * 2) / pg.ranges.length;
        return { x: body.x + body.w - 8, y: body.y + pad + (i + 0.5) * lh };
      }
      if (pg.kind === 'leaf') {
        const per = pg.entries.length / 2, pad = body.h * 0.03, lh = (body.h - pad * 2) / per;
        const col = Math.floor(i / per);
        return { x: body.x + (col + 1) * body.w / 2 - 1, y: body.y + pad + ((i % per) + 0.5) * lh };
      }
      const pad = body.h * 0.04, rh = (body.h - pad * 2) / pg.rows.length;
      return { x: body.x + body.w - 8, y: body.y + pad + (i + 0.5) * rh };
    }

    // ----- RAM frames -----

    paintFrames(a, b, live, p) {
      const { ctx, c } = this;
      const n = b.ram.length;
      const t = this.table;
      const e = ease(p);
      const full = b.ram.every(Boolean);
      const lru = full ? b.used.indexOf(Math.min(...b.used)) : -1;
      let flying = null;

      for (let f = 0; f < n; f++) {
        const fr = frameRect(f, n);
        // empty slot
        roundRect(ctx, fr.x, fr.y, fr.w, fr.h, 10);
        ctx.fillStyle = c.panel2;
        ctx.fill();
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = c.lineStrong;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = c.muted;
        ctx.font = `600 13px ${this.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('free frame', fr.x + fr.w / 2, fr.y + fr.h / 2);
        ctx.textAlign = 'left';

        const pidB = b.ram[f];
        const pidA = a && a.ram.length === n ? a.ram[f] : pidB;
        const slot = slotRect(f, n);

        if (pidA && pidA !== pidB) {
          // leaving: evicted (or rewinding) — slides up and fades out
          const k = live && b.kind === 'read' ? clamp(p / 0.35, 0, 1) : e;
          const r = { x: slot.x + slot.w * 0.08 * k, y: slot.y - 26 * k, w: slot.w * (1 - 0.16 * k), h: slot.h * (1 - 0.16 * k) };
          this.page(t.pages[pidA], r, Object.assign(this.ramState(a, pidA, f, 1, false), { alpha: 1 - k }));
          if (live && b.kind === 'read' && k < 1) {
            ctx.globalAlpha = 1 - k;
            this.tag(slot.x + slot.w / 2, slot.y - 30 * k - 8, 'evicted', c.bad, c.badSoft);
            ctx.globalAlpha = 1;
          }
        }
        if (!pidB) continue;
        if (pidA === pidB) {
          const hitK = b.kind === 'hit' && b.hit === f ? (live ? Math.sin(p * Math.PI) : 0.9) : 0;
          this.page(t.pages[pidB], slot, Object.assign(this.ramState(b, pidB, f, p, live), { hit: hitK }));
        } else if (live && b.kind === 'read' && b.read.pid === pidB) {
          flying = { pid: pidB, slot, f };
        } else {
          this.page(t.pages[pidB], slot, Object.assign(this.ramState(b, pidB, f, p, live), { alpha: e }));
        }
      }

      if (lru >= 0 && !(live && b.kind === 'read')) {
        const fr = frameRect(lru, n);
        this.tag(fr.x + fr.w / 2, fr.y + fr.h + 1, 'next to evict', c.muted, c.panel2);
      }

      // the page being copied from disk flies on top of everything
      if (flying) {
        const pg = t.pages[flying.pid];
        const from = diskRect(pg);
        const k = clamp((p - 0.12) / 0.88, 0, 1);
        const r = lerpRect(from, flying.slot, ease(k));
        r.y -= Math.sin(k * Math.PI) * 26;
        this.page(pg, r, Object.assign(this.ramState(b, flying.pid, flying.f, p, live), { flying: k > 0 && k < 1, focus: k >= 1 }));
        if (k < 1) {
          ctx.globalAlpha = 1 - k * 0.6;
          this.tag(r.x + r.w / 2, r.y - 10, 'copy', c.warn, c.warnSoft);
          ctx.globalAlpha = 1;
        }
      }
    }

    // Marks for a page in RAM: the rows/keys checked in this step, faded marks from earlier pages.
    ramState(step, pid, f, p, live) {
      const st = { focus: step.focus === f && step.kind !== 'idle' && step.kind !== 'done', found: new Set(step.result.map((r) => r.id)) };
      if (step.seq && step.seq.pid === pid) {
        const rv = reveal(step.seq, p, live);
        st.marks = new Map(rv.items.map((it) => [it.i, it.res]));
        st.cur = rv.cur;
        if (rv.last && rv.last.lo != null && rv.last.res !== 'yes') st.range = [rv.last.lo, rv.last.hi];
      } else if (step.scanned[pid]) {
        st.faded = new Map(step.scanned[pid].map((it) => [it.i, it.res]));
      }
      return st;
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

    // ----- Pointer arrow: index entry in RAM → the page it points to on disk -----

    paintPointer(a, b, live, p) {
      if (!b.ptr) return;
      const { ctx, c } = this;
      const t = this.table;
      const n = b.ram.length;
      const fresh = !a || !a.ptr || a.ptr.pid !== b.ptr.pid;
      const k = fresh && live ? clamp((p - 0.82) / 0.18, 0, 1) : 1;
      if (k <= 0) return;
      const src = t.pages[b.ram[b.ptr.frame]];
      if (!src) return;
      const from = this.itemPoint(src, slotRect(b.ptr.frame, n), b.ptr.item);
      const dr = diskRect(t.pages[b.ptr.pid]);
      const to = { x: dr.x + dr.w / 2, y: dr.y - 7 };
      const c1 = { x: from.x + 70, y: from.y + 40 };
      const c2 = { x: to.x, y: to.y - 130 };
      ctx.save();
      ctx.globalAlpha = k;
      ctx.strokeStyle = c.violet;
      ctx.lineWidth = 3;
      ctx.setLineDash([9, 7]);
      ctx.lineDashOffset = -(this.now || 0) / 30;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // arrowhead
      const ang = Math.atan2(to.y - c2.y, to.x - c2.x);
      ctx.fillStyle = c.violet;
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - 13 * Math.cos(ang - 0.42), to.y - 13 * Math.sin(ang - 0.42));
      ctx.lineTo(to.x - 13 * Math.cos(ang + 0.42), to.y - 13 * Math.sin(ang + 0.42));
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(from.x, from.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // ----- Tour spotlight -----

    paintSpot(a, b, p) {
      const spotA = a && a.spot && SPOTS[a.spot] ? SPOTS[a.spot] : null;
      const spotB = b.spot && SPOTS[b.spot] ? SPOTS[b.spot] : null;
      const boardOnly = b.spot === 'board';
      if (!spotA && !spotB && !boardOnly && !(a && a.spot)) return;
      const { ctx, c } = this;
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

  IdxView.WORLD = { W, H };
  global.IdxView = IdxView;
})(window);
