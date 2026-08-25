import { describe, it, expect } from 'vitest';
import { PixelEngine, MaterialType, FlatGravity } from '../../src/index.js';
import {
  createSurfaceWalkers,
  stepSurfaceWalkers,
  aliveWalkers,
  type SurfaceWalkers,
} from '../surface-walkers.js';

/**
 * Surface-walker tests. The planet is a bare ROCK disc — no grass anywhere —
 * because the spawn contract under test is that walkers populate a dead
 * world at boot, on bare rock, with no census gate.
 */
const SIZE = 160;
const CX = 80;
const CY = 80;
const R = 60;

function makeRockWorld(): PixelEngine {
  const e = new PixelEngine({ width: SIZE, height: SIZE, seed: 7, gravity: new FlatGravity() });
  e.beginBulk();
  const r2 = R * R;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if ((x - CX) ** 2 + (y - CY) ** 2 <= r2) e.setMaterial(x, y, MaterialType.ROCK);
    }
  }
  e.endBulk();
  return e;
}

function makePop(engine: PixelEngine, seed = 7): SurfaceWalkers {
  return createSurfaceWalkers(engine, { centerX: CX, centerY: CY, seed });
}

describe('surface walkers — spawn contract', () => {
  it('populates a bare-rock world at boot (no grass, no census gate)', () => {
    const engine = makeRockWorld();
    const pop = makePop(engine);
    // Staggered boot spawn: all 16 alive within 16 × 12 ticks.
    for (let i = 0; i < 220; i++) stepSurfaceWalkers(engine, pop, {}, i);
    expect(aliveWalkers(pop)).toBe(16);
  });

  it('spawns on walkable footing above the planet surface, not in the core', () => {
    const engine = makeRockWorld();
    const pop = makePop(engine);
    for (let i = 0; i < 220; i++) stepSurfaceWalkers(engine, pop, {}, i);
    for (const w of pop.list) {
      if (!w.alive) continue;
      // Standing on rock means radius ≈ the disc's edge at that angle.
      expect(w.radius).toBeGreaterThan(R - 6);
      expect(w.radius).toBeLessThanOrEqual(R + 2);
    }
  });

  it('never writes to the grid (strictly visual)', () => {
    const engine = makeRockWorld();
    const before = Uint8Array.from(engine.grid);
    const pop = makePop(engine);
    for (let i = 0; i < 300; i++) {
      engine.update();
      stepSurfaceWalkers(engine, pop, {}, i);
    }
    expect(Uint8Array.from(engine.grid)).toEqual(before);
  });
});

describe('surface walkers — hazards and respawn', () => {
  it('dies in lava and the population regrows', () => {
    const engine = makeRockWorld();
    const pop = makePop(engine);
    for (let i = 0; i < 220; i++) stepSurfaceWalkers(engine, pop, {}, i);
    const victim = pop.list.find((w) => w.alive)!;
    // Bury the victim: LAVA at feet, chest and head along its angle.
    for (const dr of [-0.5, 6, 8]) {
      const x = Math.round(CX + (victim.radius + dr) * Math.cos(victim.angle));
      const y = Math.round(CY + (victim.radius + dr) * Math.sin(victim.angle));
      engine.setMaterial(x, y, MaterialType.LAVA);
    }
    stepSurfaceWalkers(engine, pop, {}, 220);
    expect(victim.alive).toBe(false);
    // Respawn after the timer, elsewhere on the rock. The planted lava stays
    // as a permanent hazard, so a second wanderer may die meanwhile — the
    // count can dip to 15 until its own respawn; the victim must be back.
    for (let i = 0; i < 260; i++) stepSurfaceWalkers(engine, pop, {}, 221 + i);
    expect(victim.alive).toBe(true);
    expect(aliveWalkers(pop)).toBeGreaterThanOrEqual(15);
  });
});

describe('surface walkers — fear', () => {
  it('a nearby strike scares walkers (freeze-stare, then flee)', () => {
    const engine = makeRockWorld();
    const pop = makePop(engine);
    for (let i = 0; i < 220; i++) stepSurfaceWalkers(engine, pop, {}, i);
    const w = pop.list.find((x) => x.alive)!;
    const x = CX + w.radius * Math.cos(w.angle);
    const y = CY + w.radius * Math.sin(w.angle);
    const strike = { x, y, tick: 220 };
    for (let i = 0; i < 30; i++) stepSurfaceWalkers(engine, pop, { strikes: [strike] }, 220 + i);
    expect(w.fear).toBeGreaterThan(0.2);
    // And it decays once the strike ages out of memory.
    for (let i = 0; i < 300; i++) stepSurfaceWalkers(engine, pop, {}, 260 + i);
    expect(w.fear).toBeLessThan(0.05);
    expect(w.alive).toBe(true);
  });
});

describe('surface walkers — determinism', () => {
  it('same seed + same world → same walker state', () => {
    const ea = makeRockWorld();
    const eb = makeRockWorld();
    const a = makePop(ea);
    const b = makePop(eb);
    for (let i = 0; i < 100; i++) {
      stepSurfaceWalkers(ea, a, {}, i);
      stepSurfaceWalkers(eb, b, {}, i);
    }
    const snap = (p: SurfaceWalkers) =>
      p.list.map((w) => `${w.angle.toFixed(6)}:${w.radius.toFixed(6)}:${w.alive}`).join('|');
    expect(snap(a)).toBe(snap(b));
  });
});
