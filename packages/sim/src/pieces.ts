import type { Ruleset } from '@rampart/config';

import { streamFor } from './rng.js';

export type Cell = readonly [number, number];

export interface PieceDef {
  id: number;
  name: string;
  /** Distinct rotations only: a square has one, an I-piece two, an L-piece four. */
  rotations: readonly (readonly Cell[])[];
  size: readonly { readonly w: number; readonly h: number }[];
}

/**
 * The wall pieces, in the spirit of the original: mostly tetrominoes, with a couple
 * of trominoes to let a player close a narrow gap and a couple of pentominoes that
 * cover ground fast but are awkward to fit.
 */
const BASE_SHAPES: Readonly<Record<string, readonly Cell[]>> = {
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
  const size = rotations.map((cells) => ({
    w: Math.max(...cells.map(([x]) => x)) + 1,
    h: Math.max(...cells.map(([, y]) => y)) + 1,
  }));
  return { id, name, rotations, size };
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
 * The shared piece sequence. Every player draws from this same list in the same
 * order, so no player can be handed an easier set of shapes than another — the
 * only difference is how far each has advanced through it.
 *
 * Generated once at a fixed length and wrapped, which keeps the match state small
 * and replayable without an unbounded array.
 */
export function generatePieceSequence(ruleset: Ruleset, seed: number): number[] {
  const rng = streamFor(seed, 'pieces');
  const entries = ruleset.build.pieces;
  const ids = entries.map((e) => pieceByName(e.name).id);
  const weights = entries.map((e) => e.weight);

  const sequence: number[] = new Array(ruleset.build.sequenceLength);
  for (let i = 0; i < sequence.length; i++) {
    sequence[i] = ids[rng.nextWeightedIndex(weights)] as number;
  }
  return sequence;
}
