import { Structure, Terrain, type Cannon, type MatchState, type PlayerState } from './types.js';
import { pieceAt, pieceCells } from './pieces.js';

/**
 * Why an action was refused. The server returns these to the client verbatim, and
 * the AI uses them to learn what it may do, so both sides share one rulebook.
 */
export type Rejection =
  | 'wrong_phase'
  | 'unknown_player'
  | 'eliminated'
  | 'out_of_bounds'
  | 'not_land'
  | 'occupied'
  | 'wrong_island'
  | 'not_territory'
  | 'no_cannons_left'
  | 'cannon_cap'
  | 'no_ready_cannon'
  | 'out_of_range'
  | 'unknown_castle'
  | 'castle_taken'
  | 'already_selected'
  | 'own_island'
  | 'overtime_spent';

export function playerOf(state: MatchState, id: number): PlayerState | null {
  return state.players[id] ?? null;
}

/** The piece this player must place next. */
export function currentPieceId(state: MatchState, playerId: number): number {
  const player = state.players[playerId];
  if (!player) throw new Error(`unknown player ${playerId}`);
  return pieceAt(state.ruleset, state.seed, player.pieceRound, player.pieceIndex);
}

/** The next `count` pieces, for the client's preview strip. */
export function upcomingPieceIds(state: MatchState, playerId: number, count: number): number[] {
  const player = state.players[playerId];
  if (!player) return [];
  const out: number[] = [];
  for (let i = 1; i <= count; i++) {
    out.push(pieceAt(state.ruleset, state.seed, player.pieceRound, player.pieceIndex + i));
  }
  return out;
}

/**
 * Walls may only go on free land of your own island. Islands are separated by
 * water, so there is no way to interfere with an opponent's walls — every wall
 * you place is purely your own defence.
 */
export function canPlacePiece(
  state: MatchState,
  playerId: number,
  rotation: number,
  x: number,
  y: number,
): Rejection | null {
  if (state.phase !== 'build') return 'wrong_phase';
  const player = playerOf(state, playerId);
  if (!player) return 'unknown_player';
  if (player.eliminated) return 'eliminated';

  if (state.overtime && player.overtimeSpent) return 'overtime_spent';

  const cells = pieceCells(currentPieceId(state, playerId), rotation);
  for (const [ox, oy] of cells) {
    const tx = x + ox;
    const ty = y + oy;
    if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) return 'out_of_bounds';
    const i = ty * state.width + tx;
    if (state.terrain[i] !== Terrain.Land) return 'not_land';
    if (state.structure[i] !== Structure.Empty) return 'occupied';
    if (state.ruleset.build.restrictToOwnIsland && state.islandId[i] !== player.islandId) {
      return 'wrong_island';
    }
  }
  return null;
}

/** Places the current piece and advances this player through the shared sequence. */
export function placePiece(
  state: MatchState,
  playerId: number,
  rotation: number,
  x: number,
  y: number,
): { rejection: Rejection } | { pieceId: number; cells: number[] } {
  const rejection = canPlacePiece(state, playerId, rotation, x, y);
  if (rejection) return { rejection };

  const player = state.players[playerId] as PlayerState;
  const pieceId = currentPieceId(state, playerId);
  const cells: number[] = [];

  for (const [ox, oy] of pieceCells(pieceId, rotation)) {
    const i = (y + oy) * state.width + x + ox;
    state.structure[i] = Structure.Wall;
    state.owner[i] = player.islandId;
    cells.push(i);
  }
  player.pieceIndex++;
  if (state.overtime) player.overtimeSpent = true;

  state.events.push({
    kind: 'piece_placed',
    tick: state.tick,
    player: playerId,
    pieceId,
    rotation,
    cells,
  });
  return { pieceId, cells };
}

/** Cannons go inside your own sealed territory, never on open ground. */
export function canPlaceCannon(
  state: MatchState,
  playerId: number,
  x: number,
  y: number,
): Rejection | null {
  if (state.phase !== 'cannon_place') return 'wrong_phase';
  const player = playerOf(state, playerId);
  if (!player) return 'unknown_player';
  if (player.eliminated) return 'eliminated';
  if (player.cannonsToPlace <= 0) return 'no_cannons_left';

  const cap = state.ruleset.cannons.maxTotal;
  if (cap !== null && countCannons(state, playerId) >= cap) return 'cannon_cap';

  const [cw, ch] = state.ruleset.cannons.footprint;
  for (let oy = 0; oy < ch; oy++) {
    for (let ox = 0; ox < cw; ox++) {
      const tx = x + ox;
      const ty = y + oy;
      if (tx < 0 || ty < 0 || tx >= state.width || ty >= state.height) return 'out_of_bounds';
      const i = ty * state.width + tx;
      if (state.terrain[i] !== Terrain.Land) return 'not_land';
      if (state.structure[i] !== Structure.Empty) return 'occupied';
      if (state.territory[i] !== player.islandId) return 'not_territory';
    }
  }
  return null;
}

export function countCannons(state: MatchState, playerId: number): number {
  let count = 0;
  for (const cannon of state.cannons) if (cannon.owner === playerId) count++;
  return count;
}

export function placeCannon(
  state: MatchState,
  playerId: number,
  x: number,
  y: number,
): { rejection: Rejection } | { cannon: Cannon } {
  const rejection = canPlaceCannon(state, playerId, x, y);
  if (rejection) return { rejection };
  const player = state.players[playerId] as PlayerState;
  const cannon = spawnCannon(state, playerId, x, y);
  player.cannonsToPlace--;
  state.events.push({
    kind: 'cannon_placed',
    tick: state.tick,
    player: playerId,
    cannonId: cannon.id,
    x,
    y,
  });
  return { cannon };
}

/** Writes a cannon into the grid without any phase or entitlement checks. */
export function spawnCannon(state: MatchState, playerId: number, x: number, y: number): Cannon {
  const player = state.players[playerId] as PlayerState;
  const [cw, ch] = state.ruleset.cannons.footprint;
  const cannon: Cannon = {
    id: state.nextCannonId++,
    owner: playerId,
    x,
    y,
    w: cw,
    h: ch,
    active: true,
    shotId: null,
  };
  for (let oy = 0; oy < ch; oy++) {
    for (let ox = 0; ox < cw; ox++) {
      const i = (y + oy) * state.width + x + ox;
      state.structure[i] = Structure.Cannon;
      state.owner[i] = player.islandId;
    }
  }
  state.cannons.push(cannon);
  return cannon;
}

/** Every legal anchor for the current piece at a given rotation. Used by the AI and UI. */
export function legalPiecePlacements(
  state: MatchState,
  playerId: number,
  rotation: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      if (canPlacePiece(state, playerId, rotation, x, y) === null) out.push({ x, y });
    }
  }
  return out;
}

/**
 * Whether this player has anywhere left to put a cannon.
 *
 * Filters on the territory layer before the full check, so the common case exits
 * on the first enclosed tile rather than walking the whole grid.
 */
export function canPlaceAnyCannon(state: MatchState, playerId: number): boolean {
  const player = state.players[playerId];
  if (!player) return false;
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      if (state.territory[y * state.width + x] !== player.islandId) continue;
      if (canPlaceCannon(state, playerId, x, y) === null) return true;
    }
  }
  return false;
}

/** Every legal cannon position for a player. */
export function legalCannonPlacements(
  state: MatchState,
  playerId: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      if (canPlaceCannon(state, playerId, x, y) === null) out.push({ x, y });
    }
  }
  return out;
}
