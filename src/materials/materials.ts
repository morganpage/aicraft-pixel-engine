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
  /**
   * Yield strength, expressed as the minimum flow thickness (in cells) at
   * which this liquid will spread sideways or level. `0`/absent = Newtonian:
   * spreads at any depth, which is the behavior every liquid had before this
   * field existed.
   *
   * Water is Newtonian — it flows until level however thin the film. Lava is
   * not: it is a Bingham plastic with a real yield strength, so a flow only
   * advances while the driving stress (which scales with thickness × slope)
   * exceeds it. Thin out, and the flow simply stops where it is.
   *
   * That single difference is what gives lava every shape it is known for. A
   * flow stops at a blunt front one yield-thickness tall instead of feathering
   * away to nothing; its cooling margins stall first and become levees that
   * channel the still-molten core; and successive flows stack instead of
   * draining away, which is the only reason an edifice can exist at all.
   *
   * Without it, a liquid on a planet has exactly two states — spreading toward
   * an equipotential shell, or frozen solid — and there is no setting in
   * between. Measured on a lava-fed planet before this field existed: at a
   * cooling rate of 0.02 the flow wrapped 180° around the planet (an orange
   * ocean), and at 0.5 it froze within 32° of the vent. A flow that travels a
   * bounded distance downslope and then *stops* — which is what a lava flow
   * is — was not reachable at any cooling rate.
   *
   * @see PixelEngine.flowThickness for how thickness is measured.
   */
  yieldThickness?: number;

  /**
   * Temperature a freshly-placed cell of this material is born at, 0–1.
   * Absent = born at the world's {@link PixelEngineOptions.ambientTemperature}.
   *
   * This is an *initial condition*, nothing more. A LAVA cell is born at 1.0 and
   * then cools like any other cell; it does not tend back toward 1.0. The
   * material that does hold its temperature says so with {@link heatSource}.
   */
  spawnTemp?: number;

  /**
   * If true, this material is held at {@link spawnTemp} — an infinite heat
   * source that neither cools nor equilibrates. Default false.
   *
   * "Held" is precise, and it is not the same as "skipped". A heat source
   * participates fully in conduction *as a source*: its neighbours draw heat
   * across the shared edge exactly as they would from any other cell, and the
   * source is then re-asserted to `spawnTemp` at the end of the step. It is a
   * Dirichlet boundary condition, not an inert cell — excluding it from
   * conduction would give a fire that nothing can warm itself against.
   *
   * This is the one place heat is created rather than moved, which is why the
   * engine's conservation property holds only for source-free systems.
   *
   * FIRE is one (it is a combustion reaction, not a hot object). LAVA is
   * emphatically not: a finite body of lava must cool, or nothing ever freezes.
   */
  heatSource?: boolean;

  /**
   * Conduction coefficient, 0–1, *relative*. Not a diffusion rate — the engine
   * scales it by its own stability constant, so 1.0 means "conducts as fast as
   * the scheme safely allows", not "moves the entire temperature difference in
   * one frame".
   *
   * Conduction happens across an *edge*, so the engine combines both endpoints'
   * values rather than reading one side's. A coefficient read from only the
   * cell being updated would let a hot conductor push out more than its cold
   * insulating neighbour took in, and heat would be created from nothing.
   */
  conductivity?: number;

  /**
   * Rate of exchange with the environment through an exposed (EMPTY) face,
   * 0–1. This is the dominant cooling term for anything at the surface, and the
   * one that carries the behaviour a host would otherwise hand-roll: a flow's
   * skin chills far ahead of its core, a buried conduit stays live, and a flow
   * front — the most exposed part of a flow — stalls first.
   *
   * Conduction cannot express any of that, because the thing an exposed cell
   * loses heat *to* is EMPTY, which has no temperature. Under a conduction-only
   * model an exposed cell has nobody to conduct into and so cools *slower* than
   * a buried one, which is backwards.
   */
  emissivity?: number;

  /** Temperature at/below which this transforms, into {@link freezesInto}. */
  freezesAt?: number;
  /** What {@link freezesAt} produces. Required if `freezesAt` is set. */
  freezesInto?: MaterialType;
  /** Temperature at/above which this transforms, into {@link meltsInto}. */
  meltsAt?: number;
  /** What {@link meltsAt} produces. Required if `meltsAt` is set. */
  meltsInto?: MaterialType;
}

