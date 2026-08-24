import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../sand';
import { MaterialType } from '../materials';
import { FlatGravity } from '../gravity';

function filledWithWall(): PixelEngine {
  const e = new PixelEngine({ width: 11, height: 11, seed: 7, gravity: new FlatGravity() });
  for (let y = 0; y < 11; y++) for (let x = 0; x < 11; x++) e.setMaterial(x, y, MaterialType.WALL);
  return e;
}

describe('explode', () => {
  /**
   * A degenerate radius used to produce a degenerate blast rather than nothing.
   *
   * `falloff = 1 - dist / radius` is `NaN` at `radius === 0`, and every
   * threshold test against NaN reads false — so the carve loop fell through to
   * the scatter path (deleting the centre cell and launching it as debris)
   * while solids at the same cell survived, and the fire core spawned anyway
   * because its radius has a floor of 3. A negative radius skipped the carve
   * loop entirely and still lit a 3-cell fireball.
   */
  it('is a no-op at zero or negative radius', () => {
    for (const r of [0, -1, -8]) {
      const e = filledWithWall();
      const before = Uint8Array.from(e.grid);
      let fired = false;
      e.explode(5, 5, r, 5);
      expect(fired, `hook for radius ${r}`).toBe(false);
      expect(e.grid, `grid unchanged for radius ${r}`).toEqual(before);
    }
  });

  it('does not light a fire core when the radius is non-positive', () => {
    // The fire core has a radius floor of 3, so it was the part that fired even
    // when the blast itself carved nothing.
    const e = new PixelEngine({ width: 11, height: 11, seed: 1, gravity: new FlatGravity() });
    e.explode(5, 5, 0, 5);
    for (let i = 0; i < e.grid.length; i++) {
      expect(e.grid[i]).toBe(MaterialType.EMPTY);
    }
  });

  it('fires the onExplode hook with metadata', () => {
    let fired: { x: number; y: number; r: number; f: number } | null = null;
    const e = new PixelEngine({
      width: 11, height: 11, seed: 1, gravity: new FlatGravity(),
      onExplode: (x, y, r, f) => (fired = { x, y, r, f }),
    });
    e.explode(5, 5, 4, 9);
    expect(fired).toEqual({ x: 5, y: 5, r: 4, f: 9 });
  });

  it('carves the high-falloff core clear of WALL', () => {
    const e = filledWithWall();
    e.explode(5, 5, 4, 3);
    // The center is consumed by the blast + fire core — never WALL.
    expect(e.getMaterial(5, 5)).not.toBe(MaterialType.WALL);
    // WALL is only affected where falloff > 0.3, i.e. dist < radius*0.7.
    // For radius 4 that's dist < 2.8 → dist² < 7.84. Assert the guaranteed
    // carve core (dist² ≤ 7) holds no WALL.
    for (let y = 2; y <= 8; y++) {
      for (let x = 2; x <= 8; x++) {
        const dx = x - 5, dy = y - 5;
        if (dx * dx + dy * dy <= 7) {
          expect(e.getMaterial(x, y), `(${x},${y}) in core cleared`).not.toBe(MaterialType.WALL);
        }
      }
    }
  });

  it('pulverizes the outer ring into scattered SAND debris', () => {
    const e = filledWithWall();
    e.explode(5, 5, 4, 3);
    // WALL/ROCK in the >0.3 falloff band is converted to colored SAND and
    // scattered outward, so some SAND must exist on the grid afterwards.
    let sandAnywhere = 0;
    for (let y = 0; y < 11; y++) {
      for (let x = 0; x < 11; x++) {
        if (e.getMaterial(x, y) === MaterialType.SAND) sandAnywhere++;
      }
    }
    expect(sandAnywhere).toBeGreaterThan(0);
  });

  it('ignites a fire/smoke core in the inner 40%', () => {
    const e = filledWithWall();
    e.explode(5, 5, 6, 3);
    // radius 6 → fireRadius = max(3, floor(6*0.4)) = 3. Core should have fire/smoke.
    let fireOrSmokeInCore = 0;
    for (let y = 2; y <= 8; y++) {
      for (let x = 2; x <= 8; x++) {
        const m = e.getMaterial(x, y);
        if (m === MaterialType.FIRE || m === MaterialType.SMOKE) fireOrSmokeInCore++;
      }
    }
    expect(fireOrSmokeInCore).toBeGreaterThan(0);
  });

  it('wakes and flags render-dirty chunks around the blast', () => {
    const e = filledWithWall();
    // consume the initial "all dirty" snapshot
    e.consumeRenderDirtyChunks();
    e.explode(5, 5, 3, 2);
    const dirty = e.consumeRenderDirtyChunks();
    const cs = e.CHUNK_SIZE;
    // The chunk containing (5,5) must be dirty.
    const ccx = Math.floor(5 / cs);
    const ccy = Math.floor(5 / cs);
    expect(dirty[ccy * e.chunkWidth + ccx]).toBe(1);
  });

  it('default hook (omitted) is a no-op and does not throw', () => {
    const e = filledWithWall();
    expect(() => e.explode(5, 5, 3, 2)).not.toThrow();
  });
});
