// Generating boards.
//
// The answer comes first. `makeSampler` gives a loop drawn **uniformly at
// random from every simple cycle of the grid**, so no board here is the
// artefact of a randomised search's taste in loops. Every cell the loop misses
// is then a candidate wall, and the walls are handed the strongest clue the
// answer supports:
//
//   colour = inside or outside, read off the answer
//   arrow  = a direction and the number of loop segments along that ray
//
// If even that board has a second answer the loop is thrown away — that is the
// genre's own ceiling, and `stats.json` prices how often it bites.
//
// Then the dial. Each wall is turned down as far as it will go while the board
// still has exactly one answer:
//
//   full -> arrow (colour dropped) -> colour (number dropped) -> wall (grey,
//   no number) -> gone entirely, the cell handed back to the loop
//
// Weakening is monotone — it can only ever admit more answers — so the greedy
// pass has a fixed point and reaching it is the whole minimisation. The two
// middle levels are incomparable, which is exactly the claim the genre rests
// on, so the dial is a chain with a fork in it and the order above is the
// order they are tried in.

import {
  Clue,
  Puzzle,
  GREY,
  WHITE,
  BLACK,
  N,
  E,
  S,
  W,
  NO_DIR,
  NO_NUM,
  LV_NONE,
  LV_WALL,
  LV_COLOUR,
  LV_ARROW,
  LV_FULL,
  makePuzzle,
  insideOf,
  solve,
  E_USED,
  RULE_LEVEL,
} from './castlewall';
import { makeSampler } from './count';
import { shuffle } from './rng';

export interface GenOptions {
  w: number;
  h: number;
  /** maximum search nodes for one uniqueness check */
  maxNodes?: number;
  /** how many loops to try before giving up */
  tries?: number;
  /** solver strength used while generating */
  level?: number;
  /** tilt towards shorter loops — see CountOpts.tilt */
  tilt?: { skip: bigint; take: bigint };
  /**
   * The levels the dial is allowed to stop at, weakest first. The default is
   * the full fork, [none, wall, colour, arrow]. The shipped boards use the
   * chain [none, wall, colour] instead: a numbered clue keeps its colour, the
   * way the genre normally prints one. `stats.json` runs both and prices the
   * difference.
   */
  dial?: number[];
  /**
   * A sampler built once and reused. Building one costs a full pass of the
   * plug DP, which is 0.9 s at 10x10 and 13 s at 12x12, so a batch run builds
   * it once per grid size and hands it in.
   */
  sampler?: (rnd: () => number) => Uint8Array;
}

export interface Generated {
  w: number;
  h: number;
  clues: (Clue | null)[];
  /** the loop, as an edge bitmap */
  answer: Uint8Array;
  /** cell -> dial level */
  levels: Int8Array;
  loopLength: number;
  /** loops drawn before one produced a unique max-information board */
  loopsTried: number;
  /** uniqueness checks spent on the dial */
  checks: number;
  /** search nodes spent on the dial */
  nodes: number;
}

const edgeUsed = (a: Uint8Array, e: number): boolean => a[e] === 1;

/** Clue data for a wall at `k`, given the answer. */
export function clueFor(p: Puzzle, answer: Uint8Array, k: number, dir: number): Clue {
  let num = 0;
  for (const e of p.rays[k][dir].along) if (edgeUsed(answer, e)) num++;
  const inside = insideOfBitmap(p, answer, k);
  return { color: inside ? WHITE : BLACK, dir, num };
}

function insideOfBitmap(p: Puzzle, answer: Uint8Array, k: number): boolean {
  const asEdges = new Uint8Array(p.edgeCount);
  for (let e = 0; e < p.edgeCount; e++) asEdges[e] = answer[e] === 1 ? E_USED : 0;
  return insideOf(p, asEdges, k);
}

/** The arrow direction with the longest ray — the most a single arrow can say. */
function bestDir(p: Puzzle, k: number, rnd: () => number): number {
  let best = N;
  let bestLen = -1;
  for (const d of shuffle([N, E, S, W], rnd)) {
    const len = p.rays[k][d].along.length;
    if (len > bestLen) {
      bestLen = len;
      best = d;
    }
  }
  return best;
}

