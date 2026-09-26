# Rampart Remake — decision archive

Why things are the way they are, in the order it was worked out. Each section records a
change that was made, what it was measured against, and what it cost — including the
attempts that were reverted, which are the ones worth reading twice.

This is history, not specification. **`docs/PLAN.md` is the current design**; where the
two disagree, PLAN.md is right and this file records how we got there. Numbers quoted
here were true of the build that measured them and many are now historical — the map
changed shape in 10l, and every bot figure from before that was measured on a layout that
no longer exists.

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

|                   | before      | after                  |
| ----------------- | ----------- | ---------------------- |
| marshal vs gunner | 7-6         | **8-3**                |
| gunner vs recruit | 19-1        | **11-1**               |
| stalemates        | ~1 in 20    | **none in 30 matches** |
| match length      | 8-20 rounds | 6-9 rounds             |

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
- **Late-phase idling.** A bot lays 8 pieces in a late build phase where a person manages 15. Once its wall is sealed, thickened and it cannot afford another castle, it stops.

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

| From round | Sizes      |
| ---------- | ---------- |
| 1          | 1, 2, 3    |
| 2          | 1, 2, 3, 4 |
| 3          | 2, 3, 4    |
| 4          | 2, 3, 4, 5 |
| 5 onward   | 3, 4, 5    |

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

|         | escalating                     | flat bag                |
| ------- | ------------------------------ | ----------------------- |
| recruit | 13 rounds median, 2 unfinished | 14 rounds, 1 unfinished |
| gunner  | 15 rounds median, 1 unfinished | 21 rounds, 3 unfinished |
| marshal | 12 rounds median, 0 unfinished | —                       |

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
_every_ seat to a bot gives a **watched match**: no input is attached and the HUD drops the
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
definition the _tightest_ wall that works, so each round the planner drew the wall in
closer to the castle — and the new sweep then removed the old outer wall, leaving the
guns outside and silent. The bot was strangling its own artillery, one round at a time.

The fix is to make the player's cannons **sinks in the cut** alongside the castle, so a
valid wall has to enclose them. It costs more wall, which is simply what they are worth.
With it, a bot holds 12 to 18 active guns where it held none.

### Still unresolved

Bot-vs-bot matches now run long and often do not finish inside a tick budget that used
to cover several matches. Nobody is eliminated, because a near-optimal defender with four
castles on a large sector can almost always seal _something_. Damage is not the
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
seed produced _the same map_. A determinism test caught it. 440 restores ten distinct maps
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
2. **Gunner and marshal** tend to enclose _a different_ castle with minimal placement,
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

|                             | recruit | gunner  | marshal |
| --------------------------- | ------- | ------- | ------- |
| castles sealed              | 1.0     | 1.42    | 1.39    |
| cannons owned               | 7.1     | 7.2     | 7.1     |
| cannons **active**          | 4.3     | 3.9     | 3.3     |
| **room for another cannon** | **0.8** | **0.3** | **0.3** |
| wall tiles                  | 45      | 41      | 37      |

Room 0.3 is the whole story. A gunner or marshal at a typical resolution had space for
**zero** more cannons, behind a ring of 37 tiles, with half the guns it owned standing
outside and silent. It was not that the bots sometimes walled themselves in too tightly.
It was that they always did, and had no way to do anything else.

### The cause is the thing that made the planner good

Sealing is a minimum cut, and a minimum cut is by definition the _tightest_ wall that
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

|                         | gunner before | gunner after | marshal before | marshal after |
| ----------------------- | ------------- | ------------ | -------------- | ------------- |
| room for another cannon | 0.3           | **1.1**      | 0.3            | **5.5**       |
| cannons idle            | 46%           | **19%**      | 54%            | **10%**       |
| cannons active          | 3.9           | **5.8**      | 3.3            | **6.3**       |
| build phase used        | 65%           | 69%          | 65%            | **108%**      |
| matches unfinished      | 2 of 3        | **1 of 8**   | 3 of 3         | **0 of 8**    |
| rounds                  | 26.7          | 12.1         | 33+            | 4.5           |

