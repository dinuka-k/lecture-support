/*
 * Sorting algorithms for the sorting demo. Each one runs on an array of items
 * ({ id, v }) and records every comparison, swap and move as a snapshot step,
 * so playback can jump back and forth.
 */
(function (global) {
  'use strict';

  // Pseudocode; "▹" starts a comment.
  const ALGOS = {
    bubble: {
      name: 'Bubble sort',
      best: 'O(n)', avg: 'O(n²)', worst: 'O(n²)', space: 'O(1)', stable: true,
      idea: 'Repeatedly compare neighbours and swap them if they are out of order. Each pass bubbles the largest remaining value to the end.',
      code: [
        'for pass = 1 … n−1:',
        '  swapped ← false',
        '  for j = 0 … n−1−pass:',
        '    if a[j] > a[j+1]:',
        '      swap a[j], a[j+1]; swapped ← true',
        '  ▹ a[n−pass] is now in its final place',
        '  if not swapped: stop ▹ already sorted',
      ],
    },
    selection: {
      name: 'Selection sort',
      best: 'O(n²)', avg: 'O(n²)', worst: 'O(n²)', space: 'O(1)', stable: false,
      idea: 'Find the smallest value in the unsorted part and swap it to the front. The sorted part grows by one each pass.',
      code: [
        'for i = 0 … n−2:',
        '  min ← i',
        '  for j = i+1 … n−1:',
        '    if a[j] < a[min]: min ← j',
        '  swap a[i], a[min]',
        '  ▹ a[0 … i] is sorted and final',
      ],
    },
    insertion: {
      name: 'Insertion sort',
      best: 'O(n)', avg: 'O(n²)', worst: 'O(n²)', space: 'O(1)', stable: true,
      idea: 'Take the next value and slide it left into its place among the already sorted values — like sorting playing cards in your hand.',
      code: [
        'for i = 1 … n−1:',
        '  key ← a[i]; j ← i − 1',
        '  while j ≥ 0 and a[j] > key:',
        '    a[j+1] ← a[j]; j ← j − 1 ▹ shift right',
        '  a[j+1] ← key',
        '  ▹ a[0 … i] is sorted',
      ],
    },
    merge: {
      name: 'Merge sort',
      best: 'O(n log n)', avg: 'O(n log n)', worst: 'O(n log n)', space: 'O(n)', stable: true,
      idea: 'Divide and conquer: split the array in half, sort each half recursively, then merge the two sorted halves using a temporary array.',
      code: [
        'mergeSort(lo, hi):',
        '  if lo ≥ hi: return ▹ one element is sorted',
        '  mid ← (lo + hi) / 2',
        '  mergeSort(lo, mid); mergeSort(mid+1, hi)',
        '  merge: repeatedly take the smaller front item',
        '    of the two halves into temp',
        '  copy temp back into a[lo … hi]',
      ],
    },
    quick: {
      name: 'Quick sort',
      best: 'O(n log n)', avg: 'O(n log n)', worst: 'O(n²)', space: 'O(log n)', stable: false,
      idea: 'Pick a pivot (here the last item), partition so smaller values go left and larger go right, then sort both sides recursively.',
      code: [
        'quickSort(lo, hi):',
        '  if lo ≥ hi: return',
        '  pivot ← a[hi]; i ← lo ▹ Lomuto partition',
        '  for j = lo … hi−1:',
        '    if a[j] < pivot: swap a[i], a[j]; i ← i + 1',
        '  swap a[i], a[hi] ▹ pivot lands in its final place',
        '  quickSort(lo, i−1); quickSort(i+1, hi)',
      ],
    },
    heap: {
      name: 'Heap sort',
      best: 'O(n log n)', avg: 'O(n log n)', worst: 'O(n log n)', space: 'O(1)', stable: false,
      idea: 'View the array as a binary tree. Build a max-heap (every parent ≥ its children), then repeatedly swap the root (the maximum) to the end and repair the heap.',
      code: [
        'for i = n/2 − 1 down to 0: siftDown(i, n) ▹ build max-heap',
        'for end = n−1 down to 1:',
        '  swap a[0], a[end] ▹ max goes to its final place',
        '  siftDown(0, end)',
        'siftDown(i, size):',
        '  c ← larger child of i (2i+1 or 2i+2, if < size)',
        '  if a[c] > a[i]: swap a[i], a[c]; siftDown(c, size)',
      ],
    },
  };

  class Recorder {
    constructor(items, algo) {
      this.a = items.slice();
      this.aux = null;
      this.done = new Set();
      this.stats = { cmp: 0, swp: 0 };
      this.algo = algo;
      this.steps = [];
      this.heap = null;
    }

    step(msg, o = {}) {
      this.steps.push({
        algo: this.algo, msg, status: o.status || 'info', line: o.line == null ? -1 : o.line,
        main: this.a.slice(), aux: this.aux ? this.aux.slice() : null,
        done: [...this.done], hl: o.hl || {}, range: o.range || null, marks: o.marks || [],
        heap: this.heap, stats: Object.assign({}, this.stats),
      });
    }

    swap(i, j) {
      const t = this.a[i];
      this.a[i] = this.a[j];
      this.a[j] = t;
      this.stats.swp++;
    }
  }

  const v = (it) => it.v;

  function bubble(rec) {
    const a = rec.a, n = a.length;
    for (let pass = 1; pass < n; pass++) {
      let swapped = false;
      for (let j = 0; j <= n - 1 - pass; j++) {
        rec.stats.cmp++;
        const big = v(a[j]) > v(a[j + 1]);
        rec.step(`Compare ${v(a[j])} and ${v(a[j + 1])}: ${big ? 'out of order' : 'in order — leave them'}.`, {
          line: 3, hl: { [a[j].id]: 'compare', [a[j + 1].id]: 'compare' }, marks: [{ i: j, label: 'j' }],
        });
        if (big) {
          rec.swap(j, j + 1);
          swapped = true;
          rec.step(`Swap them: ${v(a[j])} moves left, ${v(a[j + 1])} moves right.`, { line: 4, hl: { [a[j].id]: 'swap', [a[j + 1].id]: 'swap' } });
        }
      }
      rec.done.add(a[n - pass].id);
      if (!swapped) {
        a.forEach((it) => rec.done.add(it.id));
        rec.step(`No swaps in pass ${pass}: the array is already sorted, so stop early.`, { line: 6, status: 'success' });
        return;
      }
      rec.step(`End of pass ${pass}: ${v(a[n - pass])} has bubbled up to its final place.`, { line: 5 });
    }
    a.forEach((it) => rec.done.add(it.id));
    rec.step('Sorted!', { line: -1, status: 'success' });
  }

  function selection(rec) {
    const a = rec.a, n = a.length;
    for (let i = 0; i < n - 1; i++) {
      let min = i;
      rec.step(`Pass ${i + 1}: find the smallest value in positions ${i}–${n - 1}. Start with min = ${v(a[i])}.`, {
        line: 1, hl: { [a[i].id]: 'min' }, range: [i, n - 1], marks: [{ i, label: 'i' }],
      });
      for (let j = i + 1; j < n; j++) {
        rec.stats.cmp++;
        const less = v(a[j]) < v(a[min]);
        rec.step(`Compare ${v(a[j])} with the current min ${v(a[min])}: ${less ? 'smaller — new min' : 'not smaller'}.`, {
          line: 3, hl: { [a[j].id]: 'compare', [a[min].id]: 'min' }, range: [i, n - 1], marks: [{ i, label: 'i' }, { i: j, label: 'j' }],
        });
        if (less) min = j;
      }
      if (min !== i) {
        rec.swap(i, min);
        rec.step(`Swap the minimum ${v(a[i])} into position ${i}.`, { line: 4, hl: { [a[i].id]: 'swap', [a[min].id]: 'swap' }, marks: [{ i, label: 'i' }] });
      } else {
        rec.step(`${v(a[i])} is already the minimum — no swap needed.`, { line: 4, hl: { [a[i].id]: 'min' }, marks: [{ i, label: 'i' }] });
      }
      rec.done.add(a[i].id);
    }
    a.forEach((it) => rec.done.add(it.id));
    rec.step('Sorted!', { status: 'success' });
  }

  function insertion(rec) {
    const a = rec.a, n = a.length;
    for (let i = 1; i < n; i++) {
      const key = a[i];
      rec.step(`Take key = ${v(key)}. Everything to its left (positions 0–${i - 1}) is already sorted.`, {
        line: 1, hl: { [key.id]: 'key' }, range: [0, i - 1], marks: [{ i, label: 'key' }],
      });
      let j = i - 1;
      while (j >= 0) {
        rec.stats.cmp++;
        const big = v(a[j]) > v(key);
        rec.step(`Compare ${v(a[j])} with key ${v(key)}: ${big ? 'bigger — shift it right' : `not bigger — ${v(key)} belongs right after it`}.`, {
          line: 2, hl: { [key.id]: 'key', [a[j].id]: 'compare' }, range: [0, i], marks: [{ i: j, label: 'j' }],
        });
        if (!big) break;
        rec.swap(j, j + 1);
        rec.step(`Shift ${v(a[j + 1])} one place right; the key moves left.`, { line: 3, hl: { [key.id]: 'key', [a[j + 1].id]: 'swap' }, range: [0, i] });
        j--;
      }
      rec.step(`Place ${v(key)} at position ${j + 1}. Positions 0–${i} are now sorted.`, { line: 4, hl: { [key.id]: 'placed' }, range: [0, i] });
    }
    a.forEach((it) => rec.done.add(it.id));
    rec.step('Sorted!', { status: 'success' });
  }

  function merge(rec) {
    const a = rec.a, n = a.length;
    const sort = (lo, hi, depth) => {
      if (lo >= hi) return;
      const mid = (lo + hi) >> 1;
      rec.step(`Split ${lo}–${hi} into ${lo}–${mid} and ${mid + 1}–${hi}.`, { line: 2, range: [lo, hi], marks: [{ i: lo, label: 'lo' }, { i: hi, label: 'hi' }] });
      sort(lo, mid, depth + 1);
      sort(mid + 1, hi, depth + 1);
      rec.aux = Array(n).fill(null);
      let i = lo, j = mid + 1, k = lo;
      rec.step(`Merge the sorted halves ${lo}–${mid} and ${mid + 1}–${hi} into the temporary array below.`, { line: 4, range: [lo, hi] });
      while (i <= mid || j <= hi) {
        let take;
        if (i > mid) take = j++;
        else if (j > hi) take = i++;
        else {
          rec.stats.cmp++;
          const left = v(a[i]) <= v(a[j]);
          rec.step(`Compare the front items ${v(a[i])} and ${v(a[j])}: take ${left ? v(a[i]) : v(a[j])}${v(a[i]) === v(a[j]) ? ' (the left one, which keeps the sort stable)' : ''}.`, {
            line: 4, hl: { [a[i].id]: 'compare', [a[j].id]: 'compare' }, range: [lo, hi], marks: [{ i, label: 'i' }, { i: j, label: 'j' }],
          });
          take = left ? i++ : j++;
        }
        const it = a[take];
        rec.aux[k] = it;
        a[take] = null;
        rec.stats.swp++;
        rec.step(`Move ${v(it)} into temp[${k}].`, { line: 5, hl: { [it.id]: 'placed' }, range: [lo, hi] });
        k++;
      }
      for (let t = lo; t <= hi; t++) a[t] = rec.aux[t];
      rec.aux = null;
      if (lo === 0 && hi === n - 1) a.forEach((x) => rec.done.add(x.id));
      rec.step(`Copy temp back: positions ${lo}–${hi} are now sorted.`, { line: 6, range: [lo, hi], status: lo === 0 && hi === n - 1 ? 'success' : 'info' });
    };
    sort(0, n - 1, 0);
    a.forEach((it) => rec.done.add(it.id));
  }

  function quick(rec) {
    const a = rec.a;
    const sort = (lo, hi) => {
      if (lo > hi) return;
      if (lo === hi) {
        rec.done.add(a[lo].id);
        rec.step(`Range ${lo}–${hi} has one item (${v(a[lo])}): it is in place.`, { line: 1, range: [lo, hi] });
        return;
      }
      const p = a[hi];
      let i = lo;
      rec.step(`Partition ${lo}–${hi} around the pivot ${v(p)} (the last item). i marks where the next smaller value goes.`, {
        line: 2, hl: { [p.id]: 'pivot' }, range: [lo, hi], marks: [{ i, label: 'i' }],
      });
      for (let j = lo; j < hi; j++) {
        rec.stats.cmp++;
        const less = v(a[j]) < v(p);
        rec.step(`Is ${v(a[j])} < pivot ${v(p)}? ${less ? 'Yes — it belongs on the left.' : 'No — leave it on the right.'}`, {
          line: 4, hl: { [p.id]: 'pivot', [a[j].id]: 'compare' }, range: [lo, hi], marks: [{ i, label: 'i' }, { i: j, label: 'j' }],
        });
        if (less) {
          if (i !== j) {
            rec.swap(i, j);
            rec.step(`Swap ${v(a[i])} into position ${i}.`, { line: 4, hl: { [p.id]: 'pivot', [a[i].id]: 'swap', [a[j].id]: 'swap' }, range: [lo, hi], marks: [{ i, label: 'i' }, { i: j, label: 'j' }] });
          }
          i++;
        }
      }
      if (i !== hi) rec.swap(i, hi);
      rec.done.add(p.id);
      rec.step(`Put the pivot ${v(p)} at position ${i}: everything left of it is smaller, everything right is larger. It is in its final place.`, {
        line: 5, hl: { [p.id]: 'pivot' }, range: [lo, hi],
      });
      sort(lo, i - 1);
      sort(i + 1, hi);
    };
    sort(0, a.length - 1);
    a.forEach((it) => rec.done.add(it.id));
    rec.step('Sorted!', { status: 'success' });
  }

  function heap(rec) {
    const a = rec.a, n = a.length;
    const sift = (i, size, line) => {
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        if (l >= size) return;
        let c = l;
        if (r < size) {
          rec.stats.cmp++;
          if (v(a[r]) > v(a[l])) c = r;
        }
        rec.stats.cmp++;
        const bigger = v(a[c]) > v(a[i]);
        rec.step(`Sift down ${v(a[i])}: its larger child is ${v(a[c])}${bigger ? ' — bigger, so swap them.' : ' — not bigger, so the heap property holds here.'}`, {
          line: 6, hl: { [a[i].id]: 'compare', [a[c].id]: 'compare' }, range: [0, size - 1],
        });
        if (!bigger) return;
        rec.swap(i, c);
        rec.step(`Swapped: ${v(a[i])} moves up, ${v(a[c])} moves down.`, { line: 6, hl: { [a[i].id]: 'swap', [a[c].id]: 'swap' }, range: [0, size - 1] });
        i = c;
      }
    };
    rec.heap = n;
    rec.step('Phase 1: build a max-heap. Start at the last parent and sift each one down.', { line: 0, range: [0, n - 1] });
    for (let i = (n >> 1) - 1; i >= 0; i--) sift(i, n, 0);
    rec.step(`Max-heap built: the root ${v(a[0])} is the largest value.`, { line: 0, hl: { [a[0].id]: 'pivot' }, range: [0, n - 1] });
    for (let end = n - 1; end > 0; end--) {
      rec.swap(0, end);
      rec.heap = end;
      rec.done.add(a[end].id);
      rec.step(`Swap the root (max ${v(a[end])}) with the last heap item; ${v(a[end])} is now final. The heap shrinks to ${end} item${end === 1 ? '' : 's'}.`, {
        line: 2, hl: { [a[end].id]: 'swap', [a[0].id]: 'swap' }, range: [0, end - 1],
      });
      sift(0, end, 3);
    }
    rec.heap = 0;
    a.forEach((it) => rec.done.add(it.id));
    rec.step('Sorted!', { status: 'success' });
  }

  const RUN = { bubble, selection, insertion, merge, quick, heap };

  function record(algo, items) {
    const rec = new Recorder(items, algo);
    rec.step(`${ALGOS[algo].name}: ${ALGOS[algo].idea}`, { line: 0 });
    RUN[algo](rec);
    const last = rec.steps[rec.steps.length - 1];
    last.status = 'success';
    last.msg = `Sorted! ${rec.stats.cmp} comparisons and ${rec.stats.swp} ${algo === 'merge' ? 'moves' : 'swaps'} for n = ${items.length}.`;
    return rec.steps;
  }

  function idle(items, algo, msg) {
    return {
      algo, msg, status: 'info', line: -1, main: items.slice(), aux: null, done: [], hl: {}, range: null, marks: [],
      heap: algo === 'heap' ? items.length : null, stats: { cmp: 0, swp: 0 },
    };
  }

  global.SortAlgo = { ALGOS, record, idle };
})(window);
