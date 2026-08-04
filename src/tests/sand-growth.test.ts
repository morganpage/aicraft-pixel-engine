import { describe, it, expect } from 'vitest';
import { PixelEngine, octantOffset, packGrowth, unpackGrowth } from '../sand';
import { MaterialType, isImmobile, needsSupport, hasGrowth } from '../materials';
import { FlatGravity, RadialGravity } from '../gravity';
import { neighborFrame } from '../sand/neighbors.js';

function flat(w: number, h: number, seed = 42): PixelEngine {
  return new PixelEngine({ width: w, height: h, seed, gravity: new FlatGravity() });
}

/** A world with a rock floor along the bottom row. */
function withFloor(w: number, h: number, seed = 42): PixelEngine {
  const e = flat(w, h, seed);
  for (let x = 0; x < w; x++) e.setMaterial(x, h - 1, MaterialType.ROCK);
  return e;
}

function count(e: PixelEngine, mat: MaterialType): number {
  let n = 0;
  for (let i = 0; i < e.grid.length; i++) if (e.grid[i] === mat) n++;
  return n;
}

/** Bounding box of every cell holding one of `mats`, or null if there are none. */
function bounds(e: PixelEngine, mats: MaterialType[]) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, n = 0;
  for (let y = 0; y < e.height; y++) {
    for (let x = 0; x < e.width; x++) {
      if (!mats.includes(e.getMaterial(x, y))) continue;
      n++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return n === 0 ? null : { minX, maxX, minY, maxY, n, w: maxX - minX + 1, h: maxY - minY + 1 };
}

const TREE_PARTS = [MaterialType.WOOD, MaterialType.LEAF, MaterialType.TREE_TIP];

describe('growth: backward compatibility', () => {
  // The load-bearing guarantee. The RNG is one shared stream, so a single extra
  // draw anywhere shifts every subsequent roll in the frame. If the growth pass
  // touched `random()` in a world with nothing alive in it, changing the growth
  // interval would change the whole simulation.
  it('a world with no growing materials is untouched by the growth pass', () => {
    const build = (interval: number) => {
      const e = new PixelEngine({
        width: 24, height: 24, seed: 99, gravity: new FlatGravity(), growthInterval: interval,
      });
      for (let x = 0; x < 24; x++) e.setMaterial(x, 23, MaterialType.WALL);
      for (let x = 4; x < 20; x++) {
        e.setMaterial(x, 2, MaterialType.SAND);
        e.setMaterial(x, 4, MaterialType.WATER);
      }
      e.setMaterial(12, 8, MaterialType.LAVA);
      for (let i = 0; i < 120; i++) e.update();
      return e;
    };
    const a = build(1);
    const b = build(97);
    expect(Array.from(a.grid)).toEqual(Array.from(b.grid));
    expect(a.growthCells.size).toBe(0);
    // Never allocated, so a host that grows nothing pays nothing.
    expect(a.growthGrid).toBeNull();
  });

  // `isStatic`/`needsSupport` replaced two hardcoded id lists in the movement
  // core. Data and behaviour must not drift apart.
  it('the static and support flags match what the movement core does', () => {
    expect(isImmobile[MaterialType.WALL]).toBe(true);
    expect(isImmobile[MaterialType.ROCK]).toBe(true);
    expect(isImmobile[MaterialType.ICE]).toBe(true);
    expect(isImmobile[MaterialType.WOOD]).toBe(false);
    expect(isImmobile[MaterialType.SAND]).toBe(false);
    expect(needsSupport[MaterialType.WOOD]).toBe(true);
    expect(needsSupport[MaterialType.ROCK]).toBe(false);
    // LEAF is static rather than supported — see the note on the material.
    expect(isImmobile[MaterialType.LEAF]).toBe(true);
    expect(needsSupport[MaterialType.LEAF]).toBe(false);
  });

  // The support test is cardinal-only, and always has been. A refactor that
  // quietly started counting diagonals would make every structure stickier.
  it('a diagonally-braced wood cell still falls', () => {
    const e = withFloor(7, 7);
    e.setMaterial(2, 5, MaterialType.ROCK);
    e.setMaterial(3, 4, MaterialType.WOOD); // diagonal from the rock only
    e.update();
    expect(e.getMaterial(3, 4)).not.toBe(MaterialType.WOOD);

    const f = withFloor(7, 7);
    f.setMaterial(2, 5, MaterialType.ROCK);
    f.setMaterial(2, 4, MaterialType.WOOD); // cardinally on top of the rock
    f.update();
    expect(f.getMaterial(2, 4)).toBe(MaterialType.WOOD);
  });

  // Leaves hold their position. `needsSupport` was tried and cannot work: it is
  // satisfied only by structural cells, and LEAF must not be one — so a leaf
  // could survive only cardinally adjacent to wood, which allows a one-cell
  // fringe along a branch and makes a canopy impossible. An 11-energy tree grew
  // as a bare stick with a few green specks.
  it('leaves stay where they are put', () => {
    const e = withFloor(7, 8);
    e.setMaterial(3, 4, MaterialType.LEAF);
    e.setMaterial(3, 3, MaterialType.LEAF);
    for (let i = 0; i < 10; i++) e.update();
    expect(e.getMaterial(3, 4)).toBe(MaterialType.LEAF);
    expect(e.getMaterial(3, 3)).toBe(MaterialType.LEAF);
  });
});

describe('growth: gravity-relative octants', () => {
  // A heading is stored as an octant, so it only means anything if the eight
  // octants are the whole 8-neighbourhood however gravity is pointed. A
  // four-direction subset would silently mean different things at different
  // angles.
  it('the eight octants are a rotation of the full 8-neighbourhood', () => {
    const models = [
      new FlatGravity(),
      new RadialGravity({ centerX: 40, centerY: 40 }),
    ];
    const probes: [number, number][] = [[10, 10], [70, 12], [12, 70], [55, 55], [41, 40]];
    for (const model of models) {
      for (const [px, py] of probes) {
        const frame = neighborFrame(px, py, model);
        const seen = new Set<string>();
        const out = { dx: 0, dy: 0 };
        for (let o = 0; o < 8; o++) {
          octantOffset(frame, o, out);
          expect(Math.abs(out.dx)).toBeLessThanOrEqual(1);
          expect(Math.abs(out.dy)).toBeLessThanOrEqual(1);
          expect(out.dx === 0 && out.dy === 0).toBe(false);
          seen.add(`${out.dx},${out.dy}`);
        }
        expect(seen.size).toBe(8);
      }
    }
  });

  it('octant 0 is directly away from gravity, and 4 is toward it', () => {
    const frame = neighborFrame(5, 5, new FlatGravity());
    const out = { dx: 0, dy: 0 };
    octantOffset(frame, 0, out);
    expect(out).toEqual({ dx: 0, dy: -1 });
    octantOffset(frame, 4, out);
    expect(out).toEqual({ dx: 0, dy: 1 });
  });

  it('negative and out-of-range octants wrap', () => {
    const frame = neighborFrame(5, 5, new FlatGravity());
    const a = { dx: 0, dy: 0 };
    const b = { dx: 0, dy: 0 };
    octantOffset(frame, -1, a);
    octantOffset(frame, 7, b);
    expect(a).toEqual(b);
    octantOffset(frame, 8, a);
    octantOffset(frame, 0, b);
    expect(a).toEqual(b);
  });
});

describe('growth: the state word', () => {
  it('round-trips every field at its maximum', () => {
    const w = packGrowth(127, 7, 3, 15);
    expect(unpackGrowth(w)).toEqual({ energy: 127, dir: 7, gen: 3, variant: 15 });
    expect(unpackGrowth(packGrowth(26, 0, 0, 9))).toEqual({
      energy: 26, dir: 0, gen: 0, variant: 9,
    });
  });

  // 7 bits of energy, not 6: at the documented 15 cells/second a 63-cell cap
  // puts a maximum tree at ~4 seconds with no headroom to tune taller.
  it('energy holds more than a six-bit budget', () => {
    expect(unpackGrowth(packGrowth(100, 2, 1, 4)).energy).toBe(100);
  });
});

describe('growth: spreading', () => {
  /** Sand shelf with a two-cell pond, and one grass cell beside it. */
  function meadow(seed = 5) {
    const e = flat(34, 10, seed);
    for (let x = 0; x < 34; x++) {
      e.setMaterial(x, 9, MaterialType.ROCK);
      e.setMaterial(x, 8, MaterialType.SAND);
    }
    e.setMaterial(16, 7, MaterialType.WATER);
    e.setMaterial(17, 7, MaterialType.WATER);
    e.setMaterial(15, 7, MaterialType.GRASS);
    return e;
  }

  it('grass spreads from water and stops at the edge of its reach', () => {
    const e = meadow();
    for (let i = 0; i < 3000; i++) e.update();
    const g = count(e, MaterialType.GRASS);
    expect(g).toBeGreaterThan(4);
    // `range: 6` bounds the meadow; without it grass would cover the shelf.
    expect(g).toBeLessThan(20);
  });

  it('grass with no water in reach never spreads', () => {
    const e = flat(20, 10);
    for (let x = 0; x < 20; x++) {
      e.setMaterial(x, 9, MaterialType.ROCK);
      e.setMaterial(x, 8, MaterialType.SAND);
    }
    e.setMaterial(10, 7, MaterialType.GRASS);
    for (let i = 0; i < 600; i++) e.update();
    expect(count(e, MaterialType.GRASS)).toBe(1);
  });

  // Ground cover has to stay on the ground. Allowed to spread upward at all and
  // given nothing to stand on, grass built a tangle several cells clear of the
  // soil; `needsFooting` is what keeps a lawn a single terrain-following layer.
  it('grass stays one layer thick', () => {
    const e = meadow();
    for (let i = 0; i < 3000; i++) e.update();
    for (let x = 0; x < e.width; x++) {
      let stacked = 0;
      for (let y = 0; y < e.height; y++) {
        if (e.getMaterial(x, y) === MaterialType.GRASS) stacked++;
      }
      expect(stacked).toBeLessThanOrEqual(1);
    }
  });

  // Backoff dormancy: a patch that has run out of room must stop emitting
  // growth events, or a turn-based host waiting on `beginSettle` never resumes.
  it('a saturated meadow goes quiet', () => {
    const e = meadow();
    for (let i = 0; i < 4000; i++) e.update();
    let events = 0;
    for (let i = 0; i < 200; i++) {
      e.update();
      events += e.growthEventsLastFrame;
    }
    expect(events).toBe(0);
    expect(e.swapsLastFrame).toBe(0);
  });

  it('a settled meadow reports settled', () => {
    const e = meadow();
    for (let i = 0; i < 4000; i++) e.update();
    e.beginSettle();
    for (let i = 0; i < 200 && !e.isSettled; i++) e.update();
    expect(e.isSettled).toBe(true);
    expect(e.settleTimedOut).toBe(false);
  });

  // The pass deliberately does not consult `activeChunks`. Growth is
  // spontaneous — nothing wakes it — so a world that has gone to sleep must
  // still grow, which is the whole "walk away and come back to a forest" case.
  it('growth runs in sleeping chunks', () => {
    const e = meadow();
    for (let i = 0; i < 40; i++) e.update();
    const before = count(e, MaterialType.GRASS);

    // Force every chunk asleep, the state a long-settled world reaches.
    e.activeChunks.fill(0);
    e.nextActiveChunks.fill(0);
    for (let i = 0; i < 400; i++) {
      e.activeChunks.fill(0);
      e.update();
    }
    expect(count(e, MaterialType.GRASS)).toBeGreaterThan(before);
  });
});

describe('growth: directed tips', () => {
  function tree(seed: number, energy = 22, w = 40, h = 28) {
    const e = withFloor(w, h, seed);
    e.plant(Math.floor(w / 2), h - 2, MaterialType.TREE_TIP, { energy, dir: 0 });
    for (let i = 0; i < 500; i++) e.update();
    return e;
  }

  // The pin that isotropic spreading can never satisfy, and the reason tips
  // exist at all: a tree is a narrow stem carrying a wide crown. A blob has no
  // such structure at any tuning, however green it is.
  //
  // Stated as stem-versus-crown rather than "taller than wide", which stopped
  // being the right test once the canopy filled out: a healthy small tree is
  // roughly as broad as it is tall, and it is still obviously a tree.
  it('a tree is a stem carrying a crown', () => {
    for (const seed of [7, 23, 101]) {
      const e = tree(seed);
      const b = bounds(e, TREE_PARTS)!;
      expect(b.h).toBeGreaterThan(8);

      const widthAt = (y: number) => {
        let n = 0;
        for (let x = 0; x < e.width; x++) if (TREE_PARTS.includes(e.getMaterial(x, y))) n++;
        return n;
      };
      let stem = 0, crown = 0;
      const mid = Math.floor((b.minY + b.maxY) / 2);
      for (let y = b.minY; y <= mid; y++) crown += widthAt(y);
      for (let y = mid + 1; y <= b.maxY; y++) stem += widthAt(y);
      expect(crown).toBeGreaterThan(stem);
      // And the very bottom is a bole, not a skirt of foliage.
      expect(widthAt(b.maxY)).toBeLessThanOrEqual(3);
    }
  });

  it('energy bounds the height', () => {
    const short = bounds(tree(7, 8), TREE_PARTS)!;
    const tall = bounds(tree(7, 24), TREE_PARTS)!;
    expect(tall.h).toBeGreaterThan(short.h);
    expect(short.h).toBeLessThanOrEqual(8 + 2);
  });

  // Tips are the only self-limiting element in the design. If one could persist
  // the world would fill; every plant must resolve to structure and stop.
  it('every tip dies', () => {
    const e = tree(23);
    expect(count(e, MaterialType.TREE_TIP)).toBe(0);
    for (const idx of e.growthCells) {
      expect(hasGrowth[e.grid[idx]]).toBe(true);
      expect(e.grid[idx]).not.toBe(MaterialType.TREE_TIP);
    }
    expect(e.growthEventsLastFrame).toBe(0);
  });

  it('a tip with nowhere to go terminates instead of stalling', () => {
    const e = withFloor(9, 9);
    // Box the tip in on all sides.
    for (let x = 2; x <= 6; x++) e.setMaterial(x, 5, MaterialType.WALL);
    for (let y = 5; y <= 7; y++) {
      e.setMaterial(2, y, MaterialType.WALL);
      e.setMaterial(6, y, MaterialType.WALL);
    }
    for (let x = 3; x <= 5; x++) e.setMaterial(x, 7, MaterialType.WALL);
    e.setMaterial(3, 6, MaterialType.WALL);
    e.setMaterial(5, 6, MaterialType.WALL);
    e.plant(4, 6, MaterialType.TREE_TIP, { energy: 20, dir: 0 });
    for (let i = 0; i < 40; i++) e.update();
    expect(e.getMaterial(4, 6)).toBe(MaterialType.LEAF);
    expect(count(e, MaterialType.TREE_TIP)).toBe(0);
  });

  // A diagonal chain touches only at the corners, and the support test is
  // cardinal-only — so unbraced 45° limbs collapsed as fast as they were drawn,
  // leaving a bare trunk and a litter of debris on the floor.
  it('diagonal limbs stay up', () => {
    const e = tree(23, 24);
    let dangling = 0;
    for (let y = 0; y < e.height; y++) {
      for (let x = 0; x < e.width; x++) {
        if (e.getMaterial(x, y) !== MaterialType.WOOD) continue;
        const held =
          e.isStructural(x, y - 1) || e.isStructural(x, y + 1) ||
          e.isStructural(x - 1, y) || e.isStructural(x + 1, y);
        if (!held) dangling++;
      }
    }
    expect(dangling).toBe(0);
  });

  it('branch depth and taper are bounded by the rule', () => {
    const e = withFloor(40, 30, 5);
    e.plant(20, 28, MaterialType.TREE_TIP, { energy: 26, dir: 0 });
    let maxGen = 0;
    for (let i = 0; i < 200; i++) {
      e.update();
      for (let y = 0; y < e.height; y++) {
        for (let x = 0; x < e.width; x++) {
          if (e.getMaterial(x, y) !== MaterialType.TREE_TIP) continue;
          const s = e.getGrowthState(x, y)!;
          if (s.gen > maxGen) maxGen = s.gen;
          expect(s.gen).toBeLessThanOrEqual(3);
          expect(s.energy).toBeLessThanOrEqual(26);
        }
      }
    }
    expect(maxGen).toBeGreaterThan(0);
  });

  // `branchEvery` versus `branchChance` is the whole difference between the two
  // silhouettes: a frond's pinnae are regularly spaced and paired, a tree's
  // limbs are neither.
  it('a fern is a symmetric tapering frond, a tree is not', () => {
    const f = withFloor(30, 22, 3);
    f.plant(15, 20, MaterialType.FERN_TIP, { energy: 16, dir: 0 });
    for (let i = 0; i < 500; i++) f.update();

    // The rachis is wherever the frond is densest, not wherever it was planted:
    // a small wobble moves the stem a cell or two off the planting column.
    const perColumn: number[] = new Array(f.width).fill(0);
    for (let y = 0; y < f.height - 1; y++) {
      for (let x = 0; x < f.width; x++) {
        if (f.getMaterial(x, y) === MaterialType.FROND) perColumn[x]++;
      }
    }
    const rachis = perColumn.indexOf(Math.max(...perColumn));
    let left = 0, right = 0;
    for (let y = 0; y < f.height - 1; y++) {
      for (let x = 0; x < f.width; x++) {
        if (f.getMaterial(x, y) !== MaterialType.FROND) continue;
        if (x < rachis) left++;
        else if (x > rachis) right++;
      }
    }
    // Paired pinnae fire on both turns at once, so the frond is balanced.
    expect(left).toBeGreaterThan(3);
    expect(right).toBeGreaterThan(3);
    expect(Math.abs(left - right) / (left + right)).toBeLessThan(0.35);

    // And it tapers: taper is applied to the rachis' *remaining* energy, so
    // pinnae get shorter the further up the stem they fork.
    const b = bounds(f, [MaterialType.FROND])!;
    const widthAt = (y: number) => {
      let n = 0;
      for (let x = 0; x < f.width; x++) if (f.getMaterial(x, y) === MaterialType.FROND) n++;
      return n;
    };
    let topHalf = 0, bottomHalf = 0;
    const mid = Math.floor((b.minY + b.maxY) / 2);
    for (let y = b.minY; y <= mid; y++) topHalf += widthAt(y);
    for (let y = mid + 1; y <= b.maxY; y++) bottomHalf += widthAt(y);
    expect(bottomHalf).toBeGreaterThan(topHalf);
  });

  // The genome. Same variant must reproduce the same plant; different variants
  // must not, or a forest looks stamped from one mould.
  it('variant is a reproducible genome', () => {
    const grow = (variant: number) => {
      const e = withFloor(40, 28, 12);
      e.plant(20, 26, MaterialType.TREE_TIP, { energy: 22, dir: 0, variant });
      for (let i = 0; i < 400; i++) e.update();
      return Array.from(e.grid);
    };
    expect(grow(1)).toEqual(grow(1));
    expect(grow(1)).not.toEqual(grow(2));
  });

  // The payoff for storing headings as gravity-relative octants: a tree planted
  // anywhere on a planet grows away from the core with no special-casing.
  it('a tree on a planet grows radially outward', () => {
    const cx = 45, cy = 45, r = 22;
    for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const e = new PixelEngine({
        width: 90, height: 90, seed: 31,
        gravity: new RadialGravity({ centerX: cx, centerY: cy }),
      });
      for (let y = 0; y < 90; y++) {
        for (let x = 0; x < 90; x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d <= r) e.setMaterial(x, y, MaterialType.ROCK);
        }
      }
      const px = Math.round(cx + Math.cos(angle) * (r + 1));
      const py = Math.round(cy + Math.sin(angle) * (r + 1));
      e.plant(px, py, MaterialType.TREE_TIP, { energy: 14, dir: 0 });
      for (let i = 0; i < 300; i++) e.update();

      const b = bounds(e, TREE_PARTS)!;
      // Centre of mass of the new growth must be further from the core than the
      // planting site, in the direction it was planted.
      let sx = 0, sy = 0, n = 0;
      for (let y = b.minY; y <= b.maxY; y++) {
        for (let x = b.minX; x <= b.maxX; x++) {
          if (!TREE_PARTS.includes(e.getMaterial(x, y))) continue;
          sx += x; sy += y; n++;
        }
      }
      expect(n).toBeGreaterThan(4);
      const outward = Math.hypot(sx / n - cx, sy / n - cy);
      expect(outward).toBeGreaterThan(r);
    }
  });
});

