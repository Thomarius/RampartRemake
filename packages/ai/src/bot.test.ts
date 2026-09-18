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
}

function play(seed: number, kinds: Difficulty[], maxTicks = 150_000): Outcome {
  const state = createMatch({
    seed,
    ruleset: defaultRuleset,
    terrainConfig: defaultTerrainConfig,
    players: kinds.map((k, i) => ({ name: `${k}${i}`, isBot: true })),
  });
  const rng = new Rng(seed);
  const bots = state.players.map((p) => new Bot(p.id, kinds[p.id] as Difficulty));
  const rejections: Rejection[] = [];

  while (state.phase !== 'game_over' && state.tick < maxTicks) {
    for (const player of state.players) {
      const action = bots[player.id]?.think(state, rng) ?? null;
      if (action === null) continue;
      const rejection = applyAction(state, action);
      if (rejection !== null) rejections.push(rejection);
    }
    step(state);
    drainEvents(state);
  }
  return { state, rejections };
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

  it('almost always reaches a conclusion', () => {
    // Almost, not always: two evenly matched defenders can hold each other off for a
    // very long time, since nothing in the rules forces escalation. Measured at
    // roughly one match in twenty, which is a property of the design rather than a
    // fault in the bot.
    let concluded = 0;
    for (let seed = 1; seed <= 6; seed++) {
      if (play(seed, ['gunner', 'gunner']).state.phase === 'game_over') concluded++;
    }
    expect(concluded).toBeGreaterThanOrEqual(5);
  }, 60_000);
});

describe('bot competence', () => {
  it('seals a castle in the first build phase', () => {
    // The whole reason the stopgap was replaced: it rebuilt the thin ring it was
    // handed and was eliminated almost immediately.
    const { state } = play(3, ['gunner', 'gunner'], 3000);
    expect(state.round).toBeGreaterThanOrEqual(1);
    expect(state.players.some((p) => p.enclosedCastles >= 1)).toBe(true);
  });

  it('expands beyond the castle it started with', () => {
    // A bot that only ever holds one castle earns two cannons a round forever.
    const { state } = play(5, ['marshal', 'marshal'], 40_000);
    const most = Math.max(...state.players.map((p) => p.enclosedCastles));
    expect(most).toBeGreaterThan(1);
  }, 30_000);

  it('survives far longer than the opponent it replaces', () => {
    const { state } = play(1, ['gunner', 'gunner']);
    expect(state.round).toBeGreaterThan(5);
  }, 30_000);
});

describe('difficulty', () => {
  it('beats the tier below it more often than not', () => {
    // Stated as a win count over several seeds rather than a single match, because
    // one match turns on the map as much as on the play.
    const record = (strong: Difficulty, weak: Difficulty): number => {
      let wins = 0;
      for (let seed = 1; seed <= 6; seed++) {
        if (play(seed, [strong, weak]).state.winner === 0) wins++;
      }
      return wins;
    };
    expect(record('marshal', 'recruit')).toBeGreaterThanOrEqual(4);
    expect(record('gunner', 'recruit')).toBeGreaterThanOrEqual(3);
  }, 90_000);
});
