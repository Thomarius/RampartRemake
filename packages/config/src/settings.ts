import { z } from 'zod';

import { RulesetSchema, type Ruleset } from './ruleset.js';

/**
 * What a host may change about a match before it starts.
 *
 * An explicit list of typed settings rather than overrides by path into the ruleset:
 * each one is a decision to let players choose it, and each has bounds declared in
 * server config, so "no rule is hardcoded" holds for the ranges too. Game speed, team
 * mode and special weapons are meant to join `maxRounds` here.
 */
export const MatchSettingsSchema = z.strictObject({
  /** Whole numbers only: the game is balanced around the cap, so it cannot be lifted. */
  maxRounds: z.number().int().positive(),
});
export type MatchSettings = z.infer<typeof MatchSettingsSchema>;

const RangeSchema = z
  .strictObject({ min: z.number().int().positive(), max: z.number().int().positive() })
  .refine((r) => r.max >= r.min, { message: 'max must be >= min', path: ['max'] });

export const SettingBoundsSchema = z.strictObject({
  maxRounds: RangeSchema,
});
export type SettingBounds = z.infer<typeof SettingBoundsSchema>;

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, value));
}

/**
 * The settings a room opens with: the ruleset's own values, pulled inside the bounds.
 * An uncapped ruleset — a testing setup — opens at the longest match a host could pick.
 */
export function defaultSettings(ruleset: Ruleset, bounds: SettingBounds): MatchSettings {
  const rounds = ruleset.scoring.maxRounds ?? bounds.maxRounds.max;
  return { maxRounds: clamp(rounds, bounds.maxRounds) };
}

/**
 * A host's change applied over the current settings, or null if any part of it is out
 * of bounds. All or nothing, so a half-valid request cannot leave a mixed result.
 */
export function mergeSettings(
  current: MatchSettings,
  change: Partial<MatchSettings>,
  bounds: SettingBounds,
): MatchSettings | null {
  const next = { ...current, ...change };
  const { min, max } = bounds.maxRounds;
  if (next.maxRounds < min || next.maxRounds > max) return null;
  return next;
}

/**
 * The ruleset a match actually runs on. Re-validated, so a setting can never produce
 * rules the schema would refuse; the result travels in the snapshot like any ruleset.
 */
export function applySettings(ruleset: Ruleset, settings: MatchSettings): Ruleset {
  return RulesetSchema.parse({
    ...ruleset,
    scoring: { ...ruleset.scoring, maxRounds: settings.maxRounds },
  });
}
