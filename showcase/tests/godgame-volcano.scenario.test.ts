import { describe, it, expect, beforeAll } from 'vitest';
import { PixelEngine } from '../../src/sand';
import { MaterialType, isTerrainSolid } from '../../src/materials';
import { RadialGravity } from '../../src/gravity';

/**
 * The god-game volcano acceptance test — the arbiter for the recipe published
 * in `games/god-game.md` §8.2.
 *
 * A "good volcano" is defined by these stringent, measurable criteria (all
 * must pass on one 1800-frame run of the recipe against the bare rock planet
 * from the brief's §4):
 *
 *  1. MAGMA CHAMBER — ≥150 LAVA cells deeper than 10 cells below the surface
 *     at some checkpoint (a real buried reservoir, not just a wet vent).
 *  2. VENT ACTIVITY — ≥5 LAVA cells above the original surface at ≥3 distinct
 *     checkpoints (magma repeatedly reaches the surface).
 *  3. BALLISTIC EJECTA — ≥8 LAVA cells airborne ≥8 cells above the surface at
 *     some checkpoint (a fountain in parabolic flight, not a dribble).
 *  4. FRAGMENTATION — ≥150 TEPHRA cells exist (ejecta that cooled in flight
 *     and landed granular; tephra only forms from airborne lava).
 *  5. EJECTA SPREAD — ≥25 TEPHRA cells ≥10 cells off the vent axis (the
 *     fountain fans across the flanks, not a single column).
 *  6. CONE — the final edifice within 22 cells of the vent axis has
 *     max height ≥10 cells above the original surface, ≥8 of 11 tangent bins
 *     (4-cell width) rise ≥4 cells (a mound, not a spike), and ≥250 cells of
 *     cone volume (tephra + frozen rock + lava above the old surface).
 *  7. NEW LAND — final ROCK count exceeds the initial by ≥150 (frozen lava
 *     became terrain).
 *  8. SETTLES — at the final frame ≤12 LAVA cells remain above the surface
 *     (the eruption ends; the land stays).
 *  9. DETERMINISM — a second run of the same recipe produces a byte-identical
 *     grid at frame 600.
 *
 * The recipe helper below is the brief's §8.2 verbatim. When tuning changes
 * the recipe, brief and helper must move together — that coupling is the
 * point of this test.
 */

const SIZE = 640;
const CX = 320, CY = 320;
const R = 205; // PLANET_R
const ANGLE = -Math.PI / 2; // due north — the cardinal angle that was the dead-vent case
const FRAMES = 1800;
const CHECK_EVERY = 60;

function buildWorld(): PixelEngine {
  const engine = new PixelEngine({
    width: SIZE, height: SIZE, seed: 1,
    gravity: new RadialGravity({ centerX: CX, centerY: CY }),
    enableHeat: true, ambientTemperature: 0.12, growthInterval: 4,
  });
  engine.beginBulk();
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - CX, dy = y - CY;
      if (dx * dx + dy * dy <= R * R) engine.setMaterial(x, y, MaterialType.ROCK);
    }
  }
  engine.endBulk();
  return engine;
}

/**
 * The brief §8.2 recipe — carve mouth, stamp heated chamber + conduit, then a
 * two-phase eruption (the showcase's dimensioning, scaled to the god game):
 *
 * - Head is dimensioned against the ASCENT cost — (chamber depth + target cone
 *   height + chamber radius) × 1.2 — because routing cost is one head unit per
 *   cell of climb plus per-cell resistance. A fixed head below the ascent cost
 *   never surfaces at all (measured: head 22 vs ascent ≈ 92 → zero cone).
 * - Phase 1, FOUNTAIN (frames 0–150): high head (≥100), surplus converted to
 *   launch velocity → ballistic ejecta → airborne cooling → TEPHRA cone.
 * - Phase 2, EFFUSION (frames 150–500): same head but zero velocity
 *   efficiency, so lava wells out and runs downslope, freezing into new ROCK.
 * - Both phases then stop: the eruption settles into land.
 */
const CHAMBER_R = 18, CHAMBER_DEPTH = 34;
const CONE_TARGET = 24; // cells of edifice the head must be able to climb
const PARCELS = 3;      // parcels per frame the head budget must afford
const SURPLUS = 80;     // surplus head per parcel → Torricelli launch speed
const FOUNTAIN_FRAMES = 300;
const EFFUSION_FRAMES = 500;

