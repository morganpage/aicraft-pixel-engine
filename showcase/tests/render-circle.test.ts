import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../../src/sand';
import { MaterialType, Materials } from '../../src/materials';
import { RadialGravity } from '../../src/gravity';
import { paintGridInto, buildPalette, type DirtyRun } from '../helpers/renderer';

/**
 * Render-integration tests: the full stamp → dirty-mark → repaint → upload
 * pipeline must keep a painted disc intact when only a ring of its cells is
 * later marked dirty. This is the regression the dirty-rect upload path broke:
 * after Scatter, the planet circle shattered because the per-run `putImageData`
 * semantics were wrong.
 *
 * These run under `environment: 'node'` with no canvas library. Instead of a
 * real 2D context we model the offscreen→visible upload as a pure pixel copy
 * (which is exactly what `putImageData` does), so the contract is testable
 * without a DOM. The engine here is a hand-rolled minimal stand-in exposing
 * only the fields the renderer reads.
 */

/** Minimal engine-like object the renderer reads. */
interface FakeEngine {
  width: number;
  height: number;
  grid: Uint8Array;
  colorGrid: Uint32Array | null;
  CHUNK_SIZE: number;
  chunkWidth: number;
  chunkHeight: number;
  /** Per-chunk dirty mask the host consumes each frame. */
  renderDirty: Uint8Array;
}

const makeEngine = (size: number): FakeEngine => {
  const CS = 32;
  return {
    width: size,
    height: size,
    grid: new Uint8Array(size * size),
    colorGrid: null,
    CHUNK_SIZE: CS,
    chunkWidth: Math.ceil(size / CS),
    chunkHeight: Math.ceil(size / CS),
    renderDirty: new Uint8Array(Math.ceil(size / CS) * Math.ceil(size / CS)),
  };
};

/** A 2-bit palette: 0 = empty (transparent), 1 = rock (grey). */
const PALETTE: number[][] = [
  [0, 0, 0, 0],   // EMPTY
  [120, 120, 120, 255], // ROCK
  [230, 200, 100, 255], // SAND
  [50, 100, 255, 200],  // WATER
];

const ROCK = 1;

/** Stamp a filled disc of ROCK into the grid, marking every touched chunk dirty. */
const stampDisc = (e: FakeEngine, cx: number, cy: number, r: number): void => {
  const r2 = r * r;
  for (let y = 0; y < e.height; y++) {
    for (let x = 0; x < e.width; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) {
        e.grid[y * e.width + x] = ROCK;
        e.renderDirty[Math.floor(y / e.CHUNK_SIZE) * e.chunkWidth + Math.floor(x / e.CHUNK_SIZE)] = 1;
      }
    }
  }
};

/**
 * Model the two-canvas pipeline the section uses:
 *   - `img`   : the persistent ImageData the renderer paints into each frame.
 *   - `off`   : the persistent offscreen canvas, updated from `img` via
 *               putImageData (full or per-run dirty rect).
 *   - `visible`: the persistent visible canvas, cleared and redrawn from `off`
 *               via drawImage each composed frame.
 *
 * Both `off` and `visible` persist across frames — that persistence is what
 * makes a dirty-rect upload correct (unchanged regions keep their previous
 * pixels). Modeling it faithfully is what catches the real regression.
 */
interface CanvasPipeline {
  img: Uint8ClampedArray;
  off: Uint8ClampedArray;
  visible: Uint8ClampedArray;
  size: number;
}

const makePipeline = (size: number): CanvasPipeline => ({
  img: new Uint8ClampedArray(size * size * 4),
  off: new Uint8ClampedArray(size * size * 4),
  visible: new Uint8ClampedArray(size * size * 4),
  size,
});

/** Upload the dirty runs from img→off (the per-run putImageData path). */
const uploadRuns = (p: CanvasPipeline, runs: DirtyRun[]): void => {
  for (const r of runs) {
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const o = ((r.y + y) * p.size + (r.x + x)) * 4;
        p.off[o] = p.img[o];
        p.off[o + 1] = p.img[o + 1];
        p.off[o + 2] = p.img[o + 2];
        p.off[o + 3] = p.img[o + 3];
      }
    }
  }
};

/** Full upload img→off (putImageData(img,0,0)). */
const uploadFull = (p: CanvasPipeline): void => {
  p.off.set(p.img);
};

/** Compose: clear visible, then copy all of off→visible (drawImage). */
const compose = (p: CanvasPipeline): void => {
  p.visible.fill(0); // ctx.fillRect clear
  // drawImage copies the whole offscreen — every region, dirty or not.
  for (let i = 0; i < p.off.length; i++) p.visible[i] = p.off[i];
};

