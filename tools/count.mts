// Exact counts. Writes src/counts.json.
//
// Everything the README and the article say about how many loops a grid has
// comes from this file, and nothing here is typed in by hand.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { countCycles, countCyclesByLength, profileStates, enumerateCycles } from '../src/count';
import { edgeCountOf } from '../src/castlewall';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'counts.json');

// OEIS A140517, "number of cycles in an n X n grid" — n counts *cells* of the
// drawing grid, so a(k) is the count for a (k+1)-by-(k+1) board of vertices.
const A140517 = [
  '0',
  '1',
  '13',
  '213',
  '9349',
  '1222363',
  '487150371',
  '603841648931',
  '2318527339461265',
  '27359264067916806101',
  '988808811046283595068099',
];

interface SquareRow {
  n: number;
  cycles: string;
  oeis: string | null;
  matchesOeis: boolean | null;
  states: number;
  ms: number;
}

const squares: SquareRow[] = [];
for (let n = 2; n <= 11; n++) {
  const t0 = Date.now();
  const c = countCycles(n, n);
  const ms = Date.now() - t0;
  const oeis = A140517[n - 1] ?? null;
  squares.push({
    n,
    cycles: c.toString(),
    oeis,
    matchesOeis: oeis === null ? null : oeis === c.toString(),
    states: profileStates(n, n),
    ms,
  });
  console.log(`  ${n}x${n}: ${c} (${ms}ms)`);
}

// Rectangles. No OEIS entry to lean on, so the small ones are checked against
// an independent depth-first enumeration instead.
interface RectRow {
  w: number;
  h: number;
  cycles: string;
  dfs: number | null;
  agrees: boolean | null;
}
const rects: RectRow[] = [];
for (let h = 2; h <= 7; h++) {
  for (let w = h; w <= 8; w++) {
    const c = countCycles(w, h);
    let dfs: number | null = null;
    if (Number(c) <= 3_000_000) {
      dfs = 0;
      enumerateCycles(w, h, () => {
        dfs = (dfs as number) + 1;
      });
    }
    rects.push({
      w,
      h,
      cycles: c.toString(),
      dfs,
      agrees: dfs === null ? null : dfs === Number(c),
    });
  }
}
console.log(`  ${rects.length} rectangles, ${rects.filter((r) => r.agrees).length} cross-checked`);

// The length density: how long is a loop, if you pick one at random?
interface LengthRow {
  w: number;
  h: number;
  total: string;
  mean: number;
  /** mean length as a fraction of the cell count */
  coverage: number;
  mode: number;
  /** the whole histogram, [length, count] for non-zero lengths */
  hist: [number, string][];
}
const lengths: LengthRow[] = [];
for (const [w, h] of [
  [4, 4],
  [5, 5],
  [6, 6],
  [7, 7],
  [8, 8],
]) {
  const byL = countCyclesByLength(w, h);
  const total = byL.reduce((a, b) => a + b, 0n);
  let mean = 0;
  let mode = 0;
  let modeVal = 0n;
  const hist: [number, string][] = [];
  for (let L = 0; L < byL.length; L++) {
    if (byL[L] === 0n) continue;
    hist.push([L, byL[L].toString()]);
    mean += L * Number(byL[L]);
    if (byL[L] > modeVal) {
      modeVal = byL[L];
      mode = L;
    }
  }
  mean /= Number(total);
  lengths.push({ w, h, total: total.toString(), mean, coverage: mean / (w * h), mode, hist });
  console.log(`  ${w}x${h} mean loop length ${mean.toFixed(2)} of ${w * h} cells`);
}

// What the tilt does to that density, exactly: the tilted mean length.
interface TiltRow {
  w: number;
  h: number;
  skip: number;
  take: number;
  mean: number;
  coverage: number;
}
const tilts: TiltRow[] = [];
for (const [w, h] of [
  [6, 6],
  [8, 8],
]) {
  for (const [a, b] of [
    [1, 1],
    [9, 8],
    [5, 4],
    [4, 3],
    [3, 2],
    [2, 1],
  ]) {
    const ec = edgeCountOf(w, h);
    const byL = countCyclesByLength(w, h);
    let num = 0;
    let den = 0;
    for (let L = 0; L < byL.length; L++) {
      if (byL[L] === 0n) continue;
      // weight skip^(E-L) * take^L, in floating point: only the ratio matters,
      // and the exact counts are already in `lengths`.
      const logw = (ec - L) * Math.log(a) + L * Math.log(b);
      const wgt = Math.exp(logw - ec * Math.log(a)) * Number(byL[L]);
      num += L * wgt;
      den += wgt;
    }
    tilts.push({ w, h, skip: a, take: b, mean: num / den, coverage: num / den / (w * h) });
  }
}

const payload = {
  generatedAt: new Date().toISOString().slice(0, 10),
  squares,
  rects,
  lengths,
  tilts,
};
writeFileSync(out, JSON.stringify(payload, null, 2) + '\n');
console.log(`wrote ${out}`);
