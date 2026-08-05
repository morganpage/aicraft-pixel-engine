/**
 * Pure grid→pixels renderer for the showcase canvases.
 *
 * Extracted from the section files so the pixel-packing logic is unit-
 * testable under Node (the sections themselves touch the DOM and can't run
 * there without jsdom, which the zero-deps invariant forbids). This mirrors
 * the `aicraft-engine` showcase pattern of testing the DOM-free helpers a
 * section calls into, rather than the section's DOM wiring.
 *
 * The function is pure: it takes an `ImageData.data`-shaped buffer and writes
 * RGBA bytes for each cell in a dirty chunk. No canvas, no DOM, no globals.
 */

/**
 * A coalesced run of dirty chunks: a horizontal strip of adjacent dirty chunks
 * within one chunk row. The renderer uploads each run as a single dirty-rect
 * `putImageData` rather than per-chunk, so upload call count is bounded by the
 * number of chunk rows, not the number of dirty chunks.
 */
export interface DirtyRun {
  /** Inclusive top-left cell x, in pixels (cells × 1 byte/channel). */
  x: number;
  /** Inclusive top-left cell y, in pixels. */
  y: number;
  /** Run width in pixels (= number of coalesced chunks × chunkSize, right-clamped). */
  w: number;
  /** Run height in pixels (= chunkSize, bottom-clamped on the last chunk row). */
  h: number;
}

/**
 * What `paintGridInto` changed this frame, so the caller can scope its canvas
 * upload to the actual dirty region instead of the whole image.
 *
 * - `chunkCount`: how many chunks were dirty (a workload proxy; 0 means the
 *   frame painted nothing and the caller can skip the upload entirely).
 * - `runs`: maximal horizontal coalesced runs of dirty chunks. Vertically
 *   adjacent dirty chunks in the same column ranges are NOT merged — runs are
 *   strictly one chunk row tall — because a single tall thin region is usually
 *   cheaper to upload as a few thin rects than as one wide one.
 * - `bounds`: the tight bounding rectangle of all dirty cells. Cheap to compute
 *   alongside the runs and useful as a fallback single-upload rect when the run
 *   count is high but the coverage is low.
 */
export interface DirtyReport {
  chunkCount: number;
  runs: DirtyRun[];
  bounds: DirtyRun | null;
}

/**
 * Paint material colors into an RGBA byte buffer, restricted to the dirty
 * chunk set.
 *
 * For each cell in a flagged dirty chunk:
 *  - If `colorGrid` has a nonzero packed color at that cell, unpack it
 *    (this carries explosion-debris tints and per-pixel color variation).
 *  - Otherwise look up `palette[grid[idx]]` for the material's base color.
 *  - Write `[r, g, b, a]` into the buffer at `idx * 4`.
 *
 * Cells outside dirty chunks are left untouched (the caller is expected to
 * reuse a persistent `ImageData` across frames and only repaint changes).
 *
 * Returns a {@link DirtyReport} describing what was painted, so the caller can
 * scope its `putImageData`/`drawImage` to the dirty region rather than
 * re-uploading the whole image every frame.
 *
 * @param data        - the `ImageData.data` buffer (length ≥ width*height*4)
 * @param grid        - material id per cell (length width*height)
 * @param colorGrid   - optional packed-RGBA per cell (ABGR: a<<24 | b<<16 | g<<8 | r), or null
 * @param width       - grid width in cells
 * @param height      - grid height in cells
 * @param chunkSize   - chunk edge length in cells (engine default 32)
 * @param dirty       - per-chunk dirty flags (length chunkWidth*chunkHeight)
 * @param chunkWidth  - number of chunks across
 * @param chunkHeight - number of chunks down
 * @param palette     - array indexed by material id → [r,g,b,a]
 */
