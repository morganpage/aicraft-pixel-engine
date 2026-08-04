import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../sand';
import { MaterialType } from '../materials';
import { FlatGravity } from '../gravity';

function flat(w: number, h: number, seed = 42): PixelEngine {
  return new PixelEngine({ width: w, height: h, seed, gravity: new FlatGravity(), enableHeat: true });
}

describe('fragmentation: ballistic tephra production', () => {
  // An airborne LAVA cell with velocity below `fragmentsAt` becomes TEPHRA.
  // This is the cone-building rule: pressure-launched bombs that cool during
  // their arc fragment into granular tephra rather than landing as ponded ROCK.
  //
  // The cell has velocity, so the velocity pass moves it before the heat step.
  // We check that TEPHRA appears somewhere in the grid after the update — the
  // cell fragmented during or after its ballistic move.
  it('airborne LAVA with velocity below fragmentsAt becomes TEPHRA', () => {
    const e = flat(8, 12);
    for (let x = 0; x < 8; x++) e.setMaterial(x, 11, MaterialType.WALL);
    e.setMaterial(4, 4, MaterialType.LAVA);
    e.setHeat(4, 4, 0.4); // below fragmentsAt (0.65)
    e.setVelocity(4, 4, 0, 8); // has velocity — ballistic
    e.update();
    // The cell fragmented to TEPHRA somewhere in the grid.
    let saw = false;
    for (let i = 0; i < e.grid.length; i++) if (e.grid[i] === MaterialType.TEPHRA) saw = true;
    expect(saw).toBe(true);
  });

  // Airborne LAVA above `fragmentsAt` stays LAVA — it hasn't cooled enough to
  // fragment. The bomb is still molten and will either continue its arc or land
  // and freeze to ROCK.
  it('airborne LAVA above fragmentsAt stays LAVA', () => {
    const e = flat(8, 12);
    for (let x = 0; x < 8; x++) e.setMaterial(x, 11, MaterialType.WALL);
    e.setMaterial(4, 4, MaterialType.LAVA);
    e.setHeat(4, 4, 0.8); // above fragmentsAt (0.65), with margin for one frame of cooling
    e.setVelocity(4, 4, 0, 8);
    e.update();
    // No TEPHRA was produced.
    let saw = false;
    for (let i = 0; i < e.grid.length; i++) if (e.grid[i] === MaterialType.TEPHRA) saw = true;
    expect(saw).toBe(false);
    // And lava still exists.
    let lava = false;
    for (let i = 0; i < e.grid.length; i++) if (e.grid[i] === MaterialType.LAVA) lava = true;
    expect(lava).toBe(true);
  });

  // Grounded LAVA below `freezesAt` still becomes ROCK — fragmentation does not
  // affect cells resting on a surface. This is what keeps a landed flow from
  // turning into a sand pile: ponded lava sets to rock, not tephra.
  it('grounded LAVA below freezesAt becomes ROCK, not TEPHRA', () => {
    const e = flat(8, 8);
    for (let x = 0; x < 8; x++) e.setMaterial(x, 7, MaterialType.WALL);
    e.setMaterial(4, 6, MaterialType.LAVA); // resting on WALL
    e.setHeat(4, 6, 0.25); // below freezesAt (0.30)
    e.update();
    expect(e.getMaterial(4, 6)).toBe(MaterialType.ROCK);
  });

  // Fragmentation requires velocity. A host-placed airborne LAVA cell (no
  // velocity) does NOT fragment, even if below `fragmentsAt`. This is what
  // preserves crater shapes built by host-placed plume ejecta.
  it('airborne LAVA without velocity does not fragment', () => {
    const e = flat(8, 12);
    for (let x = 0; x < 8; x++) e.setMaterial(x, 11, MaterialType.WALL);
    e.setMaterial(4, 4, MaterialType.LAVA);
    e.setHeat(4, 4, 0.4); // below fragmentsAt
    // No velocity — not a ballistic parcel.
    e.update();
    // No TEPHRA produced — the cell stays LAVA (airborne-freeze guard prevents
    // ROCK, no velocity gate prevents fragmentation).
    let saw = false;
    for (let i = 0; i < e.grid.length; i++) if (e.grid[i] === MaterialType.TEPHRA) saw = true;
    expect(saw).toBe(false);
  });

  // A pressure-launched lava cell fragments during a multi-frame ballistic arc.
  // This is the end-to-end integration: the pressure source routes to the vent,
  // the surplus launches the cell with velocity (Torricelli), and the cell
  // cools during flight until it fragments to TEPHRA.
  it('a pressure-launched lava cell fragments during flight', () => {
    const w = 5, h = 28;
    const e = new PixelEngine({ width: w, height: h, seed: 1, gravity: new FlatGravity(), enableHeat: true });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    // A conduit starting lower so there's headroom above the vent for the arc.
    for (let y = 8; y <= 22; y++) e.setMaterial(2, y, MaterialType.LAVA);
    for (let y = 23; y <= 25; y++) for (let x = 1; x <= 3; x++) e.setMaterial(x, y, MaterialType.LAVA);
    // Clear the sky above the vent so the fountain has room to fly.
    for (let y = 0; y <= 7; y++) e.setMaterial(2, y, MaterialType.EMPTY);
    // High-pressure source for a fountain.
    e.addPressureSource({
      x: 2, y: 23, material: MaterialType.LAVA,
      rate: 1, pressureRate: 50, maxPressure: 80, maxPending: 3,
      temperature: 0.75,
    });
    // Track whether any TEPHRA appears from the fountain.
    let sawFragmentedSand = false;
    for (let f = 0; f < 100; f++) {
      e.update();
      for (let i = 0; i < e.grid.length; i++) {
        if (e.grid[i] === MaterialType.TEPHRA) { sawFragmentedSand = true; break; }
      }
      if (sawFragmentedSand) break;
    }
    expect(sawFragmentedSand).toBe(true);
  });

  // Momentum-preserving fragmentation: a LAVA cell that fragments in the heat
  // step retains its velocity. The TEPHRA fragment appears in velCells and
  // moves on the next frame's velocity pass. This is the root-cause fix for the
  // "no visible tephra" bug — previously setMaterial zeroed velocity, so the
  // fragment was stationary and never flew.
  it('a fragment retains velocity after phase change and moves next frame', () => {
    const e = flat(10, 16);
    for (let x = 0; x < 10; x++) e.setMaterial(x, 15, MaterialType.WALL);
    // Place an airborne lava cell with velocity, cooled below fragmentsAt.
    e.setMaterial(5, 8, MaterialType.LAVA);
    e.setHeat(5, 8, 0.4); // below fragmentsAt (0.65)
    e.setVelocity(5, 8, 0, -32); // upward velocity
    // Frame 1: the heat step fragments LAVA→TEPHRA. The fix preserves velocity.
    e.update();
    // Find the TEPHRA cell — it should still have velocity.
    let sandIdx = -1;
    for (let i = 0; i < e.grid.length; i++) {
      if (e.grid[i] === MaterialType.TEPHRA) { sandIdx = i; break; }
    }
    expect(sandIdx).toBeGreaterThanOrEqual(0);
    const sx = sandIdx % 10, sy = Math.floor(sandIdx / 10);
    const v = e.getVelocity(sx, sy);
    expect(v.vy).not.toBe(0); // velocity survived the phase change
    expect(e.velCells.has(sandIdx)).toBe(true); // still in the active set
    // Frame 2: the TEPHRA fragment moves along its inherited velocity.
    const yBefore = sy;
    e.update();
    let sandIdx2 = -1;
    for (let i = 0; i < e.grid.length; i++) {
      if (e.grid[i] === MaterialType.TEPHRA) { sandIdx2 = i; break; }
    }
    expect(sandIdx2).toBeGreaterThanOrEqual(0);
    const sy2 = Math.floor(sandIdx2 / 10);
    expect(sy2).not.toBe(yBefore); // the fragment moved
  });
});
