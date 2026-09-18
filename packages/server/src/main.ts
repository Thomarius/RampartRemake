import { loadConfigBundle } from '@rampart/config/node';

import { repoRoot } from './paths.js';

// M0 smoke test: prove the config bundle loads and cross-validates from disk.
// The WebSocket server itself arrives in M4.
const bundle = loadConfigBundle(repoRoot);

console.error(
  `config ok — ${bundle.terrain.gridWidth}x${bundle.terrain.gridHeight} grid, ` +
    `${bundle.ruleset.players.min}-${bundle.ruleset.players.max} players, ` +
    `${bundle.terrain.castles.perIsland} castles per island, ` +
    `server would listen on ${bundle.server.host}:${bundle.server.port}`,
);
