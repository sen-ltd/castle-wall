/**
 * The page. An SVG board you draw the loop on by clicking the gaps between
 * cell centres, the five-rung ladder behind the Hint button, and an overlay
 * that shows exactly which edges the rung you picked still cannot decide.
 *
 * Only `castlewall.ts` reaches the browser. The censuses, the plug DP and the
 * generator are build-time code and none of it needs to ship.
 */
import bank from './puzzles.json';
import {
  Board,
  Clue,
  Puzzle,
  RULE_LEVEL,
  RuleSet,
  E_UNKNOWN,
  E_USED,
  E_UNUSED,
  GREY,
  WHITE,
  N,
  E,
  S,
  W,
  NO_DIR,
  makeBoard,
  makePuzzle,
  propagate,
  validate,
  solve,
  insideOf,
} from './castlewall';

interface RawClue {
  k: number;
  color: number;
  dir: number;
  num: number;
}
interface RawBoard {
  id: string;
  w: number;
  h: number;
  clues: RawClue[];
  answer: string;
  loopLength: number;
}
const BANK = (bank as unknown as { boards: RawBoard[] }).boards;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const svg = document.getElementById('board') as unknown as SVGSVGElement;
const statusEl = $('status');
const statsEl = $('stats');
const sizeEl = $<HTMLSelectElement>('size');
const rungEl = $<HTMLSelectElement>('rung');
const showEl = $<HTMLInputElement>('show');

const SVGNS = 'http://www.w3.org/2000/svg';
const ARROW: Record<number, string> = { [N]: '↑', [E]: '→', [S]: '↓', [W]: '←' };

let raw: RawBoard;
let puzzle: Puzzle;
let board: Board;
let answer: Uint8Array;
let index = 0;
let hinted = -1;
let cell = 46;

const sized = (): RawBoard[] => BANK.filter((b) => `${b.w}x${b.h}` === sizeEl.value);

function load(i: number): void {
  const list = sized();
  index = ((i % list.length) + list.length) % list.length;
  raw = list[index];
  const clues: (Clue | null)[] = new Array(raw.w * raw.h).fill(null);
  for (const c of raw.clues) clues[c.k] = { color: c.color, dir: c.dir, num: c.num };
  puzzle = makePuzzle(raw.w, raw.h, clues);
  board = makeBoard(puzzle);
  answer = new Uint8Array(puzzle.edgeCount);
  for (let e = 0; e < puzzle.edgeCount; e++) answer[e] = raw.answer[e] === '1' ? E_USED : E_UNUSED;
  hinted = -1;
  cell = raw.w >= 10 ? 40 : 46;
  draw();
  say('Click between two cell centres to draw the loop. Click again to cross the gap out.');
}

// --- geometry ---------------------------------------------------------------

const pad = 26;
const cx = (c: number): number => pad + c * cell;
const cy = (r: number): number => pad + r * cell;

function edgeEnds(e: number): [number, number, number, number] {
  const a = puzzle.ends[e * 2];
  const b = puzzle.ends[e * 2 + 1];
  const w = puzzle.w;
  return [cx(a % w), cy(Math.floor(a / w)), cx(b % w), cy(Math.floor(b / w))];
}

function el(name: string, attrs: Record<string, string | number>, cls?: string): SVGElement {
  const n = document.createElementNS(SVGNS, name);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (cls) n.setAttribute('class', cls);
  return n;
}

// --- drawing ----------------------------------------------------------------

