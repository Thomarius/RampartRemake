import { defaultRuleset, defaultTerrainConfig } from '@rampart/config';
import { describe, expect, it } from 'vitest';

import { computeEnclosure } from './enclosure.js';
import {
  LogReplayer,
  applyAction,
  createMatch,
  hashMatchState,
  runLog,
  step,
  stepTo,
  ticksFor,
  type MatchOptions,
} from './match.js';
import { legalCannonPlacements } from './placement.js';
import { Structure } from './types.js';
import { recordRandomPlayout } from './playout.js';
import { beginMatch, fastRuleset } from './testing.js';

function options(playerCount: number, seed = 42, ruleset = fastRuleset()): MatchOptions {
  return {
    seed,
    ruleset,
    terrainConfig: defaultTerrainConfig,
    players: Array.from({ length: playerCount }, (_, i) => ({ name: `p${i}`, isBot: true })),
  };
}

describe('match setup', () => {
  it('opens with an announcement rather than straight into play', () => {
    const state = createMatch(options(3));
    expect(state.phase).toBe('intermission');
    expect(state.pendingPhase).toBe('castle_select');
  });

  it('starts in castle selection with every castle placed and nothing built', () => {
    const state = beginMatch(createMatch(options(3)));
    expect(state.phase).toBe('castle_select');
    expect(state.castles).toHaveLength(3 * defaultTerrainConfig.castles.perIsland);
    expect(state.cannons).toHaveLength(0);
    for (const player of state.players) {
      expect(state.castles.filter((c) => c.islandId === player.islandId)).toHaveLength(
        defaultTerrainConfig.castles.perIsland,
      );
    }
  });

  it('rejects a player count the ruleset does not allow', () => {
    expect(() => createMatch(options(1))).toThrow(/2-4 players/);
    expect(() => createMatch(options(5))).toThrow(/2-4 players/);
  });

  it('refuses a castle on another island', () => {
    const state = beginMatch(createMatch(options(2)));
    const theirs = state.castles.find((c) => c.islandId === 2);
    expect(applyAction(state, { kind: 'select_castle', player: 0, castleId: theirs!.id })).toBe(
      'wrong_island',
    );
  });
});

describe('castle selection', () => {
  it('grants a sealed ring and hands the player cannons to place', () => {
    const state = beginMatch(createMatch(options(2)));
    for (const player of state.players) {
      const castle = state.castles.find((c) => c.islandId === player.islandId)!;
      expect(
        applyAction(state, { kind: 'select_castle', player: player.id, castleId: castle.id }),
      ).toBeNull();
    }

    // The opening cannons are placed by the player, not dropped in automatically.
    beginMatch(state);
    expect(state.phase).toBe('cannon_place');
    expect(state.cannons).toHaveLength(0);
    for (const player of state.players) {
      expect(player.cannonsToPlace).toBe(defaultRuleset.cannons.startingCount);
    }

    // The ring is already sealed, so there is somewhere legal to put them.
    const result = computeEnclosure(state);
    for (const player of state.players) {
      expect(result.enclosedCastlesByPlayer[player.id]).toBe(1);
      expect(legalCannonPlacements(state, player.id).length).toBeGreaterThan(0);
    }
  });

  it('starts round 1 once the opening cannons are down', () => {
    const state = beginMatch(createMatch(options(2)));
    for (const player of state.players) {
      const castle = state.castles.find((c) => c.islandId === player.islandId)!;
      applyAction(state, { kind: 'select_castle', player: player.id, castleId: castle.id });
    }
    beginMatch(state);
    for (const player of state.players) {
      for (let i = 0; i < defaultRuleset.cannons.startingCount; i++) {
        const spot = legalCannonPlacements(state, player.id)[0]!;
        expect(applyAction(state, { kind: 'place_cannon', player: player.id, ...spot })).toBeNull();
      }
    }
    // The announcement has to clear before combat starts.
    expect(state.phase).toBe('intermission');
    expect(state.pendingPhase).toBe('combat');
    beginMatch(state);
    expect(state.phase).toBe('combat');
    expect(state.round).toBe(1);
    expect(state.cannons).toHaveLength(2 * defaultRuleset.cannons.startingCount);
    expect(state.cannons.every((c) => c.active)).toBe(true);
  });

  it('picks a castle for anyone who runs out the clock', () => {
    const state = createMatch(options(2));
    while (state.phase !== 'cannon_place' && state.tick < 5000) step(state);
    expect(state.phase).toBe('cannon_place');
    for (const player of state.players) expect(player.startingCastleId).not.toBeNull();
  });
});

