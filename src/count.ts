// Counting the loops, exactly.
//
// An answer to a Castle Wall board is a simple cycle of the grid graph that
// misses the walls. Strip the clues away and the question "how much room does
// the genre have" becomes "how many cycles does this grid have", which is a
// question with a published answer to check against: OEIS A140517.
//
// The machine is a connectivity-profile ("plug") dynamic program. Sweep the
// cells in reading order carrying a frontier of `w + 1` plugs — one per column
// for the vertical edge crossing the sweep line, plus one for the horizontal
// edge dangling out of the cell just processed — and remember which plug is
// paired with which. Canonicalise the pairing by first appearance and the
// number of live states stays small even when the number of cycles does not.
//
// Two things here are not in the textbook version:
//
//   1. **Cells may be skipped.** A Hamiltonian-cycle DP forces every cell onto
//      the loop; Castle Wall's loop wanders, so "this cell is not on the loop"
//      is a legal move, and with it the DP counts *all* simple cycles.
//   2. **Inside/outside costs one bit.** Sweeping left to right along row r,
//      carry the running parity of the vertical edges already laid down in
//      that row. At cell (r,c) that bit *is* the answer to "is (r,c) inside
//      the loop" — it is the west parity ray, evaluated incrementally. Reset it
//      at every row start. One extra bit in the key, and the DP can count the
//      cycles that agree with any colouring of the walls.
//
// Written as a memoised recursion from the *end* of the sweep, so `rec(i, st)`
// is the number of ways to finish — exactly the weight needed to sample a
// cycle **uniformly at random** in one forward walk. The generator draws its
// answers that way, so the loops behind the shipped boards are uniform over
// all the legal loops of their grid.

import { hEdge, vEdge, edgeCountOf } from './castlewall';

/** Plug slots are base-8 digits; ids run 1..7, which covers grids to w = 14. */
const BASE = 8;

function encode(slots: number[]): number {
  let k = 0;
  for (let j = slots.length - 1; j >= 0; j--) k = k * BASE + slots[j];
  return k;
}

/** Relabel component ids by first appearance, so equivalent frontiers merge. */
function canon(slots: number[]): number[] {
  const map = new Map<number, number>();
  let next = 1;
  const out = slots.slice();
  for (let j = 0; j < out.length; j++) {
    const v = out[j];
    if (v === 0) continue;
    let m = map.get(v);
    if (m === undefined) {
      m = next++;
      map.set(v, m);
    }
    out[j] = m;
  }
  return out;
}

function freshId(slots: number[]): number {
  const seen = new Set(slots);
  for (let i = 1; i < BASE; i++) if (!seen.has(i)) return i;
  throw new Error('frontier too wide for base-8 plug ids');
}

export interface Move {
  next: number[];
  up: boolean;
  left: boolean;
  down: boolean;
  right: boolean;
  /** 1 once a loop has closed */
  closed: number;
}

export interface CountOpts {
  /** cell -> 1 if the loop may not enter it */
  blocked?: Uint8Array;
  /** cell -> 1 inside, 0 outside, -1 free. Only meaningful on blocked cells. */
  colour?: Int8Array;
  /**
   * Exponential tilt towards short loops. Each of the grid's E edge slots gets
   * weight `skip` when the loop leaves it alone and `take` when the loop uses
   * it, so a loop of length L weighs skip^(E-L) * take^L and the measure slides
   * from uniform (skip = take) towards short loops as skip/take grows. Kept as
   * a pair of bigints so the tilted counts stay exact.
   *
   * The generator needs this. A cycle drawn uniformly from a 10x10 grid covers
   * about three cells in four, which leaves too few walls to pin it down — see
   * `stats.json`, `loopLength`. And the ratio is sharp: skip/take = 1 gives 75%
   * coverage, 2 gives 31%, 3 gives 5%. All the interesting boards live in the
   * sliver between 1 and 2.
   */
  tilt?: { skip: bigint; take: bigint };
}

