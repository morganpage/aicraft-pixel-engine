import { describe, it, expect } from 'vitest';
import { PixelEngine, DEFAULT_AMBIENT_TEMPERATURE } from '../sand';
import { MaterialType, Materials, isThermal } from '../materials';
import { FlatGravity } from '../gravity';

/**
 * A constant as it reads back out of the Float32Array.
 *
 * `heatGrid` is Float32 while every source constant is a JS double, so a stored
 * 0.1 returns 0.10000000149011612. Comparing against the rounded value rather
 * than loosening to `toBeCloseTo` keeps these assertions exact: seeding must
 * land on precisely the ambient value, not merely near it.
 */
const f32 = (v: number): number => Math.fround(v);

/**
 * Temperature — storage layer.
 *
 * This file covers the heat *field*: allocation, seeding, and the guarantee
 * that heat rides with the material it belongs to. The heat *step* — conduction,
 * environment exchange, phase change — lands separately and is tested
 * separately. What is pinned here is mostly what must NOT happen: heat must not
 * perturb movement, must not appear from nowhere, and must not stay behind when
 * its cell moves.
 */

function floored(width = 40, height = 24, opts: { heat?: boolean } = {}): PixelEngine {
  const e = new PixelEngine({
    width,
    height,
    seed: 1,
    gravity: new FlatGravity(),
    enableHeat: opts.heat,
  });
  for (let x = 0; x < width; x++) e.setMaterial(x, height - 1, MaterialType.WALL);
  return e;
}

describe('heat field — opt-in', () => {
  it('costs nothing and changes nothing for a host that never touches it', () => {
    // The backward-compatibility guarantee, and the load-bearing one: enabling
    // heat must not perturb the simulation by a single cell. Two identical
    // worlds, one tracking heat, must agree on `grid` forever.
    const cold = floored(40, 24, { heat: false });
    const hot = floored(40, 24, { heat: true });
    for (const e of [cold, hot]) {
      for (let y = 10; y < 20; y++) e.setMaterial(18, y, MaterialType.WATER);
      for (let x = 12; x < 16; x++) e.setMaterial(x, 5, MaterialType.SAND);
    }
    for (let i = 0; i < 200; i++) {
      cold.update();
      hot.update();
    }
    expect(Array.from(hot.grid)).toEqual(Array.from(cold.grid));

    // And the disabled engine allocated nothing at all.
    expect(cold.heatGrid).toBeNull();
    expect(cold.thermalChunks).toBeNull();
    expect(cold.activeThermalChunkCount).toBe(0);
  });

  it('reports a material temperature before the grid exists', () => {
    // `getHeat` has to answer without forcing the host to opt in, so an
    // unallocated field reports what the cell would be born at.
    const e = floored();
    e.setMaterial(5, 22, MaterialType.LAVA);
    expect(e.heatGrid).toBeNull();
    expect(e.getHeat(5, 22)).toBe(Materials[MaterialType.LAVA].spawnTemp);
    expect(e.getHeat(6, 22)).toBe(DEFAULT_AMBIENT_TEMPERATURE); // EMPTY -> ambient
    expect(e.getHeat(-1, 0)).toBe(DEFAULT_AMBIENT_TEMPERATURE); // out of bounds
  });
});

describe('heat field — allocation seeds rather than zero-fills', () => {
  it('does not freeze the world when the grid is allocated mid-simulation', () => {
    // `0` is a real temperature (it is *frozen*), so it cannot double as the
    // "unset" sentinel that colorGrid and stiffnessGrid rely on. A zero-filled
    // heat grid would assert the whole world is at absolute cold, and the first
    // phase-change pass would flash every lava cell to rock. Allocating via a
    // single distant setHeat must leave existing lava molten.
    const e = floored();
    for (let x = 4; x < 8; x++) e.setMaterial(x, 22, MaterialType.LAVA);
    expect(e.heatGrid).toBeNull();

    e.setHeat(30, 3, 0.5); // allocates, far from the lava

    expect(e.heatGrid).not.toBeNull();
    for (let x = 4; x < 8; x++) {
      expect(e.getHeat(x, 22)).toBe(Materials[MaterialType.LAVA].spawnTemp);
    }
    expect(e.getHeat(30, 3)).toBeCloseTo(0.5, 6);
    expect(e.getHeat(20, 10)).toBe(f32(DEFAULT_AMBIENT_TEMPERATURE)); // untouched EMPTY
  });

  it('seeds identically whether enabled at construction or lazily', () => {
    // enableHeat is a scheduling choice, not a behavioural one.
    const eager = floored(20, 12, { heat: true });
    const lazy = floored(20, 12, { heat: false });
    for (const e of [eager, lazy]) {
      e.setMaterial(5, 10, MaterialType.LAVA);
      e.setMaterial(6, 10, MaterialType.ICE);
      e.setMaterial(7, 10, MaterialType.SAND);
    }
    lazy.setHeat(0, 0, lazy.getHeat(0, 0)); // force allocation, change nothing
    expect(Array.from(lazy.heatGrid!)).toEqual(Array.from(eager.heatGrid!));
  });

  it('returns a cleared world to ambient, not to zero', () => {
    const e = floored(20, 12, { heat: true });
    e.setMaterial(5, 10, MaterialType.LAVA);
    expect(e.getHeat(5, 10)).toBe(1);
    e.clear();
    for (let i = 0; i < e.heatGrid!.length; i++) {
      expect(e.heatGrid![i]).toBe(f32(DEFAULT_AMBIENT_TEMPERATURE));
    }
  });
});

