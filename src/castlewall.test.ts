import { describe, it, expect } from 'vitest';
import {
  Clue,
  E_USED,
  E_UNUSED,
  E_UNKNOWN,
  GREY,
  WHITE,
  BLACK,
  N,
  E,
  S,
  W,
  NO_DIR,
  NO_NUM,
  RULE_SETS,
  RULE_LEVEL,
  LV_NONE,
  LV_WALL,
  LV_COLOUR,
  LV_ARROW,
  LV_FULL,
  edgeCountOf,
  hEdge,
  vEdge,
  makePuzzle,
  makeBoard,
  insideOf,
  validate,
  isSolution,
  propagate,
  propagateShare,
  solve,
} from './castlewall';
import { countCycles, countCyclesByLength, enumerateCycles, makeSampler } from './count';
import { generate, clueFor, atLevel, withoutColours, withoutArrows, wallsOnly } from './generate';
import { mulberry32 } from './rng';
import bank from './puzzles.json';

const BANK = bank as unknown as {
  boards: { id: string; w: number; h: number; clues: { k: number; color: number; dir: number; num: number }[]; answer: string; loopLength: number }[];
};

const blankOf = (w: number, h: number) => makePuzzle(w, h, new Array(w * h).fill(null));
const asEdges = (w: number, h: number, used: Uint8Array): Uint8Array => {
  const out = new Uint8Array(edgeCountOf(w, h));
  for (let e = 0; e < out.length; e++) out[e] = used[e] === 1 ? E_USED : E_UNUSED;
  return out;
};
const cycles = (w: number, h: number): Uint8Array[] => {
  const out: Uint8Array[] = [];
  enumerateCycles(w, h, (u) => out.push(u.slice()));
  return out;
};
const bankPuzzle = (b: (typeof BANK.boards)[number]) => {
  const clues: (Clue | null)[] = new Array(b.w * b.h).fill(null);
  for (const c of b.clues) clues[c.k] = { color: c.color, dir: c.dir, num: c.num };
  return makePuzzle(b.w, b.h, clues);
};
const bankAnswer = (b: (typeof BANK.boards)[number]): Uint8Array => {
  const a = new Uint8Array(b.answer.length);
  for (let e = 0; e < b.answer.length; e++) a[e] = b.answer[e] === '1' ? E_USED : E_UNUSED;
  return a;
};

// The border loop of a 3x3 grid: the eight outer cells, centre left empty.
function ring3(): Uint8Array {
  const w = 3;
  const h = 3;
  const a = new Uint8Array(edgeCountOf(w, h));
  a[hEdge(0, 0, w)] = E_USED;
  a[hEdge(0, 1, w)] = E_USED;
  a[hEdge(2, 0, w)] = E_USED;
  a[hEdge(2, 1, w)] = E_USED;
  a[vEdge(0, 0, w, h)] = E_USED;
  a[vEdge(1, 0, w, h)] = E_USED;
  a[vEdge(0, 2, w, h)] = E_USED;
  a[vEdge(1, 2, w, h)] = E_USED;
  for (let e = 0; e < a.length; e++) if (a[e] !== E_USED) a[e] = E_UNUSED;
  return a;
}

describe('geometry', () => {
  it('counts edges', () => {
    expect(edgeCountOf(3, 3)).toBe(12);
    expect(edgeCountOf(4, 5)).toBe(31);
  });

  it('gives every edge two distinct ends', () => {
    const p = blankOf(5, 4);
    for (let e = 0; e < p.edgeCount; e++) {
      const a = p.ends[e * 2];
      const b = p.ends[e * 2 + 1];
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(a).not.toBe(b);
    }
  });

  it('keeps the incidence table and the end table in step', () => {
    const p = blankOf(5, 4);
    for (let k = 0; k < 20; k++) {
      for (let d = 0; d < 4; d++) {
        const e = p.inc[k * 4 + d];
        if (e < 0) continue;
        expect([p.ends[e * 2], p.ends[e * 2 + 1]]).toContain(k);
      }
    }
  });
});

