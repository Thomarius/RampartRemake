import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateConfigBundle } from '@rampart/config';
import { loadConfigBundle } from '@rampart/config/node';

// Headless match driver: runs bot-vs-bot matches without rendering, for balance
// tuning, determinism checks and soak testing. Match execution arrives with M1/M5.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const bundle = loadConfigBundle(repoRoot);

console.log('Rampart headless harness');
console.log(`  grid          ${bundle.terrain.gridWidth}x${bundle.terrain.gridHeight}`);
console.log(`  players       ${bundle.ruleset.players.min}-${bundle.ruleset.players.max}`);
console.log(`  castles/isle  ${bundle.terrain.castles.perIsland}`);
console.log(`  tick rate     ${bundle.ruleset.tickRateHz} Hz`);
console.log(`  problems      ${validateConfigBundle(bundle).length}`);
