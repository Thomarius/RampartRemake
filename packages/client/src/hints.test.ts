import { applyEnclosure, computeEnclosure, stateFromAscii } from '@rampart/sim';
import { describe, expect, it } from 'vitest';

import { MAX_LEAK_CELLS, buildHints } from './hints.js';

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
  it('points at the gap and the castle behind it', () => {
    const state = building(BREACHED);
    const hints = buildHints(state, 0, computeEnclosure(state));
    expect(hints.leak).toEqual([2 * state.width + 5]);
    expect(hints.unsealed).toHaveLength(1);
  });

  it('draws the whole of a gap, corners included', () => {
    // The north-east corner and a block either side of it are gone. The corner touches
    // no standing wall, only the other two missing blocks — and it is still needed,
    // since the escape is 8-connected and slips through it diagonally.
    const state = building(`
      ............
      .,,,,,,,,,,.
      .,######,,,.
      .,#,,,,,,,,.
      .,#,,@@,,#,.
      .,#,,@@,,#,.
      .,#,,,,,,#,.
      .,########,.
      .,,,,,,,,,,.
      ............
    `);
    const at = (x: number, y: number): number => y * state.width + x;
    const hints = buildHints(state, 0, computeEnclosure(state));
    expect([...hints.leak].sort((a, b) => a - b)).toEqual([at(8, 2), at(9, 2), at(9, 3)]);
  });

  it('says nothing once a castle is sealed', () => {
    const state = building(BREACHED.replace('.,###,####,.', '.,########,.'));
    expect(buildHints(state, 0, computeEnclosure(state))).toEqual({ leak: [], unsealed: [] });
  });

  it('says nothing outside the build phase', () => {
    const state = building(BREACHED);
    state.phase = 'combat';
    expect(buildHints(state, 0, computeEnclosure(state)).leak).toEqual([]);
  });

  it('marks the castle but does not draw a whole wall for the player', () => {
    // No wall at all: sealing needs far more than a gap's worth of blocks.
    const state = building(BREACHED.replace(/#/g, ','));
    const hints = buildHints(state, 0, computeEnclosure(state));
    expect(hints.unsealed).toHaveLength(1);
    expect(hints.leak).toEqual([]);
    expect(MAX_LEAK_CELLS).toBeLessThan(20);
  });
});