Marshal, which could not finish a single match on any seed tried, now finishes all of
them with essentially every gun it owns firing.

Two players, six seeds, marshal against marshal — a case none of the above touched, and
the one the unit tests run:

|                         | before     | after      |
| ----------------------- | ---------- | ---------- |
| matches unfinished      | **4 of 6** | **0 of 6** |
| rounds                  | 27.3       | 4.2        |
| cannons idle            | —          | 4%         |
| room for another cannon | —          | 4.9        |

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
`audio` because a public directory's _contents_ are served at the site root.

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

| base / per tile | 20-tile flight | shots per cannon | notes           |
| --------------- | -------------- | ---------------- | --------------- |
| 350 / 35        | 1.05s          | 4.5              | as shipped      |
| 500 / 60        | 1.70s          | 4.5 / 4.1        |                 |
| 600 / 80        | 2.20s          | 4.2 / 3.1        | gunner idle 57% |
| 700 / 90        | 2.50s          | 3.6 / 3.6        |                 |
| **850 / 110**   | **3.05s**      | **3.1 / 3.0**    | adopted         |

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

|                                | before | after    |
| ------------------------------ | ------ | -------- |
| gunner room for another cannon | 1.7    | **7.6**  |
| gunner build phase used        | 58%    | **121%** |
| gunner cannons idle            | 30%    | **16%**  |
| marshal build phase used       | 88%    | **101%** |
| marshal cannons idle           | 38%    | **31%**  |

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

|                     | before | after  |
| ------------------- | ------ | ------ |
| marshal wall tiles  | 67     | **88** |
| gunner wall tiles   | 53     | **75** |
| marshal rounds      | 4.6    | 5.4    |
| gunner cannons idle | 16%    | 30%    |

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
flight time went from 1.05s to 3.05s at twenty tiles (10k), the apex went from 8 tiles to 23. A five-tile lob peaked 10 tiles in the air.

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
that flight time scales with distance, and makes close shots _slower_ than they were.
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
so the lobby and the board agree; seats read _"2 of 8 taken — the rest are played by
bots"_; and each bot tier says what it does, since "gunner" tells a new player nothing.

That last one needed a second pass. Explaining the tier on every row gave eight identical
lines of explanation on a default table, which reads as noise and buries the line doing
the work. It is now explained once per distinct tier.

Names are escaped. They come from other players and the server caps their length, not
their content.

Three copies of "player colour as CSS" became one, in `colours.ts`.

## 10r. The round cap and points scoring

Before this a match ended only when one player was left, and between competent bots
that could take thirty rounds or never happen. A match now ends at the resolution of
round `scoring.maxRounds` (10), or earlier when one player is left; at the cap the best
score among the survivors wins. The rules are in PLAN.md §1.7; this records how they
were settled and what was measured.

### Measured before anything was built

At the bot play of the day, four of eight three-player matches and seven of eight
two-player matches would have reached round 10. **So the cap is not a tie-breaker, it is
the main win condition**, and the scoring formula is the game's balance with elimination
the exception. The default weights split about 65/35 territory to damage at three
players and 76/24 at two.

### Questions that reading the code turned up

- **Territory is total tiles times total castles**, not summed per region. Two separate
  one-castle loops of 30 tiles score 120, exactly as one loop holding both would.
- **An enclosed tile is whatever the solver marks as the player's territory** — castle
  and cannon footprints included, so placing a gun never costs points.
- **Self-fire.** `fire()` had no island check at all, so a player could shoot a spare
  stretch of their own wall for two points a tile and rebuild it in a build phase they
  were spending anyway. The plan had recommended scoring it zero and leaving it legal;
  the decision was to forbid it. `fire()` refuses your own island, and an impact clears a
  wall only if a live opponent owns it — checked at impact too, so a wide crater cannot
  reach your own. An eliminated player's rubble is therefore indestructible, and a player
  can no longer clear their own stranded wall from ground a cannon needs. Both accepted.
