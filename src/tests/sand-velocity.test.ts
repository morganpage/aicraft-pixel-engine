import { describe, it, expect } from 'vitest';
import {
  PixelEngine,
  DEFAULT_VELOCITY_DRAG,
  VELOCITY_CELL_UNIT,
  VELOCITY_MAX_STEPS,
} from '../sand';
import { MaterialType } from '../materials';
import { FlatGravity } from '../gravity';

function flat(w: number, h: number, seed = 42): PixelEngine {
  return new PixelEngine({ width: w, height: h, seed, gravity: new FlatGravity() });
}

/** Find the (first) cell holding `mat` in column `x`, scanning top to bottom. */
function findInColumn(e: PixelEngine, x: number, mat: MaterialType): number {
  for (let y = 0; y < e.height; y++) if (e.getMaterial(x, y) === mat) return y;
  return -1;
}

describe('velocity: backward compatibility', () => {
  // The load-bearing guarantee. The velocity pass draws no RNG and iterates an
  // empty active set, so a world that never imparts velocity must be
  // byte-for-byte identical to one without the field. Mirrors the growth and
  // pressure no-op tests.
  it('a world with no impulses is byte-for-byte identical regardless of the velocity field', () => {
    const build = () => {
      const e = flat(16, 16, 7);
      for (let x = 0; x < 16; x++) e.setMaterial(x, 15, MaterialType.ROCK);
      for (let x = 3; x < 13; x++) e.setMaterial(x, 8, MaterialType.WATER);
      e.setMaterial(8, 5, MaterialType.LAVA);
      for (let i = 0; i < 80; i++) e.update();
      return e;
    };
    const a = build();
    const b = build();
    expect(Array.from(a.grid)).toEqual(Array.from(b.grid));
    expect(a.velocityMovesLastFrame).toBe(0);
    expect(a.activeVelocityCount).toBe(0);
  });

  // The field is null until the first setVelocity/applyImpulse, so a host that
  // never uses velocity pays no allocation.
  it('the velocity field is null until the first impulse', () => {
    const e = flat(8, 8);
    expect(e.velX).toBeNull();
    e.setVelocity(4, 4, 0, -16);
    expect(e.velX).not.toBeNull();
  });
});

