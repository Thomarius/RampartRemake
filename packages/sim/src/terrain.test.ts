import { defaultTerrainConfig, TerrainConfigSchema } from '@rampart/config';
import { describe, expect, it } from 'vitest';

import { NEIGHBOURS_4 } from './grid.js';
import {
  TerrainGenerationError,
  planLayout,
  generateTerrain,
  type GeneratedTerrain,
} from './terrain.js';
import { Terrain } from './types.js';

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

function componentsOf(map: GeneratedTerrain, islandId: number): number {
  const { width: w, height: h } = map;
  const seen = new Uint8Array(w * h);
  let components = 0;
  for (let start = 0; start < w * h; start++) {
    if (map.islandId[start] !== islandId || seen[start]) continue;
    components++;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      const x = i % w;
      const y = (i - x) / w;
      for (const [ox, oy] of NEIGHBOURS_4) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (map.islandId[ni] !== islandId || seen[ni]) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
  }
  return components;
}

describe.each([2, 3, 4, 5, 6, 7, 8])('terrain for %i players', (playerCount) => {
  const maps = SEEDS.map((seed) => generateTerrain(defaultTerrainConfig, playerCount, seed));

  it('generates a map for every seed', () => {
    expect(maps).toHaveLength(SEEDS.length);
  });

  it('gives every player one island of exactly identical size', () => {
    // Exactly, at every count. Islands are translated and mirrored copies of one box
    // and both transforms are exact on a square grid, where the rotational layout this
    // replaces could only manage it at 2 and 4 players.
    for (const map of maps) {
      expect(map.islandAreas).toHaveLength(playerCount);
      expect(Math.min(...map.islandAreas)).toBe(Math.max(...map.islandAreas));
    }
  });

  it('makes every island a single landmass', () => {
    for (const map of maps) {
      for (let island = 1; island <= playerCount; island++) {
        expect(componentsOf(map, island)).toBe(1);
      }
    }
  });

  it('gives every island the same number of castles, all on their own island', () => {
    for (const map of maps) {
      for (let island = 1; island <= playerCount; island++) {
        const mine = map.castles.filter((c) => c.islandId === island);
        expect(mine).toHaveLength(defaultTerrainConfig.castles.perIsland);
        for (const castle of mine) {
          for (let oy = 0; oy < castle.h; oy++) {
            for (let ox = 0; ox < castle.w; ox++) {
              expect(map.islandId[(castle.y + oy) * map.width + castle.x + ox]).toBe(island);
            }
          }
        }
      }
    }
  });

  it('keeps every castle far enough from its neighbours', () => {
    const minSpacing2 =
      defaultTerrainConfig.castles.minSpacingTiles * defaultTerrainConfig.castles.minSpacingTiles;
    for (const map of maps) {
      for (let island = 1; island <= playerCount; island++) {
        const mine = map.castles.filter((c) => c.islandId === island);
        for (let a = 0; a < mine.length; a++) {
          for (let b = a + 1; b < mine.length; b++) {
            const dx = (mine[a]!.x - mine[b]!.x) as number;
            const dy = (mine[a]!.y - mine[b]!.y) as number;
            expect(dx * dx + dy * dy).toBeGreaterThanOrEqual(minSpacing2);
          }
        }
      }
    }
  });

  it('leaves every castle room for its starting wall ring on solid ground', () => {
    // Every castle must be a viable opening choice; a coastal one would start breached.
    const ring = defaultTerrainConfig.startingWall.ringRadiusTiles;
    for (const map of maps) {
      for (const castle of map.castles) {
        for (let y = castle.y - ring; y < castle.y + castle.h + ring; y++) {
          for (let x = castle.x - ring; x < castle.x + castle.w + ring; x++) {
            expect(map.islandId[y * map.width + x]).toBe(castle.islandId);
          }
        }
      }
    }
  });

  it('separates the islands by open water', () => {
    // The closest approach between two islands is always between coastal tiles,
    // so only those need scanning — checking every land tile is 20x the work.
    const gap = defaultTerrainConfig.island.minWaterGapTiles;
    let closest = Infinity;

    for (const map of maps) {
      const coastal: number[] = [];
      for (let y = 0; y < map.height; y++) {
        for (let x = 0; x < map.width; x++) {
          const i = y * map.width + x;
          if (map.islandId[i] === 0) continue;
          for (const [ox, oy] of NEIGHBOURS_4) {
            const nx = x + ox;
            const ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
            if (map.islandId[ny * map.width + nx] === 0) {
              coastal.push(i);
              break;
            }
          }
        }
      }

      for (const i of coastal) {
        const x = i % map.width;
        const y = (i - x) / map.width;
        const id = map.islandId[i] as number;
        for (let oy = -gap; oy <= gap; oy++) {
          for (let ox = -gap; ox <= gap; ox++) {
            const nx = x + ox;
            const ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
            const other = map.islandId[ny * map.width + nx] as number;
            if (other === 0 || other === id) continue;
            closest = Math.min(closest, ox * ox + oy * oy);
          }
        }
      }
    }

    expect(Math.sqrt(closest)).toBeGreaterThanOrEqual(gap);
  });

  it('marks land and island membership consistently', () => {
    for (const map of maps) {
      for (let i = 0; i < map.terrain.length; i++) {
        expect(map.terrain[i] === Terrain.Land).toBe((map.islandId[i] as number) > 0);
      }
    }
  });
});

