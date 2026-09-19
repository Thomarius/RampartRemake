import { defaultRuleset, defaultTerrainConfig } from '@rampart/config';
import {
  Rng,
  applyAction,
  createMatch,
  drainEvents,
  step,
  type MatchState,
  type Rejection,
} from '@rampart/sim';
import { describe, expect, it } from 'vitest';

import { Bot, type Difficulty } from './bot.js';

interface Outcome {
  state: MatchState;
  rejections: Rejection[];
  /** Pieces player 0 laid in each build phase, in order. */
  placementsPerPhase: number[];
}

function play(seed: number, kinds: Difficulty[], maxTicks = 30_000): Outcome {
  const state = createMatch({
    seed,
    ruleset: defaultRuleset,
    terrainConfig: defaultTerrainConfig,
    players: kinds.map((k, i) => ({ name: `${k}${i}`, isBot: true })),
  });
  const rng = new Rng(seed);
  const bots = state.players.map((p) => new Bot(p.id, kinds[p.id] as Difficulty));
  const rejections: Rejection[] = [];
  const placementsPerPhase: number[] = [];
  let placed = 0;
  let phase = state.phase;

  while (state.phase !== 'game_over' && state.tick < maxTicks) {
    for (const player of state.players) {
      const action = bots[player.id]?.think(state, rng) ?? null;
      if (action === null) continue;
      const rejection = applyAction(state, action);
      if (rejection !== null) rejections.push(rejection);
      else if (action.kind === 'place_piece' && player.id === 0) placed++;
    }
    step(state);
    drainEvents(state);
    if (state.phase !== phase) {
      if (phase === 'build') {
        placementsPerPhase.push(placed);
        placed = 0;
      }
      phase = state.phase;
    }
  }
  return { state, rejections, placementsPerPhase };
}

describe('bot conduct', () => {
  it('never asks for a move the rules refuse', () => {
    // A bot goes through the same validated action API as a person, so it cannot
    // cheat. It should also not be wasting the server's time with illegal requests:
    // everything it asks for is derived from the state it was just handed.
    for (const seed of [1, 2]) {
      expect(play(seed, ['marshal', 'gunner', 'recruit']).rejections).toEqual([]);
    }
  }, 60_000);

  it('keeps its guns inside the wall', () => {
    // The regression this exists for: a minimum cut is the *tightest* wall that
    // works, so the planner drew it closer to the castle every round, and the sweep
    // then took the old outer wall away. Bots ended up owning fifteen cannons with
    // two active between them, and a match nobody could win. Cannons are now sinks
    // in the cut, so a wall has to enclose them.
    const { state } = play(3, ['gunner', 'gunner']);
    expect(state.round).toBeGreaterThan(3);

    const active = state.players.map(
      (p) => state.cannons.filter((c) => c.owner === p.id && c.active).length,
    );
    expect(Math.max(...active)).toBeGreaterThan(2);
  }, 90_000);
});

describe('bot pacing', () => {
  it('builds at a rate a person could manage', () => {
    // A person lays roughly 20-30 pieces in a 25-second build phase while the pieces
    // are small, falling to 10-18 once the large ones arrive. A bot placing six a
    // second would be unbeatable for a reason that has nothing to do with playing
    // well, so the budget is time in milliseconds, not a per-tick chance.
    const { placementsPerPhase } = play(3, ['marshal', 'marshal'], 20_000);
    expect(placementsPerPhase.length).toBeGreaterThan(2);
    for (const count of placementsPerPhase) {
      expect(count).toBeLessThanOrEqual(30);
    }
    // And it is actually using the phase, not stopping after a token repair.
    expect(placementsPerPhase[0]).toBeGreaterThanOrEqual(8);
  }, 60_000);

  it('slows down as the pieces get harder to place', () => {
    // The piece schedule widens over the match, and a bigger shape takes longer to
    // fit, so the rate should fall of its own accord rather than by a separate rule.
    const { placementsPerPhase } = play(5, ['marshal', 'marshal'], 30_000);
    expect(placementsPerPhase.length).toBeGreaterThan(4);
    const first = placementsPerPhase[0] as number;
    const later = placementsPerPhase[3] as number;
    expect(later).toBeLessThan(first);
  }, 60_000);
});

describe('bot competence', () => {
  it('seals a castle in the first build phase', () => {
    const { state } = play(3, ['gunner', 'gunner'], 3000);
    expect(state.round).toBeGreaterThanOrEqual(1);
    expect(state.players.some((p) => p.enclosedCastles >= 1)).toBe(true);
  });

  it('expands beyond the castle it started with', () => {
    // A bot that only ever holds one castle earns two cannons a round forever, has
    // nowhere to put them, and is always one breach from elimination.
    const { state } = play(5, ['marshal', 'marshal'], 30_000);
    const most = Math.max(...state.players.map((p) => p.enclosedCastles));
    expect(most).toBeGreaterThan(1);
  }, 60_000);

  it('survives far longer than the opponent it replaces', () => {
    const { state } = play(1, ['gunner', 'gunner']);
    expect(state.round).toBeGreaterThan(5);
  }, 60_000);
});

describe('difficulty', () => {
  it('holds a better position than the tier below it', () => {
    // Scored by position at a fixed point rather than by wins: well-matched bots
    // often do not finish a match at all now, so counting victories measures mostly
    // whether the clock ran out. Castles held and guns that can actually fire is
    // what being ahead looks like.
    const lead = (strong: Difficulty, weak: Difficulty): number => {
      let ahead = 0;
      for (let seed = 1; seed <= 4; seed++) {
        // Both seats, since position carries a real advantage on a symmetric map.
        for (const order of [
          [strong, weak],
          [weak, strong],
        ] as Difficulty[][]) {
          const { state } = play(seed, order as Difficulty[], 20_000);
          const strongSeat = order[0] === strong ? 0 : 1;
          const score = (id: number): number =>
            (state.players[id]?.eliminated ? -100 : 0) +
            (state.players[id]?.enclosedCastles ?? 0) * 5 +
            state.cannons.filter((c) => c.owner === id && c.active).length;
          if (score(strongSeat) >= score(1 - strongSeat)) ahead++;
        }
      }
      return ahead;
    };
    expect(lead('gunner', 'recruit')).toBeGreaterThanOrEqual(5);
  }, 120_000);
});
