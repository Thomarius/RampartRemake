/**
 * Seeded pseudo-random number generation.
 *
 * Every random decision in the simulation comes from here. `Math.random` is banned
 * in this package by lint rule — a single unseeded call would desync clients from
 * the server without failing any test.
 *
 * All arithmetic is exact 32-bit integer work (`Math.imul`, `>>> 0`), so results are
 * identical on every JavaScript engine.
 */

/** FNV-1a over a string, used to derive stream seeds from stream names. */
export function hashString(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Mixes a 32-bit integer so that sequential seeds produce unrelated streams. */
export function mix32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = mix32(seed);
  }

  /** Uniform 32-bit unsigned integer. */
  nextU32(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), 1 | t) >>> 0;
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) >>> 0;
  }

  /** Uniform float in [0, 1). Division by 2^32 is exact in IEEE 754 doubles. */
  nextFloat(): number {
    return this.nextU32() / 4294967296;
  }

  /**
   * Uniform integer in [0, bound). Uses rejection sampling rather than a modulo,
   * so the distribution has no bias and the call consumes a deterministic,
   * bound-independent number of words.
   */
  nextInt(bound: number): number {
    if (bound <= 0) throw new RangeError(`nextInt bound must be positive, got ${bound}`);
    const limit = 4294967296 - (4294967296 % bound);
    let value = this.nextU32();
    while (value >= limit) value = this.nextU32();
    return value % bound;
  }

  /** Uniform float in [min, max). */
  nextRange(min: number, max: number): number {
    return min + this.nextFloat() * (max - min);
  }

  /** Picks an index from a weight table. Weights need not be normalised. */
  nextWeightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    if (total <= 0) throw new RangeError('weights must sum to a positive value');
    let roll = this.nextFloat() * total;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i] ?? 0;
      if (roll < 0) return i;
    }
    return weights.length - 1;
  }

  /** In-place Fisher-Yates. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const a = items[i] as T;
      items[i] = items[j] as T;
      items[j] = a;
    }
    return items;
  }

  /**
   * Derives an independent stream. Separate streams mean a cosmetic change cannot
   * shift the piece sequence, and terrain generation cannot be perturbed by how
   * many shots were fired.
   */
  fork(streamName: string): Rng {
    return new Rng(hashString(streamName, this.state));
  }
}

/** Creates the named top-level stream for a match seed. */
export function streamFor(seed: number, streamName: string): Rng {
  return new Rng(hashString(streamName, mix32(seed)));
}