/**
 * Every legal way to route the loop through cell (r,c). The cell's up and left
 * edges are not choices — the frontier already decided them — so the only
 * freedom is which of `down` and `right` makes up the degree.
 */
export function movesAt(
  slots: number[],
  closed: number,
  r: number,
  c: number,
  w: number,
  h: number,
  blocked: boolean,
): Move[] {
  const U = slots[c];
  const L = slots[w];
  const hasDown = r < h - 1;
  const hasRight = c < w - 1;
  const out: Move[] = [];

  if (blocked) {
    // Nothing may arrive, and nothing may leave.
    if (U !== 0 || L !== 0) return out;
    const s = slots.slice();
    s[w] = 0;
    out.push({ next: canon(s), up: false, left: false, down: false, right: false, closed });
    return out;
  }

  if (U !== 0 && L !== 0) {
    const s = slots.slice();
    s[c] = 0;
    s[w] = 0;
    if (U === L) {
      if (closed === 1) return out;
      out.push({ next: canon(s), up: true, left: true, down: false, right: false, closed: 1 });
    } else {
      for (let j = 0; j <= w; j++) if (s[j] === L) s[j] = U;
      out.push({ next: canon(s), up: true, left: true, down: false, right: false, closed });
    }
    return out;
  }

  if (U !== 0 || L !== 0) {
    const pl = U !== 0 ? U : L;
    const fromUp = U !== 0;
    if (hasDown) {
      const s = slots.slice();
      s[c] = pl;
      s[w] = 0;
      out.push({ next: canon(s), up: fromUp, left: !fromUp, down: true, right: false, closed });
    }
    if (hasRight) {
      const s = slots.slice();
      s[c] = 0;
      s[w] = pl;
      out.push({ next: canon(s), up: fromUp, left: !fromUp, down: false, right: true, closed });
    }
    return out;
  }

  // Nothing arrives: the cell sits off the loop ...
  {
    const s = slots.slice();
    s[w] = 0;
    out.push({ next: canon(s), up: false, left: false, down: false, right: false, closed });
  }
  // ... or it opens a new component with its down and right edges.
  if (hasDown && hasRight && closed !== 1) {
    const s = slots.slice();
    const id = freshId(s);
    s[c] = id;
    s[w] = id;
    out.push({ next: canon(s), up: false, left: false, down: true, right: true, closed });
  }
  return out;
}

const stateKey = (slots: number[], closed: number, par: number): number =>
  encode(slots) * 4 + closed * 2 + par;

interface Ctx {
  w: number;
  h: number;
  n: number;
  blocked: Uint8Array;
  colour: Int8Array;
  skip: bigint;
  take: bigint;
}

function ctxOf(w: number, h: number, opts: CountOpts): Ctx {
  const n = w * h;
  return {
    w,
    h,
    n,
    blocked: opts.blocked ?? new Uint8Array(n),
    colour: opts.colour ?? new Int8Array(n).fill(-1),
    skip: opts.tilt?.skip ?? 1n,
    take: opts.tilt?.take ?? 1n,
  };
}

/** How many edges cell (r,c) is responsible for creating: its down and right. */
const availAt = (r: number, c: number, w: number, h: number): number =>
  (r < h - 1 ? 1 : 0) + (c < w - 1 ? 1 : 0);

const usedBy = (m: Move): number => (m.down ? 1 : 0) + (m.right ? 1 : 0);

function tiltWeight(ctx: Ctx, avail: number, taken: number): bigint {
  if (ctx.skip === 1n && ctx.take === 1n) return 1n;
  return ctx.skip ** BigInt(avail - taken) * ctx.take ** BigInt(taken);
}

