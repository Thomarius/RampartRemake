import type { ArtConfig } from '@rampart/config';
import { Structure, Terrain, type MatchState } from '@rampart/sim';
import { Container, Graphics, Sprite, Texture } from 'pixi.js';

import { E, KEY, N, S, W, buildAtlas } from './pixel/generators.js';
import {
  hex,
  playerColour,
  tileX,
  tileY,
  type EffectFrame,
  type Ghost,
  type Theme,
  type ThemeLayers,
  type ViewTransform,
} from './theme.js';

interface Blast {
  x: number;
  y: number;
  age: number;
}

/** Mixes a colour toward white, so tinting a texture shifts its hue without crushing it. */
function washed(colour: number, amount: number): number {
  const r = (colour >> 16) & 0xff;
  const g = (colour >> 8) & 0xff;
  const b = colour & 0xff;
  const mix = (c: number): number => Math.round(c + (255 - c) * amount);
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

/**
 * The procedural pixel style.
 *
 * Every sprite is generated at boot from the palette and packed into one texture, so
 * the whole board draws in a single batch and the repository carries no binary art.
 * Terrain, walls and structures are generated in neutral stone and grass and tinted
 * per player, which keeps the atlas small and guarantees the two styles agree on
 * colour — both read the same palette.
 */
export class PixelTheme implements Theme {
  readonly id = 'pixel' as const;

  private art!: ArtConfig;
  private textures = new Map<string, Texture>();
  private readonly seed: number;

  private terrainLayer!: Container;
  private structureLayer!: Container;
  private effectLayer!: Container;
  private readonly territoryGfx = new Graphics();
  private readonly overlayGfx = new Graphics();
  private readonly effectGfx = new Graphics();

  /** Water sprites are kept so the sea can be animated without rebuilding the map. */
  private waterSprites: Sprite[] = [];
  private waterFrame = -1;
  private waterElapsed = 0;
  private blasts: Blast[] = [];
  private craters: Container = new Container();

  constructor(seed = 1) {
    this.seed = seed;
  }

  init(layers: ThemeLayers, art: ArtConfig): Promise<void> {
    this.art = art;
    this.textures = buildAtlas(art, this.seed);

    this.terrainLayer = layers.terrain;
    this.structureLayer = layers.structures;
    this.effectLayer = layers.effects;

    layers.territory.addChild(this.territoryGfx);
    layers.effects.addChild(this.craters);
    layers.effects.addChild(this.effectGfx);
    layers.overlay.addChild(this.overlayGfx);
    return Promise.resolve();
  }

  destroy(): void {
    this.terrainLayer?.removeChildren();
    this.structureLayer?.removeChildren();
    this.effectLayer?.removeChildren();
    this.territoryGfx.destroy();
    this.overlayGfx.destroy();
    this.effectGfx.destroy();
    this.craters.destroy({ children: true });
    for (const texture of this.textures.values()) texture.destroy();
    this.textures.clear();
    this.waterSprites = [];
  }

  private texture(key: string): Texture {
    return this.textures.get(key) ?? Texture.EMPTY;
  }

  private place(
    parent: Container,
    key: string,
    view: ViewTransform,
    x: number,
    y: number,
    tiles = 1,
  ): Sprite {
    const sprite = new Sprite(this.texture(key));
    sprite.x = tileX(view, x);
    sprite.y = tileY(view, y);
    sprite.width = view.tile * tiles;
    sprite.height = view.tile * tiles;
    // Sprites are generated at 16 pixels a tile but displayed at whatever the map
    // scales to, so snap to the pixel grid rather than let edges land on halves.
    sprite.roundPixels = true;
    parent.addChild(sprite);
    return sprite;
  }

  drawTerrain(state: MatchState, view: ViewTransform): void {
    this.terrainLayer.removeChildren();
    this.waterSprites = [];
    this.waterFrame = -1;

    const land = (x: number, y: number): boolean =>
      x >= 0 &&
      y >= 0 &&
      x < state.width &&
      y < state.height &&
      state.terrain[y * state.width + x] === Terrain.Land;

    const variants = this.art.generators.terrain.grassVariants;

    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const i = y * state.width + x;
        if (state.terrain[i] !== Terrain.Land) {
          this.waterSprites.push(this.place(this.terrainLayer, KEY.water(0), view, x, y));
          continue;
        }

        // Which sides meet the sea decides the tile; the top nibble carries the
        // diagonals so a headland does not come out square.
        let mask = 0;
        if (!land(x, y - 1)) mask |= N;
        if (!land(x + 1, y)) mask |= E;
        if (!land(x, y + 1)) mask |= S;
        if (!land(x - 1, y)) mask |= W;
        if (!land(x - 1, y - 1)) mask |= 16;
        if (!land(x + 1, y - 1)) mask |= 32;
        if (!land(x + 1, y + 1)) mask |= 64;
        if (!land(x - 1, y + 1)) mask |= 128;

        const key = mask === 0 ? KEY.grass((x * 7 + y * 13) % variants) : KEY.shore(mask);
        const sprite = this.place(this.terrainLayer, key, view, x, y);

        // Only a hint of the owner's colour. Tinting hard enough to identify an
        // island by its grass turns the ground muddy and throws away the generated
        // texture; ownership is carried by the shoreline, the walls and the
        // territory shading instead.
        const owner = (state.islandId[i] as number) - 1;
        if (owner >= 0) {
          const strength = mask === 0 ? 0.78 : 0.45;
          sprite.tint = washed(playerColour(this.art, owner, 'base'), strength);
        }
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
          alpha: this.art.flat.territoryAlpha * 0.7,
        });
      }
    }
  }

  drawStructures(state: MatchState, view: ViewTransform): void {
    this.structureLayer.removeChildren();

    const isWall = (x: number, y: number): boolean =>
      x >= 0 &&
      y >= 0 &&
      x < state.width &&
      y < state.height &&
      state.structure[y * state.width + x] === Structure.Wall;

    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        const i = y * state.width + x;
        if (state.structure[i] !== Structure.Wall) continue;

        // Joins to its neighbours, so a run of blocks reads as one wall.
        let mask = 0;
        if (isWall(x, y - 1)) mask |= N;
        if (isWall(x + 1, y)) mask |= E;
        if (isWall(x, y + 1)) mask |= S;
        if (isWall(x - 1, y)) mask |= W;

        const sprite = this.place(this.structureLayer, KEY.wall(mask, 0), view, x, y);
        const owner = (state.owner[i] as number) - 1;
        sprite.tint =
          owner >= 0
            ? washed(playerColour(this.art, owner, 'light'), 0.15)
            : hex(this.art.palette.rockMid);
      }
    }

    for (const castle of state.castles) {
      const sprite = this.place(
        this.structureLayer,
        KEY.castle,
        view,
        castle.x,
        castle.y,
        castle.w,
      );
      sprite.tint = washed(playerColour(this.art, castle.islandId - 1, 'base'), 0.35);
    }

    for (const cannon of state.cannons) {
      const sprite = this.place(
        this.structureLayer,
        KEY.cannon,
        view,
        cannon.x,
        cannon.y,
        cannon.w,
      );
      sprite.tint = cannon.active
        ? washed(playerColour(this.art, cannon.owner, 'base'), 0.3)
        : hex(this.art.palette.rockDark);
      sprite.alpha = cannon.active ? 1 : 0.7;
    }
  }

  noteImpact(x: number, y: number): void {
    this.blasts.push({ x, y, age: 0 });
  }

  drawEffects(state: MatchState, view: ViewTransform, frame: EffectFrame): void {
    const g = this.effectGfx;
    g.clear();

    this.animateWater(frame.deltaMs);
    this.effectLayer.removeChildren();
    this.effectLayer.addChild(this.craters, g);

    const now = state.tick + frame.tickFraction;
    for (const shot of state.shots) {
      const span = shot.impactTick - shot.launchTick;
      const t = span <= 0 ? 1 : Math.min(1, Math.max(0, (now - shot.launchTick) / span));
      const x = shot.fromX + (shot.toX - shot.fromX) * t;
      const y = shot.fromY + (shot.toY - shot.fromY) * t;
      const lift = Math.sin(Math.PI * t) * span * 0.25;

      // Shadow on the ground reads the fall; the ball itself rides above it.
      g.circle(tileX(view, x + 0.5), tileY(view, y + 0.5), view.tile * 0.25);
      g.fill({ color: hex(this.art.palette.shadow), alpha: 0.35 });

      const ball = this.place(this.effectLayer, KEY.shot, view, 0, 0, 0.6);
      ball.x = tileX(view, x + 0.5) - view.tile * 0.3;
      ball.y = tileY(view, y + 0.5 - lift) - view.tile * 0.3;

      g.circle(tileX(view, shot.toX + 0.5), tileY(view, shot.toY + 0.5), view.tile * 0.45);
      g.stroke({ width: 1, color: playerColour(this.art, shot.owner, 'light'), alpha: 0.5 });
    }

    const frames = this.art.generators.fx.explosionFrames;
    const perFrame = this.art.generators.fx.explosionMsPerFrame;
    for (const blast of this.blasts) {
      blast.age += frame.deltaMs;
      const index = Math.floor(blast.age / perFrame);
      if (index >= frames) continue;
      this.place(this.effectLayer, KEY.blast(index), view, blast.x - 0.5, blast.y - 0.5, 2);
    }
    this.blasts = this.blasts.filter((b) => b.age < frames * perFrame);
  }

  /** Cycles the sea through its generated frames. */
  private animateWater(deltaMs: number): void {
    const frames = this.art.generators.terrain.waterAnimFrames;
    this.waterElapsed += deltaMs;
    const next =
      Math.floor(this.waterElapsed / this.art.generators.terrain.waterAnimMsPerFrame) % frames;
    if (next === this.waterFrame) return;
    this.waterFrame = next;
    const texture = this.texture(KEY.water(next));
    for (const sprite of this.waterSprites) sprite.texture = texture;
  }

  drawOverlay(state: MatchState, view: ViewTransform, ghost: Ghost, humanPlayer: number): void {
    const g = this.overlayGfx;
    g.clear();

    for (const castle of ghost.selectable) {
      g.rect(
        tileX(view, castle.x),
        tileY(view, castle.y),
        castle.w * view.tile,
        castle.h * view.tile,
      );
      g.stroke({ width: 2, color: hex(this.art.palette.uiAccent) });
    }

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
      g.fill({ color: colour, alpha: 0.5 });
      g.stroke({ width: 1, color: colour });
      return;
    }

    if (state.phase === 'cannon_place' && ghost.footprint) {
      g.rect(
        tileX(view, ghost.tile.x),
        tileY(view, ghost.tile.y),
        ghost.footprint.w * view.tile,
        ghost.footprint.h * view.tile,
      );
      g.fill({ color: colour, alpha: 0.45 });
      return;
    }

    if (state.phase === 'combat') {
      const cx = tileX(view, ghost.tile.x + 0.5);
      const cy = tileY(view, ghost.tile.y + 0.5);
      const r = view.tile * 1.1;
      const ink = ghost.valid ? playerColour(this.art, humanPlayer, 'light') : colour;
      g.circle(cx, cy, r);
      g.stroke({ width: 2, color: ink });
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as const) {
        g.moveTo(cx + dx * r * 0.6, cy + dy * r * 0.6);
        g.lineTo(cx + dx * r * 1.7, cy + dy * r * 1.7);
      }
      g.stroke({ width: 2, color: ink, alpha: 0.85 });
    }
  }
}