describe('growth: contact aggregation', () => {
  it('a seed germinates on soil and stays inert in the air', () => {
    const e = withFloor(12, 12);
    for (let x = 0; x < 12; x++) e.setMaterial(x, 10, MaterialType.SAND);
    e.setMaterial(6, 9, MaterialType.SEED);
    for (let i = 0; i < 200; i++) e.update();
    expect(count(e, MaterialType.SEED)).toBe(0);
    // A terminal canopy alone is not a tree. This must produce an actual trunk.
    expect(count(e, MaterialType.WOOD)).toBeGreaterThan(2);
    expect(count(e, MaterialType.LEAF)).toBeGreaterThan(0);

    // Nothing to root in: the seed falls and waits.
    const f = flat(12, 12);
    for (let x = 0; x < 12; x++) f.setMaterial(x, 11, MaterialType.WALL);
    f.setMaterial(6, 2, MaterialType.SEED);
    for (let i = 0; i < 200; i++) f.update();
    expect(count(f, MaterialType.SEED)).toBe(1);
    expect(count(f, MaterialType.WOOD)).toBe(0);
  });

  // This is the live-showcase interaction reduced to a deterministic test: a
  // radius-three sand brush lands on the top of a radial planet, followed by a
  // radius-one seed brush. A seed denser than sand sinks into that mound and
  // germinates boxed in, yielding only a tiny terminal leaf stamp. It has to
  // rest on the soil for the tip to find open space and build a trunk.
  it('a seed brush grows trunks from a soil mound on a planet', () => {
    const cx = 45, cy = 45, r = 22;
    const e = new PixelEngine({
      width: 90, height: 90, seed: 1,
      gravity: new RadialGravity({ centerX: cx, centerY: cy }),
    });
    for (let y = 0; y < e.height; y++) {
      for (let x = 0; x < e.width; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
          e.setMaterial(x, y, MaterialType.ROCK);
        }
      }
    }

    const stamp = (sx: number, sy: number, radius: number, mat: MaterialType) => {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy <= radius * radius) {
            e.setMaterial(sx + dx, sy + dy, mat);
          }
        }
      }
    };
    stamp(cx, 14, 3, MaterialType.SAND);
    for (let i = 0; i < 120; i++) e.update();
    stamp(cx, 20, 1, MaterialType.SEED);
    for (let i = 0; i < 300; i++) e.update();

    expect(count(e, MaterialType.WOOD)).toBeGreaterThan(3);
    expect(count(e, MaterialType.TREE_TIP)).toBe(0);
  });

  // Not DLA, and the test says so on purpose. The walkers are a rising gas, so
  // they arrive from below and the cluster accretes downward from whatever it
  // first caught on. A perimeter-to-area threshold would pass on a combed clump
  // too and let the claim of dendritic growth stand unchallenged.
  it('spores accrete on the underside of what they hit', () => {
    const e = flat(24, 24, 8);
    for (let x = 0; x < 24; x++) e.setMaterial(x, 0, MaterialType.ROCK);
    for (let i = 0; i < 400; i++) {
      if (i % 4 === 0) e.setMaterial(10 + (i % 5), 22, MaterialType.SPORE);
      e.update();
    }
    const b = bounds(e, [MaterialType.CORAL]);
    expect(b).not.toBeNull();
    // It hangs from the ceiling it caught on rather than piling on the floor.
    expect(b!.minY).toBeLessThan(4);
  });
});

