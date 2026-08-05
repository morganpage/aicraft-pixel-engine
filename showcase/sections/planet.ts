/**
 * Section 2 — Radial-gravity planet.
 *
 * A square `PixelEngine` with `RadialGravity` centered in the grid, plus a
 * pre-stamped disc planet. Every material falls *toward the planet center*
 * and settles as a ring on its surface — the defining god-game behavior
 * (Reus / Godfinger style) and the reason the gravity seam exists. Paint
 * sand/water anywhere in the void and watch it curve inward.
 *
 * Shares the renderer helper and loop shape with the sandbox section; only
 * the gravity model, scene setup, and brush set differ.
 *
 * Grid resolution and planet diameter are both live sliders. Neither can be
 * changed in place — `PixelEngine` sizes its grids and chunk bitmaps in its
 * constructor and exposes `width`/`height` as readonly — so changing either
 * rebuilds the scene (see {@link buildWorld}). Everything depending on the two
 * therefore lives in a {@link World} record rather than in module constants,
 * and every closure below reads it through the mutable `world` binding.
 */

import { PixelEngine } from '../../src/sand';
import { MaterialType, Materials } from '../../src/materials';
import { RadialGravity } from '../../src/gravity';
import { paintGridInto, buildPalette, type DirtyReport } from '../helpers/renderer';
import { scheduleFrame, resumeAfterHidden } from '../helpers/frame-scheduler';
import { attachViewport } from '../helpers/viewport';
import {
  stampVolcano,
  createVolcanoState,
  makeRng,
  volcanoGeometryFor,
  buildVolcanoOpts,
  stepVolcanoFrame,
  type VolcanoConfig,
  type VolcanoStepOptions,
  type VolcanoRuntime,
  type VolcanoTimings,
} from '../helpers/volcano';
import {
  placeCloud,
  stepCloud,
  removeDead,
  cloudSpacing,
  DEFAULT_CLOUD_RADIUS,
  type Cloud,
  type CloudOptions,
} from '../helpers/cloud';
import {
  createVolcanoEffectsState,
  stepVolcanoEffects,
  screenToGrid,
  effectScale,
  DEFAULT_EFFECT_OPTS,
  EFFECTS_SEED,
  type VolcanoEffectsState,
  type VolcanoEffectMode,
} from '../helpers/volcano-effects';

/**
 * Per-tick visual rotation when spinning is on, in radians. ~0.2°/tick at
 * 60 Hz ≈ one full revolution every ~30 s — a slow, legible globe spin.
 *
 * This is purely visual: it drives a canvas ctx.rotate on the rendered image
 * and never touches the physics grid. The sim runs unrotated underneath.
 */
const SPIN_PER_TICK = (Math.PI / 180) * 0.2;

/** Sim ticks per second. */
const FPS = 60;

/** Seed for the volcano's PRNG, re-applied on every rebuild for determinism. */
const VOLCANO_SEED = 4242;

/** Seed for the clouds' rain-jitter PRNG, re-applied on every rebuild. */
const CLOUD_SEED = 707;

/**
 * Ticks averaged before the perf readout refreshes. Per-tick figures at 60 Hz
 * are unreadable noise; ~half a second of averaging is steady enough to compare
 * two slider positions by eye.
 */
const PERF_WINDOW = 30;

/** Everything that depends on grid resolution or planet diameter. */
interface World {
  /** Grid width and height, in cells (the grid is square). */
  size: number;
  /** Planet center — always the grid center. */
  cx: number;
  cy: number;
  /** Planet surface radius, in cells. */
  planetR: number;
  engine: PixelEngine;
  img: ImageData;
  /** Offscreen canvas holding the unrotated grid (see the render notes below). */
  off: HTMLCanvasElement;
  offCtx: CanvasRenderingContext2D;
  volcanoCfg: VolcanoConfig;
  /** Edifice height the first eruption builds to. */
  capStart: number;
  /** Added to the cap by each "Erupt again". */
  capStep: number;
  /** Ceiling the cap may never exceed. */
  capMax: number;
  /** Radius at which 🌍 Scatter drops its shell, in cells. */
  scatterR: number;
}

/** Stamp the planet disc into the engine. */
function stampPlanet(world: World): void {
  const { engine, size, cx, cy, planetR } = world;
  const r2 = planetR * planetR;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        engine.setMaterial(x, y, MaterialType.ROCK);
      }
    }
  }
}

/**
 * Build the world for a given resolution and diameter, and stamp the planet.
 *
 * `prev` is reused when the resolution is unchanged: a diameter-only change
 * needs nothing more than a cleared grid and a fresh stamp, so it skips
 * reallocating the engine, the ImageData, and the offscreen canvas. Only a
 * resolution change has to construct a new engine.
 *
 * @param size - grid width/height, in cells
 * @param diameterPct - planet diameter as a percentage of the grid width
 * @param canvas - the visible canvas, resized to match `size`
 * @param prev - the outgoing world, reused when its resolution matches
 */
function buildWorld(
  size: number,
  diameterPct: number,
  canvas: HTMLCanvasElement,
  prev?: World,
): World {
  const cx = size / 2;
  const cy = size / 2;
  const planetR = Math.round((size * diameterPct) / 200);
  /** Free cells between the planet surface and the nearest grid edge. */
  const headroom = size / 2 - planetR;

  const reuse = prev && prev.size === size ? prev : undefined;

  let engine: PixelEngine;
  let img: ImageData;
  let off: HTMLCanvasElement;
  let offCtx: CanvasRenderingContext2D;

  if (reuse) {
    engine = reuse.engine;
    engine.clear();
    img = reuse.img;
    off = reuse.off;
    offCtx = reuse.offCtx;
  } else {
    // Resizing the backing store resets every context property, so the visible
    // context's imageSmoothingEnabled has to be re-applied by the caller.
    canvas.width = size;
    canvas.height = size;

    engine = new PixelEngine({
      width: size,
      height: size,
      seed: 1,
      gravity: new RadialGravity({ centerX: cx, centerY: cy }),
      // The volcano runs on the engine's heat field: lava is born hot, cools by
      // exposure, and freezes to rock on its own. `ambientTemperature` is the
      // dial the Ambient slider drives -- it sets how cold the world the flows
      // are losing heat to is, so it is what decides whether they set into
      // short stubby tongues or drape the whole cone.
      enableHeat: true,
      // The volcano's pressure source fractures frozen conduit rock to reopen a
      // blocked vent. The default of 1/frame is too slow to clear a ~26-cell
      // bore before it re-freezes; 4 lets a new effusive episode break through
      // in under 10 frames.
      fracturePerFrame: 4,
    });

    // Offscreen canvas holds the unrotated grid each frame. The visible canvas
    // then draws it via drawImage under a ctx.rotate transform — so the spin is
    // purely visual. putImageData ignores transforms, which is why we render to
    // an offscreen first and drawImage it back rotated. The physics grid is
    // never touched by the spin.
    off = document.createElement('canvas');
    off.width = size;
    off.height = size;
    offCtx = off.getContext('2d')!;
    img = offCtx.createImageData(size, size);
  }

  const geom = volcanoGeometryFor(cx, cy, planetR, headroom);

  const world: World = {
    size,
    cx,
    cy,
    planetR,
    engine,
    img,
    off,
    offCtx,
    volcanoCfg: geom.cfg,
    capStart: geom.capStart,
    capStep: geom.capStep,
    capMax: geom.capMax,
    // Far enough out to read as orbit, but never past the grid edge — on a
    // wide planet there is barely any void left to drop material into.
    scatterR: planetR + Math.max(3, Math.min(Math.round(planetR * 0.2), headroom - 2)),
  };

  stampPlanet(world);
  return world;
}

