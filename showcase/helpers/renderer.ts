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
): void {
  for (let cy = 0; cy < chunkHeight; cy++) {
    for (let cx = 0; cx < chunkWidth; cx++) {
      if (!dirty[cy * chunkWidth + cx]) continue;
      const xStart = cx * chunkSize;
      const yStart = cy * chunkSize;
      const xEnd = Math.min(xStart + chunkSize, width);
      const yEnd = Math.min(yStart + chunkSize, height);
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
    }
  }
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
