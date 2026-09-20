# Rampart Remake

Multiplayer-only recreation of the 1990 Atari arcade game _Rampart_, in TypeScript.
Shoot down opponents' castle walls, then race to rebuild your own before the next
barrage. Fail to seal a castle and you are out.

`docs/PLAN.md` is the design record and the source of truth: sections 10a-10o hold the
decisions and measurements behind everything below, and are worth reading before
changing rules, terrain or bots. This file is the orientation.

## Commands

```bash
npm install
npm run check                       # format, lint, typecheck, test — must pass before committing
npm run build                       # client bundle + server bundle, both needed by the image
npm run dev   -w @rampart/client    # play offline at http://localhost:5173
npm run build -w @rampart/client    # required before the server can serve it
npm start     -w @rampart/server    # play online at http://localhost:8080
npm start     -w @rampart/headless -- --matches 5 --players 3 --difficulty marshal
npm start     -w @rampart/headless -- --map --players 3 --seed 2   # print a map as ASCII
```

Client dev query parameters: `?autostart=1&players=3&seed=7`, `&snapshot=build` to jump
to a phase, `&speed=10`, `&style=flat|pixel`, `&watch=1&bots=marshal` to observe a bot
match. All are also reachable from the menu, which configures every seat individually.

`npm run check` takes a few minutes, mostly bot matches. Run it in the background and
wait rather than assuming it hung.

## Layout

| Package          | Contents                                                                   |
| ---------------- | -------------------------------------------------------------------------- |
| `config`         | Zod schemas, typed defaults, cross-file validation. Reads `config/*.json`. |
| `sim`            | The deterministic game core. No DOM, no Node, no I/O.                      |
| `protocol`       | Wire messages and validators.                                              |
| `ai`             | Bots: min-cut sealing, 0-1 BFS attack, difficulty tiers.                   |
| `server`         | Authoritative match server, rooms, WebSocket.                              |
| `client`         | Pixi renderer, two visual styles, controls, HUD, netcode client.           |
| `tools/headless` | Bot-vs-bot soak runs and map dumps.                                        |

Internal packages export TypeScript source directly, so there is no build step between
them.

## Four things that are not negotiable

**The simulation is deterministic.** `(seed, ruleset, ordered input log)` must always
produce one identical match. The server sends _actions and the tick they landed on_, not
board state, and every client replays them — so any nondeterminism is a desync, not a
cosmetic bug. `Math.random`, `Date.now` and `performance` are banned in `sim` and `ai` by
lint rule. `Math.sin/cos/sqrt` are implementation-approximated per spec, so `trig.ts` and
`math.ts` provide exact replacements; use those. Every 30 ticks the server sends a state
hash and clients check it.

**Nothing derivable is transmitted.** Terrain and the piece queue are regenerated from
the seed. The ruleset travels in the snapshot, because a client on different rules would
desync rather than merely look wrong.

**No rule is hardcoded.** Every tunable lives in `config/*.json` behind a strict schema —
an unknown key is an error, not a silent default.

**The server owns identity.** It overwrites the `player` field of every incoming action
with the sender's seat, so a client cannot act for someone else.

## The rules, where they differ from expectation

- **One island, copied into a pattern.** A rectangular-ish island is drawn inside a box,
  trimmed to its land, then stamped into N placements by translation and mirroring — both
  exact, so every island is pixel-identical at **every** player count. **2-8 players**, all
  playable; grids at 2, 4, 6, 8 and rings at 3, 5, 7, from the `patterns` table in
  `config/terrain.default.json`. ~440 tiles a player, four 2x2 castles each, a 2-tile
  channel. **The map's size is measured from the island and the pattern, not configured**
  — 52x25 at two players, 102x48 at eight. See PLAN.md 10l.
- **A wall must turn its corners.** The escape flood is 8-connected while the wall is
  not, so a diagonal join does not seal. The coastline is worth nothing — water is
  traversable, so enclosure needs a complete loop on land.
- **Only walls are destructible.** Castles and cannons are indestructible; a shot removes
  exactly the tile it hits.
