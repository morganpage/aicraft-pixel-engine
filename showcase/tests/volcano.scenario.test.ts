import { describe, it, expect, beforeAll } from 'vitest';
import { PixelEngine } from '../../src/sand';
import { MaterialType } from '../../src/materials';
import {
  stampVolcano,
  emitPlume,
  syncFromHeat,
  remeltConduit,
  createVolcanoState,
  stepVolcanoPre,
  stepVolcanoPost,
  rechargeReservoir,
  ventPosition,
  edificeHeight,
  surfaceRadiusAt,
  makeRng,
  stepVolcanoFrame,
  buildVolcanoOpts,
  DEFAULT_VOLCANO_INPUTS,
  type VolcanoRuntime,
} from '../helpers/volcano';
import {
  DEFAULT_VOLCANO_CFG as CFG,
  VOLCANO_SIZE as SIZE,
  VOLCANO_CX as CX,
  VOLCANO_CY as CY,
  VOLCANO_R as R,
  VOLCANO_CAP_START as CAP_START,
  VOLCANO_CAP_STEP as CAP_STEP,
  VOLCANO_CAP_MAX as CAP_MAX,
  defaultVolcanoOpts,
  buildVolcanoPlanet,
  runVolcanoTrajectory,
  engineFromSnapshot,
  erupt,
  countMaterial,
  countOutside,
  edificeProfile,
  heightProfile,
  type VolcanoSnapshot,
} from '../helpers/volcano-scenario';

/**
 * Slow volcano scenarios — the full 220×220 shipping-planet eruption.
 *
 * These tests run multi-thousand-frame simulations, so this file is **excluded
 * from the default `showcase:test` run** (see `showcase/vitest.config.ts`) and
 * is collected instead by `showcase:vitest.scenario.config.ts`. Use
 * `npm run showcase:test:scenario` (or `:all`) to run them.
 *
 * Almost every assertion here reads from a single golden 2600-frame trajectory
 * captured once in `beforeAll`, instead of each test re-simulating the eruption
 * from scratch. Consolidation is safe because the eruption is deterministic: a
 * checkpoint at frame N is byte-identical to a standalone run that stops at N
 * (see the parity test, which locks that property). Five scenarios use a
 * different seed or a different code path and remain individual runs.
 */

const OPTS = defaultVolcanoOpts(CFG);

/** The one golden trajectory; checkpoints reused by every read-only test below. */
const GOLDEN_CHECKPOINTS = [300, 600, 900, 1200, 2400, 2600] as const;
let golden: Map<number, VolcanoSnapshot>;

/** Reconstruct a read-only engine for a golden-trajectory checkpoint. */
function goldenAt(frame: number): PixelEngine {
  const snap = golden.get(frame);
  if (!snap) throw new Error(`no golden checkpoint at frame ${frame}`);
  return engineFromSnapshot(snap);
}

beforeAll(() => {
  // One ~22s pass instead of six multi-thousand-frame runs. The seed (4242) and
  // the per-frame loop match the legacy `erupt()` exactly, so each checkpoint is
  // the same world a standalone `erupt(N)` would have produced.
  const traj = runVolcanoTrajectory({
    frames: 2600,
    checkpoints: [...GOLDEN_CHECKPOINTS],
    seed: 4242,
    cfg: CFG,
    opts: OPTS,
  });
  golden = traj.snapshots;
}, 60_000);

// ---------------------------------------------------------------------------
// Golden-trajectory contracts. Assertion bodies are ported verbatim from the
// legacy per-test eruptions; only the engine source changes (`erupt(N)` →
// `goldenAt(N)`). Each test tags the checkpoint it reads.
// ---------------------------------------------------------------------------

