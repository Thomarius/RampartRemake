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
Every phase is preceded by an INTERMISSION, and nothing is playable during one:

```

INTERMISSION shots still in the air land -> 1s pause -> announcement crosses
the screen (4s). The next phase begins only once it has left.

```

```

LOBBY
-> CASTLE_SELECT (15s) pick 1 of the castles on your island
-> [a wall ring is auto-built around it]
-> CANNON_PLACE (25s) place your 2 opening cannons inside that ring
-> COMBAT (10s) click targets, cannons lob shots at enemy walls
-> BUILD (25s) place tetromino wall pieces on your island
-> [enclosure resolved; players with 0 enclosed castles are eliminated]
-> CANNON_PLACE (25s) place your earned cannons, ending early once done
-> COMBAT ...
-> GAME_OVER last player standing; simultaneous elimination = draw

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
  land. Formally: flood-fill from the map border across every tile that is not a wall —
  water included — and any castle not reached is enclosed.
- **The wall must turn its corners.** The escape flood is 8-connected while the wall is
  not, so the sea slips between two blocks meeting at a point: a diagonal join does not
  seal, and the corner block has to be there. A 4-connected flood would let a diagonal
  staircase stand in for a wall, which the original did not allow.
- A single sealed region containing K castles counts as K castles. Separate sealed regions
  stack. This is the central tradeoff: a wide loop earns more cannons but leaves far more
  perimeter to repair each round.

### 1.4 Cannons

- 2x2 footprint, placed inside your own enclosed territory. This includes the opening
  pair: the game builds your starting wall ring, but every cannon you own you placed
  yourself.
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
  Unlimited range. A shot destroys exactly the tile it hits — neighbours are untouched.
  Wider craters remain available through `shots.craterPattern`.

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
│ ├── ruleset.default.json # all game rules & timings
│ ├── terrain.default.json # map generation parameters
│ ├── art.default.json # palettes, sprite generator parameters
│ ├── audio.manifest.json # audio cue -> file mapping
│ └── server.default.json # ports, room limits, rate limits
├── assets/
│ └── audio/ # user-supplied audio files (gitignored placeholders)
├── packages/
│ ├── config/ # zod schemas, typed defaults, cross-file validation
│ ├── sim/ # deterministic game core — no DOM, no Node
│ ├── protocol/ # wire message types + zod schemas
│ ├── ai/ # bot logic against the sim interface
│ ├── server/ # ws server, rooms, tick loop
│ └── client/ # Pixi renderer, UI, procedural asset generators
├── docs/
│ └── PLAN.md
└── tools/
└── headless/ # CLI match driver for testing & AI tuning

````

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
    "combatMs": 10000,
    "buildMs": 25000,
    "cannonPlaceMs": 25000,
    "endOfPhasePauseMs": 1000,
    "transitionBannerMs": 4000
  },
  "cannons": {
    "startingCount": 2,
    "firstCastleReward": 2,
    "perAdditionalCastleReward": 1,
    "footprint": [
      2,
      2
    ],
    "inertWhenNotEnclosed": true,
    "maxTotal": null
  },
  "shots": {
    "baseFlightMs": 350,
    "perTileFlightMs": 35,
    "maxRangeTiles": null,
    "craterPattern": "single",
    "damagesWalls": true,
    "damagesCastles": false,
    "damagesCannons": false
  },
  "build": {
    "sharedPieceSequence": true,
    "previewCount": 1,
    "allowSkip": false,
    "restrictToOwnIsland": true,
    "pieces": [
      {
        "name": "i1",
        "weight": 10
      },
      {
        "name": "i2",
        "weight": 10
      },
      {
        "name": "i3",
        "weight": 9
      },
      {
        "name": "l3",
        "weight": 10
      },
      {
        "name": "o4",
        "weight": 9
      },
      {
        "name": "i4",
        "weight": 7
      },
      {
        "name": "t4",
        "weight": 9
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
        "weight": 8
      },
      {
        "name": "l4",
        "weight": 8
      },
      {
        "name": "p5",
        "weight": 6
      },
      {
        "name": "q5",
        "weight": 6
      },
      {
        "name": "f5",
        "weight": 5
      },
      {
        "name": "g5",
        "weight": 5
      },
      {
        "name": "z5",
        "weight": 5
      },
      {
        "name": "s5",
        "weight": 5
      },
      {
        "name": "t5",
        "weight": 5
      },
      {
        "name": "u5",
        "weight": 5
      },
      {
        "name": "v5",
        "weight": 5
      },
      {
        "name": "w5",
        "weight": 5
      },
      {
        "name": "x5",
        "weight": 3
      }
    ],
    "sizeSchedule": [
      {
        "fromRound": 1,
        "sizes": [
          1,
          2,
          3
        ]
      },
      {
        "fromRound": 2,
        "sizes": [
          1,
          2,
          3,
          4
        ]
      },
      {
        "fromRound": 3,
        "sizes": [
          2,
          3,
          4
        ]
      },
      {
        "fromRound": 4,
        "sizes": [
          2,
          3,
          4,
          5
        ]
      },
      {
        "fromRound": 5,
        "sizes": [
          3,
          4,
          5
        ]
      }
    ]
  },
  "enclosure": {
    "shorelineCountsAsWall": false,
    "connectivity": 8,
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
    "footprint": [
      3,
      3
    ],
    "minSpacingTiles": 6,
    "minDistanceFromShoreTiles": 3
  },
  "startingWall": {
    "ringRadiusTiles": 3
  },
  "generation": {
    "maxRetries": 150
  }
}
```

