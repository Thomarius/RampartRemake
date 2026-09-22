import { describe, expect, it } from 'vitest';

import {
  type AudioManifest,
  ArtConfigSchema,
  AudioManifestSchema,
  MUSIC_CUES,
  RulesetSchema,
  SFX_CUES,
  ServerConfigSchema,
  TerrainConfigSchema,
  assertValidConfigBundle,
  defaultArtConfig,
  defaultAudioManifest,
  defaultConfigBundle,
  defaultRuleset,
  defaultServerConfig,
  defaultTerrainConfig,
  applySettings,
  defaultSettings,
  mergeSettings,
  validateConfigBundle,
} from './index.js';

describe('shipped config files', () => {
  it('all parse against their schemas', () => {
    expect(defaultRuleset.tickRateHz).toBe(30);
    expect(defaultTerrainConfig.patterns).toHaveLength(7);
    expect(defaultArtConfig.players.length).toBeGreaterThanOrEqual(defaultRuleset.players.max);
    expect(defaultServerConfig.port).toBe(8080);
  });

  it('encode the agreed design decisions', () => {
    // A complete wall loop on land is required; the coastline gives you nothing.
    expect(defaultRuleset.enclosure.shorelineCountsAsWall).toBe(false);
    // One sealed region holding K castles counts as K.
    expect(defaultRuleset.enclosure.sharedRegionCountsAllCastles).toBe(true);
    // Only walls are damageable.
    expect(defaultRuleset.shots.damagesCastles).toBe(false);
    expect(defaultRuleset.shots.damagesCannons).toBe(false);
    // The one self-correcting force in the game.
    expect(defaultRuleset.cannons.inertWhenNotEnclosed).toBe(true);
    // 1 castle -> 2 cannons, each further castle -> +1.
    expect(defaultRuleset.cannons.firstCastleReward).toBe(2);
    expect(defaultRuleset.cannons.perAdditionalCastleReward).toBe(1);
    // Not shared, because a continue rewinds one player's piece schedule to round one
    // and theirs alone. The schema refuses the two together, so this is the consequence
    // of resetPieceScheduleOnContinue rather than a free choice.
    expect(defaultRuleset.elimination.resetPieceScheduleOnContinue).toBe(true);
    expect(defaultRuleset.build.sharedPieceSequence).toBe(false);
    // Two lives beyond the first, as in the original.
    expect(defaultRuleset.elimination.continues).toBe(2);
    expect(defaultRuleset.build.restrictToOwnIsland).toBe(true);
  });

  it('pass cross-file validation', () => {
    expect(validateConfigBundle(defaultConfigBundle)).toEqual([]);
  });
});

