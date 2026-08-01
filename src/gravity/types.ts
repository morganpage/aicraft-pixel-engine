/**
 * Gravity model contract.
 *
 * The falling-sand engine never assumes which way is "down". Instead, at
 * every cell it asks its {@link GravityModel} for the local gravity
 * direction, and the movement rules (falling, rising, liquid leveling,
 * explosion scatter) become gravity-relative.
 *
 * This is the seam that lets the same engine drive both flat worlds
 * ({@link FlatGravity}) and circular planets ({@link RadialGravity}) for
 * Reus / Godfinger-style god games — with no rewrite of the core loop.
 *
 * ## v1 scope note
 *
 * The engine is a *displacement-based* cellular automaton: each particle
 * moves one cell (or not) per frame, with no per-particle velocity to
 * integrate. Gravity **direction** therefore affects motion cleanly, but
 * gravity **magnitude** does not — there is nothing for magnitude to scale
 * without injecting probability, which would risk determinism.
 *
 * So all v1 models are effectively uniform-magnitude toward the source.
 * {@link GravityModel.magnitudeAt} is reserved for a future
 * velocity-integrated layer; the v1 core does not call it.
 */

/**
 * A 2D vector. Components are in cell units.
 */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * A source of per-cell gravity direction.
 *
 * Implementations must be **pure**: the same `(x, y)` must always yield the
 * same direction, with no dependence on wall-clock time, `Math.random()`, or
 * mutable external state. This is what keeps the simulation deterministic
 * and golden-testable.
 */
export interface GravityModel {
  /**
   * Unit vector pointing "downhill" — toward the gravity source — at cell
   * `(x, y)`. For a flat world this is always `{0, 1}`; for a planet this
   * points toward the planet center.
   *
   * Implementations should return an approximately unit-length vector. The
   * engine normalizes before use, so exact length is not required, but a
   * near-unit vector keeps the quantization in {@link neighborFrame}
   * well-behaved.
   */
  gravityAt(x: number, y: number): Vec2;

  /**
   * Optional gravity magnitude at `(x, y)`. **Not consumed by the v1 core.**
   * Reserved for a future velocity-integrated or zero-g-threshold model.
   *
   * If omitted, the engine treats magnitude as uniform (1.0).
   */
  magnitudeAt?(x: number, y: number): number;
}