describe('growth: composition with the existing reactions', () => {
  it('fire burns grass', () => {
    const e = flat(12, 8);
    for (let x = 0; x < 12; x++) {
      e.setMaterial(x, 7, MaterialType.ROCK);
      e.setMaterial(x, 6, MaterialType.SAND);
      // Fire is a gas and rises out of reach in a frame; a lid keeps it against
      // the grass long enough to be a test of ignition rather than of buoyancy.
      e.setMaterial(x, 4, MaterialType.WALL);
    }
    for (let x = 3; x <= 9; x++) e.setMaterial(x, 5, MaterialType.GRASS);
    const before = count(e, MaterialType.GRASS);
    e.setMaterial(3, 5, MaterialType.FIRE);
    for (let i = 0; i < 200; i++) e.update();
    expect(count(e, MaterialType.GRASS)).toBeLessThan(before - 1);
  });

  // Foliage is the most flammable thing in the table, so fire is what clears a
  // canopy. This is the composition that replaced the collapse-on-burn story:
  // a crown that cannot exist is worse than a crown that cannot fall.
  it('fire consumes a canopy', () => {
    const e = withFloor(16, 14, 3);
    for (let y = 6; y <= 12; y++) e.setMaterial(7, y, MaterialType.WOOD);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        e.setMaterial(7 + dx, 6 + dy, MaterialType.LEAF);
      }
    }
    const before = count(e, MaterialType.LEAF);
    expect(before).toBeGreaterThan(10);
    e.setMaterial(7, 3, MaterialType.FIRE);
    e.setMaterial(6, 3, MaterialType.FIRE);
    for (let i = 0; i < 400; i++) e.update();
    expect(count(e, MaterialType.LEAF)).toBeLessThan(before / 2);
  });

  it('acid dissolves grown wood as readily as placed wood', () => {
    const e = withFloor(16, 20, 4);
    e.plant(8, 18, MaterialType.TREE_TIP, { energy: 12, dir: 0 });
    for (let i = 0; i < 300; i++) e.update();
    const before = count(e, MaterialType.WOOD);
    expect(before).toBeGreaterThan(3);
    // Placed directly against the trunk rather than rained onto the crown:
    // acid eats WOOD/ROCK/SAND/WALL and has no rule for LEAF, so a canopy holds
    // it up indefinitely. Worth knowing, but not what this test is about.
    // Sat directly on top of grown wood, and both halves of that matter.
    // `stepAcid` checks its downward neighbour first, so acid resting on the
    // floor eats the floor before it ever tries the trunk beside it; and acid
    // dropped into the crown just pools on the foliage, being lighter than LEAF
    // with no rule for dissolving it.
    let placed = 0;
    for (let y = 0; y < e.height && placed < 3; y++) {
      for (let x = 0; x < e.width && placed < 3; x++) {
        if (e.getMaterial(x, y) !== MaterialType.WOOD) continue;
        if (e.getMaterial(x, y - 1) === MaterialType.WOOD) continue;
        e.setMaterial(x, y - 1, MaterialType.ACID);
        placed++;
      }
    }
    expect(placed).toBeGreaterThan(0);
    for (let i = 0; i < 400; i++) e.update();
    expect(count(e, MaterialType.WOOD)).toBeLessThan(before);
  });
});

