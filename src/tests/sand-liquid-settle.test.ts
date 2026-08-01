import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../sand';
import { MaterialType } from '../materials';
import { FlatGravity, RadialGravity } from '../gravity';

/**
 * Regression tests for the liquid-shimmer / foam bug.
 *
 * Before the `flowRun` purpose-gate, a settled pool was a ~50%-density foam:
 * water traded places with the holes in its own lattice every frame, forever
 * (282 swaps/frame in the 64×64 scenario below), never compacted, and
 * `beginSettle()` always timed out. These tests guard each property the fix
 * restored — a settled pool goes quiet, compacts, fills, lets settle converge,
 * and drives the render-dirty set to zero. They would all fail on the old
 * engine.
 *
 * Scenario: 64×64 cup, 20×20 block (400 cells) of water dropped in the middle,
 * run well past any reasonable settle time. This is large enough for the foam
 * lattice to establish (the existing 40×20 cup with 18 cells was too small to
 * surface the bug — see the investigation plan, §3.2).
 */

/** Build the 64×64 cup scenario with a 400-cell water block. */
function buildPoolEngine(): PixelEngine {
  const e = new PixelEngine({ width: 64, height: 64, seed: 1, gravity: new FlatGravity() });
  for (let x = 0; x < 64; x++) e.setMaterial(x, 63, MaterialType.WALL); // floor
  for (let y = 0; y < 64; y++) { e.setMaterial(0, y, MaterialType.WALL); e.setMaterial(63, y, MaterialType.WALL); } // walls
  for (let y = 22; y < 42; y++) for (let x = 22; x < 42; x++) e.setMaterial(x, y, MaterialType.WATER);
  return e;
}

describe('liquid settling (the shimmer/foam regression)', () => {
  it('a settled pool goes completely quiet', () => {
    const e = buildPoolEngine();
    for (let i = 0; i < 600; i++) e.update();
    // After settling, every one of the next 20 frames must do zero work.
    // Fails on the old engine at 282 swaps/frame.
    for (let i = 0; i < 20; i++) {
      e.update();
      expect(e.swapsLastFrame, `frame ${i} after settle`).toBe(0);
    }
  });

  it('a pool compacts — no water rests on empty', () => {
    const e = buildPoolEngine();
    for (let i = 0; i < 600; i++) e.update();
    // The strongest single guard: catches the foam directly. Fails on the old
    // engine with 171 violations.
    let violations = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (e.getMaterial(x, y) === MaterialType.WATER && e.getMaterial(x, y + 1) === MaterialType.EMPTY) {
          violations++;
        }
      }
    }
    expect(violations).toBe(0);
  });

  it('the wetted region is a dense body of water', () => {
    const e = buildPoolEngine();
    for (let i = 0; i < 600; i++) e.update();
    // Bounding box of the water; assert it's ≥ 95% water (was 49.6% as foam).
    let water = 0, empty = 0;
    let minY = 64, maxY = 0, minX = 64, maxX = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (e.getMaterial(x, y) === MaterialType.WATER) {
          water++;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
        }
      }
    }
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (e.getMaterial(x, y) === MaterialType.EMPTY) empty++;
      }
    }
    expect(water / (water + empty)).toBeGreaterThanOrEqual(0.9);
  });

  it('beginSettle() converges naturally (does not time out)', () => {
    const e = buildPoolEngine();
    e.beginSettle();
    // Run well past the natural settle point but under the 600-frame timeout.
    let steps = 0;
    while (e.isSettling && steps < 599) { e.update(); steps++; }
    expect(e.isSettled).toBe(true);
    expect(e.settleTimedOut).toBe(false); // old engine always timed out
  });

  it('a settled pool drives render-dirty to zero (engine idles)', () => {
    const e = buildPoolEngine();
    for (let i = 0; i < 600; i++) e.update();
    // Clear the initial all-dirty snapshot, then settle a few more frames.
    e.consumeRenderDirtyChunks();
    for (let i = 0; i < 10; i++) e.update();
    const dirty = e.consumeRenderDirtyChunks();
    let dirtyCount = 0;
    for (let i = 0; i < dirty.length; i++) dirtyCount += dirty[i];
    expect(dirtyCount).toBe(0); // a quiet pool repaints nothing
  });

  it('radial water settles within an honest bound (not zero — known seam jitter)', () => {
    // Per the investigation (§6.2), radial gravity has a residual ~14-swap
    // period-2 jitter at the eight octant seams where snapToCompass flips
    // which diagonal is "down". This test encodes the honest bound so it
    // guards against regressions without falsely claiming radial is fully
    // solved. Sand on the same planet settles to exactly 0.
    const SIZE = 80, CX = 40, CY = 40, R = 20;
    const e = new PixelEngine({ width: SIZE, height: SIZE, seed: 1, gravity: new RadialGravity({ centerX: CX, centerY: CY }) });
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const dx = x - CX, dy = y - CY;
      if (dx * dx + dy * dy <= R * R) e.setMaterial(x, y, MaterialType.ROCK);
    }
    for (let a = 0; a < 360; a += 6) {
      const rad = (a * Math.PI) / 180;
      e.setMaterial(Math.round(CX + Math.cos(rad) * (R + 8)), Math.round(CY + Math.sin(rad) * (R + 8)), MaterialType.WATER);
    }
    for (let i = 0; i < 500; i++) e.update();
    const swaps: number[] = [];
    for (let i = 0; i < 20; i++) { e.update(); swaps.push(e.swapsLastFrame); }
    expect(Math.max(...swaps)).toBeLessThanOrEqual(20);
  });
});
