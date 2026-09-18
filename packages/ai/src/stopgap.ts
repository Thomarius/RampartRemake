import {
  Structure,
  canPlaceCannon,
  canPlacePiece,
  currentPieceId,
  pieceCells,
  type Action,
  type MatchState,
  type Rng,
} from '@rampart/sim';

/**
 * A stopgap opponent, good enough to be worth playing against.
 *
 * The simulation's scripted driver places pieces at uniformly random legal
 * positions, which never closes a breach — every such opponent dies in round one,
 * and a human would win before seeing a second round. This one biases placement
 * towards tiles that touch its own walls, so rings tend to get mended and matches
 * actually run.
 *
 * It is not an AI, and it does not survive long. It rebuilds the thin rectangular
 * ring it started with, which is a losing shape: only the straight pieces fit along
 * a one-tile line, so every other piece must deposit blocks beside the wall. That
 * litter accumulates until gaps have no free neighbours left to anchor a piece,
 * and a piece is at least three cells. Expect two or three rounds.
 *
 * Playing well means thickening the wall into a blob rather than restoring a thin
 * line — which is planning, and therefore M5's job.
 */

const FIRE_CHANCE = 0.12;
// Repairs stop as soon as the ring is whole, so a brisk rate is self-limiting.
const BUILD_CHANCE = 0.15;

export function stopgapAction(state: MatchState, playerId: number, rng: Rng): Action | null {
  const player = state.players[playerId];
  if (!player || player.eliminated) return null;

  switch (state.phase) {
    case 'castle_select': {
      if (player.startingCastleId !== null) return null;
      const mine = state.castles.filter((c) => c.islandId === player.islandId);
      const castle = mine[rng.nextInt(Math.max(1, mine.length))];
      return castle ? { kind: 'select_castle', player: playerId, castleId: castle.id } : null;
    }

    case 'combat': {
      if (rng.nextFloat() > FIRE_CHANCE) return null;
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
      if (rng.nextFloat() > BUILD_CHANCE) return null;
      return repairAction(state, playerId, rng);
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

interface Ring {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The perimeter of the wall ring this player was given around its starting castle. */
function ringOf(state: MatchState, playerId: number): Ring | null {
  const castleId = state.players[playerId]?.startingCastleId;
  if (castleId === null || castleId === undefined) return null;
  const castle = state.castles.find((c) => c.id === castleId);
  if (!castle) return null;
  const r = state.terrainConfig.startingWall.ringRadiusTiles;
  return {
    x0: castle.x - r,
    y0: castle.y - r,
    x1: castle.x + castle.w - 1 + r,
    y1: castle.y + castle.h - 1 + r,
  };
}

function insideRing(ring: Ring, x: number, y: number): boolean {
  return x > ring.x0 && x < ring.x1 && y > ring.y0 && y < ring.y1;
}

function onRing(ring: Ring, x: number, y: number): boolean {
  const withinX = x >= ring.x0 && x <= ring.x1;
  const withinY = y >= ring.y0 && y <= ring.y1;
  if (!withinX || !withinY) return false;
  return x === ring.x0 || x === ring.x1 || y === ring.y0 || y === ring.y1;
}

/**
 * Picks a placement that plugs a hole in the starting ring.
 *
 * Aiming at the gaps directly, rather than sampling positions and scoring them,
 * is the whole difference between an opponent that survives and one that does not:
 * a specific gap tile is a needle in 6400 tiles, and random sampling essentially
 * never finds it. Here each gap proposes its own candidate placements — one per
 * piece cell per rotation — so a legal repair is found if one exists.
 */
function repairAction(state: MatchState, playerId: number, rng: Rng): Action | null {
  const ring = ringOf(state, playerId);
  if (ring === null) return null;

  const gaps = ringGaps(state, playerId, ring);
  if (gaps.length === 0) return null;
  rng.shuffle(gaps);

  const pieceId = currentPieceId(state, playerId);
  let best: { x: number; y: number; rotation: number } | null = null;
  // Any legal repair beats none: the penalty ranks candidates, it does not veto them.
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const gap of gaps) {
    for (let rotation = 0; rotation < 4; rotation++) {
      const cells = pieceCells(pieceId, rotation);
      for (const [ox, oy] of cells) {
        const x = gap.x - ox;
        const y = gap.y - oy;
        if (canPlacePiece(state, playerId, rotation, x, y) !== null) continue;
        // Prefer a piece that covers several gaps at once, and that does not
        // spill many blocks off the ring where they do nothing.
        let covered = 0;
        let inward = 0;
        let outward = 0;
        for (const [cx, cy] of cells) {
          const tx = x + cx;
          const ty = y + cy;
          if (onRing(ring, tx, ty)) covered++;
          else if (insideRing(ring, tx, ty)) inward++;
          else outward++;
        }
        // Blocks landing outside the ring are the expensive mistake: they occupy
        // exactly the tiles a later repair needs as anchors, and a piece is at
        // least three cells, so a lone gap with no free neighbours becomes
        // unfillable. Spilling inward merely wastes space.
        const score = covered * 4 - inward - outward * 8;
        if (score > bestScore) {
          bestScore = score;
          best = { x, y, rotation };
        }
      }
    }
    if (bestScore >= cellCount(pieceId) * 4) break; // every block on the ring
  }

  return best ? { kind: 'place_piece', player: playerId, ...best } : null;
}

function cellCount(pieceId: number): number {
  return pieceCells(pieceId, 0).length;
}

/** Empty tiles on the ring perimeter — the holes that need filling. */
function ringGaps(state: MatchState, playerId: number, ring: Ring): { x: number; y: number }[] {
  const islandId = state.players[playerId]?.islandId;
  const gaps: { x: number; y: number }[] = [];
  for (let y = ring.y0; y <= ring.y1; y++) {
    for (let x = ring.x0; x <= ring.x1; x++) {
      if (!onRing(ring, x, y)) continue;
      if (x < 0 || y < 0 || x >= state.width || y >= state.height) continue;
      const i = y * state.width + x;
      if (state.structure[i] !== Structure.Empty) continue;
      if (state.islandId[i] !== islandId) continue;
      gaps.push({ x, y });
    }
  }
  return gaps;
}
