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
      /**
       * Added to the intermission when somebody spends a continue or is knocked out,
       * so the banner announcing it has the board to itself. In the ruleset rather
       * than the client because it lengthens a phase, and phase length is part of what
       * every client has to agree on.
       */
      continueBannerMs: ms,
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
      /**
       * Whether a shot may destroy wall its own player built. Off, a target on your own
       * island is refused outright and only a live opponent's wall is ever cleared —
       * otherwise shooting a spare stretch of your own wall would score for damage you
       * were going to repair anyway.
       */
      damagesOwnWalls: z.boolean(),
    }),

    build: z.strictObject({
      /**
       * After the build clock runs out, a short window in which every player may place
       * the one piece they are holding, and no more — so a piece being lined up as the
       * clock hit zero is not simply lost. Ends early once everyone still in has used
       * it. Zero turns it off.
       */
      overtimeMs: z.number().int().nonnegative(),
      /** All players draw from one seeded sequence, so luck is never a factor. */
      sharedPieceSequence: z.boolean(),
      previewCount: z.number().int().nonnegative().max(5),
      allowSkip: z.boolean(),
      restrictToOwnIsland: z.boolean(),
      /** Piece names must exist in the simulation's catalogue. Weights are relative. */
      pieces: z
        .array(
          z.strictObject({
            name: z.string().min(1),
            weight: z.number().positive(),
          }),
        )
        .min(1),
      /**
       * Which piece sizes are in the bag, by round.
       *
       * The draw narrows as a match goes on: small pieces that can plug any gap give
       * way to large ones that cannot, so sealing gets harder for everyone. This is
       * the game's difficulty ramp, and the one thing in the rules that forces a long
       * match toward a resolution.
       *
       * Each band applies from its round until the next one begins; the last runs to
       * the end of the match.
       */
      sizeSchedule: z
        .array(
          z.strictObject({
            fromRound: z.number().int().nonnegative(),
            sizes: z.array(z.number().int().min(1).max(5)).min(1),
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
      /**
       * Between the build phase and the next barrage, clear wall that is doing no
       * work: loose ends, and anything not linked to sealed ground. Without it the
       * board silts up with stray blocks, and the space a cannon needs goes with it.
       */
      sweepOrphanedWalls: z.boolean(),
    }),

    elimination: z.strictObject({
      onZeroEnclosedCastles: z.boolean(),
      simultaneousIsDraw: z.boolean(),
      /**
       * Lives. Failing to seal a castle spends one instead of ending the match: the
       * island is wiped, a fresh castle is chosen, and a new ring is raised around it.
       * Zero means failing is final, which is how the game behaved before this existed.
       */
      continues: z.number().int().nonnegative(),
      /**
       * Extra opening cannons per continue already spent, so a player on their last
       * life fields more guns than one on their first.
       */
      extraCannonsPerContinue: z.number().int().nonnegative(),
      /**
       * Whether a continue also rewinds the player's piece schedule to round one.
       *
       * The schedule widens with the round, so this hands somebody starting again the
       * small pieces they need to close a ring — and leaves whoever has survived
       * longest working with the awkward ones. It makes the round a *personal* count,
       * which is why it cannot coexist with a shared piece sequence.
       */
      resetPieceScheduleOnContinue: z.boolean(),
    }),

    /**
     * Points, banked at each build-phase resolution by every player holding a sealed
     * castle. With a cap they decide most matches, so these weights are the balance.
     */
    scoring: z.strictObject({
      /**
       * The match ends at the resolution of this round, and the highest-scoring
       * survivor wins. Null means no cap, which exists for tests about elimination:
       * the game is balanced around the cap, and a host cannot choose to lift it.
       */
      maxRounds: z.number().int().positive().nullable(),
      /** Per opponent's wall tile destroyed during the round. */
      wallPoints: z.number().int().nonnegative(),
      /** Times total enclosed tiles times total enclosed castles. */
      tilePoints: z.number().int().nonnegative(),
      /**
       * Whether damage still scores for a player who ends the round without a sealed
       * castle. Off by default: failing to seal forfeits the round's points entirely.
       */
      scoreDamageOnFailedRound: z.boolean(),
    }),
  })
  .refine((r) => r.players.max >= r.players.min, {
    message: 'players.max must be >= players.min',
    path: ['players', 'max'],
  })
  .refine((r) => !r.elimination.resetPieceScheduleOnContinue || !r.build.sharedPieceSequence, {
    // Rewinding one player's schedule is precisely that player drawing from a
    // different bag from everybody else, so the two cannot both be true. Checking it
    // here means the consequence has to be written down in the config rather than
    // discovered in a match.
    message:
      'elimination.resetPieceScheduleOnContinue requires build.sharedPieceSequence to be false',
    path: ['elimination', 'resetPieceScheduleOnContinue'],
  })
  .refine((r) => r.shots.damagesWalls, {
    message: 'shots.damagesWalls must be true — walls are the only damageable structure',
    path: ['shots', 'damagesWalls'],
  });

export type Ruleset = z.infer<typeof RulesetSchema>;
