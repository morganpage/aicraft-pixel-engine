/**
 * Anchored structural support, and the rooting gate on `plant()`.
 *
 * These two features exist to close one bug with two halves, reported against
 * 0.2.1 as "trees growing in the air" in a god-game build:
 *
 *  1. `plant(x, y, TREE_TIP)` grew a complete tree at any cell, sky included,
 *     because a tip material is `isStatic` and nothing asked what was under it.
 *  2. The resulting trunk never fell, because `needsSupport` was a one-hop
 *     neighbour test and WOOD is itself structural — so two stacked trunk
 *     cells each cited the other as their support, forever.
 *
 * Every test below is the measured before/after of one of those.
 */
import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../sand';
import { MaterialType } from '../materials';
import { FlatGravity, RadialGravity } from '../gravity';

function flat(w: number, h: number, seed = 42): PixelEngine {
  return new PixelEngine({ width: w, height: h, seed, gravity: new FlatGravity() });
}

/** A world with a sand floor `depth` rows deep along the bottom. */
function withSoil(w: number, h: number, depth = 4, seed = 42): PixelEngine {
  const e = flat(w, h, seed);
  for (let y = h - depth; y < h; y++) {
    for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.SAND);
  }
  return e;
}

function count(e: PixelEngine, mat: MaterialType): number {
  let n = 0;
  for (let i = 0; i < e.grid.length; i++) if (e.grid[i] === mat) n++;
  return n;
}

/** Rows holding at least one cell of `mat`, ascending. */
function rowsWith(e: PixelEngine, w: number, h: number, mat: MaterialType): number[] {
  const rows: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (e.grid[y * w + x] === mat) { rows.push(y); break; }
    }
  }
  return rows;
}

