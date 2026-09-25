import {
  NEIGHBOURS_4,
  NEIGHBOURS_8,
  Structure,
  Terrain,
  type Castle,
  type MatchState,
} from '@rampart/sim';

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
  /**
   * Also keep this player's cannons inside the wall. A cannon only fires from sealed
   * ground, so a wall drawn tight around the castle alone leaves the guns outside and
   * silent — and the sweep then takes the old outer wall away, so they never come
   * back. Enclosing them costs more, and that is simply what they are worth.
   */
  keepCannons = false,
  /**
   * Ground around each castle that must also end up inside the wall.
   *
   * A minimum cut is by definition the *tightest* wall that works, which is exactly
   * the wall with no room in it: a cannon needs a clear 2x2 of sealed ground, and a
   * wall drawn against the castle leaves nowhere to put one. A bot that cannot spend
   * the cannons it earns has no firepower, and a match between two of those does not
   * end.
   */
  roomRadius = 0,
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

  const sinkTile = (i: number): void => {
    const n = node[i] as number;
    if (n >= 0) flow.addEdge(outNode(n), sink, INFINITE_CAPACITY);
  };

  for (const castle of castles) {
    // The castle, plus the band of ground the wall has to take in around it.
    const x0 = Math.max(0, castle.x - roomRadius);
    const y0 = Math.max(0, castle.y - roomRadius);
    const x1 = Math.min(state.width - 1, castle.x + castle.w - 1 + roomRadius);
    const y1 = Math.min(state.height - 1, castle.y + castle.h - 1 + roomRadius);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) sinkTile(y * state.width + x);
    }
  }

  if (keepCannons) {
    for (const cannon of state.cannons) {
      if (cannon.owner !== playerId) continue;
      for (let oy = 0; oy < cannon.h; oy++) {
        for (let ox = 0; ox < cannon.w; ox++)
          sinkTile((cannon.y + oy) * state.width + cannon.x + ox);
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
 * Every wall worth considering, cheapest first.
 *
 * Each castle alone, then pairs, then the lot — so a caller can choose between
 * staying alive cheaply and reaching for a bigger enclosure, which is the decision
 * that actually matters in a build phase.
 */
export function sealOptions(
  state: MatchState,
  playerId: number,
  maxCastles: number,
  blocked?: ReadonlySet<number>,
  keepCannons = false,
  roomRadius = 0,
): SealPlan[] {
  const islandId = state.players[playerId]?.islandId;
  const mine = state.castles.filter((c) => c.islandId === islandId);
  if (mine.length === 0) return [];

  const plans: SealPlan[] = [];
  const add = (plan: SealPlan | null): void => {
    if (plan !== null) plans.push(plan);
  };

  for (const castle of mine) {
    add(planSeal(state, playerId, [castle], blocked, keepCannons, roomRadius));
  }

  if (maxCastles > 1) {
    for (let a = 0; a < mine.length; a++) {
      for (let b = a + 1; b < mine.length; b++) {
        add(
          planSeal(
            state,
            playerId,
            [mine[a] as Castle, mine[b] as Castle],
            blocked,
            keepCannons,
            roomRadius,
          ),
        );
      }
    }
  }
  if (maxCastles > 2 && mine.length >= 3) {
    add(planSeal(state, playerId, mine, blocked, keepCannons, roomRadius));
  }

  return plans.sort((x, y) => x.cost - y.cost);
}

/** The cheapest wall that encloses at least this many castles, if one exists. */
export function cheapestPlanFor(
  state: MatchState,
  playerId: number,
  atLeastCastles: number,
  maxCastles: number,
  blocked?: ReadonlySet<number>,
  keepCannons = false,
  roomRadius = 0,
): SealPlan | null {
  const options = sealOptions(state, playerId, maxCastles, blocked, keepCannons, roomRadius).filter(
    (plan) => plan.castleIds.length >= atLeastCastles,
  );
  return options[0] ?? null;
}

export function bestSealPlan(
  state: MatchState,
  playerId: number,
  ambition: number,
  blocked?: ReadonlySet<number>,
): SealPlan | null {
  const options = sealOptions(state, playerId, ambition, blocked);
  if (options.length === 0) return null;
  // More castles mean more cannons, so a longer wall can still be the better deal —
  // but only just. The blocks are a one-off; the length is a bill that arrives every
  // round, because a longer wall is more of it to repair under fire.
  let best = options[0] as SealPlan;
  const value = (p: SealPlan): number => p.cost - p.castleIds.length * 6;
  for (const plan of options) if (value(plan) < value(best)) best = plan;
  return best;
}

/**
 * How many cannons this player's sealed ground could still hold.
 *
 * A wall drawn tight around one castle runs out of room to put the cannons it earns,
 * so the reward becomes unspendable. Counting the space is what lets a bot notice
 * that and widen before it matters.
 */
export function cannonRoom(state: MatchState, playerId: number): number {
  const islandId = state.players[playerId]?.islandId;
  if (islandId === undefined) return 0;
  const [cw, ch] = state.ruleset.cannons.footprint;

  const taken = new Uint8Array(state.width * state.height);
  let spots = 0;
  for (let y = 0; y + ch <= state.height; y++) {
    for (let x = 0; x + cw <= state.width; x++) {
      let fits = true;
      for (let oy = 0; oy < ch && fits; oy++) {
        for (let ox = 0; ox < cw; ox++) {
          const i = (y + oy) * state.width + x + ox;
          if (
            state.territory[i] !== islandId ||
            state.structure[i] !== Structure.Empty ||
            taken[i]
          ) {
            fits = false;
            break;
          }
        }
      }
      if (!fits) continue;
      // Reserve the footprint, so overlapping positions are not counted twice.
      for (let oy = 0; oy < ch; oy++) {
        for (let ox = 0; ox < cw; ox++) taken[(y + oy) * state.width + x + ox] = 1;
      }
      spots++;
    }
  }
  return spots;
}

/**
 * Tiles worth building to thicken the wall where it is thinnest.
 *
 * A minimum cut is by definition one block thick, so every block of it is
 * load-bearing and a single crater breaks the seal. `weakestWall` already computes
 * where an opponent would come through; the empty ground beside those blocks is
 * where a second layer is worth having.
 */
export function thickenTargets(state: MatchState, playerId: number): number[] {
  const breach = weakestWall(state, playerId);
  if (breach.length === 0) return [];

  const seen = new Set<number>();
  const out: number[] = [];
  for (const wall of breach) {
    const x = wall % state.width;
    const y = (wall - x) / state.width;
    for (const [ox, oy] of NEIGHBOURS_8) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) continue;
      const i = ny * state.width + nx;
      if (seen.has(i) || !buildable(state, playerId, i)) continue;
      // Outward only. A second layer laid on the inside is a block of wall standing
      // where a cannon could have stood, and a cannon is what wins the match.
      if (state.territory[i] === state.players[playerId]?.islandId) continue;
      seen.add(i);
      out.push(i);
    }
  }
  return out;
}

/**
 * Every free tile against the outside of this player's wall — the last thing worth
 * building when nothing more particular is. A second layer anywhere is a breach that
 * takes two shots instead of one, and it is laid outward, so it never takes ground a
 * cannon could stand on.
 */
export function outerSkin(state: MatchState, playerId: number): number[] {
  const islandId = state.players[playerId]?.islandId;
  if (islandId === undefined) return [];
  const out: number[] = [];
  for (let i = 0; i < state.structure.length; i++) {
    if (!buildable(state, playerId, i) || state.territory[i] === islandId) continue;
    const x = i % state.width;
    const y = (i - x) / state.width;
    for (const [ox, oy] of NEIGHBOURS_4) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) continue;
      const j = ny * state.width + nx;
      if (state.structure[j] === Structure.Wall && state.islandId[j] === islandId) {
        out.push(i);
        break;
      }
    }
  }
  return out;
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
