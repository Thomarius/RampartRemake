# Rampart Remake — Implementation Plan

A multiplayer-only recreation of the 1990 Atari arcade game _Rampart_, condensed to a
single game mode, with online play, AI opponents, and fully procedural visual assets.

---

## 1. Design summary

### 1.1 Match structure

2–4 players, free-for-all. Empty slots are filled by AI. The data model is team-aware
from the start so 2v2 can be added later without a refactor, but no team mode ships in v1.

Phase loop (all phases are simultaneous and real-time for every player):

```
LOBBY
  -> CASTLE_SELECT      (15s)  pick 1 of the castles on your island
  -> [auto wall ring + 2 cannons granted]
  -> COMBAT             (30s)  click targets, cannons lob shots at enemy walls
  -> BUILD              (25s)  place tetromino wall pieces on your island
  -> [enclosure resolved; players with 0 enclosed castles are eliminated]
  -> CANNON_PLACE       (10s)  place your earned cannons inside your territory
  -> COMBAT ...
  -> GAME_OVER          last player standing; simultaneous elimination = draw
```

### 1.2 Map

- Square tile grid, default 80x80.
- Each player owns one **island**, fully separated by water. Islands are **rotational
  copies** of a single procedurally generated shape, placed at `360/N` degree intervals
  around the map centre. This guarantees identical area, castle layout and sightlines.
- Each island carries the same number of castles (default 3).
- No fog of war; every island is fully visible to everyone.

### 1.3 Walls and enclosure

- Walls may only be placed on **free land tiles of your own island**. You cannot build in
  or interfere with an opponent's territory.
- **The shoreline does not count as wall.** Enclosure requires a complete wall loop on
  land. Formally: flood-fill 4-connected from the map border across every tile that is not
  a wall — water included — and any castle not reached is enclosed.
- A single sealed region containing K castles counts as K castles. Separate sealed regions
  stack. This is the central tradeoff: a wide loop earns more cannons but leaves far more
  perimeter to repair each round.

### 1.4 Cannons

- 2x2 footprint, placed inside your own enclosed territory.
- **Indestructible.** Only walls are damaged by cannon fire; castles and cannons are not.
- Reward per build phase: `2 cannons for the first enclosed castle, +1 per additional`.
  0 enclosed castles = elimination.
- A cannon **not inside an enclosed region** at round resolution is **inert**: it cannot
  fire, but is not destroyed and reactivates if you re-enclose it. Breaching a leader's
  wall silences their guns.
- Beyond that rule, balance is expected to come from the players, as in the original: with
  3+ players alive, the leader draws everyone's fire. Once a match is down to two this no
  longer applies, which is acceptable — by then matches are meant to end quickly.
- Firing: click a target tile; the **nearest ready cannon** fires. A cannon is ready only
  when it has no shot in flight — there is no separate reload.
- Flight time scales with distance: `ticks = ceil((baseMs + perTileMs * dist) / tickMs)`.
  Unlimited range. Impact craters the target tile plus its 4 orthogonal neighbours.

### 1.5 Build pieces

- Tetromino-like wall pieces. All players receive the **same seeded sequence** — fairness
  is not left to chance.
- Next-piece preview. No skip, no discard, no hold.

---

## 2. Technology

| Layer      | Choice                                            | Rationale                                                                                                                                                                                       |
| ---------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language   | TypeScript **5.9.3**, end to end                  | One simulation shared by server, client, AI and tests. Pinned below 6: TypeScript 7 is released, but `typescript-eslint@8` still declares `typescript <6.1.0`, so adopting 7 would cost linting |
| Client     | Vite + PixiJS v8                                  | WebGL batching and filters for shots/explosions/water                                                                                                                                           |
| Server     | Node + `ws`                                       | Tiny protocol surface; a hand-rolled room layer beats fighting a framework's state-schema system on a tile grid                                                                                 |
| Transport  | WebSocket, JSON v1                                | Input rate is ~1 message/sec/player; binary is unnecessary                                                                                                                                      |
| Validation | zod, server-side                                  | Never trust a client message                                                                                                                                                                    |
| Tests      | vitest                                            | Fast, TS-native                                                                                                                                                                                 |
| Packaging  | npm workspaces                                    | `pnpm` is not installed on the dev machine; npm 11 is, and handles a 6-package monorepo fine                                                                                                    |
| Deploy     | Docker, single process serving static client + WS | Fly.io / Railway / self-host                                                                                                                                                                    |

