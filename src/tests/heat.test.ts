import { describe, it, expect } from 'vitest';
import { PixelEngine, DEFAULT_AMBIENT_TEMPERATURE, HEAT_EPSILON } from '../sand';
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
  // Heat now evolves, so these cannot assert a carried value survives
  // unchanged. They assert the *difference* travels: two worlds identical
  // except for one cell's starting temperature must still differ wherever that
  // cell ended up, and agree where it never was.

  it('carries heat with a falling cell rather than leaving it behind', () => {
    const drop = (t: number): PixelEngine => {
      const e = floored(20, 24, { heat: true });
      e.setMaterial(10, 2, MaterialType.SAND);
      e.setHeat(10, 2, t);
      for (let i = 0; i < 8; i++) e.update();
      return e;
    };
    const hot = drop(0.95);
    const cool = drop(f32(DEFAULT_AMBIENT_TEMPERATURE));

    let y = -1;
    for (let j = 0; j < 24; j++) if (hot.getMaterial(10, j) === MaterialType.SAND) y = j;
    expect(y).toBeGreaterThan(2); // it moved
    expect(cool.getMaterial(10, y)).toBe(MaterialType.SAND); // identically in both

    // The heat went with it, and did not stay at the origin.
    expect(hot.getHeat(10, y)).toBeGreaterThan(cool.getHeat(10, y) + 0.3);
    expect(hot.getHeat(10, 2)).toBeCloseTo(cool.getHeat(10, 2), 4);
  });

  it('carries heat through a levelling transfer, not just a swap', () => {
    // Levelling moves a cell non-locally by writing grid directly instead of
    // calling swap(), so it needs its own heat carry. A column of water that
    // levels sideways must take its temperature along the transfer.
    const run = (t: number): PixelEngine => {
      const e = floored(40, 24, { heat: true });
      for (let y = 12; y < 23; y++) e.setMaterial(20, y, MaterialType.WATER);
      for (let y = 12; y < 23; y++) e.setHeat(20, y, t);
      for (let i = 0; i < 40; i++) e.update();
      return e;
    };
    const hot = run(0.65);
    const cool = run(f32(DEFAULT_AMBIENT_TEMPERATURE));

    // Sample water that can only have arrived where it is by levelling --
    // several cells lateral of the original column.
    let compared = 0;
    for (let x = 0; x < 40; x++) {
      if (Math.abs(x - 20) < 3) continue;
      for (let y = 0; y < 23; y++) {
        if (hot.getMaterial(x, y) !== MaterialType.WATER) continue;
        expect(cool.getMaterial(x, y)).toBe(MaterialType.WATER);
        expect(hot.getHeat(x, y)).toBeGreaterThan(cool.getHeat(x, y) + 0.05);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(3); // the sample is not vacuous
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

describe('heat step — conduction', () => {
  /**
   * A sealed block of one material, with ambient set to the block's own mean.
   *
   * Environment exchange is not conservative in general — the environment is an
   * infinite reservoir — so a conservation test has to neutralise it. With every
   * cell the same material and equally unexposed, each exchanges toward ambient
   * with the same coefficient, so setting ambient to the mean makes the sum
   * exactly neutral and leaves conduction as the only term moving heat.
   */
  function sealed(size: number, hot: number, cold: number): PixelEngine {
    const mean = (hot + cold) / 2;
    const e = new PixelEngine({
      width: size, height: size, seed: 1, gravity: new FlatGravity(),
      enableHeat: true, ambientTemperature: mean,
    });
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        e.setMaterial(x, y, MaterialType.ROCK); // static, and never exposed
        e.setHeat(x, y, x < size / 2 ? hot : cold);
      }
    }
    return e;
  }

  const total = (e: PixelEngine): number => {
    let s = 0;
    for (let i = 0; i < e.heatGrid!.length; i++) s += e.heatGrid![i];
    return s;
  };

  it('conserves heat exactly, up to the settling epsilon', () => {
    // Conservation comes from *edge symmetry*: each edge is visited exactly
    // once and both endpoints are updated by the same amount with opposite
    // signs. Any coefficient both endpoints agree on conserves equally well --
    // min, max, the harmonic mean, or a constant. What would break it is
    // computing flux per-cell over all four neighbours, where the two ends of
    // an edge disagree about how much crossed it.
    const e = sealed(16, 0.8, 0.2);
    const before = total(e);
    for (let i = 0; i < 100; i++) e.update();
    // Tolerance is the documented epsilon bias, not float epsilon: sub-epsilon
    // increments are deliberately discarded so chunks can sleep.
    expect(Math.abs(total(e) - before)).toBeLessThan(HEAT_EPSILON * e.heatGrid!.length);
  });

  it('conducts at a rate independent of which cell owns the edge', () => {
    // What min() actually buys -- and it is not conservation, which edge
    // symmetry already guarantees however the coefficient is chosen. It is
    // that the edge's conductance cannot depend on which endpoint the loop
    // happens to visit first. Reading conductivity from the owning cell alone
    // makes a ROCK|WATER seam conduct at 0.2 or at 0.9 depending purely on
    // which side is to the left, so the physics would follow grid orientation.
    //
    // min() also models the bottleneck: a good insulator throttles the pair.
    // The physically exact choice is the harmonic mean, which is likewise
    // symmetric and drops in unchanged.
    const rise = (waterFirst: boolean): number => {
      const e = sealed(16, 0.5, 0.5);
      const wx = waterFirst ? 7 : 8;
      const rx = waterFirst ? 8 : 7;
      e.setMaterial(wx, 8, MaterialType.WATER); // cannot move: denser rock all round
      e.setHeat(wx, 8, 0.1);
      e.setHeat(rx, 8, 0.9);
      e.update();
      return e.getHeat(wx, 8) - 0.1;
    };
    const ownedByRock = rise(false);
    const ownedByWater = rise(true);
    expect(ownedByRock).toBeGreaterThan(0.01);          // it did exchange
    expect(ownedByWater).toBeCloseTo(ownedByRock, 6);   // ...at the same rate
  });

  it('actually moves heat while conserving it', () => {
    // Guards the test above from passing on an implementation that does nothing.
    const e = sealed(16, 0.8, 0.2);
    for (let i = 0; i < 100; i++) e.update();
    expect(e.getHeat(0, 8)).toBeLessThan(0.8 - 0.05);
    expect(e.getHeat(15, 8)).toBeGreaterThan(0.2 + 0.05);
  });

  it('obeys the max principle on a worst-case stencil', () => {
    // The bound that CONDUCTION_MAX exists to hold. Using conductivity applied
    // directly as the per-neighbour fraction, a cell at 1.0 with four
    // neighbours at 0.0 would move 4x its own difference out in one step and
    // land far below zero, flipping sign every step after.
    const e = new PixelEngine({
      width: 9, height: 9, seed: 1, gravity: new FlatGravity(),
      enableHeat: true, ambientTemperature: 0.5,
    });
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        e.setMaterial(x, y, MaterialType.WATER); // the highest conductivity
        e.setHeat(x, y, 0);
      }
    }
    e.setHeat(4, 4, 1);
    for (let i = 0; i < 50; i++) {
      e.update();
      for (let j = 0; j < e.heatGrid!.length; j++) {
        expect(e.heatGrid![j]).toBeGreaterThanOrEqual(0);
        expect(e.heatGrid![j]).toBeLessThanOrEqual(1);
      }
    }
    // And it converged rather than oscillating: the centre never rebounds above
    // where it started.
    expect(e.getHeat(4, 4)).toBeLessThan(1);
  });

  it('is bounded in space — heat does not teleport across the grid', () => {
    // The cap is what stops a single hot cell flash-heating the world.
    const e = sealed(16, 0.5, 0.5);
    e.setHeat(8, 8, 1);
    const far = e.getHeat(8, 11);
    e.update();
    expect(e.getHeat(8, 9)).toBeGreaterThan(0.5); // immediate neighbour warmed
    expect(e.getHeat(8, 11)).toBeCloseTo(far, 6); // three away did not
  });

  it('does not conduct into non-thermal materials', () => {
    // OIL sets no thermal field, so it must neither gain nor lose heat.
    const e = sealed(16, 0.5, 0.5);
    e.setMaterial(8, 8, MaterialType.OIL);
    e.setHeat(8, 8, 0.9);
    e.setHeat(7, 8, 0.1);
    for (let i = 0; i < 30; i++) e.update();
    expect(e.getHeat(8, 8)).toBeCloseTo(0.9, 5); // untouched by the step
  });
});