export function paintGridInto(
  data: Uint8ClampedArray,
  grid: Uint8Array,
  colorGrid: Uint32Array | null,
  width: number,
  height: number,
  chunkSize: number,
  dirty: Uint8Array,
  chunkWidth: number,
  chunkHeight: number,
  palette: ReadonlyArray<readonly number[]>,
): DirtyReport {
  let chunkCount = 0;
  const runs: DirtyRun[] = [];
  // Bounding rect of every dirty cell, accumulated across chunk rows.
  let bxMin = width, byMin = height, bxMax = -1, byMax = -1;

  for (let cy = 0; cy < chunkHeight; cy++) {
    const yStart = cy * chunkSize;
    const yEnd = yStart + chunkSize > height ? height : yStart + chunkSize;
    let runCx0 = -1; // chunk-x start of the run being accumulated, -1 = none

    for (let cx = 0; cx < chunkWidth; cx++) {
      const isDirty = dirty[cy * chunkWidth + cx] !== 0;
      if (isDirty) {
        if (runCx0 < 0) runCx0 = cx; // begin a new run
        chunkCount++;
        // Paint this chunk's cells.
        const xStart = cx * chunkSize;
        const xEnd = xStart + chunkSize > width ? width : xStart + chunkSize;
        for (let y = yStart; y < yEnd; y++) {
          const rowOff = y * width;
          for (let x = xStart; x < xEnd; x++) {
            const idx = rowOff + x;
            const mat = grid[idx];
            const o = idx * 4;

            // Packed color (explosion debris / per-pixel tint) takes priority
            // when present; otherwise fall back to the material palette.
            const packed = colorGrid ? colorGrid[idx] : 0;
            if (packed !== 0) {
              // Format from engine.explode: (a << 24) | (b << 16) | (g << 8) | r
              data[o] = packed & 0xff;            // r
              data[o + 1] = (packed >>> 8) & 0xff; // g
              data[o + 2] = (packed >>> 16) & 0xff; // b
              data[o + 3] = (packed >>> 24) & 0xff; // a
            } else {
              const c = palette[mat] ?? [0, 0, 0, 0];
              data[o] = c[0];
              data[o + 1] = c[1];
              data[o + 2] = c[2];
              data[o + 3] = c[3];
            }
          }
        }
        // Extend the bounding rect with this chunk's cell range.
        if (xStart < bxMin) bxMin = xStart;
        if (yStart < byMin) byMin = yStart;
        if (xEnd > bxMax) bxMax = xEnd;
        if (yEnd > byMax) byMax = yEnd;
        continue;
      }
      // Not dirty: if a run was open and ended just before this chunk, close it.
      if (runCx0 >= 0) {
        const x0 = runCx0 * chunkSize;
        const x1 = cx * chunkSize > width ? width : cx * chunkSize;
        runs.push({ x: x0, y: yStart, w: x1 - x0, h: yEnd - yStart });
        runCx0 = -1;
      }
    }
    // End of row: close any run that ran to the last chunk.
    if (runCx0 >= 0) {
      const x0 = runCx0 * chunkSize;
      // The run ends at the right edge: chunkWidth*chunkSize, clamped to width.
      const rawEnd = chunkWidth * chunkSize;
      const x1 = rawEnd > width ? width : rawEnd;
      runs.push({ x: x0, y: yStart, w: x1 - x0, h: yEnd - yStart });
    }
  }

  const bounds: DirtyRun | null = chunkCount > 0
    ? { x: bxMin, y: byMin, w: bxMax - bxMin, h: byMax - byMin }
    : null;
  return { chunkCount, runs, bounds };
}

/**
 * Build the palette array the renderer wants, from the engine's `Materials`
 * record: an array indexed by material id where each entry is `[r,g,b,a]`.
 *
 * Centralized here so both sections share one definition and the palette
 * construction is itself testable.
 */
export function buildPalette(
  materials: Record<number, { color: readonly number[] }>,
): number[][] {
  // Collect ids, sort ascending, map to color tuples. Sorting ensures the
  // array is indexable by material id (id 0 → index 0, etc.).
  const ids = Object.keys(materials)
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
  const palette: number[][] = [];
  for (const id of ids) {
    palette[id] = [...materials[id].color];
  }
  return palette;
}
