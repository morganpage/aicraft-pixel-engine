/**
 * The gravity seam: translate a per-cell gravity direction into the discrete
 * 8-neighbor movement frame the cellular automaton uses.
 *
 * This is the *only* module that knows about gravity direction. The engine
 * core asks {@link neighborFrame} for a cell's movement offsets and uses
 * them instead of literal `y+1` / `x-1` etc. Swap the {@link GravityModel}
 * and the whole simulation's "down" rotates — no core rewrite.
 *
 * ## Derivation
 *
 * Given a (near-unit) gravity vector **g** = (gx, gy):
 *
 *  1. Snap **g** to the nearest of 8 compass directions (multiples of 45°)
 *     to get the quantized **down** axis **d**. This keeps movement on the
 *     grid's 8-neighborhood and avoids sub-cell drift.
 *  2. The level axis is **d** rotated 90°. Two perpendiculars exist; we
 *     define **left** = rotate **d** by +90° (i.e. (-dy, dx)) and
 *     **right** = -**left**.
 *  3. **downLeft** and **downRight** are **d** + **left** / **d** + **right**,
 *     each re-snapped to a unit step.
 *
 * For **g** = (0, 1) (flat) this yields exactly the original hardcoded
 * offsets — verified by `gravity-flat.test.ts`.
 */
import type { GravityModel, Vec2 } from '../gravity/types.js';
import type { NeighborFrame } from './types.js';

/** Inline a small sign helper to avoid allocating closures. */
function sign(v: number): number {
  return v > 0.001 ? 1 : v < -0.001 ? -1 : 0;
}

/**
 * Snap a (near-unit) vector to one of the 8 compass directions.
 *
 * Returns the snapped (dx, dy) where each component is in {-1, 0, 1} and at
 * least one is nonzero (the input is assumed to be a meaningful direction).
 */
function snapToCompass(gx: number, gy: number): Vec2 {
  // Angle of the gravity vector. atan2(dy, dx) → (-π, π].
  const angle = Math.atan2(gy, gx);
  // Nearest octant index in -4..4 (multiples of 45°).
  const octant = Math.round(angle / (Math.PI / 4));
  switch (octant) {
    case 0:  return { x: 1, y: 0 };              // E
    case 1:  return { x: 1, y: 1 };              // SE  (down-right in screen space)
    case 2:  return { x: 0, y: 1 };              // S   (straight down)
    case 3:  return { x: -1, y: 1 };             // SW
    case 4:
    case -4: return { x: -1, y: 0 };             // W
    case -3: return { x: -1, y: -1 };            // NW
    case -2: return { x: 0, y: -1 };             // N (straight up)
    case -1: return { x: 1, y: -1 };             // NE
    default: return { x: 0, y: 1 };              // unreachable; fall back to "down"
  }
}

/**
 * Compute the gravity-relative movement frame at cell `(x, y)`.
 *
 * Pure and allocation-heavy only at the call site — the engine calls this
 * once per active cell per frame. To avoid per-call object allocation in hot
 * loops, prefer {@link fillNeighborFrame} which writes into a reusable
 * object.
 */
export function neighborFrame(x: number, y: number, model: GravityModel): NeighborFrame {
  const frame: NeighborFrame = { down: { dx: 0, dy: 0 }, downLeft: { dx: 0, dy: 0 }, downRight: { dx: 0, dy: 0 }, left: { dx: 0, dy: 0 }, right: { dx: 0, dy: 0 } };
  fillNeighborFrame(x, y, model, frame);
  return frame;
}

/**
 * Write the gravity-relative movement frame at `(x, y)` into `out`, reusing
 * its nested offset objects. Use this in hot loops to avoid allocation.
 *
 * The `out` object's structure is preserved; only its `dx`/`dy` fields are
 * overwritten.
 */
export function fillNeighborFrame(
  x: number,
  y: number,
  model: GravityModel,
  out: NeighborFrame,
): void {
  const g = model.gravityAt(x, y);
  const d = snapToCompass(g.x, g.y);

  // Level axis = down rotated +90°: left = (-dy, dx), right = (dy, -dx).
  const leftX = -d.y;
  const leftY = d.x;

  // down + left / down + right, each re-snapped to a unit step.
  const dlX = sign(d.x + leftX);
  const dlY = sign(d.y + leftY);
  const drX = sign(d.x - leftX);
  const drY = sign(d.y - leftY);

  out.down.dx = d.x;       out.down.dy = d.y;
  out.left.dx = sign(leftX);  out.left.dy = sign(leftY);
  out.right.dx = -sign(leftX); out.right.dy = -sign(leftY);
  out.downLeft.dx = dlX;   out.downLeft.dy = dlY;
  out.downRight.dx = drX;  out.downRight.dy = drY;
}
