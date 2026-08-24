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
  /** Spreading ground cover. See {@link SpreadRule}. */
  GRASS = 14,
  /** Falls, then germinates into {@link TREE_TIP} on soil. */
  SEED = 15,
  /** Ephemeral growing point of a tree. See {@link TipRule}. */
  TREE_TIP = 16,
  /** Static foliage forming a tree crown. */
  LEAF = 17,
  /** Ephemeral growing point of a fern. */
  FERN_TIP = 18,
  /** Wandering gas that accretes onto {@link CORAL}. */
  SPORE = 19,
  CORAL = 20,
  /** Fern blade — the static counterpart to {@link LEAF}. */
  FROND = 21,
  /** Granular volcanic ejecta; light enough to remain above molten lava. */
  TEPHRA = 22,
}

/**
 * A gravity-relative direction, `0` = "up" (directly away from gravity),
 * numbered clockwise. Under {@link FlatGravity} octant 0 is `(0, -1)`; on a
 * planet it points radially outward from the core.
 *
 * @see octantOffset
 */
export type Octant = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * A generative rule: the conditions under which a material creates new cells.
 *
 * Three kinds, because "life" is three different problems and only the first is
 * solvable by an isotropic copy rule:
 *
 *  - {@link SpreadRule} — grass, moss, algae. Stateless and directionless.
 *  - {@link TipRule} — trees, ferns, vines. A *directed, stateful* growing
 *    point that leaves structure behind it. No amount of spreading produces a
 *    tree; it produces a blob.
 *  - {@link AggregateRule} — coral, germination. A cell that transforms itself
 *    on contact rather than writing into a neighbour.
 *
 * Absent = the material is inert, which is every material that predates this
 * field. See {@link PixelEngine.runGrowth} for the pass that consumes it.
 */
export type GrowthRule = SpreadRule | TipRule | AggregateRule;

/**
 * Isotropic spreading — the "texture" tier.
 *
 * Every condition here is evaluated at the **target** cell, not the source.
 * That is not a detail: a source-side crowding check only slows the interior of
 * a patch down while its frontier keeps expanding at exactly the same final
 * extent, so it cannot bound coverage. Sandspiel arrives at the same place,
 * refusing to grow when the cells flanking the destination are already plant.
 */
export interface SpreadRule {
  kind: 'spread';
  /** What appears in the target cell. Usually the material itself. */
  into: MaterialType;
  /** What the source becomes after a successful spawn. Absent = unchanged. */
  becomes?: MaterialType;
  /** Materials the target may overwrite. Default `[EMPTY]`. */
  intoMaterial?: MaterialType[];
  /**
   * Materials that must be present in the **source's** 8-neighbourhood for it
   * to spawn at all — and, with {@link range}, for how far its descendants can
   * carry that licence.
   *
   * Checked at the source rather than the target, unlike every other condition
   * here, and the asymmetry is deliberate. A target-side moisture test sounds
   * stricter and is: it confines grass to the single ring of cells physically
   * touching water, so a pond grows a green fringe and a lawn is unreachable at
   * any chance value. Crowding still belongs at the target — that one really
   * does bound coverage — but a resource has to be able to travel.
   */
  needs?: MaterialType[];

  /**
   * How many generations of spread a {@link needs} licence survives. Default 1:
   * only cells that themselves touch what they need may spawn.
   *
   * A cell adjacent to everything in `needs` is refreshed to `range` on every
   * tick; a cell that is not keeps whatever its parent passed down, minus one,
   * and stops spawning at zero. So `range` is the radius of the living zone
   * around a resource, in cells, and grass with `range: 6` puts a six-cell
   * meadow around a pond that grows outward and then stops.
   *
   * The counter lives in the cell's growth word, which for a spreading material
   * is otherwise only holding a backoff counter. This is the per-cell state
   * paying for itself a second time: a moisture gradient with no extra grid.
   */
  range?: number;
  /** Headings allowed, gravity-relative. Default: all eight. */
  directions?: Octant[];

  /**
   * Require the target to have something solid directly "below" it in the
   * gravity frame. Off by default.
   *
   * This is what makes ground cover ground cover. Without it, grass permitted
   * to spread upward at all does so without limit and builds a tangle standing
   * several cells clear of the soil — the reach limit bounds how far it gets,
   * not whether it is touching anything. With it, a lawn follows the terrain,
   * climbs a slope, and stops at a cliff edge; on a planet it wraps the surface
   * because "below" is re-derived per cell from the gravity model.
   */
  needsFooting?: boolean;
  /** Refuse to spawn if the target already has more than this many `into` neighbours. */
  maxNeighbors?: number;
  /** Probability per growth tick, 0–1. Rolled against `engine.random()`. */
  chance: number;
  /** Only grow while the target's temperature is within `[min, max]`. */
  tempRange?: [number, number];
}

