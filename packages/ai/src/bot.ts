import { defaultAiConfig, type AiConfig, type BotProfile } from '@rampart/config';
import {
  Structure,
  canPlaceCannon,
  canPlacePiece,
  currentPieceId,
  distanceSquared,
  pieceById,
  pieceCells,
  type Action,
  type MatchState,
  type Rng,
} from '@rampart/sim';

import {
  cannonRoom,
  cheapestPlanFor,
  thickenTargets,
  weakestWall,
  type SealPlan,
} from './tactics.js';

/** How long a bot waits before looking again when it found nothing to do. */
const IDLE_RETRY_MS = 250;

export const DIFFICULTIES = ['recruit', 'gunner', 'marshal'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/**
 * A bot.
 *
 * It plays through the same validated action API as a person, so it cannot cheat by
 * construction, and it acts at a human pace rather than a machine one: placement and
 * firing are limited by time in milliseconds, not by a per-tick probability.
 *
 * Within a build phase it works down a ladder — stay alive, then make room, then take
 * more ground, then thicken what it has — which is roughly the order a person's
 * attention goes.
 */
export class Bot {
  private readonly profile: BotProfile;

  private plan: number[] = [];
  private plannedAt = -1;
  private planRound = -1;
  /** Cut tiles no piece could reach; the next plan routes around them. */
  private unreachable = new Set<number>();

  private nextPlacementTick = 0;
  private nextCannonTick = 0;
  private nextShotTick = 0;
  private breach: number[] = [];
  private breachedAt = -1;

  constructor(
    readonly playerId: number,
    readonly difficulty: Difficulty = 'gunner',
    ai: AiConfig = defaultAiConfig,
  ) {
    const profile = ai.profiles[difficulty];
    if (!profile) throw new Error(`no bot profile configured for "${difficulty}"`);
    this.profile = profile;
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

  // ------------------------------------------------------------------ timing

  private ticks(ms: number, state: MatchState): number {
    return Math.max(1, Math.round((ms * state.ruleset.tickRateHz) / 1000));
  }

  /** Stands down briefly after a fruitless look, rather than retrying every tick. */
  private pause(state: MatchState): void {
    this.nextPlacementTick = state.tick + this.ticks(IDLE_RETRY_MS, state);
  }

  /** How long this bot takes over a piece; a larger shape takes longer to fit. */
  private placementMs(cells: number): number {
    return this.profile.placementBaseMs + this.profile.placementPerCellMs * cells;
  }

  /**
   * Pieces it could still lay before the phase ends.
   *
   * This is what turns "should I reach for a second castle?" from a guess into a
   * question with an answer: a slower bot is correctly more cautious, because it
   * genuinely has fewer pieces left to spend.
   */
  private piecesAffordable(state: MatchState): number {
    const ticksLeft = Math.max(0, state.phaseEndTick - state.tick);
    const msLeft = (ticksLeft * 1000) / state.ruleset.tickRateHz;
    const averagePiece = this.placementMs(3.5);
    return msLeft / averagePiece;
  }

  // ------------------------------------------------------------------ combat

  private shoot(state: MatchState, rng: Rng): Action | null {
    if (state.tick < this.nextShotTick) return null;

    // Never ask to fire a gun that is still reloading: the rules would refuse it.
    let ready = false;
    for (const cannon of state.cannons) {
      if (cannon.owner === this.playerId && cannon.active && cannon.shotId === null) {
        ready = true;
        break;
      }
    }
    if (!ready) return null;

    const target = this.pickTarget(state, rng);
    this.nextShotTick = state.tick + this.ticks(this.profile.fireIntervalMs, state);
    return target;
  }

  private pickTarget(state: MatchState, rng: Rng): Action | null {
    if (rng.nextFloat() >= this.profile.aimJitter) {
      if (state.tick - this.breachedAt > 20 || this.breach.length === 0) {
        this.breach = weakestWall(state, this.chooseOpponent(state, rng));
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
  private chooseOpponent(state: MatchState, rng: Rng): number {
    const rivals = state.players.filter((p) => p.id !== this.playerId && !p.eliminated);
    if (rivals.length === 0) return this.playerId;
    if (!this.profile.picksTarget) {
      return (rivals[rng.nextInt(rivals.length)] as (typeof rivals)[number]).id;
    }
    let best = rivals[0] as (typeof rivals)[number];
    const score = (p: typeof best): number =>
      p.enclosedCastles * 10 + state.cannons.filter((c) => c.owner === p.id && c.active).length;
    for (const rival of rivals) if (score(rival) > score(best)) best = rival;
    return best.id;
  }

  // ------------------------------------------------------------------- build

  private build(state: MatchState, rng: Rng): Action | null {
    void rng;
    // Check the clock before anything else: this runs for every bot on every tick,
    // and looking the piece up first made that lookup the bot's largest single cost.
    if (state.tick < this.nextPlacementTick) return null;
    const pieceId = currentPieceId(state, this.playerId);

    // Last round's dead ends mean nothing now that the board has changed.
    if (this.planRound !== state.round) {
      this.planRound = state.round;
      this.unreachable.clear();
      this.plan = [];
      this.plannedAt = -1;
    }

    if (this.plannedAt < 0 || state.tick - this.plannedAt > this.profile.replanTicks) {
      this.plan = this.decide(state);
      this.plannedAt = state.tick;
    }

    const wanted = this.plan.filter((i) => state.structure[i] === Structure.Empty);
    if (wanted.length === 0) {
      this.pause(state);
      return null;
    }

    const placement = this.fit(state, pieceId, wanted);
    if (placement === null) {
      // Nothing legal reaches any of these tiles — a gap with no free neighbours
      // cannot take a piece. Rule them out so the next plan routes around them.
      for (const tile of wanted) this.unreachable.add(tile);
      this.plannedAt = -1;
      // And wait before trying again. Forcing a replan without also standing down
      // meant re-planning on every tick, which cost more than the entire rest of
      // the match put together.
      this.pause(state);
      return null;
    }

    this.nextPlacementTick =
      state.tick + this.ticks(this.placementMs(pieceById(pieceId).size), state);
    return { kind: 'place_piece', player: this.playerId, ...placement };
  }

  /**
   * What to build, in order of what would hurt most to be without.
   *
   * 1. Stay alive. Enclose something, or everything else is moot.
   * 2. Make room. Cannons need sealed 2x2 ground; without it the reward is unspendable.
   * 3. Take more ground. Another castle is another cannon a round, and a spare life.
   * 4. Thicken. A minimum cut is one block thick, so every block of it is load-bearing.
   */
  private decide(state: MatchState): number[] {
    const player = state.players[this.playerId];
    if (!player) return [];
    const sealed = player.enclosedCastles;
    const budget = this.piecesAffordable(state) * this.profile.riskMargin;
    const affordable = (plan: SealPlan | null): boolean =>
      plan !== null && plan.cost / 3.5 <= budget;

    if (sealed === 0) {
      // Reaching for two castles while unenclosed is the real gamble: it is more
      // cannons if it lands and elimination if it does not. Only when it clearly fits.
      if (this.profile.maxCastles > 1) {
        const bold = cheapestPlanFor(
          state,
          this.playerId,
          2,
          this.profile.maxCastles,
          this.unreachable,
        );
        if (affordable(bold)) return (bold as SealPlan).tiles;
      }
      const safe = cheapestPlanFor(
        state,
        this.playerId,
        1,
        this.profile.maxCastles,
        this.unreachable,
      );
      return safe?.tiles ?? [];
    }

    const needsRoom = cannonRoom(state, this.playerId) <= player.cannonsToPlace + 1;
    const wantsMore = sealed < this.profile.maxCastles;

    if (needsRoom || wantsMore) {
      const bigger = cheapestPlanFor(
        state,
        this.playerId,
        sealed + 1,
        this.profile.maxCastles,
        this.unreachable,
      );
      if (affordable(bigger)) return (bigger as SealPlan).tiles;
    }

    const thicken = thickenTargets(state, this.playerId);
    if (thicken.length > 0) return thicken;

    // Still standing, nowhere obvious to improve: hold the current wall.
    const hold = cheapestPlanFor(
      state,
      this.playerId,
      1,
      this.profile.maxCastles,
      this.unreachable,
    );
    return hold?.tiles ?? [];
  }

  /** The placement that covers most of what is wanted, proposed from the tiles themselves. */
  private fit(
    state: MatchState,
    pieceId: number,
    wanted: readonly number[],
  ): { x: number; y: number; rotation: number } | null {
    let best: { x: number; y: number; rotation: number } | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    const target = new Set(wanted);

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
          // Spill never weakens a wall, but a block on the plan is worth far more.
          const score = covered * 4 - (cells.length - covered);
          if (score > bestScore) {
            bestScore = score;
            best = { x, y, rotation };
          }
        }
      }
      if (bestScore >= pieceCells(pieceId, 0).length * 4) break;
    }
    return best;
  }

  // ------------------------------------------------------------------ castles

  /** The castle that is cheapest to wall, which on a rough island is several phases of work. */
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
      const plan = cheapestPlanFor(
        { ...state, castles: [castle] } as MatchState,
        this.playerId,
        1,
        1,
      );
      const cost = plan?.cost ?? Number.MAX_SAFE_INTEGER;
      if (cost < bestCost) {
        bestCost = cost;
        best = castle;
      }
    }
    return { kind: 'select_castle', player: this.playerId, castleId: best.id };
  }

  /**
   * Cannons go as close to the enemy as the walls allow: flight time scales with
   * distance and a cannon cannot fire again until its shot lands, so a gun ten tiles
   * nearer is simply a faster gun.
   */
  private placeCannon(state: MatchState, rng: Rng): Action | null {
    const player = state.players[this.playerId];
    if (!player || player.cannonsToPlace <= 0) return null;
    // Siting a gun takes a person a moment too, and without this the search below ran
    // on every tick of a 25-second phase.
    if (state.tick < this.nextCannonTick) return null;
    this.nextCannonTick = state.tick + this.ticks(this.profile.placementBaseMs, state);

    const enemies = state.castles.filter((c) => c.islandId !== player.islandId);
    let best: { x: number; y: number } | null = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        if (state.territory[y * state.width + x] !== player.islandId) continue;
        if (canPlaceCannon(state, this.playerId, x, y) !== null) continue;
        let nearest = Number.MAX_SAFE_INTEGER;
        for (const enemy of enemies) {
          nearest = Math.min(nearest, distanceSquared(x, y, enemy.x, enemy.y));
        }
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