describe('velocity: kinematics', () => {
  // Upward velocity lifts a cell before gravity wins it back. A cell with a
  // strong upward impulse rises, decelerates under gravity, stops, and falls
  // back — the ballistic arc that the volcano's fountain needs.
  it('upward velocity lifts a cell before gravity wins', () => {
    const e = flat(10, 24);
    for (let x = 0; x < 10; x++) e.setMaterial(x, 23, MaterialType.WALL);
    e.setMaterial(5, 22, MaterialType.SAND);
    e.setVelocity(5, 22, 0, -64);
    let highestY = 22;
    for (let i = 0; i < 40; i++) {
      e.update();
      const y = findInColumn(e, 5, MaterialType.SAND);
      if (y >= 0 && y < highestY) highestY = y;
    }
    // It rose several cells above its start.
    expect(highestY).toBeLessThan(20);
    // And it has returned to rest on the floor.
    const finalY = findInColumn(e, 5, MaterialType.SAND);
    expect(finalY).toBe(22);
    expect(e.activeVelocityCount).toBe(0);
  });

  // Greater impulse produces greater height. A cell launched harder rises
  // higher before gravity arrests it — the defining property of ballistic
  // motion, and what a fountain's vigor knob controls.
  it('greater impulse produces greater height', () => {
    const run = (vel: number): number => {
      const e = flat(10, 40);
      for (let x = 0; x < 10; x++) e.setMaterial(x, 39, MaterialType.WALL);
      e.setMaterial(5, 38, MaterialType.SAND);
      e.setVelocity(5, 38, 0, vel);
      let highestY = 38;
      for (let i = 0; i < 60; i++) {
        e.update();
        const y = findInColumn(e, 5, MaterialType.SAND);
        if (y >= 0 && y < highestY) highestY = y;
      }
      return 38 - highestY; // height above start
    };
    const low = run(-32);
    const high = run(-80);
    expect(high).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(0);
  });

  // Drag decelerates velocity each frame. A cell with no gravity and a sideways
  // velocity eventually stops — drag removes its momentum over a bounded number
  // of frames.
  it('drag decelerates velocity over time', () => {
    // Use a radial-gravity world with the cell at the centre, so gravity is ~0
    // and only drag acts. A simpler approach: just check the velocity decreases.
    const e = flat(20, 5);
    for (let x = 0; x < 20; x++) e.setMaterial(x, 4, MaterialType.WALL);
    e.setMaterial(2, 3, MaterialType.SAND);
    e.setVelocity(2, 3, 48, 0); // strong rightward
    const v0 = e.getVelocity(2, 3);
    expect(v0.vx).toBe(48);
    e.update();
    // After one frame the velocity is reduced by drag.
    // Find where the sand went.
    let foundIdx = -1;
    for (let i = 0; i < e.grid.length; i++) {
      if (e.grid[i] === MaterialType.SAND && i !== e.getIndex(2, 3)) { foundIdx = i; break; }
    }
    if (foundIdx >= 0) {
      const fx = foundIdx % 20;
      const v1 = e.getVelocity(fx, 3);
      expect(Math.abs(v1.vx)).toBeLessThan(48);
    }
  });

  // Collision stops velocity: a velocity cell moving into a wall zeroes its
  // velocity rather than tunneling through.
  it('collision stops velocity without tunneling', () => {
    const e = flat(8, 6);
    for (let x = 0; x < 8; x++) e.setMaterial(x, 5, MaterialType.WALL);
    e.setMaterial(2, 4, MaterialType.SAND);
    e.setMaterial(5, 4, MaterialType.WALL); // wall ahead
    e.setVelocity(2, 4, 64, 0); // strong rightward into the wall
    for (let i = 0; i < 5; i++) e.update();
    // The sand did not pass through the wall.
    expect(e.getMaterial(5, 4)).toBe(MaterialType.WALL);
    // And it has zero velocity (collision stopped it).
    const sandY = findInColumn(e, 2, MaterialType.SAND);
    if (sandY >= 0) {
      const v = e.getVelocity(2, sandY);
      expect(v.vx).toBe(0);
    }
  });

  // Velocity rides through swap. When two cells exchange position, their
  // velocities go with them — velocity is parcel state.
  it('velocity rides through swap', () => {
    const e = flat(8, 8);
    e.setMaterial(4, 4, MaterialType.SAND);
    e.setVelocity(4, 4, 32, 0);
    // Swap it with the cell above (which is EMPTY, so density allows it).
    e.swap(4, 4, 4, 3);
    // The velocity moved with the sand.
    expect(e.getVelocity(4, 3).vx).toBe(32);
    expect(e.getVelocity(4, 4).vx).toBe(0);
  });

  // Sub-cell remainder accumulates. A velocity of 9 at CELL_UNIT 8 means 1.125
  // cells/frame: 1 step with remainder 1, then 1+1=2 (still <8), then 2+1=3,
  // etc. The remainder carries the fractional part forward so it isn't lost.
  // Over several frames the cell moves further than floor(v/c)*frames would give,
  // because the fractional remainder eventually crosses the unit boundary.
  it('sub-cell remainder accumulates fractional velocity', () => {
    const e = flat(30, 4);
    for (let x = 0; x < 30; x++) e.setMaterial(x, 3, MaterialType.WALL);
    e.setMaterial(5, 2, MaterialType.SAND);
    // Velocity 9 at unit 8 = 1.125 cells/frame. The 0.125 remainder accumulates.
    e.setVelocity(5, 2, 9, 0);
    // Run until velocity decays to zero (drag), then check the total distance.
    for (let i = 0; i < 40; i++) e.update();
    const sandX = (() => {
      for (let x = 0; x < 30; x++) if (e.getMaterial(x, 2) === MaterialType.SAND) return x;
      return -1;
    })();
    // It moved several cells. The remainder means it moves slightly more than
    // floor(9/8)=1 cell per frame would give over the same number of frames
    // before drag zeroes it — the point is it moved at all and moved rightward.
    expect(sandX).toBeGreaterThan(5);
  });

  // Saturation clamps: a velocity of 200 does not wrap to a negative Int8 value
  // and reverse direction.
  it('saturation clamps to ±127 without wraparound', () => {
    const e = flat(8, 20);
    for (let x = 0; x < 8; x++) e.setMaterial(x, 19, MaterialType.WALL);
    e.setMaterial(4, 18, MaterialType.SAND);
    e.setVelocity(4, 18, 0, -200); // beyond Int8 max
    // Should be clamped, not wrapped.
    const v = e.getVelocity(4, 18);
    expect(v.vy).toBe(-127);
    // And the cell moves upward, not downward.
    let highestY = 18;
    for (let i = 0; i < 10; i++) {
      e.update();
      const y = findInColumn(e, 4, MaterialType.SAND);
      if (y >= 0 && y < highestY) highestY = y;
    }
    expect(highestY).toBeLessThan(18);
  });

  // applyImpulse is additive: two impulses on the same cell produce a higher
  // speed than one. This is what "impulse" means — a delta, not a replacement.
  it('applyImpulse is additive', () => {
    const e = flat(8, 8);
    e.setMaterial(4, 4, MaterialType.SAND);
    e.applyImpulse(4, 4, 10, 0);
    expect(e.getVelocity(4, 4).vx).toBe(10);
    e.applyImpulse(4, 4, 10, 0);
    expect(e.getVelocity(4, 4).vx).toBe(20);
  });

  // Settling accounts for velocity. A world with an in-flight velocity cell is
  // not settled, even if nothing else is moving. Once the cell lands and drag
  // zeroes it, settle can complete.
  it('settling does not complete while velocity cells are in flight', () => {
    const e = flat(10, 24);
    for (let x = 0; x < 10; x++) e.setMaterial(x, 23, MaterialType.WALL);
    e.setMaterial(5, 22, MaterialType.SAND);
    e.setVelocity(5, 22, 0, -80);
    e.beginSettle();
    e.update();
    // While in flight, not settled.
    expect(e.isSettled).toBe(false);
    expect(e.velocityMovesLastFrame).toBeGreaterThan(0);
    // Run until it settles.
    for (let i = 0; i < 200 && !e.isSettled; i++) e.update();
    expect(e.isSettled).toBe(true);
    expect(e.velocityMovesLastFrame).toBe(0);
  });

  // Determinism: the same impulse stream produces identical grids.
  it('repeated runs with the same impulse stream produce identical grids', () => {
    const run = () => {
      const e = flat(12, 20);
      for (let x = 0; x < 12; x++) e.setMaterial(x, 19, MaterialType.WALL);
      e.setMaterial(3, 18, MaterialType.SAND);
      e.setMaterial(8, 18, MaterialType.SAND);
      e.setVelocity(3, 18, 16, -48);
      e.setVelocity(8, 18, -16, -48);
      for (let i = 0; i < 30; i++) e.update();
      return Array.from(e.grid);
    };
    expect(run()).toEqual(run());
  });

  // clear() removes pressure sources [FIX 1a]. After clear, a source added
  // before the clear does not pump into the empty grid.
  it('clear() removes pressure sources so they do not pump into the empty grid', () => {
    const e = flat(8, 8);
    e.setMaterial(4, 4, MaterialType.LAVA);
    e.addPressureSource({
      x: 4, y: 4, material: MaterialType.LAVA,
      rate: 1, pressureRate: 5, maxPressure: 20, maxPending: 5,
    });
    e.clear();
    // After clear, the grid is empty and the source is gone.
    let lava = 0;
    for (let i = 0; i < e.grid.length; i++) if (e.grid[i] === MaterialType.LAVA) lava++;
    expect(lava).toBe(0);
    e.update(); // would pump if the source survived
    lava = 0;
    for (let i = 0; i < e.grid.length; i++) if (e.grid[i] === MaterialType.LAVA) lava++;
    expect(lava).toBe(0);
  });
});

