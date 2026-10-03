/*
 * The decision panel beside the canvas. For each step it shows what the
 * current component is looking at: the SQL clauses, the rule list of the
 * rewriter, statistics and cost comparisons of the planner, the DP table of
 * join orders, and finally the plan as EXPLAIN would print it.
 */
(function (global) {
  'use strict';

  const E = global.QoEngine;
  const { fmtInt, fmtRows, fmtCost, fmtSel, fmtBig } = E;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const code = (s) => `<code>${esc(s)}</code>`;

  const HEADS = {
    parse: ['Parser', 'reads the SQL text'],
    rewrite: ['Rewriter · RBO', 'rule-based: fixed rules, no statistics'],
    plan: ['Planner · CBO', 'cost-based: statistics and estimated costs'],
    done: ['Execution plan', 'handed to the executor'],
  };

  // Bar width (%) on a log scale, so costs that differ 1000× still fit.
  function logW(v, min, max) {
    if (!(max > min)) return 100;
    const lv = Math.log(Math.max(v, 1e-9)), lmin = Math.log(Math.max(min, 1e-9)), lmax = Math.log(max);
    return 6 + 94 * ((lv - lmin) / (lmax - lmin));
  }

  function rowsTxt(n) { return `${fmtRows(n)} row${Math.round(n) <= 1 ? '' : 's'}`; }

  // ---------- Kinds ----------

  function clauses(b) {
    return `<p class="b-lead">The grammar is fine. Each clause will become an operator of the query tree:</p>
      <ul class="b-clauses">${b.rows.map((r) => `
        <li class="tone-${r.tone}"><span class="b-kw">${esc(r.kw)}</span><span class="b-text">${code(r.text)}</span><span class="b-op"><b>${esc(r.op)}</b>${esc(r.opName)}</span></li>`).join('')}
      </ul>
      <p class="b-note">SQL says <em>what</em> to return, not <em>how</em> to compute it. Finding the “how” is the optimizer’s job.</p>`;
  }

  function bind(b) {
    const tables = b.rows.filter((r) => r.kind === 'table');
    const colsB = b.rows.filter((r) => r.kind === 'col');
    const row = (r) => `<tr><td>${code(r.text)}</td><td class="arrow">→</td><td>${code(r.to)}</td><td class="muted">${esc(r.note)}</td><td class="ok">✓</td></tr>`;
    return `<p class="b-lead">Every name is looked up in the catalog (the database’s dictionary of tables and columns):</p>
      <table class="b-table">
        <thead><tr><th>Written</th><th></th><th>Means</th><th></th><th></th></tr></thead>
        <tbody>${tables.map(row).join('')}${colsB.map(row).join('')}</tbody>
      </table>
      <p class="b-note">Unknown tables, misspelt columns and ambiguous names (a column that exists in two tables) are reported here, try one!</p>`;
  }

  function canonical(b) {
    const sub = (s) => `<sub>${esc(s)}</sub>`;
    let inner = b.from.map(esc).join(' <b class="x">×</b> ');
    if (b.pred.length) inner = `σ${sub(b.pred.join(' ∧ '))}( ${inner} )`;
    let ra = `π${sub(b.proj)}( ${inner} )`;
    if (b.top.length) ra = `${b.top.join(' · ')} ( ${ra} )`;
    const big = b.from.length > 1;
    return `<p class="b-lead">The canonical form of SELECT … FROM … WHERE, in relational algebra:</p>
      <div class="b-ra">${ra}</div>
      ${big ? `<div class="b-alert">Executed literally, × first pairs every row with every row:<br><b>${b.sizes.join(' × ')} = ${esc(fmtBig(b.prodRows))}</b> combinations, before σ throws nearly all of them away.</div>` : ''}
      ${b.subs ? '<p class="b-note">The subquery hangs off σ (dashed): run literally, it would be evaluated for every row.</p>' : ''}
      <p class="b-note">Correct, but ${big ? 'hopelessly slow' : 'not yet optimized'}. Now the optimizer looks for an equivalent tree that is much cheaper to run.</p>`;
  }

  function rules(b) {
    const pill = (r) => {
      if (r.status === 'applied' || (r.status === 'active' && r.count)) return `<span class="b-pill ok">✓${r.count > 1 ? ` ×${r.count}` : ''}</span>`;
      if (r.status === 'active') return '<span class="b-pill on">now</span>';
      if (r.status === 'skipped') return `<span class="b-pill">${esc(r.note || 'no match')}</span>`;
      if (r.status === 'na') return `<span class="b-pill">${esc(r.note || 'not needed')}</span>`;
      return '';
    };
    const list = `<ol class="b-rules">${b.rules.map((r, i) => `
      <li class="st-${r.status}${i === b.current ? ' current' : ''}"><span class="n">${i + 1}</span><div><b>${esc(r.name)}</b><small>${esc(r.short)}</small></div>${pill(r)}</li>`).join('')}
      </ol>`;
    let detail = '';
    if (b.detail && b.detail.lines && b.detail.lines.length) {
      detail = `<div class="b-detail fresh">${b.detail.lines.map((l) => `
        <div class="b-change">
          <code class="before${l.after == null ? ' gone' : ''}">${esc(l.before)}</code>
          ${l.after != null ? `<span class="arrow">→</span><code class="after${l.after === 'FALSE' ? ' bad' : ''}">${esc(l.after)}</code>` : ''}
          <small>${esc(l.why || '')}</small>
        </div>`).join('')}</div>`;
    } else if (b.detail && b.detail.text) {
      detail = `<div class="b-detail fresh"><p>${esc(b.detail.text)}</p></div>`;
    }
    const lead = b.current < 0
      ? '<p class="b-lead">Rules fire in a fixed order, wherever their pattern matches. No statistics, no costs.</p>'
      : '';
    return lead + list + detail;
  }

  function graph(b) {
    return `<p class="b-lead">The planner sees tables (with their own filters) linked by join conditions:</p>
      <ul class="b-tables">${b.tables.map((t) => `<li><b>${esc(t.name)}</b>${t.sub ? ' <span class="b-pill">subquery</span>' : ''}<div>${t.filters.length ? t.filters.map(code).join(' ') : '<span class="muted">no filter</span>'}</div></li>`).join('')}</ul>
      ${b.edges.length ? `<h4>Join conditions</h4><ul class="b-plain">${b.edges.map((e) => `<li>${code(e)}</li>`).join('')}</ul>` : ''}
      ${b.complex.length ? `<h4>Other conditions</h4><ul class="b-plain">${b.complex.map((e) => `<li>${code(e)}</li>`).join('')}</ul>` : ''}
      ${b.tables.length > 1 ? '<p class="b-note">Joins can be reordered: (A ⋈ B) ⋈ C = A ⋈ (B ⋈ C) = (A ⋈ C) ⋈ B. Every order gives the same rows, at very different costs.</p>' : ''}`;
  }

  function stats(b) {
    return `<p class="b-lead">Statistics from the catalog (kept fresh by <code>ANALYZE</code>) for the columns this query uses:</p>
      ${b.tables.map((t) => `
      <div class="b-stat">
        <div class="b-stat-head"><b>${esc(t.name)}</b><span>${fmtInt(t.rows)} rows · ${fmtInt(t.pages)} page${t.pages === 1 ? '' : 's'} (${t.perPage} rows/page)</span></div>
        ${t.cols.length ? `<table><thead><tr><th>column</th><th>distinct (NDV)</th><th>min … max</th><th>index</th></tr></thead><tbody>${t.cols.map((c) => `
          <tr><td>${code(c.name)}</td><td class="num">${fmtInt(c.ndv)}</td><td>${esc(c.range)}</td><td>${c.indexed ? `<span class="b-pill ok">${esc(c.index)}</span>` : '<span class="muted">-</span>'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">no filter or join column</p>'}
      </div>`).join('')}
      <p class="b-note">Cost units: a page read in order = 1.0 · a random page read = ${b.rpc} (${b.storage === 'ssd' ? 'SSD' : 'hard disk'}) · per row = 0.01 · per comparison = 0.0025.</p>`;
  }

  function table(b) {
    const est = b.filters.length
      ? `<table class="b-est">${b.filters.map((f) => `
          <tr><td>${code(f.text)}${f.derived ? ' <span class="b-pill ok">derived</span>' : ''}</td><td class="why">${esc(f.why)}</td><td class="num">${fmtSel(f.sel)}</td></tr>`).join('')}
          <tr class="total"><td colspan="2">${fmtInt(b.N)} rows × ${b.filters.length > 1 ? b.filters.map((f) => fmtSel(f.sel)).join(' × ') : fmtSel(b.sel)}</td><td class="num">≈ ${esc(rowsTxt(b.rows))}</td></tr>
        </table>`
      : `<p class="muted">No filter: all ${fmtInt(b.N)} rows are needed.</p>`;
    const show = b.show === 'acc';
    const costs = b.cands.map((c) => c.cost);
    const min = Math.min(...costs), max = Math.max(...costs);
    const acc = `<div class="b-cands">${b.cands.map((c) => `
        <div class="b-cand${c.best ? ' best' : ''} k-${c.kind}">
          <div class="top"><b>${esc(c.label)}</b><span class="cost">${fmtCost(c.cost)}</span>${c.best ? '<span class="b-pill ok">cheapest</span>' : ''}</div>
          <div class="bar"><i style="width:${logW(c.cost, min * 0.5, max).toFixed(1)}%"></i></div>
          <small class="formula">${esc(c.formula)}</small>
          <small>${esc(c.note)}</small>
        </div>`).join('')}
        ${b.unusable.length ? `<ul class="b-unusable">${b.unusable.map((u) => `<li>${code(u.index)}: ${esc(u.why)}</li>`).join('')}</ul>` : ''}
      </div>`;
    return `<div class="b-sub"><b>${esc(b.name)}</b> · ${fmtInt(b.N)} rows · ${fmtInt(b.pages)} page${b.pages === 1 ? '' : 's'}</div>
      <h4>1 · How many rows pass the filters?</h4>
      <div class="${show ? '' : 'fresh'}">${est}</div>
      <h4 class="${show ? '' : 'later'}">2 · Cheapest way to read them</h4>
      ${show ? `<div class="fresh">${acc}</div>` : '<p class="muted small">next step</p>'}`;
  }

  function dp(b) {
    const levels = [];
    b.cells.forEach((c) => { (levels[c.level] = levels[c.level] || []).push(c); });
    const cell = (c) => {
      if (c.skip) return `<div class="cell skip" title="No join condition inside this set"><b>${esc(c.label)}</b><small>no join condition</small></div>`;
      const show = c.state !== 'pending';
      return `<div class="cell st-${c.state}${c.state === 'current' ? ' fresh' : ''}">
        <b>${esc(c.label)}</b>
        ${show ? `<small>≈${esc(rowsTxt(c.rows))}</small><span>${esc(c.method)} · ${fmtCost(c.cost)}</span>` : '<small>…</small>'}
      </div>`;
    };
    const lattice = `<div class="b-lattice">${levels.map((lv, i) => (lv ? `
      <div class="lvl"><span class="lvl-n" title="tables in the set">${i}</span><div class="cells">${lv.map(cell).join('')}</div></div>` : '')).join('')}</div>`;
    let detail = '';
    const d = b.detail;
    if (d) {
      const all = d.rows2.flatMap((r) => r.costs.filter((x) => x.cost != null).map((x) => x.cost));
      const min = Math.min(...all), max = Math.max(...all);
      const cellH = (x) => {
        if (x.cost == null) return `<td class="na" title="${esc(x.na)}">-</td>`;
        return `<td class="${x.win ? 'win' : ''}" title="${esc(x.formula || '')}"><span class="mbar" style="width:${logW(x.cost, min * 0.5, max).toFixed(1)}%"></span><span class="v">${fmtCost(x.cost)}</span></td>`;
      };
      detail = `<div class="b-matrix fresh">
        <div class="b-matrix-head"><b>${esc(d.label)}</b><span>≈ ${esc(rowsTxt(d.rows))} for every order</span></div>
        <small class="muted">rows ≈ ${esc(d.rowsWhy)}</small>
        <table>
          <thead><tr><th>order (outer ⋈ inner)</th>${['Nested loop', 'Index NL', 'Hash', 'Merge'].map((h) => `<th>${h}</th>`).join('')}</tr></thead>
          <tbody>${d.rows2.map((r) => (r.na
            ? `<tr class="invalid"><td>${code(r.label)}</td><td colspan="4" class="na">${esc(r.na)}</td></tr>`
            : `<tr class="${r.best ? 'has-win' : ''}"><td>${code(r.label)}</td>${r.costs.map(cellH).join('')}</tr>`)).join('')}
          </tbody>
        </table>
        <div class="b-win">Kept: <b>${esc(d.win.method)}</b> of ${code(d.win.label)} · cost <b>${fmtCost(d.win.cost)}</b>: all other plans for this set are pruned.</div>
      </div>`;
    }
    const lead = d ? '' : '<p class="b-lead">Dynamic programming: the best plan for each set of tables, smallest sets first. Bigger sets only extend the winners of smaller ones.</p>';
    return lead + lattice + detail;
  }

  function final(b) {
    if (b.empty) {
      return `<div class="b-final"><div><span class="muted">total cost</span><b>0</b></div><div><span class="muted">result</span><b>empty</b></div></div>
        <p class="b-note">The rewriter proved that no row can satisfy the WHERE clause, so not a single page is read. Rules alone can sometimes beat any cost model.</p>
        <h4>EXPLAIN</h4><pre class="b-explain">${esc(b.explain.join('\n'))}</pre>`;
    }
    const bars = [
      { label: 'Chosen plan (cost-based)', cost: b.cost, cls: 'win' },
      { label: `Rules only: ${b.rules.desc}`, cost: b.rules.cost, cls: 'rules' },
    ];
    const max = Math.max(...bars.map((x) => x.cost));
    const min = Math.min(...bars.map((x) => x.cost));
    return `<div class="b-final">
        <div><span class="muted">total cost</span><b>${fmtCost(b.cost)}</b></div>
        <div><span class="muted">result</span><b>≈ ${esc(rowsTxt(b.rows))}</b></div>
        <div><span class="muted">plans costed</span><b>${fmtInt(b.considered)}</b></div>
      </div>
      <div class="b-compare">${bars.map((x) => `
        <div class="b-cmp ${x.cls}"><div class="top"><span>${esc(x.label)}</span><b>${fmtCost(x.cost)}</b></div><div class="bar"><i style="width:${logW(x.cost, min * 0.5, max).toFixed(1)}%"></i></div></div>`).join('')}
        ${b.naive.tables.length > 1 ? `<p class="b-note">The canonical tree, run as written, would first build ${b.naive.tables.join(' × ')} = <b>${esc(fmtBig(b.naive.rows))}</b> row pairs.</p>` : ''}
      </div>
      <h4>Decisions</h4>
      <ul class="b-decisions">${b.decisions.map((d) => `<li><span>${code(d.what)}</span><b>${esc(d.choice)}</b><small>${esc(d.why)}</small></li>`).join('')}</ul>
      <h4>EXPLAIN</h4>
      <pre class="b-explain">${esc(b.explain.join('\n'))}</pre>`;
  }

  function error(b) {
    const e = b.err;
    // Show a window of the line around the error, so the caret stays visible.
    let line = e.text, at = e.at;
    if (line.length > 46 && at > 18) {
      const from = at - 16;
      line = '…' + line.slice(from);
      at = at - from + 1;
    }
    if (line.length > 52) line = line.slice(0, 51) + '…';
    const caret = ' '.repeat(Math.max(0, at)) + '^'.repeat(Math.max(1, Math.min(e.len, 40)));
    return `<div class="b-error">
        <b>${esc(b.stage)} error</b> <span class="muted">line ${e.line}, column ${e.col}</span>
        <p>${esc(e.msg)}</p>
        <pre>${esc(line)}\n<span class="caret">${esc(caret)}</span></pre>
        ${e.hint ? `<p class="hint">${esc(e.hint)}</p>` : ''}
      </div>
      ${b.tables ? `<h4>Tables in the catalog</h4><ul class="b-plain b-catalog">${b.tables.map((t) => `<li><b>${esc(t.name)}</b> ${t.cols.map(code).join(' ')}</li>`).join('')}</ul>` : ''}
      <p class="b-note">Fix the query in the editor and press Optimize again.</p>`;
  }

  function intro() {
    return `<p class="b-lead">Type a query (or pick an example) and press <b>Optimize</b>. You will see:</p>
      <ol class="b-plain">
        <li><b>Parser</b>: SQL text → query tree</li>
        <li><b>Rewriter (RBO)</b>: fixed rules make the tree smarter</li>
        <li><b>Planner (CBO)</b>: statistics and costs pick the plan</li>
      </ol>`;
  }

  const KINDS = { clauses, bind, canonical, rules, graph, stats, table, dp, final, error, intro };

  function render(el, step, animate) {
    const b = step.board || { kind: 'intro' };
    const [title, sub] = HEADS[step.phase] || ['Query optimizer', ''];
    el.classList.toggle('still', !animate);
    el.dataset.phase = step.phase || '';
    el.innerHTML = `<header class="b-head"><h2>${esc(title)}</h2><span>${esc(sub)}</span></header>
      <div class="b-body">${(KINDS[b.kind] || intro)(b)}</div>`;
  }

  global.QoBoard = { render };
})(window);