Authoritative server, **no rollback netcode needed**. Both phases are simultaneous but not
twitchy, and a shot's 0.5–1.5s flight time absorbs RTT entirely.

---

## 3. Repository layout

```
RampartRemake/
├── config/
│   ├── ruleset.default.json     # all game rules & timings
│   ├── terrain.default.json     # map generation parameters
│   ├── art.default.json         # palettes, sprite generator parameters
│   ├── audio.manifest.json      # audio cue -> file mapping
│   └── server.default.json      # ports, room limits, rate limits
├── assets/
│   └── audio/                   # user-supplied audio files (gitignored placeholders)
├── packages/
│   ├── config/                  # zod schemas, typed defaults, cross-file validation
│   ├── sim/                     # deterministic game core — no DOM, no Node
│   ├── protocol/                # wire message types + zod schemas
│   ├── ai/                      # bot logic against the sim interface
│   ├── server/                  # ws server, rooms, tick loop
│   └── client/                  # Pixi renderer, UI, procedural asset generators
├── docs/
│   └── PLAN.md
└── tools/
    └── headless/                # CLI match driver for testing & AI tuning
```

`packages/sim` is the entire game. Everything else is I/O.

---

## 4. Configuration

Every tunable lives in `config/*.json`, is validated by a zod schema, and is **sent to
clients in the match snapshot** so both sides run one identical ruleset. A lobby host may
override a whitelisted subset (M4).

`packages/config` owns the schemas and is the only package that reads these files. Schemas
are **strict**: an unknown key is an error, not a silently ignored one, so a typo in a
config file fails at startup instead of quietly changing the game. Defaults are parsed at
module load. Constraints that span more than one file — can N islands of this size fit on
this grid with water between them? are there enough player palettes? does the audio
manifest cover every cue the code can trigger? — live in `validateConfigBundle`.

### `config/ruleset.default.json`

```json
{
  "tickRateHz": 30,
  "players": {
    "min": 2,
    "max": 4
  },
  "phases": {
    "castleSelectMs": 15000,
    "combatMs": 30000,
    "buildMs": 25000,
    "cannonPlaceMs": 10000
  },
  "cannons": {
    "startingCount": 2,
    "firstCastleReward": 2,
    "perAdditionalCastleReward": 1,
    "footprint": [2, 2],
    "inertWhenNotEnclosed": true,
    "maxTotal": null
  },
  "shots": {
    "baseFlightMs": 350,
    "perTileFlightMs": 35,
    "maxRangeTiles": null,
    "craterPattern": "plus5",
    "damagesWalls": true,
    "damagesCastles": false,
    "damagesCannons": false
  },
  "build": {
    "sharedPieceSequence": true,
    "previewCount": 1,
    "allowSkip": false,
    "restrictToOwnIsland": true,
    "sequenceLength": 4096,
    "pieces": [
      {
        "name": "i3",
        "weight": 8
      },
      {
        "name": "l3",
        "weight": 10
      },
      {
        "name": "o4",
        "weight": 10
      },
      {
        "name": "i4",
        "weight": 8
      },
      {
        "name": "t4",
        "weight": 10
      },
      {
        "name": "s4",
        "weight": 7
      },
      {
        "name": "z4",
        "weight": 7
      },
      {
        "name": "j4",
        "weight": 9
      },
      {
        "name": "l4",
        "weight": 9
      },
      {
        "name": "p5",
        "weight": 5
      },
      {
        "name": "u5",
        "weight": 4
      }
    ]
  },
  "enclosure": {
    "shorelineCountsAsWall": false,
    "connectivity": 4,
    "sharedRegionCountsAllCastles": true
  },
  "elimination": {
    "onZeroEnclosedCastles": true,
    "simultaneousIsDraw": true
  }
}
```

