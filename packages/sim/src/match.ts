import type { Ruleset, TerrainConfig } from '@rampart/config';

import { applyEnclosure } from './enclosure.js';
import { sweepOrphanedWalls } from './sweep.js';
import { Hasher } from './hash.js';
import {
  canPlaceAnyCannon,
  legalCannonPlacements,
  placeCannon,
  placePiece,
  type Rejection,
} from './placement.js';
import { streamFor } from './rng.js';
import { fire, resolveImpacts } from './shots.js';
import { generateTerrain } from './terrain.js';
import {
  PHASES,
  Structure,
  type Action,
  type Castle,
  type LoggedAction,
  type MatchState,
  type Phase,
  type PlayerState,
  type RoundResult,
} from './types.js';

export interface MatchPlayerOptions {
  name: string;
  isBot: boolean;
}

export interface MatchOptions {
  seed: number;
  ruleset: Ruleset;
  terrainConfig: TerrainConfig;
  players: readonly MatchPlayerOptions[];
}

export function ticksFor(ms: number, tickRateHz: number): number {
  return Math.ceil((ms * tickRateHz) / 1000);
}

export function createMatch(options: MatchOptions): MatchState {
  const { seed, ruleset, terrainConfig } = options;
  const playerCount = options.players.length;
  if (playerCount < ruleset.players.min || playerCount > ruleset.players.max) {
    throw new RangeError(
      `match needs ${ruleset.players.min}-${ruleset.players.max} players, got ${playerCount}`,
    );
  }

  const generated = generateTerrain(terrainConfig, playerCount, seed);
  const size = generated.width * generated.height;

  const players: PlayerState[] = options.players.map((p, id) => ({
    id,
    islandId: id + 1,
    name: p.name,
    isBot: p.isBot,
    eliminated: false,
    eliminatedRound: null,
    startingCastleId: null,
    enclosedCastles: 0,
    cannonsToPlace: 0,
    pieceIndex: 0,
    continuesRemaining: options.ruleset.elimination.continues,
    pieceRound: 0,
    score: 0,
    wallsDestroyed: 0,
  }));

  const structure = new Uint8Array(size);
  const owner = new Uint8Array(size);
  const castles: Castle[] = generated.castles.map((c, id) => ({ ...c, id, enclosed: false }));
  for (const castle of castles) {
    for (let oy = 0; oy < castle.h; oy++) {
      for (let ox = 0; ox < castle.w; ox++) {
        const i = (castle.y + oy) * generated.width + castle.x + ox;
        structure[i] = Structure.Castle;
        owner[i] = castle.islandId;
      }
    }
  }

  const state: MatchState = {
    seed,
    ruleset,
    terrainConfig,
    width: generated.width,
    height: generated.height,
    tick: 0,
    round: 0,
    phase: 'intermission',
    phaseEndTick: intermissionTicks(ruleset),
    pendingPhase: 'castle_select',
    players,
    terrain: generated.terrain,
    islandId: generated.islandId,
    structure,
    owner,
    territory: new Uint8Array(size),
    castles,
    cannons: [],
    shots: [],
    nextCannonId: 0,
    nextShotId: 0,
    winners: [],
    draw: false,
    endedBy: null,
    events: [],
  };

  state.events.push({
    kind: 'phase_changed',
    tick: 0,
    phase: state.phase,
    round: 0,
    phaseEndTick: state.phaseEndTick,
    pendingPhase: state.pendingPhase,
  });
  return state;
}

function intermissionTicks(ruleset: Ruleset): number {
  return (
    ticksFor(ruleset.phases.endOfPhasePauseMs, ruleset.tickRateHz) +
    ticksFor(ruleset.phases.transitionBannerMs, ruleset.tickRateHz)
  );
}

function enterPhase(state: MatchState, phase: Phase, durationMs: number): void {
  state.phase = phase;
  state.pendingPhase = null;
  state.phaseEndTick = state.tick + ticksFor(durationMs, state.ruleset.tickRateHz);
  state.events.push({
    kind: 'phase_changed',
    tick: state.tick,
    phase,
    round: state.round,
    phaseEndTick: state.phaseEndTick,
    pendingPhase: null,
  });
}

