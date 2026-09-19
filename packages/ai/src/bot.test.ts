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
import { cannonRoom } from './tactics.js';

interface Outcome {
  state: MatchState;
  rejections: Rejection[];
  /** Pieces player 0 laid in each build phase, in order. */
  placementsPerPhase: number[];
  /**
   * What each surviving player held at each round resolution.
   *
   * Sampled there and nowhere else. `enclosedCastles` is live during a build phase, so
   * it is legitimately zero mid-repair — a bot redrawing a wider wall is unsealed for
   * most of the phase and sealed at the end of it, which is the only moment the rules
   * ask about. The sweep runs inside the same step, so these are the walls and guns
   * the next barrage actually meets.
   */
  resolutions: Resolution[];
}

interface Resolution {
  round: number;
  player: number;
  enclosedCastles: number;
  activeCannons: number;
  cannonRoom: number;
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
  const resolutions: Resolution[] = [];
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
    for (const event of drainEvents(state)) {
      if (event.kind !== 'round_resolved') continue;
      for (const result of event.results) {
        if (result.eliminated) continue;
        resolutions.push({
          round: event.round,
          player: result.player,
          enclosedCastles: result.enclosedCastles,
          activeCannons: state.cannons.filter((c) => c.owner === result.player && c.active).length,
          cannonRoom: cannonRoom(state, result.player),
        });
      }
    }
    if (state.phase !== phase) {
      if (phase === 'build') {
        placementsPerPhase.push(placed);
        placed = 0;
      }
      phase = state.phase;
    }
  }
  return { state, rejections, placementsPerPhase, resolutions };
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
    // Measured at the resolutions rather than at the final state: a match now ends in
    // a handful of rounds, and the last of them is the one where somebody's wall came
    // down — the worst possible moment to count anybody's working guns.
    // Seed 1 rather than 3, which is now decided in two rounds — too short to show
    // whether guns survive a sustained barrage, which is the whole question here.
    const { resolutions } = play(1, ['gunner', 'gunner']);
    const late = resolutions.filter((r) => r.round >= 3);
    expect(late.length).toBeGreaterThan(0);
    expect(Math.max(...late.map((r) => r.activeCannons))).toBeGreaterThan(2);
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
    // However many phases the match lasts — it is much shorter than it used to be —
    // the last one should be slower going than the first.
    expect(placementsPerPhase.length).toBeGreaterThanOrEqual(3);
    const first = placementsPerPhase[0] as number;
    const later = placementsPerPhase[placementsPerPhase.length - 1] as number;
    expect(later).toBeLessThan(first);
  }, 60_000);
});

describe('bot competence', () => {
  it('seals a castle in the first build phase', () => {
    // Asked at the resolution, not at a tick chosen to fall inside the phase.
    // `enclosedCastles` is live while building, so a bot part-way through widening its
    // wall reads as zero — which is correct, and says nothing about whether it will
    // close in time. The resolution is where the rules themselves ask the question.
    const { resolutions } = play(3, ['gunner', 'gunner'], 3000);
    const first = resolutions.filter((r) => r.round === 1);
    expect(first.length).toBeGreaterThan(0);
    expect(first.some((r) => r.enclosedCastles >= 1)).toBe(true);
  });

  it('expands beyond the castle it started with', () => {
    // A bot that only ever holds one castle earns two cannons a round forever, has
    // nowhere to put them, and is always one breach from elimination.
    const { resolutions } = play(5, ['marshal', 'marshal'], 30_000);
    expect(resolutions.length).toBeGreaterThan(2);
    // Over the match, not at the end of it: a match that ends in a simultaneous
    // elimination leaves every player holding nothing, which is a fact about how it
    // finished rather than about whether anyone ever expanded.
    expect(Math.max(...resolutions.map((r) => r.enclosedCastles))).toBeGreaterThan(1);
  }, 60_000);

  it('leaves room inside the wall for the cannons it earns', () => {
    // The regression this exists for, and the reason bot matches used to run forever.
    // A minimum cut is the *tightest* wall that works, so a planner handed the cut and
    // told to build it walls itself in against the castle with nowhere to stand a gun.
    // Measured before the fix: gunner and marshal held room for 0.3 cannons, averaged
    // over every surviving player-round, behind a 37-tile ring — and half the guns they
    // owned were outside it and silent. Two of those cannot hurt each other, so nobody
    // ever wins.
    //
    // The wall only has to be roomy enough to spend the reward it is about to earn,
    // which is two cannons for the first castle and one for each after.
    const { resolutions } = play(3, ['marshal', 'gunner'], 20_000);
    expect(resolutions.length).toBeGreaterThan(4);
    const cramped = resolutions.filter((r) => r.cannonRoom < 2).length;
    expect(cramped / resolutions.length).toBeLessThan(0.5);
  }, 90_000);

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
