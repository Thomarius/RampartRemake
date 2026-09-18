import type { TerrainConfig } from '@rampart/config';

import { fbm2D } from './noise.js';
import { NEIGHBOURS_4 } from './grid.js';
import { cosTurns, rotationFor, sinTurns } from './trig.js';
import { streamFor } from './rng.js';
import { Terrain } from './types.js';

/**
 * Terrain generation.
 *
 * One island is generated, then rotated into N congruent copies about the map centre.
 * Rotating a finished raster (rather than re-sampling the noise field per island)
 * is what makes the islands the *same* island rather than merely similar ones: for
 * 2 and 4 players the rotation is a multiple of 90 degrees and therefore exact.
 */

export interface IslandLayout {
  playerCount: number;
  /** Distance from map centre to each island centre, in tiles. */
  radius: number;
  /** Angle of the canonical island, in turns. */
  angleOffset: number;
  /** Nominal island extent used for the packing constraints. */
  extent: number;
  centres: readonly { readonly x: number; readonly y: number }[];
}

export interface GeneratedCastle {
  islandId: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GeneratedTerrain {
  width: number;
  height: number;
  terrain: Uint8Array;
  islandId: Uint8Array;
  castles: GeneratedCastle[];
  islandAreas: number[];
  layout: IslandLayout;
  /** How many seeds were rejected before one satisfied every constraint. */
  attempts: number;
  /** Tiles added to reconcile rounding when the rotation is not a quarter turn. */
  repairedTiles: number;
}

/** Why a candidate map was thrown away. Tallied and reported when generation fails. */
export type RejectReason =
  | 'canonical_area'
  | 'canonical_castles'
  | 'island_overlap'
  | 'island_area'
  | 'island_split'
  | 'water_gap'
  | 'castle_out_of_bounds'
  | 'castle_ring_off_island'
  | 'castle_ring_blocked'
  | 'castle_spacing';

export class TerrainGenerationError extends Error {}

/**
 * Irregular islands reach further than a circle of equal area. Island packing is
 * checked against this inflated radius so coastlines do not touch.
 */
const EXTENT_FACTOR = 1.25;
/** Keep islands clear of the map border by this many tiles. */
const BORDER_MARGIN = 2;

/**
 * Places island centres on a ring so the whole map is invariant under rotation by
 * 1/N of a turn — the only arrangement in which no player has a positional advantage.
 *
 * The 1/(2N) turn offset matters: for 4 players it puts islands on the diagonals
 * rather than the axes, which is what makes them fit a square map at all.
 */
export function computeIslandLayout(config: TerrainConfig, playerCount: number): IslandLayout {
  const extent = EXTENT_FACTOR * Math.sqrt(config.island.targetAreaTiles / Math.PI);
  const angleOffset = 0.5 / playerCount;

  const halfW = config.gridWidth / 2;
  const halfH = config.gridHeight / 2;
  const limitX = halfW - BORDER_MARGIN - extent;
  const limitY = halfH - BORDER_MARGIN - extent;
  if (limitX <= 0 || limitY <= 0) {
    throw new TerrainGenerationError(
      `an island of ${config.island.targetAreaTiles} tiles does not fit on a ` +
        `${config.gridWidth}x${config.gridHeight} grid`,
    );
  }

  // Adjacent centres must be far enough apart to leave the required water gap.
  const separation = 2 * extent + config.island.minWaterGapTiles;
  const chord = 2 * Math.abs(sinTurns(0.5 / playerCount));
  const minRadius = playerCount === 1 ? 0 : separation / chord;

  // And close enough in that every island still fits on the map.
  let maxRadius = Infinity;
  for (let i = 0; i < playerCount; i++) {
    const turns = angleOffset + i / playerCount;
    const sx = Math.abs(sinTurns(turns));
    const sy = Math.abs(cosTurns(turns));
    if (sx > 1e-9) maxRadius = Math.min(maxRadius, limitX / sx);
    if (sy > 1e-9) maxRadius = Math.min(maxRadius, limitY / sy);
  }

  if (minRadius > maxRadius) {
    throw new TerrainGenerationError(
      `cannot place ${playerCount} islands of ${config.island.targetAreaTiles} tiles on a ` +
        `${config.gridWidth}x${config.gridHeight} grid with a ${config.island.minWaterGapTiles}-tile ` +
        `water gap: they would need a ring radius of at least ${minRadius.toFixed(1)} tiles but ` +
        `at most ${maxRadius.toFixed(1)} fits. Shrink island.targetAreaTiles or grow the grid.`,
    );
  }

  const radius = playerCount === 1 ? 0 : (minRadius + maxRadius) / 2;
  const cx = (config.gridWidth - 1) / 2;
  const cy = (config.gridHeight - 1) / 2;

  const centres = [];
  for (let i = 0; i < playerCount; i++) {
    const turns = angleOffset + i / playerCount;
    centres.push({ x: cx + radius * sinTurns(turns), y: cy - radius * cosTurns(turns) });
  }

  return { playerCount, radius, angleOffset, extent, centres };
}

/** Noise field for the canonical island: high in the middle, falling off radially. */
function buildField(config: TerrainConfig, layout: IslandLayout, seed: number): Float64Array {
  const { gridWidth: w, gridHeight: h } = config;
  const centre = layout.centres[0] as { x: number; y: number };
  const field = new Float64Array(w * h);
  const roughness = config.island.coastlineRoughness;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - centre.x) / layout.extent;
      const dy = (y - centre.y) / layout.extent;
      const d2 = dx * dx + dy * dy;
      if (d2 > 2.56) {
        field[y * w + x] = -1e9; // well outside the island; never land
        continue;
      }
      const raw = fbm2D(x, y, seed, {
        octaves: config.island.noiseOctaves,
        frequency: config.island.noiseFrequency,
      });
      // roughness 0 gives a perfect disc; 1 lets the noise dominate the coastline.
      const n = 0.5 + (raw - 0.5) * roughness;
      field[y * w + x] = n - d2;
    }
  }
  return field;
}

