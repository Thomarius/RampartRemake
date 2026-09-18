import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { RulesetSchema } from './ruleset.js';
import { TerrainConfigSchema } from './terrain.js';
import { ArtConfigSchema } from './art.js';
import { AudioManifestSchema } from './audio.js';
import { ServerConfigSchema } from './server.js';
import { assertValidConfigBundle, type ConfigBundle } from './bundle.js';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Loads and validates the config bundle from a checkout's `config/` directory.
 * Use this on the server and in tools; the client imports the compiled-in defaults.
 */
export function loadConfigBundle(repoRoot: string): ConfigBundle {
  const dir = join(repoRoot, 'config');
  const bundle: ConfigBundle = {
    ruleset: RulesetSchema.parse(readJson(join(dir, 'ruleset.default.json'))),
    terrain: TerrainConfigSchema.parse(readJson(join(dir, 'terrain.default.json'))),
    art: ArtConfigSchema.parse(readJson(join(dir, 'art.default.json'))),
    audio: AudioManifestSchema.parse(readJson(join(dir, 'audio.manifest.json'))),
    server: ServerConfigSchema.parse(readJson(join(dir, 'server.default.json'))),
  };
  assertValidConfigBundle(bundle);
  return bundle;
}
