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

  it('unravels a dead end all the way back', () => {
    // Removing the tip strands the next block, which strands the next: the rule has
    // to repeat until nothing more falls.
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
    for (let x = 8; x <= 10; x++) {
      expect({ x, kind: state.structure[5 * 12 + x] }).toEqual({ x, kind: Structure.Empty });
    }
    // The loop's own edge, which the spur grew out of, is untouched.
    expect(state.structure[5 * 12 + 7]).toBe(Structure.Wall);
    expect(applyEnclosure(state).castleEnclosed[0]).toBe(true);
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

  it('sweeps a loop that encloses nothing', () => {
    // Survives the loose-end rule, but reaches no sealed ground, so it still goes.
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
    for (let y = 2; y <= 4; y++) {
      for (let x = 8; x <= 10; x++) {
        expect({ x, y, kind: state.structure[y * 14 + x] }).toEqual({
          x,
          y,
          kind: Structure.Empty,
        });
      }
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
