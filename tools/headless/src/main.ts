import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateConfigBundle, type ConfigBundle } from '@rampart/config';
import { loadConfigBundle } from '@rampart/config/node';
import { Bot, DIFFICULTIES, cannonRoom, cheapestPlanFor, type Difficulty } from '@rampart/ai';
import {
  Rng,
  Structure,
  Terrain,
  applyAction,
  createMatch,
  drainEvents,
  generateTerrain,
  hashMatchState,
  pieceCells,
  poolForRound,
  renderAscii,
  seatOrder,
  step,
  type MatchState,
} from '@rampart/sim';

/**
 * Headless harness: runs matches with no renderer.
 *
 * Its job is to catch what a UI cannot show you — a phase machine that stalls, a
 * seed that generates no valid map, a replay that does not reproduce. Beyond the
 * outcome it can also record, per round, the handful of quantities every open
 * question about the bots turns out to be about: see `--stats`.
 */

interface Args {
  matches: number;
  players: number;
  seed: number;
  maxTicks: number;
  map: boolean;
  difficulties: Difficulty[];
  stats: string | null;
  /** Players per team; 1 is free-for-all. Seats go into teams in order, then shuffle. */
  teams: number;
  /** Overrides `scoring.maxRounds`; undefined keeps the ruleset's, null lifts the cap. */
  maxRounds: number | null | undefined;
}

/**
 * Seat tiers.
 *
 * One name sets the whole table; a comma-separated list sets each seat in turn and
 * repeats if it is shorter than the table. A table of identical bots answers "do
 * matches end?" but cannot answer "is marshal better than gunner?", which is the
 * question the difficulty ladder in docs/PLAN.md section 8 is made of.
 */
function parseDifficulties(value: string | undefined): Difficulty[] | null {
  if (value === undefined) return null;
  const names = value.split(',').map((n) => n.trim());
  if (names.length === 0) return null;
  for (const name of names) {
    if (!DIFFICULTIES.includes(name as Difficulty)) return null;
  }
  return names as Difficulty[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    matches: 20,
    players: 3,
    seed: 1,
    maxTicks: 150_000,
    map: false,
    difficulties: ['gunner'],
    stats: null,
    maxRounds: undefined,
    teams: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--matches':
        args.matches = Number(value);
        i++;
        break;
      case '--teams':
        args.teams = Number(value);
        i++;
        break;
      case '--players':
        args.players = Number(value);
        i++;
        break;
      case '--seed':
        args.seed = Number(value);
        i++;
        break;
      case '--max-rounds':
        args.maxRounds = value === 'none' ? null : Number(value);
        i++;
        break;
      case '--max-ticks':
        args.maxTicks = Number(value);
        i++;
        break;
      case '--difficulty': {
        const tiers = parseDifficulties(value);
        if (tiers === null) {
          console.error(`--difficulty wants ${DIFFICULTIES.join('|')}, or a comma-separated list`);
          process.exit(1);
        }
        args.difficulties = tiers;
        i++;
        break;
      }
      case '--stats':
        args.stats = value ?? 'stats.csv';
        i++;
        break;
      case '--map':
        args.map = true;
        break;
      case '--help':
        console.log(
          'usage: npm start -w @rampart/headless -- [--matches N] [--players N] [--seed N] ' +
            `[--max-ticks N] [--max-rounds N|none] [--teams N] [--difficulty ${DIFFICULTIES.join('|')}[,...]] [--stats FILE] [--map]`,
        );
        process.exit(0);
    }
  }
  return args;
}

function describeOutcome(state: MatchState): string {
  if (state.phase !== 'game_over') return `unfinished (${state.phase}, round ${state.round})`;
  if (state.draw) return 'draw';
  if (state.winners.length === 0) return 'no winner';
  const who = state.winners.map((id) => `player ${id}`).join(' + ');
  return state.endedBy === 'round_cap' ? `${who} on points` : `${who} last standing`;
}

// ------------------------------------------------------------------------- stats

/**
 * One row per player per round, sampled at the resolution that ends a build phase.
 *
 * That moment and no other: `enclosedCastles` is live during a build phase, so it is
 * legitimately zero mid-repair, and the sweep runs inside the same step — so the
 * cannon and wall counts here are what the next barrage will actually meet.
 */
