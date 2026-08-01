/**
 * The gravity-relative movement frame for a single cell.
 *
 * Every cell offset is a signed integer in `-1..1` — a unit step along one
 * of the 8 compass directions (or zero). The engine adds these to a cell's
 * `(x, y)` to get neighbor coordinates.
 *
 * Under {@link FlatGravity} this is always:
 *   - `down        = ( 0,  1)`
 *   - `downLeft    = (-1,  1)`
 *   - `downRight   = ( 1,  1)`
 *   - `left        = (-1,  0)`
 *   - `right       = ( 1,  0)`
 *
 * which reproduces the original hardcoded movement exactly. Under
 * {@link RadialGravity} the whole frame rotates to point "down" toward the
 * planet center.
 */
export interface NeighborFrame {
  /** One step "downhill" (toward the gravity source). */
  down: CellOffset;
  /** One step downhill and to the frame's left. */
  downLeft: CellOffset;
  /** One step downhill and to the frame's right. */
  downRight: CellOffset;
  /** One step along the level axis, frame-left. */
  left: CellOffset;
  /** One step along the level axis, frame-right. */
  right: CellOffset;
}

/**
 * A signed integer cell offset. Components are each `-1`, `0`, or `1`.
 */
export interface CellOffset {
  dx: number;
  dy: number;
}
