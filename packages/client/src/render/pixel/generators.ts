import type { ArtConfig } from '@rampart/config';
import { Rng } from '@rampart/sim';

import type { Texture } from 'pixi.js';

import { Atlas, Pixels } from './canvas.js';

/**
 * Every sprite in the game, drawn from code.
 *
 * Nothing here is authored art and nothing is loaded from disk. Terrain, walls,
 * castles and cannons are generated in neutral stone and grass and tinted per player
 * at draw time, which keeps the atlas small and means the two visual styles cannot
 * drift apart on colour: both read the same palette.
 *
 * Generation is seeded, so the same map always produces the same speckle.
 */

export const KEY = {
  water: (frame: number) => `water.${frame}`,
  grass: (variant: number) => `grass.${variant}`,
  rock: (variant: number) => `rock.${variant}`,
  shore: (mask: number) => `shore.${mask}`,
  wall: (mask: number, damage: number) => `wall.${mask}.${damage}`,
  castle: 'castle',
  cannon: 'cannon',
  shot: 'shot',
  crater: (variant: number) => `crater.${variant}`,
  blast: (frame: number) => `blast.${frame}`,
} as const;

/** Adjacency bitmask order: north, east, south, west. */
export const N = 1;
export const E = 2;
export const S = 4;
export const W = 8;

function water(art: ArtConfig, rng: Rng, size: number, frame: number, frames: number): Pixels {
  const p = new Pixels(size, size);
  const { waterDeep, waterMid, waterShallow, waterFoam } = art.palette;
  p.fill(waterMid);

  // Slow horizontal swell, offset per frame so the sea drifts rather than flickers.
  const phase = (frame / frames) * size;
  for (let y = 0; y < size; y++) {
    const shift = Math.round(Math.sin(((y + phase) / size) * Math.PI * 2) * 2);
    for (let x = 0; x < size; x++) {
      const band = (x + shift + y * 3) % 7;
      if (band === 0) p.set(x, y, waterDeep, 0.5);
      else if (band === 3) p.set(x, y, waterShallow, 0.4);
    }
  }
  p.speckle(rng, waterFoam, 0.012);
  return p;
}

function grass(art: ArtConfig, rng: Rng, size: number): Pixels {
  const p = new Pixels(size, size);
  const { grassDark, grassMid, grassLight } = art.palette;
  p.fill(grassMid);
  p.speckle(rng, grassDark, 0.18);
  p.speckle(rng, grassLight, 0.1);
  // A few tufts, so the ground is not pure noise.
  for (let i = 0; i < 3; i++) {
    const x = rng.nextInt(size);
    const y = rng.nextInt(size);
    p.set(x, y, grassLight);
    p.set(x, y - 1, grassLight);
  }
  return p;
}

function rock(art: ArtConfig, rng: Rng, size: number): Pixels {
  const p = new Pixels(size, size);
  const { rockDark, rockMid, rockLight } = art.palette;
  p.fill(rockMid);
  p.speckle(rng, rockDark, 0.22);
  p.speckle(rng, rockLight, 0.12);
  return p;
}

/**
 * Land that meets water, keyed by which sides the sea is on.
 *
 * Generated for all 256 neighbour combinations rather than the usual reduced blob set:
 * at 16 pixels a tile the whole run costs a few kilobytes, and covering every case
 * outright is far less error-prone than mapping corners onto a 47-tile set.
 */
function shore(art: ArtConfig, rng: Rng, size: number, mask: number): Pixels {
  const p = grass(art, rng, size);
  const { sand, waterFoam } = art.palette;
  const fringe = 3;

  const edge = (side: number, at: (i: number, depth: number) => [number, number]): void => {
    if ((mask & side) === 0) return;
    for (let i = 0; i < size; i++) {
      for (let depth = 0; depth < fringe; depth++) {
        // Ragged rather than ruler-straight, so coastlines do not look stamped.
        if (depth === fringe - 1 && rng.nextFloat() < 0.5) continue;
        const [x, y] = at(i, depth);
        p.set(x, y, sand);
        if (depth === 0 && rng.nextFloat() < 0.35) p.set(x, y, waterFoam);
      }
    }
  };

  edge(N, (i, d) => [i, d]);
  edge(S, (i, d) => [i, size - 1 - d]);
  edge(W, (i, d) => [d, i]);
  edge(E, (i, d) => [size - 1 - d, i]);

  // Diagonal-only neighbours get a corner dab, otherwise a headland reads as square.
  const corners: [number, number, number, number][] = [
    [16, 0, 0, 1],
    [32, size - 1, 0, -1],
    [64, size - 1, size - 1, -1],
    [128, 0, size - 1, 1],
  ];
  for (const [bit, cx, cy, dx] of corners) {
    if ((mask & bit) === 0) continue;
    const dy = cy === 0 ? 1 : -1;
    for (let i = 0; i < fringe; i++) {
      for (let j = 0; j < fringe - i; j++) {
        p.set(cx + dx * i, cy + dy * j, sand);
      }
    }
  }
  return p;
}