/**
 * Directed, stateful growth — the "structure" tier, and the reason this engine
 * can grow a tree rather than a stain.
 *
 * A tip is a mobile, ephemeral cell. Each growth tick it advances one cell
 * along its heading, converts the cell it vacated into {@link becomes}, and
 * spends a unit of energy. When the energy runs out — or the way ahead is
 * blocked — it converts to {@link terminal} and is gone. **Tips always die**,
 * which is the only self-limiting property in the whole design and the reason a
 * forest converges instead of consuming the grid.
 *
 * Per-cell state (heading, remaining energy, branch depth, genome) lives in
 * {@link PixelEngine.growthGrid}. The Powder Toy packs the same four fields
 * into a particle's `ctype`, and Sandspiel into its `ra`/`rb` registers; both
 * arrived there because directed growth is impossible without per-cell memory.
 */
export interface TipRule {
  kind: 'tip';
  /** What the tip leaves behind as it advances — the trunk or stem. */
  becomes: MaterialType;
  /** What the tip turns into when it stops, out of energy or blocked. */
  terminal: MaterialType;
  /** Materials the tip may grow into. Default `[EMPTY]`. */
  intoMaterial?: MaterialType[];
  /** Chance per advance of veering one octant. 0 = ruler-straight. */
  wobble?: number;
  /** Octant turns a branch may take, e.g. `[-1, 1]` (45°) or `[-2, 2]` (90°). */
  branchTurns?: number[];
  /** Stochastic branching (trees): probability per advance, per turn. */
  branchChance?: number;
  /**
   * Deterministic branching (ferns): fork every N cells of energy instead of by
   * chance. A frond's pinnae are regularly spaced; a tree's limbs are not, and
   * this one field is the difference between the two silhouettes.
   */
  branchEvery?: number;
  /** Child energy = `floor(parent energy × taper)`. Default 0.6. */
  branchTaper?: number;
  /** Maximum branch depth. Default 3, and 3 is the ceiling (`gen` is 2 bits). */
  maxGen?: 0 | 1 | 2 | 3;
  /** Don't branch below this energy — keeps twigs from forking. Default 4. */
  branchMinEnergy?: number;
  /**
   * Bias each advance toward the heading with the most open space within a
   * two-cell probe: the cheap cellular reduction of space colonization's
   * premise that what shapes a canopy is competition for room. Stops adjacent
   * trees from growing through each other.
   *
   * Ties break deterministically — toward the current heading, then by
   * ascending octant — so this cannot make growth depend on sort stability.
   */
  preferOpen?: boolean;
  /** Foliage scattered along the branches as the tip advances. */
  foliage?: { into: MaterialType; chance: number };
  /** Cluster stamped where a tip terminates. Radius in cells; 1 = the 8-ring. */
  canopy?: { into: MaterialType; radius: number };
  /** On termination, maybe drop a seed — closes the life cycle. */
  seeds?: { into: MaterialType; chance: number };
  /** Only advance while the tip's own temperature is within `[min, max]`. */
  tempRange?: [number, number];
}

/**
 * Contact transformation — a cell that changes *itself* when it touches
 * something, rather than writing into a neighbour.
 *
 * Two jobs share this shape. Germination is one: a SEED that has landed on soil
 * becomes a growing tip, seeded with the {@link state} the tip needs. Accretion
 * is the other: a wandering SPORE that touches CORAL becomes CORAL.
 *
 * The accretion case is deliberately **not** diffusion-limited aggregation,
 * whatever the resemblance. DLA's dendrites come from isotropic walkers — a
 * walker equally likely to arrive from any direction, so protrusions shadow the
 * interior and the cluster branches. This engine's gas path tries straight up
 * first, then the up-diagonals, then lateral, so approaches almost always
 * arrive from below and the result combs upward. For coral growing toward the
 * light that bias is the right shape rather than an artefact, but it is not
 * DLA, and calling it that would set the wrong expectation for anyone tuning it.
 */