describe('round resolution', () => {
  function startedMatch(playerCount = 2) {
    const state = beginMatch(createMatch(options(playerCount)));
    for (const player of state.players) {
      const castle = state.castles.find((c) => c.islandId === player.islandId)!;
      applyAction(state, { kind: 'select_castle', player: player.id, castleId: castle.id });
    }
    return state;
  }

  /** Advances to the end of the next build phase, where the round is resolved. */
  function runToResolution(state: ReturnType<typeof startedMatch>) {
    const resolutions = (): number =>
      state.events.filter((e) => e.kind === 'round_resolved').length;
    const before = resolutions();
    while (state.phase !== 'game_over' && resolutions() === before) step(state);
  }

  it('awards two cannons for one castle', () => {
    const state = startedMatch();
    runToResolution(state);
    for (const player of state.players) {
      expect(player.enclosedCastles).toBe(1);
      expect(player.cannonsToPlace).toBe(defaultRuleset.cannons.firstCastleReward);
    }
  });

  it('awards one more cannon for each further castle in the loop', () => {
    const state = startedMatch();
    // Wall off the whole of player 0's island, sweeping in all three castles.
    for (let i = 0; i < state.islandId.length; i++) {
      if (state.islandId[i] !== 1) continue;
      const x = i % state.width;
      const y = (i - x) / state.width;
      let coastal = false;
      for (const [ox, oy] of [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ] as const) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) coastal = true;
        else if (state.islandId[ny * state.width + nx] !== 1) coastal = true;
      }
      if (coastal && state.structure[i] === Structure.Empty) state.structure[i] = Structure.Wall;
    }
    runToResolution(state);

    const perIsland = defaultTerrainConfig.castles.perIsland;
    const player = state.players[0]!;
    expect(player.enclosedCastles).toBe(perIsland);
    expect(player.cannonsToPlace).toBe(
      defaultRuleset.cannons.firstCastleReward +
        (perIsland - 1) * defaultRuleset.cannons.perAdditionalCastleReward,
    );
  });

  it('eliminates a player whose walls are gone, and ends the match', () => {
    const state = startedMatch();
    // Raze every wall on player 1's island; they cannot enclose anything.
    for (let i = 0; i < state.structure.length; i++) {
      if (state.structure[i] === Structure.Wall && state.islandId[i] === 2) {
        state.structure[i] = Structure.Empty;
      }
    }
    runToResolution(state);

    expect(state.players[1]!.eliminated).toBe(true);
    expect(state.players[0]!.eliminated).toBe(false);
    expect(state.phase).toBe('game_over');
    expect(state.winner).toBe(0);
    expect(state.draw).toBe(false);
  });

  it('calls a draw when the last players fail together', () => {
    const state = startedMatch();
    for (let i = 0; i < state.structure.length; i++) {
      if (state.structure[i] === Structure.Wall) state.structure[i] = Structure.Empty;
    }
    runToResolution(state);
    expect(state.phase).toBe('game_over');
    expect(state.winner).toBeNull();
    expect(state.draw).toBe(true);
  });

  it('strips an eliminated player of their cannons but leaves the rubble', () => {
    const state = startedMatch(3);
    for (let i = 0; i < state.structure.length; i++) {
      if (state.structure[i] === Structure.Wall && state.islandId[i] === 3) {
        state.structure[i] = Structure.Empty;
      }
    }
    runToResolution(state);
    expect(state.players[2]!.eliminated).toBe(true);
    expect(state.cannons.some((c) => c.owner === 2)).toBe(false);
    expect(state.phase).not.toBe('game_over'); // two players remain
  });
});

describe('determinism', () => {
  it('replays an input log to exactly the same state', () => {
    const opts = options(3, 1234, defaultRuleset);
    const recorded = recordRandomPlayout(opts, 99, 4000);
    expect(recorded.log.length).toBeGreaterThan(100);

    const replay = createMatch(opts);
    runLog(replay, recorded.log, recorded.state.tick);

    expect(replay.tick).toBe(recorded.state.tick);
    expect(hashMatchState(replay)).toBe(hashMatchState(recorded.state));
  });

  it('agrees at every checkpoint along the way, not just at the end', () => {
    // A divergence that appears mid-match and happens to cancel out by the end is
    // still a desync, so compare as the match runs rather than only at the finish.
    const opts = options(3, 2024, defaultRuleset);
    const recorded = recordRandomPlayout(opts, 31, 4000, { checkpointEvery: 100 });
    expect(recorded.checkpoints.length).toBeGreaterThan(10);

    const replay = createMatch(opts);
    const replayer = new LogReplayer(replay, recorded.log);
    for (const checkpoint of recorded.checkpoints) {
      replayer.advanceTo(checkpoint.tick);
      expect(hashMatchState(replay)).toBe(checkpoint.hash);
    }
  });

  it('reaches the same state twice from the same seed', () => {
    const a = recordRandomPlayout(options(4, 7), 7, 3000);
    const b = recordRandomPlayout(options(4, 7), 7, 3000);
    expect(hashMatchState(a.state)).toBe(hashMatchState(b.state));
  });

  it('diverges when the seed changes', () => {
    const a = recordRandomPlayout(options(2, 11), 5, 2000);
    const b = recordRandomPlayout(options(2, 12), 5, 2000);
    expect(hashMatchState(a.state)).not.toBe(hashMatchState(b.state));
  });
});

