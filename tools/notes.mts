/**
 * Folds src/counts.json and src/stats.json into the notes block of index.html
 * and into README.md. Every number in either file comes from here, so nothing
 * is transcribed by hand and no number can quietly go stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import counts from '../src/counts.json';
import stats from '../src/stats.json';
import bank from '../src/puzzles.json';

/* eslint-disable @typescript-eslint/no-explicit-any */
const C = counts as any;
const S = stats as any;
const BANK = bank as any;
const SIZES: string[] = [...new Set<string>(BANK.boards.map((b: any) => `${b.w}x${b.h}`))];

const n = (x: number | string): string => Number(x).toLocaleString('en-US');
const big = (s: string): string => BigInt(s).toLocaleString('en-US');
const pct = (x: number, d = 1): string => `${(100 * x).toFixed(d)}%`;
const ms = (x: number): string => (x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${n(x)} ms`);
const f = (x: number, d = 2): string => x.toFixed(d);

const rows = (head: string[], body: string[][]): string =>
  [
    '<table>',
    `  <tr>${head.map((x) => `<th>${x}</th>`).join('')}</tr>`,
    ...body.map(
      (r) => `  <tr><th>${r[0]}</th>${r.slice(1).map((c) => `<td>${c}</td>`).join('')}</tr>`,
    ),
    '</table>',
  ].join('\n');
const untag = (s: string): string =>
  s
    .replace(/<code>(.*?)<\/code>/g, '`$1`')
    .replace(/<\/?strong>/g, '**')
    .replace(/<\/?em>/g, '*')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g, '[$2]($1)');
const mdTable = (head: string[], body: string[][]): string =>
  [
    `| ${head.map(untag).join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.map(untag).join(' | ')} |`),
  ].join('\n');

interface Section {
  title: string;
  paras: string[];
  table?: { head: string[]; body: string[][] };
  tables?: { head: string[]; body: string[][] }[];
}

const sections: Section[] = [];
const BUDGET_LOOP = 120_000;
/** the solution-count cap used in the ablation; anything at it is a floor */
const ANSWER_CAP = 500;
const capped = (x: number): string => (x >= ANSWER_CAP ? `≥ ${n(x)}` : n(x));

// --- 1. the theorem ---------------------------------------------------------
{
  const o4 = S.orth.find((r: any) => r.w === 4);
  const o5 = S.orth.find((r: any) => r.w === 5);
  sections.push({
    title: 'The number and the colour never talk about the same edges',
    paras: [
      `A Castle Wall clue has two halves and they look like they ought to overlap. Walk east out of the wall at <code>(r,c)</code> along the row's centre line. The segments the arrow counts are the <strong>horizontal</strong> edges of row <code>r</code>: they lie <em>along</em> the ray, collinear with it, and a ray that runs along a piece of curve does not cross it. Now nudge the ray down by a hair. The only loop edges it can meet are <strong>vertical</strong> edges spanning rows <code>r</code> and <code>r+1</code>, and by the Jordan curve theorem the parity of that count is exactly the inside/outside bit. So the arrow counts the edges the ray runs <em>along</em>, and the colour is the parity of the edges the ray runs <em>across</em>. Disjoint sets. Neither half can be computed from the other.`,
      `That is a claim, so it is measured. For every cycle of a grid, for every cell the loop misses and every one of the four directions, record the number an arrow would print and the colour the cell would get, then take the mutual information between them — pooled per <code>(cell, direction)</code> so that no correlation can sneak in from the cell's position. It comes out at ${f(o5.miMean, 4)} bits on a 5×5 board across all ${big(String(C.squares.find((s: any) => s.n === 5).cycles))} of its cycles. The control in the last column takes the same measurement against the parity of the <em>across</em> ray, which is the colour by construction, and gets the colour's whole entropy back.`,
      `The naive guess — "the number is odd exactly when the wall is inside" — scores ${pct(o5.parityAgreement)} on a 5×5 board, which sounds respectable until you notice that <strong>always answering "outside" scores ${pct(1 - o5.insideRate)}</strong>. Reading the parity of the number is worse than not reading it.`,
    ],
    table: {
      head: [
        'grid',
        '(cell, dir) pairs',
        'samples',
        'P(inside)',
        'guess from number parity',
        'always say "outside"',
        'I(colour ; number)',
        'worst pair',
        'I(colour ; across parity)',
        'H(colour)',
      ],
      body: [o4, o5].map((r: any) => [
        `${r.w} × ${r.h}`,
        n(r.pairs),
        n(r.samples),
        pct(r.insideRate),
        pct(r.parityAgreement),
        pct(1 - r.insideRate),
        `${f(r.miMean, 4)} bits`,
        `${f(r.miMax, 4)} bits`,
        `${f(r.controlMiMean, 4)} bits`,
        `${f(r.entropyMean, 4)} bits`,
      ]),
    },
  });
}

