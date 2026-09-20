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

export interface BannerText {
  player: number;
  text: string;
  eliminated: boolean;
}

function lifeWord(count: number): string {
  return count === 1 ? 'life' : 'lives';
}

export function bannersFor(
  state: MatchState,
  livesLost: ReadonlyMap<number, LifeLost>,
): BannerText[] {
  // Once the match is over the winner has the screen; nothing else needs saying.
  if (state.phase === 'game_over') return [];

  const out: BannerText[] = [];
  for (const player of state.players as readonly PlayerState[]) {
    // Out for good, and it stays up for the rest of the match so nobody has to
    // remember who is still in it.
    if (player.eliminated) {
      out.push({ player: player.id, text: `${player.name} is out`, eliminated: true });
      continue;
    }
    const lost = livesLost.get(player.id);
    if (lost === undefined || state.tick >= lost.untilTick) continue;
    out.push({
      player: player.id,
      text:
        `${player.name} lost a life — ` +
        (lost.remaining > 0 ? `${lost.remaining} ${lifeWord(lost.remaining)} left` : 'last life'),
      eliminated: false,
    });
  }
  return out;
}