### `config/art.default.json`

Style selector, arcade-era base palette, per-player colours, flat-style parameters, and the
generator parameters the pixel style draws from: tile pixel size, atlas size, terrain
variant counts, water animation frames, wall damage states, castle battlement rhythm,
cannon proportions and explosion frame counts.

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
class Bot {
  constructor(playerId: number, difficulty: Difficulty)
  think(state: MatchState, rng: Rng): Action | null
}
```

Bots go through exactly the same validated action API as a person, so they cannot cheat
by construction — and they never ask for anything the rules refuse, which the soak run
asserts.

### Sealing is a minimum cut

The bot does not follow a shape. It asks for the cheapest wall that exists.

Enclosure is an escape flood from the map border across non-wall tiles, so sealing a
castle means cutting every such path. Give each tile the player could build on capacity
one, everything else that cannot be built on infinite capacity, and the **minimum cut
between the border and the castle is the smallest wall that works**. Existing walls are
simply absent from the graph, so their value is counted without any special case.

The graph is built over the bot's own island alone — a few hundred tiles rather than
6400 — because water is all connected to the border, so every tile where the island meets
the sea is an entry point hanging off the source. That is exact, not an approximation, and
it made the solver **37x faster**: 7.8s per match to 211ms.

This is precisely what the stopgap lacked. It rebuilt the ring it was handed, which is the
one shape guaranteed to be expensive. A bot that asks for the cheapest loop instead hugs
the coast, reuses whatever survived the barrage, and abandons a ring no longer worth
holding.

**Unfillable gaps.** A cut tile with no free neighbours cannot be filled, since the
smallest piece is three cells and pieces may not overlap — the M2 geometry problem. When
no legal placement reaches a tile the bot marks it unusable and replans, and the cut
routes around it. Adding this was the difference between dying in round 2 and enclosing
all three castles by round 4.

### Attacking is a shortest path

A 0-1 breadth-first search from the border to an enemy castle, free across open ground and
costing one per wall block, finds **the thinnest part of their defence**. Its wall tiles
are what to shoot. Scattering fire over a wall achieves nothing; concentrating it on four
blocks in a line opens a breach.

### Difficulty

| | recruit | gunner | marshal |
|---|---|---|---|
| Aim | mostly random | usually the weak point | almost always the weak point |
| Target | random opponent | the strongest | the strongest |
| Castle choice | random | cheapest to wall | cheapest to wall |
| Ambition | 1 castle | 1 castle | up to 2 |
| Replans every | 60 ticks | 30 | 15 |

Measured over 14 seeds head to head: marshal beats recruit 12-0, gunner beats recruit 8-3,
and marshal beats gunner 7-6. The top two are close, which is honest — the gap between
them is aim quality and replanning rate, not a difference in kind.

**Ambition has to be bounded.** An earlier marshal tried to wall all three castles at
once and *lost* to gunner: the blocks to build a wall are a one-off, but its length is a
bill that arrives every round under fire. Valuing a castle too highly makes a bot reach
for everything and lose the lot.

**Matches can still stalemate**, in roughly one in twenty: two evenly matched defenders
hold each other off and nothing in the rules forces escalation. It is a property of the
design rather than a fault in the bot, and worth revisiting in the balance pass.

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
| **M3a** | Style abstraction | Renderer split into a scene that owns camera, layers and dirty tracking, and a theme that owns only appearance. The minimal style becomes the reference implementation, selectable from the menu and by URL. **Done.** |
| **M3b** | Procedural art   | Full generator suite, atlas, animation, per-player palettes, implemented as a second theme. **Done.** |
| **M4** | Online           | ws server, room codes, authoritative loop, clock sync, reconnect + bot takeover. 2-player online match end to end.                                                                 |
| **M5** | AI               | 3 difficulty tiers, bots fill empty slots, headless bot-vs-bot soak runs clean.                                                                                                    |
| **M6** | Full scope       | 3–4 players, audio integration, HUD/menu polish, Docker, deployment.                                                                                                               |
| **M7** | Balance          | Tuning pass driven by the headless harness; ruleset defaults finalised.                                                                                                            |

Milestone M2 is deliberately early and ugly: the cheapest possible answer to "is this
actually fun with these rules?" is worth more than any amount of art built on top of a
loop that does not work.

---

## 10a. Decisions from M2

The prototype plays. Three things came out of it.

**Thin walls versus the piece set — settled, no change.** Only `i3` and `i4` fit along a
straight run of a one-tile-wide wall, so every other piece deposits blocks beside it, and
that litter can eventually leave a gap with no free neighbours to anchor a repair. This
looked like a rules problem when the stopgap opponent hit it, but the stopgap hits it
because it was told to rebuild the exact rectangle it started with. Players do not do
that — they build whatever valid shape of wall works, thickening rather than restoring a
line. The finding is about the opponent, not the design.

**Combat was too long relative to build.** Nearly every wall was destroyed within a 30s
combat phase and 25s was not enough to restore it. Combat is now 20s, and a shot destroys
only the tile it hits rather than a 5-tile cross — a 5x reduction in damage per shot.
Both are single values in `config/ruleset.default.json`.

Worth noting for later tuning: these changes barely move the stopgap opponent's match
length (median 2-3 rounds either way), because that opponent is limited by its own repair
strategy rather than by incoming damage. Bot-vs-bot numbers will not be meaningful
evidence about pacing until M5.

**Opening cannons are placed by the player.** They were auto-placed, which quietly removed
the first real decision of the match. Castle selection now leads into a cannon placement
phase, so the only thing the game hands you is the wall ring.

### Intermissions

Phases used to change instantly, which made them easy to miss and meant the build phase
could begin while the previous volley was still landing on it. Every transition now runs
through an intermission, which holds until three things have happened:

1. every shot still in the air has landed and played its impact,
2. a pause of `endOfPhasePauseMs` has elapsed,
3. the announcement has crossed the screen, taking `transitionBannerMs`.

The banner travels at constant speed and does not dwell — it sweeps past rather than
stopping to be read. Its duration is a ruleset value rather than a stylesheet constant,
because the simulation holds the next phase until it has gone: this is match timing, not
decoration, and the server has to agree with the client about it.

While shots remain in flight the intermission keeps pushing its own end tick back, so the
announcement always plays against a settled board.

### When territory is shown

Territory shading is not merely a readout of the solver — when it updates is a design
decision in itself:

- **On castle selection**, immediately. The wall ring goes up with the choice rather than
  when the last player has chosen, so the shape you committed to is visible at once.
- **During the build phase**, on every block placed. A loop lights up as territory on the
  tick that closes it, which is the feedback that makes building legible.
- **Not during combat.** What is shown under a barrage is the territory you _earned_ at
  the last resolution, and it stays put even as the walls come down. Recomputing here
  would dissolve the map from under the player, and would also be misleading: the
  enclosure that counts is the one at the end of the next build phase, not the one that
  happens to exist mid-volley.

The cannon placement phase also ends as soon as no player has anywhere left to put one,
rather than running a timer that cannot change anything.

### Castles must never block each other's rings

Castle siting enforces separation on an axis, not merely by distance. Euclidean spacing
alone is not enough: an offset of 5,5 clears a minimum distance of 7 while dropping one
castle squarely on another's ring corner, and the ring is then built with a hole in it.

This mattered only once the escape flood became 8-connected. Before that a missing corner
still sealed, so the bug was invisible — a player could commit to a castle whose ring
could never be closed and not find out until the first resolution.

Every castle must be a viable opening choice, so the generator rejects any layout where
one castle's footprint intersects another's ring rectangle, and a test asserts that every
castle on a map yields a complete, sealed ring when chosen.

## 10b. Visual styles

The renderer is split in two. The **scene** owns the Pixi application, the layer stack,
the camera fit, the screen-to-tile mapping and the dirty tracking that decides when a
repaint is needed. A **theme** owns only what things look like.

Everything a theme needs is derived in the client from grid state it already has —
neighbour bitmasks for autotiling, damage states, animation frames — so styles reach into
neither the simulation nor the protocol. A second style costs its drawing code and
nothing else.

```
Theme
  init(layers, art)          prepare; a textured style generates its atlas here
  drawTerrain(state, view)   static for the match
  drawTerritory(state, view) on solver changes
  drawStructures(state, view) on grid changes
  drawEffects(state, view, frame)   every frame
  drawOverlay(state, view, ghost, player)  every frame
  noteImpact(x, y) / destroy()
