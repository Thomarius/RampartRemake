import { z } from 'zod';

/** Shape of the crater a landed shot punches into a wall. */
export const CraterPatternSchema = z.enum(['single', 'plus5', 'square9']);
export type CraterPattern = z.infer<typeof CraterPatternSchema>;

const ms = z.number().int().nonnegative();

export const RulesetSchema = z
  .strictObject({
    tickRateHz: z.number().int().positive().max(120),

    players: z.strictObject({
      min: z.number().int().min(2),
      max: z.number().int().max(8),
    }),

    phases: z.strictObject({
      castleSelectMs: ms,
      combatMs: ms,
      buildMs: ms,
      cannonPlaceMs: ms,
      /**
       * Breathing room after a phase's clock runs out, before the announcement
       * for the next one begins. Shots still in the air land during it.
       */
      endOfPhasePauseMs: ms,
      /**
       * How long the phase announcement takes to cross the screen. The next phase
       * does not begin until it has left, so this is match timing, not decoration.
       */
      transitionBannerMs: ms,
    }),

    cannons: z.strictObject({
      startingCount: z.number().int().nonnegative(),
      /** Cannons granted for enclosing the first castle. */
      firstCastleReward: z.number().int().nonnegative(),
      /** Additional cannons per castle beyond the first. */
      perAdditionalCastleReward: z.number().int().nonnegative(),
      footprint: z.tuple([z.number().int().positive(), z.number().int().positive()]),
      /** A cannon outside an enclosed region cannot fire, but survives. */
      inertWhenNotEnclosed: z.boolean(),
      /** Hard cap on total cannons per player; null = uncapped. */
      maxTotal: z.number().int().positive().nullable(),
    }),

    shots: z.strictObject({
      baseFlightMs: ms,
      /** Flight time scales with distance: base + perTile * tiles. */
      perTileFlightMs: z.number().nonnegative(),
      maxRangeTiles: z.number().int().positive().nullable(),
      craterPattern: CraterPatternSchema,
      damagesWalls: z.boolean(),
      damagesCastles: z.boolean(),
      damagesCannons: z.boolean(),
    }),

    build: z.strictObject({
      /** All players draw from one seeded sequence, so luck is never a factor. */
      sharedPieceSequence: z.boolean(),
      previewCount: z.number().int().nonnegative().max(5),
      allowSkip: z.boolean(),
      restrictToOwnIsland: z.boolean(),
      /** Length of the generated sequence; it wraps, keeping match state bounded. */
      sequenceLength: z.number().int().positive(),
      /** Piece names must exist in the simulation's catalogue. Weights are relative. */
      pieces: z
        .array(
          z.strictObject({
            name: z.string().min(1),
            weight: z.number().positive(),
          }),
        )
        .min(1),
    }),

    enclosure: z.strictObject({
      /** False: the coastline gives you nothing, a full wall loop on land is required. */
      shorelineCountsAsWall: z.boolean(),
      /**
       * Connectivity of the escape flood, not of the wall. 8 means the sea slips
       * through a diagonal join, so a sealing wall must be a 4-connected loop and
       * has to include its corners. 4 would let a diagonal step stand in for one.
       */
      connectivity: z.union([z.literal(4), z.literal(8)]),
      /** One sealed region holding K castles counts as K. */
      sharedRegionCountsAllCastles: z.boolean(),
    }),

    elimination: z.strictObject({
      onZeroEnclosedCastles: z.boolean(),
      simultaneousIsDraw: z.boolean(),
    }),
  })
  .refine((r) => r.players.max >= r.players.min, {
    message: 'players.max must be >= players.min',
    path: ['players', 'max'],
  })
  .refine((r) => r.shots.damagesWalls, {
    message: 'shots.damagesWalls must be true — walls are the only damageable structure',
    path: ['shots', 'damagesWalls'],
  });

export type Ruleset = z.infer<typeof RulesetSchema>;
