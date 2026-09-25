import { defaultArtConfig, type ArtConfig, type ArtStyle } from '@rampart/config';
import type { MatchState } from '@rampart/sim';
import { Application, Container } from 'pixi.js';

import { FlatTheme } from './flat.js';
import { PixelTheme } from './pixel.js';
import { hex, type Ghost, type Theme, type ThemeLayers, type ViewTransform } from './theme.js';

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

/**
 * The scene owns everything that does not depend on how the game looks: the Pixi
 * application, the layer stack, the camera fit, and the mapping from screen to tile.
 * Painting is delegated entirely to the active theme.
 */
export class Scene {
  readonly app = new Application();

  private readonly layers: ThemeLayers = {
    terrain: new Container(),
    territory: new Container(),
    structures: new Container(),
    effects: new Container(),
    overlay: new Container(),
  };

  private theme: Theme = new FlatTheme();
  private art: ArtConfig = defaultArtConfig;
  private view: ViewTransform = { tile: 8, originX: 0, originY: 0 };

  async init(
    canvas: HTMLCanvasElement,
    theme: Theme,
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

    this.app.stage.addChild(
      this.layers.terrain,
      this.layers.territory,
      this.layers.structures,
      this.layers.effects,
      this.layers.overlay,
    );
    await this.useTheme(theme);
  }

  /** Swaps the active style. The caller repaints afterwards. */
  async useTheme(theme: Theme): Promise<void> {
    this.theme.destroy();
    for (const layer of Object.values(this.layers)) layer.removeChildren();
    this.theme = theme;
    await theme.init(this.layers, this.art);
  }

  get style(): ArtStyle {
    return this.theme.id;
  }

  /** Recomputes the fit of the grid into the canvas. */
  resize(state: MatchState, width: number, height: number): void {
    this.app.renderer.resize(width, height);
    const tile = Math.max(1, Math.floor(Math.min(width / state.width, height / state.height)));
    this.view = {
      tile,
      originX: Math.floor((width - tile * state.width) / 2),
      originY: Math.floor((height - tile * state.height) / 2),
    };
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
    this.theme.drawTerrain(state, this.view);
  }

  /**
   * Territory as it stands now, not as the sim last recorded it. The sim refreshes
   * `territory` at placements and resolutions but not when shots land, because a
   * breach only counts at a resolution — so drawn from state, a castle breached in
   * combat stayed shaded as sealed until somebody built, which read as the sea being
   * taken for wall. Display only: what the rules do with a breach is unchanged.
   */
  drawTerritory(state: MatchState, territory: Uint8Array = state.territory): void {
    this.theme.drawTerritory({ ...state, territory }, this.view);
  }

  drawStructures(state: MatchState): void {
    this.theme.drawStructures(state, this.view);
  }

  drawEffects(state: MatchState, tickFraction: number, deltaMs: number): void {
    this.theme.drawEffects(state, this.view, { tickFraction, deltaMs });
  }

  drawOverlay(state: MatchState, ghost: Ghost, humanPlayer: number): void {
    this.theme.drawOverlay(state, this.view, ghost, humanPlayer);
  }

  noteImpact(x: number, y: number): void {
    this.theme.noteImpact(x, y);
  }

  render(): void {
    this.app.renderer.render(this.app.stage);
  }
}
