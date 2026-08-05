/**
 * Pure fixed-step simulation scheduler decisions, extracted from the planet
 * section's `requestAnimationFrame` loop so the accumulator math and render
 * throttling are unit-testable without a DOM.
 *
 * The scheduler is intentionally pure: given the elapsed wall-clock time, the
 * previous accumulator, and the presentation state, it returns how many physics
 * ticks to run, the resulting accumulator, and whether to render. The section
 * applies these decisions — the bookkeeping here has no side effects.
 *
 * Policy:
 * - Physics runs at a fixed {@link STEP_MS} (1000/60 ≈ 16.67 ms) via an
 *   accumulator, so per-tick sim semantics (cooling, growth, rain, eruption) are
 *   independent of the display refresh rate.
 * - The accumulator is clamped to {@link MAX_CATCHUP} ticks so a long pause
 *   (tab switch, debugger) cannot demand an unbounded catch-up burst.
 * - Rendering is throttled to a presentation interval. Above the
 *   {@link HIRES_THRESHOLD} resolution the cap is 30 FPS; below it, 60 FPS.
 *   Physics stays at 60 ticks/s in both cases.
 * - A priority-present flag forces a render after the tick it is raised in, so a
 *   30-FPS presentation cannot skip both the appearance and disappearance of a
 *   single-tick transient (an explosion flash).
 */

/** Physics step duration in ms (60 Hz). */
export const STEP_MS = 1000 / 60;
/** At or above this resolution, cap the render rate to 30 FPS. */
export const HIRES_THRESHOLD = 800;
/** Maximum physics ticks to run in one frame; caps the catch-up spiral. */
export const MAX_CATCHUP = 5;
/** Render interval at/below the threshold (60 FPS). */
export const RENDER_60 = 1000 / 60;
/** Render interval at/above the threshold (30 FPS). */
export const RENDER_30 = 1000 / 30;

/** Presentation interval for a given world size, in ms. */
export const renderIntervalFor = (size: number): number =>
  size >= HIRES_THRESHOLD ? RENDER_30 : RENDER_60;

export interface SchedulerInput {
  /** Elapsed wall-clock since the last frame, in ms. */
  elapsed: number;
  /** Accumulator carried over from the previous frame, in ms. */
  acc: number;
  /** Whether a priority-present signal is active this frame. */
  forcePresent: boolean;
  /** Wall-clock of the last rendered frame, in ms. */
  lastRender: number;
  /** Current wall-clock time, in ms (the rAF `now`). */
  now: number;
  /** Current world size (cells), selecting the render interval. */
  size: number;
}

export interface SchedulerDecision {
  /** How many physics ticks to run this frame (0..MAX_CATCHUP). */
  ticks: number;
  /** New accumulator value to carry forward, in ms. */
  nextAcc: number;
  /** Whether to present (call render) this frame. */
  shouldRender: boolean;
}

/**
 * Decide how many fixed steps to run and whether to render, given elapsed time.
 * Pure: no mutation, no I/O. The caller owns the accumulator and last-render
 * timestamps and feeds the returned `nextAcc` back in next frame.
 */
export const scheduleFrame = (input: SchedulerInput): SchedulerDecision => {
  let acc = input.acc + input.elapsed;
  // Clamp so a long pause can't demand an unbounded burst of catch-up ticks.
  if (acc > MAX_CATCHUP * STEP_MS) acc = MAX_CATCHUP * STEP_MS;

  let ticks = 0;
  while (acc >= STEP_MS && ticks < MAX_CATCHUP) {
    acc -= STEP_MS;
    ticks++;
    // Stop stepping once a priority transient fires: it wants to be presented
    // in the frame it occurred, not buried under more catch-up ticks.
    if (input.forcePresent) break;
  }

  const interval = renderIntervalFor(input.size);
  const shouldRender = input.forcePresent
    || input.now - input.lastRender >= interval
    || (ticks > 0 && input.size < HIRES_THRESHOLD);

  return { ticks, nextAcc: acc, shouldRender };
};

/**
 * Visibility-resume reset: discard hidden elapsed time and force an immediate
 * render on return. Returns the accumulator/timestamp values to install so the
 * first frame after un-hiding does not attempt wall-clock catch-up.
 */
export const resumeAfterHidden = (now: number): { acc: number; lastTime: number; lastRender: number } => ({
  acc: 0, // discard hidden elapsed time; no catch-up
  lastTime: now,
  lastRender: 0, // force an immediate render on resume
});
