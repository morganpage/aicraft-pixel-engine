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
import { paintGridInto, buildPalette } from '../helpers/renderer';
import {
  stampVolcano,
  stepVolcanoPre,
  stepVolcanoPost,
  createVolcanoState,
  isDormant,
  makeRng,
  volcanoGeometryFor,
  type VolcanoConfig,
  type VolcanoStepOptions,
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

  // --- Resolution + diameter sliders --------------------------------------
  // Read before the world exists, because they are what define it.
  const resInput = container.querySelector<HTMLInputElement>('.planet-resolution')!;
  const resValue = container.querySelector<HTMLElement>('.planet-resolution-value')!;
  const diaInput = container.querySelector<HTMLInputElement>('.planet-diameter')!;
  const diaValue = container.querySelector<HTMLElement>('.planet-diameter-value')!;
  const perfValue = container.querySelector<HTMLElement>('.planet-perf')!;

  let world = buildWorld(Number(resInput.value), Number(diaInput.value), canvas);
  ctx.imageSmoothingEnabled = false;

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
  const coolingInput = container.querySelector<HTMLInputElement>('.planet-volcano-cooling')!;
  const coolingValue = container.querySelector<HTMLElement>('.planet-volcano-cooling-value')!;
  const effusionInput = container.querySelector<HTMLInputElement>('.planet-volcano-effusion')!;
  const effusionValue = container.querySelector<HTMLElement>('.planet-volcano-effusion-value')!;
  const ashInput = container.querySelector<HTMLInputElement>('.planet-volcano-ash')!;
  const ashValue = container.querySelector<HTMLElement>('.planet-volcano-ash-value')!;
  const spreadInput = container.querySelector<HTMLInputElement>('.planet-volcano-spread')!;
  const spreadValue = container.querySelector<HTMLElement>('.planet-volcano-spread-value')!;
  const phaseLabel = container.querySelector<HTMLElement>('.planet-volcano-phase')!;

  const volcanoParams = {
    cooling: Number(coolingInput.value),
    effusion: Number(effusionInput.value),
    ash: Number(ashInput.value),
    spread: Number(spreadInput.value),
  };
  const fmt = (v: number): string => Number.isInteger(v) ? String(v) : v.toFixed(2);
  coolingInput.addEventListener('input', () => {
    volcanoParams.cooling = Number(coolingInput.value);
    coolingValue.textContent = fmt(volcanoParams.cooling);
  });
  effusionInput.addEventListener('input', () => {
    volcanoParams.effusion = Number(effusionInput.value);
    effusionValue.textContent = fmt(volcanoParams.effusion);
  });
  ashInput.addEventListener('input', () => {
    volcanoParams.ash = Number(ashInput.value);
    ashValue.textContent = fmt(volcanoParams.ash);
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
    const dx = px - world.cx;
    const dy = py - world.cy;
    // The canvas is visually rotated by spinAngle (whether or not it is still
    // actively spinning — render() rotates unconditionally by the current
    // angle). To paint what you actually SEE, always un-rotate the click back
    // into grid space by the inverse rotation (−spinAngle). At angle 0 this
    // is a no-op, so it's safe even when the planet has never spun.
    const cos = Math.cos(-spinAngle);
    const sin = Math.sin(-spinAngle);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    return { x: Math.floor(world.cx + rx), y: Math.floor(world.cy + ry) };
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

  /**
   * Read the eruption's tuning fresh each tick, so slider changes apply
   * mid-eruption. The cap has to be read live too — "Erupt again" raises it.
   */
  const volcanoOpts = (): VolcanoStepOptions => ({
    plume: {
      // perFrame: how vigorous the explosive phase is (slider, default 8).
      perFrame: volcanoParams.ash,
      // spread: launch half-angle (slider, default 0.18 ≈ 10°). Wider scatters
      //   ejecta further → broader, flatter cone; narrower → tall thin spire.
      spread: volcanoParams.spread,
      loft: 5,
      // Mostly tephra. Granular ejecta piles at its own angle of repose, which
      // is what gives the cone its tapering profile — lava ponds level out and
      // freeze with cliff edges, so a lava-built edifice is a flat-topped mesa,
      // not a cone. The lava's job is the flows down the flanks, not the shape.
      lavaFraction: 0.05,
      maxHeight: capHeight,
      // Centre the fallout on the rim rather than the axis, so the summit gets
      // a crater instead of a dome. It tapers both ways from here: outward into
      // the flank, inward to keep the crater floor rising with the cone.
      rimBias: 0.45,
    },
    pressure: {
      riseInterval: 1,
      // effusion: cells of magma spilled per frame (slider).
      effusion: volcanoParams.effusion,
      craterHalfAngle: 0.06,
      // Only just above the plume's cap. More headroom than this and lava stops
      // running down the cone and starts building a level slab on top of it.
      maxHeight: capHeight + 2,
      // Most of it out through the rim breach, onto ground that already falls
      // away; the rest keeps the crater molten.
      breachFraction: 0.85,
    },
    // cooling: the dial between short stubby flows (freeze fast) and long ones
    //   that drape the cone (freeze slow). Too slow and lava levels into a
    //   shell around the whole planet like water. Slider, default 0.08.
    cool: { rate: volcanoParams.cooling, insulatedFactor: 0.02 },
    assimilateRate: 0.5,
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
   * The eruption ran its course. Say so explicitly — a scene that simply stops
   * moving is indistinguishable from the page having frozen, which is exactly
   * how this read before.
   */
  const goDormant = (): void => {
    erupting = false;
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
  };

  volcanoBtn.addEventListener('click', () => {
    if (erupting) {
      erupting = false;
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
  let perfTicks = 0;
  let perfMs = 0;
  let perfCells = 0;
  let perfSwaps = 0;

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
    const cells = Math.round(perfCells / perfTicks);
    const swaps = Math.round(perfSwaps / perfTicks);
    const ms = perfMs / perfTicks;
    const budget = 1000 / FPS;
    perfValue.textContent =
      `${cells.toLocaleString()} cells/tick · ${swaps.toLocaleString()} swaps · ` +
      `${ms.toFixed(2)} ms (${Math.round((ms / budget) * 100)}% of the ${budget.toFixed(1)} ms budget)`;
    perfTicks = 0;
    perfMs = 0;
    perfCells = 0;
    perfSwaps = 0;
  };

  // --- Render + fixed-step loop -------------------------------------------
  // The grid renders to an offscreen canvas unrotated, then drawImage copies
  // it onto the visible canvas under a ctx.rotate transform. This keeps the
  // spin purely visual — the physics grid is never rotated, only the pixels.
  //
  // Declared as a function rather than a const arrow because rebuild() above
  // calls it before this point in the body.
  function render(): void {
    const { engine, img, off, offCtx, size, cx, cy } = world;
    const dirty = engine.consumeRenderDirtyChunks();
    paintGridInto(img.data, engine.grid, engine.colorGrid, size, size, engine.CHUNK_SIZE, dirty, engine.chunkWidth, engine.chunkHeight, palette);
    offCtx.putImageData(img, 0, 0);

    // Visible canvas: clear, rotate about the planet center, draw the grid.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(spinAngle);
    ctx.translate(-cx, -cy);
    ctx.drawImage(off, 0, 0);

    // Clouds are drawn while still inside the rotation transform, so drawing in
    // grid coords makes them ride the visual spin automatically — the same trick
    // that keeps painted material aligned under toGrid()'s un-rotation. Each
    // cloud is a soft white disc faded by its remaining water, so it visibly
    // thins out as it rains down to nothing.
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
  }

  render();

  window.setInterval(() => {
    const { engine, volcanoCfg } = world;
    const t0 = performance.now();

    // The eruption straddles the engine step: emission has to land before it so
    // new cells move on the frame they appear, while cooling and plumbing
    // maintenance have to come after, so a flow gets a chance to travel before
    // it is asked whether it has set. Cloud rain uses the same pre-step ordering
    // for the same reason — rain spawned this frame should fall this frame.
    if (clouds.length > 0) {
      const copts = cloudOpts();
      for (let i = 0; i < clouds.length; i++) stepCloud(engine, clouds[i], copts, cloudRng);
    }
    if (erupting) {
      const opts = volcanoOpts();
      stepVolcanoPre(engine, volcanoCfg, volcanoState, volcanoRng, opts);
      engine.update();
      stepVolcanoPost(engine, volcanoCfg, volcanoState, volcanoRng, opts);
      phaseLabel.textContent = PHASE_LABEL[volcanoState.phase] ?? volcanoState.phase;
      // Ask the cone's height directly. An episode placing nothing this frame
      // only means its sample cells were occupied, not that it has finished.
      if (isDormant(engine, volcanoCfg, capHeight)) goDormant();
    } else {
      engine.update();
    }
    if (clouds.length > 0) clouds = removeDead(clouds);

    perfMs += performance.now() - t0;
    perfCells += cellsScanned();
    perfSwaps += engine.swapsLastFrame;
    if (++perfTicks >= PERF_WINDOW) reportPerf();

    if (spinning) spinAngle += SPIN_PER_TICK;
    render();
  }, 1000 / FPS);
}
