import type { EnclosureResult, MatchState } from '@rampart/sim';

/**
 * What the board should point out to a player who is building.
 *
 * A pure function of the state, so it can be tested without a browser, as `banners.ts`
 * is. While nothing of theirs is sealed, their castles are outlined: that is the round
 * they are about to lose a life over.
 *
 * It used to mark the gap as well — the cells of the cheapest repair. Removed after the
 * first human play: the marks were hard to tell from the piece ghost and from wall
 * already laid, and they read as the only way to close the wall, when any shape that
 * closes it will do.
 */
export interface BuildHints {
  /** The player's castles, when none of them is sealed. */
  unsealed: readonly { x: number; y: number; w: number; h: number }[];
}

const NONE: BuildHints = { unsealed: [] };

export function buildHints(
  state: MatchState,
  humanPlayer: number,
  live: EnclosureResult,
): BuildHints {
  if (state.phase !== 'build') return NONE;
  const player = state.players[humanPlayer];
  if (player === undefined || player.eliminated) return NONE;
  // Something sealed is a round survived; the rest is ambition, and not ours to point at.
  if ((live.enclosedCastlesByPlayer[humanPlayer] ?? 0) > 0) return NONE;
  return { unsealed: state.castles.filter((c) => c.islandId === player.islandId) };
}
