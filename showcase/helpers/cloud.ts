/**
 * Cloud — a rain-producing cloud painted above a radial-gravity planet.
 *
 * ## Why this is a host-side helper, not an engine material
 *
 * The engine has no cloud material and no buoyancy/pressure term. A gas in
 * `RadialGravity` only ever rises *away* from the gravity center until it hits
 * the grid edge (see the gas-rising path in `engine.ts`): there is no setting
 * that holds a body of vapour in place at a fixed altitude. That is the same
 * gap that made the volcano helper advect its own magma conduit rather than ask
 * the engine for pressure — `docs/integration.md` is explicit that multi-cell
 * "features" are the host's job.
 *
 * So a cloud here is a *logical entity* the host tracks and renders, not a
 * material in the grid. The rain, by contrast, is real: each tick the cloud
 * spends some of its water budget to spawn `WATER` cells at its base, which the
 * engine then pulls onto the surface under `RadialGravity` — exactly the
 * god-game settling the planet section exists to show. Only `WATER` ever enters
 * the simulation; the cloud itself never touches `grid`.
 *
 * DOM-free and deterministic, so it runs and is tested under Node — the same
 * split the sections use for `renderer.ts` and `volcano.ts`.
 */

import type { PixelEngine } from '../../src/sand';
import { MaterialType } from '../../src/materials';

/**
 * The slice of planet geometry the helper needs.
 *
 * Kept as a narrow interface rather than a reference to the section's `World`
 * type so the helper has no dependency on the DOM-facing layer and stays
 * testable in Node.
 */
export interface PlanetView {
  /** Planet center, in cells. */
  centerX: number;
  centerY: number;
  /** Planet surface radius, in cells. */
  planetRadius: number;
  /** Grid width/height, in cells (the grid is square). */
  size: number;
}

/** A single rain cloud, tracked and rendered by the host. */
export interface Cloud {
  /** Center in grid space, in cells. */
  x: number;
  y: number;
  /** Current visible radius, in cells. Shrinks with {@link Cloud.water}. */
  radius: number;
  /** Radius the cloud was placed at, in cells. */
  initialRadius: number;
  /**
   * Remaining water budget. Each tick of rain spends {@link CloudOptions.rainPerTick}
   * of it, one `WATER` cell per unit. When it hits zero the cloud is exhausted
   * and is removed.
   */
  water: number;
  /** Water budget the cloud started with. */
  initialWater: number;
}

/** Per-tick tuning, read fresh from the UI each frame (mirrors volcano opts). */
export interface CloudOptions {
  /**
   * Water spent per cloud per tick — i.e. the rain rate. Each unit becomes one
   * `WATER` cell spawned under the cloud. Higher values empty the cloud faster
   * (a heavier shower is a shorter one), which is the natural, self-consistent
   * mapping from the single "Rain" slider onto both rate and lifetime.
   */
  rainPerTick: number;
}

/**
 * Default cloud radius, in cells. Tuned to read as a small puffy cloud at the
 * showcase's default 220-cell grid while still leaving rain a few cells wide so
 * it visibly curtains rather than trickling as a single column.
 */
export const DEFAULT_CLOUD_RADIUS = 7;

/**
 * Water budget per cell of initial radius.
 *
 * Sized so that at the default rain rate (2) a freshly-placed cloud of radius 7
 * holds `7 * CLOUD_WATER_PER_CELL = 420` water, which at 2/tick drains in 210
 * ticks ≈ 3.5 s at 60 Hz — a short, snappy shower that visibly shrinks.
 */
export const CLOUD_WATER_PER_CELL = 60;

/**
 * How far below its center a cloud drops its rain, as a fraction of its radius.
 *
 * Rain is spawned just under the cloud body rather than at its center so the
 * curtain hangs below the visible cloud and the cloud itself never occludes the
 * stream. A fraction rather than a fixed offset so it scales with cloud size.
 */
const RAIN_OFFSET_FACTOR = 0.7;

/**
 * Place a cloud centred at grid cell `(x, y)`, or return `null` if the point is
 * not a valid cloud location.
 *
 * A cloud is only valid in the void above the surface — placing one inside the
 * planet disc or off the grid returns `null`, which is the guard that enforces
 * the feature's contract ("click above the surface to draw a cloud"). The
 * radius is also clamped so a cloud placed near the grid edge cannot extend
 * past it; a cloud whose clamped radius is below 1 is rejected, since a
 * zero-radius cloud renders and rains as nothing.
 *
 * @param planet - planet geometry
 * @param x - grid x of the click
 * @param y - grid y of the click
 * @param radius - desired cloud radius, in cells
 */