/** Chooses the sea level that yields an island closest to the requested area. */
function thresholdForArea(field: Float64Array, targetArea: number): number {
  let lo = -2;
  let hi = 2;
  for (let iteration = 0; iteration < 48; iteration++) {
    const mid = (lo + hi) / 2;
    let area = 0;
    for (let i = 0; i < field.length; i++) if ((field[i] as number) > mid) area++;
    if (area > targetArea) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Keeps only the largest 4-connected land region, discarding offshore islets. */
function largestComponent(mask: Uint8Array, w: number, h: number): number {
  const label = new Int32Array(mask.length).fill(-1);
  const queue = new Int32Array(mask.length);
  let best = -1;
  let bestSize = 0;
  let current = 0;

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== Terrain.Land || label[start] !== -1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = current;
    let size = 0;

    while (head < tail) {
      const i = queue[head++] as number;
      size++;
      const x = i % w;
      const y = (i - x) / w;
      for (const [ox, oy] of NEIGHBOURS_4) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (mask[ni] !== Terrain.Land || label[ni] !== -1) continue;
        label[ni] = current;
        queue[tail++] = ni;
      }
    }

    if (size > bestSize) {
      bestSize = size;
      best = current;
    }
    current++;
  }

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === Terrain.Land && label[i] !== best) mask[i] = Terrain.Water;
  }
  return bestSize;
}

/**
 * Smooths the coastline: drops spurs and one-tile isthmuses, fills pinholes.
 * Both rules read a snapshot, so the result does not depend on scan order.
 */
function erode(mask: Uint8Array, w: number, h: number, passes: number): void {
  for (let pass = 0; pass < passes; pass++) {
    const before = mask.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let landNeighbours = 0;
        for (const [ox, oy] of NEIGHBOURS_4) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (before[ny * w + nx] === Terrain.Land) landNeighbours++;
        }
        if (before[i] === Terrain.Land && landNeighbours < 2) mask[i] = Terrain.Water;
        else if (before[i] === Terrain.Water && landNeighbours >= 3) mask[i] = Terrain.Land;
      }
    }
  }
}

