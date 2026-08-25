// In-repo import; when copying this file into a game, change to:
//   import type { ... } from 'aicraft-pixel-engine';

/**
 * A fixed-timestep clock that survives browser timer throttling.
 *
 * ## The failure it prevents
 *
 * Occluded and background tabs have their `setInterval`/`setTimeout` timers
 * throttled to roughly one fire per second. A game loop written as "one
 * simulation step per interval fire" then runs its simulation at ~1/60th
 * speed whenever the tab is not frontmost — measured during the god-game
 * build: ticks advanced once per second while `engine.update()` itself took
 * ~1 ms. The game appears frozen-ish, rain takes a minute to fall, and any
 * wall-clock feature (a census readout, a day/night cycle) drifts from the
 * simulation.
 *
 * ## The fix
 *
 * Drive *fixed steps* from a wall-clock accumulator: each timer fire adds the
 * elapsed time (clamped, so a long occlusion doesn't simulate a burst of
 * "missed" frames the moment the tab becomes visible again) and runs as many
 * exactly-`stepMs` steps as the accumulator can pay for. Every step is the
 * same amount of simulation time regardless of how the browser starves the
 * timer; determinism is preserved because step count, not wall time, drives
 * the engine.
 *
 * ## Drive it from `setInterval`, never `requestAnimationFrame`
 *
 * The accumulator is only half the fix, and the other half is easy to get
 * wrong precisely because the accumulator looks like the interesting part. A
 * later build reimplemented this arithmetic correctly — same clamp, same
 * fixed step — and hung it off `requestAnimationFrame`. rAF does not fire
 * *at all* while `document.hidden`; `setInterval` merely slows to ~1 Hz. So
 * the throttled tab went from simulating 60× slow to not simulating, and the
 * world froze completely whenever the tab was not frontmost. It also made the
 * game unverifiable in a headless browser, where the page is hidden by
 * definition and every screenshot showed the boot frame forever.
 *
 * {@link startFixedTickClock} is the whole loop with the right driver already
 * chosen. Prefer it to assembling {@link createAccumulator} yourself; the
 * split exists for hosts that already own a timer, not as an invitation to
 * pick a different one. If you must render from rAF, keep the *simulation* on
 * the interval and let the render pass be the thing that pauses — a frozen
 * picture of a world that kept running is recoverable; a frozen world is not.
 */

export interface TickAccumulator {
  /** Feed a `performance.now()` timestamp; runs 0..N steps, returns how many. */
  pump(nowMs: number): number;
  /** Steps run so far (the simulation's tick counter). */
  stepCount(): number;
}

export function createAccumulator(stepMs: number, maxCatchUpMs = 100): TickAccumulator {
  if (stepMs <= 0) throw new Error('stepMs must be positive');
  let last = NaN;
  let acc = 0;
  let count = 0;
  return {
    pump(nowMs: number): number {
      if (Number.isNaN(last)) {
        last = nowMs;
        return 0;
      }
      acc += Math.min(nowMs - last, maxCatchUpMs);
      last = nowMs;
      let ran = 0;
      while (acc >= stepMs) {
        acc -= stepMs;
        ran++;
      }
      count += ran;
      return ran;
    },
    stepCount() {
      return count;
    },
  };
}

/**
 * The full loop: a `setInterval` feeding the accumulator and running `step`.
 * `step` receives the current `performance.now()` value, matching the shape
 * the census recipe's wall-clock gate expects.
 *
 * `setInterval` and not `requestAnimationFrame` — see the header. This is the
 * entry point to copy.
 */
export function startFixedTickClock(
  stepMs: number,
  step: (nowMs: number) => void,
): { stop(): void } {
  const acc = createAccumulator(stepMs);
  const timer = setInterval(() => {
    const now = performance.now();
    const n = acc.pump(now);
    for (let i = 0; i < n; i++) step(now);
  }, stepMs);
  return { stop: () => clearInterval(timer) };
}
