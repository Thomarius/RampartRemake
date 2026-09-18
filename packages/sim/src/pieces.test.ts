import { defaultRuleset } from '@rampart/config';
import { describe, expect, it } from 'vitest';

import { PIECE_CATALOGUE, generatePieceSequence, pieceByName, pieceCells } from './pieces.js';

describe('piece catalogue', () => {
  it('collapses rotations that are the same shape', () => {
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

  it('only names pieces the simulation actually has', () => {
    for (const entry of defaultRuleset.build.pieces) {
      expect(() => pieceByName(entry.name)).not.toThrow();
    }
  });
});

describe('piece sequence', () => {
  it('is reproducible from the seed', () => {
    expect(generatePieceSequence(defaultRuleset, 5)).toEqual(
      generatePieceSequence(defaultRuleset, 5),
    );
    expect(generatePieceSequence(defaultRuleset, 5)).not.toEqual(
      generatePieceSequence(defaultRuleset, 6),
    );
  });

  it('is the configured length and draws only configured pieces', () => {
    const sequence = generatePieceSequence(defaultRuleset, 1);
    expect(sequence).toHaveLength(defaultRuleset.build.sequenceLength);
    const allowed = new Set(defaultRuleset.build.pieces.map((p) => pieceByName(p.name).id));
    for (const id of sequence) expect(allowed.has(id)).toBe(true);
  });

  it('respects the configured weights', () => {
    const ruleset = {
      ...defaultRuleset,
      build: {
        ...defaultRuleset.build,
        pieces: [
          { name: 'o4', weight: 9 },
          { name: 'i4', weight: 1 },
        ],
      },
    };
    const sequence = generatePieceSequence(ruleset, 3);
    const squares = sequence.filter((id) => id === pieceByName('o4').id).length;
    expect(squares / sequence.length).toBeGreaterThan(0.85);
    expect(squares / sequence.length).toBeLessThan(0.95);
  });
});
