# Rampart Remake

Multiplayer-only recreation of the 1990 Atari arcade game _Rampart_, in TypeScript.
Shoot down opponents' castle walls, then race to rebuild your own before the next
barrage. Fail to seal a castle and you spend a life; run out of lives and you are out.

**`docs/PLAN.md` is the design and the open work** — read it before changing rules,
terrain or bots. **`docs/ARCHIVE.md`** records how each decision was reached, with the
measurements and the reverted attempts; consult it before re-trying something. This file
is the orientation.

## Commands

```bash
npm install
npm run check                       # format, lint, typecheck, test — must pass before committing
npm run build                       # client + server bundles, both needed by the image
npm run dev   -w @rampart/client    # play offline at http://localhost:5173
npm start     -w @rampart/server    # serves the built client at http://localhost:8080
npm start     -w @rampart/headless -- --matches 8 --players 3 --difficulty gunner --stats out.csv
npm start     -w @rampart/headless -- --map --players 3 --seed 2   # print a map as ASCII
```

`npm run check` takes a few minutes, mostly bot matches. Run it in the background and
wait rather than assuming it hung.

Client dev query parameters: `?autostart=1&players=3&seed=7`, `&snapshot=build` to jump
to a phase, `&speed=10`, `&style=flat|pixel`, `&watch=1&bots=marshal` to observe a bot
match. Online: `?host=8` opens a room, `?join=CODE` joins one, `&name=Bo` sets the name.
All are reachable from the menu too, which configures every seat individually.

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
them. The production image bundles the server with esbuild; development never does.

## Four things that are not negotiable

**The simulation is deterministic.** `(seed, ruleset, ordered input log)` must always
produce one identical match. The server sends _actions and the tick they landed on_, not
board state, and every client replays them — so any nondeterminism is a desync, not a
cosmetic bug. `Math.random`, `Date.now` and `performance` are banned in `sim` and `ai` by
lint rule. `Math.sin/cos/sqrt` are implementation-approximated per spec, so `trig.ts` and
`math.ts` provide exact replacements. Anything the sim must choose for a player comes
from `streamFor(seed, name)`. Every 30 ticks the server sends a state hash and clients
check it.

**Nothing derivable is transmitted.** Terrain and the piece queue are regenerated from
the seed. The ruleset travels in the snapshot, because a client on different rules would
desync rather than merely look wrong.

**No rule is hardcoded.** Every tunable lives in `config/*.json` behind a strict schema —
an unknown key is an error, not a silent default.

**The server owns identity.** It overwrites the `player` field of every incoming action
with the sender's seat, so a client cannot act for someone else.

## The rules, where they differ from expectation

Full detail in PLAN.md §1. The parts that surprise people:

- **One island, copied into a pattern.** A rectangular-ish island is drawn in a box,
  trimmed to its land, then stamped by translation and mirroring — both exact, so every
  island is pixel-identical at every player count. 2–8 players; grids at 2, 4, 6, 8 and
  rings at 3, 5, 7. **The map's size is measured from the island and the pattern, not
  configured.**
- **A wall must turn its corners.** The escape flood is 8-connected while the wall is
  not, so a diagonal join does not seal. The coastline is worth nothing.
- **Only walls are destructible**, and a shot removes exactly the tile it hits — and only
  an opponent's. `fire()` refuses your own island, and an eliminated player's rubble is
  indestructible.
- **Cannons go inert outside sealed territory.** This is the game's main corrective and
  the source of most bot trouble.
- **Flight time _is_ the reload** — a cannon cannot fire again until its shot lands.
- **The starting ring is 8x8 around a 6x6 interior.** A castle sits centred in it, so the
  free band is two tiles wide and a 2x2 cannon spans it: opening cannons must touch the
  wall. Geometry, not a bot failing.
- **Continues**: failing to seal spends a life, wipes the island, and hands back a fresh
  castle and ring. It also rewinds that player's piece schedule to round 1, which is why
  `build.sharedPieceSequence` is false.
- **Orphaned wall is swept in one pass**: blocks with fewer than two orthogonal wall
  neighbours are marked against the board as it stands, then go together. A run of three
  keeps its middle. Stranded wall stays as an obstacle.
- **The piece set widens by round**, and one-cell pieces stop being dealt after the early
  rounds — so a one-tile gap with no free neighbour can never be filled.

## Status

**M0–M5 done.** M6 done but for audio files: deployment (`Dockerfile`, one process,
verified by a CI job since there is no Docker on this machine), audio wired end to end,
2–8 players, and the lobby (tested at eight seats over a real socket; code copying, seat
colours, tier descriptions).

**M7, the balance pass, is where the work is.** PLAN.md §11 lists it in priority order:

