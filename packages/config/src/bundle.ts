import { SFX_CUES, MUSIC_CUES, type AudioManifest } from './audio.js';
import type { Ruleset } from './ruleset.js';
import type { TerrainConfig } from './terrain.js';
import type { ArtConfig } from './art.js';
import type { ServerConfig } from './server.js';

export interface ConfigBundle {
  ruleset: Ruleset;
  terrain: TerrainConfig;
  art: ArtConfig;
  audio: AudioManifest;
  server: ServerConfig;
}

/** Fraction of the map that may be land once every island is placed. */
const MAX_LAND_FRACTION = 0.5;

/**
 * Constraints that span more than one config file, and so cannot be expressed
 * in any single schema. Returns human-readable problems; empty means valid.
 */
export function validateConfigBundle(bundle: ConfigBundle): string[] {
  const problems: string[] = [];
  const { ruleset, terrain, art, audio } = bundle;

  const gridArea = terrain.gridWidth * terrain.gridHeight;
  const landArea = ruleset.players.max * terrain.island.targetAreaTiles;
  if (landArea > gridArea * MAX_LAND_FRACTION) {
    problems.push(
      `terrain: ${ruleset.players.max} islands of ${terrain.island.targetAreaTiles} tiles need ` +
        `${landArea} land tiles, exceeding ${Math.floor(gridArea * MAX_LAND_FRACTION)} ` +
        `(${MAX_LAND_FRACTION * 100}% of a ${terrain.gridWidth}x${terrain.gridHeight} grid). ` +
        `Islands would leave no room for the water separating them.`,
    );
  }

  if (art.players.length < ruleset.players.max) {
    problems.push(
      `art: ${art.players.length} player palettes defined but ruleset allows ` +
        `${ruleset.players.max} players.`,
    );
  }

  const [castleW, castleH] = terrain.castles.footprint;
  const ring = terrain.startingWall.ringRadiusTiles;
  const startingFootprint = (castleW + 2 * ring) * (castleH + 2 * ring);
  if (startingFootprint > terrain.island.targetAreaTiles) {
    problems.push(
      `terrain: the starting wall ring occupies ${startingFootprint} tiles, which does not ` +
        `fit an island of ${terrain.island.targetAreaTiles} tiles.`,
    );
  }

  const [cannonW, cannonH] = ruleset.cannons.footprint;
  if (cannonW > castleW + 2 * ring || cannonH > castleH + 2 * ring) {
    problems.push(
      `ruleset: a ${cannonW}x${cannonH} cannon cannot fit inside the starting enclosure.`,
    );
  }

  problems.push(...missingCues(audio));

  return problems;
}

function missingCues(audio: AudioManifest): string[] {
  const problems: string[] = [];
  for (const cue of SFX_CUES) {
    if (!(cue in audio.sfx)) problems.push(`audio: missing sfx cue "${cue}".`);
  }
  for (const cue of MUSIC_CUES) {
    if (!(cue in audio.music)) problems.push(`audio: missing music cue "${cue}".`);
  }
  return problems;
}

export function assertValidConfigBundle(bundle: ConfigBundle): void {
  const problems = validateConfigBundle(bundle);
  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}
