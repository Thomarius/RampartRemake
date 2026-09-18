import { defaultRuleset, defaultTerrainConfig } from '@rampart/config';
import {
  Structure,
  applyAction,
  beginMatch,
  computeEnclosure,
  createMatch,
  stateFromAscii,
  type MatchState,
} from '@rampart/sim';
import { describe, expect, it } from 'vitest';

import { bestSealPlan, planSeal, weakestWall } from './tactics.js';

/** Builds every tile of a plan, as a bot eventually would. */
function buildPlan(state: MatchState, tiles: readonly number[], islandId = 1): void {
  for (const i of tiles) {
    state.structure[i] = Structure.Wall;
    state.owner[i] = islandId;
  }
}

describe('sealing plan', () => {
  it('finds a wall for an open castle, and the wall works', () => {
    const state = stateFromAscii(`
      ..........
      ..,,,,,,..
      ..,,,,,,..
      ..,,@@,,..
      ..,,@@,,..
      ..,,,,,,..
      ..,,,,,,..
      ..........
    `);
    const plan = planSeal(state, 0, state.castles);
    expect(plan).not.toBeNull();
    expect(plan!.cost).toBeGreaterThan(0);
    expect(computeEnclosure(state).castleEnclosed[0]).toBe(false);

    buildPlan(state, plan!.tiles);
    expect(computeEnclosure(state).castleEnclosed[0]).toBe(true);
  });

  it('costs nothing when the castle is already sealed', () => {
    const state = stateFromAscii(`
      ..........
      ..######..
      ..#,,,,#..
      ..#,@@,#..
      ..#,@@,#..
      ..#,,,,#..
      ..######..
      ..........
    `);
    const plan = planSeal(state, 0, state.castles);
    expect(plan?.cost).toBe(0);
    expect(plan?.tiles).toEqual([]);
  });

  it('reuses the wall that is already standing', () => {
    // Three sides are built, so the plan should be about the length of the fourth
    // rather than a whole new ring.
    const state = stateFromAscii(`
      ..........
      ..######..
      ..#,,,,#..
      ..#,@@,#..
      ..#,@@,#..
      ..#,,,,#..
      ..,,,,,,..
      ..........
    `);
    const plan = planSeal(state, 0, state.castles);
    expect(plan).not.toBeNull();
    expect(plan!.cost).toBeLessThanOrEqual(8);
    buildPlan(state, plan!.tiles);
    expect(computeEnclosure(state).castleEnclosed[0]).toBe(true);
  });

  it('gives up when a castle cannot be walled off at all', () => {
    // The castle sits on the shore, so the sea reaches it across tiles nobody can
    // build on. No wall exists that would work.
    const state = stateFromAscii(`
      .....
      .,@@.
      .,@@.
      .....
    `);
    const plan = planSeal(state, 0, state.castles);
    expect(plan).toBeNull();
  });

  it('routes around a tile it has been told it cannot use', () => {
    const state = stateFromAscii(`
      ..........
      ..,,,,,,..
      ..,,,,,,..
      ..,,@@,,..
      ..,,@@,,..
      ..,,,,,,..
      ..,,,,,,..
      ..........
    `);
    const first = planSeal(state, 0, state.castles)!;
    const forbidden = new Set([first.tiles[0] as number]);
    const second = planSeal(state, 0, state.castles, forbidden)!;

    expect(second.tiles).not.toContain(first.tiles[0]);
    buildPlan(state, second.tiles);
    expect(computeEnclosure(state).castleEnclosed[0]).toBe(true);
  });

  it('will take a longer wall when it brings in another castle', () => {
    const state = createMatch({
      seed: 3,
      ruleset: defaultRuleset,
      terrainConfig: defaultTerrainConfig,
      players: [
        { name: 'a', isBot: true },
        { name: 'b', isBot: true },
      ],
    });
    const modest = bestSealPlan(state, 0, 1)!;
    const ambitious = bestSealPlan(state, 0, 3)!;
    expect(modest.castleIds).toHaveLength(1);
    expect(ambitious.castleIds.length).toBeGreaterThanOrEqual(modest.castleIds.length);
    expect(ambitious.cost).toBeGreaterThanOrEqual(modest.cost);
  });

  it('produces a plan that actually encloses, on a generated map', () => {
    const state = beginMatch(
      createMatch({
        seed: 11,
        ruleset: defaultRuleset,
        terrainConfig: defaultTerrainConfig,
        players: [
          { name: 'a', isBot: true },
          { name: 'b', isBot: true },
        ],
      }),
    );
    const castle = state.castles.find((c) => c.islandId === 1)!;
    applyAction(state, { kind: 'select_castle', player: 0, castleId: castle.id });

    // Knock the ring apart, then check the plan puts it back together.
    for (let i = 0; i < state.structure.length; i++) {
      if (state.structure[i] === Structure.Wall && state.owner[i] === 1 && i % 3 === 0) {
        state.structure[i] = Structure.Empty;
      }
    }
    expect(computeEnclosure(state).enclosedCastlesByPlayer[0]).toBe(0);

    const plan = bestSealPlan(state, 0, 1)!;
    expect(plan.cost).toBeGreaterThan(0);
    buildPlan(state, plan.tiles);
    expect(computeEnclosure(state).enclosedCastlesByPlayer[0]).toBeGreaterThanOrEqual(1);
  });
});

describe('finding the weak point', () => {
  it('picks the thin side of a wall, not the thick one', () => {
    // Left side is one block thick, right side is three. The cheapest way in is left.
    const state = stateFromAscii(`
      ..............
      ..#########...
      ..#,,,,,,###..
      ..#,@@,,,###..
      ..#,@@,,,###..
      ..#,,,,,,###..
      ..#########...
      ..............
    `);
    state.castles[0]!.enclosed = true;
    const path = weakestWall(state, 0);
    expect(path.length).toBeGreaterThan(0);
    // Every tile it names is a wall, and the cheapest breach is a single block.
    for (const i of path) expect(state.structure[i]).toBe(Structure.Wall);
    expect(path.length).toBeLessThanOrEqual(3);
  });

  it('names nothing when the target holds no sealed castle', () => {
    const state = stateFromAscii(`
      ........
      ..,@@,..
      ..,@@,..
      ........
    `);
    expect(weakestWall(state, 0)).toEqual([]);
  });
});
