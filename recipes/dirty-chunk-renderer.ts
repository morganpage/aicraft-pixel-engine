// In-repo import; when copying this file into a game, change to:
//   import { MaterialType, Materials, materialDefs, type PixelEngine } from 'aicraft-pixel-engine';
import { MaterialType, Materials, materialDefs } from '../src/index.js';
import type { PixelEngine } from '../src/index.js';

/**
 * The dirty-chunk renderer: grid pixels into an offscreen canvas at native
 * resolution, repaint only the chunks the simulation flagged, blit the whole
 * thing through the camera transform.
 *
 * ## The failures it prevents
 *
 * - **The `putImageData` dirty-offset trap.** `putImageData(img, dx, dy,
 *   dirtyX, dirtyY, w, h)`'s `dirtyX/dirtyY` are an offset **into the source
 *   ImageData**, not a destination coordinate. Write a chunk's pixels into
 *   `img` at `(x0, y0)` and then call `putImageData(img, x0, y0, x0, y0, w,
 *   h)` and only chunk (0,0) renders — every other chunk shows nothing or
 *   garbage, while the grid data is perfectly correct. This was the #1
 *   rendering bug across engine-built games; the correct call keeps the
 *   source offset at the origin: `putImageData(img, 0, 0, x0, y0, w, h)`.
 *
 * - **The first-frame hole.** The engine reports *every* chunk dirty on the
 *   first `consumeRenderDirtyChunks()` after construction (or `clear()`), so
 *   the loop below performs the initial full paint with no special case.
 *
 * - **CSS-stretched planets.** The backing store is the grid, exactly, and
 *   the caller sizes the CSS box; scaling happens only through the camera
 *   transform with `imageSmoothingEnabled = false`.
 *
 * Texture: a deterministic per-cell brightness dither and optional radial
 * depth shading (rock darkens toward the core) turn flat material fills into
 * something that reads as *ground*. Both are pure functions of `(x, y)` —
 * they never feed back into the grid.
 */

export interface RendererOptions {
  /** Planet center + radius for depth shading; omit to disable the effect. */
  planet?: { centerX: number; centerY: number; radius: number };
}

export interface DirtyChunkRenderer {
  /** Blit through the camera transform; call once per rendered frame. */
  render(
    camera: { originX: number; originY: number; zoom: number },
    overlays?: (ctx: CanvasRenderingContext2D, camera: { zoom: number }) => void,
  ): void;
  /** Force a full repaint of every chunk (e.g. after `engine.clear()`). */
  repaintAll(): void;
}

export function createDirtyChunkRenderer(
  engine: PixelEngine,
  ctx: CanvasRenderingContext2D,
  opts: RendererOptions = {},
): DirtyChunkRenderer {
  const CHUNK = engine.CHUNK_SIZE;
  // chunkWidth/chunkHeight from the engine handle grids that are not a whole
  // multiple of the chunk size; deriving them by division does not.
  const chunksPerRow = engine.chunkWidth;
  const chunkRows = engine.chunkHeight;

  // Palette: MaterialType id → packed RGBA (0xAABBGGRR). EMPTY writes alpha 0
  // so whatever the page paints behind the canvas shows through as sky.
  const palette = new Uint32Array(Object.keys(Materials).length);
  for (const m of materialDefs) {
    const [r, g, b, a] = m.color;
    palette[m.id] = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }

  const gridCanvas = document.createElement('canvas');
  gridCanvas.width = engine.width;
  gridCanvas.height = engine.height;
  const gctx = gridCanvas.getContext('2d')!;
  const img = gctx.createImageData(engine.width, engine.height);

  const dither = (x: number, y: number) => ((x * 7 + y * 13) % 5) - 2;

  function brightness(mat: number, x: number, y: number): number {
    const d = dither(x, y);
    if (mat === MaterialType.ROCK || mat === MaterialType.WALL || mat === MaterialType.TEPHRA) {
      const p = opts.planet;
      if (p) {
        const depth = Math.min(1, Math.hypot(x - p.centerX, y - p.centerY) / p.radius);
        return 0.58 + 0.42 * depth + d * 0.015;
      }
      return 1 + d * 0.015;
    }
    if (mat === MaterialType.SAND) return 1 + d * 0.05;
    return 1 + d * 0.02;
  }

  function paintChunk(x0: number, y0: number) {
    const xEnd = Math.min(x0 + CHUNK, engine.width);
    const yEnd = Math.min(y0 + CHUNK, engine.height);
    for (let y = y0; y < yEnd; y++) {
      for (let x = x0; x < xEnd; x++) {
        const cell = y * engine.width + x;
        const o = cell * 4;
        const mat = engine.grid[cell];
        if (mat === MaterialType.EMPTY) {
          img.data[o] = 0; img.data[o + 1] = 0; img.data[o + 2] = 0; img.data[o + 3] = 0;
          continue;
        }
        // engine.colorGrid takes priority when set (0 = fall back to the
        // palette): the volcano subsystem writes per-cell incandescence and
        // cooled-rock tints there, and explode writes debris tints. A renderer
        // that ignores it shows a flat grey cone where the showcase glows.
        const override = engine.colorGrid ? engine.colorGrid[cell] : 0;
        const c = override !== 0 ? override : palette[mat];
        const f = override !== 0 ? 1 : brightness(mat, x, y);
        img.data[o] = Math.max(0, Math.min(255, (c & 0xff) * f));
        img.data[o + 1] = Math.max(0, Math.min(255, ((c >> 8) & 0xff) * f));
        img.data[o + 2] = Math.max(0, Math.min(255, ((c >> 16) & 0xff) * f));
        img.data[o + 3] = (c >> 24) & 0xff;
      }
    }
    // ⚠️ The source dirty-offset is (0,0), NOT (x0,y0) — see the header.
    gctx.putImageData(img, 0, 0, x0, y0, xEnd - x0, yEnd - y0);
  }

  function repaintAll() {
    for (let cy = 0; cy < chunkRows; cy++) {
      for (let cx = 0; cx < chunksPerRow; cx++) {
        paintChunk(cx * CHUNK, cy * CHUNK);
      }
    }
  }

  function render(
    camera: { originX: number; originY: number; zoom: number },
    overlays?: (ctx: CanvasRenderingContext2D, camera: { zoom: number }) => void,
  ) {
    const dirty = engine.consumeRenderDirtyChunks();
    for (let i = 0; i < dirty.length; i++) {
      if (!dirty[i]) continue;
      const cx = i % chunksPerRow;
      const cy = (i / chunksPerRow) | 0;
      paintChunk(cx * CHUNK, cy * CHUNK);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(camera.zoom, 0, 0, camera.zoom, -camera.originX * camera.zoom, -camera.originY * camera.zoom);
    ctx.drawImage(gridCanvas, 0, 0);
    if (overlays) {
      overlays(ctx, camera);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  repaintAll();
  return { render, repaintAll };
}
