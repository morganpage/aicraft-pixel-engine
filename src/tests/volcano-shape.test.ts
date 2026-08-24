import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../sand';
import { MaterialType } from '../materials';
import { RadialGravity } from '../gravity';
import {
  stampVolcano, createVolcanoState, stepVolcanoFrame, makeRng,
  buildVolcanoOpts, DEFAULT_VOLCANO_INPUTS,
  type VolcanoConfig, type VolcanoRuntime,
} from '../volcano';
import {
  DEFAULT_VOLCANO_CFG, buildVolcanoPlanet,
  measureVolcanoShape, assertVolcanoShape, DEFAULT_SHAPE_BUDGET,
} from './helpers/volcano-fixtures';

/**
 * THE SILHOUETTE CONTRACT.
 *
 * Every other volcano assertion in this repo measures *magnitude* — height,
 * volume, spread, new rock, does it settle. A player screenshot proved those
 * are jointly satisfiable by something that is not a volcano: a straight-sided
 * chimney standing on a skirt. It is tall. It has volume. Its centre is higher
 * than its shoulders.
 *
 * What separates a cone from a tower is **taper**, and taper needs a metric of
 * its own. This file is that metric plus its contract, and it is deliberately
 * split in two: the first suite tests the *ruler* against shapes whose answer
 * is known by construction, because a shape test nobody has calibrated is a
 * shape test that quietly passes everything.
 */

const ANGLES: [string, number][] = [
  ['N', -Math.PI / 2],
  ['E', 0],
  ['S', Math.PI / 2],
  ['W', Math.PI],
  ['NW', (-Math.PI * 3) / 4],
];

/** A bare planet with a synthetic edifice stamped on it, for calibrating the ruler. */
function syntheticPlanet(): { engine: PixelEngine; cfg: VolcanoConfig } {
  const SIZE = 160, C = 80, R = 50;
  const cfg: VolcanoConfig = {
    centerX: C, centerY: C, planetRadius: R, ventAngle: -Math.PI / 2,
    conduitHalfWidth: 1, chamberRadius: 6, chamberDepth: 18, surfaceScanLimit: 60,
  };
  const engine = new PixelEngine({
    width: SIZE, height: SIZE, seed: 1,
    gravity: new RadialGravity({ centerX: C, centerY: C }),
  });
  engine.beginBulk();
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - C, dy = y - C;
      if (dx * dx + dy * dy <= R * R) engine.setMaterial(x, y, MaterialType.ROCK);
    }
  }
  engine.endBulk();
  return { engine, cfg };
}

/** Stamp `halfWidth(t)` cells either side of the vent axis at each height. */
function stampProfile(
  engine: PixelEngine, cfg: VolcanoConfig,
  height: number, halfWidth: (t: number) => number,
): void {
  const ux = Math.cos(cfg.ventAngle), uy = Math.sin(cfg.ventAngle);
  engine.beginBulk();
  for (let t = 0; t <= height; t++) {
    const hw = halfWidth(t);
    for (let w = -hw; w <= hw; w++) {
      const x = Math.round(cfg.centerX + ux * (cfg.planetRadius + t) - uy * w);
      const y = Math.round(cfg.centerY + uy * (cfg.planetRadius + t) + ux * w);
      engine.setMaterial(x, y, MaterialType.ROCK);
    }
  }
  engine.endBulk();
}