// --- 2. how many loops ------------------------------------------------------
{
  const ok = C.squares.filter((r: any) => r.matchesOeis === true).length;
  sections.push({
    title: 'How many loops a grid has, exactly',
    paras: [
      `An answer to a Castle Wall board is a simple cycle of the grid graph that misses the walls, so before any clue is read the question is how many cycles a grid has. A connectivity-profile sweep answers it: carry a frontier of <code>w+1</code> plugs, remember which is paired with which, canonicalise the pairing by first appearance. Two things are not in the textbook version — a cell may be <em>skipped</em>, because this loop wanders rather than filling the board, and the inside/outside bit rides along as <strong>one extra bit</strong> in the key, being the west parity ray evaluated incrementally as the sweep crosses the row.`,
      `The square grids have a published answer to check against, <a href="https://oeis.org/A140517">OEIS A140517</a>. All ${ok} of them match. The rectangles have no OEIS entry, so ${C.rects.filter((r: any) => r.agrees).length} of them are checked against a depth-first enumeration that shares no code with the sweep.`,
    ],
    table: {
      head: ['grid', 'cycles', 'matches A140517', 'frontier states', 'time'],
      body: C.squares.map((r: any) => [
        `${r.n} × ${r.n}`,
        big(r.cycles),
        r.matchesOeis === null ? '—' : r.matchesOeis ? 'yes' : 'NO',
        n(r.states),
        ms(r.ms),
      ]),
    },
  });
}

// --- 3. a random loop is too long ------------------------------------------
{
  const l8 = C.lengths.find((r: any) => r.w === 8);
  const t8 = C.tilts.filter((r: any) => r.w === 8);
  sections.push({
    title: 'A loop drawn at random is too long to be a puzzle',
    paras: [
      `The walls have to go where the loop is not, so a long loop is a board with few walls. Splitting the same sweep by length says how long a loop is if you pick one uniformly: on an 8×8 board the mean is ${f(l8.mean)} cells out of ${l8.w * l8.h}, ${pct(l8.coverage)} coverage, and it creeps <em>up</em> with the grid. That is the wrong end of the scale. The generator therefore does not sample uniformly; it tilts, giving every edge the loop leaves alone a weight of <code>skip</code> and every edge it takes a weight of <code>take</code>, which slides the density down without leaving the exact arithmetic — the tilted counts are still bigints.`,
      `The ratio is sharp. Between 1 and 2 the coverage falls from ${pct(t8[0].coverage)} to ${pct(t8[t8.length - 1].coverage)}, and every board worth generating lives in that sliver. The shipped boards use <code>${BANK.tilt.skip}/${BANK.tilt.take}</code>.`,
    ],
    tables: [
      {
        head: ['grid', 'cycles', 'mean loop length', 'coverage', 'most common length'],
        body: C.lengths.map((r: any) => [
          `${r.w} × ${r.h}`,
          big(r.total),
          f(r.mean),
          pct(r.coverage),
          n(r.mode),
        ]),
      },
      {
        head: ['grid', 'skip / take', 'mean loop length', 'coverage'],
        body: C.tilts.map((r: any) => [
          `${r.w} × ${r.h}`,
          `${r.skip} / ${r.take}`,
          f(r.mean),
          pct(r.coverage),
        ]),
      },
      {
        head: ['grid', 'uniform coverage', 'tilted sampler', 'shipped boards', 'walls per board'],
        body: S.lengths.map((r: any) => {
          const exact = C.lengths.find((x: any) => `${x.w}x${x.h}` === r.size);
          return [
            r.size,
            exact ? pct(exact.coverage) : '—',
            pct(r.samplerCoverage),
            pct(r.shippedCoverage),
            f(r.shippedClues, 1),
          ];
        }),
      },
    ],
  });
}

