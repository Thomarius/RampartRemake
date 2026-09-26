import { defaultArtConfig, type ArtConfig, type ArtStyle } from '@rampart/config';
import type { MatchState, Shot } from '@rampart/sim';
import { Application, Container, Graphics } from 'pixi.js';

import type { SealGlow } from '../seal.js';
import type { Look } from '../transition.js';

import { FlatTheme } from './flat.js';
import { PixelTheme } from './pixel.js';
import {
  hex,
  type Cell,
  type Debris,
  type Ghost,
  type Theme,
  type ThemeLayers,
  type ViewTransform,
} from './theme.js';

export type { Ghost, Theme, ViewTransform } from './theme.js';

/** Every style the client can render in. */
export function createTheme(style: ArtStyle, seed = 1): Theme {
  switch (style) {
    case 'flat':
      return new FlatTheme();
    case 'pixel':
      return new PixelTheme(seed);
  }
}

/** A theme and the layer stack it owns, under one root so it can be masked whole. */
interface Slot {
  theme: Theme;
  root: Container;
  layers: ThemeLayers;
  /** Screen-space rectangle this look is confined to during a wipe. */
  mask: Graphics;
  /** Something changed while it was hidden, so it must be redrawn before it is shown. */
  stale: boolean;
}

function newLayers(): ThemeLayers {
  return {
    terrain: new Container(),
    territory: new Container(),
    structures: new Container(),
    effects: new Container(),
    overlay: new Container(),
  };
}

/** Nothing to point out: for the look that is leaving, whose overlay must not linger. */
const NO_GHOST: Ghost = {
  tile: null,
  cells: [],
  valid: false,
  footprint: null,
  selectable: [],
  unsealed: [],
  aiming: false,
};

/** Which looks are on screen this frame, and where the line between them is. */
export interface LookFrame {
  /** The look below the banner, which is leaving. */
  from: Look;
  /** The look above it, which is arriving — the only one outside a banner. */
  to: Look;
  /** The banner's centre in screen pixels, or null when no wipe is under way. */
  lineY: number | null;
}

/**
 * The scene owns everything that does not depend on how the game looks: the Pixi
 * application, the layer stacks, the camera fit, and the mapping from screen to tile.
 * Painting is delegated entirely to the themes.
 *
 * There are two looks, one for building and one for combat (see `transition.ts`), and
 * both themes stay alive for the whole match, each in its own layer stack: the pixel
 * style empties its layers with `removeChildren()`, which would take the other style's
 * graphics with it if they shared. Outside a banner only the current look is visible
 * and drawn; the other is marked stale on every change and redrawn in full as a wipe
 * reveals it, so keeping two costs nothing between banners. The same style for both
 * looks is one slot, and a wipe then changes nothing.
 */
export class Scene {
  readonly app = new Application();

  private slots!: Record<Look, Slot>;
  private art: ArtConfig = defaultArtConfig;
  private view: ViewTransform = { tile: 8, originX: 0, originY: 0 };
  private shown: LookFrame = { from: 'build', to: 'build', lineY: null };

  /** The last board drawn, so a stale look can be brought up to date as it is revealed. */
  private board: {
    state: MatchState | null;
    territory: Uint8Array | null;
    structures: MatchState | null;
  } = { state: null, territory: null, structures: null };

  async init(
    canvas: HTMLCanvasElement,
    themes: Record<Look, Theme>,
    art: ArtConfig = defaultArtConfig,
  ): Promise<void> {
    this.art = art;
    await this.app.init({
      canvas,
      // Matches the generated sea, so the map does not sit in a visible frame.
      background: hex(art.palette.waterMid),
      antialias: false,
      resolution: Math.min(2, globalThis.devicePixelRatio || 1),
      autoDensity: true,
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    });
    this.app.ticker.autoStart = false;
    this.app.ticker.stop();

    const build = await this.slotFor(themes.build);
    const combat = themes.combat === themes.build ? build : await this.slotFor(themes.combat);
    this.slots = { build, combat };
    this.applyVisibility();
  }