describe('silhouette metric: calibrated against known shapes', () => {
  it('passes a cone', () => {
    const { engine, cfg } = syntheticPlanet();
    // Base 41 wide, tapering linearly to a point over 20 cells of height.
    stampProfile(engine, cfg, 20, (t) => Math.round(20 * (1 - t / 20)));
    const s = measureVolcanoShape(engine, cfg);
    expect(s.maxFlatRun).toBeLessThanOrEqual(DEFAULT_SHAPE_BUDGET.maxFlatRun);
    expect(s.maxBulge).toBeLessThanOrEqual(DEFAULT_SHAPE_BUDGET.maxBulge);
    expect(() => assertVolcanoShape(engine, cfg, 'synthetic cone')).not.toThrow();
  });

  it('FAILS a chimney — the defect this file exists for', () => {
    const { engine, cfg } = syntheticPlanet();
    // A skirt for the first 6 cells, then vertical walls: exactly the shape the
    // god-game recipe produced, and exactly what height-and-volume tests miss.
    stampProfile(engine, cfg, 24, (t) => (t < 6 ? 20 - t * 2 : 8));
    const s = measureVolcanoShape(engine, cfg);
    expect(s.maxFlatRun).toBeGreaterThan(DEFAULT_SHAPE_BUDGET.maxFlatRun);
    expect(() => assertVolcanoShape(engine, cfg, 'synthetic chimney'))
      .toThrow(/VERTICAL WALL/);
  });

  it('FAILS a flat-topped mesa', () => {
    const { engine, cfg } = syntheticPlanet();
    stampProfile(engine, cfg, 18, () => 18);
    expect(() => assertVolcanoShape(engine, cfg, 'synthetic mesa')).toThrow(/VERTICAL WALL/);
  });

  it('FAILS a bulb on a stalk', () => {
    const { engine, cfg } = syntheticPlanet();
    // Narrow stalk, then a wide head — the shape a taper test alone would let
    // through, since a bulb re-widens rather than holding one width.
    stampProfile(engine, cfg, 22, (t) => (t < 12 ? 14 - t : 12));
    expect(() => assertVolcanoShape(engine, cfg, 'synthetic bulb')).toThrow();
  });

  it('FAILS a cone that is too steep to stand', () => {
    const { engine, cfg } = syntheticPlanet();
    // Tapers correctly, but 30 cells tall on a 21-cell base: aspect 1.4.
    stampProfile(engine, cfg, 30, (t) => Math.max(0, Math.round(10 * (1 - t / 30))));
    expect(() => assertVolcanoShape(engine, cfg, 'synthetic spike')).toThrow(/TOO STEEP/);
  });

  it('reports detached material', () => {
    const { engine, cfg } = syntheticPlanet();
    stampProfile(engine, cfg, 20, (t) => Math.round(20 * (1 - t / 20)));
    const clean = measureVolcanoShape(engine, cfg);
    expect(clean.detachedCells).toBe(0);
    // A clump floating clear of the edifice: the cone tops out at t=20, so t=26
    // leaves a six-cell gap. (Not higher — this synthetic planet has only 30
    // cells of headroom above the surface before the grid ends.)
    const ux = Math.cos(cfg.ventAngle), uy = Math.sin(cfg.ventAngle);
    for (let d = 0; d < 4; d++) {
      const x = Math.round(cfg.centerX + ux * (cfg.planetRadius + 26) - uy * (d - 2));
      const y = Math.round(cfg.centerY + uy * (cfg.planetRadius + 26) + ux * (d - 2));
      engine.setMaterial(x, y, MaterialType.ROCK);
    }
    expect(measureVolcanoShape(engine, cfg).detachedCells).toBeGreaterThan(0);
  });
});

describe('library volcano builds a cone at every vent angle', () => {
  /**
   * The subsystem's own eruption, measured with the same ruler.
   *
   * The cone is fully settled by frame ~600 (checked: frames 600, 900 and 1200
   * give identical silhouettes), so this runs the short window and stays inside
   * the fast suite's budget.
   */
  function eruptAt(angle: number): { engine: PixelEngine; cfg: VolcanoConfig } {
    const cfg: VolcanoConfig = { ...DEFAULT_VOLCANO_CFG, ventAngle: angle };
    const engine = buildVolcanoPlanet(cfg);
    stampVolcano(engine, cfg);
    const state = createVolcanoState();
    const rng = makeRng(4242);
    const opts = buildVolcanoOpts(cfg, DEFAULT_VOLCANO_INPUTS);
    const runtime: VolcanoRuntime = { erupting: true, capHeight: opts.pressure.maxHeight - 2 };
    for (let f = 1; f <= 600; f++) stepVolcanoFrame(engine, cfg, state, rng, opts, runtime);
    return { engine, cfg };
  }

  for (const [name, angle] of ANGLES) {
    it(`${name}: silhouette reads as a volcano`, () => {
      const { engine, cfg } = eruptAt(angle);
      const s = assertVolcanoShape(engine, cfg, `library volcano, vent ${name}`);
      // Recorded so a regression shows the direction of drift, not just a fail.
      expect(s.maxFlatRun).toBeLessThanOrEqual(3);
      expect(s.aspect).toBeLessThanOrEqual(0.55);
    });
  }
});
