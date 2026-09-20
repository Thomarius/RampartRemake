import type { PatternKind, TerrainConfig } from '@rampart/config';

import { fbm2D } from './noise.js';
import { NEIGHBOURS_4 } from './grid.js';
import { cosTurns, sinTurns } from './trig.js';
import { streamFor } from './rng.js';
import { Terrain } from './types.js';

/**
 * Terrain generation.
 *
 * One island is generated inside a rectangular box, then copied into N placements laid
 * out by a pattern. The copies are translated and optionally mirrored, and both are
 * exact on a square grid — so every island is pixel-identical at every player count,
 * and the map's size is measured from the arrangement rather than configured.
 *
 * The rotational layout this replaces could only be exact at 2 and 4 players, because
 * a third of a turn has no representation on a square grid. It paid for that with a
 * slack tile in the channel, a repair pass over rounded castle rings, and four
 * rejection reasons that no longer have anything to reject.
 */

/** Where one island sits on the map, and how it is turned. */
export interface Placement {
  /** Top-left of this island's box, in map coordinates. */
  x: number;
  y: number;
  flipX: boolean;
  flipY: boolean;
}

/**
 * The arrangement of islands, and the map it implies.
 *
 * Measured rather than configured: the box and the pattern decide how big the map has
 * to be, so eight players get the map eight players need instead of being squeezed
 * into a fixed grid.
 */
export interface LayoutPlan {
  playerCount: number;
  kind: PatternKind;
  boxWidth: number;
  boxHeight: number;
  width: number;
  height: number;
  placements: readonly Placement[];
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
  layout: LayoutPlan;
  /** How many seeds were rejected before one satisfied every constraint. */
  attempts: number;
}

/** Why a candidate map was thrown away. Tallied and reported when generation fails. */
/**
 * Why a candidate map was thrown away. Tallied and reported when generation fails.
 *
 * Only two remain. Islands are now translated and mirrored copies of one box rather
 * than rotated ones, and both transforms are exact on a square grid — so equal areas,
 * a single component each, no overlap and the water gap all hold by construction,
 * where the rotational layout had to test for them and reject.
 */
export type RejectReason = 'canonical_area' | 'canonical_castles';

export class TerrainGenerationError extends Error {}

/** Keep land clear of the map border by this many tiles. */
const BORDER_MARGIN = 2;

/**
 * Whether two boxes of this size, centred here, stand clear of each other.
 *
 * Axis separation rather than distance: they are rectangles, so they miss only if one
 * clears the other on an axis entirely. Requiring the gap on that axis is what makes
 * the water between islands at least as wide as configured, by construction.
 */
function boxesClear(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  boxW: number,
  boxH: number,
  gap: number,
): boolean {
  return Math.abs(ax - bx) >= boxW + gap || Math.abs(ay - by) >= boxH + gap;
}

/**
 * Mirrors chosen so the arrangement reads as a pattern rather than as one island
 * stamped N times.
 *
 * Reflection is exact on a square grid, so this is free: the islands stay congruent
 * and equal in area whichever way they are turned. A quarter turn would be exact too,
 * but it swaps the box's width and height and would complicate every placement, for
 * variety that mirroring already provides.
 */
function mirrorFor(column: number, row: number): { flipX: boolean; flipY: boolean } {
  return { flipX: column % 2 === 1, flipY: row % 2 === 1 };
}

/** Islands in rows: tighter than a ring, at the cost of edge and middle seats differing. */
function gridPlacements(
  playerCount: number,
  cols: number,
  boxW: number,
  boxH: number,
  gap: number,
): { x: number; y: number; flipX: boolean; flipY: boolean }[] {
  const out = [];
  for (let i = 0; i < playerCount; i++) {
    const column = i % cols;
    const row = Math.floor(i / cols);
    out.push({
      x: column * (boxW + gap),
      y: row * (boxH + gap),
      ...mirrorFor(column, row),
    });
  }
  return out;
}

/**
 * Islands on a circle, so every player has the same two neighbours at the same
 * distance.
 *
 * The radius is the smallest at which no two boxes touch, found by walking outward a
 * tile at a time. That is a loop rather than a formula because the boxes are
 * axis-aligned while the centres are not, so how much room a given radius buys depends
 * on where the angles happen to fall.
 */
