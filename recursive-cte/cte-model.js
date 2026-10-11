/*
 * Recursive CTE model: three small example queries and a function that runs
 * the recursion round by round, recording every step as a snapshot so the
 * player can show, rewind or skip to any step.
 */
(function (global) {
  'use strict';

  // The demo stops a runaway recursion (UNION ALL on cyclic data) after this many rounds.
  const MAX_ROUNDS = 6;

  const keyOf = (vals) => vals.join('\u0001');
  const plural = (n, one, many) => (n === 1 ? one : many || one + 's');
  const listOf = (items) => (items.length < 2
    ? items.join('')
    : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]);
  const edgeKey = (a, b) => a + '>' + b;

  // ---------- Example queries ----------
  // sql(u)      -> lines of the query, each tagged with the part it belongs to
  // anchor()    -> rows of round 0 (+ the base rows they came from)
  // expand(v)   -> rows the recursive part returns for one working row
  // graph       -> picture: nodes (by key), edges, and size of the drawing

  const EMPLOYEES = [
    [1, 'Asha', null], [2, 'Bimal', 1], [3, 'Chamari', 1],
    [4, 'Dilan', 2], [5, 'Eranga', 2], [6, 'Farah', 3],
    [7, 'Gayan', 4], [8, 'Hiruni', 4], [9, 'Isuru', 6],
  ].map(([id, name, mgr]) => ({ id, vals: [id, name, mgr] }));

  const FLIGHTS = [
    ['Colombo', 'Kandy'], ['Colombo', 'Galle'], ['Kandy', 'Jaffna'],
    ['Galle', 'Jaffna'], ['Jaffna', 'Colombo'], ['Jaffna', 'Ella'],
  ].map((vals, id) => ({ id, vals }));

  const SCENARIOS = {
    count: {
      id: 'count',
      title: 'Count to 5',
      resultName: 'nums',
      cols: ['n'],
      base: null,
      baseNote: 'This query reads no table. Each new row is computed from the working row alone: n + 1, as long as n < 5.',
      sql: (u) => [
        { t: 'WITH RECURSIVE nums(n) AS (', r: 'head' },
        { t: '  SELECT 1', r: 'anchor' },
        { t: '  ' + u, r: 'union' },
        { t: '  SELECT n + 1', r: 'recursive' },
        { t: '  FROM nums', r: 'recursive' },
        { t: '  WHERE n < 5', r: 'recursive' },
        { t: ')', r: 'head' },
        { t: 'SELECT * FROM nums;', r: 'final' },
      ],
      anchor: () => ({
        rows: [{ vals: [1], baseIds: [] }],
        text: 'The anchor part, SELECT 1, runs once. It returns one row, n = 1. That row goes into the result and is also the first working table.',
      }),
      expand: (v) => {
        const n = v[0];
        if (n < 5) {
          return { cands: [{ vals: [n + 1], baseIds: [] }], text: `Working row n = ${n}. The test ${n} < 5 is true, so the recursive part returns n + 1 = ${n + 1}.` };
        }
        return { cands: [], text: `Working row n = ${n}. The test ${n} < 5 is false, so the recursive part returns nothing for this row.` };
      },
      label: (v) => String(v[0]),
      nodeKey: (v) => String(v[0]),
      graph: {
        title: 'The numbers found so far',
        w: 560, h: 160, nw: 56,
        nodes: [1, 2, 3, 4, 5].map((n, i) => ({ key: String(n), label: String(n), x: 60 + i * 110, y: 80 })),
        edges: [['1', '2'], ['2', '3'], ['3', '4'], ['4', '5']],
      },
    },

    org: {
      id: 'org',
      title: 'Org chart',
      resultName: 'team',
      cols: ['id', 'name', 'level'],
      base: { name: 'employees', cols: ['id', 'name', 'manager_id'], rows: EMPLOYEES },
      sql: (u) => [
        { t: 'WITH RECURSIVE team(id, name, level) AS (', r: 'head' },
        { t: '  SELECT id, name, 0', r: 'anchor' },
        { t: '  FROM employees', r: 'anchor' },
        { t: '  WHERE manager_id IS NULL', r: 'anchor' },
        { t: '  ' + u, r: 'union' },
        { t: '  SELECT e.id, e.name, t.level + 1', r: 'recursive' },
        { t: '  FROM employees e', r: 'recursive' },
        { t: '  JOIN team t ON e.manager_id = t.id', r: 'recursive' },
        { t: ')', r: 'head' },
        { t: 'SELECT * FROM team;', r: 'final' },
      ],
      anchor: () => {
        const top = EMPLOYEES.filter((e) => e.vals[2] === null);
        return {
          rows: top.map((e) => ({ vals: [e.id, e.vals[1], 0], baseIds: [e.id] })),
          text: `The anchor part runs once: it picks the employee with no manager, ${listOf(top.map((e) => e.vals[1]))}, the top of the tree. That row goes into the result and is the first working table.`,
        };
      },
      expand: (v) => {
        const [id, name, level] = v;
        const kids = EMPLOYEES.filter((e) => e.vals[2] === id);
        if (!kids.length) {
          return { cands: [], text: `${name} (id ${id}) manages nobody, so the join finds no employee with manager_id = ${id}.` };
        }
        return {
          cands: kids.map((k) => ({ vals: [k.id, k.vals[1], level + 1], baseIds: [k.id] })),
          text: `${name} (id ${id}) is the manager of ${listOf(kids.map((k) => k.vals[1]))}. The join e.manager_id = t.id finds ${kids.length} ${plural(kids.length, 'row')}, one level deeper (level ${level + 1}).`,
        };
      },
      label: (v) => v[1],
      nodeKey: (v) => String(v[0]),
      graph: {
        title: 'Who reports to whom (arrow: manager to employee)',
        w: 560, h: 170, nw: 84,
        nodes: [
          [1, 'Asha', 0, 108], [2, 'Bimal', 1, 72], [3, 'Chamari', 1, 142],
          [4, 'Dilan', 2, 42], [5, 'Eranga', 2, 102], [6, 'Farah', 2, 142],
          [7, 'Gayan', 3, 22], [8, 'Hiruni', 3, 62], [9, 'Isuru', 3, 142],
        ].map(([id, label, col, y]) => ({ key: String(id), label, x: 48 + col * 155, y })),
        edges: EMPLOYEES.filter((e) => e.vals[2] !== null).map((e) => [String(e.vals[2]), String(e.id)]),
      },
    },

    routes: {
      id: 'routes',
      title: 'Flight routes',
      resultName: 'reach',
      cols: ['city'],
      base: { name: 'flights', cols: ['src', 'dest'], rows: FLIGHTS },
      sql: (u) => [
        { t: 'WITH RECURSIVE reach(city) AS (', r: 'head' },
        { t: "  SELECT 'Colombo'", r: 'anchor' },
        { t: '  ' + u, r: 'union' },
        { t: '  SELECT f.dest', r: 'recursive' },
        { t: '  FROM flights f', r: 'recursive' },
        { t: '  JOIN reach r ON f.src = r.city', r: 'recursive' },
        { t: ')', r: 'head' },
        { t: 'SELECT * FROM reach;', r: 'final' },
      ],
      anchor: () => ({
        rows: [{ vals: ['Colombo'], baseIds: [] }],
        text: 'The anchor part runs once: the starting city, Colombo. That row goes into the result and is the first working table.',
      }),
      expand: (v) => {
        const city = v[0];
        const out = FLIGHTS.filter((f) => f.vals[0] === city);
        if (!out.length) {
          return { cands: [], text: `${city}: no flight leaves from here, so the join f.src = '${city}' finds nothing.` };
        }
        return {
          cands: out.map((f) => ({ vals: [f.vals[1]], baseIds: [f.id] })),
          text: `${city}: ${out.length} ${plural(out.length, 'flight leaves', 'flights leave')} from here, to ${listOf(out.map((f) => f.vals[1]))}. Each destination is a candidate row.`,
        };
      },
      label: (v) => v[0],
      nodeKey: (v) => v[0],
      graph: {
        title: 'Flights (arrow: from, to)',
        w: 560, h: 160, nw: 84,
        nodes: [
          { key: 'Colombo', label: 'Colombo', x: 52, y: 80 },
          { key: 'Kandy', label: 'Kandy', x: 205, y: 28 },
          { key: 'Galle', label: 'Galle', x: 205, y: 132 },
          { key: 'Jaffna', label: 'Jaffna', x: 358, y: 80 },
          { key: 'Ella', label: 'Ella', x: 508, y: 80 },
        ],
        edges: [['Colombo', 'Kandy'], ['Colombo', 'Galle'], ['Kandy', 'Jaffna'], ['Galle', 'Jaffna'], ['Jaffna', 'Ella'], ['Jaffna', 'Colombo', 'back']],
      },
    },
  };

  const ORDER = ['count', 'org', 'routes'];

  // ---------- Pseudocode of what the database does ----------

  const pseudo = (dedupe) => [
    { t: 'result  = run the anchor part', i: 0 },
    { t: 'working = result', i: 0 },
    { t: 'while working is not empty:', i: 0 },
    { t: 'new = recursive part, reading working', i: 1 },
    dedupe
      ? { t: 'new = new minus rows already in result', i: 1, cm: 'UNION' }
      : { t: 'keep every row of new', i: 1, cm: 'UNION ALL' },
    { t: 'result  = result + new', i: 1 },
    { t: 'working = new', i: 1 },
    { t: 'outer SELECT reads result', i: 0 },
  ];

  const linesOf = (lines, ...regions) => lines.reduce((acc, l, i) => (regions.includes(l.r) ? acc.concat(i) : acc), []);

  // ---------- Run the recursion and record every step ----------

  function run(scn, dedupe) {
    const u = dedupe ? 'UNION' : 'UNION ALL';
    const lines = scn.sql(u);
    const L = {
      head: linesOf(lines, 'head'),
      anchor: linesOf(lines, 'anchor'),
      rec: linesOf(lines, 'recursive'),
      recU: linesOf(lines, 'recursive', 'union'),
      final: linesOf(lines, 'final'),
    };

    const steps = [];
    const result = [];
    let work = [];
    let workRound = 0;
    let round = 0;
    const used = new Set();

    const push = (o) => steps.push(Object.assign({
      round,
      status: 'info',
      short: '',
      sql: [],
      pseudo: [],
      base: [],
      workHot: -1,
      workRound,
      work: work.map((w) => w.slice()),
      result: result.map((r) => ({ vals: r.vals, round: r.round })),
      fresh: 0,
      rejected: [],
      edgesNew: [],
      edgesRej: [],
      hotNode: null,
      used: [...used],
    }, o));

    push({
      short: 'Start',
      text: `WITH RECURSIVE builds its result in rounds. Round 0 runs the anchor part once. Each later round runs the recursive part on the rows the previous round produced, until a round produces nothing.`,
      sql: L.head,
    });

    const a = scn.anchor();
    a.rows.forEach((r) => result.push({ vals: r.vals, round: 0 }));
    work = a.rows.map((r) => r.vals);
    push({
      short: `Round 0 (anchor): ${a.rows.map((r) => scn.label(r.vals)).join(', ')}`,
      text: a.text,
      status: 'success',
      sql: L.anchor,
      pseudo: [0, 1],
      base: [].concat(...a.rows.map((r) => r.baseIds)),
      fresh: a.rows.length,
    });

    let capped = false;
    while (work.length) {
      round += 1;
      push({
        short: `Round ${round} starts`,
        text: `Round ${round}: the recursive part runs once for each row of the working table, the ${work.length} ${plural(work.length, 'row')} produced by round ${round - 1}.`,
        sql: L.rec,
        pseudo: [2, 3],
      });

      const born = [];
      work.forEach((w, wi) => {
        const { cands, text } = scn.expand(w);
        const wKey = scn.nodeKey(w);
        const notes = [];
        const rejected = [];
        const edgesNew = [];
        const edgesRej = [];
        const baseIds = [];
        const added = [];
        let repeats = 0;

        cands.forEach((c) => {
          baseIds.push(...c.baseIds);
          const k = keyOf(c.vals);
          const twin = result.find((r) => keyOf(r.vals) === k);
          const edge = edgeKey(wKey, scn.nodeKey(c.vals));
          if (twin && dedupe) {
            const same = twin.round === round;
            rejected.push({ vals: c.vals, why: same ? 'duplicate in this round' : 'already in the result' });
            edgesRej.push(edge);
            notes.push(`${scn.label(c.vals)} ${same ? 'was just found in this round' : 'is already in the result'}, so UNION discards it.`);
            return;
          }
          if (twin) {
            repeats += 1;
            notes.push(`${scn.label(c.vals)} is a repeat, but UNION ALL keeps it.`);
          }
          result.push({ vals: c.vals, round });
          born.push(c.vals);
          used.add(edge);
          edgesNew.push(edge);
          added.push(scn.label(c.vals));
        });

        const status = rejected.length || repeats ? 'warn' : added.length ? 'success' : 'info';
        push({
          short: `${scn.label(w)}: ${added.length ? 'adds ' + listOf(added) : rejected.length ? 'only repeats' : 'nothing'}`,
          text: [text].concat(notes).join(' '),
          status,
          sql: rejected.length ? L.recU : L.rec,
          pseudo: rejected.length ? [3, 4] : [3],
          base: baseIds,
          workHot: wi,
          hotNode: wKey,
          fresh: added.length,
          rejected,
          edgesNew,
          edgesRej,
        });
      });

      if (!born.length) {
        work = [];
        push({
          short: `Round ${round}: no new rows`,
          text: `Round ${round} produced no new rows, so the working table is empty and the recursion stops.`,
          status: 'success',
          pseudo: [2],
        });
        break;
      }

      work = born;
      workRound = round;
      push({
        short: `Round ${round} done: ${born.length} new ${plural(born.length, 'row')}`,
        text: `Round ${round} produced ${born.length} new ${plural(born.length, 'row')}. They are now in the result, and they replace the working table for round ${round + 1}.`,
        sql: L.rec,
        pseudo: [5, 6],
        fresh: 0,
      });

      if (round >= MAX_ROUNDS) {
        capped = true;
        work = [];
        push({
          short: 'Demo stops here',
          text: `The demo stops after ${MAX_ROUNDS} rounds. Rows keep coming (the data has a cycle), so a real database would never finish on its own. Use UNION to drop repeats, or add a limit in the WHERE clause.`,
          status: 'error',
          pseudo: [2],
        });
        break;
      }
    }

    push({
      short: 'Final SELECT',
      text: `The outer query, ${lines[L.final[0]].t.replace(/;$/, '')}, reads the finished result: ${result.length} ${plural(result.length, 'row')}${capped ? ' (cut off by the demo)' : ''}.`,
      status: capped ? 'warn' : 'success',
      sql: L.final,
      pseudo: [7],
    });

    return { steps, lines, pseudo: pseudo(dedupe), capped };
  }

  global.CteModel = { SCENARIOS, ORDER, MAX_ROUNDS, run, edgeKey, keyOf };
})(window);
