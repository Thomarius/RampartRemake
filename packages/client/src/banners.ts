import type { MatchState, PlayerState } from '@rampart/sim';

/**
 * What the banners over the islands should say.
 *
 * Separated from the drawing so it can be tested without a browser. The timing window
 * is the part with something to get wrong, and it only shows itself a dozen rounds into
 * a match — which is exactly the sort of thing playing the game never checks.
 */

/** A life lost, as the client recorded it from a `player_continued` event. */
export interface LifeLost {
  remaining: number;
  /** The tick at which the announcement stops being news. */
  untilTick: number;
}

/** Points banked at a resolution, as the client recorded them from `round_resolved`. */
export interface PointsGained {
  amount: number;
  untilTick: number;
}

export interface BannerText {
  player: number;
  text: string;
  eliminated: boolean;
  /** Points just banked, rather than news about a life. */
  gain: boolean;
}

function lifeWord(count: number): string {
  return count === 1 ? 'life' : 'lives';
}

export function bannersFor(
  state: MatchState,
  livesLost: ReadonlyMap<number, LifeLost>,
  gained: ReadonlyMap<number, PointsGained> = new Map(),
): BannerText[] {
  // Once the match is over the winner has the screen; nothing else needs saying.
  if (state.phase === 'game_over') return [];

  const out: BannerText[] = [];
  for (const player of state.players as readonly PlayerState[]) {
    // Out for good, and it stays up for the rest of the match so nobody has to
    // remember who is still in it.
    if (player.eliminated) {
      out.push({
        player: player.id,
        text: `${player.name} is out`,
        eliminated: true,
        gain: false,
      });
      continue;
    }
    const lost = livesLost.get(player.id);
    if (lost === undefined || state.tick >= lost.untilTick) {
      // A life lost banks nothing, so the two never compete for the same island.
      const points = gained.get(player.id);
      if (points !== undefined && points.amount > 0 && state.tick < points.untilTick) {
        out.push({ player: player.id, text: `+${points.amount}`, eliminated: false, gain: true });
      }
      continue;
    }
    out.push({
      player: player.id,
      text:
        `${player.name} lost a life — ` +
        (lost.remaining > 0 ? `${lost.remaining} ${lifeWord(lost.remaining)} left` : 'last life'),
      eliminated: false,
      gain: false,
    });
  }
  return out;
}
