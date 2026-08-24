/**
 * Volcano effects — the atmospheric layer that makes an eruption read as one.
 *
 * ## Why this is a host-side helper, not an engine material
 *
 * The engine ships a `SMOKE` material, and a gas in `RadialGravity` does rise —
 * but only one cell at a time, straight away from the gravity center, and it
 * spreads only when obstructed (see the gas-rising path in `engine.ts`). Filling
 * enough cells to read as a volumetric column keeps many chunks active and still
 * produces a thin stream rather than a billowing plume. That is the same gap that
 * keeps `cloud.ts` host-side: the engine simulates materials, not multi-cell
 * atmospheric features.
 *
 * So the ash plume here is a *logical entity* the host tracks and renders, never a
 * material in the grid. Nothing the plume does can touch `grid`, `heatGrid`,
 * `colorGrid`, or `stiffnessGrid` — which is what keeps the volcano's golden
 * trajectory byte-identical between the browser and the headless harness. The
 * vent glow, eruption flash, and screen shake live here too, for the same reason:
 * they are presentation, not physics.
 *
 * DOM-free and deterministic, so it runs and is tested under Node — the same
 * split the sections use for `cloud.ts`, `renderer.ts`, and `volcano.ts`.
 */

import type { PixelEngine } from '../../src/sand';
import { MaterialType } from '../../src/materials';
import {
  summitRadius,
  type EruptionPhase,
  type VolcanoConfig,
} from '../../src/volcano';

/**
 * The mode driving effects for a tick.
 *
 * Adds the two non-erupting host states to {@link EruptionPhase}: `paused` (the
 * user clicked the volcano button to stop) and `dormant` (the eruption ran its
 * course or the scene was reset). Both stop emission and let existing puffs
 * disperse, but the distinction is what lets the host communicate *why* emission
 * stopped, so the plume can fade out cleanly in either case.
 */
export type VolcanoEffectMode = EruptionPhase | 'paused' | 'dormant';

/** A single ash puff — an expanding, fading translucent body in grid space. */
export interface AshPuff {
  /** Center in grid space, in cells. */
  x: number;
  y: number;
  /** Velocity in cells/tick. */
  vx: number;
  vy: number;
  /** Current visible radius, in cells. Grows with age. */
  radius: number;
  /** Radius the puff was emitted at, in cells. */
  initialRadius: number;
  /** Current opacity, 0..1. Falls with age. */
  opacity: number;
  /** Opacity the puff was emitted with, 0..1. */
  initialOpacity: number;
  /**
   * Current greyscale brightness, 0..255. Starts dark for ash (low) or pale for
   * gas (high) and lightens toward neutral grey as the puff disperses.
   */
  shade: number;
  /** Shade the puff was emitted with, 0..255. */
  initialShade: number;
  /** Shade the puff lightens toward by end of life, 0..255. */
  finalShade: number;
  /** Ticks since emission. */
  age: number;
  /** Ticks this puff lives before it is culled. */
  lifetime: number;
  /**
   * Deterministic per-puff seed for lobe offsets and shape. Drawn once at
   * emission so the same state renders to identical pixels twice without any
   * `Math.random()` in the render path.
   */
  shapeSeed: number;
}

/** Tunable effect parameters. All linear values scale with `effectScale`. */
export interface VolcanoEffectOptions {
  /** Hard ceiling on live puffs. Emission is skipped when full (never eviction). */
  maxPuffs: number;
  /** Per-phase tuning. */
  phases: {
    explosive: PhaseTuning;
    effusive: PhaseTuning;
  };
  /** Cells of clear air sought between the summit and the emission origin. */
  ventClearance: number;
  /** Half-width of tangential jitter across the crater mouth, in cells (pre-scale). */
  mouthHalfWidth: number;
  /** Per-tick radial buoyant acceleration, in cells/tick² (pre-scale). */
  buoyantAccel: number;
  /** Per-tick velocity drag, in 0..1 (fraction of velocity kept). */
  drag: number;
  /** Radial speed above which buoyant acceleration stops adding, in cells/tick. */
  terminalRadialSpeed: number;
  /** Per-tick fractional radius growth. */
  radiusGrowth: number;
  /** Per-tick flash decay (fraction of flash remaining after one tick). */
  flashDecay: number;
  /** Per-tick glow rise toward its phase target. */
  glowRise: number;
  /** Per-tick glow fall when not emitting. */
  glowFall: number;
  /** Maximum shake displacement, in cells (pre-scale). Applied at explosive entry. */
  maxShake: number;
}

