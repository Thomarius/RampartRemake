import { cheapestPlanFor } from '@rampart/ai';
import { NEIGHBOURS_4, Structure, type EnclosureResult, type MatchState } from '@rampart/sim';

/**
 * What the board should point out to a player who is building.
 *
 * A pure function of the state, so it can be tested without a browser, as `banners.ts`
 * is. The bots know exactly where their wall leaks — it is a minimum cut — and a person
 * has to find it by eye against the clock, which is the difference that most often costs
 * them a life. So when nothing of theirs is sealed, the castles are marked and, if the
 * gap is small, so is the gap.
 */
export interface BuildHints {
  /** Empty tiles that would seal a castle, when the gap is short enough to be a gap. */
  leak: readonly number[];
  /** The player's castles, when none of them is sealed. */
  unsealed: readonly { x: number; y: number; w: number; h: number }[];
}

/**
 * The most cells a leak may need and still be shown. Beyond this it is not a gap in a
 * wall but a wall still to be built, and drawing it would be building it for them.
 * Twelve, because that is the top of what a round's barrage leaves: the soak of ARCHIVE
 * 10s measured repairs of 3-12 cells, and a typical first-round breach is about nine.
 */
export const MAX_LEAK_CELLS = 12;

const NONE: BuildHints = { leak: [], unsealed: [] };

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

  const unsealed = state.castles.filter((c) => c.islandId === player.islandId);
  // The repair that keeps the player's guns inside, as the bots' does: the tightest wall
  // regardless would often be a small new ring that abandons every cannon they own.
  const plan = cheapestPlanFor(state, humanPlayer, 1, 1, undefined, true);
  const missing = plan?.tiles.filter((i) => state.structure[i] === Structure.Empty) ?? [];
  // A gap is a hole in a wall that stands, so every run of missing cells reaches that
  // wall somewhere — though not every cell does: the corner of a missing run touches
  // only its neighbours in the run. A run out in open ground is a wall still to be
  // designed, and is not drawn.
  const neighbours = (i: number): number[] => {
    const x = i % state.width;
    const y = (i - x) / state.width;
    const out: number[] = [];
    for (const [ox, oy] of NEIGHBOURS_4) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx >= 0 && ny >= 0 && nx < state.width && ny < state.height) {
        out.push(ny * state.width + nx);
      }
    }
    return out;
  };
  const ownWall = (j: number): boolean =>
    state.structure[j] === Structure.Wall && state.islandId[j] === player.islandId;
  const wanted = new Set(missing);
  const reached = new Set(missing.filter((i) => neighbours(i).some(ownWall)));
  const queue = [...reached];
  while (queue.length > 0) {
    for (const j of neighbours(queue.pop() as number)) {
      if (wanted.has(j) && !reached.has(j)) {
        reached.add(j);
        queue.push(j);
      }
    }
  }
  const isGap = missing.length <= MAX_LEAK_CELLS && reached.size === missing.length;
  return { leak: isGap ? missing : [], unsealed };
}
