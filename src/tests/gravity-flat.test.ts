import { describe, it, expect } from 'vitest';
import { FlatGravity } from '../gravity';
import { neighborFrame } from '../sand';

/**
 * Flat gravity must reproduce the original hardcoded movement offsets
 * byte-for-byte. This is the contract that makes FlatGravity the safe
 * default — any existing flat-world behavior is unchanged.
 */
describe('FlatGravity', () => {
  it('always reports down = (0, 1)', () => {
    const g = new FlatGravity();
    for (const [x, y] of [[0, 0], [5, 5], [100, 0], [0, 100]]) {
      const v = g.gravityAt(x, y);
      expect(v.x).toBe(0);
      expect(v.y).toBe(1);
    }
  });

  it('is pure — same cell always yields the same vector', () => {
    const g = new FlatGravity();
    const a = g.gravityAt(3, 4);
    const b = g.gravityAt(3, 4);
    expect(a).toEqual(b);
  });
});

describe('neighborFrame under FlatGravity (byte-identical to original)', () => {
  // The original engine hardcoded these offsets. FlatGravity must derive
  // exactly the same frame, proving the gravity seam is behavior-preserving.
  const g = new FlatGravity();

  /** Normalize -0 to +0 so deep-equal treats them the same. */
  const z = (n: number): number => (n === 0 ? 0 : n);

  it('produces the canonical flat frame at every cell', () => {
    for (const [x, y] of [[0, 0], [7, 3], [50, 50]]) {
      const f = neighborFrame(x, y, g);
      expect(z(f.down.dx)).toBe(0); expect(z(f.down.dy)).toBe(1);
      expect(z(f.downLeft.dx)).toBe(-1); expect(z(f.downLeft.dy)).toBe(1);
      expect(z(f.downRight.dx)).toBe(1); expect(z(f.downRight.dy)).toBe(1);
      expect(z(f.left.dx)).toBe(-1); expect(z(f.left.dy)).toBe(0);
      expect(z(f.right.dx)).toBe(1); expect(z(f.right.dy)).toBe(0);
    }
  });

  it('offsets are all unit steps in {-1,0,1}', () => {
    const f = neighborFrame(10, 10, g);
    for (const o of [f.down, f.downLeft, f.downRight, f.left, f.right]) {
      expect(Math.abs(o.dx)).toBeLessThanOrEqual(1);
      expect(Math.abs(o.dy)).toBeLessThanOrEqual(1);
      expect(Number.isInteger(o.dx)).toBe(true);
      expect(Number.isInteger(o.dy)).toBe(true);
    }
  });
});