  private async slotFor(theme: Theme): Promise<Slot> {
    const layers = newLayers();
    const root = new Container();
    root.addChild(
      layers.terrain,
      layers.territory,
      layers.structures,
      layers.effects,
      layers.overlay,
    );
    const mask = new Graphics();
    // Masks live beside the roots, so the shake moves them with the board.
    this.app.stage.addChild(root, mask);
    await theme.init(layers, this.art);
    return { theme, root, layers, mask, stale: false };
  }

  /** The styles in use, one per look. */
  get styles(): Record<Look, ArtStyle> {
    return { build: this.slots.build.theme.id, combat: this.slots.combat.theme.id };
  }

  /** The distinct slots currently on screen. */
  private visible(): Slot[] {
    const to = this.slots[this.shown.to];
    const from = this.slots[this.shown.from];
    return this.shown.lineY === null || from === to ? [to] : [to, from];
  }

  private isVisible(slot: Slot): boolean {
    return this.visible().includes(slot);
  }

  /** Every distinct slot, whether shown or not. */
  private all(): Slot[] {
    return this.slots.build === this.slots.combat
      ? [this.slots.build]
      : [this.slots.build, this.slots.combat];
  }

  /**
   * Chooses what is on screen: one look, or two split at the banner's line — the
   * arriving look above it, the leaving one below. A look coming into view after
   * changes it missed is redrawn first.
   */
  showLooks(frame: LookFrame): void {
    this.shown = frame;
    for (const slot of this.visible()) {
      if (slot.stale) this.refresh(slot);
    }
    this.applyVisibility();
  }

  private applyVisibility(): void {
    const visible = this.visible();
    const split = visible.length > 1 ? this.shown.lineY : null;
    const width = this.app.renderer.width / this.app.renderer.resolution;
    const height = this.app.renderer.height / this.app.renderer.resolution;
    for (const slot of this.all()) {
      slot.root.visible = visible.includes(slot);
      slot.mask.clear();
      if (split === null || !slot.root.visible) {
        slot.root.mask = null;
        continue;
      }
      // Generous margins either side, so the shake never shows an edge.
      const line = Math.max(-64, Math.min(height + 64, split));
      if (slot === this.slots[this.shown.to]) slot.mask.rect(-64, -64, width + 128, line + 64);
      else slot.mask.rect(-64, line, width + 128, height + 64 - line);
      slot.mask.fill({ color: 0xffffff });
      slot.root.mask = slot.mask;
    }
  }

  /** Brings a look up to date with the last board drawn. */
  private refresh(slot: Slot): void {
    const { state, territory, structures } = this.board;
    if (state !== null) slot.theme.drawTerrain(state, this.view);
    if (state !== null && territory !== null)
      slot.theme.drawTerritory({ ...state, territory }, this.view);
    if (structures !== null) slot.theme.drawStructures(structures, this.view);
    slot.stale = false;
  }

  /** Draws on the looks on screen and marks the rest stale. */
  private paint(draw: (slot: Slot) => void): void {
    for (const slot of this.all()) {
      if (this.isVisible(slot)) draw(slot);
      else slot.stale = true;
    }
  }

  /** Recomputes the fit of the grid into the canvas. */
  /**
   * Fits the board to the window below `topInset` pixels, which the HUD bar occupies.
   * Centred in the whole window instead, the top island's first rows sat under the bar
   * whenever the window was the height that limited the tile size.
   */
  resize(state: MatchState, width: number, height: number, topInset = 0): void {
    this.app.renderer.resize(width, height);
    const usable = Math.max(1, height - topInset);
    const tile = Math.max(1, Math.floor(Math.min(width / state.width, usable / state.height)));
    this.view = {
      tile,
      originX: Math.floor((width - tile * state.width) / 2),
      originY: topInset + Math.floor((usable - tile * state.height) / 2),
    };
    this.applyVisibility();
  }

  /** Screen coordinates to tile, or null when outside the grid. */
  /** Centre of a tile in screen pixels, for anything drawn over the board in HTML. */
  screenAt(x: number, y: number): { x: number; y: number } {
    return {
      x: this.view.originX + (x + 0.5) * this.view.tile,
      y: this.view.originY + (y + 0.5) * this.view.tile,
    };
  }

