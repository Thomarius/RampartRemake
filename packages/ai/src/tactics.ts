import { NEIGHBOURS_8, Structure, Terrain, type Castle, type MatchState } from '@rampart/sim';

import { INFINITE_CAPACITY, MaxFlow } from './flow.js';

/** The cheapest wall that would seal a set of castles. */
export interface SealPlan {
  /** Tiles that still need building. */
  tiles: number[];
  /** Castles the wall would enclose. */
  castleIds: number[];
  /** Blocks needed, which is the minimum cut. */
  cost: number;
}

function passable(state: MatchState, i: number): boolean {
  return state.structure[i] !== Structure.Wall;
}

/** Empty land of this player's own island: the only tiles they may build on. */
function buildable(state: MatchState, playerId: number, i: number): boolean {
  const islandId = state.players[playerId]?.islandId;
  return (
    state.terrain[i] === Terrain.Land &&
    state.islandId[i] === islandId &&
    state.structure[i] === Structure.Empty
  );
}

/**
 * The smallest set of blocks that would enclose these castles.
 *
 * Returns null when no wall could do it — which happens when a castle can be reached
 * through tiles nobody can build on, such as another player's ground.
 *
 * This is what the stopgap opponent lacked. It rebuilt the ring it was handed, which
 * is the one shape guaranteed to be expensive: a thin rectangle no piece fits along.
 * Asking instead for the cheapest loop that exists lets a bot hug the coast, reuse
 * whatever wall survived the barrage, and abandon a ring that is no longer worth
 * holding.
 */
export function planSeal(
  state: MatchState,
  playerId: number,
  castles: readonly Castle[],
  /**
   * Tiles to treat as unbuildable. A gap with no free neighbours cannot be filled,
   * because the smallest piece is three cells and pieces may not overlap — so a plan
   * that depends on it is worthless, and the wall has to go around instead.
   */
  blocked?: ReadonlySet<number>,
): SealPlan | null {
  if (castles.length === 0) return null;
  const islandId = state.players[playerId]?.islandId;
  if (islandId === undefined) return null;

  // Only this player's own island can ever be part of the cut, so the graph is built
  // over its few hundred land tiles rather than all six thousand on the map. Water is
  // all connected to the border, so every tile where the island meets the sea is an
  // entry point and hangs straight off the source. That is not an approximation: any
  // route from the open map to the castle has to come ashore somewhere.
  const size = state.width * state.height;
  const node = new Int32Array(size).fill(-1);
  const tiles: number[] = [];
  for (let i = 0; i < size; i++) {
    if (state.islandId[i] !== islandId || !passable(state, i)) continue;
    node[i] = tiles.length;
    tiles.push(i);
  }
  if (tiles.length === 0) return null;

  const count = tiles.length;
  const inNode = (n: number): number => n * 2;
  const outNode = (n: number): number => n * 2 + 1;
  const source = count * 2;
  const sink = count * 2 + 1;
  const flow = new MaxFlow(count * 2 + 2);

  for (let n = 0; n < count; n++) {
    const i = tiles[n] as number;
    const canBuild = buildable(state, playerId, i) && blocked?.has(i) !== true;
    flow.addEdge(inNode(n), outNode(n), canBuild ? 1 : INFINITE_CAPACITY);

    const x = i % state.width;
    const y = (i - x) / state.width;
    let coastal = false;
    for (const [ox, oy] of NEIGHBOURS_8) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) {
        coastal = true;
        continue;
      }
      const j = ny * state.width + nx;
      if (state.islandId[j] !== islandId) {
        // Sea, or somebody else's ground: either way it is open to the border.
        if (passable(state, j)) coastal = true;
        continue;
      }
      const m = node[j] as number;
      if (m >= 0) flow.addEdge(outNode(n), inNode(m), INFINITE_CAPACITY);
    }
    if (coastal) flow.addEdge(source, inNode(n), INFINITE_CAPACITY);
  }

  for (const castle of castles) {
    for (let oy = 0; oy < castle.h; oy++) {
      for (let ox = 0; ox < castle.w; ox++) {
        const n = node[(castle.y + oy) * state.width + castle.x + ox] as number;
        if (n >= 0) flow.addEdge(outNode(n), sink, INFINITE_CAPACITY);
      }
    }
  }

  const cost = flow.maxFlow(source, sink, 400);
  if (cost >= 400) return null;

  const near = flow.reachable(source);
  const cut: number[] = [];
  for (let n = 0; n < count; n++) {
    const i = tiles[n] as number;
    if (!buildable(state, playerId, i) || blocked?.has(i) === true) continue;
    // A tile is on the cut when the flow reaches into it but not out of it.
    if (near[inNode(n)] === 1 && near[outNode(n)] === 0) cut.push(i);
  }

  return { tiles: cut, castleIds: castles.map((c) => c.id), cost };
}

