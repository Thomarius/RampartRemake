import type { CraterPattern } from '@rampart/config';

import { distanceFixed, distanceSquared } from './math.js';
import { playerOf, type Rejection } from './placement.js';
import { Structure, type Cannon, type MatchState, type Shot } from './types.js';

/** Tiles a landed shot clears, relative to the impact tile. */
export function craterOffsets(pattern: CraterPattern): readonly (readonly [number, number])[] {
  switch (pattern) {
    case 'single':
      return [[0, 0]];
    case 'plus5':
      return [
        [0, 0],
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ];
    case 'square9':
      return [
        [-1, -1],
        [0, -1],
        [1, -1],
        [-1, 0],
        [0, 0],
        [1, 0],
        [-1, 1],
        [0, 1],
        [1, 1],
      ];
  }
}

function cannonCentreX(cannon: Cannon): number {
  return cannon.x + (cannon.w - 1) / 2;
}

function cannonCentreY(cannon: Cannon): number {
  return cannon.y + (cannon.h - 1) / 2;
}

/**
 * The nearest cannon that is active and has nothing in flight.
 *
 * Nearest rather than round-robin keeps the player thinking about targets instead of
 * inventory, and makes front-line cannons the workhorses. Ties break on cannon id so
 * the choice is reproducible.
 */
export function findReadyCannon(state: MatchState, playerId: number, tx: number, ty: number) {
  let best: Cannon | null = null;
  let bestDistance = Infinity;
  for (const cannon of state.cannons) {
    if (cannon.owner !== playerId || !cannon.active || cannon.shotId !== null) continue;
    const d = distanceSquared(cannonCentreX(cannon), cannonCentreY(cannon), tx, ty);
    if (d < bestDistance || (d === bestDistance && best !== null && cannon.id < best.id)) {
      bestDistance = d;
      best = cannon;
    }
  }
  return best;
}

/**
 * Flight time grows with distance, so distant targets must be led — and a cannon
 * cannot fire again until its shot has landed, which is the only rate limit.
 *
 * Distance uses an exact integer square root rather than `Math.sqrt`: the spec allows
 * engines to approximate `Math.sqrt`, and a one-tick disagreement on impact time
 * between client and server is a desync.
 */
export function flightTicks(
  state: MatchState,
  fromX: number,
  fromY: number,
  tx: number,
  ty: number,
): number {
  const { baseFlightMs, perTileFlightMs } = state.ruleset.shots;
  const distance256 = distanceFixed(fromX, fromY, tx, ty);
  const flightMs = baseFlightMs + (perTileFlightMs * distance256) / 256;
  return Math.max(1, Math.ceil((flightMs * state.ruleset.tickRateHz) / 1000));
}

export function fire(
  state: MatchState,
  playerId: number,
  tx: number,
  ty: number,
): { rejection: Rejection } | { shot: Shot } {
  if (state.phase !== 'combat') return { rejection: 'wrong_phase' };
  const player = playerOf(state, playerId);
  if (!player) return { rejection: 'unknown_player' };
  if (player.eliminated) return { rejection: 'eliminated' };
  if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) {
    return { rejection: 'out_of_bounds' };
  }
  // Refused rather than fired and wasted: a shot here could only ever hit your own
  // wall, which neither damages it nor scores.
  if (
    !state.ruleset.shots.damagesOwnWalls &&
    state.islandId[ty * state.width + tx] === player.islandId
  ) {
    return { rejection: 'own_island' };
  }

  const cannon = findReadyCannon(state, playerId, tx, ty);
  if (!cannon) return { rejection: 'no_ready_cannon' };

  const fromX = cannonCentreX(cannon);
  const fromY = cannonCentreY(cannon);

  const maxRange = state.ruleset.shots.maxRangeTiles;
  if (maxRange !== null && distanceSquared(fromX, fromY, tx, ty) > maxRange * maxRange) {
    return { rejection: 'out_of_range' };
  }

  const shot: Shot = {
    id: state.nextShotId++,
    cannonId: cannon.id,
    owner: playerId,
    fromX,
    fromY,
    toX: tx,
    toY: ty,
    launchTick: state.tick,
    impactTick: state.tick + flightTicks(state, fromX, fromY, tx, ty),
  };
  cannon.shotId = shot.id;
  state.shots.push(shot);
  state.events.push({ kind: 'shot_fired', tick: state.tick, shot });
  return { shot };
}

/**
 * Lands every shot due this tick. Craters clear walls only — castles and cannons
 * are indestructible, so a breach is the sole thing artillery can achieve.
 *
 * Only a live opponent's wall is cleared unless `damagesOwnWalls` says otherwise, and
 * only that ever credits the shooter. Checked here as well as at `fire`, because a
 * crater wider than one tile reaches ground the aim never pointed at. The owner is
 * read before the tile is cleared, since clearing it is what zeroes the owner.
 */
export function resolveImpacts(state: MatchState): void {
  if (state.shots.length === 0) return;
  const offsets = craterOffsets(state.ruleset.shots.craterPattern);
  const remaining: Shot[] = [];

  for (const shot of state.shots) {
    if (shot.impactTick > state.tick) {
      remaining.push(shot);
      continue;
    }

    const destroyed: number[] = [];
    const shooter = state.players[shot.owner];
    const shooterIsland = shooter?.islandId ?? 0;
    if (state.ruleset.shots.damagesWalls) {
      for (const [ox, oy] of offsets) {
        const tx = shot.toX + ox;
        const ty = shot.toY + oy;
        if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) continue;
        const i = ty * state.width + tx;
        if (state.structure[i] !== Structure.Wall) continue;
        const opponents = state.owner[i] !== 0 && state.owner[i] !== shooterIsland;
        if (!opponents && !state.ruleset.shots.damagesOwnWalls) continue;
        if (opponents && shooter) shooter.wallsDestroyed++;
        state.structure[i] = Structure.Empty;
        state.owner[i] = 0;
        destroyed.push(i);
      }
    }

    const cannon = state.cannons.find((c) => c.id === shot.cannonId);
    if (cannon && cannon.shotId === shot.id) cannon.shotId = null;

    state.events.push({
      kind: 'shot_impact',
      tick: state.tick,
      shotId: shot.id,
      x: shot.toX,
      y: shot.toY,
      destroyed,
    });
  }

  state.shots = remaining;
}
