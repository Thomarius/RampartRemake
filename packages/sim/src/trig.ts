/**
 * Deterministic trigonometry.
 *
 * ECMAScript leaves `Math.sin` and `Math.cos` to "implementation-approximated"
 * precision, so two engines may disagree in the last bits. Terrain is regenerated
 * from the seed on every client, and island rotation depends on sine and cosine —
 * a one-ulp difference could round a tile the other way and desync the map.
 *
 * These use only IEEE 754 addition and multiplication, which *are* exactly specified,
 * so every engine produces bit-identical results. Accuracy (~1e-13) is far beyond what
 * tile rasterisation needs; reproducibility is the point.
 *
 * Angles are in turns (1.0 = a full revolution) to keep the reduction exact.
 */

const TAU = 6.283185307179586;

/** Taylor series for sin on [0, PI/2]; degree 17, worst-case error below 1e-13. */
function sinCore(a: number): number {
  const a2 = a * a;
  return (
    a *
    (1 +
      a2 *
        (-1 / 6 +
          a2 *
            (1 / 120 +
              a2 *
                (-1 / 5040 +
                  a2 *
                    (1 / 362880 +
                      a2 *
                        (-1 / 39916800 +
                          a2 *
                            (1 / 6227020800 +
                              a2 * (-1 / 1307674368000 + a2 * (1 / 355687428096000)))))))))
  );
}

/** Sine of an angle given in turns. */
export function sinTurns(turns: number): number {
  let t = turns - Math.floor(turns); // [0, 1)
  let sign = 1;
  if (t >= 0.5) {
    t -= 0.5;
    sign = -1;
  }
  // t now in [0, 0.5); fold the second quadrant onto the first.
  if (t > 0.25) t = 0.5 - t;
  return sign * sinCore(t * TAU);
}

/** Cosine of an angle given in turns. */
export function cosTurns(turns: number): number {
  return sinTurns(turns + 0.25);
}

export interface Rotation {
  cos: number;
  sin: number;
}

/**
 * Rotation coefficients for an angle in turns.
 *
 * Quarter turns are returned exactly rather than through the series. This matters:
 * it makes the identity rotation a true identity, and for 2 and 4 players it makes
 * the islands exact rasterised copies of one another rather than near-copies.
 */
export function rotationFor(turns: number): Rotation {
  const quarters = turns * 4;
  if (Number.isInteger(quarters)) {
    const k = (((quarters % 4) + 4) % 4) as 0 | 1 | 2 | 3;
    const exact: Record<0 | 1 | 2 | 3, Rotation> = {
      0: { cos: 1, sin: 0 },
      1: { cos: 0, sin: 1 },
      2: { cos: -1, sin: 0 },
      3: { cos: 0, sin: -1 },
    };
    return exact[k];
  }
  return { cos: cosTurns(turns), sin: sinTurns(turns) };
}
