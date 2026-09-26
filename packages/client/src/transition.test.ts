import { defaultRuleset } from '@rampart/config';
import {
  Structure,
  renderAscii,
  stateFromAscii,
  sweepOrphanedWalls,
  ticksFor,
  type MatchState,
  type Phase,
} from '@rampart/sim';
import { describe, expect, it } from 'vitest';

import {
  bannerProgress,
  boardWithStanding,
  looksAround,
  lookOf,
  stillStanding,
  type SweptWall,
} from './transition.js';

const BANNER = ticksFor(defaultRuleset.phases.transitionBannerMs, defaultRuleset.tickRateHz);

/** Only the fields the banner reads. */
function at(
  tick: number,
  phase: Phase,
  pendingPhase: Phase | null = null,
  phaseEndTick = 1000,
): MatchState {
  return { tick, phase, pendingPhase, phaseEndTick, ruleset: defaultRuleset } as MatchState;
}

describe('which look is on screen', () => {
  it('plays combat in the combat look and everything else in the build look', () => {
    expect(lookOf('combat')).toBe('combat');
    for (const phase of ['castle_select', 'cannon_place', 'build', 'game_over'] as const) {
      expect(lookOf(phase)).toBe('build');
    }
  });

  it('swaps to the combat look on the banner before combat', () => {
    expect(looksAround(at(0, 'intermission', 'combat'))).toEqual({
      before: 'build',
      after: 'combat',
    });
  });

  it('swaps back on the banner after it', () => {
    expect(looksAround(at(0, 'intermission', 'build'))).toEqual({
      before: 'combat',
      after: 'build',
    });
  });

  it('changes nothing on the banner between building and placing cannons', () => {
    // That one carries the sweep instead.
    expect(looksAround(at(0, 'intermission', 'cannon_place'))).toEqual({
      before: 'build',
      after: 'build',
    });
    expect(looksAround(at(0, 'intermission', 'castle_select'))).toEqual({
      before: 'build',
      after: 'build',
    });
  });

  it('keeps the phase look outside an intermission', () => {
    expect(looksAround(at(0, 'combat'))).toEqual({ before: 'combat', after: 'combat' });
    expect(looksAround(at(0, 'build'))).toEqual({ before: 'build', after: 'build' });
  });
});

describe('where the banner is', () => {
  it('shows nothing outside an intermission', () => {
    expect(bannerProgress(at(995, 'build'), 0)).toBeNull();
  });

  it('waits out the pause before it enters', () => {
    expect(bannerProgress(at(1000 - BANNER - 1, 'intermission', 'combat'), 0)).toBeNull();
    expect(bannerProgress(at(1000 - BANNER - 1, 'intermission', 'combat'), 0.999)).toBeNull();
  });

  it('crosses at constant speed and leaves as the next phase begins', () => {
    expect(bannerProgress(at(1000 - BANNER, 'intermission', 'combat'), 0)).toBe(0);
    expect(bannerProgress(at(1000 - BANNER / 2, 'intermission', 'combat'), 0)).toBeCloseTo(0.5);
    expect(bannerProgress(at(1000 - 1, 'intermission', 'combat'), 1)).toBe(1);
  });

  it('moves between ticks, so it does not step down the screen', () => {
    const early = bannerProgress(at(1000 - BANNER, 'intermission', 'combat'), 0.25) as number;
    const late = bannerProgress(at(1000 - BANNER, 'intermission', 'combat'), 0.75) as number;
    expect(early).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(early);
  });
});

describe('the sweep, drawn under the banner', () => {
  // A spur off a loop loses its tip; a lone block goes; the loop stays.
  const art = `
    ...........
    .,,,,,,,,,.
    .,######,,.
    .,#,,,,#,,.
    .,#,@@,####
    .,#,@@,#,,.
    .,#,,,,#,#.
    .,######,,.
    ...........
  `;

  function swept(): { before: MatchState; after: MatchState; walls: SweptWall[] } {
    const before = stateFromAscii(art);
    const after = stateFromAscii(art);
    const walls = sweepOrphanedWalls(after).map((index) => ({
      index,
      owner: before.owner[index] as number,
    }));
    return { before, after, walls };
  }

  it('takes only what the sim swept', () => {
    const { walls } = swept();
    expect(walls.map((w) => w.index).sort((a, b) => a - b)).toEqual([4 * 11 + 10, 6 * 11 + 9]);
  });

  it('draws every swept block while the banner has not arrived', () => {
    const { before, after, walls } = swept();
    const standing = stillStanding(walls, after.width, Number.NEGATIVE_INFINITY);
    const board = boardWithStanding(after, standing);
    expect(renderAscii({ ...after, ...board })).toBe(renderAscii(before));
    expect(board.owner).toEqual(before.owner);
  });

  it('takes a row away once the line has passed its middle', () => {
    const { after, walls } = swept();
    // Row 4's block goes at 4.5; row 6's is still standing.
    expect(stillStanding(walls, after.width, 4.4).length).toBe(2);
    expect(stillStanding(walls, after.width, 4.6).map((w) => w.index)).toEqual([6 * 11 + 9]);
    expect(stillStanding(walls, after.width, 9)).toEqual([]);
  });

  it('draws the state itself once nothing is left standing', () => {
    const { after } = swept();
    const board = boardWithStanding(after, []);
    expect(board.structure).toBe(after.structure);
  });

  it('never draws a block over something that has been built since', () => {
    const { after, walls } = swept();
    const first = walls[0] as SweptWall;
    after.structure[first.index] = Structure.Cannon;
    expect(boardWithStanding(after, walls).structure[first.index]).toBe(Structure.Cannon);
  });
});