```

**`flat`** — the minimal style: solid colour, hard edges, no textures and no atlas to
generate. It began as placeholder art for M2 and is kept as a real option. Besides being
a style in its own right it is the fallback when texture generation fails or is slow, the
low-spec option, and by some distance the easiest thing to debug against: an enclosure or
territory bug is obvious in flat colour and easy to miss under texture.

**`pixel`** — the procedural style. Every sprite is generated at boot from the palette and
packed into one texture, so the whole board draws in a single batch and the repository
carries no binary art.

Sprites are generated in neutral stone and grass and tinted per player at draw time. That
keeps the atlas small, and it guarantees the two styles cannot disagree on colour, since
both read the same palette. The land tint is deliberately faint: tinting hard enough to
identify an island by its grass turns the ground muddy and throws away the texture, so
ownership is carried by the tinted shoreline, the walls and the territory shading.

Shore tiles are generated for all 256 neighbour combinations rather than the usual reduced
47-tile blob set. At 16 pixels a tile the whole run is a few kilobytes, and covering every
case outright is far less error-prone than mapping corners onto a reduced set.

Chosen by `art.style` in config, overridden by `?style=` and by the menu. The palette is
shared: the minimal style's colours are the pixel style's colours, so the two cannot drift
apart.

The real cost of keeping two styles is not the abstraction but the discipline — every
renderer feature from here is built and verified twice. That is a deliberate tax, accepted
because the minimal look is a shipping option rather than scaffolding.

## 10c. How the netcode actually works

The server never sends the board during play. It sends **the actions it applied and the
tick they landed on**, and every client replays them into its own simulation. This is only
sound because the simulation is deterministic, which is why M1 spent effort on exact
integer square roots and a hand-written sine: those were not pedantry, they are what makes
this design safe.

```
client intent ──► server validates against the same rules everyone runs
                     │
                     ├─ accepted ──► broadcast commit { tick, actions }
                     └─ refused  ──► rejected { action, reason }  (to the sender only)
