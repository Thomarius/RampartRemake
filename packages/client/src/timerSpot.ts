import { Terrain, type MatchState } from '@rampart/sim';

/** Where the big timer sits: the centre of an all-water square, in tile coordinates. */
export interface TimerSpot {
  x: number;
  y: number;
  /** Side of the square, in tiles, which bounds how large the number may be drawn. */
  size: number;
}

/** Squares tried, largest first: a bigger number reads better, if there is room. */
const SIZES = [5, 4, 3] as const;

/**
 * Open water near the middle of the map, for the time left in large figures.
 *
 * The time is the most important number in a phase, and at the top of the screen it is
 * the one a player looking at their wall does not see. The middle is where every island
 * faces, and on a ring or grid it is sea between the islands — so the number goes there,
 * in water, where it covers nothing anybody builds on or aims at.
 *
 * The largest square that fits close enough to the centre wins; failing that, the
 * closest 3x3 anywhere. Terrain never changes during a match, so this is asked once.
 */
export function timerSpot(state: MatchState): TimerSpot | null {
  const { width: w, height: h, terrain } = state;
  // Summed-area table of land, so any square is tested for water in constant time.
  const land = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const isLand = terrain[y * w + x] === Terrain.Land ? 1 : 0;
      land[(y + 1) * (w + 1) + x + 1] =
        isLand +
        (land[y * (w + 1) + x + 1] as number) +
        (land[(y + 1) * (w + 1) + x] as number) -
        (land[y * (w + 1) + x] as number);
    }
  }
  const landIn = (x: number, y: number, s: number): number =>
    (land[(y + s) * (w + 1) + x + s] as number) -
    (land[y * (w + 1) + x + s] as number) -
    (land[(y + s) * (w + 1) + x] as number) +
    (land[y * (w + 1) + x] as number);

  const cx = w / 2;
  const cy = h / 2;
  // Close enough to count as the middle: a quarter of the map's shorter side.
  const nearEnough = Math.min(w, h) / 4;
  let fallback: TimerSpot | null = null;

  for (const s of SIZES) {
    let best: TimerSpot | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let y = 0; y + s <= h; y++) {
      for (let x = 0; x + s <= w; x++) {
        if (landIn(x, y, s) !== 0) continue;
        const mx = x + s / 2;
        const my = y + s / 2;
        const d = Math.hypot(mx - cx, my - cy);
        if (d < bestDistance) {
          bestDistance = d;
          best = { x: mx, y: my, size: s };
        }
      }
    }
    if (best !== null && bestDistance <= nearEnough) return best;
    if (best !== null) fallback = best;
  }
  return fallback;
}