- **A shared win is not a draw**, so `winner` became `winners`, beside `draw` and a new
  `endedBy`. The snapshot changed shape and `PROTOCOL_VERSION` went to 2, then 3 with the
  lobby settings. The welcome message had been sending a hardcoded 1 regardless.
- **Failing to seal in the final round still costs a life.** Nothing follows it, but the
  normal path needs no special case.
- **`maxRounds` is nullable, for tests only.** The game is balanced around the cap and a
  host cannot lift it. `withoutRoundCap` sits beside `withoutContinues`.

### Lobby settings, as a mechanism

Only `maxRounds` is settable, but game speed, team mode and special weapons are meant to
follow, so it is an explicit list of typed settings in `config/src/settings.ts` with
bounds in `server.lobbySettings` (5 to 20 rounds), not overrides by path into the
ruleset. The room accepts a change only from the host, before the start, and only inside
the bounds — refused whole rather than clamped — then applies it over the server's
ruleset and re-validates through `RulesetSchema`. The result travels in the snapshot, so
determinism is untouched. The offline menu has the same control, and a host's menu choice
carries into the room they open. The validator refuses bounds that exclude the ruleset's
own cap.

### Things found along the way

- **The HUD roster put player names into `innerHTML` unescaped**, and online they come
  from other clients.
- **`stateFromAscii` gave walls no owner**, so every wall in a test picture was rubble on
  island 1. It now owns walls by island and takes an optional island overlay picture.
- **The gunner-over-recruit position test changed result, not meaning**: it reads
  position at 20,000 ticks, which the cap now ends matches close to, and the lead fell
  from 5 of 8 to 4. It runs uncapped.

First measurement under the rules, four three-player gunner matches: two decided on
points at round 10, two by elimination. Territory 64 per surviving player-round against
24 for damage, 73/27 — damage fell once self-inflicted hits and rubble stopped counting.

## 10s. Teaching the bots to play for points

Bots were tuned for survival, and a soak cannot judge scoring weights while they play
for survival. This is where they learned otherwise — mostly by finding out they were
losing rounds they could have won.

### Three levers that did nothing

Marshal alone changed, in one seat against two gunners, both seats. Baseline 7 of 11.

| Change, marshal only                    | wins    | castles | forfeited rounds |
| --------------------------------------- | ------- | ------- | ---------------- |
| none                                    | 7 of 11 | 1.46    | 26%              |
| `maxCastles` 2 -> 3                     | 6 of 11 | 1.50    | 26%              |
| target the rival with the highest score | 5 of 11 | 1.47    | 27%              |
| `ROOM_RADIUS` 3 -> 4                    | 1 of 12 | 1.09    | 43%              |

The ambition cap was not binding — bots barely held two castles — so the handicap
expected under points was not there. A wider band was badly worse, as it was for
survival. What the numbers did show: **both tiers forfeited about a quarter of their
rounds**, and each forfeit costs the whole round and a life.

### Why a quarter of rounds failed

Headless `--stats` gained `repairAtBuild`, `repairLeft` and `repairStuck` — the cells the
tightest seal needed as the build phase opened, the cells still missing on its last
tick, and how many of those no piece in the bag could cover. Hashes are identical with
and without `--stats`, so measuring does not disturb play.

**Every failed round was affordable**: a tightest repair of 3–12 cells against a budget
of 42–47, ended 1–3 cells short with the whole phase spent. About 30% ended on a hole no
piece in the bag fitted; the rest on cells that could have been filled. Two causes in
`decide()`: a breached bot asked for the _widest_ affordable wall first, against an
estimate of 3.5 cells a piece that is optimistic once the bag widens; and it read
`enclosedCastles`, which landing shots do not refresh, so as a breached phase opened it
believed it was sealed. Most of its second castles came from that stale path.

**The fix: count sealed castles afresh, and when breached close the tightest wall that
keeps the guns before anything else.** Marshal alone with it: forfeits 26% -> 9%, wins 7
of 11 -> 10 of 12, and from seat 0, 2 of 6 -> 5 of 6 — most of the seat bias seen that
week was this bug. With every tier on it the ladder held. Preferring the roomiest repair
within three cells of the tightest was tried and dropped for no measurable gain.