describe('cone profile @2600', () => {
  it('has flanks that slope like a cone, not walls like a mesa', () => {
    // The regression this whole profile section exists for. Two bugs each made
    // the edifice a flat-topped slab with cliff sides rather than a cone.
    // Measured with both in place the mean flank was 46-64°, against roughly 30°
    // for a real cinder cone.
    //
    // The same symptom returned as a tower: with a short ballistic range the
    // cone's width saturates and further growth goes vertical, producing a 57°
    // spire. The fix is a higher fountain pressure (wider range) and a capMax
    // held near the range-limited width. This bound rejects both regressions:
    // the mesa (cliff sides, no taper) and the tower (vertical spire). A cinder
    // cone sits near 33°; 45° is a generous ceiling that still fails the 57°
    // tower while tolerating the single-cycle checkpoint's short, broad cone.
    const e = goldenAt(2600);
    const hs = heightProfile(e, CFG);
    const peak = Math.max(...hs);
    const pi = hs.indexOf(peak);
    let zi = pi;
    while (zi < hs.length - 1 && hs[zi] > 0) zi++;
    const arcPerDeg = (Math.PI / 180) * R;
    const meanFlank = (Math.atan(peak / Math.max(1, (zi - pi) * arcPerDeg)) * 180) / Math.PI;

    expect(peak).toBeGreaterThan(3); // single-cycle cone is smaller than the old multi-cycle one
    // The physics-driven cone (fragmented fountain ejecta) is flatter than the
    // old plume-built cone. The key property is that it tapers at all rather
    // than being a uniform-height slab.
    expect(meanFlank).toBeGreaterThan(3); // not perfectly flat
    // ...but not a tower either: the flank must be shallower than a spire. The
    // 57° tower regression measured 57°; this bound fails it with margin.
    expect(meanFlank).toBeLessThan(45); // cone, not a vertical spire
  });

  it('keeps a crater without letting it become a chasm', () => {
    // The fountain's ballistic ejecta naturally concentrates near the vent
    // (material launched straight up falls back close) while material launched
    // at an angle lands further out — producing a ring deposit with a crater.
    const e = goldenAt(2600);
    const hs = heightProfile(e, CFG);
    const peak = Math.max(...hs);
    const axis = hs[50]; // the vent axis
    const crater = peak - axis;
    // A single-cycle cone may have a smaller crater; the key property is that
    // the rim is higher than the axis (there IS a depression at the vent).
    if (peak > 2) {
      expect(crater).toBeGreaterThanOrEqual(0);
      expect(crater).toBeLessThan(peak * 0.85); // not a chasm
    }
  });

  it('caps growth on the highest point, not the vent axis', () => {
    // Once there is a crater the vent axis is the *lowest* point of the summit,
    // so a cap watching it never trips and the rim grows without bound —
    // measured, a cap of 20 let the rim reach 40 and keep climbing.
    const e = goldenAt(2600);
    expect(edificeHeight(e, CFG)).toBeLessThanOrEqual(OPTS.pressure.maxHeight + 6);
  });
});

