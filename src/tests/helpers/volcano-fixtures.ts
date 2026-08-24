/**
 * Headless volcano scenario harness.
 *
 * The showcase's per-frame eruption loop previously lived in three places: the
 * browser `setInterval` in `sections/planet.ts`, the `erupt()` helper inlined in
 * `tests/volcano.test.ts`, and (for a few standalone scenarios) the test bodies
 * themselves. This module is the single DOM-free home for that loop, so a
 * deterministic trajectory can be run once and its checkpoints reused by every
 * read-only assertion — instead of every test re-simulating thousands of frames
 * from scratch.
 *
 * The reason consolidation is safe is determinism: the per-frame RNG draws and
 * the engine step are a pure function of (seed, frame), so a snapshot captured
 * at frame N of a seeded run is byte-identical to a standalone `erupt(N)` that
 * stops at N. One golden 2600-frame trajectory with checkpoints therefore
 * replaces the six redundant multi-thousand-frame runs the old suite performed.
 *
 * DOM-free and deterministic; runs under Node. No browser, no canvas.
 */

import { PixelEngine } from '../../sand';
import { MaterialType } from '../../materials';
import { RadialGravity } from '../../gravity';
import {
  stampVolcano,
  createVolcanoState,
  stepVolcanoFrame,
  surfaceRadiusAt,
  buildVolcanoOpts,
  DEFAULT_VOLCANO_INPUTS,
  makeRng,
  type EruptionPhase,
  type VolcanoConfig,
  type VolcanoStepOptions,
  type VolcanoRuntime,
} from '../../volcano';

// ---------------------------------------------------------------------------
// Shipping-geometry fixtures.
//
// The showcase's own geometry (SIZE 220, planetRadius = floor(220 * 0.3) = 66).
// Shape assertions are only meaningful against the configuration that actually
// ships: the same angular spread on a smaller planet subtends a narrower cone,
// so a shrunken test planet quietly measures a steeper volcano than anyone will
// ever see. These constants are the single source of truth shared by the fast
// contract tests and the scenario tests.
// ---------------------------------------------------------------------------

export const VOLCANO_SIZE = 220;
export const VOLCANO_CX = 110;
export const VOLCANO_CY = 110;
export const VOLCANO_R = 66;

/** Cap progression values, matching `volcanoGeometryFor` for R=66. */
export const VOLCANO_CAP_START = 20;
export const VOLCANO_CAP_STEP = 8;
export const VOLCANO_CAP_MAX = 36;

/** The shipping volcano geometry, reproduced exactly by `volcanoGeometryFor`. */
export const DEFAULT_VOLCANO_CFG: VolcanoConfig = {
  centerX: VOLCANO_CX,
  centerY: VOLCANO_CY,
  planetRadius: VOLCANO_R,
  ventAngle: -Math.PI / 2,
  conduitHalfWidth: 1,
  chamberRadius: 8,
  chamberDepth: 26,
  // Matches volcanoGeometryFor at the shipping radius: max(60, capMax+10) where
  // capMax=36 → 60. The historical scan limit, now explicit.
  surfaceScanLimit: 60,
};

/**
 * Showcase eruption tuning — the production defaults, via the shared factory.
 *
 * Both the browser showcase and this headless harness build options through
 * {@link buildVolcanoOpts} so the golden trajectory tests the volcano users
 * actually run. The defaults are the production slider values on first load.
 */
export function defaultVolcanoOpts(cfg: VolcanoConfig = DEFAULT_VOLCANO_CFG): VolcanoStepOptions {
  return buildVolcanoOpts(cfg, DEFAULT_VOLCANO_INPUTS);
}

/**
 * Build the shipping planet: a 220×220 radial-gravity world with a radius-66
 * rock disc, heat enabled, and showcase fracture throughput. Matches the
 * showcase's `rebuildPlanet` construction exactly.
 */
