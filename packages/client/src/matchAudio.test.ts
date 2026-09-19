import type { MusicCue, SfxCue } from '@rampart/config';
import type { MatchEvent, MatchState, Phase } from '@rampart/sim';
import { describe, expect, it } from 'vitest';

import { MatchAudio, type Cues } from './matchAudio.js';

/** Records what was asked for, in order. */
class Recorder implements Cues {
  readonly sfx: SfxCue[] = [];
  readonly tracks: (MusicCue | null)[] = [];
  play(cue: SfxCue): void {
    this.sfx.push(cue);
  }
  music(cue: MusicCue | null): void {
    this.tracks.push(cue);
  }
}

const HUMAN = 0;

function setup(humanPlayer = HUMAN): { audio: Recorder; match: MatchAudio } {
  const audio = new Recorder();
  return { audio, match: new MatchAudio(audio, humanPlayer) };
}

function phase(next: Phase, pending: Phase | null = null): MatchEvent {
  return {
    kind: 'phase_changed',
    tick: 0,
    phase: next,
    round: 1,
    phaseEndTick: 300,
    pendingPhase: pending,
  };
}

/** Only the four fields the countdown reads. */
function clock(current: Phase, tick: number, phaseEndTick: number): MatchState {
  return {
    phase: current,
    tick,
    phaseEndTick,
    ruleset: { tickRateHz: 30 },
  } as unknown as MatchState;
}

describe('match audio', () => {
  it('calls the barrage in and out', () => {
    const { audio, match } = setup();
    match.handle([phase('combat')]);
    expect(audio.sfx).toEqual(['voice_fire']);

    // Combat ends by stepping into the intermission: shots in the air still land, but
    // no further one can be started, which is what "cease fire" means.
    match.handle([phase('intermission', 'build')]);
    expect(audio.sfx).toEqual(['voice_fire', 'voice_cease_fire']);
  });

  it('does not call cease fire when an intermission follows anything else', () => {
    const { audio, match } = setup();
    match.handle([phase('build'), phase('intermission', 'cannon_place')]);
    expect(audio.sfx).not.toContain('voice_cease_fire');
  });

  it('starts the next phase’s music during the intermission before it', () => {
    const { audio, match } = setup();
    // The music leads into the announcement rather than arriving after it.
    match.handle([phase('build'), phase('intermission', 'combat')]);
    expect(audio.tracks).toEqual(['music_admin', 'music_battle']);
  });

  it('shares one track across the phases that feel the same', () => {
    const { audio, match } = setup();
    match.handle([phase('castle_select'), phase('cannon_place'), phase('build')]);
    expect(audio.tracks).toEqual(['music_admin', 'music_admin', 'music_admin']);
  });

  it('distinguishes a shot that took a block out from one that did not', () => {
    const { audio, match } = setup();
    match.handle([{ kind: 'shot_impact', tick: 1, shotId: 1, x: 3, y: 4, destroyed: [] }]);
    expect(audio.sfx).toEqual(['shot_impact']);

    match.handle([{ kind: 'shot_impact', tick: 2, shotId: 2, x: 5, y: 6, destroyed: [77] }]);
    expect(audio.sfx).toEqual(['shot_impact', 'shot_impact', 'wall_destroyed']);
  });

  it('acknowledges only the player’s own placements', () => {
    const { audio, match } = setup();
    match.handle([
      { kind: 'piece_placed', tick: 1, player: HUMAN, pieceId: 0, rotation: 0, cells: [] },
      { kind: 'piece_placed', tick: 1, player: 1, pieceId: 0, rotation: 0, cells: [] },
    ]);
    expect(audio.sfx).toEqual(['piece_place']);
  });

  it('sounds the fanfare for ground newly won, and not for merely holding it', () => {
    const { audio, match } = setup();
    const resolved = (enclosedCastles: number, eliminated = false): MatchEvent => ({
      kind: 'round_resolved',
      tick: 1,
      round: 1,
      results: [{ player: HUMAN, enclosedCastles, cannonsAwarded: 2, eliminated }],
    });

    match.handle([resolved(1)]);
    expect(audio.sfx).toEqual(['enclosure_success']);

    // Still holding one castle is every round a player survives; it is not news.
    match.handle([resolved(1)]);
    expect(audio.sfx).toEqual(['enclosure_success']);

    match.handle([resolved(2)]);
    expect(audio.sfx).toEqual(['enclosure_success', 'enclosure_success']);

    match.handle([resolved(1)]);
    expect(audio.sfx.at(-1)).toBe('enclosure_failed');
  });

  it('leaves an elimination to its own cue rather than crowding it', () => {
    const { audio, match } = setup();
    match.handle([
      {
        kind: 'round_resolved',
        tick: 1,
        round: 3,
        results: [{ player: HUMAN, enclosedCastles: 0, cannonsAwarded: 0, eliminated: true }],
      },
      { kind: 'player_eliminated', tick: 1, player: HUMAN, round: 3 },
    ]);
    expect(audio.sfx).toEqual(['player_eliminated']);
  });

  it('plays victory only for the player who actually won', () => {
    const won = setup();
    won.match.handle([{ kind: 'game_over', tick: 1, winner: HUMAN, draw: false }]);
    expect(won.audio.tracks).toEqual(['music_victory']);

    const lost = setup();
    lost.match.handle([{ kind: 'game_over', tick: 1, winner: 1, draw: false }]);
    expect(lost.audio.tracks).toEqual(['music_defeat']);

    // A draw is every survivor eliminated together, which nobody won.
    const drawn = setup();
    drawn.match.handle([{ kind: 'game_over', tick: 1, winner: null, draw: true }]);
    expect(drawn.audio.tracks).toEqual(['music_defeat']);
  });

  it('says nothing personal in a watched match', () => {
    const { audio, match } = setup(-1);
    match.handle([
      {
        kind: 'round_resolved',
        tick: 1,
        round: 1,
        results: [{ player: 0, enclosedCastles: 2, cannonsAwarded: 3, eliminated: false }],
      },
    ]);
    expect(audio.sfx).toEqual([]);
  });

  it('ticks once per second over the last seconds of a phase', () => {
    const { audio, match } = setup();
    match.handle([phase('build')]);
    // 30Hz, ending at tick 300: the countdown starts with three seconds to go.
    for (let tick = 180; tick < 300; tick++) match.frame(clock('build', tick, 300));
    expect(audio.sfx.filter((c) => c === 'countdown_tick')).toHaveLength(3);
  });

  it('does not tick through an intermission, which is not a deadline', () => {
    const { audio, match } = setup();
    match.handle([phase('intermission', 'build')]);
    for (let tick = 280; tick < 300; tick++) match.frame(clock('intermission', tick, 300));
    expect(audio.sfx).not.toContain('countdown_tick');
  });
});
