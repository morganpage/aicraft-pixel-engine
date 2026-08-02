import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../sand';
import { MaterialType, Materials } from '../materials';
import { FlatGravity, RadialGravity } from '../gravity';

/**
 * Yield strength — the Bingham term that separates lava from water.
 *
 * A Newtonian liquid flows until level however thin the film. Lava does not: a
 * flow advances only while the driving stress, which scales with thickness,
 * beats its yield strength, so it stops at a blunt front instead of feathering
 * away. Without this the engine offered only two regimes on a planet — spread
 * to an equipotential shell, or frozen solid — with nothing in between.
 */

function floored(width = 40, height = 24): PixelEngine {
  const e = new PixelEngine({ width, height, seed: 1, gravity: new FlatGravity() });
  for (let x = 0; x < width; x++) e.setMaterial(x, height - 1, MaterialType.WALL);
  return e;
}

/** Occupied-column count per x, and how many columns are occupied at all. */
function profile(e: PixelEngine, m: MaterialType): { cols: number[]; width: number } {
  const cols: number[] = [];
  for (let x = 0; x < e.width; x++) {
    let n = 0;
    for (let y = 0; y < e.height - 1; y++) if (e.getMaterial(x, y) === m) n++;
    cols.push(n);
  }
  return { cols, width: cols.filter((v) => v > 0).length };
}

describe('liquid yield strength', () => {
  it('leaves Newtonian liquids exactly as they were', () => {
    // Water has no yieldThickness, so none of this may touch it: it must still
    // spread to a flat, one-cell-deep sheet. This is the backward-compatibility
    // guarantee for every existing liquid.
    const e = floored();
    for (let y = 13; y < 23; y++) e.setMaterial(20, y, MaterialType.WATER);
    for (let i = 0; i < 300; i++) e.update();
    const p = profile(e, MaterialType.WATER);
    expect(Math.max(...p.cols)).toBe(1); // perfectly level
    expect(p.width).toBe(10);            // all 10 cells spread out
    expect(e.swapsLastFrame).toBe(0);    // and it still settles
  });

  it('holds a thin sheet of lava in place instead of levelling it', () => {
    // A 2-thick sheet is under lava's yield thickness, so it must not spread at
    // all. This is the mechanism behind flow fronts and levees.
    const e = floored();
    for (let x = 10; x < 30; x++) {
      e.setMaterial(x, 21, MaterialType.LAVA);
      e.setMaterial(x, 22, MaterialType.LAVA);
    }
    const before = profile(e, MaterialType.LAVA).width;
    for (let i = 0; i < 300; i++) e.update();
    expect(profile(e, MaterialType.LAVA).width).toBe(before);
    expect(e.swapsLastFrame).toBe(0);
  });

  it('lets a thick body of lava spread, but only until it thins', () => {
    // Over the threshold it flows; it stops once it has thinned to roughly the
    // yield thickness, rather than continuing to a one-cell film like water.
    const e = floored();
    for (let x = 18; x < 22; x++) for (let y = 15; y < 23; y++) e.setMaterial(x, y, MaterialType.LAVA);
    for (let i = 0; i < 400; i++) e.update();
    const p = profile(e, MaterialType.LAVA);
    expect(p.width).toBeGreaterThan(4);  // it did spread
    expect(p.width).toBeLessThan(20);    // but nothing like water would
    expect(e.swapsLastFrame).toBe(0);
  });

  it('stops lava creeping around a planet the way water does', () => {
    // The regression that motivated the whole term. Poured onto a planet with no
    // yield strength, lava reached 180° — an orange ocean — at slow cooling.
    // Bounded spreading is what makes a volcano possible at all.
    const SIZE = 160, CX = 80, CY = 80, R = 50;
    const e = new PixelEngine({
      width: SIZE, height: SIZE, seed: 1,
      gravity: new RadialGravity({ centerX: CX, centerY: CY }),
    });
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const dx = x - CX, dy = y - CY;
      if (dx * dx + dy * dy <= R * R) e.setMaterial(x, y, MaterialType.ROCK);
    }
    // A generous blob of lava dumped on the north pole.
    for (let dy = -6; dy <= 0; dy++) for (let dx = -6; dx <= 6; dx++) {
      e.setMaterial(CX + dx, CY - R + dy, MaterialType.LAVA);
    }
    for (let i = 0; i < 1200; i++) e.update();

    let maxDeg = 0;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      if (e.getMaterial(x, y) !== MaterialType.LAVA) continue;
      const dx = x - CX, dy = y - CY;
      maxDeg = Math.max(maxDeg, Math.abs(((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 540) % 360 - 180));
    }
    expect(maxDeg).toBeLessThan(60);
    expect(e.swapsLastFrame).toBe(0);
  });

  it('flowThickness measures the run through a cell along the gravity axis', () => {
    // Counted both ways, so the levelling pass (which only ever sees the cell at
    // the top of a column) and the movement pass (which can see any cell in it)
    // agree on how thick the flow is.
    const e = floored();
    for (let y = 18; y < 23; y++) e.setMaterial(20, y, MaterialType.LAVA);
    // From the top cell of the column, looking down.
    expect(e.flowThickness(20, 18, MaterialType.LAVA, 0, 1, 8)).toBe(5);
    // From the middle, looking both ways.
    expect(e.flowThickness(20, 20, MaterialType.LAVA, 0, 1, 8)).toBe(5);
    // Capped.
    expect(e.flowThickness(20, 20, MaterialType.LAVA, 0, 1, 3)).toBe(3);
  });
});

