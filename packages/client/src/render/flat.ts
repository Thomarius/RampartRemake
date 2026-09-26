import type { ArtConfig, FlatStyleConfig } from '@rampart/config';
import { Structure, Terrain, type MatchState } from '@rampart/sim';
import { Graphics } from 'pixi.js';

import {
  FlagHoist,
  Landings,
  dimEliminated,
  drawBuildHints,
  drawFireReticle,
  drawOvertimeBorder,
  drawSealGlow,
  hex,
  playerColour,
  tileX,
  tileY,
  type EffectFrame,
  type Ghost,
  type Theme,
  type ThemeLayers,
  type ViewTransform,
  shotLift,
  type Cell,
  type Debris,
} from './theme.js';

interface Impact {
  x: number;
  y: number;
  age: number;
}

const IMPACT_MS = 320;

/** A swept block fading out where it stood. */
interface Crumble {
  x: number;
  y: number;
  colour: number;
  age: number;
}

/**
 * The minimal style: flat colour, hard edges, no textures and no atlas.
 *
 * It began as placeholder art and is kept as a real option. Besides being a style in
 * its own right, it is the fallback if texture generation fails or is slow, and it is
 * far easier to debug against — an enclosure or territory bug is obvious in flat colour
 * and easy to miss under texture.
 *
 * Everything is drawn into one Graphics per layer, with shapes batched by colour: at
 * 80x80 a full repaint is a few thousand rectangles and happens only when the grid
 * actually changes.
 */
export class FlatTheme implements Theme {
  readonly id = 'flat' as const;

  private art!: ArtConfig;
  private style!: FlatStyleConfig;

  private readonly terrainGfx = new Graphics();
  private readonly territoryGfx = new Graphics();
  private readonly structureGfx = new Graphics();
  private readonly effectGfx = new Graphics();
  private readonly overlayGfx = new Graphics();

  private impacts: Impact[] = [];
  private crumbles: Crumble[] = [];
  private readonly landings = new Landings();
  private readonly flags = new FlagHoist();
  /** Milliseconds of drawing, for the flags. */
  private clock = 0;

  init(layers: ThemeLayers, art: ArtConfig): Promise<void> {
    this.art = art;
    this.style = art.flat;
    layers.terrain.addChild(this.terrainGfx);
    layers.territory.addChild(this.territoryGfx);
    layers.structures.addChild(this.structureGfx);
    layers.effects.addChild(this.effectGfx);
    layers.overlay.addChild(this.overlayGfx);
    return Promise.resolve();
  }

  destroy(): void {
    for (const g of [
      this.terrainGfx,
      this.territoryGfx,
      this.structureGfx,
      this.effectGfx,
      this.overlayGfx,
    ]) {
      g.destroy();
    }
  }

  /** The flat style stays plain: it is the one to debug against. */
  noteShot(): void {}

  noteImpact(x: number, y: number): void {
    this.impacts.push({ x, y, age: 0 });
  }

  noteCrumble(block: Debris): void {
    const colour =
      block.owner < 0
        ? hex(this.art.palette.rockDark)
        : playerColour(this.art, block.owner, 'light');
    this.crumbles.push({ x: block.x, y: block.y, colour, age: 0 });
  }

  noteLanding(cells: readonly Cell[], owner: number): void {
    this.landings.add(cells, owner);
  }

  drawTerrain(state: MatchState, view: ViewTransform): void {
    const g = this.terrainGfx;
    g.clear();
    // Tinted per island, which is the only thing that makes ownership readable
    // before anything has been built.
    for (let player = 0; player < state.players.length; player++) {
      let any = false;
      for (let i = 0; i < state.terrain.length; i++) {
        if (state.terrain[i] !== Terrain.Land || state.islandId[i] !== player + 1) continue;
        const x = i % state.width;
        g.rect(tileX(view, x), tileY(view, (i - x) / state.width), view.tile, view.tile);
        any = true;
      }
      if (any) {
        g.fill({ color: playerColour(this.art, player, 'dark'), alpha: this.style.landAlpha });
      }
    }
  }

