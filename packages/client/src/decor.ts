import type { ArtConfig } from '@rampart/config';
import { Rng } from '@rampart/sim';

import { Pixels } from './render/pixel/canvas.js';
import { water } from './render/pixel/generators.js';

/**
 * The menu and lobby's dressing: a pixel-art title in the stone of the game's walls, and
 * the game's own animated sea behind the panel. Generated from the palette like every
 * sprite in the game, so nothing binary is committed and the colours cannot drift.
 */

/**
 * Letters as 5x7 bitmaps, `#` for stone. Only those the title uses: this is a logo, not
 * a font, and a letter it lacks is left out rather than guessed at.
 */
const GLYPHS: Record<string, readonly string[]> = {
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
};

/** Pixels per bitmap cell: each cell is one dressed stone. */
const STONE = 4;

/**
 * A word set in stone blocks — a light top edge, a shaded bottom, a drop shadow — as a
 * data URL to show with nearest-neighbour scaling.
 */
export function stoneTitle(text: string, art: ArtConfig): string {
  const letters = [...text.toUpperCase()].map((c) => GLYPHS[c]).filter((g) => g !== undefined);
  const cells = letters.length * 6 - 1;
  const p = new Pixels(cells * STONE + 2, 7 * STONE + 2);
  const { rockLight, rockMid, rockDark, shadow, uiAccent } = art.palette;
  letters.forEach((glyph, n) => {
    glyph.forEach((row, y) => {
      [...row].forEach((cell, x) => {
        if (cell !== '#') return;
        const px = (n * 6 + x) * STONE;
        const py = y * STONE;
        p.rect(px + 2, py + 2, STONE, STONE, shadow, 0.8);
        p.rect(px, py, STONE, STONE, rockMid);
        p.rect(px, py, STONE, 1, rockLight);
        p.rect(px, py + STONE - 1, STONE, 1, rockDark);
        p.rect(px + STONE - 1, py, 1, STONE, rockDark, 0.6);
      });
    });
  });
  // A thread of gold along the top of each letter, the lobby's accent colour.
  letters.forEach((glyph, n) => {
    [...(glyph[0] ?? '')].forEach((cell, x) => {
      if (cell === '#') p.rect((n * 6 + x) * STONE, 0, STONE, 1, uiAccent, 0.8);
    });
  });
  return p.canvas.toDataURL();
}

/**
 * Lays the game's sea behind the whole page and sets it drifting. Once per page: the
 * match's canvas covers it entirely, so it can stay put underneath.
 */
export function installBackdrop(art: ArtConfig): void {
  if (document.querySelector('#backdrop') !== null) return;
  const frames = 4;
  const size = art.tileSizePx;
  // Several tiles side by side, so the pattern repeats less obviously than one would.
  const sheet = new Pixels(size * frames, size);
  const rng = new Rng(7);
  const ctx = sheet.canvas.getContext('2d');
  for (let f = 0; f < frames; f++) {
    ctx?.drawImage(water(art, rng, size, f, frames).canvas, f * size, 0);
  }
  const backdrop = document.createElement('div');
  backdrop.id = 'backdrop';
  backdrop.style.backgroundImage = `url(${sheet.canvas.toDataURL()})`;
  backdrop.style.backgroundSize = `${size * frames * 3}px ${size * 3}px`;
  document.body.prepend(backdrop);
}
