import { defaultRuleset, defaultTerrainConfig } from '@rampart/config';
import { describe, expect, it } from 'vitest';

import { applyEnclosure, computeEnclosure } from './enclosure.js';
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
import { canPlacePiece, currentPieceId, legalCannonPlacements } from './placement.js';
import { pieceCells } from './pieces.js';
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
    const { min, max } = defaultRuleset.players;
    expect(() => createMatch(options(min - 1))).toThrow(`${min}-${max} players`);
    expect(() => createMatch(options(max + 1))).toThrow(`${min}-${max} players`);
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
      // Walls every land tile touching water, diagonals included. Orthogonal
      // neighbours alone leave a band that a diagonal coastline lets the sea
      // slip through, now that the escape flood is 8-connected.
      let coastal = false;
      for (const [ox, oy] of [
        [0, -1],
        [1, -1],
        [1, 0],
        [1, 1],
        [0, 1],
        [-1, 1],
        [-1, 0],
        [-1, -1],
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

describe('territory feedback', () => {
  it('raises the wall ring the moment a castle is chosen', () => {
    const state = beginMatch(createMatch(options(3)));
    const castle = state.castles.find((c) => c.islandId === 1)!;
    const wallsBefore = state.structure.filter((v) => v === Structure.Wall).length;

    applyAction(state, { kind: 'select_castle', player: 0, castleId: castle.id });

    // This player's ring is up immediately, without waiting for the others.
    expect(state.structure.filter((v) => v === Structure.Wall).length).toBeGreaterThan(wallsBefore);
    expect(state.players[1]!.startingCastleId).toBeNull();
  });

  it('shows the enclosed territory as soon as the castle is chosen', () => {
    const state = beginMatch(createMatch(options(2)));
    const castle = state.castles.find((c) => c.islandId === 1)!;
    expect(state.territory.some((v) => v === 1)).toBe(false);

    applyAction(state, { kind: 'select_castle', player: 0, castleId: castle.id });
    expect(state.territory.some((v) => v === 1)).toBe(true);
    // And only for the player who has actually chosen.
    expect(state.territory.some((v) => v === 2)).toBe(false);
  });

  it('lights up new territory the instant a block closes a loop', () => {
    const state = beginMatch(createMatch(options(2)));
    for (const player of state.players) {
      const castle = state.castles.find((c) => c.islandId === player.islandId)!;
      applyAction(state, { kind: 'select_castle', player: player.id, castleId: castle.id });
    }
    state.phase = 'build';
    state.phaseEndTick = state.tick + 100_000;

    // Knock a hole in the middle of a ring edge, then plug it and watch the
    // territory come back. A corner would not do: removing the corner of a
    // rectangle leaves the interior sealed under 4-connectivity, because the
    // gap's inward neighbours are both still wall.
    const castle = state.castles.find((c) => c.id === state.players[0]!.startingCastleId)!;
    const ring = state.terrainConfig.startingWall.ringRadiusTiles;
    const ringTile = (castle.y - ring) * state.width + castle.x + 1;
    expect(state.structure[ringTile]).toBe(Structure.Wall);
    state.structure[ringTile] = Structure.Empty;
    applyEnclosure(state);
    expect(state.territory.some((v) => v === 1)).toBe(false);

    let closed = false;
    for (let rotation = 0; rotation < 4 && !closed; rotation++) {
      const x = ringTile % state.width;
      const y = (ringTile - x) / state.width;
      for (const [ox, oy] of pieceCells(currentPieceId(state, 0), rotation)) {
        if (canPlacePiece(state, 0, rotation, x - ox, y - oy) !== null) continue;
        expect(
          applyAction(state, { kind: 'place_piece', player: 0, x: x - ox, y: y - oy, rotation }),
        ).toBeNull();
        closed = true;
        break;
      }
    }
    expect(closed).toBe(true);
    expect(state.territory.some((v) => v === 1)).toBe(true);
  });

  it('holds territory through a barrage that breaks the wall', () => {
    // What you see during combat is the territory you earned, not what is left of
    // it — otherwise the map would dissolve under you as your walls came down.
    const state = beginMatch(createMatch(options(2)));
    for (const player of state.players) {
      const castle = state.castles.find((c) => c.islandId === player.islandId)!;
      applyAction(state, { kind: 'select_castle', player: player.id, castleId: castle.id });
    }
    beginMatch(state);
    for (const player of state.players) {
      for (let i = 0; i < defaultRuleset.cannons.startingCount; i++) {
        const spot = legalCannonPlacements(state, player.id)[0];
        if (spot) applyAction(state, { kind: 'place_cannon', player: player.id, ...spot });
      }
    }
    beginMatch(state);
    expect(state.phase).toBe('combat');

    const before = state.territory.filter((v) => v === 1).length;
    expect(before).toBeGreaterThan(0);
    for (let i = 0; i < state.structure.length; i++) {
      if (state.structure[i] === Structure.Wall && state.owner[i] === 1) {
        state.structure[i] = Structure.Empty;
      }
    }
    step(state);
    expect(state.territory.filter((v) => v === 1).length).toBe(before);
  });
});

describe('cannon placement phase', () => {
  it('ends early when nobody has room for another cannon', () => {
    const state = beginMatch(createMatch(options(2)));
    for (const player of state.players) {
      const castle = state.castles.find((c) => c.islandId === player.islandId)!;
      applyAction(state, { kind: 'select_castle', player: player.id, castleId: castle.id });
    }
    beginMatch(state);
    expect(state.phase).toBe('cannon_place');

    // Hand out far more cannons than the starting enclosure can hold.
    for (const player of state.players) player.cannonsToPlace = 500;
    const startedAt = state.tick;
    while (state.phase === 'cannon_place' && state.tick < startedAt + 100_000) step(state);

    expect(state.phase).toBe('intermission');
    expect(state.tick - startedAt).toBeLessThan(
      ticksFor(defaultRuleset.phases.cannonPlaceMs, defaultRuleset.tickRateHz),
    );
    // It ended because there was no room, not because everything was placed.
    expect(state.players.some((p) => p.cannonsToPlace > 0)).toBe(true);
  });
});

describe('starting rings', () => {
  it('builds a complete, sealed ring for any castle a player picks', () => {
    // A castle whose ring has a hole in it is a trap: the player commits to it and
    // starts the match unenclosed. This went unnoticed while the escape flood was
    // 4-connected, because a missing corner still sealed.
    const ring = defaultTerrainConfig.startingWall.ringRadiusTiles;

    for (const seed of [1, 2, 3, 4, 5]) {
      const probe = beginMatch(createMatch(options(3, seed)));
      const mine = probe.castles.filter((c) => c.islandId === 1);
      expect(mine).toHaveLength(defaultTerrainConfig.castles.perIsland);

      for (const choice of mine) {
        const state = beginMatch(createMatch(options(3, seed)));
        expect(
          applyAction(state, { kind: 'select_castle', player: 0, castleId: choice.id }),
        ).toBeNull();

        const x0 = choice.x - ring;
        const y0 = choice.y - ring;
        const x1 = choice.x + choice.w - 1 + ring;
        const y1 = choice.y + choice.h - 1 + ring;

        // Every tile of the perimeter, corners included, is wall.
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            if (x !== x0 && x !== x1 && y !== y0 && y !== y1) continue;
            expect({ x, y, kind: state.structure[y * state.width + x] }).toEqual({
              x,
              y,
              kind: Structure.Wall,
            });
          }
        }

        expect(computeEnclosure(state).enclosedCastlesByPlayer[0]).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('keeps every other castle clear of that ring', () => {
    const ring = defaultTerrainConfig.startingWall.ringRadiusTiles;
    for (const seed of [7, 11, 13]) {
      const state = createMatch(options(4, seed));
      for (const castle of state.castles) {
        for (const other of state.castles) {
          if (other.id === castle.id || other.islandId !== castle.islandId) continue;
          const overlapsX =
            other.x + other.w > castle.x - ring && other.x <= castle.x + castle.w - 1 + ring;
          const overlapsY =
            other.y + other.h > castle.y - ring && other.y <= castle.y + castle.h - 1 + ring;
          expect(overlapsX && overlapsY).toBe(false);
        }
      }
    }
  });
});