/**
 * The canonical material table, keyed by id.
 *
 * ## Thermal values
 *
 * A material is thermal if it sets *any* of `spawnTemp`/`heatSource`/
 * `conductivity`/`emissivity`/`freezesAt`/`meltsAt` — see {@link isThermal}.
 * EMPTY, OIL, ACID, SMOKE and FGAS deliberately set none: they neither conduct
 * nor exchange nor transform, and the heat step skips them. Giving OIL a
 * boiling point is purely additive whenever a host needs it. EMPTY is the one
 * that must stay non-thermal — heat stored in vacuum cells would advect through
 * {@link PixelEngine.swap} as hot air parcels and be destroyed silently by
 * `setMaterial`, so conservation would be fiction.
 *
 * Five of these numbers are derived rather than chosen, and move together:
 *
 *  - `LAVA.emissivity = 0.13` reproduces the showcase's default cooling. That
 *    slider is an *absolute* loss per frame for a fully exposed cell (0.12);
 *    ours is proportional to `T − ambient`, so matching at the hot end gives
 *    `0.12 × 0.55 / (0.55 × 0.9) ≈ 0.13`.
 *  - `FIRE.spawnTemp`, `WATER.emissivity` and `WATER.meltsAt` are set by a
 *    reachability constraint: a heat source held at `T` can never drive a
 *    neighbour past `T`, since conduction moves a fraction of the *difference*.
 *    With fire at 0.90 and water boiling at 0.95 the threshold was unreachable
 *    outright; and at `WATER.emissivity` 0.30 — which had water equilibrating
 *    with air in about five frames, badly understating its thermal inertia —
 *    even lava-adjacent water settled near 0.48, so `LAVA + WATER` would have
 *    produced ROCK but never the STEAM the reaction is named for.
 *
 * The equilibrium a cell actually reaches, for `n` faces touching a source at
 * `Ts` with exposure factor `k`, is where `n·f·(Ts − T) = emissivity·k·(T −
 * ambient)`. Use that, not intuition, before moving any threshold.
 *
 * `STEAM.freezesAt` is the fifth derived number, and it is deliberately far
 * below `WATER.meltsAt` rather than just under it. Because phase change carries
 * temperature across, water boiling at 0.70 becomes steam at 0.70 — so a
 * condensation threshold of 0.65 gave steam a measured lifetime of **one
 * frame**, flickering straight back to water instead of forming a plume.
 *
 * What is missing physically is latent heat: converting water to steam absorbs
 * a large amount of energy that must be shed again before it condenses. Modelling
 * that properly needs a per-cell energy budget — new state, and purely additive
 * whenever it is wanted. The wide gap is the stateless stand-in: the energy is
 * represented by the temperature span the steam has to fall through. At 0.20 a
 * plume lives ~36 frames, from `T(t) = ambient + (0.70 − ambient)·e^(−e·k·t)`.
 *
 * Note this lowers only the *condensation* leg. Boiling still happens at
 * `WATER.meltsAt`, so nothing about it visibly lags.
 */
