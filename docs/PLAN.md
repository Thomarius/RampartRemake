# Rampart Remake — design and open work

A multiplayer-only recreation of the 1990 Atari arcade game _Rampart_, condensed to a
single game mode, with online play, AI opponents, and fully procedural visual assets.

This file describes **the game as it is now, and what is left to do**. How each decision
was arrived at — with the measurements, and the attempts that were reverted — is in
[`ARCHIVE.md`](./ARCHIVE.md). Where the two disagree, this file is right.

**Values are not repeated here.** Every tunable lives in `config/*.json` behind a strict
schema; quoting numbers in prose only guarantees they drift. This file says what is
configurable and why it matters.

---

## 1. The game

### 1.1 Match structure

2–8 players, free-for-all. Empty seats are filled by AI. The data model is team-aware so
2v2 can be added later without a refactor, but no team mode ships in v1. Three and four
players are the focus; the higher counts exist mainly so team modes have somewhere to go.

Every phase is simultaneous and real-time, and each is preceded by an **intermission**,
during which nothing is playable: shots still in the air land, then a pause, then the
announcement for the next phase crosses the screen. The next phase begins only once it
has left.

```
LOBBY
-> CASTLE_SELECT   pick one of the castles on your island
-> [a wall ring is auto-built around it]
-> CANNON_PLACE    place your opening cannons inside that ring
-> COMBAT          click targets; cannons lob shots at enemy walls
-> BUILD           place wall pieces on your island
-> [enclosure resolved; a player with no enclosed castle spends a life or is out]
-> CANNON_PLACE    place the cannons you earned, ending early once done
-> COMBAT ...
-> GAME_OVER       last player standing; simultaneous elimination is a draw
```

Phase durations are in `ruleset.phases`. The intermission is not decoration: its length
is part of match timing, so every client has to agree on it.

### 1.2 Map

One island is drawn inside a rectangular box from the seed, **trimmed to its actual
land**, and stamped into N placements by translation and mirroring. Both transforms are
exact on a square grid, so every island is pixel-identical at every player count.

- **The map's size is measured, not configured.** It falls out of the island and the
  pattern, so two players get a small map and eight get a large one without either being
  cramped or swimming in ocean.
- `terrain.patterns` gives one arrangement per player count: a **grid** at 2, 4, 6 and 8,
  a **ring** at 3, 5 and 7. A ring puts every player the same distance from the same two
  neighbours; a grid is tighter but gives edge and middle seats different neighbourhoods.
  Exact fairness is not required — the higher counts exist for team modes, which rebalance
  by how the teams are drawn — so where the two differ the tighter map wins.
- Islands are separated by a channel of `island.minWaterGapTiles`, guaranteed by
  construction rather than tested for. **The channel must be measured from the land, not
  from the generation box**: an island fills about two thirds of its box, and spacing the
  boxes leaves an ocean between the players. Flight time scales with distance, so an ocean
  means slow artillery and matches that will not end.
- The generation box needs real slack over the target area. An island that nearly fills it
  has its coastline pinned by the frame rather than by the noise, and **every seed then
  produces the same map** — which generates perfectly and is caught only by a determinism
  test. The config validator refuses it.
- Each island carries the same number of castles, and **the starting ring is 8x8 around a
  6x6 interior**, as in the original. A castle sits centred in it, so the free band is
  exactly two tiles wide and a 2x2 cannon spans it: opening cannons _must_ touch the wall.
  That is geometry, not a bot failing.
- No fog of war; every island is fully visible to everyone.

### 1.3 Walls and enclosure

- Walls may only be placed on free land of your own island. You cannot build in or
  interfere with an opponent's territory.
- **The shoreline does not count as wall.** Enclosure is a flood from the map border
  across every non-wall tile — water included — and any castle not reached is enclosed.
- **The wall must turn its corners.** The escape flood is 8-connected while the wall is
  not, so the sea slips between two blocks meeting at a point: a diagonal join does not
  seal.
