import { z } from 'zod';

export const DifficultySchema = z.enum(['recruit', 'gunner', 'marshal']);
export type DifficultyName = z.infer<typeof DifficultySchema>;

/**
 * How a bot plays, in human units.
 *
 * Rates are milliseconds between actions rather than per-tick probabilities: a
 * probability is opaque, does not survive a change to the tick rate or a phase
 * length, and cannot be compared against what a person actually manages. These can.
 */
export const BotProfileSchema = z.strictObject({
  /**
   * Time to place a piece, as `base + perCell * cells`. Placement slows with piece
   * complexity because a larger shape takes longer to fit — which is why a human's
   * rate falls from roughly 25 pieces a build phase early to 15 late, as the size
   * bands widen.
   */
  placementBaseMs: z.number().int().nonnegative(),
  placementPerCellMs: z.number().int().nonnegative(),

  /** Time between shots. Clicking is fast, so this is small; the reload is the real limit. */
  fireIntervalMs: z.number().int().nonnegative(),

  /** Chance of shooting somewhere other than the opponent's weakest point. */
  aimJitter: z.number().min(0).max(1),

  /** Most castles it will try to bring inside one wall. */
  maxCastles: z.number().int().min(1),

  /**
   * Appetite for a wall it may not finish. A plan is attempted when its cost fits
   * inside the pieces the bot can still lay this phase, times this. Below 1 it
   * insists on slack; above 1 it will gamble on finishing, and losing that gamble
   * means no castle enclosed and elimination.
   */
  riskMargin: z.number().positive(),

  /** Ticks between recomputing the plan. */
  replanTicks: z.number().int().positive(),

  /** Whether it fires at the strongest opponent rather than one at random. */
  picksTarget: z.boolean(),
});
export type BotProfile = z.infer<typeof BotProfileSchema>;

export const AiConfigSchema = z.strictObject({
  profiles: z.record(DifficultySchema, BotProfileSchema),
});
export type AiConfig = z.infer<typeof AiConfigSchema>;