/**
 * The cheapest plan among the sensible options: each castle alone, and — for a bot
 * that thinks that far — every combination worth the extra cannons.
 */
export function bestSealPlan(
  state: MatchState,
  playerId: number,
  ambition: number,
  blocked?: ReadonlySet<number>,
): SealPlan | null {
  const islandId = state.players[playerId]?.islandId;
  const mine = state.castles.filter((c) => c.islandId === islandId);
  if (mine.length === 0) return null;

  let best: SealPlan | null = null;
  const consider = (plan: SealPlan | null): void => {
    if (plan === null) return;
    // More castles mean more cannons, so a longer wall can still be the better deal —
    // but only just. The blocks to build it are a one-off; the length is a bill that
    // comes in every round, because a longer wall is more of it to repair under fire.
    // Valuing a castle too highly makes a bot reach for all three and lose the lot.
    const value = (p: SealPlan): number => p.cost - p.castleIds.length * 6;
    if (best === null || value(plan) < value(best)) best = plan;
  };

  for (const castle of mine) consider(planSeal(state, playerId, [castle], blocked));

  if (ambition > 1) {
    for (let a = 0; a < mine.length; a++) {
      for (let b = a + 1; b < mine.length; b++) {
        consider(planSeal(state, playerId, [mine[a] as Castle, mine[b] as Castle], blocked));
      }
    }
    if (ambition > 2 && mine.length >= 3) consider(planSeal(state, playerId, mine, blocked));
  }

  return best;
}

/**
 * The wall blocks on the cheapest way in to an enemy castle.
 *
 * A 0-1 breadth-first search from the map border: crossing open ground is free,
 * crossing a wall costs one. The cheapest path is therefore the thinnest part of
 * their defence, and its wall tiles are exactly what to shoot. Scattering fire over
 * a wall achieves nothing; concentrating it on four blocks in a line opens a breach.
 */
export function weakestWall(state: MatchState, targetPlayer: number): number[] {
  const islandId = state.players[targetPlayer]?.islandId;
  if (islandId === undefined) return [];
  const targets = state.castles.filter((c) => c.islandId === islandId && c.enclosed);
  if (targets.length === 0) return [];

  const size = state.width * state.height;
  // Not MAX_SAFE_INTEGER: an Int32Array truncates it to -1, which makes every
  // relaxation look like a step backwards and the search never leaves the border.
  const dist = new Int32Array(size).fill(0x7fffffff);
  const from = new Int32Array(size).fill(-1);

  // A real double-ended queue: 0-1 BFS pushes free steps to the front and costly ones
  // to the back, which is only linear if the front push is O(1). Splicing an array
  // instead turns this into the slowest thing the bot does.
  const capacity = size * 4;
  const deque = new Int32Array(capacity);
  let head = capacity >> 1;
  let tail = head;
  const pushFront = (v: number): void => {
    deque[--head] = v;
  };
  const pushBack = (v: number): void => {
    deque[tail++] = v;
  };

  const goal = new Uint8Array(size);
  for (const castle of targets) {
    for (let oy = 0; oy < castle.h; oy++) {
      for (let ox = 0; ox < castle.w; ox++) goal[(castle.y + oy) * state.width + castle.x + ox] = 1;
    }
  }

  for (let i = 0; i < size; i++) {
    const x = i % state.width;
    const y = (i - x) / state.width;
    if (x !== 0 && y !== 0 && x !== state.width - 1 && y !== state.height - 1) continue;
    const cost = state.structure[i] === Structure.Wall ? 1 : 0;
    if (cost >= (dist[i] as number)) continue;
    dist[i] = cost;
    if (cost === 0) pushFront(i);
    else pushBack(i);
  }

  let reached = -1;
  while (head < tail) {
    const i = deque[head++] as number;
    if (goal[i] === 1) {
      reached = i;
      break;
    }
    const x = i % state.width;
    const y = (i - x) / state.width;
    for (const [ox, oy] of NEIGHBOURS_8) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) continue;
      const j = ny * state.width + nx;
      const step = state.structure[j] === Structure.Wall ? 1 : 0;
      const next = (dist[i] as number) + step;
      if (next >= (dist[j] as number)) continue;
      dist[j] = next;
      from[j] = i;
      if (step === 0) pushFront(j);
      else pushBack(j);
    }
  }

  if (reached === -1) return [];
  const path: number[] = [];
  for (let at = reached; at !== -1; at = from[at] as number) {
    if (state.structure[at] === Structure.Wall) path.push(at);
  }
  return path;
}