describe('schema strictness', () => {
  it('rejects unknown keys rather than silently ignoring them', () => {
    const withTypo = { ...defaultRuleset, tickRateHZ: 60 };
    expect(RulesetSchema.safeParse(withTypo).success).toBe(false);
  });

  it('rejects a malformed colour', () => {
    const bad = {
      ...defaultArtConfig,
      palette: { ...defaultArtConfig.palette, waterDeep: 'blue' },
    };
    expect(ArtConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a player range that cannot be satisfied', () => {
    const bad = { ...defaultRuleset, players: { min: 4, max: 2 } };
    expect(RulesetSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an island larger than the map', () => {
    const bad = {
      ...defaultTerrainConfig,
      island: { ...defaultTerrainConfig.island, targetAreaTiles: 999_999 },
    };
    expect(TerrainConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an out-of-range port', () => {
    expect(ServerConfigSchema.safeParse({ ...defaultServerConfig, port: 0 }).success).toBe(false);
  });
});

describe('audio manifest', () => {
  it('covers every cue the code can trigger', () => {
    for (const cue of SFX_CUES) expect(defaultAudioManifest.sfx[cue]).toBeDefined();
    for (const cue of MUSIC_CUES) expect(defaultAudioManifest.music[cue]).toBeDefined();
  });

  it('rejects a cue name the code does not know about', () => {
    const bad = {
      ...defaultAudioManifest,
      sfx: { ...defaultAudioManifest.sfx, dragon_roar: { file: 'x.ogg', volume: 1 } },
    };
    expect(AudioManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('reports a missing cue through bundle validation', () => {
    const { cannon_fire: _dropped, ...sfx } = defaultAudioManifest.sfx;
    const problems = validateConfigBundle({
      ...defaultConfigBundle,
      audio: { ...defaultAudioManifest, sfx: sfx as AudioManifest['sfx'] },
    });
    expect(problems).toContain('audio: missing sfx cue "cannon_fire".');
  });
});

describe('cross-file validation', () => {
  it('catches an island that would fill its generation box', () => {
    // The box is a frame to draw in and it needs slack: an island that nearly fills it
    // has its coastline pinned by the frame rather than by the noise, and every seed
    // then produces the same map. That generates perfectly and looks fine in a single
    // screenshot, which is exactly why it is worth a startup error.
    const island = defaultTerrainConfig.island;
    const problems = validateConfigBundle({
      ...defaultConfigBundle,
      terrain: {
        ...defaultTerrainConfig,
        island: { ...island, targetAreaTiles: island.boxWidth * island.boxHeight - 1 },
      },
    });
    expect(problems.some((p) => p.includes('no room to vary between seeds'))).toBe(true);
  });

  it('catches a player count with nowhere to put the islands', () => {
    const problems = validateConfigBundle({
      ...defaultConfigBundle,
      terrain: {
        ...defaultTerrainConfig,
        patterns: defaultTerrainConfig.patterns.filter((pattern) => pattern.players !== 3),
      },
    });
    expect(problems).toContain('terrain: no island pattern for 3 players.');
  });

  it('catches too few player palettes for the allowed player count', () => {
    const problems = validateConfigBundle({
      ...defaultConfigBundle,
      art: { ...defaultArtConfig, players: defaultArtConfig.players.slice(0, 2) },
    });
    expect(problems.some((p) => p.startsWith('art:'))).toBe(true);
  });

  it('catches a starting wall ring too large for the island', () => {
    const problems = validateConfigBundle({
      ...defaultConfigBundle,
      terrain: {
        ...defaultTerrainConfig,
        startingWall: { ringRadiusTiles: 40 },
      },
    });
    expect(problems.some((p) => p.includes('starting wall ring'))).toBe(true);
  });

  it('throws with every problem listed at once', () => {
    expect(() =>
      assertValidConfigBundle({
        ...defaultConfigBundle,
        art: { ...defaultArtConfig, players: [] as never },
        terrain: { ...defaultTerrainConfig, startingWall: { ringRadiusTiles: 40 } },
      }),
    ).toThrow(/Invalid configuration/);
  });
});

describe('lobby settings', () => {
  const bounds = { maxRounds: { min: 5, max: 20 } };

  it('opens on the ruleset cap, pulled inside the bounds', () => {
    const rules = (maxRounds: number | null) => ({
      ...defaultRuleset,
      scoring: { ...defaultRuleset.scoring, maxRounds },
    });
    expect(defaultSettings(rules(10), bounds)).toEqual({ maxRounds: 10 });
    expect(defaultSettings(rules(99), bounds)).toEqual({ maxRounds: 20 });
    // Uncapped is a testing setup; a room cannot offer it, so it opens at the longest.
    expect(defaultSettings(rules(null), bounds)).toEqual({ maxRounds: 20 });
  });

  it('refuses a change outside the bounds rather than clamping it', () => {
    expect(mergeSettings({ maxRounds: 10 }, { maxRounds: 7 }, bounds)).toEqual({ maxRounds: 7 });
    expect(mergeSettings({ maxRounds: 10 }, { maxRounds: 21 }, bounds)).toBeNull();
    expect(mergeSettings({ maxRounds: 10 }, { maxRounds: 4 }, bounds)).toBeNull();
  });

  it('applies over the ruleset and re-validates the result', () => {
    expect(applySettings(defaultRuleset, { maxRounds: 7 }).scoring.maxRounds).toBe(7);
    expect(() => applySettings(defaultRuleset, { maxRounds: 0 })).toThrow();
  });

  it("insists the bounds include the ruleset's own cap", () => {
    const problems = validateConfigBundle({
      ...defaultConfigBundle,
      server: { ...defaultServerConfig, lobbySettings: { maxRounds: { min: 12, max: 20 } } },
    });
    expect(problems.some((p) => p.includes('lobbySettings.maxRounds'))).toBe(true);
  });
});
