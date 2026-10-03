/*
 * SQL front end for the query optimizer demo: the sample catalog (tables,
 * statistics, indexes), a tokenizer and parser for a small SQL subset, name
 * binding, and expression helpers (printing, constant folding).
 */
(function (global) {
  'use strict';

  // ---------- Catalog: a small university database ----------

  // ndv = number of distinct values. `unique` columns hold a different value in
  // every row; `fk` columns take their values from another table's id.
  const TABLES = {
    students: {
      rows: 10000, perPage: 50, pk: 'id',
      cols: {
        id: { type: 'int', unique: true },
        name: { type: 'text', ndv: 9000, sample: "'Nimal'" },
        dept_id: { type: 'int', fk: 'departments' },
        year: { type: 'int', ndv: 4, min: 1, max: 4 },
        gpa: { type: 'num', ndv: 301, min: 1, max: 4 },
      },
    },
    departments: {
      rows: 20, perPage: 40, pk: 'id',
      cols: {
        id: { type: 'int', unique: true },
        name: { type: 'text', unique: true, sample: "'Physics'" },
        building: { type: 'text', ndv: 6, sample: "'Science'" },
        budget: { type: 'int', ndv: 20, min: 100000, max: 2000000 },
      },
    },
    courses: {
      rows: 400, perPage: 40, pk: 'id',
      cols: {
        id: { type: 'int', unique: true },
        title: { type: 'text', unique: true, sample: "'Databases'" },
        dept_id: { type: 'int', fk: 'departments' },
        credits: { type: 'int', ndv: 4, min: 1, max: 4 },
      },
    },
    enrollments: {
      rows: 200000, perPage: 100, pk: null,
      cols: {
        student_id: { type: 'int', fk: 'students' },
        course_id: { type: 'int', fk: 'courses' },
        grade: { type: 'text', ndv: 5, sample: "'A'" },
        score: { type: 'int', ndv: 101, min: 0, max: 100 },
      },
    },
  };

  const DEFAULT_INDEXES = ['students.id', 'students.year', 'departments.id', 'courses.id', 'enrollments.student_id'];
  const FANOUT = 200; // index entries per index page
  const MAX_RELS = 5;

  class Catalog {
    constructor(state) {
      this.rowsOver = {};
      this.indexes = new Set(DEFAULT_INDEXES);
      this.storage = 'hdd';
      if (state) this.load(state);
    }

    load(s) {
      if (s.rows) Object.keys(s.rows).forEach((t) => { if (TABLES[t] && s.rows[t] > 0) this.rowsOver[t] = Math.round(s.rows[t]); });
      if (Array.isArray(s.indexes)) {
        this.indexes = new Set(s.indexes.filter((k) => { const [t, c] = k.split('.'); return TABLES[t] && TABLES[t].cols[c]; }));
        Object.keys(TABLES).forEach((t) => { if (TABLES[t].pk) this.indexes.add(`${t}.${TABLES[t].pk}`); });
      }
      if (s.storage === 'ssd' || s.storage === 'hdd') this.storage = s.storage;
    }

    save() { return { rows: { ...this.rowsOver }, indexes: [...this.indexes], storage: this.storage }; }

    reset() {
      this.rowsOver = {};
      this.indexes = new Set(DEFAULT_INDEXES);
    }

    get randomPageCost() { return this.storage === 'ssd' ? 1.1 : 4.0; }
    tables() { return Object.keys(TABLES); }
    has(t) { return Object.prototype.hasOwnProperty.call(TABLES, t); }
    columns(t) { return Object.keys(TABLES[t].cols); }
    hasCol(t, c) { return Object.prototype.hasOwnProperty.call(TABLES[t].cols, c); }
    col(t, c) { return TABLES[t].cols[c]; }
    pk(t) { return TABLES[t].pk; }
    rows(t) { return this.rowsOver[t] || TABLES[t].rows; }
    defaultRows(t) { return TABLES[t].rows; }
    perPage(t) { return TABLES[t].perPage; }
    pages(t) { return Math.max(1, Math.ceil(this.rows(t) / TABLES[t].perPage)); }

    ndv(t, c) {
      const d = TABLES[t].cols[c];
      const n = this.rows(t);
      if (d.unique) return n;
      if (d.fk) return Math.min(this.rows(d.fk), n);
      return Math.min(d.ndv, n);
    }

    // [min, max] for number columns, null for text.
    range(t, c) {
      const d = TABLES[t].cols[c];
      if (d.type === 'text') return null;
      if (d.unique) return [1, this.rows(t)];
      if (d.fk) return [1, this.rows(d.fk)];
      return [d.min, d.max];
    }

    isIndexed(t, c) { return this.indexes.has(`${t}.${c}`); }
    // The primary key index is clustered: rows are stored in key order.
    isClustered(t, c) { return TABLES[t].pk === c && this.isIndexed(t, c); }
    indexName(t, c) { return TABLES[t].pk === c ? `${t}_pkey` : `${t}_${c}_idx`; }
    indexesOf(t) { return this.columns(t).filter((c) => this.isIndexed(t, c)); }
    height(t) { return Math.max(1, Math.ceil(Math.log(Math.max(2, this.rows(t))) / Math.log(FANOUT))); }

    toggleIndex(t, c) {
      const k = `${t}.${c}`;
      if (TABLES[t].pk === c) return false; // the primary key always has its index
      if (this.indexes.has(k)) this.indexes.delete(k); else this.indexes.add(k);
      return true;
    }

    setRows(t, n) {
      n = Math.round(n);
      if (!(n >= 1)) return;
      if (n === TABLES[t].rows) delete this.rowsOver[t]; else this.rowsOver[t] = n;
    }
  }

  // ---------- Errors ----------

  class SqlError extends Error {
    constructor(message, s, e, hint) {
      super(message);
      this.s = s;
      this.e = e;
      this.hint = hint || '';
    }
  }

  // ---------- Tokenizer ----------

  const KEYWORDS = new Set(['SELECT', 'DISTINCT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'JOIN', 'INNER', 'CROSS', 'ON',
    'AS', 'IN', 'BETWEEN', 'LIKE', 'ORDER', 'GROUP', 'BY', 'ASC', 'DESC', 'LIMIT', 'TRUE', 'FALSE', 'LEFT', 'RIGHT',
    'FULL', 'OUTER', 'HAVING', 'NULL', 'IS', 'UNION', 'EXISTS', 'USING', 'NATURAL']);
  const AGGS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

  function tokenize(src) {
    const toks = [];
    const n = src.length;
    let i = 0;
    while (i < n) {
      const ch = src[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '-' && src[i + 1] === '-') { while (i < n && src[i] !== '\n') i++; continue; }
      const s = i;
      if (/[A-Za-z_]/.test(ch)) {
        while (i < n && /[A-Za-z0-9_]/.test(src[i])) i++;
        const word = src.slice(s, i);
        const up = word.toUpperCase();
        toks.push(KEYWORDS.has(up) ? { t: 'kw', v: up, s, e: i } : { t: 'id', v: word.toLowerCase(), s, e: i });
        continue;
      }
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        while (i < n && /[0-9]/.test(src[i])) i++;
        if (src[i] === '.' && /[0-9]/.test(src[i + 1] || '')) {
          i++;
          while (i < n && /[0-9]/.test(src[i])) i++;
        }
        if (/[A-Za-z_]/.test(src[i] || '')) {
          while (i < n && /[A-Za-z0-9_]/.test(src[i])) i++;
          throw new SqlError(`'${src.slice(s, i)}' is not a valid number or name`, s, i, 'Names must start with a letter.');
        }
        toks.push({ t: 'num', v: parseFloat(src.slice(s, i)), s, e: i });
        continue;
      }
      if (ch === "'") {
        let v = '';
        i++;
        for (;;) {
          if (i >= n) throw new SqlError('This text value has no closing quote', s, n, "Text values go between single quotes, e.g. 'Physics'.");
          if (src[i] === "'") {
            if (src[i + 1] === "'") { v += "'"; i += 2; continue; }
            i++;
            break;
          }
          v += src[i++];
        }
        toks.push({ t: 'str', v, s, e: i });
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        while (j < n && src[j] !== '"') j++;
        throw new SqlError('Double quotes are for names in SQL', s, Math.min(n, j + 1), "Write text values in single quotes, e.g. 'Physics'.");
      }
      const two = src.slice(i, i + 2);
      if (two === '<=' || two === '>=' || two === '<>' || two === '!=') {
        toks.push({ t: 'op', v: two === '!=' ? '<>' : two, s, e: i + 2 });
        i += 2;
        continue;
      }
      if ('=<>(),.;*+-/'.includes(ch)) {
        toks.push({ t: 'op', v: ch, s, e: i + 1 });
        i++;
        continue;
      }
      throw new SqlError(`Unexpected character '${ch}'`, s, s + 1);
    }
    toks.push({ t: 'eof', v: '', s: n, e: n });
    return toks;
  }

  // ---------- Parser (recursive descent) ----------

  const CMP_OPS = new Set(['=', '<>', '<', '<=', '>', '>=']);

  class Parser {
    constructor(src) {
      this.src = src;
      this.toks = tokenize(src);
      this.i = 0;
    }

    get tok() { return this.toks[this.i]; }
    peek(k) { return this.toks[Math.min(this.i + (k || 1), this.toks.length - 1)]; }
    isKw(v, tk) { tk = tk || this.tok; return tk.t === 'kw' && tk.v === v; }
    isOp(v, tk) { tk = tk || this.tok; return tk.t === 'op' && tk.v === v; }
    acceptKw(v) { return this.isKw(v) ? this.toks[this.i++] : null; }
    acceptOp(v) { return this.isOp(v) ? this.toks[this.i++] : null; }
    get last() { return this.toks[Math.max(0, this.i - 1)]; }

    describe(tk) {
      if (tk.t === 'eof') return 'the end of the query';
      return `'${this.src.slice(tk.s, tk.e)}'`;
    }

    fail(msg, tk, hint) {
      tk = tk || this.tok;
      throw new SqlError(`${msg}, but found ${this.describe(tk)}`, tk.s, Math.max(tk.e, tk.s + 1), hint);
    }

    expectKw(v, where, hint) {
      const t = this.acceptKw(v);
      if (!t) this.fail(`Expected ${v}${where ? ' ' + where : ''}`, null, hint);
      return t;
    }

    expectOp(v, where) {
      const t = this.acceptOp(v);
      if (!t) this.fail(`Expected '${v}'${where ? ' ' + where : ''}`);
      return t;
    }

    unsupported(what, hint, tk) {
      tk = tk || this.tok;
      throw new SqlError(`${what} is not covered in this demo`, tk.s, tk.e, hint);
    }

    parseQuery() {
      if (this.tok.t === 'eof') throw new SqlError('The query is empty', 0, 0, 'Start with SELECT … FROM …, or pick an example.');
      const q = this.parseSelect(false);
      this.acceptOp(';');
      if (this.isKw('UNION')) this.unsupported('UNION');
      if (this.tok.t !== 'eof') this.fail('Expected the end of the query');
      return q;
    }

    parseSelect(nested) {
      const start = this.tok;
      this.expectKw('SELECT', nested ? 'after the opening bracket' : 'at the start of the query');
      const q = { distinct: false, star: false, items: [], from: [], where: null, group: [], order: [], limit: null, spans: {}, s: start.s };
      if (this.acceptKw('DISTINCT')) q.distinct = true;
      const selS = this.tok.s;
      if (this.isOp('*')) {
        this.i++;
        q.star = true;
      } else {
        do q.items.push(this.parseItem()); while (this.acceptOp(','));
      }
      q.spans.select = [selS, this.last.e];
      this.expectKw('FROM', 'after the SELECT list', 'Every query in this demo reads FROM at least one table.');
      q.from.push(this.parseTableRef('FROM'));
      for (;;) {
        if (this.acceptOp(',')) { q.from.push(this.parseTableRef(',')); continue; }
        if (this.isKw('LEFT') || this.isKw('RIGHT') || this.isKw('FULL') || this.isKw('OUTER')) {
          this.unsupported('An outer join', 'Use an inner JOIN … ON …, or list tables with commas and join them in WHERE.');
        }
        if (this.isKw('NATURAL')) this.unsupported('NATURAL JOIN', 'Write JOIN … ON a.x = b.y instead.');
        if (this.isKw('JOIN') || this.isKw('INNER') || this.isKw('CROSS')) {
          const kwTok = this.tok;
          const cross = !!this.acceptKw('CROSS');
          if (!cross) this.acceptKw('INNER');
          this.expectKw('JOIN');
          const ref = this.parseTableRef(cross ? 'CROSS JOIN' : 'JOIN');
          ref.s = kwTok.s;
          if (!cross) {
            if (this.isKw('USING')) this.unsupported('JOIN … USING', 'Write JOIN … ON a.x = b.y instead.');
            this.expectKw('ON', 'after the joined table', 'An inner join needs a condition: JOIN t ON a.x = t.y');
            ref.on = this.parseExpr();
            ref.onS = ref.on.s;
          }
          ref.e = this.last.e;
          q.from.push(ref);
          continue;
        }
        break;
      }
      if (this.acceptKw('WHERE')) {
        const s = this.tok.s;
        q.where = this.parseExpr();
        q.spans.where = [s, this.last.e];
      }
      if (this.isKw('GROUP')) {
        this.i++;
        this.expectKw('BY', 'after GROUP');
        const s = this.tok.s;
        do q.group.push(this.parseExpr()); while (this.acceptOp(','));
        q.spans.group = [s, this.last.e];
      }
      if (this.isKw('HAVING')) this.unsupported('HAVING', 'Filter rows with WHERE instead.');
      if (this.isKw('ORDER')) {
        this.i++;
        this.expectKw('BY', 'after ORDER');
        const s = this.tok.s;
        do {
          const e = this.parseExpr();
          let desc = false;
          if (this.acceptKw('DESC')) desc = true;
          else this.acceptKw('ASC');
          q.order.push({ e, desc });
        } while (this.acceptOp(','));
        q.spans.order = [s, this.last.e];
      }
      if (this.acceptKw('LIMIT')) {
        const t = this.tok;
        if (t.t !== 'num' || !Number.isInteger(t.v)) this.fail('Expected a whole number after LIMIT');
        this.i++;
        q.limit = t.v;
        q.spans.limit = [t.s, t.e];
      }
      q.e = this.last.e;
      return q;
    }

    parseItem() {
      const s = this.tok.s;
      const expr = this.parseExpr();
      let alias = null;
      if (this.acceptKw('AS')) {
        if (this.tok.t !== 'id') this.fail('Expected a name after AS');
        alias = this.tok.v;
        this.i++;
      } else if (this.tok.t === 'id') {
        alias = this.tok.v;
        this.i++;
      }
      return { expr, alias, s, e: this.last.e };
    }

    parseTableRef(kw) {
      const tk = this.tok;
      if (tk.t !== 'id') {
        if (this.isOp('(')) this.unsupported('A subquery in FROM', 'Subqueries are supported as: col IN (SELECT …).');
        this.fail('Expected a table name');
      }
      this.i++;
      let alias = null;
      if (this.acceptKw('AS')) {
        if (this.tok.t !== 'id') this.fail('Expected an alias after AS');
        alias = this.tok.v;
        this.i++;
      } else if (this.tok.t === 'id') {
        alias = this.tok.v;
        this.i++;
      }
      return { kw, table: tk.v, alias, on: null, s: tk.s, e: this.last.e, ts: tk.s, te: tk.e };
    }

    parseExpr() { return this.parseOr(); }

    parseOr() {
      const s = this.tok.s;
      let l = this.parseAnd();
      if (!this.isKw('OR')) return l;
      const args = [l];
      while (this.acceptKw('OR')) args.push(this.parseAnd());
      l = { k: 'or', args, s, e: this.last.e };
      return l;
    }

    parseAnd() {
      const s = this.tok.s;
      const l = this.parseNot();
      if (!this.isKw('AND')) return l;
      const args = [l];
      while (this.acceptKw('AND')) args.push(this.parseNot());
      return { k: 'and', args, s, e: this.last.e };
    }

    parseNot() {
      const s = this.tok.s;
      if (this.acceptKw('NOT')) {
        if (this.isKw('EXISTS')) this.unsupported('NOT EXISTS');
        const e = this.parseNot();
        return { k: 'not', e, s, e2: this.last.e };
      }
      return this.parsePredicate();
    }

    parsePredicate() {
      const s = this.tok.s;
      if (this.isKw('EXISTS')) this.unsupported('EXISTS', 'Write col IN (SELECT …) instead.');
      const left = this.parseAdd();
      let not = false;
      const nx = this.peek();
      if (this.isKw('NOT') && (this.isKw('IN', nx) || this.isKw('BETWEEN', nx) || this.isKw('LIKE', nx))) {
        this.i++;
        not = true;
      }
      if (this.acceptKw('BETWEEN')) {
        const lo = this.parseAdd();
        this.expectKw('AND', 'in BETWEEN … AND …');
        const hi = this.parseAdd();
        return { k: 'between', e: left, lo, hi, not, s, end: this.last.e };
      }
      if (this.acceptKw('IN')) {
        this.expectOp('(', 'after IN');
        if (this.isKw('SELECT')) {
          const subTok = this.tok;
          const sub = this.parseSelect(true);
          this.expectOp(')', 'to close the subquery');
          return { k: 'insub', e: left, sub, not, s, end: this.last.e, subS: subTok.s };
        }
        const list = [];
        do list.push(this.parseAdd()); while (this.acceptOp(','));
        this.expectOp(')', 'to close the IN list');
        return { k: 'in', e: left, list, not, s, end: this.last.e };
      }
      if (this.acceptKw('LIKE')) {
        const t = this.tok;
        if (t.t !== 'str') this.fail("Expected a text pattern after LIKE, e.g. 'Ph%'");
        this.i++;
        return { k: 'like', e: left, pat: t.v, not, s, end: this.last.e };
      }
      if (not) this.fail('Expected IN, BETWEEN or LIKE after NOT');
      if (this.tok.t === 'op' && CMP_OPS.has(this.tok.v)) {
        const op = this.tok.v;
        this.i++;
        const r = this.parseAdd();
        return { k: 'cmp', op, l: left, r, s, end: this.last.e };
      }
      if (this.isKw('IS')) this.unsupported('IS NULL', 'This demo’s tables have no NULL values.');
      return left;
    }

    parseAdd() {
      let l = this.parseMul();
      while (this.isOp('+') || this.isOp('-')) {
        const op = this.tok.v;
        this.i++;
        const r = this.parseMul();
        l = { k: 'bin', op, l, r, s: l.s, end: this.last.e };
      }
      return l;
    }

    parseMul() {
      let l = this.parseUnary();
      while (this.isOp('*') || this.isOp('/')) {
        const op = this.tok.v;
        this.i++;
        const r = this.parseUnary();
        l = { k: 'bin', op, l, r, s: l.s, end: this.last.e };
      }
      return l;
    }

    parseUnary() {
      const s = this.tok.s;
      if (this.acceptOp('-')) {
        const e = this.parseUnary();
        return { k: 'neg', e, s, end: this.last.e };
      }
      if (this.acceptOp('+')) return this.parseUnary();
      return this.parsePrimary();
    }

    parsePrimary() {
      const tk = this.tok;
      if (tk.t === 'num') { this.i++; return { k: 'num', v: tk.v, s: tk.s, end: tk.e }; }
      if (tk.t === 'str') { this.i++; return { k: 'str', v: tk.v, s: tk.s, end: tk.e }; }
      if (this.isKw('TRUE') || this.isKw('FALSE')) { this.i++; return { k: 'bool', v: tk.v === 'TRUE', s: tk.s, end: tk.e }; }
      if (this.isKw('NULL')) this.unsupported('NULL', 'This demo’s tables have no NULL values.');
      if (this.isOp('(')) {
        if (this.isKw('SELECT', this.peek())) {
          this.unsupported('A subquery here', 'Subqueries are supported in WHERE as: col IN (SELECT col FROM table WHERE …).', this.peek());
        }
        this.i++;
        const e = this.parseExpr();
        this.expectOp(')', 'to close the bracket');
        return e;
      }
      if (tk.t === 'id') {
        this.i++;
        if (this.isOp('(')) {
          const fn = tk.v.toUpperCase();
          if (!AGGS.has(fn)) throw new SqlError(`Function ${fn}() is not covered in this demo`, tk.s, tk.e, 'Supported: COUNT, SUM, AVG, MIN, MAX.');
          this.i++;
          let arg = null;
          if (this.acceptOp('*')) {
            if (fn !== 'COUNT') throw new SqlError(`${fn}(*) is not valid, only COUNT(*)`, tk.s, this.last.e);
          } else {
            if (this.isKw('DISTINCT')) this.unsupported(`${fn}(DISTINCT …)`);
            arg = this.parseAdd();
          }
          this.expectOp(')', `to close ${fn}(`);
          return { k: 'agg', fn, arg, s: tk.s, end: this.last.e };
        }
        if (this.acceptOp('.')) {
          const ct = this.tok;
          if (ct.t === 'op' && ct.v === '*') this.unsupported(`${tk.v}.*`, 'Use SELECT * or list the columns.');
          if (ct.t !== 'id') this.fail(`Expected a column name after '${tk.v}.'`);
          this.i++;
          return { k: 'col', q: tk.v, c: ct.v, s: tk.s, end: ct.e };
        }
        return { k: 'col', q: null, c: tk.v, s: tk.s, end: tk.e };
      }
      if (tk.t === 'kw') {
        this.fail('Expected a value or a column name', tk, `${tk.v} is a reserved word in SQL.`);
      }
      this.fail('Expected a value or a column name');
    }
  }

  function parse(src) {
    const p = new Parser(src);
    const ast = p.parseQuery();
    ast.src = src;
    return ast;
  }

  // ---------- Expression helpers ----------

  const TRUE = { k: 'bool', v: true };
  const FALSE = { k: 'bool', v: false };
  const isLit = (e) => e.k === 'num' || e.k === 'str';
  const isConst = (e) => e.k === 'num' || e.k === 'str' || e.k === 'bool';
  const FLIP = { '=': '=', '<>': '<>', '<': '>', '>': '<', '<=': '>=', '>=': '<=' };
  const NEG = { '=': '<>', '<>': '=', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };

  function fmtNum(v) {
    if (Number.isInteger(v)) return String(v);
    return String(+v.toFixed(6));
  }

  // Prints an expression as SQL. `q.qualify` decides whether columns get their table alias.
  function str(e, q, ctx) {
    ctx = ctx || 0;
    const qual = !q || q.qualify;
    const wrap = (p, s) => (p < ctx ? `(${s})` : s);
    switch (e.k) {
      case 'num': return fmtNum(e.v);
      case 'str': return `'${e.v.replace(/'/g, "''")}'`;
      case 'bool': return e.v ? 'TRUE' : 'FALSE';
      case 'col': return qual ? `${e.t}.${e.c}` : e.c;
      case 'agg': return `${e.fn}(${e.arg ? str(e.arg, q) : '*'})`;
      case 'ref': return e.name;
      case 'neg': return wrap(7, '-' + str(e.e, q, 8));
      case 'bin': {
        const p = e.op === '+' || e.op === '-' ? 5 : 6;
        return wrap(p, `${str(e.l, q, p)} ${e.op} ${str(e.r, q, p + 1)}`);
      }
      case 'cmp': return wrap(4, `${str(e.l, q, 5)} ${e.op} ${str(e.r, q, 5)}`);
      case 'between': return wrap(4, `${str(e.e, q, 5)}${e.not ? ' NOT' : ''} BETWEEN ${str(e.lo, q, 5)} AND ${str(e.hi, q, 5)}`);
      case 'in': return wrap(4, `${str(e.e, q, 5)}${e.not ? ' NOT' : ''} IN (${e.list.map((x) => str(x, q)).join(', ')})`);
      case 'like': return wrap(4, `${str(e.e, q, 5)}${e.not ? ' NOT' : ''} LIKE '${e.pat.replace(/'/g, "''")}'`);
      case 'insub': return wrap(4, `${str(e.e, q, 5)} IN (SELECT ${str(e.sub.col, q)} …)`);
      case 'not': return wrap(3, 'NOT ' + str(e.e, q, 9));
      case 'and': return wrap(2, e.args.map((a) => str(a, q, 2)).join(' AND '));
      case 'or': return wrap(1, e.args.map((a) => str(a, q, 3)).join(' OR '));
      default: return '?';
    }
  }

  // Relation ids referenced by an expression.
  function refs(e, out) {
    out = out || new Set();
    switch (e.k) {
      case 'col': out.add(e.t); break;
      case 'agg': if (e.arg) refs(e.arg, out); break;
      case 'neg': case 'not': refs(e.e, out); break;
      case 'bin': case 'cmp': refs(e.l, out); refs(e.r, out); break;
      case 'between': refs(e.e, out); refs(e.lo, out); refs(e.hi, out); break;
      case 'in': refs(e.e, out); e.list.forEach((x) => refs(x, out)); break;
      case 'like': refs(e.e, out); break;
      case 'insub': refs(e.e, out); out.add(e.sub.rel); break;
      case 'and': case 'or': e.args.forEach((a) => refs(a, out)); break;
      default: break;
    }
    return out;
  }

  // Column references in an expression (excluding subquery internals).
  function cols(e, out) {
    out = out || [];
    switch (e.k) {
      case 'col': out.push(e); break;
      case 'agg': if (e.arg) cols(e.arg, out); break;
      case 'neg': case 'not': cols(e.e, out); break;
      case 'bin': case 'cmp': cols(e.l, out); cols(e.r, out); break;
      case 'between': cols(e.e, out); cols(e.lo, out); cols(e.hi, out); break;
      case 'in': cols(e.e, out); e.list.forEach((x) => cols(x, out)); break;
      case 'like': cols(e.e, out); break;
      case 'insub': cols(e.e, out); break;
      case 'and': case 'or': e.args.forEach((a) => cols(a, out)); break;
      default: break;
    }
    return out;
  }

  const conj = (e) => (!e ? [] : e.k === 'and' ? e.args.flatMap(conj) : [e]);
  const andAll = (list) => (!list.length ? null : list.length === 1 ? list[0] : { k: 'and', args: list });

  function arith(op, a, b) {
    let v;
    if (op === '+') v = a + b;
    else if (op === '-') v = a - b;
    else if (op === '*') v = a * b;
    else if (op === '/') { if (b === 0) return null; v = a / b; }
    return Math.round(v * 1e9) / 1e9;
  }

  function cmpVals(op, a, b) {
    if (a.k !== b.k) return null;
    const x = a.v, y = b.v;
    switch (op) {
      case '=': return x === y;
      case '<>': return x !== y;
      case '<': return a.k === 'bool' ? null : x < y;
      case '<=': return a.k === 'bool' ? null : x <= y;
      case '>': return a.k === 'bool' ? null : x > y;
      case '>=': return a.k === 'bool' ? null : x >= y;
      default: return null;
    }
  }

  function likeRegex(pat) {
    const esc = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
    return new RegExp(`^${esc}$`);
  }

  // Constant folding and boolean simplification. Never mutates its input.
  function fold(e) {
    switch (e.k) {
      case 'num': case 'str': case 'bool': case 'col': case 'agg': case 'insub': return e;
      case 'neg': {
        const x = fold(e.e);
        return x.k === 'num' ? { k: 'num', v: -x.v } : { k: 'neg', e: x };
      }
      case 'bin': {
        const l = fold(e.l), r = fold(e.r);
        if (l.k === 'num' && r.k === 'num') {
          const v = arith(e.op, l.v, r.v);
          if (v !== null) return { k: 'num', v };
        }
        return { k: 'bin', op: e.op, l, r };
      }
      case 'cmp': {
        const l = fold(e.l), r = fold(e.r);
        if (isConst(l) && isConst(r)) {
          const v = cmpVals(e.op, l, r);
          if (v !== null) return v ? TRUE : FALSE;
        }
        // Put the column on the left: 5 < s.year → s.year > 5
        if (isConst(l) && !isConst(r)) return { k: 'cmp', op: FLIP[e.op], l: r, r: l };
        return { k: 'cmp', op: e.op, l, r };
      }
      case 'between': {
        const x = fold(e.e), lo = fold(e.lo), hi = fold(e.hi);
        if (isConst(x) && isConst(lo) && isConst(hi)) {
          const a = cmpVals('>=', x, lo), b = cmpVals('<=', x, hi);
          if (a !== null && b !== null) return (a && b) !== e.not ? TRUE : FALSE;
        }
        return { k: 'between', e: x, lo, hi, not: e.not };
      }
      case 'in': {
        const x = fold(e.e);
        const list = e.list.map(fold);
        if (isConst(x) && list.every(isConst)) {
          const hit = list.some((v) => cmpVals('=', x, v) === true);
          return hit !== e.not ? TRUE : FALSE;
        }
        if (list.length === 1) return fold({ k: 'cmp', op: e.not ? '<>' : '=', l: x, r: list[0] });
        return { k: 'in', e: x, list, not: e.not };
      }
      case 'like': {
        const x = fold(e.e);
        if (x.k === 'str') return likeRegex(e.pat).test(x.v) !== e.not ? TRUE : FALSE;
        if (!/[%_]/.test(e.pat)) return { k: 'cmp', op: e.not ? '<>' : '=', l: x, r: { k: 'str', v: e.pat } };
        return { k: 'like', e: x, pat: e.pat, not: e.not };
      }
      case 'not': return negate(fold(e.e));
      case 'and':
      case 'or': {
        const out = [];
        e.args.forEach((a) => {
          const f = fold(a);
          if (f.k === e.k) out.push(...f.args); else out.push(f);
        });
        // FALSE decides an AND, TRUE decides an OR; the other constant is dropped.
        const decides = e.k === 'or';
        if (out.some((x) => x.k === 'bool' && x.v === decides)) return decides ? TRUE : FALSE;
        const rest = out.filter((x) => x.k !== 'bool');
        if (!rest.length) return e.k === 'and' ? TRUE : FALSE;
        return rest.length === 1 ? rest[0] : { k: e.k, args: rest };
      }
      default: return e;
    }
  }

  function negate(x) {
    switch (x.k) {
      case 'bool': return x.v ? FALSE : TRUE;
      case 'cmp': return { k: 'cmp', op: NEG[x.op], l: x.l, r: x.r };
      case 'not': return x.e;
      case 'between': case 'in': case 'like': return { ...x, not: !x.not };
      case 'and': return fold({ k: 'or', args: x.args.map((a) => ({ k: 'not', e: a })) });
      case 'or': return fold({ k: 'and', args: x.args.map((a) => ({ k: 'not', e: a })) });
      default: return { k: 'not', e: x };
    }
  }

  // Replaces every reference to column `from` by column `to`.
  function swapCol(e, from, to) {
    const sw = (x) => swapCol(x, from, to);
    switch (e.k) {
      case 'col': return e.t === from.t && e.c === from.c ? { k: 'col', t: to.t, c: to.c } : e;
      case 'neg': case 'not': return { ...e, e: sw(e.e) };
      case 'bin': case 'cmp': return { ...e, l: sw(e.l), r: sw(e.r) };
      case 'between': return { ...e, e: sw(e.e), lo: sw(e.lo), hi: sw(e.hi) };
      case 'in': return { ...e, e: sw(e.e), list: e.list.map(sw) };
      case 'like': return { ...e, e: sw(e.e) };
      case 'and': case 'or': return { ...e, args: e.args.map(sw) };
      default: return e;
    }
  }

  const hasAgg = (e) => {
    switch (e.k) {
      case 'agg': return true;
      case 'neg': case 'not': return hasAgg(e.e);
      case 'bin': case 'cmp': return hasAgg(e.l) || hasAgg(e.r);
      case 'between': return hasAgg(e.e) || hasAgg(e.lo) || hasAgg(e.hi);
      case 'in': return hasAgg(e.e) || e.list.some(hasAgg);
      case 'like': return hasAgg(e.e);
      case 'and': case 'or': return e.args.some(hasAgg);
      default: return false;
    }
  };

  const BOOLISH = new Set(['cmp', 'between', 'in', 'insub', 'like', 'not', 'and', 'or', 'bool']);

  // ---------- Binder: resolve names against the catalog ----------

  function relName(r) { return r.alias === r.table ? r.table : `${r.table} ${r.alias}`; }

  function bind(ast, cat) {
    const q = {
      src: ast.src, rels: [], rel: {}, main: [], subs: [], conds: [], pred: null,
      items: [], star: ast.star, distinct: ast.distinct, group: [], order: [], limit: ast.limit,
      aggregate: false, qualify: false, bindings: [], ast,
    };
    const taken = new Set();

    function addRel(ref, sub) {
      if (!cat.has(ref.table)) {
        throw new SqlError(`There is no table '${ref.table}'`, ref.ts, ref.te, `Tables: ${cat.tables().join(', ')}.`);
      }
      let alias = ref.alias || ref.table;
      if (!sub && taken.has(alias)) {
        throw new SqlError(`The name '${alias}' is used for two tables`, ref.s, ref.e, 'Give each table its own alias, e.g. FROM students s1, students s2.');
      }
      let id = alias;
      for (let k = 2; taken.has(id); k++) id = `${alias}${k}`;
      taken.add(id);
      const r = { id, table: ref.table, alias: id, written: alias, sub: !!sub };
      r.name = relName(r);
      q.rels.push(r);
      q.rel[id] = r;
      if (q.rels.length > MAX_RELS) {
        throw new SqlError(`This demo plans at most ${MAX_RELS} tables`, ref.s, ref.e, 'Remove a table to keep the search space small enough to show.');
      }
      q.bindings.push({ kind: 'table', text: ref.alias && ref.alias !== ref.table ? `${ref.table} ${ref.alias}` : ref.table, to: `table ${ref.table}`, note: `${cat.rows(ref.table).toLocaleString('en-US')} rows` });
      return r;
    }

    const mainScope = ast.from.map((ref) => addRel(ref, false));
    q.main = mainScope.map((r) => r.id);

    function resolveCol(e, scope, where, outerScope) {
      if (e.q) {
        const r = scope.find((x) => x.written === e.q);
        if (!r) {
          if (outerScope && outerScope.some((x) => x.alias === e.q)) {
            throw new SqlError(`The subquery refers to '${e.q}' outside it (a correlated subquery)`, e.s, e.end, 'Only independent subqueries are covered: use columns of the subquery’s own table.');
          }
          const names = scope.map((x) => x.written).join(', ');
          throw new SqlError(`'${e.q}' is not a table or alias in FROM`, e.s, e.end, `Available here: ${names}.`);
        }
        if (!cat.hasCol(r.table, e.c)) {
          throw new SqlError(`Table ${r.table} has no column '${e.c}'`, e.s, e.end, `Columns of ${r.table}: ${cat.columns(r.table).join(', ')}.`);
        }
        q.bindings.push({ kind: 'col', text: `${e.q}.${e.c}`, to: `${r.alias}.${e.c}`, note: r.table });
        return { k: 'col', t: r.id, c: e.c };
      }
      const hits = scope.filter((r) => cat.hasCol(r.table, e.c));
      if (!hits.length) {
        if (outerScope && outerScope.some((r) => cat.hasCol(r.table, e.c))) {
          throw new SqlError(`'${e.c}' is not a column of the subquery’s table (a correlated subquery)`, e.s, e.end, 'Only independent subqueries are covered here.');
        }
        const all = scope.map((r) => `${r.table}: ${cat.columns(r.table).join(', ')}`).join(' · ');
        throw new SqlError(`No table in FROM has a column '${e.c}'`, e.s, e.end, all);
      }
      if (hits.length > 1) {
        throw new SqlError(`Column '${e.c}' is ambiguous: it is in ${hits.map((r) => r.name).join(' and ')}`, e.s, e.end,
          `Say which one you mean: ${hits.map((r) => `${r.alias}.${e.c}`).join(' or ')}.`);
      }
      const r = hits[0];
      q.bindings.push({ kind: 'col', text: e.c, to: `${r.alias}.${e.c}`, note: r.table });
      return { k: 'col', t: r.id, c: e.c };
    }

    function bindExpr(e, scope, ctx) {
      const b = (x, c2) => bindExpr(x, scope, c2 || { ...ctx, top: false });
      switch (e.k) {
        case 'num': case 'str': case 'bool': return { k: e.k, v: e.v };
        case 'col': return resolveCol(e, scope, ctx.where, ctx.outer);
        case 'agg': {
          if (!ctx.allowAgg) throw new SqlError(`${e.fn}() can’t be used in ${ctx.where}`, e.s, e.end, ctx.where === 'WHERE' ? 'Aggregates are computed after WHERE has filtered the rows.' : '');
          if (e.arg && hasAgg(e.arg)) throw new SqlError('Aggregates can’t be nested', e.s, e.end);
          return { k: 'agg', fn: e.fn, arg: e.arg ? b(e.arg, { ...ctx, allowAgg: false, top: false }) : null };
        }
        case 'neg': return { k: 'neg', e: b(e.e) };
        case 'bin': return { k: 'bin', op: e.op, l: b(e.l), r: b(e.r) };
        case 'cmp': {
          const out = { k: 'cmp', op: e.op, l: b(e.l), r: b(e.r) };
          checkTypes(out.l, out.r, e);
          checkTypes(out.r, out.l, e);
          return out;
        }
        case 'between': {
          const out = { k: 'between', e: b(e.e), lo: b(e.lo), hi: b(e.hi), not: e.not };
          checkTypes(out.e, out.lo, e);
          checkTypes(out.e, out.hi, e);
          return out;
        }
        case 'in': {
          const out = { k: 'in', e: b(e.e), list: e.list.map((x) => b(x)), not: e.not };
          out.list.forEach((x) => checkTypes(out.e, x, e));
          return out;
        }
        case 'like': return { k: 'like', e: b(e.e), pat: e.pat, not: e.not };
        case 'not': return { k: 'not', e: b(e.e) };
        case 'and': return { k: 'and', args: e.args.map((a) => bindExpr(a, scope, ctx)) };
        case 'or': return { k: 'or', args: e.args.map((a) => b(a)) };
        case 'insub': return bindSub(e, scope, ctx);
        default: throw new SqlError('Unsupported expression', e.s, e.end);
      }
    }

    // A number column compared with text (or the other way round) is almost always a typo.
    function checkTypes(c, v, e) {
      if (c.k !== 'col' || !isLit(v)) return;
      const r = q.rel[c.t];
      const d = cat.col(r.table, c.c);
      if (d.type === 'text' && v.k === 'num') {
        throw new SqlError(`${r.alias}.${c.c} holds text, but is compared with the number ${fmtNum(v.v)}`, e.s, e.end,
          `Put text values in single quotes, e.g. ${d.sample || "'abc'"}.`);
      }
      if (d.type !== 'text' && v.k === 'str') {
        throw new SqlError(`${r.alias}.${c.c} is a number, but is compared with the text '${v.v}'`, e.s, e.end, 'Compare it with a number (no quotes).');
      }
    }

    function bindSub(e, scope, ctx) {
      if (ctx.where !== 'WHERE' || !ctx.top) {
        throw new SqlError('IN (SELECT …) is covered only as a WHERE condition joined with AND', e.s, e.end, 'Move it to WHERE, outside any OR / NOT.');
      }
      if (e.not) throw new SqlError('NOT IN (SELECT …) is not covered in this demo', e.s, e.end, 'Try IN (SELECT …), it becomes a semi join.');
      const sub = e.sub;
      const subS = e.subS;
      if (sub.star || sub.items.length !== 1) throw new SqlError('The subquery must SELECT exactly one column', subS, sub.e, 'e.g. IN (SELECT e.student_id FROM enrollments e WHERE …)');
      if (sub.from.length !== 1 || sub.from[0].on) throw new SqlError('Keep the subquery to one table', subS, sub.e, 'e.g. IN (SELECT e.student_id FROM enrollments e WHERE …)');
      if (sub.group.length || sub.order.length || sub.limit != null || sub.distinct) throw new SqlError('Keep the subquery simple: SELECT col FROM table WHERE …', subS, sub.e);
      const outer = q.ctxOuter || scope;
      const r = addRel(sub.from[0], true);
      const subScope = [r];
      const item = sub.items[0].expr;
      if (item.k !== 'col') throw new SqlError('The subquery must SELECT a plain column', sub.items[0].s, sub.items[0].e);
      const colB = resolveCol(item, subScope, 'SELECT', outer);
      const where = sub.where ? bindCond(sub.where, subScope, { where: 'WHERE', outer, top: false, inSub: true }) : null;
      const s = { rel: r.id, col: colB, where };
      q.subs.push(s);
      return { k: 'insub', e: bindExpr(e.e, scope, { ...ctx, top: false }), sub: s, not: false };
    }

    function bindCond(e, scope, ctx) {
      const out = bindExpr(e, scope, ctx);
      if (!BOOLISH.has(out.k)) {
        throw new SqlError(`A condition must compare something, e.g. ${str(out, null)} = …`, e.s, e.end || e.e);
      }
      if (ctx.inSub && out && conj(out).some((x) => x.k === 'insub')) {
        throw new SqlError('Nested subqueries are not covered', e.s, e.end);
      }
      return out;
    }

    // ON conditions first (they come first in the text), then WHERE.
    ast.from.forEach((ref) => {
      if (ref.on) q.conds.push(...conj(bindCond(ref.on, mainScope, { where: 'ON', top: false })));
    });
    if (ast.where) {
      const w = ast.where;
      const parts = w.k === 'and' ? w.args : [w];
      parts.forEach((p) => q.conds.push(...conj(bindCond(p, mainScope, { where: 'WHERE', top: true }))));
    }
    q.pred = andAll(q.conds);

    // SELECT list, GROUP BY, ORDER BY
    if (!ast.star) {
      ast.items.forEach((it) => {
        const ex = bindExpr(it.expr, mainScope, { where: 'SELECT', allowAgg: true });
        q.items.push({ expr: ex, alias: it.alias, s: it.s, e: it.e });
      });
    }
    q.group = ast.group.map((g) => {
      const ex = bindExpr(g, mainScope, { where: 'GROUP BY' });
      if (ex.k !== 'col') throw new SqlError('GROUP BY a column, e.g. GROUP BY d.name', g.s, g.end);
      return ex;
    });
    q.aggregate = q.group.length > 0 || q.items.some((it) => hasAgg(it.expr));
    q.qualify = q.rels.length > 1;
    q.items.forEach((it) => { it.label = it.alias ? `${str(it.expr, q)} AS ${it.alias}` : str(it.expr, q); });

    if (q.aggregate) {
      if (ast.star) throw new SqlError('SELECT * can’t be combined with GROUP BY or aggregates', ast.spans.select[0], ast.spans.select[1], 'List the grouped columns and aggregates instead.');
      const gk = new Set(q.group.map((g) => str(g, q)));
      q.items.forEach((it) => {
        if (hasAgg(it.expr)) return;
        cols(it.expr).forEach((c) => {
          if (!gk.has(str(c, q))) {
            throw new SqlError(`${str(c, q)} must be in GROUP BY (or inside an aggregate)`, it.s, it.e, 'Every selected column must be grouped when you aggregate.');
          }
        });
      });
    }

    q.order = ast.order.map((o) => {
      const e = o.e;
      if (e.k === 'col' && !e.q) {
        const it = q.items.find((x) => x.alias === e.c);
        if (it) return { expr: { k: 'ref', name: e.c, target: it.expr }, desc: o.desc };
      }
      const ex = bindExpr(e, mainScope, { where: 'ORDER BY', allowAgg: q.aggregate });
      if (q.aggregate && !hasAgg(ex)) {
        const gk = new Set(q.group.map((g) => str(g, q)));
        cols(ex).forEach((c) => {
          if (!gk.has(str(c, q))) throw new SqlError(`ORDER BY ${str(c, q)}: it must be grouped`, e.s, e.end);
        });
      }
      return { expr: ex, desc: o.desc };
    });

    // Remove duplicate column bindings for the bind table.
    const seen = new Set();
    q.bindings = q.bindings.filter((b) => {
      const k = `${b.kind}:${b.text}:${b.to}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return q;
  }

  global.QoSql = {
    TABLES, DEFAULT_INDEXES, Catalog, SqlError, tokenize, parse, bind, KEYWORDS, AGGS,
    str, refs, cols, conj, andAll, fold, negate, swapCol, isLit, isConst, fmtNum, relName, TRUE, FALSE, FLIP,
  };
})(window);