interface StatRow {
  seed: number;
  round: number;
  player: number;
  difficulty: Difficulty;
  enclosedCastles: number;
  cannonsAwarded: number;
  eliminated: boolean;
  cannonsOwned: number;
  cannonsActive: number;
  cannonRoom: number;
  wallTiles: number;
  piecesPlaced: number;
  piecesBudget: number;
  shotsFired: number;
  territoryPoints: number;
  damagePoints: number;
  /** Banked total after this round. */
  score: number;
  /**
   * Cells the tightest possible seal needed as the build phase opened, and how many it
   * still needed on the phase's last tick. Together they say why a round failed:
   * a repair larger than the phase could ever build, or one that fit and was missed.
   */
  repairAtBuild: number;
  repairLeft: number;
  /**
   * Of the cells still missing on the last tick, how many no piece in this player's bag
   * could cover at all — holes the round's pieces are too big for.
   */
  repairStuck: number;
}

const STAT_COLUMNS: (keyof StatRow)[] = [
  'seed',
  'round',
  'player',
  'difficulty',
  'enclosedCastles',
  'cannonsAwarded',
  'eliminated',
  'cannonsOwned',
  'cannonsActive',
  'cannonRoom',
  'wallTiles',
  'piecesPlaced',
  'piecesBudget',
  'shotsFired',
  'territoryPoints',
  'damagePoints',
  'score',
  'repairAtBuild',
  'repairLeft',
  'repairStuck',
];

/**
 * Pieces this tier could lay in a whole build phase.
 *
 * The same arithmetic the bot itself prices a plan with — base plus per-cell over an
 * average piece of 3.5 cells — so `piecesPlaced / piecesBudget` reads directly as how
 * much of the phase a bot actually used. A bot that seals early and then stands idle
 * shows up here as a ratio well under one, with nothing else needing to be measured.
 */
function piecesBudget(bundle: ConfigBundle, difficulty: Difficulty): number {
  const profile = bundle.ai.profiles[difficulty];
  if (profile === undefined) return 0;
  const perPiece = profile.placementBaseMs + profile.placementPerCellMs * 3.5;
  return bundle.ruleset.phases.buildMs / perPiece;
}

function wallTilesOf(state: MatchState, playerId: number): number {
  const islandId = state.players[playerId]?.islandId;
  let tiles = 0;
  for (let i = 0; i < state.structure.length; i++) {
    if (state.structure[i] === Structure.Wall && state.islandId[i] === islandId) tiles++;
  }
  return tiles;
}

/** Whether any piece in the player's current bag can legally cover tile `i`. */
function coverable(state: MatchState, playerId: number, i: number): boolean {
  const player = state.players[playerId];
  if (player === undefined) return false;
  const tx = i % state.width;
  const ty = (i - tx) / state.width;
  const fits = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= state.width || y >= state.height) return false;
    const j = y * state.width + x;
    return (
      state.terrain[j] === Terrain.Land &&
      state.structure[j] === Structure.Empty &&
      state.islandId[j] === player.islandId
    );
  };
  for (const id of poolForRound(state.ruleset, player.pieceRound).ids) {
    for (let rotation = 0; rotation < 4; rotation++) {
      const cells = pieceCells(id, rotation);
      // Every way of laying this piece so that one of its cells lands on the tile.
      for (const [ax, ay] of cells) {
        if (cells.every(([cx, cy]) => fits(tx - ax + cx, ty - ay + cy))) return true;
      }
    }
  }
  return false;
}

