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
