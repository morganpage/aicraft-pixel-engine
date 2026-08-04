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
import type { CellOffset, NeighborFrame } from './types.js';

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

/**
 * Write the offset for gravity-relative `octant` into `out`.
 *
 * Octants run clockwise from "up", where up is directly away from gravity:
 *
 * ```
 *   0 up        = −down          4 down
 *   1 upRight   = −downLeft      5 downLeft
 *   2 right                      6 left
 *   3 downRight                  7 upLeft = −downRight
 * ```
 *
 * {@link NeighborFrame} carries five of the eight because that is all the
 * movement rules ever needed; the other three are negations of the frame's
 * diagonals, exactly as the gas-rising path already derives "up" as `−down`.
 *
 * Directed growth is what needs all eight. A tip stores its heading as an
 * octant, so a tree planted anywhere on a `RadialGravity` planet grows radially
 * outward with no special-casing — the gravitropism The Powder Toy computes
 * explicitly from its gravity field falls out of the frame here for free.
 *
 * The eight offsets are a **rotation of the full 8-neighbourhood at any gravity
 * angle**, not a subset, which is what makes storing a heading as an octant
 * well-defined. Under 45° gravity `down = (1,1)`, `left = (-1,1)`,
 * `downLeft = (0,1)` and `downRight = (1,0)`, so the octants come out as
 * `{(-1,-1), (0,-1), (1,-1), (1,0), (1,1), (0,1), (-1,1), (-1,0)}` — all eight
 * neighbours, each exactly once. A four-direction subset would not have that
 * property, and a heading expressed in one would quietly mean different things
 * at different gravity angles.
 *
 * `octant` is taken modulo 8, so callers may pass `dir + turn` without
 * normalising, including negative turns.
 */
export function octantOffset(frame: NeighborFrame, octant: number, out: CellOffset): void {
  let dx: number;
  let dy: number;
  // Normalise into 0..7 for negative inputs too (JS `%` keeps the sign).
  switch (((octant % 8) + 8) % 8) {
    case 0: dx = -frame.down.dx;       dy = -frame.down.dy;       break; // up
    case 1: dx = -frame.downLeft.dx;   dy = -frame.downLeft.dy;   break; // upRight
    case 2: dx = frame.right.dx;       dy = frame.right.dy;       break;
    case 3: dx = frame.downRight.dx;   dy = frame.downRight.dy;   break;
    case 4: dx = frame.down.dx;        dy = frame.down.dy;        break;
    case 5: dx = frame.downLeft.dx;    dy = frame.downLeft.dy;    break;
    case 6: dx = frame.left.dx;        dy = frame.left.dy;        break;
    default: dx = -frame.downRight.dx; dy = -frame.downRight.dy;  break; // 7, upLeft
  }
  // `+ 0` collapses the negative zero that negating a zero component leaves
  // behind. It compares equal to `0` but not under `Object.is`, so leaving it
  // in makes an offset that is arithmetically correct fail a deep-equality
  // check — which is a trap to hand a consumer, not a nicety.
  out.dx = dx + 0;
  out.dy = dy + 0;
}