describe('per-cell stiffness', () => {
  it('overrides the material default', () => {
    // A thin sheet normally locks. Marked fluid (stiffness 1, always met) the
    // same sheet must flow — this is how a host with a heat field makes fresh
    // lava mobile and chilled lava stiff.
    const e = floored();
    e.stiffnessGrid = new Uint8Array(e.width * e.height);
    for (let x = 15; x < 25; x++) {
      for (const y of [21, 22]) {
        e.setMaterial(x, y, MaterialType.LAVA);
        e.stiffnessGrid[y * e.width + x] = 1;
      }
    }
    const before = profile(e, MaterialType.LAVA).width;
    for (let i = 0; i < 200; i++) e.update();
    expect(profile(e, MaterialType.LAVA).width).toBeGreaterThan(before);
  });

  it('rides along with the material when it moves', () => {
    // The whole point of it living on the engine: a stiffened parcel has to stay
    // stiff as it flows, or the rheology would be a property of the *location*.
    const e = floored();
    e.stiffnessGrid = new Uint8Array(e.width * e.height);
    e.setMaterial(20, 10, MaterialType.LAVA);
    e.stiffnessGrid[10 * e.width + 20] = 7;
    e.update(); // the cell falls one row
    expect(e.getMaterial(20, 11)).toBe(MaterialType.LAVA);
    expect(e.stiffnessGrid[11 * e.width + 20]).toBe(7);
    expect(e.stiffnessGrid[10 * e.width + 20]).toBe(0);
  });

  it('is dropped when a cell becomes a different material', () => {
    const e = floored();
    e.stiffnessGrid = new Uint8Array(e.width * e.height);
    e.setMaterial(5, 5, MaterialType.LAVA);
    e.stiffnessGrid[5 * e.width + 5] = 6;
    e.setMaterial(5, 5, MaterialType.ROCK);
    expect(e.stiffnessGrid[5 * e.width + 5]).toBe(0);
  });

  it('lava declares a yield thickness and other liquids do not', () => {
    expect(Materials[MaterialType.LAVA].yieldThickness).toBeGreaterThan(1);
    expect(Materials[MaterialType.WATER].yieldThickness).toBeUndefined();
    expect(Materials[MaterialType.OIL].yieldThickness).toBeUndefined();
    expect(Materials[MaterialType.ACID].yieldThickness).toBeUndefined();
  });
});
