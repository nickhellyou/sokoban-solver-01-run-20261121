# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/nickhellyou/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/nickhellyou/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban
solver, 21 November 2026" bounty. It answers a whole set of 5 levels in
one run: `main.ts` reads `/input/<id>/level.txt` (XSB) and writes
`/output/<id>/solution.txt`, the player's moves in LURD, with as few
pushes as possible.

## How it works

A level is a hallway with one to four rooms off it, and a box pushed out
of a room's door into the hallway can never come back, so the rooms are
independent: the level's push-optimum is the sum of the rooms' optima.
The solver splits a level into rooms (cutting the hallway's dead squares
out of the floor), solves each room on its own, and walks the player from
room to room through the hallway.

Inside a room the search is over pushes only: a state is the boxes'
squares plus the player's reachable region (named by its lowest square),
and the estimate is the cheapest assignment of boxes to goals under the
floor distances, which no single push can shrink by more than one, so the
first solved state A\* meets is push-optimal. Two deadlocks are pruned:
a box on a square from which no pull chain reaches a goal, and a box
caught in a frozen 2 x 2 block of walls and boxes. If a level does not
split into rooms, the same search runs over the whole board, and a greedy
best-first pass is the fallback when A\* spends its work budget.

Everything is budgeted by work (states expanded), never by the clock, so
two runs write the same bytes.

## Results

- Practice set: **1,000,000 / 1,000,000** — every instance solved in
  exactly its push-optimal count (13, 16, 29, 47, 60 pushes), in about
  0.4 seconds for the whole set.
- 16 further sets drawn from the published generator with fresh seeds:
  **1,000,000** on all of them, worst set 0.5 seconds, deterministic
  (byte-identical across runs).

## Run it

```sh
node main.ts
```

`main.ts` reads the levels from `/input/<id>/level.txt` (or
`$MAKEFUN_INPUT_DIR/<id>/level.txt` outside a container) and writes each
answer to `/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`). Node
22, standard library only, no dependencies, no network.

## Layout

- `main.ts` — the solver and driver.
- `package.json` — `{"type": "module"}`, so the entry point loads as
  one ES module.
- `.makefun/owner.json` — the payout wallet that signs the entry.

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
