import { defaultRuleset, defaultTerrainConfig } from '@rampart/config';
import { Rng, applyAction, createMatch, drainEvents, step, type MatchState } from '@rampart/sim';
import { describe, expect, it } from 'vitest';

import { stopgapAction } from './opponent.js';

/** Runs a match with every seat driven by the stopgap opponent. */
function playOut(seed: number, playerCount: number, maxTicks = 200_000): MatchState {
  const state = createMatch({
    seed,
    ruleset: defaultRuleset,
    terrainConfig: defaultTerrainConfig,
    players: Array.from({ length: playerCount }, (_, i) => ({ name: `bot${i}`, isBot: true })),
  });
  const rng = new Rng(seed);
  while (state.phase !== 'game_over' && state.tick < maxTicks) {
    for (const player of state.players) {
      const action = stopgapAction(state, player.id, rng);
      if (action !== null) applyAction(state, action);
    }
    step(state);
    drainEvents(state);
  }
  return state;
}

describe('stopgap opponent', () => {
  it('usually survives the first resolution', () => {
    // The simulation's uniformly-random driver never closes a breach at all, so
    // every seat it plays is eliminated in round one. This opponent is weak — it
    // rebuilds the thin ring, which is the wrong shape — but it should get most
    // matches past the first resolution with somebody still standing.
    let survived = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const state = playOut(seed, 3, 2600);
      if (state.players.some((p) => !p.eliminated && p.enclosedCastles >= 1)) survived++;
    }
    expect(survived).toBeGreaterThanOrEqual(7);
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