describe('heat step — environment exchange', () => {
  it('cools an exposed cell faster than a buried one', () => {
    // The term conduction cannot express, and the one that carries the
    // behaviour: a flow's skin chills ahead of its core and its front stalls
    // first. Under conduction alone an exposed cell has nobody to conduct into
    // and would cool *slower* than a buried one -- exactly backwards.
    const build = (bury: boolean): PixelEngine => {
      const e = floored(24, 24, { heat: true });
      if (bury) {
        for (let y = 18; y <= 22; y++) {
          for (let x = 8; x <= 12; x++) e.setMaterial(x, y, MaterialType.ROCK);
        }
      }
      e.setMaterial(10, 20, MaterialType.LAVA);
      e.setHeat(10, 20, 1);
      return e;
    };
    const exposed = build(false);
    const buried = build(true);
    for (let i = 0; i < 20; i++) { exposed.update(); buried.update(); }

    let ex = -1;
    for (let y = 0; y < 24; y++) if (exposed.getMaterial(10, y) === MaterialType.LAVA) ex = y;
    expect(exposed.getHeat(10, ex)).toBeLessThan(buried.getHeat(10, 20));
  });

  it('cools toward ambient rather than toward zero', () => {
    const e = new PixelEngine({
      width: 12, height: 12, seed: 1, gravity: new FlatGravity(),
      enableHeat: true, ambientTemperature: 0.4,
    });
    e.setMaterial(6, 6, MaterialType.SAND);
    e.setHeat(6, 6, 1);
    for (let i = 0; i < 400; i++) e.update();
    expect(e.getHeat(6, 6)).toBeCloseTo(0.4, 2);
  });

  it('makes ambient a climate dial that freezes an ocean', () => {
    // Turning the world's temperature down has to be enough on its own; this
    // is the whole point of ambient being a world constant rather than a
    // per-material one. Phase change is not wired up yet, so this asserts the
    // water actually reaches ICE's melting point.
    const cold = new PixelEngine({
      width: 24, height: 24, seed: 1, gravity: new FlatGravity(),
      enableHeat: true, ambientTemperature: 0.02,
    });
    const temperate = new PixelEngine({
      width: 24, height: 24, seed: 1, gravity: new FlatGravity(),
      enableHeat: true, // default ambient
    });
    for (const e of [cold, temperate]) {
      for (let x = 0; x < 24; x++) e.setMaterial(x, 23, MaterialType.WALL);
      for (let x = 4; x < 20; x++) e.setMaterial(x, 22, MaterialType.WATER);
      for (let i = 0; i < 400; i++) e.update();
    }
    // The threshold that governs water turning to ice is water's own freezing
    // point, not ice's melting point. The default ambient sits deliberately
    // between the two -- above WATER.freezesAt and below ICE.meltsAt -- which
    // is what makes both phases stable on an untouched world.
    const freezing = Materials[MaterialType.WATER].freezesAt!;
    expect(cold.getHeat(12, 22)).toBeLessThan(freezing);
    expect(temperate.getHeat(12, 22)).toBeGreaterThan(freezing);
    expect(temperate.getHeat(12, 22)).toBeLessThan(Materials[MaterialType.ICE].meltsAt!);
  });
});

