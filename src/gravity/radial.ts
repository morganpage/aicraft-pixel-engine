/**
 * Radial gravity: gravity points toward a single fixed planet center.
 *
 * Designed for circular-world god games (Reus, Godfinger). The world is
 * still a square `Uint8Array` grid; you stamp your planet as a disc of
 * solid cells, and `RadialGravity` makes every other cell fall toward the
 * disc's center. Particles settle as a layer on the planet surface rather
 * than pooling at the grid bottom.
 *
 * ## Magnitude
 *
 * v1 returns uniform magnitude (the direction is all the displacement core
 * consumes). See {@link types.ts} for why magnitude is reserved for a
 * future velocity-integrated layer.
 *
 * ## Grid chunkiness
 *
 * On a square grid, radial direction is quantized to 8 compass neighbors by
 * {@link neighborFrame}. At the 45°/135°/225°/315° boundaries the chosen
 * diagonal flips, producing mild chunkiness — but the result is stable and
 * deterministic. This is the standard approach for square-grid planet sims.
 */
import type { GravityModel, Vec2 } from './types';

/** Options for constructing a {@link RadialGravity}. */
export interface RadialGravityOptions {
  /** Planet center X, in cell units. */
  centerX: number;
  /** Planet center Y, in cell units. */
  centerY: number;
}

/**
 * Gravity that points from each cell toward a fixed center.
 *
 * Pure: the same cell always yields the same direction. Stateless aside
 * from the immutable center, so a single instance can be shared.
 */
export class RadialGravity implements GravityModel {
  private readonly centerX: number;
  private readonly centerY: number;

  constructor(options: RadialGravityOptions) {
    this.centerX = options.centerX;
    this.centerY = options.centerY;
  }

  /**
   * Height above the planet center — simply the distance from it. Moving one
   * cell toward the center reduces this by exactly 1, satisfying the
   * {@link GravityModel.potentialAt} contract.
   *
   * At the center the potential is 0 and flat, which is correct: there is no
   * "downhill" left, matching {@link gravityAt}'s arbitrary-but-stable
   * fallback direction there.
   */
  potentialAt(x: number, y: number): number {
    const dx = x - this.centerX;
    const dy = y - this.centerY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  gravityAt(x: number, y: number): Vec2 {
    // Direction from cell toward center = "down" (fall toward planet).
    let dx = this.centerX - x;
    let dy = this.centerY - y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) {
      // At (or essentially at) the center: pick an arbitrary stable "down"
      // so movement remains well-defined. +Y is as good as any.
      return { x: 0, y: 1 };
    }
    dx /= len;
    dy /= len;
    return { x: dx, y: dy };
  }
}
