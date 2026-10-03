/*
 * Model for the indexing demo: a small "students" table stored as pages on a
 * simulated disk, a sorted index on id (one root page + leaf pages), a buffer
 * pool of a few RAM frames with LRU eviction, and recorders that turn a query
 * into animation steps. Every step is a full snapshot, so playback can jump
 * back and forth freely.
 */
(function (global) {
  'use strict';

  const ROWS_PER_PAGE = 4;
  const DATA_PAGES = 16;
  const LEAF_PAGES = 4;
  const ROWS = ROWS_PER_PAGE * DATA_PAGES;
  const PER_LEAF = ROWS / LEAF_PAGES;
  const MAX_ID = 99;
  const RAM_MS = 0.0001; // ≈100 ns: checking one row or key that is already in RAM

  // pageMs: simplified cost of reading one page (the animation charges every read the same).
  // seekMs / seqMBs: used only by the "bigger tables" estimate, where full scans read sequentially.
  const DISKS = {
    hdd: { name: 'hard disk', short: 'HDD', pageMs: 10, seekMs: 10, seqMBs: 150 },
    ssd: { name: 'SSD', short: 'SSD', pageMs: 0.1, seekMs: 0.1, seqMBs: 500 },
  };

  const NAMES = [
    'Nimal', 'Kasun', 'Amaya', 'Saman', 'Dilini', 'Ruwan', 'Chamari', 'Ishara', 'Kavindu', 'Sachini',
    'Hasini', 'Lahiru', 'Pasindu', 'Dinithi', 'Malith', 'Sanduni', 'Yasiru', 'Oshadi', 'Nuwan', 'Thilini',
    'Kamal', 'Anjali', 'Priya', 'Ravi', 'Arjun', 'Fatima', 'Rizwan', 'Aisha', 'Omar', 'Mei',
    'Liam', 'Emma', 'Noah', 'Sofia', 'Lucas', 'Zara', 'Ethan', 'Nadia', 'Tariq', 'Asha',
  ];

  // Pseudocode; "▹" starts a comment. {col} / {val} are filled in per query.
  const CODE = {
    scan: [
      'for each page P of students.dat:',
      '  if P is not in RAM: read P from disk ▹ slow',
      '  for each row R in P: ▹ in RAM — fast',
      '    if R.{col} = {val}: add R to the result',
      'return the result',
    ],
    scanFirst: [
      'for each page P of students.dat:',
      '  if P is not in RAM: read P from disk ▹ slow',
      '  for each row R in P: ▹ in RAM — fast',
      '    if R.{col} = {val}: return R ▹ LIMIT 1',
      'return no rows',
    ],
    index: [
      'page ← root of students_id_idx',
      'while page is not a leaf:',
      '  load page into RAM ▹ disk read unless cached',
      '  page ← child whose range holds {val}',
      'load the leaf into RAM',
      'binary-search {val} in the sorted leaf',
      'if found (→ data page P, slot S):',
      '  load P into RAM ▹ one more disk read',
      '  return row S',
      'else: return no rows',
    ],
  };

  // ---------- Small helpers ----------

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(list, rnd) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  // 160.0064 → "160 ms", 0.0064 → "6.4 µs", 2400 → "2.4 s"
  function fmtMs(ms) {
    const num = (v, unit) => {
      let s;
      if (v >= 100) s = v.toFixed(0);
      else if (v >= 10) s = v.toFixed(1).replace(/\.0$/, '');
      else s = v.toFixed(2).replace(/\.?0+$/, '');
      return `${s} ${unit}`;
    };
    if (!(ms > 0)) return '0 ms';
    if (ms >= 3600000) return num(ms / 3600000, 'h');
    if (ms >= 60000) return num(ms / 60000, 'min');
    if (ms >= 1000) return num(ms / 1000, 's');
    if (ms >= 1) return num(ms, 'ms');
    if (ms >= 0.001) return num(ms * 1000, 'µs');
    return num(ms * 1e6, 'ns');
  }

  const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
  const plural = (n, word, many) => `${n} ${n === 1 ? word : many || word + 's'}`;
  const pageName = (pg) => (pg.kind === 'data' ? `p${pg.no + 1}` : pg.kind === 'leaf' ? `leaf ${pg.no + 1}` : 'root');
  const timesFaster = (slow, fast) => {
    const r = slow / fast;
    return r >= 10 ? Math.round(r).toLocaleString('en-US') : r.toFixed(1).replace(/\.0$/, '');
  };

  // Ranges shown in the root page: one line per leaf.
  function rootRanges(root) {
    const k = root.keys;
    return root.kids.map((_, i) => {
      if (i === 0) return `< ${k[0]}`;
      if (i === k.length) return `≥ ${k[k.length - 1]}`;
      return `${k[i - 1]}–${k[i] - 1}`;
    });
  }

  // ---------- The table and its index ----------

  function makeTable(seed) {
    const rnd = mulberry32(seed);
    const pool = shuffle(Array.from({ length: MAX_ID }, (_, i) => i + 1), rnd);
    const rows = pool.slice(0, ROWS).map((id, n) => ({
      id,
      name: NAMES[Math.floor(rnd() * NAMES.length)],
      page: Math.floor(n / ROWS_PER_PAGE),
      slot: n % ROWS_PER_PAGE,
    }));

    const pages = {};
    const data = [];
    for (let p = 0; p < DATA_PAGES; p++) {
      const pg = { id: 'd' + p, kind: 'data', no: p, rows: rows.slice(p * ROWS_PER_PAGE, (p + 1) * ROWS_PER_PAGE) };
      data.push(pg);
      pages[pg.id] = pg;
    }

    // The index holds every id in sorted order with a pointer (page, slot) to its row.
    const sorted = rows.slice().sort((x, y) => x.id - y.id);
    const leaves = [];
    for (let l = 0; l < LEAF_PAGES; l++) {
      const entries = sorted.slice(l * PER_LEAF, (l + 1) * PER_LEAF).map((r) => ({ key: r.id, page: r.page, slot: r.slot }));
      const lf = { id: 'l' + l, kind: 'leaf', no: l, entries };
      leaves.push(lf);
      pages[lf.id] = lf;
    }
    const root = { id: 'r', kind: 'root', no: 0, keys: leaves.slice(1).map((lf) => lf.entries[0].key), kids: leaves.map((lf) => lf.id) };
    root.ranges = rootRanges(root);
    pages.r = root;

    return { seed, rows, data, leaves, root, pages };
  }

  // ---------- Engine: buffer pool + step recorders ----------

  const zeroStats = () => ({ reads: 0, hits: 0, rows: 0, keys: 0, diskMs: 0, ramMs: 0 });

  class Engine {
    constructor(opts) {
      this.opts = Object.assign({ seed: 2026, frames: 6, disk: 'hdd', limitOne: false }, opts);
      this.table = makeTable(this.opts.seed);
      this.board = { scan: null, index: null };
      this.runs = 0;
      this.setFrames(this.opts.frames);
    }

    get disk() { return DISKS[this.opts.disk]; }

    setFrames(n) {
      this.opts.frames = n;
      this.frames = Array(n).fill(null); // page id held by each RAM frame
      this.used = Array(n).fill(0); // LRU clock value of each frame
      this.clock = 0;
    }

    newData(seed) {
      this.opts.seed = seed;
      this.table = makeTable(seed);
      this.setFrames(this.opts.frames);
      this.board = { scan: null, index: null };
    }

    clearBoard() { this.board = { scan: null, index: null }; }

    // A value that exists, roughly two-thirds of the way into the file — a good first demo.
    sampleValue(col, random) {
      const rows = this.table.rows;
      const r = random ? rows[Math.floor(Math.random() * rows.length)] : rows[9 * ROWS_PER_PAGE + 1];
      return col === 'name' ? r.name : r.id;
    }

    findRow(col, val) {
      return this.table.rows.find((r) => (col === 'id' ? r.id === val : r.name.toLowerCase() === String(val).toLowerCase()));
    }

    // The step shown when nothing is running.
    idle(msg, status = 'info') {
      const ctx = this.begin('idle', null);
      return this.snap(ctx, 'idle', { msg, status, cpu: { act: 'Waiting for a query' } });
    }

    begin(type, q, extra) {
      const run = Object.assign({ id: ++this.runs, type, q, label: '', code: null, lane: null }, extra);
      if (q) {
        const val = q.col === 'name' ? `'${q.val}'` : String(q.val);
        run.where = `${q.col} = ${val}`;
        run.limit = this.opts.limitOne;
        run.sql = ['SELECT * FROM students', `WHERE ${run.where}${run.limit ? ' LIMIT 1' : ''};`];
        if (run.code) run.code = run.code.map((l) => l.replace('{col}', q.col).replace(/\{val\}/g, val));
      }
      const ctx = { run, steps: [], stats: zeroStats(), visited: [], scanned: {}, result: [], ptr: null };
      if (run.lane) this.board[run.lane] = { run: run.id, where: run.where, limit: run.limit, stats: zeroStats(), done: false, fallback: !!run.fallback };
      return ctx;
    }

    snap(ctx, kind, f) {
      if (ctx.run.lane) this.board[ctx.run.lane].stats = Object.assign({}, ctx.stats);
      const board = {};
      ['scan', 'index'].forEach((k) => {
        const l = this.board[k];
        board[k] = l ? Object.assign({}, l, { stats: Object.assign({}, l.stats) }) : null;
      });
      const step = Object.assign({
        run: ctx.run, kind, msg: '', status: 'info', line: -1,
        ram: this.frames.slice(), used: this.used.slice(),
        read: null, hit: -1, focus: -1, seq: null, ptr: ctx.ptr, spot: null,
        visited: ctx.visited.slice(), scanned: Object.assign({}, ctx.scanned), result: ctx.result.slice(),
        cpu: { act: '' }, stats: Object.assign({}, ctx.stats), board, active: ctx.run.lane,
        dur: 500, hold: null,
      }, f);
      ctx.steps.push(step);
      return step;
    }

    touch(fr) { this.used[fr] = ++this.clock; }

    flushPool() {
      this.frames.fill(null);
      this.used.fill(0);
    }

    // Brings a page into RAM: a buffer hit if it is already there, otherwise a disk
    // read into a free frame — evicting the least recently used page when RAM is full.
    load(ctx, pid, line, say) {
      const pg = this.table.pages[pid];
      let fr = this.frames.indexOf(pid);
      if (fr >= 0) {
        this.touch(fr);
        ctx.stats.hits++;
        this.snap(ctx, 'hit', {
          hit: fr, focus: fr, line, dur: Math.round(650 * (say.pace || 1)), hold: say.hold,
          msg: `${pg.kind === 'data' ? `Page ${pageName(pg)}` : pg.kind === 'root' ? "The index's root page" : `Index ${pageName(pg)}`} is already in RAM (a buffer hit), so no disk read is needed.`,
          cpu: { act: 'Page already in RAM', verdict: 'yes' },
        });
        return fr;
      }
      let evict = null;
      fr = this.frames.indexOf(null);
      if (fr < 0) {
        fr = this.used.indexOf(Math.min(...this.used));
        evict = this.frames[fr];
      }
      this.frames[fr] = pid;
      this.touch(fr);
      ctx.stats.reads++;
      ctx.stats.diskMs += this.disk.pageMs;
      ctx.visited.push(pid);
      const ev = evict ? ` RAM is full, so the least recently used page (${pageName(this.table.pages[evict])}) is evicted to make room.` : '';
      this.snap(ctx, 'read', {
        read: { pid, frame: fr, evict }, focus: fr, line,
        dur: say.slow ? 1600 : Math.round(1150 * (say.pace || 1)), hold: say.hold,
        msg: say.read + ev,
        cpu: { act: 'Waiting for the disk…', wait: true },
      });
      return fr;
    }

    // ---------- Full table scan ----------

    runScan(q, fallback) {
      const first = this.opts.limitOne;
      const ctx = this.begin('scan', q, {
        lane: 'scan', fallback, label: `Full scan · ${q.col} = ${q.col === 'name' ? `'${q.val}'` : q.val}${first ? ' · LIMIT 1' : ''}`,
        code: CODE[first ? 'scanFirst' : 'scan'],
      });
      const t = this.table;
      const ms = fmtMs(this.disk.pageMs);
      const want = q.col === 'id' ? q.val : String(q.val).toLowerCase();
      const match = (r) => (q.col === 'id' ? r.id === want : r.name.toLowerCase() === want);

      this.snap(ctx, 'plan', {
        line: 0, dur: 450, hold: 1500,
        msg: fallback
          ? `There is no index on ${q.col} (the index is on id), so the database falls back to a full table scan: read every page and check every row.`
          : `Plan: full table scan. With no index on ${q.col}, the only way to find ${ctx.run.where} is to read every page of students.dat and check every row.`,
        cpu: { act: 'Plan: full table scan' },
      });

      let stopped = false;
      for (const pg of t.data) {
        // Explain the first pages in detail, then speed the animation up page by page
        // (pace 1 → 0.28) so the rest of the table doesn't drag on in class.
        const early = pg.no < 2;
        const pace = early ? 1 : Math.max(0.28, 1 - 0.18 * (pg.no - 1));
        const name = pageName(pg);
        const fr = this.load(ctx, pg.id, 1, {
          slow: early, pace, hold: early ? null : Math.round(500 * pace),
          read: pg.no === 0
            ? `Read page ${name} from the ${this.disk.name} into a free RAM frame. This is the slow part: ≈${ms}, and the CPU can do nothing but wait.`
            : early
              ? `Next page: read ${name} from disk into RAM (≈${ms} again).`
              : pg.no === 2
                ? `Read ${name} from disk → RAM. From here on the animation speeds up — but every page still costs ≈${ms} on the clock.`
                : `Read ${name} from disk → RAM (≈${ms}).`,
        });

        const items = pg.rows.map((r, i) => ({ i, res: match(r) ? 'yes' : 'no' }));
        const hits = pg.rows.filter(match);
        ctx.stats.rows += pg.rows.length;
        ctx.stats.ramMs += pg.rows.length * RAM_MS;
        ctx.scanned[pg.id] = items;
        hits.forEach((r) => ctx.result.push(r));

        let msg;
        if (hits.length) {
          const what = hits.map((r) => `${r.id} · ${r.name}`).join(' and ');
          msg = `Match! Row ${what} is on page ${name} → add it to the result.`;
          if (first) msg += ' LIMIT 1 lets the scan stop here.';
          else if (pg.no < DATA_PAGES - 1) msg += ` But keep scanning: without an index the database can't know there is no other row with ${ctx.run.where} further on.`;
        } else if (early) {
          msg = `Now the CPU checks the ${pg.rows.length} rows in RAM: ${pg.rows.map((r) => (q.col === 'id' ? r.id : r.name)).join(', ')} — no match. This takes about ${fmtMs(pg.rows.length * RAM_MS)}: RAM is fast.`;
        } else {
          msg = `Check its ${pg.rows.length} rows in RAM — no match.`;
        }
        this.snap(ctx, 'scan', {
          focus: fr, line: hits.length ? 3 : 2, dur: Math.round((180 * pg.rows.length + 160) * pace),
          seq: { frame: fr, pid: pg.id, items },
          msg, status: hits.length ? 'success' : 'info', hold: hits.length ? 1800 : early ? 1300 : Math.round(250 * pace),
          cpu: { act: hits.length ? `Found ${hits.map((r) => r.id).join(', ')}` : 'No match on this page', verdict: hits.length ? 'yes' : 'no' },
        });
        if (hits.length && first) { stopped = true; break; }
      }

      const s = ctx.stats;
      const n = ctx.result.length;
      const pages = s.reads + s.hits;
      const found = n ? `found ${plural(n, 'row')}` : `found no row with ${ctx.run.where}`;
      const msg = stopped
        ? `Done: stopped at page ${pages} of ${DATA_PAGES}, after ${plural(s.reads, 'disk read')} and ${s.rows} rows checked. Without LIMIT 1 it would have read all ${DATA_PAGES} pages.`
        : `Done: ${found} after ${plural(s.reads, 'disk read')} and ${s.rows} rows checked. Disk time ${fmtMs(s.diskMs)} vs RAM time ${fmtMs(s.ramMs)} — the disk is the bottleneck.`;
      this.board.scan.done = true;
      // With LIMIT 1 a match returns from inside the loop; line 4 is then "return no rows".
      this.snap(ctx, 'done', { line: stopped ? 3 : 4, msg, status: n ? 'success' : 'warn', dur: 500, cpu: { act: n ? 'Done' : 'Done — no rows' } });
      return ctx.steps;
    }

    // ---------- Index lookup ----------

    runIndex(q) {
      if (q.col !== 'id') return this.runScan(q, true);
      const ctx = this.begin('index', q, { lane: 'index', label: `Index lookup · id = ${q.val}`, code: CODE.index });
      const t = this.table;
      const val = q.val;
      const ms = fmtMs(this.disk.pageMs);

      this.snap(ctx, 'plan', {
        line: 0, dur: 450, hold: 1500,
        msg: `Plan: use the index students_id_idx. It is sorted by id, so we start at its root page and follow the pointers down.`,
        cpu: { act: 'Plan: index lookup' },
      });

      // 1. Root page: pick the one leaf whose range can hold the value.
      const rfr = this.load(ctx, 'r', 2, { slow: true, read: `Read the index's root page from disk into RAM (≈${ms}).` });
      const root = t.root;
      let c = 0;
      while (c < root.keys.length && val >= root.keys[c]) c++;
      const ritems = [];
      for (let i = 0; i <= c; i++) ritems.push({ i, res: i === c ? 'go' : 'no' });
      const why = [];
      if (c > 0) why.push(`${val} ≥ ${root.keys[c - 1]}`);
      if (c < root.keys.length) why.push(`${val} < ${root.keys[c]}`);
      ctx.stats.keys += Math.min(c + 1, root.keys.length);
      ctx.stats.ramMs += Math.min(c + 1, root.keys.length) * RAM_MS;
      const leaf = t.leaves[c];
      ctx.ptr = { frame: rfr, item: c, pid: leaf.id };
      ctx.scanned.r = ritems;
      this.snap(ctx, 'probe', {
        focus: rfr, line: 3, dur: 260 * ritems.length + 300, hold: 1800,
        seq: { frame: rfr, pid: 'r', items: ritems },
        msg: `In RAM, compare ${val} with the root's keys: ${why.join(' and ')}, so id ${val} can only be in leaf ${c + 1}. The other ${LEAF_PAGES - 1} leaves are never read.`,
        cpu: { act: `${val} → leaf ${c + 1}`, verdict: 'go' },
      });

      // 2. Leaf page: binary search, possible because the entries are sorted.
      const lfr = this.load(ctx, leaf.id, 4, { slow: true, read: `Follow the pointer: read leaf ${c + 1} from disk into RAM (≈${ms}).` });
      const e = leaf.entries;
      let lo = 0, hi = e.length - 1, at = -1;
      const items = [];
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (e[mid].key === val) { at = mid; items.push({ i: mid, res: 'yes', lo: mid, hi: mid }); break; }
        if (e[mid].key < val) lo = mid + 1;
        else hi = mid - 1;
        items.push({ i: mid, res: e[mid].key < val ? 'right' : 'left', lo, hi });
      }
      ctx.stats.keys += items.length;
      ctx.stats.ramMs += items.length * RAM_MS;
      const trail = items.map((it) => `${e[it.i].key} ${it.res === 'yes' ? '✓' : it.res === 'right' ? '(too small)' : '(too big)'}`).join(', ');
      const hit = at >= 0 ? e[at] : null;
      ctx.scanned[leaf.id] = items;
      ctx.ptr = hit ? { frame: lfr, item: at, pid: 'd' + hit.page } : null;
      this.snap(ctx, 'probe', {
        focus: lfr, line: 5, dur: 420 * items.length + 300, hold: 2000,
        seq: { frame: lfr, pid: leaf.id, items },
        msg: hit
          ? `The leaf is sorted, so binary search halves the candidates each time: ${trail}. The entry says id ${val} lives on page p${hit.page + 1}, slot ${hit.slot + 1}.`
          : `Binary search the sorted leaf: ${trail}. Id ${val} isn't there — so no row has id ${val}, and we know it after just ${plural(ctx.stats.reads + ctx.stats.hits, 'page')}.`,
        status: hit ? 'info' : 'warn',
        cpu: { act: hit ? `${val} → p${hit.page + 1}, slot ${hit.slot + 1}` : `${val} not in the index`, verdict: hit ? 'yes' : 'no' },
      });

      // 3. Exactly one data page.
      if (hit) {
        const pg = t.data[hit.page];
        const dfr = this.load(ctx, pg.id, 7, { slow: true, read: `Follow the pointer to the table: read only page p${hit.page + 1} from disk (≈${ms}). The other ${DATA_PAGES - 1} data pages stay untouched.` });
        const row = pg.rows[hit.slot];
        ctx.stats.rows += 1;
        ctx.stats.ramMs += RAM_MS;
        ctx.result.push(row);
        ctx.scanned[pg.id] = [{ i: hit.slot, res: 'yes' }];
        ctx.ptr = null;
        this.snap(ctx, 'fetch', {
          focus: dfr, line: 8, dur: 700, hold: 1500,
          seq: { frame: dfr, pid: pg.id, items: [{ i: hit.slot, res: 'yes' }] },
          msg: `Go straight to slot ${hit.slot + 1}: row ${row.id} · ${row.name}. No other rows need to be checked.`,
          status: 'success',
          cpu: { act: `Found ${row.id}`, verdict: 'yes' },
        });
      } else {
        ctx.ptr = null;
      }

      const s = ctx.stats;
      const pages = s.reads + s.hits;
      const sc = this.board.scan;
      let msg;
      if (s.reads === 0) {
        msg = `Done: all ${pages} pages were already in RAM, so this lookup needed no disk reads at all. That's why repeated queries are often much faster.`;
      } else if (sc && sc.done && sc.where === ctx.run.where && sc.stats.diskMs > s.diskMs) {
        msg = `Done: ${plural(s.reads, 'disk read')} instead of ${sc.stats.reads} — ${timesFaster(sc.stats.diskMs + sc.stats.ramMs, s.diskMs + s.ramMs)}× faster than the full table scan.`;
      } else {
        msg = `Done: the index answered with only ${plural(s.reads, 'disk read')}, where a full scan needs ${DATA_PAGES}. Run a full scan on the same id to compare.`;
      }
      this.board.index.done = true;
      this.snap(ctx, 'done', { line: hit ? 8 : 9, msg, status: hit ? 'success' : 'warn', dur: 500, cpu: { act: hit ? 'Done' : 'Done — no rows' } });
      return ctx.steps;
    }

    // ---------- RAM flush and guided tour ----------

    flush(reason) {
      const ctx = this.begin('flush', null, { label: 'Empty RAM' });
      const had = this.frames.some(Boolean);
      this.flushPool();
      this.snap(ctx, 'flush', {
        dur: had ? 700 : 300,
        msg: reason || 'RAM emptied (a "cold" cache): the next query has to read every page it needs from disk.',
        cpu: { act: 'Waiting for a query' },
      });
      return ctx.steps;
    }

    tour(val) {
      const ctx = this.begin('tour', null, { label: 'Tour' });
      const d = this.disk;
      const row = this.findRow('id', val) || this.table.rows[0];
      const hit = this.table.leaves.flatMap((l) => l.entries).find((en) => en.key === row.id);
      const say = (spot, msg) => this.snap(ctx, 'tour', { spot, msg, dur: 600, hold: 7000, cpu: { act: 'Waiting for a query' } });
      say('disk', `This is the disk. The students table lives here permanently, in a file called students.dat. A ${d.name} stores a lot for little money — but it is slow.`);
      say('data', `The file is cut into fixed-size pages (blocks). Here each page holds ${ROWS_PER_PAGE} rows; real databases use ~8 KB pages with about a hundred rows. The disk always reads a whole page, never a single row.`);
      say('data', `Rows are stored in the order they were inserted, so the ids are not sorted. Id ${row.id} could be on any page — it happens to be on p${row.page + 1}.`);
      say('ram', `This is RAM, the database's buffer pool. The CPU can only check rows that are in RAM. RAM is fast (≈100 ns) but small: only ${this.opts.frames} pages fit here, and it forgets everything when the power goes off.`);
      say('bus', `Copying one page from disk into RAM takes ≈${fmtMs(d.pageMs)} on a ${d.name} — about ${fmtInt(d.pageMs / RAM_MS)}× slower than reading RAM. So: the fewer pages a query reads from disk, the faster it is.`);
      say('cpu', `The query engine runs our SQL. Without help, the only way to find id ${row.id} is to bring every page into RAM and check every row: a full table scan.`);
      say('index', `An index is a second, much smaller file, sorted by id. Each leaf entry says where a row lives (${row.id} → p${hit.page + 1}). The root page tells us which leaf to open, so a lookup touches just a few pages.`);
      say('board', 'The scoreboard counts disk reads, checks in RAM and time. Press Compare to run both plans on the same id and watch the difference.');
      return ctx.steps;
    }
  }

  // ---------- "Bigger tables" estimate ----------

  const SCALE = { rowsPerPage: 100, fanout: 400, pageKB: 8 };

  // Full scans read neighbouring pages in one sweep; index lookups jump around (one seek per page).
  function estimate(rows, diskKey) {
    const d = DISKS[diskKey];
    const scanPages = Math.ceil(rows / SCALE.rowsPerPage);
    let levels = 1;
    for (let n = Math.ceil(rows / SCALE.fanout); n > 1; n = Math.ceil(n / SCALE.fanout)) levels++;
    const idxPages = levels + 1; // index levels + the one data page
    const transferMs = (SCALE.pageKB * 1024) / (d.seqMBs * 1e6) * 1000;
    return {
      scanPages,
      idxPages,
      levels,
      scanMs: d.seekMs + scanPages * transferMs,
      idxMs: idxPages * (d.seekMs + transferMs),
    };
  }

  global.IdxModel = {
    Engine, makeTable, estimate, fmtMs, fmtInt, plural, pageName, timesFaster,
    DISKS, SCALE, ROWS_PER_PAGE, DATA_PAGES, LEAF_PAGES, ROWS, PER_LEAF, MAX_ID, RAM_MS,
  };
})(window);