function build(ctx: Ctx): {
  rec: (i: number, slots: number[], closed: number, par: number) => bigint;
  memo: Map<number, bigint>[];
} {
  const { w, h, n } = ctx;
  const memo: Map<number, bigint>[] = Array.from({ length: n + 1 }, () => new Map());
  const rec = (i: number, slots: number[], closed: number, par: number): bigint => {
    if (i === n) return slots.every((v) => v === 0) && closed === 1 ? 1n : 0n;
    const key = stateKey(slots, closed, par);
    const hit = memo[i].get(key);
    if (hit !== undefined) return hit;
    const r = Math.floor(i / w);
    const c = i % w;
    let total = 0n;
    const isBlocked = ctx.blocked[i] === 1;
    const avail = availAt(r, c, w, h);
    // `par` is the west parity ray of this cell, so it *is* its inside bit.
    if (!(isBlocked && ctx.colour[i] >= 0 && ctx.colour[i] !== par)) {
      for (const m of movesAt(slots, closed, r, c, w, h, isBlocked)) {
        const nextPar = c === w - 1 ? 0 : par ^ (m.down ? 1 : 0);
        total += tiltWeight(ctx, avail, usedBy(m)) * rec(i + 1, m.next, m.closed, nextPar);
      }
    }
    memo[i].set(key, total);
    return total;
  };
  return { rec, memo };
}

/** How many simple cycles the grid has, subject to `opts`. Exact. */
export function countCycles(w: number, h: number, opts: CountOpts = {}): bigint {
  if (w < 2 || h < 2) return 0n;
  const ctx = ctxOf(w, h, opts);
  const { rec } = build(ctx);
  return rec(0, new Array<number>(w + 1).fill(0), 0, 0);
}

/** How many distinct frontier states the sweep ever visits. */
export function profileStates(w: number, h: number, opts: CountOpts = {}): number {
  if (w < 2 || h < 2) return 0;
  const ctx = ctxOf(w, h, opts);
  const { rec, memo } = build(ctx);
  rec(0, new Array<number>(w + 1).fill(0), 0, 0);
  return memo.reduce((a, m) => a + m.size, 0);
}

/**
 * A sampler over the cycles of one grid. Building it costs one pass of the DP;
 * after that every draw is uniform over all of them.
 */
export function makeSampler(
  w: number,
  h: number,
  opts: CountOpts = {},
): (rnd: () => number) => Uint8Array {
  const ctx = ctxOf(w, h, opts);
  const { rec } = build(ctx);
  const total = rec(0, new Array<number>(w + 1).fill(0), 0, 0);
  if (total === 0n) throw new Error(`no cycle on ${w}x${h} under these constraints`);
  const { n } = ctx;

  return (rnd: () => number): Uint8Array => {
    const used = new Uint8Array(edgeCountOf(w, h));
    let slots = new Array<number>(w + 1).fill(0);
    let closed = 0;
    let par = 0;
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / w);
      const c = i % w;
      const moves = movesAt(slots, closed, r, c, w, h, ctx.blocked[i] === 1);
      const avail = availAt(r, c, w, h);
      const pars = moves.map((m) => (c === w - 1 ? 0 : par ^ (m.down ? 1 : 0)));
      const weights = moves.map((m, j) =>
        tiltWeight(ctx, avail, usedBy(m)) * rec(i + 1, m.next, m.closed, pars[j]),
      );
      const sum = weights.reduce((a, b) => a + b, 0n);
      let pick = (sum * BigInt(Math.floor(rnd() * 9007199254740992))) / 9007199254740992n;
      let chosen = -1;
      for (let j = 0; j < moves.length; j++) {
        if (weights[j] === 0n) continue;
        chosen = j;
        if (pick < weights[j]) break;
        pick -= weights[j];
      }
      const m = moves[chosen];
      if (m.up) used[vEdge(r - 1, c, w, h)] = 1;
      if (m.left) used[hEdge(r, c - 1, w)] = 1;
      if (m.down) used[vEdge(r, c, w, h)] = 1;
      if (m.right) used[hEdge(r, c, w)] = 1;
      slots = m.next;
      closed = m.closed;
      par = pars[chosen];
    }
    return used;
  };
}