export const Materials: Record<MaterialType, MaterialDef> = {
  [MaterialType.EMPTY]: { id: MaterialType.EMPTY, name: 'Empty', color: [0, 0, 0, 0], density: 0, isLiquid: false, isGas: false, flammability: 0, friction: 0 },
  [MaterialType.WALL]: { id: MaterialType.WALL, name: 'Wall', color: [100, 100, 100, 255], density: 1000, isLiquid: false, isGas: false, flammability: 0, friction: 1, conductivity: 0.2, emissivity: 0.10 },
  [MaterialType.SAND]: { id: MaterialType.SAND, name: 'Sand', color: [230, 200, 100, 255], density: 10, isLiquid: false, isGas: false, flammability: 0, friction: 0.8, conductivity: 0.2, emissivity: 0.10 },
  [MaterialType.WATER]: { id: MaterialType.WATER, name: 'Water', color: [50, 100, 255, 200], density: 5, isLiquid: true, isGas: false, flammability: 0, friction: 0.1, spawnTemp: 0.15, conductivity: 0.9, emissivity: 0.05, freezesAt: 0.05, freezesInto: MaterialType.ICE, meltsAt: 0.70, meltsInto: MaterialType.STEAM },
  // yieldThickness 3: lava spreads only where the flow is at least 3 cells
  // thick, so a tongue advances while it is being fed and halts at a blunt
  // front once it thins. This is the value for lava with no temperature behind
  // it — a host tracking heat overrides it per cell via `stiffnessGrid`, since
  // the real quantity climbs steeply as the melt cools.
  [MaterialType.LAVA]: { id: MaterialType.LAVA, name: 'Lava', color: [255, 80, 0, 255], density: 8, isLiquid: true, isGas: false, flammability: 0, friction: 0.5, yieldThickness: 3, spawnTemp: 1.0, conductivity: 0.6, emissivity: 0.13, freezesAt: 0.30, freezesInto: MaterialType.ROCK },
  [MaterialType.ROCK]: { id: MaterialType.ROCK, name: 'Rock', color: [80, 80, 80, 255], density: 100, isLiquid: false, isGas: false, flammability: 0, friction: 0.9, conductivity: 0.2, emissivity: 0.15 },
  [MaterialType.STEAM]: { id: MaterialType.STEAM, name: 'Steam', color: [200, 200, 200, 150], density: -1, isLiquid: false, isGas: true, flammability: 0, friction: 0.1, spawnTemp: 0.75, conductivity: 0.4, emissivity: 0.05, freezesAt: 0.20, freezesInto: MaterialType.WATER },
  [MaterialType.FIRE]: { id: MaterialType.FIRE, name: 'Fire', color: [255, 150, 0, 255], density: -2, isLiquid: false, isGas: true, flammability: 0, friction: 0.1, spawnTemp: 1.0, heatSource: true, conductivity: 0.8, emissivity: 0.10 },
  [MaterialType.SMOKE]: { id: MaterialType.SMOKE, name: 'Smoke', color: [100, 100, 100, 150], density: -1, isLiquid: false, isGas: true, flammability: 0, friction: 0.1 },
  [MaterialType.OIL]: { id: MaterialType.OIL, name: 'Oil', color: [50, 50, 50, 255], density: 4, isLiquid: true, isGas: false, flammability: 100, friction: 0.05 },
  [MaterialType.ACID]: { id: MaterialType.ACID, name: 'Acid', color: [100, 255, 100, 200], density: 6, isLiquid: true, isGas: false, flammability: 0, friction: 0.1 },
  [MaterialType.WOOD]: { id: MaterialType.WOOD, name: 'Wood', color: [139, 69, 19, 255], density: 50, isLiquid: false, isGas: false, flammability: 30, friction: 0.9, conductivity: 0.2, emissivity: 0.10 },
  [MaterialType.FGAS]: { id: MaterialType.FGAS, name: 'F.Gas', color: [180, 255, 50, 120], density: -1.5, isLiquid: false, isGas: true, flammability: 100, friction: 0.1 },
  [MaterialType.ICE]: { id: MaterialType.ICE, name: 'Ice', color: [200, 230, 255, 200], density: 5, isLiquid: false, isGas: false, flammability: 0, friction: 0.05, spawnTemp: 0.0, conductivity: 0.3, emissivity: 0.20, meltsAt: 0.15, meltsInto: MaterialType.WATER },
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
 * Whether each material participates in the heat field, indexed by id.
 *
 * A material is thermal if it sets *any* thermal field. Precomputed rather than
 * checked inline because the alternative is six `undefined` tests per cell per
 * frame in the heat step's inner loop; this makes it one array read.
 *
 * Note what this is not: it is not "has a temperature". Every cell has a
 * temperature once {@link PixelEngine.heatGrid} is allocated. This is "takes
 * part in conduction, environment exchange, and phase change" — a non-thermal
 * material's stored heat simply sits there, riding along with the cell through
 * swaps but never changing on its own.
 */
export const isThermal: readonly boolean[] = materialDefs.map(
  (d) =>
    d.spawnTemp !== undefined ||
    d.heatSource !== undefined ||
    d.conductivity !== undefined ||
    d.emissivity !== undefined ||
    d.freezesAt !== undefined ||
    d.meltsAt !== undefined
);

/**
 * Whether each material is skipped outright by the movement core — it never
 * falls, flows, or rises under any circumstance. Indexed by id.
 *
 * Mirrors the early-out at the top of `runCheckerboardUpdate` (minus EMPTY,
 * which is skipped for a different reason). Kept as data because the phase
 * change step needs the same question answered: freezing a *mobile* material
 * into an immobile one mid-air produces a cell that can never fall, so a lava
 * bomb still in flight would freeze into rock and hang in the sky forever.
 * That guard is only correct if "immobile" means exactly what the movement
 * core thinks it means, so the two must not drift apart.
 *
 * WOOD is deliberately absent: it is in {@link TERRAIN_SOLIDS} but the core
 * does process it, falling when it loses structural support.
 */
export const isImmobile: readonly boolean[] = materialDefs.map(
  (d) =>
    d.id === MaterialType.WALL ||
    d.id === MaterialType.ROCK ||
    d.id === MaterialType.ICE
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
