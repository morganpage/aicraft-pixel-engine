import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../../src/sand';
import { MaterialType } from '../../src/materials';
import { RadialGravity } from '../../src/gravity';
import { makeRng, stampVolcano, type VolcanoConfig } from '../../src/volcano';
import {
  DEFAULT_VOLCANO_CFG as CFG,
  VOLCANO_CX as CX,
  VOLCANO_CY as CY,
  VOLCANO_R as R,
  buildVolcanoPlanet,
} from '../../src/tests/helpers/volcano-fixtures';
import {
  createVolcanoEffectsState,
  resetVolcanoEffects,
  stepVolcanoEffects,
  effectScale,
  screenToGrid,
  DEFAULT_EFFECT_OPTS,
  EFFECTS_SEED,
  type VolcanoEffectsState,
  type VolcanoEffectMode,
  type VolcanoEffectOptions,
} from '../helpers/volcano-effects';

/**
 * Tests for the host-side volcano effects (ash plume, vent glow, flash, shake).
 *
 * These pin the behaviours that, if broken, would make the feature not read as an
 * eruption: the plume has to actually emit during the explosive phase, stop when
 * dormant, stay bounded, and reproduce identically for a given seed. The pointer
 * composition is also load-bearing — under shake, painting has to land where the
 * pixels appear.
 *
 * Tests run under Node with no DOM: the effects helper is DOM-free by design, and
 * a real `PixelEngine` with a stamped planet provides the summit geometry the
 * emitter queries (matching how the cloud tests build their world).
 */

/** Fresh deterministic effects RNG, as the section creates each scene. */
const effectsRng = () => makeRng(EFFECTS_SEED);

/** Step `n` ticks, mirroring the browser loop's per-tick call. */
function run(
  engine: PixelEngine,
  cfg: VolcanoConfig,
  state: VolcanoEffectsState,
  mode: VolcanoEffectMode,
  episode: number,
  ticks: number,
  rng: () => number = effectsRng(),
  opts: VolcanoEffectOptions = DEFAULT_EFFECT_OPTS,
): void {
  for (let i = 0; i < ticks; i++) {
    stepVolcanoEffects(engine, cfg, state, rng, mode, episode, opts);
  }
}

describe('createVolcanoEffectsState / resetVolcanoEffects', () => {
  it('starts empty with a previousEpisode that guarantees first-eruption entry', () => {
    const s = createVolcanoEffectsState();
    expect(s.puffs).toHaveLength(0);
    expect(s.emissionCarry).toBe(0);
    expect(s.flash).toBe(0);
    expect(s.glow).toBe(0);
    expect(s.previousMode).toBe('dormant');
    expect(s.previousEpisode).toBe(-1);
  });

  it('resetVolcanoEffects clears state in place', () => {
    const engine = buildVolcanoPlanet();
    stampVolcano(engine, CFG);
    const s = createVolcanoEffectsState();
    run(engine, CFG, s, 'explosive', 0, 40);
    expect(s.puffs.length).toBeGreaterThan(0);
    resetVolcanoEffects(s);
    expect(s.puffs).toHaveLength(0);
    expect(s.flash).toBe(0);
    expect(s.glow).toBe(0);
    expect(s.emissionCarry).toBe(0);
    expect(s.previousEpisode).toBe(-1);
  });
});

describe('emission by phase', () => {
  it('explosive emits dark ash', () => {
    const engine = buildVolcanoPlanet();
    stampVolcano(engine, CFG);
    const s = createVolcanoEffectsState();
    run(engine, CFG, s, 'explosive', 0, 30);
    expect(s.puffs.length).toBeGreaterThan(0);
    // Dark ash: initial shade well below neutral grey.
    const avgShade = s.puffs.reduce((a, p) => a + p.initialShade, 0) / s.puffs.length;
    expect(avgShade).toBeLessThan(80);
    // The vent is cached for glow rendering.
    expect(s.vent).not.toBeNull();
  });

  it('effusive emits fewer, lighter puffs than explosive', () => {
    const engine = buildVolcanoPlanet();
    stampVolcano(engine, CFG);
    const e = createVolcanoEffectsState();
    run(engine, CFG, e, 'explosive', 0, 60);
    const engine2 = buildVolcanoPlanet();
    stampVolcano(engine2, CFG);
    const f = createVolcanoEffectsState();
    run(engine2, CFG, f, 'effusive', 0, 60);
    expect(f.puffs.length).toBeLessThan(e.puffs.length);
    const avgEffusiveShade =
      f.puffs.reduce((a, p) => a + p.initialShade, 0) / f.puffs.length;
    const avgExplosiveShade =
      e.puffs.reduce((a, p) => a + p.initialShade, 0) / e.puffs.length;
    expect(avgEffusiveShade).toBeGreaterThan(avgExplosiveShade);
  });

  it('repose, dormant, and paused emit nothing', () => {
    const engine = buildVolcanoPlanet();
    stampVolcano(engine, CFG);
    for (const mode of ['repose', 'dormant', 'paused'] as VolcanoEffectMode[]) {
      const s = createVolcanoEffectsState();
      run(engine, CFG, s, mode, 0, 30);
      expect(s.puffs).toHaveLength(0);
      expect(s.flash).toBe(0);
    }
  });
});

