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

  it('a pile on an open floor levels out', () => {
    // The headline test for height-field levelling, and the case walls hide:
    // with no side walls to shape it, a liquid body has to level itself. Before
    // the levelling pass this settled as a dome 16 rows tall that never stopped
    // moving (32 swaps/frame), because a contiguous body can only advance at
    // its free boundary and the boundary had nowhere to descend to.
    const W = 300, H = 195;
    const e = new PixelEngine({ width: W, height: H, seed: 1, gravity: new FlatGravity() });
    for (let x = 0; x < W; x++) e.setMaterial(x, H - 1, MaterialType.WALL);
    // Pour from a brush-sized blob in the middle, as the sandbox does.
    for (let i = 0; i < 600; i++) {
      const cx = 150, cy = 120, r = 14;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          if (e.getMaterial(cx + dx, cy + dy) === MaterialType.EMPTY) {
            e.setMaterial(cx + dx, cy + dy, MaterialType.WATER);
          }
        }
      }
      e.update();
    }
    for (let i = 0; i < 3000; i++) e.update();

    const surface: number[] = [];
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) {
        if (e.getMaterial(x, y) === MaterialType.WATER) { surface.push(y); break; }
      }
    }
    // Residual slope is bounded by the levelling reach: roughly one cell per
    // LIQUID_LEVEL_REACH cells of span, so ~5 across a 300-wide pool.
    const flatness = Math.max(...surface) - Math.min(...surface);
    expect(flatness, `surface spread across ${surface.length} columns`).toBeLessThanOrEqual(6);
    // And having levelled, it must go quiet — the failure mode of an earlier
    // attempt was levelling that never terminated.
    for (let i = 0; i < 10; i++) { e.update(); expect(e.swapsLastFrame).toBe(0); }
  });

  it('levelling conserves liquid exactly', () => {
    // The levelling pass writes the grid directly rather than going through
    // swap(), so it could silently create or destroy cells. Pin it under both
    // gravity models, including while the body is actively flowing.
    for (const [name, gravity] of [
      ['flat', new FlatGravity()],
      ['radial', new RadialGravity({ centerX: 60, centerY: 60 })],
    ] as const) {
      const e = new PixelEngine({ width: 120, height: 120, seed: 3, gravity });
      for (let x = 0; x < 120; x++) e.setMaterial(x, 119, MaterialType.WALL);
      if (name === 'radial') {
        for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) {
          const dx = x - 60, dy = y - 60;
          if (dx * dx + dy * dy <= 34 * 34) e.setMaterial(x, y, MaterialType.ROCK);
        }
      }
      let expected = 0;
      for (let y = 30; y < 45; y++) for (let x = 40; x < 60; x++) {
        if (e.getMaterial(x, y) === MaterialType.EMPTY) { e.setMaterial(x, y, MaterialType.WATER); expected++; }
      }
      const count = (): number => {
        let n = 0;
        for (let i = 0; i < e.grid.length; i++) if (e.grid[i] === MaterialType.WATER) n++;
        return n;
      };
      for (let i = 0; i < 400; i++) {
        e.update();
        expect(count(), `${name} gravity, frame ${i}`).toBe(expected);
      }
    }
  });

  it('a planet-scale ocean shell settles to a dead stop', () => {
    // Guards the curvature-following probe in `flowRun`. A straight-line probe
    // walks off a curved surface within a few cells and then tests descent
    // against a stale "down", which leaves this scene shimmering at 12
    // swaps/frame forever. Re-deriving the frame per probe step takes it to 0.
    // Showcase-scale planet (220x220, r=66) so the curvature matches what the
    // planet section actually renders.
    const SIZE = 220, CX = 110, CY = 110, R = 66;
    const e = new PixelEngine({ width: SIZE, height: SIZE, seed: 1, gravity: new RadialGravity({ centerX: CX, centerY: CY }) });
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const dx = x - CX, dy = y - CY, d2 = dx * dx + dy * dy;
      if (d2 <= R * R) e.setMaterial(x, y, MaterialType.ROCK);
      else if (d2 <= (R + 5) * (R + 5)) e.setMaterial(x, y, MaterialType.WATER);
    }
    for (let i = 0; i < 4000; i++) e.update();
    for (let i = 0; i < 20; i++) {
      e.update();
      expect(e.swapsLastFrame, `frame ${i} after settle`).toBe(0);
    }
  });

  it('radial scattered puddles settle to a dead stop', () => {
    // A sparse ring of single cells lands as scattered puddles. This used to
    // retain a residual jitter (14+ swaps/frame originally, 8 after the
    // curvature-following probe), which the potential gate eliminated: the
    // residual was the quantized level axis ratcheting liquid uphill by
    // sub-cell amounts, ~0.25-0.5 cells of head per step, indefinitely.
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
    for (let i = 0; i < 20; i++) {
      e.update();
      expect(e.swapsLastFrame, `frame ${i} after settle`).toBe(0);
    }
  });

  it('a level step never carries liquid uphill', () => {
    // Directly pins the potential gate rather than its symptom. Every liquid
    // move the engine makes must be downhill or level in the gravity model's
    // own potential field; an uphill move means the quantized level axis is
    // ratcheting the body upward again.
    const SIZE = 120, CX = 60, CY = 60, R = 34;
    const g = new RadialGravity({ centerX: CX, centerY: CY });
    const e = new PixelEngine({ width: SIZE, height: SIZE, seed: 1, gravity: g });
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const dx = x - CX, dy = y - CY, d2 = dx * dx + dy * dy;
      if (d2 <= R * R) e.setMaterial(x, y, MaterialType.ROCK);
      else if (d2 <= (R + 4) * (R + 4)) e.setMaterial(x, y, MaterialType.WATER);
    }
    // Wrap swap() to audit the potential change of every liquid move.
    const origSwap = e.swap.bind(e);
    let uphill = 0;
    (e as unknown as { swap: typeof origSwap }).swap = (x1, y1, x2, y2) => {
      const m1 = e.grid[e.getIndex(x1, y1)];
      const m2 = e.grid[e.getIndex(x2, y2)];
      if (m1 === MaterialType.WATER && m2 !== MaterialType.WATER) {
        if (g.potentialAt(x2, y2) > g.potentialAt(x1, y1) + 1e-9) uphill++;
      }
      origSwap(x1, y1, x2, y2);
    };
    for (let i = 0; i < 400; i++) e.update();
    expect(uphill).toBe(0);
  });
});
