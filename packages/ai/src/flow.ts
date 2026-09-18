/**
 * Dinic's maximum flow, used to answer one question: what is the cheapest set of
 * tiles that would seal a castle?
 *
 * Sealing is exactly a minimum vertex cut. The sea reaches a castle through some path
 * of non-wall tiles; to enclose it you must place walls that break every such path,
 * and you may only build on empty land of your own island. Give every buildable tile
 * capacity 1 and everything else that cannot be built on infinite capacity, and the
 * minimum cut between the map border and the castle is the smallest wall that works.
 *
 * Existing walls are simply absent from the graph, so their value is accounted for
 * without any special case: paths must already route around them, and the cut only
 * ever counts tiles that still need building.
 */

export const INFINITE_CAPACITY = 1 << 28;

export class MaxFlow {
  private readonly head: Int32Array;
  private readonly to: number[] = [];
  private readonly capacity: number[] = [];
  private readonly next: number[] = [];
  private readonly level: Int32Array;
  private readonly cursor: Int32Array;

  constructor(private readonly nodes: number) {
    this.head = new Int32Array(nodes).fill(-1);
    this.level = new Int32Array(nodes);
    this.cursor = new Int32Array(nodes);
  }

  /** Adds a directed edge and its residual twin. */
  addEdge(from: number, to: number, capacity: number): void {
    this.to.push(to);
    this.capacity.push(capacity);
    this.next.push(this.head[from] as number);
    this.head[from] = this.to.length - 1;

    this.to.push(from);
    this.capacity.push(0);
    this.next.push(this.head[to] as number);
    this.head[to] = this.to.length - 1;
  }

  maxFlow(source: number, sink: number, limit = INFINITE_CAPACITY): number {
    let total = 0;
    while (total < limit && this.buildLevels(source, sink)) {
      this.cursor.set(this.head);
      for (;;) {
        const pushed = this.augment(source, sink, limit - total);
        if (pushed === 0) break;
        total += pushed;
        if (total >= limit) break;
      }
    }
    return total;
  }

  private buildLevels(source: number, sink: number): boolean {
    this.level.fill(-1);
    const queue = new Int32Array(this.nodes);
    let head = 0;
    let tail = 0;
    queue[tail++] = source;
    this.level[source] = 0;

    while (head < tail) {
      const u = queue[head++] as number;
      for (let e = this.head[u] as number; e !== -1; e = this.next[e] as number) {
        const v = this.to[e] as number;
        if ((this.capacity[e] as number) <= 0 || this.level[v] !== -1) continue;
        this.level[v] = (this.level[u] as number) + 1;
        queue[tail++] = v;
      }
    }
    return this.level[sink] !== -1;
  }

  /** Iterative depth-first augmentation; recursion would blow the stack on a full grid. */
  private augment(source: number, sink: number, limit: number): number {
    const path: number[] = [];
    let node = source;

    for (;;) {
      if (node === sink) {
        let bottleneck = limit;
        for (const e of path) bottleneck = Math.min(bottleneck, this.capacity[e] as number);
        for (const e of path) {
          this.capacity[e] = (this.capacity[e] as number) - bottleneck;
          this.capacity[e ^ 1] = (this.capacity[e ^ 1] as number) + bottleneck;
        }
        return bottleneck;
      }

      let advanced = false;
      for (let e = this.cursor[node] as number; e !== -1; e = this.next[e] as number) {
        this.cursor[node] = e;
        const v = this.to[e] as number;
        if (
          (this.capacity[e] as number) > 0 &&
          this.level[v] === (this.level[node] as number) + 1
        ) {
          path.push(e);
          node = v;
          advanced = true;
          break;
        }
      }
      if (advanced) continue;

      // Dead end: retire this node from the level graph and step back.
      this.cursor[node] = -1;
      this.level[node] = -1;
      const last = path.pop();
      if (last === undefined) return 0;
      node = this.to[last ^ 1] as number;
    }
  }

  /** Nodes still reachable from the source once the flow is maximal: the cut's near side. */
  reachable(source: number): Uint8Array {
    const seen = new Uint8Array(this.nodes);
    const queue = new Int32Array(this.nodes);
    let head = 0;
    let tail = 0;
    queue[tail++] = source;
    seen[source] = 1;

    while (head < tail) {
      const u = queue[head++] as number;
      for (let e = this.head[u] as number; e !== -1; e = this.next[e] as number) {
        const v = this.to[e] as number;
        if ((this.capacity[e] as number) <= 0 || seen[v] === 1) continue;
        seen[v] = 1;
        queue[tail++] = v;
      }
    }
    return seen;
  }
}
