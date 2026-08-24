/**
 * The engine's random number generator, as free functions.
 *
 * mulberry32: a 32-bit-state PRNG that is fast, has no allocation, and — the
 * property this library is built on — is exactly reproducible from its seed.
 * Every stochastic decision the simulation makes draws from it, so a given seed
 * plus a given sequence of host calls always produces the same world.
 *
 * ## Why this is a module and not just a method
 *
 * {@link PixelEngine.random} needs the state as an *inspectable field* rather
 * than a closure variable, so a future save format can serialize it and resume
 * a world mid-stream. A closure-based generator cannot offer that. But hosts
 * need side-streams too — a volcano wants its own RNG so its draws do not shift
 * the simulation's — and those want the closure form.
 *
 * Both are here, over one implementation. The alternative is what this replaces:
 * the same four lines of bit-mixing copy-pasted into the engine and into a host
 * helper, with nothing checking that they still agree. They are the same
 * algorithm because they are literally the same code.
 */

/** Advance a mulberry32 state by one step. Pure. */
export function mulberry32Next(state: number): number {
  return (state + 0x6d2b79f5) | 0;
}

/**
 * Map a mulberry32 state to its output in `[0, 1)`. Pure — the same state
 * always yields the same value, and reading does not advance anything.
 */
export function mulberry32Value(state: number): number {
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * A self-contained mulberry32 stream seeded at `seed`.
 *
 * Use this for a host-side side-stream — volcano jitter, decorative scatter,
 * anything that should be deterministic without perturbing the simulation's own
 * draw sequence. For decisions that write cells, prefer `engine.random()`, so
 * the world stays reproducible from the engine seed alone.
 */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = mulberry32Next(s);
    return mulberry32Value(s);
  };
}