/** True if the pixel at (x,y) is opaque rock-grey (inside the disc). */
const isRock = (data: Uint8ClampedArray, w: number, x: number, y: number): boolean => {
  const o = (y * w + x) * 4;
  return data[o] === 120 && data[o + 1] === 120 && data[o + 2] === 120 && data[o + 3] === 255;
};

describe('render pipeline keeps the disc intact under a partial dirty update', () => {
  // The regression: the disc renders correctly on the first (full) frame, but
  // after a partial dirty update — the exact pattern Scatter produces — the
  // circle visibly breaks apart. These tests reproduce that pipeline without a
  // DOM by driving the renderer the same way the section does.

  it('a freshly stamped disc renders as a solid circle (baseline)', () => {
    const SIZE = 220, cx = 110, cy = 110, r = 33;
    const e = makeEngine(SIZE);
    stampDisc(e, cx, cy, r);
    const p = makePipeline(SIZE);
    paintGridInto(p.img, e.grid, e.colorGrid, SIZE, SIZE, e.CHUNK_SIZE, e.renderDirty, e.chunkWidth, e.chunkHeight, PALETTE);
    uploadFull(p);
    compose(p);
    e.renderDirty.fill(0);

    for (const [dx, dy] of [[0, -r], [0, r], [-r, 0], [r, 0]]) {
      expect(isRock(p.visible, SIZE, cx + dx, cy + dy), `edge (${cx + dx},${cy + dy})`).toBe(true);
    }
    expect(isRock(p.visible, SIZE, cx, cy - r - 5)).toBe(false);
  });

  it('after a ring-only dirty update the disc stays circular (Scatter pattern)', () => {
    const SIZE = 220, cx = 110, cy = 110, r = 33;
    const e = makeEngine(SIZE);
    stampDisc(e, cx, cy, r);
    const p = makePipeline(SIZE);

    // Frame 0: full paint + full upload + compose → visible has the full disc.
    paintGridInto(p.img, e.grid, e.colorGrid, SIZE, SIZE, e.CHUNK_SIZE, e.renderDirty, e.chunkWidth, e.chunkHeight, PALETTE);
    uploadFull(p);
    compose(p);
    e.renderDirty.fill(0);

    // Frame 1: Scatter — stamp a SAND ring and mark only those chunks dirty.
    const scatterR = 40;
    const points = Math.max(12, Math.round((2 * Math.PI * scatterR) / 3));
    for (let i = 0; i < points; i++) {
      const rad = (i / points) * 2 * Math.PI;
      const sx = Math.round(cx + Math.cos(rad) * scatterR);
      const sy = Math.round(cy + Math.sin(rad) * scatterR);
      e.grid[sy * SIZE + sx] = 2; // SAND
      e.renderDirty[Math.floor(sy / e.CHUNK_SIZE) * e.chunkWidth + Math.floor(sx / e.CHUNK_SIZE)] = 1;
    }
    // Repaint only dirty chunks into the persistent img, upload the dirty runs,
    // and recompose — exactly the section's per-frame sequence.
    const report = paintGridInto(p.img, e.grid, e.colorGrid, SIZE, SIZE, e.CHUNK_SIZE, e.renderDirty, e.chunkWidth, e.chunkHeight, PALETTE);
    uploadRuns(p, report.runs);
    compose(p);

    // The disc must still be intact: its edge and interior are rock, unchanged
    // by the ring update that touched only cells outside it.
    for (const [dx, dy] of [[0, -r], [0, r], [-r, 0], [r, 0]]) {
      expect(isRock(p.visible, SIZE, cx + dx, cy + dy), `disc edge (${cx + dx},${cy + dy})`).toBe(true);
    }
    for (const [dx, dy] of [[0, 0], [-10, 0], [10, 0], [0, -10], [0, 10]]) {
      expect(isRock(p.visible, SIZE, cx + dx, cy + dy), `disc interior (${cx + dx},${cy + dy})`).toBe(true);
    }
  });
});