function openVolcano(engine: PixelEngine, angle: number): number {
  const ux = Math.cos(angle), uy = Math.sin(angle);

  // NOTE: no carved mouth. An open crater lets the fountain's own fallback
  // tephra rain back down the conduit (tephra is lighter than lava but sinks
  // through the frozen throat), choke the chamber, and kill the source cell —
  // measured: chamber full of tephra, effusion discharged ZERO. Instead, let
  // the source seal behind rock and FRACTURE its own vent open (the engine's
  // designed seal-then-pop path; fracture cap 18 beats rock strength 15).

  const chx = Math.round(CX + ux * (R - CHAMBER_DEPTH));
  const chy = Math.round(CY + uy * (R - CHAMBER_DEPTH));
  const hot: number[] = [];
  const cell = (x: number, y: number) => {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
    engine.setMaterial(x, y, MaterialType.LAVA);
    hot.push(y * SIZE + x);
  };
  engine.beginBulk();
  for (let y = chy - CHAMBER_R; y <= chy + CHAMBER_R; y++) {
    for (let x = chx - CHAMBER_R; x <= chx + CHAMBER_R; x++) {
      const dx = x - chx, dy = y - chy;
      if (dx * dx + dy * dy <= CHAMBER_R * CHAMBER_R) cell(x, y);
    }
  }
  for (let t = 0; t <= CHAMBER_DEPTH - CHAMBER_R; t++) {
    const px = Math.round(CX + ux * (R - t));
    const py = Math.round(CY + uy * (R - t));
    cell(px, py);
    cell(Math.round(px + uy), Math.round(py - ux));
    cell(Math.round(px - uy), Math.round(py + ux));
  }
  engine.endBulk();
  for (const idx of hot) engine.setHeat(idx % SIZE, (idx / SIZE) | 0, 1.0);

  const ascent = Math.ceil((CHAMBER_DEPTH + CONE_TARGET + CHAMBER_R) * 1.2);
  // Phase 1: the fountain. Head is REFILLED IN FULL EVERY FRAME and must
  // afford PARCELS launches, each costing the ascent climb plus the surplus
  // that Torricelli-converts to speed: speed = √(2·surplus)·efficiency.
  // A head budget sized for one launch throttles the jet to ~1 parcel/frame
  // however high `rate` is set (measured).
  return engine.addPressureSource({
    x: chx, y: chy,
    material: MaterialType.LAVA,
    rate: PARCELS,
    pressureRate: (ascent + SURPLUS) * PARCELS,
    maxPressure: (ascent + SURPLUS) * PARCELS,
    maxPending: 5,
    maxDischargePerFrame: PARCELS,
    outletVelocityEfficiency: 0.7,
    outletLateralSpread: 0.55,
    temperature: 1.0,
    ventAnchor: { cx: CX, cy: CY, angle, corridorRadius: 3 },
    fracture: { minSealedFrames: 6, pressureRate: 3, maxPressure: 18 },
  });
}

/**
 * Keep the volcano's throat molten: remelt fallback tephra in the narrow
 * corridor (crater + upper conduit, |tangent| ≤ 2) back to hot lava. Without
 * this, raining ejecta plugs the vent, the throat freezes to rock, and the
 * buried source dies (measured: effusion discharge 0 for 500 frames). The
 * cone outside the throat is never touched.
 */
function remeltThroat(engine: PixelEngine, angle: number) {
  const ux = Math.cos(angle), uy = Math.sin(angle);
  for (let t = -8; t <= 16; t++) {
    for (let w = -2; w <= 2; w++) {
      const x = Math.round(CX + ux * (R - t) - uy * w);
      const y = Math.round(CY + uy * (R - t) + ux * w);
      if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue;
      if (engine.getMaterial(x, y) === MaterialType.TEPHRA) {
        engine.setMaterial(x, y, MaterialType.LAVA);
        engine.setHeat(x, y, 1.0);
      }
    }
  }
}

/**
 * Edifice height above the original surface, measured over the strip within
 * ±5 cells of the vent axis (the corridor's footprint). Host-side cap check —
 * the engine has no maxHeight because "nothing removes material", so an
 * uncapped fountain feeds a chimney that runs away vertically (measured: 66
 * cells and climbing when the criteria want a ~22-cell cone).
 */
function edificeHeight(engine: PixelEngine, angle: number): number {
  const ux = Math.cos(angle), uy = Math.sin(angle);
  let maxH = 0;
  for (let t = 1; t <= 80; t++) {
    for (let w = -5; w <= 5; w++) {
      const x = Math.round(CX + ux * (R + t) - uy * w);
      const y = Math.round(CY + uy * (R + t) + ux * w);
      if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) continue;
      // Count only BUILT edifice (tephra, frozen rock) — the lava jet and
      // active flows are transient; measuring them caps the fountain the
      // moment it starts throwing.
      if (isTerrainSolid(engine.getMaterial(x, y))) {
        if (t > maxH) maxH = t;
        break;
      }
    }
  }
  return maxH;
}

