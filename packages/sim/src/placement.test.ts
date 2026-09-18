import { defaultRuleset, defaultTerrainConfig } from '@rampart/config';
import { describe, expect, it } from 'vitest';

import { applyEnclosure } from './enclosure.js';
import { applyAction, createMatch } from './match.js';
import { pieceByName, pieceCells } from './pieces.js';
import {
  canPlaceCannon,
  canPlacePiece,
  countCannons,
  currentPieceId,
  legalCannonPlacements,
  placeCannon,
  placePiece,
  upcomingPieceIds,
} from './placement.js';
import { beginMatch, fastRuleset } from './testing.js';
import { Structure } from './types.js';

/** A match advanced to a build phase, with everyone holding an intact starting ring. */
function buildPhaseMatch(playerCount = 2) {
  const ruleset = fastRuleset();
  const state = beginMatch(
    createMatch({
      seed: 3,
      ruleset,
      terrainConfig: defaultTerrainConfig,
      players: Array.from({ length: playerCount }, (_, i) => ({ name: `p${i}`, isBot: true })),
    }),
  );
  for (const player of state.players) {
    const castle = state.castles.find((c) => c.islandId === player.islandId)!;
    applyAction(state, { kind: 'select_castle', player: player.id, castleId: castle.id });
  }
  state.phase = 'build';
  state.phaseEndTick = state.tick + 100_000;
  return state;
}

/** Finds an empty land tile on the given island. */
function freeTileOn(state: ReturnType<typeof buildPhaseMatch>, islandId: number) {
  for (let i = 0; i < state.structure.length; i++) {
    if (state.islandId[i] === islandId && state.structure[i] === Structure.Empty) {
      const x = i % state.width;
      return { x, y: (i - x) / state.width };
    }
  }
  throw new Error('no free tile');
}

describe('piece placement', () => {
  it('accepts a piece on free land of your own island', () => {
    const state = buildPhaseMatch();
    const spot = freeTileOn(state, 1);
    // Search for an anchor where the whole piece fits.
    let placed = false;
    for (let dy = 0; dy < 20 && !placed; dy++) {
      for (let dx = 0; dx < 20; dx++) {
        if (canPlacePiece(state, 0, 0, spot.x + dx, spot.y + dy) === null) {
          const result = placePiece(state, 0, 0, spot.x + dx, spot.y + dy);
          expect('cells' in result).toBe(true);
          placed = true;
          break;
        }
      }
    }
    expect(placed).toBe(true);
  });

  it('refuses another player’s island', () => {
    // Islands are separated by water, so walls can never be used to grief.
    const state = buildPhaseMatch();
    let checked = false;
    for (let i = 0; i < state.structure.length && !checked; i++) {
      if (state.islandId[i] !== 2 || state.structure[i] !== Structure.Empty) continue;
      const x = i % state.width;
      const y = (i - x) / state.width;
      if (canPlacePiece(state, 0, 0, x, y) === 'wrong_island') checked = true;
    }
    expect(checked).toBe(true);
  });

  it('refuses water, occupied tiles and the map edge', () => {
    const state = buildPhaseMatch();
    expect(canPlacePiece(state, 0, 0, 0, 0)).toBe('not_land');
    expect(canPlacePiece(state, 0, 0, -5, 5)).toBe('out_of_bounds');
    const castle = state.castles.find((c) => c.islandId === 1)!;
    expect(canPlacePiece(state, 0, 0, castle.x, castle.y)).toBe('occupied');
  });

  it('only works during the build phase', () => {
    const state = buildPhaseMatch();
    state.phase = 'combat';
    const spot = freeTileOn(state, 1);
    expect(canPlacePiece(state, 0, 0, spot.x, spot.y)).toBe('wrong_phase');
  });

  it('refuses an eliminated player', () => {
    const state = buildPhaseMatch();
    state.players[0]!.eliminated = true;
    const spot = freeTileOn(state, 1);
    expect(canPlacePiece(state, 0, 0, spot.x, spot.y)).toBe('eliminated');
  });

  it('writes exactly the cells of the piece and advances the sequence', () => {
    const state = buildPhaseMatch();
    const pieceId = currentPieceId(state, 0);
    const expected = pieceCells(pieceId, 0).length;

    let result: ReturnType<typeof placePiece> | null = null;
    outer: for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        if (canPlacePiece(state, 0, 0, x, y) !== null) continue;
        result = placePiece(state, 0, 0, x, y);
        break outer;
      }
    }
    expect(result).not.toBeNull();
    if (result === null || 'rejection' in result) throw new Error('expected a placement');
    expect(result.cells).toHaveLength(expected);
    for (const i of result.cells) expect(state.structure[i]).toBe(Structure.Wall);
    expect(state.players[0]!.pieceIndex).toBe(1);
  });
});

