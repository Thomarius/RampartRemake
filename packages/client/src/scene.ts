import { defaultArtConfig } from '@rampart/config';
import { Structure, Terrain, pieceCells, type MatchState, type Shot } from '@rampart/sim';
import { Application, Container, Graphics } from 'pixi.js';

/**
 * Placeholder renderer: everything is a rectangle.
 *
 * M2 exists to answer whether the loop is fun, and art would only make that
 * question harder to see. Shapes here are deliberately flat and readable; the
 * procedural generators replace them wholesale in M3.
 */

const palette = defaultArtConfig.palette;

function hex(value: string): number {
  return Number.parseInt(value.slice(1), 16);
}

export interface ViewTransform {
  tile: number;
  originX: number;
  originY: number;
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

interface Impact {
  x: number;
  y: number;
  age: number;
}

export class Scene {
  readonly app = new Application();
  private readonly terrainLayer = new Container();
  private readonly territoryLayer = new Container();
  private readonly structureLayer = new Container();
  private readonly effectLayer = new Container();
  private readonly overlayLayer = new Container();

  private readonly terrainGfx = new Graphics();
  private readonly territoryGfx = new Graphics();
  private readonly structureGfx = new Graphics();
  private readonly effectGfx = new Graphics();
  private readonly overlayGfx = new Graphics();

  private view: ViewTransform = { tile: 8, originX: 0, originY: 0 };
  private impacts: Impact[] = [];

