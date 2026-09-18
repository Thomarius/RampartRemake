/**
 * Integer maths used anywhere a value affects simulation state.
 *
 * `Math.sqrt` is left to implementation-approximated precision by the ECMAScript
 * spec, so shot flight times are derived from an exact integer square root instead.
 * A one-tick difference between client and server would be a desync.
 */

/** Largest integer r with r*r <= value. Exact for value < 2^53. */
export function isqrt(value: number): number {
  if (value < 0) throw new RangeError(`isqrt of negative value ${value}`);
  if (value < 2) return value;
  let r = Math.floor(Math.sqrt(value));
  // Correct any rounding error from the floating-point estimate.
  while (r > 0 && r * r > value) r--;
  while ((r + 1) * (r + 1) <= value) r++;
  return r;
}

/** Euclidean distance between two tiles, in units of 1/256 of a tile. */
export function distanceFixed(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return isqrt((dx * dx + dy * dy) * 65536);
}

/** Squared tile distance, exact. Sufficient for comparisons, which is most uses. */
export function distanceSquared(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