export function placeCloud(
  planet: PlanetView,
  x: number,
  y: number,
  radius = DEFAULT_CLOUD_RADIUS,
): Cloud | null {
  // Inside the planet disc: not a cloud location.
  const dx = x - planet.centerX;
  const dy = y - planet.centerY;
  if (dx * dx + dy * dy <= planet.planetRadius * planet.planetRadius) return null;

  // Outside the grid: not a cloud location.
  if (x < 0 || x >= planet.size || y < 0 || y >= planet.size) return null;

  // Clamp radius to the room left toward each grid edge, so a cloud dragged
  // near the boundary never draws or rains off-grid.
  const maxR = Math.max(
    1,
    Math.min(x, planet.size - 1 - x, y, planet.size - 1 - y, radius),
  );
  if (maxR < 1) return null;

  const initialWater = maxR * CLOUD_WATER_PER_CELL;
  return {
    x,
    y,
    radius: maxR,
    initialRadius: maxR,
    water: initialWater,
    initialWater,
  };
}

/**
 * Advance one cloud by one tick: spend water, spawn rain, age the radius.
 *
 * Designed to be called *before* `engine.update()` for the frame, so that
 * freshly-spawned rain moves on the same tick it appears — the same pre-step
 * ordering rationale as `stepVolcanoPre`. Rain lands at jittered points across
 * the cloud's underside so it reads as a curtain rather than a single stream;
 * each rain cell is only placed into empty space, never overwriting terrain,
 * so rain never carves into the planet or erases a user's brushwork.
 *
 * The radius tracks the remaining water fraction, so the cloud visibly shrinks
 * as it rains and is exactly zero once exhausted — the visual feedback that
 * matches the budget.
 *
 * @param engine - the simulation (rain is written into its grid)
 * @param cloud - the cloud to step (mutated in place)
 * @param opts - per-tick tuning
 * @param rng - deterministic PRNG for rain jitter (see `makeRng` in volcano.ts)
 */
export function stepCloud(
  engine: PixelEngine,
  cloud: Cloud,
  opts: CloudOptions,
  rng: () => number,
): void {
  if (cloud.water <= 0) {
    cloud.radius = 0;
    return;
  }

  const spend = Math.min(opts.rainPerTick, cloud.water);
  const r = cloud.initialRadius;
  // Half the rain width across the cloud underside. A touch narrower than the
  // full radius so the curtain clearly originates under the body rather than
  // speckling past its edges.
  const halfWidth = Math.max(0.5, r * 0.8);
  const yOffset = r * RAIN_OFFSET_FACTOR;

  for (let i = 0; i < spend; i++) {
    // Uniform across the underside, biased outward by nothing in particular —
    // a flat curtain is what reads as rain.
    const t = rng() * 2 - 1; // [-1, 1]
    const rx = Math.round(cloud.x + t * halfWidth);
    const ry = Math.round(cloud.y + yOffset + rng() * 2); // small vertical jitter
    // Only rain into empty space. The engine reports out-of-bounds as WALL, so
    // this guard also keeps rain off the grid boundary without a second check.
    if (engine.getMaterial(rx, ry) === MaterialType.EMPTY) {
      engine.setMaterial(rx, ry, MaterialType.WATER);
    }
  }

  cloud.water -= spend;
  // Radius follows the water fraction so the shrink is visible and ends at 0.
  const frac = cloud.water > 0 ? cloud.water / cloud.initialWater : 0;
  cloud.radius = cloud.initialRadius * frac;
}

/**
 * Return the clouds that still have water left.
 *
 * Exhausted clouds have zero radius and produce no rain, so keeping them
 * around would only waste render and step work — drop them once spent.
 */
export function removeDead(clouds: Cloud[]): Cloud[] {
  const out: Cloud[] = [];
  for (let i = 0; i < clouds.length; i++) {
    if (clouds[i].water > 0) out.push(clouds[i]);
  }
  return out;
}

/**
 * Minimum spacing between cloud centres on a drag, in cells.
 *
 * Without this, a pointer drag stamps a cloud every move event (every cell the
 * pointer crosses), piling dozens of overlapping clouds into a solid white mass
 * and flooding the surface. Spacing placement at the cloud's own diameter leaves
 * a trail of distinct clouds instead, which is what "drag to paint clouds"
 * reads as.
 *
 * @param radius - the radius each placed cloud will have, in cells
 */
export function cloudSpacing(radius: number): number {
  return Math.max(4, radius * 2);
}
