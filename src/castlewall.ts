// Castle Wall.
//
// Draw **one closed loop** through the centres of the empty cells. The loop
// never enters a clue cell. A clue cell carries up to two independent pieces
// of information:
//
//   * a **number and an arrow** — the total length of the loop's segments that
//     lie in that row (or column) on the arrow's side of the cell. Equivalently
//     the number of cell borders the loop crosses if you walk out of the cell
//     in that direction.
//   * a **colour** — white means the clue cell finishes **inside** the loop,
//     black means **outside**, grey says nothing and is simply a wall.
//
// The whole genre turns on the fact that those two halves are talking about
// **disjoint sets of edges**, and the reason is a picture.
//
// Walk out of the clue cell at (r,c) heading east, along the row's centre line.
// The loop segments the arrow counts are the *horizontal* edges of row r: they
// lie **along** the ray, collinear with it. A ray that runs along a piece of
// curve does not cross it, so the arrow's number says nothing at all about
// which side of the loop the cell is on. Now nudge the ray down by epsilon.
// The only loop edges it can meet are *vertical* edges spanning rows r..r+1,
// and by the Jordan curve theorem the parity of that count is exactly the
// inside/outside bit. So:
//
//   arrow  = a count of the edges the ray runs ALONG
//   colour = the parity of the edges the ray runs ACROSS
//
// The two clue halves partition the edge set around the cell, and neither can
// be derived from the other. That is measured, not assumed — see stats.json,
// `arrowColour`.
//
// A second consequence, which the `parity` rung leans on: the same argument
// works in all four directions, so **one colour clue is four parity
// constraints**, over
//
//   west  {vEdge(rb, c') : c' < c}      east  {vEdge(rb, c') : c' > c}
//   north {hEdge(r', cb) : r' < r}      south {hEdge(r', cb) : r' > r}
//
// where rb/cb are the row/column the epsilon-nudge lands in. And with no clues
// at all, a closed curve crosses any straight line an even number of times, so
// every row gap and every column gap carries a free parity constraint too.
//
// The rule ladder, weakest first:
//
//   degree  a clue cell has no loop edges; every other cell has zero or two.
//   arrow   the numbers, propagated as an interval on each ray.
//   parity  the colours as four parity constraints each, plus the free
//           even-crossing law on every row gap and column gap.
//   loop    one loop, not several: an edge that would close a short cycle is
//           unusable while any other used edge sits outside it, and a fragment
//           whose two ends can no longer reach each other is dead.
//   probe   singleton consistency: assume an edge, propagate, drop it if the
//           board dies.
//
// `solve` is the complete search on top of `probe`.

export const E_UNKNOWN = 0;
export const E_USED = 1;
export const E_UNUSED = 2;

/** Clue colours. GREY is a wall that says nothing about inside/outside. */
export const GREY = 0;
export const WHITE = 1;
export const BLACK = 2;

/** Directions, in the order the cell tables use: N, E, S, W. */
export const N = 0;
export const E = 1;
export const S = 2;
export const W = 3;
export const OPP = [S, W, N, E] as const;
export const NO_DIR = -1;
export const NO_NUM = -1;

export const RULE_SETS = ['degree', 'arrow', 'parity', 'loop', 'probe'] as const;
export type RuleSet = (typeof RULE_SETS)[number];

export const RULE_LEVEL: Record<RuleSet, number> = {
  degree: 0,
  arrow: 1,
  parity: 2,
  loop: 3,
  probe: 4,
};

/**
 * How much a wall is allowed to say. The generator dials each clue down this
 * list and keeps the weakest level that still leaves one answer. NONE is not a
 * wall at all — the cell goes back to being an ordinary cell the loop may use.
 *
 * COLOUR and ARROW are *incomparable*: neither implies the other, which is the
 * whole point of the genre. So this is a dial with a fork in the middle, not a
 * chain.
 */
export const LV_NONE = 0;
export const LV_WALL = 1;
export const LV_COLOUR = 2;
export const LV_ARROW = 3;
export const LV_FULL = 4;
export const LEVELS = [LV_NONE, LV_WALL, LV_COLOUR, LV_ARROW, LV_FULL] as const;
export const LEVEL_NAMES = ['none', 'wall', 'colour', 'arrow', 'full'] as const;

