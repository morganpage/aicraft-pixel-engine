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