describe('anchored support', () => {
  // The control. A lone WOOD cell always fell correctly — the bug needed two.
  it('a single airborne wood cell falls to the floor', () => {
    const e = withSoil(20, 20, 2);
    e.setMaterial(10, 5, MaterialType.WOOD);
    for (let i = 0; i < 200; i++) e.update();
    expect(rowsWith(e, 20, 20, MaterialType.WOOD)).toEqual([17]);
  });

  // The bug, in its smallest form. Under the one-hop rule each of these cited
  // the other and the pair hung at y=5 indefinitely.
  it('a stacked airborne wood pair falls — neither cell supports the other', () => {
    const e = withSoil(20, 20, 2);
    e.setMaterial(10, 5, MaterialType.WOOD);
    e.setMaterial(10, 6, MaterialType.WOOD);
    for (let i = 0; i < 200; i++) e.update();
    // Both cells end up on the soil. Which rows exactly depends on whether the
    // pair stacks or spreads as it lands, so assert the part that is the bug:
    // nothing is left up at y=5/6.
    expect(count(e, MaterialType.WOOD)).toBe(2);
    expect(rowsWith(e, 20, 20, MaterialType.WOOD).every((y) => y >= 16)).toBe(true);
  });

  // Horizontal was the other half of the same circularity.
  it('a side-by-side airborne wood pair falls', () => {
    const e = withSoil(20, 20, 2);
    e.setMaterial(9, 5, MaterialType.WOOD);
    e.setMaterial(10, 5, MaterialType.WOOD);
    for (let i = 0; i < 200; i++) e.update();
    expect(rowsWith(e, 20, 20, MaterialType.WOOD)).toEqual([17]);
  });

  // The load-bearing distinction: sand is not a *span* but it is ground. Get
  // this wrong and every tree in the game collapses the frame it sprouts.
  it('wood resting on sand is anchored', () => {
    const e = withSoil(20, 20, 4);
    for (let y = 10; y <= 15; y++) e.setMaterial(10, y, MaterialType.WOOD);
    for (let i = 0; i < 200; i++) e.update();
    expect(rowsWith(e, 20, 20, MaterialType.WOOD)).toEqual([10, 11, 12, 13, 14, 15]);
  });

  it('a column standing on rock is anchored', () => {
    const e = flat(20, 20);
    for (let x = 0; x < 20; x++) e.setMaterial(x, 19, MaterialType.ROCK);
    for (let y = 12; y <= 18; y++) e.setMaterial(10, y, MaterialType.WOOD);
    for (let i = 0; i < 200; i++) e.update();
    expect(rowsWith(e, 20, 20, MaterialType.WOOD)).toEqual([12, 13, 14, 15, 16, 17, 18]);
  });

  // Support is reachability, not adjacency: a cantilever is held by the span it
  // is attached to, however many cells away the ground is.
  it('a cantilevered span is anchored through the structure it hangs off', () => {
    const e = flat(24, 24);
    for (let x = 0; x < 24; x++) e.setMaterial(x, 23, MaterialType.ROCK);
    for (let y = 14; y <= 22; y++) e.setMaterial(4, y, MaterialType.WOOD);   // mast
    for (let x = 5; x <= 16; x++) e.setMaterial(x, 14, MaterialType.WOOD);   // arm
    for (let i = 0; i < 200; i++) e.update();
    expect(count(e, MaterialType.WOOD)).toBe(21);
    expect(e.getMaterial(16, 14)).toBe(MaterialType.WOOD);
  });

  // ...and the same structure with its footing removed must come down, which
  // the one-hop rule could never do. This is the "burnt trunk" story.
  it('cutting the footing drops the whole span', () => {
    const e = flat(24, 24);
    for (let x = 0; x < 24; x++) e.setMaterial(x, 23, MaterialType.ROCK);
    for (let y = 14; y <= 22; y++) e.setMaterial(4, y, MaterialType.WOOD);
    for (let x = 5; x <= 16; x++) e.setMaterial(x, 14, MaterialType.WOOD);
    for (let i = 0; i < 60; i++) e.update();
    expect(e.getMaterial(4, 22)).toBe(MaterialType.WOOD);

    e.setMaterial(4, 22, MaterialType.EMPTY);      // knock out the base
    for (let i = 0; i < 300; i++) e.update();

    // Everything ends up resting on the rock floor rather than in mid-air.
    const rows = rowsWith(e, 24, 24, MaterialType.WOOD);
    expect(rows.every((y) => y >= 14)).toBe(true);
    expect(e.getMaterial(16, 14)).not.toBe(MaterialType.WOOD);
  });

  // Foliage is static so a crown can exist at all, but it must not double as
  // ground — or the circularity returns one material along.
  it('leaves do not anchor a trunk', () => {
    const e = withSoil(20, 20, 2);
    e.setMaterial(10, 5, MaterialType.WOOD);
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      e.setMaterial(10 + dx, 5 + dy, MaterialType.LEAF);
    }
    for (let i = 0; i < 200; i++) e.update();
    expect(e.getMaterial(10, 5)).not.toBe(MaterialType.WOOD);
  });

  // Grass keeps the default: its spread rule sets needsFooting, so a grass cell
  // only exists where there is already soil under it.
  it('grass anchors — a sapling rooted in a lawn stands', () => {
    const e = withSoil(20, 20, 4);
    for (let x = 0; x < 20; x++) e.setMaterial(x, 15, MaterialType.GRASS);
    for (let y = 11; y <= 14; y++) e.setMaterial(10, y, MaterialType.WOOD);
    for (let i = 0; i < 200; i++) e.update();
    expect(rowsWith(e, 20, 20, MaterialType.WOOD)).toEqual([11, 12, 13, 14]);
  });

  it('the grid edge counts as bedrock', () => {
    const e = flat(20, 20);
    for (let y = 16; y <= 19; y++) e.setMaterial(0, y, MaterialType.WOOD);
    for (let i = 0; i < 200; i++) e.update();
    expect(rowsWith(e, 20, 20, MaterialType.WOOD)).toEqual([16, 17, 18, 19]);
  });

  // isAnchored is public, so pin the contract directly too.
  it('isAnchored reports the same verdict the movement core acts on', () => {
    const e = withSoil(20, 20, 2);
    e.setMaterial(10, 17, MaterialType.WOOD);         // on the soil
    e.setMaterial(10, 5, MaterialType.WOOD);          // in the air
    e.setMaterial(10, 6, MaterialType.WOOD);
    expect(e.isAnchored(10, 17)).toBe(true);
    expect(e.isAnchored(10, 5)).toBe(false);
    expect(e.isAnchored(10, 6)).toBe(false);
  });

  // The memo is keyed on an epoch bumped by structural writes; a stale verdict
  // would leave a cut structure hanging. Same query, both sides of the cut.
  it('the support memo invalidates when the structure changes', () => {
    const e = flat(20, 20);
    for (let x = 0; x < 20; x++) e.setMaterial(x, 19, MaterialType.ROCK);
    for (let y = 15; y <= 18; y++) e.setMaterial(10, y, MaterialType.WOOD);
    expect(e.isAnchored(10, 15)).toBe(true);
    e.setMaterial(10, 18, MaterialType.EMPTY);
    expect(e.isAnchored(10, 15)).toBe(false);
  });
});

