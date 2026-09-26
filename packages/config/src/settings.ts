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
  /** Players per team; one is free-for-all. */
  teamSize: z.number().int().positive(),
});
export type MatchSettings = z.infer<typeof MatchSettingsSchema>;

const RangeSchema = z
  .strictObject({ min: z.number().int().positive(), max: z.number().int().positive() })
  .refine((r) => r.max >= r.min, { message: 'max must be >= min', path: ['max'] });

export const SettingBoundsSchema = z.strictObject({
  maxRounds: RangeSchema,
  teamSize: RangeSchema,
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
  return { maxRounds: clamp(rounds, bounds.maxRounds), teamSize: 1 };
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
  const within = (value: number, range: { min: number; max: number }): boolean =>
    value >= range.min && value <= range.max;
  if (!within(next.maxRounds, bounds.maxRounds)) return null;
  if (!within(next.teamSize, bounds.teamSize)) return null;
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

/**
 * The player counts a team size allows: at least two teams, all of that size. Free-for-
 * all allows every count. So within 2–8, size 2 allows 4, 6 and 8; size 3 only 6; size 4
 * only 8.
 */
export function validPlayerCounts(
  teamSize: number,
  players: { min: number; max: number },
): number[] {
  const out: number[] = [];
  for (let n = players.min; n <= players.max; n++) {
    if (teamSize === 1 || (n % teamSize === 0 && n / teamSize >= 2)) out.push(n);
  }
  return out;
}

/** Seats into teams in order: the first `teamSize` seats are team 0, and so on. */
export function defaultTeams(playerCount: number, teamSize: number): number[] {
  return Array.from({ length: playerCount }, (_, seat) => Math.floor(seat / teamSize));
}

/** Whether a seat-to-team assignment makes teams of exactly `teamSize`, numbered from 0. */
export function teamsBalanced(teams: readonly number[], teamSize: number): boolean {
  if (teams.length === 0 || teams.length % teamSize !== 0) return false;
  const count = teams.length / teamSize;
  if (teamSize > 1 && count < 2) return false;
  const sizes = new Array<number>(count).fill(0);
  for (const team of teams) {
    if (!Number.isInteger(team) || team < 0 || team >= count) return false;
    sizes[team] = (sizes[team] as number) + 1;
  }
  return sizes.every((size) => size === teamSize);
}