describe('terrain determinism', () => {
  it('produces an identical map from the same seed', () => {
    const a = generateTerrain(defaultTerrainConfig, 4, 777);
    const b = generateTerrain(defaultTerrainConfig, 4, 777);
    expect(a.terrain).toEqual(b.terrain);
    expect(a.islandId).toEqual(b.islandId);
    expect(a.castles).toEqual(b.castles);
  });

  it('produces different maps from different seeds', () => {
    const a = generateTerrain(defaultTerrainConfig, 4, 1);
    const b = generateTerrain(defaultTerrainConfig, 4, 2);
    expect(a.terrain).not.toEqual(b.terrain);
  });
});

describe('island layout', () => {
  it('measures the map from the pattern rather than being told its size', () => {
    // Two players side by side need a wide, short map; eight need a much larger one.
    // Neither is configured — both fall out of the island box and the arrangement.
    const small = planLayout(defaultTerrainConfig, 2);
    const large = planLayout(defaultTerrainConfig, 8);
    expect(large.width * large.height).toBeGreaterThan(small.width * small.height);
    for (const count of [2, 3, 4, 5, 6, 7, 8]) {
      const plan = planLayout(defaultTerrainConfig, count);
      expect(plan.placements).toHaveLength(count);
    }
  });

  it('keeps every pair of island boxes a channel apart', () => {
    // The water gap used to be a constraint a candidate map could fail. Spacing the
    // boxes makes it true by construction, so there is nothing left to reject.
    const gap = defaultTerrainConfig.island.minWaterGapTiles;
    for (const count of [2, 3, 4, 5, 6, 7, 8]) {
      const plan = planLayout(defaultTerrainConfig, count);
      for (let a = 0; a < plan.placements.length; a++) {
        for (let b = a + 1; b < plan.placements.length; b++) {
          const first = plan.placements[a] as (typeof plan.placements)[number];
          const second = plan.placements[b] as (typeof plan.placements)[number];
          const apartX = Math.abs(first.x - second.x) >= plan.boxWidth + gap;
          const apartY = Math.abs(first.y - second.y) >= plan.boxHeight + gap;
          expect(apartX || apartY).toBe(true);
        }
      }
    }
  });

  it('explains itself when a player count has no pattern', () => {
    const config = TerrainConfigSchema.parse({
      ...defaultTerrainConfig,
      patterns: [{ players: 2, kind: 'grid', cols: 2, rows: 1 }],
    });
    expect(() => planLayout(config, 4)).toThrow(TerrainGenerationError);
    expect(() => planLayout(config, 4)).toThrow(/no island pattern is configured for 4/);
  });

  it('gives every sector the same share of the map', () => {
    // Every island is the same island, so this is exact at every count.
    for (const players of [2, 3, 4, 5, 6, 7, 8]) {
      const map = generateTerrain(defaultTerrainConfig, players, 12);
      expect(Math.min(...map.islandAreas)).toBe(Math.max(...map.islandAreas));
    }
  });
});

describe('the channel between players', () => {
  it('is a narrow strip, not an ocean', () => {
    // The point of sectors rather than islands: ground sits side by side with a
    // channel down the middle. A shot's flight time scales with distance, so an ocean
    // between players means slow artillery and matches that will not end.
    const map = generateTerrain(defaultTerrainConfig, 3, 4);
    const gap = defaultTerrainConfig.island.minWaterGapTiles;

    let shared = 0;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.islandId[y * map.width + x] !== 0) continue;
        const near = new Set<number>();
        for (let oy = -3; oy <= 3; oy++) {
          for (let ox = -3; ox <= 3; ox++) {
            const nx = x + ox;
            const ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
            const id = map.islandId[ny * map.width + nx] as number;
            if (id !== 0) near.add(id);
          }
        }
        // Water within reach of two different players is channel, not ocean.
        if (near.size >= 2) shared++;
      }
    }
    expect(shared).toBeGreaterThan(80);
    expect(gap).toBeLessThanOrEqual(4);
  });
});
