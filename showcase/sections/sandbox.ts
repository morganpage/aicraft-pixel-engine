/**
 * Section 1 — Flat falling-sand sandbox.
 *
 * A `PixelEngine` with the default `FlatGravity` rendered at 1px-per-cell
 * onto a CSS-scaled canvas. The user paints materials in with a brush
 * palette and watches the simulation evolve: sand piles, water levels, lava
 * cools to rock on water contact, fire spreads through flammables, acid
 * dissolves solids, oil floats on water. Density stratification, liquid
 * flow, gas rising, and material reactions are all visible live.
 *
 * The loop is a fixed-step 60 Hz `setInterval` (the engine has no game-loop
 * module; `setInterval` is the simplest correct driver for its per-frame
 * `update()` model). Each tick: `engine.update()`, then repaint only the
 * chunks flagged dirty via `consumeRenderDirtyChunks()` → `paintGridInto`
 * → `putImageData`.
 */

import { PixelEngine } from '../../src/sand';
import { MaterialType, Materials } from '../../src/materials';
import { FlatGravity } from '../../src/gravity';
import { paintGridInto, buildPalette } from '../helpers/renderer';
import { attachViewport } from '../helpers/viewport';

/** Grid resolution. ~3px-per-cell at the CSS display size. */
const WIDTH = 300;
const HEIGHT = 195;

/** Sim ticks per second. */
const FPS = 60;

/**
 * Initialize the sandbox section.
 *
 * @param container - the `<section id="sandbox">` element
 */
export function initSandbox(container: HTMLElement): void {
  const canvas = container.querySelector<HTMLCanvasElement>('.sandbox-canvas')!;
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d')!;
  // Crisp nearest-neighbor scaling — each grid cell is one backing-store pixel,
  // stretched to the CSS size without blur.
  ctx.imageSmoothingEnabled = false;

  const img = ctx.createImageData(WIDTH, HEIGHT);
  const palette = buildPalette(Materials as Record<number, { color: readonly number[] }>);

  const engine = new PixelEngine({ width: WIDTH, height: HEIGHT, seed: 1, gravity: new FlatGravity() });

  // Pre-stamp a wall floor so dropped materials collect above it.
  for (let x = 0; x < WIDTH; x++) engine.setMaterial(x, HEIGHT - 1, MaterialType.WALL);
  // A couple of rock ledges to make the stratification readable. Positioned as
  // fractions of the grid so they keep their layout at any resolution.
  for (let x = Math.floor(WIDTH * 0.20); x < Math.floor(WIDTH * 0.40); x++) {
    engine.setMaterial(x, HEIGHT - 30, MaterialType.ROCK);
  }
  for (let x = Math.floor(WIDTH * 0.65); x < Math.floor(WIDTH * 0.85); x++) {
    engine.setMaterial(x, HEIGHT - 50, MaterialType.ROCK);
  }

  // --- View ----------------------------------------------------------------
  // Zoom/pan is a CSS transform on the canvas, so `toGrid` below needs no
  // knowledge of it: `getBoundingClientRect()` already reports the transformed
  // box. Pan gestures are swallowed in the capture phase before they reach the
  // paint handlers.
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

  const brushButtons = container.querySelectorAll<HTMLButtonElement>('.sandbox-brush');
  const brushSize = container.querySelector<HTMLInputElement>('.sandbox-brush-size')!;
  const brushSizeValue = container.querySelector<HTMLElement>('.sandbox-brush-size-value')!;
  const explodeBtn = container.querySelector<HTMLButtonElement>('.sandbox-explode')!;
  const clearBtn = container.querySelector<HTMLButtonElement>('.sandbox-clear')!;

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

  /** Map a pointer event to integer grid coordinates. */
  const toGrid = (e: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * WIDTH);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * HEIGHT);
    return { x, y };
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

  explodeBtn.addEventListener('click', () => {
    engine.explode(Math.floor(WIDTH / 2), Math.floor(HEIGHT / 2), 18, 6);
    explodeBtn.blur();
  });

  clearBtn.addEventListener('click', () => {
    engine.clear();
    // Re-stamp the floor and ledges so the scene resets to a known shape.
    for (let x = 0; x < WIDTH; x++) engine.setMaterial(x, HEIGHT - 1, MaterialType.WALL);
    for (let x = 40; x < 80; x++) engine.setMaterial(x, HEIGHT - 30, MaterialType.ROCK);
    for (let x = 130; x < 170; x++) engine.setMaterial(x, HEIGHT - 50, MaterialType.ROCK);
    clearBtn.blur();
  });

  // --- Render + fixed-step loop -------------------------------------------
  const render = (): void => {
    const dirty = engine.consumeRenderDirtyChunks();
    paintGridInto(img.data, engine.grid, engine.colorGrid, WIDTH, HEIGHT, engine.CHUNK_SIZE, dirty, engine.chunkWidth, engine.chunkHeight, palette);
    ctx.putImageData(img, 0, 0);
  };

  // Initial paint so the floor/ledges are visible before the first tick.
  render();

  window.setInterval(() => {
    engine.update();
    render();
  }, 1000 / FPS);
}
