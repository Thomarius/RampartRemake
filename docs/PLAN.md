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

2–8 players, free-for-all or in equal teams (§1.8). Empty seats are filled by AI. Three
and four players are the focus. **Every match is a team match internally**: free-for-all
is teams of one, so a rule written for teams is the free-for-all rule too.

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

### 1.8 Teams

- **Equal teams only**: a team size needs at least two teams, so within 2–8 players size
  2 allows 4, 6 or 8; size 3 only 6; size 4 only 8. Odd counts are free-for-all.
- **No attacking a teammate in any way**: `fire()` refuses a teammate's island, an impact
  never clears a teammate's wall, bots never target one.
- **A shared score**, the sum of each member's own (their tiles × their castles, plus
  their damage).
- **Pooled lives**: a team starts with the sum of its members' continues; a member who
  fails spends one, and their own island is wiped as in §1.5. **A member failing with the
  pool empty puts the whole team out**, sealed members included. The continue bonus counts
  the team's lives spent, capped by `elimination.maxExtraCannons` (3).
- **Helping build**: a player may place pieces on a teammate's island, from their own
  queue. `teams.crossIslandBuild` says who may — `humans` by default, since a bot laying
  wall against a person's plan would be infuriating. The wall belongs to the island's
  owner, not the placer, so every other rule treats it as theirs. Cannons stay on your own
  territory.
- **Teams belong to seats; the host chooses who sits where.** Teams are seats in order
  (teams of two: seats 1–2 are Team A, 3–4 Team B), shown as one column each, and the host
  picks the occupant of every seat — a bot or any person at the table, by name — swapping
  with whoever sat there (`configure.move`). A bot keeps its skill when it moves. There is
  no per-seat team choice: moving one seat's team always unbalanced them, so it could only
  ever be refused. Which island each seat gets is shuffled at the start (§6), and the
  lobby's map shows the deal. Random islands were measured to decide nothing (ARCHIVE 10u).
- **Shown** by colour families — each team one hue, each member a shade — plus a team letter
  over every island, a roster grouped by team, and team wording on banners and the end
  screen. **The letter is the lobby's**: `denseTeams` numbers the host's labels in label
  order, so Team A in the lobby is Team A in play whichever seats the shuffle dealt where.

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
- **One lobby for online and offline.** The lobby is one screen (`lobbyMarkup`) fed by a
  room when a server answers with a welcome within two seconds, and by a table held in the
  browser when not. Both change the table through one rule, `reshapeTable` in config. A
  room nobody else joined is played locally when the host starts it. Solo play never needs
  a network.
- **Seats are shuffled onto islands at the start**, seeded from the match seed, server and
  local alike. The sim's invariant that player p owns island p + 1 is untouched — it is
  the seats that move, and the server tells each connection which player it has become.
- **The seed is fixed when the table is set, not when the match starts**: a room draws it
  at creation and a local table from the browser's entropy as the lobby opens, and the
  host may draw another or type one (`configure.seed`; `?seed=N` for testing). Since
  terrain and the seat shuffle follow from the seed alone, the lobby shows the map that
  will be played and which island each seat gets, in the colour it will play.
- **Seats are held where the host put them** until the start: a newcomer takes the lowest
  free seat, somebody leaving moves nobody, a shrinking table brings anyone beyond it into
  a free seat, and whoever is moved is sent a fresh `welcome` with their new seat.
- **The host may put a bot in their own seat** (`configure.hostBot`) and watch: the server
  marks the seat a bot's, ignores the host's actions, and keeps it the bot's if they
  reconnect. With nobody else at the table that is a match of bots alone, which replaced
  the separate "watch the bots" button.
- **Lobby settings are a mechanism, not a special case**: an explicit list of typed
  settings (`config/src/settings.ts`), bounded by `server.lobbySettings`, accepted only
  from the host before the start, refused whole when out of bounds, and applied over the
  server's ruleset — which is re-validated and travels in the snapshot. Only `maxRounds`
  exists so far; game speed and team mode are meant to join it.

---

## 7. `packages/client`

Two visual styles behind one `Theme` interface: the scene owns the camera, the layer
stacks, dirty tracking and input mapping; a theme owns only what things look like. All
sprites are generated at boot from `art.default.json` plus the match seed — nothing binary
is committed except audio.