export interface AggregateRule {
  kind: 'aggregate';
  /** Transform when adjacent to any of these. */
  contact: MaterialType[];
  /** What this cell becomes. */
  into: MaterialType;
  /** Probability per growth tick, 0–1. */
  chance: number;
  /** Initial growth state for the produced cell — used to sprout a tip. */
  state?: { energy: number; dir: Octant | 'up'; variant?: 'random' | number };
  /** Only transform while this cell's temperature is within `[min, max]`. */
  tempRange?: [number, number];
}

/**
 * Static definition of a material's physical properties.
 *
 * Density drives displacement: a denser material sinks through a less dense
 * one. Gases have negative density so they rise. Phase flags (`isLiquid`,
 * `isGas`) select which movement rules apply. `flammability` (0–100) gates
 * fire spread; `decayChance` lets short-lived materials disappear independently
 * of whether they moved; `friction` is exposed for consumers (e.g. a future
 * rigid-body layer) but is not consumed by the v1 displacement core.
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
  /** 0–1. Chance per simulation tick that this material becomes EMPTY. */
  decayChance?: number;
  /** Leave the simulation when rising beyond the grid instead of treating the boundary as a wall. */
  escapesAtBoundary?: boolean;
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
   * @see yieldThicknessCurve for the temperature-dependent form, which is what
   *   a melt actually obeys.
   */
  yieldThickness?: number;

  /**
   * Yield thickness as a function of temperature: `[minTemp, thickness]` tiers,
   * **hottest first**. The first tier whose `minTemp` the cell meets wins;
   * below every tier, {@link yieldThickness} applies.
   *
   * ## Why a constant is the wrong shape for this
   *
   * Yield strength is not a constant of a melt. For lava it climbs by orders of
   * magnitude over the last couple of hundred degrees before it sets, as
   * crystals nucleate and lock it up — and everything that makes a flow look
   * like a flow comes out of that one dependence. Fresh lava at the vent is
   * nearly fluid and runs downhill; the chilled skin and the flow front stiffen
   * first, so the front stalls into a blunt snout and the margins set into
   * levees that channel the still-mobile core behind them; the flow stops at a
   * finite length set by how far it got before it chilled.
   *
   * A single value cannot produce any of that. Held low, lava never stops and
   * levels into an ocean around the planet; held high, it seizes the instant it
   * leaves the vent and stacks into a spire.
   *
   * ## The spire, specifically
   *
   * This field exists because the constant had a silent, ugly failure mode. A
   * host that enabled heat but never wrote {@link PixelEngine.stiffnessGrid}
   * got lava pinned at `yieldThickness: 3` — meaning a parcel needed three
   * cells of depth before it could shear sideways *at all*. On a volcano's
   * summit no parcel is ever three cells deep, so extruded lava could not move,
   * froze exactly where it landed, and the next parcel stacked on the last.
   * The result was a straight-sided chimney precisely as wide as the vent
   * corridor, which passed every height-and-volume test written for it. See
   * `showcase/tests/godgame-volcano.scenario.test.ts`.
   *
   * The curve is consulted only when {@link PixelEngine.heatGrid} is live and
   * the cell has no explicit `stiffnessGrid` override, so a host that writes
   * its own rheology still wins, and a world without heat behaves exactly as
   * before.
   */
  yieldThicknessCurve?: readonly (readonly [minTemp: number, thickness: number])[];

  /**
   * Hydraulic head lost per routed cell when this material moves under a
   * pressure gradient, in cell-head units. Absent means pressure transport is
   * **unsupported** for this material — an {@link PixelEngine.injectLiquid}
   * request for it returns `unsupportedMaterial` without exploring its
   * connected component.
   *
   * Pressure routing is lava-only in V1, deliberately. A low-resistance liquid
   * in a broad body can make every cell physically reachable within a modest
   * head budget, which turns the router's visited-cell ceiling from a safety
   * guard into a correctness limit (a valid outlet beyond the ceiling is
   * falsely reported as unreachable). General water routing needs a different
   * algorithm and is out of scope until that exists.
   *
   * As with {@link yieldThickness}, this is a material constant today and the
   * real quantity climbs steeply as magma cools and crystallizes. A V1 conduit
   * cell therefore routes exactly like a fresh one; per-cell,
   * temperature-dependent resistance is a later extension that mirrors
   * {@link PixelEngine.stiffnessGrid}.
   */
  pressureResistance?: number;

  /**
   * Pressure (in hydraulic head) at which this **solid** fractures under a
   * sustained pressure gradient from an adjacent pressurized liquid body.
   * Absent means the solid is unbreakable by pressure — `WALL` deliberately
   * sets none, so editor geometry stays permanent.
   *
   * This is what lets a blocked vent fail: when routing finds no affordable
   * liquid outlet, the engine checks the solid boundaries of the explored
   * body. A boundary whose `pressureStrength` is below the source's available
   * pressure fractures into the source material (the rock becomes part of the
   * conduit), opening a path for the next routing attempt. Fracture is bounded
   * per frame and consumes pressure equal to the strength, so it cannot clear a
   * mountain in one update.
   *
   * `ROCK` opts in — a cooling cap that froze from lava can be broken back open
   * by sufficient sustained pressure. Hosts can add it to other solids; `WALL`
   * stays unbreakable unless explicitly configured.
   */
  pressureStrength?: number;

  /**
   * Temperature at/below which an **airborne** cell of this material fragments
   * into granular tephra ({@link fragmentsInto}). Absent means no fragmentation
   * — the material transforms only via `freezesAt`/`meltsAt` as usual.
   *
   * This is what builds a volcano's cone from physics-driven ejecta rather than
   * host-placed cells. A pressure-launched lava bomb cools during its ballistic
   * arc; if it crosses this threshold *while still in flight* it becomes the
   * granular `fragmentsInto` material, which piles at its angle of repose and
   * builds a tapering flank. A bomb that
   * lands hot (short arc) does not fragment and freezes to ROCK from ponded
   * lava — which is the mesa-forming path. The flight-time dependence is the
   * physically correct fragmentation criterion, and it emerges for free from
   * the cooling curve.
   *
   * Set above `freezesAt` (lava: 0.65 vs 0.30) so fragmentation begins earlier
   * in the arc than full freezing, producing more tephra. Grounded cells never
   * fragment — they freeze via `freezesAt` like any other material.
   */
  fragmentsAt?: number;
  /** What {@link fragmentsAt} produces. Required if `fragmentsAt` is set. */
  fragmentsInto?: MaterialType;

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

  /**
   * This material never moves under gravity — it never falls, flows, or rises,
   * and the movement core skips it outright. Default false.
   *
   * Vegetation is why this is a field rather than the hardcoded id list it
   * replaces. A plant is not a powder: GRASS at density 20 outweighs SAND at
   * 10, so without this it would sink through the soil it is supposed to be
   * rooted in. See {@link isImmobile}, which the phase-change guard also reads.
   */
  isStatic?: boolean;

  /**
   * This material falls unless a {@link isTerrainSolid} neighbour holds it up —
   * the rule WOOD has always had, generalised out of the movement core.
   *
   * Note the support test is **cardinal only**, and that is deliberate rather
   * than an oversight to fix: a diagonally-braced cell falls, today and after.
   *
   * Support is satisfied only by {@link isTerrainSolid} cells, which makes this
   * a narrow tool. Foliage was built on it first, for the sake of a canopy that
   * collapses when its trunk burns; that had to be abandoned, because a leaf
   * could then only survive cardinally adjacent to wood and a *canopy* — leaves
   * two or more cells from any branch — could not exist at all. See LEAF.
   */
  needsSupport?: boolean;

  /**
   * Generative rule — under what conditions this material creates new cells.
   * Absent = inert, which is every material that predates this field.
   *
   * This is the opt-in that separates life from matter in the sim. A flammable
   * material burns (destructive); a growing one spreads (generative). Most are
   * neither.
   */
  growth?: GrowthRule;
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
  [MaterialType.WALL]: { id: MaterialType.WALL, name: 'Wall', color: [100, 100, 100, 255], density: 1000, isLiquid: false, isGas: false, flammability: 0, friction: 1, isStatic: true, conductivity: 0.2, emissivity: 0.10 },
  [MaterialType.SAND]: { id: MaterialType.SAND, name: 'Sand', color: [230, 200, 100, 255], density: 10, isLiquid: false, isGas: false, flammability: 0, friction: 0.8, conductivity: 0.2, emissivity: 0.10 },
  [MaterialType.WATER]: { id: MaterialType.WATER, name: 'Water', color: [50, 100, 255, 200], density: 5, isLiquid: true, isGas: false, flammability: 0, friction: 0.1, spawnTemp: 0.15, conductivity: 0.9, emissivity: 0.05, freezesAt: 0.05, freezesInto: MaterialType.ICE, meltsAt: 0.70, meltsInto: MaterialType.STEAM },
  // yieldThickness 3: lava spreads only where the flow is at least 3 cells
  // thick, so a tongue advances while it is being fed and halts at a blunt
  // front once it thins. This is the value for lava with no temperature behind
  // it — a host tracking heat overrides it per cell via `stiffnessGrid`, since
  // the real quantity climbs steeply as the melt cools.
  // `yieldThicknessCurve` is the load-bearing one; `yieldThickness: 3` is only
  // the no-heat fallback. The tiers are set against the engine's measured
  // cooling curve, not picked by eye:
  //
  //  - A thickness of 1 can never gate anything — one cell is already one cell
  //    thick — so the top tier means "free to move at any depth". Only lava
  //    within ~0.15 of vent temperature gets it, and a cell loses about 0.08
  //    per frame while exposed, so the live window lasts a couple of frames:
  //    long enough to leave the vent as a stream, not long enough to thin into
  //    a monolayer.
  //  - Lava freezes at 0.30. A two-cell-thick flow falls from vent heat to 0.60
  //    in ~14 frames and to 0.30 in ~36, so tiering the second step at 0.60
  //    buys a tongue roughly a dozen cells of travel before it stiffens, and
  //    the front stalls well before the body has set. At 0.72 — tried — every
  //    flow seized within a couple of cells of the crater.
  //  - The cold tier is 8, not 3: stiff enough to hold a flow front.
  [MaterialType.LAVA]: { id: MaterialType.LAVA, name: 'Lava', color: [255, 80, 0, 255], density: 8, isLiquid: true, isGas: false, flammability: 0, friction: 0.5, yieldThickness: 3, yieldThicknessCurve: [[0.85, 1], [0.60, 2], [0.45, 3], [0.32, 5], [0, 8]], spawnTemp: 1.0, conductivity: 0.6, emissivity: 0.13, freezesAt: 0.30, freezesInto: MaterialType.ROCK, pressureResistance: 0.15, fragmentsAt: 0.65, fragmentsInto: MaterialType.TEPHRA },
  [MaterialType.ROCK]: { id: MaterialType.ROCK, name: 'Rock', color: [80, 80, 80, 255], density: 100, isLiquid: false, isGas: false, flammability: 0, friction: 0.9, isStatic: true, conductivity: 0.2, emissivity: 0.15, pressureStrength: 15 },
  [MaterialType.STEAM]: { id: MaterialType.STEAM, name: 'Steam', color: [200, 200, 200, 150], density: -1, isLiquid: false, isGas: true, flammability: 0, friction: 0.1, spawnTemp: 0.75, conductivity: 0.4, emissivity: 0.05, freezesAt: 0.20, freezesInto: MaterialType.WATER },
  [MaterialType.FIRE]: { id: MaterialType.FIRE, name: 'Fire', color: [255, 150, 0, 255], density: -2, isLiquid: false, isGas: true, flammability: 0, friction: 0.1, spawnTemp: 1.0, heatSource: true, conductivity: 0.8, emissivity: 0.10 },
  [MaterialType.SMOKE]: { id: MaterialType.SMOKE, name: 'Smoke', color: [100, 100, 100, 150], density: -1, isLiquid: false, isGas: true, flammability: 0, friction: 0.1, decayChance: 0.02, escapesAtBoundary: true },
  [MaterialType.OIL]: { id: MaterialType.OIL, name: 'Oil', color: [50, 50, 50, 255], density: 4, isLiquid: true, isGas: false, flammability: 100, friction: 0.05 },
  [MaterialType.ACID]: { id: MaterialType.ACID, name: 'Acid', color: [100, 255, 100, 200], density: 6, isLiquid: true, isGas: false, flammability: 0, friction: 0.1 },
  [MaterialType.WOOD]: { id: MaterialType.WOOD, name: 'Wood', color: [139, 69, 19, 255], density: 50, isLiquid: false, isGas: false, flammability: 30, friction: 0.9, needsSupport: true, conductivity: 0.2, emissivity: 0.10 },
  [MaterialType.FGAS]: { id: MaterialType.FGAS, name: 'F.Gas', color: [180, 255, 50, 120], density: -1.5, isLiquid: false, isGas: true, flammability: 100, friction: 0.1 },
  [MaterialType.ICE]: { id: MaterialType.ICE, name: 'Ice', color: [200, 230, 255, 200], density: 5, isLiquid: false, isGas: false, flammability: 0, friction: 0.05, isStatic: true, spawnTemp: 0.0, conductivity: 0.3, emissivity: 0.20, meltsAt: 0.15, meltsInto: MaterialType.WATER },

  // Fragmented volcanic ejecta needs its own physics identity. Reusing SAND
  // (density 10) made every grain sink through LAVA (density 8), travel back
  // into the reservoir, and remelt; raising the fragmentation threshold could
  // not change that. Tephra at density 7 still falls through air and water but
  // remains on molten lava long enough to pile into a granular cone.
  //
  // Like ROCK, tephra opts into pressure fracture: a vent-capping crust must
  // fail open under sustained magma pressure rather than sealing the eruption
  // for good. Its strength (6) is far below rock (15) — loose unconsolidated
  // ash — so the cap holds only briefly, pressure builds, and the vent pops in
  // a rhythmic build-up-and-release cycle. Cone flanks see no accumulated head
  // against them and stay put; only the pressurized vent clears.
  [MaterialType.TEPHRA]: { id: MaterialType.TEPHRA, name: 'Tephra', color: [132, 112, 98, 255], density: 7, isLiquid: false, isGas: false, flammability: 0, friction: 0.85, conductivity: 0.2, emissivity: 0.10, pressureStrength: 6 },

  // --- Life -------------------------------------------------------------
  //
  // Every material below is inert until its `growth` rule fires, and every one
  // of them is skipped entirely by hosts that never place them. The thermal
  // values mirror WOOD, so a forest conducts and radiates like the timber it is
  // rather than sitting outside the heat field as a hole in the conduction map.

  // Ground cover. Static, or it would sink through the sand it roots in.
  // `directions` covers the upper hemisphere only: grass creeps across a
  // surface and up over obstacles, but does not tunnel down into the soil.
  [MaterialType.GRASS]: {
    id: MaterialType.GRASS, name: 'Grass', color: [90, 180, 70, 255],
    density: 20, isLiquid: false, isGas: false, flammability: 40, friction: 0.7,
    isStatic: true, conductivity: 0.2, emissivity: 0.10,
    growth: {
      kind: 'spread',
      into: MaterialType.GRASS,
      needs: [MaterialType.WATER],
      range: 6,
      // TEPHRA is fertile: volcanic ash weathers into the richest soils, so a
      // cooled cone's flanks green over like any other ground. The
      // temperature window keeps fresh, still-hot ejecta sterile — and turns
      // grass off entirely in frozen worlds.
      intoMaterial: [MaterialType.SAND, MaterialType.TEPHRA, MaterialType.EMPTY],
      tempRange: [0.05, 0.65],
      // Upper hemisphere only, so a lawn creeps sideways and up over obstacles
      // instead of tunnelling into the soil, and `needsFooting` keeps it on the
      // surface rather than climbing into the air.
      directions: [7, 0, 1, 6, 2],
      needsFooting: true,
      maxNeighbors: 3,
      chance: 0.05,
    },
  },

  // Falls like a powder until it lands on something it can root in, then
  // germinates. Deliberately not static: dispersal is half of what a seed is.
  // Its density must stay below SAND's 10 and at TEPHRA's 7: at 12 it buried
  // itself inside a painted soil mound, and at 9 it sank out of sight into
  // loose ash before it could sprout. Seven rests on tephra (equal density
  // does not displace) and still falls through water, coming to rest on the
  // soil surface where a shoot has open space.
  [MaterialType.SEED]: {
    id: MaterialType.SEED, name: 'Seed', color: [180, 140, 60, 255],
    density: 7, isLiquid: false, isGas: false, flammability: 50, friction: 0.6,
    conductivity: 0.2, emissivity: 0.10,
    growth: {
      kind: 'aggregate',
      // TEPHRA counts as soil: volcanic ash is fertile ground, once it has
      // cooled (see the temperature window).
      contact: [MaterialType.SAND, MaterialType.GRASS, MaterialType.TEPHRA],
      tempRange: [0.05, 0.65],
      into: MaterialType.TREE_TIP,
      chance: 0.25,
      // 10, not 26. Energy is the trunk length in cells, and the showcase's
      // default planet has a radius of 66 — a 26-energy tree plus its limbs
      // stood about three quarters of the way to the planet's centre, which is
      // a beanstalk. This puts a tree at roughly a fifth of the radius.
      state: { energy: 10, dir: 'up', variant: 'random' },
    },
  },

  // The growing point of a tree. On screen for a handful of frames per cell,
  // and given a bright bud colour deliberately: a visible growing tip reads as
  // life happening rather than as machinery leaking through.
  [MaterialType.TREE_TIP]: {
    id: MaterialType.TREE_TIP, name: 'Bud', color: [140, 230, 90, 255],
    density: 20, isLiquid: false, isGas: false, flammability: 40, friction: 0.7,
    isStatic: true, conductivity: 0.2, emissivity: 0.10,
    growth: {
      kind: 'tip',
      becomes: MaterialType.WOOD,
      terminal: MaterialType.LEAF,
      branchTurns: [-1, 1],
      branchChance: 0.18,
      // Limbs are a bit under half the remaining trunk, two generations deep.
      // At 0.55 and three generations the lowest limbs came out longer than
      // the trunk was tall and the tree read as a spider rather than a tree.
      branchTaper: 0.45,
      maxGen: 2,
      branchMinEnergy: 4,
      wobble: 0.15,
      preferOpen: true,
      // A small tree is mostly crown. Foliage fills in along the limbs and the
      // canopy caps each spent tip; between them they close into one mass.
      foliage: { into: MaterialType.LEAF, chance: 0.5 },
      canopy: { into: MaterialType.LEAF, radius: 2 },
      seeds: { into: MaterialType.SEED, chance: 0.1 },
    },
  },

  // Foliage. Static, and that is a trade made with eyes open.
  //
  // `needsSupport` was tried first, for the sake of a canopy that collapses when
  // its trunk burns away. It cannot work: support is satisfied only by
  // `isStructural` cells, and LEAF is deliberately not one (if leaves held up
  // leaves, a collapse would unwind one cell per frame as a slow drizzle). So a
  // leaf could only survive cardinally adjacent to wood — which permits a
  // one-cell fringe along a branch and makes a *canopy* physically impossible.
  // Measured: an 11-energy tree grew as a bare stick with a few green specks.
  //
  // A crown is most of what makes a small tree read as a tree, so it wins. Fire
  // is what removes foliage now, which is both the genre-standard behaviour and
  // still a real composition with the destructive rules — LEAF is the most
  // flammable thing in the table.
  [MaterialType.LEAF]: {
    id: MaterialType.LEAF, name: 'Leaf', color: [60, 150, 60, 255],
    density: 15, isLiquid: false, isGas: false, flammability: 60, friction: 0.6,
    isStatic: true, conductivity: 0.2, emissivity: 0.10,
  },

  // A frond, not a tree: regular pinnae at 90° (`branchEvery` rather than
  // `branchChance`), a shallow hierarchy, and no wood anywhere in it.
  [MaterialType.FERN_TIP]: {
    id: MaterialType.FERN_TIP, name: 'Frond', color: [120, 210, 110, 255],
    density: 20, isLiquid: false, isGas: false, flammability: 50, friction: 0.6,
    isStatic: true, conductivity: 0.2, emissivity: 0.10,
    growth: {
      kind: 'tip',
      becomes: MaterialType.FROND,
      terminal: MaterialType.FROND,
      branchTurns: [-2, 2],
      branchEvery: 2,
      branchTaper: 0.35,
      // One generation, unlike the tree's two. Let pinnae fork again and the
      // gaps between them fill in, and the frond reads as a solid triangle
      // rather than as separate leaflets — the negative space is most of what
      // makes a fern a fern.
      maxGen: 1,
      branchMinEnergy: 3,
      wobble: 0.05,
    },
  },

  // A drifting gas that sets where it lands on reef. The rise bias is why the
  // result combs upward instead of branching — see AggregateRule.
  [MaterialType.SPORE]: {
    id: MaterialType.SPORE, name: 'Spore', color: [200, 235, 205, 130],
    density: -1, isLiquid: false, isGas: true, flammability: 0, friction: 0.1,
    growth: {
      kind: 'aggregate',
      contact: [MaterialType.CORAL, MaterialType.ROCK],
      into: MaterialType.CORAL,
      chance: 0.4,
    },
  },

  [MaterialType.CORAL]: {
    id: MaterialType.CORAL, name: 'Coral', color: [230, 120, 140, 255],
    density: 60, isLiquid: false, isGas: false, flammability: 0, friction: 0.8,
    isStatic: true, conductivity: 0.2, emissivity: 0.10,
  },

  // The fern's blade. Physically identical to LEAF now that foliage is static —
  // it earns its id on palette alone, because a frond and a tree's canopy
  // reading as the same green flattens a mixed planet into one mass of foliage.
  // It was originally a necessity rather than a choice: while LEAF needed
  // support, a plant built entirely of it collapsed into a heap, and a
  // 16-energy fern rendered as a solid triangle of settled debris.
  [MaterialType.FROND]: {
    id: MaterialType.FROND, name: 'Frond', color: [80, 175, 85, 255],
    density: 18, isLiquid: false, isGas: false, flammability: 55, friction: 0.6,
    isStatic: true, conductivity: 0.2, emissivity: 0.10,
  },
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
 * *Is* the early-out at the top of `runCheckerboardUpdate` (minus EMPTY, which
 * is skipped for a different reason), rather than a copy of it. It was a
 * hardcoded id list on both sides until vegetation needed to join: a plant is
 * not a powder, and there is no density that makes GRASS sit on sand rather
 * than sink into it. Now both sides read {@link MaterialDef.isStatic}.
 *
 * The phase-change step needs the same question answered — freezing a *mobile*
 * material into an immobile one mid-air produces a cell that can never fall, so
 * a lava bomb still in flight would set into rock and hang in the sky forever.
 * That guard is only correct if "immobile" means exactly what the movement core
 * means by it, which is why this is one array and not two lists.
 *
 * WOOD is deliberately absent: it is in {@link TERRAIN_SOLIDS} but the core does
 * process it, falling when it loses structural support. See
 * {@link MaterialDef.needsSupport}.
 */
