import { defaultTerrainConfig, TerrainConfigSchema } from '@rampart/config';
import { describe, expect, it } from 'vitest';

import { NEIGHBOURS_4 } from './grid.js';
import {
  TerrainGenerationError,
  computeIslandLayout,
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

describe.each([2, 3, 4])('terrain for %i players', (playerCount) => {
  const maps = SEEDS.map((seed) => generateTerrain(defaultTerrainConfig, playerCount, seed));

  it('generates a map for every seed', () => {
    expect(maps).toHaveLength(SEEDS.length);
  });

  it('only needs rounding repairs when the rotation is not a quarter turn', () => {
    for (const map of maps) {
      if (playerCount === 2 || playerCount === 4) expect(map.repairedTiles).toBe(0);
      else expect(map.repairedTiles).toBeLessThan(40);
    }
  });

  it('gives every player one island of near-identical size', () => {
    for (const map of maps) {
      expect(map.islandAreas).toHaveLength(playerCount);
      const min = Math.min(...map.islandAreas);
      const max = Math.max(...map.islandAreas);
      // 2 and 4 players rotate by exact quarter turns, so those must match exactly.
      // 3 players rotate by 120 degrees, which no square grid represents exactly.
      if (playerCount === 2 || playerCount === 4) expect(min).toBe(max);
      else expect((max - min) / max).toBeLessThan(0.05);
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
  it('spaces islands evenly around the map centre', () => {
    const layout = computeIslandLayout(defaultTerrainConfig, 4);
    expect(layout.centres).toHaveLength(4);
    const cx = (defaultTerrainConfig.gridWidth - 1) / 2;
    const cy = (defaultTerrainConfig.gridHeight - 1) / 2;
    for (const centre of layout.centres) {
      const d = Math.hypot(centre.x - cx, centre.y - cy);
      expect(d).toBeCloseTo(layout.radius, 6);
    }
  });

  it('explains itself when a single island is larger than the map', () => {
    const config = TerrainConfigSchema.parse({
      ...defaultTerrainConfig,
      gridWidth: 40,
      gridHeight: 40,
      island: { ...defaultTerrainConfig.island, targetAreaTiles: 900 },
    });
    expect(() => computeIslandLayout(config, 4)).toThrow(TerrainGenerationError);
    expect(() => computeIslandLayout(config, 4)).toThrow(/does not fit on a 40x40 grid/);
  });

  it('explains itself when islands fit alone but not together', () => {
    // The M0 defaults: each island fits the grid on its own, but four of them plus
    // the water between them do not. Caught only once terrain generation was real.
    const config = TerrainConfigSchema.parse({
      ...defaultTerrainConfig,
      gridWidth: 64,
      gridHeight: 64,
      island: { ...defaultTerrainConfig.island, targetAreaTiles: 420 },
    });
    expect(() => computeIslandLayout(config, 4)).toThrow(/Shrink island.targetAreaTiles/);
  });

  it('places 2 and 4 players at the same packing cost', () => {
    // A consequence of offsetting the ring by half a sector: 4 players sit on the
    // diagonals, where both the water gap and the fit to a square map scale by the
    // same factor. Putting them on the axes instead would not fit at these sizes.
    for (const config of [defaultTerrainConfig]) {
      expect(() => computeIslandLayout(config, 2)).not.toThrow();
      expect(() => computeIslandLayout(config, 4)).not.toThrow();
      const two = computeIslandLayout(config, 2);
      const four = computeIslandLayout(config, 4);
      expect(four.radius).toBeCloseTo(two.radius * Math.SQRT2, 6);
    }
  });
});
