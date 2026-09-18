/**
 * Scripted playouts: drives a match with legal-but-unthinking moves.
 *
 * Used by the determinism suite to produce input logs, and by the headless harness
 * to soak-test the phase machine. Real opponents arrive with the AI package in M5.
 */

import { applyAction, createMatch, hashMatchState, step, type MatchOptions } from './match.js';
import { canPlacePiece, canPlaceCannon } from './placement.js';
import { Rng } from './rng.js';
import { Structure, type Action, type LoggedAction, type MatchState } from './types.js';

export interface PlayoutBehaviour {
  /** Per-tick chance a player takes a shot during combat. */
  fireChance?: number;
  /** Per-tick chance a player places a piece during build. */
  buildChance?: number;
  /** Capture a state hash every N ticks, for intermediate determinism checks. */
  checkpointEvery?: number;
}

/**
 * One legal-but-unthinking move for a player, or null to do nothing this tick.
 *
 * Exported so the client can field opponents before the AI package exists: a match
 * against opponents that at least shoot back tells you far more about whether the
 * loop works than an empty map does.
 */
export function scriptedAction(
  state: MatchState,
  playerId: number,
  rng: Rng,
  behaviour: Required<Pick<PlayoutBehaviour, 'fireChance' | 'buildChance'>>,
): Action | null {
  const player = state.players[playerId];
  if (!player || player.eliminated) return null;

  switch (state.phase) {
    case 'castle_select': {
      if (player.startingCastleId !== null) return null;
      const mine = state.castles.filter((c) => c.islandId === player.islandId);
      if (mine.length === 0) return null;
      const castle = mine[rng.nextInt(mine.length)];
      return castle ? { kind: 'select_castle', player: playerId, castleId: castle.id } : null;
    }
    case 'combat': {
      if (rng.nextFloat() > behaviour.fireChance) return null;
      // Aim at an opponent's wall, found by sampling rather than scanning the map.
      for (let attempt = 0; attempt < 40; attempt++) {
        const x = rng.nextInt(state.width);
        const y = rng.nextInt(state.height);
        const i = y * state.width + x;
        if (state.structure[i] !== Structure.Wall) continue;
        if (state.islandId[i] === player.islandId) continue;
        return { kind: 'fire', player: playerId, x, y };
      }
      return null;
    }
    case 'build': {
      if (rng.nextFloat() > behaviour.buildChance) return null;
      for (let attempt = 0; attempt < 60; attempt++) {
        const x = rng.nextInt(state.width);
        const y = rng.nextInt(state.height);
        const rotation = rng.nextInt(4);
        if (canPlacePiece(state, playerId, rotation, x, y) === null) {
          return { kind: 'place_piece', player: playerId, x, y, rotation };
        }
      }
      return null;
    }
    case 'cannon_place': {
      if (player.cannonsToPlace <= 0) return null;
      for (let attempt = 0; attempt < 200; attempt++) {
        const x = rng.nextInt(state.width);
        const y = rng.nextInt(state.height);
        if (canPlaceCannon(state, playerId, x, y) === null) {
          return { kind: 'place_cannon', player: playerId, x, y };
        }
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Plays a match with random legal moves, recording every accepted action.
 *
 * The resulting log is the input to the determinism suite: replaying it into a
 * fresh match must reproduce the original state exactly, tick for tick.
 */
export function recordRandomPlayout(
  options: MatchOptions,
  rngSeed: number,
  maxTicks: number,
  behaviour: PlayoutBehaviour = {},
): { state: MatchState; log: LoggedAction[]; checkpoints: { tick: number; hash: string }[] } {
  const settings = {
    fireChance: behaviour.fireChance ?? 0.2,
    buildChance: behaviour.buildChance ?? 0.12,
  };
  const checkpointEvery = behaviour.checkpointEvery ?? 0;

  const state = createMatch(options);
  const rng = new Rng(rngSeed);
  const log: LoggedAction[] = [];
  const checkpoints: { tick: number; hash: string }[] = [];

  while (state.tick < maxTicks && state.phase !== 'game_over') {
    for (const player of state.players) {
      const action = scriptedAction(state, player.id, rng, settings);
      if (action === null) continue;
      if (applyAction(state, action) === null) log.push({ tick: state.tick, action });
    }
    step(state);
    if (checkpointEvery > 0 && state.tick % checkpointEvery === 0) {
      checkpoints.push({ tick: state.tick, hash: hashMatchState(state) });
    }
  }
  return { state, log, checkpoints };
}
