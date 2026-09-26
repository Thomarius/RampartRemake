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

2–8 players, free-for-all. Empty seats are filled by AI. Team mode is planned (§11.7) and
not built. Despite what this section used to claim, **the data model is not team-aware**:
score, lives and elimination all belong to a player, and every "whose is this" test is
player against player. Three and four players are the focus; the higher counts exist
mainly so team modes have somewhere to go.

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
-> [enclosure resolved; points banked; a player with no enclosed castle spends a life or is out]
-> CANNON_PLACE    place the cannons you earned, ending early once done
-> COMBAT ...
-> GAME_OVER       last player standing, or the best score at the round cap;
                   simultaneous elimination is a draw
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
- **Only an opponent's wall can be damaged.** `fire()` refuses a target on your own
  island, and an impact clears a wall only if a live opponent owns it — so a wide crater
  cannot reach your own, and an eliminated player's unowned rubble is indestructible.
  `shots.damagesOwnWalls` turns this off; self-inflicted damage never scores either way.

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
one-tile gap with no free neighbour cannot be filled at all.

**Overtime.** When the build clock runs out, every player may still place the one piece
they are holding, within `build.overtimeMs` (3 s); no further piece is dealt, and the
window closes early once everyone still in has used it. Added after human play: a piece
being lined up as the clock hit zero was simply lost, which was frustrating out of all
proportion to what it decided. It gives everyone slightly more wall per round, which the
elimination baseline of 11.2 will be measured with. That is why a cannon jammed
against its own wall is a defensive problem and not merely an ugly one.

### 1.7 Scoring and the round cap

A match ends at the resolution of round `scoring.maxRounds` (default 10; a host picks 5
to 20), or earlier when one player is left. **The cap is the main win condition, not a
tie-breaker**: most matches reach it, so the scoring formula is the game's balance and
elimination the exception. At the cap the highest score among those still in wins, and a
tie is a shared win — which is not a draw. **A player who is out cannot win however many
points they had**, which keeps attacking worth it for somebody behind. Simultaneous
elimination is a draw whatever the scores.

Points are banked at each build-phase resolution, after the sweep, by every player holding
a sealed castle:

- `wallPoints` for each **opponent's** wall tile they destroyed that round;
- `tilePoints` × **total enclosed tiles × total enclosed castles**, across every region
  they hold. Totals, not per region: two one-castle loops of 30 tiles score 120, as one
  loop around both would. An enclosed tile is `territory === id + 1`, castle and cannon
  footprints included, so placing a gun never costs points.

Failing to seal forfeits the round's points, damage included
(`scoreDamageOnFailedRound` turns that off), and spends a life as usual — in the final
round too. The HUD shows banked scores only, never a running tally that could still be
forfeited. `maxRounds: null` lifts the cap for tests; no host can choose it.

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