- A single sealed region containing K castles counts as K castles. Separate regions stack.
  This is the central tradeoff: a wide loop earns more cannons but leaves far more
  perimeter to repair each round.
- **Orphaned wall is swept** between build and combat, in one pass: every block with fewer
  than two orthogonal wall neighbours is marked against the board as it stands, then the
  marked blocks go together. A run of three keeps its middle; a spur loses only its tip.
  Cascading instead takes far too much and means half-built wall can never carry across a
  round. Stranded wall is left standing as an obstacle. Orthogonal deliberately: that is
  the connectivity which makes a wall a wall, and it means **a loop enclosing anything can
  never be swept**.

### 1.4 Cannons

- 2x2 footprint, placed inside your own enclosed territory, including the opening ones.
  The game builds your starting ring, but every cannon you own you placed yourself.
- **Indestructible.** Only walls are damaged; castles and cannons are not.
- Reward per build phase is in `ruleset.cannons`: a fixed number for the first enclosed
  castle and more for each additional one.
- A cannon **not inside an enclosed region** at a resolution is **inert**: it cannot fire,
  is not destroyed, and reactivates if re-enclosed. Breaching a leader's wall silences
  their guns. This is the game's main corrective and the source of most bot trouble.
- Firing: click a target; the nearest ready cannon fires. A cannon is ready only when it
  has no shot in flight — **there is no separate reload, so flight time _is_ the rate of
  fire**. Tune it against shots per cannon in round one, not against a match average.
- Flight time scales with distance. Unlimited range. A shot destroys exactly the tile it
  hits; wider craters remain available through `shots.craterPattern`.
- `fire()` does **not** restrict whose wall you may target. A player may legally shoot
  their own wall or neutral rubble, which matters for any rule that rewards damage.

### 1.5 Continues

Failing to seal a castle spends a life rather than ending the match. The island is wiped —
cannons, shots in the air, and the wall itself — a castle is chosen again during the
coming cannon phase, a fresh ring goes up, and the player places the opening count plus
one cannon for each life already spent. Out of lives, failing is final.

A continue also **rewinds that player's piece schedule to round one**, so somebody
starting again gets the small pieces they need to close a ring while whoever has survived
longest goes on drawing the wide ones. That makes the schedule a personal difficulty ramp
keyed to how long you have held on — and it is why `build.sharedPieceSequence` is false.
The schema refuses the two being true together.

A player who lets the cannon phase run out without choosing gets a castle and guns picked
for them from a seeded stream, so hesitating does not cost a second life.

### 1.6 Build pieces

Tetromino-like wall pieces, drawn from a bag that **widens by round** (`build.sizeSchedule`)
— small pieces early, large ones late. That is the game's difficulty ramp.
`pieceAt(ruleset, seed, round, index)` is a pure function, so a client regenerates its own
queue rather than receiving it, and the match state stays a fixed size however long a
match runs.

Note the consequence: **one-cell pieces stop being dealt after the early rounds**, so a
one-tile gap with no free neighbour cannot be filled at all. That is why a cannon jammed
against its own wall is a defensive problem and not merely an ugly one.

---

## 2. Technology

| Layer      | Choice                                                          | Rationale                                                                                                       |
| ---------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Language   | TypeScript 5.9.3, end to end                                    | One simulation shared by server, client, AI and tests. Pinned below 6 while `typescript-eslint` requires it     |
| Client     | Vite + PixiJS v8                                                | WebGL batching and filters for shots, explosions, water                                                         |
| Server     | Node + `ws`                                                     | Tiny protocol surface; a hand-rolled room layer beats fighting a framework's state-schema system on a tile grid |
| Transport  | WebSocket, JSON v1                                              | Input is about one message per second per player; binary is unnecessary                                         |
| Validation | zod, server-side                                                | Never trust a client message                                                                                    |
| Tests      | vitest                                                          | Fast, TS-native                                                                                                 |
| Packaging  | npm workspaces                                                  | Internal packages export TypeScript source, so there is no build step between them                              |
| Deploy     | Docker, one process serving the static client and the WebSocket | Fly.io / Railway / self-host                                                                                    |

