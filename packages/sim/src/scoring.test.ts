import { defaultRuleset, type Ruleset } from '@rampart/config';
import { describe, expect, it } from 'vitest';

import { step } from './match.js';
import { fire, resolveImpacts } from './shots.js';
import { stateFromAscii, withoutContinues } from './testing.js';
import { Structure, type MatchState } from './types.js';

/** A cannon on island 1, and on island 2 a wall with a stretch of island 1's beside it. */
const FIRING = [
  `
  ....................
  ..**.........#######
  ..**.........#......
  ....................
`,
  `
  ....................
  .............11222..
  ....................
  ....................
`,
] as const;

function firing(ruleset: Ruleset = defaultRuleset): MatchState {
  return stateFromAscii(FIRING[0], ruleset, FIRING[1]);
}

function fireAndLand(state: MatchState, x: number, y: number): void {
  const result = fire(state, 0, x, y);
  if (!('shot' in result)) throw new Error(`fire rejected: ${result.rejection}`);
  state.tick = result.shot.impactTick;
  resolveImpacts(state);
}

describe('whose wall a shot may damage', () => {
  it('refuses a target on your own island', () => {
    const state = firing();
    expect(fire(state, 0, 13, 1)).toEqual({ rejection: 'own_island' });
    // Any tile of your own island, not only wall: nothing there is an opponent's.
    expect(fire(state, 0, 2, 1)).toEqual({ rejection: 'own_island' });
  });

  it("clears an opponent's wall and credits the shooter", () => {
    const state = firing();
    fireAndLand(state, 16, 1);
    expect(state.structure[1 * state.width + 16]).toBe(Structure.Empty);
    expect(state.players[0]!.wallsDestroyed).toBe(1);
  });

  it('does not let a wide crater reach your own wall', () => {
    const state = firing();
    state.ruleset = { ...state.ruleset, shots: { ...state.ruleset.shots, craterPattern: 'plus5' } };
    // Aimed at island 2's first tile; the crater spills one tile west onto island 1.
    fireAndLand(state, 15, 1);
    expect(state.structure[1 * state.width + 15]).toBe(Structure.Empty);
    expect(state.structure[1 * state.width + 16]).toBe(Structure.Empty);
    expect(state.structure[1 * state.width + 14]).toBe(Structure.Wall);
    expect(state.players[0]!.wallsDestroyed).toBe(2);
  });

  it("leaves an eliminated player's rubble standing, and scores nothing for it", () => {
    const state = firing();
    // Stripping an eliminated player clears the owner and leaves the wall.
    for (let i = 0; i < state.owner.length; i++) if (state.islandId[i] === 2) state.owner[i] = 0;
    fireAndLand(state, 16, 1);
    expect(state.structure[1 * state.width + 16]).toBe(Structure.Wall);
    expect(state.players[0]!.wallsDestroyed).toBe(0);
  });

  it('can be told to allow self-fire, which still never scores', () => {
    const state = firing({
      ...defaultRuleset,
      shots: { ...defaultRuleset.shots, damagesOwnWalls: true },
    });
    fireAndLand(state, 13, 1);
    expect(state.structure[1 * state.width + 13]).toBe(Structure.Empty);
    expect(state.players[0]!.wallsDestroyed).toBe(0);
  });
});

/**
 * Three sealed rings, one per island, each around a 4x3 interior holding its castle:
 * twelve enclosed tiles apiece, the castle's own four included.
 */
const RINGS = [
  `
  ........................
  .######..######..######.
  .#,,,,#..#,,,,#..#,,,,#.
  .#,@@,#..#,@@,#..#,@@,#.
  .#,@@,#..#,@@,#..#,@@,#.
  .######..######..######.
  ........................
`,
  `
  ........................
  ........2222222233333333
  ........2222222233333333
  ........2222222233333333
  ........2222222233333333
  ........2222222233333333
  ........................
`,
] as const;

function rings(ruleset: Ruleset): MatchState {
  return stateFromAscii(RINGS[0], ruleset, RINGS[1]);
}

/** Puts the state at the last tick of a build phase and steps into its resolution. */
function resolve(state: MatchState, round = 1): void {
  state.phase = 'build';
  state.round = round;
  state.phaseEndTick = state.tick + 1;
  step(state);
}

/** Knocks a mid-edge block out of a player's ring, so it no longer seals. */
function breach(state: MatchState, player: number): void {
  const x = 3 + 8 * player;
  state.structure[1 * state.width + x] = Structure.Empty;
  state.owner[1 * state.width + x] = 0;
}

const uncapped: Ruleset = {
  ...withoutContinues(defaultRuleset),
  scoring: { ...defaultRuleset.scoring, maxRounds: null },
};

