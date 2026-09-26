import type { MatchState } from './types.js';

/**
 * Team relations, kept apart from the match so the shot and placement rules can ask them
 * without importing the match that imports them.
 */

/** Whether two players are on the same team — a player is on their own, too. */
export function sameTeam(state: MatchState, a: number, b: number): boolean {
  const pa = state.players[a];
  const pb = state.players[b];
  return pa !== undefined && pb !== undefined && pa.team === pb.team;
}

/** A team's score: the sum of its members' own. */
export function teamScore(state: MatchState, team: number): number {
  let total = 0;
  for (const p of state.players) if (p.team === team) total += p.score;
  return total;
}