### `config/terrain.default.json`

```json
{
  "gridWidth": 80,
  "gridHeight": 80,
  "layout": "rotational",
  "island": {
    "targetAreaTiles": 420,
    "areaTolerance": 0.08,
    "noiseOctaves": 4,
    "noiseFrequency": 0.08,
    "coastlineRoughness": 0.55,
    "minWaterGapTiles": 6,
    "erosionPasses": 2
  },
  "castles": {
    "perIsland": 3,
    "footprint": [3, 3],
    "minSpacingTiles": 7,
    "minDistanceFromShoreTiles": 3
  },
  "startingWall": {
    "ringRadiusTiles": 3
  },
  "generation": {
    "maxRetries": 50
  }
}
```

### `config/art.default.json`

Arcade-era base palette, per-player hue rotations, tile pixel size (16), sprite generator
parameters (tower counts, battlement rhythm, dithering thresholds, water animation frame
count), atlas dimensions.

---

## 5. `packages/sim` — the deterministic core

### 5.1 State representation

Static, generated once from the seed:

```ts
terrain: Uint8Array; // WATER | LAND
islandId: Uint8Array; // 0 = water, 1..N = owning player's island
```

Dynamic:

```ts
structure: Uint8Array; // EMPTY | WALL | CASTLE | CANNON
owner: Uint8Array; // 0 = neutral, 1..N
territory: Uint8Array; // recomputed each resolution: enclosed-region owner, 0 = outside
```

Entities: `Castle[]`, `Cannon[]`, `Shot[]`, `PlayerState[]`.

```ts
interface MatchState {
  seed: number;
  tick: number;
  round: number;
  phase: Phase;
  phaseEndTick: number;
  ruleset: Ruleset;
  players: PlayerState[];
  grid: GridLayers;
  castles: Castle[];
  cannons: Cannon[];
  shots: Shot[];
  rng: RngStreams; // separate streams: terrain, pieceQueue, cosmetic
}
```

### 5.2 Determinism rules

- Fixed 30Hz integer tick counter; nothing reads wall-clock time.
- Seeded PCG32; `Math.random` is banned by lint rule.
- All durations stored as tick counts, never milliseconds, inside state.
- Separate RNG streams so a cosmetic change cannot shift the piece sequence.
- Invariant: `(seed, ruleset, ordered input log) -> identical final state hash`. Enforced
  by test, and the basis of the whole regression suite.

### 5.3 Core algorithms

**Enclosure solver** — the most important function in the codebase.

```
resolveEnclosure(state):
  outside = BFS from every border tile, 4-connected,
            over all tiles where structure != WALL   (water is traversable)
  regions = connected components of (not outside)
  for each region: owner = island owner if it contains >=1 castle of that island
  for each castle: enclosed = its tiles are not in `outside`
  for each cannon: active = all footprint tiles lie in an enclosed region it owns
  for each player: enclosedCastles = count -> reward or elimination
```

Complexity O(W*H) per resolution, run once per build phase. Trivial at 80x80.

**Placement validation**

```
canPlacePiece(state, player, piece, x, y, rot):
  every cell is in-bounds, LAND, EMPTY, and islandId == player's island

canPlaceCannon(state, player, x, y):
  2x2 all in-bounds, LAND, EMPTY,
  and every cell's territory == player  (i.e. inside a sealed region)

canFire(state, player, tx, ty):
  player has >=1 active cannon with no shot in flight
  target in-bounds (and within maxRangeTiles if configured)
```

**Shot resolution** — on `fire`, pick the nearest ready active cannon by squared distance
(ties broken by cannon id, for determinism), compute `impactTick`, push a `Shot`. On the
tick matching `impactTick`, apply the crater pattern to wall tiles only and free the cannon.

