import { defaultAiConfig, type AiConfig, type BotProfile } from '@rampart/config';
import {
  NEIGHBOURS_8,
  Structure,
  Terrain,
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
  sealOptions,
  thickenTargets,
  weakestWall,
  type SealPlan,
} from './tactics.js';

/** How long a bot waits before looking again when it found nothing to do. */
const IDLE_RETRY_MS = 250;

/** How far from a castle a cannon is taken to belong to it. */
const GUN_REACH = 12;

/**
 * Ground the wall must take in around each castle.
 *
 * Without it the planner returns the tightest wall that works, which is the wall with
 * no room inside for a gun.
 *
 * Two, not three, and the difference is not small. Three tiles buys a band with room
 * for about fourteen cannons against a reward of three a round — ground that has to be
 * walled and then repaired every round under fire, for guns that will never be built.
 * Marshal matches went from never finishing to finishing in 2.3 rounds, all three
 * players wiped out together in a barrage none of them could out-repair. At two the
 * band holds six or seven, the wall is short enough to maintain, and matches run four
 * rounds with nobody idle. Room is worth paying for; more room than the reward can
 * spend is just a longer bill.
 */
const ROOM_RADIUS = 3;

/**
 * Clearance a cannon wants between itself and the nearest wall or shore.
 *
 * A cannon jammed against its own wall is what makes a breach there unrepairable. The
 * hole a shot leaves has the cannon on one side and, on a coastal wall, water on the
 * other — so the only tile free to build in is the hole itself, and a piece is at
 * least two cells from round three on. The size schedule stops dealing ones after
 * round two, which turns a one-tile gap from awkward into permanent.
 *
 * Two tiles is enough to leave a piece somewhere to land.
 *
 * It buys nothing in the *opening*, and cannot: a castle sits centred in its starting
 * ring, so at `ringRadiusTiles: 3` the free interior is a band exactly two tiles wide
 * and a 2x2 cannon spans it completely. Surveyed directly — sixteen legal opening
 * spots, every one of them at clearance one. Widening the ring to 4 does make room, and
 * took two-player round-one eliminations from 2 in 12 to none, but an 8x8 starting wall
 * is what the original had and what the game is built around, so the ring stayed at 3.
 *
 * Where this does bite is every round after the first, once a player holds enough
 * ground to have a choice. Before it existed, all 120 opening cannons across twelve
 * matches sat against the wall, because proximity to the enemy was the only thing being
 * scored.
 */
