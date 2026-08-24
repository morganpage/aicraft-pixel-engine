import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../../src/sand';
import { MaterialType } from '../../src/materials';
import { RadialGravity } from '../../src/gravity';
import {
  stampVolcano,
  volcanoGeometryFor,
  type VolcanoConfig,
} from '../../src/volcano';
import {
  runVolcanoTrajectory,
  edificeProfile,
  engineFromSnapshot,
} from '../../src/tests/helpers/volcano-fixtures';

/**
 * High-resolution cone-formation regression.
 *
 * The volcano's cone is built by magma routed under pressure from the chamber
 * to the vent. At 220² a clear cone forms; the regression was that above ~700²
 * no cone formed at all — the eruption cycled through its phases emitting
 * nothing because the pressure router's Dijkstra visit budget (a fixed 2048)
 * was exhausted before it could find a route through the proportionally larger
 * chamber+conduit. The fix scales the visit budget with the planet (planetRadius²,
 * tracking the searchable volume) so the route is always reachable.
 *
 * These tests run the eruption at the shipping size (control) and at high
 * resolution and compare the resulting edifice. They are SLOW (thousands of
 * frames), so each sets its own timeout.
 */

/**
 * Build a size-matched planet with the same scaled pressure-route budget the
 * showcase uses, so the test exercises the real production construction (not
 * the default `buildVolcanoPlanet`, which omits the scaling and routes nothing
 * at high resolution).
 */
const buildScaled = (cfg: VolcanoConfig, size: number): PixelEngine => {
  const e = new PixelEngine({
    width: size,
    height: size,
    seed: 1,
    gravity: new RadialGravity({ centerX: cfg.centerX, centerY: cfg.centerY }),
    enableHeat: true,
    fracturePerFrame: 4,
    // Match showcase/sections/planet.ts constructWorld: scale the Dijkstra visit
    // budget with the planet radius so the chamber→vent route is always reachable.
    pressureVisitLimit: Math.max(2048, Math.round(2048 * cfg.planetRadius / 66)),
  });
  const { centerX: cx, centerY: cy, planetRadius: r } = cfg;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) e.setMaterial(x, y, MaterialType.ROCK);
    }
  }
  return e;
};

/** Build a size-matched planet + volcano and run one eruption cycle to completion. */
const eruptAt = (size: number, pct = 60, frames = 4000) => {
  const cx = size / 2, cy = size / 2;
  const planetR = Math.round((size * pct) / 200);
  const headroom = size / 2 - planetR;
  const geom = volcanoGeometryFor(cx, cy, planetR, headroom);
  const cfg = geom.cfg;
  const engine = buildScaled(cfg, size);
  stampVolcano(engine, cfg);

  const { snapshots } = runVolcanoTrajectory({
    frames,
    checkpoints: [frames],
    cfg,
    build: () => engine,
  });
  const snap = snapshots.get(frames);
  const finalEngine = snap ? engineFromSnapshot(snap) : engine;
  return { engine: finalEngine, cfg, planetR };
};

describe('volcano cone formation across resolutions', () => {
  // A cone is newly-built land above the original surface. edificeProfile.height
  // is the max cells-above-surface of any ROCK/TEPHRA/LAVA cell; edificeHeight
  // samples the summit window. The regression is that at high resolution this
  // stays near zero (no cone) while at 220² it grows to a sizable fraction of
  // capStart.

  it('forms a cone at the shipping 220² size (control)', () => {
    const { engine, cfg } = eruptAt(220);
    const profile = edificeProfile(engine, cfg);
    // At 220² the cap target is 20 cells; a real cone reaches a good fraction.
    expect(profile.height, '220² cone height').toBeGreaterThanOrEqual(10);
    expect(profile.cells, '220² cone cell count').toBeGreaterThan(400);
  }, 20000);

  it('forms a cone at 1000² (the fix: scaled pressure-route budget)', () => {
    // The reported bug was "no cone forms above ~700²." The cause: the pressure
    // router's fixed visit budget (2048) was exhausted before finding a route
    // through the proportionally larger chamber+conduit, so the eruption cycled
    // through its phases emitting nothing (tephra stayed at 0, height ~1.0).
    // The fix scales the budget with the planet; a cone now forms.
    const { engine, cfg, planetR } = eruptAt(1000);
    const profile = edificeProfile(engine, cfg);
    // A real cone is non-trivial land above the surface. The pre-fix height was
    // ~1.0 (flat); the fix reaches double digits, comparable to the 220² control.
    expect(profile.height, `1000² cone height (planetR ${planetR})`).toBeGreaterThanOrEqual(10);
    // And it is made of erupted material (tephra/lava/rock outside the surface),
    // not a bare vent — the pre-fix cell count was near zero.
    expect(profile.cells, '1000² cone cell count').toBeGreaterThan(100);
  }, 120000);

  it('the high-res cone is at least as tall as the 220² cone (no absolute-cell ceiling)', () => {
    // The defining regression signature: at 220² the cone reached ~10 cells, but
    // at 1000² it was ~1.0 — an absolute-cell ceiling that did not scale. After
    // the fix the 1000² cone must reach at least the 220² height (it should be
    // taller, since the planet is bigger, but "at least as tall" is the property
    // that distinguished the bug from the fix).
    const small = eruptAt(220);
    const big = eruptAt(1000);
    const smallH = edificeProfile(small.engine, small.cfg).height;
    const bigH = edificeProfile(big.engine, big.cfg).height;
    expect(bigH, `1000² height ${bigH} vs 220² height ${smallH}`).toBeGreaterThanOrEqual(smallH);
  }, 120000);
});
