// Measurements. Writes src/stats.json.
//
// Nothing in the README, the page or the article is a number somebody typed;
// every one of them is read out of this file.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  Clue,
  Puzzle,
  RULE_SETS,
  RULE_LEVEL,
  RuleSet,
  E_USED,
  E_UNUSED,
  LV_NONE,
  LV_WALL,
  LV_COLOUR,
  LV_ARROW,
  LEVEL_NAMES,
  WHITE,
  makePuzzle,
  solve,
  propagateShare,
  insideOf,
  isSolution,
} from '../src/castlewall';
import { enumerateCycles, countCycles, makeSampler } from '../src/count';
import { clueFor, withoutColours, withoutArrows, wallsOnly, generate } from '../src/generate';
import { mulberry32 } from '../src/rng';
import bank from '../src/puzzles.json';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'stats.json');
const BANK = bank as unknown as {
  boards: { id: string; w: number; h: number; clues: { k: number; color: number; dir: number; num: number }[]; answer: string; loopLength: number }[];
  levelTally: Record<string, number>;
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Off-loop cells of a cycle, plus the blank puzzle used to read the rays. */
function dissect(w: number, h: number, used: Uint8Array) {
  const n = w * h;
  const blank = makePuzzle(w, h, new Array(n).fill(null));
  const deg = new Int32Array(n);
  let len = 0;
  for (let e = 0; e < blank.edgeCount; e++) {
    if (used[e] !== 1) continue;
    len++;
    deg[blank.ends[e * 2]]++;
    deg[blank.ends[e * 2 + 1]]++;
  }
  const off: number[] = [];
  for (let k = 0; k < n; k++) if (deg[k] === 0) off.push(k);
  return { blank, off, len };
}

const longestDir = (p: Puzzle, k: number): number => {
  let best = 0;
  let bl = -1;
  for (const d of [0, 1, 2, 3]) {
    const l = p.rays[k][d].along.length;
    if (l > bl) {
      bl = l;
      best = d;
    }
  }
  return best;
};

/** Every cell the loop misses, carrying colour + the longest arrow it can. */
function maxInfoBoard(w: number, h: number, used: Uint8Array): Puzzle {
  const { blank, off } = dissect(w, h, used);
  const clues: (Clue | null)[] = new Array(w * h).fill(null);
  for (const k of off) clues[k] = clueFor(blank, used, k, longestDir(blank, k));
  return makePuzzle(w, h, clues);
}

// ---------------------------------------------------------------------------
// A. The genre's ceiling, exactly: over EVERY cycle of a small grid, how many
//    have a max-information board with a single answer?
// ---------------------------------------------------------------------------
console.log('A. exhaustive census');
interface CensusRow {
  w: number;
  h: number;
  cycles: number;
  unique: number;
  rate: number;
  minLoopUnique: number | null;
  maxOffLoop: number;
}
const census: CensusRow[] = [];
for (const [w, h] of [
  [2, 2],
  [2, 3],
  [3, 3],
  [3, 4],
  [4, 4],
  [3, 5],
  [4, 5],
  [3, 6],
  [5, 5],
]) {
  let cycles = 0;
  let unique = 0;
  let minLoopUnique: number | null = null;
  let maxOffLoop = 0;
  enumerateCycles(w, h, (used) => {
    cycles++;
    const { off, len } = dissect(w, h, used);
    maxOffLoop = Math.max(maxOffLoop, off.length);
    const p = maxInfoBoard(w, h, used);
    const res = solve(p, { limit: 2, maxNodes: 500_000 });
    if (!res.aborted && res.count === 1) {
      unique++;
      if (minLoopUnique === null || len < minLoopUnique) minLoopUnique = len;
    }
  });
  census.push({ w, h, cycles, unique, rate: cycles ? unique / cycles : 0, minLoopUnique, maxOffLoop });
  console.log(`   ${w}x${h}: ${unique}/${cycles} max-info boards unique`);
}

// ---------------------------------------------------------------------------
// B. The point of the genre: does the number tell you the colour?
//    For each (cell, direction) of a grid, pool over every cycle that misses
//    that cell and measure the mutual information between the arrow's number
//    and the inside/outside bit.
// ---------------------------------------------------------------------------
console.log('B. arrow vs colour');
interface OrthRow {
  w: number;
  h: number;
  /** (cell, direction) pairs with at least 30 cycles behind them */
  pairs: number;
  samples: number;
  /** P(inside) pooled */
  insideRate: number;
  /** P(inside === (num is odd)) pooled — the naive "parity must be the colour" guess */
  parityAgreement: number;
  /** mean and max mutual information I(colour ; number), in bits */
  miMean: number;
  miMax: number;
  /** control: I(colour ; parity of the ACROSS ray), which is H(colour) by construction */
  controlMiMean: number;
  entropyMean: number;
}
const orth: OrthRow[] = [];
for (const [w, h] of [
  [4, 4],
  [5, 5],
]) {
  const n = w * h;
  const blank = makePuzzle(w, h, new Array(n).fill(null));
  // joint[(k*4+d)] : Map<num*2+inside, count>
  const joint: Map<number, number>[] = Array.from({ length: n * 4 }, () => new Map());
  const ctrl: Map<number, number>[] = Array.from({ length: n * 4 }, () => new Map());
  let samples = 0;
  let insideHits = 0;
  let parityHits = 0;
  enumerateCycles(w, h, (used) => {
    const edges = new Uint8Array(blank.edgeCount);
    for (let e = 0; e < blank.edgeCount; e++) edges[e] = used[e] === 1 ? E_USED : E_UNUSED;
    const { off } = dissect(w, h, used);
    for (const k of off) {
      const inside = insideOf(blank, edges, k) ? 1 : 0;
      for (let d = 0; d < 4; d++) {
        let num = 0;
        for (const e of blank.rays[k][d].along) if (edges[e] === E_USED) num++;
        let acr = 0;
        for (const e of blank.rays[k][d].across) if (edges[e] === E_USED) acr ^= 1;
        const key = k * 4 + d;
        joint[key].set(num * 2 + inside, (joint[key].get(num * 2 + inside) ?? 0) + 1);
        ctrl[key].set(acr * 2 + inside, (ctrl[key].get(acr * 2 + inside) ?? 0) + 1);
        samples++;
        insideHits += inside;
        if (inside === (num & 1)) parityHits++;
      }
    }
  });
  const mi = (m: Map<number, number>): { mi: number; h: number } => {
    let tot = 0;
    for (const v of m.values()) tot += v;
    const px = new Map<number, number>();
    const py = [0, 0];
    for (const [key, v] of m) {
      const x = key >> 1;
      const y = key & 1;
      px.set(x, (px.get(x) ?? 0) + v);
      py[y] += v;
    }
    let out2 = 0;
    for (const [key, v] of m) {
      const x = key >> 1;
      const y = key & 1;
      const pxy = v / tot;
      out2 += pxy * Math.log2(pxy / ((px.get(x) as number) / tot) / (py[y] / tot));
    }
    let hy = 0;
    for (const y of [0, 1]) if (py[y] > 0) hy -= (py[y] / tot) * Math.log2(py[y] / tot);
    return { mi: out2, h: hy };
  };
  const mis: number[] = [];
  const ctrls: number[] = [];
  const hs: number[] = [];
  let pairs = 0;
  for (let key = 0; key < n * 4; key++) {
    let tot = 0;
    for (const v of joint[key].values()) tot += v;
    if (tot < 30) continue;
    pairs++;
    const a = mi(joint[key]);
    const b = mi(ctrl[key]);
    mis.push(a.mi);
    hs.push(a.h);
    ctrls.push(b.mi);
  }
  orth.push({
    w,
    h,
    pairs,
    samples,
    insideRate: insideHits / samples,
    parityAgreement: parityHits / samples,
    miMean: mean(mis),
    miMax: Math.max(...mis),
    controlMiMean: mean(ctrls),
    entropyMean: mean(hs),
  });
  console.log(`   ${w}x${h}: ${pairs} (cell,dir) pairs, mean I(colour;number)=${mean(mis).toFixed(4)} bits`);
}

// ---------------------------------------------------------------------------
// C. The inside field, two ways: enumerate, then check with the DP's parity bit.
// ---------------------------------------------------------------------------
console.log('C. inside field');
const FIELD_W = 5;
const FIELD_H = 5;
const fieldN = FIELD_W * FIELD_H;
const fieldOff = new Int32Array(fieldN);
const fieldIn = new Int32Array(fieldN);
{
  const blank = makePuzzle(FIELD_W, FIELD_H, new Array(fieldN).fill(null));
  enumerateCycles(FIELD_W, FIELD_H, (used) => {
    const edges = new Uint8Array(blank.edgeCount);
    for (let e = 0; e < blank.edgeCount; e++) edges[e] = used[e] === 1 ? E_USED : E_UNUSED;
    const { off } = dissect(FIELD_W, FIELD_H, used);
    for (const k of off) {
      fieldOff[k]++;
      if (insideOf(blank, edges, k)) fieldIn[k]++;
    }
  });
}
let fieldAgrees = true;
for (let k = 0; k < fieldN; k++) {
  const blocked = new Uint8Array(fieldN);
  blocked[k] = 1;
  const colour = new Int8Array(fieldN).fill(-1);
  colour[k] = 1;
  const inCount = Number(countCycles(FIELD_W, FIELD_H, { blocked, colour }));
  const total = Number(countCycles(FIELD_W, FIELD_H, { blocked }));
  if (inCount !== fieldIn[k] || total !== fieldOff[k]) fieldAgrees = false;
}
console.log(`   5x5 inside field cross-checks: ${fieldAgrees}`);

// ---------------------------------------------------------------------------
// D. Ablation on the shipped boards: erase the colours, erase the numbers.
// ---------------------------------------------------------------------------
console.log('D. clue-half ablation');
interface AblRow {
  size: string;
  boards: number;
  clues: number;
  coloured: number;
  numbered: number;
  fullUnique: number;
  noColourUnique: number;
  noArrowUnique: number;
  wallsOnlyUnique: number;
  noColourMedian: number;
  noArrowMedian: number;
  wallsOnlyMedian: number;
}
const ablation: AblRow[] = [];
const sizes = [...new Set(BANK.boards.map((b) => `${b.w}x${b.h}`))];
const toPuzzle = (b: (typeof BANK.boards)[number]): Puzzle => {
  const clues: (Clue | null)[] = new Array(b.w * b.h).fill(null);
  for (const c of b.clues) clues[c.k] = { color: c.color, dir: c.dir, num: c.num };
  return makePuzzle(b.w, b.h, clues);
};
const answerOf = (b: (typeof BANK.boards)[number]): Uint8Array => {
  const a = new Uint8Array(b.answer.length);
  for (let e = 0; e < b.answer.length; e++) a[e] = b.answer[e] === '1' ? E_USED : E_UNUSED;
  return a;
};
const LIMIT = 500;
for (const size of sizes) {
  const bs = BANK.boards.filter((b) => `${b.w}x${b.h}` === size);
  const row: AblRow = {
    size,
    boards: bs.length,
    clues: 0,
    coloured: 0,
    numbered: 0,
    fullUnique: 0,
    noColourUnique: 0,
    noArrowUnique: 0,
    wallsOnlyUnique: 0,
    noColourMedian: 0,
    noArrowMedian: 0,
    wallsOnlyMedian: 0,
  };
  const nc: number[] = [];
  const na: number[] = [];
  const wo: number[] = [];
  for (const b of bs) {
    const p = toPuzzle(b);
    row.clues += b.clues.length;
    row.coloured += b.clues.filter((c) => c.color !== 0).length;
    row.numbered += b.clues.filter((c) => c.num >= 0).length;
    if (!isSolution(p, answerOf(b))) throw new Error(`shipped answer invalid: ${b.id}`);
    const f = solve(p, { limit: 2, maxNodes: 2_000_000 });
    if (f.count === 1 && !f.aborted) row.fullUnique++;
    const c1 = solve(withoutColours(p), { limit: LIMIT, maxNodes: 2_000_000 });
    const c2 = solve(withoutArrows(p), { limit: LIMIT, maxNodes: 2_000_000 });
    const c3 = solve(wallsOnly(p), { limit: LIMIT, maxNodes: 2_000_000 });
    if (c1.count === 1) row.noColourUnique++;
    if (c2.count === 1) row.noArrowUnique++;
    if (c3.count === 1) row.wallsOnlyUnique++;
    nc.push(c1.count);
    na.push(c2.count);
    wo.push(c3.count);
  }
  row.noColourMedian = median(nc);
  row.noArrowMedian = median(na);
  row.wallsOnlyMedian = median(wo);
  ablation.push(row);
  console.log(`   ${size}: colours erased ${row.noColourUnique}/${bs.length} still unique, numbers erased ${row.noArrowUnique}/${bs.length}`);
}

// ---------------------------------------------------------------------------
// E. The ladder: what each rung settles, and what the search costs without it.
// ---------------------------------------------------------------------------
console.log('E. ladder');
interface RungRow {
  size: string;
  /** rung -> median share of the answer's edges settled by propagation alone */
  share: Record<string, number>;
  /** rung -> median search nodes at that level */
  nodes: Record<string, number>;
  /** rung removed -> median share at full strength without it */
  without: Record<string, number>;
  /** rung removed -> median search nodes without it */
  withoutNodes: Record<string, number>;
  /** boards propagation alone finishes, at full strength */
  solvedByProbe: number;
  boards: number;
  /** searches that ran out of node budget, by rung */
  aborted: Record<string, number>;
}
// Probing is expensive per node — one probe pass is two propagations for every
// undecided gap — so a search that probes gets a small budget and a search that
// does not gets a large one. Budgets that bite are reported, not hidden.
const BUDGET: Record<RuleSet, number> = {
  degree: 120_000,
  arrow: 120_000,
  parity: 120_000,
  loop: 120_000,
  probe: 1_000,
};
/** The leave-one-out searches are the expensive ones; they get their own cap. */
const ABLATION_BUDGET = 20_000;
/** and only on the sizes where the answer is informative rather than a timeout */
const ABLATION_SIZES = new Set(['6x6', '8x8']);
const ladder: RungRow[] = [];
for (const size of sizes) {
  const bs = BANK.boards.filter((b) => `${b.w}x${b.h}` === size);
  const share: Record<string, number[]> = {};
  const nodes: Record<string, number[]> = {};
  const without: Record<string, number[]> = {};
  const withoutNodes: Record<string, number[]> = {};
  const aborted: Record<string, number> = {};
  let solvedByProbe = 0;
  for (const b of bs) {
    const p = toPuzzle(b);
    const ans = answerOf(b);
    for (const r of RULE_SETS) {
      const s = propagateShare(p, ans, RULE_LEVEL[r]);
      if (!s.ok) throw new Error(`rung ${r} contradicted the answer on ${b.id}`);
      (share[r] ??= []).push(s.settled / s.total);
      const res = solve(p, { limit: 2, level: RULE_LEVEL[r], maxNodes: BUDGET[r] });
      (nodes[r] ??= []).push(res.nodes);
      if (res.aborted) aborted[r] = (aborted[r] ?? 0) + 1;
    }
    const full = propagateShare(p, ans, RULE_LEVEL.probe);
    if (full.settled === full.total) solvedByProbe++;
    for (const r of ['arrow', 'parity', 'loop'] as RuleSet[]) {
      const off = new Set<RuleSet>([r]);
      const s = propagateShare(p, ans, RULE_LEVEL.probe, off);
      (without[r] ??= []).push(s.ok ? s.settled / s.total : 0);
      if (!ABLATION_SIZES.has(size)) continue;
      const res = solve(p, { limit: 2, level: RULE_LEVEL.loop, maxNodes: ABLATION_BUDGET, off });
      (withoutNodes[r] ??= []).push(res.nodes);
      if (res.aborted) aborted[`-${r}`] = (aborted[`-${r}`] ?? 0) + 1;
    }
  }
  const med = (m: Record<string, number[]>): Record<string, number> =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, median(v)]));
  ladder.push({
    size,
    share: med(share),
    nodes: med(nodes),
    without: med(without),
    withoutNodes: med(withoutNodes),
    solvedByProbe,
    boards: bs.length,
    aborted,
  });
  console.log(`   ${size}: probe settles ${(median(share.probe) * 100).toFixed(1)}% of the edges`);
}