**What it did to the game**: with every bot careful, three gunners forfeited half as
often (22% -> 11%) but held half the territory (80 -> 41 per sealed round), and eight
matches produced no eliminations at all. Careful play under the default weights is a
tight wall around one castle — the turtle the scoring was meant to punish. A finding
about the weights, visible now that the bots play for points.

### Three faults seen watching a match

- **"The sea counted as wall."** It did not. An independent check — a search outward
  from each castle rather than the solver's flood inward — agrees with the sim at every
  resolution of three full matches, and is now a test. The display was wrong: territory
  is refreshed at placements and resolutions, not when shots land, so a castle breached
  in combat stayed shaded as sealed. The client now draws territory and counts castles
  from a fresh `computeEnclosure`. Display only.
- **Cannons against a coastal wall.** Clearance treated a wall with the sea behind it
  like an inland one, and in a tight ring every spot touches a wall, so range decided —
  toward the enemy, where the coast usually is. A spot is now _pinned_ if a wall block
  beside it has nothing buildable beyond, and pinned spots are taken only when nothing
  else exists.
- **Idle beside an unwalled castle.** Thickening targets no piece could reach were marked
  unreachable, but `thickenTargets` never consulted that set, so the bot got them back,
  failed, and paused for the rest of the phase without reaching `spareWork`. Build
  choices are now tried in turn, skipping dead ends, and spare time reaches for every
  castle on the island. Pieces laid against time available went 95% -> 105%, territory
  41 -> 52.

The cramped-walls test held one seed to 0.5 while the soak average sits at 50–56%, so it
flipped with any change. It now measures three seeds against 0.6.

### Is thickening worth it — the baron

Two profile switches, `thickens` and `expandsWhenSealed`. Each variant with marshal's
speed and aim, against two gunners, twenty matches (equal play wins about 7):

| Variant                                   | wins of 20 |
| ----------------------------------------- | ---------- |
| marshal as it is                          | 13         |
| marshal, thickening off                   | 12         |
| no thickening, eager expansion            | 9          |
| eager expansion, thickening kept, `max` 4 | 14         |

Dropping thickening changes nothing; dropping it while expanding eagerly is worse — the
wall an expansion relies on while it is being built is the wall being shot. The 14 did
not survive a forty-match rerun (seeds 101–120): 28 against marshal's 29. It was kept
anyway as the **baron** tier, for variety rather than strength — marshal's skill,
`maxCastles` 4, eager expansion, thickening kept.

## 10t. Polish: looking at the client, combat, feedback, lives

The client had grown a scoring HUD tested only as functions. `tools/screenshots.sh`
changed that: Playwright's screenshot command renders in real time, where headless
Chrome's virtual time barely drives the render loop, so `&snapshot=PHASE&round=N` and a
wait reach any state worth seeing. Its first pass found six things nobody had seen: the
board under the HUD bar, the pixel sea ending in a hard rectangle, inert cannons nearly
invisible in pixel style, a 0.0s timer at game over, the round label jumping every
intermission, and a final table that was one upper-cased line.

**Combat.** The art config had declared banner waves, sixteen barrel rotations, recoil,
muzzle flash and shot trails, and nothing used them. They are built now, barrels
rasterised at each angle since rotating one sprite smears pixels. The barrel first drew at
9 px, too short to read, and in the base's own shade; banners at 5 px vanished. The shake
fires only for your own wall: shots land somewhere all the time.

**Leak hints**, found wrong on screen twice. Red vanished on the red player's island, so
they are in the UI's ink. And the first rule — every missing cell touches standing wall —
refused a real breach, because the corner of a missing run touches only its neighbours
in the run; it is now per run. The limit went 8 -> 12 when the first screenshot showed a
typical first-round breach of nine. The suggested repair keeps the guns inside: the
tightest wall regardless is often a ring that abandons them.