function draw(): void {
  const { w, h } = puzzle;
  svg.setAttribute('width', String(pad * 2 + (w - 1) * cell));
  svg.setAttribute('height', String(pad * 2 + (h - 1) * cell));
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // faint lattice
  for (let r = 0; r < h; r++) {
    svg.appendChild(el('line', { x1: cx(0), y1: cy(r), x2: cx(w - 1), y2: cy(r) }, 'grid'));
  }
  for (let c = 0; c < w; c++) {
    svg.appendChild(el('line', { x1: cx(c), y1: cy(0), x2: cx(c), y2: cy(h - 1) }, 'grid'));
  }
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (puzzle.clues[r * w + c]) continue;
      svg.appendChild(el('circle', { cx: cx(c), cy: cy(r), r: 2.2 }, 'dot'));
    }
  }

  // what the chosen rung still cannot decide
  if (showEl.checked) {
    const probe = makeBoard(puzzle);
    for (let e = 0; e < puzzle.edgeCount; e++) probe.edges[e] = board.edges[e];
    if (propagate(puzzle, probe, RULE_LEVEL[rungEl.value as RuleSet], null)) {
      for (let e = 0; e < puzzle.edgeCount; e++) {
        if (probe.edges[e] !== E_UNKNOWN) continue;
        const [x1, y1, x2, y2] = edgeEnds(e);
        svg.appendChild(el('line', { x1, y1, x2, y2 }, 'open'));
      }
    }
  }

  if (hinted >= 0 && board.edges[hinted] === E_UNKNOWN) {
    const [x1, y1, x2, y2] = edgeEnds(hinted);
    svg.appendChild(el('line', { x1, y1, x2, y2 }, 'hintseg'));
  }

  for (let e = 0; e < puzzle.edgeCount; e++) {
    const [x1, y1, x2, y2] = edgeEnds(e);
    if (board.edges[e] === E_USED) {
      svg.appendChild(el('line', { x1, y1, x2, y2 }, 'seg'));
    } else if (board.edges[e] === E_UNUSED) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const d = 4.5;
      svg.appendChild(el('line', { x1: mx - d, y1: my - d, x2: mx + d, y2: my + d }, 'cross'));
      svg.appendChild(el('line', { x1: mx - d, y1: my + d, x2: mx + d, y2: my - d }, 'cross'));
    }
  }

  // the walls, drawn over the lattice
  const box = cell * 0.8;
  for (let k = 0; k < w * h; k++) {
    const clue = puzzle.clues[k];
    if (!clue) continue;
    const c = k % w;
    const r = Math.floor(k / w);
    const tone = clue.color === WHITE ? 'white' : clue.color === GREY ? 'grey' : 'black';
    svg.appendChild(
      el(
        'rect',
        { x: cx(c) - box / 2, y: cy(r) - box / 2, width: box, height: box, rx: 4 },
        `wall ${tone}`,
      ),
    );
    if (clue.dir !== NO_DIR && clue.num >= 0) {
      const t = el('text', { x: cx(c), y: cy(r) + 0.5 }, `on-${tone}`);
      t.textContent = `${clue.num}${ARROW[clue.dir]}`;
      svg.appendChild(t);
    }
  }

  // click targets last, so they sit on top
  for (let e = 0; e < puzzle.edgeCount; e++) {
    const [x1, y1, x2, y2] = edgeEnds(e);
    const hit = el('line', { x1, y1, x2, y2 }, 'hit');
    hit.addEventListener('click', () => toggle(e));
    hit.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      toggle(e, true);
    });
    svg.appendChild(hit);
  }

  refresh();
}

function toggle(e: number, back = false): void {
  const cur = board.edges[e];
  const order = back ? [E_UNKNOWN, E_UNUSED, E_USED] : [E_UNKNOWN, E_USED, E_UNUSED];
  board.edges[e] = order[(order.indexOf(cur) + 1) % 3];
  hinted = -1;
  draw();
  check();
}

function say(msg: string, cls = ''): void {
  statusEl.innerHTML = cls ? `<span class="${cls}">${msg}</span>` : msg;
}

function refresh(): void {
  let used = 0;
  let unknown = 0;
  for (let e = 0; e < puzzle.edgeCount; e++) {
    if (board.edges[e] === E_USED) used++;
    else if (board.edges[e] === E_UNKNOWN) unknown++;
  }
  const walls = raw.clues.length;
  const numbered = raw.clues.filter((c) => c.num >= 0).length;
  const coloured = raw.clues.filter((c) => c.color !== GREY).length;
  statsEl.innerHTML = [
    ['board', `${raw.w} × ${raw.h}, #${index + 1} of ${sized().length}`],
    ['walls', `${walls} — ${coloured} coloured, ${numbered} numbered`],
    ['loop so far', `${used} of ${raw.loopLength} segments`],
    ['gaps still unmarked', String(unknown)],
  ]
    .map(([a, b]) => `<div class="row"><span>${a}</span><b>${b}</b></div>`)
    .join('');
}

