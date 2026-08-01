import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../sand';
import { MaterialType } from '../materials';
import { FlatGravity } from '../gravity';

function makeEngine(w = 3, h = 3): PixelEngine {
  return new PixelEngine({ width: w, height: h, seed: 42, gravity: new FlatGravity() });
}

describe('material interactions', () => {
  it('lava + water → rock + steam', () => {
    const e = makeEngine();
    e.setMaterial(0, 1, MaterialType.WATER);
    e.setMaterial(1, 1, MaterialType.LAVA);
    // Pin both in place so movement doesn't move them out before reacting.
    // Use a floor + walls so they stay adjacent.
    e.setMaterial(0, 2, MaterialType.WALL);
    e.setMaterial(1, 2, MaterialType.WALL);
    e.setMaterial(2, 2, MaterialType.WALL);
    e.update();
    const cells = [e.getMaterial(0, 1), e.getMaterial(1, 1)];
    expect(cells).toContain(MaterialType.ROCK);
    expect(cells).toContain(MaterialType.STEAM);
  });

  it('fire + water → empty (fire extinguished)', () => {
    const e = makeEngine();
    e.setMaterial(0, 1, MaterialType.WATER);
    e.setMaterial(1, 1, MaterialType.FIRE);
    e.setMaterial(0, 2, MaterialType.WALL);
    e.setMaterial(1, 2, MaterialType.WALL);
    e.update();
    // Fire cell becomes empty; water remains.
    expect(e.getMaterial(1, 1)).toBe(MaterialType.EMPTY);
  });

  it('acid is neutralized by adjacent water', () => {
    const e = makeEngine();
    e.setMaterial(0, 1, MaterialType.WATER);
    e.setMaterial(1, 1, MaterialType.ACID);
    e.setMaterial(0, 2, MaterialType.WALL);
    e.setMaterial(1, 2, MaterialType.WALL);
    e.update();
    // Acid becomes water on contact.
    expect(e.getMaterial(1, 1)).toBe(MaterialType.WATER);
  });

  it('acid dissolves a solid neighbor (sand) given enough frames', () => {
    const e = makeEngine();
    // Acid above sand with walls to keep them adjacent.
    e.setMaterial(1, 0, MaterialType.ACID);
    e.setMaterial(1, 1, MaterialType.SAND);
    e.setMaterial(0, 0, MaterialType.WALL);
    e.setMaterial(2, 0, MaterialType.WALL);
    e.setMaterial(0, 1, MaterialType.WALL);
    e.setMaterial(2, 1, MaterialType.WALL);
    e.setMaterial(1, 2, MaterialType.WALL);
    // The reaction is probabilistic (~20%/frame); run many frames.
    for (let i = 0; i < 200; i++) e.update();
    // Either the sand was dissolved (now empty) or acid got consumed in the process.
    const dissolved = e.getMaterial(1, 1) === MaterialType.EMPTY;
    expect(dissolved).toBe(true);
  });

  it('FGAS next to fire ignites into fire', () => {
    const e = makeEngine();
    e.setMaterial(0, 1, MaterialType.FIRE);
    e.setMaterial(1, 1, MaterialType.FGAS);
    e.setMaterial(0, 2, MaterialType.WALL);
    e.setMaterial(1, 2, MaterialType.WALL);
    e.update();
    expect(e.getMaterial(1, 1)).toBe(MaterialType.FIRE);
  });

  it('ice melts into water adjacent to lava', () => {
    const e = makeEngine();
    e.setMaterial(0, 1, MaterialType.LAVA);
    e.setMaterial(1, 1, MaterialType.ICE);
    e.setMaterial(0, 2, MaterialType.WALL);
    e.setMaterial(1, 2, MaterialType.WALL);
    e.update();
    expect(e.getMaterial(1, 1)).toBe(MaterialType.WATER);
  });
});