**Terrain generation**

1. Seeded fBm noise, thresholded by binary search so the island hits the requested area.
2. Largest connected component only, then erosion passes to smooth the coast and fill pinholes.
3. Castle siting by farthest-point sampling, respecting `minSpacingTiles`, shore distance, and
   requiring the whole starting-ring block to be solid ground — every castle must be a viable
   opening choice, or a player could pick a coastal one and begin the match already breached.
4. Replicate: rotate the finished raster into N copies about the map centre.
5. Re-validate and repair (see below), then check island areas, connectivity and the water gap.
   Reject the seed and draw another if any constraint fails.

**Rotation is exact for 2 and 4 players, approximate for 3.** Quarter turns map grid points to
grid points, so those islands are pixel-identical copies with zero area difference. 120 degrees
has no exact representation on a square grid, so the rotated copies are rasterised independently
and differ by a few tiles.

That rounding can drop a tile of a castle's starting-ring block into the water. Two ways to
prevent it were measured:

- _Guarantee it from the canonical island_ — demand a clear region large enough to survive any
  rotation. The preimage of a rotated 9x9 block is a rotated square spanning a disc of radius
  5.7, so three castles would need islands roughly twice the size. Measured: every seed rejected
  at the shipped island size, and only a 96x96 grid with 700-tile islands succeeded.
- _Rotate, then repair_ — fill the handful of water tiles that land inside a ring block.
  Measured: 3-player maps repair about 6 tiles of 420, a worst-case area spread of 2.4%, well
  inside the 8% tolerance. 2- and 4-player maps repair nothing at all.

The second is implemented. It keeps the map at 80x80 and guarantees what actually matters —
every castle is playable — at the cost of islands that are congruent rather than identical for
3 players, which is what "almost equal" was always going to mean on a square grid.

The generator tallies _why_ it rejected each seed and reports the breakdown if it gives up, so
an impossible configuration is distinguishable from an unlucky one.

## 6. Netcode

### 6.1 Model

Clients send **intents**; the server validates, simulates, and broadcasts **events plus
tile deltas**. Clients never own state. Terrain is never transmitted — the snapshot carries
the seed and terrain config, and clients regenerate it identically.

### 6.2 Messages

Client → server: `join`, `ready`, `selectCastle`, `fire`, `placePiece`, `placeCannon`, `ping`

Server → client:

| Message         | Payload                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `joined`        | playerId, reconnect token, room state                                      |
| `snapshot`      | full state (RLE-encoded dynamic layers) — on join, reconnect, phase change |
| `phaseChange`   | phase, round, endTick, serverTick                                          |
| `shotFired`     | shotId, cannonId, playerId, from, to, launchTick, impactTick               |
| `impact`        | shotId, x, y, destroyedTiles[]                                             |
| `piecePlaced`   | playerId, cells[], nextPieceId                                             |
| `cannonPlaced`  | playerId, cannonId, x, y                                                   |
| `roundResolved` | per player: enclosedCastles, cannonsToPlace, eliminated; territory RLE     |
| `gameOver`      | winnerId or null (draw)                                                    |
| `pong`          | client t, serverTick                                                       |
| `error`         | code, message                                                              |

Because `shotFired` carries `launchTick` and `impactTick`, every client animates the
identical arc with no per-frame synchronisation.

### 6.3 Clock sync

`ping`/`pong` with a min-RTT filter maintains a client→server tick offset. Phase countdowns
render from `phaseEndTick` against the corrected clock, so all players see the same timer.

### 6.4 Rooms and lifecycle

- 6-character room codes from an unambiguous alphabet (no `0/O`, `1/I`).
- Anonymous nicknames, no accounts, no persistence, no ranking.
- Room TTL, max concurrent rooms, per-connection message rate limits from `server.json`.
- **Disconnect**: the slot is taken over by AI, `connected = false`. Rejoining with the
  reconnect token within the match restores control.

---