Audio is driven by simulation events, so what a player hears is what the server actually
did. Missing files are silent by design, which is what lets the game ship before the audio
does. **A missing file cannot be told from its HTTP status** — the static handler answers
an unknown path with `index.html` and a 200 — so absence is detected by failure to decode,
and a corrupt file is silent rather than noisy.

**Two looks, swapped by the banners, as in the original** (`transition.ts`). Each player
chooses a style for building and one for combat (`art.styles`: flat and pixel by
default). Combat is drawn in the combat look, everything else in the build look, and the
banners either side of combat change one for the other as they cross the board — above
the banner's middle already the new look, below it still the old. The banner after the
build phase carries the sweep instead: the sim sweeps at the resolution, and the client
keeps drawing the swept blocks until the banner's line passes their row, when each
crumbles. The banner's position is a pure function of the sim clock, so the wipe is
always exactly beneath it. Both themes live for the whole match in separate layer stacks
under masked roots; the hidden one is only marked stale, and redrawn as a wipe reveals
it. The same style for both looks is one theme, and a banner then changes nothing.

**Anything in the client that depends on the clock cannot be verified headlessly.** A
watched match is still on round 0 after two minutes of virtual time, because the render
loop is barely driven; headless Chrome catches a crash on load and nothing else. The
pattern that works is to pull the decision out into a pure function and test that —
`bannersFor` in `banners.ts`, `lobbyMarkup` in `lobby.ts`, the score text in `scores.ts`.

**The menu and lobby** are dressed in the game's own art (`decor.ts`): the title set in
stone blocks, and the pixel sea drifting behind the panel. The lobby shows the map the
table will play (`preview.ts`) — each island in the colour its seat will play and numbered
for it, the viewer's own ringed — beside seat cards that carry the same number and
colour, a rank badge per bot tier, and columns per team. A newcomer's card flashes as they
sit down.

**The end of a round and of a match** (V6). Points banked at a resolution count up in the
island's banner, total and all, while a glow sweeps the island's territory outward from
its castles, both over `effects.tallyMs`. A lost life takes the island's wall down outward
from its middle over `effects.lifeCrumbleMs` instead of clearing it in a frame (the
cannons, removed from the state outright, still go at once). Once the match is over,
fireworks burst over the winners' islands in their colours for as long as the screen
stays up.

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
banked hold over it with the new total for the whole intermission
(`hud.pointsBannerMs`). A lost life lands as a banner over the island, red on the last; a
knockout stamps the island and greys it for the rest of the match.

**The build phase, felt** (`seal.ts`, `art.effects`). Sealing is drawn as ground being
taken: whenever the board's enclosure gains territory — a breach closed, a castle chosen,
a loop widened — the new ground floods outward from the castle, or from the edge of what
was already held, with a bright front running ahead of the paving. Every sealed castle
hoists a flag, in both styles, from the foot of its pole. A placed piece settles onto its
tiles from slightly large and bright, and in pixel style kicks up dust from its outer
edges. In pixel style the piece in hand is drawn as the wall it would make, joined to
itself and to the wall standing, and outlined in valid or invalid ink round its outside.
Overtime rings the board in a pulsing red border. All shared effects are drawn alike in
both styles where they carry information.

**Combat, in pixel style.** Barrels turn to their target, recoil and flash; destroyed
wall throws debris in its owner's colour; shots trail; the board shakes, but only when a
shot breaks your own wall. The flat style stays plain, as the one to debug against.

**The pixel style is the cinematic one**, since it is the default combat look. Light falls
from the north: a wall block with nothing to its south shows a dark front face under a
light lip, and walls, castles and guns cast a shadow onto the ground south of them. Sealed
ground is paved in the owner's colour rather than tinted. The sea darkens with distance
from land and surf breathes along the coasts. A shot on land leaves a scorch mark that
fades over `fx.craterRounds`; the blocks either side of a breach crack for the rest of the
round. An eliminated player's wall is rubble, and an inert gun slumps its barrel and
smoulders instead of being struck through.

