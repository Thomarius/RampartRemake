import { NEIGHBOURS_4 } from './grid.js';
import { Structure, type MatchState } from './types.js';

/**
 * Clears away wall that is doing no work, between the build phase and the next
 * barrage.
 *
 * One rule, applied once: **a wall block with fewer than two orthogonal wall
 * neighbours is swept.** Every block is judged against the board as it stood at the
 * end of the build phase, and the ones that fail go together — so removing a block
 * never condemns its neighbour in the same sweep.
 *
 * That "once" is the whole of it, and it is what the original did. A straight run of
 * three blocks loses both ends, because each has only the middle for company, and the
 * middle survives even though it is left standing alone: it had two neighbours when
 * the question was asked. Next round it will have none, and then it goes.
 *
 * Cascading instead — removing loose ends until none are left, which is the 2-core of
 * the wall graph — takes far too much. It unravels a five-block spur to nothing in one
 * resolution, so a wall half-built towards another castle is simply gone by the time
 * its builder comes back to it, and work can never be carried across a round.
 *
 * Nor is there any requirement that a wall reach sealed ground. Wall stranded out in
 * the open is left alone, because it is not litter: it is an obstacle, standing where
 * a cannon cannot be placed and where a future wall has to route around.
 *
 * Neighbours are counted orthogonally, deliberately: a wall seals only when it is
 * 4-connected, so this is exactly the connectivity that makes a wall a wall. It also
 * means **a loop that encloses anything can never be swept**, whatever else is
 * happening on the board — every block of a loop has two orthogonal neighbours.
 */
export function sweepOrphanedWalls(state: MatchState): number[] {
  const { width: w, height: h, structure } = state;
  const size = w * h;

  // Marked first, removed after. Judging each block against a board that is already
  // being dismantled is what turns one pass into a cascade.
  const marked: number[] = [];

  for (let i = 0; i < size; i++) {
    if (structure[i] !== Structure.Wall) continue;
    const x = i % w;
    const y = (i - x) / w;

    let count = 0;
    for (const [ox, oy] of NEIGHBOURS_4) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (structure[ny * w + nx] === Structure.Wall) count++;
    }
    if (count < 2) marked.push(i);
  }

  for (const i of marked) {
    structure[i] = Structure.Empty;
    state.owner[i] = 0;
  }
  return marked;
}
