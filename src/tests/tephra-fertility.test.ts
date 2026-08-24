import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../sand';
import { MaterialType } from '../materials';
import { FlatGravity } from '../gravity';

/**
 * Volcanic ash is fertile: tephra counts as soil for both life rules — grass
 * creeps onto a cooled cone's flanks (given water within its range) and seeds
 * germinate on it — while still-hot ejecta stays sterile, and seeds rest on
 * loose ash instead of sinking out of sight.
 */

const TREE_PARTS = [MaterialType.WOOD, MaterialType.LEAF, MaterialType.TREE_TIP];

function ashWorld(opts?: { heat?: boolean; ambient?: number; growthInterval?: number }): PixelEngine {
  const e = new PixelEngine({
    width: 32, height: 24, seed: 7, gravity: new FlatGravity(),
    enableHeat: opts?.heat ?? false,
    ambientTemperature: opts?.ambient,
    growthInterval: opts?.growthInterval ?? 1, // every frame by default, so tests settle fast
  });
  // A tephra "cone" floor across the middle rows.
  for (let y = 16; y < 24; y++) {
    for (let x = 0; x < 32; x++) e.setMaterial(x, y, MaterialType.TEPHRA);
  }
  return e;
}

function count(e: PixelEngine, mat: MaterialType): number {
  let n = 0;
  for (let i = 0; i < e.grid.length; i++) if (e.grid[i] === mat) n++;
  return n;
}

describe('tephra fertility', () => {
  it('grass spreads onto tephra near water', () => {
    const e = ashWorld();
    // Meadow geometry (mirrors the sand-shelf fixture in sand-growth.test.ts):
    // water ADJACENT to the colonist on the same row — the moisture scan
    // reaches an adjacent cell, not one further along.
    e.setMaterial(9, 15, MaterialType.WATER);
    e.setMaterial(8, 15, MaterialType.WATER);
    e.setMaterial(10, 15, MaterialType.GRASS);
    for (let i = 0; i < 3000; i++) e.update();
    expect(count(e, MaterialType.GRASS)).toBeGreaterThan(1);
  });

  it('grass does not spread onto tephra without water nearby', () => {
    const e = ashWorld();
    e.setMaterial(10, 15, MaterialType.GRASS);  // no water anywhere
    for (let i = 0; i < 600; i++) e.update();
    expect(count(e, MaterialType.GRASS)).toBe(1);
  });

  it('grass does not spread onto hot tephra', () => {
    const e = ashWorld({ heat: true });
    e.setMaterial(2, 16, MaterialType.WATER);
    e.setMaterial(10, 15, MaterialType.GRASS);
    // Scalding ground: every tephra surface cell well above the temp window.
    for (let y = 16; y < 24; y++) {
      for (let x = 0; x < 32; x++) e.setHeat(x, y, 0.9);
    }
    for (let i = 0; i < 600; i++) e.update();
    expect(count(e, MaterialType.GRASS)).toBe(1);
  });

  it('seeds germinate on tephra', () => {
    const e = ashWorld();
    e.setMaterial(10, 15, MaterialType.SEED);
    let sprouted = false;
    for (let i = 0; i < 600 && !sprouted; i++) {
      e.update();
      for (const m of TREE_PARTS) if (count(e, m) > 0) sprouted = true;
    }
    expect(sprouted).toBe(true);
  });

  it('seeds rest on tephra instead of sinking into it', () => {
    // Growth effectively never fires here, so the RESTING behavior is
    // observable before germination can replace the seed.
    const e = ashWorld({ growthInterval: 1_000_000 });
    e.setMaterial(10, 0, MaterialType.SEED);
    for (let i = 0; i < 60; i++) e.update();
    // The seed fell, but stopped ON the ash surface (row 15 sits on the
    // tephra floor that begins at row 16) rather than vanishing inside it.
    const y = Math.floor(e.grid.indexOf(MaterialType.SEED) / 32);
    expect(y).toBeGreaterThanOrEqual(10);
    expect(y).toBeLessThanOrEqual(15);
  });
});