**Combat, felt.** In pixel style a shot grows toward the top of its arc as its shadow
shrinks and fades; what it hits decides how it lands — a plume and rings in the sea, a
blast and dust on open ground, a blast on a wall that leaves the breach smouldering with
dark smoke and embers for `fx.smoulderMs` — and each gun puffs smoke from its muzzle as it
fires. In both styles the mark where a shot will land pulses ever faster as it nears, and
turns red and thick when it is coming down on the watching player's own wall; and a
breached castle's flag is lowered, struck in a darker shade, rather than vanishing.

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

**Teammates are never targets**, and cannons face the other teams' castles. Bots build
only on their own island, so they never help a teammate, whatever the rule allows.

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
| M8  | Team mode, and one lobby for online and offline           | Done                     |
| M9  | Visual pass: phase themes, banner wipe, effects, lobby    | Done (§11.8)             |

---

## 11. Open work

**Where to start (2026-09-26).** Team mode and the polish pass are done; the user is
playing test matches. The next milestone is **11.2, elimination tuning**, as soon as that
play has given a feel for it — its plan is ready and starts with a baseline measurement.
Beside it, independent of balance: **11.6**, bots as personality × skill. **11.8**, the
visual pass, is done. Smaller items are in 11.5.

### 11.1 Round cap and points scoring — done

The rules are §1.7, the lobby setting §6; how they were settled is ARCHIVE 10r.

### 11.2 Elimination tuning — planned, waiting on human play

**Agreed 2026-09-25, not started.** The user is playing a few matches first, so the
tuning is not fitted to the bots and misses the human experience.

**Changed since it was planned**: overtime shipped (§1.6), a little more wall per round
for everyone; and team matches eliminate even less than free-for-all — 5 in 180 at gunner
(ARCHIVE 10u), since a pooled life lasts a team longer. Measure 2v2 alongside three and
four players.

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

- **Position bias** at 4, 6 and 8 players, where grids give islands structurally different
  neighbourhoods. Seats are shuffled onto islands now, so no seat is favoured, but an
  island position still could be — it would show as the player on it winning more often,
  whoever that is. At three players the gap seen in 10s was mostly a bot bug; with it fixed
  marshal wins about equally from either island.
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

### 11.7 Team mode — done

The rules are §1.8, seating and the lobby §6; how it was built and measured is ARCHIVE 10u.
Left open: **bots do not help a teammate build**, even under `crossIslandBuild: all` —
teaching one to help without wrecking a person's plan is its own question.

### 11.8 Visual pass — done

**Agreed 2026-09-26, finished the same day** (ARCHIVE 10w–10z, 11a, 11b). Everything here
is client-side and cosmetic: no sim, protocol or ruleset change, so it cannot desync a match or move a balance measurement,
and it can proceed while 11.2 waits on human play. Cosmetic randomness may use
`Math.random` (the client is outside the lint rule), but durations, sizes and counts
belong in `art.default.json` like every other visual tunable, not in code.

**Verification, for every package.** Headless Chrome cannot check anything timed (§7), so
each package pulls its decisions into pure functions with unit tests — which look is on
screen, where the wipe line is, which walls are still drawn — adds a scene to
`tools/screenshots.sh` where a still frame shows it, and leaves anything under a second
to be looked at by a person.

Work packages in order. V1 is the feature; V2–V6 are independent of each other and can
be taken in any order after it, though V2 comes first because V1 makes the pixel style
the combat look specifically.

#### V1 — Phase themes and the banner wipe — done

Kept as it was planned, for the record; how it turned out is §7 and ARCHIVE 10w.

**The original.** The banners either side of the combat phase cross the screen from top
to bottom, and the board beneath changes as the banner passes: from the simple, flat look
of building to the more realistic, cinematic look of combat before it, and back after.
The banner between the build and cannon phases does not change the look; instead it
carries the sweep of loose wall, which vanishes row by row as the banner passes over.

**Today** all three parts exist but are not joined: one style is chosen for the whole
match (`Scene.useTheme` is called once), the announcement is a CSS animation across the
window that knows nothing of the board (`@keyframes sweep`), and the sweep is drawn the
moment the sim applies it at the resolution — before the banner shows — although the sim
already reports exactly which tiles went (`walls_swept`, ignored by the client).

**Decided with the user:**