/**
 * Steps out of a phase and into the gap before the next one.
 *
 * Nothing is playable here. Shots still in the air land and play out, then a pause,
 * then the announcement crosses the screen — and only once it has left does the next
 * phase begin. Without this the build phase would start under a banner the player is
 * still reading, with cannonballs from the last volley still landing on it.
 */
function enterIntermission(state: MatchState, next: Phase): void {
  state.phase = 'intermission';
  state.pendingPhase = next;
  state.phaseEndTick = state.tick + intermissionTicks(state.ruleset);
  state.events.push({
    kind: 'phase_changed',
    tick: state.tick,
    phase: 'intermission',
    round: state.round,
    phaseEndTick: state.phaseEndTick,
    pendingPhase: next,
  });
}

/**
 * Whether this player still has a castle to choose.
 *
 * True at the start of a match, and true again after a continue — the same question in
 * both cases, so it is the same predicate. A player in this state has no territory at
 * all, which is why the cannon phase has to treat them as unfinished rather than as
 * having nowhere left to build.
 */
export function owesCastleChoice(player: PlayerState): boolean {
  return !player.eliminated && player.startingCastleId === null;
}

export function alivePlayers(state: MatchState): PlayerState[] {
  return state.players.filter((p) => !p.eliminated);
}

/** Lays the auto-built wall ring around a player's chosen castle. */
function buildStartingRing(state: MatchState, castle: Castle): void {
  const ring = state.terrainConfig.startingWall.ringRadiusTiles;
  const x0 = castle.x - ring;
  const y0 = castle.y - ring;
  const x1 = castle.x + castle.w - 1 + ring;
  const y1 = castle.y + castle.h - 1 + ring;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const onBorder = x === x0 || x === x1 || y === y0 || y === y1;
      if (!onBorder) continue;
      if (x < 0 || y < 0 || x >= state.width || y >= state.height) continue;
      const i = y * state.width + x;
      if (state.structure[i] !== Structure.Empty) continue;
      state.structure[i] = Structure.Wall;
      state.owner[i] = castle.islandId;
    }
  }
}

function finishCastleSelect(state: MatchState): void {
  for (const player of state.players) {
    if (player.startingCastleId !== null) continue;
    // Timed out: take the lowest-numbered castle on this player's island, so an
    // absent or disconnected player still starts a valid game.
    const fallback = state.castles.find((c) => c.islandId === player.islandId);
    if (!fallback) continue;
    player.startingCastleId = fallback.id;
    buildStartingRing(state, fallback);
  }

  applyEnclosure(state);

  // The opening cannons are placed by the player, exactly like every later batch.
  // Round 0 here; the first combat phase starts round 1 via startNextCombat.
  state.round = 0;
  for (const player of state.players) {
    player.cannonsToPlace = state.ruleset.cannons.startingCount;
  }
  enterIntermission(state, 'cannon_place');
}

/** Clears an eliminated player's cannons and leaves their walls as neutral rubble. */
/**
 * Clears everything a player built, for a continue: cannons, shots in the air, and the
 * wall itself.
 *
 * Stronger than `stripEliminated`, which leaves an eliminated player's wall standing as
 * unowned rubble — reasonable for someone who is out, wrong for someone about to build
 * again, who would otherwise have to plan around the wreck of their last attempt.
 */
function wipeIsland(state: MatchState, playerId: number): void {
  const player = state.players[playerId] as PlayerState;
  stripEliminated(state, playerId);
  for (let i = 0; i < state.structure.length; i++) {
    if (state.islandId[i] !== player.islandId) continue;
    if (state.structure[i] === Structure.Wall) {
      state.structure[i] = Structure.Empty;
      state.owner[i] = 0;
    }
  }
}

function stripEliminated(state: MatchState, playerId: number): void {
  const islandId = (state.players[playerId] as PlayerState).islandId;
  state.cannons = state.cannons.filter((cannon) => {
    if (cannon.owner !== playerId) return true;
    for (let oy = 0; oy < cannon.h; oy++) {
      for (let ox = 0; ox < cannon.w; ox++) {
        const i = (cannon.y + oy) * state.width + cannon.x + ox;
        state.structure[i] = Structure.Empty;
        state.owner[i] = 0;
      }
    }
    return false;
  });
  state.shots = state.shots.filter((shot) => shot.owner !== playerId);
  for (let i = 0; i < state.owner.length; i++) {
    if (state.owner[i] === islandId && state.structure[i] === Structure.Wall) state.owner[i] = 0;
  }
}

