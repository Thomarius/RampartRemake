import { defaultRuleset, defaultTerrainConfig, type Ruleset } from '@rampart/config';
import { describe, expect, it } from 'vitest';

import { applyAction, createMatch, step } from './match.js';
import { canPlacePiece } from './placement.js';
import { fire, resolveImpacts } from './shots.js';
import { seatOrder, teamScore } from './teams.js';
import { stateFromAscii, withoutContinues } from './testing.js';
import { Structure, type MatchState } from './types.js';

/** Three sealed rings on three islands, twelve enclosed tiles apiece. */
const ART = `
  ........................
  .######..######..######.
  .#,,,,#..#,,,,#..#,,,,#.
  .#,@@,#..#,@@,#..#,@@,#.
  .#,@@,#..#,@@,#..#,@@,#.
  .######..######..######.
  ........................
`;
const ISLANDS = `
  ........................
  ........2222222233333333
  ........2222222233333333
  ........2222222233333333
  ........2222222233333333
  ........2222222233333333
  ........................
`;

const uncapped: Ruleset = {
  ...withoutContinues(defaultRuleset),
  scoring: { ...defaultRuleset.scoring, maxRounds: null },
};

/** Players 0 and 1 a team, player 2 alone, with `lives` in each pool. */
function teamed(ruleset: Ruleset = uncapped, lives = 0): MatchState {
  const state = stateFromAscii(ART, ruleset, ISLANDS);
  state.players[1]!.team = 0;
  state.players[2]!.team = 1;
  state.teams = [
    { id: 0, continuesRemaining: lives, continuesAtStart: lives },
    { id: 1, continuesRemaining: lives, continuesAtStart: lives },
  ];
  return state;
}

function resolve(state: MatchState, round = 1): void {
  state.ruleset = { ...state.ruleset, build: { ...state.ruleset.build, overtimeMs: 0 } };
  state.phase = 'build';
  state.round = round;
  state.phaseEndTick = state.tick + 1;
  step(state);
}

function breach(state: MatchState, player: number): void {
  const i = 1 * state.width + 3 + 8 * player;
  state.structure[i] = Structure.Empty;
  state.owner[i] = 0;
}

describe('forming teams', () => {
  it('pools every member’s continues, and leaves free-for-all as teams of one', () => {
    const players = (teams: (number | undefined)[]) =>
      teams.map((team, i) =>
        team === undefined ? { name: `p${i}`, isBot: true } : { name: `p${i}`, isBot: true, team },
      );
    const options = { seed: 1, ruleset: defaultRuleset, terrainConfig: defaultTerrainConfig };
    const { continues } = defaultRuleset.elimination;

    const twoByTwo = createMatch({ ...options, players: players([7, 9, 7, 9]) });
    expect(twoByTwo.players.map((p) => p.team)).toEqual([0, 1, 0, 1]);
    expect(twoByTwo.teams.map((t) => t.continuesRemaining)).toEqual([2 * continues, 2 * continues]);

    const ffa = createMatch({ ...options, players: players([undefined, undefined, undefined]) });
    expect(ffa.players.map((p) => p.team)).toEqual([0, 1, 2]);
    expect(ffa.teams.map((t) => t.continuesRemaining)).toEqual([continues, continues, continues]);
  });
});

describe('no attacking a teammate', () => {
  it('refuses a shot at a teammate’s island', () => {
    const state = teamed();
    state.phase = 'combat';
    state.cannons.push({ id: 0, owner: 0, x: 3, y: 3, w: 1, h: 1, active: true, shotId: null });
    expect(fire(state, 0, 11, 1)).toEqual({ rejection: 'teammate_island' });
    expect('shot' in fire(state, 0, 19, 1)).toBe(true); // the other team is fair game
  });

  it('never clears a teammate’s wall, even with a crater that reaches it', () => {
    const state = teamed({ ...uncapped, shots: { ...uncapped.shots, craterPattern: 'square9' } });
    // Player 0 aims at open water beside island 2; the 3x3 crater takes in island 2's
    // west wall, which is a teammate's.
    const i = 1 * state.width + 9;
    state.shots.push({
      id: 0,
      cannonId: 0,
      owner: 0,
      fromX: 3,
      fromY: 3,
      toX: 8,
      toY: 1,
      launchTick: 0,
      impactTick: 0,
    });
    resolveImpacts(state);
    expect(state.structure[i]).toBe(Structure.Wall);
    expect(state.players[0]!.wallsDestroyed).toBe(0);
  });
});

