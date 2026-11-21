// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
// One program answers a whole set: it reads /input/<id>/level.txt (XSB) and
// writes /output/<id>/solution.txt, the player's moves in LURD (an upper
// letter marks a push; the replay decides that from the board, case is free).
//
// Idea. A level is a hallway with one to four rooms off it, and a box pushed
// out of a room's door into the hallway can never come back, so the rooms are
// independent: the level's push-optimum is the sum of the rooms' optima. The
// solver therefore splits a level into rooms, solves each room on its own
// with a push-optimal A*, and walks the player from room to room through the
// hallway. Inside a room the search is over pushes only: a state is the
// boxes' squares plus the player's reachable region (named by its lowest
// square), and the estimate is the cheapest assignment of boxes to goals
// under the floor distances, which no single push can shrink by more than
// one, so the first solved state A* meets is push-optimal. Two deadlocks
// are pruned: a box on a square from which no pull chain reaches a goal,
// and a box caught in a frozen 2 x 2 block of walls and boxes. Everything
// is budgeted by work (states expanded), never by the clock, so two runs
// write the same bytes.
//
// Written from scratch for this bounty. No dependency, no network, no clock,
// no randomness; the direction order u, d, l, r breaks every tie.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions: [dx, dy, walk letter, push letter].
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// Work budgets (states expanded). A room the generator keeps is solvable
// within 250_000 states by its own breadth-first push search, and this A*
// expands no state that search would not, so the caps below are generous.
const ASTAR_CAP = 250_000;
const GREEDY_CAP = 250_000;
// Whole-set work budget: once spent, the remaining instances are answered
// empty rather than risking the 60-second wall.
const TOTAL_CAP = 3_000_000;

let spent = 0;

type Board = {
  w: number;
  h: number;
  size: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * h;
  const wall = new Uint8Array(size).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever the text shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, size, wall, goals, boxes, player };
}