export interface Clue {
  /** GREY | WHITE | BLACK */
  color: number;
  /** N | E | S | W, or NO_DIR */
  dir: number;
  /** the arrow's count, or NO_NUM */
  num: number;
}

export interface Ray {
  /** edges the ray runs ALONG — what the arrow counts */
  along: number[];
  /** edges the ray runs ACROSS — whose parity is the inside/outside bit */
  across: number[];
}

export interface Puzzle {
  w: number;
  h: number;
  /** cell -> clue, or null for an ordinary cell */
  clues: (Clue | null)[];
  /** cell -> [N,E,S,W] edge id, -1 where the grid ends */
  inc: Int32Array;
  edgeCount: number;
  /** edge id -> [cellA, cellB] */
  ends: Int32Array;
  /** cell -> [N,E,S,W] rays */
  rays: Ray[][];
  /** every row gap and column gap, as an edge list: crossed an even number of times */
  gaps: number[][];
}

export interface Board {
  edges: Uint8Array;
}

export const rowOf = (k: number, w: number): number => Math.floor(k / w);
export const colOf = (k: number, w: number): number => k % w;

/** Horizontal edge between (r,c) and (r,c+1). */
export const hEdge = (r: number, c: number, w: number): number => r * (w - 1) + c;
/** Vertical edge between (r,c) and (r+1,c). */
export const vEdge = (r: number, c: number, w: number, h: number): number =>
  h * (w - 1) + r * w + c;

export function edgeCountOf(w: number, h: number): number {
  return h * (w - 1) + (h - 1) * w;
}

/**
 * The four rays leaving cell (r,c). `along` is the arrow's edge set; `across`
 * is the parity set. The epsilon-nudge has to land inside the grid, which is
 * what `rb`/`cb` are for: from the bottom row you nudge up, from the right
 * column you nudge left, and the argument is unchanged.
 */
function raysAt(r: number, c: number, w: number, h: number): Ray[] {
  const rb = r <= h - 2 ? r : r - 1;
  const cb = c <= w - 2 ? c : c - 1;
  const out: Ray[] = [];
  for (const dir of [N, E, S, W]) {
    const along: number[] = [];
    const across: number[] = [];
    if (dir === E) {
      for (let cc = c; cc <= w - 2; cc++) along.push(hEdge(r, cc, w));
      if (rb >= 0) for (let cc = c + 1; cc <= w - 1; cc++) across.push(vEdge(rb, cc, w, h));
    } else if (dir === W) {
      for (let cc = 0; cc <= c - 1; cc++) along.push(hEdge(r, cc, w));
      if (rb >= 0) for (let cc = 0; cc <= c - 1; cc++) across.push(vEdge(rb, cc, w, h));
    } else if (dir === S) {
      for (let rr = r; rr <= h - 2; rr++) along.push(vEdge(rr, c, w, h));
      if (cb >= 0) for (let rr = r + 1; rr <= h - 1; rr++) across.push(hEdge(rr, cb, w));
    } else {
      for (let rr = 0; rr <= r - 1; rr++) along.push(vEdge(rr, c, w, h));
      if (cb >= 0) for (let rr = 0; rr <= r - 1; rr++) across.push(hEdge(rr, cb, w));
    }
    out.push({ along, across });
  }
  return out;
}

