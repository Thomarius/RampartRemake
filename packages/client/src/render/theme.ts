import type { ArtConfig, ArtStyle } from '@rampart/config';
import type { MatchState, Shot } from '@rampart/sim';
import type { Container } from 'pixi.js';

/**
 * A visual style.
 *
 * The scene owns the camera, the layer stack, when a redraw is needed and how input
 * maps to tiles. A theme owns only what things look like. Splitting it this way means
 * a second style costs its drawing code and nothing else — no duplicated update logic,
 * no second copy of the dirty-tracking, and no reach into the simulation, since
 * everything a style needs is derived from grid state the client already has.
 */
export interface Theme {
  readonly id: ArtStyle;

  /**
   * Prepares the style and takes ownership of its layers. Asynchronous because a
   * texture-based style generates its atlas here.
   */
  init(layers: ThemeLayers, art: ArtConfig): Promise<void>;

  /** Static for the whole match: land, water, island tint. */
  drawTerrain(state: MatchState, view: ViewTransform): void;
  /** Enclosed regions, redrawn when the solver says they changed. */
  drawTerritory(state: MatchState, view: ViewTransform): void;
  /** Walls, castles and cannons; redrawn only when the grid changes. */
  drawStructures(state: MatchState, view: ViewTransform): void;
  /** Shots in flight and impact flashes; every frame. */
  drawEffects(state: MatchState, view: ViewTransform, frame: EffectFrame): void;
  /** Reticle, piece ghost and selectable castles; every frame. */
  drawOverlay(state: MatchState, view: ViewTransform, ghost: Ghost, humanPlayer: number): void;

  /** A shot has just landed here, destroying these wall blocks. */
  noteImpact(x: number, y: number, debris: readonly Debris[]): void;
  /** A cannon has just fired this shot. */
  noteShot(shot: Shot): void;

  /** Releases textures and display objects. */
  destroy(): void;
}

export interface ThemeLayers {
  terrain: Container;
  territory: Container;
  structures: Container;
  effects: Container;
  overlay: Container;
}

export interface ViewTransform {
  /** Side of one tile, in screen pixels. */
  tile: number;
  originX: number;
  originY: number;
}

export interface EffectFrame {
  /** Progress through the current simulation tick, for smooth shot interpolation. */
  tickFraction: number;
  deltaMs: number;
  /**
   * Whether each castle is sealed as the board stands, by castle id — not the sim's
   * `enclosed`, which a breach in combat does not change until the next resolution.
   */
  castleSealed: readonly boolean[];
}

/** A wall block a shot destroyed, and whose it was. */
export interface Debris {
  x: number;
  y: number;
  owner: number;
}

export interface Ghost {
  /** Tile the pointer is over, or null when off the map. */
  tile: { x: number; y: number } | null;
  /** Cells of the held piece relative to the anchor, during build. */
  cells: readonly (readonly [number, number])[];
  valid: boolean;
  /** Footprint for the cannon ghost, during cannon placement. */
  footprint: { w: number; h: number } | null;
  /** Castles the player may choose, during castle selection. */
  selectable: readonly { x: number; y: number; w: number; h: number }[];
}

export function hex(value: string): number {
  return Number.parseInt(value.slice(1), 16);
}

/** Player colours cycle if a match ever has more players than the palette defines. */
export function playerColour(
  art: ArtConfig,
  player: number,
  shade: 'base' | 'light' | 'dark',
): number {
  const entry = art.players[player % art.players.length];
  return hex(entry ? entry[shade] : art.palette.uiInk);
}

/**
 * Fraction of its own range a shot rises at the top of its arc.
 *
 * Range, not flight time. The lift used to be `span * 0.25` where `span` is the flight
 * in ticks, which tied the picture to the reload: when flight time went from 1.05s to
 * 3.05s at twenty tiles (ARCHIVE.md 10k), the apex went from 8 tiles to 23 and most shots
 * simply left the top of the screen. A lob's height should follow how far it is thrown,
 * and then it survives any amount of balance tuning.
 */
const ARC_RISE = 0.22;

/**
 * Ceiling on the arc, so a shot across a big map still stays on it.
 *
 * Five tiles is a fifth of the height of the two-player map, which is the shortest one
 * the game generates — enough to read as a lob, not enough to leave the screen from a
 * gun near the top edge.
 */
const ARC_MAX_TILES = 5;

/** How far above the ground a shot rides, in tiles, at progress `t` through its flight. */
export function shotLift(shot: Shot, t: number): number {
  const dx = shot.toX - shot.fromX;
  const dy = shot.toY - shot.fromY;
  const range = Math.sqrt(dx * dx + dy * dy);
  return Math.sin(Math.PI * t) * Math.min(range * ARC_RISE, ARC_MAX_TILES);
}

/** Top-left of a tile in screen space. */
export function tileX(view: ViewTransform, x: number): number {
  return view.originX + x * view.tile;
}

export function tileY(view: ViewTransform, y: number): number {
  return view.originY + y * view.tile;
}