/**
 * Whether the match ends at this resolution, and if so who won.
 *
 * Outlasting everyone wins however the scores stand. At the cap the highest score
 * among those still in wins, and a tie is shared — a player who is out never wins on
 * points, which is what keeps attacking worth it for somebody behind.
 */
function checkGameOver(state: MatchState): boolean {
  const alive = alivePlayers(state);
  const { maxRounds } = state.ruleset.scoring;
  const capped = maxRounds !== null && state.round >= maxRounds;
  if (alive.length > 1 && !capped) return false;
  state.pendingPhase = null;
  if (alive.length > 1) {
    const top = Math.max(...alive.map((p) => p.score));
    state.winners = alive.filter((p) => p.score === top).map((p) => p.id);
    state.draw = false;
    state.endedBy = 'round_cap';
  } else {
    state.winners = alive.map((p) => p.id);
    state.draw = alive.length === 0 && state.ruleset.elimination.simultaneousIsDraw;
    state.endedBy = 'elimination';
  }
  state.phase = 'game_over';
  state.phaseEndTick = state.tick;
  state.events.push({
    kind: 'game_over',
    tick: state.tick,
    winners: [...state.winners],
    draw: state.draw,
    endedBy: state.endedBy,
  });
  return true;
}

/**
 * End of a build phase: seal the map, hand out cannons, eliminate whoever failed.
 * This is the only point at which a player can lose.
 */
function resolveRound(state: MatchState): void {
  applyEnclosure(state);

  const { firstCastleReward, perAdditionalCastleReward, maxTotal } = state.ruleset.cannons;
  const results: RoundResult[] = [];
  const eliminatedNow: number[] = [];
  const continued: number[] = [];

  for (const player of state.players) {
    if (player.eliminated) continue;
    const enclosed = player.enclosedCastles;

    if (enclosed === 0 && state.ruleset.elimination.onZeroEnclosedCastles) {
      const { continues, extraCannonsPerContinue, resetPieceScheduleOnContinue } =
        state.ruleset.elimination;

      // A life, if there is one left. Everything the player built goes, they choose a
      // castle again in the coming cannon phase, and the ring is raised around it — so
      // this is a fresh start on the same ground rather than a reprieve on a ruin.
      if (player.continuesRemaining > 0) {
        player.continuesRemaining--;
        const spent = continues - player.continuesRemaining;
        wipeIsland(state, player.id);
        player.startingCastleId = null;
        player.enclosedCastles = 0;
        // More guns for a player closer to the end, and the opening count rather than
        // a round reward: they have no territory to be rewarded for.
        player.cannonsToPlace =
          state.ruleset.cannons.startingCount + extraCannonsPerContinue * spent;
        // Rewound so the next round deals round one's pieces. `pieceRound` is
        // incremented with the match round, so zero here means one there.
        if (resetPieceScheduleOnContinue) player.pieceRound = 0;

        continued.push(player.id);
        results.push({
          player: player.id,
          enclosedCastles: 0,
          cannonsAwarded: player.cannonsToPlace,
          eliminated: false,
          territoryPoints: 0,
          damagePoints: 0,
        });
        continue;
      }

      player.eliminated = true;
      player.eliminatedRound = state.round;
      player.cannonsToPlace = 0;
      eliminatedNow.push(player.id);
      results.push({
        player: player.id,
        enclosedCastles: 0,
        cannonsAwarded: 0,
        eliminated: true,
        territoryPoints: 0,
        damagePoints: 0,
      });
      continue;
    }

    let award = firstCastleReward + (enclosed - 1) * perAdditionalCastleReward;
    if (maxTotal !== null) {
      const owned = state.cannons.filter((c) => c.owner === player.id).length;
      award = Math.max(0, Math.min(award, maxTotal - owned));
    }
    player.cannonsToPlace = award;
    results.push({
      player: player.id,
      enclosedCastles: enclosed,
      cannonsAwarded: award,
      eliminated: false,
      territoryPoints: 0,
      damagePoints: 0,
    });
  }

  state.events.push({ kind: 'round_resolved', tick: state.tick, round: state.round, results });
  for (const id of continued) {
    state.events.push({
      kind: 'player_continued',
      tick: state.tick,
      player: id,
      round: state.round,
      continuesRemaining: (state.players[id] as PlayerState).continuesRemaining,
    });
  }
  for (const id of eliminatedNow) {
    stripEliminated(state, id);
    state.events.push({
      kind: 'player_eliminated',
      tick: state.tick,
      player: id,
      round: state.round,
    });
  }

  // Territory changes once eliminated players are stripped from the board.
  applyEnclosure(state);

  // Then clear the wall that is doing no work. A loop that encloses anything is
  // safe from this by construction, so it can only take what was already useless.
  if (state.ruleset.enclosure.sweepOrphanedWalls) {
    const swept = sweepOrphanedWalls(state);
    if (swept.length > 0) {
      state.events.push({ kind: 'walls_swept', tick: state.tick, tiles: swept });
      applyEnclosure(state);
    }
  }

  // Scored last, so the territory counted is the territory that will face the next
  // barrage. The results were already announced, but events are read only once the
  // step returns, so filling them in here is still in time.
  scoreRound(state, results);

  if (checkGameOver(state)) return;

  const anyToPlace = state.players.some((p) => !p.eliminated && p.cannonsToPlace > 0);
  enterIntermission(state, anyToPlace ? 'cannon_place' : 'combat');

  // A life lost or a player knocked out gets the board to itself for a moment. One
  // pause however many it was: the banners sit over their own islands and cannot
  // overlap, so they are all readable at once.
  if (continued.length > 0 || eliminatedNow.length > 0) {
    state.phaseEndTick += ticksFor(state.ruleset.phases.continueBannerMs, state.ruleset.tickRateHz);
  }
}

