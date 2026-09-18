import type { Rng } from '@rampart/sim';
import { Rectangle, Texture } from 'pixi.js';

/**
 * A tiny pixel-drawing surface.
 *
 * Sprites are generated at their true pixel size — 16 pixels to a tile — and scaled
 * up with nearest-neighbour filtering, so every edge stays hard. Drawing one pixel at
 * a time is slow per call and irrelevant here: generation happens once at boot, over
 * a few thousand pixels in total.
 */
export class Pixels {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    ctx.imageSmoothingEnabled = false;
    this.ctx = ctx;
  }

  set(x: number, y: number, colour: string, alpha = 1): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = colour;
    this.ctx.fillRect(Math.floor(x), Math.floor(y), 1, 1);
    this.ctx.globalAlpha = 1;
  }

  rect(x: number, y: number, w: number, h: number, colour: string, alpha = 1): void {
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = colour;
    this.ctx.fillRect(Math.floor(x), Math.floor(y), Math.floor(w), Math.floor(h));
    this.ctx.globalAlpha = 1;
  }

  fill(colour: string): void {
    this.rect(0, 0, this.width, this.height, colour);
  }

  /** Filled circle, rasterised so the edge stays chunky rather than antialiased. */
  disc(cx: number, cy: number, r: number, colour: string): void {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r) this.set(x, y, colour);
      }
    }
  }

  /** Scatters pixels at a given density, for grain and speckle. */
  speckle(
    rng: Rng,
    colour: string,
    density: number,
    region?: (x: number, y: number) => boolean,
  ): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (region && !region(x, y)) continue;
        if (rng.nextFloat() < density) this.set(x, y, colour);
      }
    }
  }
}

interface Entry {
  key: string;
  pixels: Pixels;
}

/**
 * Packs every generated sprite into one texture.
 *
 * A single shared texture is what keeps the whole board batching into one draw call;
 * separate textures per sprite would break the batch on every tile and put the draw
 * count into the thousands. A shelf packer is more than enough — the sprites are all
 * small and their sizes barely vary.
 */
export class Atlas {
  private readonly entries: Entry[] = [];

  add(key: string, pixels: Pixels): void {
    this.entries.push({ key, pixels });
  }

  build(size: number): Map<string, Texture> {
    const sheet = new Pixels(size, size);
    const ctx = sheet.canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    ctx.imageSmoothingEnabled = false;

    const order = [...this.entries].sort((a, b) => b.pixels.height - a.pixels.height);
    const frames = new Map<string, Rectangle>();
    let x = 0;
    let y = 0;
    let shelfHeight = 0;

    for (const entry of order) {
      const { width: w, height: h } = entry.pixels;
      if (x + w > size) {
        x = 0;
        y += shelfHeight;
        shelfHeight = 0;
      }
      if (y + h > size) {
        throw new Error(`sprite atlas of ${size}px is too small for the generated sprites`);
      }
      ctx.drawImage(entry.pixels.canvas, x, y);
      frames.set(entry.key, new Rectangle(x, y, w, h));
      x += w;
      shelfHeight = Math.max(shelfHeight, h);
    }

    const base = Texture.from(sheet.canvas);
    base.source.scaleMode = 'nearest';
    base.source.label = 'rampart-pixel-atlas';

    const textures = new Map<string, Texture>();
    for (const [key, frame] of frames) {
      textures.set(key, new Texture({ source: base.source, frame }));
    }
    return textures;
  }
}
