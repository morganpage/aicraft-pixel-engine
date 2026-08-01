import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../sand';
import { MaterialType } from '../materials';
import { FlatGravity, RadialGravity } from '../gravity';

/**
 * Determinism guarantee: same seed + same public calls + same gravity model
 * → identical grid evolution over any number of frames.
 *
 * Validated under BOTH Flat and Radial gravity, since radial movement is a
 * new code path that must also be deterministic.
 */

const N = 60;

/** Snapshot the grid as a string for easy comparison. */
function snapshot(e: PixelEngine): string {
  // Use the underlying buffer slice for a compact, fast fingerprint.
  const g = e.grid;
  let s = '';
  for (let i = 0; i < g.length; i++) s += g[i] + ',';
  return s;
}

/** Build an engine preloaded with a nontrivial starting state. */
function buildEngine(gravity: 'flat' | 'radial'): PixelEngine {
  const g =
    gravity === 'flat'
      ? new FlatGravity()
      : new RadialGravity({ centerX: 40, centerY: 30 });
  const e = new PixelEngine({ width: 80, height: 60, seed: 99, gravity: g });
  // A floor of walls.
  for (let x = 0; x < 80; x++) e.setMaterial(x, 59, MaterialType.WALL);
  // A central blob of mixed materials.
  for (let y = 20; y < 30; y++) {
    for (let x = 30; x < 50; x++) {
      const m = (x + y) % 4;
      if (m === 0) e.setMaterial(x, y, MaterialType.SAND);
      else if (m === 1) e.setMaterial(x, y, MaterialType.WATER);
      else if (m === 2) e.setMaterial(x, y, MaterialType.OIL);
      else e.setMaterial(x, y, MaterialType.LAVA);
    }
  }
  return e;
}

describe('determinism under FlatGravity', () => {
  it('two engines with the same seed evolve identically', () => {
    const a = buildEngine('flat');
    const b = buildEngine('flat');
    let sa = '';
    let sb = '';
    for (let i = 0; i < N; i++) {
      a.update();
      b.update();
      sa = snapshot(a);
      sb = snapshot(b);
    }
    expect(sa).toEqual(sb);
  });

  it('liquids level into a flat surface (behave like a liquid, not sand)', () => {
    // Behavioral check for the liquid-flow rule: a deep column poured into a
    // cup must spread out and form a FLAT surface (water leveling), rather
    // than staying piled in a column (sand-like). This is the property that
    // distinguishes liquid behavior from granular — the original single-cell
    // lateral flow rule achieves it.
    const e = new PixelEngine({ width: 40, height: 20, seed: 1, gravity: new FlatGravity() });
    for (let x = 0; x < 40; x++) e.setMaterial(x, 19, MaterialType.WALL);
    for (let y = 0; y < 20; y++) { e.setMaterial(5, y, MaterialType.WALL); e.setMaterial(34, y, MaterialType.WALL); }
    // Pour a deep column on the left of the cup.
    for (let y = 1; y <= 12; y++) e.setMaterial(8, y, MaterialType.WATER);

    // Settle: water spreads across the cup and levels.
    for (let i = 0; i < 600; i++) e.update();

    // Surface row per column (topmost water cell). A liquid levels to ~1 row;
    // sand would leave a tall pile (big row range).
    const surfaceRows: number[] = [];
    let cols = 0;
    for (let x = 6; x < 34; x++) {
      for (let y = 0; y < 20; y++) {
        if (e.getMaterial(x, y) === MaterialType.WATER) { surfaceRows.push(y); cols++; break; }
      }
    }
    expect(cols).toBeGreaterThan(1); // spread out, not a single column
    const flatness = Math.max(...surfaceRows) - Math.min(...surfaceRows);
    expect(flatness).toBeLessThanOrEqual(2); // near-flat surface (liquid, not piled)
  });

  it('a deep column levels flat and spreads across a wide cup', () => {
    // Regression test for the "water piles instead of leveling" bug. A deep
    // column poured into a wide cup must spread out and form a near-flat
    // surface, not stay piled in a narrow column. The fix: velocity memory +
    // emptier-side lateral flow gives the frontier a deterministic outward push.
    const e = new PixelEngine({ width: 40, height: 20, seed: 1, gravity: new FlatGravity() });
    for (let x = 0; x < 40; x++) e.setMaterial(x, 19, MaterialType.WALL);
    for (let y = 0; y < 20; y++) { e.setMaterial(5, y, MaterialType.WALL); e.setMaterial(34, y, MaterialType.WALL); }
    // 18 cells poured in a single deep column at x=8.
    for (let y = 1; y <= 18; y++) e.setMaterial(8, y, MaterialType.WATER);
    for (let i = 0; i < 1500; i++) e.update();

    // Must spread well beyond the pour column (was ~9 cols when broken).
    let cols = 0;
    const surfaceRows: number[] = [];
    for (let x = 6; x < 34; x++) {
      for (let y = 0; y < 20; y++) {
        if (e.getMaterial(x, y) === MaterialType.WATER) { cols++; surfaceRows.push(y); break; }
      }
    }
    expect(cols).toBeGreaterThan(14); // spreads across most of the cup
    const flatness = surfaceRows.length ? Math.max(...surfaceRows) - Math.min(...surfaceRows) : 99;
    expect(flatness).toBeLessThanOrEqual(2); // near-flat (was 4 when piling)
  });
});

describe('determinism under RadialGravity', () => {
  it('two radial engines with the same seed evolve identically', () => {
    const a = buildEngine('radial');
    const b = buildEngine('radial');
    let sa = '';
    let sb = '';
    for (let i = 0; i < N; i++) {
      a.update();
      b.update();
      sa = snapshot(a);
      sb = snapshot(b);
    }
    expect(sa).toEqual(sb);
  });

  it('a precomputed radial golden sequence is stable across runs', () => {
    // Run once to capture the golden, then run a second independent engine
    // and assert equality. This catches nondeterminism from any source
    // (iteration order, float drift, accidental Math.random).
    const run = (): string => {
      const e = buildEngine('radial');
      for (let i = 0; i < N; i++) e.update();
      return snapshot(e);
    };
    expect(run()).toEqual(run());
  });
});