/**
 * Initialize the planet section.
 *
 * @param container - the `<section id="planet">` element
 */
export function initPlanet(container: HTMLElement): void {
  const canvas = container.querySelector<HTMLCanvasElement>('.planet-canvas')!;
  const ctx = canvas.getContext('2d')!;

  const palette = buildPalette(Materials as Record<number, { color: readonly number[] }>);

  // User preference: when set, the eruption's screen shake is suppressed in both
  // render and pointer compensation, while the DOM-free effects state stays
  // identical (so deterministic tests are unaffected). Queried once, live.
  const reduceMotion = () =>
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  // --- Resolution + diameter sliders --------------------------------------
  // Read before the world exists, because they are what define it.
  const resInput = container.querySelector<HTMLInputElement>('.planet-resolution')!;
  const resValue = container.querySelector<HTMLElement>('.planet-resolution-value')!;
  const diaInput = container.querySelector<HTMLInputElement>('.planet-diameter')!;
  const diaValue = container.querySelector<HTMLElement>('.planet-diameter-value')!;
  const perfValue = container.querySelector<HTMLElement>('.planet-perf')!;

  let world = buildWorld(Number(resInput.value), Number(diaInput.value), canvas);
  ctx.imageSmoothingEnabled = false;

  // --- View ----------------------------------------------------------------
  // A CSS transform on the canvas, so `toGrid` needs no knowledge of it — the
  // transformed `getBoundingClientRect()` keeps its screen→grid maths correct,
  // and the spin un-rotation composes on top unchanged. Pan gestures are
  // swallowed in the capture phase before they reach the paint handlers.
  attachViewport({
    viewport: container.querySelector<HTMLElement>('.canvas-viewport')!,
    canvas,
    zoomIn: container.querySelector<HTMLButtonElement>('.viewctl-in')!,
    zoomOut: container.querySelector<HTMLButtonElement>('.viewctl-out')!,
    fit: container.querySelector<HTMLButtonElement>('.viewctl-fit')!,
    pan: container.querySelector<HTMLButtonElement>('.viewctl-pan')!,
    readout: container.querySelector<HTMLElement>('.viewctl-level')!,
  });

  // --- Brush state ---------------------------------------------------------
  let activeBrush: MaterialType = MaterialType.SAND;
  let brushRadius = 3;
  let painting = false;

  // --- Spin state ----------------------------------------------------------
  // Purely visual: spinAngle drives a ctx.rotate on the rendered canvas image
  // (see render). The physics grid is NEVER touched by the spin — material
  // still falls toward the center in the unrotated simulation underneath. So
  // a spinning planet looks like a rotating globe while remaining physically
  // static, which is exactly what reads as a god-game planet.
  let spinning = false;
  let spinAngle = 0;

  const brushButtons = container.querySelectorAll<HTMLButtonElement>('.planet-brush');
  const brushSize = container.querySelector<HTMLInputElement>('.planet-brush-size')!;
  const brushSizeValue = container.querySelector<HTMLElement>('.planet-brush-size-value')!;
  const scatterBtn = container.querySelector<HTMLButtonElement>('.planet-scatter')!;
  const volcanoBtn = container.querySelector<HTMLButtonElement>('.planet-volcano')!;
  const clearBtn = container.querySelector<HTMLButtonElement>('.planet-clear')!;
  const spinBtn = container.querySelector<HTMLButtonElement>('.planet-spin')!;
  const cloudBtn = container.querySelector<HTMLButtonElement>('.planet-cloud')!;

  const setActive = (mat: MaterialType): void => {
    activeBrush = mat;
    brushButtons.forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.mat === String(mat)));
    });
  };
  brushButtons.forEach((b) => {
    b.addEventListener('click', () => {
      setActive(Number(b.dataset.mat));
      b.blur();
    });
  });
  setActive(MaterialType.SAND);

  const applyBrushSize = (v: number): void => {
    brushRadius = v;
    brushSizeValue.textContent = String(v);
  };
  applyBrushSize(Number(brushSize.value));
  brushSize.addEventListener('input', () => applyBrushSize(Number(brushSize.value)));

  // --- Volcano tuning sliders ---------------------------------------------
  // Live values for the eruption. Each `input` event updates both the display
  // and the value the loop reads next tick, so changes apply mid-eruption.
  // Mirrors the brush-size slider pattern above.
  const ambientInput = container.querySelector<HTMLInputElement>('.planet-volcano-ambient')!;
  const ambientValue = container.querySelector<HTMLElement>('.planet-volcano-ambient-value')!;
  const effusionInput = container.querySelector<HTMLInputElement>('.planet-volcano-effusion')!;
  const effusionValue = container.querySelector<HTMLElement>('.planet-volcano-effusion-value')!;
  const spreadInput = container.querySelector<HTMLInputElement>('.planet-volcano-spread')!;
  const spreadValue = container.querySelector<HTMLElement>('.planet-volcano-spread-value')!;
  const phaseLabel = container.querySelector<HTMLElement>('.planet-volcano-phase')!;

  const volcanoParams = {
    ambient: Number(ambientInput.value),
    effusion: Number(effusionInput.value),
    spread: Number(spreadInput.value),
    fountainRate: 1,
    fountainPressure: 100,
    fragmentsAt: 0.65,
    tephraStrength: 6,
  };
  // Temporary fountain/fragmentation tuning sliders (remove after tuning).
  const frateInput = container.querySelector<HTMLInputElement>('.planet-volcano-frate')!;
  const frateValue = container.querySelector<HTMLElement>('.planet-volcano-frate-value')!;
  const fpressInput = container.querySelector<HTMLInputElement>('.planet-volcano-fpress')!;
  const fpressValue = container.querySelector<HTMLElement>('.planet-volcano-fpress-value')!;
  const fragInput = container.querySelector<HTMLInputElement>('.planet-volcano-frag')!;
  const fragValue = container.querySelector<HTMLElement>('.planet-volcano-frag-value')!;
  const tstrengthInput = container.querySelector<HTMLInputElement>('.planet-volcano-tstrength')!;
  const tstrengthValue = container.querySelector<HTMLElement>('.planet-volcano-tstrength-value')!;
  volcanoParams.fountainRate = Number(frateInput.value);
  volcanoParams.fountainPressure = Number(fpressInput.value);
  volcanoParams.fragmentsAt = Number(fragInput.value);
  volcanoParams.tephraStrength = Number(tstrengthInput.value);
  frateInput.addEventListener('input', () => {
    volcanoParams.fountainRate = Number(frateInput.value);
    frateValue.textContent = fmt(volcanoParams.fountainRate);
  });
  fpressInput.addEventListener('input', () => {
    volcanoParams.fountainPressure = Number(fpressInput.value);
    fpressValue.textContent = fmt(volcanoParams.fountainPressure);
  });
  fragInput.addEventListener('input', () => {
    volcanoParams.fragmentsAt = Number(fragInput.value);
    fragValue.textContent = volcanoParams.fragmentsAt.toFixed(2);
    // Apply live to the material definition so fragmentation takes effect
    // immediately without restarting the eruption.
    Materials[MaterialType.LAVA].fragmentsAt = volcanoParams.fragmentsAt;
  });
  tstrengthInput.addEventListener('input', () => {
    volcanoParams.tephraStrength = Number(tstrengthInput.value);
    tstrengthValue.textContent = String(volcanoParams.tephraStrength);
    // Applied straight to the material def: the engine's fracture path reads
    // pressureStrength each attempt, so a vent-capping tephra crust instantly
    // becomes easier or harder to punch through without rebuilding the world.
    Materials[MaterialType.TEPHRA].pressureStrength = volcanoParams.tephraStrength;
  });

  const fmt = (v: number): string => Number.isInteger(v) ? String(v) : v.toFixed(2);
  world.engine.ambientTemperature = volcanoParams.ambient;
  ambientInput.addEventListener('input', () => {
    volcanoParams.ambient = Number(ambientInput.value);
    ambientValue.textContent = fmt(volcanoParams.ambient);
    // Applied straight to the live engine rather than stashed for the next
    // frame: ambient temperature is settable at runtime, and setting it wakes
    // every thermal chunk so already-settled regions pick the change up too.
    world.engine.ambientTemperature = volcanoParams.ambient;
  });
  effusionInput.addEventListener('input', () => {
    volcanoParams.effusion = Number(effusionInput.value);
    effusionValue.textContent = fmt(volcanoParams.effusion);
  });
  spreadInput.addEventListener('input', () => {
    volcanoParams.spread = Number(spreadInput.value);
    spreadValue.textContent = fmt(volcanoParams.spread);
  });

  // --- Cloud tuning slider ------------------------------------------------
  // Same live-value pattern as the volcano sliders: the rain rate is read fresh
  // each tick so a slider drag applies immediately to clouds already raining.
  const rainInput = container.querySelector<HTMLInputElement>('.planet-rain')!;
  const rainValue = container.querySelector<HTMLElement>('.planet-rain-value')!;
  const cloudParams = { rain: Number(rainInput.value) };
  rainInput.addEventListener('input', () => {
    cloudParams.rain = Number(rainInput.value);
    rainValue.textContent = String(cloudParams.rain);
  });

  /**
   * Read cloud tuning fresh each tick — the rain rate is a live slider value,
   * and `placeCloud`'s spacing depends on the (fixed) cloud radius.
   */
  const cloudOpts = (): CloudOptions => ({ rainPerTick: cloudParams.rain });

  /** Stamp a filled disc of the active brush at grid coords (gx, gy). */
  const stamp = (gx: number, gy: number): void => {
    const r2 = brushRadius * brushRadius;
    for (let dy = -brushRadius; dy <= brushRadius; dy++) {
      for (let dx = -brushRadius; dx <= brushRadius; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        world.engine.setMaterial(gx + dx, gy + dy, activeBrush);
      }
    }
  };

  const toGrid = (e: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    // Screen pixel → grid cell, relative to the planet center.
    const px = ((e.clientX - rect.left) / rect.width) * world.size;
    const py = ((e.clientY - rect.top) / rect.height) * world.size;
    // The canvas renders world pixels under a translate(shake) · rotate(spin)
    // transform (see render). To land the brush on what you actually SEE, invert
    // both: undo the shake translation, then un-rotate by -spinAngle about the
    // center. Shake is suppressed under reduced-motion, and the pure helper is
    // tested independently under Node. At zero shake/angle this is the identity.
    const sx = reduceMotion() ? 0 : effectsState.shakeX;
    const sy = reduceMotion() ? 0 : effectsState.shakeY;
    const g = screenToGrid(px, py, world.cx, world.cy, spinAngle, sx, sy);
    return { x: Math.floor(g.x), y: Math.floor(g.y) };
  };

  // --- Cloud state --------------------------------------------------------
  // A cloud is a host-tracked visual entity that rains real WATER into the grid
  // (see helpers/cloud.ts for why it isn't an engine material). `cloudMode`
  // routes pointer events to cloud placement instead of the brush; the cloud
  // list and PRNG live here so they reset with the scene like the volcano's do.
  let cloudMode = false;
  let clouds: Cloud[] = [];
  let cloudRng = makeRng(CLOUD_SEED);
  // Last cell a cloud was placed at, so a drag can space successive clouds apart
  // rather than stamping one per pixel of travel.
  let lastCloudAt: { x: number; y: number } | null = null;

  /**
   * Drop a cloud centred at grid cell `(x, y)`, honouring the placement guard
   * (only in the void above the surface) and the drag spacing (skip until the
   * pointer has moved at least one cloud-diameter from the last cloud).
   */
  const tryPlaceCloud = (x: number, y: number): void => {
    const spacing = cloudSpacing(DEFAULT_CLOUD_RADIUS);
    if (lastCloudAt) {
      const ddx = x - lastCloudAt.x;
      const ddy = y - lastCloudAt.y;
      if (ddx * ddx + ddy * ddy < spacing * spacing) return;
    }
    // Project the section's World into the helper's narrow PlanetView, so the
    // DOM-facing layer stays the only place that knows about the canvas/engine.
    const cloud = placeCloud(
      { centerX: world.cx, centerY: world.cy, planetRadius: world.planetR, size: world.size },
      x,
      y,
      DEFAULT_CLOUD_RADIUS,
    );
    if (!cloud) return; // on/in the planet, or off-grid: do nothing.
    clouds.push(cloud);
    lastCloudAt = { x, y };
  };

  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => {
    painting = true;
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = toGrid(e);
    if (cloudMode) { tryPlaceCloud(x, y); return; }
    stamp(x, y);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!painting) return;
    const { x, y } = toGrid(e);
    if (cloudMode) { tryPlaceCloud(x, y); return; }
    stamp(x, y);
  });
  canvas.addEventListener('pointerup', () => { painting = false; });
  canvas.addEventListener('pointercancel', () => { painting = false; });

  // 🌍 Scatter — drop a shell of mixed material around the planet to
  // demonstrate radial settling (the behavior golden from the engine tests,
  // made visible). Alternates sand and water for a stratified look.
  scatterBtn.addEventListener('click', () => {
    // Spacing is held at ~3 cells rather than at a fixed angular step, so the
    // shell reads the same on a small planet and on a large one.
    const points = Math.max(12, Math.round((2 * Math.PI * world.scatterR) / 3));
    for (let i = 0; i < points; i++) {
      const rad = (i / points) * 2 * Math.PI;
      const sx = Math.round(world.cx + Math.cos(rad) * world.scatterR);
      const sy = Math.round(world.cy + Math.sin(rad) * world.scatterR);
      world.engine.setMaterial(sx, sy, i % 2 === 0 ? MaterialType.WATER : MaterialType.SAND);
    }
    forcePresent = true; // show the scatter ring immediately, not at the next 30-FPS boundary
    scatterBtn.blur();
  });

  // 🌋 Volcano — carve a magma chamber and conduit, then erupt continuously.
  //
  // Built entirely on the engine's public API: the engine has no pressure term
  // and no lava→rock transition except contact with water, so the section
  // supplies both (see helpers/volcano.ts). Toggling it off leaves the terrain
  // it built in place.
  let erupting = false;
  let started = false;
  // Each eruption is finite: it builds until the cone reaches its cap, then the
  // volcano goes dormant. Erupting again raises the cap so the cone grows in
  // stages rather than either stopping forever or growing without bound.
  let capHeight = world.capStart;
  let volcanoRng = makeRng(VOLCANO_SEED);
  let volcanoState = createVolcanoState();

  // --- Volcano effects state ---------------------------------------------
  // The ash plume, vent glow, eruption flash, and screen shake. Host-tracked
  // entities rendered as a canvas overlay (see helpers/volcano-effects.ts for
  // why they are not engine materials). Owns its own PRNG so puff counts never
  // perturb the physical eruption's random stream.
  let effectsState: VolcanoEffectsState = createVolcanoEffectsState();
  let effectsRng = makeRng(EFFECTS_SEED);
  // Bumped on every explicit eruption start so the entry flash + shake retrigger
  // reliably — even across a pause/resume where no tick separates stop and start.
  let eruptionEpisode = 0;
  // The effect mode to use when not erupting: 'paused' (user clicked stop) or
  // 'dormant' (ran its course / scene reset). Both stop emission; the distinction
  // lets the plume fade out cleanly in either case.
  let stoppedEffectMode: VolcanoEffectMode = 'dormant';

  /**
   * Read the eruption's tuning fresh each tick, so slider changes apply
   * mid-eruption. The cap has to be read live too — "Erupt again" raises it.
   */
  const volcanoOpts = (): VolcanoStepOptions =>
    buildVolcanoOpts(world.volcanoCfg, {
      effusion: volcanoParams.effusion,
      fountainRate: volcanoParams.fountainRate,
      fountainPressure: volcanoParams.fountainPressure,
      // The cap grows cycle by cycle (capStart → +capStep → … → capMax); the
      // first cycle of a fresh planet starts at capStart.
      maxHeight: capHeight,
    });

  const PHASE_LABEL: Record<string, string> = {
    explosive: 'explosive — ash & tephra',
    effusive: 'effusive — lava flows',
    repose: 'repose — flows crusting over',
  };

  const setVolcanoLabel = (label: string, on: boolean): void => {
    volcanoBtn.setAttribute('aria-pressed', String(on));
    volcanoBtn.classList.toggle('active', on);
    volcanoBtn.textContent = label;
  };

  /**
   * Remove the live pressure source if one exists, so a paused or reset volcano
   * does not keep pumping magma into the grid with no host consuming the results.
   */
  const removeLiveSource = (): void => {
    if (volcanoState.sourceId !== null) {
      world.engine.removePressureSource(volcanoState.sourceId);
      volcanoState.sourceId = null;
    }
  };

  /**
   * The eruption ran its course. Say so explicitly — a scene that simply stops
   * moving is indistinguishable from the page having frozen, which is exactly
   * how this read before.
   */
  const goDormant = (): void => {
    removeLiveSource();
    erupting = false;
    stoppedEffectMode = 'dormant';
    setVolcanoLabel('🌋 Erupt again', false);
    phaseLabel.textContent = 'dormant';
  };

  /**
   * Return the scene to its opening state. Shared by 🧹 Clear and by both
   * rebuild paths — a resized world starts fresh for the same reason a cleared
   * one does. The volcano's PRNG is re-seeded too, so a given pair of slider
   * positions always produces the same eruption.
   */
  const resetScene = (): void => {
    removeLiveSource();
    spinAngle = 0;
    erupting = false;
    started = false;
    capHeight = world.capStart;
    volcanoRng = makeRng(VOLCANO_SEED);
    volcanoState = createVolcanoState();
    setVolcanoLabel('🌋 Volcano', false);
    phaseLabel.textContent = '—';
    // Clouds are cleared and the PRNG re-seeded for the same reproducibility
    // reason the volcano's is — a given pair of slider positions always paints
    // the same shower. Mode is left as-is so the user's tool choice survives a
    // Clear, matching how the brush selection does.
    clouds = [];
    cloudRng = makeRng(CLOUD_SEED);
    lastCloudAt = null;
    // Effects reset the same way: fresh state, re-seeded RNG, no residual puffs,
    // glow, flash, or shake. `eruptionEpisode` returns to 0 and the next eruption
    // bumps it to 1, which differs from the reset `previousEpisode` (-1) so the
    // opening flash + shake fire on the first eruption of a fresh scene.
    effectsState = createVolcanoEffectsState();
    effectsRng = makeRng(EFFECTS_SEED);
    eruptionEpisode = 0;
    stoppedEffectMode = 'dormant';
  };

  volcanoBtn.addEventListener('click', () => {
    if (erupting) {
      removeLiveSource();
      erupting = false;
      stoppedEffectMode = 'paused';
      setVolcanoLabel('🌋 Erupt again', false);
      phaseLabel.textContent = 'paused';
      volcanoBtn.blur();
      return;
    }
    if (!started) {
      stampVolcano(world.engine, world.volcanoCfg);
      started = true;
    } else {
      capHeight = Math.min(capHeight + world.capStep, world.capMax); // a taller cone each time
    }
    // Restart the cycle on its explosive phase, so resuming opens with a burst
    // rather than picking up mid-flow.
    volcanoState = createVolcanoState();
    // A new episode makes the effects helper re-fire the entry flash + shake even
    // across a pause/resume — see helpers/volcano-effects.ts stepVolcanoEffects.
    eruptionEpisode++;
    erupting = true;
    setVolcanoLabel('🌋 Erupting', true);
    volcanoBtn.blur();
  });

  clearBtn.addEventListener('click', () => {
    world.engine.clear();
    stampPlanet(world);
    resetScene();
    clearBtn.blur();
  });

  // 🌀 Spin — toggle a slow clockwise rotation of the grid's loose material.
  // The planet body is re-stamped each spin tick so it rotates perfectly
  // without sampling drift; painted sand/water/lava rides along.
  spinBtn.addEventListener('click', () => {
    spinning = !spinning;
    spinBtn.setAttribute('aria-pressed', String(spinning));
    spinBtn.classList.toggle('active', spinning);
    spinBtn.textContent = spinning ? '🌀 Spinning' : '🌀 Spin';
    spinBtn.blur();
  });

  // ☁ Cloud — enter cloud mode: drag above the surface to paint rain clouds.
  // A purely host-side feature; the engine only ever sees the WATER rain.
  cloudBtn.addEventListener('click', () => {
    cloudMode = !cloudMode;
    cloudBtn.setAttribute('aria-pressed', String(cloudMode));
    cloudBtn.classList.toggle('active', cloudMode);
    cloudBtn.textContent = cloudMode ? '☁ Cloud on' : '☁ Cloud';
    cloudBtn.blur();
  });

  // --- Resolution + diameter wiring ---------------------------------------
  // Rebuilding allocates a whole engine, so dragging a slider must not do it
  // once per pixel of travel. The label tracks the drag live while the rebuild
  // itself is debounced, which also keeps the sim running smoothly under the
  // dragging thumb instead of stuttering on every intermediate value.
  const REBUILD_DEBOUNCE_MS = 120;
  let rebuildTimer: number | undefined;

  const showSliderLabels = (): void => {
    const size = Number(resInput.value);
    const pct = Number(diaInput.value);
    resValue.textContent = `${size}×${size}`;
    diaValue.textContent = `${pct}% (r=${Math.round((size * pct) / 200)})`;
  };

  const rebuild = (): void => {
    world = buildWorld(Number(resInput.value), Number(diaInput.value), canvas, world);
    world.engine.ambientTemperature = volcanoParams.ambient;
    // A new backing store clears the context's settings along with its pixels.
    ctx.imageSmoothingEnabled = false;
    resetScene();
    render();
  };

  const scheduleRebuild = (): void => {
    showSliderLabels();
    window.clearTimeout(rebuildTimer);
    rebuildTimer = window.setTimeout(rebuild, REBUILD_DEBOUNCE_MS);
  };

  resInput.addEventListener('input', scheduleRebuild);
  diaInput.addEventListener('input', scheduleRebuild);
  showSliderLabels();

  // --- Perf readout --------------------------------------------------------
  // Cells scanned is the engine's *workload*, which frame rate is only the
  // downstream symptom of — and unlike frame rate it is deterministic, so the
  // same scene reports the same figure on any machine. That is what makes it
  // the number to size the resolution ceiling against.
  //
  // It is an upper bound rather than an exact count: every cell of an active
  // chunk is counted, including the air ones that cost only a branch, and edge
  // chunks count whole even where the grid ends partway through them.
  // Per-window perf accumulators. Each bucket sums the cost of one stage of the
  // frame so a bottleneck can be attributed to its cause rather than read as a
  // single opaque "slow" number. The split exists specifically so a frame that
  // reports zero engine work can still expose a render-side cost — the failure
  // mode the resolution ceiling is most likely to hit first.
  let perfTicks = 0;          // physics steps this window
  let perfRenderedFrames = 0; // rendered frames this window (may differ under throttle)
  // Sub-stage costs, summed across the window:
  let perfHostPreMs = 0;      // cloud stepping + volcano pre/post (host-owned sim)
  let perfUpdateMs = 0;       // engine.update()
  let perfHeatSyncMs = 0;     // host heat-driven colour/stiffness sync
  let perfPackMs = 0;         // CPU colour packing into the ImageData
  let perfUploadMs = 0;       // offscreen putImageData
  let perfComposeMs = 0;      // visible-canvas clear + transform + drawImage + overlays
  let perfTotalMs = 0;        // whole frame, render() included
  let perfCells = 0;          // engine active-chunk cell count (workload proxy)
  let perfSwaps = 0;          // engine swaps (movement workload proxy)
  let perfDirtyChunks = 0;    // render-dirty chunk count (upload workload proxy)
  let perfUploadCalls = 0;    // putImageData calls
  let perfUploadBytes = 0;    // bytes pushed by putImageData
  // Per-frame buckets filled in by render(); moved into the window sums by the
  // loop after render() returns. Held outside render() so the loop's total-frame
  // bracket can include the render cost without re-entrant timing.
  const renderTimings = { packMs: 0, uploadMs: 0, composeMs: 0, dirtyChunks: 0, uploadCalls: 0, uploadBytes: 0 };
  // Volcano sub-step timings, filled by stepVolcanoFrame via the runtime.
  const volcanoTimings: VolcanoTimings = { preMs: 0, updateMs: 0, postMs: 0, heatSyncMs: 0 };

  /**
   * Cells the engine scanned on the tick that just ran.
   *
   * `update()` swaps `activeChunks` ← `nextActiveChunks` and zeroes the next
   * set *before* scanning, so once it returns, `activeChunks` still holds
   * exactly the set of chunks it walked. Reading it after the call is what
   * makes this the work actually done, rather than the work queued for later.
   */
  const cellsScanned = (): number => {
    const chunks = world.engine.activeChunks;
    let active = 0;
    for (let i = 0; i < chunks.length; i++) active += chunks[i];
    return active * world.engine.CHUNK_SIZE * world.engine.CHUNK_SIZE;
  };

  const reportPerf = (): void => {
    const budget = 1000 / FPS; // 16.7 ms per physics tick
    // Per-tick (physics) averages — engine + host sim cost, the original metric.
    const cells = Math.round(perfCells / perfTicks);
    const swaps = Math.round(perfSwaps / perfTicks);
    const updateMs = perfUpdateMs / perfTicks;
    const hostPreMs = perfHostPreMs / perfTicks;
    const heatSyncMs = perfHeatSyncMs / perfTicks;
    const dirtyChunks = Math.round(perfDirtyChunks / perfTicks);
    // Per-rendered-frame averages — presentation cost. Uses renderedFrames, not
    // ticks, since a throttled high-resolution mode renders fewer frames than it
    // simulates. Total frame time is the number to size the ceiling against: it
    // includes render(), so a settled planet that still redraws shows up here.
    const rf = perfRenderedFrames || 1;
    const totalMs = perfTotalMs / rf;
    const packMs = perfPackMs / rf;
    const uploadMs = perfUploadMs / rf;
    const composeMs = perfComposeMs / rf;
    const upCalls = Math.round(perfUploadCalls / rf);
    const upKiB = perfUploadBytes / rf / 1024;
    perfValue.textContent =
      `${totalMs.toFixed(2)} ms/frame (${Math.round((totalMs / budget) * 100)}% of ${budget.toFixed(0)}ms) · ` +
      `${cells.toLocaleString()} cells · ${swaps.toLocaleString()} swaps · ${dirtyChunks} dirty · ` +
      `${upCalls}↑ ${upKiB.toFixed(0)}KiB · ` +
      `sim ${hostPreMs.toFixed(2)}+${updateMs.toFixed(2)}+${heatSyncMs.toFixed(2)} · ` +
      `gfx ${packMs.toFixed(2)}+${uploadMs.toFixed(2)}+${composeMs.toFixed(2)}`;
    perfTicks = 0;
    perfRenderedFrames = 0;
    perfHostPreMs = 0;
    perfUpdateMs = 0;
    perfHeatSyncMs = 0;
    perfPackMs = 0;
    perfUploadMs = 0;
    perfComposeMs = 0;
    perfTotalMs = 0;
    perfCells = 0;
    perfSwaps = 0;
    perfDirtyChunks = 0;
    perfUploadCalls = 0;
    perfUploadBytes = 0;
  };

  // --- Render + fixed-step loop -------------------------------------------
  // The grid renders to an offscreen canvas unrotated, then drawImage copies
  // it onto the visible canvas under a ctx.rotate transform. This keeps the
  // spin purely visual — the physics grid is never rotated, only the pixels.
  //
  // Declared as a function rather than a const arrow because rebuild() above
  // calls it before this point in the body.

  /**
   * Draw the volcanic atmospheric layer (vent glow, ash puffs, eruption flash).
   * Called inside the rotation transform so grid-space positions ride the spin;
   * the caller has already applied any shake translation. Pure: every value is
   * derived from the effects state (puff fields, normalized age, cached vent) —
   * no `Math.random()` here, so identical state paints identical pixels.
   */
  function drawVolcanoEffects(
    ctx: CanvasRenderingContext2D,
    state: VolcanoEffectsState,
    reducedMotion: boolean,
  ): void {
    void reducedMotion; // shake is applied by the caller; this draws only overlays.

    // --- Vent glow: a small warm halo at the live vent, fading with phase. ---
    if (state.glow > 0.01 && state.vent) {
      const { x, y } = state.vent;
      const g = state.glow;
      const r = 4 * effectScale(world.planetR);
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(255, 150, 48, ${0.55 * g})`);
      grad.addColorStop(0.5, `rgba(220, 80, 24, ${0.3 * g})`);
      grad.addColorStop(1, 'rgba(180, 40, 10, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- Ash puffs: overlapping translucent clusters built from each puff's
    // deterministic shapeSeed. Low alpha so overlaps build density naturally;
    // dark ash lightens toward grey as it disperses; a warm-brown tint near the
    // base (young puffs) connects the column to tephra. No additive blending. ---
    const puffs = state.puffs;
    for (let i = 0; i < puffs.length; i++) {
      const p = puffs[i];
      // Deterministic lobe offsets from the per-puff seed — drawing the same
      // state twice yields identical pixels. A 2-3 lobe cluster reads as a
      // volumetric body rather than a flat disc.
      const a = (p.shapeSeed & 0xffff) / 65535;
      const b = ((p.shapeSeed >>> 16) & 0xffff) / 65535;
      const lobes = [
        { dx: 0, dy: 0, r: 1 },
        { dx: (a - 0.5) * p.radius * 0.9, dy: (b - 0.5) * p.radius * 0.9, r: 0.75 },
        { dx: (b - 0.5) * p.radius * 0.7, dy: (a - 0.5) * p.radius * 0.7, r: 0.6 },
      ];
      const young = p.age < p.lifetime * 0.25;
      for (let l = 0; l < lobes.length; l++) {
        const lb = lobes[l];
        const lx = p.x + lb.dx;
        const ly = p.y + lb.dy;
        const lr = p.radius * lb.r;
        if (lr <= 0) continue;
        // Warm-brown tint for young puffs near the base; plain grey ash after.
        const cr = young ? Math.min(255, p.shade + 16) : p.shade;
        const cg = young ? Math.max(0, p.shade * 0.92) : p.shade * 0.96;
        const cb = young ? Math.max(0, p.shade * 0.78) : p.shade * 0.9;
        const coreAlpha = p.opacity * 0.9;
        const edgeAlpha = p.opacity * 0.25;
        const grad = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr);
        grad.addColorStop(0, `rgba(${cr | 0}, ${cg | 0}, ${cb | 0}, ${coreAlpha})`);
        grad.addColorStop(1, `rgba(${cr | 0}, ${cg | 0}, ${cb | 0}, ${edgeAlpha})`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(lx, ly, lr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // --- Eruption flash: a brief warm burst localized at the vent on explosive
    // entry. Squared falloff so it lasts only a few ticks; not full-screen. ----
    if (state.flash > 0.01 && state.vent) {
      const { x, y } = state.vent;
      const a = state.flash * state.flash;
      const r = 7 * effectScale(world.planetR);
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(255, 224, 150, ${0.6 * a})`);
      grad.addColorStop(0.5, `rgba(255, 140, 40, ${0.3 * a})`);
      grad.addColorStop(1, 'rgba(200, 60, 10, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function render(): void {
    const { engine, img, off, offCtx, size, cx, cy } = world;
    const dirty = engine.consumeRenderDirtyChunks();

    let tPack = performance.now();
    const report: DirtyReport = paintGridInto(img.data, engine.grid, engine.colorGrid, size, size, engine.CHUNK_SIZE, dirty, engine.chunkWidth, engine.chunkHeight, palette);
    renderTimings.packMs = performance.now() - tPack;
    renderTimings.dirtyChunks = report.chunkCount;

    // Base-image upload. A clean frame (no dirty chunks) uploads nothing. The
    // adaptive strategy picks between a full-image putImageData and per-run
    // dirty rects: when dirty coverage is high or the runs are too fragmented,
    // one full upload is cheaper than dozens of small ones. Otherwise each
    // coalesced run uploads as a single dirty rect, so call count is bounded by
    // chunk rows rather than individual dirty chunks.
    renderTimings.uploadCalls = 0;
    renderTimings.uploadBytes = 0;
    renderTimings.uploadMs = 0;
    let baseImageDirty = report.chunkCount > 0;
    if (baseImageDirty) {
      const totalChunk = engine.chunkWidth * engine.chunkHeight;
      // Thresholds: >50% of chunks dirty, or runs too fragmented (>2 per chunk
      // row on average) → a single full-image upload wins on call overhead.
      const coverageHigh = report.chunkCount > totalChunk * 0.5;
      const fragmented = report.runs.length > engine.chunkHeight * 2;
      const tUp = performance.now();
      if (coverageHigh || fragmented || report.bounds === null) {
        offCtx.putImageData(img, 0, 0);
        renderTimings.uploadCalls = 1;
        renderTimings.uploadBytes = img.data.length;
      } else {
        for (let i = 0; i < report.runs.length; i++) {
          const r = report.runs[i];
          // putImageData(image, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH): uploads
          // only the sub-rectangle [dirtyX, dirtyX+dirtyW) × [dirtyY, dirtyY+dirtyH)
          // of the source ImageData to (dx, dy) on the destination.
          offCtx.putImageData(img, r.x, r.y, r.x, r.y, r.w, r.h);
          renderTimings.uploadCalls++;
          renderTimings.uploadBytes += r.w * r.h * 4;
        }
      }
      renderTimings.uploadMs = performance.now() - tUp;
    }

    // Visible-canvas composition. When the offscreen base didn't change AND
    // nothing visual rides on top (no spin, no clouds, no shaking effects), the
    // visible canvas is already correct from the last frame — skip the clear,
    // transform, and drawImage entirely. Spinning or animating clouds force a
    // recompose, but not a redundant base upload (handled above).
    const rm = reduceMotion();
    const shaking = !rm && (effectsState.shakeX !== 0 || effectsState.shakeY !== 0);
    const hasOverlays = clouds.length > 0 || shaking || effectsState.glow > 0.01 || effectsState.flash > 0.01
      || effectsState.puffs.length > 0;
    const needCompose = baseImageDirty || spinning || hasOverlays;

    renderTimings.composeMs = 0;
    if (needCompose) {
      // Visible canvas: clear, then composite the grid and all atmospheric layers
      // under a single transform stack:
      //   translate(shake) · translate(c) · rotate(spin) · translate(-c)
      // The shake translation is applied outermost (screen axes), before the
      // rotation, so the world jitters as a whole rather than rotating about a
      // displaced center. It shifts rendered pixels, so toGrid() inverts it first
      // when mapping a click back to grid space. Suppressed under reduced-motion.
      const tCompose = performance.now();
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, size, size);
      ctx.save();
      const shX = rm ? 0 : effectsState.shakeX;
      const shY = rm ? 0 : effectsState.shakeY;
      if (shX !== 0 || shY !== 0) ctx.translate(shX, shY);
      ctx.translate(cx, cy);
      ctx.rotate(spinAngle);
      ctx.translate(-cx, -cy);
      ctx.drawImage(off, 0, 0);

      drawVolcanoEffects(ctx, effectsState, rm);

      // Clouds are drawn while still inside the rotation transform, so drawing in
      // grid coords makes them ride the visual spin automatically — the same trick
      // that keeps painted material aligned under toGrid()'s un-rotation. Each
      // cloud is a soft white disc faded by its remaining water, so it visibly
      // thins out as it rains down to nothing. Drawn OVER the volcanic plume so
      // weather reads in front of ash.
      for (let i = 0; i < clouds.length; i++) {
        const c = clouds[i];
        const frac = c.initialWater > 0 ? c.water / c.initialWater : 0;
        if (frac <= 0 || c.radius <= 0) continue;
        const grad = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.radius);
        // Puffier toward the middle; alpha tracks remaining water so a nearly-spent
        // cloud is barely there before it vanishes.
        grad.addColorStop(0, `rgba(245, 248, 255, ${0.85 * frac})`);
        grad.addColorStop(1, `rgba(220, 228, 245, ${0.15 * frac})`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();

      // Crosshair is drawn AFTER restore so it stays fixed (not spinning) — it
      // marks the gravity center, which doesn't move with the visual rotation.
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(cx - 0.5, cy - 4, 1, 9);
      ctx.fillRect(cx - 4, cy - 0.5, 9, 1);
      renderTimings.composeMs = performance.now() - tCompose;
    }
  }

  render();

  // The pure simulation body of one tick, extracted so the scheduler can run it
  // a fixed number of times per frame independent of the render rate. Everything
  // here advances the world state; nothing presents it. Returns nothing — the
  // timing buckets are folded into the perf record by the caller, which also
  // owns the render() call.
  const stepPhysics = (tHostStart: number): void => {
    const { engine, volcanoCfg } = world;

    // The eruption straddles the engine step: emission has to land before it so
    // new cells move on the frame they appear, while cooling and plumbing
    // maintenance have to come after, so a flow gets a chance to travel before
    // it is asked whether it has set. Cloud rain uses the same pre-step ordering
    // for the same reason — rain spawned this frame should fall this frame.
    if (clouds.length > 0) {
      const copts = cloudOpts();
      for (let i = 0; i < clouds.length; i++) stepCloud(engine, clouds[i], copts, cloudRng);
    }
    // The volcano's pure per-frame core (active/dormant branch + dormancy
    // transition + appearance sync) is shared with the headless test harness via
    // stepVolcanoFrame, so the browser and the golden trajectory stay identical.
    // The controller mutates runtime.erupting on completion; the UI label and
    // any presentation-only side effects stay here.
    if (erupting) phaseLabel.textContent = PHASE_LABEL[volcanoState.phase] ?? volcanoState.phase;
    // Capture the effect mode BEFORE stepVolcanoFrame mutates volcanoState.phase
    // (it advances phases inside the pre-step). Reading it here aligns the plume
    // with the phase whose physical work appears this tick, not the next one —
    // a transition to effusive/repose becomes visible the tick it actually begins.
    const effectMode: VolcanoEffectMode = erupting ? volcanoState.phase : stoppedEffectMode;
    // Reset the per-frame volcano sub-step buckets; stepVolcanoFrame fills them.
    volcanoTimings.preMs = volcanoTimings.updateMs = volcanoTimings.postMs = volcanoTimings.heatSyncMs = 0;
    const runtime: VolcanoRuntime = { erupting, capHeight, timings: volcanoTimings };
    stepVolcanoFrame(engine, volcanoCfg, volcanoState, volcanoRng, volcanoOpts(), runtime);
    if (erupting && !runtime.erupting) {
      // The controller just completed the eruption. goDormant handles the
      // presentation side (label); the source removal is already done inside.
      goDormant();
    }
    erupting = runtime.erupting;
    // Step the atmospheric layer (ash plume, glow, flash, shake). Host-only: it
    // reads summit geometry from the engine but never writes the sim grids, so
    // the volcano's golden trajectory stays byte-identical.
    stepVolcanoEffects(
      engine, volcanoCfg, effectsState, effectsRng,
      effectMode, eruptionEpisode, DEFAULT_EFFECT_OPTS,
    );
    if (clouds.length > 0) clouds = removeDead(clouds);

    // Attribute host-sim cost: pre/post (and cloud stepping above) vs engine
    // update vs heat sync. The volcano timings split pre/update/post/heat; the
    // cloud stepping and effects work fold into the host-pre bucket.
    const hostMs = performance.now() - tHostStart;
    perfHostPreMs += hostMs - volcanoTimings.updateMs - volcanoTimings.heatSyncMs;
    perfUpdateMs += volcanoTimings.updateMs;
    perfHeatSyncMs += volcanoTimings.heatSyncMs;
    perfCells += cellsScanned();
    perfSwaps += engine.swapsLastFrame;

    // Spin advances per physics tick, so rotation rate is independent of the
    // render rate: a 30-FPS render doesn't slow the apparent spin.
    if (spinning) spinAngle += SPIN_PER_TICK;
  };

  // --- Fixed-step simulation, decoupled render --------------------------------
  // Physics runs at a fixed 60 Hz via an accumulator so cooling, growth, rain,
  // and eruption timing keep their existing per-tick semantics regardless of
  // how fast the display refreshes. Rendering is throttled separately: at low
  // resolution we render up to 60 FPS; above the high-resolution threshold we
  // cap presentation at 30 FPS (physics stays at 60 ticks/s). This replaces the
  // old fixed setInterval, which offered no back-pressure when a tick overran
  // 16.7 ms and forced simulation and presentation to share one rate. The
  // decision math lives in the pure `scheduleFrame` helper (unit-tested in
  // frame-scheduler.test.ts); this loop applies it.
  let acc = 0;                         // accumulated unstepped sim time
  let lastTime = performance.now();    // wall-clock of the last rAF callback
  let lastRender = 0;                  // wall-clock of the last rendered frame
  let rafId = 0;                       // requestAnimationFrame handle (cancellable)
  let scheduled = false;               // guard against double-scheduling on visibility return
  // Priority-presentation signal: set by one-tick transients or forced after a
  // direct paint / rebuild so the result shows up immediately rather than at the
  // next throttle boundary.
  let forcePresent = false;

  const frame = (now: number): void => {
    const decision = scheduleFrame({
      elapsed: now - lastTime,
      acc,
      forcePresent,
      lastRender,
      now,
      size: world.size,
    });
    lastTime = now;
    acc = decision.nextAcc;

    const tFrame = performance.now();
    for (let i = 0; i < decision.ticks; i++) {
      const tHost = performance.now();
      stepPhysics(tHost);
      perfTicks++;
    }

    if (decision.shouldRender) {
      render();
      lastRender = now;
      perfRenderedFrames++;
      perfTotalMs += performance.now() - tFrame;
      // Render sub-buckets were filled by render(); fold them into the window.
      perfPackMs += renderTimings.packMs;
      perfUploadMs += renderTimings.uploadMs;
      perfComposeMs += renderTimings.composeMs;
      perfDirtyChunks += renderTimings.dirtyChunks;
      perfUploadCalls += renderTimings.uploadCalls;
      perfUploadBytes += renderTimings.uploadBytes;
    }
    forcePresent = false;
    if (perfTicks >= PERF_WINDOW) reportPerf();

    if (scheduled) rafId = window.requestAnimationFrame(frame);
  };

  // Visibility: a deliberate showcase power/CPU policy. When the tab is hidden,
  // stop scheduling both simulation and rendering — backgrounding pauses growth,
  // rain, cooling, and eruptions. On return, reset the accumulator and discard
  // the hidden elapsed time rather than attempting wall-clock catch-up (the
  // sim never sees a multi-second burst). A future game that promises offline
  // progression must implement that separately from this scheduler.
  const onVisibility = (): void => {
    if (document.hidden) {
      scheduled = false;
      window.cancelAnimationFrame(rafId);
    } else if (!scheduled) {
      scheduled = true;
      // Discard hidden elapsed time rather than catching up; force an immediate
      // render on resume (see resumeAfterHidden).
      const r = resumeAfterHidden(performance.now());
      acc = r.acc;
      lastTime = r.lastTime;
      lastRender = r.lastRender;
      rafId = window.requestAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  scheduled = true;
  rafId = window.requestAnimationFrame(frame);
}
