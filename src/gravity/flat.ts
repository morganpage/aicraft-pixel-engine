/**
 * Flat gravity: "down" is always `+Y`, everywhere.
 *
 * This is the classic top-down falling-sand world. It is the default model
 * and reproduces byte-for-byte the behavior of a flat-world simulation —
 * proven by the flat golden test, which checks that the derived movement
 * frame equals the original hardcoded offsets `{down:(0,1), downLeft:(-1,1),
 * downRight:(1,1), left:(-1,0), right:(1,0)}`.
 */
import type { GravityModel, Vec2 } from './types';

/** Shared constant — `gravityAt` is allocation-free. */
const DOWN: Readonly<Vec2> = { x: 0, y: 1 };

/**
 * Flat, constant gravity pointing toward `+Y`.
 *
 * Stateless and pure; safe to share a single instance across engines.
 */
export class FlatGravity implements GravityModel {
  gravityAt(_x: number, _y: number): Vec2 {
    return { x: DOWN.x, y: DOWN.y };
  }
}