describe('heat field — birth temperature', () => {
  it('births a cell at its material spawnTemp, overridable afterwards', () => {
    const e = floored(20, 12, { heat: true });
    e.setMaterial(5, 10, MaterialType.LAVA);
    expect(e.getHeat(5, 10)).toBe(1);
    e.setMaterial(6, 10, MaterialType.ICE);
    expect(e.getHeat(6, 10)).toBe(0);
    e.setMaterial(7, 10, MaterialType.SAND); // no spawnTemp
    expect(e.getHeat(7, 10)).toBe(f32(DEFAULT_AMBIENT_TEMPERATURE));

    // setHeat after setMaterial wins; the reverse order is discarded, which is
    // the documented ordering hazard.
    e.setHeat(5, 10, 0.4);
    expect(e.getHeat(5, 10)).toBeCloseTo(0.4, 6);
    e.setMaterial(5, 10, MaterialType.LAVA); // same material, no reset
    expect(e.getHeat(5, 10)).toBeCloseTo(0.4, 6);
    e.setMaterial(5, 10, MaterialType.WATER); // real change, resets
    expect(e.getHeat(5, 10)).toBe(f32(Materials[MaterialType.WATER].spawnTemp!));
  });

  it('clamps writes to [0, 1]', () => {
    const e = floored(20, 12, { heat: true });
    e.setHeat(5, 5, 4);
    expect(e.getHeat(5, 5)).toBe(1);
    e.setHeat(5, 5, -2);
    expect(e.getHeat(5, 5)).toBe(0);
  });
});

describe('heat field — heat rides with the material', () => {
  it('carries heat with a falling cell rather than leaving it behind', () => {
    // The property that made colorGrid an attractive heat store in the first
    // place, and the reason heat must be a grid the engine owns rather than
    // host-side bookkeeping.
    const e = floored(20, 24, { heat: true });
    e.setMaterial(10, 2, MaterialType.SAND);
    e.setHeat(10, 2, 0.87);
    for (let i = 0; i < 60; i++) e.update();

    let found = -1;
    for (let y = 0; y < 24; y++) if (e.getMaterial(10, y) === MaterialType.SAND) found = y;
    expect(found).toBe(22); // landed on the floor
    expect(e.getHeat(10, found)).toBeCloseTo(0.87, 5);
    expect(e.getHeat(10, 2)).toBe(f32(DEFAULT_AMBIENT_TEMPERATURE)); // nothing left behind
  });

  it('carries heat through a levelling transfer, not just a swap', () => {
    // Levelling moves a cell non-locally by writing grid directly instead of
    // calling swap(), so it needs its own heat carry. A mound of water that
    // levels sideways must take its temperature along.
    const e = floored(40, 24, { heat: true });
    for (let y = 12; y < 23; y++) e.setMaterial(20, y, MaterialType.WATER);
    for (let y = 12; y < 23; y++) e.setHeat(20, y, 0.6);

    for (let i = 0; i < 300; i++) e.update();

    // The column has spread into a flat sheet; every water cell in it must
    // still be at the temperature it started with.
    let cells = 0;
    for (let x = 0; x < 40; x++) {
      for (let y = 0; y < 23; y++) {
        if (e.getMaterial(x, y) === MaterialType.WATER) {
          cells++;
          expect(e.getHeat(x, y)).toBeCloseTo(0.6, 5);
        }
      }
    }
    expect(cells).toBe(11); // nothing lost or duplicated
  });
});

