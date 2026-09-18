import { describe, expect, it } from 'vitest';

import { computeEnclosure } from './enclosure.js';
import { stateFromAscii } from './testing.js';

describe('enclosure solver', () => {
  it('seals a castle inside a complete wall loop', () => {
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
    const result = computeEnclosure(state);
    expect(result.castleEnclosed[0]).toBe(true);
    expect(result.enclosedCastlesByPlayer[0]).toBe(1);
  });

  it('leaks through a single missing block', () => {
    const state = stateFromAscii(`
      ..........
      ..######..
      ..#,,,,#..
      ..#,@@,#..
      ..#,@@,#..
      ..#,,,,#..
      ..###,##..
      ..........
    `);
    expect(computeEnclosure(state).castleEnclosed[0]).toBe(false);
  });

  it('leaks through a diagonal join, so a wall must turn its corners', () => {
    // Two blocks meeting at a point do not seal: the escape flood is 8-connected
    // while the wall is not, so the sea slips between them. The corner block has
    // to be there.
    const state = stateFromAscii(`
      ..........
      ...####...
      ..#,,,,#..
      ..#,@@,#..
      ..#,@@,#..
      ..#,,,,#..
      ...####...
      ..........
    `);
    expect(computeEnclosure(state).castleEnclosed[0]).toBe(false);
  });

  it('seals once the corner blocks are added', () => {
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
    expect(computeEnclosure(state).castleEnclosed[0]).toBe(true);
  });

  it('does not let a diagonal staircase stand in for a wall', () => {
    const state = stateFromAscii(`
      ............
      ....#####...
      ...#,,,,#...
      ..#,,@@,,#..
      .#,,,@@,,,#.
      .#,,,,,,,,#.
      .##########.
      ............
    `);
    expect(computeEnclosure(state).castleEnclosed[0]).toBe(false);
  });

  it('does not let the coastline stand in for a wall', () => {
    // The castle is walled on three sides and open to the sea on the fourth.
    // Water is traversable by the escape flood, so this is a breach.
    const state = stateFromAscii(`
      ..........
      ..######..
      ..#,,,,#..
      ..#,@@,#..
      ..#,@@,#..
      ..#,,,,#..
      ..........
      ..........
    `);
    expect(computeEnclosure(state).castleEnclosed[0]).toBe(false);
  });

  it('counts every castle inside one shared loop', () => {
    const state = stateFromAscii(`
      ..............
      ..##########..
      ..#,,,,,,,,#..
      ..#,@@,,@@,#..
      ..#,@@,,@@,#..
      ..#,,,,,,,,#..
      ..##########..
      ..............
    `);
    const result = computeEnclosure(state);
    expect(result.castleEnclosed).toEqual([true, true]);
    expect(result.enclosedCastlesByPlayer[0]).toBe(2);
  });

  it('counts castles in separate loops independently', () => {
    const state = stateFromAscii(`
      ...............
      ..####,,####...
      ..#@@#,,#@@#...
      ..#@@#,,#@@#...
      ..####,,####...
      ...............
    `);
    const result = computeEnclosure(state);
    expect(result.castleEnclosed).toEqual([true, true]);
    expect(result.enclosedCastlesByPlayer[0]).toBe(2);
  });

  it('keeps a breached loop from counting while an intact one still does', () => {
    const state = stateFromAscii(`
      ...............
      ..####,,####...
      ..#@@#,,#@@#...
      ..#@@#,,#@@#...
      ..##,#,,####...
      ...............
    `);
    const result = computeEnclosure(state);
    expect(result.castleEnclosed[0]).toBe(false);
    expect(result.castleEnclosed[1]).toBe(true);
    expect(result.enclosedCastlesByPlayer[0]).toBe(1);
  });

  it('does not let a cannon plug a gap in the wall', () => {
    // A cannon sits exactly where a wall block is missing. Only walls block the
    // flood, so the loop is still open.
    const state = stateFromAscii(`
      ..........
      ..######..
      ..#,,,,#..
      ..#,@@,#..
      ..#,@@,#..
      ..#,,,,#..
      ..###**#..
      ..........
    `);
    expect(computeEnclosure(state).castleEnclosed[0]).toBe(false);
  });

  it('refuses territory to a sealed pocket with no castle in it', () => {
    // Otherwise a player could wall off a bare 2x2 and own a cannon that can
    // never be silenced, no matter what happens to their castles.
    const state = stateFromAscii(`
      ..............
      ..######......
      ..#,@@#.####..
      ..#,@@#.#**#..
      ..#,,,#.#**#..
      ..#####.####..
      ..............
    `);
    const result = computeEnclosure(state);
    expect(result.castleEnclosed[0]).toBe(true);
    expect(result.cannonActive[0]).toBe(false);
  });

  it('activates a cannon sharing its region with a castle', () => {
    const state = stateFromAscii(`
      ..............
      ..##########..
      ..#,@@,,**,#..
      ..#,@@,,**,#..
      ..#,,,,,,,,#..
      ..##########..
      ..............
    `);
    const result = computeEnclosure(state);
    expect(result.cannonActive[0]).toBe(true);
    expect(result.territory[2 * 14 + 8]).toBe(1);
  });

  it('silences a cannon when its wall is breached, without destroying it', () => {
    const sealed = stateFromAscii(`
      ..............
      ..##########..
      ..#,@@,,**,#..
      ..#,@@,,**,#..
      ..#,,,,,,,,#..
      ..##########..
      ..............
    `);
    const breached = stateFromAscii(`
      ..............
      ..##########..
      ..#,@@,,**,#..
      ..#,@@,,**,#..
      ..#,,,,,,,,#..
      ..####,#####..
      ..............
    `);
    expect(computeEnclosure(sealed).cannonActive[0]).toBe(true);
    expect(computeEnclosure(breached).cannonActive[0]).toBe(false);
    // The cannon itself is untouched — re-enclosing brings it back.
    expect(breached.cannons).toHaveLength(1);
  });

  it('resolves each island independently', () => {
    const state = stateFromAscii(`
      ...................
      ..#####...#####....
      ..#,@@#...#2@@2#...
      ..#,@@#...#2@@2#...
      ..#####...#2,,2#...
      ...................
    `);
    const result = computeEnclosure(state);
    // Island 1 is sealed; island 2's "walls" are plain land, so it is wide open.
    expect(result.enclosedCastlesByPlayer[0]).toBe(1);
    expect(result.enclosedCastlesByPlayer[1]).toBe(0);
  });
});
