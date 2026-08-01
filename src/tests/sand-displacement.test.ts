import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../sand';
import { MaterialType } from '../materials';
import { FlatGravity } from '../gravity';

/**
 * Helpers for building a tiny engine and asserting per-cell state.
 * All displacement tests use FlatGravity (the default) so "down" = +Y.
 */
function makeEngine(w = 5, h = 6): PixelEngine {
  return new PixelEngine({ width: w, height: h, seed: 1, gravity: new FlatGravity() });
}

describe('canDisplace (density + flags)', () => {
  it('EMPTY always displaces', () => {
    const e = makeEngine();
    e.setMaterial(2, 2, MaterialType.SAND);
    expect(e.canDisplace(2, 2, 2, 3)).toBe(true); // sand -> empty below
  });

  it('WALL is never displacable', () => {
    const e = makeEngine();
    e.setMaterial(2, 2, MaterialType.SAND);
    e.setMaterial(2, 3, MaterialType.WALL);
    expect(e.canDisplace(2, 2, 2, 3)).toBe(false);
  });

  it('out-of-bounds targets are not displacable', () => {
    const e = makeEngine();
    e.setMaterial(0, 5, MaterialType.SAND);
    expect(e.canDisplace(0, 5, 0, 6)).toBe(false); // below grid
  });

  it('denser material displaces lighter; lighter cannot displace denser', () => {
    const e = makeEngine();
    // Sand (density 10) over water (density 5): sand displaces water.
    e.setMaterial(2, 2, MaterialType.SAND);
    e.setMaterial(2, 3, MaterialType.WATER);
    expect(e.canDisplace(2, 2, 2, 3)).toBe(true);
    // Water below sand: water cannot displace sand above it (moving up).
    expect(e.canDisplace(2, 3, 2, 2)).toBe(false);
  });

  it('equal-density materials do not displace each other', () => {
    const e = makeEngine();
    e.setMaterial(2, 2, MaterialType.WATER); // density 5
    e.setMaterial(2, 3, MaterialType.ICE); // density 5 (solid)
    expect(e.canDisplace(2, 2, 2, 3)).toBe(false);
  });
});

describe('falling under flat gravity', () => {
  it('sand falls one cell per frame into empty space', () => {
    const e = makeEngine(3, 6);
    e.setMaterial(1, 0, MaterialType.SAND);
    e.update();
    expect(e.getMaterial(1, 0)).toBe(MaterialType.EMPTY);
    expect(e.getMaterial(1, 1)).toBe(MaterialType.SAND);
  });

  it('sand piles on a wall floor', () => {
    const e = makeEngine(3, 6);
    // floor row
    for (let x = 0; x < 3; x++) e.setMaterial(x, 5, MaterialType.WALL);
    e.setMaterial(1, 0, MaterialType.SAND);
    for (let i = 0; i < 10; i++) e.update();
    expect(e.getMaterial(1, 4)).toBe(MaterialType.SAND);
    expect(e.getMaterial(1, 5)).toBe(MaterialType.WALL);
  });

  it('sand falls diagonally around an obstacle', () => {
    const e = makeEngine(3, 6);
    for (let x = 0; x < 3; x++) e.setMaterial(x, 5, MaterialType.WALL);
    e.setMaterial(1, 1, MaterialType.WALL); // pillar directly under the drop
    e.setMaterial(1, 0, MaterialType.SAND);
    for (let i = 0; i < 10; i++) e.update();
    // Sand must have left column 1 and landed on the floor to either side.
    expect(e.getMaterial(1, 0)).toBe(MaterialType.EMPTY);
    const onFloor =
      e.getMaterial(0, 4) === MaterialType.SAND ||
      e.getMaterial(2, 4) === MaterialType.SAND;
    expect(onFloor).toBe(true);
  });
});