export function buildVolcanoPlanet(
  cfg: VolcanoConfig = DEFAULT_VOLCANO_CFG,
  size: number = VOLCANO_SIZE,
): PixelEngine {
  const e = new PixelEngine({
    width: size,
    height: size,
    seed: 1,
    gravity: new RadialGravity({ centerX: cfg.centerX, centerY: cfg.centerY }),
    // The volcano runs on the engine's heat field: lava is born hot, cools by
    // exposure, and freezes to rock without the host doing anything.
    enableHeat: true,
    // Match the showcase: enough fractures/frame to reopen a frozen bore.
    fracturePerFrame: 4,
  });
  const { centerX: cx, centerY: cy, planetRadius: r } = cfg;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) e.setMaterial(x, y, MaterialType.ROCK);
    }
  }
  return e;
}

// ---------------------------------------------------------------------------
// Snapshots.
// ---------------------------------------------------------------------------

/** A captured phase transition in a trajectory's trace. */
export interface PhaseEvent {
  /** Absolute frame (1-based, post-step) at which the phase became active. */
  frame: number;
  phase: EruptionPhase;
}

/**
 * An immutable snapshot of the simulation at one frame.
 *
 * Deep copies of the four data grids plus the per-frame scalar, so the live
 * engine can keep advancing (or be discarded) without aliasing. Reconstruct a
 * read-only {@link PixelEngine} via {@link engineFromSnapshot}.
 */
export interface VolcanoSnapshot {
  frame: number;
  width: number;
  height: number;
  grid: Uint8Array;
  colorGrid: Uint32Array | null;
  stiffnessGrid: Uint8Array | null;
  heatGrid: Float32Array | null;
  /** `engine.swapsLastFrame` at the captured frame. Read from the snapshot; a reconstructed engine reports 0. */
  swapsLastFrame: number;
}

/** Capture an immutable snapshot of the engine's current state. */
export function snapshotEngine(engine: PixelEngine, frame: number): VolcanoSnapshot {
  return {
    frame,
    width: engine.width,
    height: engine.height,
    grid: Uint8Array.from(engine.grid),
    colorGrid: engine.colorGrid ? Uint32Array.from(engine.colorGrid) : null,
    stiffnessGrid: engine.stiffnessGrid ? Uint8Array.from(engine.stiffnessGrid) : null,
    heatGrid: engine.heatGrid ? Float32Array.from(engine.heatGrid) : null,
    swapsLastFrame: engine.swapsLastFrame,
  };
}

/**
 * Reconstruct a **read-only** {@link PixelEngine} from a snapshot, so every
 * existing helper (`surfaceRadiusAt`, `edificeHeight`, `countOutside`, …) works
 * unchanged against a captured frame.
 *
 * The engine is constructed *without* `enableHeat` and the heat grid is assigned
 * directly, which skips the O(cells) `allocHeat` seeding sweep — we already hold
 * the captured temperatures. The returned engine is never advanced (no
 * `update()` calls); assertion helpers only read it. A defensive copy is taken
 * so multiple reconstructions from the same shared snapshot cannot alias.
 */
export function engineFromSnapshot(snap: VolcanoSnapshot): PixelEngine {
  const e = new PixelEngine({
    width: snap.width,
    height: snap.height,
    seed: 1, // irrelevant — the engine is never advanced.
    gravity: new RadialGravity({ centerX: snap.width / 2, centerY: snap.height / 2 }),
    enableHeat: false,
  });
  e.grid.set(snap.grid);
  if (snap.colorGrid) e.colorGrid = Uint32Array.from(snap.colorGrid);
  if (snap.stiffnessGrid) e.stiffnessGrid = Uint8Array.from(snap.stiffnessGrid);
  if (snap.heatGrid) e.heatGrid = Float32Array.from(snap.heatGrid);
  return e;
}

// ---------------------------------------------------------------------------
// Trajectory runner.
// ---------------------------------------------------------------------------

export interface TrajectoryOptions {
  /** Total frames to simulate. */
  frames: number;
  /** Frames at which to capture snapshots (1-based, post-step). */
  checkpoints: number[];
  /** RNG seed. Matches the legacy `erupt` default of 4242. */
  seed?: number;
  cfg?: VolcanoConfig;
  opts?: VolcanoStepOptions;
  /** Custom planet builder; defaults to {@link buildVolcanoPlanet}. */
  build?: (cfg: VolcanoConfig) => PixelEngine;
}

