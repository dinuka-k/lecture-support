/*
 * B-tree of order m (at most m children and m − 1 keys per node) with step recording.
 *
 * Every operation returns an array of steps. A step is a full snapshot of the tree
 * plus what to highlight and one sentence explaining what happened, so the view can
 * animate from any step to any other (forwards or backwards).
 *
 * Insertion splits bottom-up on overflow; deletion fixes underflow bottom-up by
 * borrowing from a sibling or merging with one. No DOM in here, so it runs in Node too.
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

  function countNodes(n) {
    return n ? 1 + n.children.reduce((s, c) => s + countNodes(c), 0) : 0;
  }

  function inorder(n, out = []) {
    if (!n) return out;
    n.keys.forEach((k, i) => {
      if (n.children[i]) inorder(n.children[i], out);
      out.push(k);
    });
    if (n.children.length) inorder(n.children[n.children.length - 1], out);
    return out;
  }

  // Index of the first key >= k: the key's slot, or the child to follow if k is absent.
  function locate(x, k) {
    let i = 0;
    while (i < x.keys.length && k > x.keys[i]) i++;
    return i;
  }

  function relation(x, k, i) {
    const ks = x.keys;
    if (i === 0) return `${k} < ${ks[0]}`;
    if (i === ks.length) return `${k} > ${ks[i - 1]}`;
    return `${ks[i - 1]} < ${k} < ${ks[i]}`;
  }

  function subtreeName(x, i) {
    const ks = x.keys;
    if (i === 0) return `subtree left of ${ks[0]}`;
    if (i === ks.length) return `subtree right of ${ks[i - 1]}`;
    return `subtree between ${ks[i - 1]} and ${ks[i]}`;
  }

  // The keys on either side of the gap where k belongs.
  function neighbours(x, i) {
    const roles = {};
    if (i > 0) roles[x.keys[i - 1]] = 'compare';
    if (i < x.keys.length) roles[x.keys[i]] = 'compare';
    return roles;
  }

  // ---------- Pseudocode shown beside the animation (steps point at line numbers) ----------

  const CODE = {
    search: [
      'SEARCH(x, k)',
      '  i ← index of the first key ≥ k in x',
      '  if x.key[i] = k: return (x, i)       ▹ found',
      '  if x is a leaf: return NIL          ▹ not found',
      '  return SEARCH(x.child[i], k)        ▹ go down',
    ],
    insert: [
      'INSERT(T, k)',
      '  if T is empty: T.root ← leaf [k]; return',
      '  x ← T.root',
      '  loop',
      '    i ← position of k among x.keys',
      '    if x.key[i] = k: return            ▹ no duplicates',
      '    if x is a leaf: break',
      '    x ← x.child[i]',
      '  insert k into leaf x at position i',
      '  while x has more than m − 1 keys    ▹ overflow',
      '    split x around its median key',
      '    if x is the root: new root ← [median]',
      '    else median moves up into parent; x ← parent',
    ],
    delete: (usePred) => [
      'DELETE(T, k)',
      '  x ← node containing k               ▹ search from root',
      '  if k is not found: return',
      '  if x is an internal node',
      usePred
        ? '    r ← predecessor of k              ▹ max of left subtree'
        : '    r ← successor of k                ▹ min of right subtree',
      '    replace k by r; x ← leaf of r; remove r from x',
      '  else remove k from leaf x',
      '  while x ≠ root and x has < ⌈m/2⌉ − 1 keys  ▹ underflow',
      '    if an adjacent sibling has a spare key',
      '      borrow it through the parent (rotate); stop',
      '    else merge x + separator + sibling',
      '      x ← parent',
      '  if the root has no keys: root ← its child (or empty)',
    ],
  };
  const CODE_DELETE = { predecessor: CODE.delete(true), successor: CODE.delete(false) };
  const OP_NAMES = { insert: 'Insert', delete: 'Delete', search: 'Search' };

  class Recorder {
    constructor(tree, op, key, enabled) {
      this.tree = tree;
      this.op = op;
      this.key = key;
      this.enabled = enabled;
      this.label = `${OP_NAMES[op]} ${key}`;
      this.code = op === 'delete' ? CODE_DELETE[tree.deleteWith] : CODE[op];
      this.steps = [];
    }

    snap(s) {
      if (!this.enabled) return;
      this.steps.push({
        op: this.op,
        key: this.key,
        label: this.label,
        code: this.code,
        tree: clone(this.tree.root),
        msg: s.msg,
        status: s.status || 'info',
        line: s.line == null ? -1 : s.line,
        nodes: s.nodes || {}, // node id -> role
        keys: s.keys || {}, // key -> role
        edges: s.edges || {}, // child id -> role (edge from its parent)
        ghost: s.ghost || null, // floating copy of the key being searched / inserted / deleted
        origin: s.origin || null, // new node id -> node it was split from
        into: s.into || null, // removed node id -> node it was merged into
      });
    }
  }

  class BTree {
    constructor(order = 4, opts = {}) {
      this.order = order;
      this.splitBias = opts.splitBias || 'left'; // which middle key moves up when m is even
      this.deleteWith = opts.deleteWith || 'predecessor'; // replacement for keys in internal nodes
      this.root = null;
    }

    get maxKeys() { return this.order - 1; }
    get minKeys() { return Math.ceil(this.order / 2) - 1; }

    clear() { this.root = null; }
    load(snapshot) { this.root = clone(snapshot); }
    snapshot() { return clone(this.root); }
    keys() { return inorder(this.root); }

    has(k) {
      let x = this.root;
      while (x) {
        const i = locate(x, k);
        if (x.keys[i] === k) return true;
        x = x.children[i];
      }
      return false;
    }

    // An overflowing node holds exactly m keys.
    medianIndex() {
      const m = this.order;
      if (m % 2) return (m - 1) / 2;
      return this.splitBias === 'left' ? m / 2 - 1 : m / 2;
    }

    // Walks from the root towards k, recording a step for every node it passes through.
    // Stops (without recording) at the node holding k or at the leaf where k would go.
    walk(R, k, line) {
      let x = this.root;
      const path = [];
      for (;;) {
        const i = locate(x, k);
        const found = x.keys[i] === k;
        if (found || isLeaf(x)) return { x, i, found, path };
        const next = x.children[i];
        R.snap({
          msg: `Compare ${k} with ${fmt(x.keys)}: ${relation(x, k, i)}, so go down to the ${subtreeName(x, i)}.`,
          line,
          nodes: { [x.id]: 'visit' },
          keys: neighbours(x, i),
          edges: { [next.id]: 'path' },
          ghost: { key: k, node: x.id, gap: i },
        });
        path.push(x);
        x = next;
      }
    }

    // ---------- Search ----------

    search(k, record = true) {
      const R = new Recorder(this, 'search', k, record);
      if (!this.root) {
        R.snap({ msg: `The tree is empty, so ${k} is not found.`, status: 'error', line: 3 });
        return R.steps;
      }
      const { x, i, found, path } = this.walk(R, k, 4);
      if (found) {
        R.snap({
          msg: `Compare ${k} with ${fmt(x.keys)}: match, found ${k} after visiting ${plural(path.length + 1, 'node')}.`,
          status: 'success',
          line: 2,
          nodes: { [x.id]: 'found' },
          keys: { [k]: 'found' },
          ghost: { key: k, node: x.id, gap: i + 0.5 },
        });
      } else {
        R.snap({
          msg: `Compare ${k} with ${fmt(x.keys)}: ${relation(x, k, i)}, but this is a leaf, so there is nowhere left to go, ${k} is not in the tree.`,
          status: 'error',
          line: 3,
          nodes: { [x.id]: 'visit' },
          keys: neighbours(x, i),
          ghost: { key: k, node: x.id, gap: i },
        });
      }
      return R.steps;
    }

    // ---------- Insert ----------

    insert(k, record = true) {
      const R = new Recorder(this, 'insert', k, record);
      if (!this.root) {
        R.snap({ msg: `Insert ${k}: the tree is empty.`, line: 1, ghost: { key: k, node: null, gap: 0 } });
        this.root = newNode([k]);
        R.snap({
          msg: `${k} becomes the root, a single leaf holding one key.`,
          status: 'success',
          line: 1,
          nodes: { [this.root.id]: 'new' },
          keys: { [k]: 'new' },
        });
        return R.steps;
      }

      const { x, i, found, path } = this.walk(R, k, 7);
      if (found) {
        R.snap({
          msg: `${k} is already in the tree. Keys in a B-tree are unique, so nothing changes.`,
          status: 'warn',
          line: 5,
          nodes: { [x.id]: 'visit' },
          keys: { [k]: 'found' },
          ghost: { key: k, node: x.id, gap: i + 0.5 },
        });
        return R.steps;
      }

      R.snap({
        msg: `Compare ${k} with ${fmt(x.keys)}: ${relation(x, k, i)}. This is a leaf, so ${k} is inserted here.`,
        line: 6,
        nodes: { [x.id]: 'visit' },
        keys: neighbours(x, i),
        ghost: { key: k, node: x.id, gap: i },
      });
      x.keys.splice(i, 0, k);
      const over = x.keys.length > this.maxKeys;
      R.snap({
        msg: over
          ? `The leaf is now ${fmt(x.keys)}, ${x.keys.length} keys, but a node may hold at most ${this.maxKeys}.`
          : `The leaf is now ${fmt(x.keys)}: ${x.keys.length} of at most ${this.maxKeys} keys, so no split is needed.`,
        status: over ? 'warn' : 'info',
        line: over ? 9 : 8,
        nodes: { [x.id]: over ? 'overflow' : 'new' },
        keys: { [k]: 'new' },
      });

      const splits = this.fixOverflow(R, x, path, k);
      R.snap({
        msg: splits
          ? `Done: ${k} inserted after ${plural(splits, 'split')}. Every node is back within ${plural(this.maxKeys, 'key')}; height is ${height(this.root)}.`
          : `Done: ${k} inserted without any split.`,
        status: 'success',
        keys: { [k]: 'new' },
      });
      return R.steps;
    }

    fixOverflow(R, x, path, k) {
      let splits = 0;
      while (x.keys.length > this.maxKeys) {
        const mi = this.medianIndex();
        const med = x.keys[mi];
        const leftKeys = x.keys.slice(0, mi);
        const rightKeys = x.keys.slice(mi + 1);
        const roles = { [k]: 'new', [med]: 'median' };
        R.snap({
          msg: `Overflow: split ${fmt(x.keys)} around its median ${med} → ${fmt(leftKeys)}, ${med}, ${fmt(rightKeys)}.`,
          status: 'warn',
          line: 10,
          nodes: { [x.id]: 'overflow' },
          keys: roles,
        });

        const right = newNode(rightKeys, x.children.slice(mi + 1));
        x.keys = leftKeys;
        x.children = x.children.slice(0, mi + 1);
        splits++;
        const origin = { [right.id]: x.id };

        if (x === this.root) {
          this.root = newNode([med], [x, right]);
          R.snap({
            msg: `${med} moves up into a new root with children ${fmt(x.keys)} and ${fmt(right.keys)}. The tree grows one level taller (height ${height(this.root)}).`,
            line: 11,
            nodes: { [this.root.id]: 'new', [x.id]: 'split', [right.id]: 'split' },
            keys: roles,
            origin,
          });
          break;
        }

        const parent = path.pop();
        const ci = parent.children.indexOf(x);
        parent.keys.splice(ci, 0, med);
        parent.children.splice(ci + 1, 0, right);
        const parentOver = parent.keys.length > this.maxKeys;
        R.snap({
          msg: `${med} moves up into the parent, which becomes ${fmt(parent.keys)}; ${fmt(x.keys)} and ${fmt(right.keys)} are now siblings.` +
            (parentOver ? ' Now the parent overflows too.' : ''),
          status: parentOver ? 'warn' : 'info',
          line: 12,
          nodes: { [parent.id]: parentOver ? 'overflow' : 'visit', [x.id]: 'split', [right.id]: 'split' },
          keys: roles,
          origin,
        });
        x = parent;
      }
      return splits;
    }

    // ---------- Delete ----------

    delete(k, record = true) {
      const R = new Recorder(this, 'delete', k, record);
      const min = this.minKeys;
      if (!this.root) {
        R.snap({ msg: `The tree is empty, there is no ${k} to delete.`, status: 'error', line: 2 });
        return R.steps;
      }

      let { x, i, found, path } = this.walk(R, k, 1);
      if (!found) {
        R.snap({
          msg: `Compare ${k} with ${fmt(x.keys)}: ${relation(x, k, i)}, and this is a leaf, so ${k} is not in the tree and nothing is deleted.`,
          status: 'error',
          line: 2,
          nodes: { [x.id]: 'visit' },
          keys: neighbours(x, i),
          ghost: { key: k, node: x.id, gap: i },
        });
        return R.steps;
      }

      if (isLeaf(x)) {
        R.snap({
          msg: `Found ${k} in a leaf, so it can be removed directly.`,
          line: 1,
          nodes: { [x.id]: 'visit' },
          keys: { [k]: 'delete' },
          ghost: { key: k, node: x.id, gap: i + 0.5 },
        });
        x.keys.splice(i, 1);
        const under = x !== this.root && x.keys.length < min;
        R.snap({
          msg: `Remove ${k} from the leaf → ${fmt(x.keys)}.` + (under ? '' : x === this.root ? '' : ` It still has at least ${plural(min, 'key')}.`),
          status: under ? 'warn' : 'info',
          line: 6,
          nodes: { [x.id]: under ? 'underflow' : 'visit' },
        });
      } else {
        const usePred = this.deleteWith === 'predecessor';
        const word = usePred ? 'predecessor' : 'successor';
        const holder = x;
        let y = x.children[usePred ? i : i + 1];
        R.snap({
          msg: usePred
            ? `Found ${k} in an internal node. It separates two subtrees, so replace it with its predecessor, the largest key in the subtree to its left.`
            : `Found ${k} in an internal node. It separates two subtrees, so replace it with its successor, the smallest key in the subtree to its right.`,
          line: 3,
          nodes: { [x.id]: 'visit' },
          keys: { [k]: 'delete' },
          edges: { [y.id]: 'path' },
          ghost: { key: k, node: x.id, gap: i + 0.5 },
        });
        path.push(x);
        while (!isLeaf(y)) {
          const next = usePred ? y.children[y.children.length - 1] : y.children[0];
          R.snap({
            msg: `Not a leaf yet, keep going to the ${usePred ? 'rightmost' : 'leftmost'} child.`,
            line: 4,
            nodes: { [y.id]: 'visit' },
            keys: { [k]: 'delete' },
            edges: { [next.id]: 'path' },
          });
          path.push(y);
          y = next;
        }
        const rep = usePred ? y.keys[y.keys.length - 1] : y.keys[0];
        R.snap({
          msg: `Reached a leaf: the ${word} of ${k} is ${rep}.`,
          line: 4,
          nodes: { [y.id]: 'visit', [holder.id]: 'visit' },
          keys: { [k]: 'delete', [rep]: 'pred' },
        });
        holder.keys[holder.keys.indexOf(k)] = rep;
        if (usePred) y.keys.pop();
        else y.keys.shift();
        const under = y.keys.length < min;
        R.snap({
          msg: `${rep} moves up to replace ${k}, and its leaf becomes ${fmt(y.keys)}.`,
          status: under ? 'warn' : 'info',
          line: 5,
          nodes: { [y.id]: under ? 'underflow' : 'visit', [holder.id]: 'visit' },
          keys: { [rep]: 'pred' },
        });
        x = y;
      }

      this.fixUnderflow(R, x, path);

      if (this.root.keys.length === 0) {
        if (isLeaf(this.root)) {
          this.root = null;
          R.snap({ msg: 'The root has no keys left, the tree is now empty.', line: 12 });
        } else {
          const old = this.root;
          this.root = old.children[0];
          R.snap({
            msg: `The root has no keys left, so its only child becomes the new root. The tree shrinks by one level (height ${height(this.root)}).`,
            line: 12,
            nodes: { [this.root.id]: 'new' },
            into: { [old.id]: this.root.id },
          });
        }
      }

      R.snap({
        msg: this.root
          ? `Done: ${k} deleted. Every node except the root has at least ${plural(min, 'key')}.`
          : `Done: ${k} deleted and the tree is empty.`,
        status: 'success',
      });
      return R.steps;
    }

    fixUnderflow(R, x, path) {
      const min = this.minKeys;
      while (x !== this.root && x.keys.length < min) {
        const parent = path.pop();
        const ci = parent.children.indexOf(x);
        const left = ci > 0 ? parent.children[ci - 1] : null;
        const right = ci < parent.children.length - 1 ? parent.children[ci + 1] : null;
        const sibRoles = {};
        if (left) sibRoles[left.id] = 'sibling';
        if (right) sibRoles[right.id] = 'sibling';

        R.snap({
          msg: `Underflow: ${fmt(x.keys)} has ${plural(x.keys.length, 'key')}, but every node except the root needs at least ${min}. Look at the adjacent siblings.`,
          status: 'warn',
          line: 7,
          nodes: { ...sibRoles, [x.id]: 'underflow' },
        });

        if (left && left.keys.length > min) {
          const sep = parent.keys[ci - 1];
          const up = left.keys[left.keys.length - 1];
          R.snap({
            msg: `The left sibling ${fmt(left.keys)} can spare a key. Rotate: the separator ${sep} moves down into the node and ${up} moves up to take its place.`,
            line: 9,
            nodes: { [x.id]: 'underflow', [left.id]: 'sibling', [parent.id]: 'visit' },
            keys: { [sep]: 'separator', [up]: 'borrow' },
          });
          x.keys.unshift(sep);
          parent.keys[ci - 1] = left.keys.pop();
          if (!isLeaf(left)) x.children.unshift(left.children.pop());
          R.snap({
            msg: `Borrowed through the parent: ${fmt(left.keys)} ← ${up} → ${fmt(x.keys)}. The underflow is fixed.`,
            line: 9,
            nodes: { [x.id]: 'fixed', [left.id]: 'sibling', [parent.id]: 'visit' },
            keys: { [sep]: 'separator', [up]: 'borrow' },
          });
          return;
        }

        if (right && right.keys.length > min) {
          const sep = parent.keys[ci];
          const up = right.keys[0];
          R.snap({
            msg: `The right sibling ${fmt(right.keys)} can spare a key. Rotate: the separator ${sep} moves down into the node and ${up} moves up to take its place.`,
            line: 9,
            nodes: { [x.id]: 'underflow', [right.id]: 'sibling', [parent.id]: 'visit' },
            keys: { [sep]: 'separator', [up]: 'borrow' },
          });
          x.keys.push(sep);
          parent.keys[ci] = right.keys.shift();
          if (!isLeaf(right)) x.children.push(right.children.shift());
          R.snap({
            msg: `Borrowed through the parent: ${fmt(x.keys)} ← ${up} → ${fmt(right.keys)}. The underflow is fixed.`,
            line: 9,
            nodes: { [x.id]: 'fixed', [right.id]: 'sibling', [parent.id]: 'visit' },
            keys: { [sep]: 'separator', [up]: 'borrow' },
          });
          return;
        }

        // Neither sibling can lend a key: merge with one of them.
        const sib = left || right;
        const [L, Rn, si] = left ? [left, x, ci - 1] : [x, right, ci];
        const sep = parent.keys[si];
        const why = left && right
          ? `Both siblings have only ${plural(min, 'key')}`
          : `The ${left ? 'left' : 'right'} sibling has only ${plural(min, 'key')}`;
        R.snap({
          msg: `${why}, so none can lend. Merge with the ${left ? 'left' : 'right'} sibling ${fmt(sib.keys)}, pulling the separator ${sep} down from the parent.`,
          line: 10,
          nodes: { [x.id]: 'underflow', [sib.id]: 'sibling', [parent.id]: 'visit' },
          keys: { [sep]: 'separator' },
        });
        L.keys = L.keys.concat([sep], Rn.keys);
        L.children = L.children.concat(Rn.children);
        parent.keys.splice(si, 1);
        parent.children.splice(si + 1, 1);
        const isRoot = parent === this.root;
        const parentUnder = isRoot ? parent.keys.length === 0 : parent.keys.length < min;
        R.snap({
          msg: `Merged into ${fmt(L.keys)}. The parent loses ${sep} and becomes ${fmt(parent.keys)}` +
            (parentUnder ? (isRoot ? ', the root is now empty.' : ', now the parent underflows.') : '.'),
          status: parentUnder ? 'warn' : 'info',
          line: 11,
          nodes: { [L.id]: 'merged', [parent.id]: parentUnder ? 'underflow' : 'visit' },
          keys: { [sep]: 'separator' },
          into: { [Rn.id]: L.id },
        });
        x = parent;
      }
    }
  }

  function stats(root) {
    return { height: height(root), nodes: countNodes(root), keys: inorder(root).length };
  }

  // Checks every B-tree invariant; returns a list of problems (empty = valid).
  function validate(tree) {
    const errs = [];
    const root = tree.root;
    if (!root) return errs;
    let leafDepth = -1;
    (function check(n, lo, hi, depth) {
      const isRoot = n === root;
      if (n.keys.length > tree.maxKeys) errs.push(`${fmt(n.keys)} has too many keys`);
      if (isRoot && n.keys.length === 0) errs.push('root is empty');
      if (!isRoot && n.keys.length < tree.minKeys) errs.push(`${fmt(n.keys)} has too few keys`);
      n.keys.forEach((k, i) => {
        if ((lo != null && k <= lo) || (hi != null && k >= hi) || (i && k <= n.keys[i - 1])) errs.push(`order broken at ${k}`);
      });
      if (isLeaf(n)) {
        if (leafDepth < 0) leafDepth = depth;
        else if (leafDepth !== depth) errs.push('leaves at different depths');
      } else {
        if (n.children.length !== n.keys.length + 1) errs.push(`${fmt(n.keys)} has ${n.children.length} children`);
        n.children.forEach((c, i) => check(c, i ? n.keys[i - 1] : lo, i < n.keys.length ? n.keys[i] : hi, depth + 1));
      }
    })(root, null, null, 0);
    return errs;
  }

  const api = { BTree, stats, validate, fmt };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.BTreeAlgo = api;
})(typeof window !== 'undefined' ? window : globalThis);