/**
 * A wall block, keyed by which sides it joins and how battered it is.
 *
 * The join mask is what makes a run of blocks read as a continuous wall: a block
 * carries a dark seam on every side with nothing next to it, and none where it meets
 * its neighbour.
 */
function wall(art: ArtConfig, rng: Rng, size: number, mask: number, damage: number): Pixels {
  const p = new Pixels(size, size);
  const { rockDark, rockMid, rockLight, shadow, craterDark } = art.palette;
  p.fill(rockMid);

  // Courses of stone, offset row to row.
  const course = 5;
  for (let y = 0; y < size; y++) {
    if (y % course === 0) {
      for (let x = 0; x < size; x++) p.set(x, y, rockDark, 0.75);
    }
    const band = Math.floor(y / course);
    for (let x = band % 2 === 0 ? 0 : 4; x < size; x += 8) {
      for (let d = 0; d < course; d++) p.set(x, y - d, rockDark, 0.5);
    }
  }
  p.speckle(rng, rockLight, 0.08);

  // Outer seam on unconnected sides, highlight on the north face.
  if ((mask & N) === 0) for (let x = 0; x < size; x++) p.set(x, 0, shadow, 0.8);
  if ((mask & S) === 0) for (let x = 0; x < size; x++) p.set(x, size - 1, shadow, 0.8);
  if ((mask & W) === 0) for (let y = 0; y < size; y++) p.set(0, y, shadow, 0.8);
  if ((mask & E) === 0) for (let y = 0; y < size; y++) p.set(size - 1, y, shadow, 0.8);
  if ((mask & N) === 0) for (let x = 0; x < size; x++) p.set(x, 1, rockLight, 0.45);

  // Damage chews the block from its edges inward.
  for (let level = 0; level < damage; level++) {
    for (let i = 0; i < size; i++) {
      const x = rng.nextInt(size);
      const y = rng.nextInt(size);
      const edgeish = x < 3 || y < 3 || x > size - 4 || y > size - 4;
      if (!edgeish && rng.nextFloat() < 0.6) continue;
      p.set(x, y, level === 0 ? craterDark : shadow, 0.85);
    }
  }
  return p;
}

/** The keep: a walled block with battlements, a gate and a banner. */
function castle(art: ArtConfig, rng: Rng, size: number): Pixels {
  const p = new Pixels(size, size);
  const { rockMid, rockLight, rockDark, shadow, uiAccent } = art.palette;
  const merlon = art.generators.castle.battlementPeriodPx;

  p.rect(1, 3, size - 2, size - 4, rockMid);
  p.speckle(rng, rockDark, 0.12, (_x, y) => y > 3 && y < size - 2);
  p.speckle(rng, rockLight, 0.08, (_x, y) => y > 3 && y < size - 2);

  // Battlements along the top.
  for (let x = 1; x < size - 1; x++) {
    const solid = Math.floor(x / merlon) % 2 === 0;
    if (solid) p.rect(x, 1, 1, 3, rockMid);
    else p.rect(x, 3, 1, 1, rockDark);
  }
  for (let x = 1; x < size - 1; x++) p.set(x, 1, rockLight, 0.6);

  // Corner towers.
  for (const tx of [1, size - 5]) {
    p.rect(tx, 1, 4, size - 2, rockMid);
    p.rect(tx, 1, 4, 1, rockLight);
    for (let y = 2; y < size - 1; y++) p.set(tx, y, rockLight, 0.35);
  }

  // Gate and banner.
  const gate = Math.floor(size / 2);
  p.rect(gate - 2, size - 7, 4, 6, shadow);
  p.disc(gate, size - 7, 2, shadow);
  p.rect(gate - 1, 4, 2, 5, uiAccent);
  p.set(gate + 1, 5, uiAccent);
  p.set(gate + 1, 6, uiAccent);

  for (let x = 1; x < size - 1; x++) p.set(x, size - 1, shadow, 0.7);
  return p;
}

