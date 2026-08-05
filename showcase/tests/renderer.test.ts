import { describe, it, expect } from 'vitest';
import { paintGridInto, buildPalette } from '../helpers/renderer';
import { Materials, MaterialType } from '../../src/materials';

/** Build a flat palette array indexed by material id (id 0 → index 0). */
const PALETTE = buildPalette(Materials as Record<number, { color: readonly number[] }>);

describe('buildPalette', () => {
  it('produces an array indexable by material id', () => {
    expect(PALETTE[MaterialType.SAND]).toEqual([230, 200, 100, 255]);
    expect(PALETTE[MaterialType.WATER]).toEqual([50, 100, 255, 200]);
    expect(PALETTE[MaterialType.EMPTY]).toEqual([0, 0, 0, 0]);
  });

  it('includes a slot for every material id', () => {
    for (const id of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
      expect(PALETTE[id], `palette slot ${id}`).toBeDefined();
      expect(PALETTE[id]).toHaveLength(4);
    }
  });
});

describe('paintGridInto', () => {
  // A tiny 4×4 grid with 2×2 chunks → chunkWidth=2, chunkHeight=2.
  const W = 4;
  const H = 4;
  const CS = 2;
  const CW = 2;
  const CH = 2;

  it('writes the correct RGBA for a known material at a known cell', () => {
    const grid = new Uint8Array(W * H);
    grid[1 * W + 2] = MaterialType.SAND; // (2,1)
    const data = new Uint8ClampedArray(W * H * 4);
    const dirty = new Uint8Array(CW * CH).fill(1); // all dirty

    paintGridInto(data, grid, null, W, H, CS, dirty, CW, CH, PALETTE);

    const o = (1 * W + 2) * 4;
    expect([data[o], data[o + 1], data[o + 2], data[o + 3]]).toEqual([230, 200, 100, 255]);
  });

  it('only writes cells inside flagged dirty chunks', () => {
    const grid = new Uint8Array(W * H).fill(MaterialType.SAND);
    // Pre-fill the buffer with a sentinel so untouched cells are detectable.
    const data = new Uint8ClampedArray(W * H * 4).fill(7);
    // Flag only chunk (1,0) dirty — cells (2,0),(3,0),(2,1),(3,1).
    const dirty = new Uint8Array(CW * CH);
    dirty[0 * CW + 1] = 1;

    paintGridInto(data, grid, null, W, H, CS, dirty, CW, CH, PALETTE);

    // Dirty chunk cells overwritten with sand color.
    const oDirty = (1 * W + 2) * 4;
    expect([data[oDirty], data[oDirty + 1], data[oDirty + 2], data[oDirty + 3]]).toEqual([230, 200, 100, 255]);
    // Untouched cell keeps its sentinel (chunk (0,0) not dirty): cell (0,0).
    const oClean = 0;
    expect([data[oClean], data[oClean + 1], data[oClean + 2], data[oClean + 3]]).toEqual([7, 7, 7, 7]);
  });

  it('uses colorGrid packed color when present, falling back to palette when 0', () => {
    const grid = new Uint8Array(W * H).fill(MaterialType.SAND);
    const colorGrid = new Uint32Array(W * H);
    // Packed format from engine.explode: (a<<24)|(b<<16)|(g<<8)|r.
    // Set a distinct color (full-red opaque) at cell (1,0).
    const r = 255, g = 0, b = 0, a = 255;
    colorGrid[0 * W + 1] = (a << 24) | (b << 16) | (g << 8) | r;
    // Leave cell (2,0) at 0 → should fall back to sand palette color.

    const data = new Uint8ClampedArray(W * H * 4);
    const dirty = new Uint8Array(CW * CH).fill(1);

    paintGridInto(data, grid, colorGrid, W, H, CS, dirty, CW, CH, PALETTE);

    const oPacked = (0 * W + 1) * 4;
    expect([data[oPacked], data[oPacked + 1], data[oPacked + 2], data[oPacked + 3]]).toEqual([255, 0, 0, 255]);

    const oFallback = (0 * W + 2) * 4;
    expect([data[oFallback], data[oFallback + 1], data[oFallback + 2], data[oFallback + 3]]).toEqual([230, 200, 100, 255]);
  });

  it('writes every cell when every chunk is dirty (initial full paint)', () => {
    const grid = new Uint8Array(W * H).fill(MaterialType.WALL);
    const data = new Uint8ClampedArray(W * H * 4);
    const dirty = new Uint8Array(CW * CH).fill(1);

    paintGridInto(data, grid, null, W, H, CS, dirty, CW, CH, PALETTE);

    // Every cell is WALL gray [100,100,100,255].
    let allWall = true;
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      if (data[o] !== 100 || data[o + 1] !== 100 || data[o + 2] !== 100 || data[o + 3] !== 255) {
        allWall = false;
        break;
      }
    }
    expect(allWall).toBe(true);
  });
});

