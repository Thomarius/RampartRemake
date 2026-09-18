import { defaultRuleset } from '@rampart/config';
import { describe, expect, it } from 'vitest';

import { craterOffsets, findReadyCannon, fire, flightTicks, resolveImpacts } from './shots.js';
import { stateFromAscii } from './testing.js';
import { Structure } from './types.js';

/** A near cannon, a far cannon, and a wall block to shoot at. */
const RANGE = `
  ....................
  ..**............##..
  ..**............##..
  ....................
  ....................
  ..**................
  ..**................
  ....................
`;

describe('flight time', () => {
  it('grows with distance', () => {
    const state = stateFromAscii(RANGE);
    const near = flightTicks(state, 0, 0, 5, 0);
    const far = flightTicks(state, 0, 0, 30, 0);
    expect(far).toBeGreaterThan(near);
  });

  it('is never zero, so a shot always takes at least one tick', () => {
    const state = stateFromAscii(RANGE);
    expect(flightTicks(state, 4, 4, 4, 4)).toBeGreaterThanOrEqual(1);
  });

  it('matches the configured base and per-tile cost', () => {
    const state = stateFromAscii(RANGE);
    const { baseFlightMs, perTileFlightMs } = defaultRuleset.shots;
    // A 3-4-5 triangle gives an exact distance of 5 tiles.
    const expected = Math.ceil(
      ((baseFlightMs + perTileFlightMs * 5) * defaultRuleset.tickRateHz) / 1000,
    );
    expect(flightTicks(state, 0, 0, 3, 4)).toBe(expected);
  });
});

describe('cannon selection', () => {
  it('picks the nearest ready cannon', () => {
    const state = stateFromAscii(RANGE);
    expect(state.cannons).toHaveLength(2);
    const chosen = findReadyCannon(state, 0, 16, 1);
    expect(chosen?.y).toBe(1); // the upper cannon is closer to the wall
  });

  it('falls through to a further cannon while the nearest is reloading', () => {
    const state = stateFromAscii(RANGE);
    const first = fire(state, 0, 16, 1);
    expect('shot' in first).toBe(true);
    const second = findReadyCannon(state, 0, 16, 1);
    expect(second?.y).toBe(5);
  });

  it('refuses to fire when every cannon has a shot in the air', () => {
    const state = stateFromAscii(RANGE);
    expect('shot' in fire(state, 0, 16, 1)).toBe(true);
    expect('shot' in fire(state, 0, 16, 1)).toBe(true);
    expect(fire(state, 0, 16, 1)).toEqual({ rejection: 'no_ready_cannon' });
  });

  it('will not fire an inactive cannon', () => {
    const state = stateFromAscii(RANGE);
    for (const cannon of state.cannons) cannon.active = false;
    expect(fire(state, 0, 16, 1)).toEqual({ rejection: 'no_ready_cannon' });
  });
});

describe('firing rules', () => {
  it('only works during combat', () => {
    const state = stateFromAscii(RANGE);
    state.phase = 'build';
    expect(fire(state, 0, 16, 1)).toEqual({ rejection: 'wrong_phase' });
  });

  it('rejects a target off the map', () => {
    const state = stateFromAscii(RANGE);
    expect(fire(state, 0, -1, 1)).toEqual({ rejection: 'out_of_bounds' });
    expect(fire(state, 0, 999, 1)).toEqual({ rejection: 'out_of_bounds' });
  });

  it('rejects an eliminated player', () => {
    const state = stateFromAscii(RANGE);
    state.players[0]!.eliminated = true;
    expect(fire(state, 0, 16, 1)).toEqual({ rejection: 'eliminated' });
  });
});

describe('impact', () => {
  /** Fires at a target and fast-forwards to the moment the shot lands. */
  function fireAndLand(state: ReturnType<typeof stateFromAscii>, x: number, y: number) {
    const result = fire(state, 0, x, y);
    if (!('shot' in result)) throw new Error(`fire rejected: ${result.rejection}`);
    state.tick = result.shot.impactTick;
    resolveImpacts(state);
    return result.shot;
  }

  it('clears walls in the configured crater pattern', () => {
    const state = stateFromAscii(RANGE);
    const shot = fireAndLand(state, 16, 1);
    expect(state.structure[1 * state.width + 16]).toBe(Structure.Empty);
    expect(state.structure[1 * state.width + 17]).toBe(Structure.Empty); // orthogonal
    expect(state.structure[2 * state.width + 17]).toBe(Structure.Wall); // diagonal survives
    const impact = state.events.find((e) => e.kind === 'shot_impact');
    expect(impact).toBeDefined();
    expect(shot.impactTick).toBe(state.tick);
  });

  it('frees the cannon that fired it', () => {
    const state = stateFromAscii(RANGE);
    const shot = fireAndLand(state, 16, 1);
    const cannon = state.cannons.find((c) => c.id === shot.cannonId);
    expect(cannon?.shotId).toBeNull();
    expect(state.shots).toHaveLength(0);
  });

  it('leaves castles and cannons standing', () => {
    // Walls are the only thing artillery can take away; a breach is all it can achieve.
    const state = stateFromAscii(`
      ..........
      ..**......
      ..**......
      ..........
      ....@@....
      ....@@....
      ..........
    `);
    const castleTiles = [4 * 10 + 4, 4 * 10 + 5, 5 * 10 + 4, 5 * 10 + 5];
    fireAndLand(state, 4, 4);
    for (const i of castleTiles) expect(state.structure[i]).toBe(Structure.Castle);

    fireAndLand(state, 2, 1);
    expect(state.structure[1 * 10 + 2]).toBe(Structure.Cannon);
    expect(state.cannons).toHaveLength(1);
  });

  it('does not land early', () => {
    const state = stateFromAscii(RANGE);
    const result = fire(state, 0, 16, 1);
    if (!('shot' in result)) throw new Error('fire rejected');
    state.tick = result.shot.impactTick - 1;
    resolveImpacts(state);
    expect(state.structure[1 * state.width + 16]).toBe(Structure.Wall);
    expect(state.shots).toHaveLength(1);
  });
});

describe('crater patterns', () => {
  it('has the expected footprint for each pattern', () => {
    expect(craterOffsets('single')).toHaveLength(1);
    expect(craterOffsets('plus5')).toHaveLength(5);
    expect(craterOffsets('square9')).toHaveLength(9);
  });

  it('always includes the tile that was aimed at', () => {
    for (const pattern of ['single', 'plus5', 'square9'] as const) {
      expect(craterOffsets(pattern)).toContainEqual([0, 0]);
    }
  });
});