  drawTerritory(state: MatchState, view: ViewTransform): void {
    const g = this.territoryGfx;
    g.clear();
    for (let player = 0; player < state.players.length; player++) {
      let any = false;
      for (let i = 0; i < state.territory.length; i++) {
        if (state.territory[i] !== player + 1) continue;
        const x = i % state.width;
        g.rect(tileX(view, x), tileY(view, (i - x) / state.width), view.tile, view.tile);
        any = true;
      }
      if (any) {
        g.fill({
          color: playerColour(this.art, player, 'light'),
          alpha: this.style.territoryAlpha,
        });
      }
    }
    dimEliminated(g, state, view);
  }

  drawStructures(state: MatchState, view: ViewTransform): void {
    const g = this.structureGfx;
    g.clear();
    const inset = view.tile >= 6 ? this.style.structureInsetPx : 0;
    const size = view.tile - inset * 2;

    // Walls first, batched per owner. Owner 0 is neutral rubble left by an
    // eliminated player.
    for (let player = 0; player <= state.players.length; player++) {
      let any = false;
      for (let i = 0; i < state.structure.length; i++) {
        if (state.structure[i] !== Structure.Wall || state.owner[i] !== player) continue;
        const x = i % state.width;
        g.rect(tileX(view, x) + inset, tileY(view, (i - x) / state.width) + inset, size, size);
        any = true;
      }
      if (any) {
        g.fill({
          color:
            player === 0
              ? hex(this.art.palette.rockDark)
              : playerColour(this.art, player - 1, 'light'),
        });
      }
    }

    // Castles and cannons are drawn per entity rather than per tile, so each can
    // carry a mark that tells it apart from a plain block at a glance.
    for (const castle of state.castles) {
      const owner = castle.islandId - 1;
      const x = tileX(view, castle.x);
      const y = tileY(view, castle.y);
      const w = castle.w * view.tile;
      const h = castle.h * view.tile;
      g.rect(x + inset, y + inset, w - inset * 2, h - inset * 2);
      g.fill({ color: playerColour(this.art, owner, 'base') });

      const core = Math.floor(Math.min(w, h) * this.style.castleCoreScale);
      g.rect(x + (w - core) / 2, y + (h - core) / 2, core, core);
      g.fill({ color: playerColour(this.art, owner, 'dark') });
    }

    for (const cannon of state.cannons) {
      const x = tileX(view, cannon.x);
      const y = tileY(view, cannon.y);
      const w = cannon.w * view.tile;
      const h = cannon.h * view.tile;
      g.rect(x + inset, y + inset, w - inset * 2, h - inset * 2);
      g.fill({ color: playerColour(this.art, cannon.owner, 'dark') });

      g.circle(x + w / 2, y + h / 2, Math.max(1, Math.min(w, h) * this.style.cannonBoreScale));
      g.fill({ color: playerColour(this.art, cannon.owner, 'light') });

      // An inert cannon reads as struck through: it survives, but it cannot fire.
      if (!cannon.active) {
        g.moveTo(x + inset, y + inset);
        g.lineTo(x + w - inset, y + h - inset);
        g.stroke({ width: this.style.outlineWidthPx, color: hex(this.art.palette.uiInvalid) });
      }
    }
  }