export interface VolcanoTrajectory {
  /** Snapshots keyed by checkpoint frame. */
  snapshots: Map<number, VolcanoSnapshot>;
  /** Best-effort trace of phase transitions (observation only). */
  trace: PhaseEvent[];
}

/**
 * Run one deterministic eruption trajectory, capturing snapshots at the given
 * checkpoint frames.
 *
 * Each frame is advanced by {@link stepVolcanoFrame} — the same shared
 * per-frame controller the browser loop uses — so a checkpoint at frame N is
 * byte-identical to what a user sees at that frame, including the post-eruption
 * dormant tail (the browser stops calling the eruption steps once the cycle
 * completes). That faithfulness is what lets the golden trajectory replace the
 * redundant per-test eruptions without changing any assertion's inputs; the
 * parity test locks it.
 */
export function runVolcanoTrajectory(o: TrajectoryOptions): VolcanoTrajectory {
  const seed = o.seed ?? 4242;
  const cfg = o.cfg ?? DEFAULT_VOLCANO_CFG;
  const opts = o.opts ?? defaultVolcanoOpts(cfg);
  const build = o.build ?? ((c: VolcanoConfig) => buildVolcanoPlanet(c));

  const engine = build(cfg);
  stampVolcano(engine, cfg);
  const state = createVolcanoState();
  const rng = makeRng(seed);

  // The runtime mirrors the showcase: the eruption opens active, and the cap
  // starts at the first-cycle value (opts.pressure.maxHeight is capHeight + 2).
  const runtime: VolcanoRuntime = { erupting: true, capHeight: opts.pressure.maxHeight - 2 };

  const wanted = new Set(o.checkpoints);
  const snapshots = new Map<number, VolcanoSnapshot>();
  const trace: PhaseEvent[] = [{ frame: 0, phase: state.phase }];

  for (let f = 1; f <= o.frames; f++) {
    stepVolcanoFrame(engine, cfg, state, rng, opts, runtime);
    if (wanted.has(f)) snapshots.set(f, snapshotEngine(engine, f));
    const prev = trace[trace.length - 1];
    // Track phase transitions while active; once dormant the phase stops
    // changing, which is itself the signal that the eruption has ended.
    if (runtime.erupting && prev.phase !== state.phase) {
      trace.push({ frame: f, phase: state.phase });
    }
  }
  return { snapshots, trace };
}

/**
 * Run a full eruption and return the final engine, reusing the trajectory
 * runner. Kept for the determinism and parity tests, which need a fresh
 * standalone run rather than a shared checkpoint.
 */
export function erupt(
  frames: number,
  seed: number = 4242,
  cfg: VolcanoConfig = DEFAULT_VOLCANO_CFG,
  opts: VolcanoStepOptions = defaultVolcanoOpts(cfg),
): PixelEngine {
  const traj = runVolcanoTrajectory({ frames, checkpoints: [frames], seed, cfg, opts });
  return engineFromSnapshot(traj.snapshots.get(frames)!);
}

// ---------------------------------------------------------------------------
// Shared read-only metrics over an engine.
//
// Faithful ports of the helpers that used to be inlined in volcano.test.ts, so
// both the fast contract tests and the scenario tests share one definition.
// ---------------------------------------------------------------------------

/** Count cells of a given material across the whole grid. */
export function countMaterial(e: PixelEngine, m: MaterialType): number {
  let n = 0;
  for (let i = 0; i < e.grid.length; i++) if (e.grid[i] === m) n++;
  return n;
}

/** Count a material deposited beyond the planet's original surface. */
export function countOutside(e: PixelEngine, cfg: VolcanoConfig, m: MaterialType): number {
  const { centerX: cx, centerY: cy, planetRadius: r } = cfg;
  let n = 0;
  for (let y = 0; y < e.height; y++) {
    for (let x = 0; x < e.width; x++) {
      if (Math.hypot(x - cx, y - cy) > r && e.getMaterial(x, y) === m) n++;
    }
  }
  return n;
}