function writeStats(path: string, rows: StatRow[]): void {
  const lines = [STAT_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(
      STAT_COLUMNS.map((column) => {
        const value = row[column];
        return typeof value === 'number' ? Number(value.toFixed(2)) : String(value);
      }).join(','),
    );
  }
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * The summary worth reading without opening the file.
 *
 * Active cannons and cannon room are the two numbers the stalemate is made of: a bot
 * whose wall has nowhere to put a gun cannot spend what it earns, and a table of
 * those cannot finish a match however long it runs.
 */
function summariseStats(rows: StatRow[]): void {
  const byTier = new Map<Difficulty, StatRow[]>();
  for (const row of rows) {
    if (row.eliminated) continue;
    const list = byTier.get(row.difficulty);
    if (list === undefined) byTier.set(row.difficulty, [row]);
    else list.push(row);
  }
  if (byTier.size === 0) return;

  console.log('\nper surviving player-round, averaged:');
  console.log('  tier     sealed  owned  active  idle%   room  wall  pieces/budget   terr   dmg');
  for (const tier of DIFFICULTIES) {
    const list = byTier.get(tier);
    if (list === undefined) continue;
    const owned = mean(list.map((r) => r.cannonsOwned));
    const active = mean(list.map((r) => r.cannonsActive));
    const idle = owned === 0 ? 0 : (1 - active / owned) * 100;
    const used = mean(
      list.map((r) => (r.piecesBudget === 0 ? 0 : r.piecesPlaced / r.piecesBudget)),
    );
    console.log(
      `  ${tier.padEnd(8)} ${mean(list.map((r) => r.enclosedCastles))
        .toFixed(2)
        .padStart(5)}  ${owned.toFixed(1).padStart(5)}  ${active.toFixed(1).padStart(6)}  ` +
        `${idle.toFixed(0).padStart(4)}%  ${mean(list.map((r) => r.cannonRoom))
          .toFixed(1)
          .padStart(4)}  ${mean(list.map((r) => r.wallTiles))
          .toFixed(0)
          .padStart(4)}  ${(used * 100).toFixed(0).padStart(11)}%  ${mean(
          list.map((r) => r.territoryPoints),
        )
          .toFixed(0)
          .padStart(5)}  ${mean(list.map((r) => r.damagePoints))
          .toFixed(0)
          .padStart(4)}`,
    );
  }
}

// ------------------------------------------------------------------------- teams

/**
 * Each player's team, by player id, seated the way a room seats them: seats go into
 * teams in order, then which island each seat gets is shuffled from the seed.
 */
function teamSeating(seed: number, players: number, size: number): number[] {
  const order = seatOrder(seed, players);
  const byPlayer = new Array<number>(players).fill(0);
  order.forEach((player, seat) => {
    byPlayer[player] = size > 1 ? Math.floor(seat / size) : seat;
  });
  return byPlayer;
}

/** How a match's teams sat, and how it ended. */
interface TeamLayout {
  /** Mean distance between a team's islands, by team, in tiles. */
  spread: number[];
  winners: number[];
  byElimination: boolean;
  rounds: number;
}

/**
 * How far apart each team's islands are. Random seating can put teammates side by side
 * one match and across the map the next; on a map with every position symmetric that
 * should not decide anything, and this is how to see whether it does.
 */
function teamLayout(state: MatchState): TeamLayout {
  const centre = state.players.map((p) => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let i = 0; i < state.islandId.length; i++) {
      if (state.islandId[i] !== p.islandId) continue;
      sx += i % state.width;
      sy += Math.floor(i / state.width);
      n++;
    }
    return { x: sx / Math.max(1, n), y: sy / Math.max(1, n) };
  });
  const teams = [...new Set(state.players.map((p) => p.team))].sort((a, b) => a - b);
  const spread = teams.map((team) => {
    const members = state.players.filter((p) => p.team === team).map((p) => centre[p.id]!);
    let total = 0;
    let pairs = 0;
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        total += Math.hypot(members[a]!.x - members[b]!.x, members[a]!.y - members[b]!.y);
        pairs++;
      }
    }
    return pairs === 0 ? 0 : total / pairs;
  });
  const winners = [...new Set(state.winners.map((id) => state.players[id]!.team))];
  return { spread, winners, byElimination: state.endedBy === 'elimination', rounds: state.round };
}

function summariseTeams(layouts: TeamLayout[]): void {
  console.log('\nteams:');
  const teamCount = layouts[0]?.spread.length ?? 0;
  for (let team = 0; team < teamCount; team++) {
    const won = layouts.filter((l) => l.winners.length === 1 && l.winners[0] === team).length;
    console.log(`  team ${String.fromCharCode(65 + team)} won ${won} of ${layouts.length}`);
  }
  const shared = layouts.filter((l) => l.winners.length !== 1).length;
  if (shared > 0) console.log(`  shared or drawn ${shared}`);

  const eliminated = layouts.filter((l) => l.byElimination).length;
  const rounds = layouts.reduce((sum, l) => sum + l.rounds, 0) / layouts.length;
  console.log(`  ${eliminated} ended by elimination; ${rounds.toFixed(1)} rounds on average`);

  // Where one team sat more tightly than another, did that help? Relative to the match's
  // own geometry — island size, and so every distance, changes from seed to seed — a team
  // is more compact if its spread is under 90% of the widest team's.
  const uneven = layouts.filter((l) => Math.min(...l.spread) < 0.9 * Math.max(...l.spread));
  const compactWon = uneven.filter(
    (l) => l.winners.length === 1 && l.spread[l.winners[0]!]! === Math.min(...l.spread),
  ).length;
  if (uneven.length > 0) {
    const fair = (1 / teamCount) * uneven.length;
    console.log(
      `  where teams sat unevenly (${uneven.length} matches), the most compact won ${compactWon}` +
        ` — ${fair.toFixed(1)} if it made no difference`,
    );
  }
  if (uneven.length < layouts.length) {
    console.log(`  ${layouts.length - uneven.length} matches seated every team alike`);
  }
}

