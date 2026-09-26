import { applyEnclosure, computeEnclosure, stateFromAscii } from '@rampart/sim';
import { describe, expect, it } from 'vitest';

import { buildHints } from './hints.js';

/** A ring around a castle with one block missing mid-edge, on the north side. */
const BREACHED = `
  ............
  .,,,,,,,,,,.
  .,###,####,.
  .,#,,,,,,#,.
  .,#,,@@,,#,.
  .,#,,@@,,#,.
  .,#,,,,,,#,.
  .,########,.
  .,,,,,,,,,,.
  ............
`;

function building(art: string) {
  const state = stateFromAscii(art);
  applyEnclosure(state);
  state.phase = 'build';
  return state;
}

describe('build hints', () => {
  it('outlines the castles of a player with nothing sealed', () => {
    const state = building(BREACHED);
    expect(buildHints(state, 0, computeEnclosure(state)).unsealed).toHaveLength(1);
  });

  it('says nothing once a castle is sealed', () => {
    const state = building(BREACHED.replace('.,###,####,.', '.,########,.'));
    expect(buildHints(state, 0, computeEnclosure(state))).toEqual({ unsealed: [] });
  });

  it('says nothing outside the build phase', () => {
    const state = building(BREACHED);
    state.phase = 'combat';
    expect(buildHints(state, 0, computeEnclosure(state)).unsealed).toEqual([]);
  });
});
