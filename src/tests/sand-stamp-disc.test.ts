import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../sand';
import { MaterialType } from '../materials';
import { FlatGravity } from '../gravity';

function engine(width = 32, height = 32): PixelEngine {
  return new PixelEngine({ width, height, seed: 11, gravity: new FlatGravity() });
}

/** Independent geometric count of the cells a disc stamp should cover. */
function discCellCount(cx: number, cy: number, radius: number, w: number, h: number): number {
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) n++;
    }
  }
  return n;
}

describe('stampDisc', () => {
  it('writes exactly the Euclidean disc of cells', () => {
    const e = engine();
    const written = e.stampDisc(16, 16, 5, MaterialType.SAND);
    expect(written).toBe(discCellCount(16, 16, 5, 32, 32));
    let sand = 0;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        if (e.getMaterial(x, y) === MaterialType.SAND) sand++;
      }
    }
    expect(sand).toBe(written);
  });

  it('clips at the grid edges without throwing and counts only written cells', () => {
    const e = engine();
    const written = e.stampDisc(0, 0, 4, MaterialType.WATER);
    expect(written).toBe(discCellCount(0, 0, 4, 32, 32));
    // The centre and the fully-in-grid quadrant are stamped; nothing wrapped.
    expect(e.getMaterial(0, 0)).toBe(MaterialType.WATER);
    expect(e.getMaterial(31, 31)).toBe(MaterialType.EMPTY);
  });

  it('by default paints only EMPTY cells — never carves existing terrain', () => {
    const e = engine();
    e.setMaterial(16, 16, MaterialType.ROCK);
    const written = e.stampDisc(16, 16, 3, MaterialType.SAND);
    expect(written).toBe(discCellCount(16, 16, 3, 32, 32) - 1);
    expect(e.getMaterial(16, 16)).toBe(MaterialType.ROCK);
  });

  it('overwrite: true replaces existing material like setMaterial', () => {
    const e = engine();
    e.setMaterial(16, 16, MaterialType.ROCK);
    const written = e.stampDisc(16, 16, 3, MaterialType.SAND, { overwrite: true });
    expect(written).toBe(discCellCount(16, 16, 3, 32, 32));
    expect(e.getMaterial(16, 16)).toBe(MaterialType.SAND);
  });

  it('marks the touched chunks render-dirty', () => {
    // 128×128 → 4 chunks per row, so a disc at the centre spans four chunks.
    const e = engine(128, 128);
    e.consumeRenderDirtyChunks(); // drop the constructor's all-dirty frame
    e.stampDisc(64, 64, 20, MaterialType.SAND);
    const dirty = e.consumeRenderDirtyChunks();
    const chunksPerRow = e.width / e.CHUNK_SIZE;
    const idx = (cx: number, cy: number) => cy * chunksPerRow + cx;
    // The disc at (64,64) reaches across the chunk-1/2 seam in both axes.
    expect(dirty[idx(1, 1)]).toBe(1);
    expect(dirty[idx(2, 1)]).toBe(1);
    expect(dirty[idx(1, 2)]).toBe(1);
    expect(dirty[idx(2, 2)]).toBe(1);
    // Far-away chunks stay clean.
    expect(dirty[idx(0, 0)]).toBe(0);
    expect(dirty[idx(chunksPerRow - 1, chunksPerRow - 1)]).toBe(0);
  });

  it('is deterministic: same stamps → byte-identical grids', () => {
    const a = engine();
    const b = engine();
    a.stampDisc(10, 10, 6, MaterialType.SAND);
    a.stampDisc(20, 8, 3, MaterialType.WATER);
    b.stampDisc(10, 10, 6, MaterialType.SAND);
    b.stampDisc(20, 8, 3, MaterialType.WATER);
    expect(Array.from(a.grid)).toEqual(Array.from(b.grid));
  });

  it('radius 0 stamps exactly the centre cell; negative radius stamps nothing', () => {
    const e = engine();
    expect(e.stampDisc(5, 5, 0, MaterialType.OIL)).toBe(1);
    expect(e.getMaterial(5, 5)).toBe(MaterialType.OIL);
    expect(e.stampDisc(5, 5, -1, MaterialType.OIL)).toBe(0);
  });
});
