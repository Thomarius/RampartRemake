import type { MatchState } from '@rampart/sim';
import { describe, expect, it } from 'vitest';

import {
  announcementLines,
  endOfMatchText,
  finalRoundNext,
  roundLabel,
  standings,
} from './scores.js';

interface Fields {
  players?: unknown[];
  round?: number;
  maxRounds?: number | null;
  phase?: string;
  pendingPhase?: string | null;
  winners?: number[];
  draw?: boolean;
  endedBy?: string | null;
}

/** Only the fields the score text reads. */
function state(fields: Fields): MatchState {
  return {
    players: fields.players ?? [],
    round: fields.round ?? 1,
    phase: fields.phase ?? 'build',
    pendingPhase: fields.pendingPhase ?? null,
    winners: fields.winners ?? [],
    draw: fields.draw ?? false,
    endedBy: fields.endedBy ?? null,
    ruleset: { scoring: { maxRounds: fields.maxRounds === undefined ? 10 : fields.maxRounds } },
  } as unknown as MatchState;
}

const player = (id: number, name: string, score: number, eliminated = false) => ({
  id,
  name,
  score,
  eliminated,
});

describe('standings', () => {
  it('ranks by score, but puts anyone out below everyone still in', () => {
    const s = state({
      players: [player(0, 'Ada', 50), player(1, 'Bo', 900, true), player(2, 'Cy', 120)],
    });
    expect(standings(s).map((x) => x.name)).toEqual(['Cy', 'Ada', 'Bo']);
  });

  it('breaks a tie on seat, so the order is stable', () => {
    const s = state({ players: [player(0, 'Ada', 10), player(1, 'Bo', 10)] });
    expect(standings(s).map((x) => x.name)).toEqual(['Ada', 'Bo']);
  });
});

describe('the round counter', () => {
  it('counts against the cap, and alone when there is none', () => {
    expect(roundLabel(state({ round: 3 }))).toBe('round 3 / 10');
    expect(roundLabel(state({ round: 3, maxRounds: null }))).toBe('round 3');
  });

  it('calls the final round in the intermission before it, not after', () => {
    const before = { phase: 'intermission', pendingPhase: 'combat' };
    expect(finalRoundNext(state({ ...before, round: 9 }))).toBe(true);
    expect(finalRoundNext(state({ ...before, round: 8 }))).toBe(false);
    // The intermission before the cannon phase is not the one that opens the round.
    expect(finalRoundNext(state({ ...before, pendingPhase: 'cannon_place', round: 9 }))).toBe(
      false,
    );
    expect(finalRoundNext(state({ ...before, round: 9, maxRounds: null }))).toBe(false);
  });

  it('carries the standings only after a resolution', () => {
    const s = state({ players: [player(0, 'Ada', 12), player(1, 'Bo', 30, true)] });
    expect(announcementLines(s, true)).toEqual([{ text: 'Ada 12 · Bo 30 (out)', emphasis: false }]);
    expect(announcementLines(s, false)).toEqual([]);
  });
});

describe('the end of a match', () => {
  const players = [player(0, 'Ada', 40), player(1, 'Bo', 40), player(2, 'Cy', 10)];

  it('says a draw is a draw', () => {
    expect(endOfMatchText(state({ players, draw: true, endedBy: 'elimination' }), 0)).toBe(
      'Draw — nobody held a castle',
    );
  });

  it('says whether the win came on points', () => {
    const lastStanding = state({ players, winners: [2], endedBy: 'elimination' });
    expect(endOfMatchText(lastStanding, 2)).toBe('You win');
    expect(endOfMatchText(lastStanding, 0)).toBe('Cy wins');
    const onPoints = state({ players, winners: [2], endedBy: 'round_cap' });
    expect(endOfMatchText(onPoints, 0)).toBe('Cy wins on points');
  });

  it('calls a tie at the top a shared win, not a draw', () => {
    const shared = state({ players, winners: [0, 1], endedBy: 'round_cap' });
    expect(endOfMatchText(shared, 1)).toBe('You share the win on points');
    expect(endOfMatchText(shared, 2)).toBe('Ada and Bo share the win on points');
    expect(endOfMatchText(shared, -1)).toBe('Ada and Bo share the win on points');
  });
});
