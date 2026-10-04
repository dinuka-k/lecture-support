/*
 * B+ tree of order m with step recording.
 *
 * All keys live in the leaves; internal nodes hold separator keys that only guide
 * searches (a key ≥ separator goes right). Leaves are linked left to right, so a
 * range query walks along the leaf level. Leaf splits COPY the first key of the new
 * right leaf up; internal splits MOVE their median up, as in a B-tree.
 *
 * Steps have the same shape as the B-tree demo's (snapshot + highlights + message),
 * plus `links`: leaf id -> role for the leaf-chain arrow leaving that leaf.
 */
(function (global) {
  'use strict';

  let nextId = 1;
  const newNode = (keys = [], children = []) => ({ id: nextId++, keys, children });
  const isLeaf = (n) => n.children.length === 0;
  const clone = (n) => (n ? { id: n.id, keys: n.keys.slice(), children: n.children.map(clone) } : null);
  const fmt = (keys) => (keys.length ? '[' + keys.join(' | ') + ']' : '[ ]');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function height(n) {
    let h = 0;
    for (; n; n = n.children[0]) h++;
    return h;
  }
  const countNodes = (n) => (n ? 1 + n.children.reduce((s, c) => s + countNodes(c), 0) : 0);
  function leaves(n, out = []) {
    if (!n) return out;
    if (isLeaf(n)) out.push(n);
    else n.children.forEach((c) => leaves(c, out));
    return out;
  }
  const allKeys = (root) => leaves(root).flatMap((l) => l.keys);

  // Internal node: child index = number of separators ≤ k (equal keys go right).
  const route = (x, k) => {
    let i = 0;
    while (i < x.keys.length && k >= x.keys[i]) i++;
    return i;
  };
  // Leaf: index of the first key ≥ k.
  const locate = (x, k) => {
    let i = 0;
    while (i < x.keys.length && k > x.keys[i]) i++;
    return i;
  };

  function relation(x, k, i) {
    const ks = x.keys;
    if (i === 0) return `${k} < ${ks[0]}`;
    if (i === ks.length) return `${k} ≥ ${ks[i - 1]}`;
    return `${ks[i - 1]} ≤ ${k} < ${ks[i]}`;
  }

  // ---------- Pseudocode ----------

  const CODE = {
    search: [
      'SEARCH(k)',
      '  x ← root',
      '  while x is internal:',
      '    i ← number of separators ≤ k',
      '    x ← x.child[i]            ▹ equal keys go right',
      '  if k is in leaf x: found',
      '  else: not found             ▹ only leaves hold keys',
    ],
    range: [
      'RANGE(lo, hi)',
      '  x ← leaf where lo belongs   ▹ search down as usual',
      '  loop',
      '    for each key k in x with k ≥ lo:',
      '      if k > hi: stop',
      '      output k',
      '    x ← x.next                ▹ follow the leaf link',
    ],
    insert: [
      'INSERT(k)',
      '  if the tree is empty: root ← leaf [k]; return',
      '  x ← leaf where k belongs    ▹ search down',
      '  if k is in x: return         ▹ no duplicates',
      '  insert k into x in order',
      '  if leaf x has more than m − 1 keys:',
      '    split x; COPY the right half\'s first key up',
      '  while an internal node has more than m − 1 keys:',
      '    split it; MOVE its median up',
      '  if the root split: new root ▹ tree grows taller',
    ],
    delete: [
      'DELETE(k)',
      '  x ← leaf holding k          ▹ search down',
      '  if k is not found: return',
      '  remove k from leaf x',
      '  if x has too few keys (leaf underflow):',
      '    borrow a key from a sibling leaf;',
      '      parent separator ← first key of the right leaf',
      '    or merge with a sibling leaf; drop the separator',
      '  while an internal node underflows:',
      '    borrow through the parent, or merge with',
      '      the separator pulled down (as in a B-tree)',
      '  if the root has no keys: root ← its child',
    ],
  };
  const OP_NAMES = { insert: 'Insert', delete: 'Delete', search: 'Search', range: 'Range' };

  class Recorder {
    constructor(tree, op, key, enabled, label) {
      this.tree = tree;
      this.op = op;
      this.key = key;
      this.enabled = enabled;
      this.label = label || `${OP_NAMES[op]} ${key}`;
      this.code = CODE[op];
      this.steps = [];
    }

    snap(s) {
      if (!this.enabled) return;
      this.steps.push({
        op: this.op, key: this.key, label: this.label, code: this.code,
        tree: clone(this.tree.root),
        msg: s.msg, status: s.status || 'info', line: s.line == null ? -1 : s.line,
        nodes: s.nodes || {}, keys: s.keys || {}, edges: s.edges || {}, links: s.links || {},
        ghost: s.ghost || null, origin: s.origin || null, into: s.into || null,
      });
    }
  }

  class BPlusTree {
    constructor(order = 4, opts = {}) {
      this.order = order;
      this.splitBias = opts.splitBias || 'left';
      this.deleteWith = opts.deleteWith || 'predecessor';
      this.root = null;
    }

    get maxKeys() { return this.order - 1; }
    get minKeys() { return Math.ceil(this.order / 2) - 1; } // internal nodes (non-root)
    get minLeaf() { return Math.ceil((this.order - 1) / 2); } // leaves (non-root)

    clear() { this.root = null; }
    load(snapshot) { this.root = clone(snapshot); }
    snapshot() { return clone(this.root); }
    keys() { return allKeys(this.root); }
    has(k) { return this.keys().includes(k); }

    // Walks from the root to the leaf where k belongs, recording each internal node.
    walk(R, k, line) {
      let x = this.root;
      const path = [];
      while (!isLeaf(x)) {
        const i = route(x, k);
        const next = x.children[i];
        const roles = {};
        if (i > 0) roles[x.keys[i - 1]] = 'compare';
        if (i < x.keys.length) roles[x.keys[i]] = 'compare';
        R.snap({
          msg: `Internal node ${fmt(x.keys)}: ${relation(x, k, i)}, so go down to child ${i + 1}.${i > 0 && x.keys[i - 1] === k ? ` (${k} equals a separator — equal keys live in the right subtree.)` : ''}`,
          line,
          nodes: { [x.id]: 'visit' },
          keys: roles,
          edges: { [next.id]: 'path' },
          ghost: { key: k, node: x.id, gap: i },
        });
        path.push(x);
        x = next;
      }
      return { x, path };
    }

    // ---------- Search ----------

    search(k, record = true) {
      const R = new Recorder(this, 'search', k, record);
      if (!this.root) {
        R.snap({ msg: `The tree is empty, so ${k} is not found.`, status: 'error', line: 6 });
        return R.steps;
      }
      const { x, path } = this.walk(R, k, 4);
      const i = locate(x, k);
      if (x.keys[i] === k) {
        R.snap({
          msg: `Leaf ${fmt(x.keys)}: found ${k}. In a B+ tree every search ends in a leaf — here after ${plural(path.length + 1, 'node')}, the height of the tree.`,
          status: 'success', line: 5, nodes: { [x.id]: 'found' }, keys: { [k]: 'found' }, ghost: { key: k, node: x.id, gap: i + 0.5 },
        });
      } else {
        R.snap({
          msg: `Leaf ${fmt(x.keys)}: ${k} is not here, so it is not in the tree (even if a separator above has that value).`,
          status: 'error', line: 6, nodes: { [x.id]: 'visit' }, ghost: { key: k, node: x.id, gap: i },
        });
      }
      return R.steps;
    }

    // ---------- Range search ----------

    range(lo, hi, record = true) {
      const R = new Recorder(this, 'range', lo, record, `Range ${lo}–${hi}`);
      if (!this.root) {
        R.snap({ msg: 'The tree is empty.', status: 'error' });
        return R.steps;
      }
      R.snap({ msg: `Range query ${lo} ≤ k ≤ ${hi}: first search down for ${lo}, then walk along the linked leaves.`, line: 1 });
      let { x } = this.walk(R, lo, 1);
      const order = leaves(this.root);
      const found = [];
      let li = order.indexOf(x);
      for (;;) {
        const roles = {};
        found.forEach((k) => { roles[k] = 'found'; });
        let stop = false;
        x.keys.forEach((k) => {
          if (k < lo) return;
          if (k > hi) { stop = true; if (!roles[k]) roles[k] = 'compare'; return; }
          found.push(k);
          roles[k] = 'found';
        });
        const inLeaf = x.keys.filter((k) => k >= lo && k <= hi);
        const next = order[li + 1];
        R.snap({
          msg: stop
            ? `Leaf ${fmt(x.keys)}: ${inLeaf.length ? `${inLeaf.join(', ')} ${inLeaf.length === 1 ? 'is' : 'are'} in range; ` : ''}a key above ${hi} appears, so stop.`
            : `Leaf ${fmt(x.keys)}: ${inLeaf.length ? `${inLeaf.join(', ')} ${inLeaf.length === 1 ? 'is' : 'are'} in range` : 'nothing in range here'}.${next ? ' Follow the link to the next leaf — no need to go back up the tree.' : ' This was the last leaf.'}`,
          status: stop || !next ? 'success' : 'info',
          line: stop ? 4 : next ? 6 : 5,
          nodes: { [x.id]: 'found' },
          keys: roles,
          links: next && !stop ? { [x.id]: 'path' } : {},
        });
        if (stop || !next) break;
        x = next;
        li++;
      }
      const roles = {};
      found.forEach((k) => { roles[k] = 'found'; });
      R.snap({
        msg: `Done: ${found.length ? found.join(', ') : 'no keys'} — found by one search down plus a walk along the leaves. This is why databases use B+ trees for range queries and ORDER BY.`,
        status: 'success', keys: roles,
      });
      return R.steps;
    }

    // ---------- Insert ----------

    insert(k, record = true) {
      const R = new Recorder(this, 'insert', k, record);
      if (!this.root) {
        R.snap({ msg: `Insert ${k}: the tree is empty.`, line: 1, ghost: { key: k, node: null, gap: 0 } });
        this.root = newNode([k]);
        R.snap({ msg: `${k} becomes the root — a single leaf.`, status: 'success', line: 1, nodes: { [this.root.id]: 'new' }, keys: { [k]: 'new' } });
        return R.steps;
      }
      const { x, path } = this.walk(R, k, 2);
      const i = locate(x, k);
      if (x.keys[i] === k) {
        R.snap({ msg: `${k} is already in leaf ${fmt(x.keys)}; keys are unique, so nothing changes.`, status: 'warn', line: 3, nodes: { [x.id]: 'visit' }, keys: { [k]: 'found' }, ghost: { key: k, node: x.id, gap: i + 0.5 } });
        return R.steps;
      }
      R.snap({ msg: `Reached leaf ${fmt(x.keys)} — all keys live in leaves, so ${k} goes here.`, line: 4, nodes: { [x.id]: 'visit' }, ghost: { key: k, node: x.id, gap: i } });
      x.keys.splice(i, 0, k);
      const over = x.keys.length > this.maxKeys;
      R.snap({
        msg: over ? `The leaf is now ${fmt(x.keys)}: ${x.keys.length} keys, but at most ${this.maxKeys} fit.` : `The leaf is now ${fmt(x.keys)}: no split needed.`,
        status: over ? 'warn' : 'info', line: over ? 5 : 4, nodes: { [x.id]: over ? 'overflow' : 'new' }, keys: { [k]: 'new' },
      });
      let splits = 0;
      if (over) {
        // Leaf split: the right half's first key is COPIED up.
        const cut = Math.ceil(x.keys.length / 2);
        const right = newNode(x.keys.slice(cut));
        const leftKeys = x.keys.slice(0, cut);
        const up = right.keys[0];
        R.snap({
          msg: `Split the leaf into ${fmt(leftKeys)} and ${fmt(right.keys)}. The first key of the right leaf, ${up}, is COPIED up as a separator — ${up} stays in the leaf too.`,
          status: 'warn', line: 6, nodes: { [x.id]: 'overflow' }, keys: { [k]: 'new', [up]: 'median' },
        });
        x.keys = leftKeys;
        splits++;
        this.insertIntoParent(R, x, up, right, path, k);
        splits += this.fixInternal(R, path, k);
      }
      R.snap({
        msg: splits ? `Done: ${k} inserted after ${plural(splits, 'split')}; height ${height(this.root)}.` : `Done: ${k} inserted.`,
        status: 'success', keys: { [k]: 'new' },
      });
      return R.steps;
    }

    insertIntoParent(R, x, up, right, path, k) {
      const origin = { [right.id]: x.id };
      if (x === this.root) {
        this.root = newNode([up], [x, right]);
        R.snap({
          msg: `${x.children.length ? 'The root split' : 'The root leaf split'}: a new root [${up}] is created above. The tree grows one level (height ${height(this.root)}).`,
          line: 9, nodes: { [this.root.id]: 'new', [x.id]: 'split', [right.id]: 'split' }, keys: { [k]: 'new', [up]: 'median' }, origin,
        });
        return;
      }
      const parent = path[path.length - 1];
      const ci = parent.children.indexOf(x);
      parent.keys.splice(ci, 0, up);
      parent.children.splice(ci + 1, 0, right);
      const pOver = parent.keys.length > this.maxKeys;
      R.snap({
        msg: `${up} goes into the parent → ${fmt(parent.keys)}.${isLeaf(x) ? ' The new leaf is linked into the leaf chain.' : ''}${pOver ? ' Now the parent overflows.' : ''}`,
        status: pOver ? 'warn' : 'info', line: isLeaf(x) ? 6 : 8,
        nodes: { [parent.id]: pOver ? 'overflow' : 'visit', [x.id]: 'split', [right.id]: 'split' },
        keys: { [k]: 'new', [up]: 'median' }, origin,
        links: isLeaf(x) ? { [x.id]: 'path', [right.id]: 'path' } : {},
      });
    }

    // Internal splits: the median MOVES up.
    fixInternal(R, path, k) {
      let splits = 0;
      while (path.length) {
        const x = path.pop();
        if (x.keys.length <= this.maxKeys) break;
        const m = this.order;
        const mi = m % 2 ? (m - 1) / 2 : this.splitBias === 'left' ? m / 2 - 1 : m / 2;
        const med = x.keys[mi];
        R.snap({
          msg: `Internal overflow: split ${fmt(x.keys)} around ${med}. Unlike a leaf split, ${med} MOVES up — internal nodes only route searches, so no copy is kept.`,
          status: 'warn', line: 8, nodes: { [x.id]: 'overflow' }, keys: { [med]: 'median' },
        });
        const right = newNode(x.keys.slice(mi + 1), x.children.slice(mi + 1));
        x.keys = x.keys.slice(0, mi);
        x.children = x.children.slice(0, mi + 1);
        splits++;
        this.insertIntoParent(R, x, med, right, path, k);
      }
      return splits;
    }

    // ---------- Delete ----------

    delete(k, record = true) {
      const R = new Recorder(this, 'delete', k, record);
      if (!this.root) {
        R.snap({ msg: `The tree is empty — nothing to delete.`, status: 'error', line: 2 });
        return R.steps;
      }
      const { x, path } = this.walk(R, k, 1);
      const i = locate(x, k);
      if (x.keys[i] !== k) {
        R.snap({ msg: `Leaf ${fmt(x.keys)} has no ${k}, so nothing is deleted.`, status: 'error', line: 2, nodes: { [x.id]: 'visit' }, ghost: { key: k, node: x.id, gap: i } });
        return R.steps;
      }
      R.snap({ msg: `Found ${k} in leaf ${fmt(x.keys)}.`, line: 3, nodes: { [x.id]: 'visit' }, keys: { [k]: 'delete' }, ghost: { key: k, node: x.id, gap: i + 0.5 } });
      x.keys.splice(i, 1);
      const isRoot = x === this.root;
      const under = !isRoot && x.keys.length < this.minLeaf;
      const stale = path.some((p) => p.keys.includes(k));
      R.snap({
        msg: `Removed ${k} → ${fmt(x.keys)}.${under ? ` A leaf needs at least ${plural(this.minLeaf, 'key')}: underflow.` : ''}${stale ? ` ${k} may still appear as a separator above — that is allowed; separators only guide the search.` : ''}`,
        status: under ? 'warn' : 'info', line: under ? 4 : 3, nodes: { [x.id]: under ? 'underflow' : 'visit' },
      });
      if (isRoot && x.keys.length === 0) {
        this.root = null;
        R.snap({ msg: 'The tree is now empty.', status: 'success', line: 11 });
        return R.steps;
      }
      if (under) this.fixLeaf(R, x, path);
      if (this.root && !isLeaf(this.root) && this.root.keys.length === 0) {
        const old = this.root;
        this.root = old.children[0];
        R.snap({ msg: `The root has no separators left, so its only child becomes the root. Height ${height(this.root)}.`, line: 11, nodes: { [this.root.id]: 'new' }, into: { [old.id]: this.root.id } });
      }
      R.snap({ msg: `Done: ${k} deleted.`, status: 'success' });
      return R.steps;
    }

    fixLeaf(R, x, path) {
      const parent = path[path.length - 1];
      const ci = parent.children.indexOf(x);
      const left = ci > 0 ? parent.children[ci - 1] : null;
      const right = ci < parent.children.length - 1 ? parent.children[ci + 1] : null;
      const min = this.minLeaf;
      if (left && left.keys.length > min) {
        const b = left.keys.pop();
        R.snap({ msg: `The left sibling leaf can spare a key: move ${b} over.`, line: 5, nodes: { [x.id]: 'underflow', [left.id]: 'sibling' }, keys: { [b]: 'borrow' } });
        x.keys.unshift(b);
        const old = parent.keys[ci - 1];
        parent.keys[ci - 1] = x.keys[0];
        R.snap({ msg: `Update the separator between them: ${old} → ${x.keys[0]} (the first key of the right leaf).`, line: 6, nodes: { [x.id]: 'fixed', [left.id]: 'sibling', [parent.id]: 'visit' }, keys: { [b]: 'borrow' } });
        return;
      }
      if (right && right.keys.length > min) {
        const b = right.keys.shift();
        R.snap({ msg: `The right sibling leaf can spare a key: move ${b} over.`, line: 5, nodes: { [x.id]: 'underflow', [right.id]: 'sibling' }, keys: { [b]: 'borrow' } });
        x.keys.push(b);
        const old = parent.keys[ci];
        parent.keys[ci] = right.keys[0];
        R.snap({ msg: `Update the separator between them: ${old} → ${right.keys[0]} (the new first key of the right leaf).`, line: 6, nodes: { [x.id]: 'fixed', [right.id]: 'sibling', [parent.id]: 'visit' }, keys: { [b]: 'borrow' } });
        return;
      }
      const [L, Rn, si] = left ? [left, x, ci - 1] : [x, right, ci];
      const sep = parent.keys[si];
      R.snap({
        msg: `No sibling can spare a key, so merge the two leaves. The separator ${sep} is simply dropped from the parent — leaves don't need it (in a B-tree it would move down).`,
        line: 7, nodes: { [x.id]: 'underflow', [(left || right).id]: 'sibling', [parent.id]: 'visit' }, keys: { [sep]: 'separator' },
      });
      L.keys = L.keys.concat(Rn.keys);
      parent.keys.splice(si, 1);
      parent.children.splice(si + 1, 1);
      const pRoot = parent === this.root;
      const pUnder = pRoot ? parent.keys.length === 0 : parent.keys.length < this.minKeys;
      R.snap({
        msg: `Merged leaf ${fmt(L.keys)}; the leaf chain skips the removed leaf. Parent → ${fmt(parent.keys)}${pUnder && !pRoot ? ' — it underflows now.' : '.'}`,
        status: pUnder ? 'warn' : 'info', line: 7, nodes: { [L.id]: 'merged', [parent.id]: pUnder ? 'underflow' : 'visit' }, into: { [Rn.id]: L.id },
      });
      path.pop();
      if (!pRoot) this.fixInternalUnder(R, parent, path);
    }

    // Internal underflow: exactly as in a B-tree (rotate through the parent or merge with the separator).
    fixInternalUnder(R, x, path) {
      const min = this.minKeys;
      while (x !== this.root && x.keys.length < min) {
        const parent = path.pop();
        const ci = parent.children.indexOf(x);
        const left = ci > 0 ? parent.children[ci - 1] : null;
        const right = ci < parent.children.length - 1 ? parent.children[ci + 1] : null;
        if (left && left.keys.length > min) {
          const sep = parent.keys[ci - 1];
          x.keys.unshift(sep);
          x.children.unshift(left.children.pop());
          parent.keys[ci - 1] = left.keys.pop();
          R.snap({ msg: `Internal underflow: rotate from the left sibling — ${sep} comes down, ${parent.keys[ci - 1]} goes up.`, line: 9, nodes: { [x.id]: 'fixed', [left.id]: 'sibling', [parent.id]: 'visit' }, keys: { [sep]: 'separator' } });
          return;
        }
        if (right && right.keys.length > min) {
          const sep = parent.keys[ci];
          x.keys.push(sep);
          x.children.push(right.children.shift());
          parent.keys[ci] = right.keys.shift();
          R.snap({ msg: `Internal underflow: rotate from the right sibling — ${sep} comes down, ${parent.keys[ci]} goes up.`, line: 9, nodes: { [x.id]: 'fixed', [right.id]: 'sibling', [parent.id]: 'visit' }, keys: { [sep]: 'separator' } });
          return;
        }
        const [L, Rn, si] = left ? [left, x, ci - 1] : [x, right, ci];
        const sep = parent.keys[si];
        L.keys = L.keys.concat([sep], Rn.keys);
        L.children = L.children.concat(Rn.children);
        parent.keys.splice(si, 1);
        parent.children.splice(si + 1, 1);
        const pRoot = parent === this.root;
        const pUnder = pRoot ? parent.keys.length === 0 : parent.keys.length < min;
        R.snap({
          msg: `Internal underflow: merge with a sibling, pulling the separator ${sep} down → ${fmt(L.keys)}.${pUnder && !pRoot ? ' The parent underflows too.' : ''}`,
          status: pUnder ? 'warn' : 'info', line: 10, nodes: { [L.id]: 'merged', [parent.id]: pUnder ? 'underflow' : 'visit' }, keys: { [sep]: 'separator' }, into: { [Rn.id]: L.id },
        });
        x = parent;
      }
    }
  }

  function stats(root) {
    return { height: height(root), nodes: countNodes(root), keys: allKeys(root).length, leaves: leaves(root).length };
  }

  // Checks the B+ tree invariants; returns a list of problems (empty = valid).
  function validate(tree) {
    const errs = [];
    const root = tree.root;
    if (!root) return errs;
    const ks = allKeys(root);
    ks.forEach((k, i) => { if (i && k <= ks[i - 1]) errs.push(`leaf order broken at ${k}`); });
    let depth = -1;
    (function check(n, lo, hi, d) {
      const isRoot = n === root;
      if (n.keys.length > tree.maxKeys) errs.push(`${fmt(n.keys)} too many keys`);
      if (isLeaf(n)) {
        if (!isRoot && n.keys.length < tree.minLeaf) errs.push(`leaf ${fmt(n.keys)} too few keys`);
        n.keys.forEach((k) => { if ((lo != null && k < lo) || (hi != null && k >= hi)) errs.push(`${k} outside its range`); });
        if (depth < 0) depth = d; else if (depth !== d) errs.push('leaves at different depths');
      } else {
        if (!isRoot && n.keys.length < tree.minKeys) errs.push(`internal ${fmt(n.keys)} too few keys`);
        if (isRoot && n.keys.length === 0) errs.push('empty internal root');
        if (n.children.length !== n.keys.length + 1) errs.push(`${fmt(n.keys)} has ${n.children.length} children`);
        n.children.forEach((c, i) => check(c, i ? n.keys[i - 1] : lo, i < n.keys.length ? n.keys[i] : hi, d + 1));
      }
    })(root, null, null, 0);
    return errs;
  }

  const api = { BTree: BPlusTree, BPlusTree, stats, validate, fmt, leaves };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.BTreeAlgo = api;
})(typeof window !== 'undefined' ? window : globalThis);
