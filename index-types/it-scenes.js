/*
 * Scenes for the index-types demo. Each scene builds a list of drawable objects
 * (boxes with rows, rectangles, dots, arrows, labels) and snapshots them into
 * steps. Objects keep stable ids, so the view can animate between steps.
 */
(function (global) {
  'use strict';

  // ---------- Helpers ----------

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = (r, list) => list[Math.floor(r() * list.length)];
  const shuffle = (r, list) => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  const NAMES = ['Nimal', 'Kasun', 'Amaya', 'Saman', 'Dilini', 'Ruwan', 'Chamari', 'Ishara', 'Kavi', 'Sachini', 'Hasini', 'Lahiru',
    'Pasindu', 'Dinithi', 'Malith', 'Sanduni', 'Yasiru', 'Oshadi', 'Nuwan', 'Thilini', 'Priya', 'Ravi', 'Arjun', 'Fatima', 'Omar', 'Mei', 'Emma', 'Noah'];

  class Scene {
    constructor() {
      this.objs = new Map();
      this.steps = [];
    }

    // Boxes: { x, y, w, title, tint, rows: [{ text, hl }], rowH, role, sub }
    box(id, o) { const b = Object.assign({ t: 'box', id, rowH: 24, rows: [], tint: 'table', role: null }, o); this.objs.set(id, b); return b; }
    rect(id, o) { const r = Object.assign({ t: 'rect', id, role: null }, o); this.objs.set(id, r); return r; }
    dot(id, o) { const d = Object.assign({ t: 'dot', id, hl: null }, o); this.objs.set(id, d); return d; }
    label(id, o) { const l = Object.assign({ t: 'label', id, size: 15, color: 'muted', align: 'left' }, o); this.objs.set(id, l); return l; }
    // Arrow endpoints: { box, row, side } or { x, y }
    arrow(id, from, to, o) { const a = Object.assign({ t: 'arrow', id, from, to, color: 'accent' }, o); this.objs.set(id, a); return a; }
    get(id) { return this.objs.get(id); }
    remove(id) { this.objs.delete(id); }
    removeWhere(fn) { [...this.objs.keys()].forEach((k) => { if (fn(this.objs.get(k))) this.objs.delete(k); }); }

    clearHl() {
      this.objs.forEach((o) => {
        if (o.t === 'box') { o.role = null; o.rows.forEach((r) => { r.hl = null; }); }
        if (o.t === 'rect') o.role = null;
        if (o.t === 'dot') o.hl = null;
      });
    }

    snap(msg, o = {}) {
      this.steps.push({ msg, status: o.status || 'info', stats: o.stats || [], objs: JSON.parse(JSON.stringify([...this.objs.values()])) });
    }
  }

  const stat = (label, value) => `${label}: <b>${value}</b>`;

  // ---------- 1. Clustered vs non-clustered ----------

  function clustered(seed) {
    const r = rng(seed);
    const sc = new Scene();
    const rows = Array.from({ length: 24 }, (_, i) => ({ id: i + 1, name: pick(r, NAMES), age: 18 + Math.floor(r() * 8) }));
    const PW = 176, GAP = 20, DY = 170;
    const pageOf = (id) => Math.floor((id - 1) / 4);
    rows.forEach((row) => { row.page = pageOf(row.id); row.slot = (row.id - 1) % 4; });
    // Table pages = leaf level of the clustered index (stored in id order).
    for (let p = 0; p < 6; p++) {
      sc.box(`d${p}`, {
        x: p * (PW + GAP), y: DY, w: PW, title: `data page ${p + 1}`, tint: 'table',
        rows: rows.slice(p * 4, p * 4 + 4).map((x) => ({ text: `${x.id}  ${x.name}  ·  ${x.age}` })),
      });
    }
    const W = 6 * (PW + GAP) - GAP;
    const root = sc.box('croot', { x: W / 2 - 230, y: 0, w: 460, title: 'clustered index on id — root', tint: 'index', rows: [{ text: 'id ≤ 4 │ ≤ 8 │ ≤ 12 │ ≤ 16 │ ≤ 20 │ > 20' }] });
    for (let p = 0; p < 6; p++) sc.arrow(`ca${p}`, { x: root.x + ((p + 0.5) / 6) * root.w, y: 50 + 4 }, { box: `d${p}`, side: 'top' }, { color: 'muted' });
    sc.label('l1', { x: 0, y: DY - 18, text: 'The table itself, stored in id order — the leaf level of the clustered index', color: 'accent' });
    sc.snap('A clustered index decides how the table is stored: the rows sit on disk sorted by the key (id). Its leaf level is the data pages themselves, so a table can have only one clustered index.', { stats: [stat('clustered indexes per table', 'max 1')] });

    // Non-clustered index on age: its own sorted leaf pages with row locators.
    const byAge = rows.slice().sort((a, b) => a.age - b.age || a.id - b.id);
    const LY = DY + 230, LW = 196, LG = (W - 4 * LW) / 3;
    for (let p = 0; p < 4; p++) {
      sc.box(`a${p}`, {
        x: p * (LW + LG), y: LY, w: LW, rowH: 21, title: `index on age — leaf ${p + 1}`, tint: 'idx2',
        rows: byAge.slice(p * 6, p * 6 + 6).map((x) => ({ text: `age ${x.age} → id ${x.id} (p${x.page + 1})` })),
      });
    }
    const aroot = sc.box('aroot', { x: W / 2 - 170, y: LY + 230, w: 340, title: 'non-clustered index on age — root', tint: 'idx2', rows: [{ text: `age ≤ ${byAge[5].age} │ ≤ ${byAge[11].age} │ ≤ ${byAge[17].age} │ more` }] });
    for (let p = 0; p < 4; p++) sc.arrow(`aa${p}`, { x: aroot.x + ((p + 0.5) / 4) * aroot.w, y: aroot.y }, { box: `a${p}`, side: 'bottom' }, { color: 'muted' });
    sc.label('l2', { x: 0, y: LY - 18, text: 'A separate structure sorted by age; each entry points to a row', color: 'violet' });
    // a few sample pointers
    [0, 7, 15].forEach((k, n) => {
      const e = byAge[k];
      sc.arrow(`samp${n}`, { box: `a${Math.floor(k / 6)}`, row: k % 6, side: 'top' }, { box: `d${e.page}`, row: e.slot, side: 'bottom' }, { color: 'violet', dash: true });
    });
    sc.snap('A non-clustered (secondary) index is a separate structure sorted by its key (age). Each entry stores a pointer to the row; the table stays in id order. A table can have many of these.', { stats: [stat('non-clustered indexes per table', 'many')] });
    sc.removeWhere((o) => o.id.startsWith('samp'));

    // Query A: range on the clustered key.
    const lo = 2 + Math.floor(r() * 12), hi = lo + 5;
    let reads = 0;
    sc.label('q', { x: W / 2, y: -40, text: `SELECT * FROM students WHERE id BETWEEN ${lo} AND ${hi}`, color: 'ink', size: 17, align: 'center', bold: true });
    sc.snap(`Query 1 — a range on the clustered key: id ${lo}–${hi} (6 rows).`, { stats: [stat('page reads', 0)] });
    sc.get('croot').role = 'read'; reads++;
    sc.snap(`Read the root: id ${lo} is in page ${pageOf(lo) + 1}.`, { stats: [stat('page reads', reads)] });
    sc.get('croot').role = null;
    for (let p = pageOf(lo); p <= pageOf(hi); p++) {
      const b = sc.get(`d${p}`);
      b.role = 'read'; reads++;
      b.rows.forEach((row, s) => { const id = p * 4 + s + 1; if (id >= lo && id <= hi) row.hl = 'hit'; });
      sc.snap(p === pageOf(lo)
        ? `Read data page ${p + 1}: the matching rows sit next to each other.`
        : `The next ids are simply on the next page — read page ${p + 1} and keep going.`, { stats: [stat('page reads', reads)] });
      b.role = null;
    }
    const readsA = reads;
    sc.snap(`Done: 6 rows with ${readsA} page reads (1 index + ${readsA - 1} data). With a clustered index, a range is a short sequential scan.`, { status: 'success', stats: [stat('page reads', readsA)] });

    // Query B: range on the non-clustered key.
    sc.clearHl();
    let alo = byAge[9].age;
    let matches = byAge.filter((x) => x.age >= alo && x.age <= alo + 1);
    if (matches.length > 9) matches = byAge.filter((x) => x.age === alo);
    const ahi = matches[matches.length - 1].age;
    reads = 0;
    sc.get('q').text = `SELECT * FROM students WHERE age BETWEEN ${alo} AND ${ahi}`;
    sc.snap(`Query 2 — a range on the non-clustered key: age ${alo}–${ahi} (${matches.length} rows).`, { stats: [stat('page reads', 0)] });
    sc.get('aroot').role = 'read'; reads++;
    sc.snap(`Read the age index's root, then its leaf pages for ages ${alo}–${ahi}.`, { stats: [stat('page reads', reads)] });
    sc.get('aroot').role = null;
    const leafPages = [...new Set(matches.map((x) => Math.floor(byAge.indexOf(x) / 6)))];
    leafPages.forEach((lp) => {
      sc.get(`a${lp}`).role = 'read'; reads++;
      matches.forEach((x) => { const k = byAge.indexOf(x); if (Math.floor(k / 6) === lp) sc.get(`a${lp}`).rows[k % 6].hl = 'key'; });
    });
    sc.snap(`The entries are next to each other in the index — but they point all over the table.`, { stats: [stat('page reads', reads)] });
    const visited = new Set();
    matches.forEach((x, n) => {
      const k = byAge.indexOf(x);
      sc.arrow(`ptr${n}`, { box: `a${Math.floor(k / 6)}`, row: k % 6, side: 'top' }, { box: `d${x.page}`, row: x.slot, side: 'bottom' }, { color: 'violet' });
      const b = sc.get(`d${x.page}`);
      b.role = 'read'; reads++;
      b.rows[x.slot].hl = 'hit';
      visited.add(x.page);
      sc.snap(`Follow the pointer for id ${x.id}: read data page ${x.page + 1}${n && visited.size < n + 1 ? '' : ''}.`, { stats: [stat('page reads', reads)] });
      b.role = null;
    });
    sc.snap(`Done: ${matches.length} rows cost ${reads} page reads, jumping across ${visited.size} different data pages — one random read per row. Query 1 needed ${readsA}.`, {
      status: 'warn', stats: [stat('page reads', reads), stat('query 1', readsA)],
    });
    sc.snap('Clustered: the data is sorted by the key, so ranges and ORDER BY are cheap — but only one per table. Non-clustered: many per table, great for finding a few rows; for large ranges the per-row lookups add up, and the optimizer may prefer a full scan.', { status: 'success' });
    return sc.steps;
  }

  // ---------- 2. Dense vs sparse ----------

  function denseSparse(seed) {
    const r = rng(seed);
    const sc = new Scene();
    let k = 1;
    const keys = Array.from({ length: 24 }, () => (k += 1 + Math.floor(r() * 4)));
    const PW = 150, GAP = 22, DY = 250;
    for (let p = 0; p < 6; p++) {
      sc.box(`d${p}`, { x: p * (PW + GAP), y: DY, w: PW, title: `data page ${p + 1}`, tint: 'table', rows: keys.slice(p * 4, p * 4 + 4).map((x) => ({ text: `key ${x}  ·  row` })) });
    }
    const W = 6 * (PW + GAP) - GAP;
    sc.label('ld', { x: 0, y: DY - 18, text: 'Data file — sorted by key', color: 'accent' });
    sc.snap('A data file sorted by its key, 4 records per page. Two ways to index it: dense and sparse.');

    // Dense: one entry per record.
    const IW = 150, IG = (W - 4 * IW) / 3;
    for (let p = 0; p < 4; p++) {
      sc.box(`x${p}`, { x: p * (IW + IG), y: 0, w: IW, rowH: 19, title: `dense index ${p + 1}`, tint: 'index', rows: keys.slice(p * 6, p * 6 + 6).map((x, i) => ({ text: `${x} → p${Math.floor((p * 6 + i) / 4) + 1}` })) });
    }
    keys.forEach((x, i) => sc.arrow(`dp${i}`, { box: `x${Math.floor(i / 6)}`, row: i % 6, side: 'bottom' }, { box: `d${Math.floor(i / 4)}`, row: i % 4, side: 'top' }, { color: 'faint' }));
    sc.label('lx', { x: 0, y: -18, text: 'Dense index — one entry for EVERY record (24 entries)', color: 'violet' });
    sc.snap('Dense index: one entry for every record, each pointing straight to its row. 24 entries in 4 index pages.', { stats: [stat('dense entries', 24), stat('dense pages', 4)] });

    // Sparse: one entry per page.
    const sp = sc.box('sp', { x: W / 2 - 110, y: DY + 200, w: 220, rowH: 22, title: 'sparse index', tint: 'idx2', rows: [0, 1, 2, 3, 4, 5].map((p) => ({ text: `${keys[p * 4]} → page ${p + 1}` })) });
    for (let p = 0; p < 6; p++) sc.arrow(`sp${p}`, { box: 'sp', row: p, side: 'top' }, { box: `d${p}`, side: 'bottom' }, { color: 'teal' });
    sc.label('ls', { x: sp.x, y: sp.y + 26 + 6 * 22 + 30, text: 'Sparse index — one entry per PAGE (its first key): 6 entries', color: 'teal' });
    sc.snap('Sparse index: one entry per data page — the first key on that page. Only 6 entries in a single index page. This works only because the file is sorted by the key.', {
      stats: [stat('dense entries', 24), stat('sparse entries', 6)],
    });

    // Search the same key in both.
    const ti = 4 * (1 + Math.floor(r() * 5)) + 1 + Math.floor(r() * 3); // not the first on its page
    const key = keys[ti], tp = Math.floor(ti / 4);
    sc.label('q', { x: W / 2, y: -52, text: `Find key ${key}`, color: 'ink', size: 17, align: 'center', bold: true });
    sc.snap(`Find key ${key} with each index.`);
    sc.get(`x${Math.floor(ti / 6)}`).role = 'read';
    sc.get(`x${Math.floor(ti / 6)}`).rows[ti % 6].hl = 'key';
    sc.get(`dp${ti}`).color = 'violet';
    sc.snap(`Dense: search the index pages for ${key} itself — an exact entry exists. (Just checking whether ${key} exists needs no data page at all.)`, { stats: [stat('dense reads', 1)] });
    sc.get(`d${tp}`).role = 'read';
    sc.get(`d${tp}`).rows[ti % 4].hl = 'hit';
    sc.snap(`Follow its pointer straight to the record on page ${tp + 1}. 2 page reads.`, { status: 'success', stats: [stat('dense reads', 2)] });
    sc.clearHl();
    sc.get(`dp${ti}`).color = 'faint';
    sc.get('sp').role = 'read';
    for (let p = 0; p <= Math.min(5, tp + 1); p++) sc.get('sp').rows[p].hl = p === tp ? 'key' : 'cmp';
    sc.snap(`Sparse: ${key} has no entry of its own. Find the largest first-key ≤ ${key}: ${keys[tp * 4]} → page ${tp + 1} (the next entry, ${keys[Math.min(23, (tp + 1) * 4)]}, is already too big).`, { stats: [stat('sparse reads', 1)] });
    sc.get('sp').rows.forEach((row, p) => { row.hl = p === tp ? 'key' : null; });
    sc.get(`sp${tp}`).color = 'accent';
    sc.get(`d${tp}`).role = 'read';
    sc.get(`d${tp}`).rows.forEach((row, s) => { row.hl = s < ti % 4 ? 'cmp' : s === ti % 4 ? 'hit' : null; });
    sc.snap(`Read page ${tp + 1} and scan it until ${key} turns up. Also 2 page reads — plus a small scan inside the page.`, { status: 'success', stats: [stat('sparse reads', 2)] });
    sc.snap('Dense: bigger, but every key is in the index, so "does it exist?" and index-only lookups are possible, and it works on unsorted data — secondary indexes must be dense. Sparse: tiny (fits in memory), but needs a file sorted on the key, i.e. a clustered/primary index.', { status: 'success' });
    return sc.steps;
  }

  // ---------- 3. Bitmap ----------

  function bitmap(seed) {
    const r = rng(seed);
    const sc = new Scene();
    const cities = ['Colombo', 'Kandy', 'Galle'];
    const rows = Array.from({ length: 12 }, (_, i) => ({ i, name: pick(r, NAMES), city: pick(r, cities), g: r() < 0.5 ? 'F' : 'M' }));
    const RH = 28;
    sc.box('t', { x: 0, y: 0, w: 260, rowH: RH, title: 'students (row · name · city · gender)', tint: 'table', rows: rows.map((x) => ({ text: `${x.i}  ${x.name}  ${x.city}  ${x.g}` })) });
    const cols = [...cities.map((c) => ({ key: c, test: (x) => x.city === c, title: `city=${c}` })), { key: 'F', test: (x) => x.g === 'F', title: 'gender=F' }, { key: 'M', test: (x) => x.g === 'M', title: 'gender=M' }];
    cols.forEach((c, j) => {
      sc.box(`b${c.key}`, { x: 300 + j * 104, y: 0, w: 92, rowH: RH, title: c.title, tint: 'index', rows: rows.map((x) => ({ text: c.test(x) ? '1' : '0', hl: null, center: true })) });
    });
    sc.snap('A bitmap index keeps one bit vector per distinct value: bit i is 1 when row i has that value. 3 cities + 2 genders = 5 bitmaps of 12 bits each.', { stats: [stat('rows', 12), stat('bitmaps', 5), stat('size', '1 bit per row per value')] });
    cols.forEach((c) => sc.get(`b${c.key}`).rows.forEach((row) => { if (row.text === '1') row.hl = 'on'; }));
    sc.snap('The 1s mark the rows having each value. Low-cardinality columns (few distinct values) give few, compact bitmaps.');

    const city = pick(r, cities);
    const res = rows.map((x) => x.city === city && x.g === 'F');
    sc.label('q', { x: 300, y: -40, text: `WHERE city = '${city}' AND gender = 'F'`, color: 'ink', size: 17, bold: true });
    sc.clearHl();
    sc.get(`b${city}`).role = 'target';
    sc.get('bF').role = 'target';
    sc.get(`b${city}`).rows.forEach((row) => { if (row.text === '1') row.hl = 'on'; });
    sc.get('bF').rows.forEach((row) => { if (row.text === '1') row.hl = 'on'; });
    sc.snap(`Query: city = '${city}' AND gender = 'F'. Take the two bitmaps — no table rows are touched yet.`);
    const rx = 300 + cols.length * 104 + 30;
    sc.box('res', { x: rx, y: 0, w: 92, rowH: RH, title: 'AND result', tint: 'idx2', rows: res.map((b) => ({ text: b ? '1' : '0', hl: b ? 'hit' : null, center: true })) });
    sc.snap(`AND them bit by bit: 1 only where both bitmaps have 1. The CPU does this for 64 rows per instruction, so it is extremely fast.`, { stats: [stat('matching rows', res.filter(Boolean).length)] });
    sc.get('t').rows.forEach((row, i) => { row.hl = res[i] ? 'hit' : null; });
    sc.snap(`The 1s in the result are the matching rows — fetch just those.`, { status: 'success', stats: [stat('matching rows', res.filter(Boolean).length)] });

    const city2 = cities.find((c) => c !== city);
    const res2 = rows.map((x) => x.city === city2 || x.g === 'M');
    sc.clearHl();
    sc.get('q').text = `WHERE city = '${city2}' OR gender = 'M'`;
    sc.get(`b${city2}`).role = 'target';
    sc.get('bM').role = 'target';
    sc.get('res').title = 'OR result';
    sc.get('res').rows = res2.map((b) => ({ text: b ? '1' : '0', hl: b ? 'hit' : null, center: true }));
    sc.get('t').rows.forEach((row, i) => { row.hl = res2[i] ? 'hit' : null; });
    sc.snap(`OR works the same way: city = '${city2}' OR gender = 'M' → 1 where either bitmap has 1.`, { status: 'success', stats: [stat('matching rows', res2.filter(Boolean).length)] });
    sc.snap('Bitmap indexes shine in data warehouses: low-cardinality columns, many AND/OR filters, few updates. They are poor for busy tables, because one update can lock or rewrite a whole bitmap. (PostgreSQL builds bitmaps on the fly in "Bitmap Heap Scan" instead of storing them.)', { status: 'success' });
    return sc.steps;
  }

  // ---------- 4. GIN ----------

  function gin(seed) {
    const r = rng(seed);
    const sc = new Scene();
    const words = ['ai', 'cloud', 'db', 'index', 'python', 'sql', 'web'];
    const posts = Array.from({ length: 9 }, (_, i) => ({ i: i + 1, tags: shuffle(r, words.slice()).slice(0, 2 + Math.floor(r() * 2)).sort() }));
    // Make sure the query pair occurs together at least twice.
    const qa = 'db', qb = pick(r, ['sql', 'index']);
    [1, 5].forEach((i) => { posts[i].tags = [...new Set([...posts[i].tags.slice(0, 1), qa, qb])].sort(); });
    const RH = 28;
    sc.box('p', { x: 0, y: 0, w: 290, rowH: RH, title: 'posts (id · tags)', tint: 'table', rows: posts.map((p) => ({ text: `${p.i}  {${p.tags.join(', ')}}` })) });
    sc.snap('Each post has an array of tags. A B-tree would index the whole array as one value — useless for "which posts have tag db?".');
    const list = words.map((w) => ({ w, ids: posts.filter((p) => p.tags.includes(w)).map((p) => p.i) }));
    sc.box('g', { x: 420, y: 0, w: 290, rowH: RH, title: 'GIN index (element → posting list)', tint: 'index', rows: list.map((e) => ({ text: `${e.w}  →  ${e.ids.join(', ')}` })) });
    sc.snap('A GIN (Generalized Inverted iNdex) indexes every element separately: each tag maps to the sorted list of posts that contain it — like the index at the back of a book.', { stats: [stat('posts', posts.length), stat('distinct tags', words.length)] });

    sc.label('q', { x: 0, y: -40, text: `WHERE tags @> '{${qa}, ${qb}}'   (contains both)`, color: 'ink', size: 17, bold: true });
    const ia = words.indexOf(qa), ib = words.indexOf(qb);
    const A = list[ia].ids, B = list[ib].ids;
    sc.get('g').rows[ia].hl = 'key';
    A.forEach((id, n) => sc.arrow(`ga${n}`, { box: 'g', row: ia, side: 'left' }, { box: 'p', row: id - 1, side: 'right' }, { color: 'accent' }));
    sc.snap(`Look up '${qa}': posts ${A.join(', ')}.`);
    sc.get('g').rows[ib].hl = 'key';
    B.forEach((id, n) => sc.arrow(`gb${n}`, { box: 'g', row: ib, side: 'left' }, { box: 'p', row: id - 1, side: 'right' }, { color: 'violet' }));
    sc.snap(`Look up '${qb}': posts ${B.join(', ')}.`);
    const both = A.filter((id) => B.includes(id));
    sc.removeWhere((o) => o.t === 'arrow');
    both.forEach((id, n) => sc.arrow(`gr${n}`, { box: 'g', row: ia, side: 'left' }, { box: 'p', row: id - 1, side: 'right' }, { color: 'good' }));
    sc.get('p').rows.forEach((row, i) => { row.hl = both.includes(i + 1) ? 'hit' : null; });
    sc.snap(`Intersect the two posting lists (both are sorted, so it is a quick merge): posts ${both.join(', ')} have both tags.`, { status: 'success', stats: [stat('posts examined', both.length)] });
    sc.snap('GIN is the index for "contains" queries: arrays (@>), full-text search (tsvector @@ tsquery), and JSONB keys. Lookups are fast; inserts are slower, because one row adds many entries (PostgreSQL buffers them in a "pending list").', { status: 'success' });
    return sc.steps;
  }

  // ---------- 5. GiST ----------

  function gist(seed) {
    const r = rng(seed);
    const sc = new Scene();
    const MW = 640, MH = 420;
    const pts = Array.from({ length: 16 }, (_, i) => ({ i, name: String.fromCharCode(97 + i), x: 30 + r() * (MW - 60), y: 30 + r() * (MH - 60) }));
    sc.rect('map', { x: 0, y: 0, w: MW, h: MH, label: 'map: cafés (points)', kind: 'frame' });
    pts.forEach((p) => sc.dot(`p${p.i}`, { x: p.x, y: p.y, label: p.name }));
    sc.snap('GiST (Generalized Search Tree) indexes things that are not simply ordered — here, points on a map. "Find cafés in this area" can\'t use a sorted list.');

    // Two-level bounding-box hierarchy (R-tree style).
    const bbox = (list, pad) => {
      const xs = list.map((p) => p.x), ys = list.map((p) => p.y);
      return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + 2 * pad, h: Math.max(...ys) - Math.min(...ys) + 2 * pad };
    };
    const byX = pts.slice().sort((a, b) => a.x - b.x);
    const halves = [byX.slice(0, 8), byX.slice(8)];
    const groups = [];
    halves.forEach((h, k) => {
      const byY = h.slice().sort((a, b) => a.y - b.y);
      groups.push({ name: `R${k + 1}`, kids: [byY.slice(0, 4), byY.slice(4)].map((g, j) => ({ name: `${'AB'[k]}${j + 1}`, pts: g })) });
    });
    groups.forEach((g, k) => {
      sc.rect(`R${k}`, Object.assign(bbox(g.kids.flatMap((c) => c.pts), 22), { label: g.name, kind: 'outer' }));
      g.kids.forEach((c, j) => sc.rect(`L${k}${j}`, Object.assign(bbox(c.pts, 11), { label: c.name, kind: 'inner' })));
    });
    // The tree on the right.
    const TX = MW + 60;
    sc.box('root', { x: TX + 90, y: 0, w: 160, title: 'root', tint: 'index', rows: [{ text: 'R1   │   R2', center: true }] });
    groups.forEach((g, k) => {
      sc.box(`n${k}`, { x: TX + k * 190, y: 110, w: 150, title: g.name, tint: 'index', rows: [{ text: g.kids.map((c) => c.name).join('   │   '), center: true }] });
      sc.arrow(`ra${k}`, { x: TX + 90 + (k ? 120 : 40), y: 54 }, { box: `n${k}`, side: 'top' }, { color: 'muted' });
      g.kids.forEach((c, j) => {
        sc.box(`m${k}${j}`, { x: TX + k * 190 + j * 80 - 4, y: 230, w: 74, rowH: 20, title: c.name, tint: 'idx2', rows: c.pts.map((p) => ({ text: p.name, center: true })) });
        sc.arrow(`na${k}${j}`, { x: TX + k * 190 + (j ? 110 : 40), y: 164 }, { box: `m${k}${j}`, side: 'top' }, { color: 'muted' });
      });
    });
    sc.snap('GiST groups nearby points into bounding boxes, and boxes into bigger boxes (an R-tree). Each tree node stores the box that covers everything below it.', { stats: [stat('points', 16), stat('boxes', 6)] });

    // Query rectangle.
    const qw = 200 + r() * 80, qh = 150 + r() * 60;
    const q = { x: 40 + r() * (MW - qw - 80), y: 40 + r() * (MH - qh - 80), w: qw, h: qh };
    const over = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const inside = (p) => p.x >= q.x && p.x <= q.x + q.w && p.y >= q.y && p.y <= q.y + q.h;
    sc.rect('Q', Object.assign({}, q, { label: 'search area', kind: 'query' }));
    sc.snap('Query: which cafés lie inside the search area?');
    let boxes = 0, checked = 0;
    sc.get('root').role = 'read';
    groups.forEach((g, k) => {
      boxes++;
      const hit = over(sc.get(`R${k}`), q);
      sc.get(`R${k}`).role = hit ? 'target' : 'skip';
      sc.get(`n${k}`).role = hit ? 'read' : 'skip';
    });
    sc.snap(`At the root, test the two big boxes against the search area: ${groups.map((g, k) => `${g.name} ${sc.get(`R${k}`).role === 'target' ? 'overlaps' : 'doesn\'t overlap — skip everything inside it'}`).join('; ')}.`, { stats: [stat('boxes tested', boxes)] });
    groups.forEach((g, k) => {
      if (sc.get(`R${k}`).role !== 'target') return;
      g.kids.forEach((c, j) => {
        boxes++;
        const hit = over(sc.get(`L${k}${j}`), q);
        sc.get(`L${k}${j}`).role = hit ? 'target' : 'skip';
        sc.get(`m${k}${j}`).role = hit ? 'read' : 'skip';
      });
    });
    sc.snap('Go down only into overlapping boxes and test their smaller boxes the same way.', { stats: [stat('boxes tested', boxes)] });
    const found = [];
    groups.forEach((g, k) => g.kids.forEach((c, j) => {
      if (sc.get(`L${k}${j}`).role !== 'target') return;
      c.pts.forEach((p, s) => {
        checked++;
        const ok = inside(p);
        sc.get(`p${p.i}`).hl = ok ? 'hit' : 'cmp';
        sc.get(`m${k}${j}`).rows[s].hl = ok ? 'hit' : 'cmp';
        if (ok) found.push(p.name);
      });
    }));
    sc.snap(`Check the points in the surviving boxes: ${found.length ? found.join(', ') : 'none'} ${found.length === 1 ? 'is' : 'are'} inside. Only ${checked} of 16 points were tested.`, {
      status: 'success', stats: [stat('boxes tested', boxes), stat('points tested', `${checked} / 16`)],
    });
    sc.snap('GiST is a framework for "overlaps / contains / nearest" searches: geometry (PostGIS), ranges (tsrange &&), nearest-neighbour ORDER BY distance, and exclusion constraints such as "no two bookings overlap".', { status: 'success' });
    return sc.steps;
  }

  // ---------- 6. BRIN ----------

  function brin(seed) {
    const r = rng(seed);
    const sc = new Scene();
    const BW = 92, G = 12;
    let day = 1;
    const blocks = Array.from({ length: 12 }, () => Array.from({ length: 4 }, () => (day += Math.floor(r() * 2) + (r() < 0.3 ? 1 : 0))));
    blocks.forEach((b, i) => sc.box(`k${i}`, { x: i * (BW + G), y: 170, w: BW, rowH: 22, title: `block ${i}`, tint: 'table', rows: b.map((d) => ({ text: `day ${d}`, center: true })) }));
    sc.label('lk', { x: 0, y: 150, text: 'A log table: rows are appended over time, so dates grow along the blocks', color: 'accent' });
    sc.snap('A log table gets rows appended in time order, so the date column naturally increases from block to block.');
    for (let s = 0; s < 6; s++) {
      const lo = blocks[2 * s][0], hi = blocks[2 * s + 1][3];
      sc.box(`s${s}`, { x: 2 * s * (BW + G), y: 0, w: 2 * BW + G, rowH: 24, title: `blocks ${2 * s}–${2 * s + 1}`, tint: 'index', rows: [{ text: `min ${lo} · max ${hi}`, center: true }] });
      sc.arrow(`sa${s}a`, { box: `s${s}`, side: 'bottom' }, { box: `k${2 * s}`, side: 'top' }, { color: 'muted' });
      sc.arrow(`sa${s}b`, { box: `s${s}`, side: 'bottom' }, { box: `k${2 * s + 1}`, side: 'top' }, { color: 'muted' });
    }
    sc.label('ls', { x: 0, y: -20, text: 'BRIN index: just min / max per range of 2 blocks', color: 'violet' });
    sc.snap('A BRIN (Block Range INdex) stores only a summary per range of blocks — here min and max date per 2 blocks. 6 tiny entries instead of one entry per row.', { stats: [stat('rows', 48), stat('BRIN entries', 6)] });
    const a = blocks[4][1], b = blocks[7][2];
    sc.label('q', { x: 6 * (BW + G), y: -52, text: `WHERE day BETWEEN ${a} AND ${b}`, color: 'ink', size: 17, bold: true, align: 'center' });
    sc.snap(`Query: day ${a}–${b}.`);
    let read = 0;
    for (let s = 0; s < 6; s++) {
      const lo = blocks[2 * s][0], hi = blocks[2 * s + 1][3];
      const hit = hi >= a && lo <= b;
      sc.get(`s${s}`).role = hit ? 'target' : 'skip';
      [2 * s, 2 * s + 1].forEach((k) => { sc.get(`k${k}`).role = hit ? 'read' : 'skip'; });
      if (hit) read += 2;
    }
    sc.snap(`Compare the range with each summary: a block range can only contain matches if its min–max overlaps ${a}–${b}. The others are skipped without reading them.`, { stats: [stat('summaries checked', 6), stat('blocks read', `${read} / 12`)] });
    for (let k = 0; k < 12; k++) {
      if (sc.get(`k${k}`).role !== 'read') continue;
      sc.get(`k${k}`).rows.forEach((row, i) => { row.hl = blocks[k][i] >= a && blocks[k][i] <= b ? 'hit' : 'cmp'; });
    }
    sc.snap(`Read only the ${read} candidate blocks and check their rows. BRIN is "lossy": it narrows down blocks, then the rows are re-checked.`, { status: 'success', stats: [stat('blocks read', `${read} / 12`)] });
    sc.snap('BRIN is tiny and cheap to maintain — ideal for huge, append-only tables (logs, sensor data, time series) where the column follows the physical order. On randomly ordered data every range overlaps everything, and it is useless.', { status: 'success' });
    return sc.steps;
  }

  const SCENES = {
    cluster: {
      name: 'Clustered vs non-clustered', build: clustered,
      points: ['Clustered: rows are stored sorted by the key; the leaf level is the data.', 'Only one clustered index per table (the data has one physical order).', 'Non-clustered: separate sorted structure with a pointer per row; many allowed.', 'Ranges: clustered = sequential pages; non-clustered = one random read per row.'],
    },
    dense: {
      name: 'Dense vs sparse', build: denseSparse,
      points: ['Dense: one index entry per record.', 'Sparse: one entry per data page (first key).', 'Sparse needs a file sorted on the key (primary / clustered).', 'Secondary indexes must be dense; sparse ones are small enough to stay in RAM.'],
    },
    bitmap: {
      name: 'Bitmap', build: bitmap,
      points: ['One bit vector per distinct value.', 'Best for low-cardinality columns (gender, status, city).', 'AND / OR / NOT of bitmaps are very fast.', 'Good for read-mostly warehouses, poor for frequently updated tables.'],
    },
    gin: {
      name: 'GIN', build: gin,
      points: ['Inverted index: element → list of rows containing it.', 'For "contains" queries on arrays, JSONB and full-text search.', 'Multi-element queries intersect posting lists.', 'Fast reads; writes are heavier (many entries per row).'],
    },
    gist: {
      name: 'GiST', build: gist,
      points: ['Balanced tree of bounding "predicates" (boxes, ranges).', 'Answers overlaps, contains, within-distance and nearest-neighbour.', 'Skips whole subtrees whose box does not match.', 'Used by PostGIS, range types, exclusion constraints.'],
    },
    brin: {
      name: 'BRIN', build: brin,
      points: ['Summary (min/max) per range of blocks.', 'Extremely small and cheap to maintain.', 'Works when values follow the physical order (time-series, logs).', 'Lossy: candidate blocks must be re-checked.'],
    },
  };

  global.ITScenes = { SCENES };
})(window);