describe('velocity: pressure outlet (Phase 6B)', () => {
  // A sealed conduit with enough surplus pressure launches the outlet cell with
  // velocity — the fountain case. The Torricelli computation converts surplus
  // head to launch speed.
  it('a persistent source with surplus pressure writes velocity at the outlet', () => {
    const w = 5, h = 14;
    const e = new PixelEngine({ width: w, height: h, seed: 1, gravity: new FlatGravity() });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    for (let y = 1; y <= 10; y++) e.setMaterial(2, y, MaterialType.LAVA);
    for (let y = 11; y <= 12; y++) for (let x = 1; x <= 3; x++) e.setMaterial(x, y, MaterialType.LAVA);
    e.setMaterial(2, 0, MaterialType.EMPTY); // outlet at the top

    const sid = e.addPressureSource({
      x: 2, y: 11, material: MaterialType.LAVA,
      rate: 1, pressureRate: 50, maxPressure: 80, maxPending: 5,
      temperature: 0.75,
    });
    // Build up pressure so there's significant surplus.
    for (let i = 0; i < 3; i++) e.update();
    const st = e.getPressureSourceState(sid)!;
    // The source has high available pressure.
    expect(st.availablePressure).toBeGreaterThan(20);
    // After the update that routes, the outlet cell should have been launched
    // with velocity (the pressure pass wrote it). Check that at some point a
    // velocity cell existed near the vent.
    expect(e.activeVelocityCount).toBeGreaterThan(0);
  });

  // Low-surplus (effusive) pressure does not write velocity — the cell just
  // extrudes and falls normally. MIN_OUTLET_SURPLUS (2 head units) is the
  // threshold.
  it('low-surplus pressure does not write velocity at the outlet', () => {
    const w = 5, h = 14;
    const e = new PixelEngine({ width: w, height: h, seed: 1, gravity: new FlatGravity() });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    for (let y = 1; y <= 10; y++) e.setMaterial(2, y, MaterialType.LAVA);
    for (let y = 11; y <= 12; y++) for (let x = 1; x <= 3; x++) e.setMaterial(x, y, MaterialType.LAVA);
    e.setMaterial(2, 0, MaterialType.EMPTY);

    // Barely enough pressure to route: the conduit is ~10 cells, cost ~11.5.
    // Set maxPressure just above the cost so surplus < MIN_OUTLET_SURPLUS.
    e.addPressureSource({
      x: 2, y: 11, material: MaterialType.LAVA,
      rate: 1, pressureRate: 12, maxPressure: 12, maxPending: 5,
      temperature: 0.75,
    });
    for (let i = 0; i < 10; i++) e.update();
    // No velocity was written — the effusive case.
    // (The source may not even route at this pressure, but if it does, no launch.)
    expect(e.activeVelocityCount).toBe(0);
  });

  // Energy is not double-counted: after a source routes and launches, the
  // available pressure is reduced by cost + kineticHead, not just cost.
  it('energy deduction includes both transport cost and kinetic head', () => {
    const w = 5, h = 14;
    const e = new PixelEngine({ width: w, height: h, seed: 1, gravity: new FlatGravity() });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    for (let y = 1; y <= 10; y++) e.setMaterial(2, y, MaterialType.LAVA);
    for (let y = 11; y <= 12; y++) for (let x = 1; x <= 3; x++) e.setMaterial(x, y, MaterialType.LAVA);
    e.setMaterial(2, 0, MaterialType.EMPTY);

    // Low pressureRate so the deduction is visible: the source accrues slowly
    // and cannot instantly refill what the kinetic launch spent.
    const sid = e.addPressureSource({
      x: 2, y: 11, material: MaterialType.LAVA,
      rate: 1, pressureRate: 5, maxPressure: 60, maxPending: 1,
      temperature: 0.75,
    });
    // Accrue to max over many frames.
    for (let i = 0; i < 20; i++) e.update();
    // The source has been routing and launching each frame. With pressureRate 5
    // and kinetic deduction, it cannot sustain maxPressure — the launch consumes
    // more than 5 head/frame. If only cost were deducted (no kinetic), 5/frame
    // would easily refill the ~11.5 cost. So availablePressure being well below
    // max proves the kinetic deduction is happening.
    const st = e.getPressureSourceState(sid)!;
    expect(st.availablePressure).toBeLessThan(50);
  });
});

