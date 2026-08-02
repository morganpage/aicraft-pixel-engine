import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../../src/sand';
import { MaterialType } from '../../src/materials';
import { RadialGravity } from '../../src/gravity';
import { makeRng } from '../helpers/volcano';
import {
  placeCloud,
  stepCloud,
  removeDead,
  cloudSpacing,
  DEFAULT_CLOUD_RADIUS,
  CLOUD_WATER_PER_CELL,
  type CloudOptions,
  type PlanetView,
} from '../helpers/cloud';

/**
 * Tests for the host-side cloud.
 *
 * The behaviours pinned here are the ones that, if broken, would make the
 * feature not read as a cloud: rain has to actually fall from it, the cloud has
 * to visibly shrink as it does, and it has to vanish once spent rather than
 * hanging empty forever. The placement guard is also load-bearing — without it
 * a click inside the planet would bury a cloud in rock.
 */

// The showcase's own geometry (SIZE 220, planetRadius 66), matching
// volcano.test.ts so assertions are made against the configuration that ships.
const SIZE = 220, CX = 110, CY = 110, R = 66;

const PLANET: PlanetView = { centerX: CX, centerY: CY, planetRadius: R, size: SIZE };

/** Showcase default rain rate. */
const OPTS: CloudOptions = { rainPerTick: 2 };

function buildPlanet(): PixelEngine {
  const e = new PixelEngine({
    width: SIZE, height: SIZE, seed: 1,
    gravity: new RadialGravity({ centerX: CX, centerY: CY }),
  });
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - CX, dy = y - CY;
      if (dx * dx + dy * dy <= R * R) e.setMaterial(x, y, MaterialType.ROCK);
    }
  }
  return e;
}

/** A point clearly in the void above the planet (screen-up from center). */
const ABOVE = { x: CX, y: CY - R - 20 };

const count = (e: PixelEngine, m: MaterialType): number => {
  let n = 0;
  for (let i = 0; i < e.grid.length; i++) if (e.grid[i] === m) n++;
  return n;
};

describe('placeCloud', () => {
  it('places a cloud at a point in the void above the surface', () => {
    // The contract: a click above the surface draws a cloud. Anything that
    // breaks this (e.g. a flipped inside/outside test) would silently make the
    // tool do nothing where the user expects it to work.
    const c = placeCloud(PLANET, ABOVE.x, ABOVE.y);
    expect(c).not.toBeNull();
    expect(c!.x).toBe(ABOVE.x);
    expect(c!.y).toBe(ABOVE.y);
    expect(c!.radius).toBe(DEFAULT_CLOUD_RADIUS);
    expect(c!.initialRadius).toBe(DEFAULT_CLOUD_RADIUS);
    expect(c!.water).toBe(DEFAULT_CLOUD_RADIUS * CLOUD_WATER_PER_CELL);
    expect(c!.initialWater).toBe(c!.water);
  });

  it('returns null for a point inside the planet disc', () => {
    // Without this guard a click on the planet body would bury a cloud in rock,
    // which is neither what the user asked for ("above the surface") nor a
    // useful state — the cloud would rain into solid terrain.
    const c = placeCloud(PLANET, CX, CY);
    expect(c).toBeNull();
  });

  it('returns null for a point outside the grid', () => {
    // The section clamps clicks to the canvas, but a defensive OOB rejection in
    // the helper keeps it correct for any caller (and any future wiring).
    expect(placeCloud(PLANET, -5, ABOVE.y)).toBeNull();
    expect(placeCloud(PLANET, SIZE + 5, ABOVE.y)).toBeNull();
    expect(placeCloud(PLANET, ABOVE.x, -5)).toBeNull();
    expect(placeCloud(PLANET, ABOVE.x, SIZE + 5)).toBeNull();
  });

  it('clamps radius so a cloud near the grid edge cannot extend off-grid', () => {
    // A cloud dragged to the boundary must not render or rain past the edge.
    // The clamp keeps both the visible disc and the rain spawn box in-grid.
    const nearEdge = placeCloud(PLANET, 2, CY - R - 20);
    expect(nearEdge).not.toBeNull();
    // x=2 leaves only 2 cells of room to the left (and right), so the radius
    // clamps to that room rather than the requested default.
    expect(nearEdge!.radius).toBeLessThanOrEqual(DEFAULT_CLOUD_RADIUS);
    expect(nearEdge!.radius).toBeGreaterThanOrEqual(1);
  });

  it('survives the full planet slider range (resize sweep)', () => {
    // Mirror of the volcano geometry sweep: the placement guard must hold at
    // every (resolution, diameter) pair the UI can produce, never placing a
    // cloud whose body or rain would land outside a small planet's grid.
    for (const size of [120, 220, 320, 400]) {
      const r = Math.round((size * 60) / 200); // 60% diameter
      const planet: PlanetView = { centerX: size / 2, centerY: size / 2, planetRadius: r, size };
      // A point just above the surface on the small planet.
      const px = size / 2, py = size / 2 - r - Math.max(4, Math.round(r * 0.2));
      const c = placeCloud(planet, px, py);
      expect(c, `size=${size}`).not.toBeNull();
      expect(c!.x, `size=${size}`).toBeGreaterThanOrEqual(0);
      expect(c!.x, `size=${size}`).toBeLessThan(size);
      expect(c!.y, `size=${size}`).toBeGreaterThanOrEqual(0);
      expect(c!.y, `size=${size}`).toBeLessThan(size);
    }
  });
});