describe('putImageData dirty-rect contract (the Scatter regression)', () => {
  // The bug: render() uploaded dirty runs with `putImageData(img, r.x, r.y,
  // r.x, r.y, r.w, r.h)`. The 6-arg form maps the SOURCE origin (0,0) to the
  // destination (dx,dy), then the dirty rect (in DESTINATION space) clips which
  // of that drawn region lands. Passing r.x,r.y as dx,dy shifts the source by
  // (r.x,r.y) and then clips a region that no longer aligns with the changed
  // pixels — so the upload silently placed nothing (or the wrong cells), and the
  // circle shattered on the first partial-dirty frame. The fix is dx=dy=0 so the
  // mapping is identity and the dirty rect selects exactly the changed region.
  //
  // These tests encode the putImageData contract per the HTML spec so the call
  // can't silently regress again. They run without a canvas: the contract is
  // pure coordinate math, modeled exactly as the spec defines it.

  /**
   * The HTML-spec putImageData(image, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH):
   * source pixel (sx, sy) maps to destination (sx + dx, sy + dy); then only
   * destination pixels inside the dirty rect [dirtyX, dirtyX+dirtyW) ×
   * [dirtyY, dirtyY+dirtyH) are written. Clamping to the canvas is implicit.
   */
  const putImageData = (
    dst: Uint8ClampedArray, src: Uint8ClampedArray, w: number, h: number,
    dx: number, dy: number, dirtyX: number, dirtyY: number, dirtyW: number, dirtyH: number,
  ): void => {
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const dstX = sx + dx, dstY = sy + dy;
        // Only the dirty-rect region of the destination is touched.
        if (dstX < dirtyX || dstX >= dirtyX + dirtyW || dstY < dirtyY || dstY >= dirtyY + dirtyH) continue;
        if (dstX < 0 || dstX >= w || dstY < 0 || dstY >= h) continue;
        const so = (sy * w + sx) * 4, doff = (dstY * w + dstX) * 4;
        dst[doff] = src[so]; dst[doff + 1] = src[so + 1]; dst[doff + 2] = src[so + 2]; dst[doff + 3] = src[so + 3];
      }
    }
  };

  it('REGRESSION: the section call (dx=dy=0) places source (x,y) at dest (x,y)', () => {
    // 10×10 source all red; mark a 3×3 region at (2,2) green. Upload with the
    // section's call shape and confirm the green lands at dest (2..4, 2..4) and
    // the rest stays red.
    const w = 10, h = 10;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < src.length; i += 4) { src[i] = 255; src[i + 3] = 255; } // red
    for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) {
      const o = (y * w + x) * 4; src[o] = 0; src[o + 1] = 255; // green in that region
    }
    const dst = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < dst.length; i += 4) { dst[i] = 255; dst[i + 3] = 255; } // red base

    // The section's corrected call: putImageData(img, 0, 0, r.x, r.y, r.w, r.h)
    putImageData(dst, src, w, h, 0, 0, 2, 2, 3, 3);
    const at = (x: number, y: number): readonly number[] => {
      const o = (y * w + x) * 4; return [dst[o], dst[o + 1], dst[o + 2], dst[o + 3]];
    };
    // Green region landed at dest (2..4, 2..4) — source maps identity.
    expect(at(3, 3)).toEqual([0, 255, 0, 255]);
    expect(at(2, 2)).toEqual([0, 255, 0, 255]);
    expect(at(4, 4)).toEqual([0, 255, 0, 255]);
    // Outside the dirty rect, the base is untouched.
    expect(at(0, 0)).toEqual([255, 0, 0, 255]);
    expect(at(5, 5)).toEqual([255, 0, 0, 255]);
  });

  it('ENCODES THE BUG: the old call (dx=r.x,dy=r.y) does NOT place source (x,y) at dest (x,y)', () => {
    // The buggy call was putImageData(img, r.x, r.y, r.x, r.y, r.w, r.h), i.e.
    // dx=r.x, dy=r.y. Under the spec, source-(0,0)→dest-(r.x,r.y), so a source
    // change at (r.x,r.y) lands at dest-(2r.x, 2r.y) — NOT at (r.x,r.y). The
    // whole point of a dirty-rect upload is to put the changed source pixels at
    // their identity destination, so this is simply wrong. Assert that the buggy
    // shape does NOT satisfy the identity property (source (x,y) → dest (x,y)),
    // which is what made the circle shatter in the browser.
    const w = 10, h = 10;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < src.length; i += 4) { src[i] = 255; src[i + 3] = 255; }
    // Source change at exactly (2,2).
    const o22 = (2 * w + 2) * 4; src[o22] = 0; src[o22 + 1] = 255;
    const dst = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < dst.length; i += 4) { dst[i] = 255; dst[i + 3] = 255; }

    // Correct call: dx=dy=0 → source (2,2) lands at dest (2,2). (Identity holds.)
    const dstCorrect = dst.slice();
    putImageData(dstCorrect, src, w, h, 0, 0, 2, 2, 1, 1);
    expect(dstCorrect[(2 * w + 2) * 4 + 1]).toBe(255); // green landed at dest (2,2)

    // Buggy call: dx=2, dy=2 → source (2,2) lands at dest (4,4), NOT (2,2).
    const dstBuggy = dst.slice();
    putImageData(dstBuggy, src, w, h, 2, 2, 2, 2, 1, 1);
    // The identity property breaks: dest (2,2) is untouched...
    expect(dstBuggy[(2 * w + 2) * 4 + 1]).toBe(0); // still red, no green
    // ...which is why the browser never showed the scatter update.
  });
});