/** Emission and appearance for one emitting phase. */
export interface PhaseTuning {
  /** Puffs emitted per tick (fractional; a carry accumulates the remainder). */
  emission: number;
  /** Lifetime for emitted puffs, in ticks. */
  lifetime: number;
  /** Initial radius, in cells (pre-scale). */
  initialRadius: number;
  /** Initial radial velocity, in cells/tick (pre-scale). */
  radialVelocity: number;
  /** Initial tangential drift, in cells/tick (pre-scale); sign chosen per puff. */
  tangentialDrift: number;
  /** Initial opacity, 0..1. */
  initialOpacity: number;
  /** Initial shade, 0..255. Dark for ash, pale for gas. */
  initialShade: number;
  /** Shade puffs lighten toward as they age, 0..255. */
  finalShade: number;
}

/**
 * Default tuning. Midpoints of the ranges in `docs/plan-volcano-effects.md`, with
 * a conservative budget: at `explosive.emission` 0.65 over `lifetime` 160 the
 * steady-state peak is ~104 puffs, plus ~12 effusive wisps before the oldest ash
 * expires — well under the 160 cap.
 */
export const DEFAULT_EFFECT_OPTS: VolcanoEffectOptions = {
  maxPuffs: 160,
  ventClearance: 2,
  mouthHalfWidth: 2,
  buoyantAccel: 0.012,
  drag: 0.985,
  terminalRadialSpeed: 0.55,
  radiusGrowth: 0.012,
  flashDecay: 0.82,
  glowRise: 0.18,
  glowFall: 0.06,
  maxShake: 1.6,
  phases: {
    explosive: {
      emission: 0.65,
      lifetime: 160,
      initialRadius: 2.6,
      radialVelocity: 0.34,
      tangentialDrift: 0.05,
      initialOpacity: 0.42,
      initialShade: 46,
      finalShade: 120,
    },
    effusive: {
      emission: 0.11,
      lifetime: 105,
      initialRadius: 2.0,
      radialVelocity: 0.16,
      tangentialDrift: 0.03,
      initialOpacity: 0.26,
      initialShade: 150,
      finalShade: 180,
    },
  },
};

/**
 * Scale at the shipped default planet radius (66). Linear effect values are
 * multiplied by this so the plume keeps its apparent size when the backing store
 * changes from 120 to 400 cells — see `docs/plan-volcano-effects.md` §1.2.
 *
 * Clamped to at least 0.5 so a tiny planet still shows *something*.
 */
export function effectScale(planetRadius: number): number {
  return Math.max(0.5, planetRadius / 66);
}

/** Seed for the effects' own PRNG. Independent of the volcano's stream. */
export const EFFECTS_SEED = 9191;

/** All effect state, plain data so it can be stepped and inspected under Node. */
export interface VolcanoEffectsState {
  puffs: AshPuff[];
  /** Fractional emission accumulator. Reset to 0 on any mode change. */
  emissionCarry: number;
  /** Last live vent, cached so glow/flash render without a second summit scan. */
  vent: { x: number; y: number } | null;
  /** 0..1 — eruption-entry flash. Decays each tick. */
  flash: number;
  /** 0..1 — vent glow. Rises while emitting, fades otherwise. */
  glow: number;
  /** Screen-axis shake offset, in cells. Held at the entry value until the next. */
  shakeX: number;
  shakeY: number;
  /** Last mode stepped, for entry-edge detection. */
  previousMode: VolcanoEffectMode;
  /** Last episode stepped, so pause/resume retriggers entry cues reliably. */
  previousEpisode: number;
}

/**
 * Fresh, empty effect state.
 *
 * `previousEpisode` starts at -1 so the very first eruption's `episode 0` differs
 * from it and fires the entry flash and shake — without this, a first eruption
 * that opens on `previousEpisode === 0` would read as "no change" and stay dark.
 */