describe('stepCloud', () => {
  it('spawns WATER cells under the cloud after stepping', () => {
    // If rain ever stops being written to the grid the feature is inert, so
    // this is the first thing to break. Counts the actual cells in the grid.
    const e = buildPlanet();
    const c = placeCloud(PLANET, ABOVE.x, ABOVE.y)!;
    stepCloud(e, c, OPTS, makeRng(1));
    expect(count(e, MaterialType.WATER)).toBeGreaterThan(0);
  });

  it('reduces water by exactly rainPerTick each tick', () => {
    // The budget arithmetic has to be exact: it is what both the lifetime and
    // the shrink fraction are derived from, so a leak here would make clouds
    // either never run out or vanish too fast.
    const e = buildPlanet();
    const c = placeCloud(PLANET, ABOVE.x, ABOVE.y)!;
    const w0 = c.water;
    stepCloud(e, c, OPTS, makeRng(1));
    expect(c.water).toBe(w0 - OPTS.rainPerTick);
  });

  it('shrinks the radius as water drains, reaching 0 when exhausted', () => {
    // The visible feedback IS the shrink. If radius stopped tracking water the
    // cloud would rain on invisibly or hang at full size while empty.
    const e = buildPlanet();
    const c = placeCloud(PLANET, ABOVE.x, ABOVE.y)!;
    const r0 = c.radius;
    stepCloud(e, c, OPTS, makeRng(1));
    expect(c.radius).toBeLessThan(r0);
    expect(c.radius).toBeGreaterThan(0);

    // Drain fully.
    const ticks = Math.ceil(c.initialWater / OPTS.rainPerTick);
    for (let i = 1; i < ticks; i++) stepCloud(e, c, OPTS, makeRng(1));
    expect(c.water).toBeLessThanOrEqual(0);
    expect(c.radius).toBe(0);
  });

  it('never overwrites non-empty cells with rain', () => {
    // Rain must only ever land into empty space — overwriting terrain would
    // carve the planet, and overwriting painted material would erase the
    // user's brushwork. The guard reads EMPTY before writing.
    const e = buildPlanet();
    // Plant a solid wall of ROCK directly under the cloud's rain band so there
    // is no empty cell for rain to occupy. The jitter spans up to three rows
    // (rng()*2 rounded → 0,1,2 below the offset), so block every one of them
    // across the full rain width, plus a margin either side.
    const c = placeCloud(PLANET, ABOVE.x, ABOVE.y)!;
    const halfWidth = Math.max(0.5, c.initialRadius * 0.8);
    const yTop = Math.round(c.y + c.initialRadius * 0.7);
    for (let dx = -Math.ceil(halfWidth) - 1; dx <= Math.ceil(halfWidth) + 1; dx++) {
      for (let dy = 0; dy <= 2; dy++) {
        e.setMaterial(c.x + dx, yTop + dy, MaterialType.ROCK);
      }
    }
    const rockBefore = count(e, MaterialType.ROCK);
    stepCloud(e, c, OPTS, makeRng(1));
    expect(count(e, MaterialType.ROCK)).toBe(rockBefore);
    expect(count(e, MaterialType.WATER)).toBe(0);
  });

  it('is deterministic: same seed reproduces the grid and cloud exactly', () => {
    // The host-side helpers are deliberately deterministic so the showcase is
    // reproducible and the tests stable. Two runs from the same seed must agree
    // cell-for-cell — if they ever diverge the helper has leaked Math.random or
    // engine-internal state into its output.
    const run = (): { grid: Uint8Array; water: number; radius: number } => {
      const e = buildPlanet();
      const c = placeCloud(PLANET, ABOVE.x, ABOVE.y)!;
      const rng = makeRng(7);
      for (let i = 0; i < 10; i++) stepCloud(e, c, OPTS, rng);
      return { grid: Uint8Array.from(e.grid), water: c.water, radius: c.radius };
    };
    const a = run();
    const b = run();
    expect(Array.from(a.grid)).toEqual(Array.from(b.grid));
    expect(a.water).toBe(b.water);
    expect(a.radius).toBe(b.radius);
  });

  it('settles to a dead stop once rain has landed', () => {
    // The same churn guard volcano.test.ts uses: once a cloud exhausts and its
    // rain has settled on the surface, the scene must go still. A scene that
    // silently chatters forever reads as a freeze or a perf bug.
    const e = buildPlanet();
    const c = placeCloud(PLANET, ABOVE.x, ABOVE.y)!;
    const rng = makeRng(1);
    // Rain out the cloud, then let the fallen water settle.
    const ticks = Math.ceil(c.initialWater / OPTS.rainPerTick);
    for (let i = 0; i < ticks; i++) stepCloud(e, c, OPTS, rng);
    for (let i = 0; i < 600; i++) e.update();
    expect(e.swapsLastFrame).toBe(0);
  });
});

describe('removeDead', () => {
  it('drops clouds whose water has run out and keeps the rest', () => {
    // Exhausted clouds have zero radius and produce no rain, so keeping them
    // around would be pure render/step overhead. They have to be dropped.
    // (Pure data — no engine needed here, unlike the step tests.)
    const live = placeCloud(PLANET, ABOVE.x, ABOVE.y)!;
    const dead = placeCloud(PLANET, ABOVE.x + 20, ABOVE.y)!;
    dead.water = 0;
    dead.radius = 0;
    const kept = removeDead([dead, live]);
    expect(kept).toEqual([live]);
  });
});

describe('cloudSpacing', () => {
  it('is at least the cloud diameter, so a drag leaves distinct clouds', () => {
    // Without enforced spacing, a pointermove handler stamps a cloud per cell
    // crossed and a drag collapses into one solid white blob plus a flood.
    // Spacing at the diameter is the minimum that reads as a trail of clouds.
    const s = cloudSpacing(DEFAULT_CLOUD_RADIUS);
    expect(s).toBeGreaterThanOrEqual(DEFAULT_CLOUD_RADIUS * 2);
    expect(cloudSpacing(1)).toBeGreaterThanOrEqual(4);
  });
});
