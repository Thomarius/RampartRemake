import { defaultRuleset } from '@rampart/config';
import { describe, expect, it } from 'vitest';

import {
  PIECE_CATALOGUE,
  pieceAt,
  pieceById,
  pieceByName,
  pieceCells,
  poolForRound,
} from './pieces.js';

describe('piece catalogue', () => {
  it('collapses rotations that are the same shape', () => {
    expect(pieceByName('i1').rotations).toHaveLength(1); // a single cell
    expect(pieceByName('i2').rotations).toHaveLength(2); // domino
    expect(pieceByName('x5').rotations).toHaveLength(1); // the plus is symmetric
    expect(pieceByName('o4').rotations).toHaveLength(1); // square
    expect(pieceByName('i4').rotations).toHaveLength(2); // bar
    expect(pieceByName('l4').rotations).toHaveLength(4);
    expect(pieceByName('s4').rotations).toHaveLength(2);
  });

  it('keeps the cell count constant across rotations', () => {
    for (const piece of PIECE_CATALOGUE) {
      const count = piece.rotations[0]!.length;
      for (const rotation of piece.rotations) expect(rotation).toHaveLength(count);
    }
  });

  it('normalises every rotation to the origin', () => {
    for (const piece of PIECE_CATALOGUE) {
      for (const rotation of piece.rotations) {
        expect(Math.min(...rotation.map(([x]) => x))).toBe(0);
        expect(Math.min(...rotation.map(([, y]) => y))).toBe(0);
      }
    }
  });

  it('wraps out-of-range rotation indices', () => {
    const piece = pieceByName('l4');
    expect(pieceCells(piece.id, 4)).toEqual(pieceCells(piece.id, 0));
    expect(pieceCells(piece.id, -1)).toEqual(pieceCells(piece.id, 3));
  });

  it('rejects an unknown piece name with the list of known ones', () => {
    expect(() => pieceByName('nope')).toThrow(/known pieces: /);
  });

  it('has every piece of one to five cells that the rules allow', () => {
    const bySize = new Map<number, number>();
    for (const piece of PIECE_CATALOGUE) {
      bySize.set(piece.size, (bySize.get(piece.size) ?? 0) + 1);
    }
    // One-sided shapes: 1, 1, 2 and 7 for sizes one to four, and the eleven five-cell
    // pieces that fit a 3x3 box.
    expect(bySize.get(1)).toBe(1);
    expect(bySize.get(2)).toBe(1);
    expect(bySize.get(3)).toBe(2);
    expect(bySize.get(4)).toBe(7);
    expect(bySize.get(5)).toBe(11);
  });

  it('keeps every five-cell piece inside a 3x3 box', () => {
    for (const piece of PIECE_CATALOGUE) {
      if (piece.size !== 5) continue;
      for (const bounds of piece.bounds) {
        expect(Math.max(bounds.w, bounds.h)).toBeLessThanOrEqual(3);
      }
    }
  });

  it('only names pieces the simulation actually has', () => {
    for (const entry of defaultRuleset.build.pieces) {
      expect(() => pieceByName(entry.name)).not.toThrow();
    }
  });
});

describe('the round schedule', () => {
  it('starts with small pieces and ends with large ones', () => {
    const early = poolForRound(defaultRuleset, 1).ids.map((id) => pieceById(id).size);
    const late = poolForRound(defaultRuleset, 9).ids.map((id) => pieceById(id).size);

    // Round one can always plug a one-tile gap; by the late game it cannot.
    expect(early).toContain(1);
    expect(late).not.toContain(1);
    expect(early).not.toContain(5);
    expect(late).toContain(5);
  });

  it('follows the configured bands', () => {
    for (const band of defaultRuleset.build.sizeSchedule) {
      const sizes = new Set(
        poolForRound(defaultRuleset, band.fromRound).ids.map((id) => pieceById(id).size),
      );
      expect([...sizes].sort()).toEqual([...band.sizes].sort());
    }
  });

  it('uses the first band before the schedule starts', () => {
    // Castle selection and the opening cannon placement happen in round 0.
    expect(poolForRound(defaultRuleset, 0).ids).toEqual(poolForRound(defaultRuleset, 1).ids);
  });

  it('keeps the last band for the rest of the match', () => {
    const last = defaultRuleset.build.sizeSchedule.at(-1)!;
    expect(poolForRound(defaultRuleset, 400).ids).toEqual(
      poolForRound(defaultRuleset, last.fromRound).ids,
    );
  });

  it('refuses a band with no piece to fill it', () => {
    const broken = {
      ...defaultRuleset,
      build: { ...defaultRuleset.build, sizeSchedule: [{ fromRound: 1, sizes: [4] }] },
      // Only three-cell pieces configured, so a four-cell band is unsatisfiable.
    };
    broken.build = { ...broken.build, pieces: [{ name: 'i3', weight: 1 }] };
    expect(() => poolForRound(broken, 1)).toThrow(/empty bag/);
  });
});

describe('the draw', () => {
  it('is the same for every player at the same position', () => {
    // Fairness is not left to chance: two players at the same point in the queue are
    // holding the same piece.
    for (let index = 0; index < 20; index++) {
      expect(pieceAt(defaultRuleset, 42, 3, index)).toBe(pieceAt(defaultRuleset, 42, 3, index));
    }
  });

  it('is reproducible from the seed, which is why it need not be transmitted', () => {
    const draw = (seed: number): number[] =>
      Array.from({ length: 30 }, (_, i) => pieceAt(defaultRuleset, seed, 2, i));
    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(8));
  });

  it('gives a different queue each round', () => {
    const draw = (round: number): number[] =>
      Array.from({ length: 30 }, (_, i) => pieceAt(defaultRuleset, 5, round, i));
    expect(draw(4)).not.toEqual(draw(5));
  });

  it('only ever draws a piece the round allows', () => {
    for (const round of [1, 2, 3, 4, 5, 12]) {
      const allowed = new Set(poolForRound(defaultRuleset, round).ids);
      for (let i = 0; i < 300; i++) {
        expect(allowed.has(pieceAt(defaultRuleset, 3, round, i))).toBe(true);
      }
    }
  });

  it('respects the configured weights within a band', () => {
    const ruleset = {
      ...defaultRuleset,
      build: {
        ...defaultRuleset.build,
        pieces: [
          { name: 'o4', weight: 9 },
          { name: 'i4', weight: 1 },
        ],
        sizeSchedule: [{ fromRound: 1, sizes: [4] }],
      },
    };
    let squares = 0;
    const draws = 4000;
    for (let i = 0; i < draws; i++) {
      if (pieceAt(ruleset, 1, 1, i) === pieceByName('o4').id) squares++;
    }
    expect(squares / draws).toBeGreaterThan(0.85);
    expect(squares / draws).toBeLessThan(0.95);
  });
});
