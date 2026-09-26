import type { ArtConfig } from '@rampart/config';
import { Structure, Terrain, type MatchState, type Shot } from '@rampart/sim';
import { Container, Graphics, Sprite, Texture } from 'pixi.js';

import { E, KEY, N, S, W, buildAtlas } from './pixel/generators.js';
import {
  FlagHoist,
  Fireworks,
  Landings,
  dimEliminated,
  drawBuildHints,
  drawFireReticle,
  drawOvertimeBorder,
  drawSealGlow,
  drawShotTarget,
  hex,
  playerColour,
  tileX,
  tileY,
  type Cell,
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

/** A scorch mark on open ground, fading over the rounds after the shot. */
interface Crater {
  index: number;
  variant: number;
  round: number;
}

/** Cracks in a standing wall block beside a breach, for the rest of the round. */
interface Crack {
  level: number;
  round: number;
}

/** Rings spreading on the sea where a shot came down in it. */
interface Splash {
  x: number;
  y: number;
  age: number;
}

/** A destroyed wall block's embers and smoke, rising for a while after. */
interface Smoulder {
  x: number;
  y: number;
  age: number;
  seed: number;
}

/** A puff of gun smoke drifting off from a muzzle, in tile coordinates. */
interface Puff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
}

/** A surf sprite along the coast, and where it is in its breath. */
interface Surf {
  sprite: Sprite;
  phase: number;
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
  /** Milliseconds since the theme began drawing, for anything that loops. */
  private clock = 0;

  /** Flagstones on sealed ground, under the scorch marks and the greying of the out. */
  private readonly courtLayer = new Container();
  private readonly craterLayer = new Container();
  private craters: Crater[] = [];
  /** By tile index. */
  private cracks = new Map<number, Crack>();
  private surf: Surf[] = [];
  private readonly landings = new Landings();
  private readonly fireworks = new Fireworks();
  private splashes: Splash[] = [];
  private smoulders: Smoulder[] = [];
  private puffs: Puff[] = [];
  private readonly flags = new FlagHoist();
  /** The piece in hand, drawn as the wall it would make. */
  private readonly ghostLayer = new Container();

  /** Remembered from the last draw, since impacts arrive without the board. */
  private terrain: Uint8Array | null = null;
  private width = 0;
  private view: ViewTransform = { tile: 16, originX: 0, originY: 0 };
  private round = 0;

  constructor(seed = 1) {
    this.seed = seed;
  }

  init(layers: ThemeLayers, art: ArtConfig): Promise<void> {
    this.art = art;
    this.textures = buildAtlas(art, this.seed);

    this.terrainLayer = layers.terrain;
    this.structureLayer = layers.structures;
    this.effectLayer = layers.effects;

    layers.territory.addChild(this.courtLayer, this.craterLayer, this.territoryGfx);
    layers.effects.addChild(this.effectGfx);
    layers.overlay.addChild(this.ghostLayer, this.overlayGfx);
    return Promise.resolve();
  }

  destroy(): void {
    this.terrainLayer?.removeChildren();
    this.structureLayer?.removeChildren();
    this.effectLayer?.removeChildren();
    this.territoryGfx.destroy();
    this.overlayGfx.destroy();
    this.ghostLayer.destroy({ children: true });
    this.effectGfx.destroy();
    this.courtLayer.destroy({ children: true });
    this.craterLayer.destroy({ children: true });
    for (const texture of this.textures.values()) texture.destroy();
    this.textures.clear();
    this.waterSprites = [];
    this.surf = [];
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
    this.surf = [];
    this.waterFrame = -1;
    this.terrain = state.terrain;
    this.width = state.width;
    this.view = view;

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
    const depth = seaDepth(state, marginX, marginY, this.art.generators.terrain.depthShadeTiles);
    const spanX = state.width + marginX * 2;
    const deepest = this.art.generators.terrain.depthShadeTiles;
    const strength = this.art.generators.terrain.depthShadeStrength;
    for (let y = -marginY; y < state.height + marginY; y++) {
      for (let x = -marginX; x < state.width + marginX; x++) {
        const inside = x >= 0 && y >= 0 && x < state.width && y < state.height;
        const i = y * state.width + x;
        if (!inside || state.terrain[i] !== Terrain.Land) {
          const sprite = this.place(this.terrainLayer, KEY.water(0), view, x, y);
          this.waterSprites.push(sprite);
          // Darker the further from land, so the islands stand in shallows and the
          // channels between them read as open sea.
          const d = depth[(y + marginY) * spanX + (x + marginX)] as number;
          const shade = Math.round(255 * (1 - (strength * Math.max(0, d - 1)) / (deepest - 1)));
          sprite.tint = (shade << 16) | (shade << 8) | Math.min(255, shade + 24);

          let coast = 0;
          if (land(x, y - 1)) coast |= N;
          if (land(x + 1, y)) coast |= E;
          if (land(x, y + 1)) coast |= S;
          if (land(x - 1, y)) coast |= W;
          if (coast !== 0) {
            const surf = this.place(this.terrainLayer, KEY.foam(coast), view, x, y);
            this.surf.push({ sprite: surf, phase: ((x * 7 + y * 11) % 13) / 13 });
          }
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
          const wash = mask === 0 ? 0.78 : 0.45;
          sprite.tint = washed(playerColour(this.art, owner, 'base'), wash);
        }
      }
    }
    this.layoutCraters();
  }

