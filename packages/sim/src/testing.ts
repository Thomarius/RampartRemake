import { defaultRuleset, defaultTerrainConfig, type Ruleset } from '@rampart/config';

import { step } from './match.js';
import {
  Structure,
  Terrain,
  type Cannon,
  type Castle,
  type MatchState,
  type PlayerState,
} from './types.js';

/**
 * Builds a match state from an ASCII picture. Enclosure bugs are geometric, and a
 * picture states the case far more clearly than a typed array literal.
 *
 * `.` water   `,` empty land   `#` wall   `@` castle   `*` cannon
 * `1`-`4` empty land belonging to that island (default is island 1)
 *
 * Adjacent `@` or `*` glyphs are grouped into one structure by bounding box.
 */
export function stateFromAscii(art: string, ruleset: Ruleset = defaultRuleset): MatchState {
  const rows = art
    .split('\n')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  const height = rows.length;
  const width = Math.max(...rows.map((r) => r.length));
  const size = width * height;

  const terrain = new Uint8Array(size);
  const islandId = new Uint8Array(size);
  const structure = new Uint8Array(size);
  const owner = new Uint8Array(size);

  const at = (x: number, y: number): string => (rows[y] as string)[x] ?? '.';

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = at(x, y);
      if (ch === '.') continue;
      const i = y * width + x;
      terrain[i] = Terrain.Land;
      islandId[i] = ch >= '1' && ch <= '9' ? Number(ch) : 1;
      if (ch === '#') structure[i] = Structure.Wall;
      else if (ch === '@') structure[i] = Structure.Castle;
      else if (ch === '*') structure[i] = Structure.Cannon;
    }
  }

  const blocks = (glyph: string): { x: number; y: number; w: number; h: number }[] => {
    const seen = new Uint8Array(size);
    const found: { x: number; y: number; w: number; h: number }[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (at(x, y) !== glyph || seen[y * width + x] === 1) continue;
        let w = 0;
        while (at(x + w, y) === glyph && seen[y * width + x + w] === 0) w++;
        let h = 0;
        while (h < height - y && at(x, y + h) === glyph) h++;
        for (let oy = 0; oy < h; oy++)
          for (let ox = 0; ox < w; ox++) seen[(y + oy) * width + x + ox] = 1;
        found.push({ x, y, w, h });
      }
    }
    return found;
  };

  const castles: Castle[] = blocks('@').map((b, id) => ({
    id,
    islandId: islandId[b.y * width + b.x] as number,
    ...b,
    enclosed: false,
  }));
  const cannons: Cannon[] = blocks('*').map((b, id) => ({
    id,
    owner: (islandId[b.y * width + b.x] as number) - 1,
    ...b,
    active: true,
    shotId: null,
  }));

  for (const castle of castles) {
    for (let oy = 0; oy < castle.h; oy++)
      for (let ox = 0; ox < castle.w; ox++)
        owner[(castle.y + oy) * width + castle.x + ox] = castle.islandId;
  }

  const islandIds = [...new Set([...islandId].filter((v) => v > 0))].sort((a, b) => a - b);
  const players: PlayerState[] = islandIds.map((island, id) => ({
    id,
    islandId: island,
    name: `p${id}`,
    isBot: true,
    eliminated: false,
    eliminatedRound: null,
    startingCastleId: null,
    enclosedCastles: 0,
    cannonsToPlace: 0,
    pieceIndex: 0,
  }));

  return {
    seed: 1,
    ruleset,
    terrainConfig: defaultTerrainConfig,
    width,
    height,
    tick: 0,
    round: 1,
    phase: 'combat',
    phaseEndTick: 1000,
    pendingPhase: null,
    players: players.length > 0 ? players : [],
    terrain,
    islandId,
    structure,
    owner,
    territory: new Uint8Array(size),
    castles,
    cannons,
    shots: [],
    nextCannonId: cannons.length,
    nextShotId: 0,
    winner: null,
    draw: false,
    events: [],
  };
}

/**
 * Steps past the opening intermission to the first playable phase. Every match now
 * begins with the announcement, so tests that want to act need to get past it.
 */
export function beginMatch(state: MatchState): MatchState {
  while (state.phase === 'intermission') step(state);
  return state;
}

/** A ruleset with compressed phases, so a whole match runs in a test in milliseconds. */
export function fastRuleset(ruleset: Ruleset = defaultRuleset): Ruleset {
  return {
    ...ruleset,
    phases: {
      castleSelectMs: 400,
      combatMs: 1500,
      buildMs: 1200,
      cannonPlaceMs: 600,
      endOfPhasePauseMs: 100,
      transitionBannerMs: 200,
    },
  };
}