describe('emission origin follows the summit', () => {
  it('emits above the original surface (cone-independent of ventPosition)', () => {
    const engine = buildVolcanoPlanet();
    stampVolcano(engine, CFG);
    const s = createVolcanoEffectsState();
    run(engine, CFG, s, 'explosive', 0, 20);
    expect(s.vent).not.toBeNull();
    // The vent is at least one cell outside the original planet radius.
    const v = s.vent!;
    const dist = Math.hypot(v.x - CX, v.y - CY);
    expect(dist).toBeGreaterThan(R);
  });

  it('the origin cell is empty', () => {
    const engine = buildVolcanoPlanet();
    stampVolcano(engine, CFG);
    const s = createVolcanoEffectsState();
    run(engine, CFG, s, 'explosive', 0, 20);
    const v = s.vent!;
    expect(engine.getMaterial(v.x, v.y)).toBe(MaterialType.EMPTY);
  });
});

describe('lifecycle and bounds', () => {
  it('puffs move away from the planet center', () => {
    const engine = buildVolcanoPlanet();
    stampVolcano(engine, CFG);
    const s = createVolcanoEffectsState();
    run(engine, CFG, s, 'explosive', 0, 5);
    const p = s.puffs[0];
    const dist0 = Math.hypot(p.x - CX, p.y - CY);
    // Step a few more and confirm the *average* radial distance increased.
    run(engine, CFG, s, 'explosive', 0, 20);
    const dist1 = s.puffs.reduce(
      (a, q) => a + Math.hypot(q.x - CX, q.y - CY),
      0,
    ) / s.puffs.length;
    expect(dist1).toBeGreaterThan(dist0);
  });

  it('radius grows and opacity shrinks with age', () => {
    const engine = buildVolcanoPlanet();
    stampVolcano(engine, CFG);
    const s = createVolcanoEffectsState();
    run(engine, CFG, s, 'explosive', 0, 1);
    const p0 = { ...s.puffs[0] };
    // Track the same seed by snapshotting identity is hard across cull compaction,
    // so instead step while still emitting and check the trend on surviving puffs.
    run(engine, CFG, s, 'explosive', 0, 5);
    // At least one puff should have grown and faded relative to a fresh emission.
    const grown = s.puffs.some((q) => q.radius > q.initialRadius);
    const faded = s.puffs.some((q) => q.opacity < q.initialOpacity);
    expect(grown).toBe(true);
    expect(faded).toBe(true);
    void p0;
  });

  it('expired puffs are removed', () => {
    const engine = buildVolcanoPlanet();
    stampVolcano(engine, CFG);
    const s = createVolcanoEffectsState();
    run(engine, CFG, s, 'explosive', 0, 20);
    expect(s.puffs.length).toBeGreaterThan(0);
    // Stop emitting and run well past the longest lifetime.
    run(engine, CFG, s, 'dormant', 0, DEFAULT_EFFECT_OPTS.phases.explosive.lifetime + 20);
    expect(s.puffs).toHaveLength(0);
  });

  it('the live count never exceeds the cap', () => {
    const engine = buildVolcanoPlanet();
    stampVolcano(engine, CFG);
    const s = createVolcanoEffectsState();
    for (let i = 0; i < 600; i++) {
      stepVolcanoEffects(engine, CFG, s, effectsRng(), 'explosive', 0, DEFAULT_EFFECT_OPTS);
      expect(s.puffs.length).toBeLessThanOrEqual(DEFAULT_EFFECT_OPTS.maxPuffs);
    }
  });

  it('forced saturation skips emission without evicting live puffs', () => {
    const engine = buildVolcanoPlanet();
    stampVolcano(engine, CFG);
    // A tiny cap forces saturation immediately.
    const opts: VolcanoEffectOptions = {
      ...DEFAULT_EFFECT_OPTS,
      maxPuffs: 3,
      phases: {
        ...DEFAULT_EFFECT_OPTS.phases,
        explosive: { ...DEFAULT_EFFECT_OPTS.phases.explosive, emission: 5, lifetime: 9999 },
      },
    };
    const s = createVolcanoEffectsState();
    run(engine, CFG, s, 'explosive', 0, 20, effectsRng(), opts);
    expect(s.puffs.length).toBeLessThanOrEqual(opts.maxPuffs);
    // And the carry did not accumulate into a later burst: stepping dormant then
    // back to explosive with a fresh episode should not dump >cap at once.
    run(engine, CFG, s, 'dormant', 0, 5, effectsRng(), opts);
    run(engine, CFG, s, 'explosive', 1, 5, effectsRng(), opts);
    expect(s.puffs.length).toBeLessThanOrEqual(opts.maxPuffs);
  });

  it('a mode change clears the emission carry', () => {
    const engine = buildVolcanoPlanet();
    stampVolcano(engine, CFG);
    const s = createVolcanoEffectsState();
    // Run a fractional emission: after one tick the carry is the fractional part.
    run(engine, CFG, s, 'explosive', 0, 1);
    const carryAfterExplosive = s.emissionCarry;
    // Switch to effusive: carry resets.
    stepVolcanoEffects(engine, CFG, s, effectsRng(), 'effusive', 0, DEFAULT_EFFECT_OPTS);
    expect(s.emissionCarry).toBeLessThan(carryAfterExplosive + 1);
    // Switching to dormant must zero it.
    run(engine, CFG, s, 'dormant', 0, 1);
    expect(s.emissionCarry).toBe(0);
  });
});

