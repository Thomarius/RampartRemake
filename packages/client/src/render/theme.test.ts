import { ArtStyleSchema, defaultArtConfig } from '@rampart/config';
import { describe, expect, it } from 'vitest';

import { stateFromAscii } from '@rampart/sim';

import { seaDepth } from './pixel.js';
import { createTheme } from './scene.js';
import { hex, playerColour, tileX, tileY, type ViewTransform } from './theme.js';

const view: ViewTransform = { tile: 10, originX: 4, originY: 7 };

describe('theme helpers', () => {
  it('parses palette colours', () => {
    expect(hex('#ff8000')).toBe(0xff8000);
    expect(hex('#000000')).toBe(0);
  });

  it('maps tiles to screen space', () => {
    expect(tileX(view, 0)).toBe(4);
    expect(tileX(view, 3)).toBe(34);
    expect(tileY(view, 2)).toBe(27);
    // Fractional tiles are used for shot interpolation, so they must not round.
    expect(tileX(view, 1.5)).toBe(19);
  });

  it('gives each player a distinct colour', () => {
    const colours = new Set(
      defaultArtConfig.players.map((_, i) => playerColour(defaultArtConfig, i, 'base')),
    );
    expect(colours.size).toBe(defaultArtConfig.players.length);
  });

  it('cycles rather than failing if a match outgrows the palette', () => {
    const count = defaultArtConfig.players.length;
    expect(playerColour(defaultArtConfig, count, 'base')).toBe(
      playerColour(defaultArtConfig, 0, 'base'),
    );
  });
});

describe('theme selection', () => {
  it('builds the style named in the config', () => {
    expect(createTheme('flat').id).toBe('flat');
  });

  it('builds the pixel style', () => {
    expect(createTheme('pixel').id).toBe('pixel');
  });

  it('covers every style the config allows', () => {
    // A style nameable in config but missing here would be a black screen.
    for (const style of ArtStyleSchema.options) {
      expect(createTheme(style).id).toBe(style);
    }
  });
});

describe('sea depth, for shading the pixel style', () => {
  it('measures straight-line distance to the nearest land, capped', () => {
    const state = stateFromAscii(`
      .....
      .....
      ..,..
      .....
      .....
    `);
    const depth = seaDepth(state, 0, 0, 2);
    const at = (x: number, y: number): number => depth[y * 5 + x] as number;
    expect(at(2, 2)).toBe(0);
    expect(at(3, 2)).toBe(1);
    // Diagonal is not two steps, which is what made the sea step in diamonds.
    expect(at(3, 3)).toBeCloseTo(Math.SQRT2);
    expect(at(0, 0)).toBe(2);
  });

  it('counts the margin beyond the board as open sea', () => {
    const state = stateFromAscii(`
      ,
    `);
    const depth = seaDepth(state, 1, 1, 3);
    // A 3x3 drawn area with the one land tile in the middle.
    expect(Array.from(depth.slice(3, 6))).toEqual([1, 0, 1]);
  });
});