## 7. `packages/client`

### 7.1 Rendering layers

| Layer      | Technique                                                    |
| ---------- | ------------------------------------------------------------ |
| Terrain    | Baked once to a single large texture after generation        |
| Structures | Tilemap with dirty-rect updates on delta                     |
| Entities   | Castles, cannons (barrel angled toward last target)          |
| Effects    | Shot arcs, explosions, crater dust, water shimmer            |
| HUD        | Pixi in-world (timers, per-player cannon counts)             |
| Menus      | HTML/CSS overlay — faster to build and to style than Pixi UI |

### 7.2 Input

- **Combat**: mouse move = reticle; click = fire. Local click feedback is immediate; the
  arc spawns on server confirmation (imperceptible against a 0.5–1.5s flight).
- **Build**: mouse = ghost piece, `R` / wheel / right-click = rotate, click = place.
  Placement is applied optimistically and rolled back if the server rejects.
- **Cannon place**: 2x2 ghost, valid tiles highlighted from the local territory map.

### 7.3 Procedural asset generation

All sprites are generated at boot into a texture atlas from `art.default.json` plus the
match seed. Nothing binary is committed. Drawn at 16px tile resolution on an OffscreenCanvas
with a quantised arcade palette, then scaled nearest-neighbour.

| Generator    | Output                                                                               |
| ------------ | ------------------------------------------------------------------------------------ |
| `terrain.ts` | Grass/rock/sand variants, 47-tile shoreline autotile blob set, animated water frames |
| `wall.ts`    | 16 neighbour-bitmask wall segments + damaged variants, per-player palette            |
| `castle.ts`  | Parametric keep: tower count, battlement rhythm, banner in player colour             |
| `cannon.ts`  | Carriage + barrel, 16 rotation steps                                                 |
| `piece.ts`   | Tetromino previews and ghost overlays                                                |
| `reticle.ts` | Targeting reticle, range/validity states                                             |
| `fx.ts`      | Explosion frame sequence, crater decals, muzzle flash                                |

Player colours are hue rotations of one base ramp, keeping shading consistent across players.

### 7.4 Audio

`config/audio.manifest.json` maps cue names to files under `assets/audio/`. The loader
treats missing files as silent, so the game runs end to end before any audio exists.

Required cues: `cannon_fire`, `shot_impact`, `wall_destroyed`, `piece_rotate`,
`piece_place`, `piece_invalid`, `phase_start_combat`, `phase_start_build`,
`phase_start_cannon`, `countdown_tick`, `enclosure_success`, `enclosure_failed`,
`player_eliminated`, `victory`, `defeat`, `ui_click`.
Music: `music_lobby`, `music_combat`, `music_build`, `music_gameover`.

---

## 8. `packages/ai`

```ts
interface Bot {
  think(state: MatchState, playerId: number, budgetMs: number): Action[];
}
```

Bots run server-side on a throttled schedule and consume exactly the same validated action
API as human players — they cannot cheat by construction.

- **Combat**: score enemy wall tiles by criticality. Cheap heuristic — prefer tiles adjacent
  to existing breaches (widen rather than scatter), and tiles on the shortest loop segment.
  Higher difficulties use articulation-point analysis on the wall graph and lead their aim
  using flight time.
- **Build**: compute breaches in the current loop, then find the cheapest wall additions
  that seal at least one castle (BFS over candidate closure paths). Place toward that goal
  with the piece in hand; fall back to widening the safest pocket.
- **Cannon place**: interior tiles, spread out, biased toward the shore facing the
  currently weakest opponent.
- **Difficulty tiers** (3): reaction delay, aim jitter, planning depth, whether flight-time
  leading is modelled.

---

## 9. Testing

- **Unit** — enclosure solver golden cases (nested loops, shared regions, loops touching
  the shore, diagonal-only gaps), placement validation, crater application, reward maths.
- **Determinism** — `(seed, ruleset, input log) -> state hash` must be stable. Input logs
  are recorded from real sessions and replayed in CI. Replays are a _test tool_, not a
  shipped feature.