// --- 4. the ceiling ---------------------------------------------------------
{
  const c55 = S.census.find((r: any) => r.w === 5 && r.h === 5);
  const c44 = S.census.find((r: any) => r.w === 4 && r.h === 4);
  sections.push({
    title: 'Even a board that says everything it can is unique only about half the time',
    paras: [
      `Before minimising anything, ask what the genre's ceiling is: hand <em>every</em> cell the loop misses a colour and its longest arrow — more than any legal board would ever print — and count the answers. Over <em>every</em> cycle of a 4×4 grid that is ${n(c44.unique)} of ${n(c44.cycles)}; over every cycle of a 5×5 grid, ${n(c55.unique)} of ${n(c55.cycles)}. The rate is falling as the grid grows and it is already at a half. <strong>Half of all loops cannot be pinned down by any set of clues at all</strong> — not because the clues are weak but because the cells the loop leaves behind are not enough to carry them.`,
      `The tiny grids at the top of the table are degenerate and worth naming as such: a 2×2 board has one cycle and no spare cell to put a wall on, so its "max-information board" is a blank grid that happens to have one answer. The interesting rows start where there is room for walls.`,
    ],
    table: {
      head: [
        'grid',
        'cycles',
        'most walls a loop leaves',
        'max-information boards with one answer',
        'rate',
      ],
      body: S.census.map((r: any) => [
        `${r.w} × ${r.h}`,
        n(r.cycles),
        n(r.maxOffLoop),
        n(r.unique),
        pct(r.rate),
      ]),
    },
  });
}

// --- 5. the ablation --------------------------------------------------------
{
  const rows6 = S.ablation.find((r: any) => r.size === '6x6');
  const rows10 = S.ablation.find((r: any) => r.size === '10x10');
  sections.push({
    title: 'Erase the numbers and nothing survives; erase the colours and most small boards do',
    paras: [
      `The two halves are independent, but they are not worth the same. Take the shipped boards and rub out one half at a time. Rubbing out every number leaves ${S.ablation.reduce((a: number, r: any) => a + r.noArrowUnique, 0)} of ${S.ablation.reduce((a: number, r: any) => a + r.boards, 0)} boards with a single answer — the colours alone never carry a board, and the count runs past the ${n(ANSWER_CAP)}-answer cap the search stops at. Rubbing out every colour leaves ${rows6.noColourUnique} of ${rows6.boards} at 6×6 and ${rows10.noColourUnique} of ${rows10.boards} at 10×10, so the colour is nearly free on a small board and load-bearing on a large one.`,
      `That is the shape you would expect from the geometry. A number is a count on a ray whose length grows with the grid; a colour is one bit however big the board is. The bigger the board, the more the arrows are already saying, and yet the further apart the answers sit — which is why the colour stops being decorative right when the search starts to hurt.`,
    ],
    table: {
      head: [
        'grid',
        'boards',
        'walls',
        'coloured',
        'numbered',
        'colours erased: still unique',
        'median answers',
        'numbers erased: still unique',
        'median answers',
        'walls only: median answers',
      ],
      body: S.ablation.map((r: any) => [
        r.size,
        n(r.boards),
        n(r.clues),
        n(r.coloured),
        n(r.numbered),
        `${r.noColourUnique} / ${r.boards}`,
        capped(r.noColourMedian),
        `${r.noArrowUnique} / ${r.boards}`,
        capped(r.noArrowMedian),
        capped(r.wallsOnlyMedian),
      ]),
    },
  });
}