export function makePuzzle(w: number, h: number, clues: (Clue | null)[]): Puzzle {
  const n = w * h;
  const inc = new Int32Array(n * 4).fill(-1);
  const edgeCount = edgeCountOf(w, h);
  const ends = new Int32Array(edgeCount * 2).fill(-1);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const k = r * w + c;
      if (r > 0) inc[k * 4 + N] = vEdge(r - 1, c, w, h);
      if (c + 1 < w) inc[k * 4 + E] = hEdge(r, c, w);
      if (r + 1 < h) inc[k * 4 + S] = vEdge(r, c, w, h);
      if (c > 0) inc[k * 4 + W] = hEdge(r, c - 1, w);
    }
  }
  for (let r = 0; r < h; r++) {
    for (let c = 0; c + 1 < w; c++) {
      const e = hEdge(r, c, w);
      ends[e * 2] = r * w + c;
      ends[e * 2 + 1] = r * w + c + 1;
    }
  }
  for (let r = 0; r + 1 < h; r++) {
    for (let c = 0; c < w; c++) {
      const e = vEdge(r, c, w, h);
      ends[e * 2] = r * w + c;
      ends[e * 2 + 1] = (r + 1) * w + c;
    }
  }
  const rays: Ray[][] = [];
  for (let k = 0; k < n; k++) rays.push(raysAt(rowOf(k, w), colOf(k, w), w, h));

  const gaps: number[][] = [];
  for (let r = 0; r + 1 < h; r++) {
    const g: number[] = [];
    for (let c = 0; c < w; c++) g.push(vEdge(r, c, w, h));
    gaps.push(g);
  }
  for (let c = 0; c + 1 < w; c++) {
    const g: number[] = [];
    for (let r = 0; r < h; r++) g.push(hEdge(r, c, w));
    gaps.push(g);
  }

  return { w, h, clues: clues.slice(), inc, edgeCount, ends, rays, gaps };
}

export function makeBoard(p: Puzzle): Board {
  return { edges: new Uint8Array(p.edgeCount) };
}

export const cloneBoard = (b: Board): Board => ({ edges: b.edges.slice() });

// ---------------------------------------------------------------------------
// The independent validator. Reads the rule text, not the solver.
// ---------------------------------------------------------------------------

/** Is the (blocked) cell k inside the loop? Parity of the west parity ray. */
export function insideOf(p: Puzzle, edges: Uint8Array, k: number): boolean {
  const ray = p.rays[k][W];
  let par = 0;
  for (const e of ray.across) if (edges[e] === E_USED) par ^= 1;
  return par === 1;
}

export interface Violation {
  kind: string;
  detail: string;
}

/** Everything the rule text asks for, checked from scratch. */
export function validate(p: Puzzle, edges: Uint8Array): Violation[] {
  const bad: Violation[] = [];
  const n = p.w * p.h;
  const deg = new Int32Array(n);
  for (let e = 0; e < p.edgeCount; e++) {
    if (edges[e] !== E_USED) continue;
    deg[p.ends[e * 2]]++;
    deg[p.ends[e * 2 + 1]]++;
  }
  for (let k = 0; k < n; k++) {
    const clue = p.clues[k];
    if (clue) {
      if (deg[k] !== 0) bad.push({ kind: 'clueCellUsed', detail: `cell ${k}` });
    } else if (deg[k] !== 0 && deg[k] !== 2) {
      bad.push({ kind: 'degree', detail: `cell ${k} has degree ${deg[k]}` });
    }
  }
  // Exactly one loop, and it is not empty.
  const parent = new Int32Array(n);
  for (let k = 0; k < n; k++) parent[k] = k;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  let used = 0;
  for (let e = 0; e < p.edgeCount; e++) {
    if (edges[e] !== E_USED) continue;
    used++;
    const a = find(p.ends[e * 2]);
    const b = find(p.ends[e * 2 + 1]);
    if (a !== b) parent[a] = b;
  }
  if (used === 0) bad.push({ kind: 'noLoop', detail: 'no edges used' });
  const roots = new Set<number>();
  for (let k = 0; k < n; k++) if (deg[k] > 0) roots.add(find(k));
  if (roots.size > 1) bad.push({ kind: 'manyLoops', detail: `${roots.size} components` });

  for (let k = 0; k < n; k++) {
    const clue = p.clues[k];
    if (!clue) continue;
    if (clue.dir !== NO_DIR && clue.num !== NO_NUM) {
      let cnt = 0;
      for (const e of p.rays[k][clue.dir].along) if (edges[e] === E_USED) cnt++;
      if (cnt !== clue.num) {
        bad.push({ kind: 'arrow', detail: `cell ${k} wants ${clue.num}, ray has ${cnt}` });
      }
    }
    if (clue.color !== GREY) {
      const inside = insideOf(p, edges, k);
      if (inside !== (clue.color === WHITE)) {
        bad.push({ kind: 'colour', detail: `cell ${k} is ${inside ? 'inside' : 'outside'}` });
      }
    }
  }
  return bad;
}