```

A client may advance its simulation to `tick + 1` on receiving commit `tick`, and never
further: the server never assigns an action to a tick it has already stepped past, so a
confirmed tick is final. The client therefore cannot display something that did not
happen. The cost is that a player's own action appears after one round trip — well under
the flight time of a cannonball, and far cheaper than local prediction with rollback.

**The hash is not a nicety.** Every 30 ticks the server includes a state fingerprint.
A client that disagrees has desynced, and says so rather than quietly drifting. The
integration suite runs whole matches between in-process clients and asserts zero
mismatches; an end-to-end run over real sockets reported 299 commits, 10 hash checks and
0 desyncs across two clients.

**Terrain is never transmitted.** A snapshot carries the seed, the ruleset and the
dynamic layers run-length encoded; the terrain and the piece sequence are regenerated.
The ruleset travelling with the snapshot matters: a client running different rules would
desync rather than merely look wrong.

**Authority over identity.** The server overwrites the `player` field of every incoming
action with the sender's own seat, so a client cannot act for someone else by writing a
different id. There is a test that tries exactly that.

**Disconnects.** A dropped seat is played by a bot after a grace period, so one dead
connection cannot stall the table. The seat is held, not freed: presenting the token
reclaims it and the returning player is sent a snapshot of the board as it now stands.

## 10d. Known weaknesses of the bots

Recorded for the balance pass. Not yet addressed.

### They repair, and then stop

A bot asks for the minimum cut and builds exactly that. Two consequences follow, and
both are structural rather than incidental.

**The wall it builds is one tile thick, by construction.** A minimum cut is by definition
the thinnest barrier that separates the castle from the sea, so the bot deliberately
builds the most fragile wall that works. Every block of it is load-bearing: a single
crater anywhere along it breaks the seal. A person thickens the places that keep getting
hit; the bot has no notion that some parts of its wall are more exposed than others.

**Once sealed, it stops building entirely.** `build()` returns null as soon as the plan is
covered, so a bot that finishes its repairs in eight seconds does nothing for the
remaining seventeen. Measured: 5-18 placements per build phase against a theoretical
budget of 60-150. That idle time is precisely what a good player spends on everything
below.

### They never expand

Nothing in the bot tries to grow. It holds what it started with, which costs it three
different things at once:

1. **Cannons.** Each further castle inside the wall is another cannon every round, so a
   bot on one castle is permanently on the minimum income of two.
2. **Room.** Cannons need 2x2 of sealed territory. A wall drawn tight around one castle
   runs out of space to put the cannons it does earn — the reward becomes unspendable.
3. **A spare life.** Elimination is at *zero* enclosed castles, so a second sealed castle
   is literally a second life. A bot on one castle is always one breach from death, which
   is also why widening matters more than the cannon count suggests.

The three compound: more castles means more cannons, more room to place them, and more
margin for error. A bot that never expands is playing a strictly worse game than the rules
reward, and the gap widens every round.

### They build and shoot faster than a person can

| | build attempts | per 25s phase | fire attempts |
|---|---|---|---|
| recruit | 2.4/s | 60 | 3.0/s |
| gunner | 4.2/s | 105 | 4.8/s |
| marshal | 6.0/s | 150 | 6.0/s |

A person places perhaps one piece a second with a mouse. Marshal is budgeted for six.

This advantage is currently invisible, because the strategy above means the bot never
uses more than a fraction of its budget — which is exactly why it must be fixed *together*
with expansion, and not before. Improving the plan without capping the rate would hand
the bot its full 150 placements a phase and make it unbeatable for the wrong reason.

**The firing advantage arrives on a timer.** Early on a cannon cannot fire again until its
shot lands, which at 40 tiles is 1.75s, so two cannons sustain roughly one shot a second
whatever the bot's rate says. The rate only becomes the binding constraint once a player
has eight to fifteen cannons — around round four to seven. So the bots are fair at the
start of a match and progressively less fair as it goes on.

### What to do about it

Both dials the feedback identifies are the right ones, and they should be expressed in
human units — **pieces per build phase** and **shots per second** — rather than the current
per-tick probabilities, which are opaque and do not survive a change to the tick rate or
the phase length. A hard cap per phase alongside the rate would bound total output even if
phase timings change.

Two things worth doing before tuning:

- **Measure a person.** Instrument the client to record placements per build phase and
  shots per second during a playtest. The numbers above are the bot's budget; we do not
  actually know a human's, and guessing it is how the difficulty curve ends up wrong.
- **Expect this to interact with the stalemate.** Roughly one match in twenty currently
  runs forever because two defenders repair everything thrown at them. Cutting build rate
  to human levels removes repair capacity, so it may well resolve the stalemate on its
  own. Tuning the two independently risks over-correcting.

A useful piece already exists for the resilience problem: `weakestWall(state, self)`
computes where an opponent would breach *this* player, which is exactly where thickening
is worth the blocks.

## 10e. The piece set grows harder as a match goes on

Implemented. The catalogue is complete and the draw narrows by round.

### The set

22 pieces: the single, the domino, both trominoes, all seven one-sided tetrominoes, and
the eleven one-sided five-cell pieces that fit a 3x3 box. The 3x3 limit applies to
five-cell pieces only, so the straight four is in; within size five it excludes the
straight five along with L, N and Y. Enumerated rather than drawn by hand, and a test
asserts the counts per size so the catalogue cannot quietly drift.

### The schedule

`build.sizeSchedule` in the ruleset, as bands of piece sizes by round. Each band runs
until the next begins; the last runs to the end of the match.

| From round | Sizes |
| --- | --- |
| 1 | 1, 2, 3 |
| 2 | 1, 2, 3, 4 |
| 3 | 2, 3, 4 |
| 4 | 2, 3, 4, 5 |
| 5 onward | 3, 4, 5 |

Bands rather than per-piece curves, because a band is a single legible thing to tune.
Individual weights still apply within whichever band is active.

### The draw is a function, not a list

`pieceAt(ruleset, seed, round, index)` — a pure function, with no stored sequence. This is
what lets a client regenerate its own queue from the seed rather than receive it, and it
keeps the match state a fixed size however long a match runs. Every player draws the same
piece at the same position, so the bag is identical for everyone. `pieceIndex` resets at
the start of each build phase, since each phase deals a fresh queue.

### What it measured

Against a control that puts every piece in the bag from round one, three players per
match, eight seeds:

| | escalating | flat bag |
| --- | --- | --- |
| recruit | 13 rounds median, 2 unfinished | 14 rounds, 1 unfinished |
| gunner | 15 rounds median, 1 unfinished | 21 rounds, 3 unfinished |
| marshal | 12 rounds median, 0 unfinished | — |

So it helps, clearly at gunner level, and marshal matches now always resolve. **It is not
by itself enough**: recruit and gunner still stalemate occasionally.

That is very likely an artefact of the bots rather than the rules. A bot places up to six
pieces a second (section 10d); a person places about one. Awkward pieces cost a human far
more than they cost a bot, so the escalation's real effect cannot be judged until bots
build at human speed. **Re-measure this after 10d, before adding anything more
sophisticated here.**

## 11. Deferred (explicitly out of scope for v1)

Team modes (2v2), quick-match / matchmaking queue, accounts and persistence, ranking,
mobile and touch input, spectator mode, shipped replays, naval units, singleplayer campaign.
````