- **Continues.** Failing to seal spends a life (default 2) rather than ending the match:
  the island is wiped, a castle is chosen again during the next cannon phase, a fresh
  ring goes up, and the player places `startingCount + livesSpent` cannons. It also
  **rewinds that player's piece schedule to round 1**, which is why
  `build.sharedPieceSequence` is now false — players no longer draw the same bag, and the
  schema refuses the two being true together. PLAN.md 10o.
- **Cannons go inert outside sealed territory**, including the opening three you place
  yourself. This is the game's main corrective, and the source of most bot trouble.
- **Orphaned wall is swept** between build and combat, in **one pass**: every block with
  fewer than two orthogonal wall neighbours is marked against the board as it stands,
  then the marked blocks go together. So a run of three keeps its middle, and a spur
  loses only its tip — cascading instead took far too much and meant half-built wall
  could never carry across a round (PLAN.md 10n). Stranded wall is left alone as an
  obstacle. A loop that encloses something is safe by construction.
- **The piece set widens by round** (sizes 1-3 early, 3-5 late), which is the game's
  difficulty ramp. `pieceAt(ruleset, seed, round, index)` is a pure function.
- Phases: castle select 15s, cannon place 25s, combat 10s, build 20s, each preceded by an
  intermission that waits for shots to land, pauses, then runs the announcement.

## Status

M0-M5 are done: scaffold, simulation, local play, two visual styles, online multiplayer,
and bots. **M6 is in progress**: deployment is done (`Dockerfile`, one process serving
the built client and the WebSocket, verified by a CI job because there is no Docker on
this machine — PLAN.md 10i), and audio is wired end to end (PLAN.md 10j). **No audio
files exist yet**; the user is producing them, and missing files are silent by design, so
the game plays exactly as before until they land. `assets/audio/README.md` lists every
cue and what fires it. **The lobby is what remains** — functional but bare. M7 is the
balance pass, and it now has a real question waiting for it: see "What is now the top
priority" below.

## Bots: how they work, and why they are still weak

In `packages/ai`. They play through the same validated action API as a person and never
ask for a move the rules refuse.

- **Sealing is a minimum cut.** Enclosure is an escape flood, so sealing is cutting every
  path; buildable tiles get capacity 1, everything else infinity, and the min cut between
  border and castle is the smallest wall that works. Built over the bot's own sector only.
- **Attacking is a 0-1 BFS** from the border, free across open ground and 1 per wall
  block, which finds the thinnest part of a defence.
- **Pace is in human units** (`config/ai.default.json`): milliseconds per placement,
  scaling with piece size, so a bot lays ~20 pieces in an early build phase and ~8 late,
  against a person's 25-then-15.

### The minimal-enclosure problem, and how it was fixed

The weaknesses watched matches showed — bots walling a castle as tightly as possible,
with no room for cannons, and standing idle once sealed — were real, and section 10h of
`docs/PLAN.md` records the fix and the measurements. The short version:

Sealing is a minimum cut, and a minimum cut is the _tightest_ wall that works. So a
planner handed the cut always asks for the wall with nowhere to put a gun. `ROOM_RADIUS`
had been added to three of the six planning call sites; the three it missed were the
ones that matter — reseal after a breach, the steady-state hold, and the castle choice
itself. **`widestAffordable` now asks for room first and gives it up a tile at a time
until the plan fits the phase's budget**, so a tight wall is the last rung rather than
the first. A bot that has finished its plan thickens rather than stops.

Two later fixes matter as much (PLAN.md 10m): **one shot per tile**, since a shot
destroys exactly the tile it hits so a second is always wasted, and **`spareWork`**, so a
bot whose plan is standing reaches for the next castle or takes in more open ground
rather than idling. Gunner's build-phase use went 58% to 121% and its room 1.7 to 7.6.

**`ROOM_RADIUS` is 3.** It was 2 on the wedge map; a compact rectangle makes a tight cut
cheaper, so the same constant meant something different and had to be re-swept. Every
number quoted in PLAN.md 10h and 10k was measured on the wedge map and is historical.

### What is now the top priority