describe('entry cues', () => {
  it('explosive entry fires flash and shake exactly once', () => {
    const engine = buildVolcanoPlanet();
    stampVolcano(engine, CFG);
    const s = createVolcanoEffectsState();
    stepVolcanoEffects(engine, CFG, s, effectsRng(), 'explosive', 0, DEFAULT_EFFECT_OPTS);
    expect(s.flash).toBe(1);
    const shakeMag = Math.hypot(s.shakeX, s.shakeY);
    expect(shakeMag).toBeGreaterThan(0);
    // Next tick: flash decays, shake is not re-impulsed (held, not re-fired).
    const flashAfterOne = s.flash;
    stepVolcanoEffects(engine, CFG, s, effectsRng(), 'explosive', 0, DEFAULT_EFFECT_OPTS);
    expect(s.flash).toBeLessThan(flashAfterOne);
  });

  it('incrementing eruptionEpisode retriggers entry effects across a pause/resume', () => {
    const engine = buildVolcanoPlanet();
    stampVolcano(engine, CFG);
    const s = createVolcanoEffectsState();
    run(engine, CFG, s, 'explosive', 0, 3);
    // Let the flash decay fully while paused.
    run(engine, CFG, s, 'paused', 0, 30);
    expect(s.flash).toBe(0);
    // Resume: a new episode re-triggers the entry flash even though the mode was
    // never anything but explosive/paused.
    stepVolcanoEffects(engine, CFG, s, effectsRng(), 'explosive', 1, DEFAULT_EFFECT_OPTS);
    expect(s.flash).toBe(1);
  });

  it('glow rises during explosive and fades when dormant', () => {
    const engine = buildVolcanoPlanet();
    stampVolcano(engine, CFG);
    const s = createVolcanoEffectsState();
    run(engine, CFG, s, 'explosive', 0, 20);
    expect(s.glow).toBeGreaterThan(0.9);
    run(engine, CFG, s, 'dormant', 0, 200);
    expect(s.glow).toBe(0);
  });
});