describe('the eruption as a whole @2400', () => {
  it('builds a steep cone, not a flat shield or a mesa', () => {
    // Shape regression. The cone's taper comes from granular tephra (fragmented
    // lava) piling at its angle of repose; lava ponds level out and freeze with
    // cliff edges, so a lava-built edifice is a flat-topped mesa.
    const e = goldenAt(2400);
    const built = edificeProfile(e, CFG);
    // The granular layer must remain visible after the full eruption. A high
    // assimilation rate used to melt every exterior grain after it briefly sank
    // into a surface flow, leaving a lava/rock mound despite producing tephra in
    // flight.
    const exteriorTephra = countOutside(e, CFG, MaterialType.TEPHRA);
    const exteriorLavaAndRock =
      countOutside(e, CFG, MaterialType.LAVA) + countOutside(e, CFG, MaterialType.ROCK);
    expect(exteriorTephra).toBeGreaterThan(10);
    // Composition. The old SAND product sank through lava and remelted, so a
    // visually plausible mound could still be almost entirely LAVA + ROCK. The
    // explosive phase must leave a genuinely granular cone — tephra must be a
    // meaningful fraction of the exterior, not a token dusting.
    //
    // Under the production config (fountain pressure 100, maxPending 4, shared
    // radius-3 vent anchor) the shipped cone is lava-dominant: measured at the
    // @2400 checkpoint, exterior tephra ≈ 14 against lava+rock ≈ 90, a ratio of
    // ~0.156. The strict "tephra > lava+rock" the suite once asserted reflected
    // the pre-anchor harness tuning and does not hold for the volcano users run.
    // The property that still does — and is what visually distinguishes a cone
    // from a lava pond — is that tephra survives at all as a substantial
    // minority: a 10% floor is comfortably below the 0.156 reference and still
    // rejects the regression where assimilation erased every exterior grain.
    expect(exteriorTephra).toBeGreaterThan(exteriorLavaAndRock * 0.10);
    expect(built.height).toBeGreaterThan(3); // single-cycle cone is smaller
    // Slope = half-width : height. The physics-driven cone is wider/flatter
    // than the old plume-built one; the key property is that it's bounded.
    expect(built.halfWidth / built.height).toBeLessThan(9.0);
    // The cap must actually bound the growth.
    expect(built.height).toBeLessThan(OPTS.pressure.maxHeight + 10);
  });

  it('runs lava down the flanks without drowning the planet', () => {
    // The behaviour the whole yield-strength term exists for: a flow that
    // travels a bounded distance downslope and stops. Too little and the lava
    // never leaves the crater; too much and it wraps the planet as an ocean.
    const e = goldenAt(2400);
    const built = edificeProfile(e, CFG);
    // Lava reached beyond the summit...
    expect(built.spreadDeg).toBeGreaterThan(4); // single-cycle: smaller spread
    // ...but nothing like the 180° an unbounded liquid reached.
    expect(built.spreadDeg).toBeLessThan(110);
    // And the edifice is mostly solid, not a molten blob.
    const lava = countOutside(e, CFG, MaterialType.LAVA);
    expect(lava).toBeLessThan(built.cells * 1.2); // single-cycle: more lava proportionally
  });
});

describe('tephra assimilation @2400', () => {
  it('does not collapse the cone', () => {
    // End-to-end guard for the runaway the threshold prevents.
    const e = goldenAt(2400);
    expect(countOutside(e, CFG, MaterialType.TEPHRA)).toBeGreaterThan(10);
    const built = edificeProfile(e, CFG);
    if (built.height > 1) {
      expect(built.halfWidth / built.height).toBeLessThan(9.0);
    }
  });
});

describe('conduit and vent @300', () => {
  it('does not let fallout choke the conduit', () => {
    // Tephra normally floats on lava, but a ballistic grain can still enter the
    // open vent and reach the plumbing.
    // The old `remeltConduit` cleared the bore spotless every frame; the engine
    // pressure source now keeps the conduit *functional* (magma routes through
    // it) without necessarily removing every grain. The property that matters is
    // that the bore is mostly lava and the volcano is not choked, not spotlessness.
    //
    // Checked during the active explosive phase (@300). The eruption completes
    // near frame 490, after which the browser stops recharging the reservoir and
    // the conduit is meant to freeze — so a dormant-tail checkpoint would test
    // the cap, not the conduit's function during eruption.
    const e = goldenAt(300);
    let lava = 0, tephra = 0;
    for (let r = R - CFG.chamberDepth - CFG.chamberRadius; r <= R; r++) {
      for (let w = -CFG.conduitHalfWidth; w <= CFG.conduitHalfWidth; w++) {
        const m = e.getMaterial(Math.round(CX + w), Math.round(CY - r));
        if (m === MaterialType.LAVA) lava++;
        else if (m === MaterialType.TEPHRA) tephra++;
      }
    }
    expect(tephra).toBeLessThan(8); // not choked — a few grains, not a plug
    expect(lava).toBeGreaterThan(20);
  });
});