// --- 6. the ladder ----------------------------------------------------------
{
  const last = S.ladder[S.ladder.length - 1];
  sections.push({
    title: 'The ladder, measured both ways',
    paras: [
      `Five rungs, weakest first. <code>degree</code>: a wall takes no gaps, every other cell takes two or none. <code>arrow</code>: each number as an interval on its ray, forcing the rest of the ray when the count is met or when nothing may be spared. <code>parity</code>: each colour as <strong>four</strong> parity constraints — one per direction, all of them the same bit — plus the free even-crossing law, since a closed curve meets any straight line an even number of times and that holds on every row gap and column gap with no clue at all. <code>loop</code>: one loop, so a gap that would close a short circuit while another fragment is alive is unusable, and a fragment that can no longer reach the rest is dead. <code>probe</code>: assume a gap, run the cheap rungs, drop the assumption if the board dies.`,
      `Two measurements, the same boards. Going up the ladder, the share of the answer's gaps that propagation alone settles from an empty board. Taking one rung out of the full ladder, what is left. At ${S.ladder.map((r: any) => `${r.size} the full ladder settles ${pct(r.share.probe)} and finishes ${r.solvedByProbe} of ${r.boards} boards outright`).join('; at ')}.`,
      `The leave-one-out table is where the colour earns its keep. At ${S.ladder[0].size} taking the <code>parity</code> rung out costs ${pct(S.ladder[0].share.probe - S.ladder[0].without.parity)} — probing puts back everything the colours were saying. By ${last.size} it costs ${pct(last.share.probe - last.without.parity)}, and taking <code>arrow</code> out costs ${pct(last.share.probe - last.without.arrow)}. The same crossover as the clue-half ablation, from the other side: small boards do not need the colours, large ones do.`,
      `The node counts are the ladder read as pruning. A search that knows only <code>degree</code> is hopeless — it runs out of its ${n(BUDGET_LOOP)}-node budget on every board above 6×6 — and each rung above it takes an order of magnitude off. Counts marked <code>≥</code> hit the budget.`,
    ],
    tables: [
      {
        head: ['grid', ...Object.keys(S.ladder[0].share).map((k: string) => `<code>${k}</code>`)],
        body: S.ladder.map((r: any) => [
          r.size,
          ...Object.keys(r.share).map((k: string) => pct(r.share[k])),
        ]),
      },
      {
        head: ['grid', ...Object.keys(S.ladder[0].without).map((k: string) => `full ladder − <code>${k}</code>`), 'full ladder'],
        body: S.ladder.map((r: any) => [
          r.size,
          ...Object.keys(r.without).map((k: string) => pct(r.without[k])),
          pct(r.share.probe),
        ]),
      },
      {
        head: [
          'grid',
          ...Object.keys(S.ladder[0].nodes).map((k: string) => `median nodes, <code>${k}</code>`),
        ],
        body: S.ladder.map((r: any) => [
          r.size,
          ...Object.keys(r.nodes).map((k: string) =>
            r.aborted[k] ? `≥ ${n(r.nodes[k])}` : n(r.nodes[k]),
          ),
        ]),
      },
    ],
  });
}