Authoritative server, **no rollback netcode needed**: both phases are simultaneous but not
twitchy, and a shot's flight time absorbs RTT entirely.

---

## 3. Repository layout

```
RampartRemake/
├── config/            every tunable, as JSON behind a strict schema
├── assets/audio/      audio cues, committed — the image builds from a clean checkout
├── packages/
│   ├── config/        zod schemas, typed defaults, cross-file validation
│   ├── sim/           deterministic core — no DOM, no Node, no I/O
│   ├── protocol/      wire messages and validators
│   ├── ai/            bot logic
│   ├── server/        authoritative match server
│   └── client/        renderer, UI, procedural asset generators
├── tools/headless/    bot-vs-bot harness for balance tuning and soak tests
└── Dockerfile         build the client, bundle the server, ship three directories
```

---

## 4. Configuration

**No rule is hardcoded.** Every tunable lives in `config/*.json` behind a strict schema —
an unknown key is an error, not a silently ignored one. The ruleset travels in the match
snapshot, because a client on different rules would desync rather than merely look wrong.

| File                   | Governs                                                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ruleset.default.json` | Phase lengths, cannon rewards and footprint, shot flight and damage, the piece catalogue and its size schedule, enclosure rules, elimination and continues |
| `terrain.default.json` | Island size and shape, the generation box, castle placement, the starting ring, the per-player-count pattern table                                         |
| `ai.default.json`      | One profile per difficulty, in milliseconds and human units                                                                                                |
| `art.default.json`     | Palettes, per-player colour ramps, sprite generator parameters                                                                                             |
| `audio.manifest.json`  | Cue names to files; see `assets/audio/README.md` for what fires each one                                                                                   |
| `server.default.json`  | Ports, room limits, rate limits, reconnect grace                                                                                                           |

`validateConfigBundle` checks what a single file cannot: that there are at least as many
player palettes as allowed players, that every playable count has a pattern, that a cannon
fits inside a starting ring, that the island does not fill its generation box, and that
every audio cue in code exists in the manifest.

---

## 5. `packages/sim` — the deterministic core

### 5.1 Determinism is not negotiable

`(seed, ruleset, ordered input log)` must always produce one identical match. The server
sends **actions and the tick they landed on**, not board state, and every client replays
them — so any nondeterminism is a desync, not a cosmetic bug.

- `Math.random`, `Date.now` and `performance` are banned in `sim` and `ai` by lint rule.
- `Math.sin/cos/sqrt` are implementation-approximated per spec, so `trig.ts` and `math.ts`
  provide exact replacements.
- Every tile layer is a typed array sized `width * height`; no floats in state.
- Every 30 ticks the server sends a state hash and clients check it.

Anything the sim must choose for a player — the fallback castle when somebody runs the
clock out, for instance — comes from `streamFor(seed, name)`, a pure function, so a replay
reproduces it like any other choice.

### 5.2 Core algorithms

- **Terrain**: noise inside a box, thresholded to a target area, eroded, largest component
  kept, castles placed by farthest-point sampling, then trimmed and stamped into the
  pattern.
- **Enclosure**: 8-connected flood from the border across non-wall tiles. What it does not
  reach is enclosed. Re-run whenever wall changes.
- **Sweep**: one marking pass over the wall graph, described in 1.3.
- **Shots**: flight ticks from distance; on impact the target tile is cleared if it is
  wall. The shooter is known; the wall's owner must be read _before_ it is cleared.
- **Scoring of a round**: resolve enclosure, award cannons, spend lives or eliminate,
  strip the eliminated, re-apply enclosure, sweep, re-apply enclosure.

---

## 6. Netcode

The server owns the match. Clients send intents; the server validates, stamps a tick, and
broadcasts. **The server overwrites the `player` field of every incoming action with the
sender's seat**, so a client cannot act for someone else.

- **Nothing derivable is transmitted.** Terrain and the piece queue are regenerated from
  the seed; the snapshot carries only what cannot be derived.
- Clients run one tick behind the server's confirmed tick and apply committed actions.
- A dropped seat is handed to a bot so the match does not stall; the player gets their seat
  back on reconnect within the grace period.
- Rooms are found by a short code from an alphabet chosen to avoid ambiguous characters.

---

## 7. `packages/client`

Two visual styles behind one `Theme` interface: the scene owns the camera, the layer
stack, dirty tracking and input mapping; a theme owns only what things look like. All
sprites are generated at boot from `art.default.json` plus the match seed — nothing binary
is committed except audio.

Audio is driven by simulation events, so what a player hears is what the server actually
did. Missing files are silent by design, which is what lets the game ship before the audio
does. **A missing file cannot be told from its HTTP status** — the static handler answers
an unknown path with `index.html` and a 200 — so absence is detected by failure to decode,
and a corrupt file is silent rather than noisy.

**Anything in the client that depends on the clock cannot be verified headlessly.** A
watched match is still on round 0 after two minutes of virtual time, because the render
loop is barely driven; headless Chrome catches a crash on load and nothing else. The
pattern that works is to pull the decision out into a pure function and test that —
`bannersFor` in `banners.ts`, `lobbyMarkup` in `lobby.ts`.

---

## 8. `packages/ai`

Bots play through the same validated action API as a person, so they cannot cheat by
construction, and the soak asserts they never ask for a move the rules refuse.

- **Sealing is a minimum cut.** Enclosure is an escape flood, so sealing is cutting every
  path: buildable tiles get capacity one, everything else infinity, and the minimum cut
  between border and castle is the smallest wall that works. Built over the bot's own
  island alone, which is exact and far faster than the whole grid.
- **A minimum cut is the _tightest_ wall that works** — which is exactly the wall with
  nowhere to put a gun, and the most fragile one. Nearly every bot problem traces back to
  this. `widestAffordable` therefore asks for room first and gives it up a tile at a time
  until the plan fits the phase's budget; a tight wall is the last rung, not the first.
- **Attacking is a 0-1 BFS** from the border, free across open ground and one per wall
  block, which finds the thinnest part of a defence. One shot per tile: a shot destroys
  exactly the tile it hits, so a second is always wasted.
- **Pace is in human units** — milliseconds per placement, scaling with piece size — so a
  bot slows as the piece schedule widens, for the same reason a person does.
- A bot whose plan is standing **thickens or reaches further rather than idling**.
  Affordability governs whether to commit to a plan over staying alive; it does not govern
  spending time nobody else wants.

Difficulty tiers differ in aim quality, target choice, ambition, replanning rate and pace.
**The head-to-head records in the archive are historical**: they were measured on the
wedge map that 10l replaced, and have not been re-run.

---

## 9. Testing

- **Unit** — enclosure golden cases, sweep geometry, placement validation, crater
  application, reward maths, scoring.
- **Determinism** — `(seed, ruleset, input log) -> state hash` must be stable; recorded
  logs are replayed in CI.
- **Property/fuzz** — random valid input streams; assert invariants.
- **Terrain** — generated maps satisfy every fairness constraint across many seeds at
  every player count, and **vary between seeds**, which is a different question from
  fitting.
- **Server integration** — in-process fake sockets: join, reconnect, rejected inputs,
  bot takeover, a full table.
- **Headless harness** — `tools/headless` runs bot-vs-bot matches without rendering.
  `--stats FILE` writes a row per player per round at each resolution; prefer it to
  watching. Watching is for forming the hypothesis.

Tests state expectations as ASCII pictures where the subject is geometric
(`stateFromAscii`). A test that asserts "failing to seal ends your match" needs
`withoutContinues`, and so does anything measuring the piece-size ramp.

---

## 10. Milestones

| #   | Goal                                                      | State                    |
| --- | --------------------------------------------------------- | ------------------------ |
| M0  | Scaffold, config schemas, CI                              | Done                     |
| M1  | Simulation core                                           | Done                     |
| M2  | Playable locally, placeholder art                         | Done                     |
| M3  | Style abstraction, then procedural art                    | Done                     |
| M4  | Online multiplayer                                        | Done                     |
| M5  | AI opponents                                              | Done                     |
| M6  | Full scope: 2–8 players, audio, lobby, Docker, deployment | Done but for audio files |
| M7  | Balance pass                                              | **In progress**          |

---

## 11. Open work

### 11.1 Round cap and points scoring — designed, not built

Agreed in full and not started. Everything below is design.

#### The rules

A match ends after `maxRounds` (default 10), or earlier when one player is left, as now.
If two or more are still in it at the cap, the highest score among them wins; a tie is a
shared win. **A player who is out cannot win however many points they had** — being
eliminated is worse than any score, which is what keeps aggression worth it when behind.

Points are awarded at each build-phase resolution, to every player holding a valid
territory with at least one castle:

- `wallPoints` (default 2) for each wall tile that player destroyed during the round.
- `tilePoints` (default 1) for each enclosed tile, multiplied by their castle count.

A player who ends the round without a valid territory scores **nothing for that round**,
including the damage they dealt. They may spend a continue as usual.

#### Why it is expected to work, and what it really changes

The scoring is aimed squarely at the failure mode this project keeps returning to: a
minimal enclosure that survives forever. Under points, a tight wall around one castle
scores almost nothing and loses on the clock.

Measured first, because it changes what this feature is. At today's bot play, with the
default weights:

|                                 | 3 players                      | 2 players  |
| ------------------------------- | ------------------------------ | ---------- |
| matches reaching round 10       | 4 of 8                         | 7 of 8     |
| enclosed tiles per player-round | 35                             | 42         |
| castles                         | 1.16                           | 1.35       |
| territory points                | 62                             | 87         |
| walls destroyed, as points      | 16.8 -> 34                     | 13.9 -> 28 |
| split                           | 65% territory / 35% aggression | 76% / 24%  |

**The cap is not a tie-breaker, it is the main win condition** — most matches will be
decided on points rather than by elimination. That makes the scoring formula the game's
balance, and the elimination rules the exception. Worth holding in mind when tuning: the
split will drift further toward territory as play improves, because tiles times castles
grows with the square-ish term while damage stays flat.

#### Which walls score

Only a wall belonging to somebody else. `state.owner[i]` already carries the island for
each wall tile and is cleared to zero when a player is eliminated or a wall is swept, so
the test is cheap — but it has to be read **before** `resolveImpacts` clears it.

Shooting your own wall must not score, because nothing prevents it: `fire()` has no
island check at all, so a player could shoot a spare stretch of their own wall for two
points a tile and rebuild it in the build phase they were spending anyway.

**Recommended: score nothing for it rather than forbidding it.** Since 10n the sweep
leaves stranded wall standing as an obstacle, and clearing your own rubble out of the
ground a cannon needs is now a legitimate use of a shot. Forbidding self-fire would take
that away to fix a problem that scoring zero already fixes. One line either way.

Rubble left by an eliminated player is unowned, so it scores nothing under the same test.
That is also fine on its own terms: shooting rubble spends a shot without touching a live
wall, which helps every opponent.

Note that this cannot be balance-tested by the usual soak until 11.2 lands.

#### What has to change

**Config** (`ruleset.scoring`): `maxRounds`, `wallPoints`, `tilePoints`, and
`scoreDamageOnFailedRound` (default false) — the last so the alternative to the
forfeit rule can be measured later without a code change.

**Sim.** `PlayerState` gains `score` and a per-round `wallsDestroyed`. `resolveImpacts`
credits the shooter, reading the victim's owner before clearing it. `resolveRound` scores
every surviving player, then resets the accumulators. `checkGameOver` gains the cap.

Scoring is measured **after** the sweep and its `applyEnclosure`, so the territory scored
is the territory that will face the next barrage. A loop that encloses anything can never
be swept, so in practice this should equal the pre-sweep figure; defining it removes the
ambiguity rather than relying on that.

**A shared win needs a shape for it.** `MatchState.winner` is `number | null` today.
Ties are rare but real, so this becomes a list, and the change ripples through the
snapshot schema, the client's end-of-match banner and several tests. Worth doing
properly rather than encoding "shared" as a draw, because a shared win is not a draw.

**Lobby settings, built as a mechanism rather than a special case.** Only `maxRounds` is
settable now, but game speed, team mode and special weapons are coming, so:

- `config/server.default.json` declares what a host may change and within what bounds —
  which keeps "no rule is hardcoded" true, since the _range_ is configuration too.
- The room validates a host's setting against those bounds, ignores a guest's, and locks
  them once the match starts, exactly as bot difficulties already work.
- The match ruleset is the server's with the host's overrides applied, and travels in the
  snapshot as it always has. Determinism is unaffected.
- The same control appears in the offline menu, or the two paths diverge and the round
  limit cannot be felt out offline.

**Client.** Scores in the HUD roster, and the leaderboard carried by the phase
announcement that already follows a build phase — so it costs no extra pause. The table
is built by a pure function and tested like `lobbyMarkup` and `bannersFor`, since
headless Chrome cannot check anything that depends on the clock.

### 11.2 Teach the bots to play for points

Deliberately a second step. Their ladder is survival-shaped and their ambition is capped at
two castles because reaching further was measured to _lose_ — a finding about surviving,
not about scoring. Under points, more castles is strictly better, so that cap becomes a
handicap.

Until this lands, **a soak cannot tell whether the scoring weights are right**: a
points-decided match between current bots goes to whoever accidentally held more ground.
This is the first feature here shipping without the tool that tuned everything else.

### 11.3 Two-player balance

The worst thing in the project. At gunner, over ten seeds: **33.8 rounds average, three
matches unfinished, cannon room 0.7, and only 48% of the build phase used.** Three players
is healthy by comparison at 12.3 rounds. The bots are back to cramped walls with idle guns
— the failure mode of 10h — because the smaller starting ring plus heavier incoming fire
leaves no budget for room.

Levers not yet tried: `cannons.maxTotal` (still `null`), the opening cannon count, and the
combat-to-build ratio. The round cap may well absorb this on its own, which is a reason to
do 11.1 first.

### 11.4 Measurements never taken

- **Seat bias.** A documented gotcha, hinted at twice, never measured. It matters more now
  that grids at 6 and 8 give seats structurally different neighbourhoods.
- **The difficulty ladder**, on the current map. `--difficulty marshal,gunner,recruit`
  exists for it and has never been used.
- **`resetPieceScheduleOnContinue`**, against the alternative. Only the "on" setting has
  ever run.

### 11.5 Smaller

- Audio files: 2 of 18 cues exist. The rest are the user's to produce; the manifest and
  every trigger are wired.
- The continue and elimination banners work but could be more impressive.
- Islands look boxy; `coastlineRoughness` and `noiseFrequency` are config.
- Rings at 5 and 7 players make considerably larger maps than grids would. One JSON edit.

---

## 12. Deferred (explicitly out of scope for v1)

Team modes (2v2), quick-match and matchmaking, accounts and persistence, ranking, mobile
and touch input, spectator mode, shipped replays, naval units, singleplayer campaign.
