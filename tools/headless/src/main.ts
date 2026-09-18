import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateConfigBundle } from '@rampart/config';
import { loadConfigBundle } from '@rampart/config/node';
import { Bot, DIFFICULTIES, type Difficulty } from '@rampart/ai';
import {
  Rng,
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
 * seed that generates no valid map, a replay that does not reproduce. Real
 * opponents arrive in M5; for now the drivers play legal moves without thinking.
 */

interface Args {
  matches: number;
  players: number;
  seed: number;
  maxTicks: number;
  map: boolean;
  difficulty: Difficulty;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    matches: 20,
    players: 3,
    seed: 1,
    maxTicks: 150_000,
    map: false,
    difficulty: 'gunner',
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
      case '--difficulty':
        if (DIFFICULTIES.includes(value as Difficulty)) args.difficulty = value as Difficulty;
        i++;
        break;
      case '--map':
        args.map = true;
        break;
      case '--help':
        console.log(
          'usage: npm start -w @rampart/headless -- [--matches N] [--players N] [--seed N] ' +
            `[--max-ticks N] [--difficulty ${DIFFICULTIES.join('|')}] [--map]`,
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
      `${map.attempts} attempt(s), ${map.repairedTiles} tile(s) repaired`,
  );
  console.log(renderAscii({ ...map, structure }));
  process.exit(0);
}

console.log(
  `running ${args.matches} match(es), ${args.players} ${args.difficulty} bots, ` +
    `${bundle.terrain.gridWidth}x${bundle.terrain.gridHeight} grid\n`,
);

const started = Date.now();
const outcomes = new Map<string, number>();
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
      name: `${args.difficulty}${p}`,
      isBot: true,
    })),
  });
  const rng = new Rng(seed);
  const bots = state.players.map((p) => new Bot(p.id, args.difficulty));
  let refused = 0;

  while (state.phase !== 'game_over' && state.tick < args.maxTicks) {
    for (const player of state.players) {
      const action = bots[player.id]?.think(state, rng) ?? null;
      if (action !== null && applyAction(state, action) !== null) refused++;
    }
    step(state);
    drainEvents(state);
  }
  if (refused > 0) refusedTotal += refused;

  const outcome = describeOutcome(state);
  outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
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