describe('liquid leveling and density stratification', () => {
  it('water flows laterally into a downhill gap (a real hole to fill)', () => {
    // The liquid-flow rule only spreads laterally into a cell whose
    // down-neighbor is empty (a genuine downhill gap), never along a flat
    // supported surface (which would oscillate forever). Construct a pool
    // next to a one-step drop: the water must flow across into the lower
    // cell because that target is unsupported (empty below it).
    //   cols: 0 1 2 3 4 5 6
    //  row4:  W W W W W W W   (wall floor)
    //  row3:  . w w w . . .   (water pool on the left)
    //  row2:  . . . . . . .   (the drop — row3 right side is empty, unsupported)
    const e = new PixelEngine({ width: 7, height: 5, seed: 1, gravity: new FlatGravity() });
    for (let x = 0; x < 7; x++) e.setMaterial(x, 4, MaterialType.WALL); // floor
    for (let x = 1; x <= 3; x++) e.setMaterial(x, 3, MaterialType.WATER); // left pool
    // The cell (4,3) is empty; below it (4,4) is wall → but the water at (3,3)
    // sees (4,3) whose down-cell is supported. To get a real gap, carve a
    // deeper basin on the right:
    e.setMaterial(4, 4, MaterialType.EMPTY); // remove floor under col 4
    e.setMaterial(4, 3, MaterialType.EMPTY);
    // Now (4,3)'s down-cell (4,4) is empty → unsupported gap. Water should
    // flow right into it.
    for (let i = 0; i < 60; i++) e.update();
    // Water must have entered column 4 (the gap).
    let enteredGap = false;
    for (let y = 0; y < 5; y++) if (e.getMaterial(4, y) === MaterialType.WATER) enteredGap = true;
    expect(enteredGap).toBe(true);
  });

  it('denser sand sinks downward through water over time', () => {
    const e = makeEngine(3, 8);
    for (let x = 0; x < 3; x++) e.setMaterial(x, 7, MaterialType.WALL);
    // Fill a column with water.
    for (let y = 1; y <= 6; y++) e.setMaterial(1, y, MaterialType.WATER);
    e.setMaterial(1, 0, MaterialType.SAND);
    // Track the sand's lowest position over the WHOLE grid (it moves
    // diagonally through water into adjacent columns). Sand (density 10) is
    // denser than water (density 5), so it must descend below row 0.
    let lowestSand = 0;
    for (let i = 0; i < 80; i++) {
      e.update();
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 3; x++) {
          if (e.getMaterial(x, y) === MaterialType.SAND) lowestSand = Math.max(lowestSand, y);
        }
      }
    }
    expect(lowestSand).toBeGreaterThan(0); // sand descended below its start
  });

  it('oil (lighter than water) floats on top of water', () => {
    // A wide basin: the liquid-flow rule surveys up to 4 cells per frame, so
    // the basin must be wider than that for oil/water to stratify naturally.
    const e = new PixelEngine({ width: 12, height: 12, seed: 1, gravity: new FlatGravity() });
    for (let x = 0; x < 12; x++) e.setMaterial(x, 11, MaterialType.WALL);
    // A substantial water layer at the bottom.
    for (let y = 7; y <= 10; y++) for (let x = 0; x < 12; x++) e.setMaterial(x, y, MaterialType.WATER);
    // Oil dropped in from the top center.
    for (let i = 0; i < 6; i++) e.setMaterial(6, 0, MaterialType.OIL);
    for (let i = 0; i < 200; i++) e.update();
    // After settling, at least one oil cell sits directly above a water cell
    // (oil is less dense, so it floats). Scan the whole grid.
    let oilAboveWater = false;
    for (let y = 1; y <= 10; y++) {
      for (let x = 0; x < 12; x++) {
        if (e.getMaterial(x, y) === MaterialType.OIL && e.getMaterial(x, y + 1) === MaterialType.WATER) {
          oilAboveWater = true;
          break;
        }
      }
    }
    expect(oilAboveWater).toBe(true);
    // And the layered oil/water must go quiet once settled — guards the density
    // path in the lateral-flow gate (oil must not tunnel through water, and
    // neither layer shimmers). Was 106 swaps/frame on the old engine.
    for (let i = 0; i < 200; i++) e.update();
    const swaps: number[] = [];
    for (let i = 0; i < 10; i++) { e.update(); swaps.push(e.swapsLastFrame); }
    expect(Math.max(...swaps)).toBe(0);
  });
});
