import { describe, it, expect } from 'vitest';
import {
  PixelEngine, RadialGravity, MaterialType,
  volcanoGeometryFor, stampVolcano, createVolcanoState, buildVolcanoOpts,
  stepVolcanoFrame, makeRng, DEFAULT_VOLCANO_INPUTS, edificeHeight,
  type VolcanoRuntime,
} from '../../src/index.js';

/**
 * The god-game brief's §8.2 pattern — the LIBRARY volcano at the brief's own
 * scale (640×640, R=205, raised pressure budgets from §4) — pinned as a
 * behavior test. The compile guard in `recipes/tests/brief-82-compile.ts`
 * pins the snippet's TYPES; this file pins what it DOES, which is where two
 * brief bugs hid: a degenerate cap ladder from a mis-transcribed headroom
 * constant, and a dead re-eruption path that never restarted the state
 * machine (a single-cycle run looks correct; only the second click exposes
 * it).
 */

const CX = 320, CY = 320, PLANET_R = 205;

function buildWorld(): PixelEngine {
  const engine = new PixelEngine({
    width: 640, height: 640, seed: 1,
    gravity: new RadialGravity({ centerX: CX, centerY: CY }),
    enableHeat: true, ambientTemperature: 0.12, growthInterval: 4,
    // §4: required at this scale — with defaults the pressure budget exhausts
    // before a route from a chamber this deep reaches the surface.
    pressureVisitLimit: Math.max(2048, Math.round(2048 * PLANET_R / 66)),
    fracturePerFrame: 4,
  });
  engine.beginBulk();
  for (let y = 0; y < 640; y++) {
    for (let x = 0; x < 640; x++) {
      const dx = x - CX, dy = y - CY;
      if (dx * dx + dy * dy <= PLANET_R * PLANET_R) engine.setMaterial(x, y, MaterialType.ROCK);
    }
  }
  engine.endBulk();
  return engine;
}

function countMat(e: PixelEngine, mat: MaterialType): number {
  let n = 0;
  for (let i = 0; i < e.grid.length; i++) if (e.grid[i] === mat) n++;
  return n;
}

function countRock(e: PixelEngine): number {
  return countMat(e, MaterialType.ROCK);
}

/** Drive the brief's per-tick pattern for `frames` ticks; returns final erupting. */
function run(
  engine: PixelEngine,
  cfg: ReturnType<typeof volcanoGeometryFor>['cfg'],
  state: { current: ReturnType<typeof createVolcanoState> },
  rng: () => number,
  capHeight: { current: number },
  erupting: { current: boolean },
  frames: number,
): boolean {
  for (let f = 0; f < frames; f++) {
    const opts = buildVolcanoOpts(cfg, { ...DEFAULT_VOLCANO_INPUTS, maxHeight: capHeight.current });
    const runtime: VolcanoRuntime = { erupting: erupting.current, capHeight: capHeight.current };
    stepVolcanoFrame(engine, cfg, state.current, rng, opts, runtime);
    erupting.current = runtime.erupting;
  }
  return erupting.current;
}

describe('library volcano at god-game scale (brief §4 + §8.2)', () => {
  it('builds a real cone over a complete eruption cycle, then settles', () => {
    const engine = buildWorld();
    const geom = volcanoGeometryFor(CX, CY, PLANET_R, 320 - PLANET_R);

    // The cap ladder must not be degenerate at this scale: headroom 115 gives
    // capStart 62 > capMax-floor and room for capStep growth.
    expect(geom.capStart).toBeGreaterThan(30);
    expect(geom.capMax).toBeGreaterThan(geom.capStart);

    const cfg = volcanoGeometryFor(CX, CY, PLANET_R, 320 - PLANET_R, -Math.PI / 2).cfg;
    stampVolcano(engine, cfg);
    // Rock baseline AFTER stamping: the stamp legitimately converts rock to
    // the magma system; the assertion is about rock the ERUPTION adds.
    const rock0 = countRock(engine);
    const state = { current: createVolcanoState() };
    const rng = makeRng(1234);
    const capHeight = { current: geom.capStart };
    const erupting = { current: true };

    run(engine, cfg, state, rng, capHeight, erupting, 1800);

    expect(erupting.current).toBe(false);                 // the cycle completed
    expect(edificeHeight(engine, cfg)).toBeGreaterThanOrEqual(10);  // a cone stands
    expect(countMat(engine, MaterialType.TEPHRA)).toBeGreaterThanOrEqual(100);
    // Baseline is post-stamp, so this is rock the ERUPTION froze into land.
    // Bar is 100: the failure mode it guards (nothing ever surfaces, or lava
    // never freezes) yields ~0; healthy runs land well above.
    expect(countRock(engine) - rock0).toBeGreaterThanOrEqual(100);
  }, 180_000);

  it('re-erupts when clicked again (state machine restart + cap growth)', () => {
    const engine = buildWorld();
    const geom = volcanoGeometryFor(CX, CY, PLANET_R, 320 - PLANET_R);
    const cfg = volcanoGeometryFor(CX, CY, PLANET_R, 320 - PLANET_R, Math.PI / 4).cfg;
    stampVolcano(engine, cfg);
    const state = { current: createVolcanoState() };
    const rng = makeRng(1234);
    const capHeight = { current: geom.capStart };
    const erupting = { current: true };

    run(engine, cfg, state, rng, capHeight, erupting, 1800);
    expect(erupting.current).toBe(false);
    const h1 = edificeHeight(engine, cfg);

    // Second click per the brief: raise the cap, RESTART the state machine.
    capHeight.current = Math.min(capHeight.current + geom.capStep, geom.capMax);
    state.current = createVolcanoState();
    erupting.current = true;

    // Within the explosive phase's window the vent must be visibly alive
    // again: lava above the old surface near THIS vent's angle (the first
    // cycle's remnant has crusted over by now, so any surface lava is the
    // new eruption's).
    let surfaceLavaSeen = false;
    for (let f = 0; f < 450 && !surfaceLavaSeen; f++) {
      const opts = buildVolcanoOpts(cfg, { ...DEFAULT_VOLCANO_INPUTS, maxHeight: capHeight.current });
      const runtime: VolcanoRuntime = { erupting: erupting.current, capHeight: capHeight.current };
      stepVolcanoFrame(engine, cfg, state.current, rng, opts, runtime);
      erupting.current = runtime.erupting;
      for (let s = 0; s < 24 && !surfaceLavaSeen; s++) {
        const a = Math.PI / 4 + (s / 23) * 0.6 - 0.3;
        for (let r = PLANET_R + 2; r < PLANET_R + 45; r++) {
          const x = Math.round(CX + r * Math.cos(a));
          const y = Math.round(CY + r * Math.sin(a));
          if (engine.getMaterial(x, y) === MaterialType.LAVA) { surfaceLavaSeen = true; break; }
        }
      }
    }
    expect(surfaceLavaSeen).toBe(true);                   // the second click erupts

    run(engine, cfg, state, rng, capHeight, erupting, 1800);
    expect(edificeHeight(engine, cfg)).toBeGreaterThan(h1); // the cone grew
  }, 300_000);
});