describe('heat step — heat sources', () => {
  it('conducts as a source and is held, rather than sitting inert', () => {
    // "Held" is not "skipped". A source is read at full strength by the
    // conduction pass -- so neighbours draw from it -- and only then pinned
    // back to its own temperature. An implementation that excluded sources
    // from conduction would give a fire nothing can warm itself against.
    const e = floored(16, 16, { heat: true });
    // Wall it in so the gas cannot rise away from its neighbour.
    for (let y = 9; y <= 13; y++) {
      for (let x = 6; x <= 10; x++) e.setMaterial(x, y, MaterialType.WALL);
    }
    e.setMaterial(8, 11, MaterialType.FIRE);
    e.setHeat(7, 11, 0);
    const before = e.getHeat(7, 11);
    e.update();
    expect(e.getMaterial(8, 11)).toBe(MaterialType.FIRE); // survived the frame
    expect(e.getHeat(7, 11)).toBeGreaterThan(before);     // it conducted
    expect(e.getHeat(8, 11)).toBe(Materials[MaterialType.FIRE].spawnTemp); // and was held
  });

  it('cannot drive a neighbour above its own temperature', () => {
    // Conduction moves a fraction of the *difference*, so a neighbour
    // approaches a source asymptotically and never crosses it. Any threshold
    // set above a source's temperature is unreachable by that source -- the
    // constraint that decides whether a phase threshold is reachable at all.
    const e = floored(16, 16, { heat: true });
    for (let y = 9; y <= 13; y++) {
      for (let x = 6; x <= 10; x++) e.setMaterial(x, y, MaterialType.WALL);
    }
    e.setMaterial(8, 11, MaterialType.FIRE);
    const src = Materials[MaterialType.FIRE].spawnTemp!;
    for (let i = 0; i < 200; i++) {
      e.update();
      for (let j = 0; j < e.heatGrid!.length; j++) {
        expect(e.heatGrid![j]).toBeLessThanOrEqual(src);
      }
    }
  });
});