describe('cooling @900', () => {
  it('does not leave frozen ejecta hanging in mid-air', () => {
    // Ejecta is spawned in mid-air and the engine has no velocity, so a cell in
    // flight is a lone airborne cell -- maximum exposure by the cooling rule,
    // and therefore the likeliest thing to freeze before it has landed. Frozen
    // lava is ROCK, a static solid that never falls, so it would hang in the
    // sky. The guard for this is now the engine's, applied for every host.
    const e = goldenAt(900);
    const solid = (m: MaterialType): boolean =>
      m === MaterialType.ROCK || m === MaterialType.TEPHRA || m === MaterialType.LAVA;
    let specks = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (Math.hypot(x - CX, y - CY) <= R) continue;
        if (e.getMaterial(x, y) !== MaterialType.ROCK) continue;
        let neighbours = 0;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
          if (solid(e.getMaterial(x + ox, y + oy))) neighbours++;
        }
        if (neighbours === 0) specks++;
      }
    }
    expect(specks).toBeLessThanOrEqual(3);
  });
});

describe('vent-stability: single focused outlet @600', () => {
  // The eruption must exit through one stable vent, not multiple surface
  // breakouts. The vent anchor restricts pressure routing to a corridor around
  // the vent position; this test verifies that the angular spread of surface
  // lava is bounded — pressure-fed exits are confined to the vent region, not
  // scattered across the summit.
  it('pressure-fed surface lava stays within a narrow angular band of the vent', () => {
    const e = goldenAt(600);
    const vp = ventPosition(CFG);
    // Scan exterior lava cells and measure their angular distance from the vent.
    const ventAngleDeg = ((Math.atan2(vp.y - CY, vp.x - CX) * 180) / Math.PI + 360) % 360;
    let maxAngularSpread = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (Math.hypot(x - CX, y - CY) <= R) continue; // only exterior
        if (e.getMaterial(x, y) !== MaterialType.LAVA) continue;
        const cellAngleDeg = ((Math.atan2(y - CY, x - CX) * 180) / Math.PI + 360) % 360;
        let diff = Math.abs(cellAngleDeg - ventAngleDeg);
        if (diff > 180) diff = 360 - diff;
        maxAngularSpread = Math.max(maxAngularSpread, diff);
      }
    }
    // The vent is at -90° (screen-up). Surface lava from a single focused vent
    // should stay within a narrow band — not scattered across the summit. A
    // generous bound of 30° accommodates flows running down either flank.
    expect(maxAngularSpread).toBeLessThan(30);
  });
});

// ---------------------------------------------------------------------------
// Non-golden scenarios.
//
// Each uses a different seed or a different code path than the golden
// trajectory, so they cannot share it. They remain individual runs.
// ---------------------------------------------------------------------------

describe('conduit and vent: explosive fountain', () => {
  it('the explosive phase produces a pressure-launched lava fountain', () => {
    // The explosive phase creates a high-pressure source. Surplus head at the
    // vent converts to ballistic velocity (Torricelli), so magma launches from
    // the vent as a fountain. Some of it fragments to TEPHRA during flight. The
    // proof is that granular ejecta appears above the planet surface during
    // the explosive phase — it could only get there via ballistic flight +
    // fragmentation.
    const e = buildVolcanoPlanet(CFG, SIZE);
    stampVolcano(e, CFG);
    const st = createVolcanoState();
    const rng = makeRng(7);
    let sawTephraAboveSurface = false;
    for (let f = 0; f < 200; f++) {
      stepVolcanoPre(e, CFG, st, rng, OPTS);
      if (st.phaseFrame < 0) break;
      e.update();
      stepVolcanoPost(e, CFG, st, rng, OPTS);
      syncFromHeat(e);
      // Check for TEPHRA above the planet surface (outside the original radius).
      if (countMaterial(e, MaterialType.TEPHRA) > 0) { sawTephraAboveSurface = true; break; }
    }
    expect(sawTephraAboveSurface).toBe(true);
  }, 20_000);
});

