// Board generation. Writes src/puzzles.json.
//
// One sampler per grid size, reused for every board of that size: building it
// is a full pass of the plug DP and costs about a second at 10x10.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generate } from '../src/generate';
import { makeSampler } from '../src/count';
import { mulberry32 } from '../src/rng';
import { LV_NONE, LV_WALL, LV_COLOUR, LEVEL_NAMES, makePuzzle, solve } from '../src/castlewall';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'puzzles.json');

const TILT = { skip: 3n, take: 2n };
// Shipped boards use the chain, not the fork: a clue that keeps its number
// keeps its colour too, the way the genre prints one.
const DIAL = [LV_NONE, LV_WALL, LV_COLOUR];

const PLAN: [number, number, number][] = [
  [6, 6, 24],
  [8, 8, 24],
  [10, 10, 16],
];

interface ShippedClue {
  k: number;
  color: number;
  dir: number;
  num: number;
}

interface Shipped {
  id: string;
  w: number;
  h: number;
  clues: ShippedClue[];
  /** '1' where the answer uses the edge */
  answer: string;
  loopLength: number;
  loopsTried: number;
}

const boards: Shipped[] = [];
const levelTally: Record<string, number> = {};
let rejected = 0;

for (const [w, h, count] of PLAN) {
  const t0 = Date.now();
  const sampler = makeSampler(w, h, { tilt: TILT });
  const build = Date.now() - t0;
  const rnd = mulberry32(0x5e4 + w * 131 + h);
  let made = 0;
  let guard = 0;
  while (made < count && guard < count * 12) {
    guard++;
    const g = generate(rnd, { w, h, sampler, dial: DIAL, maxNodes: 600_000 });
    if (!g) {
      rejected++;
      continue;
    }
    const clues: ShippedClue[] = [];
    for (let k = 0; k < w * h; k++) {
      const c = g.clues[k];
      if (c) clues.push({ k, color: c.color, dir: c.dir, num: c.num });
      levelTally[LEVEL_NAMES[g.levels[k]]] = (levelTally[LEVEL_NAMES[g.levels[k]]] ?? 0) + 1;
    }
    // Paranoia: re-solve the shipped form from scratch and insist on one answer.
    const p = makePuzzle(
      w,
      h,
      Array.from({ length: w * h }, (_, k) => g.clues[k] ?? null),
    );
    const res = solve(p, { limit: 2, maxNodes: 2_000_000 });
    if (res.aborted || res.count !== 1) {
      console.log(`  ${w}x${h} board failed re-check (count=${res.count}) — dropped`);
      rejected++;
      continue;
    }
    boards.push({
      id: `${w}x${h}-${made + 1}`,
      w,
      h,
      clues,
      answer: Array.from(g.answer, (v) => (v === 1 ? '1' : '0')).join(''),
      loopLength: g.loopLength,
      loopsTried: g.loopsTried,
    });
    made++;
  }
  console.log(
    `  ${w}x${h}: ${made} boards in ${((Date.now() - t0) / 1000).toFixed(1)}s (sampler ${build}ms)`,
  );
}

const payload = {
  generatedAt: new Date().toISOString().slice(0, 10),
  tilt: { skip: Number(TILT.skip), take: Number(TILT.take) },
  dial: DIAL.map((l) => LEVEL_NAMES[l]),
  rejected,
  levelTally,
  boards,
};
writeFileSync(out, JSON.stringify(payload) + '\n');
console.log(`wrote ${out} — ${boards.length} boards`);
