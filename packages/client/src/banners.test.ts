import type { MatchState } from '@rampart/sim';
import { describe, expect, it } from 'vitest';

import { bannersFor, type LifeLost } from './banners.js';

/** Only the fields the banners read. */
function state(tick: number, players: unknown[], phase = 'build'): MatchState {
  return { tick, phase, players } as unknown as MatchState;
}

const alive = (id: number, name: string) => ({ id, name, eliminated: false, team: id });
const knockedOut = (id: number, name: string) => ({ id, name, eliminated: true, team: id });

describe('island banners', () => {
  it('says nothing when nothing has happened', () => {
    expect(bannersFor(state(100, [alive(0, 'Ada'), alive(1, 'Bo')]), new Map())).toEqual([]);
  });

  it('announces a life lost, and stops once it is no longer news', () => {
    const lost = new Map<number, LifeLost>([[0, { remaining: 1, untilTick: 200 }]]);
    expect(bannersFor(state(150, [alive(0, 'Ada')]), lost)).toEqual([
      {
        player: 0,
        kind: 'life',
        title: 'Life lost',
        detail: 'Ada — 1 life left',
        urgent: false,
      },
    ]);
    // The window is half-open: at untilTick it has already gone.
    expect(bannersFor(state(200, [alive(0, 'Ada')]), lost)).toEqual([]);
  });

  it('counts remaining lives in words a player can read, and marks the last', () => {
    const two = new Map<number, LifeLost>([[0, { remaining: 2, untilTick: 200 }]]);
    expect(bannersFor(state(1, [alive(0, 'Ada')]), two)[0]).toMatchObject({
      detail: 'Ada — 2 lives left',
      urgent: false,
    });
    const none = new Map<number, LifeLost>([[0, { remaining: 0, untilTick: 200 }]]);
    expect(bannersFor(state(1, [alive(0, 'Ada')]), none)[0]).toMatchObject({
      detail: 'Ada — last life',
      urgent: true,
    });
  });

  it('shows every player who lost a life in the same round', () => {
    // A round can take a life from more than one player, and one pause covers them
    // all — so all of their banners have to be up together.
    const lost = new Map<number, LifeLost>([
      [0, { remaining: 1, untilTick: 200 }],
      [2, { remaining: 0, untilTick: 200 }],
    ]);
    const shown = bannersFor(state(150, [alive(0, 'Ada'), alive(1, 'Bo'), alive(2, 'Cy')]), lost);
    expect(shown.map((b) => b.player)).toEqual([0, 2]);
  });

  it('keeps an elimination up indefinitely, and prefers it to a lost life', () => {
    // No expiry: a player who is out stays marked out. And if they were knocked out on
    // the same round they last lost a life, "out" is the news that matters.
    const lost = new Map<number, LifeLost>([[0, { remaining: 0, untilTick: 200 }]]);
    const ada = { ...knockedOut(0, 'Ada'), eliminatedRound: 4 };
    expect(bannersFor(state(99_999, [ada, alive(1, 'Bo')]), lost)).toEqual([
      { player: 0, kind: 'out', title: 'Knocked out', detail: 'Ada, round 4', urgent: false },
    ]);
  });

  it('clears the board once the match is over', () => {
    const over = state(500, [knockedOut(0, 'Ada'), alive(1, 'Bo')], 'game_over');
    expect(bannersFor(over, new Map())).toEqual([]);
  });

  it('shows the points an island just banked, and gives way to a lost life', () => {
    const gained = new Map([
      [0, { amount: 48, untilTick: 200 }],
      [1, { amount: 30, untilTick: 200 }],
    ]);
    const lost = new Map<number, LifeLost>([[1, { remaining: 1, untilTick: 200 }]]);
    const ada = { ...alive(0, 'Ada'), score: 312 };
    const banners = bannersFor(state(150, [ada, alive(1, 'Bo')]), lost, gained);
    expect(banners.map((b) => [b.kind, b.title])).toEqual([
      ['gain', '+48'],
      ['life', 'Life lost'],
    ]);
    // With the total it brings them to, which is the number a player is tracking.
    expect(banners[0]?.detail).toBe('312 total');
    // Gone once it is no longer news, and never shown for nothing.
    expect(bannersFor(state(200, [alive(0, 'Ada')]), new Map(), gained)).toEqual([]);
    const none = new Map([[0, { amount: 0, untilTick: 200 }]]);
    expect(bannersFor(state(1, [alive(0, 'Ada')]), new Map(), none)).toEqual([]);
  });
});