export interface EdificeProfile {
  cells: number;
  height: number;
  halfWidth: number;
  spreadDeg: number;
}

/** Material outside the original surface — i.e. newly built land. */
export function edificeProfile(e: PixelEngine, cfg: VolcanoConfig): EdificeProfile {
  const { centerX: cx, centerY: cy, planetRadius: r } = cfg;
  let cells = 0, height = 0, spreadDeg = 0;
  const profile = new Map<number, number>();
  for (let y = 0; y < e.height; y++) {
    for (let x = 0; x < e.width; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d <= r) continue;
      const m = e.getMaterial(x, y);
      if (m !== MaterialType.ROCK && m !== MaterialType.TEPHRA && m !== MaterialType.LAVA) continue;
      cells++;
      height = Math.max(height, d - r);
      const deg = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 540) % 360 - 180);
      spreadDeg = Math.max(spreadDeg, Math.abs(deg));
      profile.set(deg, Math.max(profile.get(deg) ?? 0, d - r));
    }
  }
  const spanDeg = [...profile.entries()].filter(([, h]) => h >= 1).map(([a]) => Math.abs(a));
  const halfWidth = (spanDeg.length ? Math.max(...spanDeg) : 0) * (Math.PI / 180) * r;
  return { cells, height, halfWidth, spreadDeg };
}

/** Height above the original surface at each whole degree from the vent. */
export function heightProfile(e: PixelEngine, cfg: VolcanoConfig, samples = 80): number[] {
  const { planetRadius: r } = cfg;
  const hs: number[] = [];
  for (let d = -50; d <= 50; d++) {
    // `samples` is passed as the explicit scan limit so the profile reaches far
    // enough outward regardless of the config's surfaceScanLimit (which is sized
    // for cap observability, not full-cone profiling).
    hs.push(surfaceRadiusAt(e, cfg, cfg.ventAngle + (d * Math.PI) / 180, samples) - r);
  }
  return hs;
}

// ---------------------------------------------------------------------------
// Silhouette — does the edifice actually READ as a volcano?
// ---------------------------------------------------------------------------

/**
 * The edifice measured in the **vent frame**: rows are height above the
 * original planet surface, columns are tangent offset from the vent axis.
 *
 * This is the frame the eye judges "cone" in, and it is the frame that makes a
 * chimney unmistakable. Every criterion the volcano tests had before this
 * measured *magnitude* — is it tall, does it have volume, did it spread, is the
 * centre higher than the shoulders — and a chimney standing on a skirt passes
 * every one of them. What none of them measured is **taper**: whether the thing
 * narrows as it rises. A cone and a tower-on-a-plinth are indistinguishable by
 * height and volume alone, and telling them apart is the whole job here.
 */
export interface VolcanoShape {
  /** Occupied tangent width at each height `t`, for `t = 0..surfaceScanLimit`. */
  widths: number[];
  /** Greatest height with any occupied cell. */
  height: number;
  /** Widest row — the footprint the cone stands on. */
  baseWidth: number;
  /**
   * Longest run of consecutive heights over which the width **fails to
   * decrease**, ignoring the sparse tip.
   *
   * The headline number. A cone shrinks on essentially every row, so this sits
   * at 0-3. Vertical walls cannot: a straight-sided chimney holds one width for
   * its whole length, and this counts exactly how many rows of wall it has.
   */
  maxFlatRun: number;
  /**
   * Greatest amount by which an upper row is **wider** than a lower one.
   *
   * Catches the shape a taper test alone would let through: a bulb, mushroom,
   * or detached blob perched on a stalk is not a plateau — it re-widens — and
   * re-widening is something no pile of granular material can do.
   */
  maxBulge: number;
  /** `height / baseWidth`. The flank angle in disguise: 0.32 is ~33 degrees. */
  aspect: number;
  /** Occupied cells not 8-connected to the planet body. */
  detachedCells: number;
}