**Two-player balance.** Bots used to fire their whole opening salvo into one wall block;
one shot per tile is now enforced, which multiplied real damage several times over
(PLAN.md 10m). Three players is in good order — marshal runs 4.6 rounds over eight seeds,
none unfinished, 3.14 shots per cannon, wins spread 4/2/2 across the seats. **Two players
is erratic**: over six seeds, two were decided in round one and one ran to the tick limit.

Flight time is _not_ the lever — it is correctly calibrated to the original's three shots
per cannon, and raising it further drops the rate below that. What is unbalanced is the
damage those three shots now do. The levers are the opening cannon count, the build phase
against the combat phase, and `cannons.maxTotal`, still `null`.

Three bot competence tests moved from two-seat to three-seat tables, because on two
players they were measuring this rather than the bot.

### Measuring the bots

`npm start -w @rampart/headless -- --stats FILE` writes a row per player per round,
sampled at the resolution that ends each build phase — castles sealed, cannons owned and
active, cannon room, wall tiles, pieces placed against the pieces the tier had time for.
A summary goes to the console. `--difficulty marshal,gunner,recruit` sets each seat
separately. Prefer this to watching; watching is for forming the hypothesis.

### What has already been tried, so it is not tried again

- **Scaling fire rate with cannon count** made matches _longer_ and flattened the skill
  ordering. Reverted.
- **Ambition is a liability**: a marshal walling three castles lost to a gunner walling
  two. Bounded at two.
- **Making gunner purely defensive** produced six draws in eighteen — a turtle is very
  hard to kill.
- **Raising fire rates to human clicking speed** changed nothing about stalemates; damage
  is not the constraint.
- **Three castles rather than four, closer together** — the lever section 10g proposed
  next. Measured and reverted: gunner went from one unfinished match in eight to five in
  six, and room for a cannon fell for both tiers. Fewer castles means fewer candidate
  walls and the survivors are tighter, which is the opposite of what 10h needed.

## Hard-won gotchas

- **A minimum cut is the _tightest_ wall that works** — which is exactly the wall with
  nowhere to put a gun, and the most fragile one. Nearly every bot problem traces back to
  this.
- **`cannonsToPlace` is zero for the whole build phase**; it is set at the resolution that
  ends it. Judge cannon room against the reward about to be earned.
- **`enclosedCastles` is live during a build phase**, so it is legitimately 0 mid-repair.
  Do not assert on it except at a resolution.
- **Headless Chrome cannot verify anything time-dependent in the client.** A watched
  match is still on round 0 after 120s of virtual time at 10x speed, because the render
  loop is barely driven. It catches a crash on load and nothing else — pull the logic out
  into a testable function instead, as `banners.ts` does.
- **A test asserting "failing to seal ends your match" needs `withoutContinues`.** That is
  only true once a player's lives are gone, and nine tests had to say so.
- **`Int32Array.fill(Number.MAX_SAFE_INTEGER)` truncates to -1**, which silently disabled
  target selection for an entire tuning session.
- **Measure both seats.** Position carries a real advantage on a symmetric map; a 19-1
  record looked like a coin toss when only seat 0 was tested.
- **"Fits" and "varies" are different questions.** An island that nearly fills its sector
  generates fine and produces the _same map for every seed_.
- **Prettier reflows code, so string-replace patches silently miss.** Assert on every
  replacement.
- **The static handler answers an unknown path with `index.html` and a 200.** So a
  missing asset is not a 404 — audio decides a file is absent by its failure to decode,
  and anything else fetched at runtime needs the same care.
- **A/B a change in a git worktree with its own `node_modules`.** Workspace links are
  relative, so a worktree pointed at the main checkout's `node_modules` resolves
  `@rampart/*` back into the working tree and silently measures the new code twice.
  Identical state hashes either side of a change mean the code did not load.
- Removing a rectangle's **corner** does not breach it under 4-connectivity; use a
  mid-edge tile in tests.

## Conventions

Comments explain _why_, not _what_, and record measurements where a number was chosen by
experiment. Commit messages are prose explaining the reasoning and what was measured.
Tests state expectations as ASCII pictures where the subject is geometric (`stateFromAscii`
in `sim/testing.ts`). Findings that are deferred get written into `docs/PLAN.md` rather
than left in chat.
