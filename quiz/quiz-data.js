/* DBMS quiz: the sample schema, the default questions and the SQL answer checker. */
(function (global) {
  'use strict';

  // Shown next to every "write a query" question.
  const SCHEMA = [
    { table: 'customer', cols: ['customer_id', 'name', 'city', 'email'] },
    { table: 'orders', cols: ['order_id', 'customer_id', 'order_date', 'amount'] },
    { table: 'product', cols: ['product_id', 'name', 'category', 'price'] },
    { table: 'employee', cols: ['emp_id', 'name', 'dept', 'salary', 'manager_id'] },
  ];

  // limit: seconds for full points (1000 falling to 500). maxTime: seconds after
  // which the question ends by itself (default MAX_TIME; longer for hard ones).
  const MAX_TIME = 300;

  // Question types:
  //   mcq  options[] + correct (index)
  //   tf   true / false, correct 0 = True, 1 = False
  //   sql  typed query; `model` is shown on the reveal, `answers` are the
  //        accepted forms (compared after normalising, {x} = any alias).
  const DEFAULT_QUESTIONS = [
    {
      type: 'sql', topic: 'Basics', limit: 60,
      text: 'Show every column and every row of the customer table.',
      model: 'SELECT * FROM customer;',
      answers: ['SELECT * FROM customer'],
    },
    {
      type: 'sql', topic: 'Basics', limit: 120,
      text: 'List the names of the customers who live in Colombo.',
      model: "SELECT name FROM customer WHERE city = 'Colombo';",
      answers: [
        "SELECT name FROM customer WHERE city = 'Colombo'",
        "SELECT customer.name FROM customer WHERE customer.city = 'Colombo'",
        "SELECT {c}.name FROM customer {c} WHERE {c}.city = 'Colombo'",
      ],
    },
    {
      type: 'sql', topic: 'Sorting', limit: 120,
      text: 'List all products, the most expensive first.',
      model: 'SELECT * FROM product ORDER BY price DESC;',
      answers: ['SELECT * FROM product ORDER BY price DESC'],
    },
    {
      type: 'sql', topic: 'Aggregates', limit: 135,
      text: 'Show each city together with the number of customers in it.',
      model: 'SELECT city, COUNT(*) FROM customer GROUP BY city;',
      answers: [
        'SELECT city, COUNT(*) FROM customer GROUP BY city',
        'SELECT city, COUNT(*) {n} FROM customer GROUP BY city',
        'SELECT city, COUNT(customer_id) FROM customer GROUP BY city',
        'SELECT city, COUNT(customer_id) {n} FROM customer GROUP BY city',
        'SELECT COUNT(*), city FROM customer GROUP BY city',
        'SELECT COUNT(*) {n}, city FROM customer GROUP BY city',
      ],
    },
    {
      type: 'sql', topic: 'Joins', limit: 160, maxTime: 480,
      text: 'Show each order_id together with the name of the customer who placed it.',
      model: 'SELECT o.order_id, c.name\nFROM orders o\nJOIN customer c ON o.customer_id = c.customer_id;',
      answers: [
        'SELECT {o}.order_id, {c}.name FROM orders {o} JOIN customer {c} ON {o}.customer_id = {c}.customer_id',
        'SELECT {o}.order_id, {c}.name FROM orders {o} JOIN customer {c} ON {c}.customer_id = {o}.customer_id',
        'SELECT {o}.order_id, {c}.name FROM customer {c} JOIN orders {o} ON {o}.customer_id = {c}.customer_id',
        'SELECT {o}.order_id, {c}.name FROM customer {c} JOIN orders {o} ON {c}.customer_id = {o}.customer_id',
        'SELECT orders.order_id, customer.name FROM orders JOIN customer ON orders.customer_id = customer.customer_id',
        'SELECT orders.order_id, customer.name FROM customer JOIN orders ON customer.customer_id = orders.customer_id',
        'SELECT order_id, name FROM orders JOIN customer ON orders.customer_id = customer.customer_id',
        'SELECT order_id, name FROM orders JOIN customer USING (customer_id)',
      ],
    },
    {
      type: 'mcq', topic: 'Joins', limit: 85,
      text: 'You need every customer, including those who never placed an order. Which join?',
      options: ['customer INNER JOIN orders', 'customer LEFT JOIN orders', 'customer CROSS JOIN orders', 'customer RIGHT JOIN orders'],
      correct: 1,
    },
    {
      type: 'mcq', topic: 'Normalization', limit: 90,
      text: 'student_name depends only on student_id. Which normal form is broken?',
      code: 'enrolment(student_id, course_id, student_name, grade)\nkey = (student_id, course_id)',
      options: ['1NF', '2NF', '3NF', 'None'], correct: 1,
    },
    {
      type: 'mcq', topic: 'Indexing', limit: 90,
      text: 'Which query gets the biggest speed-up from an index on customer(city)?',
      options: [
        "SELECT * FROM customer WHERE city = 'Kandy'",
        'SELECT * FROM customer',
        'SELECT COUNT(*) FROM orders',
        'UPDATE customer SET city = UPPER(city)',
      ],
      correct: 0,
    },
    {
      type: 'mcq', topic: 'Recursive CTE', limit: 105, maxTime: 480,
      text: 'What does this query return?',
      code: 'WITH RECURSIVE chain AS (\n  SELECT emp_id, name, manager_id\n  FROM employee WHERE emp_id = 5\n  UNION ALL\n  SELECT e.emp_id, e.name, e.manager_id\n  FROM employee e\n  JOIN chain c ON e.emp_id = c.manager_id\n)\nSELECT name FROM chain;',
      options: [
        'Employee 5 and every manager above them, up to the top',
        'Everyone who reports to employee 5',
        "Only employee 5's direct manager",
        'Nothing: it loops forever',
      ],
      correct: 0,
    },
    {
      type: 'mcq', topic: 'Window functions', limit: 95, maxTime: 480,
      text: 'Which expression ranks employees by salary within each department?',
      options: [
        'RANK() OVER (PARTITION BY dept ORDER BY salary DESC)',
        'RANK() OVER (ORDER BY salary DESC)',
        'RANK(salary) GROUP BY dept',
        'COUNT(*) OVER (PARTITION BY salary)',
      ],
      correct: 0,
    },
  ];

  function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_QUESTIONS));
  }

  // ---------- SQL answer checking ----------

  // Puts a query in a canonical form so that spacing, letter case (also inside
  // quotes), a trailing semicolon, AS, ASC, INNER / OUTER, != vs <> and a
  // plural s on a name (products, customers) don't matter.
  function normSql(input) {
    const s = String(input || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
    const parts = s.split(/('(?:[^']|'')*'?|"[^"]*"?)/);
    let out = '';
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (i % 2) {
        out += (p[0] === '"' ? "'" + p.slice(1).replace(/"$/, '') + "'" : p).toLowerCase();
        continue;
      }
      out += p.toLowerCase()
        .replace(/--[^\n]*/g, ' ')
        .replace(/\b(as|asc|inner|outer)\b/g, ' ')
        .replace(/\b([a-z_][a-z0-9_]*?)s\b/g, '$1')
        .replace(/!=/g, '<>')
        .replace(/\s+/g, ' ')
        .replace(/\s*([(),;=<>*+\-/.])\s*/g, '$1');
    }
    return out.trim().replace(/;+$/, '').trim();
  }

  const patternCache = new Map();

  // An accepted answer becomes a regular expression; {x} matches any
  // identifier, and the same {x} must be the same identifier everywhere.
  function patternFor(answer) {
    if (patternCache.has(answer)) return patternCache.get(answer);
    const seen = {};
    const src = normSql(answer)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\{([a-z]\w*)\\\}/g, (m, name) => {
        if (seen[name]) return '\\k<' + name + '>';
        seen[name] = true;
        return '(?<' + name + '>[a-z_][a-z0-9_]*)';
      });
    const re = new RegExp('^' + src + '$');
    patternCache.set(answer, re);
    return re;
  }

  function checkSql(input, q) {
    const n = normSql(input);
    if (!n) return false;
    const accepted = (q.answers && q.answers.length) ? q.answers : [q.model || ''];
    return accepted.some((a) => {
      try { return patternFor(a).test(n); } catch (e) { return false; }
    });
  }

  // ---------- SHA-256 (for the admin password; works from file:// too) ----------

  function sha256(text) {
    const ascii = unescape(encodeURIComponent(text));
    const rot = (v, n) => (v >>> n) | (v << (32 - n));
    const K = [], H = [];
    const isComposite = {};
    for (let c = 2, n = 0; n < 64; c++) {
      if (isComposite[c]) continue;
      for (let i = 0; i < 313; i += c) isComposite[i] = c;
      H[n] = (Math.pow(c, 0.5) * 4294967296) | 0;
      K[n++] = (Math.pow(c, 1 / 3) * 4294967296) | 0;
    }
    let hash = H.slice(0, 8);
    let msg = ascii + '\x80';
    while (msg.length % 64 - 56) msg += '\x00';
    const words = [];
    for (let i = 0; i < msg.length; i++) words[i >> 2] |= msg.charCodeAt(i) << ((3 - i) % 4) * 8;
    words[words.length] = (ascii.length * 8 / 4294967296) | 0;
    words[words.length] = ascii.length * 8;
    for (let j = 0; j < words.length;) {
      const w = words.slice(j, j += 16);
      const old = hash;
      hash = hash.slice(0, 8);
      for (let i = 0; i < 64; i++) {
        const w15 = w[i - 15], w2 = w[i - 2];
        const a = hash[0], e = hash[4];
        const t1 = hash[7] + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & hash[5]) ^ (~e & hash[6])) + K[i] +
          (w[i] = i < 16 ? w[i] : (w[i - 16] + (rot(w15, 7) ^ rot(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rot(w2, 17) ^ rot(w2, 19) ^ (w2 >>> 10))) | 0);
        const t2 = (rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(t1 + t2) | 0].concat(hash);
        hash[4] = (hash[4] + t1) | 0;
      }
      for (let i = 0; i < 8; i++) hash[i] = (hash[i] + old[i]) | 0;
    }
    let out = '';
    for (let i = 0; i < 8; i++) {
      for (let j = 3; j >= 0; j--) {
        const b = (hash[i] >> (j * 8)) & 255;
        out += (b < 16 ? '0' : '') + b.toString(16);
      }
    }
    return out;
  }

  global.QuizData = { SCHEMA, MAX_TIME, DEFAULT_QUESTIONS, cloneDefaults, normSql, checkSql, sha256 };
})(window);