- Two style settings, **build look** and **combat look**, default **flat** and **pixel**.
  The combat look is on screen during combat; the build look everywhere else — castle
  choice, cannon placement, building. Both are chosen from the same list of styles, so a
  new style is offered for either, and **choosing the same style for both switches
  nothing** (the banner still sweeps; nothing changes under it). No separate "classic"
  mode: it is simply the default pair.
- **"Fire!" wipes build → combat, "Rebuild" wipes combat → build**, and "Place cannons"
  carries the sweep. The sim is untouched: it still sweeps at the resolution, and the
  client only delays _drawing_ it. That is safe because nothing is playable during an
  intermission, and the next phase does not begin until the banner has left.
- **No special rule** for the rare round in which nobody has cannons to place and the
  sim goes straight to combat: the pending sweep is drawn away by whichever banner comes
  next, so that "Fire!" carries both the sweep and the wipe.
- The styles stay a per-player choice in the menu, not a table setting: they are how you
  see the game, not its rules, so they never travel to the server or the snapshot.

**Steps:**

1. **Settings.** `art.style` becomes `art.styles: { build, combat }`, both `ArtStyleSchema`,
   defaulting to `flat` and `pixel`. The menu's single Style select becomes two, "Building"
   and "Combat", remembered in `localStorage`. `?style=X` still sets both, for the
   screenshot script and old links; `?buildStyle=` and `?combatStyle=` set one each.
2. **Which look, as a pure function** of state alone, so a client joining mid-intermission
   gets it right without history. Before an intermission the look is combat exactly when
   `pendingPhase === 'build'` (only combat leads there); after it, combat exactly when
   `pendingPhase === 'combat'`. Outside intermissions it follows the phase.
3. **The banner follows the sim clock.** Its progress becomes a pure function of
   `(tick + tickFraction, phaseEndTick, bannerTicks)` and is applied as a transform each
   frame, replacing the CSS keyframes and the `animationend` removal. Then the wipe line
   _is_ the banner, and both stay right through dropped frames and at `&speed=`. The
   announcement's text and standings lines are unchanged.
4. **Two themes alive at once.** The Scene gets one layer stack per look, each under its
   own root container. Separate stacks are necessary as well as clean: the pixel style
   calls `removeChildren()` on its layers and would wipe the flat style's graphics if
   they shared. During a wipe each root is masked by a screen-space rectangle split at
   the banner's centre line — new look above, old below — covering the whole canvas, so
   the pixel sea beyond the board switches with it. Outside a wipe only the current look
   is visible and drawn.
5. **Cost.** The hidden look is not kept up to date; it is marked dirty on any change and
   redrawn in full (terrain, territory, structures) when a wipe begins and on resize, so
   steady-state cost is what it is today. Its own state — cannon aims, flags, the water's
   frame — simply survives being hidden. Check the frame rate mid-wipe at eight players,
   where both terrains are live; the pixel terrain is the large one.
6. **Effects and overlay.** Only visible looks draw effects. There are no shots in the air
   during a banner — the intermission waits for the last to land — so a wipe never cuts
   a shot in half; debris from the last impact may still be falling and is simply
   clipped. The overlay comes from the look of the coming phase from the moment its
   banner starts, so the aiming cursor that appears with "Fire!" is already the combat
   one. The HTML layer (team tags, island banners, big timer) is above the canvas and
   takes no part. The shake moves the stage and so moves both.
7. **The sweep, drawn late.** On `walls_swept` the client keeps the tile list and draws
   structures from a display copy in which those tiles are still wall until the banner
   line passes their row, as `drawTerritory` already draws from the live enclosure rather
   than the state. **The owner must come from the board the client last drew**: the sim
   has already zeroed `owner` for swept tiles, and `islandId` is wrong for an eliminated
   player's rubble. Territory needs no such treatment — a loop enclosing anything cannot
   be swept (§1.3). Each tile crumbles as it goes: a new `Theme.noteCrumble(x, y, owner)`,
   a puff of debris in the pixel style and a short fade in the flat one. A client that
   joins mid-intermission never saw the event and shows the walls already gone, which is
   correct.
8. **Tests.** Pure: the look before and after every kind of intermission; banner
   progress at its start, middle and end; which swept tiles are still drawn for a given
   line. Screenshots: a new scene caught mid-wipe into combat, and one mid-sweep on "Place
   cannons" (real-time Playwright, with `&snapshot=` and a wait into the banner). Then a
   person watches a whole round at normal speed.
