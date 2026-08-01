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
 */

import { PixelEngine } from '../../src/sand';
import { MaterialType, Materials } from '../../src/materials';
import { RadialGravity } from '../../src/gravity';
import { paintGridInto, buildPalette } from '../helpers/renderer';
import {
  stampVolcano,
  emitPlume,
  coolLava,
  remeltConduit,
  assimilateTephra,
  isDormant,
  makeRng,
  type VolcanoConfig,
} from '../helpers/volcano';

/** Square grid so the planet sits centered with even margin all around. */
const SIZE = 220;
/** Planet center = grid center. */
const CX = SIZE / 2;
const CY = SIZE / 2;
/** Planet disc radius (cells). ~30% of the grid → room to drop material around it. */
const PLANET_R = Math.floor(SIZE * 0.3);

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

/** Stamp the planet disc into the engine. */
function stampPlanet(engine: PixelEngine): void {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - CX;
      const dy = y - CY;
      if (dx * dx + dy * dy <= PLANET_R * PLANET_R) {
        engine.setMaterial(x, y, MaterialType.ROCK);
      }
    }
  }
}

/**
 * Initialize the planet section.
 *
 * @param container - the `<section id="planet">` element
 */
export function initPlanet(container: HTMLElement): void {
  const canvas = container.querySelector<HTMLCanvasElement>('.planet-canvas')!;
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const img = ctx.createImageData(SIZE, SIZE);
  const palette = buildPalette(Materials as Record<number, { color: readonly number[] }>);

  // Offscreen canvas holds the unrotated grid each frame. The visible canvas
  // then draws it via drawImage under a ctx.rotate transform — so the spin is
  // purely visual. putImageData ignores transforms, which is why we render to
  // an offscreen first and drawImage it back rotated. The physics grid is
  // never touched by the spin.
  const off = document.createElement('canvas');
  off.width = SIZE;
  off.height = SIZE;
  const offCtx = off.getContext('2d')!;

  const engine = new PixelEngine({
    width: SIZE,
    height: SIZE,
    seed: 1,
    gravity: new RadialGravity({ centerX: CX, centerY: CY }),
  });
  stampPlanet(engine);

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

  /** Stamp a filled disc of the active brush at grid coords (gx, gy). */
  const stamp = (gx: number, gy: number): void => {
    const r2 = brushRadius * brushRadius;
    for (let dy = -brushRadius; dy <= brushRadius; dy++) {
      for (let dx = -brushRadius; dx <= brushRadius; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        engine.setMaterial(gx + dx, gy + dy, activeBrush);
      }
    }
  };

  const toGrid = (e: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    // Screen pixel → grid cell, relative to the planet center.
    const px = ((e.clientX - rect.left) / rect.width) * SIZE;
    const py = ((e.clientY - rect.top) / rect.height) * SIZE;
    let dx = px - CX;
    let dy = py - CY;
    // The canvas is visually rotated by spinAngle (whether or not it is still
    // actively spinning — render() rotates unconditionally by the current
    // angle). To paint what you actually SEE, always un-rotate the click back
    // into grid space by the inverse rotation (−spinAngle). At angle 0 this
    // is a no-op, so it's safe even when the planet has never spun.
    const cos = Math.cos(-spinAngle);
    const sin = Math.sin(-spinAngle);
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    return { x: Math.floor(CX + rx), y: Math.floor(CY + ry) };
  };

  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', (e) => {
    painting = true;
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = toGrid(e);
    stamp(x, y);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!painting) return;
    const { x, y } = toGrid(e);
    stamp(x, y);
  });
  canvas.addEventListener('pointerup', () => { painting = false; });
  canvas.addEventListener('pointercancel', () => { painting = false; });

  // 🌍 Scatter — drop a shell of mixed material around the planet to
  // demonstrate radial settling (the behavior golden from the engine tests,
  // made visible). Alternates sand and water for a stratified look.
  scatterBtn.addEventListener('click', () => {
    for (let a = 0; a < 360; a += 6) {
      const rad = (a * Math.PI) / 180;
      const r = PLANET_R + 14;
      const sx = Math.round(CX + Math.cos(rad) * r);
      const sy = Math.round(CY + Math.sin(rad) * r);
      engine.setMaterial(sx, sy, a % 12 === 0 ? MaterialType.WATER : MaterialType.SAND);
    }
    scatterBtn.blur();
  });

  // 🌋 Volcano — carve a magma chamber and conduit, then erupt continuously.
  //
  // Built entirely on the engine's public API: the engine has no pressure term
  // and no lava→rock transition except contact with water, so the section
  // supplies both (see helpers/volcano.ts). Toggling it off leaves the terrain
  // it built in place.
  const volcanoCfg: VolcanoConfig = {
    centerX: CX,
    centerY: CY,
    planetRadius: PLANET_R,
    ventAngle: -Math.PI / 2, // summit at the top of the screen
    conduitHalfWidth: 1,
    chamberRadius: 8,
    chamberDepth: 26,
  };
  let erupting = false;
  let started = false;
  // Each eruption is finite: it builds until the cone reaches its cap, then the
  // volcano goes dormant. Erupting again raises the cap so the cone grows in
  // stages rather than either stopping forever or growing without bound.
  let capHeight = 16;
  const volcanoRng = makeRng(4242);

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
  };

  volcanoBtn.addEventListener('click', () => {
    if (erupting) {
      erupting = false;
      setVolcanoLabel('🌋 Erupt again', false);
      volcanoBtn.blur();
      return;
    }
    if (!started) {
      stampVolcano(engine, volcanoCfg);
      started = true;
    } else {
      capHeight = Math.min(capHeight + 8, 40); // a taller cone each time
    }
    erupting = true;
    setVolcanoLabel('🌋 Erupting', true);
    volcanoBtn.blur();
  });

  clearBtn.addEventListener('click', () => {
    engine.clear();
    stampPlanet(engine);
    spinAngle = 0;
    erupting = false;
    started = false;
    capHeight = 16;
    setVolcanoLabel('🌋 Volcano', false);
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

  // --- Render + fixed-step loop -------------------------------------------
  // The grid renders to an offscreen canvas unrotated, then drawImage copies
  // it onto the visible canvas under a ctx.rotate transform. This keeps the
  // spin purely visual — the physics grid is never rotated, only the pixels.
  const render = (): void => {
    const dirty = engine.consumeRenderDirtyChunks();
    paintGridInto(img.data, engine.grid, engine.colorGrid, SIZE, SIZE, engine.CHUNK_SIZE, dirty, engine.chunkWidth, engine.chunkHeight, palette);
    offCtx.putImageData(img, 0, 0);

    // Visible canvas: clear, rotate about the planet center, draw the grid.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.translate(CX, CY);
    ctx.rotate(spinAngle);
    ctx.translate(-CX, -CY);
    ctx.drawImage(off, 0, 0);
    ctx.restore();

    // Crosshair is drawn AFTER restore so it stays fixed (not spinning) — it
    // marks the gravity center, which doesn't move with the visual rotation.
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(CX - 0.5, CY - 4, 1, 9);
    ctx.fillRect(CX - 4, CY - 0.5, 9, 1);
  };

  render();

  window.setInterval(() => {
    if (erupting) {
      emitPlume(engine, volcanoCfg, volcanoRng, {
        // 8/frame builds a full cone in ~20s at 60Hz; at 2/frame the demo
        // takes well over a minute to read as anything.
        perFrame: 8,
        spread: 0.21, // ~12°
        loft: 5,
        // Mostly granular tephra: it piles at its own angle of repose, which is
        // what gives the cone its shape. Lava alone freezes into static rock
        // and builds a lumpy mesa instead.
        lavaFraction: 0.3,
        maxHeight: capHeight,
      });
      // Ask the cone's height directly. A plume placing nothing this frame
      // only means its sample cells were occupied, not that it has finished.
      if (isDormant(engine, volcanoCfg, capHeight)) goDormant();
    }
    engine.update();
    // Fallout sinks through the magma (tephra is denser than lava), so the
    // bore has to be reclaimed each frame or the volcano chokes on its own
    // ejecta within a few seconds.
    if (erupting) remeltConduit(engine, volcanoCfg);
    // Cooling runs after the step, so a flow gets a chance to move before it
    // freezes. Rate is the dial between a steep cone (freeze fast) and a broad
    // shield (freeze slow); too slow and lava levels into a shell like water.
    // Slowed from 0.25 so a flow travels further down the flank before setting
    // — bounded by the assimilation:cooling ratio, since cooling terminates the
    // advancing front.
    if (erupting) coolLava(engine, volcanoRng, { rate: 0.15 });
    // Magma dissolves tephra trapped inside it (tephra is denser than lava so it
    // sinks in and lodges there). Gated on embedding, not mere contact, so the
    // cone's flank survives; runs after cooling so a freshly-assimilated cell
    // survives this tick and flows on the next.
    if (erupting) assimilateTephra(engine, volcanoRng, { rate: 0.5 });
    if (spinning) spinAngle += SPIN_PER_TICK;
    render();
  }, 1000 / FPS);
}