**Lives.** Pips in the roster, a life-lost banner that lands, red on the last, and a
knockout stamped over a greyed island. The old knockout message sat in the middle of the
screen for the rest of the match, over the game the player was left to watch; it is a line
at the bottom now. `&idle=1` leaves your seat undriven in a fast-forward, which is the
quickest way to put a mid-match knockout on screen.

**After the first human play.** Leak marks came out: hard to tell from the piece ghost and
from wall already laid, and read as the one right repair when any closing shape will do.
The castle outline stayed, as it has neither problem. The fire cursor only changed colour
slightly when a gun was ready; it now changes shape, and carries the count. And the time
left, which a player watching their wall never looks up to see, is repeated in large
figures in the sea near the middle — the one place every island faces.

**Second round of human feedback.** The points banner was far too quick at 2.4 s; it now
holds for the intermission, with the total. The aiming cursor appears during the "Fire!"
announcement, so a target can be chosen before the phase opens. The cannon badge counts
guns still to place. And overtime, a rule: a 3 s window after the build clock in which
each player may place the piece they hold. Its early end, once everyone has used it, is
noticed by the next step rather than run from inside the action — run from the action, a
resolution that ended the match did so before its tick was stepped, and the determinism
test's log replay came out different.

## 10u. Team mode

Chosen by the user ahead of the balance work, and built in six steps. The rules are in
PLAN.md §11.7; how they came out:

- **Every match became a team match**, free-for-all as teams of one, rather than a second
  copy of every rule. Checked, not assumed: free-for-all bot matches played out identically
  to the tick before and after, at each step that touched the sim or the bots.
- **PLAN.md had claimed the data model was team-aware already.** It was not; score, lives
  and elimination all belonged to a player.
- **A placed block belongs to the island, not the placer**, which made a teammate's help
  fall under the sweep, damage and rubble rules with no change to any of them.
- **The old bots made 598 refused shots at teammates** in two 2v2 matches before T3.
- **Islands are shuffled among seats, not inside the sim**, which keeps player p on island
  p + 1 everywhere; the server tells each connection who it has become. The shuffle applies
  to free-for-all too. Two room tests had assumed the first seat stays player 0, one passing
  only by luck of the shuffle.
- **One lobby for online and offline.** "A server is there" had to mean a welcome within
  two seconds, not an open socket: under the dev server the socket's address is the dev
  server's own, which can accept and say nothing.
- **Presentation found two layout faults on screen**: the team tag at an island's top middle
  sat under the big timer, and a 4v4 roster wrapped the bar onto two lines.
- **Measured (T6)**: random seating decides nothing measurable, and eliminations are rarer
  than in free-for-all — 5 in 180 team matches.

## 10v. Bugs found by the user's own play

- **No castle to choose after a continue.** The sim accepted `select_castle` in the cannon
  phase from a player owing one — bots and the timeout fallback used it, and it was tested
  — but the client's controls decided what a click meant from the phase alone, so a person
  was offered a cannon with nowhere to put it. What a click means is now `inputMode`, a
  pure function of the state and the player, tested by playing a match to a continue.
- **Announcements wiped everything else drawn over the board.** Each replaced every child
  of the banner layer, which also held the island banners, the team tags, the big timer
  and the cursor count; those went on updating nodes no longer on the page. Screenshots
  jump to a phase and skip announcements, which is why none caught it.
- **The cursor looked ready over a teammate's island**, where the shot is refused.
  `mayTarget` now answers for the cursor and the click alike.

The pattern across all three: the rules were right and tested, and the client asked a
different, simpler question than the sim did. Where the client has to predict a rule, it
should ask the same function or one tested against it.

## 10w. The original's banner: two looks, and the sweep drawn under it (V1)

The first package of the visual pass (PLAN §11.8). In the original, the banners either side
of combat change the board's look as they cross it — plain for building, cinematic for
combat — and the banner after the build phase carries the sweep of loose wall. All three
parts already existed here but were unconnected: one style for the whole match, a CSS
banner that knew nothing of the board, and a sweep drawn at the resolution before any
banner showed.