// ---------------------------------------------------------------------------
// F. The dial: the chain the boards ship with, against the full fork.
// ---------------------------------------------------------------------------
console.log('F. dial');
interface DialRow {
  size: string;
  seeds: number;
  chainClues: number;
  forkClues: number;
  chainLevels: Record<string, number>;
  forkLevels: Record<string, number>;
}
const dialRows: DialRow[] = [];
for (const [w, h] of [
  [6, 6],
  [8, 8],
]) {
  const sampler = makeSampler(w, h, { tilt: { skip: 3n, take: 2n } });
  const chain = [LV_NONE, LV_WALL, LV_COLOUR];
  const fork = [LV_NONE, LV_WALL, LV_COLOUR, LV_ARROW];
  const chainLevels: Record<string, number> = {};
  const forkLevels: Record<string, number> = {};
  let chainClues = 0;
  let forkClues = 0;
  let seeds = 0;
  for (let s = 0; s < 24; s++) {
    const a = generate(mulberry32(1000 + s), { w, h, sampler, dial: chain });
    const b = generate(mulberry32(1000 + s), { w, h, sampler, dial: fork });
    if (!a || !b) continue;
    seeds++;
    for (let k = 0; k < w * h; k++) {
      if (a.levels[k] !== LV_NONE) {
        chainClues++;
        chainLevels[LEVEL_NAMES[a.levels[k]]] = (chainLevels[LEVEL_NAMES[a.levels[k]]] ?? 0) + 1;
      }
      if (b.levels[k] !== LV_NONE) {
        forkClues++;
        forkLevels[LEVEL_NAMES[b.levels[k]]] = (forkLevels[LEVEL_NAMES[b.levels[k]]] ?? 0) + 1;
      }
    }
  }
  dialRows.push({
    size: `${w}x${h}`,
    seeds,
    chainClues: chainClues / Math.max(1, seeds),
    forkClues: forkClues / Math.max(1, seeds),
    chainLevels,
    forkLevels,
  });
  console.log(`   ${w}x${h}: chain ${(chainClues / Math.max(1, seeds)).toFixed(1)} clues, fork ${(forkClues / Math.max(1, seeds)).toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// G. Loop length, three ways: exact, as the tilted sampler draws it, and as
//    the shipped boards ended up.
// ---------------------------------------------------------------------------
console.log('G. loop length');
interface LenRow {
  size: string;
  shippedMean: number;
  shippedCoverage: number;
  samplerMean: number;
  samplerCoverage: number;
  shippedClues: number;
}
const lenRows: LenRow[] = [];
for (const size of sizes) {
  const bs = BANK.boards.filter((b) => `${b.w}x${b.h}` === size);
  const w = bs[0].w;
  const h = bs[0].h;
  const sampler = makeSampler(w, h, { tilt: { skip: 3n, take: 2n } });
  const rnd = mulberry32(55);
  const lens: number[] = [];
  const blank = makePuzzle(w, h, new Array(w * h).fill(null));
  for (let i = 0; i < 300; i++) {
    const a = sampler(rnd);
    let L = 0;
    for (let e = 0; e < blank.edgeCount; e++) if (a[e] === 1) L++;
    lens.push(L);
  }
  lenRows.push({
    size,
    shippedMean: mean(bs.map((b) => b.loopLength)),
    shippedCoverage: mean(bs.map((b) => b.loopLength)) / (w * h),
    samplerMean: mean(lens),
    samplerCoverage: mean(lens) / (w * h),
    shippedClues: mean(bs.map((b) => b.clues.length)),
  });
}

const payload = {
  generatedAt: new Date().toISOString().slice(0, 10),
  census,
  orth,
  field: {
    w: FIELD_W,
    h: FIELD_H,
    off: Array.from(fieldOff),
    inside: Array.from(fieldIn),
    agrees: fieldAgrees,
  },
  ablation,
  ladder,
  dial: dialRows,
  lengths: lenRows,
  bankLevels: BANK.levelTally,
  colourSplit: (() => {
    let white = 0;
    let black = 0;
    let grey = 0;
    for (const b of BANK.boards) {
      for (const c of b.clues) {
        if (c.color === WHITE) white++;
        else if (c.color === 0) grey++;
        else black++;
      }
    }
    return { white, black, grey };
  })(),
};
writeFileSync(out, JSON.stringify(payload, null, 2) + '\n');
console.log(`wrote ${out}`);
