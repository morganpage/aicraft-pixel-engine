/**
 * aicraft-pixel-engine
 *
 * A pixel-based falling-sand cellular-automaton physics engine.
 * Zero runtime dependencies. Deterministic. DOM-free core.
 *
 * Import from individual modules for optimal tree-shaking, or from the
 * package root for convenience.
 */
export * from './rng.js';
export * from './materials/index.js';
export * from './gravity/index.js';
export * from './sand/index.js';
// Opt-in subsystem: nothing in the core imports it, so a world without a
// volcano never pays for it. See volcano/index.ts.
export * from './volcano/index.js';
