import rulesetJson from '../../../config/ruleset.default.json' with { type: 'json' };
import terrainJson from '../../../config/terrain.default.json' with { type: 'json' };
import artJson from '../../../config/art.default.json' with { type: 'json' };
import audioJson from '../../../config/audio.manifest.json' with { type: 'json' };
import serverJson from '../../../config/server.default.json' with { type: 'json' };
import aiJson from '../../../config/ai.default.json' with { type: 'json' };

import { RulesetSchema, type Ruleset } from './ruleset.js';
import { TerrainConfigSchema, type TerrainConfig } from './terrain.js';
import { ArtConfigSchema, type ArtConfig } from './art.js';
import { AudioManifestSchema, type AudioManifest } from './audio.js';
import { ServerConfigSchema, type ServerConfig } from './server.js';
import { AiConfigSchema, type AiConfig } from './ai.js';

/**
 * Parsed at module load, so a malformed config file fails immediately at startup
 * rather than at the moment the bad value is first read mid-match.
 */
export const defaultRuleset: Ruleset = RulesetSchema.parse(rulesetJson);
export const defaultTerrainConfig: TerrainConfig = TerrainConfigSchema.parse(terrainJson);
export const defaultArtConfig: ArtConfig = ArtConfigSchema.parse(artJson);
export const defaultAudioManifest: AudioManifest = AudioManifestSchema.parse(audioJson);
export const defaultServerConfig: ServerConfig = ServerConfigSchema.parse(serverJson);
export const defaultAiConfig: AiConfig = AiConfigSchema.parse(aiJson);

export const defaultConfigBundle = {
  ruleset: defaultRuleset,
  terrain: defaultTerrainConfig,
  art: defaultArtConfig,
  audio: defaultAudioManifest,
  server: defaultServerConfig,
  ai: defaultAiConfig,
} as const;