export const isSolution = (p: Puzzle, edges: Uint8Array): boolean =>
  validate(p, edges).length === 0;

// ---------------------------------------------------------------------------
// Propagation
// ---------------------------------------------------------------------------

export interface Counters {
  /** how many assignments each rung made */
  byRule: Record<RuleSet, number>;
  /** search nodes */
  nodes: number;
}

export const freshCounters = (): Counters => ({
  byRule: { degree: 0, arrow: 0, parity: 0, loop: 0, probe: 0 },
  nodes: 0,
});

const DEAD = false;

function setEdge(b: Board, e: number, v: number, rule: RuleSet, ctr: Counters | null): boolean {
  const cur = b.edges[e];
  if (cur === v) return true;
  if (cur !== E_UNKNOWN) return DEAD;
  b.edges[e] = v;
  if (ctr) ctr.byRule[rule]++;
  return true;
}

/** Degree rung: clue cells are empty, every other cell has zero or two edges. */
function ruleDegree(p: Puzzle, b: Board, ctr: Counters | null): boolean {
  const n = p.w * p.h;
  for (let k = 0; k < n; k++) {
    const base = k * 4;
    const isClue = p.clues[k] !== null;
    let used = 0;
    let unknown = 0;
    for (let d = 0; d < 4; d++) {
      const e = p.inc[base + d];
      if (e < 0) continue;
      if (b.edges[e] === E_USED) used++;
      else if (b.edges[e] === E_UNKNOWN) unknown++;
    }
    if (isClue) {
      if (used > 0) return DEAD;
      if (unknown > 0) {
        for (let d = 0; d < 4; d++) {
          const e = p.inc[base + d];
          if (e >= 0 && b.edges[e] === E_UNKNOWN && !setEdge(b, e, E_UNUSED, 'degree', ctr)) return DEAD;
        }
      }
      continue;
    }
    if (used > 2) return DEAD;
    if (used === 2 && unknown > 0) {
      for (let d = 0; d < 4; d++) {
        const e = p.inc[base + d];
        if (e >= 0 && b.edges[e] === E_UNKNOWN && !setEdge(b, e, E_UNUSED, 'degree', ctr)) return DEAD;
      }
    } else if (used === 1) {
      if (unknown === 0) return DEAD;
      if (unknown === 1) {
        for (let d = 0; d < 4; d++) {
          const e = p.inc[base + d];
          if (e >= 0 && b.edges[e] === E_UNKNOWN && !setEdge(b, e, E_USED, 'degree', ctr)) return DEAD;
        }
      }
    } else if (used === 0 && unknown === 1) {
      // A lone possible edge could only give this cell degree one.
      for (let d = 0; d < 4; d++) {
        const e = p.inc[base + d];
        if (e >= 0 && b.edges[e] === E_UNKNOWN && !setEdge(b, e, E_UNUSED, 'degree', ctr)) return DEAD;
      }
    }
  }
  return true;
}

/** Push an edge set towards an exact target count. */
function forceCount(
  b: Board,
  set: number[],
  target: number,
  rule: RuleSet,
  ctr: Counters | null,
): boolean {
  let used = 0;
  let unknown = 0;
  for (const e of set) {
    if (b.edges[e] === E_USED) used++;
    else if (b.edges[e] === E_UNKNOWN) unknown++;
  }
  if (used > target) return DEAD;
  if (used + unknown < target) return DEAD;
  if (unknown === 0) return true;
  if (used === target) {
    for (const e of set) {
      if (b.edges[e] === E_UNKNOWN && !setEdge(b, e, E_UNUSED, rule, ctr)) return DEAD;
    }
  } else if (used + unknown === target) {
    for (const e of set) {
      if (b.edges[e] === E_UNKNOWN && !setEdge(b, e, E_USED, rule, ctr)) return DEAD;
    }
  }
  return true;
}

