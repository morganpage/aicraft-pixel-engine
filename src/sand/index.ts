export {
  PixelEngine,
  SETTLE_STABLE_THRESHOLD,
  SETTLE_TIMEOUT_FRAMES,
  DEFAULT_AMBIENT_TEMPERATURE,
  HEAT_EPSILON,
  type PixelEngineOptions,
  type ExplosionHook,
} from './engine.js';
export { neighborFrame, fillNeighborFrame } from './neighbors.js';
export type { NeighborFrame, CellOffset } from './types.js';