// -------------------------------------------------------------------------- run

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = parseArgs(process.argv.slice(2));
const bundle = loadConfigBundle(repoRoot);

const problems = validateConfigBundle(bundle);
if (problems.length > 0) {
  console.error(`configuration is invalid:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}

if (args.map) {
  const map = generateTerrain(bundle.terrain, args.players, args.seed);
  const structure = new Uint8Array(map.width * map.height);
  for (const castle of map.castles) {
    for (let oy = 0; oy < castle.h; oy++) {
      for (let ox = 0; ox < castle.w; ox++) {
        structure[(castle.y + oy) * map.width + castle.x + ox] = 2;
      }
    }
  }
  console.log(
    `${args.players}p seed ${args.seed} — areas ${map.islandAreas.join('/')}, ` +
      `${map.width}x${map.height}, ${map.attempts} attempt(s)`,
  );
  console.log(renderAscii({ ...map, structure }));
  process.exit(0);
}

/** Which tier sits in each seat, repeating the list if it is shorter than the table. */
const seatTier = (p: number): Difficulty =>
  args.difficulties[p % args.difficulties.length] as Difficulty;
const table = Array.from({ length: args.players }, (_, p) => seatTier(p));

console.log(
  // No grid size here: it is measured from the island, which varies a little with the
  // seed, so there is no one figure to quote. `--map` prints each map's own.
  `running ${args.matches} match(es), ${args.players} bots (${table.join(', ')})\n`,
);

const ruleset =
  args.maxRounds === undefined
    ? bundle.ruleset
    : { ...bundle.ruleset, scoring: { ...bundle.ruleset.scoring, maxRounds: args.maxRounds } };

const layouts: TeamLayout[] = [];
const started = Date.now();
const outcomes = new Map<string, number>();
const wins = new Map<Difficulty, number>();
const stats: StatRow[] = [];
let refusedTotal = 0;
let totalTicks = 0;
let totalRounds = 0;
let unfinished = 0;

for (let i = 0; i < args.matches; i++) {
  const seed = args.seed + i;
  const state = createMatch({
    seed,
    ruleset,
    terrainConfig: bundle.terrain,
    players: teamSeating(seed, args.players, args.teams).map((team, p) => ({
      name: `${seatTier(p)}${p}`,
      isBot: true,
      team,
    })),
  });
  const rng = new Rng(seed);
  const bots = state.players.map((p) => new Bot(p.id, seatTier(p.id)));
  let refused = 0;

  // Reset at every resolution, so a row counts only its own round's work.
  const placed = new Map<number, number>();
  const fired = new Map<number, number>();
  const repairAtBuild = new Map<number, number>();
  const repairLeft = new Map<number, number>();
  const repairStuck = new Map<number, number>();
  /**
   * The tightest wall that would seal a castle, in cells still to fill — zero for a wall
   * that stands. Asked of the min cut rather than of `enclosedCastles`, which is not
   * recomputed when shots land and so still says "sealed" as a breached phase opens.
   */
  const tightestRepair = (id: number): number =>
    cheapestPlanFor(state, id, 1, 1)?.cost ?? Number.POSITIVE_INFINITY;

  while (state.phase !== 'game_over' && state.tick < args.maxTicks) {
    for (const player of state.players) {
      const action = bots[player.id]?.think(state, rng) ?? null;
      if (action !== null && applyAction(state, action) !== null) refused++;
    }
    step(state);
    const events = drainEvents(state);
    if (args.stats === null) continue;

    // Measured once as the phase opens and once on its last tick, which is the last
    // moment before the resolution wipes a failed island.
    if (state.phase === 'build' && state.tick === state.phaseEndTick - 1) {
      for (const p of state.players) {
        if (p.eliminated) continue;
        const plan = cheapestPlanFor(state, p.id, 1, 1);
        repairLeft.set(p.id, plan?.cost ?? Number.POSITIVE_INFINITY);
        const missing = plan?.tiles.filter((i) => state.structure[i] === Structure.Empty) ?? [];
        repairStuck.set(p.id, missing.filter((i) => !coverable(state, p.id, i)).length);
      }
    }

    for (const event of events) {
      if (event.kind === 'phase_changed' && event.phase === 'build') {
        for (const p of state.players) {
          if (!p.eliminated) repairAtBuild.set(p.id, tightestRepair(p.id));
        }
      } else if (event.kind === 'piece_placed') {
        placed.set(event.player, (placed.get(event.player) ?? 0) + 1);
      } else if (event.kind === 'shot_fired') {
        fired.set(event.shot.owner, (fired.get(event.shot.owner) ?? 0) + 1);
      } else if (event.kind === 'round_resolved') {
        // Sampled after the step that produced the event, so the sweep has already
        // run and these are the walls and guns the next barrage will meet.
        for (const result of event.results) {
          let owned = 0;
          let active = 0;
          for (const cannon of state.cannons) {
            if (cannon.owner !== result.player) continue;
            owned++;
            if (cannon.active) active++;
          }
          const tier = seatTier(result.player);
          stats.push({
            seed,
            round: event.round,
            player: result.player,
            difficulty: tier,
            enclosedCastles: result.enclosedCastles,
            cannonsAwarded: result.cannonsAwarded,
            eliminated: result.eliminated,
            cannonsOwned: owned,
            cannonsActive: active,
            cannonRoom: cannonRoom(state, result.player),
            wallTiles: wallTilesOf(state, result.player),
            piecesPlaced: placed.get(result.player) ?? 0,
            piecesBudget: piecesBudget(bundle, tier),
            shotsFired: fired.get(result.player) ?? 0,
            territoryPoints: result.territoryPoints,
            damagePoints: result.damagePoints,
            score: state.players[result.player]?.score ?? 0,
            repairAtBuild: repairAtBuild.get(result.player) ?? 0,
            repairLeft: repairLeft.get(result.player) ?? 0,
            repairStuck: repairStuck.get(result.player) ?? 0,
          });
        }
        placed.clear();
        fired.clear();
        repairAtBuild.clear();
        repairLeft.clear();
        repairStuck.clear();
      }
    }
  }
  if (refused > 0) refusedTotal += refused;

  if (args.teams > 1) layouts.push(teamLayout(state));
  const outcome = describeOutcome(state);
  outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
  // A shared win counts for each player who shares it.
  for (const winner of state.phase === 'game_over' ? state.winners : []) {
    const tier = seatTier(winner);
    wins.set(tier, (wins.get(tier) ?? 0) + 1);
  }
  totalTicks += state.tick;
  totalRounds += state.round;
  if (state.phase !== 'game_over') unfinished++;

  console.log(
    `  seed ${String(seed).padStart(5)}  ${String(state.round).padStart(3)} rounds  ` +
      `${String(state.tick).padStart(6)} ticks  hash ${hashMatchState(state)}  ${outcome}`,
  );
}

const elapsed = Date.now() - started;
console.log(
  `\n${args.matches} matches in ${elapsed}ms (${(elapsed / args.matches).toFixed(1)}ms each)`,
);
console.log(
  `average ${(totalRounds / args.matches).toFixed(1)} rounds, ${(totalTicks / args.matches).toFixed(0)} ticks`,
);
for (const [outcome, count] of [...outcomes].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${outcome}`);
}

if (layouts.length > 0) summariseTeams(layouts);

// Only meaningful with a mixed table; with one tier it is a seat count, which is
// worth seeing anyway because a symmetric map is supposed to make it a flat one.
if (new Set(table).size > 1) {
  console.log('\nwins by tier:');
  for (const tier of DIFFICULTIES) {
    const seats = table.filter((t) => t === tier).length;
    if (seats === 0) continue;
    console.log(
      `  ${tier.padEnd(8)} ${String(wins.get(tier) ?? 0).padStart(3)} (${seats} seat(s))`,
    );
  }
}

if (args.stats !== null) {
  writeStats(args.stats, stats);
  summariseStats(stats);
  console.log(`\n${stats.length} row(s) written to ${args.stats}`);
}

// A bot asking for something the rules refuse is a bug in the bot: everything it
// proposes is derived from the state it was just handed.
if (refusedTotal > 0) {
  console.error(`\n${refusedTotal} action(s) were refused by the rules`);
  process.exit(1);
}
if (unfinished > 0) {
  console.error(
    `\n${unfinished} match(es) did not finish within ${args.maxTicks} ticks. ` +
      `Two evenly matched defenders can hold each other off indefinitely.`,
  );
}