describe('full match', () => {
  it('plays to a conclusion', () => {
    const { state } = recordRandomPlayout(options(3, 5), 5, 60_000);
    expect(state.phase).toBe('game_over');
    expect(state.players.filter((p) => !p.eliminated).length).toBeLessThanOrEqual(1);
    if (state.winner !== null) expect(state.players[state.winner]!.eliminated).toBe(false);
  });

  it('keeps cycling rounds for as long as nobody breaks a wall', () => {
    // With no shots fired, the starting rings stay intact, so the phase loop should
    // run indefinitely without eliminating anyone. This is the round machine under
    // test, isolated from combat.
    const { state } = recordRandomPlayout(options(3, 8), 8, 12_000, { fireChance: 0 });
    expect(state.phase).not.toBe('game_over');
    expect(state.round).toBeGreaterThan(20);
    expect(state.players.every((p) => !p.eliminated)).toBe(true);
    expect(state.players.every((p) => p.enclosedCastles >= 1)).toBe(true);
  });

  it('is won by whoever repairs when the others do not', () => {
    // Random players never fix a breach; a player who simply seals their ring each
    // build phase should therefore outlast them.
    const { state } = recordRandomPlayout(options(2, 17), 3, 60_000);
    expect(state.phase).toBe('game_over');
  });
});

describe('intermission', () => {
  function intoCombat(playerCount = 2) {
    const state = beginMatch(createMatch(options(playerCount, 42, defaultRuleset)));
    for (const player of state.players) {
      const castle = state.castles.find((c) => c.islandId === player.islandId)!;
      applyAction(state, { kind: 'select_castle', player: player.id, castleId: castle.id });
    }
    beginMatch(state); // announcement before cannon placement
    for (const player of state.players) {
      for (let i = 0; i < defaultRuleset.cannons.startingCount; i++) {
        const spot = legalCannonPlacements(state, player.id)[0];
        if (spot) applyAction(state, { kind: 'place_cannon', player: player.id, ...spot });
      }
    }
    beginMatch(state); // announcement before combat
    expect(state.phase).toBe('combat');
    return state;
  }

  it('lasts the configured pause plus the announcement', () => {
    const state = intoCombat();
    while (state.phase === 'combat') step(state);

    expect(state.phase).toBe('intermission');
    expect(state.pendingPhase).toBe('build');
    const expected =
      ticksFor(defaultRuleset.phases.endOfPhasePauseMs, defaultRuleset.tickRateHz) +
      ticksFor(defaultRuleset.phases.transitionBannerMs, defaultRuleset.tickRateHz);
    expect(state.phaseEndTick - state.tick).toBe(expected);
  });

  it('holds until the last shot has landed', () => {
    // A cannonball fired as the clock runs out must land, and be seen to land,
    // before the next phase starts under it.
    const state = intoCombat();
    stepTo(state, state.phaseEndTick - 1);
    const target = state.castles.find((c) => c.islandId === 2)!;
    expect(
      applyAction(state, { kind: 'fire', player: 0, x: target.x, y: target.y - 4 }),
    ).toBeNull();
    const shot = state.shots[0]!;
    expect(shot.impactTick).toBeGreaterThan(state.phaseEndTick);

    step(state);
    expect(state.phase).toBe('intermission');

    // The intermission cannot end while the shot is still in the air.
    stepTo(state, shot.impactTick - 1);
    expect(state.phase).toBe('intermission');
    expect(state.shots).toHaveLength(1);

    // Once it lands, the full pause and announcement still have to play out.
    stepTo(state, shot.impactTick);
    expect(state.shots).toHaveLength(0);
    const remaining = state.phaseEndTick - state.tick;
    expect(remaining).toBeGreaterThan(
      ticksFor(defaultRuleset.phases.transitionBannerMs, defaultRuleset.tickRateHz) - 2,
    );
    stepTo(state, state.phaseEndTick);
    expect(state.phase).toBe('build');
  });

  it('blocks play while it runs', () => {
    const state = intoCombat();
    while (state.phase === 'combat') step(state);
    expect(state.phase).toBe('intermission');
    const target = state.castles.find((c) => c.islandId === 2)!;
    expect(applyAction(state, { kind: 'fire', player: 0, x: target.x, y: target.y })).toBe(
      'wrong_phase',
    );
    expect(applyAction(state, { kind: 'place_piece', player: 0, x: 5, y: 5, rotation: 0 })).toBe(
      'wrong_phase',
    );
  });

  it('precedes every phase, so no phase begins unannounced', () => {
    const state = beginMatch(createMatch(options(2, 9, defaultRuleset)));
    let previous = state.phase;
    const starts: string[] = [];
    for (let i = 0; i < 40_000 && state.phase !== 'game_over'; i++) {
      step(state);
      if (state.phase !== previous) {
        if (previous === 'intermission') starts.push(state.phase);
        else expect(state.phase).toBe('intermission');
        previous = state.phase;
      }
    }
    expect(starts.length).toBeGreaterThan(2);
  });
});