  /** Places the scorch marks, whose sprites must follow the camera. */
  private layoutCraters(): void {
    this.craterLayer.removeChildren();
    const rounds = this.art.generators.fx.craterRounds;
    for (const crater of this.craters) {
      const x = crater.index % this.width;
      const y = (crater.index - x) / this.width;
      const sprite = this.place(this.craterLayer, KEY.crater(crater.variant), this.view, x, y);
      sprite.alpha = 0.9 * (1 - (this.round - crater.round) / rounds);
    }
  }

  /**
   * Sealed ground as a courtyard of flagstones in the owner's colour. A wash of colour
   * was hard to read at a glance under textured grass; paving says "held" by itself.
   */
  drawTerritory(state: MatchState, view: ViewTransform): void {
    this.courtLayer.removeChildren();
    const variants = this.art.generators.terrain.courtyardVariants;
    for (let i = 0; i < state.territory.length; i++) {
      const owner = (state.territory[i] as number) - 1;
      if (owner < 0) continue;
      const x = i % state.width;
      const y = (i - x) / state.width;
      const sprite = this.place(this.courtLayer, KEY.court((x * 5 + y * 3) % variants), view, x, y);
      sprite.tint = washed(playerColour(this.art, owner, 'light'), 0.55);
      sprite.alpha = 0.8;
    }
    const g = this.territoryGfx;
    g.clear();
    dimEliminated(g, state, view);
  }

