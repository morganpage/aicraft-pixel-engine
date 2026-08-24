import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../sand';
import { FlatGravity } from '../gravity';
import { mulberry32, mulberry32Next, mulberry32Value } from '../rng';

describe('mulberry32', () => {
  it('is deterministic from its seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 64; i++) expect(a()).toBe(b());
  });

  it('produces values in [0, 1)', () => {
    const r = mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('different seeds diverge immediately', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });

  /**
   * The reason `rng.ts` exists.
   *
   * `PixelEngine.random()` and the host-facing `mulberry32` closure used to be
   * two hand-copied transcriptions of the same bit-mixing, several hundred
   * lines apart, with nothing asserting they still agreed. They now share one
   * implementation — this test is what keeps that true, and would fail loudly
   * if either side were ever "optimised" independently.
   */
  it('matches PixelEngine.random() draw for draw', () => {
    const seed = 4242;
    const e = new PixelEngine({ width: 4, height: 4, seed, gravity: new FlatGravity() });
    const r = mulberry32(seed);
    for (let i = 0; i < 256; i++) {
      expect(e.random(), `draw ${i}`).toBe(r());
    }
  });

  it('the closure form is exactly next-then-value', () => {
    const seed = 7;
    const r = mulberry32(seed);
    let s = seed | 0;
    for (let i = 0; i < 32; i++) {
      s = mulberry32Next(s);
      expect(r()).toBe(mulberry32Value(s));
    }
  });

  it('mulberry32Value does not advance state', () => {
    const s = mulberry32Next(1);
    expect(mulberry32Value(s)).toBe(mulberry32Value(s));
  });
});