/**
 * Measure the silhouette of whatever has been built above `cfg`'s surface.
 *
 * Counts `ROCK`, `TEPHRA` and `LAVA` alike: at the end of an eruption the lava
 * has frozen, and mid-eruption a jet in flight is part of what the player sees.
 * The caller decides when to look.
 */
export function measureVolcanoShape(
  e: PixelEngine,
  cfg: VolcanoConfig,
  maxT = 80,
  maxW = 70,
): VolcanoShape {
  const ux = Math.cos(cfg.ventAngle), uy = Math.sin(cfg.ventAngle);
  const { centerX: cx, centerY: cy, planetRadius: r } = cfg;
  const at = (t: number, w: number): MaterialType => {
    const x = Math.round(cx + ux * (r + t) - uy * w);
    const y = Math.round(cy + uy * (r + t) + ux * w);
    if (x < 0 || x >= e.width || y < 0 || y >= e.height) return MaterialType.EMPTY;
    return e.getMaterial(x, y);
  };
  const solid = (m: MaterialType): boolean =>
    m === MaterialType.ROCK || m === MaterialType.TEPHRA || m === MaterialType.LAVA;

  const widths: number[] = [];
  for (let t = 0; t <= maxT; t++) {
    let n = 0;
    for (let w = -maxW; w <= maxW; w++) if (solid(at(t, w))) n++;
    widths.push(n);
  }

  let height = 0;
  for (let t = 0; t <= maxT; t++) if (widths[t] > 0) height = t;
  const baseWidth = Math.max(1, ...widths);

  // Flat runs are measured only where the edifice is substantial. The last few
  // rows of any cone are a sparse scatter of one or two cells whose widths tie
  // by coincidence, and counting those would report a plateau on a perfect cone.
  const SUBSTANTIAL = 4;
  let maxFlatRun = 0, run = 0;
  for (let t = 1; t <= height; t++) {
    if (widths[t] >= SUBSTANTIAL && widths[t] >= widths[t - 1]) {
      run++;
      if (run > maxFlatRun) maxFlatRun = run;
    } else {
      run = 0;
    }
  }

  let maxBulge = 0;
  let seenMin = Infinity;
  for (let t = 0; t <= height; t++) {
    // Compare each row against the narrowest row anywhere below it: that is
    // what a bulb sitting on a stalk violates, and a merely-flat wall does not.
    if (widths[t] - seenMin > maxBulge) maxBulge = widths[t] - seenMin;
    if (widths[t] < seenMin) seenMin = widths[t];
  }

  return {
    widths,
    height,
    baseWidth,
    maxFlatRun,
    maxBulge,
    aspect: height / baseWidth,
    detachedCells: countDetachedEdifice(e, cfg),
  };
}

/**
 * Edifice cells with no 8-connected path back to the planet body.
 *
 * A volcano is one solid mass. Anything floating free of it — a frozen arch, an
 * airborne clump that set mid-flight — is a rendering artefact rather than
 * terrain, and reads instantly as wrong.
 */
function countDetachedEdifice(e: PixelEngine, cfg: VolcanoConfig): number {
  const { centerX: cx, centerY: cy, planetRadius: r } = cfg;
  const w = e.width, h = e.height;
  const solidAt = (i: number): boolean => {
    const m = e.grid[i];
    return m === MaterialType.ROCK || m === MaterialType.TEPHRA || m === MaterialType.LAVA;
  };
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  // Seed from the planet body itself, then flood outward through contact.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy > r * r) continue;
      const i = y * w + x;
      if (!seen[i] && solidAt(i)) { seen[i] = 1; stack.push(i); }
    }
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i - (i % w)) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const j = ny * w + nx;
        if (!seen[j] && solidAt(j)) { seen[j] = 1; stack.push(j); }
      }
    }
  }
  let detached = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r * r) continue;
      const i = y * w + x;
      if (solidAt(i) && !seen[i]) detached++;
    }
  }
  return detached;
}