  drawStructures(state: MatchState, view: ViewTransform): void {
    this.structureLayer.removeChildren();
    // Shadows first, under everything that casts them.
    const shade = new Graphics();
    this.structureLayer.addChild(shade);
    this.dropShadows(shade, state, view);

    // Cracks last only the round they were made in: the walls are dressed again by
    // the time the next barrage comes.
    for (const [index, crack] of this.cracks) {
      if (crack.round !== state.round || state.structure[index] !== Structure.Wall) {
        this.cracks.delete(index);
      }
    }
    const worst = this.art.generators.wall.damageStates - 1;
    const rubbleVariants = this.art.generators.wall.rubbleVariants;

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

        const owner = (state.owner[i] as number) - 1;
        if (owner < 0) {
          // An eliminated player's wall: still in the way, but nobody's any more.
          this.place(this.structureLayer, KEY.rubble((x * 3 + y * 7) % rubbleVariants), view, x, y);
          continue;
        }
        const damage = Math.min(worst, this.cracks.get(i)?.level ?? 0);
        const sprite = this.place(this.structureLayer, KEY.wall(mask, damage), view, x, y);
        sprite.tint = washed(playerColour(this.art, owner, 'light'), 0.15);
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

  /**
   * What stands up casts a shadow onto the ground to its south, as the light falls on
   * the generated sprites from the north. With the front faces, it is what lifts the
   * walls off the map. Rubble casts none; it is lying down.
   */
  private dropShadows(g: Graphics, state: MatchState, view: ViewTransform): void {
    const depth = view.tile * 0.35;
    for (let i = 0; i < state.structure.length; i++) {
      if (state.structure[i] !== Structure.Wall || state.owner[i] === 0) continue;
      const x = i % state.width;
      const y = (i - x) / state.width;
      if (y + 1 < state.height && state.structure[i + state.width] === Structure.Wall) continue;
      g.rect(tileX(view, x), tileY(view, y + 1), view.tile, depth);
    }
    for (const castle of state.castles) {
      g.rect(tileX(view, castle.x), tileY(view, castle.y + castle.h), castle.w * view.tile, depth);
    }
    g.fill({ color: hex(this.art.palette.shadow), alpha: this.art.generators.wall.shadowAlpha });
    for (const cannon of state.cannons) {
      g.ellipse(
        tileX(view, cannon.x + cannon.w / 2 + 0.12),
        tileY(view, cannon.y + cannon.h / 2 + 0.2),
        (cannon.w * view.tile) / 2 - 1,
        (cannon.h * view.tile) / 2 - 2,
      );
    }
    g.fill({ color: hex(this.art.palette.shadow), alpha: this.art.generators.wall.shadowAlpha });
  }

  /**
   * A shot lands, and what it hits decides how it looks: the sea takes it in a splash,
   * open ground in a blast and a puff of dust, a wall in a blast that leaves the breach
   * smouldering.
   */
  noteImpact(x: number, y: number, debris: readonly Debris[]): void {
    const inSea =
      this.terrain !== null &&
      x >= 0 &&
      y >= 0 &&
      x < this.width &&
      this.terrain[y * this.width + x] !== Terrain.Land;
    if (inSea) {
      this.splash(x, y);
      return;
    }
    this.blasts.push({ x, y, age: 0 });
    this.scorch(x, y);
    if (debris.length === 0) this.dust(x, y);
    for (const block of debris) {
      this.smoulders.push({ x: block.x, y: block.y, age: 0, seed: Math.random() * 10 });
    }
    // The blocks either side of a breach are shaken too.
    const worst = this.art.generators.wall.damageStates - 1;
    for (const block of debris) {
      for (const [dx, dy] of [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ] as const) {
        const nx = block.x + dx;
        const ny = block.y + dy;
        if (nx < 0 || ny < 0 || nx >= this.width) continue;
        const index = ny * this.width + nx;
        const level = Math.min(worst, (this.cracks.get(index)?.level ?? 0) + 1);
        this.cracks.set(index, { level, round: this.round });
      }
    }
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

  /**
   * A piece set down: it settles, and kicks up a little dust from its outer edges —
   * light and brief, a stone laid rather than a shot landing.
   */
  noteLanding(cells: readonly Cell[], owner: number): void {
    this.landings.add(cells, owner);
    const inPiece = new Set(cells.map((c) => `${c.x},${c.y}`));
    const colour = hex(this.art.palette.sand);
    const count = this.art.effects.landingDustPerEdge;
    for (const cell of cells) {
      for (const [dx, dy] of [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ] as const) {
        if (inPiece.has(`${cell.x + dx},${cell.y + dy}`)) continue;
        for (let k = 0; k < count; k++) {
          const along = Math.random() - 0.5;
          this.fragments.push({
            x: cell.x + 0.5 + dx * 0.5 + (dy === 0 ? 0 : along),
            y: cell.y + 0.5 + dy * 0.5 + (dx === 0 ? 0 : along),
            vx: dx * (0.6 + Math.random() * 0.8),
            vy: dy * (0.6 + Math.random() * 0.8) - 0.8,
            age: 0,
            colour,
          });
        }
      }
    }
  }

  /** Rings on the water, and spray thrown up and falling back. */
  private splash(x: number, y: number): void {
    this.splashes.push({ x, y, age: 0 });
    const colour = hex(this.art.palette.waterFoam);
    for (let k = 0; k < 8; k++) {
      const angle = Math.random() * Math.PI * 2;
      this.fragments.push({
        x: x + 0.5,
        y: y + 0.5,
        vx: Math.cos(angle) * (0.8 + Math.random()),
        vy: -2.2 - Math.random() * 1.8,
        age: 0,
        colour,
      });
    }
  }

  /** Earth thrown up by a shot that hit open ground. */
  private dust(x: number, y: number): void {
    const colours = [hex(this.art.palette.sand), hex(this.art.palette.craterMid)];
    for (let k = 0; k < 7; k++) {
      this.fragments.push({
        x: x + 0.5,
        y: y + 0.5,
        vx: (Math.random() - 0.5) * 3,
        vy: -1.5 - Math.random() * 2,
        age: 0,
        colour: colours[k % 2] as number,
      });
    }
  }

  /** Leaves a scorch mark where a shot came down on land, replacing any older one. */
  private scorch(x: number, y: number): void {
    if (this.terrain === null || x < 0 || y < 0 || x >= this.width) return;
    const index = y * this.width + x;
    if (this.terrain[index] !== Terrain.Land) return;
    this.craters = this.craters.filter((c) => c.index !== index);
    const variant = Math.floor(Math.random() * this.art.generators.fx.craterDecalVariants);
    this.craters.push({ index, variant, round: this.round });
    this.layoutCraters();
  }

  /** The banner takes a swept block: a puff of its stone, lighter than a hit's. */
  noteCrumble(block: Debris): void {
    const colour =
      block.owner < 0 ? hex(this.art.palette.rockMid) : playerColour(this.art, block.owner, 'base');
    const count = Math.ceil(this.art.generators.fx.debrisPerTile / 2);
    for (let k = 0; k < count; k++) {
      this.fragments.push({
        x: block.x + 0.2 + Math.random() * 0.6,
        y: block.y + 0.2 + Math.random() * 0.6,
        vx: (Math.random() - 0.5) * 1.2,
        vy: -1 - Math.random() * 1.2,
        age: 0,
        colour,
      });
    }
  }

  noteShot(shot: Shot): void {
    const angle = Math.atan2(shot.toX - shot.fromX, -(shot.toY - shot.fromY));
    this.aims.set(shot.cannonId, { angle, firedAgo: 0 });
    // Smoke from the muzzle, blown out along the barrel and then drifting off. The
    // shot's origin is the tile at the gun's centre, so the muzzle is half a tile on
    // from there plus the barrel's length.
    const reach = this.art.generators.cannon.barrelLengthPx / this.art.tileSizePx + 0.15;
    const mx = shot.fromX + 0.5 + Math.sin(angle) * reach;
    const my = shot.fromY + 0.5 - Math.cos(angle) * reach;
    for (let k = 0; k < this.art.generators.fx.muzzleSmokePuffs; k++) {
      const push = 0.4 + Math.random() * 0.5;
      this.puffs.push({
        x: mx,
        y: my,
        vx: Math.sin(angle) * push + (Math.random() - 0.5) * 0.3,
        vy: -Math.cos(angle) * push - 0.25 + (Math.random() - 0.5) * 0.3,
        age: -k * 60,
      });
    }
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
      // Toward the other teams: a teammate's castle is not what a gun faces.
      const owner = state.players[castle.islandId - 1];
      if (owner === undefined || owner.team === state.players[cannon.owner]?.team) continue;
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

    this.clock += frame.deltaMs;
    this.animateWater(frame.deltaMs);
    this.effectLayer.removeChildren();
    this.effectLayer.addChild(g);
    this.age(state);

    drawSealGlow(g, view, frame.sealGlow, this.art);
    this.landings.draw(g, view, this.art, frame.deltaMs);
    this.fireworks.draw(g, view, this.art, frame.celebrate, frame.deltaMs);
    this.drawSplashes(view, frame.deltaMs);
    this.drawSmoulders(view, frame.deltaMs);
    this.drawBarrels(state, view, frame.deltaMs);
    this.drawInertSmoke(state, view);
    this.drawPuffs(view, frame.deltaMs);
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

      // Height sold twice: the ball grows as it nears the top of its arc, as if
      // coming toward the viewer, and its shadow on the ground shrinks and fades.
      const height = Math.min(1, lift / 3);
      const shadow = view.tile * 0.25 * (1 - 0.45 * height);
      g.circle(tileX(view, x + 0.5), tileY(view, y + 0.5), shadow);
      g.fill({ color: hex(this.art.palette.shadow), alpha: 0.4 - 0.2 * height });

      const size = 0.6 * (1 + 0.55 * height);
      const ball = this.place(this.effectLayer, KEY.shot, view, 0, 0, size);
      ball.x = tileX(view, x + 0.5) - (view.tile * size) / 2;
      ball.y = tileY(view, y + 0.5 - lift) - (view.tile * size) / 2;

      drawShotTarget(g, view, state, shot, t, this.art, frame.humanPlayer);
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

  /** Two rings spreading and fading on the water where a shot went in. */
  private drawSplashes(view: ViewTransform, deltaMs: number): void {
    const g = this.effectGfx;
    const span = this.art.generators.fx.splashMs;
    const foam = hex(this.art.palette.waterFoam);
    const white = hex(this.art.palette.uiInk);
    for (const splash of this.splashes) {
      splash.age += deltaMs;
      const cx = tileX(view, splash.x + 0.5);
      const cy = tileY(view, splash.y + 0.5);
      // The plume where it went in, gone in the first third.
      const plume = splash.age / span / 0.35;
      if (plume < 1) {
        g.circle(cx, cy - view.tile * 0.25 * plume, view.tile * 0.32 * (1 - plume * 0.6));
        g.fill({ color: white, alpha: 0.85 * (1 - plume) });
      }
      for (const [lag, colour] of [
        [0, white],
        [0.3, foam],
      ] as const) {
        const t = splash.age / span - lag;
        if (t <= 0 || t >= 1) continue;
        g.ellipse(cx, cy, view.tile * (0.25 + 0.95 * t), view.tile * (0.15 + 0.6 * t));
        g.stroke({ width: Math.max(2, view.tile / 7), color: colour, alpha: 0.9 * (1 - t) });
      }
    }
    this.splashes = this.splashes.filter((s) => s.age < span * 1.3);
  }

  /**
   * A breach smoulders for a while: smoke curling up from it and embers winking at the
   * ground, dying away together. It marks where the wall was hit long after the blast.
   */
  private drawSmoulders(view: ViewTransform, deltaMs: number): void {
    const g = this.effectGfx;
    const span = this.art.generators.fx.smoulderMs;
    // Dark, as burning stone and timber give off, and so it reads against the grass
    // where grey vanished.
    const smoke = hex(this.art.palette.rockDark);
    const embers = [hex(this.art.palette.emberHot), hex(this.art.palette.emberMid)];
    for (const s of this.smoulders) {
      s.age += deltaMs;
      const life = 1 - s.age / span;
      if (life <= 0) continue;
      for (let k = 0; k < 3; k++) {
        const t = (s.age / 900 + k / 3 + s.seed) % 1;
        const x = s.x + 0.5 + Math.sin(t * 4 + s.seed) * 0.2;
        const y = s.y + 0.4 - t * 1.1;
        g.circle(tileX(view, x), tileY(view, y), view.tile * (0.14 + t * 0.28));
        g.fill({ color: smoke, alpha: 0.6 * (1 - t) * life });
      }
      for (let k = 0; k < 3; k++) {
        const flicker = Math.sin(s.age / 70 + k * 2.1 + s.seed * 3);
        if (flicker < -0.2) continue;
        const px = s.x + 0.25 + ((k * 0.37 + s.seed) % 0.5);
        const py = s.y + 0.55 + ((k * 0.23 + s.seed) % 0.3);
        const size = Math.max(2, view.tile / 8);
        g.rect(tileX(view, px), tileY(view, py), size, size);
        g.fill({ color: embers[k % 2] as number, alpha: (0.6 + 0.4 * flicker) * life });
      }
    }
    this.smoulders = this.smoulders.filter((s) => s.age < span);
  }

  /** Gun smoke: puffs slowing as they drift, swelling and thinning to nothing. */
  private drawPuffs(view: ViewTransform, deltaMs: number): void {
    const g = this.effectGfx;
    const span = this.art.generators.fx.muzzleSmokeMs;
    const colour = hex(this.art.palette.rockLight);
    const dt = deltaMs / 1000;
    for (const puff of this.puffs) {
      puff.age += deltaMs;
      if (puff.age < 0) continue;
      const drag = Math.exp(-2.5 * dt);
      puff.vx *= drag;
      puff.vy = puff.vy * drag - 0.15 * dt;
      puff.x += puff.vx * dt;
      puff.y += puff.vy * dt;
      const t = puff.age / span;
      if (t >= 1) continue;
      g.circle(tileX(view, puff.x), tileY(view, puff.y), view.tile * (0.15 + 0.35 * t));
      g.fill({ color: colour, alpha: 0.55 * (1 - t) });
    }
    this.puffs = this.puffs.filter((p) => p.age < span);
  }

  /** Fades the scorch marks as rounds pass, and forgets the ones that have gone. */
  private age(state: MatchState): void {
    if (state.round === this.round) return;
    this.round = state.round;
    const rounds = this.art.generators.fx.craterRounds;
    this.craters = this.craters.filter((c) => this.round - c.round < rounds);
    this.layoutCraters();
  }

  /**
   * An inert gun smoulders: grey puffs rise from it and fade. With its slumped barrel
   * that says "silenced" without the struck-through mark the flat style uses, which
   * reads as information rather than as part of a battlefield.
   */
  private drawInertSmoke(state: MatchState, view: ViewTransform): void {
    const g = this.effectGfx;
    const period = this.art.generators.cannon.inertSmokeMs;
    const colour = hex(this.art.palette.rockDark);
    for (const cannon of state.cannons) {
      if (cannon.active) continue;
      const cx = cannon.x + cannon.w / 2;
      const cy = cannon.y + cannon.h / 2;
      for (let k = 0; k < 3; k++) {
        const t = (this.clock / period + k / 3 + cannon.id * 0.37) % 1;
        const x = cx + Math.sin(t * 5 + cannon.id) * 0.18;
        const y = cy - 0.2 - t * 1.3;
        g.circle(tileX(view, x), tileY(view, y), view.tile * (0.12 + t * 0.22));
        g.fill({ color: colour, alpha: 0.45 * (1 - t) });
      }
    }
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
        cannon.active ? KEY.barrel(step, recoil) : KEY.droop(step),
        view,
        cannon.x,
        cannon.y,
        cannon.w,
      );
      // The owner's light colour, a step above the base's, so the barrel reads on it.
      sprite.tint = cannon.active
        ? washed(playerColour(this.art, cannon.owner, 'light'), 0.45)
        : hex(this.art.palette.rockMid);

      if (cannon.active && kick < flashFrames) {
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
    this.flags.update(frame.castleSealed, this.clock, this.art);
    for (const castle of state.castles) {
      const raised = this.flags.raised(castle.id, this.clock, this.art);
      if (raised === null) continue;
      // A pole rising from the middle of the castle, the banner hoisted to its head
      // above the roofline, where it reads from across the map.
      const poleX = tileX(view, castle.x + castle.w / 2);
      const top = tileY(view, castle.y) - view.tile * 0.9;
      const length = view.tile * 1.4;
      const pole = Math.max(2, Math.round(view.tile / 10));
      g.rect(poleX - pole / 2, top, pole, length);
      g.fill({ color: hex(this.art.palette.rockDark) });
      const sprite = new Sprite(texture);
      sprite.width = view.tile * 0.8;
      sprite.height = (view.tile * 0.8 * texture.height) / Math.max(1, texture.width);
      sprite.x = poleX + pole / 2;
      sprite.y = top + (1 - raised) * (length - sprite.height);
      // A flag coming down after a breach is struck in a darker shade.
      sprite.tint = playerColour(
        this.art,
        castle.islandId - 1,
        this.flags.lowering(castle.id) ? 'dark' : 'base',
      );
      this.effectLayer.addChild(sprite);
    }
  }

  /**
   * The piece in hand as the wall it would make: each block joined to the others and to
   * the wall already standing, so a player sees the shape they are about to have rather
   * than a stencil. Whether it fits stays plain — the player's colour when it does, red
   * when it does not, each with an outline in the style's usual valid or invalid ink.
   */
  private drawGhostWall(
    state: MatchState,
    view: ViewTransform,
    ghost: Ghost,
    humanPlayer: number,
  ): void {
    const anchor = ghost.tile;
    if (anchor === null) return;
    const cells = ghost.cells.map(([ox, oy]) => ({ x: anchor.x + ox, y: anchor.y + oy }));
    const inPiece = new Set(cells.map((c) => `${c.x},${c.y}`));
    const joins = (x: number, y: number): boolean =>
      inPiece.has(`${x},${y}`) ||
      (x >= 0 &&
        y >= 0 &&
        x < state.width &&
        y < state.height &&
        state.structure[y * state.width + x] === Structure.Wall);
    const tint = ghost.valid
      ? washed(playerColour(this.art, humanPlayer, 'light'), 0.15)
      : hex(this.art.palette.uiInvalid);
    for (const { x, y } of cells) {
      let mask = 0;
      if (joins(x, y - 1)) mask |= N;
      if (joins(x + 1, y)) mask |= E;
      if (joins(x, y + 1)) mask |= S;
      if (joins(x - 1, y)) mask |= W;
      const sprite = this.place(this.ghostLayer, KEY.wall(mask, 0), view, x, y);
      sprite.tint = tint;
      sprite.alpha = ghost.valid ? 0.8 : 0.6;
    }
    // Round the piece's outside only; lines between its own blocks would cut up the
    // joined wall the sprites just drew.
    const g = this.overlayGfx;
    for (const { x, y } of cells) {
      const left = tileX(view, x);
      const top = tileY(view, y);
      const right = left + view.tile;
      const bottom = top + view.tile;
      if (!inPiece.has(`${x},${y - 1}`)) g.moveTo(left, top).lineTo(right, top);
      if (!inPiece.has(`${x + 1},${y}`)) g.moveTo(right, top).lineTo(right, bottom);
      if (!inPiece.has(`${x},${y + 1}`)) g.moveTo(left, bottom).lineTo(right, bottom);
      if (!inPiece.has(`${x - 1},${y}`)) g.moveTo(left, top).lineTo(left, bottom);
    }
    g.stroke({
      width: 1,
      color: ghost.valid ? hex(this.art.palette.uiValid) : hex(this.art.palette.uiInvalid),
      alpha: 0.8,
    });
  }

  /** Cycles the sea through its generated frames. */
  private animateWater(deltaMs: number): void {
    // The surf breathes along the coast, each tile a little out of step with the next.
    const cycle = this.art.generators.terrain.foamCycleMs;
    for (const surf of this.surf) {
      const t = (this.clock / cycle + surf.phase) * Math.PI * 2;
      surf.sprite.alpha = 0.45 + 0.4 * Math.sin(t);
    }
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
    this.ghostLayer.removeChildren();
    drawOvertimeBorder(g, state, view, this.art, performance.now());

    for (const castle of ghost.selectable) {
      g.rect(
        tileX(view, castle.x),
        tileY(view, castle.y),
        castle.w * view.tile,
        castle.h * view.tile,
      );
      g.stroke({ width: 2, color: hex(this.art.palette.uiAccent) });
    }

    drawBuildHints(g, view, ghost, this.art, performance.now());

    if (!ghost.tile) return;
    const colour = ghost.valid ? hex(this.art.palette.uiValid) : hex(this.art.palette.uiInvalid);

    if (state.phase === 'build' && ghost.cells.length > 0) {
      this.drawGhostWall(state, view, ghost, humanPlayer);
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

    if (ghost.aiming) drawFireReticle(g, view, ghost, this.art, humanPlayer);
  }
}

/**
 * Distance from each tile of the drawn area to the nearest land, in tiles, capped at
 * `limit`. Euclidean, measured outright within the limit: a breadth-first flood gave
 * Manhattan distance, and the sea stepped in diamonds. Run only when the terrain is
 * drawn, so a few million comparisons at eight players cost nothing that matters. The
 * drawn area runs past the board by the given margins, which are open sea.
 */
export function seaDepth(
  state: MatchState,
  marginX: number,
  marginY: number,
  limit: number,
): Float32Array {
  const w = state.width + marginX * 2;
  const h = state.height + marginY * 2;
  const depth = new Float32Array(w * h).fill(limit);
  const reach = Math.ceil(limit);
  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      if (state.terrain[y * state.width + x] !== Terrain.Land) continue;
      const cx = x + marginX;
      const cy = y + marginY;
      for (let dy = -reach; dy <= reach; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -reach; dx <= reach; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= w) continue;
          const d = Math.sqrt(dx * dx + dy * dy);
          const j = ny * w + nx;
          if (d < (depth[j] as number)) depth[j] = d;
        }
      }
    }
  }
  return depth;
}