describe('growth: system properties', () => {
  it('is deterministic for the same seed and calls', () => {
    const run = () => {
      const e = withFloor(36, 24, 77);
      for (let x = 0; x < 36; x++) e.setMaterial(x, 22, MaterialType.SAND);
      e.setMaterial(20, 21, MaterialType.WATER);
      e.setMaterial(19, 21, MaterialType.GRASS);
      e.plant(8, 22, MaterialType.TREE_TIP, { energy: 18, dir: 0 });
      for (let i = 0; i < 400; i++) e.update();
      return { grid: Array.from(e.grid), growth: Array.from(e.growthGrid!) };
    };
    expect(run()).toEqual(run());
  });

  // Membership is a pure function of the grid, never of history. That is what
  // makes a world reloaded from a saved grid grow like the one that was saved.
  it('the candidate set is recoverable from the grid alone', () => {
    const e = withFloor(36, 24, 5);
    for (let x = 0; x < 36; x++) e.setMaterial(x, 22, MaterialType.SAND);
    e.setMaterial(20, 21, MaterialType.WATER);
    e.setMaterial(19, 21, MaterialType.GRASS);
    e.plant(8, 22, MaterialType.TREE_TIP, { energy: 18, dir: 0 });
    for (let i = 0; i < 200; i++) e.update();

    // Superset invariant: nothing that can grow is missing from the set.
    for (let i = 0; i < e.grid.length; i++) {
      if (hasGrowth[e.grid[i]]) expect(e.growthCells.has(i)).toBe(true);
    }
    const observed = Array.from(e.growthCells).sort((a, b) => a - b);
    e.rebuildGrowthCells();
    const rebuilt = Array.from(e.growthCells).sort((a, b) => a - b);
    // A growth tick prunes stale entries, so after one the two agree exactly.
    expect(rebuilt).toEqual(observed);
  });

  // The pass iterates a snapshot sorted by cell index rather than by `Set`
  // insertion order, so the order cells were *placed* in cannot leak into how
  // they grow. That is what lets a world rebuilt from a saved grid — where the
  // original insertion order is long gone — behave like the one that was saved.
  it('growth does not depend on the order cells were placed in', () => {
    const build = (order: number[]) => {
      const e = withFloor(30, 14, 61);
      for (let x = 0; x < 30; x++) e.setMaterial(x, 12, MaterialType.SAND);
      e.setMaterial(15, 11, MaterialType.WATER);
      for (const x of order) e.setMaterial(x, 11, MaterialType.GRASS);
      for (let i = 0; i < 300; i++) e.update();
      return Array.from(e.grid);
    };
    const ascending = build([10, 11, 12, 13, 14]);
    const descending = build([14, 13, 12, 11, 10]);
    const shuffled = build([12, 14, 10, 13, 11]);
    expect(descending).toEqual(ascending);
    expect(shuffled).toEqual(ascending);
  });

  it('growth counts as activity for settle detection', () => {
    const e = withFloor(30, 20, 9);
    e.plant(15, 18, MaterialType.TREE_TIP, { energy: 24, dir: 0 });
    e.update();
    e.beginSettle();
    let sawGrowth = false;
    for (let i = 0; i < 40; i++) {
      e.update();
      if (e.growthEventsLastFrame > 0) {
        sawGrowth = true;
        // Growing is not settled, even when nothing is moving.
        expect(e.isSettled).toBe(false);
      }
    }
    expect(sawGrowth).toBe(true);
  });

  it('the growth interval paces the advance', () => {
    const grow = (interval: number) => {
      const e = new PixelEngine({
        width: 30, height: 24, seed: 4, gravity: new FlatGravity(), growthInterval: interval,
      });
      for (let x = 0; x < 30; x++) e.setMaterial(x, 23, MaterialType.ROCK);
      e.plant(15, 22, MaterialType.TREE_TIP, { energy: 20, dir: 0 });
      for (let i = 0; i < 40; i++) e.update();
      return bounds(e, TREE_PARTS)!.h;
    };
    expect(grow(1)).toBeGreaterThan(grow(8));
  });
});