/**
 * Banks the round's points: opponents' wall destroyed, plus enclosed tiles times
 * enclosed castles, both as totals across every region a player holds. Totals rather
 * than per region, so two separate loops are worth what one loop around both would be
 * — and the product grows with the square of what a player holds, which is what
 * makes a tight wall around a single castle lose on the clock.
 *
 * A player who ends the round without a sealed castle forfeits all of it, damage
 * included, unless `scoreDamageOnFailedRound` says otherwise.
 */
function scoreRound(state: MatchState, results: RoundResult[]): void {
  const { wallPoints, tilePoints, scoreDamageOnFailedRound } = state.ruleset.scoring;
  const tiles = new Array<number>(state.players.length).fill(0);
  for (let i = 0; i < state.territory.length; i++) {
    const owner = state.territory[i] as number;
    if (owner > 0) tiles[owner - 1] = (tiles[owner - 1] as number) + 1;
  }

  for (const result of results) {
    const player = state.players[result.player] as PlayerState;
    if (player.eliminated) continue;
    const sealed = player.enclosedCastles > 0;
    result.territoryPoints = sealed
      ? tilePoints * (tiles[player.id] as number) * player.enclosedCastles
      : 0;
    result.damagePoints =
      sealed || scoreDamageOnFailedRound ? wallPoints * player.wallsDestroyed : 0;
    player.score += result.territoryPoints + result.damagePoints;
  }
  for (const player of state.players) player.wallsDestroyed = 0;
}

/** Begins the phase an intermission was holding. */
function beginPendingPhase(state: MatchState): void {
  const next = state.pendingPhase ?? 'combat';
  if (next === 'combat') {
    state.round++;
    for (const player of state.players) {
      player.cannonsToPlace = 0;
      player.pieceRound++;
    }
    enterPhase(state, 'combat', state.ruleset.phases.combatMs);
    return;
  }
  if (next === 'build') {
    // Each build phase deals a fresh queue, so the round's size band applies from
    // its first piece.
    for (const player of state.players) player.pieceIndex = 0;
  }
  const durations: Partial<Record<Phase, number>> = {
    castle_select: state.ruleset.phases.castleSelectMs,
    build: state.ruleset.phases.buildMs,
    cannon_place: state.ruleset.phases.cannonPlaceMs,
  };
  enterPhase(state, next, durations[next] ?? 0);
}

/**
 * Chooses for anyone who did not choose, as the cannon phase closes.
 *
 * Only a person can end up here: a bot always acts, and a disconnected seat is played
 * by one. Without it, running the clock down would leave a player with no ring at all,
 * so they would fail the next resolution and spend another life for having hesitated.
 *
 * Deterministic, from the match seed and the round — `Math.random` is banned in `sim`,
 * and a replay has to reproduce these choices exactly like any other.
 */