function ringPlacements(
  playerCount: number,
  boxW: number,
  boxH: number,
  gap: number,
): { x: number; y: number; flipX: boolean; flipY: boolean }[] {
  const limit = (boxW + boxH + gap) * playerCount;
  for (let radius = 1; radius <= limit; radius++) {
    const centres = [];
    for (let i = 0; i < playerCount; i++) {
      const turns = i / playerCount;
      centres.push({
        x: Math.round(radius * sinTurns(turns)),
        y: Math.round(-radius * cosTurns(turns)),
      });
    }

    let clear = true;
    for (let a = 0; a < centres.length && clear; a++) {
      for (let b = a + 1; b < centres.length; b++) {
        const first = centres[a] as { x: number; y: number };
        const second = centres[b] as { x: number; y: number };
        if (!boxesClear(first.x, first.y, second.x, second.y, boxW, boxH, gap)) {
          clear = false;
          break;
        }
      }
    }
    if (!clear) continue;

    // Mirror by which side of the ring an island sits on, which is the closest thing
    // to facing the centre that an exact transform can manage.
    return centres.map((c) => ({
      x: c.x - Math.floor(boxW / 2),
      y: c.y - Math.floor(boxH / 2),
      flipX: c.x > 0,
      flipY: c.y > 0,
    }));
  }
  throw new TerrainGenerationError(
    `no ring radius separates ${playerCount} islands of ${boxW}x${boxH} by ${gap} tiles`,
  );
}

/**
 * Lays out the islands and measures the map that holds them.
 *
 * The map is not configured. Its size falls out of the island box and the pattern,
 * which is what lets one configuration serve two players and eight without either
 * being cramped or swimming in ocean.
 */
export function planLayout(
  config: TerrainConfig,
  playerCount: number,
  /**
   * The island's actual extent, which is smaller than the box it was drawn in.
   *
   * Spacing the boxes instead was wrong in a way only a test caught: an island fills
   * about two thirds of its box, so boxes two tiles apart put eight or ten tiles of
   * open water between the land. Section 1.2 rules that out — flight time scales with
   * distance, and an ocean between players means slow artillery and matches that will
   * not end. Measuring the land is what keeps the channel the width it was asked for.
   */
  islandWidth: number = config.island.boxWidth,
  islandHeight: number = config.island.boxHeight,
): LayoutPlan {
  const pattern = config.patterns.find((p) => p.players === playerCount);
  if (pattern === undefined) {
    throw new TerrainGenerationError(
      `no island pattern is configured for ${playerCount} players ` +
        `(patterns exist for ${config.patterns.map((p) => p.players).join(', ')})`,
    );
  }

  const boxW = islandWidth;
  const boxH = islandHeight;
  const gap = config.island.minWaterGapTiles;

  const raw =
    pattern.kind === 'grid'
      ? gridPlacements(playerCount, pattern.cols as number, boxW, boxH, gap)
      : ringPlacements(playerCount, boxW, boxH, gap);

  // Shift the arrangement so it sits inside the border margin, then measure it.
  let minX = Infinity;
  let minY = Infinity;
  for (const place of raw) {
    minX = Math.min(minX, place.x);
    minY = Math.min(minY, place.y);
  }
  const placements = raw.map((place) => ({
    ...place,
    x: place.x - minX + BORDER_MARGIN,
    y: place.y - minY + BORDER_MARGIN,
  }));

  let width = 0;
  let height = 0;
  for (const place of placements) {
    width = Math.max(width, place.x + boxW + BORDER_MARGIN);
    height = Math.max(height, place.y + boxH + BORDER_MARGIN);
  }

  return {
    playerCount,
    kind: pattern.kind,
    boxWidth: boxW,
    boxHeight: boxH,
    width,
    height,
    placements,
  };
}

/**
 * The island's field: high in the middle of the box, falling away towards its edges.
 *
 * Distance from the box edge, roughened by noise. Raising the sea level then eats the
 * island inward from every side at once, which is what makes the result read as a
 * rectangle with a coastline rather than as a circle or a blob.
 */
function buildField(config: TerrainConfig, seed: number): Float64Array {
  const w = config.island.boxWidth;
  const h = config.island.boxHeight;
  const field = new Float64Array(w * h);
  const roughness = config.island.coastlineRoughness * 6;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const toEdge = Math.min(x, y, w - 1 - x, h - 1 - y);
      const raw = fbm2D(x, y, seed, {
        octaves: config.island.noiseOctaves,
        frequency: config.island.noiseFrequency,
      });
      field[y * w + x] = toEdge + (raw - 0.5) * roughness;
    }
  }
  return field;
}

