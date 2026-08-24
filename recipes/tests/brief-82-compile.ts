/**
 * A COMPILE GUARD for the god-game brief's §8.2 volcano snippet
 * (games/god-game.md): the snippet's structure, verbatim, against the real
 * engine source. Run by `recipes:typecheck`. Not a vitest file — its job is
 * to fail the build the moment the library API drifts from what the brief
 * teaches. (The first version of that section shipped calling an API that
 * did not exist; this file exists so that cannot recur silently.)
 *
 * The same configuration is runtime-verified at god-game scale (640×640,
 * R=205, raised pressure budgets): explosive → effusive → repose → dormant,
 * ~2,500 lava cells, 325 tephra, 149 new rock over 1800 frames.
 */
import {
  PixelEngine, RadialGravity,
  volcanoGeometryFor, stampVolcano, createVolcanoState, buildVolcanoOpts,
  stepVolcanoFrame, makeRng, DEFAULT_VOLCANO_INPUTS,
  type VolcanoRuntime,
} from '../../src/index.js';

const CX = 320, CY = 320, PLANET_R = 205;
const engine = new PixelEngine({
  width: 640, height: 640, seed: 1,
  gravity: new RadialGravity({ centerX: CX, centerY: CY }),
  enableHeat: true, ambientTemperature: 0.12, growthInterval: 4,
  pressureVisitLimit: Math.max(2048, Math.round(2048 * 205 / 66)),
  fracturePerFrame: 4,
});

// headroom = free sky above the surface; undersizing it stunts the cone
// and collapses the cap ladder (see the brief's §8.2).
const HEADROOM = 320 - PLANET_R;
const volcanoGeom = volcanoGeometryFor(CX, CY, PLANET_R, HEADROOM);
let volcanoState = createVolcanoState();
const volcanoRng = makeRng(1234);
let volcanoStarted = false;
let erupting = false;
let capHeight = volcanoGeom.capStart;
const gx = 320, gy = 100; // a click due north

// On Volcano click:
const cfg = volcanoGeometryFor(CX, CY, PLANET_R, HEADROOM, Math.atan2(gy - CY, gx - CX)).cfg;
if (!volcanoStarted) {
  stampVolcano(engine, cfg);
  volcanoStarted = true;
} else {
  capHeight = Math.min(capHeight + volcanoGeom.capStep, volcanoGeom.capMax);
}
// Restart the cycle on its explosive phase — without this, a completed state
// machine sits in repose forever and every later click emits nothing.
volcanoState = createVolcanoState();
erupting = true;

// Every tick:
const volcanoOpts = buildVolcanoOpts(cfg, {
  ...DEFAULT_VOLCANO_INPUTS,
  maxHeight: capHeight,
});
const runtime: VolcanoRuntime = { erupting, capHeight };
stepVolcanoFrame(engine, cfg, volcanoState, volcanoRng, volcanoOpts, runtime);
erupting = runtime.erupting;