  drawEffects(state: MatchState, view: ViewTransform, frame: EffectFrame): void {
    const g = this.effectGfx;
    g.clear();
    const now = state.tick + frame.tickFraction;
    this.clock += frame.deltaMs;

    drawSealGlow(g, view, frame.sealGlow, this.art);
    this.landings.draw(g, view, this.art, frame.deltaMs);
    this.drawFlags(state, view, frame);

    for (const shot of state.shots) {
      const span = shot.impactTick - shot.launchTick;
      const t = span <= 0 ? 1 : Math.min(1, Math.max(0, (now - shot.launchTick) / span));
      const x = shot.fromX + (shot.toX - shot.fromX) * t;
      const y = shot.fromY + (shot.toY - shot.fromY) * t;
      // A parabolic lift sells the lob. The shot still lands exactly on impactTick.
      const lift = shotLift(shot, t);
      const colour = playerColour(this.art, shot.owner, 'light');

      g.circle(tileX(view, x + 0.5), tileY(view, y + 0.5 - lift), Math.max(2, view.tile * 0.35));
      g.fill({ color: colour });

      // Where it will come down, so the target can read the threat.
      g.circle(tileX(view, shot.toX + 0.5), tileY(view, shot.toY + 0.5), view.tile * 0.45);
      g.stroke({ width: 1, color: colour, alpha: 0.5 });
    }

    for (const impact of this.impacts) {
      impact.age += frame.deltaMs;
      const t = impact.age / IMPACT_MS;
      if (t >= 1) continue;
      g.circle(
        tileX(view, impact.x + 0.5),
        tileY(view, impact.y + 0.5),
        view.tile * (0.4 + t * 2.2),
      );
      g.stroke({
        width: this.style.outlineWidthPx,
        color: hex(this.art.palette.emberHot),
        alpha: 1 - t,
      });
    }
    this.impacts = this.impacts.filter((impact) => impact.age < IMPACT_MS);

    // A swept block shrinks into its tile and fades: plain, like the rest of the style,
    // but enough to see what the banner took.
    const crumbleMs = this.style.crumbleMs;
    for (const crumble of this.crumbles) {
      crumble.age += frame.deltaMs;
      const t = crumble.age / crumbleMs;
      if (t >= 1) continue;
      const size = view.tile * (1 - t * 0.6);
      const offset = (view.tile - size) / 2;
      g.rect(tileX(view, crumble.x) + offset, tileY(view, crumble.y) + offset, size, size);
      g.fill({ color: crumble.colour, alpha: 1 - t });
    }
    this.crumbles = this.crumbles.filter((crumble) => crumble.age < crumbleMs);
  }

  /**
   * A pennant on a plain pole over every sealed castle, hoisted as it is sealed: the
   * flat style's share of the moment, kept as simple as the rest of it.
   */
  private drawFlags(state: MatchState, view: ViewTransform, frame: EffectFrame): void {
    const g = this.effectGfx;
    this.flags.update(frame.castleSealed, this.clock);
    for (const castle of state.castles) {
      const raised = this.flags.raised(castle.id, this.clock, this.art.effects.flagRaiseMs);
      if (raised === null) continue;
      const pole = tileX(view, castle.x + castle.w / 2);
      const top = tileY(view, castle.y) - view.tile;
      const foot = tileY(view, castle.y + castle.h / 2);
      const width = Math.max(2, Math.round(view.tile / 8));
      g.rect(pole - width / 2, top, width, foot - top);
      g.fill({ color: hex(this.art.palette.uiInk) });
      const height = view.tile * 0.7;
      const y = foot - height - raised * (foot - top - height);
      g.poly([
        pole + width / 2,
        y,
        pole + width / 2 + view.tile,
        y + height / 2,
        pole + width / 2,
        y + height,
      ]);
      g.fill({ color: playerColour(this.art, castle.islandId - 1, 'base') });
    }
  }

  drawOverlay(state: MatchState, view: ViewTransform, ghost: Ghost, humanPlayer: number): void {
    const g = this.overlayGfx;
    g.clear();
    drawOvertimeBorder(g, state, view, this.art, performance.now());

    for (const castle of ghost.selectable) {
      g.rect(
        tileX(view, castle.x),
        tileY(view, castle.y),
        castle.w * view.tile,
        castle.h * view.tile,
      );
      g.stroke({ width: this.style.outlineWidthPx, color: hex(this.art.palette.uiAccent) });
    }

    drawBuildHints(g, view, ghost, this.art, performance.now());

    if (!ghost.tile) return;
    const colour = ghost.valid ? hex(this.art.palette.uiValid) : hex(this.art.palette.uiInvalid);

    if (state.phase === 'build' && ghost.cells.length > 0) {
      for (const [ox, oy] of ghost.cells) {
        g.rect(
          tileX(view, ghost.tile.x + ox),
          tileY(view, ghost.tile.y + oy),
          view.tile,
          view.tile,
        );
      }
      g.fill({ color: colour, alpha: 0.55 });
      return;
    }

    if (state.phase === 'cannon_place' && ghost.footprint) {
      g.rect(
        tileX(view, ghost.tile.x),
        tileY(view, ghost.tile.y),
        ghost.footprint.w * view.tile,
        ghost.footprint.h * view.tile,
      );
      g.fill({ color: colour, alpha: 0.5 });
      return;
    }

    if (ghost.aiming) drawFireReticle(g, view, ghost, this.art, humanPlayer);
  }
}