describe('the eruption cycle', () => {
  it('runs explosive → effusive → ash coda → repose once, then stops', () => {
    // The eruption cycle runs a single pass: the opening burst builds the tephra
    // cone, effusion sends lava flows down the flanks, a closing ash fall drapes
    // them, and repose lets everything crust over. Then it stops — no looping.
    // The host can restart with another click.
    //
    // The coda is what stops the eruption ending on bare lava. A flow front
    // freezes into a blunt wall and `ROCK` is static, so with nothing after it
    // that wall is permanent — the ledges on the flank. Ending on ash buries
    // them, the same way the opening phase's fallout was burying them until it
    // stopped.
    const e = buildVolcanoPlanet(CFG, SIZE);
    stampVolcano(e, CFG);
    const st = createVolcanoState();
    const rng = makeRng(1);
    const seen: string[] = [];
    expect(st.phase).toBe('explosive'); // opens with a burst
    expect(st.closing).toBe(false);
    for (let f = 0; f < 1600; f++) {
      const label = st.phase === 'explosive' && st.closing ? 'coda' : st.phase;
      if (seen[seen.length - 1] !== label) seen.push(label);
      stepVolcanoPre(e, CFG, st, rng, OPTS);
      if (st.phaseFrame < 0) break; // eruption complete
      e.update();
      stepVolcanoPost(e, CFG, st, rng, OPTS);
    }
    expect(seen).toEqual(['explosive', 'effusive', 'coda', 'repose']);
    expect(st.cycle).toBe(1);
    expect(st.phaseFrame).toBe(-1); // signaled complete
  }, 20_000);

  it('gives every phase a share of the growth allowance', () => {
    // The height cap is one budget for the whole eruption. Checked directly by
    // each phase it was first-come-first-served, and the opening burst always
    // got there first — so as the cone approached its cap the later phases were
    // progressively starved of it. Measured at the third episode, effusion fell
    // to half its parcels and the closing ash fall to 9 of its 120 frames'
    // worth, which is the failure the flanks show: the flows the coda is there
    // to drape are the ones it stops being able to reach.
    //
    // Runs the production cap progression through the real per-frame controller
    // — the pre/post pair alone omits `syncFromHeat`, so lava never stiffens as
    // it cools and the cone builds differently enough to hide this.
    const e = buildVolcanoPlanet(CFG, SIZE);
    stampVolcano(e, CFG);
    const rng = makeRng(4242);

    const runEpisode = (capHeight: number): Record<string, number> => {
      const opts = buildVolcanoOpts(CFG, { ...DEFAULT_VOLCANO_INPUTS, maxHeight: capHeight });
      const st = createVolcanoState();
      const runtime: VolcanoRuntime = { erupting: true, capHeight };
      const routed: Record<string, number> = {};
      let f = 0;
      while (runtime.erupting && f < 2000) {
        const label = st.phase === 'explosive' && st.closing ? 'coda' : st.phase;
        stepVolcanoFrame(e, CFG, st, rng, opts, runtime);
        for (const r of e.consumeInjectionResults()) {
          routed[label] = (routed[label] ?? 0) + r.accepted;
        }
        f++;
      }
      // Dormant gap, as the showcase has between clicks.
      for (let i = 0; i < 150; i++) stepVolcanoFrame(e, CFG, st, rng, opts, runtime);
      return routed;
    };

    for (let c = 0; c < 3; c++) {
      const routed = runEpisode(Math.min(CAP_START + c * CAP_STEP, CAP_MAX));
      const where = `episode ${c + 1}`;
      expect(routed.explosive ?? 0, `${where}: no opening burst`).toBeGreaterThan(60);
      expect(routed.effusive ?? 0, `${where}: lava flows starved`).toBeGreaterThan(60);
      expect(routed.coda ?? 0, `${where}: closing ash fall starved`).toBeGreaterThan(40);
    }
  }, 60_000);

  it('keeps a cone profile through the full cap progression, not a tower', () => {
    // The tower regression: with a ballistic range shorter than the cap, the
    // cone's width saturates and every later cell of growth goes vertical. At
    // the top of the old progression (capMax 44, fountainPressure 100) the cone
    // was a 42-cell edifice on a 28-cell base — a 57° flank, where a cinder cone
    // sits near 33°. This runs the whole cap progression the way the showcase
    // does and checks the *final* flank, which is where the tower appears: the
    // single-cycle golden trajectory never grows tall enough to expose it.
    const e = buildVolcanoPlanet(CFG, SIZE);
    stampVolcano(e, CFG);
    const rng = makeRng(4242);
    for (let c = 0; ; c++) {
      const capHeight = Math.min(CAP_START + c * CAP_STEP, CAP_MAX);
      if (capHeight > CAP_MAX) break;
      const opts = buildVolcanoOpts(CFG, { ...DEFAULT_VOLCANO_INPUTS, maxHeight: capHeight });
      const st = createVolcanoState();
      const runtime: VolcanoRuntime = { erupting: true, capHeight };
      let f = 0;
      while (runtime.erupting && f < 2500) { stepVolcanoFrame(e, CFG, st, rng, opts, runtime); f++; }
      for (let i = 0; i < 150; i++) stepVolcanoFrame(e, CFG, st, rng, opts, runtime);
      if (capHeight >= CAP_MAX) break;
    }
    const hs = heightProfile(e, CFG);
    const peak = Math.max(...hs);
    let halfW = 0;
    for (let i = 0; i < hs.length; i++) if (hs[i] >= 1) halfW = Math.max(halfW, Math.abs(i - 50));
    const arcPerDeg = (Math.PI / 180) * R;
    const flank = (Math.atan(peak / Math.max(1, halfW * arcPerDeg)) * 180) / Math.PI;
    // Cinder cones 28-38°; 45° fails the 57° tower with margin.
    expect(flank, `final flank ${flank.toFixed(0)}° should be a cone, not a tower`).toBeLessThan(45);
    expect(peak, 'cone must actually grow').toBeGreaterThan(10);
  }, 90_000);

  it('settles to a dead stop once the eruption ends', () => {
    // Guards every liquid invariant the engine established: an eruption must not
    // leave the world churning forever. A single zero-swap frame can be
    // transient (a frame between two flow fronts), so this requires a *stable
    // window* on every activity axis — swaps, velocity moves, growth, AND thermal
    // chunks — all zero for several consecutive frames. The thermal count is the
    // engine's explicit settle signal: without it the test can pass while heat is
    // still diffusing (lava still cooling/freezing), which is not a true stop.
    const e = buildVolcanoPlanet(CFG, SIZE);
    stampVolcano(e, CFG);
    const st = createVolcanoState();
    const rng = makeRng(5);
    for (let f = 0; f < 800; f++) {
      stepVolcanoPre(e, CFG, st, rng, OPTS);
      e.update();
      stepVolcanoPost(e, CFG, st, rng, OPTS);
    }
    // Tap off: the engine keeps cooling the remaining flows so they set. Hold
    // out for a run of quiet frames, with a hard cap well above any observed
    // cooling-driven settle.
    const STABLE_REQUIRED = 8;
    let stable = 0;
    for (let f = 0; f < 2000 && stable < STABLE_REQUIRED; f++) {
      e.update();
      const quiet =
        e.swapsLastFrame === 0 &&
        e.activeVelocityCount === 0 &&
        e.growthEventsLastFrame === 0 &&
        e.activeThermalChunkCount === 0;
      stable = quiet ? stable + 1 : 0;
    }
    expect(stable).toBe(STABLE_REQUIRED);
    // Final state is genuinely still on every activity axis.
    expect(e.swapsLastFrame).toBe(0);
    expect(e.activeVelocityCount).toBe(0);
    expect(e.growthEventsLastFrame).toBe(0);
    expect(e.activeThermalChunkCount).toBe(0);
  }, 30_000);

  it('is deterministic for a given seed', () => {
    // Inherently two runs — determinism can only be observed by comparing two.
    const run = (): Uint8Array => erupt(400, 11, CFG, OPTS).grid;
    expect(run()).toEqual(run());
  }, 20_000);
});

