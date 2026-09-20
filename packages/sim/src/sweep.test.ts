import { describe, expect, it } from 'vitest';

import { applyEnclosure } from './enclosure.js';
import { sweepOrphanedWalls } from './sweep.js';
import { renderAscii } from './debug.js';
import { stateFromAscii } from './testing.js';
import { Structure, type MatchState } from './types.js';

/** Sweeps with territory already solved, as it happens at a round resolution. */
function sweep(art: string): MatchState {
  const state = stateFromAscii(art);
  applyEnclosure(state);
  sweepOrphanedWalls(state);
  return state;
}

function walls(state: MatchState): number {
  return state.structure.filter((v) => v === Structure.Wall).length;
}

describe('sweeping orphaned wall', () => {
  it('leaves a working loop completely alone', () => {
    // A loop that encloses something is safe by construction: every block of it has
    // two orthogonal neighbours and touches the ground it encloses.
    const before = stateFromAscii(`
      ..........
      ..######..
      ..#,,,,#..
      ..#,@@,#..
      ..#,@@,#..
      ..#,,,,#..
      ..######..
      ..........
    `);
    applyEnclosure(before);
    const kept = walls(before);

    const after = sweep(`
      ..........
      ..######..
      ..#,,,,#..
      ..#,@@,#..
      ..#,@@,#..
      ..#,,,,#..
      ..######..
      ..........
    `);
    expect(walls(after)).toBe(kept);
    expect(applyEnclosure(after).castleEnclosed[0]).toBe(true);
  });

  it('takes a stray block standing on its own', () => {
    const state = sweep(`
      ..........
      ..######..
      ..#,,,,#..
      ..#,@@,#..
      ..#,@@,#..
      ..#,,,,#..
      ..######..
      ..#.......
    `);
    expect(state.structure[7 * 10 + 2]).toBe(Structure.Empty);
  });

  it('takes only the tip of a dead end, not the whole spur', () => {
    // The rule runs once. Removing the tip does not then condemn the block behind it,
    // because every block was judged against the board as it stood. Cascading here is
    // what made the old sweep take too much: a spur half-built towards another castle
    // vanished entirely, so work could never be carried across a round.
    const state = sweep(`
      ............
      ..######....
      ..#,,,,#....
      ..#,@@,#....
      ..#,@@,#....
      ..#,,,,####.
      ..######....
      ............
    `);
    // Only the far end goes: it alone had a single neighbour.
    expect(state.structure[5 * 12 + 10]).toBe(Structure.Empty);
    for (let x = 7; x <= 9; x++) {
      expect({ x, kind: state.structure[5 * 12 + x] }).toEqual({ x, kind: Structure.Wall });
    }
    expect(applyEnclosure(state).castleEnclosed[0]).toBe(true);
  });

  it('reduces a run of three to its middle block', () => {
    // Both ends have only the middle for company and go together. The middle survives
    // even though it is left standing alone — it had two neighbours when the question
    // was asked. Next round it has none, and then it goes.
    const state = sweep(`
      .......
      .......
      .###...
      .......
    `);
    expect(state.structure[2 * 7 + 1]).toBe(Structure.Empty);
    expect(state.structure[2 * 7 + 2]).toBe(Structure.Wall);
    expect(state.structure[2 * 7 + 3]).toBe(Structure.Empty);
  });

  it('clears a block dropped inside your own ground', () => {
    // This is the one that matters for cannons: a block sitting in the middle of
    // sealed territory is eating the space a 2x2 gun needs, and it is not holding
    // anything up.
    const state = sweep(`
      ..........
      ..######..
      ..#,,,,#..
      ..#,@@,#..
      ..#,@@,#..
      ..#,#,,#..
      ..######..
      ..........
    `);
    expect(state.structure[5 * 10 + 4]).toBe(Structure.Empty);
    expect(applyEnclosure(state).castleEnclosed[0]).toBe(true);
  });

  it('keeps a wall deliberately built two thick', () => {
    // A second layer is connected to the first at both ends, so it survives: it is
    // an investment, not litter.
    const state = sweep(`
      ............
      ..########..
      ..########..
      ..##,,,,##..
      ..##,@@,##..
      ..##,@@,##..
      ..########..
      ............
    `);
    expect(walls(state)).toBeGreaterThan(30);
    expect(applyEnclosure(state).castleEnclosed[0]).toBe(true);
  });

  it('leaves a loop that encloses nothing standing, as an obstacle', () => {
    // Nothing requires a wall to reach sealed ground. Stranded wall is not litter: it
    // stands where a cannon cannot go and where a future wall has to route around, and
    // the original kept it too.
    const state = sweep(`
      ..............
      ..######......
      ..#,@@#.###...
      ..#,@@#.#,#...
      ..#,,,#.###...
      ..#####.......
      ..............
    `);
    expect(applyEnclosure(state).castleEnclosed[0]).toBe(true);
    for (const [x, y] of [
      [8, 2],
      [9, 2],
      [10, 2],
      [8, 3],
      [10, 3],
      [8, 4],
      [9, 4],
      [10, 4],
    ]) {
      expect({ x, y, kind: state.structure[(y as number) * 14 + (x as number)] }).toEqual({
        x,
        y,
        kind: Structure.Wall,
      });
    }
  });

  it('never takes a wall that is holding an enclosure together', () => {
    // The property that makes this safe to run automatically: whatever it removes,
    // every castle that was enclosed still is.
    const art = `
      ...............
      ..#####..###...
      ..#,@@#.##,##..
      ..#,@@#..###...
      ..#####...#....
      ...............
    `;
    const before = stateFromAscii(art);
    const enclosedBefore = applyEnclosure(before).enclosedCastlesByPlayer[0];
    const after = sweep(art);
    expect(applyEnclosure(after).enclosedCastlesByPlayer[0]).toBe(enclosedBefore);
  });

  it('reports what it removed, so the board can be redrawn', () => {
    const state = stateFromAscii(`
      ..........
      ..######..
      ..#,,,,#..
      ..#,@@,#..
      ..#,@@,#..
      ..#,,,,#..
      ..######..
      ..#.#.#...
    `);
    applyEnclosure(state);
    const removed = sweepOrphanedWalls(state);
    expect(removed).toHaveLength(3);
    for (const i of removed) expect(state.structure[i]).toBe(Structure.Empty);
    expect(renderAscii(state)).not.toContain('#.#.#');
  });
});
