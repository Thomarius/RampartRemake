import { SFX_CUES, MUSIC_CUES, type AudioManifest } from './audio.js';
import type { Ruleset } from './ruleset.js';
import type { TerrainConfig } from './terrain.js';
import type { ArtConfig } from './art.js';
import type { ServerConfig } from './server.js';
import { DifficultySchema, type AiConfig } from './ai.js';

export interface ConfigBundle {
  ruleset: Ruleset;
  terrain: TerrainConfig;
  art: ArtConfig;
  audio: AudioManifest;
  server: ServerConfig;
  ai: AiConfig;
}

/**
 * Fraction of the map that may be land once every island is placed. Generous,
 * because the players are meant to be separated by a channel rather than an ocean:
 * the real packing check lives in the terrain generator, which knows the geometry.
 */
const MAX_LAND_FRACTION = 0.8;

/**
 * Constraints that span more than one config file, and so cannot be expressed
 * in any single schema. Returns human-readable problems; empty means valid.
 */
export function validateConfigBundle(bundle: ConfigBundle): string[] {
  const problems: string[] = [];
  const { ruleset, terrain, art, audio } = bundle;

  // The island must not nearly fill its box. When it does, the coastline is pinned by
  // the box rather than by the noise and every seed produces the same map — which
  // generates perfectly and is caught only by a determinism test, if there is one.
  const boxArea = terrain.island.boxWidth * terrain.island.boxHeight;
  if (terrain.island.targetAreaTiles > boxArea * MAX_LAND_FRACTION) {
    problems.push(
      `terrain: an island of ${terrain.island.targetAreaTiles} tiles fills more than ` +
        `${MAX_LAND_FRACTION * 100}% of its ${terrain.island.boxWidth}x${terrain.island.boxHeight} ` +
        `box, leaving the coastline no room to vary between seeds.`,
    );
  }

  // Every playable count needs somewhere to put the islands.
  for (let count = ruleset.players.min; count <= ruleset.players.max; count++) {
    if (!terrain.patterns.some((pattern) => pattern.players === count)) {
      problems.push(`terrain: no island pattern for ${count} players.`);
    }
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

  // A bot difficulty the server can be set to but no profile describes would leave
  // empty seats unplayable.
  for (const name of DifficultySchema.options) {
    if (bundle.ai.profiles[name] === undefined) problems.push(`ai: no profile for "${name}".`);
  }
  if (bundle.ai.profiles[bundle.server.botDifficulty] === undefined) {
    problems.push(`server: botDifficulty "${bundle.server.botDifficulty}" has no profile.`);
  }

  // Enough families for the most teams a table can hold, each with a shade for every
  // member of the largest team a host may choose.
  const { teamSize } = bundle.server.lobbySettings;
  const maxPlayers = ruleset.players.max;
  const mostTeams = Math.floor(maxPlayers / Math.max(2, teamSize.min === 1 ? 2 : teamSize.min));
  if (bundle.art.teamFamilies.length < mostTeams) {
    problems.push(
      `art: ${mostTeams} teams are possible but only ${bundle.art.teamFamilies.length} teamFamilies exist.`,
    );
  }
  if (bundle.art.teamFamilies.some((family) => family.length < teamSize.max)) {
    problems.push(
      `art: every teamFamilies entry needs ${teamSize.max} shades, for teams of ${teamSize.max}.`,
    );
  }

  // A ruleset whose own cap a host could not pick would open every room on a value the
  // lobby then clamps away from, so the default is not the default anyone plays.
  const rounds = ruleset.scoring.maxRounds;
  const bounds = bundle.server.lobbySettings.maxRounds;
  if (rounds !== null && (rounds < bounds.min || rounds > bounds.max)) {
    problems.push(
      `server: lobbySettings.maxRounds ${bounds.min}-${bounds.max} does not include the ` +
        `ruleset's maxRounds of ${rounds}.`,
    );
  }

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