- **Client only.** The sim still sweeps at the resolution; the client draws the swept
  blocks until the banner's line passes their row. Safe because nothing is playable during
  an intermission and the next phase opens only once the banner has left. Checked with the
  user against the original: "Fire!" and "Rebuild" swap the look, "Place cannons" carries
  the sweep. The rare round with no cannon phase needs no rule — the next banner, "Fire!",
  takes the sweep as well.
- **Two settings, not a mode**: `art.styles.build` and `.combat`, flat and pixel by default,
  chosen per player in the menu. The same style for both simply switches nothing.
- **The banner follows the sim clock** (`bannerProgress`), not a stylesheet, so the wipe is
  always exactly beneath it. It now travels from wholly above the screen to wholly below,
  rather than from -12% to the bottom edge, so the wipe covers the whole board.
- **Each look has its own layer stack.** The pixel style empties its layers with
  `removeChildren()`, which took the other style's graphics with it when they shared. The
  hidden look is only marked stale and redrawn as a wipe reveals it, so between banners two
  looks cost what one did. A look that never ages its effects must not be handed impacts
  while hidden, or they all go off at once when it is next shown.
- **Owners of swept blocks come from the board last drawn**: the sweep has already zeroed
  them in the state, and `islandId` would be wrong for an eliminated player's rubble.
- Seen in real-time screenshots, frames diffed before and after the banner: blocks above
  the line gone mid-crossing, those below still standing, and the pixel look coming into
  view with the cannons placed while it was hidden.

## 10x. The pixel style as the combat look (V2)

With V1 the pixel style became specifically the combat look, the cinematic half of a pair,
so it was pushed further from the flat one. All client-side; the tunables are new fields
under `art.generators`.

- **Height, from light falling from the north**: a wall block with nothing to its south
  shows a front face — a light lip, then dark dressed stone — and walls, castles and guns
  cast a shadow onto the ground south of them. The castle gained a shaded front below its
  roofline. At first the face was too subtle under the owner's tint and was darkened a step.
- **Sealed ground paved**, flagstones tinted with the owner's colour, instead of an alpha
  wash that was hard to read under textured grass.
- **Water**: darker with distance from land, and surf along the coast whose opacity breathes
  a little out of step tile to tile. The first depth measure was a breadth-first flood,
  i.e. Manhattan distance, and the sea stepped in visible diamonds; it is Euclidean now,
  measured outright within the shading range, and only when terrain is drawn.
- **What was generated but never drawn is used**: the crater decals mark shots on land,
  fading over `fx.craterRounds`, and the damaged-wall variants crack the blocks either side
  of a breach for the rest of the round. Both sit below the walls, so rebuilding covers them.
- **Rubble** for an eliminated player's wall: loose stones with the grass showing through,
  no face, no shadow — in the way, but plainly nobody's.
- **Inert guns** slump (a short, unlit barrel) and smoulder instead of the red strike the
  flat style keeps. No reachable snapshot has an inert gun — that needs a gun left
  outside sealed ground at a resolution — so it was first seen by the user in play.

## 10y. Build-phase effects (V3)

The third package of the visual pass. Sealing a castle is the most satisfying thing a
player does, and it used to pass unmarked: the territory simply appeared.

- **The flood** (`seal.ts`). The client compares the enclosure before and after every
  change and floods whatever territory was gained, breadth-first from the castle's own
  footprint or from the edge of the territory already held, so a widened loop floods only
  its new ground. Drawing hides what the front has not reached and never adds anything
  back, so a flood outlived by a breach cannot restore lost ground. A lit front trails
  `sealGlowTiles` behind it. It is drawn in both styles, since it shows exactly what the
  last piece sealed. **40 tiles a second was too fast**: a typical region filled in about
  150 ms and read as a flash. 16 lets the ground be seen being taken.
- **Flags hoisted** in both styles: the flat style gained a plain pennant, since the
  flat look is where building happens by default and the moment would otherwise have no
  flag at all. Its first pennant was too small at a three-player tile size and was
  enlarged.
