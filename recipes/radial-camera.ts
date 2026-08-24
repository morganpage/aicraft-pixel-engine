/**
 * A 2D zoom/pan camera for a pixel-grid canvas, with the input hygiene the
 * naive version misses.
 *
 * ## The failures it prevents
 *
 * - **Pointer-capture hangs.** The natural pattern — `setPointerCapture` on
 *   `pointerdown`, stop painting/panning on the captured element's
 *   `pointerup` — wedges when a pointer stream ends without a clean
 *   `pointerup` on that element: synthetic/automated drags, alt-tab
 *   mid-drag, some touch drivers. The canvas then keeps capture forever, the
 *   brush keeps pouring at the last cell, and every later click (toolbar
 *   included) is swallowed. Measured in the wild during the god-game build.
 *   Fix: also stop on **window-level** `pointerup`/`pointercancel`/`blur`,
 *   and release the capture explicitly (in a try/catch).
 *
 * - **Mapping drift.** Screen→grid must divide by the canvas's *rendered*
 *   size versus its backing store, then by zoom — and must clamp to the grid,
 *   or the last pixel column floors to an out-of-range cell that
 *   `getMaterial` reports as WALL ("solid") and smite-style ray casts
 *   misclassify.
 */

export interface Camera {
  /** Grid cell currently at the canvas top-left. */
  originX: number;
  originY: number;
  /** Pixels per cell. */
  zoom: number;
}

export interface CameraControls {
  camera: Camera;
  screenToGrid(e: MouseEvent): { gx: number; gy: number };
  isPanModifierHeld(): boolean;
  /** True while a pan drag is in progress (suppresses painting). */
  isPanning(): boolean;
  reset(): void;
}

export function attachCamera(
  canvas: HTMLCanvasElement,
  opts: { minZoom?: number; maxZoom?: number; panButtons?: number[] } = {},
): CameraControls {
  const minZoom = opts.minZoom ?? 1;
  const maxZoom = opts.maxZoom ?? 8;
  const panButtons = new Set(opts.panButtons ?? [1]); // middle-drag by default
  const camera: Camera = { originX: 0, originY: 0, zoom: 1 };

  let spaceHeld = false;
  let panning = false;
  let panPointerId: number | null = null;
  let lastX = 0;
  let lastY = 0;

  function screenToGrid(e: MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
    return {
      gx: clamp(Math.floor(camera.originX + (sx / rect.width) * (canvas.width / camera.zoom)), canvas.width - 1),
      gy: clamp(Math.floor(camera.originY + (sy / rect.height) * (canvas.height / camera.zoom)), canvas.height - 1),
    };
  }

  function reset() {
    camera.zoom = 1;
    camera.originX = 0;
    camera.originY = 0;
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      spaceHeld = true;
      if (e.target === document.body) e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') spaceHeld = false;
  });

  // Zoom toward the cursor: keep the cell under the cursor pinned.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const sy = ((e.clientY - rect.top) / rect.height) * canvas.height;
    const gxBefore = camera.originX + sx / camera.zoom;
    const gyBefore = camera.originY + sy / camera.zoom;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    camera.zoom = Math.min(maxZoom, Math.max(minZoom, camera.zoom * factor));
    camera.originX = gxBefore - sx / camera.zoom;
    camera.originY = gyBefore - sy / camera.zoom;
  }, { passive: false });

  canvas.addEventListener('pointerdown', (e) => {
    if (panButtons.has(e.button) || (e.button === 0 && spaceHeld)) {
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      panPointerId = e.pointerId;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
      e.preventDefault();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!panning) return;
    const rect = canvas.getBoundingClientRect();
    const cellsPerPx = canvas.width / rect.width / camera.zoom;
    camera.originX -= (e.clientX - lastX) * cellsPerPx;
    camera.originY -= (e.clientY - lastY) * cellsPerPx;
    lastX = e.clientX;
    lastY = e.clientY;
  });

  const stop = () => {
    panning = false;
    if (panPointerId !== null) {
      try { canvas.releasePointerCapture(panPointerId); } catch { /* already released */ }
      panPointerId = null;
    }
  };
  // Window-level stops are the point: a pointer stream that ends anywhere
  // other than a clean pointerup on the captured element must not wedge input.
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  window.addEventListener('blur', stop);
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  canvas.addEventListener('dblclick', reset);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    camera,
    screenToGrid,
    isPanModifierHeld: () => spaceHeld,
    isPanning: () => panning,
    reset,
  };
}
