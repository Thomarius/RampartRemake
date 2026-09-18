import { defaultArtConfig } from '@rampart/config';
import { describe, expect, it } from 'vitest';

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

  it('falls back rather than failing on a style that is not implemented yet', () => {
    // The pixel style arrives in M3b. Until it does, asking for it must still
    // produce a working renderer instead of a black screen.
    expect(() => createTheme('pixel')).not.toThrow();
    expect(createTheme('pixel').id).toBe('flat');
  });
});