describe('dirty run coalescing (DirtyReport)', () => {
  // A 6×6 grid with 2×2 chunks → chunkWidth=3, chunkHeight=3. Wide enough to
  // form multi-chunk horizontal runs and to test edge-clamping.
  const W = 6, H = 6, CS = 2, CW = 3, CH = 3;

  const paint = (dirty: Uint8Array) => {
    const grid = new Uint8Array(W * H).fill(MaterialType.SAND);
    const data = new Uint8ClampedArray(W * H * 4);
    return paintGridInto(data, grid, null, W, H, CS, dirty, CW, CH, PALETTE);
  };

  it('reports zero chunks and no runs/bounds on a clean frame', () => {
    const report = paint(new Uint8Array(CW * CH));
    expect(report.chunkCount).toBe(0);
    expect(report.runs).toEqual([]);
    expect(report.bounds).toBeNull();
  });

  it('coalesces horizontally adjacent dirty chunks into one run', () => {
    // Chunks (0,0) and (1,0) dirty → one run covering x∈[0,4), y∈[0,2).
    const dirty = new Uint8Array(CW * CH);
    dirty[0] = 1; dirty[1] = 1;
    const report = paint(dirty);
    expect(report.chunkCount).toBe(2);
    expect(report.runs).toEqual([{ x: 0, y: 0, w: 4, h: 2 }]);
  });

  it('splits runs at a gap within the same chunk row', () => {
    // Chunks (0,0) and (2,0) dirty, (1,0) clean → two separate runs.
    const dirty = new Uint8Array(CW * CH);
    dirty[0] = 1; dirty[2] = 1;
    const report = paint(dirty);
    expect(report.chunkCount).toBe(2);
    expect(report.runs).toEqual([
      { x: 0, y: 0, w: 2, h: 2 },
      { x: 4, y: 0, w: 2, h: 2 },
    ]);
  });

  it('keeps runs one chunk-row tall (no vertical coalescing)', () => {
    // Chunks (0,0) and (0,1) dirty (vertically adjacent) → two runs, not one.
    const dirty = new Uint8Array(CW * CH);
    dirty[0 * CW + 0] = 1; dirty[1 * CW + 0] = 1;
    const report = paint(dirty);
    expect(report.runs).toHaveLength(2);
    expect(report.runs[0]).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    expect(report.runs[1]).toEqual({ x: 0, y: 2, w: 2, h: 2 });
  });

  it('clamps run width at the right edge for sizes not a multiple of chunkSize', () => {
    // A 5×5 grid (CS=2) → chunkWidth=3, but the rightmost chunk column is only
    // 1 cell wide (cells 4). Dirty the whole top row → run must clamp to width 5.
    const w = 5, h = 5, cs = 2, cw = 3, ch = 3;
    const grid = new Uint8Array(w * h).fill(MaterialType.SAND);
    const data = new Uint8ClampedArray(w * h * 4);
    const dirty = new Uint8Array(cw * ch);
    dirty[0] = 1; dirty[1] = 1; dirty[2] = 1; // top chunk row
    const report = paintGridInto(data, grid, null, w, h, cs, dirty, cw, ch, PALETTE);
    expect(report.runs).toEqual([{ x: 0, y: 0, w: 5, h: 2 }]);
  });

  it('clamps run height at the bottom edge', () => {
    // A 6×5 grid (CS=2) → chunkHeight=3, bottom chunk row is only 1 cell tall.
    const w = 6, h = 5, cs = 2, cw = 3, ch = 3;
    const grid = new Uint8Array(w * h).fill(MaterialType.SAND);
    const data = new Uint8ClampedArray(w * h * 4);
    const dirty = new Uint8Array(cw * ch);
    dirty[2 * cw + 1] = 1; // bottom-middle chunk
    const report = paintGridInto(data, grid, null, w, h, cs, dirty, cw, ch, PALETTE);
    expect(report.runs).toEqual([{ x: 2, y: 4, w: 2, h: 1 }]);
  });

  it('reports a tight bounding rect across multiple runs', () => {
    // Dirty chunks at (0,0) and (2,2): bounds should span the full extent.
    const dirty = new Uint8Array(CW * CH);
    dirty[0] = 1; dirty[2 * CW + 2] = 1;
    const report = paint(dirty);
    expect(report.bounds).toEqual({ x: 0, y: 0, w: 6, h: 6 });
  });

  it('reports one run spanning the full row and a full-extent bounds when all dirty', () => {
    const dirty = new Uint8Array(CW * CH).fill(1);
    const report = paint(dirty);
    // Three chunk rows → three runs, each spanning the full width.
    expect(report.runs).toHaveLength(CH);
    for (const r of report.runs) expect(r.w).toBe(W);
    expect(report.bounds).toEqual({ x: 0, y: 0, w: W, h: H });
    expect(report.chunkCount).toBe(CW * CH);
  });
});