describe('the two halves of a clue', () => {
  it('never share an edge', () => {
    const p = blankOf(6, 5);
    for (let k = 0; k < 30; k++) {
      for (const d of [N, E, S, W]) {
        const { along, across } = p.rays[k][d];
        for (const e of along) expect(across).not.toContain(e);
      }
    }
  });

  it('puts the arrow on horizontal edges east and west, vertical north and south', () => {
    const p = blankOf(5, 5);
    const k = 2 * 5 + 2;
    for (const e of p.rays[k][E].along) expect(e).toBeLessThan(5 * 4);
    for (const e of p.rays[k][W].along) expect(e).toBeLessThan(5 * 4);
    for (const e of p.rays[k][N].along) expect(e).toBeGreaterThanOrEqual(5 * 4);
    for (const e of p.rays[k][S].along) expect(e).toBeGreaterThanOrEqual(5 * 4);
  });

  it('splits each row and column exactly in two', () => {
    const p = blankOf(6, 6);
    for (let k = 0; k < 36; k++) {
      expect(p.rays[k][E].along.length + p.rays[k][W].along.length).toBe(5);
      expect(p.rays[k][N].along.length + p.rays[k][S].along.length).toBe(5);
    }
  });
});

describe('inside and outside', () => {
  it('sees the centre of a 3x3 ring as inside', () => {
    const p = makePuzzle(3, 3, [
      null,
      null,
      null,
      null,
      { color: WHITE, dir: NO_DIR, num: NO_NUM },
      null,
      null,
      null,
      null,
    ]);
    expect(insideOf(p, ring3(), 4)).toBe(true);
  });

  it('agrees on all four rays, for every cycle of a 4x4 grid', () => {
    const w = 4;
    const h = 4;
    const p = blankOf(w, h);
    let checked = 0;
    for (const u of cycles(w, h)) {
      const edges = asEdges(w, h, u);
      const deg = new Int32Array(w * h);
      for (let e = 0; e < p.edgeCount; e++) {
        if (edges[e] !== E_USED) continue;
        deg[p.ends[e * 2]]++;
        deg[p.ends[e * 2 + 1]]++;
      }
      for (let k = 0; k < w * h; k++) {
        if (deg[k] !== 0) continue;
        const pars = [N, E, S, W].map((d) => {
          let par = 0;
          for (const e of p.rays[k][d].across) if (edges[e] === E_USED) par ^= 1;
          return par;
        });
        expect(new Set(pars).size).toBe(1);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('finds every bottom-row and top-row cell outside', () => {
    const w = 5;
    const h = 5;
    const p = blankOf(w, h);
    for (const u of cycles(w, h).slice(0, 400)) {
      const edges = asEdges(w, h, u);
      for (const k of [0, 1, w - 1, (h - 1) * w, h * w - 1]) {
        let deg = 0;
        for (let d = 0; d < 4; d++) {
          const e = p.inc[k * 4 + d];
          if (e >= 0 && edges[e] === E_USED) deg++;
        }
        if (deg === 0) expect(insideOf(p, edges, k)).toBe(false);
      }
    }
  });
});

describe('the even-crossing law', () => {
  it('holds on every row gap and column gap of every 4x4 cycle', () => {
    const w = 4;
    const h = 4;
    const p = blankOf(w, h);
    for (const u of cycles(w, h)) {
      const edges = asEdges(w, h, u);
      for (const g of p.gaps) {
        let par = 0;
        for (const e of g) if (edges[e] === E_USED) par ^= 1;
        expect(par).toBe(0);
      }
    }
  });
});

describe('the validator', () => {
  const ringPuzzle = (clue: Clue) =>
    makePuzzle(3, 3, [null, null, null, null, clue, null, null, null, null]);

  it('accepts the ring with a white centre', () => {
    expect(isSolution(ringPuzzle({ color: WHITE, dir: NO_DIR, num: NO_NUM }), ring3())).toBe(true);
  });

  it('rejects the ring with a black centre', () => {
    const bad = validate(ringPuzzle({ color: BLACK, dir: NO_DIR, num: NO_NUM }), ring3());
    expect(bad.map((b) => b.kind)).toContain('colour');
  });

  it('reads the arrow as segments along the ray', () => {
    // From the centre, east: the horizontal edge of row 1 to the right is unused
    // (both its ends are the blocked centre and a loop cell of degree two).
    expect(isSolution(ringPuzzle({ color: WHITE, dir: E, num: 0 }), ring3())).toBe(true);
    expect(isSolution(ringPuzzle({ color: WHITE, dir: E, num: 1 }), ring3())).toBe(false);
    // North: both vertical edges of column 1 above the centre are unused too.
    expect(isSolution(ringPuzzle({ color: WHITE, dir: N, num: 0 }), ring3())).toBe(true);
  });

  it('rejects an empty board', () => {
    const p = ringPuzzle({ color: GREY, dir: NO_DIR, num: NO_NUM });
    const none = new Uint8Array(p.edgeCount).fill(E_UNUSED);
    expect(validate(p, none).map((b) => b.kind)).toContain('noLoop');
  });

  it('rejects a loop through a wall', () => {
    const p = makePuzzle(3, 3, [
      { color: GREY, dir: NO_DIR, num: NO_NUM },
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(validate(p, ring3()).map((b) => b.kind)).toContain('clueCellUsed');
  });

  it('rejects two separate loops', () => {
    const w = 5;
    const h = 2;
    const p = blankOf(w, h);
    const a = new Uint8Array(p.edgeCount).fill(E_UNUSED);
    // two 1x2 squares, side by side but not joined
    a[hEdge(0, 0, w)] = E_USED;
    a[hEdge(1, 0, w)] = E_USED;
    a[vEdge(0, 0, w, h)] = E_USED;
    a[vEdge(0, 1, w, h)] = E_USED;
    a[hEdge(0, 3, w)] = E_USED;
    a[hEdge(1, 3, w)] = E_USED;
    a[vEdge(0, 3, w, h)] = E_USED;
    a[vEdge(0, 4, w, h)] = E_USED;
    expect(validate(p, a).map((b) => b.kind)).toContain('manyLoops');
  });
});

describe('the plug DP', () => {
  it('reproduces OEIS A140517', () => {
    expect(countCycles(2, 2)).toBe(1n);
    expect(countCycles(3, 3)).toBe(13n);
    expect(countCycles(4, 4)).toBe(213n);
    expect(countCycles(5, 5)).toBe(9349n);
    expect(countCycles(6, 6)).toBe(1222363n);
  });

  it('agrees with an independent depth-first enumeration', () => {
    for (const [w, h] of [
      [2, 3],
      [3, 4],
      [4, 5],
      [2, 7],
      [3, 6],
    ]) {
      let seen = 0;
      enumerateCycles(w, h, () => {
        seen++;
      });
      expect(BigInt(seen)).toBe(countCycles(w, h));
    }
  });

  it('honours blocked cells', () => {
    const w = 4;
    const h = 4;
    const blocked = new Uint8Array(w * h);
    blocked[5] = 1;
    blocked[10] = 1;
    const p = blankOf(w, h);
    let seen = 0;
    enumerateCycles(w, h, (u) => {
      const edges = asEdges(w, h, u);
      let touches = false;
      for (const k of [5, 10]) {
        for (let d = 0; d < 4; d++) {
          const e = p.inc[k * 4 + d];
          if (e >= 0 && edges[e] === E_USED) touches = true;
        }
      }
      if (!touches) seen++;
    });
    expect(BigInt(seen)).toBe(countCycles(w, h, { blocked }));
  });

  it('honours the inside/outside bit', () => {
    const w = 4;
    const h = 4;
    const p = blankOf(w, h);
    for (const k of [5, 6, 9]) {
      const blocked = new Uint8Array(w * h);
      blocked[k] = 1;
      let inside = 0;
      let outside = 0;
      enumerateCycles(w, h, (u) => {
        const edges = asEdges(w, h, u);
        let touches = false;
        for (let d = 0; d < 4; d++) {
          const e = p.inc[k * 4 + d];
          if (e >= 0 && edges[e] === E_USED) touches = true;
        }
        if (touches) return;
        if (insideOf(p, edges, k)) inside++;
        else outside++;
      });
      const colIn = new Int8Array(w * h).fill(-1);
      colIn[k] = 1;
      const colOut = new Int8Array(w * h).fill(-1);
      colOut[k] = 0;
      expect(countCycles(w, h, { blocked, colour: colIn })).toBe(BigInt(inside));
      expect(countCycles(w, h, { blocked, colour: colOut })).toBe(BigInt(outside));
    }
  });

  it('splits the cycles by length without losing any', () => {
    for (const [w, h] of [
      [3, 4],
      [4, 4],
      [5, 5],
    ]) {
      const byL = countCyclesByLength(w, h);
      expect(byL.reduce((a, b) => a + b, 0n)).toBe(countCycles(w, h));
      // the shortest cycle in a grid is a unit square
      expect(byL[4]).toBe(BigInt((w - 1) * (h - 1)));
    }
  });

  it('tilts exactly', () => {
    const w = 4;
    const h = 4;
    const ec = edgeCountOf(w, h);
    const byL = countCyclesByLength(w, h);
    const skip = 3n;
    const take = 2n;
    let want = 0n;
    for (let L = 0; L < byL.length; L++) {
      if (byL[L] === 0n) continue;
      want += byL[L] * skip ** BigInt(ec - L) * take ** BigInt(L);
    }
    expect(countCycles(w, h, { tilt: { skip, take } })).toBe(want);
  });
});

describe('the sampler', () => {
  it('draws legal cycles', () => {
    const w = 6;
    const h = 5;
    const s = makeSampler(w, h);
    const rnd = mulberry32(4);
    const p = blankOf(w, h);
    for (let i = 0; i < 40; i++) {
      const edges = asEdges(w, h, s(rnd));
      expect(validate(p, edges)).toEqual([]);
    }
  });

  it('respects blocked cells', () => {
    const w = 5;
    const h = 5;
    const blocked = new Uint8Array(w * h);
    blocked[12] = 1;
    const s = makeSampler(w, h, { blocked });
    const rnd = mulberry32(9);
    const p = blankOf(w, h);
    for (let i = 0; i < 30; i++) {
      const edges = asEdges(w, h, s(rnd));
      for (let d = 0; d < 4; d++) {
        const e = p.inc[12 * 4 + d];
        if (e >= 0) expect(edges[e]).toBe(E_UNUSED);
      }
    }
  });

  it('shortens the loops when tilted', () => {
    const w = 8;
    const h = 8;
    const p = blankOf(w, h);
    const len = (s: (r: () => number) => Uint8Array, seed: number): number => {
      const rnd = mulberry32(seed);
      let total = 0;
      for (let i = 0; i < 25; i++) {
        const a = s(rnd);
        for (let e = 0; e < p.edgeCount; e++) if (a[e] === 1) total++;
      }
      return total / 25;
    };
    const flat = len(makeSampler(w, h), 11);
    const tilted = len(makeSampler(w, h, { tilt: { skip: 3n, take: 2n } }), 11);
    expect(tilted).toBeLessThan(flat);
  });
});

describe('the solver', () => {
  it('counts what brute force counts, on max-information boards', () => {
    const w = 5;
    const h = 5;
    const p0 = blankOf(w, h);
    const all = cycles(w, h);
    const rnd = mulberry32(31);
    for (let i = 0; i < 25; i++) {
      const u = all[Math.floor(rnd() * all.length)];
      const edges = asEdges(w, h, u);
      const deg = new Int32Array(w * h);
      for (let e = 0; e < p0.edgeCount; e++) {
        if (edges[e] !== E_USED) continue;
        deg[p0.ends[e * 2]]++;
        deg[p0.ends[e * 2 + 1]]++;
      }
      const clues: (Clue | null)[] = new Array(w * h).fill(null);
      for (let k = 0; k < w * h; k++) {
        if (deg[k] !== 0) continue;
        let best = N;
        let bl = -1;
        for (const d of [N, E, S, W]) {
          if (p0.rays[k][d].along.length > bl) {
            bl = p0.rays[k][d].along.length;
            best = d;
          }
        }
        clues[k] = clueFor(p0, u, k, best);
      }
      const p = makePuzzle(w, h, clues);
      let brute = 0;
      for (const v of all) if (isSolution(p, asEdges(w, h, v))) brute++;
      const res = solve(p, { limit: 200, maxNodes: 2_000_000 });
      expect(res.aborted).toBe(false);
      expect(res.count).toBe(brute);
    }
  });

  it('never contradicts the answer, at any rung, on every shipped board', () => {
    for (const b of BANK.boards) {
      const p = bankPuzzle(b);
      const ans = bankAnswer(b);
      for (const r of RULE_SETS) {
        const s = propagateShare(p, ans, RULE_LEVEL[r]);
        expect(s.ok).toBe(true);
      }
    }
  });

  it('settles at least as much the higher up the ladder you go', () => {
    for (const b of BANK.boards.slice(0, 20)) {
      const p = bankPuzzle(b);
      const ans = bankAnswer(b);
      let last = -1;
      for (const r of RULE_SETS) {
        const s = propagateShare(p, ans, RULE_LEVEL[r]);
        expect(s.settled).toBeGreaterThanOrEqual(last);
        last = s.settled;
      }
    }
  });

  it('finds the shipped answer, and only it', () => {
    for (const b of BANK.boards) {
      const p = bankPuzzle(b);
      const res = solve(p, { limit: 2, maxNodes: 2_000_000 });
      expect(res.aborted).toBe(false);
      expect(res.count).toBe(1);
      expect(Array.from(res.solutions[0])).toEqual(Array.from(bankAnswer(b)));
    }
  });

  it('gives the same count however strong the propagation is', () => {
    const rnd = mulberry32(77);
    for (const b of BANK.boards.slice(0, 6)) {
      const p = withoutArrows(bankPuzzle(b));
      const counts = RULE_SETS.map(
        (r) => solve(p, { limit: 12, level: RULE_LEVEL[r], maxNodes: 2_000_000 }).count,
      );
      expect(new Set(counts).size).toBe(1);
      rnd();
    }
  });
});

describe('the clue dial', () => {
  const full: Clue = { color: WHITE, dir: E, num: 3 };

  it('drops the right half at each level', () => {
    expect(atLevel(full, LV_NONE)).toBeNull();
    expect(atLevel(full, LV_WALL)).toEqual({ color: GREY, dir: NO_DIR, num: NO_NUM });
    expect(atLevel(full, LV_COLOUR)).toEqual({ color: WHITE, dir: NO_DIR, num: NO_NUM });
    expect(atLevel(full, LV_ARROW)).toEqual({ color: GREY, dir: E, num: 3 });
    expect(atLevel(full, LV_FULL)).toEqual(full);
  });

  it('only ever admits more answers when a clue is weakened', () => {
    for (const b of BANK.boards.slice(0, 10)) {
      const p = bankPuzzle(b);
      const base = solve(p, { limit: 60, maxNodes: 2_000_000 }).count;
      for (const weaker of [withoutColours(p), withoutArrows(p), wallsOnly(p)]) {
        expect(solve(weaker, { limit: 60, maxNodes: 2_000_000 }).count).toBeGreaterThanOrEqual(base);
      }
    }
  });

  it('keeps the answer legal under every weakening', () => {
    for (const b of BANK.boards.slice(0, 12)) {
      const p = bankPuzzle(b);
      const ans = bankAnswer(b);
      for (const weaker of [withoutColours(p), withoutArrows(p), wallsOnly(p)]) {
        expect(isSolution(weaker, ans)).toBe(true);
      }
    }
  });
});

describe('the generator', () => {
  it('produces boards with exactly one answer', () => {
    const rnd = mulberry32(2024);
    for (let i = 0; i < 4; i++) {
      const g = generate(rnd, { w: 6, h: 6, tilt: { skip: 3n, take: 2n } });
      expect(g).not.toBeNull();
      const p = makePuzzle(6, 6, (g as NonNullable<typeof g>).clues);
      const res = solve(p, { limit: 2, maxNodes: 1_000_000 });
      expect(res.count).toBe(1);
    }
  });

  it('never puts a wall on the loop, and always tells the truth', () => {
    const rnd = mulberry32(5150);
    for (let i = 0; i < 4; i++) {
      const g = generate(rnd, { w: 6, h: 6, tilt: { skip: 3n, take: 2n } });
      const gg = g as NonNullable<typeof g>;
      const p = makePuzzle(6, 6, gg.clues);
      const edges = asEdges(6, 6, gg.answer);
      expect(validate(p, edges)).toEqual([]);
    }
  });

  it('respects the dial it is handed', () => {
    const rnd = mulberry32(4242);
    const g = generate(rnd, { w: 6, h: 6, tilt: { skip: 3n, take: 2n }, dial: [LV_NONE, LV_WALL, LV_COLOUR] });
    const gg = g as NonNullable<typeof g>;
    for (let k = 0; k < 36; k++) expect(gg.levels[k]).not.toBe(LV_ARROW);
  });
});

describe('the shipped bank', () => {
  it('is not empty and covers three sizes', () => {
    expect(BANK.boards.length).toBeGreaterThan(40);
    expect(new Set(BANK.boards.map((b) => `${b.w}x${b.h}`)).size).toBe(3);
  });

  it('stores an answer of the right length for every board', () => {
    for (const b of BANK.boards) {
      expect(b.answer.length).toBe(edgeCountOf(b.w, b.h));
      expect([...b.answer].filter((c) => c === '1').length).toBe(b.loopLength);
    }
  });

  it('never puts two clues on one cell, and never a clue off the grid', () => {
    for (const b of BANK.boards) {
      const seen = new Set<number>();
      for (const c of b.clues) {
        expect(c.k).toBeGreaterThanOrEqual(0);
        expect(c.k).toBeLessThan(b.w * b.h);
        expect(seen.has(c.k)).toBe(false);
        seen.add(c.k);
      }
    }
  });

  it('gives every numbered clue a direction, and every plain clue none', () => {
    for (const b of BANK.boards) {
      for (const c of b.clues) {
        if (c.num >= 0) expect(c.dir).toBeGreaterThanOrEqual(0);
        else expect(c.dir).toBe(NO_DIR);
      }
    }
  });

  it('only uses the three levels of the shipped chain — never a grey clue with a number', () => {
    for (const b of BANK.boards) {
      for (const c of b.clues) {
        const level =
          c.num >= 0 ? (c.color === GREY ? 'arrow' : 'full') : c.color === GREY ? 'wall' : 'colour';
        expect(['wall', 'colour', 'full']).toContain(level);
      }
    }
  });
});

describe('propagation bookkeeping', () => {
  it('leaves nothing unknown once a board is solved by probing', () => {
    const b = BANK.boards[0];
    const p = bankPuzzle(b);
    const board = makeBoard(p);
    expect(propagate(p, board, RULE_LEVEL.probe)).toBe(true);
    for (let e = 0; e < p.edgeCount; e++) {
      if (board.edges[e] === E_UNKNOWN) continue;
      expect(board.edges[e]).toBe(bankAnswer(b)[e]);
    }
  });

  it('spots a contradiction straight away when a wall is told it is on the loop', () => {
    const p = makePuzzle(3, 3, [
      { color: GREY, dir: NO_DIR, num: NO_NUM },
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    const board = makeBoard(p);
    board.edges[hEdge(0, 0, 3)] = E_USED;
    expect(propagate(p, board, RULE_LEVEL.degree)).toBe(false);
  });

  it('kills a board whose even-crossing law is already broken', () => {
    const p = blankOf(4, 4);
    const board = makeBoard(p);
    // one single vertical edge in the top row gap, everything else ruled out
    for (let c = 0; c < 4; c++) board.edges[vEdge(0, c, 4, 4)] = c === 0 ? E_USED : E_UNUSED;
    expect(propagate(p, board, RULE_LEVEL.parity)).toBe(false);
  });
});