describe('rooted tips', () => {
  it('plant() refuses a tree tip in open sky and writes nothing', () => {
    const e = withSoil(30, 30, 3);
    const ok = e.plant(15, 8, MaterialType.TREE_TIP, { energy: 18, dir: 0 });
    expect(ok).toBe(false);
    expect(e.getMaterial(15, 8)).toBe(MaterialType.EMPTY);

    for (let i = 0; i < 400; i++) e.update();
    expect(count(e, MaterialType.WOOD)).toBe(0);
    expect(count(e, MaterialType.LEAF)).toBe(0);
    expect(count(e, MaterialType.TREE_TIP)).toBe(0);
  });

  it('plant() accepts a tree tip standing on soil', () => {
    const e = withSoil(30, 30, 3);
    const ok = e.plant(15, 26, MaterialType.TREE_TIP, { energy: 18, dir: 0 });
    expect(ok).toBe(true);
    for (let i = 0; i < 400; i++) e.update();
    expect(count(e, MaterialType.WOOD)).toBeGreaterThan(5);
    expect(count(e, MaterialType.LEAF)).toBeGreaterThan(5);
  });

  // The regression in its original shape: the god-game brush scattered tips
  // across the cursor disc, and every one that landed above the surface grew a
  // tree hanging in the sky beside the planet.
  it('a brush scattering tips above the surface grows nothing airborne', () => {
    const e = withSoil(40, 40, 4);
    let planted = 0;
    for (let y = 10; y <= 20; y++) {
      for (let x = 15; x <= 25; x++) {
        if (e.plant(x, y, MaterialType.TREE_TIP, { energy: 16, dir: 0 })) planted++;
      }
    }
    expect(planted).toBe(0);
    for (let i = 0; i < 400; i++) e.update();
    expect(count(e, MaterialType.WOOD)).toBe(0);
  });

  // Rootedness is decided at establishment, not per advance — or every limb
  // that runs level or downward would be pruned and a tree would be a stick.
  it('a rooted tree still branches out over open space', () => {
    const e = withSoil(40, 40, 4, 7);
    expect(e.plant(20, 35, MaterialType.TREE_TIP, { energy: 24, dir: 0 })).toBe(true);
    for (let i = 0; i < 600; i++) e.update();
    // A crown is wider than the trunk: limbs reached cells with nothing below.
    let minX = 99, maxX = -1;
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        const m = e.grid[y * 40 + x];
        if (m === MaterialType.WOOD || m === MaterialType.LEAF) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    expect(maxX - minX).toBeGreaterThan(3);
  });

  // Seeds were always safe — they fall and germinate on contact — and must stay
  // that way, since scattering SEED is the shape hosts are told to use.
  it('the SEED path still grows a tree without any rooting check by the host', () => {
    const e = withSoil(30, 30, 4, 11);
    for (let x = 12; x <= 18; x++) e.setMaterial(x, 10, MaterialType.SEED);
    for (let i = 0; i < 900; i++) e.update();
    expect(count(e, MaterialType.WOOD)).toBeGreaterThan(3);
  });

  it('rooting is gravity-relative — a tip on a planet surface roots outward', () => {
    const size = 80;
    const cx = 40, cy = 40, r = 24;
    const e = new PixelEngine({
      width: size, height: size, seed: 3,
      gravity: new RadialGravity({ centerX: cx, centerY: cy }),
    });
    e.beginBulk();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r * r) e.setMaterial(x, y, MaterialType.SAND);
      }
    }
    e.endBulk();

    // Just outside the disc on the +x axis: ground is inward, so this roots.
    expect(e.plant(cx + r, cy, MaterialType.TREE_TIP, { energy: 14, dir: 0 })).toBe(true);
    // Well clear of the surface on the -x axis: open space below, refused.
    expect(e.plant(cx - r - 12, cy, MaterialType.TREE_TIP, { energy: 14, dir: 0 })).toBe(false);
    expect(e.getMaterial(cx - r - 12, cy)).toBe(MaterialType.EMPTY);
  });
});