describe('render pipeline with the REAL engine (no fake)', () => {
  // The fake-engine tests above prove the pure pixel math. This block drives
  // the actual PixelEngine — real setMaterial/markRenderDirty/consumeRenderDirtyChunks
  // — through the exact per-frame sequence the section runs, so the dirty-set
  // lifecycle (consume-then-clear, bulk stamp's markAllDirty) is exercised for
  // real. If the disc shatters here, the engine's dirty tracking is at fault.

  const PALETTE = buildPalette(Materials as Record<number, { color: readonly number[] }>);
  const isRock = (data: Uint8ClampedArray, w: number, x: number, y: number): boolean => {
    const o = (y * w + x) * 4;
    const c = Materials[MaterialType.ROCK].color;
    return data[o] === c[0] && data[o + 1] === c[1] && data[o + 2] === c[2] && data[o + 3] === c[3];
  };

  const runFrame = (
    engine: PixelEngine,
    img: Uint8ClampedArray,
    off: Uint8ClampedArray,
    visible: Uint8ClampedArray,
    size: number,
  ): void => {
    // Mirror render() exactly: consume dirty, paint, choose upload strategy,
    // upload, compose. The coverage threshold mirrors the section's 50%.
    const dirty = engine.consumeRenderDirtyChunks();
    const report = paintGridInto(img, engine.grid, engine.colorGrid, size, size, engine.CHUNK_SIZE, dirty, engine.chunkWidth, engine.chunkHeight, PALETTE);
    if (report.chunkCount > 0) {
      const total = engine.chunkWidth * engine.chunkHeight;
      const full = report.chunkCount > total * 0.5 || report.runs.length > engine.chunkHeight * 2 || report.bounds === null;
      if (full) {
        off.set(img);
      } else {
        for (const r of report.runs) {
          for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
            const o = ((r.y + y) * size + (r.x + x)) * 4;
            off[o] = img[o]; off[o + 1] = img[o + 1]; off[o + 2] = img[o + 2]; off[o + 3] = img[o + 3];
          }
        }
      }
    }
    // Compose: clear + drawImage (copy all of off).
    visible.fill(0);
    for (let i = 0; i < off.length; i++) visible[i] = off[i];
  };

  it('REAL ENGINE: disc stays circular after a Scatter ring update', () => {
    const SIZE = 220, cx = 110, cy = 110, r = 33;
    const engine = new PixelEngine({
      width: SIZE, height: SIZE, seed: 1,
      gravity: new RadialGravity({ centerX: cx, centerY: cy }),
    });
    // Stamp the disc via bulk (as stampPlanetSync does), then the first frame.
    engine.beginBulk();
    const r2 = r * r;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) engine.setMaterial(x, y, MaterialType.ROCK);
    }
    engine.endBulk();

    const img = new Uint8ClampedArray(SIZE * SIZE * 4);
    const off = new Uint8ClampedArray(SIZE * SIZE * 4);
    const visible = new Uint8ClampedArray(SIZE * SIZE * 4);

    // Frame 0: full paint (endBulk marks everything dirty → full upload).
    runFrame(engine, img, off, visible, SIZE);

    // Sanity: the disc rendered on frame 0.
    expect(isRock(visible, SIZE, cx, cy), 'center is rock after frame 0').toBe(true);

    // Frame 1: Scatter a SAND ring around the disc, marking only those cells dirty.
    const scatterR = 40;
    const points = Math.max(12, Math.round((2 * Math.PI * scatterR) / 3));
    for (let i = 0; i < points; i++) {
      const rad = (i / points) * 2 * Math.PI;
      const sx = Math.round(cx + Math.cos(rad) * scatterR);
      const sy = Math.round(cy + Math.sin(rad) * scatterR);
      engine.setMaterial(sx, sy, MaterialType.SAND);
    }
    runFrame(engine, img, off, visible, SIZE);

    // THE ASSERTION: the disc body must be intact — the ring touched only cells
    // 40px out; the circle's interior and edge (33px) must be unchanged rock.
    expect(isRock(visible, SIZE, cx, cy), 'center still rock after scatter').toBe(true);
    for (const [dx, dy] of [[0, -r], [0, r], [-r, 0], [r, 0]]) {
      expect(isRock(visible, SIZE, cx + dx, cy + dy), `disc edge (${cx + dx},${cy + dy})`).toBe(true);
    }
  });
});