- **Pieces settle** from slightly large and bright, and in pixel style throw dust from
  their outer edges only.
- **The pixel ghost is the wall it would make**, joined to itself and to the standing wall.
  At first each of its cells was outlined, which cut the joined wall into squares again;
  only the outside is outlined now.
- **Overtime rings the board** in a pulsing red border, drawn just inside the board: drawn
  on its edge, half of it fell under the HUD bar and off the bottom of the window.
- Seen in screenshots driven through Playwright's library (for the mouse, to see the ghost)
  and in bursts of frames from a watched match, picked out by measuring what changed.

## 10z. Combat effects (V4)

The fourth package of the visual pass, mostly in the pixel style, which is the combat look.

- **The lob**: the ball grows by up to half again toward the top of its arc while its
  shadow shrinks and fades, so height reads twice over.
- **Impacts by what they hit**: in the sea a white plume and two rings (no blast, no
  scorch); on open ground a blast, a scorch mark and dust; on a wall a blast, the debris
  already thrown, and a breach that smoulders for `fx.smoulderMs`. **The first splash was
  too faint** against the patterned sea and gained the plume and a thicker bright ring;
  **the first smoke was grey and vanished against the grass**, and is dark now, as burning
  stone gives off, with embers that show more often.
- **Muzzle smoke**: puffs blown out along the barrel, slowing under drag and drifting up.
  The shot's origin is the tile at the gun's centre, so the muzzle is placed from there.
- **The landing mark pulses ever faster** as the shot nears, and turns red and thick over
  the watching player's own wall. Both styles, being the warning a player repairs by; the
  effect frame now carries who is watching.
- **Flags are lowered** on a breach, in a darker shade, and go back up from wherever they
  had got to if the castle is sealed again. `FlagHoist` holds the logic and is unit-tested.
- Looking at water needed the player's own shots, since even recruits land their misses on
  land. Playwright's `mouse.click` did not fire in this game where a move followed by a
  press did — worth knowing before concluding a click handler is broken. The flag coming
  down was not caught on screen; the user checked it in play.

## 11a. The lobby shows the real map (V5)

The fifth package of the visual pass, with three decisions from the user: draw the seed
when the table is set so the preview is the real map; make it random every time a lobby
opens, with `?seed=` kept for testing; and let the host seat a bot in their own place,
which replaces the "watch the bots play" button.

- **The seed moved from the start to the table.** A room draws it at creation (from its
  random generator, which also issues tokens, so match seeds changed for every room seed;
  no test depended on the old values) and sends it in every `room` message; a local table
  takes it from `crypto.getRandomValues`. The host may draw another or type one in.
  Protocol 7.
- **The preview deals exactly what the match will** (`preview.ts`): the terrain from the
  seed, the island of each seat from `seatOrder`, the colour from `matchPalette`. A test
  builds the real local match and compares all three. **The first colours were wrong**:
  `createMatch` renumbers team labels densely in order of first appearance among the
  players, after the shuffle, and the colour family follows the renumbered id. The same
  renumbering means the lobby's team letter can differ from the match's — recorded in
  PLAN 11.5, since it predates V5.
- **A host watching**: the server marks the host's seat a bot's at the start, ignores the
  host's actions, and — found while writing it — must not hand the seat back when the host
  reconnects, which the generic "reclaim a seat a bot was holding" path would have done.
- **Server bots are numbered from one**, as the lobby numbers seats: the match said "Bot 2"
  for the lobby's "Bot 3".
- **Dressing**: a stone-block title and the game's sea drifting behind the menu and lobby
  (`decor.ts`), seat cards with the seat's number in its colour, rank badges per tier
  (chevrons, a star for the baron), team columns, a flash for a newcomer.
- Checked over a real socket on a second port, host and guest in two pages: the guest saw
  the host watching, the host's match ran as a spectator, and the guest's island was the
  one the preview had shown. A server already on 8080 belonged to the user and was left
  alone — it runs the old protocol until restarted.
