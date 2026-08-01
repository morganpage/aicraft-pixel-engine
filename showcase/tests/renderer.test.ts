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