export function createVolcanoEffectsState(): VolcanoEffectsState {
  return {
    puffs: [],
    emissionCarry: 0,
    vent: null,
    flash: 0,
    glow: 0,
    shakeX: 0,
    shakeY: 0,
    previousMode: 'dormant',
    previousEpisode: -1,
  };
}

/**
 * Reset effect state in place (clears puffs and scalars, keeps bookkeeping fresh).
 *
 * Used by Clear and by world rebuilds. Equivalent to reassigning to
 * {@link createVolcanoEffectsState} but reuses the array reference, which the
 * section's closures read through.
 */
export function resetVolcanoEffects(state: VolcanoEffectsState): void {
  state.puffs.length = 0;
  state.emissionCarry = 0;
  state.vent = null;
  state.flash = 0;
  state.glow = 0;
  state.shakeX = 0;
  state.shakeY = 0;
  state.previousMode = 'dormant';
  state.previousEpisode = -1;
}

/** True for modes that emit new puffs. */
function isEmitting(mode: VolcanoEffectMode): mode is EruptionPhase {
  return mode === 'explosive' || mode === 'effusive';
}

/** The tuning for an emitting mode, or `null` for a non-emitting one. */
function tuningFor(
  mode: VolcanoEffectMode,
  opts: VolcanoEffectOptions,
): PhaseTuning | null {
  if (mode === 'explosive') return opts.phases.explosive;
  if (mode === 'effusive') return opts.phases.effusive;
  return null;
}

/**
 * Find the emission origin for this tick: the summit along the vent axis, pushed
 * `clearance` cells into open air, with a small bounded walk if that point is
 * occupied (a mature cone can bury a fixed offset).
 *
 * Returns `null` only when no open cell can be found within a short outward walk
 * — e.g. before the volcano is stamped. The caller treats `null` as "no emission
 * this tick".
 */
function emissionOrigin(
  engine: PixelEngine,
  cfg: VolcanoConfig,
  clearance: number,
): { x: number; y: number } | null {
  const summit = summitRadius(engine, cfg);
  const ux = Math.cos(cfg.ventAngle);
  const uy = Math.sin(cfg.ventAngle);
  // Walk outward from the summit until an empty cell is found. The first attempt
  // is `summit + clearance`; a couple of further steps cover a buried rim.
  for (let step = clearance; step <= clearance + 4; step++) {
    const r = summit + step;
    const x = Math.round(cfg.centerX + ux * r);
    const y = Math.round(cfg.centerY + uy * r);
    if (x < 0 || x >= engine.width || y < 0 || y >= engine.height) return null;
    if (engine.getMaterial(x, y) === MaterialType.EMPTY) return { x, y };
  }
  return null;
}

/**
 * Step the effects by one tick.
 *
 * Ordering (see `docs/plan-volcano-effects.md` §Phase 2):
 *
 *  1. Advance and cull the puffs that existed at tick start, and decay the scalar
 *     cues. A newborn puff therefore renders at age zero and a fresh flash at full
 *     intensity.
 *  2. Detect explosive entry (mode edge or episode change) and fire flash + shake.
 *  3. Update the live vent and emit new puffs for the captured mode.
 *  4. Record `previousMode` / `previousEpisode`.
 *
 * The mode passed in is the one captured *before* the physical tick's phase
 * transitions, so the visible plume aligns with the work done this tick rather
 * than the next phase. The helper never mutates `engine`'s grids — it only reads
 * geometry to place the emission origin.
 *
 * @param engine   - the simulation (read-only here, for summit geometry)
 * @param cfg      - volcano geometry
 * @param state    - effect state (mutated in place)
 * @param rng      - deterministic PRNG dedicated to effects (see `makeRng`)
 * @param mode     - the effect mode for the tick being simulated
 * @param episode  - host eruption-episode counter; a change retriggers entry cues
 * @param opts     - tuning
 */
