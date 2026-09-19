# Rampart Remake

Multiplayer-only recreation of the 1990 Atari arcade game _Rampart_, in TypeScript.
Shoot down opponents' castle walls, then race to rebuild your own before the next
barrage. Fail to seal a castle and you are out.

`docs/PLAN.md` is the design record and the source of truth: sections 10a-10g hold the
decisions and measurements behind everything below, and are worth reading before
changing rules, terrain or bots. This file is the orientation.

## Commands

```bash
npm install
npm run check                       # format, lint, typecheck, test — must pass before committing
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

- **Sectors, not islands.** The map is divided into N equal wedges meeting at the centre,
  separated by a 2-tile channel, rotationally symmetric so no seat is favoured. 56x56
  grid, ~440 tiles a player, four 2x2 castles each.
- **A wall must turn its corners.** The escape flood is 8-connected while the wall is
  not, so a diagonal join does not seal. The coastline is worth nothing — water is
  traversable, so enclosure needs a complete loop on land.
- **Only walls are destructible.** Castles and cannons are indestructible; a shot removes
  exactly the tile it hits.
- **Cannons go inert outside sealed territory**, including the opening three you place
  yourself. This is the game's main corrective, and the source of most bot trouble.
- **Orphaned wall is swept** between build and combat: anything with fewer than two
  orthogonal wall neighbours goes (repeatedly, so dead ends unravel), and what survives
  must reach sealed ground through other wall. A loop that encloses something is safe by
  construction.
- **The piece set widens by round** (sizes 1-3 early, 3-5 late), which is the game's
  difficulty ramp. `pieceAt(ruleset, seed, round, index)` is a pure function.
- Phases: castle select 15s, cannon place 25s, combat 10s, build 20s, each preceded by an
  intermission that waits for shots to land, pauses, then runs the announcement.

## Status

M0-M5 are done: scaffold, simulation, local play, two visual styles, online multiplayer,
and bots. **M6 is next** — audio has a manifest and schema but _no playback code at all_,
there is no Dockerfile, and the lobby is functional but bare. M7 is the balance pass.

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

### Known weaknesses, observed by the user while watching matches

These are the current top priority and are **not yet fixed**:

1. **Recruit** encloses its starting castle and cannons correctly, but **does not expand**,
   and **stops placing tiles entirely once its enclosure is valid** — wasting most of the
   build phase.
2. **Gunner and marshal** tend to enclose _a different_ castle with minimal tile
   placement, **leaving no room for cannons at all**. With no firepower on either side,
   matches stalemate.
3. Consequence: recruit matches finish in ~3 rounds, but gunner and marshal matches
   frequently do not finish at all.

Note these observations predate the most recent fixes (`ROOM_RADIUS` in `bot.ts`, which
makes the planner demand a band of ground around each castle, and the stranded-gun
recovery path). **Re-observe before acting** — set every seat to a bot and use
`&watch=1`.

### What has already been tried, so it is not tried again

- **Scaling fire rate with cannon count** made matches _longer_ and flattened the skill
  ordering. Reverted.
- **Ambition is a liability**: a marshal walling three castles lost to a gunner walling
  two. Bounded at two.
- **Making gunner purely defensive** produced six draws in eighteen — a turtle is very
  hard to kill.
- **Raising fire rates to human clicking speed** changed nothing about stalemates; damage
  is not the constraint.
- The **next untried lever** is three castles rather than four, closer together, so one
  barrage threatens more than one at a time. Four spread-out castles give a near-optimal
  planner four independent chances and it only needs one.

## Hard-won gotchas

- **A minimum cut is the _tightest_ wall that works** — which is exactly the wall with
  nowhere to put a gun, and the most fragile one. Nearly every bot problem traces back to
  this.
- **`cannonsToPlace` is zero for the whole build phase**; it is set at the resolution that
  ends it. Judge cannon room against the reward about to be earned.
- **`enclosedCastles` is live during a build phase**, so it is legitimately 0 mid-repair.
  Do not assert on it except at a resolution.
- **`Int32Array.fill(Number.MAX_SAFE_INTEGER)` truncates to -1**, which silently disabled
  target selection for an entire tuning session.
- **Measure both seats.** Position carries a real advantage on a symmetric map; a 19-1
  record looked like a coin toss when only seat 0 was tested.
- **"Fits" and "varies" are different questions.** An island that nearly fills its sector
  generates fine and produces the _same map for every seed_.
- **Prettier reflows code, so string-replace patches silently miss.** Assert on every
  replacement.
- Removing a rectangle's **corner** does not breach it under 4-connectivity; use a
  mid-edge tile in tests.

## Conventions

Comments explain _why_, not _what_, and record measurements where a number was chosen by
experiment. Commit messages are prose explaining the reasoning and what was measured.
Tests state expectations as ASCII pictures where the subject is geometric (`stateFromAscii`
in `sim/testing.ts`). Findings that are deferred get written into `docs/PLAN.md` rather
than left in chat.
