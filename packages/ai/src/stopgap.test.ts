import { defaultRuleset, defaultTerrainConfig } from '@rampart/config';
import {
  Rng,
  applyAction,
  createMatch,
  drainEvents,
  scriptedAction,
  step,
  type Action,
  type MatchState,
} from '@rampart/sim';
import { describe, expect, it } from 'vitest';

import { stopgapAction } from './stopgap.js';

type Driver = (state: MatchState, playerId: number, rng: Rng) => Action | null;

/** The simulation's unthinking driver, as a baseline to measure against. */
const randomDriver: Driver = (state, playerId, rng) =>
  scriptedAction(state, playerId, rng, { fireChance: 0.12, buildChance: 0.1 });

function playOut(
  seed: number,
  playerCount: number,
  maxTicks = 200_000,
  driver: Driver = stopgapAction,
): MatchState {
  const state = createMatch({
    seed,
    ruleset: defaultRuleset,
    terrainConfig: defaultTerrainConfig,
    players: Array.from({ length: playerCount }, (_, i) => ({ name: `bot${i}`, isBot: true })),
  });
  const rng = new Rng(seed);
  while (state.phase !== 'game_over' && state.tick < maxTicks) {
    for (const player of state.players) {
      const action = driver(state, player.id, rng);
      if (action !== null) applyAction(state, action);
    }
    step(state);
    drainEvents(state);
  }
  return state;
}

/** How many of these seeds still had somebody holding a castle after round one. */
function survivalRate(driver: Driver): number {
  let survived = 0;
  for (let seed = 1; seed <= 12; seed++) {
    if (playOut(seed, 3, 200_000, driver).round >= 2) survived++;
  }
  return survived;
}

describe('stopgap opponent', () => {
  it('repairs well enough to outlast the unthinking driver', () => {
    // Stated as a comparison rather than a fixed number, because the absolute rate
    // moves with map generation and rule changes while the property being tested —
    // that plugging ring gaps beats placing blocks at random — does not.
    const baseline = survivalRate(randomDriver);
    const stopgap = survivalRate(stopgapAction);
    expect(stopgap).toBeGreaterThan(baseline);
  });

  it('always reaches a conclusion rather than stalling', () => {
    for (const seed of [1, 7, 13]) {
      expect(playOut(seed, 2).phase).toBe('game_over');
    }
  });

  it('keeps a castle enclosed for as long as it is alive', () => {
    const state = playOut(11, 3);
    for (const player of state.players) {
      if (!player.eliminated) expect(player.enclosedCastles).toBeGreaterThanOrEqual(1);
    }
  });
});