function check(): void {
  refresh();
  let unknown = 0;
  for (let e = 0; e < puzzle.edgeCount; e++) if (board.edges[e] === E_UNKNOWN) unknown++;
  const settled = new Uint8Array(puzzle.edgeCount);
  for (let e = 0; e < puzzle.edgeCount; e++) {
    settled[e] = board.edges[e] === E_USED ? E_USED : E_UNUSED;
  }
  const bad = validate(puzzle, settled);
  if (bad.length === 0) {
    say('Solved. One loop, every wall satisfied.', 'win');
    return;
  }
  if (unknown > 0) {
    say(
      'Click between two cell centres to draw the loop, click again to cross the gap out. Right-click steps the other way.',
    );
    return;
  }
  const kinds = [...new Set(bad.map((b) => b.kind))];
  say(`Not there yet — ${kinds.join(', ')}.`, 'err');
}

// --- buttons ----------------------------------------------------------------

$('new').addEventListener('click', () => load(index + 1));
sizeEl.addEventListener('change', () => load(0));
rungEl.addEventListener('change', () => draw());
showEl.addEventListener('change', () => draw());

$('clear').addEventListener('click', () => {
  board = makeBoard(puzzle);
  hinted = -1;
  draw();
  say('Cleared.');
});

$('solve').addEventListener('click', () => {
  // Draw the loop and leave the rest of the gaps unmarked: crossing out every
  // edge the answer does not use buries the loop in a field of little x's.
  board.edges.fill(E_UNKNOWN);
  for (let e = 0; e < puzzle.edgeCount; e++) if (answer[e] === E_USED) board.edges[e] = E_USED;
  hinted = -1;
  draw();
  check();
});

$('hint').addEventListener('click', () => {
  const level = RULE_LEVEL[rungEl.value as RuleSet];
  const probe = makeBoard(puzzle);
  probe.edges.set(board.edges);
  if (!propagate(puzzle, probe, level, null)) {
    say('This position is already dead — something on the board contradicts the walls.', 'err');
    return;
  }
  for (let e = 0; e < puzzle.edgeCount; e++) {
    if (board.edges[e] !== E_UNKNOWN || probe.edges[e] === E_UNKNOWN) continue;
    hinted = e;
    draw();
    const a = puzzle.ends[e * 2];
    const b = puzzle.ends[e * 2 + 1];
    const name = (k: number): string => `r${Math.floor(k / puzzle.w) + 1}c${(k % puzzle.w) + 1}`;
    say(
      `<em>${rungEl.value}</em> settles the gap ${name(a)}–${name(b)}: it is ${
        probe.edges[e] === E_USED ? 'part of the loop' : 'not part of the loop'
      }.`,
    );
    return;
  }
  say(`<em>${rungEl.value}</em> has nothing left to say here. Try a stronger rung.`);
});

$('count').addEventListener('click', () => {
  const t0 = performance.now();
  const res = solve(puzzle, { limit: 2, maxNodes: 2_000_000 });
  const ms = Math.round(performance.now() - t0);
  say(
    res.aborted
      ? `Search hit its node budget after ${ms} ms.`
      : `${res.count === 1 ? 'Exactly one answer' : `${res.count}+ answers`} — ${res.nodes} search nodes, ${ms} ms.`,
  );
});

$('inside').addEventListener('click', () => {
  const settled = new Uint8Array(puzzle.edgeCount);
  for (let e = 0; e < puzzle.edgeCount; e++) settled[e] = board.edges[e] === E_USED ? E_USED : E_UNUSED;
  const names: string[] = [];
  for (let k = 0; k < puzzle.w * puzzle.h; k++) {
    if (!puzzle.clues[k]) continue;
    const inside = insideOf(puzzle, settled, k);
    names.push(
      `r${Math.floor(k / puzzle.w) + 1}c${(k % puzzle.w) + 1} ${inside ? 'inside' : 'outside'}`,
    );
  }
  say(`Counting crossings on the loop you have drawn: ${names.join(', ')}.`);
});

load(0);
