# Rampart Remake — Implementation Plan

A multiplayer-only recreation of the 1990 Atari arcade game _Rampart_, condensed to a
single game mode, with online play, AI opponents, and fully procedural visual assets.

---

## 1. Design summary

### 1.1 Match structure

2–8 players, free-for-all; 3 and 4 remain the focus, and higher counts exist mainly so
team modes have somewhere to go. Empty slots are filled by AI. The data model is team-aware
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

- Square tile grid, default 56x56.
- The map is divided into N equal **sectors** meeting at its centre, one per player,
  separated by a **channel two tiles wide**. Sectors are rotational copies of one
  generated shape, so the whole map turns onto itself by 1/N and no seat is better
  placed than another.
- The players sit side by side rather than across an ocean, and that is a rule about
  pacing as much as looks: flight time scales with distance, so an ocean between
  players means slow, weak artillery and matches that will not end.
- Each sector carries the same number of castles (default 4, each 2x2).
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
- **Continues.** Failing to seal a castle spends a life rather than ending the match.
  The island is wiped — cannons, shots, and every wall — a castle is chosen again in the
  coming cannon phase, a fresh ring is raised around it, and the player places
  `startingCount + livesSpent` cannons. Out of lives, failing is final as before. See 10o.
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
│ └── audio/ # audio cues, committed — the image is built from a clean checkout
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
    "buildMs": 20000,
    "cannonPlaceMs": 25000,
    "endOfPhasePauseMs": 1000,
    "transitionBannerMs": 4000
  },
  "cannons": {
    "startingCount": 3,
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
    "sharedRegionCountsAllCastles": true,
    "sweepOrphanedWalls": true
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
  "gridWidth": 56,
  "gridHeight": 56,
  "layout": "rotational",
  "island": {
    "targetAreaTiles": 440,
    "areaTolerance": 0.08,
    "noiseOctaves": 4,
    "noiseFrequency": 0.08,
    "coastlineRoughness": 0.55,
    "minWaterGapTiles": 2,
    "erosionPasses": 2
  },
  "castles": {
    "perIsland": 4,
    "footprint": [
      2,
      2
    ],
    "minSpacingTiles": 7,
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

### `config/ai.default.json`

```json
{
  "profiles": {
    "recruit": {
      "placementBaseMs": 600,
      "placementPerCellMs": 420,
      "fireIntervalMs": 600,
      "aimJitter": 0.7,
      "maxCastles": 1,
      "riskMargin": 0.55,
      "replanTicks": 60,
      "picksTarget": false
    },
    "gunner": {
      "placementBaseMs": 420,
      "placementPerCellMs": 360,
      "fireIntervalMs": 380,
      "aimJitter": 0.25,
      "maxCastles": 2,
      "riskMargin": 0.8,
      "replanTicks": 30,
      "picksTarget": true
    },
    "marshal": {
      "placementBaseMs": 360,
      "placementPerCellMs": 320,
      "fireIntervalMs": 260,
      "aimJitter": 0.05,
      "maxCastles": 2,
      "riskMargin": 1.0,
      "replanTicks": 20,
      "picksTarget": true
    }
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

Complexity O(W*H) per resolution, run once per build phase. Trivial at 56x56.

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
| **M6** | Full scope       | 2–8 players, audio integration, HUD/menu polish, Docker, deployment.                                                                                                               |
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

## 10d. Bots play at a human pace, and to a plan

Implemented. The two problems recorded here — no strategy, and inhuman speed — were
fixed together, because fixing either alone makes things worse: a better plan without a
rate cap is unbeatable for the wrong reason, and a rate cap without a better plan is just
a weaker bot.

### Pace, in human units

`config/ai.default.json` describes each tier in milliseconds, not per-tick chances. A
probability is opaque, does not survive a change to the tick rate or a phase length, and
cannot be compared against what a person manages. Placement time is `base + perCell *
cells`, so a bot slows down as the piece schedule widens — which is the same reason a
person's rate falls, rather than a separate rule bolted on.

Measured, player 0 across a match: **20 pieces in the first build phase falling to 8 by
the late rounds**, against the roughly 25-then-15 a person manages. Firing is barely
limited at all, at 260-600ms between shots, because clicking is fast and the reload is the
real constraint.

### A ladder, not a single objective

Each time it may place, a bot works down what would hurt most to be without:

1. **Stay alive.** Enclose something, or the rest is moot.
2. **Make room.** Cannons need sealed 2x2 ground; without it the reward is unspendable.
3. **Take more ground.** Another castle is another cannon a round, and a spare life.
4. **Thicken.** A minimum cut is one block thick, so every block of it is load-bearing.
   `weakestWall` against itself says where an opponent would come through, and the ground
   beside those blocks is where a second layer is worth having.

### Reaching for two castles is an affordability question

Combining repair with expansion is the interesting decision, and it is a gamble: more
cannons if the wall closes, elimination if it does not. A rate-limited bot can price it —
it knows how many pieces it can still lay this phase, and `riskMargin` is its appetite for
attempting a wall that does not comfortably fit. Below 1 it insists on slack; above 1 it
gambles.

Tuning found that **over-reaching loses**. A marshal set to bring three castles inside one
wall lost to a gunner reaching for two (8-9); cut to two castles it wins (10-6). Ambition
has to be paid for out of a budget, not assumed.

### What it fixed

| | before | after |
| --- | --- | --- |
| marshal vs gunner | 7-6 | **8-3** |
| gunner vs recruit | 19-1 | **11-1** |
| stalemates | ~1 in 20 | **none in 30 matches** |
| match length | 8-20 rounds | 6-9 rounds |

The stalemates are gone. Between the widening piece schedule from section 10e and a human
build rate, bots can no longer repair everything thrown at them — so the question left open
there is answered: **the escalation is enough, once the bots stop building at six pieces a
second.**

### A performance note worth keeping

Build-phase thinking was 30.7 seconds of a 31-second match. The cause was not the
planning: when a bot could not fit a piece it forced a replan without also standing down,
so it re-planned on every tick. Standing down for 250ms first took it to 2.1 seconds. The
lesson is that a bot which fails to act still has to pay its own rate limit.

### Still open

- **Personalities.** The tiers carry risk appetite, but a separate axis — turtle, expander,
  aggressor — would make opponents feel different rather than merely better. Deliberately
  deferred; it layers cleanly on the ladder.
- **Late-phase idling.** A bot lays 8 pieces in a late build phase where a person manages
  15. Once its wall is sealed, thickened and it cannot afford another castle, it stops.

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

### Setting the table

Both the offline menu and the online lobby configure seats individually rather than
just counting players.

**Offline**, each seat is either the person or a bot of a named skill, so a match can mix
tiers — a recruit and a marshal against you — instead of facing three of the same. Setting
*every* seat to a bot gives a **watched match**: no input is attached and the HUD drops the
control hints, which is much the clearest way to see how the bots actually play.

**Online**, the room reports a row for every place at the table: the people who have
joined, then the bots waiting behind the seats nobody took. Only the host may change a
bot, and only before the match starts — both enforced on the server, since a guest could
otherwise reconfigure the table by sending the message directly.

Seats a person holds still get a bot built for them, which is what covers them if they
drop mid-match.

## 10f. Sweeping, sectors, and what they exposed

Five changes from a session of watching bot matches, plus the bug that watching found.

### Wall that is doing no work is swept away

Between the build phase and the next barrage, **one rule applied once**: a wall block
with fewer than two orthogonal wall neighbours is swept. Every block is judged against
the board as it stood at the end of the build phase, and the failures go together — so
removing a block never condemns its neighbour in the same sweep.

A straight run of three loses both ends and keeps its middle, which is left standing
alone: it had two neighbours when the question was asked. Next round it has none, and
then it goes.

Orthogonal, deliberately: a wall seals only when it is 4-connected, so this is exactly
the connectivity that makes a wall a wall — and it means **a loop enclosing anything can
never be swept**, since every block of a loop has two orthogonal neighbours. A test
asserts that property directly.

**This was originally implemented as a cascade and that was wrong** — see 10n.

### Smaller castles, more of them, closer together

Castles are 2x2 and there are four per sector, on the larger ground the channels free up.
Build phase 25s to 20s.

### The bug watching found

Bots were laying blocks inside their own sealed ground, which is the one place a cannon
may go. Three causes, all now fixed: thickening worked inward as readily as outward,
spill into territory was scored as merely wasted rather than harmful, and the test for
"do I have room for my cannons" compared against `cannonsToPlace` — which is zero for
the whole build phase, because it is set at the resolution that ends it.

### And the bug that was underneath it

Measured while fixing the above: bots owned 15 cannons apiece and had **two active
between them**. A cannon fires only from sealed ground, and a minimum cut is by
definition the *tightest* wall that works, so each round the planner drew the wall in
closer to the castle — and the new sweep then removed the old outer wall, leaving the
guns outside and silent. The bot was strangling its own artillery, one round at a time.

The fix is to make the player's cannons **sinks in the cut** alongside the castle, so a
valid wall has to enclose them. It costs more wall, which is simply what they are worth.
With it, a bot holds 12 to 18 active guns where it held none.

### Still unresolved

Bot-vs-bot matches now run long and often do not finish inside a tick budget that used
to cover several matches. Nobody is eliminated, because a near-optimal defender with four
castles on a large sector can almost always seal *something*. Damage is not the
constraint: raising fire rates to a person's clicking speed changed nothing.

This wants a human's judgement rather than more tuning, and the seat configuration added
alongside it is what makes that possible — set every seat to a bot and watch. Candidate
levers, in the order I would try them: fewer castles per sector, castles closer together
so one barrage threatens several, and a smaller sector so there is less ground to retreat
into.

## 10g. Sizing the map from the original

The endless matches were mostly a map problem. Measured from a screenshot of the
original's three-player map: roughly **42x30 tiles, about 400 a player including the
river**. Ours were 1100 tiles of pure land each — nearly three times the space, which is
why walling a castle was never in doubt.

Territories are now **440 tiles on a 56x56 grid**, and players start with **three
cannons** rather than two, as in the original.

Not the measured 400: four 2x2 castles each need an 8x8 block of clear ground for their
starting ring — 10x10 on three-player maps, where the 120 degree rotation needs a tile of
slack — and 380 tiles cannot hold four of those. 440 is the smallest that generates
reliably at every player count.

**480 was the first answer and it was quietly wrong.** At four players the island nearly
filled its sector, so the coastline was pinned by geometry rather than noise and every
seed produced *the same map*. A determinism test caught it. 440 restores ten distinct maps
in ten seeds at every player count — worth remembering that "fits" and "varies" are
different questions, and only one of them is obvious when looking at a single map.

### What it fixed, and what it did not

Recruit matches went from 36-43 rounds with frequent stalls to **three rounds, none
unfinished**. Gunner and marshal still do not reliably finish.

Chasing the rest turned up a second mechanism, and it is an interaction with the sweep
rather than a fault in either part alone. When a bot holds two enclosures and one is
breached, the sweep correctly removes that whole wall — and strands every cannon inside
it on open ground. Recovering them never fits one build phase's budget, so they stay
silent. Matches were reaching **zero active cannons for every player**: nobody could hurt
anybody, so nobody could win.

Two changes followed:

- **The planner asks for room.** A minimum cut is by definition the tightest wall that
  works, which is precisely the wall with nowhere to put a gun. It now requires a band of
  ground around each castle, so a bot can spend the cannons it earns.
- **A bot that has lost most of its guns commits to getting them back**, across several
  phases rather than one. That works because a part-built extension of a live wall still
  touches territory, so the sweep leaves it standing and the work carries over.

Together those took matches from zero active guns to one player holding six to eleven.
Still not enough: the other two defend perfectly with no firepower at all.

### Observed while watching, after the above landed

Recorded from playtest observation, and the current top priority:

1. **Recruit** encloses its starting castle and its cannons correctly, but does not
   expand, and **stops placing tiles entirely once its enclosure is valid** — most of the
   build phase goes unused.
2. **Gunner and marshal** tend to enclose *a different* castle with minimal placement,
   **leaving no room for cannons at all**. Neither side ends up with firepower, and the
   match stalls.

These were seen around the same time as the `ROOM_RADIUS` and stranded-gun changes, so
re-observe before acting on them — set every seat to a bot and watch.

**Next lever, untried:** three castles rather than four, closer together, so a single
barrage threatens more than one at a time. Four spread-out castles give a near-optimal
planner four independent chances to seal something, and it only needs one.

## 10h. The planner asked for the tightest wall, and got what it asked for

Implemented. This is the answer to the two things recorded at the end of 10g, and it
turned out to be one thing wearing two hats.

### First, the harness had to be able to see it

Every diagnosis from 10d onwards was made by watching a match, which is why each of
those sections ends by asking the next session to go and watch again. The harness
printed rounds, ticks and a winner — none of the quantities the open questions were
actually about.

`--stats FILE` now writes a row per player per round, sampled at the resolution that
ends a build phase and nowhere else: `enclosedCastles` is live during a build phase and
the sweep runs inside the same step, so that instant is the only one where the numbers
mean what they look like. It records castles sealed, cannons owned and active, cannon
room, wall tiles, pieces placed against the pieces the tier had time for, and shots
fired. A summary of the same goes to the console, because a number nobody reads is not
instrumentation.

`--difficulty` also takes a comma-separated list now, one tier per seat. It could not
mix tiers before, which means the head-to-head records in sections 8 and 10d could not
have come from it and cannot be reproduced by it.

### What it said, immediately

Three players, eight seeds, averaged over every surviving player-round:

| | recruit | gunner | marshal |
| --- | --- | --- | --- |
| castles sealed | 1.0 | 1.42 | 1.39 |
| cannons owned | 7.1 | 7.2 | 7.1 |
| cannons **active** | 4.3 | 3.9 | 3.3 |
| **room for another cannon** | **0.8** | **0.3** | **0.3** |
| wall tiles | 45 | 41 | 37 |

Room 0.3 is the whole story. A gunner or marshal at a typical resolution had space for
**zero** more cannons, behind a ring of 37 tiles, with half the guns it owned standing
outside and silent. It was not that the bots sometimes walled themselves in too tightly.
It was that they always did, and had no way to do anything else.

### The cause is the thing that made the planner good

Sealing is a minimum cut, and a minimum cut is by definition the *tightest* wall that
works. Hand a planner the cut and tell it to build, and every round it asks for the wall
with nowhere to put a gun — and then the sweep takes the old, wider wall away, so the
room is not merely unbought, it is actively demolished. Section 10f called this the
bot strangling its own artillery and fixed it for one code path. There were six, and
`ROOM_RADIUS` reached three of them. The three it missed were the ones that matter most:

- the preferred branch of `reseal`, which is what runs after a breach — the exact
  moment the wall is redrawn from scratch,
- `hold`, which is where a settled bot spends most of a match,
- and `chooseCastle`, which scores a castle by how cheaply it can be walled. That is a
  measure of how tightly a castle can be strangled, so it reliably picked the castle
  with the least ground around it, before a single piece was placed.

### Ask for the widest wall you can pay for, not the tightest that works

`widestAffordable` asks at `ROOM_RADIUS` and steps the band down a tile at a time until
a plan fits the phase's budget. Room is what gets asked for first and surrendered last,
which is the exact inversion of the old behaviour, and a tight wall is still reachable
as the bottom rung. The same ladder now runs through `reseal`'s fallback, ending in the
cheapest wall on the board — because a bot that cannot afford any plan should build
toward one it can finish. Without that last rung a bot spent a phase laying fourteen
pieces of a wall that could never close, the sweep took the lot, and it died with
nothing standing.

**`ROOM_RADIUS` is two, and three was actively harmful.** Three tiles buys room for
about fourteen cannons against a reward of three a round — ground that must be walled
and then repaired every round under fire, for guns that will never exist. At three,
marshal matches went from never finishing to finishing in 2.3 rounds, all three players
eliminated together in a barrage none could out-repair. At two the band holds six or
seven and the wall is short enough to maintain.

**And a bot that has finished its plan thickens rather than stops.** Recruit laid 69% of
the pieces it had time for; marshal, which keeps finding expansions to afford, laid 106%.
The gap was simply standing still. This is the late-phase idling left open in 10d.

### What it fixed

Three players, eight seeds, same measurements:

| | gunner before | gunner after | marshal before | marshal after |
| --- | --- | --- | --- | --- |
| room for another cannon | 0.3 | **1.1** | 0.3 | **5.5** |
| cannons idle | 46% | **19%** | 54% | **10%** |
| cannons active | 3.9 | **5.8** | 3.3 | **6.3** |
| build phase used | 65% | 69% | 65% | **108%** |
| matches unfinished | 2 of 3 | **1 of 8** | 3 of 3 | **0 of 8** |
| rounds | 26.7 | 12.1 | 33+ | 4.5 |

Marshal, which could not finish a single match on any seed tried, now finishes all of
them with essentially every gun it owns firing.

Two players, six seeds, marshal against marshal — a case none of the above touched, and
the one the unit tests run:

| | before | after |
| --- | --- | --- |
| matches unfinished | **4 of 6** | **0 of 6** |
| rounds | 27.3 | 4.2 |
| cannons idle | — | 4% |
| room for another cannon | — | 4.9 |

**Measure a change against a worktree with its own `node_modules`.** The first attempt at
that baseline pointed the worktree's `node_modules` at the main checkout's, and npm
workspace links are relative — so `@rampart/ai` resolved back through the symlink into
the working tree and the "before" run was the after code. It reported hashes identical to
the new run, which read as "the change does nothing" rather than as the setup error it
was. Identical state hashes across a code change are evidence the code did not load, not
evidence it did nothing.

### What it exposed, which is a rules question and not a bot one

For the whole of 10f and 10g the binding constraint was that nobody's artillery worked,
and section 10f records raising fire rates to human clicking speed changing nothing.
That was never a test of the rules — it was a test of guns that were inert whatever
their rate. **Now that the guns fire, damage is the constraint, and there is nothing in
the rules that bounds it.** Cannons are indestructible and accumulate at two or three a
round forever, while repair capacity is fixed by the length of a build phase. The two
curves cross, and with three players they cross for everyone at once: marshal draws two
of eight now, both of them every surviving player eliminated in the same resolution.

`cannons.maxTotal` already exists in the ruleset and is `null`. That is the first thing
to try in the balance pass, ahead of the combat-to-build phase ratio and the reward
schedule.

### Still open

- **Gunner holds room for 1.1 cannons where marshal holds 5.5.** The tiers differ in
  budget, so a poorer bot correctly settles for a tighter wall — but 1.1 is close enough
  to the old failure that it is probably not only that. One of its eight seeds still did
  not finish.
- **Seat bias.** Eight seeds of three identical recruits went six wins to seat 2; the
  baseline runs skewed to a seat as well. The map is meant to be rotationally symmetric,
  so either it is not, or something in the turn order or in three-player targeting
  favours a seat. The stats dump is the tool for this and it has not been pointed at it.
- The **three-castle lever from 10g has now been tried, and it is worse.** Three castles
  a sector at spacing six, three players, six seeds: gunner went from one unfinished match
  in eight to **five in six**, its room from 1.1 to 0.2, and marshal's room from 5.5 to
  1.2 with idle guns back up from 10% to 28%. Fewer castles means fewer candidate walls,
  and the ones that remain are tighter — so it pushes on exactly the thing 10h had to
  correct. Reverted, and it should not be retried without a reason beyond the one in 10g,
  which was that matches never ended. They end now.
- **Matches may now be too short.** Two-player marshal runs 4.2 rounds and three-player
  4.5, against an original whose matches were brisk but not that brisk. This is the same
  finding as the balance note above seen from the other side, and the two should be tuned
  together rather than separately.

## 10i. Deployment is one image and one process

Implemented. `Dockerfile` builds the client, bundles the server, and ships a runtime
stage holding three directories and no `node_modules`.

### The environment may set a port and nothing else

Section 4's rule is that no game rule is hardcoded — every tunable lives in
`config/*.json` behind a strict schema. The tempting extension is a general environment
override, and it is the wrong one: **a rule an environment variable could change is a
rule two clients could disagree about**, which is a desync rather than a setting, and the
snapshot carries the ruleset precisely so that cannot happen.

A port is not a rule. It is where the process binds, and managed hosts assign it rather
than asking. So `PORT` and `HOST` are read from the environment ahead of the config file
in `main.ts`, with a validity check, and nothing else is. The narrowness is the point and
is worth defending if it is ever proposed to widen it.

### The server is bundled, and the no-build-step design survives

The image runs plain JavaScript rather than TypeScript through tsx, which keeps a dev
toolchain out of production and the image at a few megabytes. The obvious way to get
there — emit configs for `server`, `sim`, `ai`, `protocol` and `config`, each with a
`dist` and a `package.json` exports map pointing at it — would have contradicted
section 3's "internal packages export TypeScript source directly, so there is no build
step between them", and left five build graphs to keep in step.

`packages/server/build.js` instead has esbuild resolve the workspace links itself and
emit one file. No package gains a build config, dev is untouched, and the bundle is a
deployment artefact rather than a new layer in the architecture.

Three things it cost, all of them worth recording:

- **`ws` is CommonJS**, and its `require` of Node builtins does not survive ESM
  bundling: the server started and then died with `Dynamic require of "events" is not
  supported`. The bundle needs a `createRequire` banner. That same banner is what lets
  `ws` probe for `bufferutil` and `utf-8-validate`, find them absent, and carry on — so
  the image can ship with no `node_modules` at all.
- **The output must live at `packages/server/dist/`.** `paths.ts` finds the repository
  root by walking three directories up from itself, and that is how both `config/` and
  the built client are located; `dist` sits at the same depth as `src`, so nothing
  changes. Somewhere tidier would have needed a code change, and a silent one — the
  server would start and then fail to find its rules.
- **There is no Docker on the development machine.** Everything above was verified by
  assembling the runtime stage's three directories by hand and running the bundle from
  them with no `node_modules` on the path: it served the client, served a hashed asset
  with the right MIME type, answered the healthcheck, and completed a WebSocket room
  creation. That is a good test of the bundle and no test at all of the Dockerfile, so
  CI now builds the image and curls it. **That job is where the Dockerfile is actually
  exercised.**

### Not done here

`assets/audio/` is not copied into the image and the static handler would not serve it
if it were — it serves only from the client's `dist`. Whether audio files ship as static
assets beside the client or go through Vite's `publicDir` is a decision for the audio
work, and guessing at it now would have meant wiring half of it.

## 10j. Audio

Implemented. `packages/client/src/audio.ts` plays; `matchAudio.ts` decides what and
when. No audio files exist yet, so the game still runs and sounds exactly as it did —
which is the property section 7.4 asked for and is now load-bearing rather than
aspirational.

### The cue list is smaller and differently cut than 7.4's

Eighteen effects and four tracks became thirteen and five, and the music is organised by
mood rather than by phase: **castle select, cannon placement and building share one
track**, because they are one experience from the player's side — arranging a position
with nothing incoming — and only the barrage gets its own. Victory and defeat are
separate tracks where there was one game-over cue.

Two of the effects are spoken, and they are the phase boundaries that matter: `voice_fire`
opens combat and `voice_cease_fire` closes it. "Closes" means the step into the
intermission, not the last impact — shots already in the air still land, but no further
one can be started, which is exactly what the call means.

### What the sound is allowed to know

Every cue but one is driven by a simulation event rather than by the client's own
guess, so what a player hears is what the authoritative server actually did: a shot
confirmed, a wall that really came down, a castle genuinely sealed. The exception is
the countdown, which is a clock reading and has no event behind it.

**Nothing in audio may reach the simulation.** Choosing among a cue's variants is
random and uses `Math.random`, never the match `Rng` — drawing from the seeded stream
would make two clients with different audio settings produce different matches. That is
the same rule as everywhere else in `sim`, arriving from an unexpected direction.

The fanfare is deliberately not "you are enclosed". It fires when a wall closes around a
castle the player **was not already holding**, because still holding one castle is true
of every round they survive and is not news. Its counterpart fires when they hold less
than they did. An elimination has its own cue and is left uncrowded.

### Anything the browser can decode

`decodeAudioData` takes bytes and does not consult the extension or the content type, so
the manifest may name any format and cues need not agree with one another. The server's
MIME table knows `.ogg`, `.mp3`, `.wav`, `.m4a` and `.flac`; an unlisted extension is
served as an unknown binary, which still plays but is worth adding.

The one to think about is Ogg, which section 7.4 assumed throughout: Safari's support for
Vorbis and Opus arrived late and older iOS does not have it. `.wav` for short effects and
`.mp3` or `.m4a` for music is the combination with no such asterisk.

### Where the files live, and why that needed no server change

`assets/audio/` is now the client's Vite `publicDir`. The dev server hands the files
straight out and `vite build` copies them into `dist/`, which is already what the
production server serves and what the Dockerfile already copies — so audio needed no
change to the server, the static handler or the image. The manifest's `basePath` is
`audio` because a public directory's *contents* are served at the site root.

**A missing file cannot be recognised from its HTTP status.** The static handler answers
an unknown path with the client's `index.html` and a **200**, which was measured
directly: `/audio/sfx/cannon_fire.ogg` returns 823 bytes of `text/html`. So an absent
cue arrives as a perfectly successful response, and what identifies it is that it will
not decode. The consequence worth knowing is that **a corrupt or truncated file is
indistinguishable from a missing one and will be silent rather than noisy.**

### Two things that are about taste, and were decided by arithmetic

Identical cues starting within **60ms** of each other are dropped. Three players with ten
guns each put dozens of shots in the air over a ten-second combat phase; twenty copies of
one sample a few milliseconds apart do not sound like twenty cannons, they sound like
distortion.

A browser will not start an `AudioContext` without a user gesture, so the first click or
keypress anywhere switches sound on. Calls made before that are **dropped rather than
queued** — a burst of everything that was missed, arriving at once the moment audio
unlocks, is worse than having missed it. Music is the one exception: the last requested
track is remembered, so the right one is playing when sound arrives rather than whatever
the next phase change happens to ask for.

### What is verified, and what cannot be

`matchAudio.test.ts` covers the translation — twelve cases over the calls in and out of
combat, the shared admin track, wall-versus-ground impacts, own-versus-rival placements,
the fanfare's "new castle" condition, elimination, victory against defeat, silence in a
watched match, and the countdown. It runs without a browser, an audio context or a sound
file, which is what the two-method `Cues` interface is for.

The built client was loaded headless in Chrome, at the menu and through a watched match
at ten times speed, with no runtime error.

The loading and decoding path was then verified against real files. Driving the actual
`Audio` class in headless Chrome with `missingFilesAreSilent` turned off makes every
failure a warning, so the set of warnings is exactly the set of cues that did not decode.
With one `.wav` and one `.mp3` supplied, the context reached `running`, twenty-three of
the twenty-five paths in the manifest warned — every file that does not exist, which is
the negative control that the capture works at all — and **the two real files were absent
from that list**, meaning both fetched and decoded. The server served them as `audio/wav`
and `audio/mpeg`.

So format support is whatever the browser decodes, and both of the formats most worth
having are confirmed. What is still unverified is subjective rather than structural: the
mix. Every `volume` in the manifest is a guess until somebody listens.

## 10k. Flight time is the reload, and it was set too short

A cannon cannot fire again until its shot lands — there is no separate reload — so
`shots.baseFlightMs` and `perTileFlightMs` set the rate of fire, and the honest unit for
them is **shots per cannon per combat phase**. Counted against the original, from
observation: ours fired about four times to the original's three.

Measured from `--stats` (`shotsFired / cannonsActive` at each resolution, three players,
eight seeds), and tuned against that number rather than against feel:

| base / per tile | 20-tile flight | shots per cannon | notes |
| --- | --- | --- | --- |
| 350 / 35 | 1.05s | 4.5 | as shipped |
| 500 / 60 | 1.70s | 4.5 / 4.1 | |
| 600 / 80 | 2.20s | 4.2 / 3.1 | gunner idle 57% |
| 700 / 90 | 2.50s | 3.6 / 3.6 | |
| **850 / 110** | **3.05s** | **3.1 / 3.0** | adopted |

### What it says about the bots

The interesting result is one nobody asked for. At 500/60, with **no change to the bot at
all**, gunner's room for another cannon went from 1.1 to 5.3, its idle guns from 19% to
8%, castles sealed from 1.59 to 1.94, and its use of the build phase from 69% to 114%.

`widestAffordable` already asks for room first and surrenders it only to the budget, so
when incoming damage fell the repair bill fell, the budget stretched, and the roomy wall
came back on its own. **The bots' minimal enclosures were largely a symptom of excess
firepower, not an independent defect** — they were not choosing to turtle, they were
being priced into it. Worth remembering before writing a rule against behaviour that a
config value was causing.

### What it did not fix

Match length. Marshal at three players went 4.5 rounds to 4.1; two-player gunner averages
**2.8 rounds with two draws in six**. Mass simultaneous elimination is untouched and
`cannons.maxTotal` is still `null`.

And at 850/110 the accumulation problem is visible from the other side: matches last
longer, so marshal ends up owning 8.6 cannons and keeping only 6.2 of them enclosed —
idle back up to 28% from 13% at 700/90. That is not a flight-time fault; it is the
arsenal growing faster than the territory that has to hold it, which is the same finding
as 10h's and the same lever answers it.

A test asserting a two-player match ran past round five was removed. It was calibrated to
the old tuning and was measuring the ruleset rather than the bot; what replaced it is a
competence floor — both gunners survive the first round — which balance work should not
move.

## 10l. Rectangular islands in a pattern, and the map measured from them

Implemented. The wedge layout is gone.

### One island, copied

An island is drawn inside a rectangular generation box, **trimmed to its actual land**,
then stamped into N placements by translation and mirroring. Both transforms are exact
on a square grid, so every island is pixel-identical at every player count — where the
rotational layout could only manage that at 2 and 4, because a third of a turn has no
representation on a square grid.

What that deleted: the `exactRotation` special case, the slack tile in the channel, the
`repairedTiles` repair pass, and four of the six rejection reasons. `island_overlap`,
`island_area`, `island_split` and `water_gap` are now true by construction, so
`componentCount` and `waterGapHolds` went with them. Only `canonical_area` and
`canonical_castles` remain. `terrain.ts` is shorter than it was despite gaining the
pattern engine.

### Patterns, and why they are configuration

`config/terrain.default.json` carries one pattern per player count: a grid for 2, 4, 6
and 8, a ring for 3, 5 and 7. A ring puts every player the same distance from the same
two neighbours, which is the uniform answer and the right one for odd counts; a grid is
tighter but gives edge and middle seats different neighbourhoods. Exact fairness is not
required — the point of 6 and 8 is team modes, which rebalance by how the teams are
drawn — so where the two differ the tighter map wins.

Measured, seed 1: 2p 52x25, 3p 55x49, 4p 52x48, 6p 77x48, 8p 102x48, with rings at 5 and
7 costing noticeably more. **Both focus counts came out smaller than the 56x56 they
replaced**, and every count generates on the first attempt with exactly equal areas.

Moving 5 or 7 to a grid is a JSON edit, which is the point of the table being config.

### The map is measured, and it has to be measured from the land

The map's size is not configured. It falls out of the island and the pattern, which is
what lets one configuration serve two players and eight without either being cramped or
swimming in ocean.

**Measure the island, not the box it was drawn in.** The first attempt spaced the boxes
by the channel width, which is wrong by the amount of box an island does not fill —
about a third — so eight or ten tiles of open water sat between the land. Section 1.2
rules that out: flight time scales with distance, and an ocean between players means
slow artillery and matches that will not end. The channel test caught it by reporting
zero channel tiles. The box is a frame that needs slack so the coastline is shaped by
noise rather than by the frame; the layout is spaced on the trimmed land.

That slack is now guarded at startup: an island filling more than 80% of its box gets a
configuration error, because a coastline pinned by the frame produces the same map for
every seed — the 10g trap, which generates perfectly and looks fine in one screenshot.

### It reset the balance baseline, as expected

A compact rectangle makes a tight cut cheaper than a wedge did, so `ROOM_RADIUS` — tuned
on wedges at 2 — was mistuned. At 3 it recovers: marshal's room for another cannon went
1.8 back to 7.3. Every number in 10h and 10k was measured on the wedge map and is
historical.

## 10m. Two bot faults found by watching, and what fixing them exposed

### A shot destroys exactly the tile it hits, so two shots at one tile is one wasted

Observed while spectating: a bot's whole opening salvo went into a single block. The
target list was consumed only when a tile stopped being wall, so with a three-second
flight and a gun firing every 150ms, every shot in the air was aimed at the same place.

Targets are now taken off the list when fired at, and any tile with a shot already
inbound — **anybody's** shot, since a block an opponent is about to remove does not need
removing twice — is skipped.

### Idling in a build phase is almost never right

Also observed: bots stopping with time left. `thickenTargets` could come back empty and
the bot would stand down for the rest of the phase.

The ladder now ends in `spareWork`: reach for the next castle, and failing that take in
more open ground for the cannons the wall will earn. **Affordability is deliberately not
consulted.** It governs whether to commit to a plan over staying alive, which is the
gamble 10d found you must not take; spending time nobody else wants is not that gamble.
A part-built extension of a live wall touches territory, so the sweep leaves it standing
and the work carries into the next phase — which is the difference between an expansion
that takes two rounds and one that never happens.

Measured, three players, eight seeds:

| | before | after |
| --- | --- | --- |
| gunner room for another cannon | 1.7 | **7.6** |
| gunner build phase used | 58% | **121%** |
| gunner cannons idle | 30% | **16%** |
| marshal build phase used | 88% | **101%** |
| marshal cannons idle | 38% | **31%** |

Three players is in good order: marshal runs 4.6 rounds over eight seeds with none
unfinished, 3.14 shots per cannon, and wins spread 4/2/2 across the three seats.

### What it exposed, and it is not small

**Fixing the targeting multiplied real damage several times over.** The rate was already
calibrated to the original's three shots per cannon — but three shots that each remove a
block is a different weapon from three shots that remove one between them.

Two-player matches are now erratic in a way three-player ones are not: over six seeds,
two were decided in **round one**, one ran to the tick limit, and the rest scattered
between. Raising flight time to 1050/135 stops the round-one eliminations but drops the
rate to 1.4-2.6 shots per cannon, well under the original's three — so flight time is the
wrong lever. It is correctly set; the damage those shots do is what is now unbalanced.

The levers that remain are the opening cannon count, the build phase length against the
combat phase, and `cannons.maxTotal`, which is still `null`. That is the balance pass,
and two-player is where it should start.

Three bot competence tests were moved from two-seat to three-seat tables. Run on two
players they were measuring this imbalance rather than the bot.

## 10n. The sweep was a cascade, and the original was not

Observed against the original: the sweep removed too much.

It had two rules, both wrong. It pruned to the **2-core** of the wall graph — dropping
loose ends repeatedly until none were left — and then deleted whatever did not reach
sealed ground. Both are gone. What remains is one pass: **mark every wall block with
fewer than two orthogonal wall neighbours, then remove the marked blocks together.**

Marking before removing is the whole of it. Judging each block against a board that is
already being dismantled is what turned one pass into a cascade, and the difference is
not subtle: a five-block spur reaching towards another castle used to unravel completely
in a single resolution, so a wall half-built could never be carried across a round. Now
it loses its tip and keeps the rest.

A run of three reduces to its middle, which then stands alone — it had two neighbours
when the question was asked. It goes next round.

**Stranded wall now stays.** The rule requiring a wall to reach sealed ground is dropped
entirely, so a loop enclosing nothing survives. That is deliberate: it is not litter but
an obstacle, standing where a cannon cannot be placed and where a future wall has to
route around. The original kept it too.

The safety property is unaffected and still tested: every block of a loop has two
orthogonal neighbours, so a wall holding an enclosure together can never be swept —
which is what makes it safe to run automatically at every resolution.

### What it measured

Three players, eight seeds, per surviving player-round. The visible change is how much
wall survives, which is the point:

| | before | after |
| --- | --- | --- |
| marshal wall tiles | 67 | **88** |
| gunner wall tiles | 53 | **75** |
| marshal rounds | 4.6 | 5.4 |
| gunner cannons idle | 16% | 30% |

Room for a cannon slipped a little at both tiers — 7.0 to 6.6 and 7.6 to 6.0 — which is
the arithmetic of more wall standing on the same ground, and gunner's idle guns rose with
it. Neither is alarming and both are the balance pass's business.

A fourth bot test moved from a two-seat to a three-seat table. Its pacing assertions were
never reached: a two-player match now ends before there are enough build phases to
measure a build rate over. Two players remains the case to fix, as 10m says.

## 10o. Continues

Implemented. Two lives beyond the first, as in the original, and failing to seal now
spends one instead of ending the match.

What happens: the island is wiped — cannons, shots in the air, and **the wall itself**,
which is more than `stripEliminated` did. That function leaves an eliminated player's
wall standing as unowned rubble, which is reasonable for somebody who is out and wrong
for somebody about to build again, who would otherwise have to plan around the wreck of
their last attempt. Then a castle is owed, chosen during the coming cannon phase, and the
ring goes up around it exactly as at the start of a match.

Cannons are the opening count plus one for each life already spent, so a player on their
last life fields more guns than one on their first.

### A continue rewinds the player's piece schedule, and that retires a stated rule

Section 1.5 said every player draws the same seeded sequence. They no longer do. A
continue sets the player's `pieceRound` to zero, so the next round deals them round one's
pieces — the small ones a player starting again needs to close a ring — while whoever has
survived longest goes on drawing the wide, awkward ones.

That makes the piece schedule a **personal difficulty ramp keyed to how long you have
held on**, which is a rubber band with real force: it stacks with the fresh compact ring
and the extra cannon. All three together are what make a continue worth having rather
than merely survivable.

`build.sharedPieceSequence` was dead config — declared and never read, the second such
flag after `layout`. It is now false, and the schema **refuses** it being true alongside
`resetPieceScheduleOnContinue`, so the consequence has to be written down in the config
rather than discovered in a match.

### The pause, and why it is in the sim

A life lost or a player knocked out adds `phases.continueBannerMs` to the intermission.
That is match timing rather than decoration: every client has to spend the same number of
ticks on it or they disagree about when the next phase began. One pause however many
players it was — the banners sit over their own islands and cannot overlap, so they are
all readable at once.

### Three things that had to change to let a player choose mid-phase

- `select_castle` was gated on `phase === 'castle_select'` and on having no castle yet.
  Both now admit a player who owes a choice during `cannon_place`, which is the same
  question asked twice, so it is the same predicate: `owesCastleChoice`.
- **`advancePhase`'s cannon-phase early exit would have ended the phase before they could
  act.** It stops when every player is `eliminated || cannonsToPlace === 0 ||
  !canPlaceAnyCannon`, and a player who owes a castle has no territory, so
  `canPlaceAnyCannon` is false and they read as finished. Found by reading rather than by
  playing, which is the only reason it is not a bug report.
- A player who lets the clock run out gets a castle and guns chosen for them, from
  `streamFor(seed, 'fallback:round:player')` — deterministic, because `Math.random` is
  banned in `sim` and a replay has to reproduce these like any other choice. Without it,
  hesitating would leave them with no ring at all and cost them a second life for it.
  Only a person can reach this path: a bot always acts, and a dropped seat is played by
  one.

### What it measured

Three players, gunner, six seeds: **32 continues and 13 eliminations**, no action ever
refused, and every invariant held at the moment of the continue — island empty of walls
and guns, cannon grant equal to `startingCount + spent`, piece schedule at zero, castle
cleared and later rechosen.

Matches run **11.8 rounds** against 4.4 before, which is what three lives each should
cost. Nothing unfinished.

### Verified, and not

The simulation is covered: six tests in `match.test.ts`, and the banner wording and
timing window in `banners.test.ts` — which is why that decision was pulled out of
`main.ts` into a function of its own.

**The banners have not been seen.** Headless Chrome cannot show them: after 120 seconds
of virtual time at ten times speed a watched match is still on round 0, because the
render loop is barely driven. That also means the "ran a watched match with no runtime
error" checks in 10i and 10j were weaker than they sounded — the match was not
progressing far enough to exercise much. Anything time-dependent in the client needs a
real browser and a person watching it.

### Tests that had to say what they meant

`options()` in `match.test.ts` now builds its ruleset with `withoutContinues`, and so
does the stopgap suite. Nine tests broke on this change, all of them asserting that
failing to seal ends a player's match — which is still true, but only once the lives are
gone. Saying so explicitly beats them quietly measuring something else.

## 10p. Cannon clearance, the starting ring, and an arc nobody could see

### A cannon jammed against its own wall makes a hole nobody can fill

Observed while spectating: bots pick a castle on the shore and then stand cannons on the
wall beside it. A shot there leaves a one-tile gap with the cannon on one side and water
on the other — and a piece is at least two cells from round three on, because the size
schedule stops dealing ones after round two. The hole is not awkward, it is **permanent**.

Measured: players eliminated at a resolution had **15.1** such holes against **10.1** for
survivors.

`placeCannon` scored candidates purely on closeness to the nearest enemy castle, so it
had no reason not to press against the wall. It now prefers clearance and settles ties on
proximity — compared as a pair rather than summed, so there is no exchange rate to invent
between tiles of cover and tiles of range. Clearance is Chebyshev distance to the nearest
own wall **or water**, capped at two, from one distance field per placement rather than a
scan per candidate.

### The opening is geometry, not choice

The first survey said all 120 opening cannons across twelve matches sat at clearance one,
which looked like the bot's fault. It is not. A castle sits **centred** in its starting
ring, so at `ringRadiusTiles: 3` the free interior is a band exactly two tiles wide and a
2x2 cannon spans it completely. Surveyed directly: sixteen legal opening spots, every one
at clearance one. The bot had no better move available.

Widening the ring to 4 does make room — opening clearance went from 1.00 to 1.98 and
two-player round-one eliminations from 2 in 12 to none — **and it was reverted anyway.**
An 8x8 starting wall around a 6x6 interior is what the original had and what the game is
built around, and fidelity won. The clearance preference stays, because it governs every
round after the first, once a player holds enough ground to have a choice.

What made the revert cheap is continues (10o): a failed opening now spends a life instead
of ending a match. Measured after reverting, ten matches at each count, no elimination
before **round 4** at three players or **round 6** at two — the early knockouts the wider
ring was protecting against are gone for a different reason.

The cost is real and worth recording: room for another cannon fell from 8.3 to 3.1 at
three players and idle guns rose from 28% to 44%, which is the arithmetic of a 6x6
interior instead of an 8x8. Matches are long now — 15.3 rounds at three players, 25.7 at
two with one unfinished in ten.

### The shot arc followed the reload

Shots were flying off the top of the screen. The lift was `sin(pi * t) * span * 0.25`
where `span` is the flight **in ticks**, so the picture was tied to the reload: when
flight time went from 1.05s to 3.05s at twenty tiles (10k), the apex went from 8 tiles to
23. A five-tile lob peaked 10 tiles in the air.

It now scales with the **range** a shot is thrown, which is what a lob's height should
follow and which survives any amount of balance tuning: `sin(pi * t) * min(range * 0.22,
5)`. At twenty tiles the apex is 4.4 tiles rather than 23. Both styles drew their own copy
of the old formula; there is now one `shotLift` in `theme.ts`, so the next person to tune
it has one number to find.

(The first attempt used 0.16 and a 4.5-tile cap, which watching found too flat once the
shots were no longer leaving the screen.)

### And they were too slow, which is a different number

Flight time had been tuned against shots per cannon averaged over a whole match, and that
average hid the problem: **in round one a cannon at the median range of 26 tiles managed
2.8 shots, and one at 35 tiles only 2.1.** The distribution over eight seeds was 2x:5
3x:30 4x:1 5x:5 6x:1 — so the long guns were firing twice while the close ones fired six
times, and the whole thing looked sluggish.

Tuned against the round-one distribution instead, `850/110` becomes **`1600/45`**: 3x:25
4x:22 5x:1, mean 3.50, **minimum three**. Every cannon now gets its three salvos.

The trade is worth recording, because it is forced by geometry rather than chosen. Shot
distances in round one run from about 10 tiles to 36, a spread of nearly four to one, so
no setting gives every cannon exactly three: guaranteeing three at the far end hands the
close ones four or five. Pushing the mode down to three everywhere needs flight to be
nearly constant with distance — around `2400/20` — which contradicts section 1.4's rule
that flight time scales with distance, and makes close shots *slower* than they were.
Lowering the per-tile term rather than the base is the compromise: **25-38% faster at
every range beyond twenty tiles, and within 5% of unchanged at point blank.**

## 10q. The online lobby, tested at last and then polished

### It had never been opened at more than four seats

The player cap went from four to eight (10l) and the online path was never exercised at
it: the protocol had validated 2-8 on both sides long before a room was asked to hold
eight. Covered now, both ways.

In `room.test.ts`: eight clients take eight distinct seats, a ninth is refused, and a
600-tick eight-player match leaves every client bit-identical to the server. And over a
real socket against the built server: seats 0-7 assigned in order, the ninth refused with
`room_full`, the match starting with eight people. Both worked first time — the cap was
genuinely the only thing in the way.

**The lobby had no way in except the menu**, which is why it went uninspected for so
long. `?host=N` and `?join=CODE` now open it directly, the way `?autostart=1` has always
opened the offline game. A whole path being untestable is itself the bug that lets it rot.

### Polish

The markup moved into `lobbyMarkup` in `lobby.ts`, a function of the room rather than
something assembled in place — whether a guest is shown the host's controls is exactly
the kind of thing that is obvious in the code and still wrong on the screen. Eight tests
cover it, including the eight-seat case that started this.

What changed for a player: the room code is set large and monospaced with a **Copy**
button beside it (falling back to selecting the text, because the clipboard API is
unavailable over plain http on anything but localhost — which is how somebody will first
try this on a home network); every seat carries the **colour it will actually play in**,
so the lobby and the board agree; seats read *"2 of 8 taken — the rest are played by
bots"*; and each bot tier says what it does, since "gunner" tells a new player nothing.

That last one needed a second pass. Explaining the tier on every row gave eight identical
lines of explanation on a default table, which reads as noise and buries the line doing
the work. It is now explained once per distinct tier.

Names are escaped. They come from other players and the server caps their length, not
their content.

Three copies of "player colour as CSS" became one, in `colours.ts`.

## 11. Deferred (explicitly out of scope for v1)

Team modes (2v2), quick-match / matchmaking queue, accounts and persistence, ranking,
mobile and touch input, spectator mode, shipped replays, naval units, singleplayer campaign.
````
