import { Structure, Terrain, type MatchState } from './types.js';

export function index(width: number, x: number, y: number): number {
  return y * width + x;
}

export function inBounds(width: number, height: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

/** Orthogonal neighbour offsets, in a fixed order so traversals are deterministic. */
export const NEIGHBOURS_4: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export const NEIGHBOURS_8: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

export function isLand(state: MatchState, x: number, y: number): boolean {
  if (!inBounds(state.width, state.height, x, y)) return false;
  return state.terrain[index(state.width, x, y)] === Terrain.Land;
}

export function isEmptyLand(state: MatchState, x: number, y: number): boolean {
  if (!isLand(state, x, y)) return false;
  return state.structure[index(state.width, x, y)] === Structure.Empty;
}

/** Island owning a tile, or 0 for water. */
export function islandAt(state: MatchState, x: number, y: number): number {
  if (!inBounds(state.width, state.height, x, y)) return 0;
  return state.islandId[index(state.width, x, y)] ?? 0;
}

/** Iterates the tiles of a rectangle, clipped to the grid. */
export function forEachInRect(
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
  visit: (x: number, y: number, i: number) => void,
): void {
  const x1 = Math.min(x + w, width);
  const y1 = Math.min(y + h, height);
  for (let ty = Math.max(0, y); ty < y1; ty++) {
    for (let tx = Math.max(0, x); tx < x1; tx++) {
      visit(tx, ty, ty * width + tx);
    }
  }
}

/** True when every tile of the rectangle is inside the grid. */
export function rectInBounds(
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  return x >= 0 && y >= 0 && x + w <= width && y + h <= height;
}