describe('heat field — bookkeeping', () => {
  it('wakes the thermal chunk set independently of the movement set', () => {
    // A motionless flow still cools, so the thermal set cannot be derived from
    // the movement set. Writing heat into a settled region must wake it
    // thermally even when nothing there is moving.
    const e = floored(64, 64, { heat: true });
    for (let i = 0; i < 40; i++) e.update();
    expect(e.swapsLastFrame).toBe(0); // world is completely still

    // Let the thermal set quiesce too. Nothing clears it yet (that arrives with
    // the heat step), so drive it directly to a known state.
    e.nextThermalChunks!.fill(0);
    e.update();
    expect(e.activeThermalChunkCount).toBe(0);

    e.setHeat(40, 40, 0.9);
    e.update();
    expect(e.activeThermalChunkCount).toBeGreaterThan(0);
    expect(e.swapsLastFrame).toBe(0); // and still nothing moved
  });

  it('is deterministic across identical runs', () => {
    const run = (): { grid: number[]; heat: number[] } => {
      const e = floored(30, 20, { heat: true });
      for (let y = 10; y < 18; y++) e.setMaterial(15, y, MaterialType.WATER);
      for (let y = 10; y < 18; y++) e.setHeat(15, y, 0.3 + y * 0.01);
      e.setMaterial(8, 4, MaterialType.SAND);
      e.setHeat(8, 4, 0.77);
      for (let i = 0; i < 120; i++) e.update();
      return { grid: Array.from(e.grid), heat: Array.from(e.heatGrid!) };
    };
    expect(run()).toEqual(run());
  });
});

describe('heat field — material metadata', () => {
  it('marks exactly the materials that set a thermal field', () => {
    // Participation is implied by having any thermal property, so this pins the
    // derivation rather than a hand-maintained list. EMPTY especially must stay
    // out: heat stored in vacuum cells would advect through swap() as hot air
    // and be destroyed silently by setMaterial.
    const thermal = [
      MaterialType.WALL, MaterialType.SAND, MaterialType.WATER, MaterialType.LAVA,
      MaterialType.ROCK, MaterialType.STEAM, MaterialType.FIRE, MaterialType.WOOD,
      MaterialType.ICE,
    ];
    const inert = [
      MaterialType.EMPTY, MaterialType.SMOKE, MaterialType.OIL,
      MaterialType.ACID, MaterialType.FGAS,
    ];
    for (const m of thermal) expect(isThermal[m]).toBe(true);
    for (const m of inert) expect(isThermal[m]).toBe(false);
  });

  it('pairs every phase threshold with a destination material', () => {
    // freezesAt without freezesInto is a transformation to nowhere — a silent
    // no-op the heat step could not act on.
    for (const def of Object.values(Materials)) {
      if (def.freezesAt !== undefined) expect(def.freezesInto).toBeDefined();
      if (def.meltsAt !== undefined) expect(def.meltsInto).toBeDefined();
    }
  });

  it('keeps every phase threshold reachable by some heat source', () => {
    // A source held at T can never drive a neighbour past T, because conduction
    // moves a fraction of the *difference*. A threshold above the hottest
    // source in the table is unreachable by construction — which is exactly the
    // bug that made an earlier draft's fire-boils-water example impossible.
    const hottest = Math.max(
      ...Object.values(Materials)
        .filter((d) => d.heatSource)
        .map((d) => d.spawnTemp ?? 0)
    );
    for (const def of Object.values(Materials)) {
      if (def.meltsAt !== undefined) expect(def.meltsAt).toBeLessThanOrEqual(hottest);
    }
  });

  it('leaves water and ice both stable at the default ambient', () => {
    // The default world must not spontaneously transform: ambient sits above
    // water's freezing point and below ice's melting point. A host that wants a
    // snowball planet lowers it deliberately.
    const water = Materials[MaterialType.WATER];
    const ice = Materials[MaterialType.ICE];
    expect(DEFAULT_AMBIENT_TEMPERATURE).toBeGreaterThan(water.freezesAt!);
    expect(DEFAULT_AMBIENT_TEMPERATURE).toBeLessThan(ice.meltsAt!);
    expect(DEFAULT_AMBIENT_TEMPERATURE).toBeLessThan(water.meltsAt!);
  });
});