| File                   | Governs                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ruleset.default.json` | Phase lengths, cannon rewards and footprint, shot flight and damage, the piece catalogue and its size schedule, enclosure rules, elimination and continues, scoring and the round cap |
| `terrain.default.json` | Island size and shape, the generation box, castle placement, the starting ring, the per-player-count pattern table                                                                    |
| `ai.default.json`      | One profile per bot tier: pace and aim in milliseconds and human units, and playstyle switches                                                                                        |
| `art.default.json`     | Palettes, per-player colour ramps, sprite generator parameters                                                                                                                        |
| `audio.manifest.json`  | Cue names to files; see `assets/audio/README.md` for what fires each one                                                                                                              |
| `server.default.json`  | Ports, room limits, rate limits, reconnect grace, and the bounds of what a host may set in the lobby                                                                                  |

`validateConfigBundle` checks what a single file cannot: that there are at least as many
player palettes as allowed players, that every playable count has a pattern, that a cannon
fits inside a starting ring, that the island does not fill its generation box, that the
lobby's round bounds include the ruleset's own cap, and that every audio cue in code exists
in the manifest.

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
- **Resolution of a round**: resolve enclosure, award cannons, spend lives or eliminate,
  strip the eliminated, re-apply enclosure, sweep, re-apply enclosure, bank points, then
  check for the end of the match — one player left, or the round cap.

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
- **Lobby settings are a mechanism, not a special case**: an explicit list of typed
  settings (`config/src/settings.ts`), bounded by `server.lobbySettings`, accepted only
  from the host before the start, refused whole when out of bounds, and applied over the
  server's ruleset — which is re-validated and travels in the snapshot. Only `maxRounds`
  exists so far; game speed and team mode are meant to join it.

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
`bannersFor` in `banners.ts`, `lobbyMarkup` in `lobby.ts`, the score text in `scores.ts`.

**Territory is drawn as the board stands, not as the sim last recorded it.** The sim
refreshes `territory` at placements and resolutions but not when shots land, since a
breach only counts at a resolution; drawn from state, a castle breached in combat stayed
shaded as sealed. The client recomputes the enclosure for display whenever structures
change, and the roster counts castles from it — and so does everything below that says
"sealed".

**Feedback a player builds by.** While nothing of yours is sealed, your castles are
outlined (`hints.ts`). The gap itself used to be marked too, and was removed after the
first human play: the marks were hard to tell from the piece ghost and from laid wall, and
read as the only way to repair it when any closing shape will do. Points float up from
each island as they are banked. **The time left** runs as a bar under the HUD and, in
large faint figures, in open water near the middle of the map (`timerSpot.ts`: the
largest all-water square close to the centre, 3x3 to 5x5, found once per match). **The
aiming cursor** says whether a click will fire — a bright crosshair when a gun is ready,
a small grey ring struck through when none is — with the number ready beside it; it
appears as "Fire!" is announced, though a click does nothing until the phase opens. When
placing cannons the same badge counts the guns still to place. The points an island
banked hold over it with the new total for the whole intermission (`hud.pointsBannerMs`). Sealed
castles fly a banner in pixel style; a lost life lands as a banner over the island, red
on the last; a knockout stamps the island and greys it for the rest of the match.

**Combat, in pixel style.** Barrels turn to their target, recoil and flash; destroyed
wall throws debris in its owner's colour; shots trail; the board shakes, but only when a
shot breaks your own wall. The flat style stays plain, as the one to debug against.

**Looking at it.** `tools/screenshots.sh` captures fixed states against the dev server —
in real time through Playwright, which renders fine where virtual time does not — using
`&snapshot`, `&round`, `&idle` and a wait. Anything lasting under a second (debris, the
shake) still has to be seen by a person.

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
  this. Once sealed, `widestAffordable` asks for room first and gives it up a tile at a
  time until the plan fits the phase's budget.
- **But when breached, the tightest wall that keeps the guns comes first**, and room is
  bought once something is sealed. Asking for room first is what lost a quarter of all
  rounds 1–3 cells short (ARCHIVE 10s). A bot counts its sealed castles with
  `computeEnclosure`, never from `enclosedCastles`, which landing shots do not refresh.
- **Cannons are never pinned when there is any alternative**: a spot beside a wall block
  with nothing buildable beyond it is where one shot makes a hole only a one-cell piece
  fits. Then clearance from wall and shore, then range.
- **Attacking is a 0-1 BFS** from the border, free across open ground and one per wall
  block, which finds the thinnest part of a defence. One shot per tile: a shot destroys
  exactly the tile it hits, so a second is always wasted.
- **Pace is in human units** — milliseconds per placement, scaling with piece size — so a
  bot slows as the piece schedule widens, for the same reason a person does.
- A bot **does not idle while anything is worth building**. Choices are tried in turn —
  the plan, thickening, the next castle (up to every castle on the island), more room,
  and finally any tile against the outside of its wall — skipping tiles already found
  unreachable, and a failed fit falls through to the next rather than pausing.
  Affordability governs whether to commit to a plan over staying alive; it does not govern
  spending time nobody else wants.

Four tiers: **recruit**, **gunner** and **marshal** differ in aim, target choice, ambition,
replanning rate and pace; **baron** has marshal's skill with a different playstyle —
reaching for the next castle the moment it holds one (`expandsWhenSealed`, `maxCastles`
4). It is as strong as marshal, not stronger, and exists for variety. Measured 2026-09-25
at three players, both seats: marshal beats two gunners 29 of 40, baron 28; gunner beats
two recruits 9 of 12. Records in the archive from before 10l are historical.

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
(`stateFromAscii`, with an optional island overlay for walls and castles that belong to
someone other than island 1). A test that asserts "failing to seal ends your match" needs
`withoutContinues`, and so does anything measuring the piece-size ramp; anything about
elimination or long matches needs `withoutRoundCap`. Enclosure in real play is checked at
every resolution against an independent search, not only on unit pictures.

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

### 11.1 Round cap and points scoring — done

The rules are §1.7, the lobby setting §6; how they were settled is ARCHIVE 10r.

### 11.2 Elimination tuning — planned, waiting on human play

**Agreed 2026-09-25, not started.** The user is playing a few matches first, so the
tuning is not fitted to the bots and misses the human experience.

**Target:** at three and four players, about **half of matches end with one player left
before the cap**, under the default rules — a 10-round cap, combat and build phases as
they are. Demanding: it needs two or three players knocked out, each failing to seal
one time more than their lives allow, inside ten rounds. Today's bots manage 0 of 8.

**The weights stay.** They were taken from the original and are believed sound, and they
barely decide how often somebody is knocked out: that comes from how often walls fail
(attack against repair speed), how many lives there are, and how many rounds there are
to fail in. The weights decide who wins at the cap, and shape eliminations only through
how much risk players take. The formula already rewards size strongly — two castles in 60
tiles score 120 a round against 30 for one in 30, so the bigger wall is worth trying
unless it fails more than about 75% of the time. That the bots turtle anyway is their
risk model (affordability, never points), not the formula.

**The soak's limit.** It measures bots, and today's are careful: they forfeit about 11% of
rounds, which makes three failures in ten rounds — two continues and the last — roughly
a one-in-forty event per player. A person reaching for more ground fails more often.
Human testing is not available at scale, so the bots have to bracket human play instead.

Before this state, three gunners over eight matches, before and after bots learned to
close a breach first (10s): forfeits 22% -> 11%, territory per sealed round 80 -> 41,
castles 1.17 -> 0.92, matches won by elimination 3/8 -> 0/8. Later fixes took territory
back to 52 and castles to 1.03; eliminations stayed at zero.

**Levers agreed:** continues 2 -> 1; **a placement delay**, new; and, to be measured rather
than assumed, bot targeting. **Not levers:** the cap length, and combat and build times.

#### Steps

1. **Baseline at three and four players**, current rules — all-gunner, all-marshal, and a
   mixed table with baron. Share ending with one player left, eliminations per match,
   lives spent, forfeit rate, and the round each elimination happens in. Measurement only.
2. **An ambitious, points-driven personality**, the first piece of 11.6: it chooses plans
   by expected points rather than by affordability alone — bigger walls, more castles,
   more risk — standing in for the way people play. Every lever is then measured against
   both the careful bots and this one, and the answer should lie between them.
3. **Placement delay, `build.placementCooldownMs`**: after placing a piece, a player
   cannot place another until it has passed. Enforced by the sim for everyone, in ticks
   and per player, so it stays deterministic and is hashed and snapshotted. The client
   shows the cooldown on the piece preview. Bots wait for it, and **their budget must
   include it** — an optimistic estimate of how many pieces fit a phase is exactly what
   cost them a quarter of their rounds (10s). Per piece, a fixed time, to start with;
   scaling with piece size is the variant to try if a fixed delay is too blunt. Default 0
   until measured.
4. **A small grid**: continues 2 or 1, delay 0 and a few values up to about a second —
   measured at three and four players against both ends of the bracket, both seats.
   Choose the setting nearest half on a mixed table.
5. **Guardrails before choosing**, so the target is not bought with a worse game: hardly
   anyone out in rounds 1–2 (an early knockout feels bad, and continues exist to prevent
   it); the ladder still ordered; two players not noticeably worse (11.3).

**Targeting, a third lever to measure in step 4.** Bots that pick targets shoot the
strongest opponent, which spreads damage and keeps everyone alive — the opposite of what
this target needs. Finishing off the weakest, as a personality trait (11.6), may matter
as much as either rule.

**What to take from the user's play first:** whether building already feels tight at
default speed, whether a delay would feel like a penalty or like the original's pace,
and how often a person actually loses a castle — the number the whole bracket rests on.

### 11.3 Two-player balance

The worst thing in the project. At gunner, over ten seeds: **33.8 rounds average, three
matches unfinished, cannon room 0.7, and only 48% of the build phase used.** Three players
is healthy by comparison at 12.3 rounds. The bots are back to cramped walls with idle guns
— the failure mode of 10h — because the smaller starting ring plus heavier incoming fire
leaves no budget for room.

Levers not yet tried: `cannons.maxTotal` (still `null`), the opening cannon count, and the
combat-to-build ratio. **Needs re-measuring before anything is tried**: that figure predates
the round cap and the bots of 10s. At the cap, eight two-player gunner matches all reached
round 10, two ending by elimination. Best done after 11.2, since the weights change what
balanced means.

### 11.4 Measurements never taken

- **Seat bias** at 4, 6 and 8 players, where grids give seats structurally different
  neighbourhoods. At three players the gap seen in 10s was mostly a bot bug; with it fixed
  marshal wins about equally from seats 0 and 1.
- **The full difficulty ladder**, every pairing and more than three players. Measured so
  far only at three: marshal and baron over gunner, gunner over recruit.
- **`resetPieceScheduleOnContinue`**, against the alternative. Only the "on" setting has
  ever run.

### 11.5 Smaller

- Audio files: 2 of 18 cues exist. The rest are the user's to produce; the manifest and
  every trigger are wired.
- Islands look boxy; `coastlineRoughness` and `noiseFrequency` are config.
- Rings at 5 and 7 players make considerably larger maps than grids would. One JSON edit.

### 11.6 Bots as personality and skill

Today a tier bundles two things: **skill** — pace and aim (`placement*Ms`,
`fireIntervalMs`, `aimJitter`, `replanTicks`) — and **personality** — how it plays
(`maxCastles`, `riskMargin`, `picksTarget`, `thickens`, `expandsWhenSealed`). Split them,
so a seat is a pair and the combinations make for more varied opponents. The profile fields
already fall cleanly into the two groups. Open: the set of personalities (for instance
aggressive, defensive, expander), how the lobby offers the pair, and whether
`server.botDifficulty` becomes two settings. Independent of balance, so it can run beside
11.2.

### 11.7 Team mode — planned, agreed 2026-09-26

Chosen by the user to come next, ahead of 11.2–11.6. Nothing is built.

#### The rules

- **Teams of equal size only.** A team size needs at least two teams, so within 2–8
  players: size 2 at 4, 6 or 8 players; size 3 at 6; size 4 at 8. Odd counts are
  free-for-all only. The host picks the team size first; only valid player counts remain.
- **No attacking a teammate in any way.** `fire()` refuses a teammate's island, an impact
  clears no teammate's wall, and bots never target one.
- **Shared score: the sum of each member's own score**, each computed exactly as today
  (their tiles × their castles, plus their damage). Not team tiles × team castles, which
  grows with the square of team size.
- **Pooled lives.** A team starts with the sum of its members' continues (three players at
  two each: six). A member who fails to seal spends one from the pool, and their own island
  is wiped, their castle chosen again and their piece schedule rewound, as today.
- **Lose together.** A member failing with the pool empty knocks the whole team out, even
  teammates who sealed — intended: they would very likely lose on score anyway. The win is
  the last team standing, or at the cap the best team score; a tie is a shared win.
- **Extra cannons after a continue** count the team's lives spent, not the player's, and
  are capped: at most +3 (`elimination.maxExtraCannons`, new).
- **Helping build.** A player may place pieces on a teammate's island, from their own
  queue, so helping spends their own build time. The wall belongs to the island's owner,
  not the placer, so the sweep, damage and rubble rules need no change. Who may do it is a
  rule, `teams.crossIslandBuild: 'none' | 'humans' | 'all'`, **default `humans`**: a bot
  laying wall on a person's island against their plan would be infuriating. A person
  building on a bot's island is fine — the bot replans around it as it does around
  breaches. **Cannons stay on your own territory only.**

#### The design move: every match is a team match

Free-for-all is teams of one. Score, the pool of lives and elimination move from the
player to the team, and every "opponent" test becomes "not on my team". So FFA behaves
exactly as now by construction, and today's tests go on guarding it — rather than a
second copy of every rule beside the first.

#### Presentation

- **Colour families per team, each player still their own colour**, from palettes in the
  art config chosen by layout: pairs as reds, blues, greens and purples; 3v3 and 4v4 as
  warm against cool shades. Four shades of one hue are hard to tell apart, so **every team
  also carries a letter** — on the island banners, in the roster, at the end. FFA keeps
  today's eight distinct colours. Shades to be chosen by screenshot.
- The roster grouped by team, one score and one lives display per team; "Team A knocked
  out"; the end screen names the winning team.

#### Seating and the lobby — decided 2026-09-26

- **The host chooses the teams; which island each player gets is random.** The sim keeps
  its invariant that player `p` owns island `p + 1` — territory, cannons, bots and the
  client all lean on it — so islands are not shuffled inside the sim. Instead the room
  shuffles **which seat becomes which player** at the start, seeded from the match seed
  so a match is reproducible. The server still owns identity: it tells each connection
  its player id once the match starts, as it does now at join. Offline, the local lobby
  does the same shuffle. A random layout can seat teammates side by side one match and
  diagonally the next — symmetric at 2v2 on the 2x2 grid, not at 2v2v2 on 3x2; T6
  measures it.
- **One lobby for online and offline.** One lobby screen, one set of controls — seats and
  who holds them, bot skills, team size and each seat's team, rounds. If a server is
  reachable the lobby also opens a room and shows its code; if not, the code is simply
  not shown. At start, **if no other person has joined, the match runs locally** in the
  browser exactly as offline play does now; otherwise on the server. Solo play never
  needs a network, which keeps the dev offline mode and static hosting working. The
  lobby is a pure view of a lobby model, tested like `lobbyMarkup`, with two backends:
  local, and the room.
- **Team assignment in the lobby.** The host picks a team size; only player counts that
  make at least two equal teams remain (size 2: 4, 6 or 8; size 3: 6; size 4: 8). Seats
  start in teams in order and the host can move any seat to another team, as long as the
  teams stay equal; Start is refused otherwise. Guests see the teams, cannot change them.

#### Steps, each shippable, FFA the default throughout

| Step                      | Content                                                                                                                                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1 Sim core**           | Teams in the state, FFA as teams of one: team score, pooled lives, team elimination, team winners, no friendly fire, capped continue bonus. Tests, including that FFA outcomes are unchanged — identical hashes where the rules do not differ.                                            |
| **T2 Helping build**      | `crossIslandBuild`, walls owned by the island's owner, the piece ghost on a teammate's island.                                                                                                                                                                                            |
| **T3 Bots**               | Never target a teammate; never build across islands unless the rule allows.                                                                                                                                                                                                               |
| **T4 Lobby and protocol** | The single lobby with its local and room backends; team size as a lobby setting with its valid player counts; seat-to-team assignment by the host; the seeded seat-to-player shuffle at start and the message that tells each connection its player id; the snapshot; `PROTOCOL_VERSION`. |
| **T5 Client**             | Colour families and team letters, the roster by team, team score and lives, team banners and end screen.                                                                                                                                                                                  |
| **T6 Measure**            | Headless `--teams`; 2v2 fairness and the layout bias of random seating.                                                                                                                                                                                                                   |

---

## 12. Deferred (explicitly out of scope for v1)

Quick-match and matchmaking, accounts and persistence, ranking, mobile
and touch input, spectator mode, shipped replays, naval units, singleplayer campaign.