function autoFinishCannonPhase(state: MatchState): void {
  for (const player of state.players) {
    if (player.eliminated) continue;
    const rng = streamFor(state.seed, `fallback:${state.round}:${player.id}`);

    if (owesCastleChoice(player)) {
      const mine = state.castles.filter((c) => c.islandId === player.islandId);
      // An island with no castles cannot happen through generation, but drawing from
      // an empty range throws rather than returning nothing, so it is checked.
      if (mine.length === 0) continue;
      const pick = mine[rng.nextInt(mine.length)] as Castle;
      player.startingCastleId = pick.id;
      buildStartingRing(state, pick);
      applyEnclosure(state);
      state.events.push({
        kind: 'castle_selected',
        tick: state.tick,
        player: player.id,
        castleId: pick.id,
      });
    }

    // Then the guns, wherever they will go. A gun somewhere beats a gun nowhere.
    while (player.cannonsToPlace > 0) {
      const spots = legalCannonPlacements(state, player.id);
      // Nowhere left to put one, which is a legitimate end to the phase rather than a
      // problem — and the reason this is checked before drawing, not after.
      if (spots.length === 0) break;
      const spot = spots[rng.nextInt(spots.length)] as { x: number; y: number };
      if ('rejection' in placeCannon(state, player.id, spot.x, spot.y)) break;
    }
  }
}

function advancePhase(state: MatchState): void {
  switch (state.phase) {
    case 'castle_select': {
      const everyoneChose = state.players.every((p) => p.startingCastleId !== null);
      if (everyoneChose || state.tick >= state.phaseEndTick) finishCastleSelect(state);
      return;
    }
    case 'combat': {
      if (state.tick >= state.phaseEndTick) enterIntermission(state, 'build');
      return;
    }
    case 'build': {
      if (state.tick >= state.phaseEndTick) resolveRound(state);
      return;
    }
    case 'cannon_place': {
      // A player with cannons left but nowhere to put them is done too — otherwise
      // everyone waits out a timer that cannot change anything.
      const done = state.players.every(
        (p) =>
          !owesCastleChoice(p) &&
          (p.eliminated || p.cannonsToPlace === 0 || !canPlaceAnyCannon(state, p.id)),
      );
      if (done || state.tick >= state.phaseEndTick) {
        // Anyone who let the clock run out gets a castle and guns chosen for them,
        // rather than starting the next round with nothing and burning another life
        // for it. Only a person can reach this — a bot always acts.
        if (state.tick >= state.phaseEndTick) autoFinishCannonPhase(state);
        enterIntermission(state, 'combat');
      }
      return;
    }

    case 'intermission': {
      // Hold while anything is still in the air, so the last volley lands and plays
      // out before the announcement starts rather than under it.
      if (state.shots.length > 0) {
        state.phaseEndTick = state.tick + intermissionTicks(state.ruleset);
        return;
      }
      if (state.tick >= state.phaseEndTick) beginPendingPhase(state);
      return;
    }
    case 'lobby':
    case 'game_over':
      return;
  }
}

/** Advances the simulation by exactly one tick. */
export function step(state: MatchState): void {
  if (state.phase === 'game_over') return;
  state.tick++;
  resolveImpacts(state);
  advancePhase(state);
}

/** Advances to an absolute tick. */
export function stepTo(state: MatchState, tick: number): void {
  while (state.tick < tick && state.phase !== 'game_over') step(state);
}

