import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../sand';
import { MaterialType } from '../materials';
import { FlatGravity } from '../gravity';

/**
 * Chunk-system tests. Use a grid whose dimensions are exact multiples of
 * CHUNK_SIZE (32) so chunk boundaries are predictable.
 */
const CS = 32;

function makeEngine(): PixelEngine {
  return new PixelEngine({ width: CS * 2, height: CS, seed: 1, gravity: new FlatGravity() });
}

describe('render-dirty tracking', () => {
  it('reports every chunk dirty on the first consume (full initial paint)', () => {
    const e = makeEngine();
    const dirty = e.consumeRenderDirtyChunks();
    let sum = 0;
    for (let i = 0; i < dirty.length; i++) sum += dirty[i];
    expect(sum).toBe(dirty.length);
  });

  it('marks only the chunk touched by setMaterial after the initial consume', () => {
    const e = makeEngine();
    e.consumeRenderDirtyChunks(); // clear initial full-dirty

    e.setMaterial(5, 5, MaterialType.SAND);
    const dirty = e.consumeRenderDirtyChunks();
    const expected = Math.floor(5 / CS) + Math.floor(5 / CS) * e.chunkWidth;
    // Exactly one chunk dirty.
    let count = 0;
    for (let i = 0; i < dirty.length; i++) if (dirty[i]) count++;
    expect(count).toBe(1);
    expect(dirty[expected]).toBe(1);
  });

  it('resets after consume (second consume with no changes reports nothing)', () => {
    const e = makeEngine();
    e.consumeRenderDirtyChunks();
    e.setMaterial(0, 0, MaterialType.SAND);
    e.consumeRenderDirtyChunks();
    const dirty = e.consumeRenderDirtyChunks();
    let sum = 0;
    for (let i = 0; i < dirty.length; i++) sum += dirty[i];
    expect(sum).toBe(0);
  });
});

describe('wakeChunk border propagation', () => {
  it('waking a cell on the left chunk edge also wakes the chunk to its left', () => {
    const e = makeEngine();
    // Cell x = CS sits at localX 0 of chunk column 1 → wakes column 0 too.
    e.wakeChunk(CS, 0);
    // nextActiveChunks is what will be active next frame.
    expect(e.nextActiveChunks[0]).toBe(1); // chunk (0,0)
    expect(e.nextActiveChunks[1]).toBe(1); // chunk (1,0)
  });

  it('waking an interior cell wakes only its own chunk', () => {
    const e = makeEngine();
    // clear() pre-activates every chunk; reset to a cold start before testing.
    e.nextActiveChunks.fill(0);
    e.wakeChunk(5, 5);
    // Only chunk (0,0) should be woken.
    let woken = 0;
    for (let i = 0; i < e.nextActiveChunks.length; i++) if (e.nextActiveChunks[i]) woken++;
    expect(woken).toBe(1);
    expect(e.nextActiveChunks[0]).toBe(1);
  });
});

describe('inactive chunks are not simulated', () => {
  it('sand in an inactive chunk does not fall', () => {
    // Fresh grid: clear() wakes every chunk. We need a grid where only one
    // region is active. Strategy: make a grid, drop sand, step once (this
    // establishes active regions from the dirtied cells), then build a
    // scenario where a faraway cell is never touched.
    const e = new PixelEngine({ width: CS * 4, height: CS, seed: 1, gravity: new FlatGravity() });
    // Place a wall floor across the whole grid and sand far to the right.
    for (let x = 0; x < CS * 4; x++) e.setMaterial(x, CS - 1, MaterialType.WALL);
    // Drop sand in the far-right region and capture its position.
    const sandX = CS * 4 - 2;
    e.setMaterial(sandX, 0, MaterialType.SAND);
    // Manually deactivate all chunks, then activate ONLY the leftmost chunk.
    e.nextActiveChunks.fill(0);
    e.activeChunks.fill(0);
    e.activeChunks[0] = 1; // only top-left chunk active
    e.nextActiveChunks[0] = 1;
    const before = e.getMaterial(sandX, 0);
    e.update();
    const after = e.getMaterial(sandX, 0);
    // Sand in an inactive chunk must not have moved.
    expect(before).toBe(MaterialType.SAND);
    expect(after).toBe(MaterialType.SAND);
  });
});

describe('bulk-stamp (beginBulk / endBulk)', () => {
  it('writes materials without per-cell dirty bookkeeping, then markAllDirty on end', () => {
    const e = makeEngine();
    // Consume the initial full-dirty so the post-endBulk all-dirty is observable.
    e.consumeRenderDirtyChunks();
    e.renderDirtyChunks.fill(0);

    e.beginBulk();
    e.setMaterial(1, 1, MaterialType.SAND);
    e.setMaterial(50, 5, MaterialType.ROCK);
    // Mid-bulk: nothing should be marked dirty yet.
    let mid = 0;
    for (let i = 0; i < e.renderDirtyChunks.length; i++) mid += e.renderDirtyChunks[i];
    expect(mid).toBe(0);
    // But the materials are written.
    expect(e.getMaterial(1, 1)).toBe(MaterialType.SAND);
    expect(e.getMaterial(50, 5)).toBe(MaterialType.ROCK);

    e.endBulk();
    // Post-endBulk: every chunk is render-dirty (markAllDirty ran).
    let after = 0;
    for (let i = 0; i < e.renderDirtyChunks.length; i++) after += e.renderDirtyChunks[i];
    expect(after).toBe(e.renderDirtyChunks.length);
  });

  it('clears per-cell override grids (color/stiffness/growth) at touched cells', () => {
    const e = makeEngine();
    // Force the optional grids to exist and seed a nonzero override, then verify
    // a bulk stamp clears it (matching setMaterial's non-bulk clearing semantics).
    const idx = e.getIndex(1, 1);
    e.colorGrid = new Uint32Array(e.width * e.height);
    e.stiffnessGrid = new Uint8Array(e.width * e.height);
    e.growthGrid = new Uint16Array(e.width * e.height);
    e.colorGrid[idx] = 0xff112233;
    e.stiffnessGrid[idx] = 5;
    e.growthGrid[idx] = 999;

    e.beginBulk();
    e.setMaterial(1, 1, MaterialType.SAND);
    e.endBulk();

    expect(e.colorGrid![idx]).toBe(0);
    expect(e.stiffnessGrid![idx]).toBe(0);
    expect(e.growthGrid![idx]).toBe(0);
  });

  it('reaches the same settled state as a non-bulk stamp of the same shape', () => {
    // Two engines: one stamps a disc via full setMaterial, one via bulk. After a
    // handful of updates both must converge to the same grid — the bulk path's
    // markAllDirty recovers the work the per-cell bookkeeping would have done.
    const stamp = (bulk: boolean): PixelEngine => {
      const e = new PixelEngine({ width: 64, height: 64, seed: 1, gravity: new FlatGravity() });
      e.consumeRenderDirtyChunks(); // clear initial full-dirty
      const cx = 32, cy = 32, r2 = 16 * 16;
      if (bulk) e.beginBulk();
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) e.setMaterial(x, y, MaterialType.ROCK);
        }
      }
      if (bulk) e.endBulk();
      return e;
    };
    const a = stamp(false);
    const b = stamp(true);
    // Run both a few steps and compare.
    for (let i = 0; i < 5; i++) { a.update(); b.update(); }
    for (let i = 0; i < a.grid.length; i++) {
      expect(b.grid[i]).toBe(a.grid[i]);
    }
  });

  it('endBulk is a no-op when not in bulk mode', () => {
    const e = makeEngine();
    expect(() => e.endBulk()).not.toThrow();
  });
});