export function stepVolcanoEffects(
  engine: PixelEngine,
  cfg: VolcanoConfig,
  state: VolcanoEffectsState,
  rng: () => number,
  mode: VolcanoEffectMode,
  episode: number,
  opts: VolcanoEffectOptions,
): void {
  const scale = effectScale(cfg.planetRadius);
  const cx = cfg.centerX;
  const cy = cfg.centerY;

  // --- 1. Advance and cull existing puffs + decay scalars -------------------
  advancePuffs(state, cx, cy, engine.width, engine.height, scale, opts);

  // Flash decays every tick; glow is handled below against the phase target.
  state.flash *= opts.flashDecay;
  if (state.flash < 0.01) state.flash = 0;

  // --- Dormant fast path ---------------------------------------------------
  // Nothing to draw and nothing to emit: skip the summit scan entirely. The host
  // still calls us every tick so a later start is detected immediately.
  if (
    !isEmitting(mode)
    && state.puffs.length === 0
    && state.flash === 0
    && state.glow < 0.01
  ) {
    state.glow = 0;
    state.previousMode = mode;
    state.previousEpisode = episode;
    return;
  }

  // --- 2. Entry detection (flash + shake) ----------------------------------
  // Explosive entry is either a mode edge into explosive or any episode change
  // while explosive. Episode counting makes a pause/resume retrigger reliably
  // even when no tick separates the two — the host bumps `episode` on every
  // explicit start.
  const entryExplosive =
    mode === 'explosive'
    && (state.previousMode !== 'explosive' || episode !== state.previousEpisode);
  if (entryExplosive) {
    state.flash = 1;
    const angle = rng() * Math.PI * 2;
    const mag = opts.maxShake * scale * (0.7 + rng() * 0.3);
    state.shakeX = Math.cos(angle) * mag;
    state.shakeY = Math.sin(angle) * mag;
  }

  // --- 3. Glow target, vent, emission --------------------------------------
  const tuning = tuningFor(mode, opts);
  const glowTarget = tuning ? (mode === 'explosive' ? 1 : 0.6) : 0;
  if (glowTarget > state.glow) {
    state.glow += opts.glowRise;
    if (state.glow > glowTarget) state.glow = glowTarget;
  } else if (glowTarget < state.glow) {
    state.glow -= opts.glowFall;
    if (state.glow < 0) state.glow = 0;
  }

  // Reset emission carry on any mode change so a fractional remainder from dense
  // ash doesn't become a gas wisp, and a pause retains no emission debt.
  if (mode !== state.previousMode) state.emissionCarry = 0;

  if (tuning) {
    const origin = emissionOrigin(engine, cfg, opts.ventClearance);
    if (origin) {
      state.vent = origin;
      emitForMode(state, cfg, origin, rng, tuning, scale, opts);
    }
  }
  // Non-emitting modes keep the last vent so glow can finish fading at the right spot.

  // --- 4. Bookkeeping ------------------------------------------------------
  state.previousMode = mode;
  state.previousEpisode = episode;
}

/**
 * Advance, age, and cull every puff. Also applies buoyant acceleration, drag,
 * tangential drift, radius growth, opacity fade, and shade lightening.
 *
 * Puffs are culled when expired, fully transparent, or entirely off-grid. An
 * edge puff whose center has crossed the boundary but whose radius still overlaps
 * the canvas is kept — removing it the instant the center leaves would make the
 * leading edge of a plume pop out before its lifetime is up.
 */
function advancePuffs(
  state: VolcanoEffectsState,
  cx: number,
  cy: number,
  width: number,
  height: number,
  scale: number,
  opts: VolcanoEffectOptions,
): void {
  const puffs = state.puffs;
  let write = 0;
  for (let i = 0; i < puffs.length; i++) {
    const p = puffs[i];

    // Buoyant acceleration: away from the planet center, scaled, with a terminal
    // radial speed so acceleration cannot grow velocity without bound.
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist;
    const uy = dy / dist;
    const radialSpeed = p.vx * ux + p.vy * uy;
    if (radialSpeed < opts.terminalRadialSpeed * scale) {
      const a = opts.buoyantAccel * scale;
      p.vx += ux * a;
      p.vy += uy * a;
    }
    // Drag.
    p.vx *= opts.drag;
    p.vy *= opts.drag;
    // Advance.
    p.x += p.vx;
    p.y += p.vy;

    // Age, radius, opacity, shade.
    p.age += 1;
    p.radius += p.initialRadius * opts.radiusGrowth;
    const t = p.age / p.lifetime; // normalized age 0..1
    p.opacity = p.initialOpacity * (1 - t);
    p.shade = p.initialShade + (p.finalShade - p.initialShade) * Math.min(1, t);

    // Cull: expired, invisible, or fully off-grid (whole radius outside canvas).
    if (p.age >= p.lifetime || p.opacity <= 0.01) continue;
    if (p.x + p.radius < 0 || p.x - p.radius >= width) continue;
    if (p.y + p.radius < 0 || p.y - p.radius >= height) continue;
    puffs[write++] = p;
  }
  puffs.length = write;
}

