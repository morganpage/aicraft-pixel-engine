import { describe, it, expect } from 'vitest';
import { RadialGravity } from '../gravity';
import { neighborFrame } from '../sand';

/** Tolerance for float comparisons after normalization. */
const EPS = 1e-6;

describe('RadialGravity', () => {
  it('points toward the center from each cardinal direction', () => {
    const g = new RadialGravity({ centerX: 50, centerY: 50 });
    // Cell to the right of center → gravity points left.
    expect(g.gravityAt(60, 50).x).toBeCloseTo(-1, 6);
    expect(g.gravityAt(60, 50).y).toBeCloseTo(0, 6);
    // Cell above center → gravity points down (+y).
    expect(g.gravityAt(50, 40).x).toBeCloseTo(0, 6);
    expect(g.gravityAt(50, 40).y).toBeCloseTo(1, 6);
    // Cell to the left → gravity points right.
    expect(g.gravityAt(40, 50).x).toBeCloseTo(1, 6);
    // Cell below center → gravity points up (-y).
    expect(g.gravityAt(50, 60).y).toBeCloseTo(-1, 6);
  });

  it('returns an approximately unit-length vector', () => {
    const g = new RadialGravity({ centerX: 32, centerY: 32 });
    for (const [x, y] of [[40, 33], [10, 50], [32, 70], [0, 0]]) {
      const v = g.gravityAt(x, y);
      const len = Math.hypot(v.x, v.y);
      expect(len, `unit length at (${x},${y})`).toBeGreaterThan(1 - EPS);
      expect(len).toBeLessThan(1 + EPS);
    }
  });

  it('handles the degenerate at-center case with a stable fallback', () => {
    const g = new RadialGravity({ centerX: 10, centerY: 10 });
    const v = g.gravityAt(10, 10);
    expect(Math.abs(v.x) + Math.abs(v.y)).toBeGreaterThan(0); // not zero
  });

  it('diagonal cells produce diagonal gravity', () => {
    const g = new RadialGravity({ centerX: 50, centerY: 50 });
    // Cell up-and-right of center → gravity down-and-left (SW).
    const v = g.gravityAt(60, 40);
    expect(v.x).toBeLessThan(0);
    expect(v.y).toBeGreaterThan(0);
  });

  it('is pure — same cell always yields the same vector', () => {
    const g = new RadialGravity({ centerX: 20, centerY: 20 });
    expect(g.gravityAt(5, 5)).toEqual(g.gravityAt(5, 5));
  });
});

describe('neighborFrame under RadialGravity', () => {
  it('rotates the frame so "down" points toward the center', () => {
    const g = new RadialGravity({ centerX: 50, centerY: 50 });

    // Cell above the center: down should be (0,1) — same as flat.
    const above = neighborFrame(50, 40, g);
    expect(above.down).toEqual({ dx: 0, dy: 1 });

    // Cell to the right of center: down should be (-1,0) — points left.
    const right = neighborFrame(60, 50, g);
    expect(right.down).toEqual({ dx: -1, dy: 0 });

    // Cell below the center: down should be (0,-1) — points up.
    const below = neighborFrame(50, 60, g);
    expect(below.down).toEqual({ dx: 0, dy: -1 });

    // Cell to the left of center: down should be (1,0) — points right.
    const left = neighborFrame(40, 50, g);
    expect(left.down).toEqual({ dx: 1, dy: 0 });
  });

  it('keeps all offsets as unit integer steps', () => {
    const g = new RadialGravity({ centerX: 25, centerY: 25 });
    for (const [x, y] of [[0, 0], [49, 0], [0, 49], [49, 49], [30, 10]]) {
      const f = neighborFrame(x, y, g);
      for (const o of [f.down, f.downLeft, f.downRight, f.left, f.right]) {
        expect(Math.abs(o.dx)).toBeLessThanOrEqual(1);
        expect(Math.abs(o.dy)).toBeLessThanOrEqual(1);
        expect(Number.isInteger(o.dx)).toBe(true);
        expect(Number.isInteger(o.dy)).toBe(true);
      }
    }
  });
});