/** Distance from each land tile to the nearest water tile, in orthogonal steps. */
function distanceToWater(mask: Uint8Array, w: number, h: number): Int32Array {
  const dist = new Int32Array(mask.length).fill(-1);
  const queue = new Int32Array(mask.length);
  let head = 0;
  let tail = 0;

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== Terrain.Land) {
      dist[i] = 0;
      queue[tail++] = i;
    }
  }

  while (head < tail) {
    const i = queue[head++] as number;
    const x = i % w;
    const y = (i - x) / w;
    const next = (dist[i] as number) + 1;
    for (const [ox, oy] of NEIGHBOURS_4) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (dist[ni] !== -1) continue;
      dist[ni] = next;
      queue[tail++] = ni;
    }
  }
  return dist;
}

/**
 * Whether two castles are far enough apart that neither sits inside the other's
 * starting wall ring.
 *
 * Euclidean spacing alone is not enough: a diagonal offset of 5,5 clears a minimum
 * distance of 7 but drops one castle squarely on the other's ring corner, and the
 * ring is then built with a hole in it. Separation on either axis is what matters,
 * because the ring is a rectangle.
 */
function ringsClear(ax: number, ay: number, bx: number, by: number, clearance: number): boolean {
  return Math.abs(ax - bx) >= clearance || Math.abs(ay - by) >= clearance;
}

/**
 * Picks castle sites by farthest-point sampling: the most inland site first, then
 * repeatedly the site furthest from those already chosen. Spreading castles out is
 * what gives the enclosure decision its bite — a loop around all three is a long
 * perimeter to defend.
 */
function placeCastles(
  mask: Uint8Array,
  dist: Int32Array,
  w: number,
  h: number,
  config: TerrainConfig,
): { x: number; y: number }[] | null {
  const [cw, ch] = config.castles.footprint;
  const minShore = config.castles.minDistanceFromShoreTiles;
  const ring = config.startingWall.ringRadiusTiles;

  const candidates: { x: number; y: number; cx: number; cy: number; inland: number }[] = [];
  for (let y = 0; y + ch <= h; y++) {
    for (let x = 0; x + cw <= w; x++) {
      let inland = Infinity;
      let ok = true;
      for (let oy = 0; oy < ch && ok; oy++) {
        for (let ox = 0; ox < cw; ox++) {
          const i = (y + oy) * w + x + ox;
          if (mask[i] !== Terrain.Land) {
            ok = false;
            break;
          }
          inland = Math.min(inland, dist[i] as number);
        }
      }
      if (!ok || inland < minShore) continue;

      // Every castle must be a viable starting choice, so the whole block the
      // auto-built wall ring occupies has to be solid ground. Without this a
      // player could pick a coastal castle and start the match already breached.
      if (x - ring < 0 || y - ring < 0 || x + cw + ring > w || y + ch + ring > h) continue;
      for (let oy = -ring; oy < ch + ring && ok; oy++) {
        for (let ox = -ring; ox < cw + ring; ox++) {
          if (mask[(y + oy) * w + x + ox] !== Terrain.Land) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;

      candidates.push({ x, y, cx: x + (cw - 1) / 2, cy: y + (ch - 1) / 2, inland });
    }
  }

  if (candidates.length < config.castles.perIsland) return null;

  const chosen: { x: number; y: number; cx: number; cy: number }[] = [];
  const minSpacing2 = config.castles.minSpacingTiles * config.castles.minSpacingTiles;
  const ringClearance = Math.max(cw, ch) + config.startingWall.ringRadiusTiles;

  // Most inland site first; ties broken by scan order, so the choice is deterministic.
  let first = candidates[0] as (typeof candidates)[number];
  for (const c of candidates) if (c.inland > first.inland) first = c;
  chosen.push(first);

  while (chosen.length < config.castles.perIsland) {
    let best: (typeof candidates)[number] | null = null;
    let bestScore = -1;
    for (const c of candidates) {
      let nearest = Infinity;
      let intrudes = false;
      for (const s of chosen) {
        const dx = c.cx - s.cx;
        const dy = c.cy - s.cy;
        nearest = Math.min(nearest, dx * dx + dy * dy);
        if (!ringsClear(c.x, c.y, s.x, s.y, ringClearance)) intrudes = true;
      }
      if (intrudes || nearest < minSpacing2) continue;
      if (nearest > bestScore) {
        bestScore = nearest;
        best = c;
      }
    }
    if (best === null) return null; // island too small for this many well-spaced castles
    chosen.push(best);
  }

  return chosen.map((c) => ({ x: c.x, y: c.y }));
}

/** Number of 4-connected components made of tiles belonging to one island. */
function componentCount(islandId: Uint8Array, id: number, w: number, h: number): number {
  const seen = new Uint8Array(islandId.length);
  const queue = new Int32Array(islandId.length);
  let components = 0;

  for (let start = 0; start < islandId.length; start++) {
    if (islandId[start] !== id || seen[start] === 1) continue;
    components++;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const i = queue[head++] as number;
      const x = i % w;
      const y = (i - x) / w;
      for (const [ox, oy] of NEIGHBOURS_4) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (islandId[ni] !== id || seen[ni] === 1) continue;
        seen[ni] = 1;
        queue[tail++] = ni;
      }
    }
  }
  return components;
}

