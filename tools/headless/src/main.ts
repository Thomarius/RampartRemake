import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateConfigBundle, type ConfigBundle } from '@rampart/config';
import { loadConfigBundle } from '@rampart/config/node';
import { Bot, DIFFICULTIES, cannonRoom, type Difficulty } from '@rampart/ai';
import {
  Rng,
  Structure,
  applyAction,
  createMatch,
  drainEvents,
  generateTerrain,
  hashMatchState,
  renderAscii,
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
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--matches':
        args.matches = Number(value);
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
            `[--max-ticks N] [--difficulty ${DIFFICULTIES.join('|')}[,...]] [--stats FILE] [--map]`,
        );
        process.exit(0);
    }
  }
  return args;
}

function describeOutcome(state: MatchState): string {
  if (state.phase !== 'game_over') return `unfinished (${state.phase}, round ${state.round})`;
  if (state.draw) return 'draw';
  return state.winner === null ? 'no winner' : `player ${state.winner}`;
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
  console.log('  tier     sealed  owned  active  idle%   room  wall  pieces/budget');
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
          .padStart(4)}  ${(used * 100).toFixed(0).padStart(11)}%`,
    );
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
    ruleset: bundle.ruleset,
    terrainConfig: bundle.terrain,
    players: Array.from({ length: args.players }, (_, p) => ({
      name: `${seatTier(p)}${p}`,
      isBot: true,
    })),
  });
  const rng = new Rng(seed);
  const bots = state.players.map((p) => new Bot(p.id, seatTier(p.id)));
  let refused = 0;

  // Reset at every resolution, so a row counts only its own round's work.
  const placed = new Map<number, number>();
  const fired = new Map<number, number>();

  while (state.phase !== 'game_over' && state.tick < args.maxTicks) {
    for (const player of state.players) {
      const action = bots[player.id]?.think(state, rng) ?? null;
      if (action !== null && applyAction(state, action) !== null) refused++;
    }
    step(state);
    const events = drainEvents(state);
    if (args.stats === null) continue;

    for (const event of events) {
      if (event.kind === 'piece_placed') {
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
          });
        }
        placed.clear();
        fired.clear();
      }
    }
  }
  if (refused > 0) refusedTotal += refused;

  const outcome = describeOutcome(state);
  outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
  if (state.phase === 'game_over' && state.winner !== null && !state.draw) {
    const tier = seatTier(state.winner);
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