/** Chooses the sea level that yields an island closest to the requested area. */
function thresholdForArea(field: Float64Array, targetArea: number): number {
  // Bounds come from the data: the field is a distance in tiles, so a fixed range
  // would either never reach the target or spend every iteration outside it.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < field.length; i++) {
    const value = field[i] as number;
    if (value <= -1e8) continue;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  if (lo === Infinity) return 0;
  lo -= 1;
  hi += 1;
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

type Attempt =
  { ok: true; value: Omit<GeneratedTerrain, 'attempts'> } | { ok: false; reason: RejectReason };

function tryGenerate(config: TerrainConfig, playerCount: number, seed: number): Attempt {
  const drawW = config.island.boxWidth;
  const drawH = config.island.boxHeight;

  // One island, drawn inside the generation box.
  const field = buildField(config, seed);
  const threshold = thresholdForArea(field, config.island.targetAreaTiles);
  const drawn = new Uint8Array(drawW * drawH);
  for (let i = 0; i < drawn.length; i++) {
    drawn[i] = (field[i] as number) > threshold ? Terrain.Land : Terrain.Water;
  }

  largestComponent(drawn, drawW, drawH);
  erode(drawn, drawW, drawH, config.island.erosionPasses);
  const area = largestComponent(drawn, drawW, drawH);

  const target = config.island.targetAreaTiles;
  if (Math.abs(area - target) > target * config.island.areaTolerance) {
    return { ok: false, reason: 'canonical_area' };
  }

  // Trim to the land. The box is a frame to draw in — it needs slack so the coastline
  // is shaped by the noise rather than by the frame — but the layout has to be spaced
  // on the island itself, or the slack becomes ocean between the players.
  let minX = drawW;
  let minY = drawH;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < drawH; y++) {
    for (let x = 0; x < drawW; x++) {
      if (drawn[y * drawW + x] !== Terrain.Land) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const boxW = maxX - minX + 1;
  const boxH = maxY - minY + 1;

  const canonical = new Uint8Array(boxW * boxH);
  for (let y = 0; y < boxH; y++) {
    for (let x = 0; x < boxW; x++) {
      canonical[y * boxW + x] = drawn[(y + minY) * drawW + x + minX] as number;
    }
  }

  const dist = distanceToWater(canonical, boxW, boxH);
  const castleSpots = placeCastles(canonical, dist, boxW, boxH, config);
  if (castleSpots === null) return { ok: false, reason: 'canonical_castles' };

  const plan = planLayout(config, playerCount, boxW, boxH);

  // Stamp it into every placement. Mirroring is exact, so these are the same island
  // tile for tile — equal areas and a single component each need no checking.
  const w = plan.width;
  const h = plan.height;
  const terrain = new Uint8Array(w * h);
  const islandId = new Uint8Array(w * h);
  const [castleW, castleH] = config.castles.footprint;
  const castles: GeneratedCastle[] = [];

  for (let player = 0; player < playerCount; player++) {
    const place = plan.placements[player] as Placement;
    /** Island coordinates to map coordinates, through this placement's mirrors. */
    const mapX = (bx: number): number => place.x + (place.flipX ? boxW - 1 - bx : bx);
    const mapY = (by: number): number => place.y + (place.flipY ? boxH - 1 - by : by);

    for (let by = 0; by < boxH; by++) {
      for (let bx = 0; bx < boxW; bx++) {
        if (canonical[by * boxW + bx] !== Terrain.Land) continue;
        const i = mapY(by) * w + mapX(bx);
        terrain[i] = Terrain.Land;
        islandId[i] = player + 1;
      }
    }

    for (const spot of castleSpots) {
      // A mirror reflects the footprint too, so take the far corner when flipped.
      const x = mapX(place.flipX ? spot.x + castleW - 1 : spot.x);
      const y = mapY(place.flipY ? spot.y + castleH - 1 : spot.y);
      castles.push({ islandId: player + 1, x, y, w: castleW, h: castleH });
    }
  }

  return {
    ok: true,
    value: {
      width: w,
      height: h,
      terrain,
      islandId,
      castles,
      islandAreas: new Array(playerCount).fill(area) as number[],
      layout: plan,
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
  const rng = streamFor(seed, 'terrain');
  const tally = new Map<RejectReason, number>();

  for (let attempt = 0; attempt < config.generation.maxRetries; attempt++) {
    const result = tryGenerate(config, playerCount, rng.nextU32());
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
