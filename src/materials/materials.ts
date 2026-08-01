/**
 * Material definitions for the falling-sand engine.
 *
 * Each cell of the simulation grid holds a single {@link MaterialType} id.
 * The behavior of each material (density, phase, flammability, friction) is
 * looked up in the {@link Materials} table.
 *
 * This module is pure data — no simulation logic. It is the contract shared
 * by the engine core and any consumer that reads the grid.
 */

/**
 * Material identifiers stored per-cell in the simulation grid.
 *
 * Values are kept stable and small so the grid can be a `Uint8Array`. Order
 * is meaningful only in that `EMPTY = 0` is the default cleared state.
 */
export enum MaterialType {
  EMPTY = 0,
  WALL = 1,
  SAND = 2,
  WATER = 3,
  LAVA = 4,
  ROCK = 5,
  STEAM = 6,
  FIRE = 7,
  SMOKE = 8,
  OIL = 9,
  ACID = 10,
  WOOD = 11,
  FGAS = 12,
  ICE = 13,
}

/**
 * Static definition of a material's physical properties.
 *
 * Density drives displacement: a denser material sinks through a less dense
 * one. Gases have negative density so they rise. Phase flags (`isLiquid`,
 * `isGas`) select which movement rules apply. `flammability` (0–100) gates
 * fire spread; `friction` is exposed for consumers (e.g. a future rigid-body
 * layer) but is not consumed by the v1 displacement core.
 */
export interface MaterialDef {
  id: MaterialType;
  name: string;
  color: number[]; // [r, g, b, a]
  /** Higher density sinks below lower density. Gases use negative density. */
  density: number;
  isLiquid: boolean;
  isGas: boolean;
  /** 0–100. Chance per neighbor-touch that fire ignites this material. */
  flammability: number;
  /** Surface friction (0–1). Exposed for consumers; unused by the v1 core. */
  friction: number;
}

/**
 * The canonical material table, keyed by id.
 */
export const Materials: Record<MaterialType, MaterialDef> = {
  [MaterialType.EMPTY]: { id: MaterialType.EMPTY, name: 'Empty', color: [0, 0, 0, 0], density: 0, isLiquid: false, isGas: false, flammability: 0, friction: 0 },
  [MaterialType.WALL]: { id: MaterialType.WALL, name: 'Wall', color: [100, 100, 100, 255], density: 1000, isLiquid: false, isGas: false, flammability: 0, friction: 1 },
  [MaterialType.SAND]: { id: MaterialType.SAND, name: 'Sand', color: [230, 200, 100, 255], density: 10, isLiquid: false, isGas: false, flammability: 0, friction: 0.8 },
  [MaterialType.WATER]: { id: MaterialType.WATER, name: 'Water', color: [50, 100, 255, 200], density: 5, isLiquid: true, isGas: false, flammability: 0, friction: 0.1 },
  [MaterialType.LAVA]: { id: MaterialType.LAVA, name: 'Lava', color: [255, 80, 0, 255], density: 8, isLiquid: true, isGas: false, flammability: 0, friction: 0.5 },
  [MaterialType.ROCK]: { id: MaterialType.ROCK, name: 'Rock', color: [80, 80, 80, 255], density: 100, isLiquid: false, isGas: false, flammability: 0, friction: 0.9 },
  [MaterialType.STEAM]: { id: MaterialType.STEAM, name: 'Steam', color: [200, 200, 200, 150], density: -1, isLiquid: false, isGas: true, flammability: 0, friction: 0.1 },
  [MaterialType.FIRE]: { id: MaterialType.FIRE, name: 'Fire', color: [255, 150, 0, 255], density: -2, isLiquid: false, isGas: true, flammability: 0, friction: 0.1 },
  [MaterialType.SMOKE]: { id: MaterialType.SMOKE, name: 'Smoke', color: [100, 100, 100, 150], density: -1, isLiquid: false, isGas: true, flammability: 0, friction: 0.1 },
  [MaterialType.OIL]: { id: MaterialType.OIL, name: 'Oil', color: [50, 50, 50, 255], density: 4, isLiquid: true, isGas: false, flammability: 100, friction: 0.05 },
  [MaterialType.ACID]: { id: MaterialType.ACID, name: 'Acid', color: [100, 255, 100, 200], density: 6, isLiquid: true, isGas: false, flammability: 0, friction: 0.1 },
  [MaterialType.WOOD]: { id: MaterialType.WOOD, name: 'Wood', color: [139, 69, 19, 255], density: 50, isLiquid: false, isGas: false, flammability: 30, friction: 0.9 },
  [MaterialType.FGAS]: { id: MaterialType.FGAS, name: 'F.Gas', color: [180, 255, 50, 120], density: -1.5, isLiquid: false, isGas: true, flammability: 100, friction: 0.1 },
  [MaterialType.ICE]: { id: MaterialType.ICE, name: 'Ice', color: [200, 230, 255, 200], density: 5, isLiquid: false, isGas: false, flammability: 0, friction: 0.05 },
};

/**
 * Material definitions as a sorted array indexed by id.
 *
 * Use this (rather than the {@link Materials} record) in hot loops: array
 * indexing by material id is faster than record lookup, and the sort-by-id
 * guarantee means `materialDefs[mat]` always returns the right definition.
 */
export const materialDefs: readonly MaterialDef[] = Object.values(Materials).sort(
  (a, b) => a.id - b.id
);

/**
 * The set of materials that count as load-bearing terrain solids.
 *
 * WALL, ROCK, WOOD, ICE form the destructible structural layer. This is used
 * to flag the terrain as dirty when these materials move or change, so a
 * future rigid-body terrain rebuild can stay in sync.
 */
export const TERRAIN_SOLIDS: ReadonlySet<MaterialType> = new Set([
  MaterialType.WALL,
  MaterialType.ROCK,
  MaterialType.WOOD,
  MaterialType.ICE,
]);

/** True if the material id is a load-bearing terrain solid (WALL/ROCK/WOOD/ICE). */
export function isTerrainSolid(mat: number): boolean {
  return TERRAIN_SOLIDS.has(mat as MaterialType);
}
