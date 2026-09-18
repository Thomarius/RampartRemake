import { describe, expect, it } from 'vitest';

import { Hasher } from './hash.js';
import { isqrt, distanceFixed } from './math.js';
import { Rng, hashString, streamFor } from './rng.js';
import { cosTurns, rotationFor, sinTurns } from './trig.js';

describe('Rng', () => {
  it('produces the same sequence from the same seed', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    const seqA = Array.from({ length: 50 }, () => a.nextU32());
    const seqB = Array.from({ length: 50 }, () => b.nextU32());
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences from adjacent seeds', () => {
    const a = Array.from({ length: 20 }, (_, i) => new Rng(i).nextU32());
    expect(new Set(a).size).toBe(a.length);
  });

  it('keeps nextInt inside its bound', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 5000; i++) {
      const v = rng.nextInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });

  it('distributes nextInt without obvious bias', () => {
    const rng = new Rng(99);
    const counts = new Array<number>(6).fill(0);
    const draws = 60_000;
    for (let i = 0; i < draws; i++) {
      const k = rng.nextInt(6);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    for (const count of counts) expect(Math.abs(count - draws / 6)).toBeLessThan(draws / 6 / 10);
  });

  it('honours weights', () => {
    const rng = new Rng(5);
    const counts = [0, 0, 0];
    for (let i = 0; i < 30_000; i++) {
      const k = rng.nextWeightedIndex([1, 0, 3]);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    expect(counts[1]).toBe(0);
    expect((counts[2] as number) / (counts[0] as number)).toBeGreaterThan(2.5);
    expect((counts[2] as number) / (counts[0] as number)).toBeLessThan(3.5);
  });

  it('gives forked streams independent sequences', () => {
    const parent = new Rng(1);
    const a = parent.fork('terrain').nextU32();
    const b = parent.fork('pieces').nextU32();
    expect(a).not.toBe(b);
  });

  it('derives stable named streams from a match seed', () => {
    expect(streamFor(42, 'pieces').nextU32()).toBe(streamFor(42, 'pieces').nextU32());
    expect(streamFor(42, 'pieces').nextU32()).not.toBe(streamFor(42, 'terrain').nextU32());
  });

  it('hashes strings stably', () => {
    expect(hashString('rampart')).toBe(hashString('rampart'));
    expect(hashString('rampart')).not.toBe(hashString('ramparts'));
  });
});

describe('Hasher', () => {
  it('separates null from any number', () => {
    expect(new Hasher().nullable(null).hex).not.toBe(new Hasher().nullable(0).hex);
    expect(new Hasher().nullable(null).hex).not.toBe(new Hasher().nullable(-1).hex);
  });

  it('is order sensitive', () => {
    expect(new Hasher().u32(1).u32(2).hex).not.toBe(new Hasher().u32(2).u32(1).hex);
  });
});

describe('integer maths', () => {
  it('computes exact integer square roots', () => {
    for (let n = 0; n < 2000; n++) {
      const r = isqrt(n);
      expect(r * r).toBeLessThanOrEqual(n);
      expect((r + 1) * (r + 1)).toBeGreaterThan(n);
    }
  });

  it('is exact for perfect squares near the precision limit', () => {
    for (const root of [46341, 1_000_000, 94_906_265]) {
      expect(isqrt(root * root)).toBe(root);
      expect(isqrt(root * root - 1)).toBe(root - 1);
    }
  });

  it('measures distance in 1/256 tiles', () => {
    expect(distanceFixed(0, 0, 3, 4)).toBe(5 * 256);
    expect(distanceFixed(0, 0, 0, 0)).toBe(0);
    expect(distanceFixed(10, 10, 10, 20)).toBe(10 * 256);
  });
});

describe('deterministic trigonometry', () => {
  it('matches the platform to well within a tile', () => {
    for (let i = 0; i < 64; i++) {
      const turns = i / 64;
      expect(sinTurns(turns)).toBeCloseTo(Math.sin(turns * 2 * Math.PI), 12);
      expect(cosTurns(turns)).toBeCloseTo(Math.cos(turns * 2 * Math.PI), 12);
    }
  });

  it('returns quarter turns exactly, so island rotation is lossless', () => {
    expect(rotationFor(0)).toEqual({ cos: 1, sin: 0 });
    expect(rotationFor(0.25)).toEqual({ cos: 0, sin: 1 });
    expect(rotationFor(0.5)).toEqual({ cos: -1, sin: 0 });
    expect(rotationFor(0.75)).toEqual({ cos: 0, sin: -1 });
    expect(rotationFor(-0.25)).toEqual({ cos: 0, sin: -1 });
  });

  it('is periodic', () => {
    expect(sinTurns(0.3)).toBeCloseTo(sinTurns(1.3), 12);
    expect(sinTurns(0.3)).toBeCloseTo(sinTurns(-0.7), 12);
  });
});
