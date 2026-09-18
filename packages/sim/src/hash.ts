/**
 * State hashing, used to assert that (seed, ruleset, input log) always produces
 * one identical match. This is the backbone of the determinism test suite.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export class Hasher {
  private h = FNV_OFFSET;

  u32(value: number): this {
    let v = value >>> 0;
    for (let i = 0; i < 4; i++) {
      this.h = Math.imul(this.h ^ (v & 0xff), FNV_PRIME) >>> 0;
      v >>>= 8;
    }
    return this;
  }

  i32(value: number): this {
    return this.u32(value | 0);
  }

  bool(value: boolean): this {
    return this.u32(value ? 1 : 0);
  }

  /**
   * Hashes null/undefined distinctly from every real number.
   *
   * The presence tag is not optional: writing a sentinel value instead would make
   * `null` collide with whichever integer shares its bit pattern, and a hash that
   * cannot tell "no value" from "some value" would let a genuine desync pass.
   */
  nullable(value: number | null | undefined): this {
    if (value === null || value === undefined) return this.u32(0).u32(0xffffffff);
    return this.u32(1).i32(value);
  }

  string(value: string): this {
    this.u32(value.length);
    for (let i = 0; i < value.length; i++) this.u32(value.charCodeAt(i));
    return this;
  }

  bytes(value: Uint8Array): this {
    this.u32(value.length);
    for (let i = 0; i < value.length; i++) {
      this.h = Math.imul(this.h ^ (value[i] as number), FNV_PRIME) >>> 0;
    }
    return this;
  }

  get value(): number {
    return this.h >>> 0;
  }

  get hex(): string {
    return (this.h >>> 0).toString(16).padStart(8, '0');
  }
}