export function applyAction(state: MatchState, action: Action): Rejection | null {
  switch (action.kind) {
    case 'select_castle': {
      // Also the cannon phase, where a player who has just spent a continue picks
      // again before placing their guns.
      if (state.phase !== 'castle_select' && state.phase !== 'cannon_place') {
        return 'wrong_phase';
      }
      const player = state.players[action.player];
      if (!player) return 'unknown_player';
      if (player.eliminated) return 'eliminated';
      if (!owesCastleChoice(player)) return 'already_selected';
      const castle = state.castles.find((c) => c.id === action.castleId);
      if (!castle) return 'unknown_castle';
      if (castle.islandId !== player.islandId) return 'wrong_island';
      player.startingCastleId = castle.id;
      // Raise the ring straight away rather than when the last player has chosen:
      // waiting left the player staring at an empty island for up to 15 seconds.
      buildStartingRing(state, castle);
      applyEnclosure(state);
      state.events.push({
        kind: 'castle_selected',
        tick: state.tick,
        player: action.player,
        castleId: castle.id,
      });
      // Everyone has chosen — no reason to sit through the rest of the timer.
      advancePhase(state);
      return null;
    }
    case 'fire': {
      const result = fire(state, action.player, action.x, action.y);
      return 'rejection' in result ? result.rejection : null;
    }
    case 'place_piece': {
      const result = placePiece(state, action.player, action.rotation, action.x, action.y);
      if ('rejection' in result) return result.rejection;
      // Re-solve so a loop lights up as territory the instant the block closing it
      // goes down. Combat deliberately does not do this: territory shown during a
      // barrage is the territory you earned, not what is left of it.
      applyEnclosure(state);
      return null;
    }
    case 'place_cannon': {
      const result = placeCannon(state, action.player, action.x, action.y);
      if ('rejection' in result) return result.rejection;
      advancePhase(state); // may end the phase early once everyone has placed
      return null;
    }
  }
}

/** Removes and returns the pending events; the server broadcasts these each tick. */
export function drainEvents(state: MatchState) {
  const events = state.events;
  state.events = [];
  return events;
}

/**
 * Replays a recorded input log, resumably.
 *
 * Resumable matters: the determinism suite compares hashes at checkpoints along the
 * way, not just at the end. A divergence that appears at tick 900 and cancels itself
 * out by tick 2500 is still a desync, and only intermediate comparison catches it.
 */
export class LogReplayer {
  private cursor = 0;

  constructor(
    private readonly state: MatchState,
    private readonly log: readonly LoggedAction[],
  ) {}

  advanceTo(tick: number): void {
    while (this.state.tick < tick && this.state.phase !== 'game_over') {
      while (
        this.cursor < this.log.length &&
        (this.log[this.cursor] as LoggedAction).tick <= this.state.tick
      ) {
        applyAction(this.state, (this.log[this.cursor] as LoggedAction).action);
        this.cursor++;
      }
      step(this.state);
    }
  }
}

export function runLog(state: MatchState, log: readonly LoggedAction[], untilTick: number): void {
  new LogReplayer(state, log).advanceTo(untilTick);
}

/**
 * A fingerprint of everything that affects play. Two simulations fed the same seed,
 * ruleset and inputs must agree on this at every tick — that property is what makes
 * the client safe to run the same code as the server.
 *
 * Deliberately excludes `events`, which are a transport concern.
 */
export function hashMatchState(state: MatchState): string {
  const h = new Hasher();
  h.u32(state.seed);
  h.i32(state.tick);
  h.i32(state.round);
  h.u32(PHASES.indexOf(state.phase));
  h.u32(state.pendingPhase === null ? 0xffff : PHASES.indexOf(state.pendingPhase));
  h.i32(state.phaseEndTick);
  h.i32(state.width);
  h.i32(state.height);

  for (const p of state.players) {
    h.i32(p.id);
    h.i32(p.islandId);
    h.bool(p.eliminated);
    h.nullable(p.eliminatedRound);
    h.nullable(p.startingCastleId);
    h.i32(p.enclosedCastles);
    h.i32(p.cannonsToPlace);
    h.i32(p.pieceIndex);
    h.i32(p.score);
    h.i32(p.wallsDestroyed);
  }

  h.bytes(state.terrain);
  h.bytes(state.islandId);
  h.bytes(state.structure);
  h.bytes(state.owner);
  h.bytes(state.territory);

  for (const c of state.castles) {
    h.i32(c.id).i32(c.islandId).i32(c.x).i32(c.y).bool(c.enclosed);
  }
  for (const c of state.cannons) {
    h.i32(c.id).i32(c.owner).i32(c.x).i32(c.y).bool(c.active).nullable(c.shotId);
  }
  for (const s of state.shots) {
    h.i32(s.id)
      .i32(s.cannonId)
      .i32(s.owner)
      .i32(s.toX)
      .i32(s.toY)
      .i32(s.launchTick)
      .i32(s.impactTick);
  }

  h.u32(state.winners.length);
  for (const id of state.winners) h.i32(id);
  h.bool(state.draw);
  h.u32(state.endedBy === null ? 0 : state.endedBy === 'elimination' ? 1 : 2);
  return h.hex;
}