1. **Round cap and points scoring** — the rules are built (§11.1a); host-settable lobby
   settings (§11.1b) are not. A match ends
   after `maxRounds` or when one player is left; if two or more remain the highest score
   wins. Measured beforehand: most matches would reach the cap, so **the scoring formula
   becomes the game's balance** rather than a tie-breaker.
2. **Teach the bots to play for points.** Deliberately second, and it blocks tuning: a
   soak cannot tell whether the weights are right while bots optimise for survival.
3. **Two-player balance** — the worst thing in the project. 33.8 rounds, three of ten
   unfinished, cannon room 0.7. Three players is fine at 12.3.
4. Measurements never taken: seat bias, the difficulty ladder on the current map.

**No audio files exist yet** beyond two test files; the user is producing them, and
missing files are silent by design. `assets/audio/README.md` lists every cue.

## Measuring the bots

`npm start -w @rampart/headless -- --stats FILE` writes a row per player per round,
sampled at the resolution that ends each build phase — castles sealed, cannons owned and
active, cannon room, wall tiles, pieces placed against the pieces the tier had time for.
A summary goes to the console. `--difficulty marshal,gunner,recruit` sets each seat
separately. Prefer this to watching; watching is for forming the hypothesis.

## What has already been tried, so it is not tried again

- **Scaling fire rate with cannon count** made matches _longer_ and flattened the skill
  ordering. Reverted.
- **Ambition is a liability for survival**: a marshal walling three castles lost to a
  gunner walling two, so it is bounded at two. Expect points scoring to invert this.
- **Making gunner purely defensive** produced six draws in eighteen — a turtle is very
  hard to kill.
- **Three castles per island rather than four, closer together.** Measured and reverted:
  gunner went from one unfinished match in eight to five in six. Fewer castles means
  fewer candidate walls and the survivors are tighter.
- **Widening the starting ring to 10x10** fixed opening cannon clearance and was reverted
  for fidelity to the original; continues absorb the early knockouts it guarded against.
- **Raising flight time further** to force exactly three salvos drops the rate below the
  original's three and makes close shots slower. The spread of ranges makes "exactly
  three for everyone" unreachable without flattening distance-scaling entirely.

## Hard-won gotchas

- **A minimum cut is the _tightest_ wall that works** — exactly the wall with nowhere to
  put a gun, and the most fragile one. Nearly every bot problem traces back to this.
- **`cannonsToPlace` is zero for the whole build phase**; it is set at the resolution that
  ends it. Judge cannon room against the reward about to be earned.
- **`enclosedCastles` is live during a build phase**, so it is legitimately 0 mid-repair.
  Do not assert on it except at a resolution.
- **Headless Chrome cannot verify anything time-dependent in the client.** A watched match
  is still on round 0 after 120s of virtual time at 10x speed. It catches a crash on load
  and nothing else — pull the logic into a pure function and test that, as `banners.ts`
  and `lobby.ts` do.
- **A test asserting "failing to seal ends your match" needs `withoutContinues`**, and so
  does anything measuring the piece-size ramp: a continue rewinds the schedule, so the
  build rate climbs back instead of falling.
- **Tune shot flight against round one, not the match average.** The average hid long guns
  firing twice while close ones fired six times.
- **A one-tile gap between a cannon and water cannot be filled** once one-cell pieces stop
  being dealt. That is why `placeCannon` weighs clearance from wall and shore ahead of
  range.
- **Anything visual scaled by flight time breaks when the reload is tuned.** The shot arc
  went off-screen when flight tripled; it follows range now (`shotLift` in `theme.ts`).
- **`Int32Array.fill(Number.MAX_SAFE_INTEGER)` truncates to -1**, which silently disabled
  target selection for an entire tuning session.
- **Measure both seats.** Position carries a real advantage; a 19-1 record looked like a
  coin toss when only seat 0 was tested.
- **"Fits" and "varies" are different questions.** An island that nearly fills its box
  generates fine and produces the _same map for every seed_.
- **Prettier reflows code, so string-replace patches silently miss.** Assert on every
  replacement.
- **The static handler answers an unknown path with `index.html` and a 200.** A missing
  asset is not a 404 — audio decides a file is absent by its failure to decode.
- **Check nothing stale is answering.** A git worktree sharing the main checkout's
  `node_modules` resolves `@rampart/*` back into the working tree and measures the new
  code twice; a server left running on 8080 answers instead of the one you just built.
  Identical state hashes either side of a change mean the code did not load.
- Removing a rectangle's **corner** does not breach it under 4-connectivity; use a
  mid-edge tile in tests.

## Conventions

Comments explain _why_, not _what_, and record measurements where a number was chosen by
experiment. Commit messages are prose explaining the reasoning and what was measured.
Tests state expectations as ASCII pictures where the subject is geometric
(`stateFromAscii` in `sim/testing.ts`). Findings that are deferred go into `docs/PLAN.md`
rather than being left in chat; completed work is summarised into `docs/ARCHIVE.md`.
