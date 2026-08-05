import { describe, it, expect } from 'vitest';
import {
  scheduleFrame,
  resumeAfterHidden,
  renderIntervalFor,
  STEP_MS,
  MAX_CATCHUP,
  HIRES_THRESHOLD,
} from '../helpers/frame-scheduler';

describe('scheduleFrame — accumulator', () => {
  it('runs one tick for one step of elapsed time', () => {
    const d = scheduleFrame({ elapsed: STEP_MS, acc: 0, forcePresent: false, lastRender: 0, now: STEP_MS, size: 220 });
    expect(d.ticks).toBe(1);
    expect(d.nextAcc).toBeCloseTo(0, 5);
  });

  it('runs two ticks when two steps have elapsed', () => {
    const d = scheduleFrame({ elapsed: STEP_MS * 2, acc: 0, forcePresent: false, lastRender: 0, now: STEP_MS * 2, size: 220 });
    expect(d.ticks).toBe(2);
    expect(d.nextAcc).toBeCloseTo(0, 5);
  });

  it('carries fractional accumulator forward across frames', () => {
    // 1.5 steps elapsed → 1 tick now, 0.5 step carried to next frame.
    const d1 = scheduleFrame({ elapsed: STEP_MS * 1.5, acc: 0, forcePresent: false, lastRender: 0, now: STEP_MS * 1.5, size: 220 });
    expect(d1.ticks).toBe(1);
    expect(d1.nextAcc).toBeCloseTo(STEP_MS * 0.5, 4);
    // Next frame: another 0.6 step → carried 0.5 + 0.6 = 1.1 → 1 tick.
    const d2 = scheduleFrame({ elapsed: STEP_MS * 0.6, acc: d1.nextAcc, forcePresent: false, lastRender: 0, now: STEP_MS * 2.1, size: 220 });
    expect(d2.ticks).toBe(1);
    expect(d2.nextAcc).toBeCloseTo(STEP_MS * 0.1, 4);
  });

  it('caps catch-up at MAX_CATCHUP ticks after a long pause', () => {
    // 60 steps (a full second) elapsed — must not run 60 ticks. The cap is what
    // matters; the exact count may be MAX_CATCHUP or one shy of it depending on
    // FP rounding after the clamp (clamping to N*STEP_MS and subtracting STEP_MS
    // N-1 times can land a hair under one more step).
    const d = scheduleFrame({ elapsed: STEP_MS * 60, acc: 0, forcePresent: false, lastRender: 0, now: 1000, size: 220 });
    expect(d.ticks).toBeLessThanOrEqual(MAX_CATCHUP);
    expect(d.ticks).toBeGreaterThan(0);
    // The leftover accumulator is clamped, not the full second.
    expect(d.nextAcc).toBeLessThanOrEqual(MAX_CATCHUP * STEP_MS);
  });

  it('clamps a large carried accumulator too', () => {
    // A huge carried accumulator alone (no new elapsed) must also clamp.
    const d = scheduleFrame({ elapsed: 0, acc: STEP_MS * 100, forcePresent: false, lastRender: 0, now: 0, size: 220 });
    expect(d.ticks).toBeLessThanOrEqual(MAX_CATCHUP);
    expect(d.ticks).toBeGreaterThan(0);
  });
});

describe('scheduleFrame — render throttling', () => {
  it('renders every frame at low resolution when ticks ran', () => {
    const d = scheduleFrame({ elapsed: STEP_MS, acc: 0, forcePresent: false, lastRender: 0, now: STEP_MS, size: 220 });
    expect(d.shouldRender).toBe(true); // ticks > 0 && size < HIRES_THRESHOLD
  });

  it('throttles to 30 FPS at/above the high-resolution threshold', () => {
    // Just under one 30-FPS interval since last render, with a tick → low-res
    // would render, but hi-res should NOT (interval not yet elapsed).
    const justUnder = renderIntervalFor(1000) - 1;
    const d = scheduleFrame({ elapsed: STEP_MS, acc: 0, forcePresent: false, lastRender: 0, now: justUnder, size: 1000 });
    // At hi-res, a single tick alone does not force a render; the interval must elapse.
    expect(d.shouldRender).toBe(false);
  });

  it('renders at hi-res once the 30-FPS interval has elapsed', () => {
    const interval = renderIntervalFor(1000);
    const d = scheduleFrame({ elapsed: STEP_MS, acc: 0, forcePresent: false, lastRender: 0, now: interval, size: 1000 });
    expect(d.shouldRender).toBe(true);
  });

  it('uses 60 FPS interval below the threshold', () => {
    expect(renderIntervalFor(799)).toBe(1000 / 60);
    expect(renderIntervalFor(HIRES_THRESHOLD)).toBe(1000 / 30);
  });
});

describe('scheduleFrame — priority present', () => {
  it('forces a render even inside the hi-res throttle window', () => {
    const d = scheduleFrame({ elapsed: STEP_MS, acc: 0, forcePresent: true, lastRender: 0, now: 5, size: 1000 });
    expect(d.shouldRender).toBe(true);
  });

  it('stops stepping after the tick a priority transient fires in', () => {
    // 3 steps available, but forcePresent breaks the loop after 1 tick so the
    // transient is presented in the frame it occurred.
    const d = scheduleFrame({ elapsed: STEP_MS * 3, acc: 0, forcePresent: true, lastRender: 0, now: STEP_MS * 3, size: 220 });
    expect(d.ticks).toBe(1);
    // Remaining ~2 steps carry forward to the next frame.
    expect(d.nextAcc).toBeGreaterThan(STEP_MS);
  });
});

describe('resumeAfterHidden', () => {
  it('discards accumulated time and forces an immediate render', () => {
    const r = resumeAfterHidden(5000);
    expect(r.acc).toBe(0);           // no catch-up burst
    expect(r.lastTime).toBe(5000);   // anchored at resume time
    expect(r.lastRender).toBe(0);    // forces render on the first frame back
  });

  it('produces zero ticks on the first frame after resume regardless of gap', () => {
    // Simulate: hidden for 10s, resume, then the first frame fires immediately.
    const r = resumeAfterHidden(10000);
    const d = scheduleFrame({ elapsed: 1, acc: r.acc, forcePresent: false, lastRender: r.lastRender, now: 10001, size: 1000 });
    expect(d.ticks).toBe(0); // ~1ms elapsed → no tick; the 10s gap is gone
  });
});
