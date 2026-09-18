import {
  Structure,
  canPlaceCannon,
  canPlacePiece,
  currentPieceId,
  distanceSquared,
  pieceCells,
  type Action,
  type MatchState,
  type Rng,
} from '@rampart/sim';

import { bestSealPlan, weakestWall, type SealPlan } from './tactics.js';

export const DIFFICULTIES = ['recruit', 'gunner', 'marshal'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface DifficultyProfile {
  /** Chance per tick of taking a shot; the reload is the real limit. */
  fireChance: number;
  /** Chance per tick of laying a block. */
  buildChance: number;
  /** Chance of shooting somewhere other than the weak point. */
  aimJitter: number;
  /** How many castles it will try to bring inside one wall. */
  ambition: number;
  /** Ticks between recomputing the sealing plan. */
  replanTicks: number;
  /** Whether it picks off the strongest opponent rather than firing at random. */
  picksTarget: boolean;
}

export const PROFILES: Record<Difficulty, DifficultyProfile> = {
  recruit: {
    fireChance: 0.1,
    buildChance: 0.08,
    aimJitter: 0.7,
    ambition: 1,
    replanTicks: 60,
    picksTarget: false,
  },
  gunner: {
    fireChance: 0.16,
    buildChance: 0.14,
    aimJitter: 0.25,
    ambition: 1,
    replanTicks: 30,
    picksTarget: true,
  },
  marshal: {
    fireChance: 0.2,
    buildChance: 0.2,
    aimJitter: 0.05,
    ambition: 2,
    replanTicks: 15,
    picksTarget: true,
  },
};

/**
 * A bot.
 *
 * It plays through exactly the same validated action API as a person, so it cannot
 * cheat by construction — it can only ask for things the rules already allow, and the
 * server checks its moves the same way it checks anyone's.
 *
 * It keeps a little state between ticks, which is what separates it from the stopgap
 * it replaces: a plan for the wall it is building, and a queue of blocks to knock out
 * of somebody else's.
 */
export class Bot {
  private plan: SealPlan | null = null;
  private plannedAt = -1;
  /** Cut tiles no piece could reach; the next plan routes around them. */
  private unreachable = new Set<number>();
  private buildPhaseRound = -1;
  private breach: number[] = [];
  private breachedAt = -1;

  constructor(
    readonly playerId: number,
    readonly difficulty: Difficulty = 'gunner',
  ) {}

  private get profile(): DifficultyProfile {
    return PROFILES[this.difficulty];
  }

  think(state: MatchState, rng: Rng): Action | null {
    const player = state.players[this.playerId];
    if (!player || player.eliminated) return null;

    switch (state.phase) {
      case 'castle_select':
        return this.chooseCastle(state, rng);
      case 'combat':
        return this.shoot(state, rng);
      case 'build':
        return this.build(state, rng);
      case 'cannon_place':
        return this.placeCannon(state, rng);
      default:
        return null;
    }
  }

  /**
   * Picks the castle that is cheapest to wall, rather than one at random. On a rough
   * island that difference is several build phases of work.
   */
  private chooseCastle(state: MatchState, rng: Rng): Action | null {
    const player = state.players[this.playerId];
    if (!player || player.startingCastleId !== null) return null;
    const mine = state.castles.filter((c) => c.islandId === player.islandId);
    if (mine.length === 0) return null;

    if (this.difficulty === 'recruit') {
      const pick = mine[rng.nextInt(mine.length)];
      return pick ? { kind: 'select_castle', player: this.playerId, castleId: pick.id } : null;
    }

    let best = mine[0] as (typeof mine)[number];
    let bestCost = Number.MAX_SAFE_INTEGER;
    for (const castle of mine) {
      const plan = bestSealPlan({ ...state, castles: [castle] } as MatchState, this.playerId, 1);
      const cost = plan?.cost ?? Number.MAX_SAFE_INTEGER;
      if (cost < bestCost) {
        bestCost = cost;
        best = castle;
      }
    }
    return { kind: 'select_castle', player: this.playerId, castleId: best.id };
  }

  private shoot(state: MatchState, rng: Rng): Action | null {
    // Do not ask to fire a gun that is still reloading. Scaling the rate with the
    // number of loaded guns was tried and made matches worse, but the guard itself
    // is simply correctness: an action the rules will refuse is a wasted request.
    let ready = false;
    for (const cannon of state.cannons) {
      if (cannon.owner === this.playerId && cannon.active && cannon.shotId === null) {
        ready = true;
        break;
      }
    }
    if (!ready) return null;
    if (rng.nextFloat() > this.profile.fireChance) return null;

    if (rng.nextFloat() >= this.profile.aimJitter) {
      if (state.tick - this.breachedAt > 20 || this.breach.length === 0) {
        this.breach = weakestWall(state, this.chooseTarget(state, rng));
        this.breachedAt = state.tick;
      }
      // Work along the thin part of their wall rather than scattering fire.
      while (this.breach.length > 0) {
        const i = this.breach[0] as number;
        if (state.structure[i] !== Structure.Wall) {
          this.breach.shift();
          continue;
        }
        const x = i % state.width;
        return { kind: 'fire', player: this.playerId, x, y: (i - x) / state.width };
      }
    }

    for (let attempt = 0; attempt < 40; attempt++) {
      const x = rng.nextInt(state.width);
      const y = rng.nextInt(state.height);
      const i = y * state.width + x;
      if (state.structure[i] !== Structure.Wall) continue;
      if (state.islandId[i] === state.players[this.playerId]?.islandId) continue;
      return { kind: 'fire', player: this.playerId, x, y };
    }
    return null;
  }

  /** The opponent closest to winning, so a leader is not left to run away with it. */
  private chooseTarget(state: MatchState, rng: Rng): number {
    const rivals = state.players.filter((p) => p.id !== this.playerId && !p.eliminated);
    if (rivals.length === 0) return this.playerId;
    if (!this.profile.picksTarget)
      return (rivals[rng.nextInt(rivals.length)] as (typeof rivals)[number]).id;

    let best = rivals[0] as (typeof rivals)[number];
    for (const rival of rivals) {
      const score = (p: typeof rival): number =>
        p.enclosedCastles * 10 + state.cannons.filter((c) => c.owner === p.id && c.active).length;
      if (score(rival) > score(best)) best = rival;
    }
    return best.id;
  }

  private build(state: MatchState, rng: Rng): Action | null {
    if (rng.nextFloat() > this.profile.buildChance) return null;

    // Last round's dead ends mean nothing now that the board has changed.
    if (this.buildPhaseRound !== state.round) {
      this.buildPhaseRound = state.round;
      this.unreachable.clear();
      this.plan = null;
    }

    if (this.plan === null || state.tick - this.plannedAt > this.profile.replanTicks) {
      this.plan = bestSealPlan(state, this.playerId, this.profile.ambition, this.unreachable);
      this.plannedAt = state.tick;
    }
    const wanted = this.plan?.tiles.filter((i) => state.structure[i] === Structure.Empty) ?? [];
    if (wanted.length === 0) return null;

    const pieceId = currentPieceId(state, this.playerId);
    let best: { x: number; y: number; rotation: number } | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    const target = new Set(wanted);

    // Propose placements from the tiles that need filling, rather than sampling the
    // map and hoping: a specific tile is a needle in six thousand.
    for (const tile of wanted) {
      const tx = tile % state.width;
      const ty = (tile - tx) / state.width;
      for (let rotation = 0; rotation < 4; rotation++) {
        const cells = pieceCells(pieceId, rotation);
        for (const [ox, oy] of cells) {
          const x = tx - ox;
          const y = ty - oy;
          if (canPlacePiece(state, this.playerId, rotation, x, y) !== null) continue;
          let covered = 0;
          for (const [cx, cy] of cells) {
            if (target.has((y + cy) * state.width + x + cx)) covered++;
          }
          // Spill is not harmful — extra wall never weakens a loop — but a block that
          // lands on the plan is worth far more than one that does not.
          const score = covered * 4 - (cells.length - covered);
          if (score > bestScore) {
            bestScore = score;
            best = { x, y, rotation };
          }
        }
      }
      if (bestScore >= pieceCells(pieceId, 0).length * 4) break;
    }

    if (best === null) {
      // Nothing legal reaches any of these tiles. Rather than jam against the same
      // hole for the rest of the phase, rule them out and let the next plan find a
      // different loop — there is almost always another way round.
      for (const tile of wanted) this.unreachable.add(tile);
      this.plan = null;
      return null;
    }
    return { kind: 'place_piece', player: this.playerId, ...best };
  }

  /**
   * Cannons go as close to the enemy as the walls allow: flight time scales with
   * distance and a cannon cannot fire again until its shot lands, so a gun ten tiles
   * nearer is simply a faster gun.
   */
  private placeCannon(state: MatchState, rng: Rng): Action | null {
    const player = state.players[this.playerId];
    if (!player || player.cannonsToPlace <= 0) return null;

    const enemies = state.castles.filter((c) => c.islandId !== player.islandId);
    let best: { x: number; y: number } | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        if (state.territory[y * state.width + x] !== player.islandId) continue;
        if (canPlaceCannon(state, this.playerId, x, y) !== null) continue;
        let nearest = Number.MAX_SAFE_INTEGER;
        for (const enemy of enemies)
          nearest = Math.min(nearest, distanceSquared(x, y, enemy.x, enemy.y));
        const score = -nearest + (this.difficulty === 'recruit' ? rng.nextFloat() * 5000 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
    }

    return best ? { kind: 'place_cannon', player: this.playerId, ...best } : null;
  }
}

/** Convenience for callers that keep no bot state, such as tests. */
export function botAction(
  state: MatchState,
  playerId: number,
  rng: Rng,
  difficulty: Difficulty = 'gunner',
): Action | null {
  return new Bot(playerId, difficulty).think(state, rng);
}
