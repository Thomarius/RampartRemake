import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateConfigBundle } from '@rampart/config';
import { loadConfigBundle } from '@rampart/config/node';
import {
  generateTerrain,
  hashMatchState,
  recordRandomPlayout,
  renderAscii,
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
}

function parseArgs(argv: string[]): Args {
  const args: Args = { matches: 20, players: 3, seed: 1, maxTicks: 120_000, map: false };
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
      case '--map':
        args.map = true;
        break;
      case '--help':
        console.log(
          'usage: npm start -w @rampart/headless -- [--matches N] [--players N] [--seed N] [--max-ticks N] [--map]',
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
  `running ${args.matches} match(es), ${args.players} players, ` +
    `${bundle.terrain.gridWidth}x${bundle.terrain.gridHeight} grid\n`,
);

const started = Date.now();
const outcomes = new Map<string, number>();
let totalTicks = 0;
let totalRounds = 0;
let unfinished = 0;

for (let i = 0; i < args.matches; i++) {
  const seed = args.seed + i;
  const { state } = recordRandomPlayout(
    {
      seed,
      ruleset: bundle.ruleset,
      terrainConfig: bundle.terrain,
      players: Array.from({ length: args.players }, (_, p) => ({ name: `bot${p}`, isBot: true })),
    },
    seed,
    args.maxTicks,
  );

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
if (unfinished > 0) {
  console.error(`\n${unfinished} match(es) did not finish within ${args.maxTicks} ticks`);
  process.exit(1);
}