/**
 * Emit new puffs for one emitting mode this tick, honouring the fractional carry
 * and the hard cap.
 *
 * The cap is an emergency invariant: if reached, the emission attempt is consumed
 * (no carry burst later) but no live puff is evicted — evicting to admit a new
 * puff makes a saturated plume's leading edge pop out before its lifetime.
 */
function emitForMode(
  state: VolcanoEffectsState,
  cfg: VolcanoConfig,
  origin: { x: number; y: number },
  rng: () => number,
  tuning: PhaseTuning,
  scale: number,
  opts: VolcanoEffectOptions,
): void {
  state.emissionCarry += tuning.emission;
  // Tangent direction across the crater mouth (perpendicular to the vent axis).
  const tx = -Math.sin(cfg.ventAngle);
  const ty = Math.cos(cfg.ventAngle);
  const ux = Math.cos(cfg.ventAngle);
  const uy = Math.sin(cfg.ventAngle);
  const mouthHalf = opts.mouthHalfWidth * scale;

  let guard = 0;
  while (state.emissionCarry >= 1) {
    state.emissionCarry -= 1;
    if (state.puffs.length >= opts.maxPuffs) continue; // skip, don't evict
    if (++guard > 8) break; // safety against a runaway loop on bad tuning

    // Tangential jitter across the crater mouth, so puffs come from an area, and
    // a per-puff tangential drift sign to suggest wind without wind physics.
    const jitter = (rng() * 2 - 1) * mouthHalf;
    const driftSign = rng() < 0.5 ? -1 : 1;
    const radial = tuning.radialVelocity * scale * (0.85 + rng() * 0.3);
    const tangential = tuning.tangentialDrift * scale * driftSign;

    state.puffs.push({
      x: origin.x + tx * jitter,
      y: origin.y + ty * jitter,
      vx: ux * radial + tx * tangential,
      vy: uy * radial + ty * tangential,
      radius: tuning.initialRadius * scale,
      initialRadius: tuning.initialRadius * scale,
      opacity: tuning.initialOpacity,
      initialOpacity: tuning.initialOpacity,
      shade: tuning.initialShade,
      initialShade: tuning.initialShade,
      finalShade: tuning.finalShade,
      age: 0,
      lifetime: tuning.lifetime,
      shapeSeed: Math.floor(rng() * 4294967296),
    });
  }
}

/**
 * Screen→grid conversion composing inverse shake and inverse spin.
 *
 * The canvas renders world pixels under a `translate(shake) · translate(c) ·
 * rotate(spin) · translate(-c)` transform. To find the grid cell under a pointer
 * we invert that: subtract the shake offset, then un-rotate by `-spin` about the
 * center. This is the pure helper the section's `toGrid` wraps, extracted so the
 * composition can be unit-tested under Node.
 *
 * Pass `shakeX = shakeY = 0` (or reduced-motion) to recover the exact pre-shake
 * mapping — the existing pointer behaviour when no effects are active.
 */
export function screenToGrid(
  px: number,
  py: number,
  cx: number,
  cy: number,
  spinAngle: number,
  shakeX: number,
  shakeY: number,
): { x: number; y: number } {
  // Undo the shake translation first (it was applied outermost in render).
  const sx = px - shakeX;
  const sy = py - shakeY;
  // Then un-rotate about the planet center by -spinAngle.
  const dx = sx - cx;
  const dy = sy - cy;
  const cos = Math.cos(-spinAngle);
  const sin = Math.sin(-spinAngle);
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  return { x: cx + rx, y: cy + ry };
}