const CANNON_CLEARANCE = 2;

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
        // A bot that has just spent a continue owes a castle before it owes anything
        // else: without one it has no territory, so no gun has anywhere to stand.
        if (state.players[this.playerId]?.startingCastleId === null) {
          return this.chooseCastle(state, rng);
        }
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

  /**
   * Tiles a shot is already on its way to.
   *
   * A shot destroys exactly the tile it hits, so a second shot at the same tile is
   * always wasted — and with a three-second flight and a gun firing every 150ms, a
   * bot that did not track this put its whole opening salvo into one block. Every
   * player's shots count, not just this bot's: a tile an opponent is about to remove
   * does not need removing twice either.
   */
  private inbound(state: MatchState): Set<number> {
    const taken = new Set<number>();
    for (const shot of state.shots) taken.add(shot.toY * state.width + shot.toX);
    return taken;
  }

  private pickTarget(state: MatchState, rng: Rng): Action | null {
    const taken = this.inbound(state);

    if (rng.nextFloat() >= this.profile.aimJitter) {
      if (state.tick - this.breachedAt > 20 || this.breach.length === 0) {
        this.breach = weakestWall(state, this.chooseOpponent(state, rng));
        this.breachedAt = state.tick;
      }
      // Work along the thin part of their wall rather than scattering fire — one shot
      // per block, moving on whether or not this one has landed yet.
      while (this.breach.length > 0) {
        const i = this.breach.shift() as number;
        if (state.structure[i] !== Structure.Wall || taken.has(i)) continue;
        const x = i % state.width;
        return { kind: 'fire', player: this.playerId, x, y: (i - x) / state.width };
      }
    }

    for (let attempt = 0; attempt < 40; attempt++) {
      const x = rng.nextInt(state.width);
      const y = rng.nextInt(state.height);
      const i = y * state.width + x;
      if (state.structure[i] !== Structure.Wall || taken.has(i)) continue;
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

    let wanted = this.plan.filter((i) => state.structure[i] === Structure.Empty);
    if (wanted.length === 0) {
      // The plan is already standing, and a bot that stops here watches the rest of
      // the phase go by. Measured: gunner and recruit laid 65% of the pieces they had
      // time for where marshal, which keeps finding expansions to afford, laid 106%.
      // Every piece not laid is wall they will wish they had when the barrage starts,
      // so spend the remainder thickening the thinnest part of what they hold.
      // Outward only, which `thickenTargets` already guarantees — a second layer laid
      // on the inside stands where a cannon could have stood.
      wanted = thickenTargets(state, this.playerId).filter(
        (i) => state.structure[i] === Structure.Empty,
      );
      if (wanted.length === 0) wanted = this.spareWork(state);
      if (wanted.length === 0) {
        this.pause(state);
        return null;
      }
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
   * What to build once the plan is standing and there is nothing left to thicken.
   *
   * Idling is almost never right. A build phase the bot does not spend is wall it will
   * wish it had, and the two things worth starting are both worth starting even when
   * they cannot be finished this round: a part-built extension of a live wall still
   * touches territory, so the sweep leaves it standing and the work carries over into
   * the next phase. That is the difference between an expansion that takes two rounds
   * and one that never happens.
   *
   * Affordability is deliberately not consulted here. It governs whether to *commit*
   * to a plan over staying alive, which is the gamble section 10d found you must not
   * take. Spending time nobody else wants is not that gamble.
   */
  private spareWork(state: MatchState): number[] {
    const player = state.players[this.playerId];
    if (player === undefined) return [];
    const sealed = player.enclosedCastles;

    // Another castle is another cannon a round and a spare life. Start it even if this
    // phase cannot close it.
    if (sealed < this.profile.maxCastles) {
      const next = cheapestPlanFor(
        state,
        this.playerId,
        sealed + 1,
        this.profile.maxCastles,
        this.unreachable,
        true,
        ROOM_RADIUS,
      );
      const tiles = next?.tiles.filter((i) => state.structure[i] === Structure.Empty) ?? [];
      if (tiles.length > 0) return tiles;
    }

    // No castle worth reaching for: take in more open ground instead, which is where
    // the cannons this wall earns will have to stand.
    const roomier = cheapestPlanFor(
      state,
      this.playerId,
      Math.max(1, sealed),
      this.profile.maxCastles,
      this.unreachable,
      true,
      ROOM_RADIUS + 2,
    );
    return roomier?.tiles.filter((i) => state.structure[i] === Structure.Empty) ?? [];
  }

  /**
   * The widest wall this phase can pay for, rather than the tightest one that works.
   *
   * This is the correction to the planner's central bias. A minimum cut is by
   * definition the *tightest* wall that works, so asking it for a wall and taking what
   * it returns means always choosing the one with nowhere to put a gun — a bot that
   * defends perfectly, cannot spend a single cannon it earns, and cannot win. Measured
   * before this existed: gunner and marshal held room for 0.3 cannons behind a 37-tile
   * ring, with half their guns idle.
   *
   * So room is asked for first and surrendered only to the budget, one tile of band at
   * a time. A tight wall is still reachable, as the last rung rather than the first.
   */
  private widestAffordable(
    state: MatchState,
    atLeastCastles: number,
    keepCannons: boolean,
    budget: number,
  ): SealPlan | null {
    for (let radius = ROOM_RADIUS; radius >= 0; radius--) {
      const plan = cheapestPlanFor(
        state,
        this.playerId,
        atLeastCastles,
        this.profile.maxCastles,
        this.unreachable,
        keepCannons,
        radius,
      );
      if (plan !== null && plan.cost / 3.5 <= budget) return plan;
    }
    return null;
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
        const bold = this.widestAffordable(state, 2, false, budget);
        if (bold !== null) return bold.tiles;
      }
      return this.reseal(state, budget);
    }

    // cannonsToPlace is zero throughout a build phase — it is set at the resolution
    // that ends it — so asking whether there is room for it always said yes. What
    // matters is the reward this wall is about to earn.
    const { firstCastleReward, perAdditionalCastleReward } = state.ruleset.cannons;
    const earning = firstCastleReward + Math.max(0, sealed - 1) * perAdditionalCastleReward;
    const needsRoom = cannonRoom(state, this.playerId) < earning + 2;

    // Guns left outside the wall are the thing most worth fixing. When one of two
    // enclosures is breached the sweep takes that whole wall, and its cannons are
    // stranded on open ground — silent, and expensive to reach. A single build phase
    // rarely pays for the wall that recovers them, so the bot commits across phases
    // instead: a part-built extension of a live wall still touches territory, so the
    // sweep leaves it standing and the work carries over. Without this, two bots
    // grind each other down to no firepower at all and the match never ends.
    let owned = 0;
    let firing = 0;
    for (const cannon of state.cannons) {
      if (cannon.owner !== this.playerId) continue;
      owned++;
      if (cannon.active) firing++;
    }
    if (owned >= 3 && firing * 2 < owned) {
      const recover = cheapestPlanFor(
        state,
        this.playerId,
        1,
        this.profile.maxCastles,
        this.unreachable,
        true,
        ROOM_RADIUS,
      );
      if (recover !== null) return recover.tiles;
    }
    const wantsMore = sealed < this.profile.maxCastles;

    if (needsRoom || wantsMore) {
      const bigger = cheapestPlanFor(
        state,
        this.playerId,
        sealed + 1,
        this.profile.maxCastles,
        this.unreachable,
        true,
        ROOM_RADIUS,
      );
      if (affordable(bigger)) return (bigger as SealPlan).tiles;
    }

    // Only thicken when there is somewhere to put the guns. Otherwise a bot spends
    // the phase making its wall stouter and its arsenal smaller, which is how a match
    // turns into two impregnable castles with nothing to shoot at each other.
    if (!needsRoom) {
      const thicken = thickenTargets(state, this.playerId);
      if (thicken.length > 0) return thicken;
    }

    // Still standing, nowhere obvious to improve: hold the current wall — but hold the
    // roomy version of it. This is the branch a settled bot spends most of the match in,
    // so a tight plan here is not one bad round, it is the shape the bot converges on.
    const hold =
      this.widestAffordable(state, 1, true, budget) ??
      cheapestPlanFor(state, this.playerId, 1, this.profile.maxCastles, this.unreachable);
    return hold?.tiles ?? [];
  }

  /**
   * Chooses which castle to wall when nothing is enclosed.
   *
   * Cheapest is the obvious answer and the wrong one. A cannon only fires from inside
   * sealed ground, so walling a fresh castle across the island abandons every gun the
   * bot owns: it survives the round with no firepower, and so does whoever breached
   * it. Two bots doing that to each other is precisely the stalemate that looks like
   * thick walls and no guns — measured at two active cannons out of sixteen.
   *
   * So a wall that takes back the ground the guns are standing on is worth paying
   * more for.
   */
  private reseal(state: MatchState, budget: number): number[] {
    // First ask for a wall that keeps the guns, with room inside it for the ones this
    // round is about to earn. Taking the cheapest gun-keeping plan instead was the
    // same mistake in a different place: it saved the artillery it had and left
    // nowhere to stand the artillery it was owed. If even a tight version is more
    // than this phase can build, fall back to merely surviving — a silent cannon
    // still beats elimination.
    const withGuns = this.widestAffordable(state, 1, true, budget);
    if (withGuns !== null) return withGuns.tiles;

    // Which of this bot's guns stand near the castles a wall would take in. Not which
    // castles were sealed last round: after a breach that is nothing at all, which is
    // exactly the moment the choice matters most.
    const gunsKept = (plan: SealPlan): number =>
      state.cannons.filter(
        (cannon) =>
          cannon.owner === this.playerId &&
          plan.castleIds.some((id) => {
            const castle = state.castles[id];
            return (
              castle !== undefined &&
              Math.abs(cannon.x - castle.x) <= GUN_REACH &&
              Math.abs(cannon.y - castle.y) <= GUN_REACH
            );
          }),
      ).length;

    // Widest first here too, so giving up room is a concession to the budget rather
    // than the default. Within a radius the choice is between castles, and a gun
    // recovered is worth a few extra blocks of wall.
    let cheapest: SealPlan | null = null;
    for (let radius = ROOM_RADIUS; radius >= 0; radius--) {
      const options = sealOptions(
        state,
        this.playerId,
        this.profile.maxCastles,
        this.unreachable,
        false,
        radius,
      );
      let best: SealPlan | null = null;
      let bestValue = -Infinity;
      for (const plan of options) {
        // sealOptions is sorted by cost, so the first plan at radius 0 is the
        // cheapest wall that exists — the last resort below.
        if (cheapest === null || plan.cost < cheapest.cost) cheapest = plan;
        if (plan.cost / 3.5 > budget) continue;
        const value = gunsKept(plan) * 3 - plan.cost / 3.5;
        if (value > bestValue) {
          bestValue = value;
          best = plan;
        }
      }
      if (best !== null) return best.tiles;
    }

    // Nothing fits the budget at any width. Build toward the cheapest wall on the
    // board anyway rather than the roomiest: an unfinished wall encloses nothing, the
    // sweep takes the lot, and a phase spent on a plan that could never close is how
    // a bot ends a round with fourteen pieces laid and no wall at all.
    return cheapest?.tiles ?? [];
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
    const islandId = state.players[this.playerId]?.islandId;

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
          let indoors = 0;
          for (const [cx, cy] of cells) {
            const i = (y + cy) * state.width + x + cx;
            if (target.has(i)) covered++;
            else if (state.territory[i] === islandId) indoors++;
          }
          // Spill outside is merely wasted. Spill inside is worse than wasted: it
          // occupies sealed ground, which is the only place a cannon may go, and a
          // wall with no guns behind it wins nothing.
          const score = covered * 4 - (cells.length - covered) - indoors * 5;
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
    // Last round's plan described an island that no longer exists: a continue wipes it.
    this.plan = [];
    this.plannedAt = -1;
    this.unreachable.clear();
    const mine = state.castles.filter((c) => c.islandId === player.islandId);
    if (mine.length === 0) return null;

    if (this.difficulty === 'recruit') {
      const pick = mine[rng.nextInt(mine.length)];
      return pick ? { kind: 'select_castle', player: this.playerId, castleId: pick.id } : null;
    }

    // Cheapest to wall is the obvious measure and a trap: it scores a castle by how
    // tightly it can be strangled, and so picks the one with the least ground around
    // it. Costing the wall that leaves room for guns instead picks a castle worth
    // holding. Falls back to the bare cost only if no castle has room at all, since
    // an unwallable start is worse than a cramped one.
    const pick = (roomRadius: number): (typeof mine)[number] | null => {
      let best: (typeof mine)[number] | null = null;
      let bestCost = Number.MAX_SAFE_INTEGER;
      for (const castle of mine) {
        const plan = cheapestPlanFor(
          { ...state, castles: [castle] } as MatchState,
          this.playerId,
          1,
          1,
          undefined,
          false,
          roomRadius,
        );
        if (plan === null || plan.cost >= bestCost) continue;
        bestCost = plan.cost;
        best = castle;
      }
      return best;
    };

    const best = pick(ROOM_RADIUS) ?? pick(0) ?? (mine[0] as (typeof mine)[number]);
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
    const hazard = this.clearanceField(state, player.islandId);
    const [cw, ch] = state.ruleset.cannons.footprint;

    let best: { x: number; y: number } | null = null;
    // Room first, then proximity: compared as a pair rather than summed, so there is no
    // exchange rate to invent between tiles of clearance and tiles of range.
    let bestRoom = -1;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        if (state.territory[y * state.width + x] !== player.islandId) continue;
        if (canPlaceCannon(state, this.playerId, x, y) !== null) continue;

        let clear = Number.MAX_SAFE_INTEGER;
        for (let oy = 0; oy < ch; oy++) {
          for (let ox = 0; ox < cw; ox++) {
            clear = Math.min(clear, hazard[(y + oy) * state.width + x + ox] as number);
          }
        }
        // Capped, because clearance beyond this buys nothing and every extra tile of it
        // is a tile of range given away.
        const room = Math.min(clear, CANNON_CLEARANCE);

        let nearest = Number.MAX_SAFE_INTEGER;
        for (const enemy of enemies) {
          nearest = Math.min(nearest, distanceSquared(x, y, enemy.x, enemy.y));
        }
        const score = -nearest + (this.difficulty === 'recruit' ? rng.nextFloat() * 5000 : 0);

        if (room > bestRoom || (room === bestRoom && score > bestScore)) {
          bestRoom = room;
          bestScore = score;
          best = { x, y };
        }
      }
    }
    return best ? { kind: 'place_cannon', player: this.playerId, ...best } : null;
  }

  /**
   * Chebyshev distance from every tile to the nearest thing a cannon should stand off
   * from: this player's own wall, or water.
   *
   * Own wall, because that is what has to be repaired under fire. Water, because a wall
   * that runs along the coast has nothing behind it either — a cannon pressed against
   * the shore leaves the future wall there the same one-tile gap.
   *
   * Eight-connected unit steps, which is exactly Chebyshev distance, and one pass over
   * the board rather than a scan per candidate.
   */
  private clearanceField(state: MatchState, islandId: number): Int32Array {
    const size = state.width * state.height;
    const dist = new Int32Array(size).fill(0x7fffffff);
    const queue = new Int32Array(size);
    let tail = 0;

    for (let i = 0; i < size; i++) {
      const hazard =
        state.terrain[i] === Terrain.Water ||
        (state.structure[i] === Structure.Wall && state.islandId[i] === islandId);
      if (!hazard) continue;
      dist[i] = 0;
      queue[tail++] = i;
    }

    for (let head = 0; head < tail; head++) {
      const i = queue[head] as number;
      const x = i % state.width;
      const y = (i - x) / state.width;
      const next = (dist[i] as number) + 1;
      for (const [ox, oy] of NEIGHBOURS_8) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) continue;
        const j = ny * state.width + nx;
        if (dist[j] !== 0x7fffffff) continue;
        dist[j] = next;
        queue[tail++] = j;
      }
    }
    return dist;
  }
}
