import { defaultArtConfig, defaultTerrainConfig } from '@rampart/config';
import { describe, expect, it } from 'vitest';

import { matchPalette } from './colours.js';
import { LocalMatch } from './localMatch.js';
import { islandCentres, tablePreview } from './preview.js';

describe('the table preview', () => {
  it('shows the map the match will be played on', () => {
    const preview = tablePreview(1234, 3, [0, 1, 2], defaultArtConfig, defaultTerrainConfig);
    const match = new LocalMatch({ seed: 1234, seats: [null, 'gunner', 'gunner'] });
    expect(preview.terrain.width).toBe(match.state.width);
    expect(preview.terrain.height).toBe(match.state.height);
    expect(Array.from(preview.terrain.terrain)).toEqual(Array.from(match.state.terrain));
  });

  it('deals each seat the island and colour the match will give it', () => {
    for (const seed of [1, 2, 3, 99, 4000000000]) {
      const teams = [0, 1, 1, 0];
      const preview = tablePreview(seed, 4, teams, defaultArtConfig, defaultTerrainConfig);
      // The host holds seat 0; the match says which player they became.
      const match = new LocalMatch({ seed, seats: [null, 'gunner', 'gunner', 'gunner'], teams });
      expect(preview.playerOfSeat[0]).toBe(match.humanPlayer);
      const palette = matchPalette(defaultArtConfig, match.state);
      preview.playerOfSeat.forEach((player, seat) => {
        expect(preview.colourOfSeat[seat]).toEqual(palette[player]);
      });
      // Seats given the same team are teammates in the match. The labels themselves are
      // renumbered by first appearance among the players, so compare who is with whom.
      const teamOf = (seat: number): number | undefined =>
        match.state.players[preview.playerOfSeat[seat] as number]?.team;
      expect(teamOf(0)).toBe(teamOf(3));
      expect(teamOf(1)).toBe(teamOf(2));
      expect(teamOf(0)).not.toBe(teamOf(1));
    }
  });

  it('changes when the seed does', () => {
    const a = tablePreview(1, 3, [0, 1, 2], defaultArtConfig, defaultTerrainConfig);
    const b = tablePreview(2, 3, [0, 1, 2], defaultArtConfig, defaultTerrainConfig);
    expect(Array.from(a.terrain.terrain)).not.toEqual(Array.from(b.terrain.terrain));
  });

  it('finds a centre for every island, to label it with its seat', () => {
    const preview = tablePreview(5, 4, [0, 1, 2, 3], defaultArtConfig, defaultTerrainConfig);
    const centres = islandCentres(preview.terrain);
    expect([...centres.keys()].sort()).toEqual([1, 2, 3, 4]);
    for (const { x, y } of centres.values()) {
      expect(x).toBeGreaterThan(0);
      expect(y).toBeGreaterThan(0);
    }
  });
});
