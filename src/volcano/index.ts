/**
 * Volcano — a vent-fed, thermally-coloured eruption on a radial-gravity planet.
 *
 * An **opt-in subsystem**, not part of the simulation core: nothing in
 * `sand/`, `materials/`, or `gravity/` imports it, and a world that never
 * constructs a volcano never loads a line of it. What it does is compose the
 * core's primitives — pressure sources, the heat field, fragmentation,
 * `stiffnessGrid`, the velocity field — into the one arrangement of them that
 * is hard to derive from scratch: an eruption that ascends a conduit, fountains
 * ballistically, fragments into tephra, and stacks the result into a cone that
 * stops growing.
 *
 * ## Why it lives in the library
 *
 * It used to live in the showcase, as `showcase/helpers/volcano.ts`. That made
 * it demo code by location while being general-purpose by content, with three
 * costs: it carried its own copy of the engine's mulberry32; the engine
 * documented `stiffnessGrid` as "a host that tracks temperature writes it here"
 * while the only such host was unpublished; and the god-game build brief had to
 * encode the whole eruption recipe *as prose*, kept in sync with a test that
 * re-derived it by hand.
 *
 * Same discipline as the core: DOM-free, no `Math.random`, no wall-clock reads
 * (instrumentation takes an injected clock — see `VolcanoRuntime.now`), fully
 * testable in Node.
 *
 * ## What is deliberately *not* here
 *
 * Ash plumes, vent glow, eruption flash, and screen shake. Those are host-side
 * renderable entities that never touch the grid, and the library ships no
 * renderer by design. They remain in `showcase/helpers/volcano-effects.ts`.
 */
export {
  // Geometry and configuration
  volcanoGeometryFor,
  ventPosition,
  surfaceRadiusAt,
  summitRadius,
  edificeHeight,
  ventTopRadius,
  craterLowPoint,
  isDormant,
  type VolcanoConfig,
  type VolcanoGeometry,

  // Rheology and the incandescence palette
  stiffnessForTemp,
  syncFromHeat,
  MAGMA_TEMP,
  VENT_TEMP,
  TEMP_STEPS,
  TEMP_RAMP,
  TEPHRA_STEPS,
  TEPHRA_RAMP,

  // World construction
  stampVolcano,
  emitPlume,
  erupt,
  type PressureOptions,
  type PlumeOptions,

  // Plumbing maintenance between and during episodes
  rechargeReservoir,
  remeltConduit,
  assimilateTephra,
  type AssimilateOptions,

  // The eruption cycle
  createVolcanoState,
  stepVolcanoPre,
  stepVolcanoPost,
  stepVolcanoFrame,
  buildVolcanoOpts,
  DEFAULT_PHASES,
  DEFAULT_VOLCANO_INPUTS,
  type EruptionPhase,
  type VolcanoState,
  type PhaseDurations,
  type VolcanoStepOptions,
  type VolcanoOptsInputs,
  type VolcanoRuntime,
  type VolcanoTimings,

  // Deterministic side-stream RNG (alias of the engine's mulberry32)
  makeRng,
} from './volcano.js';
