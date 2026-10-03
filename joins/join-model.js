/*
 * Model for the joins demo: two small tables (students and departments) joined
 * on students.dept = departments.id, and recorders that turn each join
 * algorithm — nested loop, hash join, merge join — into animation steps.
 * Every step is a full snapshot, so playback can jump back and forth freely.
 */
(function (global) {
  'use strict';

  // n students, m departments. One student always has a dept with no department row.
  const SIZES = {
    s: { n: 6, m: 4, name: 'Small' },
    m: { n: 8, m: 5, name: 'Medium' },
    l: { n: 12, m: 6, name: 'Large' },
  };
  const MAX_KEY = 9;
  const DEPTS = ['', 'Computing', 'Electrical', 'Mechanical', 'Civil', 'Chemical', 'Physics', 'Maths', 'Biology', 'Business'];
  const LANES = ['nl', 'hash', 'merge'];
  const ALGOS = {
    nl: { name: 'Nested loop join', short: 'Nested loop' },
    hash: { name: 'Hash join', short: 'Hash join' },
    merge: { name: 'Merge join', short: 'Merge join' },
  };
  const OP_NS = 10; // "bigger tables" estimate: one comparison or hash ≈ 10 ns, all in RAM

  const NAMES = [
    'Nimal', 'Kasun', 'Amaya', 'Saman', 'Dilini', 'Ruwan', 'Chamari', 'Ishara', 'Kavindu', 'Sachini',
    'Hasini', 'Lahiru', 'Pasindu', 'Dinithi', 'Malith', 'Sanduni', 'Yasiru', 'Oshadi', 'Nuwan', 'Thilini',
    'Kamal', 'Anjali', 'Priya', 'Ravi', 'Arjun', 'Fatima', 'Rizwan', 'Aisha', 'Omar', 'Mei',
    'Liam', 'Emma', 'Noah', 'Sofia', 'Lucas', 'Zara', 'Ethan', 'Nadia', 'Tariq', 'Asha',
  ];

  // Pseudocode; "▹" starts a comment. {B} is the number of hash buckets.
  const CODE = {
    nl: [
      'for each student s in students: ▹ outer loop',
      '  for each department d in departments: ▹ inner loop',
      '    if s.dept = d.id: output (s, d)',
      'return the result',
    ],
    hash: [
      'for each department d: ▹ build phase',
      '  add d to bucket h(d.id) ▹ h(k) = k mod {B}',
      'for each student s: ▹ probe phase',
      '  for each d in bucket h(s.dept): ▹ only this bucket',
      '    if s.dept = d.id: output (s, d)',
      'return the result',
    ],
    merge: [
      'sort students by dept',
      'sort departments by id',
      's ← first student, d ← first department',
      'while neither list is finished:',
      '  if s.dept < d.id: s ← next student ▹ s has no match',
      '  else if s.dept > d.id: d ← next department',
      '  else: output (s, d); s ← next student ▹ d stays for the next student',
      'return the result',
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
    if (ms >= 86400000) return num(ms / 86400000, 'days');
    if (ms >= 3600000) return num(ms / 3600000, 'h');
    if (ms >= 60000) return num(ms / 60000, 'min');
    if (ms >= 1000) return num(ms / 1000, 's');
    if (ms >= 1) return num(ms, 'ms');
    if (ms >= 0.001) return num(ms * 1000, 'µs');
    return num(ms * 1e6, 'ns');
  }

  // 1234 → "1,234", 3.2e9 → "3.2 billion"
  function fmtInt(n) {
    n = Math.round(n);
    if (n >= 1e12) return `${+(n / 1e12).toPrecision(3)} trillion`;
    if (n >= 1e9) return `${+(n / 1e9).toPrecision(3)} billion`;
    if (n >= 1e7) return `${+(n / 1e6).toPrecision(3)} million`;
    return n.toLocaleString('en-US');
  }

  const plural = (n, word, many) => `${n} ${n === 1 ? word : many || word + 's'}`;
  const timesFaster = (slow, fast) => {
    const r = slow / fast;
    return r >= 10 ? fmtInt(r) : r.toFixed(1).replace(/\.0$/, '');
  };
  const range = (n) => Array.from({ length: n }, (_, i) => i);
  const listAnd = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

  // Stable merge sort that counts its key comparisons.
  function sortCount(list, key) {
    let cmp = 0;
    const ms = (a) => {
      if (a.length < 2) return a;
      const mid = a.length >> 1;
      const l = ms(a.slice(0, mid));
      const r = ms(a.slice(mid));
      const out = [];
      let i = 0, j = 0;
      while (i < l.length && j < r.length) {
        cmp++;
        out.push(key(r[j]) < key(l[i]) ? r[j++] : l[i++]);
      }
      return out.concat(l.slice(i), r.slice(j));
    };
    return { order: ms(list.slice()), cmp };
  }

  // ---------- The two tables ----------

  function makeTables(seed, sizeKey) {
    const size = SIZES[sizeKey];
    const rnd = mulberry32(seed);
    const keys = shuffle(range(MAX_KEY).map((k) => k + 1), rnd);
    const ids = keys.slice(0, size.m); // departments that exist, in storage order
    const missing = keys.slice(size.m); // dept numbers with no department row
    const depts = ids.map((id, i) => ({ i, key: id, name: DEPTS[id] }));
    const names = shuffle(NAMES.slice(), rnd).slice(0, size.n);
    const orphan = 1 + Math.floor(rnd() * (size.n - 1));
    const students = names.map((name, i) => ({
      i,
      name,
      key: i === orphan ? missing[Math.floor(rnd() * missing.length)] : ids[Math.floor(rnd() * ids.length)],
    }));
    return { seed, size: sizeKey, n: size.n, m: size.m, students, depts };
  }

  // ---------- Engine: step recorders ----------

  const zeroStats = () => ({ cmp: 0, hash: 0, sort: 0, out: 0 });
  const cellKey = (si, di) => `${si},${di}`;

  class Engine {
    constructor(opts) {
      this.opts = Object.assign({ seed: 2026, size: 'm', buckets: 4 }, opts);
      this.t = makeTables(this.opts.seed, this.opts.size);
      this.runs = 0;
      this.clearBoard();
    }

    clearBoard() { this.board = { nl: null, hash: null, merge: null }; }

    newData(seed) {
      this.opts.seed = seed;
      this.t = makeTables(seed, this.opts.size);
      this.clearBoard();
    }

    setSize(size) {
      this.opts.size = size;
      this.t = makeTables(this.opts.seed, size);
      this.clearBoard();
    }

    setBuckets(b) {
      this.opts.buckets = b;
      this.board.hash = null;
    }

    // The student whose dept has no department row.
    orphan() {
      const ids = new Set(this.t.depts.map((d) => d.key));
      return this.t.students.find((s) => !ids.has(s.key));
    }

    // The step shown when nothing is running.
    idle(msg, status = 'info') {
      const ctx = this.begin('idle');
      return this.snap(ctx, 'idle', { msg, status });
    }

    begin(type, extra) {
      const t = this.t;
      const run = Object.assign({ id: ++this.runs, type, label: '', code: null, lane: null, B: this.opts.buckets }, extra);
      if (run.code) run.code = run.code.map((l) => l.replace('{B}', run.B));
      const ctx = {
        run, steps: [], stats: zeroStats(),
        sOrder: range(t.n), dOrder: range(t.m),
        cells: {}, result: [], marks: {}, buckets: null, ptr: null,
      };
      if (run.lane) this.board[run.lane] = { run: run.id, stats: zeroStats(), done: false, B: run.B };
      return ctx;
    }

    // Records a step. ctx.cells holds the comparisons made *before* this step:
    // the view adds the step's own comparisons (f.seq) as they are revealed.
    snap(ctx, kind, f) {
      if (ctx.run.lane) this.board[ctx.run.lane].stats = Object.assign({}, ctx.stats);
      const board = {};
      LANES.forEach((k) => {
        const l = this.board[k];
        board[k] = l ? Object.assign({}, l, { stats: Object.assign({}, l.stats) }) : null;
      });
      const step = Object.assign({
        run: ctx.run, kind, msg: '', status: 'info', line: -1,
        sOrder: ctx.sOrder.slice(), dOrder: ctx.dOrder.slice(),
        sCur: -1, dCur: -1, seq: null, hashing: null, probe: -1, ptr: ctx.ptr, sorting: null, spot: null,
        cells: Object.assign({}, ctx.cells), result: ctx.result.slice(), marks: Object.assign({}, ctx.marks),
        buckets: ctx.buckets ? ctx.buckets.map((b) => b.slice()) : null,
        stats: Object.assign({}, ctx.stats), board, active: ctx.run.lane,
        panel: null, dur: 500, hold: null,
      }, f);
      ctx.steps.push(step);
      return step;
    }

    addCells(ctx, items) {
      items.forEach((it) => { ctx.cells[cellKey(it.si, it.di)] = it.res; });
    }

    output(ctx, si, di) {
      ctx.result.push({ si, di });
      ctx.stats.out = ctx.result.length;
    }

    finish(ctx, lane, f) {
      this.board[lane].done = true;
      return this.snap(ctx, 'done', Object.assign({ dur: 500, status: 'success' }, f));
    }

    // ---------- Nested loop join ----------

    runNested() {
      const t = this.t;
      const { n, m } = t;
      const ctx = this.begin('nl', { lane: 'nl', label: 'Nested loop join', code: CODE.nl });

      this.snap(ctx, 'plan', {
        line: 0, dur: 450, hold: 2400,
        msg: `Plan: nested loop join. For every student (outer loop), go through every department (inner loop) and compare s.dept with d.id. That is ${n} × ${m} = ${n * m} comparisons, whatever the data.`,
        panel: { text: `${n} × ${m} = ${n * m}`, sub: 'pairs to compare — all of them' },
      });

      t.students.forEach((st, k) => {
        const items = t.depts.map((d) => ({ si: st.i, di: d.i, res: st.key === d.key ? 'yes' : 'no' }));
        const hit = items.find((it) => it.res === 'yes');
        const d = hit ? t.depts[hit.di] : null;
        ctx.stats.cmp += m;
        if (hit) this.output(ctx, st.i, d.i);
        ctx.marks[st.i] = hit ? 'yes' : 'no';

        let msg;
        if (k === 0) msg = `Outer loop, student 1 of ${n}: ${st.name} (dept ${st.key}). The inner loop compares ${st.key} with the id of every department in turn: ${t.depts.map((x) => x.key).join(', ')}.`;
        else if (k === 1) msg = `Student 2: ${st.name} (dept ${st.key}). The inner loop starts again at the first department — all ${m} are compared again.`;
        else msg = `${st.name} (dept ${st.key}): ${m} more comparisons.`;
        if (d) msg += ` Match with ${d.key} ${d.name} → output the joined row.${k < 2 ? ' The inner loop still checks the remaining departments: it doesn’t know ids are unique.' : ''}`;
        else msg += ` No department has id ${st.key}, so ${st.name} produces no row.`;

        this.snap(ctx, 'loop', {
          line: hit ? 2 : 1, sCur: st.i,
          seq: { items, t0: 0.05, t1: 0.8 },
          dur: (k < 2 ? 380 : 230) * m + 400, hold: k < 2 ? 2200 : hit ? 700 : 500,
          msg, status: hit ? 'success' : 'info',
          panel: d
            ? { text: `${st.key} = ${d.key}`, sub: `${st.name} → ${d.name} · ${m} comparisons`, verdict: 'yes' }
            : { text: `no id ${st.key}`, sub: `${st.name}: ${m} comparisons, no match`, verdict: 'no' },
        });
        this.addCells(ctx, items);
      });

      const s = ctx.stats;
      this.finish(ctx, 'nl', {
        line: 3,
        msg: `Done: ${plural(s.out, 'row')} from ${n} × ${m} = ${s.cmp} comparisons. A nested loop compares every pair, so its work grows like n × m: make both tables 10× bigger and it does 100× the work.`,
        panel: { text: `${s.out} rows`, sub: `${s.cmp} comparisons for ${n * m} pairs` },
      });
      return ctx.steps;
    }

    // ---------- Hash join ----------

    runHash() {
      const t = this.t;
      const { n, m } = t;
      const B = this.opts.buckets;
      const ctx = this.begin('hash', { lane: 'hash', label: `Hash join · ${B} buckets`, code: CODE.hash });
      ctx.buckets = range(B).map(() => []);

      this.snap(ctx, 'plan', {
        line: 0, dur: 450, hold: 2600,
        msg: `Plan: hash join. Build phase: put the smaller table (departments, ${m} rows) into a hash table in RAM, using h(id) = id mod ${B}. Probe phase: each student then looks only in the one bucket where its department can be.`,
        panel: { text: `h(k) = k mod ${B}`, sub: `${B} buckets, empty so far` },
      });

      t.depts.forEach((d, k) => {
        const b = d.key % B;
        const others = ctx.buckets[b].map((x) => t.depts[x].key);
        ctx.buckets[b].push(d.i);
        ctx.stats.hash++;
        let msg = k === 0
          ? `Build: department ${d.key} ${d.name}. h(${d.key}) = ${d.key} mod ${B} = ${b}, so it goes into bucket ${b}.`
          : `${d.key} ${d.name}: h(${d.key}) = ${d.key} mod ${B} = ${b} → bucket ${b}.`;
        if (others.length) msg += ` Bucket ${b} already holds ${listAnd(others)}: a collision, so the bucket keeps a list.`;
        this.snap(ctx, 'build', {
          line: 1, dCur: d.i, hashing: { side: 'd', idx: d.i, key: d.key, b },
          dur: k < 2 ? 1300 : 900, hold: k < 2 || others.length ? 1700 : 500,
          msg,
          panel: { text: `h(${d.key}) = ${d.key} mod ${B} = ${b}`, sub: `${d.name} → bucket ${b}` },
        });
      });

      this.snap(ctx, 'phase', {
        line: 2, dur: 450, hold: 2300,
        msg: `Build done: all ${m} departments are in the hash table, after reading the departments table once. Probe phase: read the students once, one by one.`,
        panel: { text: 'probe phase', sub: 'hash each student’s dept, search one bucket' },
      });

      let explainedCollision = false;
      t.students.forEach((st, k) => {
        const b = st.key % B;
        const items = ctx.buckets[b].map((di) => ({ si: st.i, di, res: t.depts[di].key === st.key ? 'yes' : 'no' }));
        const hit = items.find((it) => it.res === 'yes');
        const d = hit ? t.depts[hit.di] : null;
        const misses = items.filter((it) => it.res === 'no').map((it) => t.depts[it.di].key);
        ctx.stats.hash++;
        ctx.stats.cmp += items.length;
        if (hit) this.output(ctx, st.i, d.i);
        ctx.marks[st.i] = hit ? 'yes' : 'no';

        let msg = k === 0
          ? `Probe: ${st.name} has dept ${st.key}. h(${st.key}) = ${st.key} mod ${B} = ${b}, so only bucket ${b} needs searching`
          : `${st.name}: h(${st.key}) = ${b} → bucket ${b}`;
        if (!items.length) {
          msg += ` — it is empty: no match, without a single comparison.`;
        } else {
          msg += k === 0 ? `: ${plural(items.length, 'comparison')} instead of ${m}.` : ` (${plural(items.length, 'comparison')}).`;
          if (d) msg += ` Match with ${d.key} ${d.name} → output.`;
          else msg += ` No department ${st.key} there → no row.`;
          if (misses.length && !explainedCollision) {
            explainedCollision = true;
            msg += ` ${listAnd(misses)} ${misses.length === 1 ? 'shares' : 'share'} the bucket but ${misses.length === 1 ? 'is' : 'are'} not ${st.key}: same hash, different key — so the keys are still compared.`;
          }
        }
        this.snap(ctx, 'probe', {
          line: hit ? 4 : 3, sCur: st.i, probe: b, hashing: { side: 's', idx: st.i, key: st.key, b },
          seq: items.length ? { items, t0: 0.32, t1: 0.82 } : null,
          dur: (k < 2 ? 1200 : 800) + items.length * (k < 2 ? 380 : 220), hold: k < 2 ? 2400 : hit ? 650 : 500,
          msg, status: hit ? 'success' : items.length ? 'info' : 'warn',
          panel: d
            ? { text: `${st.key} = ${d.key}`, sub: `${st.name} → ${d.name}`, verdict: 'yes' }
            : { text: `h(${st.key}) = ${b}`, sub: items.length ? `no department ${st.key} in bucket ${b}` : `bucket ${b} is empty`, verdict: 'no' },
        });
        this.addCells(ctx, items);
      });

      const s = ctx.stats;
      this.finish(ctx, 'hash', {
        line: 5,
        msg: `Done: ${plural(s.out, 'row')} with only ${plural(s.cmp, 'key comparison')} (+ ${s.hash} hash computations) — a nested loop needs ${n * m}. Each row is hashed once, so the work grows like n + m. The catch: equality (=) joins only, and the hash table must fit in RAM.`,
        panel: { text: `${s.out} rows`, sub: `${s.cmp} comparisons + ${s.hash} hashes` },
      });
      return ctx.steps;
    }

    // ---------- Merge join ----------

    runMerge() {
      const t = this.t;
      const { n, m } = t;
      const ctx = this.begin('merge', { lane: 'merge', label: 'Merge join', code: CODE.merge });

      this.snap(ctx, 'plan', {
        line: 0, dur: 450, hold: 2400,
        msg: 'Plan: merge join. First sort both tables on the join key. Then walk down the two sorted lists together, like merging two sorted piles of cards — each pointer only ever moves forward.',
        panel: { text: 'sort, then merge', sub: 'two pointers, never going back' },
      });

      const ss = sortCount(t.students, (x) => x.key);
      ctx.sOrder = ss.order.map((x) => x.i);
      ctx.stats.sort += ss.cmp;
      this.snap(ctx, 'sort', {
        line: 0, sorting: 's', dur: 1700, hold: 2000,
        msg: `Sort students by dept: ${ss.cmp} comparisons (merge sort). Students of the same department are now next to each other.`,
        panel: { text: 'students by dept', sub: `sorted with ${ss.cmp} comparisons` },
      });

      const ds = sortCount(t.depts, (x) => x.key);
      ctx.dOrder = ds.order.map((x) => x.i);
      ctx.stats.sort += ds.cmp;
      this.snap(ctx, 'sort', {
        line: 1, sorting: 'd', dur: 1500, hold: 1800,
        msg: `Sort departments by id: ${ds.cmp} more comparisons. Sorting is the expensive part of a merge join — unless the rows already come sorted, e.g. read through an index.`,
        panel: { text: 'departments by id', sub: `sorted with ${ds.cmp} comparisons` },
      });

      let i = 0, j = 0, k = 0;
      const told = {};
      while (i < n && j < m) {
        const st = t.students[ctx.sOrder[i]];
        const d = t.depts[ctx.dOrder[j]];
        ctx.ptr = { i, j };
        ctx.stats.cmp++;
        let res, line, msg, panel;
        const first = (kind) => { const f = !told[kind]; told[kind] = true; return f; };
        if (st.key < d.key) {
          res = 'lt';
          line = 4;
          ctx.marks[st.i] = 'no';
          msg = first('lt')
            ? `${st.name}: dept ${st.key} < ${d.key}. The departments are sorted, so no department ${st.key} can come later: ${st.name} has no match. Move s to the next student.`
            : `${st.key} < ${d.key} → ${st.name} has no match; s moves on.`;
          panel = { text: `${st.key} < ${d.key}`, sub: `${st.name} has no match → next student`, verdict: 'down' };
          i++;
        } else if (st.key > d.key) {
          res = 'gt';
          line = 5;
          msg = first('gt')
            ? `${st.key} > ${d.key}: department ${d.key} (${d.name}) is behind. Every remaining student has dept ≥ ${st.key}, so nobody can match it any more: move d to the next department.`
            : `${st.key} > ${d.key} → ${d.name} can’t match anyone left; d moves on.`;
          panel = { text: `${st.key} > ${d.key}`, sub: `${d.name} is behind → next department`, verdict: 'right' };
          j++;
        } else {
          res = 'yes';
          line = 6;
          this.output(ctx, st.i, d.i);
          ctx.marks[st.i] = 'yes';
          msg = first('eq')
            ? `${st.key} = ${d.key}: match → output ${st.name} + ${d.name}. Move s to the next student; d stays, because the next student may be in ${d.name} too.`
            : `${st.key} = ${d.key} → match: ${st.name} + ${d.name}.`;
          panel = { text: `${st.key} = ${d.key}`, sub: `match: ${st.name} → ${d.name}`, verdict: 'yes' };
          i++;
        }
        const slow = k < 4;
        this.snap(ctx, 'merge', {
          line, seq: { items: [{ si: st.i, di: d.i, res }], t0: 0.3, t1: 0.3 },
          dur: slow ? 1100 : 800, hold: slow ? 2000 : res === 'yes' ? 500 : 350,
          msg, status: res === 'yes' ? 'success' : 'info', panel,
        });
        this.addCells(ctx, [{ si: st.i, di: d.i, res }]);
        k++;
      }

      ctx.ptr = { i, j };
      const s = ctx.stats;
      const left = n - i;
      const stop = i >= n
        ? 's has passed the last student, so the merge stops.'
        : `d has passed the last department, so the merge stops: the remaining ${plural(left, 'student')} can’t match and ${left === 1 ? 'is' : 'are'} never compared.`;
      this.finish(ctx, 'merge', {
        line: 7,
        msg: `Done: ${stop} The merge took only ${plural(s.cmp, 'comparison')} (at most n + m = ${n + m}), but sorting cost ${s.sort}. Bonus: the result comes out sorted by dept.`,
        panel: { text: `${s.out} rows`, sub: `${s.sort} to sort + ${s.cmp} to merge` },
      });
      return ctx.steps;
    }

    // ---------- Guided tour ----------

    tour() {
      const t = this.t;
      const ctx = this.begin('tour', { label: 'Tour' });
      const o = this.orphan();
      const say = (spot, msg) => this.snap(ctx, 'tour', { spot, msg, dur: 600, hold: 7000 });
      say('s', 'This is the students table, the left input of the join. Each student row stores the number of their department in the dept column.');
      say('d', 'This is the departments table, the right input. id is its primary key: no two departments share an id.');
      say('sql', 'The query: SELECT * FROM students s JOIN departments d ON s.dept = d.id — pair every student with the department whose id equals their dept.');
      say('result', `The result gets one row per matching pair. No department has id ${o.key}, so ${o.name} will be left out: an inner join keeps only the pairs that match.`);
      say('matrix', `Each cell is one possible pair: ${t.n} × ${t.m} = ${t.n * t.m} pairs. Whenever an algorithm compares s.dept with d.id, that cell lights up — green for a match. Fewer lit cells = less work.`);
      say('work', 'The join engine shows each algorithm’s trick: a nested loop tries every pair, a hash join first sorts the departments into buckets, and a merge join sorts both tables and walks them together.');
      say('board', 'The scoreboard counts the work: key comparisons, plus hashing or sorting. Press Compare all to run the three algorithms on the same tables.');
      return ctx.steps;
    }
  }

  // ---------- "Bigger tables" estimate ----------

  // Operation counts for n students and m departments.
  function estimate(n, m) {
    const lg = (x) => Math.max(1, Math.log2(x));
    return {
      nl: n * m,
      hash: m + 2 * n, // hash each department, then hash + compare each student (~1 entry per bucket)
      merge: n * lg(n) + m * lg(m) + n + m,
      sorted: n + m, // inputs already sorted: only the merge pass
    };
  }

  global.JoinModel = {
    Engine, makeTables, sortCount, estimate, fmtMs, fmtInt, plural, timesFaster, cellKey,
    SIZES, DEPTS, LANES, ALGOS, CODE, MAX_KEY, OP_NS,
  };
})(window);