describe('shared piece sequence', () => {
  it('hands every player the same piece at the same position in the queue', () => {
    const state = buildPhaseMatch(3);
    expect(currentPieceId(state, 0)).toBe(currentPieceId(state, 1));
    expect(currentPieceId(state, 0)).toBe(currentPieceId(state, 2));

    // Player 0 places one; the others are now one piece behind, not on a different list.
    const previous = currentPieceId(state, 0);
    state.players[0]!.pieceIndex++;
    expect(currentPieceId(state, 1)).toBe(previous);
    expect(currentPieceId(state, 0)).toBe(state.pieceSequence[1]);
  });

  it('previews the pieces still to come', () => {
    const state = buildPhaseMatch();
    expect(upcomingPieceIds(state, 0, 3)).toEqual(state.pieceSequence.slice(1, 4));
  });

  it('wraps at the end of the sequence rather than running out', () => {
    const state = buildPhaseMatch();
    state.players[0]!.pieceIndex = state.pieceSequence.length;
    expect(currentPieceId(state, 0)).toBe(state.pieceSequence[0]);
  });

  it('only ever offers pieces the catalogue knows', () => {
    const state = buildPhaseMatch();
    const allowed = new Set(defaultRuleset.build.pieces.map((p) => pieceByName(p.name).id));
    for (const id of state.pieceSequence.slice(0, 200)) expect(allowed.has(id)).toBe(true);
  });
});

describe('cannon placement', () => {
  function cannonPhaseMatch() {
    const state = buildPhaseMatch();
    applyEnclosure(state);
    state.phase = 'cannon_place';
    state.phaseEndTick = state.tick + 100_000;
    for (const player of state.players) player.cannonsToPlace = 2;
    return state;
  }

  it('accepts a spot inside your own sealed territory', () => {
    const state = cannonPhaseMatch();
    const spots = legalCannonPlacements(state, 0);
    expect(spots.length).toBeGreaterThan(0);
    const before = countCannons(state, 0);
    const result = placeCannon(state, 0, spots[0]!.x, spots[0]!.y);
    expect('cannon' in result).toBe(true);
    expect(countCannons(state, 0)).toBe(before + 1);
    expect(state.players[0]!.cannonsToPlace).toBe(1);
  });

  it('refuses open ground outside any enclosure', () => {
    const state = cannonPhaseMatch();
    let found = false;
    for (let i = 0; i < state.structure.length && !found; i++) {
      if (state.islandId[i] !== 1 || state.structure[i] !== Structure.Empty) continue;
      if (state.territory[i] !== 0) continue;
      const x = i % state.width;
      const y = (i - x) / state.width;
      if (canPlaceCannon(state, 0, x, y) === 'not_territory') found = true;
    }
    expect(found).toBe(true);
  });

  it('refuses another player’s territory', () => {
    const state = cannonPhaseMatch();
    const theirs = legalCannonPlacements(state, 1);
    expect(theirs.length).toBeGreaterThan(0);
    expect(canPlaceCannon(state, 0, theirs[0]!.x, theirs[0]!.y)).toBe('not_territory');
  });

  it('refuses once the entitlement is spent', () => {
    const state = cannonPhaseMatch();
    state.players[0]!.cannonsToPlace = 0;
    const spots = legalCannonPlacements(state, 0);
    expect(canPlaceCannon(state, 0, spots[0]?.x ?? 5, spots[0]?.y ?? 5)).toBe('no_cannons_left');
  });

  it('honours a configured cannon cap', () => {
    const state = cannonPhaseMatch();
    state.ruleset = {
      ...state.ruleset,
      cannons: { ...state.ruleset.cannons, maxTotal: countCannons(state, 0) },
    };
    const spots = legalCannonPlacements(state, 0);
    expect(spots).toHaveLength(0);
    expect(canPlaceCannon(state, 0, 5, 5)).toBe('cannon_cap');
  });

  it('only works during the cannon phase', () => {
    const state = cannonPhaseMatch();
    state.phase = 'combat';
    expect(canPlaceCannon(state, 0, 5, 5)).toBe('wrong_phase');
  });
});