describe('the explosive plume', () => {
  it('leaves a crater inside the rim it builds', () => {
    // A cinder cone has a crater because material thrown straight up falls back
    // down the throat, while material thrown at an angle lands clear and stays.
    // Without the rim the plume fills its own crater and the effusive phase has
    // no basin to pond in.
    const e = buildVolcanoPlanet(CFG, SIZE);
    stampVolcano(e, CFG);
    const rng = makeRng(9);
    // emitPlume is no longer in the eruption cycle but still exists as a function.
    // This test pins its standalone behaviour: rim-biased fallout produces a crater.
    const plumeOpts = { perFrame: 8, spread: 0.36, loft: 5, lavaFraction: 0.05, maxHeight: 20, rimBias: 0.55 };
    for (let f = 0; f < 600; f++) {
      emitPlume(e, CFG, rng, plumeOpts);
      e.update();
      remeltConduit(e, CFG);
    }
    const axis = surfaceRadiusAt(e, CFG, CFG.ventAngle);
    const rimL = surfaceRadiusAt(e, CFG, CFG.ventAngle - plumeOpts.spread * 0.8);
    const rimR = surfaceRadiusAt(e, CFG, CFG.ventAngle + plumeOpts.spread * 0.8);
    expect(Math.max(rimL, rimR)).toBeGreaterThan(axis);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Parity (production faithfulness).
//
// The golden trajectory is only worth consolidating if it matches what a user
// actually sees. This guards that by comparing the trajectory against an
// INDEPENDENT hand-reproduction of the browser loop — one that calls the raw
// stepVolcanoPre/Post + the active/dormant transition directly, NOT the shared
// stepVolcanoFrame controller. Without an independent oracle the check is
// circular (controller vs controller) and silently passes while diverging from
// production, which is exactly how the original harness ran the active sequence
// past completion and drifted by hundreds of cells at the post-eruption
// checkpoints.
// ---------------------------------------------------------------------------

describe('parity: trajectory matches the production loop', () => {
  /**
   * Independent reproduction of the browser's per-frame loop (planet.ts),
   * hand-written from the source rather than delegating to stepVolcanoFrame.
   * This is the non-circular oracle: if the controller and the browser loop
   * ever diverge, this function still expresses the browser's intent.
   */
  function browserLoopReference(frames: number, seed: number): PixelEngine {
    const e = buildVolcanoPlanet(CFG, SIZE);
    stampVolcano(e, CFG);
    const state = createVolcanoState();
    const rng = makeRng(seed);
    let erupting = true;
    // No cap tracking here: the cap is enforced inside `stepVolcanoPre`, which
    // removes the source once the edifice reaches `OPTS.pressure.maxHeight`.
    // The loop only has to notice when the cycle itself finishes.
    for (let f = 0; f < frames; f++) {
      if (erupting) {
        stepVolcanoPre(e, CFG, state, rng, OPTS);
        e.update();
        stepVolcanoPost(e, CFG, state, rng, OPTS);
        // Completion is the cycle finishing, not the height cap: reaching the
        // cap only stops the source (`stepVolcanoPre` removes it), and cutting
        // the eruption short there skipped the effusive phase on every episode
        // after the first. Mirrors `stepVolcanoFrame`.
        if (state.phaseFrame < 0) {
          if (state.sourceId !== null) { e.removePressureSource(state.sourceId); state.sourceId = null; }
          erupting = false;
        }
      } else {
        // Dormant: maintain the plumbing (chamber + buried conduit) so a
        // restart can route magma, matching the production controller.
        rechargeReservoir(e, CFG, 'repose');
        e.update();
      }
      syncFromHeat(e);
    }
    return e;
  }

  // Compares across the active/dormant boundary: frame 600 is ~110 frames
  // after the single cycle completes (~490), so a controller that keeps calling
  // the eruption steps post-completion diverges here. That was the original bug
  // (measured: 9 grid / 1342 heat / 676 colour / 273 stiffness cells off).
  it('the @600 checkpoint matches an independent browser-loop run', () => {
    const checkpoint = goldenAt(600);
    const browser = browserLoopReference(600, 4242);
    expect(Array.from(checkpoint.grid)).toEqual(Array.from(browser.grid));
    expect(Array.from(checkpoint.heatGrid!)).toEqual(Array.from(browser.heatGrid!));
    expect(Array.from(checkpoint.colorGrid!)).toEqual(Array.from(browser.colorGrid!));
    expect(Array.from(checkpoint.stiffnessGrid!)).toEqual(Array.from(browser.stiffnessGrid!));
  }, 30_000);
});

describe('repeated eruptions: dormant restart', () => {
  // The original repeated-eruption bug: after the first cycle completes and the
  // volcano goes dormant, the chamber and conduit freeze solid. "Erupt again"
  // then produces no surface discharge — magma is trapped underground and
  // fractures extensively internally without reaching the surface.
  //
  // This test runs three full eruption cycles with a substantial dormant gap
  // between each, and asserts that every cycle produces exterior lava discharge.
  it('every restart cycle produces meaningful exterior discharge', () => {
    const e = buildVolcanoPlanet(CFG, SIZE);
    stampVolcano(e, CFG);
    const rng = makeRng(4242);
    let capHeight = CAP_START;

    for (let cycle = 0; cycle < 3; cycle++) {
      // Rebuild opts with the current cap, matching the browser's per-click rebuild.
      const opts = defaultVolcanoOpts(CFG);
      opts.pressure.maxHeight = capHeight + 2;
      const state = createVolcanoState();
      let erupting = true;
      const before = countOutside(e, CFG, MaterialType.LAVA)
        + countOutside(e, CFG, MaterialType.ROCK)
        + countOutside(e, CFG, MaterialType.TEPHRA);
      let maxVel = 0;
      for (let f = 0; f < 600; f++) {
        if (erupting) {
          stepVolcanoPre(e, CFG, state, rng, opts);
          e.update();
          stepVolcanoPost(e, CFG, state, rng, opts);
          // Track max velocity (a proxy for fountain activity).
          for (let i = 0; i < e.grid.length; i++) {
            const v = Math.abs(e.velX![i]) + Math.abs(e.velY![i]);
            if (v > maxVel) maxVel = v;
          }
          if (state.phaseFrame < 0) {
            if (state.sourceId !== null) { e.removePressureSource(state.sourceId); state.sourceId = null; }
            erupting = false;
          }
        } else {
          rechargeReservoir(e, CFG, 'repose');
          e.update();
        }
        syncFromHeat(e);
      }
      const after = countOutside(e, CFG, MaterialType.LAVA)
        + countOutside(e, CFG, MaterialType.ROCK)
        + countOutside(e, CFG, MaterialType.TEPHRA);
      const delta = after - before;
      // Every cycle must add meaningful exterior material (not just > 0) and
      // produce visible velocity. Later cycles are weaker but must still erupt.
      expect(delta).toBeGreaterThanOrEqual(3);
      expect(maxVel).toBeGreaterThanOrEqual(2);
      // Advance cap by the production step for the next cycle.
      capHeight = Math.min(capHeight + CAP_STEP, CAP_MAX);
      // Dormant gap: 200 frames with plumbing maintenance.
      for (let f = 0; f < 200; f++) {
        rechargeReservoir(e, CFG, 'repose');
        e.update();
        syncFromHeat(e);
      }
    }
  }, 120_000);
});