- **Property/fuzz** — random valid input streams; assert invariants: no overlapping
  structures, no wall off-island, cannon count never exceeds entitlement, no cannon fires
  while a shot is in flight, phase timers monotonic.
- **Terrain** — generated maps satisfy every fairness constraint across thousands of seeds:
  equal island area, equal castle count, minimum water gap, N valid castle sites.
- **Server integration** — in-process fake sockets: join/reconnect, rejected inputs,
  rate limiting, bot takeover on disconnect.
- **Headless harness** (`tools/headless`) — runs full bot-vs-bot matches without rendering,
  for balance tuning and soak testing.

---

## 10. Milestones

| #      | Goal             | Done when                                                                                                                                                                          |
| ------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0** | Scaffold         | npm workspace, per-package tsconfigs, eslint/prettier, vitest, CI, all config files + zod schemas. **Done.**                                                                       |
| **M1** | Sim core         | Terrain generation, enclosure solver, placement rules, shot resolution, phase state machine. Full match runs headless from a scripted input log. Determinism test green. **Done.** |
| **M2** | Playable locally | Pixi client running the sim in-browser, no network. Placeholder rectangles. **This is the fun-check** — if the loop is not fun here, adjust rules before building anything else.   |
| **M3** | Procedural art   | Full generator suite, atlas, animation, per-player palettes. The game looks like Rampart.                                                                                          |
| **M4** | Online           | ws server, room codes, authoritative loop, clock sync, reconnect + bot takeover. 2-player online match end to end.                                                                 |
| **M5** | AI               | 3 difficulty tiers, bots fill empty slots, headless bot-vs-bot soak runs clean.                                                                                                    |
| **M6** | Full scope       | 3–4 players, audio integration, HUD/menu polish, Docker, deployment.                                                                                                               |
| **M7** | Balance          | Tuning pass driven by the headless harness; ruleset defaults finalised.                                                                                                            |

Milestone M2 is deliberately early and ugly: the cheapest possible answer to "is this
actually fun with these rules?" is worth more than any amount of art built on top of a
loop that does not work.

---

## 10a. Open design question from M2

**A one-tile-wide wall cannot absorb the piece set without spill, and the spill
accumulates.**

Of the eleven piece shapes, only `i3` and `i4` fit entirely along a straight run of a
one-tile-wide wall. Every other piece placed on that line must deposit blocks beside it.
Since pieces may not overlap existing wall and the smallest is three cells, those strays
progressively remove the free neighbours a later repair needs as anchors — until an
isolated one-tile gap has nowhere to put the rest of the piece and simply cannot be
filled.

The practical consequence is that **rebuilding the thin rectangular ring the game hands
you is a losing strategy**, and the starting ring therefore teaches players the wrong
shape. Surviving means thickening the wall into a blob, where spill is harmless and gaps
always have free neighbours.

Measured with the stopgap opponent, which does rebuild the thin ring: matches last a
median of 2 rounds. Notably, the obvious balance levers do nothing — a single-tile crater,
a 40s build phase, a 15s combat phase and a 3.4x slower reload all produce the same
median. This is a geometry problem, not a damage-versus-repair problem.

Options, none yet chosen:

1. **Leave it.** Learning to build blobs rather than lines is legitimate depth, and the
   original arguably worked this way too.
2. **Add a one- or two-cell piece** to the set, so any gap is always fillable. Cheapest
   fix, costs some tension.
3. **Change the starting ring** to a thicker or rounder shape, so the shape players are
   taught is the shape that works.
4. **Allow placement over your own wall**, making spill self-correcting.

This needs a human playing the M2 build before deciding — the stopgap opponent is not
evidence about how the rule feels.

## 11. Deferred (explicitly out of scope for v1)

Team modes (2v2), quick-match / matchmaking queue, accounts and persistence, ranking,
mobile and touch input, spectator mode, shipped replays, naval units, singleplayer campaign.