// Squares a box can be pushed from onto some goal, found by pulling back
// from the goals: a square y is live when some live square x = y + d can be
// reached by pushing from y, which needs the player to stand on y - d.
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.size);
  const queue: number[] = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * b.w + dx;
      const y = x - d;
      if (y < 0 || y >= b.size) continue;
      if (!b.wall[y] && !b.wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Shortest walking distances between floor squares, ignoring boxes.
// dist[a * size + b] is the walk length, or -1 when unreachable.
function allDistances(b: Board): Int32Array {
  const dist = new Int32Array(b.size * b.size).fill(-1);
  const q = new Int32Array(b.size);
  for (let s = 0; s < b.size; s++) {
    if (b.wall[s]) continue;
    let n = 0;
    q[n++] = s;
    dist[s * b.size + s] = 0;
    for (let qi = 0; qi < n; qi++) {
      const p = q[qi]!;
      const dd = dist[s * b.size + p]!;
      for (const [dx, dy] of DIRS) {
        const t = p + dy * b.w + dx;
        if (b.wall[t] || dist[s * b.size + t] !== -1) continue;
        dist[s * b.size + t] = dd + 1;
        q[n++] = t;
      }
    }
  }
  return dist;
}

// The squares the player reaches from `from` with `occupied` in the way;
// marks them in `seen` with `stamp` and returns the lowest one reached.
function reach(b: Board, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - b.w : k === 1 ? p + b.w : k === 2 ? p - 1 : p + 1;
      if (b.wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// True when the box just pushed to `t` sits in a frozen 2 x 2 block: four
// squares of walls and boxes, one of the boxes off its goal.
function frozenBlock(b: Board, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  for (const a of [t, t - 1, t - b.w, t - b.w - 1]) {
    const c = a + 1;
    const d = a + b.w;
    const e = d + 1;
    if (!(b.wall[a] || occupied[a]) || !(b.wall[c] || occupied[c]) || !(b.wall[d] || occupied[d]) || !(b.wall[e] || occupied[e])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d]) || (occupied[e] && !goal[e])) return true;
  }
  return false;
}

// The shortest walk from `from` to `to` around walls and boxes, in lower
// LURD letters; '' when already there.
function walkTo(b: Board, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(b.size).fill(-1);
  const how = new Array<string>(b.size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * b.w + dx;
      if (b.wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return '';
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

type PushStep = { from: number; to: number; dir: number };

// Push search over one board: { pushes, moves } or null. `greedy` ranks
// states by the estimate alone (fast, not optimal); otherwise A* on
// pushes + estimate (optimal). `cap` bounds the states expanded.
function pushSearch(b: Board, cap: number, greedy: boolean): { pushes: number; moves: string } | null {
  const n = b.boxes.length;
  if (n === 0) return { pushes: 0, moves: '' };
  const goal = new Uint8Array(b.size);
  for (const g of b.goals) goal[g] = 1;
  const live = liveSquares(b);
  for (const x of b.boxes) if (!live[x]) return null;
  const dist = allDistances(b);
  const solved = (boxes: number[]): boolean => boxes.every((x) => goal[x]);

  // Cheapest assignment of boxes to goals, by walking distance; Infinity
  // when some box cannot reach any goal. With at most five boxes the
  // permutations are few (120 at most); longer lists fall back to the
  // nearest-goal sum, which is still admissible: one push moves one box
  // by one square, so no estimate here can shrink by more than one.
  const usePerms = n <= 5 && b.goals.length === n;
  const perms: number[][] = [];
  const buildPerms = (prefix: number[], rest: number[]): void => {
    if (rest.length === 0) {
      perms.push(prefix);
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      const r = rest.slice();
      const v = r.splice(i, 1)[0]!;
      buildPerms(prefix.concat(v), r);
    }
  };
  if (usePerms) buildPerms([], b.goals.map((_, i) => i));
  const estimate = (boxes: number[]): number => {
    if (!usePerms) {
      let sum = 0;
      for (const x of boxes) {
        let m = Infinity;
        for (const g of b.goals) {
          const d = dist[x * b.size + g]!;
          if (d >= 0 && d < m) m = d;
        }
        if (m === Infinity) return Infinity;
        sum += m;
      }
      return sum;
    }
    let best = Infinity;
    for (const p of perms) {
      let sum = 0;
      let ok = true;
      for (let i = 0; i < n; i++) {
        const d = dist[boxes[i]! * b.size + b.goals[p[i]!]!]!;
        if (d < 0) {
          ok = false;
          break;
        }
        sum += d;
      }
      if (ok && sum < best) best = sum;
    }
    return best;
  };

  // State key: the region's lowest square, then the boxes, as digits in
  // base size (exact while size ** (n + 1) stays under 2 ** 53: a room
  // holds at most four boxes on any board this generator draws). Wider
  // boards fall back to a string key.
  const numericKey = Math.pow(b.size, n + 1) < 2 ** 53;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (!numericKey) return `${low}:${boxes.join(',')}`;
    let k = low;
    for (const x of boxes) k = k * b.size + x;
    return k;
  };

  const occupied = new Uint8Array(b.size);
  const seen = new Int32Array(b.size);
  const stack = new Int32Array(b.size);
  let stamp = 0;
  // A second mark array, with its own stamps, for the region a push leaves
  // the player in: it must never overwrite the expansion's reachability
  // marks, or squares the player can stand on read as unreachable.
  const mark = new Int32Array(b.size);
  let markStamp = 0;

  const stBoxes: number[][] = [b.boxes.slice()];
  const stPlayer: number[] = [b.player];
  const stParent: number[] = [-1];
  const stPush: (PushStep | null)[] = [null];
  const stG: number[] = [0];
  const best = new Map<number | string, number>();
  for (const x of b.boxes) occupied[x] = 1;
  const low0 = reach(b, occupied, b.player, mark, ++markStamp, stack);
  for (const x of b.boxes) occupied[x] = 0;
  best.set(keyOf(b.boxes, low0), 0);
  if (solved(b.boxes)) return { pushes: 0, moves: '' };

  // Binary heap on [f, -g, order]: lowest f first, deepest first on a tie,
  // earliest first after that. The order counter keeps every comparison
  // total, so the pop sequence is the same on every run.
  const heap: [number, number, number, number][] = [];
  let order = 0;
  const h0 = estimate(b.boxes);
  const less = (a: [number, number, number, number], c: [number, number, number, number]): boolean =>
    a[0] < c[0] || (a[0] === c[0] && (a[1] < c[1] || (a[1] === c[1] && a[2] < c[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      const tmp = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        const tmp = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };
  heapPush([h0, 0, order++, 0]);

  let expanded = 0;
  let found = -1;
  while (heap.length > 0 && expanded < cap) {
    const [, , , s] = heapPop();
    const boxes = stBoxes[s]!;
    const g = stG[s]!;
    // Skip a stale entry: a shorter path to this state was recorded.
    // (The key is recomputed from the state's own player square, whose
    // region is the state's region.)
    const regionLow = (() => {
      for (const x of boxes) occupied[x] = 1;
      const low = reach(b, occupied, stPlayer[s]!, mark, ++markStamp, stack);
      for (const x of boxes) occupied[x] = 0;
      return low;
    })();
    if (best.get(keyOf(boxes, regionLow)) !== s) continue;
    expanded++;
    spent++;
    for (const x of boxes) occupied[x] = 1;
    const here = ++stamp;
    reach(b, occupied, stPlayer[s]!, seen, here, stack);
    for (let bi = 0; bi < n; bi++) {
      const box = boxes[bi]!;
      for (let dir = 0; dir < 4; dir++) {
        const [dx, dy] = DIRS[dir]!;
        const d = dy * b.w + dx;
        const to = box + d;
        const behind = box - d;
        if (seen[behind] !== here || b.wall[to] || occupied[to] || !live[to]) continue;
        occupied[box] = 0;
        occupied[to] = 1;
        const frozen = frozenBlock(b, occupied, goal, to);
        let key: number | string = -1;
        let next: number[] | null = null;
        let low = -1;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = to;
          next.sort((a, c) => a - c);
          low = reach(b, occupied, box, mark, ++markStamp, stack);
          key = keyOf(next, low);
        }
        occupied[to] = 0;
        occupied[box] = 1;
        if (frozen || next === null) continue;
        const prev = best.get(key);
        if (prev !== undefined && stG[prev]! <= g + 1) continue;
        const t = stBoxes.length;
        stBoxes.push(next);
        stPlayer.push(box);
        stParent.push(s);
        stPush.push({ from: box, to, dir });
        stG.push(g + 1);
        best.set(key, t);
        if (solved(next)) {
          found = t;
          break;
        }
        const h = estimate(next);
        if (h === Infinity) continue;
        heapPush([greedy ? h : g + 1 + h, -(g + 1), order++, t]);
      }
      if (found >= 0) break;
    }
    for (const x of boxes) occupied[x] = 0;
    if (found >= 0) break;
    if (spent >= TOTAL_CAP) return null;
  }
  if (found < 0) return null;

  // The pushes, oldest first, then the walk to each push's square.
  const path: number[] = [];
  for (let s = found; s > 0; s = stParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes.slice();
  for (const s of path) {
    const step = stPush[s]!;
    const [dx, dy, , letter] = DIRS[step.dir]!;
    const d = dy * b.w + dx;
    for (const x of boxes) occupied[x] = 1;
    moves += walkTo(b, occupied, player, step.from - d);
    for (const x of boxes) occupied[x] = 0;
    moves += letter;
    player = step.from;
    boxes = stBoxes[s]!.slice();
  }
  return { pushes: path.length, moves };
}

// The level's rooms: cut the dead squares of the player's row (the hallway:
// a box there reaches no goal) out of the floor, and each part left that
// holds a box is a room, with its boxes and goals. Null when the split
// does not come out even, or a box starts in the hallway.
function roomsOf(b: Board): { boxes: number[]; goals: number[] }[] | null {
  const live = liveSquares(b);
  const row = Math.floor(b.player / b.w);
  const cut = new Uint8Array(b.size);
  for (let i = row * b.w; i < (row + 1) * b.w; i++) {
    if (!b.wall[i] && !live[i]) cut[i] = 1;
  }
  if (b.boxes.some((x) => cut[x])) return null;
  const part = new Int32Array(b.size).fill(-1);
  const rooms: { boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < b.size; s++) {
    if (b.wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * b.w + dx;
        if (!b.wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [] });
  }
  for (const x of b.boxes) rooms[part[x]!]!.boxes.push(x);
  for (const g of b.goals) {
    if (part[g] < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// Solve one level: room by room when it splits, else over the whole board.
// A room's search runs with the other rooms' boxes standing as walls (on
// their goals once their room is done), the player walking on from where
// the last room left it.
function solveLevel(text: string): string {
  const b = parseLevel(text);
  if (b.player < 0 || b.boxes.length === 0) return '';
  const rooms = roomsOf(b);
  if (rooms === null) {
    const whole = pushSearch(b, ASTAR_CAP, false) ?? pushSearch(b, GREEDY_CAP, true);
    return whole === null ? '' : whole.moves;
  }
  let player = b.player;
  let moves = '';
  const done: boolean[] = rooms.map(() => false);
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri]!;
    const wall = b.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      const other = rooms[oj]!;
      for (const x of done[oj] ? other.goals : other.boxes) wall[x] = 1;
    }
    const sub: Board = {
      w: b.w,
      h: b.h,
      size: b.size,
      wall,
      goals: room.goals.slice().sort((a, c) => a - c),
      boxes: room.boxes.slice().sort((a, c) => a - c),
      player,
    };
    const solved = pushSearch(sub, ASTAR_CAP, false) ?? pushSearch(sub, GREEDY_CAP, true);
    if (solved === null) return '';
    moves += solved.moves;
    // Where the player stands after these moves, on the full board.
    for (const ch of solved.moves) {
      const c = ch.toLowerCase();
      player += c === 'u' ? -b.w : c === 'd' ? b.w : c === 'l' ? -1 : 1;
    }
    done[ri] = true;
    if (spent >= TOTAL_CAP) return '';
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