/** A gun emplacement: stone base, banded barrel, muzzle facing out. */
function cannon(art: ArtConfig, size: number): Pixels {
  const p = new Pixels(size, size);
  const { rockDark, rockMid, rockLight, shadow, emberMid } = art.palette;

  p.disc(size / 2 - 0.5, size / 2 - 0.5, size / 2 - 1, rockMid);
  p.disc(size / 2 - 0.5, size / 2 - 0.5, size / 2 - 3, rockDark);

  const barrelW = 5;
  const left = Math.floor((size - barrelW) / 2);
  p.rect(left, 1, barrelW, size / 2 + 2, rockDark);
  p.rect(left, 1, 1, size / 2 + 2, rockLight);
  p.rect(left + barrelW - 1, 1, 1, size / 2 + 2, shadow);
  p.rect(left - 1, 1, barrelW + 2, 2, rockLight);
  p.rect(left + 1, 1, barrelW - 2, 1, emberMid, 0.5);

  p.disc(size / 2 - 0.5, size / 2 + 3, 2, rockLight);
  return p;
}

function shot(art: ArtConfig, size: number): Pixels {
  const p = new Pixels(size, size);
  p.disc(size / 2 - 0.5, size / 2 - 0.5, size / 2 - 0.5, art.palette.shadow);
  p.disc(size / 2 - 0.5, size / 2 - 0.5, size / 2 - 1.5, art.palette.rockLight);
  p.set(size / 2 - 1, size / 2 - 1, art.palette.uiInk);
  return p;
}

function crater(art: ArtConfig, rng: Rng, size: number): Pixels {
  const p = new Pixels(size, size);
  const { craterDark, craterMid } = art.palette;
  p.disc(size / 2 - 0.5, size / 2 - 0.5, size / 2 - 2, craterMid);
  p.disc(size / 2 - 0.5, size / 2 - 0.5, size / 2 - 4, craterDark);
  p.speckle(rng, craterDark, 0.25);
  return p;
}

/** One frame of an expanding blast, hot core fading to smoke. */
function blast(art: ArtConfig, rng: Rng, size: number, frame: number, frames: number): Pixels {
  const p = new Pixels(size, size);
  const { emberHot, emberMid, emberCool, shadow } = art.palette;
  const t = frame / (frames - 1);
  const radius = (size / 2) * (0.25 + t * 0.75);
  const centre = size / 2 - 0.5;

  p.disc(centre, centre, radius, t < 0.6 ? emberCool : shadow);
  p.disc(centre, centre, radius * 0.7, t < 0.5 ? emberMid : emberCool);
  if (t < 0.45) p.disc(centre, centre, radius * 0.4, emberHot);

  for (let i = 0; i < 10; i++) {
    const angle = rng.nextFloat() * Math.PI * 2;
    const d = radius * (0.8 + rng.nextFloat() * 0.4);
    p.set(
      Math.round(centre + Math.cos(angle) * d),
      Math.round(centre + Math.sin(angle) * d),
      emberMid,
    );
  }
  return p;
}

/** Generates every sprite and packs them into one texture. */
export function buildAtlas(art: ArtConfig, seed: number): Map<string, Texture> {
  const tile = art.tileSizePx;
  const gen = art.generators;
  const atlas = new Atlas();
  const rng = new Rng(seed);

  for (let f = 0; f < gen.terrain.waterAnimFrames; f++) {
    atlas.add(KEY.water(f), water(art, rng, tile, f, gen.terrain.waterAnimFrames));
  }
  for (let v = 0; v < gen.terrain.grassVariants; v++)
    atlas.add(KEY.grass(v), grass(art, rng, tile));
  for (let v = 0; v < gen.terrain.rockVariants; v++) atlas.add(KEY.rock(v), rock(art, rng, tile));
  for (let mask = 0; mask < 256; mask++) atlas.add(KEY.shore(mask), shore(art, rng, tile, mask));

  for (let mask = 0; mask < 16; mask++) {
    for (let damage = 0; damage < gen.wall.damageStates; damage++) {
      atlas.add(KEY.wall(mask, damage), wall(art, rng, tile, mask, damage));
    }
  }

  atlas.add(KEY.castle, castle(art, rng, tile * 3));
  atlas.add(KEY.cannon, cannon(art, tile * 2));
  atlas.add(KEY.shot, shot(art, 8));
  for (let v = 0; v < gen.fx.craterDecalVariants; v++)
    atlas.add(KEY.crater(v), crater(art, rng, tile));
  for (let f = 0; f < gen.fx.explosionFrames; f++) {
    atlas.add(KEY.blast(f), blast(art, rng, tile * 2, f, gen.fx.explosionFrames));
  }

  return atlas.build(art.atlasSizePx);
}
