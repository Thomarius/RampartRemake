import { z } from 'zod';

export const IslandLayoutSchema = z.enum(['rotational', 'mirror']);
export type IslandLayout = z.infer<typeof IslandLayoutSchema>;

export const TerrainConfigSchema = z
  .strictObject({
    gridWidth: z.number().int().min(16).max(512),
    gridHeight: z.number().int().min(16).max(512),
    /** How the single generated island is replicated into N fair player islands. */
    layout: IslandLayoutSchema,

    island: z.strictObject({
      targetAreaTiles: z.number().int().positive(),
      /** Accepted deviation from targetAreaTiles, as a fraction. */
      areaTolerance: z.number().min(0).max(1),
      noiseOctaves: z.number().int().min(1).max(8),
      noiseFrequency: z.number().positive(),
      coastlineRoughness: z.number().min(0).max(1),
      /** Minimum water separation between any two islands. */
      minWaterGapTiles: z.number().int().positive(),
      erosionPasses: z.number().int().nonnegative().max(8),
    }),

    castles: z.strictObject({
      perIsland: z.number().int().positive(),
      footprint: z.tuple([z.number().int().positive(), z.number().int().positive()]),
      minSpacingTiles: z.number().int().nonnegative(),
      minDistanceFromShoreTiles: z.number().int().nonnegative(),
    }),

    startingWall: z.strictObject({
      /** Radius of the auto-built ring granted around the chosen starting castle. */
      ringRadiusTiles: z.number().int().positive(),
    }),

    generation: z.strictObject({
      maxRetries: z.number().int().positive(),
    }),
  })
  .refine((t) => t.island.targetAreaTiles < t.gridWidth * t.gridHeight, {
    message: 'island.targetAreaTiles must be smaller than the grid',
    path: ['island', 'targetAreaTiles'],
  });

export type TerrainConfig = z.infer<typeof TerrainConfigSchema>;