export const isImmobile: readonly boolean[] = materialDefs.map(
  (d) => d.isStatic === true
);

/**
 * Whether each material falls unless a structural neighbour holds it up.
 * Indexed by id. See {@link MaterialDef.needsSupport}.
 */
export const needsSupport: readonly boolean[] = materialDefs.map(
  (d) => d.needsSupport === true
);

/**
 * Whether each material has a {@link GrowthRule}. Indexed by id.
 *
 * Precomputed because it is asked on every {@link PixelEngine.setMaterial} and
 * every {@link PixelEngine.swap} to keep the growth candidate set in sync, and
 * a property lookup on a `MaterialDef` in those paths is measurably worse than
 * one array read.
 */
export const hasGrowth: readonly boolean[] = materialDefs.map(
  (d) => d.growth !== undefined
);

/**
 * Whether each material participates in pressure transport, indexed by id.
 *
 * Precomputed for the same reason {@link hasGrowth} is: the router asks it on
 * every cell it visits, and a property lookup in that hot path is measurably
 * worse than one array read. Today only LAVA sets {@link MaterialDef.pressureResistance}.
 */
export const hasPressure: readonly boolean[] = materialDefs.map(
  (d) => d.pressureResistance !== undefined
);

/**
 * Whether each solid may fracture under sustained pressure, indexed by id.
 * True when {@link MaterialDef.pressureStrength} is set. WALL deliberately
 * sets none; ROCK opts in so a cooling cap can fail.
 */