/** Push an edge set towards a parity. Only bites when one unknown is left. */
function forceParity(
  b: Board,
  set: number[],
  target: number,
  rule: RuleSet,
  ctr: Counters | null,
): boolean {
  let used = 0;
  let unknown = 0;
  let lastUnknown = -1;
  for (const e of set) {
    if (b.edges[e] === E_USED) used++;
    else if (b.edges[e] === E_UNKNOWN) {
      unknown++;
      lastUnknown = e;
    }
  }
  if (unknown === 0) return (used & 1) === target ? true : DEAD;
  if (unknown === 1) {
    const want = ((used & 1) ^ target) === 1 ? E_USED : E_UNUSED;
    return setEdge(b, lastUnknown, want, rule, ctr);
  }
  return true;
}

function ruleArrow(p: Puzzle, b: Board, ctr: Counters | null): boolean {
  const n = p.w * p.h;
  for (let k = 0; k < n; k++) {
    const clue = p.clues[k];
    if (!clue || clue.dir === NO_DIR || clue.num === NO_NUM) continue;
    if (!forceCount(b, p.rays[k][clue.dir].along, clue.num, 'arrow', ctr)) return DEAD;
  }
  return true;
}

function ruleParity(p: Puzzle, b: Board, ctr: Counters | null): boolean {
  for (const g of p.gaps) {
    if (!forceParity(b, g, 0, 'parity', ctr)) return DEAD;
  }
  const n = p.w * p.h;
  for (let k = 0; k < n; k++) {
    const clue = p.clues[k];
    if (!clue || clue.color === GREY) continue;
    const want = clue.color === WHITE ? 1 : 0;
    for (let d = 0; d < 4; d++) {
      if (!forceParity(b, p.rays[k][d].across, want, 'parity', ctr)) return DEAD;
    }
  }
  return true;
}

/**
 * Loop rung. Union-find over the used edges:
 *   - a used edge closing a component whose vertices all have degree two is a
 *     finished loop; nothing else may be used, and nothing else may still be
 *     forced.
 *   - an unknown edge joining two ends of the same fragment would close a loop
 *     early, so it is unusable while any other fragment is alive.
 *   - a fragment's two endpoints must still be able to reach each other
 *     through cells that are not walls and not already interior to a fragment.
 */
