import { mix32 } from './rng.js';

/**
 * Seeded value noise. Chosen over gradient/simplex noise because island silhouettes
 * only need smooth low-frequency variation, and integer-hash value noise is trivially
 * reproducible across engines.
 */

function hash2(x: number, y: number, seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (x | 0), 0x27220a95) >>> 0;
  h = Math.imul(h ^ (y | 0), 0x85ebca6b) >>> 0;
  return mix32(h);
}

/** Value at integer lattice point, in [0, 1). */
function latticeValue(x: number, y: number, seed: number): number {
  return hash2(x, y, seed) / 4294967296;
}

/** Smootherstep — zero first and second derivatives at the ends, so no lattice banding. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Bilinearly interpolated value noise at (x, y). Returns [0, 1). */
export function valueNoise2D(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);

  const v00 = latticeValue(x0, y0, seed);
  const v10 = latticeValue(x0 + 1, y0, seed);
  const v01 = latticeValue(x0, y0 + 1, seed);
  const v11 = latticeValue(x0 + 1, y0 + 1, seed);

  const top = v00 + (v10 - v00) * fx;
  const bottom = v01 + (v11 - v01) * fx;
  return top + (bottom - top) * fy;
}

export interface FbmOptions {
  octaves: number;
  frequency: number;
  /** Amplitude multiplier per octave. */
  persistence?: number;
  /** Frequency multiplier per octave. */
  lacunarity?: number;
}

/** Fractal Brownian motion, normalised to [0, 1). */
export function fbm2D(x: number, y: number, seed: number, options: FbmOptions): number {
  const persistence = options.persistence ?? 0.5;
  const lacunarity = options.lacunarity ?? 2;

  let amplitude = 1;
  let frequency = options.frequency;
  let sum = 0;
  let norm = 0;

  for (let octave = 0; octave < options.octaves; octave++) {
    sum +=
      amplitude * valueNoise2D(x * frequency, y * frequency, (seed + octave * 0x9e3779b9) >>> 0);
    norm += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }

  return norm === 0 ? 0 : sum / norm;
}
