import type { Ruleset, TerrainConfig } from '@rampart/config';

import { applyEnclosure } from './enclosure.js';
import { Hasher } from './hash.js';
import { generatePieceSequence } from './pieces.js';
import { canPlaceAnyCannon, placeCannon, placePiece, type Rejection } from './placement.js';
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
    pieceSequence: generatePieceSequence(ruleset, seed),
    winner: null,
    draw: false,
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

function checkGameOver(state: MatchState): boolean {
  const alive = alivePlayers(state);
  if (alive.length > 1) return false;
  state.pendingPhase = null;
  state.winner = alive.length === 1 ? (alive[0] as PlayerState).id : null;
  state.draw = alive.length === 0 && state.ruleset.elimination.simultaneousIsDraw;
  state.phase = 'game_over';
  state.phaseEndTick = state.tick;
  state.events.push({
    kind: 'game_over',
    tick: state.tick,
    winner: state.winner,
    draw: state.draw,
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

  for (const player of state.players) {
    if (player.eliminated) continue;
    const enclosed = player.enclosedCastles;

    if (enclosed === 0 && state.ruleset.elimination.onZeroEnclosedCastles) {
      player.eliminated = true;
      player.eliminatedRound = state.round;
      player.cannonsToPlace = 0;
      eliminatedNow.push(player.id);
      results.push({ player: player.id, enclosedCastles: 0, cannonsAwarded: 0, eliminated: true });
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
    });
  }

  state.events.push({ kind: 'round_resolved', tick: state.tick, round: state.round, results });
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

  if (checkGameOver(state)) return;

  const anyToPlace = state.players.some((p) => !p.eliminated && p.cannonsToPlace > 0);
  enterIntermission(state, anyToPlace ? 'cannon_place' : 'combat');
}

/** Begins the phase an intermission was holding. */
function beginPendingPhase(state: MatchState): void {
  const next = state.pendingPhase ?? 'combat';
  if (next === 'combat') {
    state.round++;
    for (const player of state.players) player.cannonsToPlace = 0;
    enterPhase(state, 'combat', state.ruleset.phases.combatMs);
    return;
  }
  const durations: Partial<Record<Phase, number>> = {
    castle_select: state.ruleset.phases.castleSelectMs,
    build: state.ruleset.phases.buildMs,
    cannon_place: state.ruleset.phases.cannonPlaceMs,
  };
  enterPhase(state, next, durations[next] ?? 0);
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
        (p) => p.eliminated || p.cannonsToPlace === 0 || !canPlaceAnyCannon(state, p.id),
      );
      if (done || state.tick >= state.phaseEndTick) enterIntermission(state, 'combat');
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
      if (state.phase !== 'castle_select') return 'wrong_phase';
      const player = state.players[action.player];
      if (!player) return 'unknown_player';
      if (player.eliminated) return 'eliminated';
      if (player.startingCastleId !== null) return 'already_selected';
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

  h.nullable(state.winner);
  h.bool(state.draw);
  return h.hex;
}