9. **Docs.** §7 describes the two looks and the wipe; the style parameters in CLAUDE.md
   change.

#### V2 — The pixel style as the combat look — done

Kept as planned, for the record; how it turned out is §7 and ARCHIVE 10x.

Now that it is the cinematic half of a pair, push it further from the flat style.

- **Use what is generated but never drawn.** The atlas already holds crater decals and
  damaged-wall variants (`wall.<mask>.<damage>`), but `drawStructures` only ever asks for
  damage 0 and the `craters` container stays empty. Scorch marks where shots land on open
  ground; cracked wall beside a breach, tracked by the client from impacts. Both kept by
  the pixel theme, which is hidden while building — whether they fade over rounds or are
  cleared by the "Rebuild" wipe is decided by looking.
- **Pseudo-3D.** Walls with a south-facing front and a drop shadow; castles with a front
  face and corner towers. The original's combat view was in perspective; this is the
  cheap version of it.
- **Sealed ground** as a courtyard or cobble pattern instead of an alpha tint, so "sealed"
  reads at a glance.
- **Water**: animated foam along the shore, deeper colour away from land.
- **Rubble**: an eliminated player's wall gets its own broken texture rather than
  grey-tinted wall.
- **Inert cannons**: a drooping barrel and a wisp of dark smoke rather than a red strike
  through. The flat style keeps the strike-through, where plain information is the point.

#### V3 — Build-phase effects — done

Kept as planned, for the record; how it turned out is §7 and ARCHIVE 10y.

In both styles where they are information, shared through `theme.ts` as the build hints
and fire reticle already are; per style where they are decoration.

- **Sealing a castle**: the territory floods outward from the castle in BFS order and its
  flag goes up. The single most satisfying moment in the game, and today it just appears.
- **A piece lands** with a slight settle and a dust puff, rather than appearing.
- **The ghost joins up**: in the pixel style the held piece previews with the wall shapes
  it would form with its neighbours.
- **Overtime** shows as a pulsing red border round the board.

#### V4 — Combat effects — done

Kept as planned, for the record; how it turned out is §7 and ARCHIVE 10z.

- **The lob**: the ball grows toward the top of its arc while its ground shadow shrinks.
- **Impacts by what they hit**: a splash ring in water, dust on grass, embers and smoke
  lingering a few seconds on a destroyed wall.
- **Incoming**: the target marker pulses faster as impact nears, more strongly on your
  own wall.
- **Breach**: a castle's flag comes down when it is breached mid-combat, rather than
  vanishing.
- **Muzzle smoke** drifting from each gun after it fires.

#### V5 — Lobby and menu — done

Kept as planned, for the record; how it turned out is §6, §7 and ARCHIVE 11a. Decided
with the user: the seed is drawn when the table is set, so the preview is the real map;
it is random each time a lobby opens (`?seed=` still sets one); and the host may seat a
bot in their own place, which replaces the "watch the bots" button.

- **A mini-map** of the table as it stands: the pattern for the chosen player count,
  generated from the seed exactly as a match would be, with team letters. Islands are
  shuffled among seats at the start, so it shows teams, not who gets which island.
  **Open:** offline the menu's seed is known; online the room draws its seed only at the
  start, so either the room draws it when the table is created (a server change, but not
  a game-logic one) or the preview shows a representative map.
- **Seat cards** in team columns, each with its colour swatch and a small rank insignia
  per tier, instead of plain rows.
- **An animated background**: the pixel sea behind the panel, or a blurred bot match being
  watched.
- A **pixel-art title**, and a little feedback when a person takes a seat or the room code
  is copied.

#### V6 — Resolution and match moments — done

Kept as planned, for the record; how it turned out is §7 and ARCHIVE 11b.

- **Points count up** across the territory as they are banked, during the intermission.
- **A lost life** crumbles the island's walls outward rather than clearing them at once.
- **Game over**: fireworks over the winning island(s).

---

## 12. Deferred (explicitly out of scope for v1)

Quick-match and matchmaking, accounts and persistence, ranking, mobile
and touch input, spectator mode, shipped replays, naval units, singleplayer campaign.