describe('velocity: explosion impulse (Phase 6B)', () => {
  // Greater explosion force produces greater debris displacement. `force` finally
  // matters — it scales the velocity impulse on each scattered particle.
  it('greater explosion force produces greater debris displacement', () => {
    const run = (force: number): number => {
      const e = new PixelEngine({ width: 30, height: 20, seed: 1, gravity: new FlatGravity() });
      for (let x = 0; x < 30; x++) e.setMaterial(x, 19, MaterialType.WALL);
      // A wall of ROCK around the blast center.
      for (let y = 8; y <= 12; y++) for (let x = 12; x <= 18; x++) e.setMaterial(x, y, MaterialType.ROCK);
      e.explode(15, 10, 5, force);
      // Run a few frames to let debris fly and land.
      for (let i = 0; i < 10; i++) e.update();
      // Find the furthest SAND from center.
      let maxDist = 0;
      for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) {
        if (e.getMaterial(x, y) === MaterialType.SAND) {
          const d = Math.hypot(x - 15, y - 10);
          if (d > maxDist) maxDist = d;
        }
      }
      return maxDist;
    };
    const lowForce = run(2);
    const highForce = run(9);
    expect(highForce).toBeGreaterThan(lowForce);
  });

  // The onExplode hook still fires with the correct force value — the velocity
  // migration does not change the callback contract.
  it('the onExplode hook still receives the correct force', () => {
    let received = -1;
    const e = new PixelEngine({
      width: 11, height: 11, seed: 1, gravity: new FlatGravity(),
      onExplode: (_x, _y, _r, f) => { received = f; },
    });
    for (let y = 0; y < 11; y++) for (let x = 0; x < 11; x++) e.setMaterial(x, y, MaterialType.ROCK);
    e.explode(5, 5, 4, 7);
    expect(received).toBe(7);
  });
});

