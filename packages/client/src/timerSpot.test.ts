import { createMatch, stateFromAscii } from '@rampart/sim';
import { defaultRuleset, defaultTerrainConfig } from '@rampart/config';
import { describe, expect, it } from 'vitest';

import { timerSpot } from './timerSpot.js';

describe('where the big timer goes', () => {
  it('takes the open water nearest the middle, not a square that overlaps land', () => {
    // Land down the middle column pushes the square to one side of it.
    const state = stateFromAscii(`
      ...........
      ...........
      ...........
      .....,.....
      .....,.....
      .....,.....
      ...........
      ...........
      ...........
    `);
    const spot = timerSpot(state)!;
    expect(spot.size).toBeGreaterThanOrEqual(3);
    const x0 = spot.x - spot.size / 2;
    const y0 = spot.y - spot.size / 2;
    for (let y = y0; y < y0 + spot.size; y++) {
      for (let x = x0; x < x0 + spot.size; x++) expect(state.terrain[y * state.width + x]).toBe(0);
    }
  });

  it('finds somewhere on every map the game can make', () => {
    for (let players = 2; players <= 8; players++) {
      const state = createMatch({
        seed: 1,
        ruleset: defaultRuleset,
        terrainConfig: defaultTerrainConfig,
        players: Array.from({ length: players }, (_, i) => ({ name: `${i}`, isBot: true })),
      });
      expect(timerSpot(state), `${players} players`).not.toBeNull();
    }
  });
});