// --- 7. the dial ------------------------------------------------------------
{
  const d = S.dial;
  const tally = S.bankLevels;
  sections.push({
    title: 'The dial has a fork in it, and the boards take the safe branch',
    paras: [
      `Minimisation here is not "which cells carry a clue" — the cells are walls either way, and a wall blocks the loop whether or not it says anything. What comes off is <em>how much each wall tells you</em>: <code>full</code> (colour and number) down to <code>colour</code> (the bit alone) or <code>arrow</code> (the number alone, wall left grey), down to <code>wall</code> (a grey blank), down to <code>none</code>, which hands the cell back to the loop. Weakening only ever admits more answers, so the greedy pass has a fixed point and reaching it is the whole minimisation.`,
      `The two middle levels are incomparable, which is the genre's own claim restated, so the dial forks. The shipped boards take the chain <code>none → wall → colour → full</code>, the way the genre prints a clue: a wall that keeps its number keeps its colour. Running the same seeds down the full fork instead answers what that costs, and the answer is <strong>nothing either way</strong>: ${d.map((r: any) => `${f(r.chainClues, 2)} clues a board on the chain against ${f(r.forkClues, 2)} on the fork at ${r.size}`).join(', ')}. The fork does not shrink a single board. What it does is strip the colours — ${d.map((r: any) => `${n(r.forkLevels.arrow ?? 0)} of ${r.size}'s ${n((r.forkLevels.arrow ?? 0) + (r.forkLevels.full ?? 0))} numbered walls turn grey`).join(' and ')} — because a number that survives on its own always prefers to, and the greedy takes the first level that works. Since the colours are free to keep and cost nothing to state, the chain is the right branch.`,
      `Across the ${BANK.boards.length} shipped boards the dial came to rest at: ${Object.entries(tally as Record<string, number>).filter(([k]) => k !== 'none').map(([k, v]) => `<code>${k}</code> ${n(v as number)}`).join(', ')}.`,
    ],
    table: {
      head: ['grid', 'seeds', 'clues on the chain', 'clues on the fork', 'chain levels', 'fork levels'],
      body: d.map((r: any) => [
        r.size,
        n(r.seeds),
        f(r.chainClues, 1),
        f(r.forkClues, 1),
        Object.entries(r.chainLevels).map(([k, v]) => `${k} ${v}`).join(', '),
        Object.entries(r.forkLevels).map(([k, v]) => `${k} ${v}`).join(', '),
      ]),
    },
  });
}

// --- 8. the bank ------------------------------------------------------------
{
  const cs = S.colourSplit;
  sections.push({
    title: 'The shipped boards',
    paras: [
      `${BANK.boards.length} boards across ${SIZES.join(', ')}, every one re-solved from scratch after generation and required to have exactly one answer. The walls split ${n(cs.white)} white, ${n(cs.black)} black, ${n(cs.grey)} grey. Black outnumbers white because a wall is outside the loop unless the loop has been drawn around it, and at these coverages most of the board is outside.`,
      `The 5×5 inside-field cross-check in <code>stats.json</code> is the sweep checking itself: for every cell, the number of cycles that miss it and enclose it, counted once by enumerating all ${big(String(C.squares.find((s: any) => s.n === 5).cycles))} cycles and once by the plug DP's parity bit. ${S.field.agrees ? 'They agree on all 25 cells.' : 'They disagree — something is wrong.'}`,
    ],
    table: {
      head: ['grid', 'boards', 'walls per board', 'loop length', 'coverage'],
      body: S.lengths.map((r: any) => [
        r.size,
        n(BANK.boards.filter((b: any) => `${b.w}x${b.h}` === r.size).length),
        f(r.shippedClues, 1),
        f(r.shippedMean, 1),
        pct(r.shippedCoverage),
      ]),
    },
  });
}

// --- an example board, drawn ------------------------------------------------

const ARROW: Record<number, string> = { 0: '\u2191', 1: '\u2192', 2: '\u2193', 3: '\u2190' };

function drawBoard(b: any): { clue: string[]; answer: string[] } {
  const { w, h } = b;
  const clueAt = new Map<number, any>();
  for (const c of b.clues) clueAt.set(c.k, c);
  const used = (e: number): boolean => b.answer[e] === '1';
  const hE = (r: number, c: number): number => r * (w - 1) + c;
  const vE = (r: number, c: number): number => h * (w - 1) + r * w + c;

  const clue: string[] = [];
  for (let r = 0; r < h; r++) {
    let line = '';
    for (let c = 0; c < w; c++) {
      const k = r * w + c;
      const q = clueAt.get(k);
      if (!q) line += '  . ';
      else {
        const tone = q.color === 1 ? 'W' : q.color === 2 ? 'B' : 'G';
        line += (q.num >= 0 ? ` ${tone}${q.num}${ARROW[q.dir]}` : ` ${tone}  `);
      }
    }
    clue.push(line.replace(/\s+$/, ''));
  }

  const answer: string[] = [];
  for (let r = 0; r < h; r++) {
    let cells = '';
    for (let c = 0; c < w; c++) {
      const k = r * w + c;
      if (clueAt.has(k)) cells += '#';
      else {
        const nrt = r > 0 && used(vE(r - 1, c));
        const sth = r + 1 < h && used(vE(r, c));
        const est = c + 1 < w && used(hE(r, c));
        const wst = c > 0 && used(hE(r, c - 1));
        const key = `${nrt ? 'N' : ''}${est ? 'E' : ''}${sth ? 'S' : ''}${wst ? 'W' : ''}`;
        cells +=
          key === 'NS' ? '\u2502'
          : key === 'EW' ? '\u2500'
          : key === 'NE' ? '\u2514'
          : key === 'NW' ? '\u2518'
          : key === 'ES' ? '\u250c'
          : key === 'SW' ? '\u2510'
          : '\u00b7';
      }
      if (c + 1 < w) cells += used(hE(r, c)) ? '\u2500\u2500\u2500' : '   ';
    }
    answer.push(cells);
    if (r + 1 >= h) continue;
    let links = '';
    for (let c = 0; c < w; c++) {
      links += used(vE(r, c)) ? '\u2502' : ' ';
      if (c + 1 < w) links += '   ';
    }
    answer.push(links.replace(/\s+$/, ''));
  }
  return { clue, answer };
}