describe('heat step — settling', () => {
  it('settles a body that spans several chunks, and stops waking them', () => {
    // Regression: an active chunk used to wake its sleeping neighbours
    // unconditionally whenever an edge crossed the seam, with no regard for
    // whether there was any gradient to move. Neighbours then re-woke each
    // other indefinitely, so a world where *not one cell was still changing*
    // never went quiet -- measured at ~0.09ms/frame forever against ~0.0006ms
    // once fixed, on a world that was otherwise completely dead.
    //
    // The geometry matters: this needs a body straddling enough chunk seams
    // that some chunks quiesce while their neighbours are still working. At
    // 96 wide it settles either way and catches nothing; 128 reproduces it.
    const N = 128;
    const top = N - 41;
    const e = new PixelEngine({
      width: N, height: N, seed: 1, gravity: new FlatGravity(), enableHeat: true,
    });
    for (let x = 0; x < N; x++) e.setMaterial(x, N - 1, MaterialType.WALL);
    for (let y = top + 1; y < N - 1; y++) {
      for (let x = 40; x < N - 40; x++) e.setMaterial(x, y, MaterialType.ROCK);
    }
    for (let x = N / 2 - 20; x < N / 2 + 20; x++) {
      e.setMaterial(x, top, MaterialType.LAVA);
      e.setHeat(x, top, 1);
    }

    let settledAt = -1;
    for (let i = 0; i < 2000; i++) {
      e.update();
      if (e.activeThermalChunkCount === 0) { settledAt = i; break; }
    }
    expect(settledAt).toBeGreaterThan(0);

    for (let i = 0; i < 100; i++) e.update();
    expect(e.activeThermalChunkCount).toBe(0);
  });

  it('reaches a thermal dead stop and stays there', () => {
    // The settle guarantee, and the reason HEAT_EPSILON exists. Diffusion
    // asymptotes but never arrives in floating point, so without the epsilon
    // every chunk stays awake and render-dirty forever. Note this is asserted
    // on thermal chunks, not swapsLastFrame -- heat moves without swapping
    // anything, so a swap count says nothing about whether it has settled.
    const e = floored(64, 64, { heat: true });
    for (let x = 20; x < 30; x++) e.setMaterial(x, 62, MaterialType.SAND);
    for (let x = 20; x < 30; x++) e.setHeat(x, 62, 1);

    let settledAt = -1;
    for (let i = 0; i < 1500; i++) {
      e.update();
      if (e.activeThermalChunkCount === 0) { settledAt = i; break; }
    }
    expect(settledAt).toBeGreaterThan(0);

    // And it stays settled: no chunk re-wakes, and nothing is re-rendered.
    e.consumeRenderDirtyChunks();
    for (let i = 0; i < 50; i++) e.update();
    expect(e.activeThermalChunkCount).toBe(0);
    expect(e.swapsLastFrame).toBe(0);
    expect(Array.from(e.consumeRenderDirtyChunks()).some((v) => v)).toBe(false);
  });
});
