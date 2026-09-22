import type { Ruleset, TerrainConfig } from '@rampart/config';

export const Terrain = { Water: 0, Land: 1 } as const;
export type TerrainKind = (typeof Terrain)[keyof typeof Terrain];

export const Structure = { Empty: 0, Wall: 1, Castle: 2, Cannon: 3 } as const;
export type StructureKind = (typeof Structure)[keyof typeof Structure];

export const PHASES = [
  'lobby',
  'castle_select',
  /** Between phases: shots land, then the next phase is announced. */
  'intermission',
  'combat',
  'build',
  'cannon_place',
  'game_over',
] as const;
export type Phase = (typeof PHASES)[number];

export interface PlayerState {
  /** 0-based. The island a player owns is `id + 1`, matching the islandId layer. */
  id: number;
  islandId: number;
  name: string;
  isBot: boolean;
  eliminated: boolean;
  eliminatedRound: number | null;
  /** Castle chosen during castle_select; the auto-built ring surrounds it. */
  startingCastleId: number | null;
  /** Castles sealed at the last resolution — drives the cannon reward. */
  enclosedCastles: number;
  /** Cannons still to be placed this cannon_place phase. */
  cannonsToPlace: number;
  /** Position in this round's queue. */
  pieceIndex: number;
  /** Lives left: failing to seal spends one instead of ending the match. */
  continuesRemaining: number;
  /**
   * The round this player's piece schedule is at, which is not always the match's.
   *
   * A continue rewinds it to zero, so the next round deals the small pieces a player
   * starting again needs to close a ring. For anyone who has never continued it tracks
   * `round` exactly.
   */
  pieceRound: number;
  /** Points banked at resolutions. Only a sealed round adds to it. */
  score: number;
  /**
   * Opponents' wall tiles this player destroyed since the last resolution — not yet
   * points, because failing to seal forfeits them.
   */
  wallsDestroyed: number;
}

export interface Castle {
  id: number;
  islandId: number;
  /** Top-left corner. */
  x: number;
  y: number;
  w: number;
  h: number;
  enclosed: boolean;
}

export interface Cannon {
  id: number;
  /** Owning player id. */
  owner: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** False when the cannon sits outside an enclosed region: it survives but cannot fire. */
  active: boolean;
  /** Shot currently in flight; a cannon is ready only when this is null. */
  shotId: number | null;
}

export interface Shot {
  id: number;
  cannonId: number;
  owner: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  launchTick: number;
  impactTick: number;
}

export type Action =
  | { kind: 'select_castle'; player: number; castleId: number }
  | { kind: 'fire'; player: number; x: number; y: number }
  | { kind: 'place_piece'; player: number; x: number; y: number; rotation: number }
  | { kind: 'place_cannon'; player: number; x: number; y: number };

export type ActionKind = Action['kind'];

/** A timestamped action, as recorded in an input log and replayed in tests. */
export interface LoggedAction {
  tick: number;
  action: Action;
}

export type MatchEvent =
  | {
      kind: 'phase_changed';
      tick: number;
      phase: Phase;
      round: number;
      phaseEndTick: number;
      pendingPhase: Phase | null;
    }
  | { kind: 'castle_selected'; tick: number; player: number; castleId: number }
  | { kind: 'shot_fired'; tick: number; shot: Shot }
  | { kind: 'shot_impact'; tick: number; shotId: number; x: number; y: number; destroyed: number[] }
  | {
      kind: 'piece_placed';
      tick: number;
      player: number;
      pieceId: number;
      rotation: number;
      cells: number[];
    }
  | { kind: 'cannon_placed'; tick: number; player: number; cannonId: number; x: number; y: number }
  | { kind: 'round_resolved'; tick: number; round: number; results: RoundResult[] }
  | {
      /** A player failed to seal anything and spent a life rather than being knocked out. */
      kind: 'player_continued';
      tick: number;
      player: number;
      round: number;
      continuesRemaining: number;
    }
  | { kind: 'walls_swept'; tick: number; tiles: number[] }
  | { kind: 'player_eliminated'; tick: number; player: number; round: number }
  | {
      kind: 'game_over';
      tick: number;
      winners: number[];
      draw: boolean;
      endedBy: MatchEnd;
    };

/**
 * How a match ended: by one player outlasting the rest, or by reaching the round cap
 * with several still in, when the highest score among them wins.
 */
export type MatchEnd = 'elimination' | 'round_cap';

export interface RoundResult {
  player: number;
  enclosedCastles: number;
  cannonsAwarded: number;
  eliminated: boolean;
  /** Banked this resolution, so nobody downstream has to recompute the formula. */
  territoryPoints: number;
  damagePoints: number;
}

export interface MatchState {
  seed: number;
  ruleset: Ruleset;
  terrainConfig: TerrainConfig;

  width: number;
  height: number;

  tick: number;
  round: number;
  phase: Phase;
  phaseEndTick: number;
  /** During an intermission, the phase that begins once it ends. */
  pendingPhase: Phase | null;

  players: PlayerState[];

  /** Static after generation. */
  terrain: Uint8Array;
  islandId: Uint8Array;
  /** Dynamic. */
  structure: Uint8Array;
  owner: Uint8Array;
  /** Recomputed each resolution: owning player + 1 for enclosed regions, else 0. */
  territory: Uint8Array;

  castles: Castle[];
  cannons: Cannon[];
  shots: Shot[];

  nextCannonId: number;
  nextShotId: number;

  /**
   * Empty until the match ends, and empty after a draw. More than one is a shared win
   * on points at the cap, which is not a draw: those players did win.
   */
  winners: number[];
  draw: boolean;
  endedBy: MatchEnd | null;

  /** Drained by the server each tick and broadcast; never part of the state hash. */
  events: MatchEvent[];
}