describe('scoring a round', () => {
  it('banks enclosed tiles and the damage dealt', () => {
    const state = rings(uncapped);
    state.players[0]!.wallsDestroyed = 3;
    resolve(state);
    const { tilePoints, wallPoints } = defaultRuleset.scoring;
    expect(state.players[0]!.score).toBe(tilePoints * 12 * 1 + wallPoints * 3);
    expect(state.players[1]!.score).toBe(tilePoints * 12);
    // The accumulator is spent, so the next round counts only its own damage.
    expect(state.players[0]!.wallsDestroyed).toBe(0);

    const resolved = state.events.find((e) => e.kind === 'round_resolved');
    if (resolved?.kind !== 'round_resolved') throw new Error('no resolution');
    expect(resolved.results[0]).toMatchObject({ territoryPoints: 12, damagePoints: 6 });
  });

  it('multiplies total area by total castles, across separate loops', () => {
    // Both of island 1's loops belong to player 0: 24 tiles and two castles is 48, where
    // scoring each loop by itself would give 24.
    const state = stateFromAscii(
      `
      ..................
      .######..######...
      .#,,,,#..#,,,,#...
      .#,@@,#..#,@@,#...
      .#,@@,#..#,@@,#...
      .######..######...
      ..................
      ..............###.
      ..............#@@#
    `,
      uncapped,
      `
      ..................
      ..................
      ..................
      ..................
      ..................
      ..................
      ..................
      ..............2222
      ..............2222
    `,
    );
    resolve(state);
    expect(state.players[0]!.enclosedCastles).toBe(2);
    expect(state.players[0]!.score).toBe(defaultRuleset.scoring.tilePoints * 24 * 2);
  });

  it('counts cannon footprints as territory, so placing a gun costs nothing', () => {
    const state = rings(uncapped);
    state.structure[2 * state.width + 2] = Structure.Cannon;
    resolve(state);
    expect(state.players[0]!.score).toBe(12);
  });

  it('forfeits the whole round, damage included, for failing to seal', () => {
    const ruleset = { ...uncapped, elimination: { ...uncapped.elimination, continues: 1 } };
    const state = rings(ruleset);
    for (const p of state.players) p.continuesRemaining = 1;
    state.players[1]!.wallsDestroyed = 5;
    breach(state, 1);
    resolve(state);
    expect(state.players[1]!.eliminated).toBe(false); // a life spent, still in it
    expect(state.players[1]!.score).toBe(0);
    expect(state.players[1]!.wallsDestroyed).toBe(0);
  });

  it('can be told to keep the damage of a failed round', () => {
    const ruleset: Ruleset = {
      ...uncapped,
      elimination: { ...uncapped.elimination, continues: 1 },
      scoring: { ...uncapped.scoring, scoreDamageOnFailedRound: true },
    };
    const state = rings(ruleset);
    for (const p of state.players) p.continuesRemaining = 1;
    state.players[1]!.wallsDestroyed = 5;
    breach(state, 1);
    resolve(state);
    expect(state.players[1]!.score).toBe(defaultRuleset.scoring.wallPoints * 5);
  });
});

describe('the round cap', () => {
  const capped: Ruleset = {
    ...withoutContinues(defaultRuleset),
    scoring: { ...defaultRuleset.scoring, maxRounds: 10 },
  };

  it('plays on before the cap', () => {
    const state = rings(capped);
    resolve(state, 9);
    expect(state.phase).toBe('intermission');
  });

  it('ends the match at the cap, won by the highest score', () => {
    const state = rings(capped);
    state.players[2]!.wallsDestroyed = 1;
    resolve(state, 10);
    expect(state.phase).toBe('game_over');
    expect(state.winners).toEqual([2]);
    expect(state.endedBy).toBe('round_cap');
    expect(state.draw).toBe(false);
    const over = state.events.find((e) => e.kind === 'game_over');
    expect(over).toMatchObject({ winners: [2], endedBy: 'round_cap', draw: false });
  });

  it('shares the win on a tie at the top, which is not a draw', () => {
    const state = rings(capped);
    state.players[0]!.wallsDestroyed = 1;
    state.players[2]!.wallsDestroyed = 1;
    resolve(state, 10);
    expect(state.winners).toEqual([0, 2]);
    expect(state.draw).toBe(false);
  });

  it('never gives the win to a player who is out, however many points they had', () => {
    const state = rings(capped);
    state.players[1]!.score = 10_000;
    breach(state, 1);
    resolve(state, 10);
    expect(state.players[1]!.eliminated).toBe(true);
    expect(state.winners).toEqual([0, 2]);
    expect(state.endedBy).toBe('round_cap');
  });

  it('ends by elimination when only one is left, even at the cap', () => {
    const state = rings(capped);
    breach(state, 1);
    breach(state, 2);
    resolve(state, 10);
    expect(state.winners).toEqual([0]);
    expect(state.endedBy).toBe('elimination');
  });
});
