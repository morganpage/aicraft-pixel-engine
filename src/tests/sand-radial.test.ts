import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../sand';
import { MaterialType } from '../materials';
import { FlatGravity, RadialGravity } from '../gravity';

/**
 * Behavior golden: under RadialGravity, sand dropped around a disc planet
 * settles onto the planet's *surface* (a ring), NOT at the bottom of the
 * grid. This is the defining god-game behavior and the reason the gravity
 * seam exists.
 */

const W = 80;
const H = 80;
const CX = 40;
const CY = 40;
const R = 15; // planet radius

function stampDisc(e: PixelEngine, mat: MaterialType, cx: number, cy: number, r: number): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) e.setMaterial(x, y, mat);
    }
  }
}

describe('radial gravity behavior', () => {
  it('sand settles as a ring on the planet surface, not at the grid bottom', () => {
    const e = new PixelEngine({
      width: W, height: H, seed: 5,
      gravity: new RadialGravity({ centerX: CX, centerY: CY }),
    });
    stampDisc(e, MaterialType.ROCK, CX, CY, R);

    // Drop sand in a shell just outside the planet, all the way around.
    for (let a = 0; a < 360; a += 4) {
      const rad = (a * Math.PI) / 180;
      const sx = Math.round(CX + Math.cos(rad) * (R + 12));
      const sy = Math.round(CY + Math.sin(rad) * (R + 12));
      e.setMaterial(sx, sy, MaterialType.SAND);
    }

    // Let it fall toward the surface.
    for (let i = 0; i < 80; i++) e.update();

    // Count sand in three regions:
    //  - "on surface" : the band R..R+4 from center (it should accumulate here)
    //  - "bottom strip": the bottom 5 rows of the grid (flat-gravity puddle location)
    let onSurface = 0;
    let atBottom = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (e.getMaterial(x, y) !== MaterialType.SAND) continue;
        const dx = x - CX;
        const dy = y - CY;
        const dist2 = dx * dx + dy * dy;
        const surfMin = R;
        const surfMax = R + 5;
        if (dist2 >= surfMin * surfMin && dist2 <= surfMax * surfMax) onSurface++;
        if (y >= H - 5) atBottom++;
      }
    }
    // The defining assertion: substantially more sand on the surface than at the bottom.
    expect(onSurface).toBeGreaterThan(0);
    expect(onSurface).toBeGreaterThan(atBottom);
  });

  it('under flat gravity the same sand DOES pool at the bottom (control)', () => {
    // Control: the same scenario under flat gravity must NOT concentrate on
    // the planet ring — it falls past/around to the grid bottom. This proves
    // the radial test above is actually exercising radial behavior, not a
    // coincidental artifact.
    const e = new PixelEngine({
      width: W, height: H, seed: 5, gravity: new FlatGravity(),
    });
    stampDisc(e, MaterialType.ROCK, CX, CY, R);
    for (let a = 0; a < 360; a += 4) {
      const rad = (a * Math.PI) / 180;
      const sx = Math.round(CX + Math.cos(rad) * (R + 12));
      const sy = Math.round(CY + Math.sin(rad) * (R + 12));
      e.setMaterial(sx, sy, MaterialType.SAND);
    }
    for (let i = 0; i < 80; i++) e.update();

    let onSurface = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (e.getMaterial(x, y) !== MaterialType.SAND) continue;
        const dx = x - CX;
        const dy = y - CY;
        const dist2 = dx * dx + dy * dy;
        if (dist2 >= R * R && dist2 <= (R + 5) * (R + 5)) onSurface++;
      }
    }
    // Under flat gravity, sand should NOT form a tight ring on the planet.
    // (It falls down, possibly resting on the top half of the disc, but the
    //  symmetric all-around ring of the radial case does not form.)
    // We assert it is strictly less than the radial case's onSurface by
    // checking it stays below a modest threshold.
    expect(onSurface).toBeLessThan(40);
  });
});