describe('lives, together', () => {
  it('spends a failing member’s life from the team’s pool', () => {
    const state = teamed(uncapped, 2);
    breach(state, 1);
    resolve(state);
    expect(state.players[1]!.eliminated).toBe(false);
    expect(state.teams[0]!.continuesRemaining).toBe(1);
    expect(state.teams[1]!.continuesRemaining).toBe(2);
  });

  it('puts the whole team out when a member fails with the pool empty', () => {
    const state = teamed(uncapped, 0);
    breach(state, 1);
    resolve(state);
    // Player 0 sealed perfectly, and is out with their teammate.
    expect(state.players[0]!.eliminated).toBe(true);
    expect(state.players[1]!.eliminated).toBe(true);
    expect(state.phase).toBe('game_over');
    expect(state.winners).toEqual([2]);
  });

  it('counts the team’s lives spent for the continue bonus, and caps it', () => {
    const ruleset: Ruleset = {
      ...uncapped,
      elimination: { ...uncapped.elimination, extraCannonsPerContinue: 2, maxExtraCannons: 3 },
    };
    const state = teamed(ruleset, 4);
    breach(state, 0);
    resolve(state);
    const { startingCount } = ruleset.cannons;
    expect(state.players[0]!.cannonsToPlace).toBe(startingCount + 2); // one spent
    // Next round both members fail — player 0's island was wiped — spending the team's
    // second and third lives: 2 x 3 = 6, capped at 3.
    breach(state, 1);
    resolve(state, 2);
    expect(state.players[1]!.cannonsToPlace).toBe(startingCount + 3);
  });
});

describe('winning as a team', () => {
  it('sums the members’ scores at the cap, and every member of the best team wins', () => {
    const state = teamed({ ...uncapped, scoring: { ...uncapped.scoring, maxRounds: 1 } });
    // Player 2 alone outscores either member of team 0, but not the two together.
    state.players[2]!.wallsDestroyed = 5;
    resolve(state, 1);
    expect(state.players[2]!.score).toBeGreaterThan(state.players[0]!.score);
    expect(teamScore(state, 0)).toBeGreaterThan(teamScore(state, 1));
    expect(state.winners).toEqual([0, 1]);
    expect(state.endedBy).toBe('round_cap');
  });
});

describe('building on a teammate’s island', () => {
  /** Somewhere on `island` this player's current piece is allowed to go, or null. */
  function spotOn(state: MatchState, player: number, island: number) {
    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        if (state.islandId[y * state.width + x] !== island) continue;
        for (let rotation = 0; rotation < 4; rotation++) {
          if (canPlacePiece(state, player, rotation, x, y) === null) return { x, y, rotation };
        }
      }
    }
    return null;
  }

  function building(crossIslandBuild: 'none' | 'humans' | 'all'): MatchState {
    const state = teamed({ ...uncapped, teams: { crossIslandBuild } });
    // Open ground on every island, so a piece has somewhere to go.
    for (let i = 0; i < state.structure.length; i++) {
      if (state.structure[i] === Structure.Wall) {
        state.structure[i] = Structure.Empty;
        state.owner[i] = 0;
      }
    }
    state.phase = 'build';
    state.players[0]!.isBot = false;
    return state;
  }

  it('lets a person build for a teammate, and the wall is the teammate’s', () => {
    const state = building('humans');
    const spot = spotOn(state, 0, 2);
    expect(spot).not.toBeNull();
    expect(applyAction(state, { kind: 'place_piece', player: 0, ...spot! })).toBeNull();
    const placed = [...state.structure.keys()].filter((i) => state.structure[i] === Structure.Wall);
    expect(placed.length).toBeGreaterThan(0);
    // Owned by island 2, player 1, so it behaves as their own wall in every rule.
    for (const i of placed) expect(state.owner[i]).toBe(2);
  });

  it('never lets anybody build on an opponent’s island', () => {
    const state = building('all');
    expect(spotOn(state, 0, 3)).toBeNull();
  });

  it('keeps bots off a teammate’s island unless the rules say all may help', () => {
    expect(spotOn(building('humans'), 1, 1)).toBeNull();
    expect(spotOn(building('all'), 1, 1)).not.toBeNull();
  });

  it('can be turned off for everyone', () => {
    expect(spotOn(building('none'), 0, 2)).toBeNull();
  });
});

describe('which seat gets which island', () => {
  it('is a shuffle, the same for the same seed and different for another', () => {
    const order = seatOrder(7, 8);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(seatOrder(7, 8)).toEqual(order);
    const differs = [1, 2, 3, 4, 5].some((seed) => seatOrder(seed, 8).join() !== order.join());
    expect(differs).toBe(true);
  });
});