/** Phase controller: swap the fountain source for the effusive one on schedule. */
function createVolcanoController(engine: PixelEngine, angle: number) {
  let fountainId = openVolcano(engine, angle);
  let effusionId: number | null = null;
  let started = false;
  const ascent = Math.ceil((CHAMBER_DEPTH + CONE_TARGET + CHAMBER_R) * 1.2);
  const switchToEffusion = () => {
    started = true;
    engine.removePressureSource(fountainId);
    const ux = Math.cos(angle), uy = Math.sin(angle);
    const chx = Math.round(CX + ux * (R - CHAMBER_DEPTH));
    const chy = Math.round(CY + uy * (R - CHAMBER_DEPTH));
    // Phase 2: extrusion. Same ascent-dimensioned head (refilled in full
    // each frame, sized for PARCELS flows) but ZERO velocity efficiency —
    // surplus stays head, so lava wells out and runs downslope instead of
    // launching, and freezes into new rock. The corridor tracks the cone's
    // growth (axis to any height), so flows spill from the summit downslope.
    effusionId = engine.addPressureSource({
      x: chx, y: chy,
      material: MaterialType.LAVA,
      rate: PARCELS,
      pressureRate: ascent * PARCELS + 12,
      maxPressure: ascent * PARCELS + 12,
      maxPending: 5,
      maxDischargePerFrame: PARCELS,
      outletVelocityEfficiency: 0,
      outletLateralSpread: 0.25,
      temperature: 1.0,
      ventAnchor: { cx: CX, cy: CY, angle, corridorRadius: 3 },
      fracture: { minSealedFrames: 6, pressureRate: 3, maxPressure: 18 },
    });
  };
  return {
    step(frame: number) {
      // Keep the throat clear of fallback tephra while the volcano runs.
      if (frame % 20 === 0 && frame <= FOUNTAIN_FRAMES + EFFUSION_FRAMES) {
        remeltThroat(engine, angle);
      }
      if (!started) {
        // Cut the fountain at the scheduled end OR when the edifice reaches
        // the cap — whichever comes first. An uncapped fountain builds a
        // chimney, not a cone.
        if (frame >= FOUNTAIN_FRAMES) {
          switchToEffusion();
        } else if (frame % 15 === 0 && edificeHeight(engine, angle) >= CONE_TARGET - 2) {
          switchToEffusion();
        }
      }
      if (started && effusionId !== null && frame >= FOUNTAIN_FRAMES + EFFUSION_FRAMES) {
        engine.removePressureSource(effusionId);
        effusionId = null;
      }
    },
  };
}

interface VolcanoMetrics {
  chamberDeepLava: number;     // criterion 1
  surfaceLavaCheckpoints: number; // criterion 2
  airborneHighLava: number;    // criterion 3
  tephra: number;              // criterion 4
  tephraSpread: number;        // criterion 5
  coneMaxHeight: number;       // criterion 6a
  coneBinsRaised: number;      // criterion 6b
  coneBins: number[];          // diagnostic: per-bin max height
  coneVolume: number;          // criterion 6c
  rockGain: number;            // criterion 7
  finalSurfaceLava: number;    // criterion 8
}

