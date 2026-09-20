import { z } from 'zod';

/**
 * How the player islands are arranged.
 *
 * `ring` puts them on a circle, so every player has the same two neighbours at the
 * same distance — uniform, and the right answer for odd counts. `grid` packs them in
 * rows, which is tighter but gives edge and middle seats different neighbourhoods.
 * Which is worth more depends on the count, so it is a table rather than a rule.
 */
export const PatternKindSchema = z.enum(['ring', 'grid']);
export type PatternKind = z.infer<typeof PatternKindSchema>;

export const IslandPatternSchema = z
  .strictObject({
    players: z.number().int().min(2).max(8),
    kind: PatternKindSchema,
    /** Grid only; ignored by a ring. */
    cols: z.number().int().positive().optional(),
    rows: z.number().int().positive().optional(),
  })
  .refine((p) => p.kind !== 'grid' || (p.cols !== undefined && p.rows !== undefined), {
    message: 'a grid pattern needs cols and rows',
  })
  .refine((p) => p.kind !== 'grid' || (p.cols ?? 0) * (p.rows ?? 0) >= p.players, {
    message: 'cols x rows must be at least players',
  });
export type IslandPattern = z.infer<typeof IslandPatternSchema>;

export const TerrainConfigSchema = z
  .strictObject({
    /**
     * One pattern per supported player count. The map's dimensions are not configured:
     * they are measured from the island box and the pattern, so a count that needs a
     * bigger map gets one instead of being squeezed into a fixed grid.
     */
    patterns: z.array(IslandPatternSchema).min(1),

    island: z.strictObject({
      /**
       * The rectangle one island is generated inside.
       *
       * Every island is this box, transformed and translated, so the box is what the
       * map is measured from. It wants real slack over `targetAreaTiles`: an island
       * that nearly fills its box has its coastline pinned by the box rather than by
       * the noise, and every seed then produces the same map.
       */
      boxWidth: z.number().int().min(8).max(256),
      boxHeight: z.number().int().min(8).max(256),
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
  .refine((t) => t.island.targetAreaTiles < t.island.boxWidth * t.island.boxHeight, {
    message: 'island.targetAreaTiles must be smaller than the island box',
    path: ['island', 'targetAreaTiles'],
  });

export type TerrainConfig = z.infer<typeof TerrainConfigSchema>;