function ruleLoop(p: Puzzle, b: Board, ctr: Counters | null): boolean {
  const n = p.w * p.h;
  const deg = new Int32Array(n);
  const maybe = new Int32Array(n);
  for (let e = 0; e < p.edgeCount; e++) {
    const a = p.ends[e * 2];
    const z = p.ends[e * 2 + 1];
    if (b.edges[e] === E_USED) {
      deg[a]++;
      deg[z]++;
    } else if (b.edges[e] === E_UNKNOWN) {
      maybe[a]++;
      maybe[z]++;
    }
  }
  const parent = new Int32Array(n);
  for (let k = 0; k < n; k++) parent[k] = k;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  let usedEdges = 0;
  for (let e = 0; e < p.edgeCount; e++) {
    if (b.edges[e] !== E_USED) continue;
    usedEdges++;
    const a = find(p.ends[e * 2]);
    const z = find(p.ends[e * 2 + 1]);
    if (a === z) continue;
    parent[a] = z;
  }
  if (usedEdges === 0) return true;

  // Components that are already closed: every vertex in them has degree two.
  const compEdges = new Map<number, number>();
  const compOpen = new Map<number, number>();
  for (let e = 0; e < p.edgeCount; e++) {
    if (b.edges[e] !== E_USED) continue;
    const root = find(p.ends[e * 2]);
    compEdges.set(root, (compEdges.get(root) ?? 0) + 1);
  }
  for (let k = 0; k < n; k++) {
    if (deg[k] === 0) continue;
    const root = find(k);
    if (deg[k] < 2) compOpen.set(root, (compOpen.get(root) ?? 0) + 1);
    else if (!compOpen.has(root)) compOpen.set(root, 0);
  }
  let closedRoot = -1;
  let closedCount = 0;
  for (const [root, open] of compOpen) {
    if (open === 0) {
      closedRoot = root;
      closedCount++;
    }
  }
  if (closedCount > 1) return DEAD;
  if (closedCount === 1) {
    // One loop is finished. Everything else has to be empty.
    if (compEdges.size > 1) return DEAD;
    for (let k = 0; k < n; k++) {
      if (find(k) === closedRoot && deg[k] > 0) continue;
      const base = k * 4;
      for (let d = 0; d < 4; d++) {
        const e = p.inc[base + d];
        if (e >= 0 && b.edges[e] === E_UNKNOWN && !setEdge(b, e, E_UNUSED, 'loop', ctr)) return DEAD;
      }
    }
    return true;
  }

  // Open fragments. Every endpoint needs two live ends to continue with.
  const fragments = compEdges.size;
  for (let k = 0; k < n; k++) {
    if (deg[k] === 0) continue;
    if (deg[k] + maybe[k] < 2) return DEAD;
  }
  // An unknown edge whose two ends are already in the same fragment closes it.
  if (fragments > 1) {
    for (let e = 0; e < p.edgeCount; e++) {
      if (b.edges[e] !== E_UNKNOWN) continue;
      const a = p.ends[e * 2];
      const z = p.ends[e * 2 + 1];
      if (deg[a] !== 1 || deg[z] !== 1) continue;
      if (find(a) !== find(z)) continue;
      if (!setEdge(b, e, E_UNUSED, 'loop', ctr)) return DEAD;
    }
  }
  // Reachability: from one endpoint of each fragment, can we still get to the
  // rest of the used edges? Walk over vertices that are usable.
  const blocked = (k: number): boolean => p.clues[k] !== null;
  let start = -1;
  for (let k = 0; k < n; k++) if (deg[k] > 0) { start = k; break; }
  const seen = new Uint8Array(n);
  const stack = [start];
  seen[start] = 1;
  while (stack.length > 0) {
    const v = stack.pop() as number;
    const base = v * 4;
    for (let d = 0; d < 4; d++) {
      const e = p.inc[base + d];
      if (e < 0 || b.edges[e] === E_UNUSED) continue;
      const u = p.ends[e * 2] === v ? p.ends[e * 2 + 1] : p.ends[e * 2];
      if (seen[u] || blocked(u)) continue;
      seen[u] = 1;
      stack.push(u);
    }
  }
  for (let k = 0; k < n; k++) if (deg[k] > 0 && !seen[k]) return DEAD;
  return true;
}

/**
 * Run every rung up to `level` until nothing moves. `off` switches individual
 * rungs out without lowering the others, which is how the ablation table in
 * `stats.json` prices each one. `degree` is not optional: without it there is
 * no notion of a loop at all.
 */
export function propagate(
  p: Puzzle,
  b: Board,
  level: number,
  ctr: Counters | null = null,
  off: ReadonlySet<RuleSet> | null = null,
): boolean {
  const on = (r: RuleSet): boolean => level >= RULE_LEVEL[r] && !(off !== null && off.has(r));
  for (;;) {
    let before = 0;
    for (let e = 0; e < p.edgeCount; e++) if (b.edges[e] !== E_UNKNOWN) before++;
    if (!ruleDegree(p, b, ctr)) return DEAD;
    if (on('arrow') && !ruleArrow(p, b, ctr)) return DEAD;
    if (on('parity') && !ruleParity(p, b, ctr)) return DEAD;
    if (on('loop') && !ruleLoop(p, b, ctr)) return DEAD;
    let after = 0;
    for (let e = 0; e < p.edgeCount; e++) if (b.edges[e] !== E_UNKNOWN) after++;
    if (after === before) break;
  }
  if (on('probe')) return probeOnce(p, b, ctr, off);
  return true;
}