  tileAt(state: MatchState, screenX: number, screenY: number): { x: number; y: number } | null {
    const x = Math.floor((screenX - this.view.originX) / this.view.tile);
    const y = Math.floor((screenY - this.view.originY) / this.view.tile);
    if (x < 0 || y < 0 || x >= state.width || y >= state.height) return null;
    return { x, y };
  }

  drawTerrain(state: MatchState): void {
    this.board.state = state;
    this.paint((slot) => slot.theme.drawTerrain(state, this.view));
  }

  /**
   * Territory as it stands now, not as the sim last recorded it. The sim refreshes
   * `territory` at placements and resolutions but not when shots land, because a
   * breach only counts at a resolution — so drawn from state, a castle breached in
   * combat stayed shaded as sealed until somebody built, which read as the sea being
   * taken for wall. Display only: what the rules do with a breach is unchanged.
   */
  drawTerritory(state: MatchState, territory: Uint8Array = state.territory): void {
    this.board.state = state;
    this.board.territory = territory;
    this.paint((slot) => slot.theme.drawTerritory({ ...state, territory }, this.view));
  }

  /**
   * Walls, castles and cannons. The state may carry a display board rather than the
   * sim's own — swept walls the banner has not reached yet — so it is kept whole.
   */
  drawStructures(state: MatchState): void {
    this.board.structures = state;
    this.paint((slot) => slot.theme.drawStructures(state, this.view));
  }

  drawEffects(
    state: MatchState,
    tickFraction: number,
    deltaMs: number,
    castleSealed: readonly boolean[],
    sealGlow: readonly SealGlow[] = [],
  ): void {
    this.applyShake(deltaMs);
    for (const slot of this.visible()) {
      slot.theme.drawEffects(state, this.view, { tickFraction, deltaMs, castleSealed, sealGlow });
    }
  }

  /** Remaining shake, in milliseconds. */
  private shaking = 0;

  /** Shakes the board, for a hit on the player's own wall. */
  shake(): void {
    this.shaking = this.art.generators.fx.shakeMs;
  }

  private applyShake(deltaMs: number): void {
    this.shaking = Math.max(0, this.shaking - deltaMs);
    const amount = (this.shaking / this.art.generators.fx.shakeMs) * this.art.generators.fx.shakePx;
    // Whole pixels: the pixel style is drawn on the pixel grid, and a fractional offset
    // blurs every sprite on the board for the length of the shake.
    this.app.stage.x = Math.round((Math.random() * 2 - 1) * amount);
    this.app.stage.y = Math.round((Math.random() * 2 - 1) * amount);
  }

  /**
   * The overlay belongs to the arriving look, so the aiming cursor that appears with
   * "Fire!" is already the combat one; the leaving look's is cleared.
   */
  drawOverlay(state: MatchState, ghost: Ghost, humanPlayer: number): void {
    const to = this.slots[this.shown.to];
    for (const slot of this.visible()) {
      slot.theme.drawOverlay(state, this.view, slot === to ? ghost : NO_GHOST, humanPlayer);
    }
  }

  /** Where a screen height falls on the board, in fractional tile rows. */
  rowAt(screenY: number): number {
    return (screenY - this.view.originY) / this.view.tile;
  }

  /**
   * On the looks on screen only: a hidden style never ages its effects, and a blast
   * noted there would all go off at once when it next came into view.
   */
  noteImpact(x: number, y: number, debris: readonly Debris[]): void {
    for (const slot of this.visible()) slot.theme.noteImpact(x, y, debris);
  }

  /** On every look, since it only turns a barrel, which should stay true while hidden. */
  noteShot(shot: Shot): void {
    for (const slot of this.all()) slot.theme.noteShot(shot);
  }

  /** On the looks on screen, for the same reason as impacts. */
  noteLanding(cells: readonly Cell[], owner: number): void {
    for (const slot of this.visible()) slot.theme.noteLanding(cells, owner);
  }

  /** In the arriving look: a block goes as the banner reaches it, so above the line. */
  noteCrumble(block: Debris): void {
    this.slots[this.shown.to].theme.noteCrumble(block);
  }

  render(): void {
    this.app.renderer.render(this.app.stage);
  }
}
