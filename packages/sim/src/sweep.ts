import { NEIGHBOURS_4 } from './grid.js';
import { Structure, type MatchState } from './types.js';

/**
 * Clears away wall that is doing no work, between the build phase and the next
 * barrage.
 *
 * Two rules, both applied until nothing more falls:
 *
 * 1. **A wall block needs two neighbours.** Anything with fewer is a loose end, and
 *    removing it can strand the block behind it, so this repeats until stable — it is
 *    the 2-core of the wall graph. Trees and stray blocks vanish entirely; only loops,
 *    and the runs joining them, remain. This applies inside your own ground too, so a
 *    block dropped in the middle of your territory does not sit there eating the space
 *    a cannon needs.
 * 2. **A wall must reach territory.** What survives the first rule still has to be
 *    linked, through other wall, to something adjacent to a sealed region. A perfectly
 *    good loop built out in the open around nothing is still swept.
 *
 * Neighbours are counted orthogonally, deliberately: a wall seals only when it is
 * 4-connected, so this is exactly the connectivity that makes a wall a wall. It also
 * means a loop that does enclose something can never be swept — every block of it has
 * two orthogonal neighbours and touches the ground it encloses.
 */
export function sweepOrphanedWalls(state: MatchState): number[] {
  const { width: w, height: h, structure } = state;
  const size = w * h;
  const removed: number[] = [];

  const isWall = (i: number): boolean => structure[i] === Structure.Wall;

  const neighbours = (i: number, visit: (j: number) => void): void => {
    const x = i % w;
    const y = (i - x) / w;
    for (const [ox, oy] of NEIGHBOURS_4) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      visit(ny * w + nx);
    }
  };

  // --- 1. Prune to the 2-core: drop loose ends until none are left. ---
  const degree = new Int32Array(size);
  const queue: number[] = [];
  for (let i = 0; i < size; i++) {
    if (!isWall(i)) continue;
    let count = 0;
    neighbours(i, (j) => {
      if (isWall(j)) count++;
    });
    degree[i] = count;
    if (count < 2) queue.push(i);
  }

  let head = 0;
  while (head < queue.length) {
    const i = queue[head++] as number;
    if (!isWall(i)) continue;
    structure[i] = Structure.Empty;
    state.owner[i] = 0;
    removed.push(i);
    neighbours(i, (j) => {
      if (!isWall(j)) return;
      degree[j] = (degree[j] as number) - 1;
      if ((degree[j] as number) < 2) queue.push(j);
    });
  }

  // --- 2. Keep only what reaches sealed ground. ---
  const reached = new Uint8Array(size);
  const flood: number[] = [];
  for (let i = 0; i < size; i++) {
    if (!isWall(i) || reached[i] === 1) continue;
    let touchesTerritory = false;
    neighbours(i, (j) => {
      if (state.territory[j] !== 0) touchesTerritory = true;
    });
    if (!touchesTerritory) continue;
    reached[i] = 1;
    flood.push(i);
  }

  head = 0;
  while (head < flood.length) {
    const i = flood[head++] as number;
    neighbours(i, (j) => {
      if (!isWall(j) || reached[j] === 1) return;
      reached[j] = 1;
      flood.push(j);
    });
  }

  for (let i = 0; i < size; i++) {
    if (!isWall(i) || reached[i] === 1) continue;
    structure[i] = Structure.Empty;
    state.owner[i] = 0;
    removed.push(i);
  }

  return removed;
}