/** Singleton consistency, iterated to a fixed point. */
function probeOnce(
  p: Puzzle,
  b: Board,
  ctr: Counters | null,
  off: ReadonlySet<RuleSet> | null,
): boolean {
  for (;;) {
    let changed = false;
    for (let e = 0; e < p.edgeCount; e++) {
      if (b.edges[e] !== E_UNKNOWN) continue;
      const ok: number[] = [];
      for (const v of [E_USED, E_UNUSED]) {
        const t = cloneBoard(b);
        t.edges[e] = v;
        if (propagate(p, t, RULE_LEVEL.loop, null, off)) ok.push(v);
      }
      if (ok.length === 0) return DEAD;
      if (ok.length === 1) {
        if (!setEdge(b, e, ok[0], 'probe', ctr)) return DEAD;
        if (!propagate(p, b, RULE_LEVEL.loop, ctr, off)) return DEAD;
        changed = true;
      }
    }
    if (!changed) return true;
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SolveResult {
  count: number;
  solutions: Uint8Array[];
  nodes: number;
  /** true if the search was cut off by the node budget */
  aborted: boolean;
}

export interface SolveOptions {
  limit?: number;
  level?: number;
  maxNodes?: number;
  counters?: Counters | null;
  /** rungs to switch off, for the ablation table */
  off?: ReadonlySet<RuleSet> | null;
}

/** Complete search. Returns up to `limit` solutions. */
export function solve(p: Puzzle, opts: SolveOptions = {}): SolveResult {
  const limit = opts.limit ?? 2;
  const level = opts.level ?? RULE_LEVEL.loop;
  const maxNodes = opts.maxNodes ?? 4_000_000;
  const ctr = opts.counters ?? null;
  const off = opts.off ?? null;
  const solutions: Uint8Array[] = [];
  let nodes = 0;
  let aborted = false;

  const start = makeBoard(p);
  const rec = (b: Board): void => {
    if (solutions.length >= limit || aborted) return;
    nodes++;
    if (ctr) ctr.nodes++;
    if (nodes > maxNodes) {
      aborted = true;
      return;
    }
    if (!propagate(p, b, level, ctr, off)) return;
    // Branch on an edge that continues an existing fragment when there is one:
    // growing a path keeps the `loop` rung in contact with the choice, and the
    // node counts drop by orders of magnitude next to "first unknown edge".
    const pick = pickEdge(p, b);
    if (pick < 0) {
      if (isSolution(p, b.edges)) solutions.push(b.edges.slice());
      return;
    }
    for (const v of [E_USED, E_UNUSED]) {
      const t = cloneBoard(b);
      t.edges[pick] = v;
      rec(t);
      if (solutions.length >= limit || aborted) return;
    }
  };
  rec(start);
  return { count: solutions.length, solutions, nodes, aborted };
}

/** The next edge to branch on: one that extends a live fragment, if any. */
function pickEdge(p: Puzzle, b: Board): number {
  const n = p.w * p.h;
  const deg = new Int32Array(n);
  for (let e = 0; e < p.edgeCount; e++) {
    if (b.edges[e] !== E_USED) continue;
    deg[p.ends[e * 2]]++;
    deg[p.ends[e * 2 + 1]]++;
  }
  let first = -1;
  for (let e = 0; e < p.edgeCount; e++) {
    if (b.edges[e] !== E_UNKNOWN) continue;
    if (first < 0) first = e;
    if (deg[p.ends[e * 2]] === 1 || deg[p.ends[e * 2 + 1]] === 1) return e;
  }
  return first;
}

/** How far propagation alone gets, as a fraction of the answer's edges. */
export function propagateShare(
  p: Puzzle,
  answer: Uint8Array,
  level: number,
  off: ReadonlySet<RuleSet> | null = null,
): { settled: number; total: number; ok: boolean } {
  const b = makeBoard(p);
  const ok = propagate(p, b, level, null, off);
  let settled = 0;
  for (let e = 0; e < p.edgeCount; e++) {
    if (b.edges[e] === E_UNKNOWN) continue;
    if (b.edges[e] !== answer[e]) return { settled: 0, total: p.edgeCount, ok: false };
    settled++;
  }
  return { settled, total: p.edgeCount, ok };
}
