/*
 * Models for the hashing demo. Each structure records its operations as a list
 * of snapshot steps for playback:
 *   HashTable   — in-memory table: separate chaining or open addressing
 *                 (linear probing, quadratic probing, double hashing), rehashing
 *   StaticHash  — a hash index on disk: N bucket pages + overflow chains, counts page I/O
 *   Extendible  — a directory of 2^d pointers and buckets with local depths
 *   LinearHash  — buckets split one at a time in round-robin order (level, next)
 */
(function (global) {
  'use strict';

  const MAX_KEY = 99;
  const BITS = 7; // keys 0–99 fit in 7 bits
  const MAX_M = 59; // largest table size the demo grows to
  const REHASH_AT = 0.75;

  // ---------- Helpers ----------

  const isPrime = (n) => {
    if (n < 2) return false;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;
    return true;
  };
  const nextPrime = (n) => { while (!isPrime(n)) n++; return n; };
  const prevPrime = (n) => { n--; while (n > 2 && !isPrime(n)) n--; return n; };
  const bin = (k, bits) => (bits <= 0 ? '' : k.toString(2).padStart(bits, '0').slice(-bits));
  const SUB = '₀₁₂₃₄₅₆₇₈₉';
  const sub = (n) => String(n).split('').map((d) => SUB[+d]).join('');
  const plural = (n, word, many) => `${n} ${n === 1 ? word : many || word + 's'}`;
  const letter = (id) => (id < 26 ? String.fromCharCode(65 + id) : `B${id}`);
  const chunk = (keys, cap) => {
    const pages = [];
    for (let i = 0; i < keys.length; i += cap) pages.push(keys.slice(i, i + cap));
    return pages.length ? pages : [[]];
  };
  // Binary with the last d bits marked for highlighting: 0010[[100]]
  const binMark = (k, d) => {
    const s = bin(k, BITS);
    return d > 0 ? `${s.slice(0, BITS - d)}[[${s.slice(BITS - d)}]]` : s;
  };

  // Pseudocode; "▹" starts a comment.
  const CODE = {
    openInsert: [
      's ← h(k) = k mod m',
      'while slot[s] is occupied:',
      '  if slot[s] = k: already there, stop',
      '  collision: i ← i + 1, s ← (h(k) + f(i)) mod m',
      'store k in slot[s]',
      'if n / m > 0.75: rehash ▹ when auto-rehash is on',
    ],
    openSearch: [
      's ← h(k) = k mod m',
      'while slot[s] is not empty:',
      '  if slot[s] = k: found',
      '  s ← next slot on the probe path ▹ skip deleted markers',
      'not found ▹ an empty slot ends the search',
    ],
    openDelete: [
      'find k along its probe path',
      'if found: replace it with a "deleted" marker',
      '  ▹ not empty: later keys on the path must stay reachable',
      'else: not found',
    ],
    chainInsert: [
      'b ← h(k) = k mod m',
      'for each node x in chain[b]:',
      '  if x = k: already there, stop',
      'append k to chain[b]',
      'if n / m > 0.75: rehash ▹ when auto-rehash is on',
    ],
    chainSearch: [
      'b ← h(k) = k mod m',
      'for each node x in chain[b]:',
      '  if x = k: found',
      'not found',
    ],
    chainDelete: [
      'b ← h(k) = k mod m',
      'find k in chain[b]',
      'unlink its node from the chain',
      'else: not found',
    ],
    rehash: [
      "m' ← next prime ≥ 2m",
      "allocate an empty table of size m'",
      'for each key k in the old table:',
      "  insert k using h(k) = k mod m'",
    ],
    diskInsert: [
      'b ← h(k) = k mod N',
      'for each page P of bucket b:',
      '  read P from disk ▹ 1 I/O',
      '  if k is in P: already there, stop',
      'if no page has room: add an overflow page',
      'write k into the first page with room ▹ 1 I/O',
    ],
    diskSearch: [
      'b ← h(k) = k mod N',
      'for each page P of bucket b:',
      '  read P from disk ▹ 1 I/O',
      '  if k is in P: found',
      'not found',
    ],
    diskDelete: [
      'b ← h(k) = k mod N',
      'read the pages of bucket b until k is found',
      'remove k and write the page back ▹ 1 I/O',
      'free the overflow page if it became empty',
    ],
    diskRange: [
      '▹ hashing scatters neighbouring keys:',
      '▹ there is no bucket to start the range from',
      'for each bucket b = 0 … N−1:',
      '  for each page P of bucket b:',
      '    read P ▹ 1 I/O',
      '    output the keys with lo ≤ k ≤ hi',
    ],
    extInsert: [
      'i ← last d bits of h(k) ▹ d = global depth',
      'B ← the bucket dir[i] points to',
      'if B has room: put k in B, done',
      'if local depth(B) = d:',
      '  double the directory, d ← d + 1',
      'split B: local depth + 1, new bucket B′',
      '  move keys whose new bit is 1 to B′, repoint entries',
      'try again from the top',
    ],
    extSearch: [
      'i ← last d bits of h(k)',
      'B ← the bucket dir[i] points to',
      'look for k in B',
    ],
    extDelete: [
      'i ← last d bits of h(k)',
      'B ← the bucket dir[i] points to',
      'remove k from B ▹ buckets are not merged here',
    ],
    linInsert: [
      'b ← h_level(k) = k mod N',
      'if b < next: b ← h_level+1(k) = k mod 2N ▹ already split',
      'if bucket b has room: put k there, done',
      'else: add an overflow page to b and put k there',
      'split bucket next: rehash its keys with h_level+1',
      'next ← next + 1',
      'if next = N: level ← level + 1, next ← 0',
    ],
    linSearch: [
      'b ← h_level(k) = k mod N',
      'if b < next: b ← h_level+1(k) = k mod 2N',
      'look for k in bucket b and its overflow pages',
    ],
    linDelete: [
      'b ← h_level(k) = k mod N',
      'if b < next: b ← h_level+1(k) = k mod 2N',
      'remove k from bucket b ▹ no merging here',
    ],
  };

  // ---------- Step recorder ----------

  // Collects snapshot steps for one operation. Calc lines may mark a part as [[highlighted]].
  class Recorder {
    constructor(model, op, key, code, label) {
      this.model = model;
      this.op = op;
      this.key = key;
      this.code = code;
      this.label = label;
      this.steps = [];
      this.calc = [];
      this.io = { reads: 0, writes: 0 };
      this.probes = 0;
      this.found = [];
    }

    addCalc(line) { this.calc.push(line); }

    step(msg, o = {}) {
      const m = this.model;
      this.steps.push({
        mode: m.mode, op: this.op, key: this.key, label: this.label, code: this.code,
        msg, status: o.status || 'info', line: o.line == null ? -1 : o.line,
        snap: m.snapshot(), hl: o.hl || {}, kh: o.kh || {}, ghost: o.ghost || null,
        calc: { formula: m.formula(), lines: this.calc.slice(), key: this.key },
        io: Object.assign({}, this.io), rules: m.rules(this), dur: o.dur || null,
      });
    }
  }

  // Used when building a structure instantly: records nothing.
  const quiet = () => ({ addCalc() {}, step() {}, io: { reads: 0, writes: 0 }, probes: 0, steps: [], found: [] });

  function idleStep(model, msg) {
    const rec = new Recorder(model, 'idle', null, null, '');
    rec.step(msg);
    return rec.steps[0];
  }

  // ---------- 1. In-memory hash table ----------

  class HashTable {
    constructor(o) {
      this.mode = 'table';
      this.m = o.m || 11;
      this.strategy = o.strategy || 'linear';
      this.autoRehash = !!o.autoRehash;
      this.clear();
    }

    get open() { return this.strategy !== 'chain'; }
    get R() { return prevPrime(this.m); } // second hash modulus for double hashing

    clear() {
      this.slots = Array(this.m).fill(null); // null | { k } | { tomb: true }
      this.chains = Array.from({ length: this.m }, () => []);
      this.n = 0;
    }

    h(k) { return k % this.m; }
    h2(k) { return this.R - (k % this.R); }

    probeAt(k, i) {
      const h = this.h(k);
      if (this.strategy === 'quadratic') return (h + i * i) % this.m;
      if (this.strategy === 'double') return (h + i * this.h2(k)) % this.m;
      return (h + i) % this.m;
    }

    probeText(k, i, s) {
      const h = this.h(k), m = this.m;
      if (this.strategy === 'quadratic') return `probe ${i}: (${h} + ${i}²) mod ${m} = [[${s}]]`;
      if (this.strategy === 'double') return `probe ${i}: (${h} + ${i}·${this.h2(k)}) mod ${m} = [[${s}]]`;
      return `probe ${i}: (${h} + ${i}) mod ${m} = [[${s}]]`;
    }

    nextHint(k, i) {
      const n = i + 1;
      if (this.strategy === 'quadratic') return `Quadratic probing jumps ${n}² = ${n * n} from the home slot.`;
      if (this.strategy === 'double') return `Double hashing moves h₂(${k}) = ${this.h2(k)} slots each time.`;
      return 'Linear probing tries the next slot.';
    }

    sid(i) { return this.open ? `s${this.m}_${i}` : `c${this.m}_${i}`; }

    keys() {
      return this.open ? this.slots.filter((s) => s && !s.tomb).map((s) => s.k) : this.chains.flat();
    }

    snapshot() {
      return {
        m: this.m,
        strategy: this.strategy,
        slots: this.open ? this.slots.map((s) => (s ? (s.tomb ? 'T' : s.k) : null)) : null,
        chains: this.open ? null : this.chains.map((c) => c.slice()),
      };
    }

    formula() {
      const m = this.m;
      if (this.strategy === 'chain') return [`h(k) = k mod ${m}`, 'collisions: chain the keys'];
      if (this.strategy === 'quadratic') return [`h(k) = k mod ${m}`, `probe i: (h(k) + i²) mod ${m}`];
      if (this.strategy === 'double') return [`h(k) = k mod ${m}`, `h₂(k) = ${this.R} − (k mod ${this.R})`, `probe i: (h(k) + i·h₂(k)) mod ${m}`];
      return [`h(k) = k mod ${m}`, `probe i: (h(k) + i) mod ${m}`];
    }

    rules(rec) {
      const out = [`n = <b>${this.n}</b>`, `m = <b>${this.m}</b>`, `load factor α = n/m = <b>${(this.n / this.m).toFixed(2)}</b>`];
      if (rec && rec.probes) out.push(`${this.open ? 'probes' : 'compares'}: <b>${rec.probes}</b>`);
      return out;
    }

    insert(k, record = true) {
      const rec = record ? new Recorder(this, 'insert', k, this.open ? CODE.openInsert : CODE.chainInsert, `Insert ${k}`) : quiet();
      const placed = this.open ? this.insertOpen(k, rec) : this.insertChain(k, rec);
      if (placed && this.autoRehash && this.n / this.m > REHASH_AT) this.rehashInto(rec, true);
      return rec.steps;
    }

    insertOpen(k, rec) {
      const m = this.m, h = this.h(k);
      rec.addCalc(`h(${k}) = ${k} mod ${m} = [[${h}]]`);
      if (this.strategy === 'double') rec.addCalc(`h₂(${k}) = ${this.R} − (${k} mod ${this.R}) = [[${this.h2(k)}]]`);
      rec.step(`Hash the key: h(${k}) = ${k} mod ${m} = ${h}, so slot ${h} is ${k}'s home slot.`, { line: 0, ghost: { key: k, at: 'calc' } });
      if (this.n === m) {
        rec.step(`The table is full (n = m = ${m}), there is no slot left for ${k}. It needs to grow: rehash into a bigger table.`, { status: 'error', ghost: { key: k, at: 'calc' } });
        return false;
      }
      let tomb = -1;
      for (let i = 0; i < m; i++) {
        const s = this.probeAt(k, i);
        if (i > 0) rec.addCalc(this.probeText(k, i, s));
        rec.probes = i + 1;
        const cell = this.slots[s];
        if (cell === null) {
          const at = tomb >= 0 ? tomb : s;
          if (tomb >= 0) {
            rec.step(`Slot ${s} is empty, so ${k} is not in the table. Reuse the deleted slot ${tomb} we passed on the way.`, {
              line: 4, ghost: { key: k, at: this.sid(tomb) }, hl: { [this.sid(s)]: 'probe', [this.sid(tomb)]: 'target' },
            });
          }
          this.slots[at] = { k };
          this.n++;
          rec.step(i === 0 ? `Slot ${s} is free, store ${k} there. One probe, no collision.` : `Store ${k} in slot ${at}, after ${plural(i + 1, 'probe')}.`, {
            line: 4, status: 'success', kh: { [k]: 'new' }, hl: { [this.sid(at)]: 'target' },
          });
          return true;
        }
        if (cell.tomb) {
          if (tomb < 0) tomb = s;
          rec.step(`Slot ${s} holds a "deleted" marker. Remember it as a place to reuse, but keep probing, ${k} could still be further along.`, {
            line: 3, ghost: { key: k, at: this.sid(s) }, hl: { [this.sid(s)]: 'probe' },
          });
          continue;
        }
        if (cell.k === k) {
          rec.step(`${k} is already in slot ${s}, a hash table stores each key only once.`, {
            line: 2, status: 'warn', kh: { [k]: 'found' }, hl: { [this.sid(s)]: 'probe' },
          });
          return false;
        }
        rec.step(`Collision: slot ${s} is taken by ${cell.k}. ${this.nextHint(k, i)}`, {
          line: 3, ghost: { key: k, at: this.sid(s) }, hl: { [this.sid(s)]: 'probe' }, kh: { [cell.k]: 'compare' },
        });
      }
      if (tomb >= 0) {
        this.slots[tomb] = { k };
        this.n++;
        rec.step(`Every slot was visited; store ${k} in the deleted slot ${tomb}.`, { line: 4, status: 'success', kh: { [k]: 'new' }, hl: { [this.sid(tomb)]: 'target' } });
        return true;
      }
      rec.step(`No free slot on ${k}'s probe path after ${m} probes.${this.strategy === 'quadratic' ? ' Quadratic probing only guarantees a free slot while the table is at most half full.' : ''}`, {
        status: 'error', ghost: { key: k, at: 'calc' },
      });
      return false;
    }

    insertChain(k, rec) {
      const m = this.m, b = this.h(k), cid = this.sid(b), chain = this.chains[b];
      rec.addCalc(`h(${k}) = ${k} mod ${m} = [[${b}]]`);
      rec.step(`Hash the key: h(${k}) = ${k} mod ${m} = ${b}, so ${k} belongs in bucket ${b}.`, { line: 0, ghost: { key: k, at: 'calc' } });
      for (let j = 0; j < chain.length; j++) {
        rec.probes = j + 1;
        if (chain[j] === k) {
          rec.step(`${k} is already in bucket ${b}'s chain, a hash table stores each key only once.`, { line: 2, status: 'warn', kh: { [k]: 'found' }, hl: { [cid]: 'target' } });
          return false;
        }
        rec.step(j === 0
          ? `Bucket ${b} already has keys (a collision): walk its chain to check for ${k}. Compare with ${chain[j]}, no.`
          : `Next node: ${chain[j]}, not ${k}.`, {
          line: 1, ghost: { key: k, at: cid }, hl: { [cid]: 'target' }, kh: { [chain[j]]: 'compare' },
        });
      }
      chain.push(k);
      this.n++;
      rec.step(chain.length === 1
        ? `Bucket ${b} was empty: ${k} becomes the first node of its chain.`
        : `End of the chain: append ${k}. Bucket ${b} now holds ${chain.length} keys, with chaining, a collision just makes the chain longer.`, {
        line: 3, status: 'success', kh: { [k]: 'new' }, hl: { [cid]: 'target' },
      });
      return true;
    }

    search(k) {
      const rec = new Recorder(this, 'search', k, this.open ? CODE.openSearch : CODE.chainSearch, `Search ${k}`);
      this.locate(k, rec, false);
      return rec.steps;
    }

    delete(k) {
      const rec = new Recorder(this, 'delete', k, this.open ? CODE.openDelete : CODE.chainDelete, `Delete ${k}`);
      this.locate(k, rec, true);
      return rec.steps;
    }

    // Shared by search and delete.
    locate(k, rec, del) {
      const m = this.m, h = this.h(k);
      rec.addCalc(`h(${k}) = ${k} mod ${m} = [[${h}]]`);
      if (this.open && this.strategy === 'double') rec.addCalc(`h₂(${k}) = ${this.R} − (${k} mod ${this.R}) = [[${this.h2(k)}]]`);
      rec.step(`Hash the key: h(${k}) = ${k} mod ${m} = ${h}. ${this.open ? `Start at slot ${h} and follow ${k}'s probe path.` : `Look in bucket ${h}'s chain.`}`, {
        line: 0, ghost: { key: k, at: 'calc' },
      });

      if (!this.open) {
        const cid = this.sid(h), chain = this.chains[h];
        for (let j = 0; j < chain.length; j++) {
          rec.probes = j + 1;
          if (chain[j] === k) {
            if (!del) {
              rec.step(`Found ${k} in bucket ${h}, node ${j + 1} of the chain.`, { line: 2, status: 'success', kh: { [k]: 'found' }, hl: { [cid]: 'target' } });
              return;
            }
            rec.step(`Found ${k} in bucket ${h}'s chain.`, { line: 1, kh: { [k]: 'delete' }, hl: { [cid]: 'target' } });
            chain.splice(j, 1);
            this.n--;
            rec.step(`Unlink the node: ${j === 0 ? 'the bucket now points' : 'the previous node now points'} to ${chain[j] != null ? chain[j] : 'nothing'}. ${k} is gone.`, { line: 2, status: 'success', hl: { [cid]: 'target' } });
            return;
          }
          rec.step(`Compare with ${chain[j]}, not ${k}.`, { line: 1, ghost: { key: k, at: cid }, hl: { [cid]: 'target' }, kh: { [chain[j]]: 'compare' } });
        }
        rec.step(chain.length ? `End of bucket ${h}'s chain, ${k} is not in the table.` : `Bucket ${h} is empty, ${k} is not in the table.`, {
          line: del ? 3 : 3, status: 'warn', ghost: { key: k, at: cid }, hl: { [cid]: 'target' },
        });
        return;
      }

      for (let i = 0; i < m; i++) {
        const s = this.probeAt(k, i);
        if (i > 0) rec.addCalc(this.probeText(k, i, s));
        rec.probes = i + 1;
        const cell = this.slots[s], id = this.sid(s);
        if (cell === null) {
          rec.step(`Slot ${s} is empty, so the search stops: ${k} is not in the table (it would have been stored here or earlier on its path).`, {
            line: del ? 3 : 4, status: 'warn', ghost: { key: k, at: id }, hl: { [id]: 'probe' },
          });
          return;
        }
        if (cell.tomb) {
          rec.step(`Slot ${s} holds a "deleted" marker, not empty, so keep probing.`, { line: del ? 0 : 3, ghost: { key: k, at: id }, hl: { [id]: 'probe' } });
          continue;
        }
        if (cell.k === k) {
          if (!del) {
            rec.step(`Found ${k} in slot ${s} after ${plural(i + 1, 'probe')}.`, { line: 2, status: 'success', kh: { [k]: 'found' }, hl: { [id]: 'target' } });
            return;
          }
          rec.step(`Found ${k} in slot ${s}.`, { line: 0, kh: { [k]: 'delete' }, hl: { [id]: 'target' } });
          this.slots[s] = { tomb: true };
          this.n--;
          rec.step(`Replace ${k} with a "deleted" marker instead of emptying the slot, an empty slot would cut the probe path of keys stored after it.`, {
            line: 1, status: 'success', hl: { [id]: 'target' },
          });
          return;
        }
        rec.step(`Slot ${s} holds ${cell.k}, not ${k}, follow the probe path.`, { line: del ? 0 : 3, ghost: { key: k, at: id }, hl: { [id]: 'probe' }, kh: { [cell.k]: 'compare' } });
      }
      rec.step(`Probed all ${m} slots, ${k} is not in the table.`, { line: del ? 3 : 4, status: 'warn', ghost: { key: k, at: 'calc' } });
    }

    rehash() {
      const rec = new Recorder(this, 'rehash', null, CODE.rehash, 'Rehash');
      this.rehashInto(rec, false);
      return rec.steps;
    }

    rehashInto(rec, auto) {
      const oldM = this.m, newM = nextPrime(2 * oldM);
      rec.code = CODE.rehash;
      rec.addCalc(`α = ${this.n} / ${oldM} = [[${(this.n / oldM).toFixed(2)}]]`);
      if (newM > MAX_M) {
        rec.step(`The table would grow to ${newM} slots, more than this demo shows (${MAX_M}). Clear it or pick a smaller table.`, { status: 'warn' });
        return;
      }
      rec.addCalc(`m' = next prime ≥ 2·${oldM} = [[${newM}]]`);
      rec.step(`${auto ? `The load factor is now α = ${this.n}/${oldM} = ${(this.n / oldM).toFixed(2)} > 0.75, so the table grows.` : `Rehash: grow the table.`} New size m' = ${newM}, the next prime ≥ 2·${oldM}. Every key must be re-inserted, because h(k) = k mod m changes when m does.`, {
        line: 0, status: 'warn',
      });
      const keys = this.keys();
      this.m = newM;
      this.clear();
      const q = quiet();
      keys.forEach((k) => (this.open ? this.insertOpen(k, q) : this.insertChain(k, q)));
      rec.addCalc(`now h(k) = k mod [[${newM}]]`);
      rec.step(`Rehashed: all ${keys.length} keys moved to their places in the new table of size ${newM}. The load factor dropped to ${(this.n / newM).toFixed(2)}.`, {
        line: 3, status: 'success', dur: 1300,
      });
    }

    example() {
      return {
        settings: { m: 11 },
        keys: [54, 26, 93, 17, 77, 31],
        next: '44, 55, 20',
        msg: 'Example: 54, 26, 93, 17, 77, 31 in a table of size 11. Now insert 44, 55 and 20, all three land on a taken slot (44 mod 11 = 0, 55 mod 11 = 0, 20 mod 11 = 9).',
      };
    }
  }

  // ---------- 2. Static hash index on disk ----------

  class StaticHash {
    constructor(o) {
      this.mode = 'disk';
      this.N = o.N || 4;
      this.cap = o.cap || 2;
      this.clear();
    }

    clear() {
      this.buckets = Array.from({ length: this.N }, () => [[]]);
      this.n = 0;
    }

    h(k) { return k % this.N; }
    pid(b, j) { return `p${b}_${j}`; }
    keys() { return this.buckets.flat(2); }

    snapshot() { return { N: this.N, cap: this.cap, buckets: this.buckets.map((ps) => ps.map((p) => p.slice())) }; }
    formula() { return [`h(k) = k mod ${this.N}`, `bucket = one disk page (${this.cap} keys) + overflow pages`]; }

    rules(rec) {
      const pages = this.buckets.reduce((a, ps) => a + ps.length, 0);
      const out = [`N = <b>${this.N}</b> buckets`, `<b>${this.cap}</b> keys per page`, `<b>${pages}</b> pages (${pages - this.N} overflow)`];
      if (rec && (rec.io.reads || rec.io.writes)) out.push(`this operation: <b>${rec.io.reads}</b> read${rec.io.reads === 1 ? '' : 's'} · <b>${rec.io.writes}</b> write${rec.io.writes === 1 ? '' : 's'}`);
      return out;
    }

    pageName(j) { return j === 0 ? 'primary page' : `overflow page ${j}`; }
    show(p) { return p.length ? p.join(', ') : 'empty'; }

    insert(k, record = true) {
      const rec = record ? new Recorder(this, 'insert', k, CODE.diskInsert, `Insert ${k}`) : quiet();
      const b = this.h(k), pages = this.buckets[b];
      rec.addCalc(`h(${k}) = ${k} mod ${this.N} = [[${b}]]`);
      rec.step(`Hash the key: h(${k}) = ${k} mod ${this.N} = ${b}. The hash value names the bucket directly, no tree to walk down.`, { line: 0, ghost: { key: k, at: 'calc' } });
      let room = -1;
      for (let j = 0; j < pages.length; j++) {
        rec.io.reads++;
        const p = pages[j];
        if (p.includes(k)) {
          rec.step(`Read bucket ${b}'s ${this.pageName(j)} (1 I/O): ${k} is already there.`, { line: 3, status: 'warn', ghost: { key: k, at: this.pid(b, j) }, hl: { [this.pid(b, j)]: 'read' }, kh: { [k]: 'found' } });
          return rec.steps;
        }
        if (room < 0 && p.length < this.cap) room = j;
        rec.step(`Read bucket ${b}'s ${this.pageName(j)} from disk (I/O #${rec.io.reads}): ${this.show(p)}, ${p.length < this.cap ? 'it has room' : 'full'}.${j < pages.length - 1 ? ' Follow the overflow chain.' : ''}`, {
          line: 2, ghost: { key: k, at: this.pid(b, j) }, hl: { [this.pid(b, j)]: p.length < this.cap ? 'read' : 'full' },
        });
      }
      if (room < 0) {
        pages.push([]);
        room = pages.length - 1;
        rec.step(`Every page of bucket ${b} is full, so allocate an overflow page and link it to the chain. A static hash index has a fixed number of buckets, it can only grow chains.`, {
          line: 4, status: 'warn', ghost: { key: k, at: this.pid(b, room) }, hl: { [this.pid(b, room)]: 'new' },
        });
      }
      pages[room].push(k);
      this.n++;
      rec.io.writes++;
      const long = pages.length >= 3 ? ` Bucket ${b} now spans ${pages.length} pages, so every lookup there costs up to ${pages.length} reads, dynamic hashing (extendible, linear) avoids this by adding buckets.` : '';
      rec.step(`Write ${k} into the ${this.pageName(room)} and save it (1 I/O). Total: ${plural(rec.io.reads, 'read')} + 1 write.${long}`, {
        line: 5, status: 'success', kh: { [k]: 'new' }, hl: { [this.pid(b, room)]: 'target' },
      });
      return rec.steps;
    }

    search(k) {
      const rec = new Recorder(this, 'search', k, CODE.diskSearch, `Search ${k}`);
      const b = this.h(k), pages = this.buckets[b];
      rec.addCalc(`h(${k}) = ${k} mod ${this.N} = [[${b}]]`);
      rec.step(`Hash the key: h(${k}) = ${k} mod ${this.N} = ${b}. Only bucket ${b} can hold ${k}.`, { line: 0, ghost: { key: k, at: 'calc' } });
      for (let j = 0; j < pages.length; j++) {
        rec.io.reads++;
        const id = this.pid(b, j);
        if (pages[j].includes(k)) {
          rec.step(`Read bucket ${b}'s ${this.pageName(j)} (I/O #${rec.io.reads}): found ${k}. ${rec.io.reads === 1 ? 'An equality lookup in a hash index costs about one page read, a B+-tree needs one per level.' : `${rec.io.reads} reads, because of the overflow chain.`}`, {
            line: 3, status: 'success', hl: { [id]: 'read' }, kh: { [k]: 'found' },
          });
          return rec.steps;
        }
        rec.step(`Read bucket ${b}'s ${this.pageName(j)} (I/O #${rec.io.reads}): ${this.show(pages[j])}, no ${k}.${j < pages.length - 1 ? ' Follow the overflow chain.' : ''}`, {
          line: 2, ghost: { key: k, at: id }, hl: { [id]: 'read' },
        });
      }
      rec.step(`Read all ${plural(pages.length, 'page')} of bucket ${b}: ${k} is not in the index.`, { line: 4, status: 'warn', ghost: { key: k, at: this.pid(b, pages.length - 1) } });
      return rec.steps;
    }

    delete(k) {
      const rec = new Recorder(this, 'delete', k, CODE.diskDelete, `Delete ${k}`);
      const b = this.h(k), pages = this.buckets[b];
      rec.addCalc(`h(${k}) = ${k} mod ${this.N} = [[${b}]]`);
      rec.step(`Hash the key: h(${k}) = ${k} mod ${this.N} = ${b}.`, { line: 0, ghost: { key: k, at: 'calc' } });
      for (let j = 0; j < pages.length; j++) {
        rec.io.reads++;
        const id = this.pid(b, j);
        const at = pages[j].indexOf(k);
        if (at < 0) {
          rec.step(`Read bucket ${b}'s ${this.pageName(j)} (I/O #${rec.io.reads}): no ${k}.`, { line: 1, ghost: { key: k, at: id }, hl: { [id]: 'read' } });
          continue;
        }
        rec.step(`Read bucket ${b}'s ${this.pageName(j)} (I/O #${rec.io.reads}): found ${k}.`, { line: 1, hl: { [id]: 'read' }, kh: { [k]: 'delete' } });
        pages[j].splice(at, 1);
        this.n--;
        rec.io.writes++;
        rec.step(`Remove ${k} and write the page back (1 I/O).`, { line: 2, status: 'success', hl: { [id]: 'target' } });
        if (j > 0 && pages[j].length === 0) {
          pages.splice(j, 1);
          rec.step(`That overflow page is now empty, unlink it from the chain and free it.`, { line: 3, status: 'success' });
        }
        return rec.steps;
      }
      rec.step(`${k} is not in bucket ${b}, so there is nothing to delete.`, { line: 1, status: 'warn' });
      return rec.steps;
    }

    range(lo, hi) {
      const rec = new Recorder(this, 'range', null, CODE.diskRange, `Range ${lo}–${hi}`);
      const N = this.N;
      rec.addCalc(`find all keys with [[${lo} ≤ k ≤ ${hi}]]`);
      rec.addCalc(`h(${lo}) = ${lo % N}, h(${lo + 1}) = ${(lo + 1) % N}, h(${lo + 2}) = ${(lo + 2) % N} …`);
      rec.step(`Range query ${lo}–${hi}: hashing scatters neighbouring keys (h(${lo}) = ${lo % N}, h(${lo + 1}) = ${(lo + 1) % N} …), so there is no bucket to start from and no order to follow. The only way is to read every page.`, { line: 1 });
      const found = [];
      this.buckets.forEach((pages, b) => {
        pages.forEach((p, j) => {
          rec.io.reads++;
          const hits = p.filter((x) => x >= lo && x <= hi);
          found.push(...hits);
          const kh = {};
          found.forEach((x) => { kh[x] = 'found'; });
          rec.step(`Read bucket ${b}'s ${this.pageName(j)} (I/O #${rec.io.reads}): ${hits.length ? `${hits.join(', ')} ${hits.length === 1 ? 'is' : 'are'} in range` : 'nothing in range'}.`, {
            line: 4, hl: { [this.pid(b, j)]: 'read' }, kh,
          });
        });
      });
      const kh = {};
      found.forEach((x) => { kh[x] = 'found'; });
      rec.step(`Done: ${plural(found.length, 'key')} in range, but it took ${plural(rec.io.reads, 'page read')}, the whole index. A B+-tree keeps keys sorted, so it would only read the leaves covering ${lo}–${hi}.`, {
        line: 5, status: found.length ? 'success' : 'warn', kh,
      });
      return rec.steps;
    }

    example() {
      return {
        settings: { N: 4, cap: 2 },
        keys: [8, 5, 12, 9, 2, 7, 15],
        next: '16, 20',
        msg: 'Example: bucket 0 already holds 8 and 12 (full). Insert 16 and 20, both hash to bucket 0, so it needs an overflow page. Then search for 20, or try a range query such as 5-10.',
      };
    }
  }

  // ---------- 3. Extendible hashing ----------

  class Extendible {
    constructor(o) {
      this.mode = 'ext';
      this.cap = o.cap || 2;
      this.maxDepth = 5;
      this.clear();
    }

    clear() {
      this.buckets = {};
      this.ids = 0;
      this.gd = 0;
      this.dir = [this.newBucket(0).id];
      this.n = 0;
    }

    newBucket(ld) {
      const b = { id: this.ids++, ld, keys: [] };
      this.buckets[b.id] = b;
      return b;
    }

    eid(i) { return `e${i}`; }
    bid(b) { return `B${b.id}`; }
    name(b) { return letter(b.id); }
    index(k) { return k & ((1 << this.gd) - 1); }
    keys() { return Object.values(this.buckets).flatMap((b) => b.keys); }
    // The bit pattern a bucket stands for (its last ld bits).
    pattern(b) { return this.dir.indexOf(b.id) & ((1 << b.ld) - 1); }

    snapshot() {
      return {
        gd: this.gd, cap: this.cap, dir: this.dir.slice(),
        buckets: Object.values(this.buckets).map((b) => ({ id: b.id, ld: b.ld, keys: b.keys.slice() })),
      };
    }

    formula() { return ['h(k) = k, written in binary', `directory entry = last d = ${this.gd} bit${this.gd === 1 ? '' : 's'}`]; }

    rules() {
      return [`global depth d = <b>${this.gd}</b>`, `directory: <b>${1 << this.gd}</b> entr${this.gd ? 'ies' : 'y'}`,
        `<b>${Object.keys(this.buckets).length}</b> buckets`, `<b>${this.cap}</b> keys per bucket`];
    }

    calcIndex(k, rec) {
      const i = this.index(k);
      rec.addCalc(`${k} = ${binMark(k, this.gd)}₂`);
      rec.addCalc(this.gd ? `last ${this.gd} bit${this.gd === 1 ? '' : 's'}: ${bin(i, this.gd)} → entry [[${i}]]` : 'd = 0: the only entry is [[0]]');
      return i;
    }

    insert(k, record = true) {
      const rec = record ? new Recorder(this, 'insert', k, CODE.extInsert, `Insert ${k}`) : quiet();
      this.calcIndex(k, rec);
      rec.step(`Hash the key and write it in binary: ${k} = ${bin(k, BITS)}. ${this.gd ? `The last ${plural(this.gd, 'bit')} choose the directory entry.` : 'The directory has a single entry (global depth 0).'}`, {
        line: 0, ghost: { key: k, at: 'calc' },
      });
      for (let tries = 0; tries < 12; tries++) {
        const i = this.index(k), B = this.buckets[this.dir[i]];
        if (tries > 0) rec.addCalc(this.gd ? `try again: last ${this.gd} bits ${bin(i, this.gd)} → entry [[${i}]]` : 'try again: entry [[0]]');
        rec.step(`${tries ? 'Try again: e' : 'E'}ntry ${this.gd ? bin(i, this.gd) : '0'} points to bucket ${this.name(B)} (local depth ${B.ld}, ${B.keys.length}/${this.cap} keys).`, {
          line: tries ? 7 : 1, ghost: { key: k, at: this.bid(B) }, hl: { [this.eid(i)]: 'target', [this.bid(B)]: 'target' },
        });
        if (B.keys.includes(k)) {
          rec.step(`${k} is already in bucket ${this.name(B)}.`, { line: 2, status: 'warn', kh: { [k]: 'found' }, hl: { [this.bid(B)]: 'target' } });
          return rec.steps;
        }
        if (B.keys.length < this.cap) {
          B.keys.push(k);
          this.n++;
          rec.step(`Bucket ${this.name(B)} has room: store ${k}.`, { line: 2, status: 'success', kh: { [k]: 'new' }, hl: { [this.eid(i)]: 'target', [this.bid(B)]: 'target' } });
          return rec.steps;
        }
        if (B.ld === this.gd) {
          if (this.gd >= this.maxDepth) {
            B.keys.push(k);
            this.n++;
            rec.step(`Bucket ${this.name(B)} is full, but the directory can't grow past ${1 << this.maxDepth} entries in this demo, so ${k} goes into an overflow slot.`, {
              line: 2, status: 'warn', kh: { [k]: 'new' }, hl: { [this.bid(B)]: 'full' },
            });
            return rec.steps;
          }
          rec.step(`Bucket ${this.name(B)} is full, and its local depth equals the global depth (${B.ld} = ${this.gd}): no spare bit to split on. Double the directory first.`, {
            line: 3, status: 'warn', ghost: { key: k, at: this.bid(B) }, hl: { [this.bid(B)]: 'full' },
          });
          const old = this.dir.length;
          this.dir = this.dir.concat(this.dir);
          this.gd++;
          const hl = { [this.bid(B)]: 'full' };
          for (let j = old; j < 2 * old; j++) hl[this.eid(j)] = 'new';
          rec.addCalc(`directory doubled → d = [[${this.gd}]], ${this.dir.length} entries`);
          rec.step(`Directory doubled to ${this.dir.length} entries (global depth ${this.gd}). Each new entry copies the pointer of its twin, ${bin(old, this.gd)} points where ${bin(0, this.gd)} does, and so on. No keys move yet.`, {
            line: 4, ghost: { key: k, at: this.bid(B) }, hl,
          });
        }
        // Split B on its next bit.
        const pat = this.pattern(B);
        const bit = 1 << B.ld;
        B.ld++;
        const B2 = this.newBucket(B.ld);
        B2.keys = B.keys.filter((x) => x & bit);
        B.keys = B.keys.filter((x) => !(x & bit));
        for (let j = 0; j < this.dir.length; j++) if (this.dir[j] === B.id && (j & bit)) this.dir[j] = B2.id;
        const kh = {};
        B2.keys.forEach((x) => { kh[x] = 'move'; });
        rec.addCalc(`split ${this.name(B)} on bit ${B.ld}: …[[1]]${bin(pat, B.ld - 1)} → ${this.name(B2)}`);
        rec.step(`Split bucket ${this.name(B)}: both halves now have local depth ${B.ld}. Keys whose bit ${B.ld} (from the right) is 1 move to the new bucket ${this.name(B2)}${B2.keys.length ? ` (${B2.keys.join(', ')})` : ', none do'}, and the entries ending in ${bin(pat | bit, B.ld)} now point to ${this.name(B2)}.`, {
          line: 6, ghost: { key: k, at: this.bid(B) }, hl: { [this.bid(B)]: 'split', [this.bid(B2)]: 'new' }, kh,
        });
      }
      return rec.steps;
    }

    lookup(k, rec) {
      const i = this.calcIndex(k, rec);
      rec.step(`Hash the key: ${k} = ${bin(k, BITS)}${this.gd ? `, last ${plural(this.gd, 'bit')} ${bin(i, this.gd)}` : ''} → entry ${i}.`, { line: 0, ghost: { key: k, at: 'calc' } });
      const B = this.buckets[this.dir[i]];
      rec.step(`Entry ${this.gd ? bin(i, this.gd) : '0'} points to bucket ${this.name(B)}: one bucket to look in.`, {
        line: 1, ghost: { key: k, at: this.bid(B) }, hl: { [this.eid(i)]: 'target', [this.bid(B)]: 'target' },
      });
      return { i, B };
    }

    search(k) {
      const rec = new Recorder(this, 'search', k, CODE.extSearch, `Search ${k}`);
      const { i, B } = this.lookup(k, rec);
      if (B.keys.includes(k)) rec.step(`Found ${k} in bucket ${this.name(B)}, a lookup costs one directory entry plus one bucket.`, { line: 2, status: 'success', kh: { [k]: 'found' }, hl: { [this.eid(i)]: 'target', [this.bid(B)]: 'target' } });
      else rec.step(`${k} is not in bucket ${this.name(B)}, so it is not stored.`, { line: 2, status: 'warn', ghost: { key: k, at: this.bid(B) }, hl: { [this.bid(B)]: 'target' } });
      return rec.steps;
    }

    delete(k) {
      const rec = new Recorder(this, 'delete', k, CODE.extDelete, `Delete ${k}`);
      const { i, B } = this.lookup(k, rec);
      const at = B.keys.indexOf(k);
      if (at < 0) {
        rec.step(`${k} is not in bucket ${this.name(B)}, nothing to delete.`, { line: 2, status: 'warn', ghost: { key: k, at: this.bid(B) } });
        return rec.steps;
      }
      rec.step(`Found ${k} in bucket ${this.name(B)}.`, { line: 2, kh: { [k]: 'delete' }, hl: { [this.eid(i)]: 'target', [this.bid(B)]: 'target' } });
      B.keys.splice(at, 1);
      this.n--;
      rec.step(`Removed ${k}. Real systems may merge a nearly empty bucket with its split twin (and halve the directory); this demo keeps it simple.`, { line: 2, status: 'success', hl: { [this.bid(B)]: 'target' } });
      return rec.steps;
    }

    example() {
      return {
        settings: { cap: 4 },
        keys: [32, 16, 4, 12, 1, 5, 21, 13, 10, 15, 7, 19],
        next: '20',
        msg: 'Textbook example (Ramakrishnan & Gehrke): global depth 2, buckets of capacity 4. Insert 20 = 0010100₂: its bucket A (entry 00) is full and A\'s local depth equals the global depth, watch the directory double.',
      };
    }
  }

  // ---------- 4. Linear hashing ----------

  class LinearHash {
    constructor(o) {
      this.mode = 'lin';
      this.N0 = o.N0 || 4;
      this.cap = o.cap || 2;
      this.clear();
    }

    clear() {
      this.level = 0;
      this.next = 0;
      this.buckets = Array.from({ length: this.N0 }, () => [[]]);
      this.n = 0;
    }

    get Nl() { return this.N0 * 2 ** this.level; }
    pid(b, j) { return `L${b}_${j}`; }
    keys() { return this.buckets.flat(2); }

    address(k) {
      const b0 = k % this.Nl;
      return b0 < this.next ? k % (2 * this.Nl) : b0;
    }

    snapshot() {
      return { level: this.level, next: this.next, N0: this.N0, Nl: this.Nl, cap: this.cap, buckets: this.buckets.map((ps) => ps.map((p) => p.slice())) };
    }

    formula() {
      const L = this.level;
      return [`h${sub(L)}(k) = k mod ${this.Nl}`, `h${sub(L + 1)}(k) = k mod ${2 * this.Nl}`, `level ${L} · next = ${this.next}`];
    }

    rules() {
      const pages = this.buckets.reduce((a, ps) => a + ps.length, 0);
      return [`level = <b>${this.level}</b>`, `N = N₀·2^level = <b>${this.Nl}</b>`, `next = <b>${this.next}</b>`,
        `<b>${this.buckets.length}</b> buckets`, `<b>${pages - this.buckets.length}</b> overflow pages`, `<b>${this.cap}</b> keys per page`];
    }

    calcAddress(k, rec) {
      const L = this.level, Nl = this.Nl, b0 = k % Nl;
      rec.addCalc(`h${sub(L)}(${k}) = ${k} mod ${Nl} = [[${b0}]]`);
      if (b0 < this.next) rec.addCalc(`${b0} < next = ${this.next}: already split → h${sub(L + 1)}(${k}) = ${k} mod ${2 * Nl} = [[${k % (2 * Nl)}]]`);
      else rec.addCalc(`${b0} ≥ next = ${this.next}: not split yet → bucket [[${b0}]]`);
      return this.address(k);
    }

    hashMsg(k) {
      const L = this.level, Nl = this.Nl, b0 = k % Nl;
      return b0 < this.next
        ? `Hash the key: h${sub(L)}(${k}) = ${k} mod ${Nl} = ${b0}. Bucket ${b0} is before the split pointer (next = ${this.next}), so it has already split this round, use h${sub(L + 1)}(${k}) = ${k} mod ${2 * Nl} = ${k % (2 * Nl)} instead.`
        : `Hash the key: h${sub(L)}(${k}) = ${k} mod ${Nl} = ${b0}. Bucket ${b0} is at or after the split pointer (next = ${this.next}), so h${sub(L)} is final.`;
    }

    insert(k, record = true) {
      const rec = record ? new Recorder(this, 'insert', k, CODE.linInsert, `Insert ${k}`) : quiet();
      const b0 = k % this.Nl;
      const b = this.calcAddress(k, rec);
      rec.step(this.hashMsg(k), { line: b0 < this.next ? 1 : 0, ghost: { key: k, at: 'calc' } });
      const pages = this.buckets[b];
      if (pages.some((p) => p.includes(k))) {
        rec.step(`${k} is already in bucket ${b}.`, { line: 2, status: 'warn', kh: { [k]: 'found' }, hl: { [this.pid(b, 0)]: 'target' } });
        return rec.steps;
      }
      const room = pages.findIndex((p) => p.length < this.cap);
      if (room >= 0) {
        pages[room].push(k);
        this.n++;
        rec.step(`Bucket ${b} has room: store ${k}${room ? ` in its overflow page ${room}` : ''}. No split, linear hashing only splits when a page overflows.`, {
          line: 2, status: 'success', kh: { [k]: 'new' }, hl: { [this.pid(b, room)]: 'target' },
        });
        return rec.steps;
      }
      pages.push([k]);
      this.n++;
      const s = this.next;
      rec.step(`Bucket ${b} is full, so ${k} goes into a new overflow page. An overflow triggers one split, of bucket next = ${s}${b === s ? ' (here the same bucket)' : `, not of bucket ${b}`}. Buckets split in a fixed round-robin order.`, {
        line: 3, status: 'warn', kh: { [k]: 'new' }, hl: { [this.pid(b, pages.length - 1)]: 'new', [this.pid(s, 0)]: 'split' },
      });
      this.split(rec);
      return rec.steps;
    }

    split(rec) {
      const s = this.next, Nl = this.Nl, img = s + Nl, L = this.level;
      const keys = this.buckets[s].flat();
      this.buckets.push([[]]);
      rec.addCalc(`split bucket ${s} with h${sub(L + 1)}(k) = k mod ${2 * Nl}`);
      rec.step(`Split bucket ${s}: add bucket ${img} (= ${s} + ${Nl}) at the end, then rehash bucket ${s}'s keys with h${sub(L + 1)}(k) = k mod ${2 * Nl}.`, {
        line: 4, hl: { [this.pid(s, 0)]: 'split', [this.pid(img, 0)]: 'new' },
      });
      const stay = keys.filter((x) => x % (2 * Nl) === s);
      const go = keys.filter((x) => x % (2 * Nl) === img);
      this.buckets[s] = chunk(stay, this.cap);
      this.buckets[img] = chunk(go, this.cap);
      const kh = {};
      go.forEach((x) => { kh[x] = 'move'; });
      rec.addCalc(`k mod ${2 * Nl} = ${s} → stay, = ${img} → [[move]]`);
      rec.step(`Keys with k mod ${2 * Nl} = ${img} move to bucket ${img}${go.length ? ` (${go.join(', ')})` : ', none do'}; ${stay.length ? `${stay.join(', ')} stay` : 'nothing stays'} in bucket ${s}.`, {
        line: 4, kh, hl: { [this.pid(s, 0)]: 'split', [this.pid(img, 0)]: 'new' },
      });
      this.next++;
      if (this.next === Nl) {
        this.level++;
        this.next = 0;
        rec.addCalc(`round done: level = [[${this.level}]], next = 0`);
        rec.step(`All ${Nl} buckets of this round have split: level → ${this.level}, next → 0. The table now has N = ${this.Nl} buckets and h${sub(this.level)}(k) = k mod ${this.Nl} is the main hash function.`, {
          line: 6, status: 'success',
        });
      } else {
        rec.addCalc(`next → [[${this.next}]]`);
        rec.step(`Advance the split pointer: next → ${this.next}. Buckets before next (and the new ones at the end) are addressed with h${sub(L + 1)}.`, {
          line: 5, status: 'success', hl: { [this.pid(this.next, 0)]: 'target' },
        });
      }
    }

    lookup(k, rec) {
      const b0 = k % this.Nl;
      const b = this.calcAddress(k, rec);
      rec.step(this.hashMsg(k), { line: b0 < this.next ? 1 : 0, ghost: { key: k, at: 'calc' } });
      return b;
    }

    search(k) {
      const rec = new Recorder(this, 'search', k, CODE.linSearch, `Search ${k}`);
      const b = this.lookup(k, rec);
      const pages = this.buckets[b];
      const j = pages.findIndex((p) => p.includes(k));
      if (j >= 0) rec.step(`Found ${k} in bucket ${b}${j ? `'s overflow page ${j}` : ''}.`, { line: 2, status: 'success', kh: { [k]: 'found' }, hl: { [this.pid(b, j)]: 'target' } });
      else rec.step(`${k} is not in bucket ${b}${pages.length > 1 ? ' or its overflow pages' : ''}, so it is not stored.`, { line: 2, status: 'warn', ghost: { key: k, at: this.pid(b, 0) }, hl: { [this.pid(b, 0)]: 'target' } });
      return rec.steps;
    }

    delete(k) {
      const rec = new Recorder(this, 'delete', k, CODE.linDelete, `Delete ${k}`);
      const b = this.lookup(k, rec);
      const pages = this.buckets[b];
      const j = pages.findIndex((p) => p.includes(k));
      if (j < 0) {
        rec.step(`${k} is not in bucket ${b}, nothing to delete.`, { line: 2, status: 'warn', ghost: { key: k, at: this.pid(b, 0) } });
        return rec.steps;
      }
      rec.step(`Found ${k} in bucket ${b}.`, { line: 2, kh: { [k]: 'delete' }, hl: { [this.pid(b, j)]: 'target' } });
      this.buckets[b] = chunk(pages.flat().filter((x) => x !== k), this.cap);
      this.n--;
      rec.step(`Removed ${k}${pages.length > this.buckets[b].length ? ', and an overflow page is no longer needed' : ''}. (Linear hashing can also shrink by undoing splits; this demo doesn't.)`, {
        line: 2, status: 'success', hl: { [this.pid(b, 0)]: 'target' },
      });
      return rec.steps;
    }

    example() {
      return {
        settings: { N0: 4, cap: 4 },
        keys: [32, 44, 36, 9, 25, 5, 14, 18, 10, 30, 31, 35, 7, 11],
        next: '43, 37, 29',
        msg: 'Textbook example (Ramakrishnan & Gehrke): 4 buckets of capacity 4, level 0, next = 0. Insert 43: bucket 3 is full, so it gets an overflow page, but bucket 0 (where next points) is the one that splits.',
      };
    }
  }

  global.HashAlgo = {
    HashTable, StaticHash, Extendible, LinearHash, idleStep,
    MAX_KEY, BITS, MAX_M, REHASH_AT, bin, sub, letter, isPrime, nextPrime, prevPrime,
  };
})(window);
