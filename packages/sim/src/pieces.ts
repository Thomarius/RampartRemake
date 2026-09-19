import type { Ruleset } from '@rampart/config';

import { Rng, mix32 } from './rng.js';

export type Cell = readonly [number, number];

export interface PieceDef {
  id: number;
  name: string;
  /** Number of cells, which is what the round schedule selects on. */
  size: number;
  /** Distinct rotations only: a square has one, an I-piece two, an L-piece four. */
  rotations: readonly (readonly Cell[])[];
  /** Bounding box per rotation. */
  bounds: readonly { readonly w: number; readonly h: number }[];
}

/**
 * The wall pieces, in the spirit of the original: mostly tetrominoes, with a couple
 * of trominoes to let a player close a narrow gap and a couple of pentominoes that
 * cover ground fast but are awkward to fit.
 */
const BASE_SHAPES: Readonly<Record<string, readonly Cell[]>> = {
  i1: [[0, 0]],
  i2: [
    [0, 0],
    [1, 0],
  ],
  i3: [
    [0, 0],
    [1, 0],
    [2, 0],
  ],
  l3: [
    [0, 0],
    [1, 0],
    [0, 1],
  ],
  o4: [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  i4: [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ],
  t4: [
    [0, 0],
    [1, 0],
    [2, 0],
    [1, 1],
  ],
  s4: [
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
  ],
  z4: [
    [0, 0],
    [1, 0],
    [1, 1],
    [2, 1],
  ],
  j4: [
    [0, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
  l4: [
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
  p5: [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [0, 2],
  ],
  u5: [
    [0, 0],
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
  // The eleven five-cell pieces that fit a 3x3 box, as one-sided shapes: P and F and
  // Z each come as a mirrored pair, while T, U, V, W and X are their own mirror.
  q5: [
    [0, 0],
    [0, 1],
    [1, 1],
    [0, 2],
    [1, 2],
  ],
  f5: [
    [0, 0],
    [0, 1],
    [1, 1],
    [2, 1],
    [1, 2],
  ],
  g5: [
    [0, 0],
    [1, 0],
    [1, 1],
    [2, 1],
    [1, 2],
  ],
  z5: [
    [0, 0],
    [0, 1],
    [1, 1],
    [2, 1],
    [2, 2],
  ],
  s5: [
    [0, 0],
    [1, 0],
    [1, 1],
    [1, 2],
    [2, 2],
  ],
  t5: [
    [0, 0],
    [0, 1],
    [1, 1],
    [2, 1],
    [0, 2],
  ],
  v5: [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 2],
    [2, 2],
  ],
  w5: [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 2],
    [2, 2],
  ],
  x5: [
    [1, 0],
    [0, 1],
    [1, 1],
    [2, 1],
    [1, 2],
  ],
};

/** Rotates 90 degrees clockwise and shifts back to the origin. */
function rotateCw(cells: readonly Cell[]): Cell[] {
  const rotated = cells.map(([x, y]) => [-y, x] as Cell);
  const minX = Math.min(...rotated.map(([x]) => x));
  const minY = Math.min(...rotated.map(([, y]) => y));
  return rotated
    .map(([x, y]) => [x - minX, y - minY] as Cell)
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

function key(cells: readonly Cell[]): string {
  return cells.map(([x, y]) => `${x},${y}`).join(';');
}

function buildPiece(id: number, name: string, base: readonly Cell[]): PieceDef {
  const rotations: Cell[][] = [];
  const seen = new Set<string>();
  let current = [...base].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  for (let r = 0; r < 4; r++) {
    const k = key(current);
    if (!seen.has(k)) {
      seen.add(k);
      rotations.push(current);
    }
    current = rotateCw(current);
  }
  const sizes = rotations.map((cells) => ({
    w: Math.max(...cells.map(([x]) => x)) + 1,
    h: Math.max(...cells.map(([, y]) => y)) + 1,
  }));
  return { id, name, size: base.length, rotations, bounds: sizes };
}

export const PIECE_CATALOGUE: readonly PieceDef[] = Object.entries(BASE_SHAPES).map(
  ([name, base], index) => buildPiece(index, name, base),
);

const BY_NAME = new Map(PIECE_CATALOGUE.map((p) => [p.name, p]));

export function pieceByName(name: string): PieceDef {
  const piece = BY_NAME.get(name);
  if (!piece) {
    throw new Error(
      `unknown piece "${name}"; known pieces: ${[...BY_NAME.keys()].sort().join(', ')}`,
    );
  }
  return piece;
}

export function pieceById(id: number): PieceDef {
  const piece = PIECE_CATALOGUE[id];
  if (!piece) throw new Error(`unknown piece id ${id}`);
  return piece;
}

/** Cells of a piece at a rotation, wrapping the index so any integer is valid. */
export function pieceCells(pieceId: number, rotation: number): readonly Cell[] {
  const piece = pieceById(pieceId);
  const count = piece.rotations.length;
  const index = ((rotation % count) + count) % count;
  return piece.rotations[index] as readonly Cell[];
}

/**
 * Which pieces are in the bag this round.
 *
 * The bands narrow as a match runs on, so the pieces that can plug a one-tile gap
 * give way to ones that cannot. That is deliberate: it is the only thing in the rules
 * that makes a long match harder rather than merely longer.
 */
export function poolForRound(
  ruleset: Ruleset,
  round: number,
): { ids: number[]; weights: number[] } {
  let band = ruleset.build.sizeSchedule[0] as (typeof ruleset.build.sizeSchedule)[number];
  for (const entry of ruleset.build.sizeSchedule) {
    if (entry.fromRound <= round) band = entry;
  }
  const allowed = new Set(band.sizes);

  const ids: number[] = [];
  const weights: number[] = [];
  for (const entry of ruleset.build.pieces) {
    const piece = pieceByName(entry.name);
    if (!allowed.has(piece.size)) continue;
    ids.push(piece.id);
    weights.push(entry.weight);
  }

  if (ids.length === 0) {
    throw new Error(
      `no piece of size ${band.sizes.join('/')} is configured, so round ${round} has an empty bag`,
    );
  }
  return { ids, weights };
}

/** Mixes a draw's coordinates into a seed, without allocating. */
function drawSeed(seed: number, round: number, index: number): number {
  let h = mix32(seed);
  h = mix32(h ^ Math.imul(round + 1, 0x9e3779b1));
  h = mix32(h ^ Math.imul(index + 1, 0x85ebca6b));
  return h >>> 0;
}

/**
 * The piece a player holds at a given position in a round's queue.
 *
 * A pure function of seed, round and index rather than a stored list. That is what
 * lets a client regenerate its own queue from the seed instead of receiving it, and
 * it keeps the match state a fixed size however long a match runs. Every player draws
 * the same piece at the same position, so no one is handed an easier bag.
 */
export function pieceAt(ruleset: Ruleset, seed: number, round: number, index: number): number {
  const pool = poolForRound(ruleset, round);
  const rng = new Rng(drawSeed(seed, round, index));
  return pool.ids[rng.nextWeightedIndex(pool.weights)] as number;
}