/** True when no two islands come within `gap` tiles of each other. */
function waterGapHolds(islandId: Uint8Array, w: number, h: number, gap: number): boolean {
  const gap2 = gap * gap;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = islandId[y * w + x] as number;
      if (id === 0) continue;
      for (let oy = -gap; oy <= gap; oy++) {
        const ny = y + oy;
        if (ny < 0 || ny >= h) continue;
        for (let ox = -gap; ox <= gap; ox++) {
          const nx = x + ox;
          if (nx < 0 || nx >= w) continue;
          const other = islandId[ny * w + nx] as number;
          if (other === 0 || other === id) continue;
          if (ox * ox + oy * oy < gap2) return false;
        }
      }
    }
  }
  return true;
}

type Attempt =
  { ok: true; value: Omit<GeneratedTerrain, 'attempts'> } | { ok: false; reason: RejectReason };

function tryGenerate(
  config: TerrainConfig,
  layout: IslandLayout,
  playerCount: number,
  seed: number,
): Attempt {
  const w = config.gridWidth;
  const h = config.gridHeight;

  const field = buildField(config, layout, seed);
  const threshold = thresholdForArea(field, config.island.targetAreaTiles);

  const canonical = new Uint8Array(w * h);
  for (let i = 0; i < canonical.length; i++) {
    canonical[i] = (field[i] as number) > threshold ? Terrain.Land : Terrain.Water;
  }

  largestComponent(canonical, w, h);
  erode(canonical, w, h, config.island.erosionPasses);
  const canonicalArea = largestComponent(canonical, w, h);

  const tolerance = config.island.areaTolerance;
  const target = config.island.targetAreaTiles;
  if (Math.abs(canonicalArea - target) > target * tolerance)
    return { ok: false, reason: 'canonical_area' };

  const dist = distanceToWater(canonical, w, h);
  const castleSpots = placeCastles(canonical, dist, w, h, config);
  if (castleSpots === null) return { ok: false, reason: 'canonical_castles' };

  // Replicate the finished raster into N rotated copies.
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const terrain = new Uint8Array(w * h);
  const islandId = new Uint8Array(w * h);

  for (let player = 0; player < playerCount; player++) {
    const { cos, sin } = rotationFor(-player / playerCount); // inverse: destination -> source
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const sx = Math.round(cx + dx * cos - dy * sin);
        const sy = Math.round(cy + dx * sin + dy * cos);
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        if (canonical[sy * w + sx] !== Terrain.Land) continue;
        const di = y * w + x;
        if (islandId[di] !== 0) return { ok: false, reason: 'island_overlap' };
        terrain[di] = Terrain.Land;
        islandId[di] = player + 1;
      }
    }
  }

  // Rotate the castle sites the same way.
  const [castleW, castleH] = config.castles.footprint;
  const ring = config.startingWall.ringRadiusTiles;
  const minSpacing2 = config.castles.minSpacingTiles * config.castles.minSpacingTiles;
  const castles: GeneratedCastle[] = [];

  for (let player = 0; player < playerCount; player++) {
    const { cos, sin } = rotationFor(player / playerCount);
    const mine: GeneratedCastle[] = [];

    for (const spot of castleSpots) {
      const ccx = spot.x + (castleW - 1) / 2 - cx;
      const ccy = spot.y + (castleH - 1) / 2 - cy;
      const rx = cx + ccx * cos - ccy * sin;
      const ry = cy + ccx * sin + ccy * cos;
      const x = Math.round(rx - (castleW - 1) / 2);
      const y = Math.round(ry - (castleH - 1) / 2);
      if (x - ring < 0 || y - ring < 0 || x + castleW + ring > w || y + castleH + ring > h) {
        return { ok: false, reason: 'castle_out_of_bounds' };
      }
      mine.push({ islandId: player + 1, x, y, w: castleW, h: castleH });
    }

    // Spacing cannot be repaired, only rejected.
    const ringClearance = Math.max(castleW, castleH) + ring;
    for (let a = 0; a < mine.length; a++) {
      for (let b = a + 1; b < mine.length; b++) {
        const first = mine[a] as GeneratedCastle;
        const second = mine[b] as GeneratedCastle;
        const dx = first.x - second.x;
        const dy = first.y - second.y;
        if (dx * dx + dy * dy < minSpacing2) return { ok: false, reason: 'castle_spacing' };
        // Every castle must be able to build a complete ring, which means no other
        // castle may stand on any tile of it.
        if (!ringsClear(first.x, first.y, second.x, second.y, ringClearance)) {
          return { ok: false, reason: 'castle_ring_blocked' };
        }
      }
    }
    castles.push(...mine);
  }

  // Repair the rounding cost of rotation.
  //
  // A 120-degree rotation has no exact representation on a square grid, so a tile
  // of a castle's starting-ring block can land on water even though the canonical
  // island had it covered. Demanding the canonical island survive every rotation
  // instead would mean islands roughly twice this size, for a handful of tiles.
  // Filling them keeps islands within the configured area tolerance and guarantees
  // what actually matters: every castle is a viable opening choice.
  let repaired = 0;
  for (const castle of castles) {
    for (let y = castle.y - ring; y < castle.y + castle.h + ring; y++) {
      for (let x = castle.x - ring; x < castle.x + castle.w + ring; x++) {
        const i = y * w + x;
        const current = islandId[i] as number;
        if (current === castle.islandId) continue;
        if (current !== 0) return { ok: false, reason: 'castle_ring_off_island' };
        terrain[i] = Terrain.Land;
        islandId[i] = castle.islandId;
        repaired++;
      }
    }
  }

  const islandAreas: number[] = new Array(playerCount).fill(0);
  for (let i = 0; i < islandId.length; i++) {
    const id = islandId[i] as number;
    if (id !== 0) islandAreas[id - 1] = (islandAreas[id - 1] as number) + 1;
  }

  for (let player = 0; player < playerCount; player++) {
    const area = islandAreas[player] as number;
    if (Math.abs(area - canonicalArea) > canonicalArea * tolerance) {
      return { ok: false, reason: 'island_area' };
    }
    if (componentCount(islandId, player + 1, w, h) !== 1) {
      return { ok: false, reason: 'island_split' };
    }
  }

  if (!waterGapHolds(islandId, w, h, config.island.minWaterGapTiles)) {
    return { ok: false, reason: 'water_gap' };
  }

  return {
    ok: true,
    value: {
      width: w,
      height: h,
      terrain,
      islandId,
      castles,
      islandAreas,
      layout,
      repairedTiles: repaired,
    },
  };
}

/**
 * Generates a map for `playerCount` players. Rejected seeds are retried; the
 * constraints (area, connectivity, water gap, castle siting) are all fairness
 * requirements, so it is better to draw another seed than to relax one.
 */
export function generateTerrain(
  config: TerrainConfig,
  playerCount: number,
  seed: number,
): GeneratedTerrain {
  const layout = computeIslandLayout(config, playerCount);
  const rng = streamFor(seed, 'terrain');
  const tally = new Map<RejectReason, number>();

  for (let attempt = 0; attempt < config.generation.maxRetries; attempt++) {
    const result = tryGenerate(config, layout, playerCount, rng.nextU32());
    if (result.ok) return { ...result.value, attempts: attempt + 1 };
    tally.set(result.reason, (tally.get(result.reason) ?? 0) + 1);
  }

  // Report which constraint did the rejecting: without it, a configuration that
  // cannot be satisfied looks identical to one that was merely unlucky.
  const breakdown = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason} x${count}`)
    .join(', ');
  throw new TerrainGenerationError(
    `no map satisfied the fairness constraints for ${playerCount} players in ` +
      `${config.generation.maxRetries} attempts (seed ${seed}). Rejections: ${breakdown}`,
  );
}
