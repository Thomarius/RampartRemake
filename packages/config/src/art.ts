import { z } from 'zod';

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #rrggbb colour');

/**
 * Palette keys are enumerated rather than left open, so a typo in art.default.json
 * fails at startup instead of rendering an undefined colour.
 */
export const PaletteSchema = z.strictObject({
  waterDeep: HexColor,
  waterMid: HexColor,
  waterShallow: HexColor,
  waterFoam: HexColor,
  sand: HexColor,
  grassDark: HexColor,
  grassMid: HexColor,
  grassLight: HexColor,
  rockDark: HexColor,
  rockMid: HexColor,
  rockLight: HexColor,
  shadow: HexColor,
  craterDark: HexColor,
  craterMid: HexColor,
  emberHot: HexColor,
  emberMid: HexColor,
  emberCool: HexColor,
  uiInk: HexColor,
  uiPanel: HexColor,
  uiAccent: HexColor,
  uiValid: HexColor,
  uiInvalid: HexColor,
});
export type Palette = z.infer<typeof PaletteSchema>;

export const PlayerPaletteSchema = z.strictObject({
  name: z.string().min(1),
  base: HexColor,
  light: HexColor,
  dark: HexColor,
  /** Degrees of hue rotation applied to generated sprites for this player. */
  hueRotate: z.number().min(0).max(360),
});
export type PlayerPalette = z.infer<typeof PlayerPaletteSchema>;

export const ArtConfigSchema = z
  .strictObject({
    tileSizePx: z.number().int().positive(),
    atlasSizePx: z.number().int().positive(),
    pixelSnap: z.boolean(),
    scaleMode: z.enum(['nearest', 'linear']),

    palette: PaletteSchema,
    players: z.array(PlayerPaletteSchema).min(2),

    dither: z.strictObject({
      enabled: z.boolean(),
      matrix: z.enum(['bayer2', 'bayer4', 'bayer8']),
      strength: z.number().min(0).max(1),
    }),

    generators: z.strictObject({
      terrain: z.strictObject({
        grassVariants: z.number().int().positive(),
        rockVariants: z.number().int().positive(),
        shorelineTileset: z.enum(['blob47', 'edge16']),
        waterAnimFrames: z.number().int().positive(),
        waterAnimMsPerFrame: z.number().int().positive(),
        noiseDetailFrequency: z.number().positive(),
      }),
      wall: z.strictObject({
        neighbourVariants: z.literal(16),
        damageStates: z.number().int().positive(),
        blockRows: z.number().int().positive(),
        mortarJitter: z.number().min(0).max(1),
      }),
      castle: z.strictObject({
        towerCountRange: z.tuple([z.number().int().positive(), z.number().int().positive()]),
        battlementPeriodPx: z.number().int().positive(),
        bannerWidthPx: z.number().int().positive(),
        bannerWaveFrames: z.number().int().positive(),
      }),
      cannon: z.strictObject({
        rotationSteps: z.number().int().positive(),
        barrelLengthPx: z.number().int().positive(),
        recoilFrames: z.number().int().positive(),
      }),
      fx: z.strictObject({
        explosionFrames: z.number().int().positive(),
        explosionMsPerFrame: z.number().int().positive(),
        muzzleFlashFrames: z.number().int().positive(),
        craterDecalVariants: z.number().int().positive(),
        shotTrailLengthPx: z.number().int().nonnegative(),
      }),
      reticle: z.strictObject({
        sizePx: z.number().int().positive(),
        spinMsPerRevolution: z.number().int().positive(),
      }),
    }),
  })
  .refine((a) => a.generators.castle.towerCountRange[0] <= a.generators.castle.towerCountRange[1], {
    message: 'towerCountRange must be [min, max] with min <= max',
    path: ['generators', 'castle', 'towerCountRange'],
  });

export type ArtConfig = z.infer<typeof ArtConfigSchema>;
