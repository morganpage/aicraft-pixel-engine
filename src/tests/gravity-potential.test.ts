import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../sand';
import { MaterialType } from '../materials';
import { FlatGravity, RadialGravity, type GravityModel, type Vec2 } from '../gravity';

/**
 * Contract tests for `GravityModel.potentialAt` — the scalar "height" field.
 *
 * `gravityAt` is purely local: it says which way is down from a cell, but not
 * whether some distant cell is lower. Levelling a liquid needs that comparison,
 * so it needs a scalar field. These tests pin the contract the levelling pass
 * will rely on (see `.zcode/plans/design-liquid-height-field.md` §3).
 *
 * The load-bearing property is **consistency with `gravityAt`**: stepping one
 * cell along the gravity direction must reduce the potential by ~1. If that
 * ever breaks, "downhill" means different things to the direction field and the
 * height field, and every rule built on top of them fights itself.
 *
 * Nothing consumes `potentialAt` yet — the last test pins that too.
 */

/** Tolerance for float comparisons. */
const EPS = 1e-9;

describe('GravityModel.potentialAt', () => {
  it('FlatGravity: potential decreases by exactly 1 per cell of fall', () => {
    const g = new FlatGravity();
    for (const y of [0, 1, 37, 194]) {
      // Down is +Y, so stepping to y+1 must lose exactly one unit of head.
      expect(g.potentialAt(10, y) - g.potentialAt(10, y + 1)).toBeCloseTo(1, 12);
    }
    // Height is independent of x on a flat world.
    expect(g.potentialAt(0, 50)).toBe(g.potentialAt(299, 50));
  });

  it('RadialGravity: potential decreases by exactly 1 per cell toward the center', () => {
    const g = new RadialGravity({ centerX: 110, centerY: 110 });
    // Along each axis, one cell inward is one unit of head.
    expect(g.potentialAt(180, 110) - g.potentialAt(179, 110)).toBeCloseTo(1, 12);
    expect(g.potentialAt(110, 40) - g.potentialAt(110, 41)).toBeCloseTo(1, 12);
    // Potential is constant on a circle — that is what "sea level" will mean.
    const r = 66;
    for (const deg of [0, 37, 90, 143, 180, 271]) {
      const a = (deg * Math.PI) / 180;
      expect(g.potentialAt(110 + Math.cos(a) * r, 110 + Math.sin(a) * r)).toBeCloseTo(r, 9);
    }
    // Flat and well-defined at the center, matching gravityAt's fallback.
    expect(g.potentialAt(110, 110)).toBeCloseTo(0, 12);
  });

  it('both models: stepping along gravityAt always reduces potential', () => {
    // The contract that ties the two methods together. Sampled across the grid
    // and, for radial, across all eight octants including the diagonals where
    // compass quantization is worst.
    const models: [string, GravityModel][] = [
      ['flat', new FlatGravity()],
      ['radial', new RadialGravity({ centerX: 110, centerY: 110 })],
    ];
    for (const [name, g] of models) {
      for (let deg = 0; deg < 360; deg += 17) {
        const a = (deg * Math.PI) / 180;
        const x = 110 + Math.cos(a) * 60;
        const y = 110 + Math.sin(a) * 60;
        const dir = g.gravityAt(x, y);
        const before = g.potentialAt!(x, y);
        const after = g.potentialAt!(x + dir.x, y + dir.y);
        expect(after, `${name} at ${deg}deg must fall downhill`).toBeLessThan(before - EPS);
        // And by ~1, since gravityAt is a unit vector.
        expect(before - after).toBeCloseTo(1, 6);
      }
    }
  });

  it('is pure — same cell always yields the same potential', () => {
    const g = new RadialGravity({ centerX: 32, centerY: 32 });
    const first = g.potentialAt(40, 33);
    for (let i = 0; i < 100; i++) expect(g.potentialAt(40, 33)).toBe(first);
  });

  it('is optional: a model without potentialAt still simulates correctly', () => {
    // Guards the non-breaking-API promise. A consumer's custom GravityModel
    // predates this method and must keep working — it simply opts out of
    // potential-based levelling and behaves as the engine did before.
    //
    // Note this asserts graceful degradation, NOT identical output: the whole
    // purpose of the field is to change how liquids settle, so a model that
    // provides one is expected to level better than one that does not.
    class BareFlat implements GravityModel {
      gravityAt(_x: number, _y: number): Vec2 { return { x: 0, y: 1 }; }
    }
    expect((new BareFlat() as GravityModel).potentialAt).toBeUndefined();

    const run = (gravity: GravityModel): PixelEngine => {
      const e = new PixelEngine({ width: 48, height: 48, seed: 7, gravity });
      for (let x = 0; x < 48; x++) e.setMaterial(x, 47, MaterialType.WALL);
      for (let y = 0; y < 48; y++) { e.setMaterial(0, y, MaterialType.WALL); e.setMaterial(47, y, MaterialType.WALL); }
      for (let y = 20; y < 30; y++) for (let x = 20; x < 30; x++) e.setMaterial(x, y, MaterialType.WATER);
      for (let i = 0; i < 400; i++) e.update();
      return e;
    };

    const bare = run(new BareFlat());
    const withPotential = run(new FlatGravity());

    // Conservation: no liquid is created or destroyed either way.
    const countWater = (e: PixelEngine): number => {
      let n = 0;
      for (let i = 0; i < e.grid.length; i++) if (e.grid[i] === MaterialType.WATER) n++;
      return n;
    };
    expect(countWater(bare)).toBe(100);
    expect(countWater(withPotential)).toBe(100);

    // Both settle; the one with a potential field is not worse.
    expect(bare.swapsLastFrame).toBe(0);
    expect(withPotential.swapsLastFrame).toBe(0);

    // And it is deterministic without a potential field, as before.
    expect(Uint8Array.from(run(new BareFlat()).grid)).toEqual(Uint8Array.from(bare.grid));
  });
});