function measure(engine: PixelEngine, ux: number, uy: number, initialRock: number, final: boolean): VolcanoMetrics {
  const g = engine.grid;
  let chamberDeepLava = 0, airborneHighLava = 0, tephra = 0, tephraSpread = 0, rock = 0;
  let surfaceLava = 0;
  let coneMaxHeight = 0, coneVolume = 0;
  const BINS = 11, BIN_W = 4;
  const binHeights = new Array<number>(BINS).fill(0);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const m = g[y * SIZE + x];
      if (m === MaterialType.EMPTY) continue;
      const dx = x - CX, dy = y - CY;
      const rad = Math.hypot(dx, dy);
      // Signed tangent offset from the vent axis.
      const s = -dx * uy + dy * ux;

      if (m === MaterialType.ROCK) rock++;
      if (m === MaterialType.LAVA) {
        if (rad < R - 10) chamberDeepLava++;
        if (rad > R + 2) surfaceLava++;
        if (rad > R + 8) airborneHighLava++;
      }
      if (m === MaterialType.TEPHRA) {
        tephra++;
        if (Math.abs(s) >= 10) tephraSpread++;
      }
      // Cone edifice: solid material above the old surface, near the axis.
      if (final && Math.abs(s) <= 22 && rad > R + 3 &&
          (m === MaterialType.TEPHRA || m === MaterialType.ROCK || m === MaterialType.LAVA)) {
        const h = rad - R;
        if (h > coneMaxHeight) coneMaxHeight = h;
        coneVolume++;
        const bin = Math.floor((s + 22) / BIN_W);
        if (bin >= 0 && bin < BINS && h > binHeights[bin]) binHeights[bin] = h;
      }
    }
  }
  return {
    chamberDeepLava,
    surfaceLavaCheckpoints: surfaceLava >= 5 ? 1 : 0,
    airborneHighLava,
    tephra,
    tephraSpread,
    coneMaxHeight,
    coneBinsRaised: binHeights.filter((h) => h >= 4).length,
    coneBins: binHeights,
    coneVolume,
    rockGain: rock - initialRock,
    finalSurfaceLava: final ? surfaceLava : 0,
  };
}

function best<T>(samples: T[], pick: (m: T) => number): number {
  return samples.reduce((acc, m) => Math.max(acc, pick(m)), 0);
}

describe('god-game volcano acceptance (brief §8.2 recipe)', () => {
  let metrics: VolcanoMetrics[] = [];
  let initialRock = 0;

  beforeAll(() => {
    const engine = buildWorld();
    // measure() with baseline 0 reports rockGain = total rock count.
    initialRock = measure(engine, Math.cos(ANGLE), Math.sin(ANGLE), 0, false).rockGain;
    const volcano = createVolcanoController(engine, ANGLE);
    for (let f = 1; f <= FRAMES; f++) {
      volcano.step(f);
      engine.update();
      if (f % CHECK_EVERY === 0) {
        metrics.push(measure(engine, Math.cos(ANGLE), Math.sin(ANGLE), initialRock, f === FRAMES));
      }
    }
  }, 120_000);

  it('1. has a buried magma chamber (≥150 deep lava cells)', () => {
    expect(best(metrics, (m) => m.chamberDeepLava)).toBeGreaterThanOrEqual(150);
  });

  it('2. sustains vent activity (≥5 surface lava cells at ≥3 checkpoints)', () => {
    const checkpoints = metrics.reduce((acc, m) => acc + m.surfaceLavaCheckpoints, 0);
    expect(checkpoints).toBeGreaterThanOrEqual(3);
  });

  it('3. throws ballistic ejecta (≥8 lava cells ≥8 cells above the surface)', () => {
    expect(best(metrics, (m) => m.airborneHighLava)).toBeGreaterThanOrEqual(8);
  });

  it('4. fragments ejecta into tephra (≥150 cells)', () => {
    expect(best(metrics, (m) => m.tephra)).toBeGreaterThanOrEqual(150);
  });

  it('5. spreads ejecta across the flanks (≥25 tephra cells ≥10 off-axis)', () => {
    expect(best(metrics, (m) => m.tephraSpread)).toBeGreaterThanOrEqual(25);
  });

  it('6a. builds a cone at least 10 cells tall', () => {
    expect(metrics[metrics.length - 1].coneMaxHeight).toBeGreaterThanOrEqual(10);
  });

  it('6b. builds a mound, not a spike (≥8 of 11 tangent bins raised ≥4)', () => {
    expect(metrics[metrics.length - 1].coneBinsRaised).toBeGreaterThanOrEqual(8);
  });

  it('6c. builds ≥250 cells of cone volume', () => {
    expect(metrics[metrics.length - 1].coneVolume).toBeGreaterThanOrEqual(250);
  });

  it('7. freezes into new land (rock gain ≥150)', () => {
    expect(metrics[metrics.length - 1].rockGain).toBeGreaterThanOrEqual(150);
  });

  it('8. settles: ≤12 lava cells above the surface at the end', () => {
    expect(metrics[metrics.length - 1].finalSurfaceLava).toBeLessThanOrEqual(12);
  });

  it('9. is deterministic (byte-identical grid at frame 600)', () => {
    const a = buildWorld();
    const b = buildWorld();
    const va = createVolcanoController(a, ANGLE);
    const vb = createVolcanoController(b, ANGLE);
    for (let f = 1; f <= 600; f++) { va.step(f); vb.step(f); a.update(); b.update(); }
    expect(Array.from(a.grid)).toEqual(Array.from(b.grid));
  }, 60_000);
});