{
  const pick = BANK.boards.find((b: any) => b.w === 8 && b.clues.length >= 9) ?? BANK.boards[0];
  const { clue, answer } = drawBoard(pick);
  const pad = Math.max(...clue.map((l: string) => l.length)) + 4;
  const body: string[] = ['```', 'the board'.padEnd(pad) + 'the answer', ''];
  const rowsN = Math.max(clue.length, answer.length);
  for (let i = 0; i < rowsN; i++) {
    const a = i < clue.length ? clue[i] : '';
    const bline = i < answer.length ? answer[i] : '';
    body.push((a + ' '.repeat(Math.max(0, pad - a.length))) + bline);
  }
  body.push('```', '');
  const coloured = pick.clues.filter((c: any) => c.color !== 0).length;
  const numbered = pick.clues.filter((c: any) => c.num >= 0).length;
  body.push(
    `A shipped ${pick.w}×${pick.h} board. **W** is white (the wall finishes inside the loop), **B** is black (outside), **G** is a grey wall that says nothing; the number and arrow count the loop's segments along that ray. ${pick.clues.length} walls — ${coloured} coloured, ${numbered} numbered — one loop of ${pick.loopLength} segments, and exactly one answer.`,
  );
  const readme = new URL('../README.md', import.meta.url);
  let text = readFileSync(readme, 'utf8');
  text = text.replace(
    /<!-- sen:board:start -->[\s\S]*?<!-- sen:board:end -->/,
    `<!-- sen:board:start -->\n${body.join('\n')}\n<!-- sen:board:end -->`,
  );
  writeFileSync(readme, text);
}

// --- render -----------------------------------------------------------------

const html: string[] = [];
const md: string[] = [];
for (const s of sections) {
  html.push(`<h2>${s.title}</h2>`);
  md.push(`### ${untag(s.title)}`);
  for (const p of s.paras) {
    html.push(`<p>${p}</p>`);
    md.push('', untag(p), '');
  }
  const tables = s.tables ?? (s.table ? [s.table] : []);
  for (const t of tables) {
    html.push(rows(t.head, t.body));
    md.push('', mdTable(t.head, t.body), '');
  }
}

{
  const page = new URL('../index.html', import.meta.url);
  let text = readFileSync(page, 'utf8');
  text = text.replace(
    /<!-- sen:stats:start -->[\s\S]*?<!-- sen:stats:end -->/,
    `<!-- sen:stats:start -->\n${html.join('\n')}\n        <!-- sen:stats:end -->`,
  );
  writeFileSync(page, text);
}
{
  const readme = new URL('../README.md', import.meta.url);
  let text = readFileSync(readme, 'utf8');
  text = text.replace(
    /<!-- sen:stats:start -->[\s\S]*?<!-- sen:stats:end -->/,
    `<!-- sen:stats:start -->\n${md.join('\n')}\n<!-- sen:stats:end -->`,
  );
  writeFileSync(readme, text);
}
console.log('rewrote index.html and README.md');