/** The clue a cell carries at a given dial level. */
export function atLevel(full: Clue, level: number): Clue | null {
  switch (level) {
    case LV_NONE:
      return null;
    case LV_WALL:
      return { color: GREY, dir: NO_DIR, num: NO_NUM };
    case LV_COLOUR:
      return { color: full.color, dir: NO_DIR, num: NO_NUM };
    case LV_ARROW:
      return { color: GREY, dir: full.dir, num: full.num };
    default:
      return { ...full };
  }
}

function assemble(
  w: number,
  h: number,
  fulls: Map<number, Clue>,
  levels: Int8Array,
): Puzzle {
  const clues: (Clue | null)[] = new Array(w * h).fill(null);
  for (const [k, full] of fulls) clues[k] = atLevel(full, levels[k]);
  return makePuzzle(w, h, clues);
}

export function generate(seedRnd: () => number, opts: GenOptions): Generated | null {
  const { w, h } = opts;
  const maxNodes = opts.maxNodes ?? 400_000;
  const tries = opts.tries ?? 60;
  const level = opts.level ?? RULE_LEVEL.loop;
  const dial = opts.dial ?? [LV_NONE, LV_WALL, LV_COLOUR, LV_ARROW];
  const sampler = opts.sampler ?? makeSampler(w, h, opts.tilt ? { tilt: opts.tilt } : {});
  const n = w * h;

  for (let t = 1; t <= tries; t++) {
    const answer = sampler(seedRnd);
    const blank = makePuzzle(w, h, new Array(n).fill(null));
    const deg = new Int32Array(n);
    let loopLength = 0;
    for (let e = 0; e < blank.edgeCount; e++) {
      if (answer[e] !== 1) continue;
      loopLength++;
      deg[blank.ends[e * 2]]++;
      deg[blank.ends[e * 2 + 1]]++;
    }
    const offLoop: number[] = [];
    for (let k = 0; k < n; k++) if (deg[k] === 0) offLoop.push(k);
    if (offLoop.length < 3 || loopLength < 8) continue;

    const fulls = new Map<number, Clue>();
    for (const k of offLoop) fulls.set(k, clueFor(blank, answer, k, bestDir(blank, k, seedRnd)));

    const levels = new Int8Array(n).fill(LV_NONE);
    for (const k of offLoop) levels[k] = LV_FULL;

    let checks = 0;
    let nodes = 0;
    const unique = (ls: Int8Array): boolean => {
      const p = assemble(w, h, fulls, ls);
      const res = solve(p, { limit: 2, level, maxNodes });
      checks++;
      nodes += res.nodes;
      if (res.aborted) return false;
      return res.count === 1;
    };

    if (!unique(levels)) continue;

    const order = shuffle(offLoop.slice(), seedRnd);

    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const k of order) {
        const cur = levels[k];
        if (cur === LV_NONE) continue;
        for (const want of dial) {
          if (want >= cur) break;
          levels[k] = want;
          if (unique(levels)) {
            changed = true;
            break;
          }
          levels[k] = cur;
        }
      }
      if (!changed) break;
    }

    return {
      w,
      h,
      clues: assemble(w, h, fulls, levels).clues,
      answer,
      levels,
      loopLength,
      loopsTried: t,
      checks,
      nodes,
    };
  }
  return null;
}

/** The same board with every colour erased. */
export function withoutColours(p: Puzzle): Puzzle {
  return makePuzzle(
    p.w,
    p.h,
    p.clues.map((c) => (c ? { ...c, color: GREY } : null)),
  );
}

/** The same board with every arrow erased. */
export function withoutArrows(p: Puzzle): Puzzle {
  return makePuzzle(
    p.w,
    p.h,
    p.clues.map((c) => (c ? { ...c, dir: NO_DIR, num: NO_NUM } : null)),
  );
}

/** The same board with every clue erased — the walls alone. */
export function wallsOnly(p: Puzzle): Puzzle {
  return makePuzzle(
    p.w,
    p.h,
    p.clues.map((c) => (c ? { color: GREY, dir: NO_DIR, num: NO_NUM } : null)),
  );
}