/**
 * Every simple cycle of a small grid, by depth-first search over paths — an
 * implementation that shares no code with the plug DP, so the two can be
 * checked against each other. Each cycle is visited once: it is enumerated
 * from its smallest vertex, and the direction is pinned by requiring the
 * second vertex to be smaller than the last.
 */
export function enumerateCycles(w: number, h: number, cb: (used: Uint8Array) => void): number {
  const n = w * h;
  if (w < 2 || h < 2) return 0;
  const nbrs: number[][] = [];
  for (let k = 0; k < n; k++) {
    const r = Math.floor(k / w);
    const c = k % w;
    const list: number[] = [];
    if (r > 0) list.push(k - w);
    if (c > 0) list.push(k - 1);
    if (c + 1 < w) list.push(k + 1);
    if (r + 1 < h) list.push(k + w);
    nbrs.push(list);
  }
  const visited = new Uint8Array(n);
  const path: number[] = [];
  let found = 0;

  const emit = (): void => {
    const used = new Uint8Array(edgeCountOf(w, h));
    for (let i = 0; i + 1 < path.length; i++) mark(used, path[i], path[i + 1], w, h);
    mark(used, path[path.length - 1], path[0], w, h);
    found++;
    cb(used);
  };

  const dfs = (s: number, cur: number): void => {
    for (const u of nbrs[cur]) {
      if (u === s) {
        if (path.length >= 4 && path[1] < path[path.length - 1]) emit();
        continue;
      }
      if (u < s || visited[u]) continue;
      visited[u] = 1;
      path.push(u);
      dfs(s, u);
      path.pop();
      visited[u] = 0;
    }
  };

  for (let s = 0; s < n; s++) {
    visited[s] = 1;
    path.push(s);
    dfs(s, s);
    path.pop();
    visited[s] = 0;
  }
  return found;
}

function mark(used: Uint8Array, a: number, b: number, w: number, h: number): void {
  const ra = Math.floor(a / w);
  const ca = a % w;
  const rb = Math.floor(b / w);
  const cb = b % w;
  if (ra === rb) used[hEdge(ra, Math.min(ca, cb), w)] = 1;
  else used[vEdge(Math.min(ra, rb), ca, w, h)] = 1;
}

/**
 * The cycles of a grid split by length, exactly. Index L holds the number of
 * simple cycles with L edges. This is the density the generator is fighting:
 * it peaks high, and high is where Castle Wall boards stop being puzzles.
 */
export function countCyclesByLength(w: number, h: number, opts: CountOpts = {}): bigint[] {
  const ec = edgeCountOf(w, h);
  const zero = (): bigint[] => new Array<bigint>(ec + 1).fill(0n);
  if (w < 2 || h < 2) return zero();
  const ctx = ctxOf(w, h, opts);
  const { n } = ctx;
  const memo: Map<number, bigint[]>[] = Array.from({ length: n + 1 }, () => new Map());
  const rec = (i: number, slots: number[], closed: number, par: number): bigint[] => {
    if (i === n) {
      const acc = zero();
      if (slots.every((v) => v === 0) && closed === 1) acc[0] = 1n;
      return acc;
    }
    const key = stateKey(slots, closed, par);
    const hit = memo[i].get(key);
    if (hit !== undefined) return hit;
    const r = Math.floor(i / w);
    const c = i % w;
    const acc = zero();
    const isBlocked = ctx.blocked[i] === 1;
    if (!(isBlocked && ctx.colour[i] >= 0 && ctx.colour[i] !== par)) {
      for (const m of movesAt(slots, closed, r, c, w, h, isBlocked)) {
        const nextPar = c === w - 1 ? 0 : par ^ (m.down ? 1 : 0);
        const add = usedBy(m);
        const sub = rec(i + 1, m.next, m.closed, nextPar);
        for (let L = 0; L + add <= ec; L++) if (sub[L] !== 0n) acc[L + add] += sub[L];
      }
    }
    memo[i].set(key, acc);
    return acc;
  };
  return rec(0, new Array<number>(w + 1).fill(0), 0, 0);
}
