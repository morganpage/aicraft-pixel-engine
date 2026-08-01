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

  clearBtn.addEventListener('click', () => {
    engine.clear();
    stampPlanet(engine);
    spinAngle = 0;
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
    engine.update();
    if (spinning) spinAngle += SPIN_PER_TICK;
    render();
  }, 1000 / FPS);
}
