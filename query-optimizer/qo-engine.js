/*
 * The optimizer, recorded as a list of steps for the player:
 *  1. parse & bind the SQL (QoSql) and build the canonical tree π(σ(R1 × R2 × …)),
 *  2. the rewriter applies heuristic rules in a fixed order (rule-based, RBO),
 *  3. the planner estimates rows and costs, picks an access path per table and
 *     finds the cheapest join order with dynamic programming (cost-based, CBO).
 * Every step carries a scene (drawn on the canvas) and a board (the decision
 * panel), so the player can move backwards and forwards freely.
 */
(function (global) {
  'use strict';

  const Q = global.QoSql;
  const { str, refs, cols, conj, andAll, fold, isLit } = Q;

  // ---------- Cost model (PostgreSQL-style constants) ----------

  const COST = { seqPage: 1.0, cpuTuple: 0.01, cpuOp: 0.0025 };

  const RULES = [
    { key: 'unnest', name: 'Unnest subqueries', short: 'x IN (SELECT y …) → semi join ⋉' },
    { key: 'simplify', name: 'Simplify expressions', short: 'compute constants, drop TRUE, remove NOT' },
    { key: 'redundant', name: 'Redundant & impossible conditions', short: 'x > 5 AND x > 3 → x > 5;  x = 1 AND x = 2 → FALSE' },
    { key: 'split', name: 'Split AND conditions', short: 'σ(a AND b) → σ(a) on top of σ(b)' },
    { key: 'pushdown', name: 'Push selections down', short: 'filter each table as early as possible' },
    { key: 'join', name: 'Cross product + condition → join', short: 'σ(a.x = b.y)(A × B) → A ⋈ B' },
    { key: 'transitive', name: 'Transitive conditions', short: 'a = b AND a = 5 ⇒ b = 5' },
    { key: 'prune', name: 'Prune columns', short: 'push π down: read only the needed columns' },
  ];

  const PSEUDO = [
    'optimize(sql):',
    '  tree ← parse(sql); bind(tree, catalog) ▹ parser',
    '  for each rule in RULES: ▹ rewriter · RBO',
    '    while rule matches tree: tree ← apply(rule, tree)',
    '  read statistics of every table ▹ planner · CBO',
    '  for each table t:',
    '    rows(t) ← |t| × selectivity(filters of t)',
    '    best[{t}] ← cheapest access path (Seq / Index Scan)',
    '  for k ← 2 … n: ▹ join order by dynamic programming',
    '    for each connected set S of k tables:',
    '      for each t in S, each join method m:',
    '        best[S] ← cheapest(best[S − t] ⋈m t)',
    '  return best[all tables] + aggregate / sort / limit',
  ];

  const METHOD = {
    nl: { name: 'Nested Loop', semi: 'Nested Loop Semi Join', short: 'Nested loop' },
    inl: { name: 'Index Nested Loop', semi: 'Index NL Semi Join', short: 'Index NL' },
    hash: { name: 'Hash Join', semi: 'Hash Semi Join', short: 'Hash join' },
    merge: { name: 'Merge Join', semi: 'Merge Semi Join', short: 'Merge join' },
  };
  const METHOD_KEYS = ['nl', 'inl', 'hash', 'merge'];
  const TOP_OPS = new Set(['limit', 'sort', 'distinct', 'project', 'agg']);

  // ---------- Number formatting ----------

  const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
  function fmtBig(n) {
    if (n >= 1e12) return `${+(n / 1e12).toPrecision(3)} trillion`;
    if (n >= 1e9) return `${+(n / 1e9).toPrecision(3)} billion`;
    if (n >= 1e6) return `${+(n / 1e6).toPrecision(3)} million`;
    return fmtInt(n);
  }
  const fmtRows = (n) => fmtBig(Math.max(1, Math.round(n)));
  const rowsTxt = (n) => `${fmtRows(n)} row${Math.round(n) <= 1 ? '' : 's'}`;
  function fmtCost(c) {
    if (c >= 1e12) return c.toExponential(1).replace('e+', 'e');
    if (c >= 1e9) return `${+(c / 1e9).toPrecision(3)}B`;
    if (c >= 1e6) return `${+(c / 1e6).toPrecision(3)}M`;
    if (c >= 100) return fmtInt(c);
    if (c >= 10) return String(+c.toFixed(1));
    return String(+c.toFixed(2));
  }
  function fmtSel(s) {
    if (s >= 0.9995) return '1';
    if (s >= 0.01) return String(+s.toFixed(3));
    if (s >= 0.0001) return String(+s.toFixed(5));
    return s.toExponential(1);
  }
  const fmtNum = Q.fmtNum;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const times = (a, b) => {
    const r = a / b;
    return r >= 100 ? fmtInt(r) : String(+r.toFixed(r >= 10 ? 0 : 1));
  };
  const sortCost = (n) => (n > 1 ? 2 * COST.cpuOp * n * Math.log2(n) : 0);

  // ---------- Step recorder ----------

  class Recorder {
    constructor() {
      this.steps = [];
      this.phaseStart = {};
    }
    add(s) {
      const step = { status: 'info', hl: {}, dur: 800, line: -1, scene: null, ...s };
      if (this.phaseStart[step.phase] == null) this.phaseStart[step.phase] = this.steps.length;
      this.steps.push(step);
      return step;
    }
  }

  // ---------- Tree helpers ----------

  function walk(n, fn, parent) {
    fn(n, parent || null);
    if (n.kids) n.kids.forEach((k) => walk(k, fn, n));
    if (n.sides) n.sides.forEach((k) => walk(k, fn, n));
  }

  function parentOf(root, node) {
    let found = null;
    walk(root, (n, p) => { if (n === node) found = p; });
    return found;
  }

  function replace(parent, oldN, newN) {
    let i = parent.kids.indexOf(oldN);
    if (i >= 0) { parent.kids[i] = newN; return; }
    i = parent.sides ? parent.sides.indexOf(oldN) : -1;
    if (i >= 0) parent.sides[i] = newN;
  }

  function relsUnder(n) {
    if (n.op === 'scan') return [n.rel];
    return (n.kids || []).flatMap(relsUnder);
  }
  const subset = (a, b) => a.every((x) => b.includes(x));

  // ---------- Cards: what the canvas draws for a node ----------

  const predLines = (p, q) => conj(p).map((c, i) => (i ? 'AND ' : '') + str(c, q));
  const itemsText = (q) => (q.star ? '*' : q.items.map((it) => it.label).join(', '));
  const orderText = (q) => q.order.map((o) => str(o.expr, q) + (o.desc ? ' DESC' : '')).join(', ');
  const aggText = (q) => {
    const aggs = q.items.filter((it) => it.expr.k === 'agg').map((it) => str(it.expr, q));
    const lines = [];
    if (q.group.length) lines.push('by ' + q.group.map((g) => str(g, q)).join(', '));
    if (aggs.length) lines.push(aggs.join(', '));
    return lines;
  };

  function cardOf(n, q, cat) {
    const c = { id: n.id, kids: (n.kids || []).map((k) => cardOf(k, q, cat)) };
    if (n.sides && n.sides.length) c.sides = n.sides.map((s) => cardOf(s, q, cat));
    switch (n.op) {
      case 'scan': {
        const r = q.rel[n.rel];
        const all = cat.columns(r.table);
        c.tone = 'scan';
        c.sym = 'table';
        c.head = r.name;
        c.note = n.cols ? (n.cols.length ? `${n.cols.length} of ${all.length} columns: ${n.cols.join(', ')}` : 'no columns, only counts rows') : `all ${all.length} columns`;
        break;
      }
      case 'select':
        c.tone = 'select';
        c.sym = 'σ';
        c.code = predLines(n.pred, q);
        if (n.derived) c.tag = 'derived';
        break;
      case 'product':
        c.tone = 'product';
        c.sym = '×';
        c.head = 'Cross product';
        c.note = 'every row × every row';
        break;
      case 'join':
        c.tone = 'join';
        c.sym = n.semi ? '⋉' : '⋈';
        c.head = n.semi ? 'Semi join' : 'Join';
        c.code = predLines(n.pred, q);
        break;
      case 'project':
        c.tone = 'project';
        c.sym = 'π';
        c.code = [n.subq ? str(n.subq.col, q) : itemsText(q)];
        if (n.subq) c.tag = 'subquery';
        break;
      case 'agg':
        c.tone = 'agg';
        c.sym = 'γ';
        c.head = q.group.length ? 'Group' : 'Aggregate';
        c.code = aggText(q);
        break;
      case 'distinct':
        c.tone = 'project';
        c.sym = 'δ';
        c.head = 'Distinct';
        c.note = 'remove duplicate rows';
        break;
      case 'sort':
        c.tone = 'sort';
        c.sym = '↓';
        c.head = 'Sort';
        c.code = [orderText(q)];
        break;
      case 'limit':
        c.tone = 'sort';
        c.sym = '#';
        c.head = `Limit ${q.limit}`;
        break;
      case 'empty':
        c.tone = 'empty';
        c.sym = '∅';
        c.head = 'Empty result';
        c.note = 'no table is read';
        break;
      default: break;
    }
    return c;
  }

  const treeScene = (root, q, cat) => ({ kind: 'tree', roots: root.kids.map((n) => cardOf(n, q, cat)) });

  // ---------- Parser steps ----------

  function rawSpan(ast, sp) {
    return ast.src.slice(sp[0], sp[1]).replace(/\s+/g, ' ').trim();
  }

  // The SQL clauses as cards; each card has the id of the tree node it becomes.
  function clauseCards(ast, q) {
    const cards = [];
    const ids = new Set();
    cards.push({ id: 'n:proj', tone: 'project', sym: 'π', head: ast.distinct ? 'SELECT DISTINCT' : 'SELECT', code: [q ? itemsText(q) : rawSpan(ast, ast.spans.select)] });
    ast.from.forEach((ref, i) => {
      let rid = q ? q.main[i] : (ref.alias || ref.table);
      let id = `scan:${rid}`;
      for (let k = 2; ids.has(id); k++) id = `scan:${rid}~${k}`;
      ids.add(id);
      const head = ref.kw === ',' ? null : ref.kw;
      const code = [ref.alias ? `${ref.table} ${ref.alias}` : ref.table];
      if (ref.on) {
        const on = q && q.onText && q.onText[i] ? q.onText[i] : rawSpan(ast, [ref.onS, ref.e]);
        code.push(`ON ${on}`);
      }
      cards.push({ id, tone: 'scan', sym: 'table', head, code, cont: ref.kw !== 'FROM' });
    });
    if (ast.where) {
      const code = q ? q.whereText : [rawSpan(ast, ast.spans.where)];
      cards.push({ id: 'n:sel', tone: 'select', sym: 'σ', head: 'WHERE', code });
    }
    if (ast.group.length) cards.push({ id: 'n:agg', tone: 'agg', sym: 'γ', head: 'GROUP BY', code: [q ? q.group.map((g) => str(g, q)).join(', ') : rawSpan(ast, ast.spans.group)] });
    if (ast.order.length) cards.push({ id: 'n:sort', tone: 'sort', sym: '↓', head: 'ORDER BY', code: [q ? orderText(q) : rawSpan(ast, ast.spans.order)] });
    if (ast.limit != null) cards.push({ id: 'n:limit', tone: 'sort', sym: '#', head: 'LIMIT', code: [String(ast.limit)] });
    return cards;
  }

  function clauseRows(ast) {
    const rows = [];
    rows.push({ kw: ast.distinct ? 'SELECT DISTINCT' : 'SELECT', text: rawSpan(ast, ast.spans.select), op: ast.distinct ? 'π δ' : 'π', opName: ast.distinct ? 'projection + distinct' : 'projection', tone: 'project' });
    rows.push({ kw: 'FROM', text: ast.from.map((r) => (r.alias ? `${r.table} ${r.alias}` : r.table)).join(', '), op: ast.from.length > 1 ? '▦ ×' : '▦', opName: ast.from.length > 1 ? 'tables, combined by ×' : 'table scan', tone: 'scan' });
    const ons = ast.from.filter((r) => r.on);
    if (ons.length) rows.push({ kw: 'JOIN … ON', text: ons.map((r) => rawSpan(ast, [r.onS, r.e])).join(' · '), op: 'σ', opName: 'conditions (like WHERE)', tone: 'select' });
    if (ast.where) rows.push({ kw: 'WHERE', text: rawSpan(ast, ast.spans.where), op: 'σ', opName: 'selection', tone: 'select' });
    if (ast.group.length) rows.push({ kw: 'GROUP BY', text: rawSpan(ast, ast.spans.group), op: 'γ', opName: 'grouping', tone: 'agg' });
    if (ast.order.length) rows.push({ kw: 'ORDER BY', text: rawSpan(ast, ast.spans.order), op: '↓', opName: 'sort', tone: 'sort' });
    if (ast.limit != null) rows.push({ kw: 'LIMIT', text: String(ast.limit), op: '#', opName: 'limit', tone: 'sort' });
    return rows;
  }

  function canonical(q) {
    const scans = q.main.map((id) => ({ id: `scan:${id}`, op: 'scan', rel: id, cols: null, kids: [] }));
    let node = scans[0];
    for (let i = 1; i < scans.length; i++) node = { id: `x:${i}`, op: 'product', kids: [node, scans[i]] };
    if (q.pred) {
      node = { id: 'n:sel', op: 'select', pred: q.pred, kids: [node] };
      if (q.subs.length) node.sides = q.subs.map(subTree);
    }
    if (q.aggregate) node = { id: 'n:agg', op: 'agg', kids: [node] };
    node = { id: 'n:proj', op: 'project', kids: [node] };
    if (q.distinct) node = { id: 'n:dist', op: 'distinct', kids: [node] };
    if (q.order.length) node = { id: 'n:sort', op: 'sort', kids: [node] };
    if (q.limit != null) node = { id: 'n:limit', op: 'limit', kids: [node] };
    return { id: 'root', op: 'root', kids: [node] };
  }

  function subTree(sub) {
    let n = { id: `scan:${sub.rel}`, op: 'scan', rel: sub.rel, cols: null, kids: [] };
    if (sub.where) n = { id: `sub:sel:${sub.rel}`, op: 'select', pred: sub.where, kids: [n] };
    return { id: `sub:proj:${sub.rel}`, op: 'project', subq: sub, kids: [n] };
  }

  function errInfo(err, sql) {
    const s = clamp(err.s, 0, sql.length), e = clamp(Math.max(err.e, err.s + 1), 0, sql.length);
    const lineNo = sql.slice(0, s).split('\n').length;
    const lineStart = sql.lastIndexOf('\n', s - 1) + 1;
    let lineEnd = sql.indexOf('\n', s);
    if (lineEnd < 0) lineEnd = sql.length;
    return { msg: err.message, hint: err.hint, s, e, line: lineNo, col: s - lineStart + 1, text: sql.slice(lineStart, lineEnd), at: s - lineStart, len: Math.max(1, Math.min(e, lineEnd) - s) };
  }

  // ---------- Rewriter (RBO) ----------

  // Conditions on one column against constants, for the redundancy rule.
  function simpleBound(c) {
    if (c.k === 'cmp' && c.l.k === 'col' && isLit(c.r)) {
      const v = c.r.v;
      switch (c.op) {
        case '=': return { col: c.l, eq: [v] };
        case '<>': return { col: c.l, ne: v };
        case '>': return { col: c.l, lo: { v, incl: false } };
        case '>=': return { col: c.l, lo: { v, incl: true } };
        case '<': return { col: c.l, hi: { v, incl: false } };
        case '<=': return { col: c.l, hi: { v, incl: true } };
        default: return null;
      }
    }
    if (c.k === 'between' && !c.not && c.e.k === 'col' && isLit(c.lo) && isLit(c.hi)) {
      return { col: c.e, lo: { v: c.lo.v, incl: true }, hi: { v: c.hi.v, incl: true } };
    }
    if (c.k === 'in' && !c.not && c.e.k === 'col' && c.list.every(isLit)) return { col: c.e, eq: c.list.map((x) => x.v) };
    return null;
  }

  const tighterLo = (a, b) => a.v > b.v || (a.v === b.v && !a.incl && b.incl);
  const tighterHi = (a, b) => a.v < b.v || (a.v === b.v && !a.incl && b.incl);
  const litOf = (v) => (typeof v === 'number' ? { k: 'num', v } : { k: 'str', v });

  function analyze(list, q) {
    const keep = list.map(() => true);
    const repl = {};
    const changes = [];
    const seen = new Map();
    list.forEach((c, i) => {
      const s = str(c, q);
      if (seen.has(s)) {
        keep[i] = false;
        changes.push({ before: s, after: null, why: 'written twice, one copy is enough' });
      } else seen.set(s, i);
    });
    const groups = new Map();
    list.forEach((c, i) => {
      if (!keep[i]) return;
      const b = simpleBound(c);
      if (!b) return;
      b.i = i;
      const key = `${b.col.t}.${b.col.c}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    });
    for (const bs of groups.values()) {
      if (bs.length < 2) continue;
      const types = new Set();
      bs.forEach((b) => {
        (b.eq || []).forEach((v) => types.add(typeof v));
        if (b.ne !== undefined) types.add(typeof b.ne);
        if (b.lo) types.add(typeof b.lo.v);
        if (b.hi) types.add(typeof b.hi.v);
      });
      if (types.size > 1) continue;
      const text = bs.map((b) => str(list[b.i], q)).join(' AND ');
      let A = null, eqFrom = -1;
      bs.forEach((b) => {
        if (!b.eq) return;
        A = A ? A.filter((v) => b.eq.includes(v)) : [...new Set(b.eq)];
        if (eqFrom < 0) eqFrom = b.i;
      });
      let lo = null, hi = null;
      bs.forEach((b) => {
        if (b.lo && (!lo || tighterLo(b.lo, lo))) lo = { ...b.lo, i: b.i };
        if (b.hi && (!hi || tighterHi(b.hi, hi))) hi = { ...b.hi, i: b.i };
      });
      const nes = bs.filter((b) => b.ne !== undefined).map((b) => b.ne);
      const ok = (v) => (!lo || (lo.incl ? v >= lo.v : v > lo.v)) && (!hi || (hi.incl ? v <= hi.v : v < hi.v)) && !nes.includes(v);
      if (A) {
        const left = A.filter(ok);
        if (!left.length) return { contradiction: { text, why: 'no value satisfies all of them' } };
        if (left.length === 1) {
          const eqC = { k: 'cmp', op: '=', l: bs[0].col, r: litOf(left[0]) };
          const eqS = str(eqC, q);
          bs.forEach((b) => {
            const s = str(list[b.i], q);
            if (b.i === eqFrom) {
              repl[b.i] = eqC;
              if (s !== eqS) changes.push({ before: s, after: eqS, why: 'only this value is left' });
            } else {
              keep[b.i] = false;
              changes.push({ before: s, after: null, why: `already implied by ${eqS}` });
            }
          });
        }
        continue;
      }
      if (lo && hi && (lo.v > hi.v || (lo.v === hi.v && !(lo.incl && hi.incl)))) {
        return { contradiction: { text, why: 'the range is empty' } };
      }
      bs.forEach((b) => {
        if (b.lo && !b.hi && lo.i !== b.i) {
          keep[b.i] = false;
          changes.push({ before: str(list[b.i], q), after: null, why: `already implied by ${str(list[lo.i], q)}` });
        }
        if (b.hi && !b.lo && hi.i !== b.i) {
          keep[b.i] = false;
          changes.push({ before: str(list[b.i], q), after: null, why: `already implied by ${str(list[hi.i], q)}` });
        }
      });
    }
    return { list: list.map((c, i) => repl[i] || c).filter((_, i) => keep[i]), changes, contradiction: null };
  }

  function whyFold(a, b) {
    if (b.k === 'bool') return b.v ? 'always TRUE, filters nothing, dropped' : 'always FALSE';
    const sa = JSON.stringify(a);
    if (sa.includes('"k":"not"')) return 'NOT removed by flipping the comparison';
    if (sa.includes('"k":"bin"') || sa.includes('"k":"neg"')) return 'arithmetic on constants done once, now';
    if (a.k === 'in') return 'IN with one value is just =';
    if (a.k === 'like') return 'LIKE without % or _ is just =';
    if (a.k === 'cmp' && Q.isConst(a.l)) return 'column moved to the left';
    return 'simplified';
  }

  // The column a simple single-table condition restricts (for transitive conditions).
  function restrictedCol(p) {
    if (p.k === 'cmp' && p.l.k === 'col' && isLit(p.r)) return p.l;
    if ((p.k === 'between') && p.e.k === 'col' && isLit(p.lo) && isLit(p.hi)) return p.e;
    if ((p.k === 'in') && p.e.k === 'col' && p.list.every(isLit)) return p.e;
    if (p.k === 'like' && p.e.k === 'col') return p.e;
    return null;
  }

  const isColEq = (c) => c.k === 'cmp' && c.op === '=' && c.l.k === 'col' && c.r.k === 'col' && c.l.t !== c.r.t;

  class Rewriter {
    constructor(tree, q, cat, R) {
      this.tree = tree;
      this.q = q;
      this.cat = cat;
      this.R = R;
      this.st = RULES.map(() => ({ status: 'pending', count: 0, note: '' }));
      this.seq = 0;
      this.applied = 0;
    }

    scene() { return treeScene(this.tree, this.q, this.cat); }
    rel(id) { return this.q.rel[id]; }

    board(cur, detail) {
      return {
        kind: 'rules', current: cur, detail: detail || null,
        rules: RULES.map((r, i) => ({ name: r.name, short: r.short, status: this.st[i].status, count: this.st[i].count, note: this.st[i].note })),
      };
    }

    settle(j) {
      const s = this.st[j];
      if (s.status === 'pending' || s.status === 'active') s.status = s.count ? 'applied' : 'skipped';
    }

    // One recorded application of rule i.
    step(i, o, counted) {
      for (let j = 0; j < i; j++) this.settle(j);
      this.st[i].status = 'active';
      if (counted !== false) {
        this.st[i].count++;
        this.applied++;
      }
      this.R.add({
        phase: 'rewrite', line: 3, dur: 900, ...o,
        title: `Rule ${i + 1} · ${o.title}`,
        scene: this.scene(),
        board: this.board(i, o.detail),
      });
    }

    sels() {
      const out = [];
      walk(this.tree, (n) => { if (n.op === 'select') out.push(n); });
      return out;
    }

    run() {
      this.R.add({
        phase: 'rewrite', title: 'Rewriter starts', line: 2, dur: 500,
        msg: `The rewriter now applies ${RULES.length} rules, always in the same order. A rule fires wherever its pattern appears in the tree. Rules never look at table sizes or costs, each one is (almost) always a good idea.`,
        scene: this.scene(), board: this.board(-1, null),
      });
      const order = [this.unnest, this.simplify, this.redundant, this.split, this.pushdown, this.combine, this.transitive, this.prune];
      for (let i = 0; i < order.length; i++) {
        if (order[i].call(this, i) === 'empty') {
          for (let j = i + 1; j < RULES.length; j++) {
            this.st[j].status = 'na';
            this.st[j].note = 'not needed';
          }
          this.settle(i);
          return true;
        }
      }
      RULES.forEach((_, j) => this.settle(j));
      const done = this.st.filter((s) => s.count).length;
      this.R.add({
        phase: 'rewrite', title: 'Rewrite finished', status: 'success', line: 3, dur: 600,
        msg: `Rewrite done: ${done} of ${RULES.length} rules changed the tree (${this.applied} change${this.applied === 1 ? '' : 's'}). ` + (this.q.rels.length > 1
          ? 'Every table is now filtered first and tables are joined on conditions. Still open: which table to start with, how to read each one and how to join them, that needs statistics and costs.'
          : 'Still open: the best way to read the table, that needs statistics and costs.'),
        scene: this.scene(), board: this.board(-1, null),
      });
      return false;
    }

    // Rule 1: x IN (SELECT y FROM T WHERE p)  →  … ⋉(x = y) σp(T)
    unnest(i) {
      const sel = this.sels().find((s) => s.sides && s.sides.length);
      if (!sel) { this.st[i].note = 'no subquery'; return; }
      const q = this.q;
      [...sel.sides].forEach((side) => {
        const sub = side.subq;
        const cs = conj(sel.pred);
        const c = cs.find((x) => x.k === 'insub' && x.sub === sub);
        const rest = cs.filter((x) => x !== c);
        const eq = { k: 'cmp', op: '=', l: c.e, r: sub.col };
        const semi = { id: `semi:${sub.rel}`, op: 'join', semi: true, pred: eq, kids: [sel.kids[0], side.kids[0]] };
        sel.kids[0] = semi;
        sel.sides = sel.sides.filter((s) => s !== side);
        let selGone = false;
        if (rest.length) sel.pred = andAll(rest);
        else {
          replace(parentOf(this.tree, sel), sel, sel.kids[0]);
          selGone = true;
        }
        const outer = [...refs(c.e)].map((id) => this.rel(id).name).join(', ');
        const hl = { [semi.id]: 'good' };
        if (!selGone) hl[sel.id] = 'focus';
        this.step(i, {
          title: 'Unnest subquery',
          msg: `Run literally, the subquery would be evaluated for every ${outer} row. Instead it becomes a semi join: keep each ${outer} row that has at least one match ${str(eq, q)} (never duplicates). Now the planner can pick the join order and method like for any join.`,
          hl, dur: 1200, detail: { lines: [{ before: str(c, q), after: `⋉ semi join on ${str(eq, q)}`, why: 'subquery → join' }] },
        });
      });
    }

    // Rule 2: constant folding and boolean simplification.
    simplify(i) {
      const q = this.q;
      const lines = [];
      const hl = {};
      const sels = this.sels();
      sels.forEach((s) => {
        const cs = conj(s.pred);
        const fs = cs.map((c) => fold(c));
        cs.forEach((c, k) => {
          const a = str(c, q), b = str(fs[k], q);
          if (a !== b) {
            lines.push({ before: a, after: b, why: whyFold(c, fs[k]) });
            hl[s.id] = 'good';
          }
        });
        s.pred = fold(andAll(fs));
      });
      if (!lines.length) { this.st[i].note = 'nothing to simplify'; return; }
      let dropped = 0;
      sels.forEach((s) => {
        if (s.pred.k === 'bool' && s.pred.v) {
          replace(parentOf(this.tree, s), s, s.kids[0]);
          delete hl[s.id];
          dropped++;
        }
      });
      const fals = sels.find((s) => s.pred.k === 'bool' && !s.pred.v);
      if (fals) hl[fals.id] = 'bad';
      const shown = lines.slice(0, 2).map((l) => `${l.before} → ${l.after}`).join('; ');
      this.step(i, {
        title: 'Simplify expressions', status: fals ? 'warn' : 'info',
        msg: `Work that gives the same answer for every row is done once, now: ${shown}${lines.length > 2 ? ` (+${lines.length - 2} more)` : ''}.` +
          (dropped ? ' A filter that is always TRUE removes nothing, so it disappears.' : '') +
          (fals ? ' One condition is always FALSE, so no row can ever pass.' : ''),
        hl, detail: { lines },
      });
      if (fals) return this.toEmpty(i);
    }

    // Rule 3: duplicates, implied bounds, contradictions.
    redundant(i) {
      const q = this.q;
      const lines = [];
      const hl = {};
      for (const s of this.sels()) {
        const res = analyze(conj(s.pred), q);
        if (res.contradiction) {
          lines.push({ before: res.contradiction.text, after: 'FALSE', why: res.contradiction.why });
          s.pred = Q.FALSE;
          hl[s.id] = 'bad';
          this.step(i, {
            title: 'Impossible condition', status: 'warn',
            msg: `${res.contradiction.text}: ${res.contradiction.why}, so this can never be true for any row. The whole WHERE clause is FALSE.`,
            hl, detail: { lines },
          });
          return this.toEmpty(i);
        }
        if (res.changes.length) {
          lines.push(...res.changes);
          s.pred = andAll(res.list);
          hl[s.id] = 'good';
        }
      }
      if (!lines.length) { this.st[i].note = 'none found'; return; }
      this.step(i, {
        title: 'Remove redundant conditions',
        msg: `${lines.map((l) => (l.after ? `${l.before} → ${l.after}` : `${l.before}: ${l.why}`)).slice(0, 2).join('; ')}. Fewer conditions to check for every row, the result is the same.`,
        hl, detail: { lines },
      });
    }

    toEmpty(i) {
      let parent = this.tree, node = this.tree.kids[0];
      while (TOP_OPS.has(node.op)) {
        parent = node;
        node = node.kids[0];
      }
      replace(parent, node, { id: 'n:empty', op: 'empty', kids: [] });
      const count = this.q.aggregate && !this.q.group.length;
      this.step(i, {
        title: 'Empty result', status: 'success', dur: 1200,
        msg: `A filter that is always FALSE means the answer is empty${count ? ' (COUNT(*) of no rows is a single row with 0)' : ''}. Everything below is replaced by “empty result”: no table will be read and nothing needs costing, a huge win found by rules alone.`,
        hl: { 'n:empty': 'good' }, detail: { text: 'The optimizer proved the result is empty without touching the data.' },
      }, false);
      return 'empty';
    }

    // Rule 4: σ(a AND b AND c) → σa(σb(σc(…)))
    split(i) {
      const q = this.q;
      const sels = this.sels().filter((s) => conj(s.pred).length > 1);
      if (!sels.length) { this.st[i].note = 'one condition per filter'; return; }
      const hl = {};
      let total = 0;
      const lines = [];
      sels.forEach((s) => {
        const cs = conj(s.pred);
        total += cs.length;
        let below = s.kids[0];
        for (let k = cs.length - 1; k >= 1; k--) {
          const id = `sel:${++this.seq}`;
          below = { id, op: 'select', pred: cs[k], kids: [below] };
          hl[id] = 'good';
        }
        s.pred = cs[0];
        s.kids = [below];
        hl[s.id] = 'good';
        lines.push({ before: `σ ${cs.map((c) => str(c, q)).join(' AND ')}`, after: cs.map((c) => `σ ${str(c, q)}`).join('  ·  '), why: `${cs.length} separate filters` });
      });
      this.step(i, {
        title: 'Split AND conditions', dur: 1100,
        msg: `A filter with ${total} AND-ed conditions becomes a stack of ${total} filters, one condition each. The result is the same (a row must pass all of them), but now each condition can move down the tree on its own.`,
        hl, detail: { lines },
      });
    }

    // Rule 5: move each σ to the lowest node that has all the tables it needs.
    pushdown(i) {
      const q = this.q;
      let moved = 0;
      for (const s of this.sels()) {
        const need = [...refs(s.pred)];
        if (!need.length) continue;
        let cur = s.kids[0];
        let insParent = null, insAt = null;
        for (;;) {
          if (cur.op === 'select') { cur = cur.kids[0]; continue; }
          if (cur.op === 'product' || cur.op === 'join') {
            const k = cur.kids.find((kid) => subset(need, relsUnder(kid)));
            if (k) {
              insParent = cur;
              insAt = k;
              cur = k;
              continue;
            }
          }
          break;
        }
        if (!insParent) continue;
        replace(parentOf(this.tree, s), s, s.kids[0]);
        replace(insParent, insAt, s);
        s.kids = [insAt];
        moved++;
        const p = str(s.pred, q);
        const names = need.map((id) => this.rel(id).name);
        const single = need.length === 1;
        this.step(i, {
          title: `Push ${p} down`, dur: 1300,
          msg: single
            ? `${p} only uses ${names[0]}. It moves down to sit right on top of ${names[0]}, so rows are thrown away as soon as they are read, before any join has to handle them.`
            : `${p} needs ${names.join(' and ')}, so it moves down to the × that first brings ${need.length === 2 ? 'those two tables' : 'those tables'} together.`,
          hl: { [s.id]: 'focus' },
          detail: { lines: [{ before: `σ ${p}`, after: single ? `directly on ${names[0]}` : `on ${names.join(' × ')}`, why: single ? 'filter before joining' : 'as low as both tables allow' }] },
        });
      }
      if (!moved) this.st[i].note = 'filters already low';
    }

    // Rule 6: σ(join condition) directly on A × B  →  A ⋈ B
    combine(i) {
      const q = this.q;
      const prods = [];
      walk(this.tree, (n) => { if (n.op === 'product') prods.push(n); });
      prods.reverse(); // deepest first
      const left = [];
      prods.forEach((p) => {
        const chain = [];
        let par = parentOf(this.tree, p);
        while (par && par.op === 'select') {
          chain.push(par);
          par = parentOf(this.tree, par);
        }
        const [L, Rr] = p.kids.map(relsUnder);
        const js = chain.filter((s) => {
          const r = [...refs(s.pred)];
          return r.some((x) => L.includes(x)) && r.some((x) => Rr.includes(x));
        });
        if (!js.length) { left.push(p); return; }
        js.forEach((s) => replace(parentOf(this.tree, s), s, s.kids[0]));
        p.op = 'join';
        p.pred = andAll(js.map((s) => s.pred));
        const ln = L.map((id) => this.rel(id).name).join(' ⋈ ');
        const rn = Rr.map((id) => this.rel(id).name).join(' ⋈ ');
        const cond = str(p.pred, q);
        this.step(i, {
          title: `× + ${cond} → ⋈`, dur: 1200,
          msg: `${cond} sits right on the cross product of ${ln} and ${rn}. “Every pair, then keep the matching ones” is exactly a join, and a join can find the matching rows directly (with a hash table or an index) instead of building every pair first.`,
          hl: { [p.id]: 'good' },
          detail: { lines: [{ before: `σ ${cond} ( ${L.join(' ')} × ${Rr.join(' ')} )`, after: `${L.join(' ')} ⋈ ${Rr.join(' ')}`, why: 'cross product + condition = join' }] },
        });
      });
      if (!prods.length || prods.length === left.length) this.st[i].note = prods.length ? '' : 'no cross products';
      left.forEach((p) => {
        const [L, Rr] = p.kids.map((k) => relsUnder(k).map((id) => this.rel(id).name).join(', '));
        this.step(i, {
          title: 'A cross product remains', status: 'warn', dur: 900,
          msg: `No condition links ${L} with ${Rr}, so this × stays: every row of one side is paired with every row of the other. That is rarely intended, usually a join condition is missing from the query.`,
          hl: { [p.id]: 'bad' },
          detail: { lines: [{ before: `${L} × ${Rr}`, after: 'stays ×', why: 'no condition connects them' }] },
        }, false);
      });
    }

    // Rule 7: a.x = b.y and a.x = 5  ⇒  b.y = 5
    transitive(i) {
      const q = this.q;
      const parent = new Map();
      const find = (k) => {
        while (parent.has(k) && parent.get(k) !== k) k = parent.get(k);
        return k;
      };
      const union = (a, b) => {
        if (!parent.has(a)) parent.set(a, a);
        if (!parent.has(b)) parent.set(b, b);
        parent.set(find(a), find(b));
      };
      const eqs = [];
      walk(this.tree, (n) => {
        if (n.op === 'join') conj(n.pred).forEach((c) => {
          if (isColEq(c)) {
            union(`${c.l.t}.${c.l.c}`, `${c.r.t}.${c.r.c}`);
            eqs.push(c);
          }
        });
      });
      if (!eqs.length) { this.st[i].note = 'no join equalities'; return; }
      const filters = new Map(); // rel id → [σ nodes directly on its scan]
      walk(this.tree, (n) => {
        if (n.op !== 'scan') return;
        const list = [];
        let p = parentOf(this.tree, n);
        while (p && p.op === 'select') {
          list.push(p);
          p = parentOf(this.tree, p);
        }
        filters.set(n.rel, list);
      });
      const has = (rel, s) => (filters.get(rel) || []).some((f) => str(f.pred, q) === s);
      const derived = [];
      for (const [rel, list] of filters) {
        for (const f of list) {
          const col = restrictedCol(f.pred);
          if (!col || col.t !== rel) continue;
          const key = `${col.t}.${col.c}`;
          if (!parent.has(key)) continue;
          const root = find(key);
          for (const other of parent.keys()) {
            if (other === key || find(other) !== root) continue;
            const [t, c] = other.split('.');
            if (t === rel) continue;
            const np = Q.swapCol(f.pred, col, { t, c });
            const s = str(np, q);
            if (has(t, s) || derived.some((d) => d.rel === t && d.text === s)) continue;
            const via = eqs.find((e) => (str(e.l, q) === str(col, q) || str(e.r, q) === str(col, q))) || eqs[0];
            derived.push({ rel: t, pred: np, text: s, from: str(f.pred, q), via: str(via, q) });
          }
        }
      }
      if (!derived.length) { this.st[i].note = 'no new conditions'; return; }
      const hl = {};
      derived.forEach((d) => {
        let scan = null;
        walk(this.tree, (n) => { if (n.op === 'scan' && n.rel === d.rel) scan = n; });
        const id = `dsel:${++this.seq}`;
        const node = { id, op: 'select', pred: d.pred, derived: true, kids: [scan] };
        replace(parentOf(this.tree, scan), scan, node);
        hl[id] = 'good';
      });
      const d0 = derived[0];
      this.step(i, {
        title: 'Infer new conditions', dur: 1200,
        msg: `${d0.via} means both columns are equal in every joined row, so ${d0.from} also implies ${d0.text}${derived.length > 1 ? ` (and ${derived.length - 1} more)` : ''}. The query never spelled this out, but now ${this.rel(d0.rel).name} can be filtered, maybe with an index, before the join.`,
        hl, detail: { lines: derived.map((d) => ({ before: `${d.via} AND ${d.from}`, after: d.text, why: 'new filter (derived)' })) },
      });
    }

    // Rule 8: each scan reads only the columns used above it.
    prune(i) {
      const q = this.q;
      const need = new Map();
      const add = (c) => {
        if (!need.has(c.t)) need.set(c.t, new Set());
        need.get(c.t).add(c.c);
      };
      walk(this.tree, (n) => {
        if (n.pred) cols(n.pred).forEach(add);
      });
      if (q.star) q.main.forEach((id) => this.cat.columns(this.rel(id).table).forEach((c) => add({ t: id, c })));
      q.items.forEach((it) => cols(it.expr).forEach(add));
      q.group.forEach((g) => cols(g).forEach(add));
      q.order.forEach((o) => cols(o.expr.k === 'ref' ? o.expr.target : o.expr).forEach(add));
      const lines = [];
      const hl = {};
      let narrowed = 0;
      walk(this.tree, (n) => {
        if (n.op !== 'scan') return;
        const r = this.rel(n.rel);
        const all = this.cat.columns(r.table);
        const set = need.get(n.rel) || new Set();
        n.cols = all.filter((c) => set.has(c));
        if (n.cols.length < all.length) {
          narrowed++;
          hl[n.id] = 'good';
          lines.push({ before: `${r.name}: all ${all.length} columns`, after: n.cols.length ? n.cols.join(', ') : '(none, only counted)', why: `${all.length - n.cols.length} column${all.length - n.cols.length === 1 ? '' : 's'} never used` });
        }
      });
      if (!narrowed) {
        this.st[i].note = 'every column is needed';
        return;
      }
      this.step(i, {
        title: 'Prune columns',
        msg: `Each table delivers only the columns used further up (${lines.map((l) => l.before.split(':')[0] + ' → ' + l.after).slice(0, 2).join('; ')}). Narrower rows mean less data copied through every operator, the textbook “push π down”.${q.star ? ' SELECT * keeps every column of the main tables.' : ''}`,
        hl, detail: { lines },
      });
    }
  }

  // ---------- Planner (CBO) ----------

  function extract(tree, q, cat) {
    const rels = [];
    walk(tree, (n) => {
      if (n.op !== 'scan') return;
      const r = q.rel[n.rel];
      rels.push({
        idx: rels.length, id: r.id, table: r.table, name: r.name, sub: r.sub, cols: n.cols,
        N: cat.rows(r.table), pages: cat.pages(r.table), perPage: cat.perPage(r.table), filters: [],
      });
    });
    rels.forEach((r) => { r.mask = 1 << r.idx; });
    const byId = {};
    rels.forEach((r) => { byId[r.id] = r; });
    const edges = [];
    const complex = [];
    walk(tree, (n) => {
      if (n.op === 'select') {
        let b = n;
        while (b.op === 'select') b = b.kids[0];
        if (b.op === 'scan') byId[b.rel].filters.push({ pred: n.pred, derived: !!n.derived });
        else conj(n.pred).forEach((c) => complex.push({ pred: c }));
      } else if (n.op === 'join') {
        conj(n.pred).forEach((c) => {
          const rs = [...refs(c)];
          if (rs.length !== 2) { complex.push({ pred: c }); return; }
          const A = byId[rs[0]], B = byId[rs[1]];
          let e = edges.find((x) => (x.a === A.idx && x.b === B.idx) || (x.a === B.idx && x.b === A.idx));
          if (!e) {
            const [a, b] = A.idx < B.idx ? [A, B] : [B, A];
            e = { a: a.idx, b: b.idx, id: `edge:${a.id}:${b.id}`, preds: [], equi: [], semi: !!n.semi };
            edges.push(e);
          }
          e.preds.push(c);
          if (isColEq(c)) e.equi.push({ [c.l.t]: c.l, [c.r.t]: c.r });
        });
      }
    });
    complex.forEach((c) => {
      c.mask = [...refs(c.pred)].reduce((m, id) => m | byId[id].mask, 0);
      c.sel = 1 / 3;
    });
    // Circle order for the graph: walk the join graph so neighbours sit side by side.
    const deg = rels.map((r) => edges.filter((e) => e.a === r.idx || e.b === r.idx).length);
    const order = [];
    const seen = new Set();
    const visit = (i) => {
      if (seen.has(i)) return;
      seen.add(i);
      order.push(i);
      edges.filter((e) => e.a === i || e.b === i).map((e) => (e.a === i ? e.b : e.a))
        .sort((x, y) => deg[x] - deg[y]).forEach(visit);
    };
    while (order.length < rels.length) {
      const start = rels.map((r) => r.idx).filter((i) => !seen.has(i)).sort((x, y) => deg[x] - deg[y] || x - y)[0];
      visit(start);
    }
    return { rels, byId, edges, complex, order };
  }

  function ndvAfter(rel, c, cat) {
    for (const f of rel.filters) {
      const p = f.pred;
      if (p.k === 'cmp' && p.op === '=' && p.l.k === 'col' && p.l.c === c && isLit(p.r)) return 1;
      if (p.k === 'in' && !p.not && p.e.k === 'col' && p.e.c === c) return Math.max(1, Math.min(p.list.length, rel.rows));
    }
    return Math.max(1, Math.min(cat.ndv(rel.table, c), rel.rows));
  }

  function rangeSel(c, rg, type, op, v) {
    const [mn, mx] = rg;
    if (type === 'int') {
      let lo = mn, hi = mx;
      if (op === '<') hi = Math.min(mx, Math.ceil(v) - 1);
      if (op === '<=') hi = Math.min(mx, Math.floor(v));
      if (op === '>') lo = Math.max(mn, Math.floor(v) + 1);
      if (op === '>=') lo = Math.max(mn, Math.ceil(v));
      const n = Math.max(0, hi - lo + 1), all = mx - mn + 1;
      return { sel: n / all, why: `${fmtInt(n)} of the ${fmtInt(all)} values ${fmtNum(mn)}…${fmtNum(mx)}` };
    }
    const lowSide = op === '<' || op === '<=';
    const s = clamp(lowSide ? (v - mn) / (mx - mn) : (mx - v) / (mx - mn), 0, 1);
    return { sel: s, why: lowSide ? `(${fmtNum(v)} − ${fmtNum(mn)}) / (${fmtNum(mx)} − ${fmtNum(mn)})` : `(${fmtNum(mx)} − ${fmtNum(v)}) / (${fmtNum(mx)} − ${fmtNum(mn)})` };
  }

  // Estimated fraction of a table's rows that pass condition e, with the reasoning.
  function selectivity(e, rel, cat) {
    const t = rel.table;
    const isCol = (x) => x.k === 'col' && x.t === rel.id;
    if (e.k === 'cmp' && isCol(e.l) && isLit(e.r)) {
      const c = e.l.c, v = e.r.v, ndv = cat.ndv(t, c), rg = cat.range(t, c);
      if (e.op === '=') return { sel: 1 / ndv, why: `1 / NDV(${c}) = 1 / ${fmtInt(ndv)}` };
      if (e.op === '<>') return { sel: 1 - 1 / ndv, why: `1 − 1 / NDV(${c}) = 1 − 1/${fmtInt(ndv)}` };
      if (rg && typeof v === 'number') return rangeSel(c, rg, cat.col(t, c).type, e.op, v);
      return { sel: 1 / 3, why: 'no range statistics for text: default guess 1/3' };
    }
    if (e.k === 'between' && isCol(e.e) && isLit(e.lo) && isLit(e.hi)) {
      const c = e.e.c, rg = cat.range(t, c);
      let r;
      if (rg && typeof e.lo.v === 'number' && typeof e.hi.v === 'number') {
        if (cat.col(t, c).type === 'int') {
          const lo = Math.max(rg[0], Math.ceil(e.lo.v)), hi = Math.min(rg[1], Math.floor(e.hi.v));
          const n = Math.max(0, hi - lo + 1), all = rg[1] - rg[0] + 1;
          r = { sel: n / all, why: `${fmtInt(n)} of the ${fmtInt(all)} values ${fmtNum(rg[0])}…${fmtNum(rg[1])}` };
        } else {
          r = { sel: clamp((e.hi.v - e.lo.v) / (rg[1] - rg[0]), 0, 1), why: `(${fmtNum(e.hi.v)} − ${fmtNum(e.lo.v)}) / (${fmtNum(rg[1])} − ${fmtNum(rg[0])})` };
        }
      } else r = { sel: 0.1, why: 'no range statistics for text: default guess 1/10' };
      return e.not ? { sel: 1 - r.sel, why: `1 − ${fmtSel(r.sel)} (NOT BETWEEN)` } : r;
    }
    if (e.k === 'in' && isCol(e.e) && e.list.every(isLit)) {
      const c = e.e.c, ndv = cat.ndv(t, c);
      const k = new Set(e.list.map((x) => x.v)).size;
      const s = Math.min(1, k / ndv);
      return e.not ? { sel: 1 - s, why: `1 − ${k} / NDV(${c})` } : { sel: s, why: `${k} values / NDV(${c}) = ${k} / ${fmtInt(ndv)}` };
    }
    if (e.k === 'like' && isCol(e.e)) {
      return e.not ? { sel: 0.95, why: 'no statistics for patterns: default guess 95%' } : { sel: 0.05, why: 'no statistics for patterns: default guess 5%' };
    }
    if (e.k === 'not') {
      const s = selectivity(e.e, rel, cat);
      return { sel: 1 - s.sel, why: `1 − ${fmtSel(s.sel)}` };
    }
    if (e.k === 'and') {
      const parts = e.args.map((a) => selectivity(a, rel, cat));
      return { sel: parts.reduce((p, x) => p * x.sel, 1), why: parts.map((x) => fmtSel(x.sel)).join(' × ') + ' (assumed independent)' };
    }
    if (e.k === 'or') {
      const parts = e.args.map((a) => selectivity(a, rel, cat));
      const s = parts.reduce((p, x) => p + x.sel - p * x.sel, 0);
      return { sel: s, why: `${parts.map((x) => fmtSel(x.sel)).join(' + ')} − overlap` };
    }
    return { sel: 1 / 3, why: 'no statistics for this kind of condition: default guess 1/3' };
  }

  // Column an index could search for this condition, or null.
  function sargCol(p, rel) {
    if (p.k === 'cmp' && p.l.k === 'col' && p.l.t === rel.id && isLit(p.r) && p.op !== '<>') return p.l.c;
    if (p.k === 'between' && !p.not && p.e.k === 'col' && p.e.t === rel.id && isLit(p.lo) && isLit(p.hi)) return p.e.c;
    if (p.k === 'in' && !p.not && p.e.k === 'col' && p.e.t === rel.id && p.list.every(isLit)) return p.e.c;
    return null;
  }

  function accessPaths(rel, cat, q) {
    const RPC = cat.randomPageCost;
    const t = rel.table;
    const seq = {
      kind: 'seq', name: 'Seq Scan', label: 'Seq Scan',
      cost: rel.pages * COST.seqPage + rel.N * COST.cpuTuple,
      formula: `${fmtInt(rel.pages)} page${rel.pages === 1 ? '' : 's'} × ${COST.seqPage.toFixed(1)} + ${fmtInt(rel.N)} rows × ${COST.cpuTuple}`,
      note: 'read every page in order, check every row',
    };
    const cands = [seq];
    const unusable = [];
    cat.indexesOf(t).forEach((c) => {
      const index = cat.indexName(t, c);
      const fs = rel.filters.filter((f) => sargCol(f.pred, rel) === c);
      if (!fs.length) {
        const other = rel.filters.find((f) => cols(f.pred).some((x) => x.c === c));
        unusable.push({ index, why: other ? `${str(other.pred, q)} can’t be searched with an index` : `no filter on ${c}` });
        return;
      }
      const sel = fs.reduce((p, f) => p * f.sel, 1);
      const k = Math.max(1, rel.N * sel);
      const clustered = cat.isClustered(t, c);
      const fetch = clustered ? Math.ceil(k / rel.perPage) : Math.ceil(k);
      const h = cat.height(t);
      cands.push({
        kind: 'index', name: 'Index Scan', label: `Index Scan · ${index}`, col: c, index, conds: fs.map((f) => f.pred),
        cost: RPC * (h + fetch) + COST.cpuTuple * k, k, fetch, h, clustered,
        formula: `(${h} index + ${fmtInt(fetch)} table page${fetch === 1 ? '' : 's'}) × ${RPC} + ${fmtInt(k)} rows × ${COST.cpuTuple}`,
        note: clustered
          ? `${fmtRows(k)} matching row${k < 1.5 ? '' : 's'}, stored together (table is kept in ${c} order)`
          : `${fmtRows(k)} matching row${k < 1.5 ? '' : 's'}, each on its own page: a random read per row`,
      });
    });
    let best = cands[0];
    cands.forEach((cd) => { if (cd.cost < best.cost) best = cd; });
    cands.forEach((cd) => { cd.best = cd === best; });
    rel.access = cands;
    rel.unusable = unusable;
    rel.best = best;
  }

  function edgeSel(e, G, cat, q) {
    const A = G.rels[e.a], B = G.rels[e.b];
    const parts = [];
    let sel = 1;
    if (e.semi && e.equi.length) {
      const T = A.sub ? A : B, M = A.sub ? B : A;
      const p = e.equi[0];
      const ny = ndvAfter(T, p[T.id].c, cat), nx = ndvAfter(M, p[M.id].c, cat);
      sel = Math.min(1, ny / nx);
      e.inner = T.idx;
      e.outerRel = M.idx;
      parts.push(`share of ${M.id} rows with a match ≈ NDV(${str(p[T.id], q)}) / NDV(${str(p[M.id], q)}) = ${fmtInt(ny)} / ${fmtInt(nx)}${ny > nx ? ' → capped at 1' : ''}`);
    } else {
      e.preds.forEach((c) => {
        if (isColEq(c)) {
          const ca = c.l.t === A.id ? c.l : c.r, cb = c.l.t === A.id ? c.r : c.l;
          const na = ndvAfter(A, ca.c, cat), nb = ndvAfter(B, cb.c, cat);
          sel *= 1 / Math.max(na, nb);
          parts.push(`1 / max(NDV(${str(ca, q)}), NDV(${str(cb, q)})) = 1 / ${fmtInt(Math.max(na, nb))}`);
        } else {
          sel *= 1 / 3;
          parts.push(`${str(c, q)}: default guess 1/3`);
        }
      });
    }
    e.sel = sel;
    e.why = parts.join(' · ');
  }

  const setLabel = (G, m) => `{${G.rels.filter((r) => m & r.mask).map((r) => r.id).join(', ')}}`;

  function planStr(p) {
    if (!p) return '';
    if (p.kind === 'scan') return p.rel.id;
    if (p.kind === 'join') {
      const w = (x) => (x.kind === 'join' ? `(${planStr(x)})` : planStr(x));
      return `${w(p.outer)} ${p.semi ? '⋉' : p.cross ? '×' : '⋈'} ${w(p.inner)}`;
    }
    return planStr(p.input);
  }

  const methodName = (p) => (p.cross ? 'Nested Loop (×)' : p.semi ? METHOD[p.method].semi : METHOD[p.method].name);
  const scanPlan = (r) => ({ kind: 'scan', rel: r, path: r.best, rows: r.rows, cost: r.best.cost, mask: r.mask });

  function makeSearch(G, cat) {
    const { rels, edges, complex } = G;
    const n = rels.length;
    const full = (1 << n) - 1;
    const RPC = cat.randomPageCost;
    const adj = rels.map(() => 0);
    edges.forEach((e) => {
      adj[e.a] |= 1 << e.b;
      adj[e.b] |= 1 << e.a;
    });
    const pop = (m) => { let c = 0; while (m) { m &= m - 1; c++; } return c; };
    const connected = (m) => {
      const start = m & -m;
      let seen = start, frontier = start;
      while (frontier) {
        let next = 0;
        for (let i = 0; i < n; i++) if (frontier & (1 << i)) next |= adj[i] & m;
        next &= ~seen;
        seen |= next;
        frontier = next;
      }
      return seen === m;
    };
    const rowsOf = (m) => {
      let r = 1;
      rels.forEach((x) => { if ((m & x.mask) && !x.sub) r *= x.rows; });
      if (rels.every((x) => !(m & x.mask) || x.sub)) rels.forEach((x) => { if (m & x.mask) r *= x.rows; });
      edges.forEach((e) => { if ((m >> e.a) & 1 && (m >> e.b) & 1) r *= e.sel; });
      complex.forEach((c) => { if ((m & c.mask) === c.mask) r *= c.sel; });
      return Math.max(1, r);
    };
    const between = (O, t) => edges.filter((e) => ((O >> e.a) & 1 && e.b === t.idx) || ((O >> e.b) & 1 && e.a === t.idx));
    const semiBlocked = (O) => rels.some((s) => s.sub && (O & s.mask) && edges.some((e) => e.semi && e.inner === s.idx && !((O >> e.outerRel) & 1)));

    // All join methods for outer plan P (rows ro) with base table t as the inner input.
    function candidates(P, ro, t, E) {
      const semi = E.some((e) => e.semi);
      const equi = [];
      E.forEach((e) => e.equi.forEach((p) => {
        const inner = p[t.id];
        const outer = Object.values(p).find((x) => x !== inner);
        equi.push({ inner, outer });
      }));
      const Co = P.cost, rt = t.rows, Ct = t.best.cost;
      const costs = {};
      costs.nl = { cost: Co + Ct + ro * rt * COST.cpuOp, formula: `${fmtCost(Co)} + ${fmtCost(Ct)} + ${fmtRows(ro)} × ${fmtRows(rt)} pairs × ${COST.cpuOp}` };
      const ip = equi.find((p) => cat.isIndexed(t.table, p.inner.c));
      if (ip) {
        const c = ip.inner.c;
        const kk = semi ? 1 : Math.max(1, t.N / cat.ndv(t.table, c));
        const fetch = cat.isClustered(t.table, c) ? Math.ceil(kk / t.perPage) : Math.ceil(kk);
        const h = cat.height(t.table);
        const probe = RPC * (h + fetch) + COST.cpuTuple * kk;
        costs.inl = { cost: Co + ro * probe, probe, kk, col: c, index: cat.indexName(t.table, c), pair: ip, formula: `${fmtCost(Co)} + ${fmtRows(ro)} lookups × ${fmtCost(probe)}` };
      } else {
        costs.inl = { na: equi.length ? `no index on ${t.id}.${equi[0].inner.c}` : 'needs an = condition' };
      }
      if (equi.length) {
        costs.hash = { cost: Co + Ct + COST.cpuTuple * (2 * rt + ro), formula: `${fmtCost(Co)} + ${fmtCost(Ct)} + (2 × ${fmtRows(rt)} + ${fmtRows(ro)}) × ${COST.cpuTuple}` };
        costs.merge = { cost: Co + Ct + sortCost(ro) + sortCost(rt) + COST.cpuTuple * (ro + rt), formula: `${fmtCost(Co)} + ${fmtCost(Ct)} + sort both + merge` };
      } else {
        costs.hash = { na: 'needs an = condition' };
        costs.merge = { na: 'needs an = condition' };
      }
      return { costs, semi, equi };
    }

    function joinPlan(P, ro, t, E, meth, c, semi, mask, rows) {
      let inner = scanPlan(t);
      if (meth === 'inl') {
        inner = { kind: 'scan', rel: t, path: { kind: 'probe', name: 'Index Scan', index: c.index, col: c.col, pair: c.pair }, rows: c.kk, loops: ro, cost: c.probe, mask: t.mask };
      }
      return { kind: 'join', method: meth, semi, outer: P, inner, rows, cost: c.cost, mask, preds: E.flatMap((e) => e.preds) };
    }

    return { n, full, pop, connected, rowsOf, between, semiBlocked, candidates, joinPlan };
  }

  function joinSearch(G, cat) {
    const S = makeSearch(G, cat);
    const { rels } = G;
    const best = {};
    const cells = [];
    const details = {};
    rels.forEach((r) => { best[r.mask] = scanPlan(r); });
    const masks = [];
    for (let m = 1; m <= S.full; m++) masks.push(m);
    masks.sort((a, b) => S.pop(a) - S.pop(b) || a - b);
    let considered = 0;
    masks.forEach((m) => {
      const k = S.pop(m);
      if (k === 1) {
        cells.push({ mask: m, level: 1, rows: best[m].rows, cost: best[m].cost, plan: best[m] });
        return;
      }
      if (!S.connected(m)) {
        cells.push({ mask: m, level: k, skip: true });
        return;
      }
      const rows = S.rowsOf(m);
      const list = [];
      rels.forEach((t) => {
        if (!(m & t.mask)) return;
        const O = m & ~t.mask;
        if (!best[O]) return;
        const E = S.between(O, t);
        const row = { outer: O, inner: t.idx, label: `${S.pop(O) > 1 ? '(' + planStr(best[O]) + ')' : planStr(best[O])} ⋈ ${t.id}`, costs: {} };
        if (!E.length) { row.na = 'no join condition: a cross product'; list.push(row); return; }
        if (S.semiBlocked(O)) { row.na = 'a subquery table can only be the inner input'; list.push(row); return; }
        const ro = best[O].rows;
        const cand = S.candidates(best[O], ro, t, E);
        row.costs = cand.costs;
        row.semi = cand.semi;
        if (cand.semi) row.label = row.label.replace(' ⋈ ', ' ⋉ ');
        row.E = E;
        row.ro = ro;
        list.push(row);
        // Also try the bigger side as the outer input (zig-zag): only a hash join changes,
        // because it builds its hash table on the inner input.
        if (S.pop(O) > 1 && !cand.semi && !rels.some((x) => x.sub && (O & x.mask))) {
          const P = best[O], ri = P.rows, Ct = t.best.cost;
          const swap = { outer: t.mask, inner: O, swapped: true, label: `${t.id} ⋈ (${planStr(P)})`, costs: {}, E, ro: t.rows };
          swap.costs.nl = { na: 'same as the other order' };
          swap.costs.inl = { na: 'inner is a join result: no index' };
          swap.costs.hash = cand.costs.hash.na != null ? { na: cand.costs.hash.na }
            : { cost: Ct + P.cost + COST.cpuTuple * (2 * ri + t.rows), formula: `${fmtCost(Ct)} + ${fmtCost(P.cost)} + (2 × ${fmtRows(ri)} + ${fmtRows(t.rows)}) × ${COST.cpuTuple}` };
          swap.costs.merge = { na: 'same as the other order' };
          list.push(swap);
        }
      });
      let win = null;
      list.forEach((row) => METHOD_KEYS.forEach((mk) => {
        const c = row.costs[mk];
        if (!c || c.na != null) return;
        considered++;
        if (!win || c.cost < win.cost) win = { row, meth: mk, cost: c.cost };
      }));
      if (!win) {
        cells.push({ mask: m, level: k, skip: true });
        return;
      }
      let t;
      if (win.row.swapped) {
        t = rels.find((x) => x.mask === win.row.outer);
        best[m] = { kind: 'join', method: 'hash', semi: false, outer: scanPlan(t), inner: best[win.row.inner], rows, cost: win.cost, mask: m, preds: win.row.E.flatMap((e) => e.preds) };
      } else {
        t = rels[win.row.inner];
        best[m] = S.joinPlan(best[win.row.outer], win.row.ro, t, win.row.E, win.meth, win.row.costs[win.meth], win.row.semi, m, rows);
      }
      win.row.best = win.meth;
      const rest = best[m & ~t.mask];
      const rowsWhy = `${fmtRows(rest.rows)} × ${fmtRows(t.sub ? 1 : t.rows)} × ${win.row.E.map((e) => fmtSel(e.sel)).join(' × ')}`;
      details[m] = { rows: list, win, rowsWhy, rowsN: rows };
      cells.push({ mask: m, level: k, rows, cost: best[m].cost, plan: best[m] });
    });

    // Tables that no condition connects: combine the pieces with cross products.
    let cross = null;
    if (!best[S.full]) {
      const comps = [];
      let left = S.full;
      while (left) {
        let m = left & -left;
        for (;;) {
          let grow = m;
          G.edges.forEach((e) => {
            if ((m >> e.a) & 1) grow |= 1 << e.b;
            if ((m >> e.b) & 1) grow |= 1 << e.a;
          });
          if (grow === m) break;
          m = grow;
        }
        comps.push(m);
        left &= ~m;
      }
      comps.sort((a, b) => best[a].rows - best[b].rows);
      let P = best[comps[0]];
      let mask = comps[0];
      for (let i = 1; i < comps.length; i++) {
        const I = best[comps[i]];
        mask |= comps[i];
        P = { kind: 'join', method: 'nl', cross: true, outer: P, inner: I, rows: S.rowsOf(mask), cost: P.cost + I.cost + P.rows * I.rows * COST.cpuOp, mask, preds: [] };
      }
      best[S.full] = P;
      cross = { comps: comps.map((m) => setLabel(G, m)) };
    }
    return { best, cells, details, considered, cross, search: S };
  }

  // What a planner without statistics would do: FROM order, an index whenever one fits.
  function rulesOnly(G, S, cat) {
    const order = [...G.rels].sort((a, b) => (a.sub - b.sub) || (a.idx - b.idx));
    const acc = (r) => r.access.find((a) => a.kind === 'index') || r.access[0];
    const first = order[0];
    let P = { kind: 'scan', rel: first, rows: first.rows, cost: acc(first).cost, mask: first.mask };
    const steps = [`${first.id}: ${acc(first).kind === 'index' ? 'index' : 'seq scan'}`];
    for (let i = 1; i < order.length; i++) {
      const t = order[i];
      const m = P.mask | t.mask;
      const rows = S.rowsOf(m);
      const E = S.between(P.mask, t);
      const ct = acc(t).cost;
      let cost, how;
      if (!E.length) {
        cost = P.cost + ct + P.rows * t.rows * COST.cpuOp;
        how = 'nested loop (×)';
      } else {
        const tt = { ...t, best: acc(t) };
        const c = S.candidates(P, P.rows, tt, E).costs;
        if (c.inl.na == null) { cost = c.inl.cost; how = 'index nested loop'; } else if (c.hash.na == null) { cost = c.hash.cost; how = 'hash join'; } else { cost = c.nl.cost; how = 'nested loop'; }
      }
      P = { kind: 'join', rows, cost, mask: m };
      steps.push(`${t.id}: ${how}`);
    }
    return { cost: P.cost, rows: P.rows, desc: `${order.map((r) => r.id).join(' → ')}, index whenever one exists`, steps };
  }

  function topPlan(p, q, G, cat) {
    let root = p;
    const ndvOf = (col) => {
      const r = G.byId[col.t];
      return r ? ndvAfter(r, col.c, cat) : 1;
    };
    if (q.aggregate) {
      const groups = q.group.length ? Math.min(root.rows, q.group.reduce((x, g) => x * ndvOf(g), 1)) : 1;
      root = { kind: 'agg', input: root, rows: Math.max(1, groups), cost: root.cost + COST.cpuTuple * root.rows };
    }
    if (q.distinct) {
      const cs = q.star ? [] : q.items.flatMap((it) => cols(it.expr));
      const d = cs.length ? cs.reduce((x, c) => x * ndvOf(c), 1) : root.rows;
      root = { kind: 'distinct', input: root, rows: Math.max(1, Math.min(root.rows, d)), cost: root.cost + COST.cpuTuple * root.rows };
    }
    if (q.order.length) root = { kind: 'sort', input: root, rows: root.rows, cost: root.cost + sortCost(root.rows) };
    if (q.limit != null) root = { kind: 'limit', input: root, rows: Math.min(q.limit, root.rows), cost: root.cost };
    return { kind: 'project', input: root, rows: root.rows, cost: root.cost };
  }

  function filterText(p, q, skip) {
    const fs = p.rel.filters.map((f) => f.pred).filter((x) => !(skip || []).includes(x));
    return fs.length ? fs.map((x) => str(x, q)).join(' AND ') : '';
  }

  function planCard(p, q) {
    const foot = `≈${fmtRows(p.rows)} rows · cost ${fmtCost(p.cost)}`;
    switch (p.kind) {
      case 'scan': {
        const r = p.rel;
        if (p.path.kind === 'probe') {
          const f = filterText(p, q);
          return {
            id: `scan:${r.id}`, rows: p.rows * p.loops, tone: 'index', sym: 'table', head: 'Index Scan', code: [`${r.name} · ${p.path.index}`],
            note: `lookup: ${str(p.path.pair.inner, q)} = ${str(p.path.pair.outer, q)}${f ? ` · then ${f}` : ''}`,
            foot: `${fmtRows(p.loops)} lookups × ≈${fmtRows(p.rows)} row${p.rows < 1.5 ? '' : 's'}`, kids: [],
          };
        }
        if (p.path.kind === 'index') {
          const f = filterText(p, q, p.path.conds);
          return {
            id: `scan:${r.id}`, rows: p.rows, tone: 'index', sym: 'table', head: 'Index Scan', code: [`${r.name} · ${p.path.index}`],
            note: `search: ${p.path.conds.map((x) => str(x, q)).join(' AND ')}${f ? ` · then ${f}` : ''}`, foot, kids: [],
          };
        }
        const f = filterText(p, q);
        return { id: `scan:${r.id}`, rows: p.rows, tone: 'seq', sym: 'table', head: 'Seq Scan', code: [r.name], note: f ? `filter: ${f}` : 'no filter', foot, kids: [] };
      }
      case 'join':
        return {
          id: `pj:${p.mask}`, rows: p.rows, tone: p.cross ? 'product' : 'join', sym: p.semi ? '⋉' : p.cross ? '×' : '⋈', head: methodName(p),
          code: p.preds.length ? predLines(andAll(p.preds), q) : null, note: p.cross ? 'every row × every row' : null, foot,
          kids: [planCard(p.outer, q), planCard(p.inner, q)], innerTag: p.method === 'hash' && !p.cross ? 'build' : p.method === 'inl' ? 'lookups' : null,
        };
      case 'agg':
        return { id: 'n:agg', rows: p.rows, tone: 'agg', sym: 'γ', head: q.group.length ? 'Hash Aggregate' : 'Aggregate', code: aggText(q), foot, kids: [planCard(p.input, q)] };
      case 'distinct':
        return { id: 'n:dist', rows: p.rows, tone: 'project', sym: 'δ', head: 'Hash Distinct', foot, kids: [planCard(p.input, q)] };
      case 'sort':
        return { id: 'n:sort', rows: p.rows, tone: 'sort', sym: '↓', head: 'Sort', code: [orderText(q)], foot, kids: [planCard(p.input, q)] };
      case 'limit':
        return { id: 'n:limit', rows: p.rows, tone: 'sort', sym: '#', head: `Limit ${q.limit}`, foot: `${fmtRows(p.rows)} rows`, kids: [planCard(p.input, q)] };
      case 'project':
        return { id: 'n:proj', rows: p.rows, tone: 'project', sym: 'π', head: 'Output', code: [itemsText(q)], kids: [planCard(p.input, q)] };
      case 'empty':
        return { id: 'n:empty', rows: 0, tone: 'empty', sym: '∅', head: 'Result (empty)', note: 'no table is read', foot: 'cost 0', kids: [] };
      default: return null;
    }
  }

  // EXPLAIN-style text, like PostgreSQL prints it.
  function explain(p, q) {
    const out = [];
    const c = (x) => `(cost=${fmtCost(x.cost)} rows=${fmtInt(Math.max(1, x.rows))})`;
    function node(x, L, arrow) {
      const pad = (k) => ' '.repeat(Math.max(0, k));
      const head = (label, extra) => out.push(pad(L - (arrow ? 4 : 0)) + (arrow ? '->  ' : '') + label + (extra ? '  ' + extra : ''));
      const det = (d) => out.push(pad(L + 2) + d);
      switch (x.kind) {
        case 'project': return node(x.input, L, arrow);
        case 'limit': head('Limit', c(x)); return node(x.input, L + 6, true);
        case 'sort': head('Sort', c(x)); det(`Sort Key: ${orderText(q)}`); return node(x.input, L + 6, true);
        case 'agg': head(q.group.length ? 'HashAggregate' : 'Aggregate', c(x)); if (q.group.length) det(`Group Key: ${q.group.map((g) => str(g, q)).join(', ')}`); return node(x.input, L + 6, true);
        case 'distinct': head('HashAggregate', c(x)); det('(distinct)'); return node(x.input, L + 6, true);
        case 'empty': head('Result', '(cost=0 rows=0)'); det('One-Time Filter: false'); return;
        case 'scan': {
          const r = x.rel;
          if (x.path.kind === 'probe') {
            head(`Index Scan using ${x.path.index} on ${r.name}`, `(cost=${fmtCost(x.cost)} rows=${fmtInt(Math.max(1, x.rows))} loops=${fmtInt(x.loops)})`);
            det(`Index Cond: (${str(x.path.pair.inner, q)} = ${str(x.path.pair.outer, q)})`);
            const f = filterText(x, q);
            if (f) det(`Filter: (${f})`);
            return;
          }
          if (x.path.kind === 'index') {
            head(`Index Scan using ${x.path.index} on ${r.name}`, c(x));
            det(`Index Cond: (${x.path.conds.map((y) => str(y, q)).join(' AND ')})`);
            const f = filterText(x, q, x.path.conds);
            if (f) det(`Filter: (${f})`);
            return;
          }
          head(`Seq Scan on ${r.name}`, c(x));
          const f = filterText(x, q);
          if (f) det(`Filter: (${f})`);
          return;
        }
        case 'join': {
          const cond = x.preds.length ? `(${x.preds.map((y) => str(y, q)).join(' AND ')})` : '';
          if (x.method === 'hash') {
            head(x.semi ? 'Hash Semi Join' : 'Hash Join', c(x));
            if (cond) det(`Hash Cond: ${cond}`);
            node(x.outer, L + 6, true);
            out.push(pad(L + 2) + '->  Hash');
            return node(x.inner, L + 12, true);
          }
          if (x.method === 'merge') {
            head(x.semi ? 'Merge Semi Join' : 'Merge Join', c(x));
            if (cond) det(`Merge Cond: ${cond}`);
            out.push(pad(L + 2) + '->  Sort');
            node(x.outer, L + 12, true);
            out.push(pad(L + 2) + '->  Sort');
            return node(x.inner, L + 12, true);
          }
          head(x.semi ? 'Nested Loop Semi Join' : 'Nested Loop', c(x));
          if (x.method === 'nl' && cond) det(`Join Filter: ${cond}`);
          node(x.outer, L + 6, true);
          if (x.method === 'nl' && x.inner.kind === 'scan') {
            out.push(pad(L + 2) + '->  Materialize');
            return node(x.inner, L + 12, true);
          }
          return node(x.inner, L + 6, true);
        }
        default: return undefined;
      }
    }
    node(p, 0, false);
    return out;
  }

  function graphScene(G, q, o) {
    o = o || {};
    const nodes = G.order.map((i) => {
      const r = G.rels[i];
      const est = o.est && o.est.has(r.idx);
      const acc = o.acc && o.acc.has(r.idx);
      return {
        id: `scan:${r.id}`, tone: 'scan', sym: 'table', head: r.name, tag: r.sub ? 'subquery' : null,
        code: r.filters.length ? r.filters.map((f) => str(f.pred, q) + (f.derived ? '  (derived)' : '')) : null,
        note: est ? `${fmtInt(r.N)} rows → ≈${fmtRows(r.rows)}` : `${fmtInt(r.N)} rows · ${fmtInt(r.pages)} page${r.pages === 1 ? '' : 's'}`,
        foot: acc ? `${r.best.label} · cost ${fmtCost(r.best.cost)}` : null,
        footTone: acc ? (r.best.kind === 'index' ? 'index' : 'seq') : null,
      };
    });
    const edges = G.edges.map((e) => ({
      id: e.id, a: `scan:${G.rels[e.a].id}`, b: `scan:${G.rels[e.b].id}`,
      label: e.preds.map((p) => str(p, q)).join(' AND '),
      kind: e.semi ? 'semi' : e.equi.length ? 'equi' : 'theta',
      sub: o.sel ? `sel ${fmtSel(e.sel)}` : null,
    }));
    return { kind: 'graph', nodes, edges, cross: !!o.cross };
  }

  function statsBoard(G, q, cat) {
    return G.rels.map((r) => {
      const used = new Set();
      r.filters.forEach((f) => cols(f.pred).forEach((c) => used.add(c.c)));
      G.edges.forEach((e) => e.preds.forEach((p) => cols(p).forEach((c) => { if (c.t === r.id) used.add(c.c); })));
      return {
        name: r.name, rows: r.N, pages: r.pages, perPage: r.perPage,
        cols: cat.columns(r.table).filter((c) => used.has(c)).map((c) => {
          const rg = cat.range(r.table, c);
          return { name: c, ndv: cat.ndv(r.table, c), range: rg ? `${fmtNum(rg[0])} … ${fmtNum(rg[1])}` : 'text', indexed: cat.isIndexed(r.table, c), index: cat.isIndexed(r.table, c) ? cat.indexName(r.table, c) : null };
        }),
        indexes: cat.indexesOf(r.table).map((c) => cat.indexName(r.table, c)),
      };
    });
  }

  function plan(tree, q, cat, R) {
    const G = extract(tree, q, cat);
    const { rels } = G;
    const n = rels.length;
    const RPC = cat.randomPageCost;
    rels.forEach((r) => {
      r.filters.forEach((f) => Object.assign(f, selectivity(f.pred, r, cat)));
      r.sel = r.filters.reduce((p, f) => p * f.sel, 1);
      r.rows = Math.max(1, r.N * r.sel);
    });
    rels.forEach((r) => accessPaths(r, cat, q));
    G.edges.forEach((e) => edgeSel(e, G, cat, q));

    const est = new Set(), acc = new Set();
    const gs = (o) => graphScene(G, q, { est: new Set(est), acc: new Set(acc), ...o });
    const edgeText = G.edges.map((e) => e.preds.map((p) => str(p, q)).join(' AND '));

    R.add({
      phase: 'plan', title: 'Planner: tables and join conditions', line: 4, dur: 1400,
      msg: n === 1
        ? `The planner (CBO) takes over. With one table there is no join order to choose, only how to read ${rels[0].name}.`
        : `The planner (CBO) takes over. It flattens the tree into ${n} tables, each with its own filters, linked by ${G.edges.length} join condition${G.edges.length === 1 ? '' : 's'}. The tree’s join order is not final: the planner will try the orders and keep the cheapest.`,
      scene: gs(), board: {
        kind: 'graph',
        tables: rels.map((r) => ({ name: r.name, filters: r.filters.map((f) => str(f.pred, q) + (f.derived ? ' (derived)' : '')), sub: r.sub })),
        edges: edgeText, complex: G.complex.map((c) => str(c.pred, q)),
      },
    });

    R.add({
      phase: 'plan', title: 'Read the statistics', line: 4, dur: 700,
      msg: 'Costs need numbers. The catalog keeps statistics, refreshed by ANALYZE: rows and pages of each table, the number of distinct values (NDV) and min … max of each column, and which indexes exist. The rewriter never looked at any of this.',
      scene: gs(), hl: Object.fromEntries(rels.map((r) => [`scan:${r.id}`, 'focus'])),
      board: { kind: 'stats', tables: statsBoard(G, q, cat), rpc: RPC, storage: cat.storage },
    });

    rels.forEach((r) => {
      const node = `scan:${r.id}`;
      const tb = (show) => ({
        kind: 'table', show, name: r.name, N: r.N, pages: r.pages, perPage: r.perPage,
        filters: r.filters.map((f) => ({ text: str(f.pred, q), sel: f.sel, why: f.why, derived: f.derived })),
        sel: r.sel, rows: r.rows,
        cands: r.access.map((a) => ({ label: a.label, kind: a.kind, cost: a.cost, formula: a.formula, note: a.note, best: a.best })),
        unusable: r.unusable, rpc: RPC,
      });
      if (r.filters.length) {
        est.add(r.idx);
        R.add({
          phase: 'plan', title: `${r.id}: estimate rows`, line: 6, dur: 900,
          msg: `How many ${r.name} rows survive ${r.filters.length === 1 ? 'its filter' : 'its filters'}? From the statistics: selectivity ${fmtSel(r.sel)} × ${fmtInt(r.N)} rows ≈ ${rowsTxt(r.rows)}.${r.filters.length > 1 ? ' (Filters are assumed to be independent, so their selectivities are multiplied.)' : ''}`,
          scene: gs(), hl: { [node]: 'focus' }, board: tb('est'),
        });
      } else est.add(r.idx);
      acc.add(r.idx);
      const b = r.best;
      const idx = r.access.filter((a) => a.kind === 'index');
      let msg;
      if (b.kind === 'index') {
        msg = `${r.name}: the index ${b.index} jumps straight to the ≈${fmtRows(b.k)} matching row${b.k < 1.5 ? '' : 's'}, cost ${fmtCost(b.cost)}, against ${fmtCost(r.access[0].cost)} for reading all ${fmtInt(r.pages)} pages. Index Scan wins.`;
      } else if (idx.length) {
        const i0 = idx[0];
        msg = `${r.name}: an index on ${i0.col} exists, but ≈${fmtRows(i0.k)} rows match and each needs its own random page read (cost ${fmtCost(i0.cost)}). Reading all ${fmtInt(r.pages)} pages in order is cheaper (${fmtCost(b.cost)}): Seq Scan wins, the index is ignored.`;
      } else if (!r.filters.length) {
        msg = `${r.name} has no filter: all ${fmtInt(r.N)} rows are needed, so the only sensible way is a Seq Scan, cost ${fmtCost(b.cost)}.`;
      } else {
        const on = cat.indexesOf(r.table);
        msg = `${r.name}: no index fits ${r.filters.length === 1 ? 'its filter' : 'its filters'}${on.length ? ` (there are indexes only on ${on.join(', ')})` : ' (the table has no index)'}, so the only access path is a Seq Scan, cost ${fmtCost(b.cost)}.`;
      }
      R.add({ phase: 'plan', title: `${r.id}: choose access path`, line: 7, dur: 1000, msg, scene: gs(), hl: { [node]: 'good' }, board: tb('acc') });
    });

    let root;
    let dp = null;
    if (n === 1) {
      root = scanPlan(rels[0]);
    } else {
      dp = joinSearch(G, cat);
      const lattice = (cur) => ({
        kind: 'dp', current: cur,
        cells: dp.cells.map((c) => ({
          label: setLabel(G, c.mask), level: c.level, skip: !!c.skip,
          rows: c.rows, cost: c.cost, plan: c.plan ? planStr(c.plan) : '',
          method: c.plan && c.plan.kind === 'join' ? METHOD[c.plan.method].short : c.plan ? c.plan.path.name : '',
          state: c.skip ? 'skip' : c.level === 1 ? 'done' : cur == null ? 'pending' : c.mask === cur ? 'current' : dp.cells.findIndex((x) => x.mask === c.mask) < dp.cells.findIndex((x) => x.mask === cur) ? 'done' : 'pending',
          mask: c.mask,
        })),
      });
      const skipped = dp.cells.filter((c) => c.skip).length;
      R.add({
        phase: 'plan', title: 'Join order: dynamic programming', line: 8, dur: 900,
        msg: `Join order matters most. The planner builds it bottom-up: the best plan for each single table is known; next it finds the best plan for every pair of tables, then every set of 3, …, always reusing the best smaller plans.${skipped ? ` ${skipped} set${skipped === 1 ? ' has' : 's have'} no join condition inside (they’d need a cross product) and ${skipped === 1 ? 'is' : 'are'} skipped.` : ''}`,
        scene: gs({ sel: true }), board: lattice(null),
      });
      dp.cells.forEach((c) => {
        if (c.level < 2 || c.skip) return;
        const d = dp.details[c.mask];
        const w = d.win;
        const t = rels[w.row.inner];
        const valid = d.rows.reduce((k, row) => k + METHOD_KEYS.filter((mk) => row.costs[mk] && row.costs[mk].na == null).length, 0);
        const hl = {};
        rels.forEach((r) => { hl[`scan:${r.id}`] = c.mask & r.mask ? 'focus' : 'dim'; });
        G.edges.forEach((e) => { hl[e.id] = (c.mask >> e.a) & 1 && (c.mask >> e.b) & 1 ? 'focus' : 'dim'; });
        const label = setLabel(G, c.mask);
        const bestName = w.row.semi ? METHOD[w.meth].semi : METHOD[w.meth].name;
        R.add({
          phase: 'plan', title: `Best plan for ${label}`, line: 11, dur: 900,
          msg: `${label}: ${valid} candidate plans (each order × each join method). Cheapest: ${bestName} of ${w.row.label}, cost ${fmtCost(w.cost)}, ≈${rowsTxt(c.rows)}. ${c.level > 2 ? `It reuses the best plan already found for ${setLabel(G, w.row.swapped ? w.row.inner : w.row.outer)}. ` : ''}Only this winner is kept for ${label}; the others are pruned.`,
          scene: gs({ sel: true }), hl,
          board: {
            ...lattice(c.mask),
            detail: {
              label, rows: c.rows, rowsWhy: d.rowsWhy,
              rows2: d.rows.map((row) => ({
                label: row.label, na: row.na || null, best: row.best || null,
                costs: METHOD_KEYS.map((mk) => {
                  const x = row.costs[mk];
                  if (!x) return { key: mk, na: '' };
                  return x.na != null ? { key: mk, na: x.na } : { key: mk, cost: x.cost, formula: x.formula, win: row.best === mk };
                }),
              })),
              win: { label: w.row.label, method: bestName, cost: w.cost },
            },
          },
        });
      });
      root = dp.best[(1 << n) - 1];
      if (dp.cross) {
        R.add({
          phase: 'plan', title: 'Cross product needed', status: 'warn', line: 11, dur: 900,
          msg: `No join condition connects ${dp.cross.comps.join(' and ')}. The planner has no choice but a cross product, every row paired with every row (≈${fmtRows(root.rows)} rows). Check the query for a missing join condition.`,
          scene: gs({ sel: true, cross: true }), board: lattice(null),
        });
      }
    }

    const top = topPlan(root, q, G, cat);
    const S = dp ? dp.search : makeSearch(G, cat);
    const rules = rulesOnly(G, S, cat);
    const rulesTop = topPlan({ ...root, cost: rules.cost, rows: rules.rows }, q, G, cat);
    const naiveRows = rels.filter((r) => !r.sub).reduce((p, r) => p * r.N, 1);
    const decisions = [];
    rels.forEach((r) => {
      const b = r.best;
      const ix = r.access.find((a) => a.kind === 'index' && !a.best);
      decisions.push({
        what: r.name,
        choice: b.kind === 'index' ? `Index Scan (${b.index})` : 'Seq Scan',
        why: b.kind === 'index' ? `≈${fmtRows(b.k)} matching rows: cheaper than reading ${fmtInt(r.pages)} pages`
          : ix ? `index on ${ix.col} ignored: ≈${fmtRows(ix.k)} rows match, too many` : r.filters.length ? 'no index fits the filter' : 'every row is needed',
      });
    });
    const joins = [];
    (function collect(p) {
      if (p.kind !== 'join') return;
      collect(p.outer);
      joins.push(p);
    })(root);
    joins.forEach((j) => decisions.push({ what: planStr(j), choice: methodName(j), why: `≈${fmtRows(j.rows)} rows · cost ${fmtCost(j.cost)}` }));
    const finalScene = { kind: 'plan', roots: [planCard(top, q)] };
    const ratio = rulesTop.cost / top.cost;
    R.add({
      phase: 'done', title: 'The execution plan', status: 'success', line: 12, dur: 1600,
      msg: `Chosen plan: ${n > 1 ? planStr(root) + ', ' : ''}total cost ${fmtCost(top.cost)}, ≈${rowsTxt(top.rows)} in the result.${ratio > 1.05 ? ` A planner with rules only (FROM order, always use an index) would pay ${fmtCost(rulesTop.cost)}, ${times(rulesTop.cost, top.cost)}× more.` : ' Here the rules-only plan happens to cost the same.'} The plan now goes to the executor.`,
      scene: finalScene,
      board: {
        kind: 'final', cost: top.cost, rows: top.rows, plan: n > 1 ? planStr(root) : rels[0].id,
        rules: { cost: rulesTop.cost, desc: rules.desc }, naive: { rows: naiveRows, tables: rels.filter((r) => !r.sub).map((r) => fmtInt(r.N)) },
        decisions, explain: explain(top, q), considered: dp ? dp.considered : rels[0].access.length,
      },
    });
  }

  function planEmpty(tree, q, cat, R) {
    let root = { kind: 'empty', rows: 0, cost: 0 };
    if (q.aggregate) root = { kind: 'agg', input: root, rows: q.group.length ? 0 : 1, cost: 0 };
    if (q.order.length) root = { kind: 'sort', input: root, rows: root.rows, cost: 0 };
    if (q.limit != null) root = { kind: 'limit', input: root, rows: 0, cost: 0 };
    root = { kind: 'project', input: root, rows: root.rows, cost: 0 };
    R.add({
      phase: 'done', title: 'The execution plan', status: 'success', line: 12, dur: 1200,
      msg: 'No planning needed: the rewriter proved that no row can match, so the plan is a constant empty result with cost 0. Not a single page is read.',
      scene: { kind: 'plan', roots: [planCard(root, q)] },
      board: { kind: 'final', empty: true, cost: 0, rows: 0, explain: explain(root, q), decisions: [] },
    });
  }

  // ---------- Entry point ----------

  function optimize(sql, cat) {
    const R = new Recorder();
    const out = { steps: R.steps, phaseStart: R.phaseStart, error: null };
    let ast;
    try {
      ast = Q.parse(sql);
    } catch (err) {
      if (!(err instanceof Q.SqlError)) throw err;
      out.error = errInfo(err, sql);
      R.add({
        phase: 'parse', title: 'Syntax error', status: 'error', line: 1,
        msg: `The parser stops: ${err.message}.${err.hint ? ' ' + err.hint : ''}`,
        board: { kind: 'error', stage: 'Parser', err: out.error },
      });
      return out;
    }

    R.add({
      phase: 'parse', title: 'Parse the SQL text', line: 1, dur: 700,
      msg: `The parser checks the grammar and cuts the query into clauses: ${clauseRows(ast).map((r) => r.kw).join(', ')}. So far these are just words, nothing is known about the tables yet.`,
      scene: { kind: 'list', cards: clauseCards(ast, null) },
      board: { kind: 'clauses', rows: clauseRows(ast) },
    });

    let q;
    try {
      q = Q.bind(ast, cat);
    } catch (err) {
      if (!(err instanceof Q.SqlError)) throw err;
      out.error = errInfo(err, sql);
      R.add({
        phase: 'parse', title: 'Name error', status: 'error', line: 1,
        msg: `Binding stops: ${err.message}.${err.hint ? ' ' + err.hint : ''}`,
        scene: { kind: 'list', cards: clauseCards(ast, null) },
        board: { kind: 'error', stage: 'Binder', err: out.error, tables: cat.tables().map((t) => ({ name: t, cols: cat.columns(t) })) },
      });
      return out;
    }
    // Bound text of each ON condition and of WHERE, for the clause cards.
    let k = 0;
    q.onText = ast.from.map((ref) => {
      if (!ref.on) return null;
      const n = conj(ref.on).length;
      const t = q.conds.slice(k, k + n).map((c) => str(c, q)).join(' AND ');
      k += n;
      return t;
    });
    q.whereText = predLines(andAll(q.conds.slice(k)) || Q.TRUE, q);
    q.whereText = q.whereText.map((l) => l.replace(/IN \(SELECT (.*) …\)/, (m0, c) => `IN (SELECT ${c} FROM ${q.subs.map((s) => q.rel[s.rel].name).join(', ')} …)`));

    const tables = q.rels.filter((r) => !r.sub).map((r) => r.name);
    const colB = q.bindings.filter((b) => b.kind === 'col' && !b.text.includes('.'));
    R.add({
      phase: 'parse', title: 'Bind names to the catalog', line: 1, dur: 800,
      msg: `Binding looks every name up in the catalog: ${tables.join(', ')} ${tables.length === 1 ? 'is a table' : 'are tables'}, and each column is tied to its table${colB.length ? ` (e.g. ${colB[0].text} → ${colB[0].to})` : ''}. A misspelt or ambiguous name would stop here.`,
      scene: { kind: 'list', cards: clauseCards(ast, q) },
      hl: Object.fromEntries(clauseCards(ast, q).map((c) => [c.id, 'good'])),
      board: { kind: 'bind', rows: q.bindings },
    });

    const tree = canonical(q);
    const prodRows = q.main.reduce((p, id) => p * cat.rows(q.rel[id].table), 1);
    const hasOn = ast.from.some((r) => r.on);
    R.add({
      phase: 'parse', title: 'Build the canonical query tree', line: 1, dur: 1500,
      msg: `The clauses become a query tree, read bottom-up: ${q.main.length > 1 ? 'the FROM tables are combined with × (every row with every row), ' : 'the table is read, '}${q.pred ? `σ keeps rows that satisfy WHERE${hasOn ? ' and the ON conditions' : ''}, ` : ''}π picks the output columns.${q.main.length > 1 ? ` Run exactly as written, × alone would build ${fmtBig(prodRows)} rows!` : ''}`,
      scene: treeScene(tree, q, cat),
      board: {
        kind: 'canonical',
        proj: itemsText(q), pred: q.pred ? conj(q.pred).map((c) => str(c, q)) : [],
        from: q.main.map((id) => q.rel[id].name), top: [q.aggregate ? 'γ' : null, q.distinct ? 'δ' : null, q.order.length ? 'sort' : null, q.limit != null ? 'limit' : null].filter(Boolean),
        prodRows, sizes: q.main.map((id) => fmtInt(cat.rows(q.rel[id].table))), subs: q.subs.length,
      },
    });

    const rw = new Rewriter(tree, q, cat, R);
    const empty = rw.run();
    if (empty) planEmpty(tree, q, cat, R);
    else plan(tree, q, cat, R);
    return out;
  }

  global.QoEngine = { optimize, RULES, PSEUDO, COST, METHOD, fmtInt, fmtRows, fmtCost, fmtSel, fmtBig };
})(window);
