import type { MatchState } from '@rampart/sim';
import { describe, expect, it } from 'vitest';

import { bannersFor, type LifeLost } from './banners.js';

/** Only the fields the banners read. */
function state(tick: number, players: unknown[], phase = 'build'): MatchState {
  return { tick, phase, players } as unknown as MatchState;
}

const alive = (id: number, name: string) => ({ id, name, eliminated: false });
const knockedOut = (id: number, name: string) => ({ id, name, eliminated: true });

describe('island banners', () => {
  it('says nothing when nothing has happened', () => {
    expect(bannersFor(state(100, [alive(0, 'Ada'), alive(1, 'Bo')]), new Map())).toEqual([]);
  });

  it('announces a life lost, and stops once it is no longer news', () => {
    const lost = new Map<number, LifeLost>([[0, { remaining: 1, untilTick: 200 }]]);
    expect(bannersFor(state(150, [alive(0, 'Ada')]), lost)).toEqual([
      { player: 0, text: 'Ada lost a life — 1 life left', eliminated: false },
    ]);
    // The window is half-open: at untilTick it has already gone.
    expect(bannersFor(state(200, [alive(0, 'Ada')]), lost)).toEqual([]);
  });

  it('counts remaining lives in words a player can read', () => {
    const two = new Map<number, LifeLost>([[0, { remaining: 2, untilTick: 200 }]]);
    expect(bannersFor(state(1, [alive(0, 'Ada')]), two)[0]?.text).toBe(
      'Ada lost a life — 2 lives left',
    );
    const none = new Map<number, LifeLost>([[0, { remaining: 0, untilTick: 200 }]]);
    expect(bannersFor(state(1, [alive(0, 'Ada')]), none)[0]?.text).toBe(
      'Ada lost a life — last life',
    );
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
    expect(bannersFor(state(99_999, [knockedOut(0, 'Ada'), alive(1, 'Bo')]), lost)).toEqual([
      { player: 0, text: 'Ada is out', eliminated: true },
    ]);
  });

  it('clears the board once the match is over', () => {
    const over = state(500, [knockedOut(0, 'Ada'), alive(1, 'Bo')], 'game_over');
    expect(bannersFor(over, new Map())).toEqual([]);
  });
});
