import { describe, it, expect } from 'vitest';
import { createAccumulator } from '../fixed-tick-clock';
import { census, formatCensus, createCensusGate } from '../census';
import { PixelEngine } from '../../src/sand';
import { MaterialType } from '../../src/materials';
import { FlatGravity } from '../../src/gravity';

describe('fixed-tick-clock accumulator', () => {
  it('runs one step per stepMs of wall time at a steady cadence', () => {
    // Integer timestamps and a divisor-friendly step: exact arithmetic, so
    // the assertion pins the accumulator rather than float drift.
    const acc = createAccumulator(10);
    let total = 0;
    for (let t = 0; t <= 10_000; t += 10) total += acc.pump(t);
    expect(total).toBe(1000);
    expect(acc.stepCount()).toBe(1000);
  });

  it('sustains ~60Hz when pumped every millisecond (unthrottled tab)', () => {
    const acc = createAccumulator(1000 / 60);
    acc.pump(0);
    let total = 0;
    for (let t = 1; t <= 1000; t++) total += acc.pump(t);
    // A healthy rAF/vsync-driven host pumps ~every ms: the accumulator pays
    // one step per ~16.67ms of that — 59-60 steps in a second, no burst.
    expect(total).toBeGreaterThanOrEqual(58);
    expect(total).toBeLessThanOrEqual(60);
  });

  it('clamps catch-up: a throttled fire pays at most maxCatchUpMs of steps', () => {
    const acc = createAccumulator(10, 100);
    acc.pump(0);
    // One throttled fire per second, each seeing a full second elapsed: the
    // clamp caps each fire at 100ms = 10 steps, so the sim keeps running
    // while occluded (~10 steps/second) instead of pausing or exploding.
    let total = 0;
    for (let s = 1; s <= 10; s++) total += acc.pump(s * 1000);
    expect(total).toBe(100);
  });

  it('ignores the first pump (no step for the initial timestamp)', () => {
    const acc = createAccumulator(16);
    expect(acc.pump(12345)).toBe(0);
    expect(acc.pump(12345 + 16)).toBe(1);
  });

  it('rejects a non-positive step', () => {
    expect(() => createAccumulator(0)).toThrow();
  });
});

describe('census', () => {
  it('counts materials, and separates grown forest from scattered seeds', () => {
    const e = new PixelEngine({ width: 8, height: 8, seed: 1, gravity: new FlatGravity() });
    e.setMaterial(0, 0, MaterialType.WATER);
    e.setMaterial(1, 0, MaterialType.SAND);
    e.setMaterial(2, 0, MaterialType.LAVA);
    e.setMaterial(3, 0, MaterialType.FIRE);
    e.setMaterial(4, 0, MaterialType.STEAM);
    e.setMaterial(5, 0, MaterialType.ROCK);
    e.setMaterial(6, 0, MaterialType.TEPHRA);
    e.setMaterial(0, 1, MaterialType.WOOD);
    e.setMaterial(1, 1, MaterialType.LEAF);
    e.setMaterial(2, 1, MaterialType.TREE_TIP);
    e.setMaterial(3, 1, MaterialType.SEED);
    const c = census(e.grid);
    expect(c).toMatchObject({
      water: 1, sand: 1, lava: 1, fire: 1, steam: 1, rock: 1, tephra: 1,
      forest: 4, forestGrown: 3,
    });
  });

  it('formats a compact readout, hiding absent materials', () => {
    const base = formatCensus({ water: 1, sand: 2, lava: 0, fire: 0, steam: 0, rock: 0, tephra: 0, forest: 0, forestGrown: 0 });
    expect(base).toBe('🌊 1 · 🏔 2 · 🌋 0 · 🔥 0');
    const full = formatCensus({ water: 1200, sand: 3, lava: 4, fire: 5, steam: 6, rock: 0, tephra: 0, forest: 7, forestGrown: 7 });
    expect(full).toBe('🌊 1.2k · 🏔 3 · 🌋 4 · 🔥 5 · 🌲 7 · 💨 6');
  });

  it('gates reporting on wall clock, not tick count', () => {
    const gate = createCensusGate(1000);
    expect(gate(0)).toBe(true);      // the very first call always reports
    expect(gate(500)).toBe(false);
    expect(gate(999)).toBe(false);
    expect(gate(1000)).toBe(true);
    expect(gate(1600)).toBe(false);
    expect(gate(2601)).toBe(true);   // 1001ms since the last report
  });
});