  async init(canvas: HTMLCanvasElement): Promise<void> {
    await this.app.init({
      canvas,
      background: hex(palette.waterDeep),
      antialias: false,
      resolution: Math.min(2, globalThis.devicePixelRatio || 1),
      autoDensity: true,
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    });
    this.app.ticker.autoStart = false;
    this.app.ticker.stop();

    this.terrainLayer.addChild(this.terrainGfx);
    this.territoryLayer.addChild(this.territoryGfx);
    this.structureLayer.addChild(this.structureGfx);
    this.effectLayer.addChild(this.effectGfx);
    this.overlayLayer.addChild(this.overlayGfx);
    this.app.stage.addChild(
      this.terrainLayer,
      this.territoryLayer,
      this.structureLayer,
      this.effectLayer,
      this.overlayLayer,
    );
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
  tileAt(state: MatchState, screenX: number, screenY: number): { x: number; y: number } | null {
    const { tile, originX, originY } = this.view;
    const x = Math.floor((screenX - originX) / tile);
    const y = Math.floor((screenY - originY) / tile);
    if (x < 0 || y < 0 || x >= state.width || y >= state.height) return null;
    return { x, y };
  }

  private playerColour(player: number, shade: 'base' | 'light' | 'dark'): number {
    const entry = defaultArtConfig.players[player % defaultArtConfig.players.length];
    return hex(entry ? entry[shade] : palette.uiInk);
  }

  /** Terrain never changes during a match, so this runs once. */
  drawTerrain(state: MatchState): void {
    const g = this.terrainGfx;
    const { tile, originX, originY } = this.view;
    g.clear();

    // Land, tinted per island so ownership is readable at a glance.
    for (let player = 0; player < state.players.length; player++) {
      let any = false;
      for (let i = 0; i < state.terrain.length; i++) {
        if (state.terrain[i] !== Terrain.Land || state.islandId[i] !== player + 1) continue;
        const x = i % state.width;
        const y = (i - x) / state.width;
        g.rect(originX + x * tile, originY + y * tile, tile, tile);
        any = true;
      }
      if (any) g.fill({ color: this.playerColour(player, 'dark'), alpha: 0.55 });
    }
  }

  /** Territory shading, refreshed whenever a round resolves. */
  drawTerritory(state: MatchState): void {
    const g = this.territoryGfx;
    const { tile, originX, originY } = this.view;
    g.clear();

    for (let player = 0; player < state.players.length; player++) {
      let any = false;
      for (let i = 0; i < state.territory.length; i++) {
        if (state.territory[i] !== player + 1) continue;
        const x = i % state.width;
        const y = (i - x) / state.width;
        g.rect(originX + x * tile, originY + y * tile, tile, tile);
        any = true;
      }
      if (any) g.fill({ color: this.playerColour(player, 'light'), alpha: 0.3 });
    }
  }

  /** Walls, castles and cannons. Redrawn only when something on the grid changed. */
  drawStructures(state: MatchState): void {
    const g = this.structureGfx;
    const { tile, originX, originY } = this.view;
    g.clear();

    const inset = tile >= 6 ? 1 : 0;
    for (const kind of [Structure.Wall, Structure.Castle, Structure.Cannon] as const) {
      for (let player = 0; player <= state.players.length; player++) {
        let any = false;
        for (let i = 0; i < state.structure.length; i++) {
          if (state.structure[i] !== kind) continue;
          if ((state.owner[i] as number) !== player) continue;
          const x = i % state.width;
          const y = (i - x) / state.width;
          g.rect(
            originX + x * tile + inset,
            originY + y * tile + inset,
            tile - inset * 2,
            tile - inset * 2,
          );
          any = true;
        }
        if (!any) continue;
        // owner 0 is neutral rubble left behind by an eliminated player.
        const colour =
          player === 0
            ? hex(palette.rockDark)
            : kind === Structure.Wall
              ? this.playerColour(player - 1, 'light')
              : kind === Structure.Castle
                ? this.playerColour(player - 1, 'base')
                : this.playerColour(player - 1, 'dark');
        g.fill({ color: colour });
      }
    }

    // An inert cannon reads as hollow: it survives, but it cannot fire.
    for (const cannon of state.cannons) {
      if (cannon.active) continue;
      g.rect(
        originX + cannon.x * tile + 1,
        originY + cannon.y * tile + 1,
        cannon.w * tile - 2,
        cannon.h * tile - 2,
      );
      g.stroke({ width: 2, color: hex(palette.uiInvalid), alpha: 0.9 });
    }
  }

  noteImpact(x: number, y: number): void {
    this.impacts.push({ x, y, age: 0 });
  }

  /** Shots in flight and impact flashes; redrawn every frame. */
  drawEffects(state: MatchState, tickFraction: number, deltaMs: number): void {
    const g = this.effectGfx;
    const { tile, originX, originY } = this.view;
    g.clear();

    const now = state.tick + tickFraction;
    for (const shot of state.shots) {
      const span = shot.impactTick - shot.launchTick;
      const t = span <= 0 ? 1 : Math.min(1, Math.max(0, (now - shot.launchTick) / span));
      const x = shot.fromX + (shot.toX - shot.fromX) * t;
      const y = shot.fromY + (shot.toY - shot.fromY) * t;
      // A parabolic lift sells the lob; the shot still lands exactly on impactTick.
      const lift = Math.sin(Math.PI * t) * span * 0.25;

      const sx = originX + (x + 0.5) * tile;
      const sy = originY + (y + 0.5 - lift) * tile;
      g.circle(sx, sy, Math.max(2, tile * 0.35));
      g.fill({ color: this.playerColour(shot.owner, 'light') });

      // Target marker, so the player can read where it will come down.
      g.circle(originX + (shot.toX + 0.5) * tile, originY + (shot.toY + 0.5) * tile, tile * 0.45);
      g.stroke({ width: 1, color: this.playerColour(shot.owner, 'light'), alpha: 0.5 });
    }

    for (const impact of this.impacts) {
      impact.age += deltaMs;
      const t = impact.age / 320;
      if (t >= 1) continue;
      g.circle(
        originX + (impact.x + 0.5) * tile,
        originY + (impact.y + 0.5) * tile,
        tile * (0.4 + t * 2.2),
      );
      g.stroke({ width: 2, color: hex(palette.emberHot), alpha: 1 - t });
    }
    this.impacts = this.impacts.filter((impact) => impact.age < 320);
  }

  /** Reticle, piece ghost and selectable castles. */
  drawOverlay(state: MatchState, ghost: Ghost, humanPlayer: number): void {
    const g = this.overlayGfx;
    const { tile, originX, originY } = this.view;
    g.clear();

    for (const castle of ghost.selectable) {
      g.rect(
        originX + castle.x * tile,
        originY + castle.y * tile,
        castle.w * tile,
        castle.h * tile,
      );
      g.stroke({ width: 2, color: hex(palette.uiAccent) });
    }

    if (!ghost.tile) return;
    const colour = ghost.valid ? hex(palette.uiValid) : hex(palette.uiInvalid);

    if (state.phase === 'build' && ghost.cells.length > 0) {
      for (const [ox, oy] of ghost.cells) {
        g.rect(
          originX + (ghost.tile.x + ox) * tile,
          originY + (ghost.tile.y + oy) * tile,
          tile,
          tile,
        );
      }
      g.fill({ color: colour, alpha: 0.55 });
      return;
    }

    if (state.phase === 'cannon_place' && ghost.footprint) {
      g.rect(
        originX + ghost.tile.x * tile,
        originY + ghost.tile.y * tile,
        ghost.footprint.w * tile,
        ghost.footprint.h * tile,
      );
      g.fill({ color: colour, alpha: 0.5 });
      return;
    }

    if (state.phase === 'combat') {
      const cx = originX + (ghost.tile.x + 0.5) * tile;
      const cy = originY + (ghost.tile.y + 0.5) * tile;
      const r = tile * 1.1;
      g.circle(cx, cy, r);
      g.stroke({
        width: 2,
        color: ghost.valid ? this.playerColour(humanPlayer, 'light') : hex(palette.uiInvalid),
      });
      g.moveTo(cx - r * 1.5, cy);
      g.lineTo(cx + r * 1.5, cy);
      g.moveTo(cx, cy - r * 1.5);
      g.lineTo(cx, cy + r * 1.5);
      g.stroke({ width: 1, color: hex(palette.uiInk), alpha: 0.7 });
    }
  }

  render(): void {
    this.app.renderer.render(this.app.stage);
  }
}

/** Cells of the piece a player is holding, for the build ghost. */
export function heldPieceCells(
  pieceId: number,
  rotation: number,
): readonly (readonly [number, number])[] {
  return pieceCells(pieceId, rotation);
}

export function shotProgress(shot: Shot, now: number): number {
  const span = shot.impactTick - shot.launchTick;
  return span <= 0 ? 1 : Math.min(1, Math.max(0, (now - shot.launchTick) / span));
}