export const hasPressureStrength: readonly boolean[] = materialDefs.map(
  (d) => d.pressureStrength !== undefined
);

/**
 * Whether each material fragments into tephra when airborne and cold, indexed
 * by id. Today only LAVA sets {@link MaterialDef.fragmentsAt}.
 */
export const hasFragmentation: readonly boolean[] = materialDefs.map(
  (d) => d.fragmentsAt !== undefined
);

/**
 * Whether each material has a {@link MaterialDef.yieldThicknessCurve}, indexed
 * by id. Asked once per lateral-flow test in the movement core, so it is an
 * array read rather than a property probe.
 */
export const hasYieldCurve: readonly boolean[] = materialDefs.map(
  (d) => d.yieldThicknessCurve !== undefined
);

/**
 * The yield thickness of `mat` at temperature `temp`, in cells.
 *
 * The single definition of the rheology curve, shared by the movement core's
 * flow gate and by any host that wants to write the same values into
 * {@link PixelEngine.stiffnessGrid} itself. It used to be duplicated: the
 * engine read a constant while the volcano helper hardcoded an unrelated tier
 * table, and the two disagreed about the cold end by a factor of nearly three.
 *
 * Materials with no curve return their constant {@link MaterialDef.yieldThickness}
 * (or 0, meaning "no yield gate at all").
 */
export function yieldThicknessAt(mat: MaterialType, temp: number): number {
  const def = materialDefs[mat];
  const curve = def.yieldThicknessCurve;
  if (curve === undefined) return def.yieldThickness ?? 0;
  for (let i = 0; i < curve.length; i++) {
    if (temp >= curve[i][0]) return curve[i][1];
  }
  return def.yieldThickness ?? 0;
}

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
