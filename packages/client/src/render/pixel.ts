import type { ArtConfig } from '@rampart/config';
import { Structure, Terrain, type MatchState, type Shot } from '@rampart/sim';
import { Container, Graphics, Sprite, Texture } from 'pixi.js';

import { E, KEY, N, S, W, buildAtlas } from './pixel/generators.js';
import {
  drawBuildHints,
  hex,
  playerColour,
  tileX,
  tileY,
  type Debris,
  type EffectFrame,
  type Ghost,
  type Theme,
  type ThemeLayers,
  type ViewTransform,
  shotLift,
} from './theme.js';

interface Blast {
  x: number;
  y: number;
  age: number;
}

/** A fragment of wall, in tile coordinates, thrown up by a shot. */
interface Fragment {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  colour: number;
}

/** Where a cannon points, and how long ago it last fired. */
interface Aim {
  angle: number;
  firedAgo: number;
}

/** How long each recoil and muzzle-flash frame is held. */
const FX_FRAME_MS = 50;

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
  private fragments: Fragment[] = [];
  /** By cannon id. A gun that has never fired faces the nearest enemy castle. */
  private aims = new Map<number, Aim>();
  private bannerElapsed = 0;
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

    // Water runs past the board to the window's edge. Drawn only across the grid, the
    // animated sea stopped in a hard rectangle with the page's flat blue beyond it.
    const marginX = Math.ceil(view.originX / view.tile) + 1;
    const marginY = Math.ceil(view.originY / view.tile) + 1;
    for (let y = -marginY; y < state.height + marginY; y++) {
      for (let x = -marginX; x < state.width + marginX; x++) {
        const inside = x >= 0 && y >= 0 && x < state.width && y < state.height;
        const i = y * state.width + x;
        if (!inside || state.terrain[i] !== Terrain.Land) {
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

  noteImpact(x: number, y: number, debris: readonly Debris[]): void {
    this.blasts.push({ x, y, age: 0 });
    const count = this.art.generators.fx.debrisPerTile;
    for (const block of debris) {
      const colour = playerColour(this.art, block.owner, 'base');
      for (let k = 0; k < count; k++) {
        // Cosmetic, so an ordinary random source: nothing here reaches the sim.
        const spread = (Math.random() - 0.5) * 2;
        this.fragments.push({
          x: block.x + 0.5,
          y: block.y + 0.5,
          vx: spread * 2.2,
          vy: -2.5 - Math.random() * 2.5,
          age: 0,
          colour,
        });
      }
    }
  }

  noteShot(shot: Shot): void {
    const angle = Math.atan2(shot.toX - shot.fromX, -(shot.toY - shot.fromY));
    this.aims.set(shot.cannonId, { angle, firedAgo: 0 });
  }

  /** Aims a cannon that has not fired yet at the nearest enemy castle. */
  private aimFor(state: MatchState, cannonId: number): Aim | null {
    const known = this.aims.get(cannonId);
    if (known !== undefined) return known;
    const cannon = state.cannons.find((c) => c.id === cannonId);
    if (cannon === undefined) return null;
    const cx = cannon.x + cannon.w / 2;
    const cy = cannon.y + cannon.h / 2;
    let best = Number.POSITIVE_INFINITY;
    let angle = 0;
    for (const castle of state.castles) {
      if (castle.islandId === cannon.owner + 1) continue;
      const dx = castle.x + castle.w / 2 - cx;
      const dy = castle.y + castle.h / 2 - cy;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        angle = Math.atan2(dx, -dy);
      }
    }
    const aim = { angle, firedAgo: Number.POSITIVE_INFINITY };
    this.aims.set(cannonId, aim);
    return aim;
  }

  drawEffects(state: MatchState, view: ViewTransform, frame: EffectFrame): void {
    const g = this.effectGfx;
    g.clear();

    this.animateWater(frame.deltaMs);
    this.effectLayer.removeChildren();
    this.effectLayer.addChild(this.craters, g);

    // An inert cannon reads as struck through, as in the flat style: it survives but
    // cannot fire. A darker tint alone was too faint to tell at a glance.
    for (const cannon of state.cannons) {
      if (cannon.active) continue;
      const x = tileX(view, cannon.x);
      const y = tileY(view, cannon.y);
      const w = view.tile * cannon.w;
      const h = view.tile * cannon.h;
      const inset = Math.max(1, Math.floor(view.tile / 6));
      g.moveTo(x + inset, y + inset);
      g.lineTo(x + w - inset, y + h - inset);
      g.stroke({
        width: Math.max(2, Math.floor(view.tile / 6)),
        color: hex(this.art.palette.uiInvalid),
      });
    }

    this.drawBarrels(state, view, frame.deltaMs);
    this.drawBanners(state, view, frame);

    const now = state.tick + frame.tickFraction;
    const trail = this.art.generators.fx.shotTrailLengthPx / this.art.tileSizePx;
    for (const shot of state.shots) {
      const span = shot.impactTick - shot.launchTick;
      const t = span <= 0 ? 1 : Math.min(1, Math.max(0, (now - shot.launchTick) / span));
      const x = shot.fromX + (shot.toX - shot.fromX) * t;
      const y = shot.fromY + (shot.toY - shot.fromY) * t;
      // A parabolic lift sells the lob. The shot still lands exactly on impactTick.
      const lift = shotLift(shot, t);

      // A short fading trail behind the ball, along the same arc.
      const distance = Math.hypot(shot.toX - shot.fromX, shot.toY - shot.fromY);
      const back = distance > 0 ? trail / distance : 0;
      for (let k = 3; k >= 1; k--) {
        const tk = t - (back * k) / 3;
        if (tk <= 0) continue;
        const px = shot.fromX + (shot.toX - shot.fromX) * tk;
        const py = shot.fromY + (shot.toY - shot.fromY) * tk - shotLift(shot, tk);
        g.circle(tileX(view, px + 0.5), tileY(view, py + 0.5), view.tile * (0.2 - k * 0.04));
        g.fill({ color: hex(this.art.palette.rockLight), alpha: 0.45 - k * 0.12 });
      }

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

    // Fragments arc up and fall back under a little gravity, fading as they go.
    const life = this.art.generators.fx.debrisMs;
    const dt = frame.deltaMs / 1000;
    for (const f of this.fragments) {
      f.age += frame.deltaMs;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.vy += 9 * dt;
      const size = Math.max(1, view.tile * 0.16);
      g.rect(tileX(view, f.x) - size / 2, tileY(view, f.y) - size / 2, size, size);
      g.fill({ color: f.colour, alpha: Math.max(0, 1 - f.age / life) });
    }
    this.fragments = this.fragments.filter((f) => f.age < life);
  }

  /** Barrels turn to their last target and kick back when they fire. */
  private drawBarrels(state: MatchState, view: ViewTransform, deltaMs: number): void {
    const steps = this.art.generators.cannon.rotationSteps;
    const recoilFrames = this.art.generators.cannon.recoilFrames;
    const flashFrames = this.art.generators.fx.muzzleFlashFrames;
    const length = this.art.generators.cannon.barrelLengthPx / this.art.tileSizePx;
    const g = this.effectGfx;
    for (const cannon of state.cannons) {
      const aim = this.aimFor(state, cannon.id);
      if (aim === null) continue;
      aim.firedAgo += deltaMs;
      const step = ((Math.round((aim.angle / (2 * Math.PI)) * steps) % steps) + steps) % steps;
      // Back at once, then home a frame at a time.
      const kick = Math.floor(aim.firedAgo / FX_FRAME_MS);
      const recoil = kick < recoilFrames ? recoilFrames - 1 - kick : 0;
      const sprite = this.place(
        this.effectLayer,
        KEY.barrel(step, recoil),
        view,
        cannon.x,
        cannon.y,
        cannon.w,
      );
      // The owner's light colour, a step above the base's, so the barrel reads on it.
      sprite.tint = cannon.active
        ? washed(playerColour(this.art, cannon.owner, 'light'), 0.45)
        : hex(this.art.palette.rockMid);

      if (kick < flashFrames) {
        const cx = cannon.x + cannon.w / 2 + Math.sin(aim.angle) * (length + 0.15);
        const cy = cannon.y + cannon.h / 2 - Math.cos(aim.angle) * (length + 0.15);
        const r = view.tile * (0.35 - kick * 0.09);
        g.circle(tileX(view, cx), tileY(view, cy), r);
        g.fill({ color: hex(this.art.palette.emberHot), alpha: 0.9 });
        g.circle(tileX(view, cx), tileY(view, cy), r * 0.55);
        g.fill({ color: hex(this.art.palette.uiInk), alpha: 0.9 });
      }
    }
    // Forget guns that no longer exist, so a continue's wiped island starts clean.
    if (this.aims.size > state.cannons.length) {
      const live = new Set(state.cannons.map((c) => c.id));
      for (const id of this.aims.keys()) if (!live.has(id)) this.aims.delete(id);
    }
  }

  /** A banner in the owner's colour flies over every castle sealed as things stand. */
  private drawBanners(state: MatchState, view: ViewTransform, frame: EffectFrame): void {
    const frames = this.art.generators.castle.bannerWaveFrames;
    this.bannerElapsed += frame.deltaMs;
    const wave = Math.floor(this.bannerElapsed / 160) % frames;
    const texture = this.texture(KEY.banner(wave));
    const g = this.effectGfx;
    for (const castle of state.castles) {
      if (!frame.castleSealed[castle.id]) continue;
      // A pole rising from the middle of the castle, the banner flying from its head
      // above the roofline, where it reads from across the map.
      const poleX = tileX(view, castle.x + castle.w / 2);
      const top = tileY(view, castle.y) - view.tile * 0.9;
      const pole = Math.max(2, Math.round(view.tile / 10));
      g.rect(poleX - pole / 2, top, pole, view.tile * 1.4);
      g.fill({ color: hex(this.art.palette.rockDark) });
      const sprite = new Sprite(texture);
      sprite.x = poleX + pole / 2;
      sprite.y = top;
      sprite.width = view.tile * 0.8;
      sprite.height = (view.tile * 0.8 * texture.height) / Math.max(1, texture.width);
      sprite.tint = playerColour(this.art, castle.islandId - 1, 'base');
      this.effectLayer.addChild(sprite);
    }
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

    drawBuildHints(g, state, view, ghost, this.art, performance.now());

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