/** Thresholds a silhouette must meet to read as a volcano. See {@link assertVolcanoShape}. */
export interface ShapeBudget {
  /** Rows of vertical wall tolerated. A cone needs 0-3; a chimney shows 6+. */
  maxFlatRun: number;
  /** Re-widening tolerated, in cells. Granular piles do not re-widen. */
  maxBulge: number;
  /** Ceiling on `height / baseWidth`. 0.55 is a ~48-degree flank. */
  maxAspect: number;
  /** Floor on height, so a flat smear cannot pass by being trivially conical. */
  minHeight: number;
  /** Floor on base width. */
  minBaseWidth: number;
}

/**
 * The default silhouette budget.
 *
 * `maxFlatRun: 3` is the load-bearing number and it is set from measurement,
 * not taste: the library's own volcano reports 0-1 at every vent angle and both
 * planet scales, while the hand-rolled god-game recipe reported 6, 11 and 11 at
 * three of five angles. Nothing lands in between, so the threshold has a wide
 * margin on both sides.
 *
 * `maxAspect: 0.55` is a ~48-degree flank. Loose on purpose: tephra's real
 * angle of repose is ~33 degrees (0.32), but a grid-quantised pile on a curved
 * planet runs steeper, and the point of the number is to reject towers, not to
 * grade cones.
 */
export const DEFAULT_SHAPE_BUDGET: ShapeBudget = {
  maxFlatRun: 3,
  maxBulge: 3,
  maxAspect: 0.55,
  minHeight: 8,
  minBaseWidth: 20,
};

/** Render a silhouette as an ASCII column plot, for failure messages. */
export function renderShape(shape: VolcanoShape): string {
  const lines: string[] = [];
  for (let t = shape.height; t >= 0; t--) {
    const n = shape.widths[t];
    lines.push(`${String(t).padStart(3)} ${String(n).padStart(3)} ${'#'.repeat(Math.min(n, 70))}`);
  }
  return lines.join('\n');
}

/**
 * Assert that an edifice reads as a volcano rather than as a tower, a wall, or
 * a blob on a stick.
 *
 * Failure messages carry the whole width profile, because the number that
 * failed is never enough to tell you *where* the shape went wrong.
 */
export function assertVolcanoShape(
  e: PixelEngine,
  cfg: VolcanoConfig,
  label: string,
  budget: ShapeBudget = DEFAULT_SHAPE_BUDGET,
): VolcanoShape {
  const s = measureVolcanoShape(e, cfg);
  const dump = `\n${label}: H=${s.height} base=${s.baseWidth} aspect=${s.aspect.toFixed(2)} `
    + `flatRun=${s.maxFlatRun} bulge=${s.maxBulge} detached=${s.detachedCells}\n`
    + `widths: ${s.widths.slice(0, s.height + 2).join(',')}\n${renderShape(s)}`;

  if (s.height < budget.minHeight) throw new Error(`${label}: no edifice (height ${s.height} < ${budget.minHeight})${dump}`);
  if (s.baseWidth < budget.minBaseWidth) throw new Error(`${label}: footprint too narrow (${s.baseWidth} < ${budget.minBaseWidth})${dump}`);
  if (s.maxFlatRun > budget.maxFlatRun) {
    throw new Error(
      `${label}: VERTICAL WALL — width failed to decrease for ${s.maxFlatRun} consecutive rows `
      + `(budget ${budget.maxFlatRun}). This is a chimney, not a cone.${dump}`,
    );
  }
  if (s.maxBulge > budget.maxBulge) {
    throw new Error(
      `${label}: OVERHANG — a row is ${s.maxBulge} cells wider than one below it `
      + `(budget ${budget.maxBulge}). Granular piles do not re-widen.${dump}`,
    );
  }
  if (s.aspect > budget.maxAspect) {
    throw new Error(
      `${label}: TOO STEEP — aspect ${s.aspect.toFixed(2)} exceeds ${budget.maxAspect} `
      + `(flank steeper than a pile can stand).${dump}`,
    );
  }
  if (s.detachedCells > 0) {
    throw new Error(`${label}: ${s.detachedCells} edifice cells float free of the planet.${dump}`);
  }
  return s;
}