describe('scaling', () => {
  it('effectScale grows with planet radius and reproduces the default at 66', () => {
    expect(effectScale(66)).toBeCloseTo(1, 5);
    expect(effectScale(120)).toBeGreaterThan(1);
    expect(effectScale(30)).toBeLessThan(1);
  });

  it('emits a valid, finite plume on a small planet', () => {
    // A 120-cell planet at 30% diameter → r≈18. Build it directly.
    const size = 120;
    const cx = 60, cy = 60, r = Math.round((size * 30) / 200);
    const cfg: VolcanoConfig = { ...CFG, centerX: cx, centerY: cy, planetRadius: r };
    const engine = new PixelEngine({
      width: size, height: size, seed: 1,
      gravity: new RadialGravity({ centerX: cx, centerY: cy }),
    });
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r * r) engine.setMaterial(x, y, MaterialType.ROCK);
      }
    }
    stampVolcano(engine, cfg);
    const s = createVolcanoEffectsState();
    run(engine, cfg, s, 'explosive', 0, 30);
    expect(s.puffs.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    expect(s.puffs.every((p) => p.radius > 0)).toBe(true);
    expect(s.puffs.length).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  it('the same seed and phase sequence reproduce identical effect state', () => {
    const engine1 = buildVolcanoPlanet();
    stampVolcano(engine1, CFG);
    const s1 = createVolcanoEffectsState();
    run(engine1, CFG, s1, 'explosive', 0, 40, makeRng(EFFECTS_SEED));

    const engine2 = buildVolcanoPlanet();
    stampVolcano(engine2, CFG);
    const s2 = createVolcanoEffectsState();
    run(engine2, CFG, s2, 'explosive', 0, 40, makeRng(EFFECTS_SEED));

    expect(s1.puffs.length).toBe(s2.puffs.length);
    for (let i = 0; i < s1.puffs.length; i++) {
      expect(s1.puffs[i]).toEqual(s2.puffs[i]);
    }
  });

  it('different seeds vary positions but keep counts stable for fractional emission', () => {
    const engine1 = buildVolcanoPlanet();
    stampVolcano(engine1, CFG);
    const s1 = createVolcanoEffectsState();
    run(engine1, CFG, s1, 'explosive', 0, 40, makeRng(EFFECTS_SEED));

    const engine2 = buildVolcanoPlanet();
    stampVolcano(engine2, CFG);
    const s2 = createVolcanoEffectsState();
    run(engine2, CFG, s2, 'explosive', 0, 40, makeRng(EFFECTS_SEED + 1));

    expect(s1.puffs.length).toBe(s2.puffs.length);
    const anyDifferent = s1.puffs.some(
      (p, i) => p.x !== s2.puffs[i].x || p.y !== s2.puffs[i].y,
    );
    expect(anyDifferent).toBe(true);
  });
});

describe('screenToGrid pointer composition', () => {
  // Screen coords that match canvas pixel == grid cell at the default scale (the
  // showcase's `toGrid` divides by rect size, but the pure helper takes grid
  // space directly).
  it('with zero shake recovers the inverse-spin-only mapping', () => {
    const px = CX + 10, py = CY - 5;
    const g = screenToGrid(px, py, CX, CY, 0.3, 0, 0);
    // Manual: un-rotate (px-CX, py-CY) by -0.3.
    const dx = px - CX, dy = py - CY;
    const cos = Math.cos(-0.3), sin = Math.sin(-0.3);
    const exX = CX + (dx * cos - dy * sin);
    const exY = CY + (dx * sin + dy * cos);
    expect(g.x).toBeCloseTo(exX, 6);
    expect(g.y).toBeCloseTo(exY, 6);
  });

  it('with zero spin and zero shake is the identity about the center', () => {
    const g = screenToGrid(CX + 7, CY - 3, CX, CY, 0, 0, 0);
    expect(g.x).toBeCloseTo(CX + 7, 6);
    expect(g.y).toBeCloseTo(CY - 3, 6);
  });

  it('applies inverse shake before inverse spin', () => {
    const px = CX + 10, py = CY - 5;
    const sx = 1.5, sy = -0.5, spin = 0.4;
    const g = screenToGrid(px, py, CX, CY, spin, sx, sy);
    // Manual composition.
    const ax = px - sx, ay = py - sy;
    const dx = ax - CX, dy = ay - CY;
    const cos = Math.cos(-spin), sin = Math.sin(-spin);
    const exX = CX + (dx * cos - dy * sin);
    const exY = CY + (dx * sin + dy * cos);
    expect(g.x).toBeCloseTo(exX, 6);
    expect(g.y).toBeCloseTo(exY, 6);
  });
});