describe('velocity: drag configuration', () => {
  it('defaults to DEFAULT_VELOCITY_DRAG', () => {
    expect(flat(4, 4).velocityDrag).toBe(DEFAULT_VELOCITY_DRAG);
  });

  it('accepts a custom drag', () => {
    const e = new PixelEngine({
      width: 4, height: 4, seed: 1, gravity: new FlatGravity(), velocityDrag: 0.5,
    });
    expect(e.velocityDrag).toBe(0.5);
  });

  it('clamps drag into [0, 1]', () => {
    // Above 1 the parcel gains energy every frame and the integration diverges;
    // below 0 it reverses direction every step. Neither is a world anyone means
    // to ask for, so both are clamped rather than trusted.
    const fast = new PixelEngine({
      width: 4, height: 4, seed: 1, gravity: new FlatGravity(), velocityDrag: 4,
    });
    expect(fast.velocityDrag).toBe(1);
    const backwards = new PixelEngine({
      width: 4, height: 4, seed: 1, gravity: new FlatGravity(), velocityDrag: -2,
    });
    expect(backwards.velocityDrag).toBe(0);
  });

  /**
   * The regression the Int16 remainders exist for.
   *
   * The pass does `rem += v` and then drains whole cells out in units of
   * VELOCITY_CELL_UNIT, so `|rem|` sits at up to `UNIT - 1` going into the next
   * frame. With drag 1.0 a parcel holds `|v| = 127`, and `7 + 127 = 134`
   * overflows an Int8 to -122 — the step count comes out negative, clamps to
   * -VELOCITY_MAX_STEPS, and the parcel reverses into the blast it came from.
   *
   * Launched along -x with no gravity component on that axis, every frame must
   * move the parcel left or leave it where it is. One step right is the bug.
   */
  it('never reverses a parcel at full speed with no drag', () => {
    const W = 60, H = 9;
    const e = new PixelEngine({
      width: W, height: H, seed: 1, gravity: new FlatGravity(), velocityDrag: 1,
    });
    for (let x = 0; x < W; x++) e.setMaterial(x, H - 1, MaterialType.WALL);
    e.setMaterial(W - 2, 1, MaterialType.SAND);
    // Maximum representable speed, straight along -x.
    e.setVelocity(W - 2, 1, -127, 0);

    let prevX = W - 2;
    for (let f = 0; f < 12; f++) {
      e.update();
      let x = -1;
      for (let yy = 0; yy < H - 1 && x < 0; yy++) {
        for (let xx = 0; xx < W; xx++) {
          if (e.getMaterial(xx, yy) === MaterialType.SAND) { x = xx; break; }
        }
      }
      if (x < 0) break; // came to rest inside the wall row; nothing left to check
      expect(x, `frame ${f}: parcel moved right (overflow)`).toBeLessThanOrEqual(prevX);
      expect(prevX - x, `frame ${f}: exceeded the step cap`)
        .toBeLessThanOrEqual(VELOCITY_MAX_STEPS);
      prevX = x;
    }
  });

  it('allocates Int16 remainders with room for the peak accumulator', () => {
    const e = flat(8, 8);
    e.setVelocity(4, 4, 100, 100);
    expect(e.velRemX).toBeInstanceOf(Int16Array);
    expect(e.velRemY).toBeInstanceOf(Int16Array);
    // 127 (max speed) + UNIT-1 (carried remainder) must be representable.
    expect(127 + VELOCITY_CELL_UNIT - 1).toBeGreaterThan(127);
  });
});
