/**
 * PixelEngine — the falling-sand cellular-automaton core.
 *
 * Ported from `arcane-antics/lib/physics/Engine.ts` with three changes:
 *
 *  1. **Rigid bodies removed.** `RigidBody`, `Box2DWorld`, the `Wizard`
 *     game concept, `bodyGrid`, and all body-displacement/drag/relocate
 *     machinery are gone. v1 is a pure particle/grid simulation. The
 *     `explode` API exposes a hook so a future rigid-body layer can apply
 *     its own impulses.
 *
 *  2. **Gravity is pluggable.** Movement rules ask
 *     {@link PixelEngine.gravity} for per-cell direction via
 *     {@link fillNeighborFrame}, instead of assuming "down = +Y".
 *     {@link FlatGravity} reproduces the original behavior byte-for-byte;
 *     {@link RadialGravity} enables circular-planet god games.
 *
 *  3. **Deterministic-core discipline.** No DOM, no `Math.random`, no
 *     `Date.now`, no side effects beyond the grid itself. Fully testable in
 *     Node.
 *
 * The simulation step order, the 2×2 checkerboard update pattern, the
 * frame-alternating scan, the material interaction rules, the chunk system,
 * and the settle detection are all preserved from the original.
 */
import {
  MaterialType,
  Materials,
  materialDefs,
  isTerrainSolid,
  isThermal,
  isImmobile,
  needsSupport,
  hasGrowth,
  hasPressure,
  hasPressureStrength,
  hasFragmentation,
  type Octant,
  type SpreadRule,
  type TipRule,
  type AggregateRule,
} from '../materials/index.js';
import { FlatGravity, type GravityModel } from '../gravity/index.js';
import type { CellOffset, NeighborFrame } from './types.js';
import { fillNeighborFrame, octantOffset } from './neighbors.js';

/** Default simulation seed. */
const DEFAULT_SEED = 12345;

/** Active/render-chunk size, in cells. */
const DEFAULT_CHUNK_SIZE = 32;

/**
 * How far a liquid looks along its level axis for a cell it could descend
 * from. Gates lateral flow so a liquid only moves when the move has a purpose
 * (reaching a descent) — which is what lets a settled pool go quiet instead of
 * shimmering forever. See {@link PixelEngineOptions.liquidDispersion}.
 *
 * 16 is the default. Under flat gravity a pool is perfectly still at any
 * value, and higher values only buy surface flatness (32 → flatness 1 vs 16 →
 * 2 on a deep pour). Under *radial* gravity the trade-off runs the other way:
 * a long probe wraps far enough around the curve to keep finding descents in
 * geometry that no longer matches the source cell, leaving a residual jitter
 * (planet ocean 0 swaps at 16, 1 at 32; scatter-ring 4 at 16, 8 at 32). 16
 * buys a quiet planet for one row of flat-surface unevenness.
 *
 * Steady-state cost is zero regardless: in a packed pool the scan exits at the
 * first non-passable cell, so a higher value only costs while the liquid is
 * genuinely in motion with open space ahead.
 */
const DEFAULT_LIQUID_DISPERSION = 16;

/**
 * How far the levelling pass looks along the surface for a lower resting
 * place. Separate from {@link PixelEngineOptions.liquidDispersion}: that gates
 * one-cell steps in the displacement core, while this bounds a non-local
 * transfer, and the two want different reaches. The residual slope of a
 * levelled pool is roughly one cell per this many cells of span.
 */
const LIQUID_LEVEL_REACH = 32;

/**
 * How far the levelling walk may climb or descend to re-seat itself on the
 * surface after a tangential step. Keeps the re-seat O(1) and stops the walk
 * from chasing a surface down a cliff.
 */
const LIQUID_LEVEL_CLIMB = 4;

/**
 * Default world environment temperature.
 *
 * Chosen so nothing spontaneously transforms on a default world: it sits above
 * `WATER.freezesAt` (0.05) and below `ICE.meltsAt` (0.15), so water stays
 * liquid and ice stays solid at the same ambient. A host that wants a snowball
 * planet sets `ambientTemperature: 0.02` and the oceans freeze on their own —
 * that is the climate dial, and it is why this is a world constant rather than
 * a per-material one.
 */
export const DEFAULT_AMBIENT_TEMPERATURE = 0.1;

/**
 * Temperature change below which the heat field treats a cell as settled.
 *
 * Load-bearing for termination, not an optimization. Diffusion approaches
 * equilibrium asymptotically and never reaches it in floating point, so without
 * an explicit floor a hot cell and a cold neighbour exchange ever-smaller
 * amounts forever, no chunk ever sleeps, and a host tinting by heat re-renders
 * every chunk every frame. With it, a thermally equilibrated region goes quiet
 * and costs nothing, exactly like a settled pool.
 *
 * The cost is a small permanent bias: truncated increments are heat that is
 * never transferred, so a settled system holds a residual gradient of up to
 * roughly this much per edge rather than being exactly flat. That is far below
 * both render resolution and any phase threshold — but it does mean a
 * conservation test must assert to a tolerance derived from this and the cell
 * count, not to float epsilon.
 */
export const HEAT_EPSILON = 1e-4;

/**
 * Maximum per-edge conduction coefficient, before a material's relative
 * {@link MaterialDef.conductivity} scales it down.
 *
 * This is a stability bound, not a taste knob. The update for a cell is
 * `T' = T(1 − Σf) + Σ(f·T_n)`, so the max principle needs the self-weight
 * `1 − Σf` to stay non-negative — i.e. `f ≤ 1/4` on a 4-neighbour stencil.
 * Exceed it and the scheme diverges: a cell at 1.0 with `f = 0.8` and four
 * neighbours at 0.0 moves 3.2 out in one step, landing at −2.2 while each
 * neighbour jumps to 0.8, and the sign flips every step after. Clamping to
 * [0,1] would stop the divergence at the cost of conservation, leaving a
 * flickering checkerboard.
 *
 * 0.25 is the true limit and is not itself wrong — but it is *attained* when
 * all four neighbours have conductivity 1.0, and at exactly zero self-weight
 * the update degenerates into a pure neighbour average, which a two-colour
 * grid oscillates on forever. 0.2 holds the self-weight at ≥ 0.2 for every
 * value the material table can produce, and costs only a slightly slower
 * approach to equilibrium.
 */
export const CONDUCTION_MAX = 0.2;

/**
 * Frames between growth ticks. See {@link PixelEngineOptions.growthInterval}.
 *
 * 4 puts a tip's advance at 15 cells/second, so a 26-energy tree takes under
 * two seconds to grow. Legible rather than instant is the whole point: growth
 * that resolves in a frame reads as a stamp, not as something alive.
 */
const DEFAULT_GROWTH_INTERVAL = 4;

/**
 * Cap on the exponential backoff a saturated spread cell applies to itself, in
 * growth ticks.
 *
 * Growth is spontaneous, so unlike movement it has no natural trigger to go
 * quiet on — a mature grass field would otherwise re-scan its neighbourhood
 * forever, and (worse) keep {@link PixelEngine.growthEventsLastFrame} nonzero
 * so a turn-based host waiting on {@link beginSettle} would never resume. A
 * cell that fails doubles its wait; any {@link wakeChunk} touching it resets
 * that to zero, so a patch re-arms the instant a neighbour changes.
 *
 * 64 ticks is ~4 seconds at the default interval. The re-arm is what makes the
 * number uncritical: it only bounds how long a *genuinely* saturated cell waits
 * before checking a world that nothing has touched.
 */
const GROWTH_BACKOFF_MAX = 64;

// --- Growth state word (see PixelEngine.growthGrid) ------------------------
//
// tip:    bits 0–6 energy 0–127 | 7–9 dir 0–7 | 10–11 gen 0–3 | 12–15 variant
// spread: bits 0–6 backoff | bits 7–13 vigour (remaining `needs` reach)
const GROWTH_ENERGY_MASK = 0x7f;
const GROWTH_DIR_SHIFT = 7;
const GROWTH_GEN_SHIFT = 10;
const GROWTH_VARIANT_SHIFT = 12;
const GROWTH_VIGOUR_SHIFT = 7;

/** Pack a tip's growth state into the 16-bit word. */
export function packGrowth(energy: number, dir: number, gen: number, variant: number): number {
  return (
    (energy & GROWTH_ENERGY_MASK) |
    ((dir & 7) << GROWTH_DIR_SHIFT) |
    ((gen & 3) << GROWTH_GEN_SHIFT) |
    ((variant & 15) << GROWTH_VARIANT_SHIFT)
  );
}

/** Every gravity-relative octant, the default direction set for spreading. */
const ALL_OCTANTS: readonly Octant[] = [0, 1, 2, 3, 4, 5, 6, 7];

/** Unpack a tip's growth state from the 16-bit word. */
export function unpackGrowth(word: number): {
  energy: number;
  dir: Octant;
  gen: number;
  variant: number;
} {
  return {
    energy: word & GROWTH_ENERGY_MASK,
    dir: ((word >> GROWTH_DIR_SHIFT) & 7) as Octant,
    gen: (word >> GROWTH_GEN_SHIFT) & 3,
    variant: (word >> GROWTH_VARIANT_SHIFT) & 15,
  };
}

/**
 * Environment-exchange factor for a cell with no exposed face.
 *
 * Small but deliberately nonzero, so a fully buried flow eventually sets
 * instead of staying molten forever, while a conduit that is recharged every
 * frame stays live.
 */
export const INSULATED_EXPOSURE = 0.02;

/** How many stable frames the grid must be quiet before settle completes. */
export const SETTLE_STABLE_THRESHOLD = 10;

/** Maximum frames {@link beginSettle} will run before forcing completion. */
export const SETTLE_TIMEOUT_FRAMES = 600;

/**
 * Default ceiling on visited cells per pressure-routed volume. Sized for
 * lava-scale conduits and chambers; see {@link PixelEngineOptions.pressureVisitLimit}.
 */
export const DEFAULT_PRESSURE_VISIT_LIMIT = 2048;

/**
 * Default cap on solid cells fractured by pressure per update. One cell per
 * frame keeps a thick plug clearing over multiple frames rather than vanishing
 * instantly.
 */
export const DEFAULT_FRACTURE_PER_FRAME = 1;

// --- Velocity (Phase 6A) ----------------------------------------------------
//
// Velocity is fixed-point: a velocity value of VELOCITY_CELL_UNIT represents
// one cell of displacement per frame. A value of 12 with a unit of 8 means 1.5
// cells/frame — the half-cell carries in a per-cell remainder accumulator so
// small lateral components are not silently truncated away. All values are
// signed Int8, clamped to ±127; drag reduces them toward zero each frame.

/** Fixed-point unit: a velocity of this many sub-cells = one cell/frame. */
export const VELOCITY_CELL_UNIT = 8;

/**
 * Per-frame velocity retention (drag). Each frame both components are multiplied
 * by this factor, so 0.92 halves speed in ~8 frames. Global in Phase 6A;
 * per-material drag (lava losing momentum faster than tephra) is a 6B extension.
 */
export const DEFAULT_VELOCITY_DRAG = 0.92;

/**
 * Fixed-point gravity acceleration per frame², in sub-cell units. Tuned so a
 * freely falling cell accelerates at roughly one cell/frame², matching the
 * existing single-step gravity rule the checkerboard applies.
 */
export const VELOCITY_GRAVITY_SCALE = 8;

/**
 * Efficiency of surplus-pressure-to-velocity conversion at a pressure outlet
 * (Torricelli). Not all hydraulic surplus becomes kinetic energy — some is lost
 * to turbulence, viscosity, and conduit geometry. 0.7 means a parcel launches
 * at 70% of the theoretical √(2gh) speed.
 *
 * This is also what closes the energy double-count: the kinetic head deducted
 * from the source is `(speed/efficiency)² · efficiency² / 2g = surplus ·
 * efficiency²`, which is less than `surplus` when `efficiency < 1`. The
 * remainder stays in the source for subsequent parcels.
 */
export const OUTLET_VELOCITY_EFFICIENCY = 0.7;

/**
 * Lateral spread fraction for outlet velocity. Each launched parcel gets a
 * deterministic lateral component (perpendicular to the exit heading) equal to
 * this fraction of its launch speed, so a fountain fans outward rather than
 * building a one-cell-wide spire. 0.25 means the lateral component is up to
 * 25% of the vertical — enough to build a cone, not so much that ejecta flies
 * sideways.
 */
export const OUTLET_LATERAL_SPREAD = 0.25;

/**
 * Minimum surplus head (in cell-head units) required to write velocity at a
 * pressure outlet. Below this, the cell extrudes and falls normally — the
 * effusive case. Above it, the surplus launches the parcel — the fountain case.
 */
export const MIN_OUTLET_SURPLUS = 2;

/**
 * Scales explosion `force` into a velocity impulse magnitude. Tuned so
 * `force=5, falloff=0.5` gives ~2–3 cells of debris flight before drag and
 * gravity win.
 */
export const EXPLOSION_VELOCITY_SCALE = 4;

/**
 * Optional callback fired by {@link PixelEngine.explode} with the explosion
 * metadata. v1 does not apply rigid-body impulses; this hook exists so a
 * future rigid-body layer (or the host game) can react to explosions
 * (applying forces to its own body system, playing audio, etc.).
 */
export type ExplosionHook = (
  centerX: number,
  centerY: number,
  radius: number,
  force: number,
) => void;

/**
 * Why an {@link injectLiquid} request was not fully accepted.
 *
 * - `unsupportedMaterial` — the material defines no
 *   {@link MaterialDef.pressureResistance} (V1: anything but LAVA). The router
 *   does not even start a search.
 * - `missingPotential` — the gravity model exposes no `potentialAt`, so head
 *   cannot be accounted. Routing is refused rather than pretending uphill is
 *   free.
 * - `incompatibleSource` — the source cell holds another liquid or a solid,
 *   and V1 does not overwrite it. Reactions, dissolution, and drilling are
 *   separate behaviours.
 * - `noOutlet` — the connected component has no EMPTY cardinal neighbour, so
 *   there is nowhere to extrude.
 * - `insufficientHead` — an outlet exists but every reachable one costs more
 *   than the request pressure.
 * - `searchLimit` — the visited-cell ceiling was reached before the search
 *   completed. A valid outlet may lie beyond; this is reported honestly rather
 *   than as `noOutlet`, and no partial candidate is selected.
 */
export type InjectionRejectionReason =
  | 'noOutlet'
  | 'insufficientHead'
  | 'searchLimit'
  | 'unsupportedMaterial'
  | 'incompatibleSource'
  | 'missingPotential';

/**
 * A queued request to inject liquid under pressure, drained during the next
 * {@link PixelEngine.update}. See {@link PixelEngine.injectLiquid}.
 */
export interface LiquidInjection {
  x: number;
  y: number;
  material: MaterialType;
  /** Requested whole-cell volumes for the next update. */
  amount: number;
  /** Maximum hydraulic head available to each volume. */
  pressure: number;
  /** Optional initial parcel temperature. Material `spawnTemp` by default. */
  temperature?: number;
  /** Optional initial packed colour. */
  color?: number;
}

/** Result of one {@link LiquidInjection}, available after the drain. */
export interface InjectionResult {
  /** Correlates with the id returned by {@link PixelEngine.injectLiquid}. */
  requestId: number;
  requested: number;
  accepted: number;
  blocked: number;
  /** Greatest path cost paid by an accepted volume. */
  maxCost: number;
  /** Why work was rejected, when the result was not fully accepted. */
  reason?: InjectionRejectionReason;
}

/** Options for {@link PixelEngine.addPressureSource}. */
export interface PressureSourceOptions {
  /** Source cell x. The body must be cardinally connected from here. */
  x: number;
  /** Source cell y. */
  y: number;
  /** Liquid material. V1: LAVA (the only material with `pressureResistance`). */
  material: MaterialType;
  /** Whole-cell volumes accrued per frame. Fractional rates accumulate a remainder. */
  rate: number;
  /** Hydraulic head accrued per frame while blocked. */
  pressureRate: number;
  /** Cap on available head. Bounds how hard a blocked source can eventually push. */
  maxPressure: number;
  /** Cap on accrued whole-cell volume. Bounds the surge when an outlet opens. */
  maxPending: number;
  /** Initial parcel temperature. Material `spawnTemp` by default. */
  temperature?: number;
  /**
   * Fraction of surplus head converted to outlet launch velocity (Torricelli).
   * Default {@link OUTLET_VELOCITY_EFFICIENCY} (0.7). Lower values leave more
   * head in the source for subsequent parcels; higher values produce faster
   * single-parcel launches. The explosive source can set this independently of
   * the effusive source.
   */
  outletVelocityEfficiency?: number;
}

/** Readable snapshot of a persistent source's accumulated state. */
export interface PressureSourceState {
  id: number;
  x: number;
  y: number;
  material: MaterialType;
  pending: number;
  availablePressure: number;
}

/**
 * Internal persistent source record. Volume accrues in `pending` at `rate` each
 * frame (with a fixed-point remainder for fractional rates); available head
 * accrues at `pressureRate` while blocked, up to `maxPressure`. On a successful
 * route, the path cost is deducted from `availablePressure` and one cell from
 * `pending`. This is what produces a bounded surge after a plug clears rather
 * than discarding every blocked frame.
 */
interface PressureSource {
  id: number;
  x: number;
  y: number;
  material: MaterialType;
  rate: number;
  pressureRate: number;
  maxPressure: number;
  maxPending: number;
  temperature: number | undefined;
  outletVelocityEfficiency: number;
  /** Accrued whole-cell volumes waiting for an outlet. */
  pending: number;
  /** Fractional volume remainder, for rates < 1. */
  pendingRem: number;
  /** Available hydraulic head, accrued while blocked. */
  availablePressure: number;
}

/** Construction options for {@link PixelEngine}. */
export interface PixelEngineOptions {
  /** Grid width in cells. */
  width: number;
  /** Grid height in cells. */
  height: number;
  /** RNG seed. Same seed + same calls → identical evolution. Default 12345. */
  seed?: number;
  /** Gravity model. Default {@link FlatGravity}. */
  gravity?: GravityModel;
  /** Chunk size in cells. Default 32. Rarely needs changing. */
  chunkSize?: number;
  /**
   * How far a liquid looks along its level axis for a cell it could descend
   * from, in cells. Higher values level a pool flatter at the cost of a
   * longer per-cell scan while the liquid is in motion. The scan exits early
   * once it hits a non-passable cell, so cost is only paid by liquid that is
   * genuinely in motion with open space ahead. Default 32.
   */
  liquidDispersion?: number;
  /**
   * Optional explosion callback. Fired at the end of {@link explode} with
   * the explosion's center, radius, and force. Default: no-op.
   */
  onExplode?: ExplosionHook;
  /**
   * Allocate {@link PixelEngine.heatGrid} at construction. Default false.
   *
   * Not a performance flag. Allocation has to *seed* every cell from its
   * material's `spawnTemp` rather than zero-fill (see
   * {@link PixelEngine.setHeat}), which is an O(cells) sweep; this makes that
   * sweep happen at a predictable moment instead of partway through a
   * simulation.
   */
  enableHeat?: boolean;
  /**
   * The environment temperature every exposed cell exchanges toward, 0–1.
   * Default {@link DEFAULT_AMBIENT_TEMPERATURE}. This is the climate dial:
   * turn it down and oceans freeze on their own.
   */
  ambientTemperature?: number;
  /**
   * Frames between growth ticks. Default {@link DEFAULT_GROWTH_INTERVAL} (4).
   *
   * The pacing dial for everything alive: raise it and a forest takes longer to
   * establish, lower it and growth starts to look like a stamp rather than a
   * process. Costs nothing in a world with no growing materials, where the pass
   * never runs at all.
   */
  growthInterval?: number;
  /**
   * Hard ceiling on visited cells per pressure-routed volume, as a safety
   * guard against runaway searches. Default {@link DEFAULT_PRESSURE_VISIT_LIMIT}.
   *
   * V1 supports high-resistance lava in bounded chambers and conduits, where
   * the head budget expires well before this many cells. The ceiling also acts
   * as a correctness limit: a valid low-resistance component can contain an
   * affordable outlet beyond it, in which case routing returns `searchLimit`
   * honestly rather than selecting a partial candidate or claiming no outlet.
   * Raising it trades a wider search against per-frame cost.
   */
  pressureVisitLimit?: number;
  /**
   * Maximum solid cells fractured by pressure in one update. Default 1.
   *
   * Bounds the rate at which a blocked source can break through rock: a cap
   * fractures one cell per frame at most, so clearing a thick plug takes
   * multiple frames rather than vanishing a mountain in one step. Each fracture
   * also consumes pressure equal to the solid's `pressureStrength`, so a
   * weakened source stops breaking until it has accumulated more.
   */
  fracturePerFrame?: number;
}

/**
 * The falling-sand simulation.
 *
 * Construct once, mutate via {@link setMaterial} / {@link swap} /
 * {@link explode}, advance via {@link update}, and read `grid` /
 * `colorGrid` / {@link consumeRenderDirtyChunks} for rendering.
 */
export class PixelEngine {
  readonly width: number;
  readonly height: number;
  /** Material id per cell. `Uint8Array` of length `width * height`. */
  readonly grid: Uint8Array;
  /**
   * Optional per-cell packed RGBA color (0xAABBGGRR). When present, the
   * engine keeps it in sync with {@link grid} on swaps and uses it to carry
   * custom colors (e.g. explosion debris). Lazily allocated on first write.
   */
  colorGrid: Uint32Array | null = null;
  /**
   * Optional per-cell override of {@link MaterialDef.yieldThickness}, in cells.
   * `0` (the default everywhere) means "use the material's own value".
   *
   * Like {@link colorGrid} this rides with the material: the engine keeps it in
   * sync on swaps and levelling transfers, so a stiffened parcel of fluid stays
   * stiff as it moves. Lazily allocated on first write.
   *
   * It exists because yield strength is not really a constant of the material —
   * for lava it is a strong function of temperature, rising by orders of
   * magnitude as the melt cools and crystallizes. That single dependence is what
   * shapes a real flow: the hot core stays mobile while the chilled margins and
   * the flow front stiffen first, which is what builds levees, gives the front
   * its blunt snout, and stops the flow at a finite length. A host that tracks
   * temperature writes it here; a host that does not can ignore the field
   * entirely and get the material's constant.
   */
  stiffnessGrid: Uint8Array | null = null;
  /**
   * Optional per-cell temperature in `[0, 1]`. `null` until
   * {@link PixelEngineOptions.enableHeat} or the first {@link setHeat}.
   *
   * Like {@link stiffnessGrid} this rides with the material through swaps and
   * levelling transfers, so a hot parcel of lava stays hot as it flows. A host
   * that never allocates it pays nothing.
   *
   * Unlike the other optional grids, this one is **never zero-filled**. `0` is a
   * legitimate temperature — it is, in fact, frozen — so it cannot double as the
   * "unset, use the material's value" sentinel that `colorGrid` and
   * `stiffnessGrid` rely on. A zero-filled heat grid would assert that every
   * cell in the world is at absolute cold, and the first phase-change pass would
   * flash every lava cell to rock. Allocation therefore seeds; see
   * {@link setHeat}.
   */
  heatGrid: Float32Array | null = null;
  /**
   * Optional per-cell growth state. `null` until the first {@link plant} or
   * growth write. Rides with the material through swaps, like
   * {@link stiffnessGrid}, and is cleared by {@link setMaterial} on a material
   * change — a trunk carries none of the tip's heading that left it behind.
   *
   * The word is interpreted by the cell's {@link GrowthRule} kind:
   *
   * ```
   *  tip:     bits 0–6   energy   0–127  remaining growth budget
   *           bits 7–9   dir      0–7    gravity-relative octant heading
   *           bits 10–11 gen      0–3    branch depth
   *           bits 12–15 variant  0–15   per-plant genome (branch mask)
   *
   *  spread:  bits 0–6   backoff         growth ticks until the next attempt
   * ```
   *
   * Directed growth is impossible without per-cell memory, which is why every
   * mature falling-sand sim has a field like this: The Powder Toy packs
   * `(life | direction | phase)` into a particle's `ctype`, Sandspiel keeps two
   * spare registers (`ra`/`rb`) on every cell. Without it a growth rule can only
   * copy itself into a neighbour, and isotropic copying produces a blob however
   * it is tuned — no trunk, no branches, no silhouette.
   *
   * `variant` is the genome: rolled once when a plant is seeded, inherited
   * unchanged by every branch, and used as a mask over {@link TipRule.branchTurns}.
   * Sixteen silhouettes from one material, all deterministic, which is what
   * keeps a forest from looking stamped.
   *
   * @see packGrowth
   * @see unpackGrowth
   */
  growthGrid: Uint16Array | null = null;
  /** Per-cell "already processed this frame" flag. */
  readonly updated: Uint8Array;
  /**
   * Per-cell liquid flow-direction memory (velocity sign), used as the
   * tiebreak when a liquid could productively flow either way. `+1` = the
   * cell's level-axis "right", `-1` = "left", `0` = none. It does NOT by
   * itself stop a pool from shimmering — the lateral-flow gate (`flowRun`)
   * does that, by refusing to move a liquid that has nowhere to descend to.
   * This memory just keeps a viable flow committed to one direction instead
   * of dithering. The sign is frame-local (relative to the cell's current
   * level axis), so it stays meaningful under any gravity model.
   */
  readonly liquidVel: Int8Array;
  /** Frames stepped so far. Drives the frame-alternating scan direction. */
  frameCount = 0;

  readonly CHUNK_SIZE: number;
  /** Lookahead distance for the liquid lateral-flow purpose-gate. */
  readonly liquidDispersion: number;
  readonly chunkWidth: number;
  readonly chunkHeight: number;
  /** Chunks to simulate this frame. */
  activeChunks: Uint8Array;
  nextActiveChunks: Uint8Array;
  /** Chunks whose contents changed and need re-rendering. */
  renderDirtyChunks: Uint8Array;
  /**
   * Chunks with heat still in motion, to be stepped next frame.
   *
   * Deliberately **separate from {@link activeChunks}**, and the distinction is
   * load-bearing rather than tidiness. A crusted lava flow is motionless: zero
   * swaps, movement chunk asleep — and it must still be cooling. Reusing the
   * movement activity set would stop it cooling the moment it stopped moving,
   * which is precisely the case the heat field exists to serve.
   *
   * The inverse matters too: a settled world must cost nothing (see
   * {@link runLiquidLevelling}, which was made chunk-major for exactly this
   * reason), so the heat step cannot simply scan the grid. Null when heat is
   * disabled.
   */
  thermalChunks: Uint8Array | null = null;
  /** Thermal chunks to step next frame. Swapped with {@link thermalChunks}. */
  nextThermalChunks: Uint8Array | null = null;

  /** The gravity model driving movement direction. */
  readonly gravity: GravityModel;

  private _ambientTemperature: number;

  /**
   * The environment temperature exposed cells exchange toward. See
   * {@link PixelEngineOptions.ambientTemperature}.
   *
   * Writable at runtime — this is the climate dial, and seasons, day/night, or
   * a terraforming verb all want to turn it while the world is running. Setting
   * it wakes every thermal chunk, because it moves the equilibrium of every
   * cell in the world including those in regions that had settled and gone
   * quiet; without that the change would only reach whatever happened to still
   * be thermally active.
   */
  get ambientTemperature(): number {
    return this._ambientTemperature;
  }

  set ambientTemperature(v: number) {
    if (v === this._ambientTemperature) return;
    this._ambientTemperature = v;
    if (this.thermalChunks) this.thermalChunks.fill(1);
    if (this.nextThermalChunks) this.nextThermalChunks.fill(1);
  }

  /**
   * Per-cell heat flux accumulator for the conduction pass, in temperature
   * units. Allocated alongside {@link heatGrid}.
   *
   * Conduction is accumulated as edge fluxes here and applied in a second pass,
   * rather than computed cell-by-cell into a scratch temperature buffer. That
   * is what makes conservation exact: each edge is visited once and both of its
   * endpoints are updated by the same amount with opposite signs, so heat
   * cannot be created at a boundary between materials of differing
   * conductivity.
   */
  private _heatDelta: Float32Array | null = null;

  /**
   * The gravity model's potential field, pre-bound, or `null` when the model
   * does not provide one. Cached at construction so the hot loop neither
   * re-checks for the optional method nor allocates a bound function.
   */
  private readonly _potentialAt: ((x: number, y: number) => number) | null;

  /**
   * The gravity model's magnitude field, pre-bound, or `null` when the model
   * does not provide one. Consumed by the velocity pass to accelerate ballistic
   * cells. Defaults to uniform 1.0 — see {@link GravityModel.magnitudeAt}.
   */
  private readonly _magnitudeAt: ((x: number, y: number) => number) | null;

  /**
   * Indices of cells whose material has a {@link GrowthRule} — the growth pass's
   * work list, and the reason its cost is proportional to the amount of life in
   * the world rather than to the size of the grid.
   *
   * ## The membership invariant
   *
   * > Every cell whose material has a growth rule is in this set.
   *
   * A *superset*, deliberately, not an exact correspondence. {@link setMaterial}
   * and {@link swap} maintain it precisely, but the reaction steps write
   * `this.grid[i]` directly — so grass burning to FIRE leaves its index behind.
   * That is safe, and it is safe for a reason worth stating: **no direct write
   * anywhere in the engine produces a material that has a growth rule** (they
   * produce FIRE, WATER, STEAM, ROCK, SMOKE, EMPTY), so a stale entry can only
   * ever be spurious, never missing. {@link runGrowth} re-reads each cell's
   * material and drops the ones that no longer qualify, which makes the set
   * exact again after every growth tick.
   *
   * The superset property is what the *behaviour* depends on: a missing entry
   * would be a plant that silently stopped growing, while a stale one costs one
   * array read and is then gone.
   *
   * Membership is a pure function of the grid, never of history, so
   * {@link rebuildGrowthCells} restores it exactly after deserialization — a
   * world loaded from a saved grid grows identically to the one that was saved.
   */
  readonly growthCells: Set<number> = new Set();

  /** Frames between growth ticks. See {@link PixelEngineOptions.growthInterval}. */
  readonly growthInterval: number;

  private _rngState: number;
  private _growthEventsThisFrame = 0;
  private _swapsThisFrame = 0;
  private _settleFrameCount = 0;
  private _settling = false;
  private _settled = false;
  private _stableFrames = 0;

  private _renderDirtyAll = true;

  private readonly _onExplode: ExplosionHook;

  private readonly _frame: NeighborFrame = {
    down: { dx: 0, dy: 0 },
    downLeft: { dx: 0, dy: 0 },
    downRight: { dx: 0, dy: 0 },
    left: { dx: 0, dy: 0 },
    right: { dx: 0, dy: 0 },
  };

  /**
   * Scratch frame for {@link flowRun}'s probe walk. Separate from
   * {@link _frame}, which holds the *source* cell's frame for the duration of
   * the cell's turn in the update loop and must not be clobbered mid-probe.
   */
  private readonly _probeFrame: NeighborFrame = {
    down: { dx: 0, dy: 0 },
    downLeft: { dx: 0, dy: 0 },
    downRight: { dx: 0, dy: 0 },
    left: { dx: 0, dy: 0 },
    right: { dx: 0, dy: 0 },
  };

  /** Scratch frame and offset for the growth pass. */
  private readonly _growthFrame: NeighborFrame = {
    down: { dx: 0, dy: 0 },
    downLeft: { dx: 0, dy: 0 },
    downRight: { dx: 0, dy: 0 },
    left: { dx: 0, dy: 0 },
    right: { dx: 0, dy: 0 },
  };
  private readonly _growthOffset: CellOffset = { dx: 0, dy: 0 };
  /** Reused candidate buffers, so the growth pass allocates nothing per cell. */
  private readonly _growthTargets: number[] = [];
  private readonly _growthHeadings: number[] = [];
  private readonly _growthScores: number[] = [];
  /**
   * Cells written by the growth pass this tick.
   *
   * A tip that advances into a cell later in the sorted snapshot would
   * otherwise take a second turn in the same tick and grow at double rate. This
   * cannot use the `updated` flags: those are cleared per *active chunk* at the
   * top of the next frame, and growth deliberately reaches into sleeping ones.
   */
  private readonly _growthTouched: Set<number> = new Set();

  // ----------------------------------------------------------------- pressure
  //
  // All pressure state is lazily allocated on the first `injectLiquid`, so a
  // world that never uses pressure pays nothing — no array, no per-frame work,
  // no draw from the RNG (the router is fully deterministic from grid state).
  /** FIFO queue of pending injection requests, drained each update. */
  private _injectionQueue: { id: number; req: LiquidInjection }[] = [];
  /** Results from the most recent drain, consumed by the host. */
  private _injectionResults: InjectionResult[] = [];
  private _nextRequestId = 1;
  private _pressureMovesThisFrame = 0;
  private _pressureCellsVisitedThisFrame = 0;
  private _blockedInjectionsThisFrame = 0;
  /** Solid cells fractured this update; reset in {@link update}. */
  private _fracturesThisFrame = 0;
  /** Velocity-driven moves this frame; reset in {@link update}. */
  private _velocityMovesThisFrame = 0;
  /** Visited-cell ceiling per routed volume. See PixelEngineOptions. */
  readonly pressureVisitLimit: number;
  /** Cap on fractures per update. See PixelEngineOptions.fracturePerFrame. */
  readonly fracturePerFrame: number;
  /**
   * Reused Dijkstra scratch, allocated on first `injectLiquid`. Generation-
   * stamped so a search costs no full-array clear: `_pressGen` is incremented
   * per volume and a cell is "visited this search" when its stamp equals it.
   */
  private _pressVisited: Uint32Array | null = null;
  private _pressGen = 0;
  private _pressCost: Float64Array | null = null;
  /** Parent index for path reconstruction, or -1 for the source. */
  private _pressParent: Int32Array | null = null;
  /** Path length (edge count) to each cell, for the shorter-path tiebreak. */
  private _pressHops: Int32Array | null = null;
  /**
   * Binary-heap index queue of settled-pending cells. Holds cell indices keyed
   * by accumulated cost; reused across volumes to avoid per-search allocation.
   */
  private _pressHeap: Int32Array | null = null;
  private _pressHeapSize = 0;
  /** Heap keys parallel to {@link _pressHeap}: the cost at each heap slot. */
  private _pressHeapCost: Float64Array | null = null;
  /**
   * Persistent pressure sources, in creation order. Processed each frame to
   * accrue volume/pressure and route accumulated volume through the same
   * machinery as one-shot injections. An empty array (the default) costs one
   * length check per frame.
   */
  private _pressureSources: PressureSource[] = [];
  private _nextSourceId = 1;

  // ----------------------------------------------------------- velocity (6A)
  //
  // Per-cell ballistic velocity in fixed-point sub-cell units, lazily allocated
  // on first impulse. A world that never imparts velocity pays nothing — no
  // arrays, no per-frame scan, no draw from the RNG. Zero = at rest.
  /**
   * X-component of velocity, in sub-cell units (see {@link VELOCITY_CELL_UNIT}).
   * Positive = +x (right). `null` until the first {@link setVelocity}/
   * {@link applyImpulse}.
   */
  velX: Int8Array | null = null;
  /** Y-component of velocity. Positive = +y (down in screen space). */
  velY: Int8Array | null = null;
  /**
   * Sub-cell displacement remainder for X. Without this, a velocity of 12 at
   * unit 8 (1.5 cells/frame) would floor to 1 cell/frame, losing half a cell
   * every frame and silently zeroing small lateral components. The remainder
   * carries the fractional part forward.
   */
  velRemX: Int8Array | null = null;
  /** Sub-cell displacement remainder for Y. */
  velRemY: Int8Array | null = null;
  /**
   * Indices of cells with nonzero velocity — the velocity pass's work list.
   * Maintained on write (add on impulse, remove when drag zeroes velocity), so
   * the integration pass is O(active velocity cells), not O(grid). A snapshot is
   * taken before each pass so a cell that moves during the pass is not processed
   * twice.
   */
  readonly velCells: Set<number> = new Set();
  /** Per-frame velocity drag, applied to both components each step. */
  readonly velocityDrag: number;

  constructor(options: PixelEngineOptions) {
    const { width, height } = options;
    this.width = width;
    this.height = height;
    this.grid = new Uint8Array(width * height);
    this.updated = new Uint8Array(width * height);
    this.liquidVel = new Int8Array(width * height);
    this._rngState = (options.seed ?? DEFAULT_SEED) | 0;
    this.gravity = options.gravity ?? new FlatGravity();
    this._potentialAt = this.gravity.potentialAt
      ? this.gravity.potentialAt.bind(this.gravity)
      : null;
    // Gravity magnitude: consumed by the velocity pass to accelerate cells.
    // Optional on the interface; defaults to uniform 1.0 — see gravity/types.ts.
    this._magnitudeAt = this.gravity.magnitudeAt
      ? this.gravity.magnitudeAt.bind(this.gravity)
      : null;
    this.CHUNK_SIZE = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.liquidDispersion = options.liquidDispersion ?? DEFAULT_LIQUID_DISPERSION;
    this.growthInterval = Math.max(1, options.growthInterval ?? DEFAULT_GROWTH_INTERVAL);
    this.pressureVisitLimit = Math.max(1, options.pressureVisitLimit ?? DEFAULT_PRESSURE_VISIT_LIMIT);
    this.fracturePerFrame = Math.max(0, options.fracturePerFrame ?? DEFAULT_FRACTURE_PER_FRAME);
    this.velocityDrag = DEFAULT_VELOCITY_DRAG;
    this._onExplode = options.onExplode ?? (() => {});
    this._ambientTemperature = options.ambientTemperature ?? DEFAULT_AMBIENT_TEMPERATURE;

    this.chunkWidth = Math.ceil(width / this.CHUNK_SIZE);
    this.chunkHeight = Math.ceil(height / this.CHUNK_SIZE);
    this.activeChunks = new Uint8Array(this.chunkWidth * this.chunkHeight);
    this.nextActiveChunks = new Uint8Array(this.chunkWidth * this.chunkHeight);
    this.renderDirtyChunks = new Uint8Array(this.chunkWidth * this.chunkHeight);

    this.clear();

    // After clear(), so the seeding sweep reads an EMPTY grid and lands every
    // cell on ambient rather than on stale material temperatures.
    if (options.enableHeat) this.allocHeat();
  }

  /**
   * Allocate and **seed** the heat field, plus its scratch buffer and thermal
   * chunk sets. Idempotent.
   *
   * The seeding is the whole point, and it is why this cannot be the one-line
   * lazy `new Float32Array(n)` that {@link colorGrid} and {@link stiffnessGrid}
   * get away with. Those can zero-fill because `0` means "no override" for them.
   * Heat has no spare value: a zero-filled grid says the entire world is at
   * absolute cold, so a single {@link setHeat} call would allocate it and the
   * next phase-change pass would turn every lava cell on the map to rock.
   *
   * One O(cells) sweep, once. {@link PixelEngineOptions.enableHeat} exists so a
   * host can choose when to pay it.
   */
  private allocHeat(): Float32Array {
    if (this.heatGrid) return this.heatGrid;
    const n = this.width * this.height;
    const h = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const st = materialDefs[this.grid[i]].spawnTemp;
      h[i] = st === undefined ? this.ambientTemperature : st;
    }
    this._heatDelta = new Float32Array(n);
    const chunks = this.chunkWidth * this.chunkHeight;
    this.thermalChunks = new Uint8Array(chunks);
    this.nextThermalChunks = new Uint8Array(chunks);
    // Everything that exists is potentially off-equilibrium; let the first heat
    // step decide what is actually quiet.
    this.thermalChunks.fill(1);
    this.nextThermalChunks.fill(1);
    return (this.heatGrid = h);
  }

  /**
   * Mark the chunk containing `(x, y)` as thermally active next frame, plus its
   * border neighbors if the cell sits on a chunk edge — so heat crossing a
   * boundary keeps the destination alive. The thermal mirror of
   * {@link wakeChunk}.
   */
  wakeThermalChunk(x: number, y: number): void {
    const next = this.nextThermalChunks;
    if (next === null) return;
    const cx = Math.floor(x / this.CHUNK_SIZE);
    const cy = Math.floor(y / this.CHUNK_SIZE);
    if (cx < 0 || cx >= this.chunkWidth || cy < 0 || cy >= this.chunkHeight) return;
    next[cy * this.chunkWidth + cx] = 1;

    const localX = x % this.CHUNK_SIZE;
    const localY = y % this.CHUNK_SIZE;

    if (localX === 0 && cx > 0) next[cy * this.chunkWidth + cx - 1] = 1;
    if (localX === this.CHUNK_SIZE - 1 && cx < this.chunkWidth - 1) next[cy * this.chunkWidth + cx + 1] = 1;
    if (localY === 0 && cy > 0) next[(cy - 1) * this.chunkWidth + cx] = 1;
    if (localY === this.CHUNK_SIZE - 1 && cy < this.chunkHeight - 1) next[(cy + 1) * this.chunkWidth + cx] = 1;
  }

  /**
   * Write a cell's temperature, clamped to `[0, 1]`.
   *
   * Allocates and seeds {@link heatGrid} on first call — see {@link allocHeat}
   * for why that is a sweep rather than a zero-fill.
   *
   * Call this *after* {@link setMaterial}, never before: a material change
   * resets the cell's heat to the new material's `spawnTemp`, so a temperature
   * written first is discarded.
   */
  setHeat(x: number, y: number, t: number): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const h = this.heatGrid ?? this.allocHeat();
    h[this.getIndex(x, y)] = t < 0 ? 0 : t > 1 ? 1 : t;
    this.wakeThermalChunk(x, y);
    this.markRenderDirty(x, y);
  }

  /**
   * Temperature at `(x, y)` in `[0, 1]`.
   *
   * When {@link heatGrid} is unallocated this reports what the cell *would* be
   * born at — its material's `spawnTemp`, or the world ambient — so a host can
   * ask "how hot is this?" without deciding to track heat. Once allocated there
   * is no fallback path: every cell holds a real value.
   */
  getHeat(x: number, y: number): number {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return this.ambientTemperature;
    const idx = this.getIndex(x, y);
    if (this.heatGrid) return this.heatGrid[idx];
    return materialDefs[this.grid[idx]].spawnTemp ?? this.ambientTemperature;
  }

  /** Seeded mulberry32-style PRNG. Use this — never `Math.random()`. */
  random(): number {
    this._rngState = (this._rngState + 0x6d2b79f5) | 0;
    let t = Math.imul(this._rngState ^ (this._rngState >>> 15), 1 | this._rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Reset the grid to empty and wake every chunk. */
  clear(): void {
    this.grid.fill(MaterialType.EMPTY);
    if (this.colorGrid) this.colorGrid.fill(0);
    if (this.stiffnessGrid) this.stiffnessGrid.fill(0);
    if (this.growthGrid) this.growthGrid.fill(0);
    this.growthCells.clear();
    // Pressure sources and queued injections are host-authored state that must
    // not survive a clear: a source left alive would pump into the empty grid
    // next frame, creating material from nothing.
    this._pressureSources = [];
    this._injectionQueue = [];
    this._injectionResults = [];
    // Ambient, not zero: the grid is now all EMPTY, and EMPTY has no spawnTemp.
    // Zero-filling would leave a cleared world at absolute cold.
    if (this.heatGrid) this.heatGrid.fill(this.ambientTemperature);
    if (this.thermalChunks) this.thermalChunks.fill(1);
    if (this.nextThermalChunks) this.nextThermalChunks.fill(1);
    this.updated.fill(0);
    this.liquidVel.fill(0);
    if (this.velX) this.velX.fill(0);
    if (this.velY) this.velY.fill(0);
    if (this.velRemX) this.velRemX.fill(0);
    if (this.velRemY) this.velRemY.fill(0);
    this.velCells.clear();
    this.activeChunks.fill(1);
    this.nextActiveChunks.fill(1);
    this.renderDirtyChunks.fill(1);
    this._renderDirtyAll = true;
  }

  /** Flat index for cell `(x, y)`. No bounds check. */
  getIndex(x: number, y: number): number {
    return y * this.width + x;
  }

  /** Mark the chunk containing `(x, y)` as needing re-render. */
  markRenderDirty(x: number, y: number): void {
    const cx = Math.floor(x / this.CHUNK_SIZE);
    const cy = Math.floor(y / this.CHUNK_SIZE);
    if (cx >= 0 && cx < this.chunkWidth && cy >= 0 && cy < this.chunkHeight) {
      this.renderDirtyChunks[cy * this.chunkWidth + cx] = 1;
    }
  }

  /**
   * Return and reset the set of render-dirty chunks.
   *
   * The returned `Uint8Array` is a fresh copy; the engine's internal dirty
   * set is cleared. On the first call after construction (or {@link clear}),
   * every chunk is reported dirty so the renderer can do an initial full
   * paint.
   */
  consumeRenderDirtyChunks(): Uint8Array {
    if (this._renderDirtyAll) {
      this._renderDirtyAll = false;
      const result = new Uint8Array(this.chunkWidth * this.chunkHeight);
      result.fill(1);
      this.renderDirtyChunks.fill(0);
      return result;
    }
    const result = new Uint8Array(this.renderDirtyChunks);
    this.renderDirtyChunks.fill(0);
    return result;
  }

  /**
   * Activate a chunk for simulation next frame, plus its border neighbors
   * if the cell sits on a chunk edge (so flow crossing chunk boundaries
   * keeps the destination alive).
   */
  wakeChunk(x: number, y: number): void {
    const cx = Math.floor(x / this.CHUNK_SIZE);
    const cy = Math.floor(y / this.CHUNK_SIZE);
    if (cx < 0 || cx >= this.chunkWidth || cy < 0 || cy >= this.chunkHeight) return;
    this.nextActiveChunks[cy * this.chunkWidth + cx] = 1;

    const localX = x % this.CHUNK_SIZE;
    const localY = y % this.CHUNK_SIZE;

    if (localX === 0 && cx > 0) this.nextActiveChunks[cy * this.chunkWidth + cx - 1] = 1;
    if (localX === this.CHUNK_SIZE - 1 && cx < this.chunkWidth - 1) this.nextActiveChunks[cy * this.chunkWidth + cx + 1] = 1;
    if (localY === 0 && cy > 0) this.nextActiveChunks[(cy - 1) * this.chunkWidth + cx] = 1;
    if (localY === this.CHUNK_SIZE - 1 && cy < this.chunkHeight - 1) this.nextActiveChunks[(cy + 1) * this.chunkWidth + cx] = 1;
  }

  /** True if `(x, y)` holds a solid (non-empty, non-liquid, non-gas). Out of bounds = solid. */
  isSolid(x: number, y: number): boolean {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return true;
    const mat = this.grid[this.getIndex(x, y)];
    if (mat === MaterialType.EMPTY) return false;
    return !materialDefs[mat].isGas && !materialDefs[mat].isLiquid;
  }

  /** True if `(x, y)` is a load-bearing structural solid (WOOD/WALL/ROCK/ICE). Out of bounds = solid. */
  isStructural(x: number, y: number): boolean {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return true;
    const mat = this.grid[this.getIndex(x, y)];
    return (
      mat === MaterialType.WOOD ||
      mat === MaterialType.WALL ||
      mat === MaterialType.ROCK ||
      mat === MaterialType.ICE
    );
  }

  /** Material at `(x, y)`. Out of bounds reports as WALL. */
  getMaterial(x: number, y: number): MaterialType {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return MaterialType.WALL;
    return this.grid[this.getIndex(x, y)] as MaterialType;
  }

  /** Set the material at `(x, y)`, tracking terrain-dirty and render-dirty. */
  setMaterial(x: number, y: number, mat: MaterialType): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const idx = this.getIndex(x, y);
    const oldMat = this.grid[idx];
    if (isTerrainSolid(oldMat) || isTerrainSolid(mat)) {
      // v1 has no rigid-body terrain to rebuild, but we keep the semantic
      // flag available for a future layer / for consumer inspection.
    }
    if (oldMat !== mat) {
      if (this.colorGrid) this.colorGrid[idx] = 0;
      // A cell that has become a different material carries none of the old
      // one's rheology.
      if (this.stiffnessGrid) this.stiffnessGrid[idx] = 0;
      // ...nor its growth state. The trunk a tip leaves behind must not inherit
      // the tip's heading and energy, or it would resume growing on its own.
      if (this.growthGrid) this.growthGrid[idx] = 0;
      if (hasGrowth[mat]) this.growthCells.add(idx);
      else if (hasGrowth[oldMat]) this.growthCells.delete(idx);
      // ...but it is born at its own temperature rather than reset to nothing,
      // which is the one place heat differs from the grids above: a freshly
      // spawned LAVA cell is born hot, and that is the point. A caller that
      // wants a specific temperature calls setHeat *after* this.
      if (this.heatGrid) {
        this.heatGrid[idx] = materialDefs[mat].spawnTemp ?? this.ambientTemperature;
        this.wakeThermalChunk(x, y);
      }
    }
    // A freshly-placed cell carries no flow direction.
    this.liquidVel[idx] = 0;
    // A material change resets velocity — a phase-changed cell starts at rest.
    // Only zeroed when the material actually changed, so a caller that re-sets
    // the same material (e.g. pressure's source write) does not clobber velocity
    // that `copyParcel` may have placed.
    if (oldMat !== mat && this.velX) {
      const vx = this.velX, vy = this.velY!, rx = this.velRemX!, ry = this.velRemY!;
      vx[idx] = 0; vy[idx] = 0; rx[idx] = 0; ry[idx] = 0;
      this.velCells.delete(idx);
    }
    this.grid[idx] = mat;
    this.wakeChunk(x, y);
    this.markRenderDirty(x, y);
  }

  /**
   * Swap the materials at two cells. Keeps `colorGrid` (if present) in sync,
   * marks both cells processed-this-frame, wakes chunks, and flags render
   * dirtiness. Terrain-dirty is tracked when a structural solid moves.
   */
  swap(x1: number, y1: number, x2: number, y2: number): void {
    const idx1 = this.getIndex(x1, y1);
    const idx2 = this.getIndex(x2, y2);
    const m1 = this.grid[idx1];
    const m2 = this.grid[idx2];
    this.grid[idx1] = m2;
    this.grid[idx2] = m1;
    this.updated[idx1] = 1;
    this.updated[idx2] = 1;
    const v1 = this.liquidVel[idx1];
    this.liquidVel[idx1] = this.liquidVel[idx2];
    this.liquidVel[idx2] = v1;
    if (this.colorGrid) {
      const c1 = this.colorGrid[idx1];
      this.colorGrid[idx1] = this.colorGrid[idx2];
      this.colorGrid[idx2] = c1;
    }
    if (this.stiffnessGrid) {
      const s1 = this.stiffnessGrid[idx1];
      this.stiffnessGrid[idx1] = this.stiffnessGrid[idx2];
      this.stiffnessGrid[idx2] = s1;
    }
    if (this.growthGrid) {
      const g1 = this.growthGrid[idx1];
      this.growthGrid[idx1] = this.growthGrid[idx2];
      this.growthGrid[idx2] = g1;
    }
    // Membership follows the material, not the cell. Only a growth-capable
    // material can be involved at all, so a world with no life pays one test.
    if (hasGrowth[m1] || hasGrowth[m2]) {
      if (hasGrowth[m2]) this.growthCells.add(idx1);
      else this.growthCells.delete(idx1);
      if (hasGrowth[m1]) this.growthCells.add(idx2);
      else this.growthCells.delete(idx2);
    }
    if (this.heatGrid) {
      const h1 = this.heatGrid[idx1];
      this.heatGrid[idx1] = this.heatGrid[idx2];
      this.heatGrid[idx2] = h1;
      // Heat that moved is heat out of equilibrium with its new surroundings,
      // even if neither cell's temperature changed.
      this.wakeThermalChunk(x1, y1);
      this.wakeThermalChunk(x2, y2);
    }
    if (this.velX) {
      // Velocity is parcel state: it rides with the material through a swap,
      // exactly as heat does.
      const vx = this.velX, vy = this.velY!, rx = this.velRemX!, ry = this.velRemY!;
      const vx1 = vx[idx1]; vx[idx1] = vx[idx2]; vx[idx2] = vx1;
      const vy1 = vy[idx1]; vy[idx1] = vy[idx2]; vy[idx2] = vy1;
      const rx1 = rx[idx1]; rx[idx1] = rx[idx2]; rx[idx2] = rx1;
      const ry1 = ry[idx1]; ry[idx1] = ry[idx2]; ry[idx2] = ry1;
      // Maintain the active-velocity set: membership follows whichever parcel
      // ends up with nonzero velocity.
      const v1new = vx[idx1] | vy[idx1];
      const v2new = vx[idx2] | vy[idx2];
      if (v1new) this.velCells.add(idx1); else this.velCells.delete(idx1);
      if (v2new) this.velCells.add(idx2); else this.velCells.delete(idx2);
    }
    this.wakeChunk(x1, y1);
    this.wakeChunk(x2, y2);
    this.markRenderDirty(x1, y1);
    this.markRenderDirty(x2, y2);
    this._swapsThisFrame++;
  }

  // ----------------------------------------------------------------------
  // Parcel primitives.
  //
  // A "parcel" is the complete per-cell state that moves with a material:
  // `grid`, `colorGrid`, `stiffnessGrid`, `growthGrid` (+ membership),
  // `heatGrid`, and `liquidVel`. This bookkeeping was duplicated across
  // `swap`, liquid levelling, phase change, explosions, and host placement
  // before these helpers existed, which is exactly the shape of bug that a
  // new movement path (pressure routing) would walk into — forgetting to
  // carry heat, or stiffness, or a growth-set entry.
  //
  // These centralize the copy/clear/write paths. They are private because the
  // distinction between a swap and a transfer is engine-internal; callers that
  // already had their own inline logic now delegate here, and the pressure pass
  // is built on the same primitives.
  // ----------------------------------------------------------------------

  /**
   * Copy the parcel at `fromIdx` onto `toIdx`, overwriting whatever was there.
   * The source cell is left untouched — this is a copy, not a move; callers
   * that need the source cleared do so explicitly with {@link clearParcel}.
   *
   * This is the one-directional transfer primitive that the liquid-levelling
   * pass and the pressure path-shift both reduce to, factored out so a new
   * movement path cannot silently drop a field. {@link swap} is a genuine
   * bidirectional exchange and does not decompose into two sequential copies
   * (the second would read the first's overwrite), so it keeps its own inline
   * exchange — but it shifts the same physical fields, kept in the same order,
   * so the two paths cannot drift on which fields count as "the parcel".
   *
   * `liquidVel` is the one field that is movement-specific rather than
   * parcel-specific: a pressure route is not a surface flow, and a parcel
   * carried up a conduit should not inherit a lateral-flow preference that was
   * meaningful only in the geometry it left. `clearLiquidVel` clears it at the
   * destination instead of copying it, for that one path.
   *
   * Does NOT touch the `updated` flag, chunk wake-up, or the swap counter:
   * those belong to the caller because a two-cell swap and a many-cell path
   * shift wake and count differently. Only the thermal wake is included here,
   * because heat moving is heat leaving equilibrium regardless of how the move
   * was initiated.
   *
   * Coordinates are taken (not derived from the index) so the thermal wake
   * resolves the right chunk.
   *
   * @internal
   */
  private copyParcel(
    fromIdx: number, toIdx: number,
    toX: number, toY: number,
    clearLiquidVel = false,
  ): void {
    const mat = this.grid[fromIdx];
    this.grid[toIdx] = mat;
    if (this.colorGrid) this.colorGrid[toIdx] = this.colorGrid[fromIdx];
    if (this.stiffnessGrid) this.stiffnessGrid[toIdx] = this.stiffnessGrid[fromIdx];
    if (this.growthGrid) this.growthGrid[toIdx] = this.growthGrid[fromIdx];
    // Membership follows the parcel: a growth-capable material arriving at
    // `toIdx` joins the set, and the membership this method does NOT touch is
    // the source's, which the caller reconciles (a swap leaves the source
    // holding the other parcel; a transfer/shift clears it).
    if (hasGrowth[mat]) this.growthCells.add(toIdx);
    if (this.heatGrid) {
      this.heatGrid[toIdx] = this.heatGrid[fromIdx];
      this.wakeThermalChunk(toX, toY);
    }
    if (clearLiquidVel) {
      this.liquidVel[toIdx] = 0;
    } else {
      this.liquidVel[toIdx] = this.liquidVel[fromIdx];
    }
    // Velocity is parcel state — copy unconditionally, independent of the
    // `clearLiquidVel` flag (which governs surface-flow memory only). A pressure
    // route must preserve a parcel's physical velocity; `liquidVel` is the one
    // field that gets cleared because it is movement-specific, not parcel state.
    if (this.velX) {
      const vx = this.velX, vy = this.velY!, rx = this.velRemX!, ry = this.velRemY!;
      vx[toIdx] = vx[fromIdx];
      vy[toIdx] = vy[fromIdx];
      rx[toIdx] = rx[fromIdx];
      ry[toIdx] = ry[fromIdx];
      if (vx[toIdx] | vy[toIdx]) this.velCells.add(toIdx);
    }
  }

  /**
   * Reset `idx` to an empty cell: EMPTY material, no companion state, heat back
   * to ambient (matching what {@link clear} establishes and what a levelling
   * source cell returns to). Maintains the {@link growthCells} membership
   * invariant. Does NOT touch `updated`, chunks, or render dirtiness — callers
   * own those, for the same reason {@link copyParcel} does.
   *
   * @internal
   */
  private clearParcel(idx: number): void {
    const oldMat = this.grid[idx];
    this.grid[idx] = MaterialType.EMPTY;
    if (this.colorGrid) this.colorGrid[idx] = 0;
    if (this.stiffnessGrid) this.stiffnessGrid[idx] = 0;
    if (this.growthGrid) this.growthGrid[idx] = 0;
    if (hasGrowth[oldMat]) this.growthCells.delete(idx);
    if (this.heatGrid) this.heatGrid[idx] = this.ambientTemperature;
    this.liquidVel[idx] = 0;
    if (this.velX) {
      const vx = this.velX, vy = this.velY!, rx = this.velRemX!, ry = this.velRemY!;
      vx[idx] = 0; vy[idx] = 0; rx[idx] = 0; ry[idx] = 0;
      this.velCells.delete(idx);
    }
  }

  /**
   * Density + processed-flag gated displacement test.
   *
   * A material at `(x, y)` may move into `(targetX, targetY)` when:
   *  - the target is in bounds,
   *  - neither cell was already processed this frame,
   *  - the target isn't an immovable WALL,
   *  - and the mover is denser than whatever is at the target (or the
   *    target is empty).
   */
  canDisplace(x: number, y: number, targetX: number, targetY: number): boolean {
    if (targetX < 0 || targetX >= this.width || targetY < 0 || targetY >= this.height) return false;

    const targetIdx = this.getIndex(targetX, targetY);
    if (this.updated[targetIdx]) return false;

    const sourceIdx = this.getIndex(x, y);
    if (this.updated[sourceIdx]) return false;

    const mover = this.grid[sourceIdx];
    const target = this.grid[targetIdx];

    if (target === MaterialType.WALL) return false;
    if (target === MaterialType.EMPTY) return true;

    const moverDef = materialDefs[mover];
    const targetDef = materialDefs[target];
    return moverDef.density > targetDef.density;
  }

  /**
   * How far along the level axis this liquid must travel to reach a cell it
   * could descend from, or 0 if no descent is reachable within
   * {@link liquidDispersion} steps.
   *
   * This is the gate that stops a liquid from flowing for the sake of flowing.
   * A liquid that returns 0 in both directions is at rest and does not move —
   * which is what lets a pool actually go quiet, and what leaves the `updated`
   * flags clear so the cell above can settle downward into it.
   *
   * The walk re-derives the movement frame at each probe cell rather than
   * stepping along the source cell's axis, so under a curved gravity field it
   * follows the surface instead of shooting off along the tangent it started
   * on. Under {@link FlatGravity} the frame is constant and this is a no-op;
   * under {@link RadialGravity} it is the difference between a planet's water
   * jittering forever and settling to a dead stop — a straight walk of 16
   * cells along the tangent of an r≈70 planet rises ~1.8 cells clear of the
   * surface and then tests descent against a stale "down".
   *
   * `goLeft` keeps the walk turning in one consistent rotational sense as the
   * frame rotates beneath it.
   *
   * The path must stay passable the whole way (empty, or a material this one
   * outweighs), so oil floating on water still layers correctly rather than
   * tunnelling through it.
   */
  private flowRun(
    x: number, y: number, mover: number,
    ldx: number, ldy: number,
    ddx: number, ddy: number,
    goLeft: boolean,
  ): number {
    const moverDensity = materialDefs[mover].density;
    // The first lateral step must be a legal move right now (updated flags).
    if (!this.canDisplace(x, y, x + ldx, y + ldy)) return 0;
    const pf = this._probeFrame;
    let tx = x, ty = y;
    let sx = ldx, sy = ldy; // step direction, re-derived each cell
    let dx = ddx, dy = ddy; // down direction, re-derived each cell
    for (let d = 1; d <= this.liquidDispersion; d++) {
      tx += sx; ty += sy;
      if (tx < 0 || tx >= this.width || ty < 0 || ty >= this.height) return 0;
      const tMat = this.grid[this.getIndex(tx, ty)];
      // Path must stay passable: empty, or something we outweigh.
      if (tMat !== MaterialType.EMPTY && materialDefs[tMat].density >= moverDensity) return 0;
      // Follow the field: re-derive the frame at the probe cell.
      fillNeighborFrame(tx, ty, this.gravity, pf);
      dx = pf.down.dx; dy = pf.down.dy;
      sx = goLeft ? pf.left.dx : pf.right.dx;
      sy = goLeft ? pf.left.dy : pf.right.dy;
      // Can we descend from here?
      const bx = tx + dx, by = ty + dy;
      if (bx >= 0 && bx < this.width && by >= 0 && by < this.height) {
        const bMat = this.grid[this.getIndex(bx, by)];
        if (bMat === MaterialType.EMPTY || materialDefs[bMat].density < moverDensity) return d;
      }
    }
    return 0;
  }

  /**
   * How many cells thick this liquid's flow is at `(x, y)`, measured along the
   * gravity axis — the contiguous run of the same material through this cell,
   * counting both up and down from it.
   *
   * This is the discrete stand-in for the flow depth `h` in a yield-stress
   * criterion: a Bingham fluid advances only while `ρ·g·h·sinθ` exceeds its
   * yield strength, and on a fixed grid with fixed gravity, `h` is the only
   * term that varies from cell to cell. So thickness *is* the flow/no-flow
   * discriminator, and {@link MaterialDef.yieldThickness} is the threshold.
   *
   * Counting both directions makes the measure agree between the engine's two
   * movement paths, which see a column from different places: the levelling
   * pass only ever handles the free-surface cell at the top of a column (where
   * everything is below), while the checkerboard's lateral-flow branch can
   * handle any cell in it. Counting only one way would report a thickness of 1
   * for a surface cell and stall a genuinely thick flow.
   *
   * Capped at `cap` so the walk stays O(1) on a deep body — the answer only
   * has to be comparable against a small threshold, never exact.
   */
  flowThickness(x: number, y: number, mat: number, dDX: number, dDY: number, cap: number): number {
    let n = 1;
    // Up (against gravity), then down. Both bounded by `cap`.
    for (let i = 1; i < cap; i++) {
      const tx = x - dDX * i, ty = y - dDY * i;
      if (tx < 0 || tx >= this.width || ty < 0 || ty >= this.height) break;
      if (this.grid[this.getIndex(tx, ty)] !== mat) break;
      n++;
    }
    for (let i = 1; n < cap; i++) {
      const tx = x + dDX * i, ty = y + dDY * i;
      if (tx < 0 || tx >= this.width || ty < 0 || ty >= this.height) break;
      if (this.grid[this.getIndex(tx, ty)] !== mat) break;
      n++;
    }
    return n;
  }

  /**
   * True if this liquid is too thin at `(x, y)` to overcome its own yield
   * strength, and so must not spread sideways or level this frame.
   *
   * Always false for a material without a {@link MaterialDef.yieldThickness},
   * which is every material except lava — so Newtonian liquids keep their
   * previous behavior exactly.
   */
  private belowYield(x: number, y: number, mat: number, dDX: number, dDY: number): boolean {
    // Per-cell stiffness wins over the material constant when the host supplies
    // it; 0 means "not set".
    const yt =
      (this.stiffnessGrid ? this.stiffnessGrid[this.getIndex(x, y)] : 0) ||
      materialDefs[mat].yieldThickness;
    if (!yt) return false;
    return this.flowThickness(x, y, mat, dDX, dDY, yt) < yt;
  }

  /**
   * True if stepping from `(x, y)` by `(dx, dy)` would raise the cell's
   * gravitational potential — i.e. carry it uphill.
   *
   * Returns `false` (no gating, today's behaviour) when the gravity model does
   * not implement {@link GravityModel.potentialAt}, which keeps custom models
   * working unchanged.
   *
   * The comparison is strict: any rise at all is rejected. That is safe
   * because the only rises a *level* step can produce are sub-cell
   * quantization noise (≤ ~0.54 measured on a planet), while genuine downhill
   * movement is a full cell or more. Under {@link FlatGravity} a level step
   * never changes `y`, so the difference is exactly 0 and nothing is rejected.
   */
  private stepRaisesPotential(x: number, y: number, dx: number, dy: number): boolean {
    const pot = this._potentialAt;
    if (pot === null) return false;
    return pot(x + dx, y + dy) > pot(x, y);
  }

  /**
   * Height-field levelling — let a free liquid surface flow to level.
   *
   * ## Why this pass has to exist
   *
   * A liquid cannot displace its own kind, so a contiguous body is rigid
   * everywhere except its free surface, and the displacement core can only
   * advance that surface where there is a full one-cell drop. Measured on a
   * settled lens, 203 of 206 cells could not take a single step and 93% of
   * attempted steps were blocked by the liquid itself. The result is that
   * water piles with a sand-like angle of repose. Walls hide it; open floors
   * and planet surfaces expose it as lumps.
   *
   * The core cannot fix this locally, because the move that resolves it is
   * non-local: a cell at the top of a mound has to reach a lower part of the
   * surface, and every cell in between is liquid it cannot pass through. So
   * this pass transfers it directly.
   *
   * ## The rule
   *
   * For each free-surface liquid cell, walk the surface outward along both
   * level directions and transfer the cell to the *first* resting place whose
   * gravitational potential is at least one full cell lower.
   *
   * "First, not lowest" keeps transfers short, which both looks better and
   * costs less; repetition across frames still drives the surface flat.
   *
   * ## Why it terminates
   *
   * Let Φ be the total potential of all liquid cells. Every transfer here
   * lowers Φ by at least 1 by construction; falling lowers it; and since the
   * lateral-flow potential gate (see {@link stepRaisesPotential}) nothing
   * raises it. Φ is bounded below, so the system reaches a fixed point and
   * stops — which is what lets a levelled pool reach zero swaps and idle its
   * chunks.
   *
   * An earlier attempt at this pass accepted destinations at the *same* level
   * and hung forever at 28 swaps/frame: cells shuffled between equally-good
   * spots because nothing decreased. The strict one-cell drop is the fix, and
   * it is load-bearing — do not relax it to "not higher".
   */
  private runLiquidLevelling(): void {
    const pot = this._potentialAt;
    if (pot === null) return; // model without a potential keeps prior behaviour
    const f = this._frame;
    const pf = this._probeFrame;
    const dir = this.frameCount % 2 === 0 ? 1 : -1;

    // Chunk-major, skipping inactive chunks wholesale — the same shape as
    // `runCheckerboardUpdate`. Iterating cells first and testing the chunk per
    // cell still costs a full-grid scan every frame, which showed up as 1.5ms
    // per frame on a 220x220 planet that had been completely still since frame
    // one. A settled world must cost nothing.
    const cs = this.CHUNK_SIZE;
    for (let cy = this.chunkHeight - 1; cy >= 0; cy--) {
      const startCX = dir === 1 ? 0 : this.chunkWidth - 1;
      const endCX = dir === 1 ? this.chunkWidth : -1;
      for (let cx = startCX; cx !== endCX; cx += dir) {
        if (!this.activeChunks[cy * this.chunkWidth + cx]) continue;

        const yStart = Math.min(this.height - 1, (cy + 1) * cs - 1);
        const yEnd = cy * cs;
        for (let y = yStart; y >= yEnd; y--) {
          const startX = dir === 1 ? cx * cs : Math.min(this.width - 1, (cx + 1) * cs - 1);
          const endX = dir === 1 ? Math.min(this.width, (cx + 1) * cs) : cx * cs - 1;
          for (let x = startX; x !== endX; x += dir) {
        const idx = this.getIndex(x, y);
        if (this.updated[idx]) continue;
        const mat = this.grid[idx];
        if (mat === MaterialType.EMPTY) continue;
        if (!materialDefs[mat].isLiquid) continue;

        fillNeighborFrame(x, y, this.gravity, f);
        // Free surface only: a cell with liquid resting on it is load-bearing.
        if (this.getMaterial(x - f.down.dx, y - f.down.dy) !== MaterialType.EMPTY) continue;

        // Yield strength: levelling is the *water* behaviour — chase the
        // lowest reachable spot however thin the film. A liquid with a yield
        // strength does not do that, and letting it would undo the flow front
        // entirely, since this pass is non-local and would teleport a
        // one-cell-thick flow margin far downslope.
        if (this.belowYield(x, y, mat, f.down.dx, f.down.dy)) continue;

        const p0 = pot(x, y);
        let destX = -1;
        let destY = -1;

        for (let side = 0; side < 2 && destX < 0; side++) {
          const goLeft = dir === 1 ? side === 0 : side === 1;
          let sx = goLeft ? f.left.dx : f.right.dx;
          let sy = goLeft ? f.left.dy : f.right.dy;
          let dx = f.down.dx, dy = f.down.dy;
          let tx = x, ty = y;

          for (let d = 1; d <= LIQUID_LEVEL_REACH; d++) {
            tx += sx; ty += sy;
            if (tx < 0 || tx >= this.width || ty < 0 || ty >= this.height) break;
            const m = this.grid[this.getIndex(tx, ty)];

            // Re-seat onto the local surface: a tangential step lands at an
            // arbitrary height relative to it.
            if (m === mat) {
              let c = 0;
              while (c < LIQUID_LEVEL_CLIMB && this.getMaterial(tx - dx, ty - dy) === mat) {
                tx -= dx; ty -= dy; c++;
              }
              // Covered by something else (or too deep): stop following.
              if (this.getMaterial(tx - dx, ty - dy) !== MaterialType.EMPTY) break;
              tx -= dx; ty -= dy; // the free cell atop this column
            } else if (m === MaterialType.EMPTY) {
              let c = 0;
              while (c < LIQUID_LEVEL_CLIMB && this.getMaterial(tx + dx, ty + dy) === MaterialType.EMPTY) {
                tx += dx; ty += dy; c++;
              }
              // Still nothing underneath: a cliff, not a surface. The ordinary
              // falling rules handle pouring over an edge.
              if (this.getMaterial(tx + dx, ty + dy) === MaterialType.EMPTY) break;
            } else {
              break; // solid, or a different material
            }

            // Destination must be free. Deliberately NOT gated on `updated`:
            // that flag is only cleared inside active chunks, so it goes stale
            // in settled regions — which is exactly where this walk wants to
            // deposit liquid. Emptiness is the correct and sufficient test,
            // since a transfer fills its destination and any later walk this
            // frame then sees it occupied.
            const tIdx = this.getIndex(tx, ty);
            if (this.grid[tIdx] !== MaterialType.EMPTY) break;
            if (pot(tx, ty) <= p0 - 1) { destX = tx; destY = ty; break; }

            fillNeighborFrame(tx, ty, this.gravity, pf);
            dx = pf.down.dx; dy = pf.down.dy;
            sx = goLeft ? pf.left.dx : pf.right.dx;
            sy = goLeft ? pf.left.dy : pf.right.dy;
          }
        }

        if (destX < 0) continue;

        // Transfer (not a swap — the path between is solid liquid). Copy the
        // parcel to the destination, then clear the source. Order matters:
        // `copyParcel` reads the source's grid/companion state, so the clear
        // must follow. Levelling zeroes `liquidVel` at both ends (a freshly
        // deposited surface cell has no committed flow direction), which
        // `clearLiquidVel` handles at the destination and `clearParcel` at the
        // source.
        const dIdx = this.getIndex(destX, destY);
        this.copyParcel(idx, dIdx, destX, destY, true);
        this.clearParcel(idx);
        if (this.heatGrid) {
          // The source was just reset to ambient by `clearParcel`; the heat it
          // vacated is out of equilibrium with its new surroundings, so wake
          // the thermal chunk there too.
          this.wakeThermalChunk(x, y);
        }
        this.updated[dIdx] = 1;
        this.updated[idx] = 1;
        this.wakeChunk(x, y);
        this.wakeChunk(destX, destY);
        this.markRenderDirty(x, y);
        this.markRenderDirty(destX, destY);
        this._swapsThisFrame++;
          }
        }
      }
    }
  }

  /**
   * Advance the heat field one frame: conduction, then environment exchange,
   * then heat-source re-assertion.
   *
   * ## Why three sequential sub-steps rather than one fused pass
   *
   * Each is individually contractive — neither can push a cell outside the
   * range it started in — and composing contractive operators stays
   * contractive. Fusing them would mean reasoning about a combined stability
   * bound, and the combined bound is where an earlier design put coefficients
   * that diverge.
   *
   * ## Why conduction is not enough on its own
   *
   * The thing an exposed cell loses heat *to* is EMPTY, which has no
   * temperature and cannot be a conduction partner (heat stored in vacuum cells
   * would advect through {@link swap} as hot air parcels and be destroyed by
   * `setMaterial`). Under conduction alone an exposed cell therefore has nobody
   * to conduct into and cools *slower* than a buried one — backwards from the
   * behaviour this field exists to provide. Environment exchange is the term
   * that actually cools a flow: a skin chills ahead of its core, a buried
   * conduit stays live, and a flow front stalls first.
   *
   * ## Cost
   *
   * Scoped to {@link thermalChunks}, and returns immediately when none is
   * active — a thermally settled world costs one scan of the chunk flags.
   */
  private runHeatStep(): void {
    const heat = this.heatGrid;
    const delta = this._heatDelta;
    const active = this.thermalChunks;
    if (heat === null || delta === null || active === null) return;

    let anyActive = false;
    for (let i = 0; i < active.length; i++) {
      if (active[i]) { anyActive = true; break; }
    }
    if (!anyActive) return;

    const cw = this.chunkWidth;
    const cs = this.CHUNK_SIZE;
    const w = this.width;
    const h = this.height;
    const grid = this.grid;

    // --- Pass 1: clear the flux accumulator over active chunks -------------
    // Only cells in active chunks can receive flux (see pass 2), so this is
    // sufficient and leaves settled regions untouched.
    for (let cy = 0; cy < this.chunkHeight; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        if (!active[cy * cw + cx]) continue;
        const yEnd = Math.min((cy + 1) * cs, h);
        const xStart = cx * cs;
        const xEnd = Math.min(xStart + cs, w);
        for (let y = cy * cs; y < yEnd; y++) {
          const rowOff = y * w;
          for (let x = xStart; x < xEnd; x++) delta[rowOff + x] = 0;
        }
      }
    }

    // --- Pass 2: accumulate conduction flux, one visit per edge ------------
    // Each cell owns its +x and +y edges, so every edge is visited exactly
    // once and both endpoints are updated with equal and opposite flux.
    for (let cy = 0; cy < this.chunkHeight; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        if (!active[cy * cw + cx]) continue;
        const yEnd = Math.min((cy + 1) * cs, h);
        const xStart = cx * cs;
        const xEnd = Math.min(xStart + cs, w);
        for (let y = cy * cs; y < yEnd; y++) {
          const rowOff = y * w;
          for (let x = xStart; x < xEnd; x++) {
            const idx = rowOff + x;
            const ca = materialDefs[grid[idx]].conductivity;
            if (ca === undefined) continue; // non-thermal: does not conduct
            const ta = heat[idx];

            // All four neighbours are *inspected*, but only the +x and +y
            // edges are conducted across — each edge has exactly one owner, so
            // it is visited once and its two endpoints updated with equal and
            // opposite flux. The -x/-y neighbours are inspected purely to
            // decide whether a sleeping chunk on that side needs waking; their
            // edges belong to the cell on the other end.
            for (let d = 0; d < 4; d++) {
              const nx = x + (d === 0 ? 1 : d === 2 ? -1 : 0);
              const ny = y + (d === 1 ? 1 : d === 3 ? -1 : 0);
              if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;

              const nIdx = ny * w + nx;
              const cb = materialDefs[grid[nIdx]].conductivity;
              if (cb === undefined) continue; // non-thermal: does not conduct

              // The coefficient is a property of the *edge*. Both endpoints
              // must agree on it, or the seam's conductance would depend on
              // which side the loop visits first and the physics would follow
              // grid orientation. `min` models the bottleneck — a good
              // insulator throttles the pair. (The physically exact form is
              // the harmonic mean, likewise symmetric, and drops in here
              // unchanged.)
              const f = CONDUCTION_MAX * (ca < cb ? ca : cb);
              const q = f * (ta - heat[nIdx]);

              // An edge is only conducted across when *both* chunks are awake:
              // flux written into a sleeping chunk would never be applied, and
              // the heat would simply vanish. Skipping transfers nothing, which
              // conserves exactly.
              const ncx = (nx / cs) | 0;
              const ncy = (ny / cs) | 0;
              if (!active[ncy * cw + ncx]) {
                // Wake the sleeping side only if there is genuinely heat to
                // move, so the pair conducts next frame — a one-frame lag at a
                // seam rather than a stall. Waking unconditionally would let
                // any active chunk re-wake its neighbours forever, and they it,
                // so a fully equilibrated world would never go quiet.
                if (q > HEAT_EPSILON || q < -HEAT_EPSILON) this.wakeThermalChunk(nx, ny);
                continue;
              }

              if (d >= 2) continue; // -x/-y: inspected for waking only
              delta[idx] -= q;
              delta[nIdx] += q;
            }
          }
        }
      }
    }

    // --- Pass 3: apply flux, exchange with the environment, hold sources ---
    for (let cy = 0; cy < this.chunkHeight; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        if (!active[cy * cw + cx]) continue;
        const yEnd = Math.min((cy + 1) * cs, h);
        const xStart = cx * cs;
        const xEnd = Math.min(xStart + cs, w);
        for (let y = cy * cs; y < yEnd; y++) {
          const rowOff = y * w;
          for (let x = xStart; x < xEnd; x++) {
            const idx = rowOff + x;
            const mat = grid[idx];
            if (!isThermal[mat]) continue;
            const def = materialDefs[mat];
            const before = heat[idx];
            let t = before + delta[idx];

            const emissivity = def.emissivity;
            if (emissivity !== undefined) {
              // Exposure = orthogonal faces open to the environment. The curve
              // is deliberately steep at the first face and shallow after:
              // touching air at all is most of the heat loss, and a cell open
              // on four sides is not four times as cold as one open on one. A
              // linear exposure/4 lets a flow's top surface — open on exactly
              // one face, which is nearly every cell of a flow — cool at a
              // quarter rate, and tongues then stay molten long enough to run
              // right around a planet as a sheet.
              let exposed = 0;
              if (this.getMaterial(x, y - 1) === MaterialType.EMPTY) exposed++;
              if (this.getMaterial(x, y + 1) === MaterialType.EMPTY) exposed++;
              if (this.getMaterial(x - 1, y) === MaterialType.EMPTY) exposed++;
              if (this.getMaterial(x + 1, y) === MaterialType.EMPTY) exposed++;
              const k = exposed > 0 ? 0.4 + (0.6 * exposed) / 4 : INSULATED_EXPOSURE;
              // `emissivity * k <= 1`, so this lands on ambient at worst and
              // never overshoots past it.
              t += emissivity * k * (this.ambientTemperature - t);
            }

            // A heat source is held, not skipped: it was read at full strength
            // by pass 2, so its neighbours have already drawn from it, and it
            // is only now pinned back to its own temperature. This is the one
            // place heat is created rather than moved.
            if (def.heatSource) t = def.spawnTemp ?? t;

            if (t > 1) t = 1;
            else if (t < 0) t = 0;

            // Below the epsilon the cell is treated as settled: the write is
            // skipped so the chunk can sleep. Without this, diffusion's
            // asymptotic tail keeps every chunk awake and every chunk
            // render-dirty forever.
            const change = t - before;
            if (change > HEAT_EPSILON || change < -HEAT_EPSILON) {
              heat[idx] = t;
              this.wakeThermalChunk(x, y);
              this.markRenderDirty(x, y);
            }
          }
        }
      }
    }

    // --- Pass 4: phase change ---------------------------------------------
    const frame = this._frame;
    for (let cy = 0; cy < this.chunkHeight; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        if (!active[cy * cw + cx]) continue;
        const yEnd = Math.min((cy + 1) * cs, h);
        const xStart = cx * cs;
        const xEnd = Math.min(xStart + cs, w);
        for (let y = cy * cs; y < yEnd; y++) {
          const rowOff = y * w;
          for (let x = xStart; x < xEnd; x++) {
            const idx = rowOff + x;
            const def = materialDefs[grid[idx]];
            const t = heat[idx];

            let into: MaterialType | undefined;
            if (def.freezesAt !== undefined && t <= def.freezesAt) into = def.freezesInto;
            else if (def.meltsAt !== undefined && t >= def.meltsAt) into = def.meltsInto;

            // Fragmentation: a ballistic cell (has velocity) below `fragmentsAt`
            // becomes granular tephra. Velocity is the sole criterion — it
            // distinguishes pressure-launched ejecta from host-placed cells and
            // from grounded conduit lava. No airborneness check: a fountain is a
            // dense stream where each cell has lava below it, so requiring EMPTY
            // below would prevent fragmentation entirely.
            if (into === undefined && hasFragmentation[def.id] && t <= def.fragmentsAt!
                && this.velX !== null && (this.velX[idx] | this.velY![idx])) {
              into = def.fragmentsInto;
            }

            if (into === undefined) continue;

            // A mobile material freezing into an immobile one must be resting
            // on something. The engine has no velocity, so a cell in flight is
            // a lone parcel with cold air on every side — maximum exposure, and
            // therefore the likeliest thing in the world to cross a freezing
            // threshold, before it has landed anywhere. Rock never falls, so
            // without this a lava bomb sets in mid-air and hangs there forever.
            // Skipping the transform (rather than clamping the temperature)
            // leaves it molten and cooling, so it sets the instant it lands.
            if (isImmobile[into] && !isImmobile[def.id]) {
              fillNeighborFrame(x, y, this.gravity, frame);
              if (this.getMaterial(x + frame.down.dx, y + frame.down.dy) === MaterialType.EMPTY) {
                continue;
              }
            }

            // Temperature carries across the change; it is the same parcel of
            // matter. Resetting to the new material's spawnTemp would snap
            // freshly-set rock straight to ambient grey, losing the fade from
            // red-hot that is most of what makes a cooling flow read as one.
            // `setMaterial` does reset it, so this must be written after.

            // Fragmentation preserves momentum: capture velocity before
            // setMaterial zeroes it, then restore after — the same capture/
            // restore pattern used for heat below. Only fragmentation does this;
            // every other phase change (LAVA→ROCK, WATER→ICE) correctly clears
            // velocity via setMaterial, since the product is at rest.
            const isFragment = hasFragmentation[def.id] && into === def.fragmentsInto;
            let fragVx = 0, fragVy = 0, fragRx = 0, fragRy = 0;
            if (isFragment && this.velX) {
              fragVx = this.velX[idx]; fragVy = this.velY![idx];
              fragRx = this.velRemX![idx]; fragRy = this.velRemY![idx];
            }

            this.setMaterial(x, y, into);
            heat[idx] = t;

            // Restore the fragment's inherited momentum. It will move on the
            // next frame's velocity pass (the heat step is the last pass this
            // frame, so there is a one-frame delay before the fragment flies —
            // which reads naturally as the fragment appearing at the vent).
            if (isFragment && this.velX && (fragVx | fragVy)) {
              const vx = this.velX, vy = this.velY!, rx = this.velRemX!, ry = this.velRemY!;
              vx[idx] = fragVx; vy[idx] = fragVy;
              rx[idx] = fragRx; ry[idx] = fragRy;
              this.velCells.add(idx);
            }
            this.wakeThermalChunk(x, y);
          }
        }
      }
    }
  }

  // ------------------------------------------------------------------ growth

  /**
   * Allocate {@link growthGrid}. Idempotent.
   *
   * Unlike {@link allocHeat} a plain zero-fill is correct: `0` means "no growth
   * state", which is what every cell that has never grown should read as.
   */
  private allocGrowth(): Uint16Array {
    if (this.growthGrid) return this.growthGrid;
    return (this.growthGrid = new Uint16Array(this.width * this.height));
  }

  /**
   * Allocate the velocity field and its sub-cell remainders. Idempotent.
   * Zero-fill is correct: `0` means "at rest", which is what every cell that has
   * never been impulsed should read as.
   */
  private allocVelocity(): void {
    if (this.velX) return;
    const n = this.width * this.height;
    this.velX = new Int8Array(n);
    this.velY = new Int8Array(n);
    this.velRemX = new Int8Array(n);
    this.velRemY = new Int8Array(n);
  }

  /**
   * Place a growing cell and seed its state.
   *
   * For a {@link TipRule} material this is the difference between a tip that
   * grows and one that sits inert: a tip with zero energy terminates on its
   * first tick. Spread and aggregate materials need no state, so for those this
   * is just {@link setMaterial}.
   *
   * @param energy  Growth budget, 0–127. Roughly the trunk length in cells.
   * @param dir     Initial heading as a gravity-relative octant. Default 0 (up,
   *                which on a planet means radially outward).
   * @param variant Genome, 0–15. Default: rolled from the engine RNG.
   */
  plant(
    x: number,
    y: number,
    mat: MaterialType,
    opts?: { energy?: number; dir?: Octant; variant?: number },
  ): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    this.setMaterial(x, y, mat);
    const rule = materialDefs[mat].growth;
    if (rule === undefined || rule.kind !== 'tip') return;
    const g = this.allocGrowth();
    const variant = opts?.variant ?? Math.floor(this.random() * 16);
    g[this.getIndex(x, y)] = packGrowth(opts?.energy ?? 12, opts?.dir ?? 0, 0, variant);
  }

  /** Growth state at `(x, y)`, or `null` if the cell has none. */
  getGrowthState(
    x: number,
    y: number,
  ): { energy: number; dir: Octant; gen: number; variant: number } | null {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return null;
    const g = this.growthGrid;
    if (!g) return null;
    const word = g[this.getIndex(x, y)];
    return word === 0 ? null : unpackGrowth(word);
  }

  /** Overwrite the growth state at `(x, y)`. Allocates {@link growthGrid}. */
  setGrowthState(
    x: number,
    y: number,
    s: { energy: number; dir: Octant; gen?: number; variant?: number },
  ): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const g = this.allocGrowth();
    g[this.getIndex(x, y)] = packGrowth(s.energy, s.dir, s.gen ?? 0, s.variant ?? 0);
  }

  /**
   * Rebuild {@link growthCells} from the grid.
   *
   * Membership is a pure function of the grid, so this restores it exactly —
   * which is what a host needs after loading a serialized world. A world
   * reconstructed this way grows identically to the one it was saved from,
   * because the candidate set carries no information the grid does not.
   */
  rebuildGrowthCells(): void {
    this.growthCells.clear();
    const n = this.width * this.height;
    for (let i = 0; i < n; i++) {
      if (hasGrowth[this.grid[i]]) this.growthCells.add(i);
    }
  }

  /**
   * Growth events (spawns, advances, transformations) in the last frame.
   *
   * Feeds settle detection alongside {@link swapsLastFrame}: a world with a
   * tree still growing in it is not settled, and a turn-based host waiting on
   * {@link beginSettle} should keep waiting.
   */
  get growthEventsLastFrame(): number {
    return this._growthEventsThisFrame;
  }

  /**
   * The growth pass: spreading, directed tips, and contact aggregation.
   *
   * Runs **outside** the checkerboard scan, and that placement is the whole
   * design. Three facts about the movement core make an in-scan growth branch
   * unworkable, and one pass fixes all three:
   *
   *  1. `runCheckerboardUpdate` skips sleeping chunks. Growth is spontaneous —
   *     it has no imbalance to be woken by — so a settled world would simply
   *     stop growing, which is exactly the "place water, walk away, come back
   *     to a forest" case the feature exists for.
   *  2. Static materials never reach the scan's interaction block; they are
   *     rejected at the top by {@link isImmobile}. Every plant is static.
   *  3. A supported `needsSupport` cell `continue`s before interactions too, so
   *     anything rooted would never dispatch.
   *
   * Out here, cost is proportional to {@link growthCells} — the amount of life
   * in the world — rather than to grid area, and a world with none pays a
   * single `size` test per frame.
   *
   * The pass iterates a **snapshot sorted by cell index**. The snapshot means a
   * cell created this tick does not act until the next one, so a whole tree
   * cannot appear in a single frame. Sorting by index rather than relying on
   * `Set` insertion order means growth is reproducible from a *serialized
   * grid*, not merely from an identical run.
   */
  private runGrowth(): void {
    // Before any RNG draw: a world with nothing alive in it must not perturb
    // the shared random stream, or "opt-in" would not be byte-identical.
    if (this.growthCells.size === 0) return;
    if (this.frameCount % this.growthInterval !== 0) return;

    const snapshot = Array.from(this.growthCells);
    snapshot.sort((a, b) => a - b);
    this._growthTouched.clear();

    for (let i = 0; i < snapshot.length; i++) {
      const idx = snapshot[i];
      const mat = this.grid[idx] as MaterialType;
      const rule = materialDefs[mat].growth;
      if (rule === undefined) {
        // Stale entry: a reaction overwrote this cell with a direct grid write.
        // See the note on `growthCells` — these can only ever be spurious.
        this.growthCells.delete(idx);
        continue;
      }
      // A cell another growth cell already wrote to this tick has had its turn.
      if (this._growthTouched.has(idx)) continue;

      const x = idx % this.width;
      const y = (idx - x) / this.width;

      let acted = false;
      if (rule.kind === 'spread') acted = this.stepSpread(idx, x, y, rule);
      else if (rule.kind === 'tip') acted = this.stepTip(idx, x, y, mat, rule);
      else acted = this.stepAggregate(idx, x, y, rule);

      if (acted) this._growthEventsThisFrame++;
    }
  }

  /**
   * Isotropic spreading. Returns true if it spawned.
   *
   * Every eligibility test is applied at the **target**, which is what actually
   * bounds a patch: a source-side crowding check leaves the frontier expanding
   * at the same final extent and only slows the interior down.
   */
  private stepSpread(idx: number, x: number, y: number, rule: SpreadRule): boolean {
    const g = this.growthGrid;
    const word = g ? g[idx] : 0;
    let vigour = (word >> GROWTH_VIGOUR_SHIFT) & GROWTH_ENERGY_MASK;

    if (g) {
      const backoff = word & GROWTH_ENERGY_MASK;
      if (backoff > 0) {
        // Re-arm if anything moved nearby. The movement activity set is already
        // exactly the "something changed in this region" signal, so this costs
        // one array read instead of a neighbour scan on every setMaterial.
        const cx = Math.floor(x / this.CHUNK_SIZE);
        const cy = Math.floor(y / this.CHUNK_SIZE);
        if (this.activeChunks[cy * this.chunkWidth + cx]) {
          g[idx] = vigour << GROWTH_VIGOUR_SHIFT;
        } else {
          g[idx] = (backoff - 1) | (vigour << GROWTH_VIGOUR_SHIFT);
          return false;
        }
      }
    }

    // A cell touching what it needs is refreshed to full range; one that isn't
    // lives off what its parent passed down. At zero it has run out of reach.
    if (rule.needs !== undefined) {
      if (this.neighborhoodHasAll(x, y, rule.needs)) vigour = rule.range ?? 1;
      if (vigour === 0) {
        this.backOff(idx, vigour);
        return false;
      }
    }

    fillNeighborFrame(x, y, this.gravity, this._growthFrame);
    const dirs = rule.directions ?? ALL_OCTANTS;
    const intoMats = rule.intoMaterial;
    const targets = this._growthTargets;
    targets.length = 0;

    for (let d = 0; d < dirs.length; d++) {
      octantOffset(this._growthFrame, dirs[d], this._growthOffset);
      const tx = x + this._growthOffset.dx;
      const ty = y + this._growthOffset.dy;
      if (tx < 0 || tx >= this.width || ty < 0 || ty >= this.height) continue;
      const tIdx = this.getIndex(tx, ty);
      if (this._growthTouched.has(tIdx)) continue;
      const tMat = this.grid[tIdx];
      if (intoMats ? !intoMats.includes(tMat) : tMat !== MaterialType.EMPTY) continue;
      if (rule.tempRange && !this.inTempRange(tIdx, rule.tempRange)) continue;
      if (rule.needsFooting && !this.hasFooting(tx, ty, rule.into)) continue;
      if (
        rule.maxNeighbors !== undefined &&
        this.countNeighbors(tx, ty, rule.into) > rule.maxNeighbors
      ) {
        continue;
      }
      targets.push(tIdx);
    }

    if (targets.length === 0) {
      this.backOff(idx, vigour);
      return false;
    }

    if (this.random() >= rule.chance) return false;

    // Uniform among the eligible, not first-past-the-post: taking the first
    // eligible target would comb a patch in whichever direction `directions`
    // happens to list first, which is visible as streaking.
    const pick =
      targets.length === 1 ? targets[0] : targets[Math.floor(this.random() * targets.length)];
    const px = pick % this.width;
    const py = (pick - px) / this.width;
    this.setMaterial(px, py, rule.into);
    this._growthTouched.add(pick);
    // The child inherits one less reach than its parent had.
    if (vigour > 1) {
      this.allocGrowth()[pick] = (vigour - 1) << GROWTH_VIGOUR_SHIFT;
    }
    if (rule.becomes !== undefined) this.setMaterial(x, y, rule.becomes);
    else if (this.growthGrid) this.growthGrid[idx] = vigour << GROWTH_VIGOUR_SHIFT;
    return true;
  }

  /** Double a spread cell's wait, preserving its reach. See {@link GROWTH_BACKOFF_MAX}. */
  private backOff(idx: number, vigour: number): void {
    const g = this.growthGrid ?? this.allocGrowth();
    const prev = g[idx] & GROWTH_ENERGY_MASK;
    const next = Math.min(GROWTH_BACKOFF_MAX, prev === 0 ? 1 : prev * 2);
    g[idx] = next | (vigour << GROWTH_VIGOUR_SHIFT);
  }

  /**
   * Directed growth. Returns true if the tip advanced or terminated.
   *
   * The tip advances one cell along its heading, converts the cell it vacated
   * into {@link TipRule.becomes}, and spends a unit of energy. Out of energy or
   * out of room, it terminates. **A tip always resolves** — it never simply
   * waits — which is why a forest converges instead of filling the grid.
   */
  private stepTip(
    idx: number,
    x: number,
    y: number,
    mat: MaterialType,
    rule: TipRule,
  ): boolean {
    const g = this.growthGrid ?? this.allocGrowth();
    const word = g[idx];
    const energy = word & GROWTH_ENERGY_MASK;
    const dir0 = (word >> GROWTH_DIR_SHIFT) & 7;
    const gen = (word >> GROWTH_GEN_SHIFT) & 3;
    const variant = (word >> GROWTH_VARIANT_SHIFT) & 15;

    // Outside its temperature band a tip pauses rather than dying: a cold snap
    // should stall a forest, not kill it.
    if (rule.tempRange && !this.inTempRange(idx, rule.tempRange)) return false;

    if (energy === 0) {
      this.terminateTip(x, y, dir0, rule);
      return true;
    }

    fillNeighborFrame(x, y, this.gravity, this._growthFrame);

    // Wobble is a deviation for *this step*, not a turn. The base heading is
    // kept and re-stored below, so a trunk jogs and comes back to its axis. Let
    // the wobble accumulate instead and the heading random-walks with no
    // restoring force: measured on a 26-energy tree, one early wobble was
    // enough to lock the trunk onto a 45° diagonal for its whole life, which
    // gave a sprawl across the ground rather than a tree.
    let step = dir0;
    if (rule.wobble !== undefined && rule.wobble > 0 && this.random() < rule.wobble) {
      step = (dir0 + (this.random() < 0.5 ? 7 : 1)) & 7;
    }

    const headings = this._growthHeadings;
    headings.length = 0;
    headings.push(step, (step + 7) & 7, (step + 1) & 7);
    if (rule.preferOpen) this.sortByOpenness(x, y, headings, step);

    const intoMats = rule.intoMaterial;
    const stepOpen = this.tipCanEnter(x, y, step, intoMats);
    for (let h = 0; h < headings.length; h++) {
      const heading = headings[h];
      octantOffset(this._growthFrame, heading, this._growthOffset);
      const odx = this._growthOffset.dx;
      const ody = this._growthOffset.dy;
      const tx = x + odx;
      const ty = y + ody;
      if (tx < 0 || tx >= this.width || ty < 0 || ty >= this.height) continue;
      const tIdx = this.getIndex(tx, ty);
      if (this._growthTouched.has(tIdx)) continue;
      const tMat = this.grid[tIdx];
      if (intoMats ? !intoMats.includes(tMat) : tMat !== MaterialType.EMPTY) continue;

      // Only a genuine blockage rewrites the heading. Wobble and `preferOpen`
      // are decisions about *this step*; letting either of them stick makes the
      // heading random-walk with no restoring force, and a single early
      // deviation then owns the rest of the limb — measured before this split,
      // one wobble on frame 3 sent a 24-energy trunk off at 45° for its entire
      // life. Growing around a rock, by contrast, should stick, or the tip
      // butts into the same rock forever.
      const nextDir = stepOpen ? dir0 : heading;

      // Trunk first, then the tip moves into the target. Order matters:
      // `setMaterial` clears the growth word, so the state has to be written
      // after the material, not before.
      this.setMaterial(x, y, rule.becomes);
      if (needsSupport[rule.becomes] && odx !== 0 && ody !== 0) {
        this.braceDiagonal(x, y, odx, ody, rule.becomes);
      }
      this.setMaterial(tx, ty, mat);
      g[tIdx] = packGrowth(energy - 1, nextDir, gen, variant);
      this._growthTouched.add(tIdx);

      // Branches fork from the node just vacated, so a limb leaves the trunk
      // rather than the growing point, and off the *base* heading rather than
      // off a wobble.
      this.branchFrom(x, y, mat, rule, energy, dir0, gen, variant);
      if (rule.foliage && this.random() < rule.foliage.chance) {
        this.scatterFoliage(x, y, rule.foliage.into);
      }
      return true;
    }

    this.terminateTip(x, y, dir0, rule);
    return true;
  }

  /** True if a tip at `(x, y)` could step to `heading`. */
  private tipCanEnter(
    x: number,
    y: number,
    heading: number,
    intoMats: MaterialType[] | undefined,
  ): boolean {
    octantOffset(this._growthFrame, heading, this._growthOffset);
    const tx = x + this._growthOffset.dx;
    const ty = y + this._growthOffset.dy;
    if (tx < 0 || tx >= this.width || ty < 0 || ty >= this.height) return false;
    const tIdx = this.getIndex(tx, ty);
    if (this._growthTouched.has(tIdx)) return false;
    const tMat = this.grid[tIdx];
    return intoMats ? intoMats.includes(tMat) : tMat === MaterialType.EMPTY;
  }

  /**
   * Fill the corner beside a diagonal step, so a limb is cardinally connected.
   *
   * A diagonal chain of trunk cells touches only at the corners, and the
   * support test {@link MaterialDef.needsSupport} runs is cardinal-only — so a
   * 45° limb is unsupported along its whole length and collapses as fast as it
   * is written. Traced on a 24-energy tree: the tip stepped up-right from the
   * base, and the trunk cell it left behind on the *next* step had empty cells
   * on all four sides and fell one row on the following frame, every time.
   *
   * Bracing fills one of the two corner cells, each of which is cardinally
   * adjacent to both the cell just vacated and the one the tip is moving into,
   * so the limb is connected however it turns. This is the same rule pixel art
   * uses for diagonal lines, and it costs one cell per diagonal step.
   *
   * It cannot be conditional on the current cell being unsupported: the cell
   * that ends up dangling is the one written on the *following* step, which
   * does not exist yet.
   */
  private braceDiagonal(x: number, y: number, dx: number, dy: number, mat: MaterialType): void {
    // Step out, then up: the lower corner reads as a thicker joint at the fork,
    // which is where a real limb carries its load.
    const outX = x + dx;
    if (
      outX >= 0 && outX < this.width &&
      this.grid[this.getIndex(outX, y)] === MaterialType.EMPTY
    ) {
      this.setMaterial(outX, y, mat);
      this._growthTouched.add(this.getIndex(outX, y));
      return;
    }
    const upY = y + dy;
    if (
      upY >= 0 && upY < this.height &&
      this.grid[this.getIndex(x, upY)] === MaterialType.EMPTY
    ) {
      this.setMaterial(x, upY, mat);
      this._growthTouched.add(this.getIndex(x, upY));
    }
  }

  /** Convert a spent or blocked tip into its terminal material, with canopy and seed. */
  private terminateTip(x: number, y: number, dir: number, rule: TipRule): void {
    this.setMaterial(x, y, rule.terminal);

    const canopy = rule.canopy;
    if (canopy) {
      const r = canopy.radius;
      // Rounded, not the square a Chebyshev radius would give: a crown made of
      // literal blocks reads as scenery someone stamped, and the corners are
      // what give it away.
      const r2 = r * r + r;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (dx * dx + dy * dy > r2) continue;
          const cx = x + dx;
          const cy = y + dy;
          if (cx < 0 || cx >= this.width || cy < 0 || cy >= this.height) continue;
          if (this.grid[this.getIndex(cx, cy)] !== MaterialType.EMPTY) continue;
          this.setMaterial(cx, cy, canopy.into);
        }
      }
    }

    const seeds = rule.seeds;
    if (seeds && this.random() < seeds.chance) {
      octantOffset(this._growthFrame, dir, this._growthOffset);
      const sx = x + this._growthOffset.dx;
      const sy = y + this._growthOffset.dy;
      if (
        sx >= 0 && sx < this.width && sy >= 0 && sy < this.height &&
        this.grid[this.getIndex(sx, sy)] === MaterialType.EMPTY
      ) {
        this.setMaterial(sx, sy, seeds.into);
      }
    }
  }

  /** Fork one or more branches from the node at `(x, y)`. */
  private branchFrom(
    x: number,
    y: number,
    mat: MaterialType,
    rule: TipRule,
    energy: number,
    dir: number,
    gen: number,
    variant: number,
  ): void {
    const turns = rule.branchTurns;
    if (turns === undefined || turns.length === 0) return;
    if (gen >= (rule.maxGen ?? 3)) return;
    if (energy < (rule.branchMinEnergy ?? 4)) return;

    const childEnergy = Math.floor(energy * (rule.branchTaper ?? 0.6));
    if (childEnergy <= 0) return;

    // The genome masks which turns this individual may take, so one material
    // yields systematically different silhouettes — a tree that only ever
    // branches left is a different tree, not just a different roll. A variant
    // that would disable every available turn is read as "all of them", so no
    // plant is condemned to grow as a bare stick.
    const turnMask = (1 << Math.min(4, turns.length)) - 1;
    let enabled = variant & turnMask;
    if (enabled === 0) enabled = turnMask;

    for (let t = 0; t < turns.length; t++) {
      if (t < 4 && (enabled & (1 << t)) === 0) continue;
      // Regular pinnae (a frond) or stochastic limbs (a tree) — this is the
      // whole difference between the fern and the tree silhouette.
      const fires =
        rule.branchEvery !== undefined
          ? energy % rule.branchEvery === 0
          : this.random() < (rule.branchChance ?? 0);
      if (!fires) continue;

      const heading = (dir + turns[t] + 8) & 7;
      octantOffset(this._growthFrame, heading, this._growthOffset);
      const bx = x + this._growthOffset.dx;
      const by = y + this._growthOffset.dy;
      if (bx < 0 || bx >= this.width || by < 0 || by >= this.height) continue;
      const bIdx = this.getIndex(bx, by);
      if (this._growthTouched.has(bIdx)) continue;
      if (this.grid[bIdx] !== MaterialType.EMPTY) continue;

      this.setMaterial(bx, by, mat);
      this.allocGrowth()[bIdx] = packGrowth(childEnergy, heading, gen + 1, variant);
      this._growthTouched.add(bIdx);
    }
  }

  /** Drop a leaf beside a branch node, where one would actually stay put. */
  private scatterFoliage(x: number, y: number, into: MaterialType): void {
    const targets = this._growthTargets;
    targets.length = 0;
    for (let d = 0; d < 8; d++) {
      octantOffset(this._growthFrame, d, this._growthOffset);
      const fx = x + this._growthOffset.dx;
      const fy = y + this._growthOffset.dy;
      if (fx < 0 || fx >= this.width || fy < 0 || fy >= this.height) continue;
      const fIdx = this.getIndex(fx, fy);
      if (this._growthTouched.has(fIdx)) continue;
      if (this.grid[fIdx] !== MaterialType.EMPTY) continue;
      targets.push(fIdx);
    }
    if (targets.length === 0) return;
    const pick =
      targets.length === 1 ? targets[0] : targets[Math.floor(this.random() * targets.length)];
    const px = pick % this.width;
    const py = (pick - px) / this.width;
    this.setMaterial(px, py, into);
    this._growthTouched.add(pick);
  }

  /** Contact transformation: accretion, and germination. Returns true if it fired. */
  private stepAggregate(idx: number, x: number, y: number, rule: AggregateRule): boolean {
    if (rule.tempRange && !this.inTempRange(idx, rule.tempRange)) return false;
    if (!this.neighborhoodHasAny(x, y, rule.contact)) return false;
    if (this.random() >= rule.chance) return false;

    this.setMaterial(x, y, rule.into);
    this._growthTouched.add(idx);

    const state = rule.state;
    if (state) {
      const g = this.allocGrowth();
      const variant =
        state.variant === 'random'
          ? Math.floor(this.random() * 16)
          : (state.variant ?? 0);
      g[idx] = packGrowth(state.energy, state.dir === 'up' ? 0 : state.dir, 0, variant);
    }
    return true;
  }

  /** True if every material in `mats` appears in the 8-neighbourhood of `(x, y)`. */
  private neighborhoodHasAll(x: number, y: number, mats: MaterialType[]): boolean {
    for (let m = 0; m < mats.length; m++) {
      let found = false;
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;
          if (this.grid[this.getIndex(nx, ny)] === mats[m]) {
            found = true;
            break;
          }
        }
      }
      if (!found) return false;
    }
    return true;
  }

  /** True if any material in `mats` appears in the 8-neighbourhood of `(x, y)`. */
  private neighborhoodHasAny(x: number, y: number, mats: MaterialType[]): boolean {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;
        if (mats.includes(this.grid[this.getIndex(nx, ny)])) return true;
      }
    }
    return false;
  }

  /** How many of the 8 neighbours of `(x, y)` hold `mat`. */
  private countNeighbors(x: number, y: number, mat: MaterialType): number {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= this.width || ny < 0 || ny >= this.height) continue;
        if (this.grid[this.getIndex(nx, ny)] === mat) n++;
      }
    }
    return n;
  }

  /**
   * True if `(x, y)` has something under it, gravity-relative.
   *
   * Reads `down` from the frame of the cell currently being grown, which is one
   * step away — close enough at this scale, and it keeps the check to a single
   * lookup. Off the grid counts as footing, matching {@link getMaterial}'s
   * out-of-bounds-is-WALL convention, so a lawn does not unravel at the edges.
   *
   * `exclude` is what the caller is growing, and it does not count as ground.
   * Letting a material stand on itself turns "must have something under it"
   * into no constraint at all after the first cell: grass grew a footing for
   * its own next cell and went up in one-wide columns instead of sideways.
   * Excluding it is what keeps ground cover a single layer following terrain.
   */
  private hasFooting(x: number, y: number, exclude: MaterialType): boolean {
    const bx = x + this._growthFrame.down.dx;
    const by = y + this._growthFrame.down.dy;
    if (bx < 0 || bx >= this.width || by < 0 || by >= this.height) return true;
    const below = this.grid[this.getIndex(bx, by)];
    return below !== MaterialType.EMPTY && below !== exclude;
  }

  /** True if cell `idx`'s temperature is inside `[min, max]`. */
  private inTempRange(idx: number, range: [number, number]): boolean {
    const t = this.heatGrid ? this.heatGrid[idx] : this._ambientTemperature;
    return t >= range[0] && t <= range[1];
  }

  /** Empty cells within a two-step probe along `heading`, stopping at the first block. */
  private openness(x: number, y: number, heading: number): number {
    octantOffset(this._growthFrame, heading, this._growthOffset);
    const dx = this._growthOffset.dx;
    const dy = this._growthOffset.dy;
    let open = 0;
    for (let d = 1; d <= 2; d++) {
      const tx = x + dx * d;
      const ty = y + dy * d;
      if (tx < 0 || tx >= this.width || ty < 0 || ty >= this.height) break;
      if (this.grid[this.getIndex(tx, ty)] !== MaterialType.EMPTY) break;
      open++;
    }
    return open;
  }

  /**
   * Order candidate headings by how much open space lies ahead of each.
   *
   * The cheap cellular reduction of space colonization's premise that what
   * shapes a canopy is competition for room. Ties break toward the current
   * heading and then by ascending octant — an explicit total order, because
   * leaving ties to `Array.prototype.sort` would make deterministic growth
   * depend on the engine's sort implementation.
   */
  private sortByOpenness(x: number, y: number, headings: number[], dir: number): void {
    const n = headings.length;
    const scores = this._growthScores;
    scores.length = 0;
    for (let i = 0; i < n; i++) scores.push(this.openness(x, y, headings[i]));

    // Insertion sort: n is 3, and it keeps the tiebreak explicit and readable.
    for (let i = 1; i < n; i++) {
      const h = headings[i];
      const s = scores[i];
      let j = i - 1;
      while (j >= 0 && this.headingBefore(h, s, headings[j], scores[j], dir)) {
        headings[j + 1] = headings[j];
        scores[j + 1] = scores[j];
        j--;
      }
      headings[j + 1] = h;
      scores[j + 1] = s;
    }
  }

  /** Strict "a sorts before b" for {@link sortByOpenness}. */
  private headingBefore(
    a: number,
    aScore: number,
    b: number,
    bScore: number,
    dir: number,
  ): boolean {
    if (aScore !== bScore) return aScore > bScore;
    if (a === dir) return b !== dir;
    if (b === dir) return false;
    return a < b;
  }

  private clearUpdatedInActiveChunks(): void {
    const cw = this.chunkWidth;
    const cs = this.CHUNK_SIZE;
    const w = this.width;
    const h = this.height;
    const updated = this.updated;
    const active = this.activeChunks;
    for (let cy = 0; cy < this.chunkHeight; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        if (!active[cy * cw + cx]) continue;
        const xStart = cx * cs;
        const xEnd = Math.min(xStart + cs, w);
        const yStart = cy * cs;
        const yEnd = Math.min(yStart + cs, h);
        for (let y = yStart; y < yEnd; y++) {
          const rowOff = y * w;
          for (let x = xStart; x < xEnd; x++) {
            updated[rowOff + x] = 0;
          }
        }
      }
    }
  }

  /**
   * Advance the simulation one frame.
   *
   * Step order:
   *  1. Clear `updated` flags within active chunks; bump frame counter.
   *  2. Swap active/next chunk buffers (movement + thermal).
   *  3. Drain queued pressure injections. No-op when the queue is empty.
   *     Runs before falling so the `updated` flags it sets on the path and
   *     outlet take effect: a freshly extruded cell is not pulled back down
   *     the conduit this frame.
   *  4. Run the 2×2 checkerboard update (4 passes, frame-alternating
   *     horizontal scan) — material interactions, gas rising, falling +
   *     liquid flow, all gravity-relative.
   *  5. Run liquid levelling, then heat (+ internal phase changes), then
   *     growth. Each acts on where the previous steps left the material.
   *  6. Fire deferred explosions (from FGAS ignition, etc.).
   *  7. Update settle bookkeeping.
   */
  update(): void {
    this.clearUpdatedInActiveChunks();
    this._swapsThisFrame = 0;
    this._growthEventsThisFrame = 0;
    this._pressureMovesThisFrame = 0;
    this._pressureCellsVisitedThisFrame = 0;
    this._blockedInjectionsThisFrame = 0;
    this._fracturesThisFrame = 0;
    this._velocityMovesThisFrame = 0;
    this.frameCount++;
    const deferredExplosions: { x: number; y: number }[] = [];

    // Swap active chunks: this frame simulates what was woken last frame.
    const temp = this.activeChunks;
    this.activeChunks = this.nextActiveChunks;
    this.nextActiveChunks = temp;
    this.nextActiveChunks.fill(0);

    // Same swap for the thermal set, kept independent of the movement set: a
    // motionless flow still cools, and a thermally settled region still moves.
    if (this.thermalChunks && this.nextThermalChunks) {
      const tt = this.thermalChunks;
      this.thermalChunks = this.nextThermalChunks;
      this.nextThermalChunks = tt;
      this.nextThermalChunks.fill(0);
    }

    // Velocity runs before pressure, so a cell impulsed last frame (e.g. at a
    // pressure outlet in 6B) gets to move before the updated flags are cleared
    // for this frame. No-op when the active set is empty.
    this.runVelocityStep();

    // Pressure runs before ordinary falling, so the `updated` flags it sets on
    // the path and outlet take effect: a freshly extruded cell is not pulled
    // straight back down the conduit this frame. No-op when the queue is empty.
    this.runPressureInjections();

    this.runCheckerboardUpdate(deferredExplosions);
    // Falling and reactions resolve first; levelling then acts on where they
    // left the liquid, which is the correct physical order.
    this.runLiquidLevelling();
    // Heat last, so it acts on where the material actually ended up this
    // frame rather than on where it started. No-op when heat is disabled.
    this.runHeatStep();
    // Growth after heat, so a temperature-gated rule reads this frame's
    // temperature rather than last frame's. No-op when nothing is alive.
    this.runGrowth();

    for (const pt of deferredExplosions) {
      this.explode(pt.x, pt.y, 8, 3);
    }

    if (this._settling) {
      this._settleFrameCount++;
      // A world with a tree still growing in it is not settled, even if nothing
      // is moving. Backoff dormancy is what keeps this from being a trap: a
      // mature field emits no growth events, so it still reaches a dead stop.
      const gridStable = this._swapsThisFrame < 5
        && this._growthEventsThisFrame === 0
        && this._velocityMovesThisFrame === 0;
      if (gridStable) {
        this._stableFrames++;
      } else {
        this._stableFrames = 0;
      }
      if (
        this._stableFrames >= SETTLE_STABLE_THRESHOLD ||
        this._settleFrameCount >= SETTLE_TIMEOUT_FRAMES
      ) {
        this._settled = true;
        this._settling = false;
      }
    }
  }

  // --------------------------------------------------------------- velocity (6A)
  //
  // Ballistic movement: each frame, a cell with nonzero velocity attempts to
  // move along its velocity vector under gravity and drag, using a sub-cell
  // remainder so fractional velocities are not truncated. The pass iterates an
  // active set (not the grid) and draws no RNG, so a world with no velocity is
  // byte-for-byte identical to one without the field.

  /**
   * Advance every velocity-bearing cell one frame: integrate gravity and drag,
   * accumulate sub-cell remainder, and move the cell along its velocity vector.
   *
   * Runs before pressure so that a cell impulsed last frame (e.g. at a pressure
   * outlet) moves before `clearUpdatedInActiveChunks` resets the processed flags
   * for this frame. Each velocity-driven swap sets `updated=1` on both cells, so
   * the checkerboard does not re-gravitate the cell this frame — the same
   * discipline the pressure pass uses.
   *
   * Collision rule (V1): a velocity move that hits a non-displaceable cell stops
   * dead (velocity → 0). No chain pushing or splash — that is a later extension.
   */
  private runVelocityStep(): void {
    if (this.velCells.size === 0 || !this.velX) return;

    const w = this.width;
    const h = this.height;
    const vx = this.velX, vy = this.velY!;
    const rx = this.velRemX!, ry = this.velRemY!;
    const grid = this.grid;
    const updated = this.updated;
    const drag = this.velocityDrag;
    const frame = this._frame;
    const probe = this._probeFrame;

    // Snapshot the active set in ascending-index order. A cell that moves during
    // the pass lands at a new index; the snapshot prevents re-processing it.
    const snapshot = Array.from(this.velCells).sort((a, b) => a - b);

    for (const idx of snapshot) {
      if (grid[idx] === MaterialType.EMPTY) { this.velCells.delete(idx); continue; }
      // Do NOT skip on `updated`: a velocity cell written by the pressure pass
      // last frame may still have a stale `updated` flag if its chunk was not
      // active when the flags were cleared. Velocity is the first pass of the
      // frame, so it is safe to process these cells — the flag will be set by
      // the velocity move itself, preventing the checkerboard from re-moving.
      // (Previously this skipped pressure-outlet cells, preventing fountains.)

      let cx = idx % w;
      let cy = (idx - cx) / w;
      let curIdx = idx;

      // --- Gravity integration ---
      // Add gravity to velocity. Direction comes from the gravity model;
      // magnitude from magnitudeAt (defaulting to 1.0).
      fillNeighborFrame(cx, cy, this.gravity, frame);
      const mag = this._magnitudeAt ? this._magnitudeAt(cx, cy) : 1;
      const gx = frame.down.dx * mag * VELOCITY_GRAVITY_SCALE;
      const gy = frame.down.dy * mag * VELOCITY_GRAVITY_SCALE;
      let cvx = Math.max(-127, Math.min(127, vx[curIdx] + Math.trunc(gx)));
      let cvy = Math.max(-127, Math.min(127, vy[curIdx] + Math.trunc(gy)));

      // --- Drag ---
      cvx = Math.trunc(cvx * drag);
      cvy = Math.trunc(cvy * drag);

      // --- Sub-cell remainder + step count ---
      rx[curIdx] += cvx;
      ry[curIdx] += cvy;
      let stepsX = Math.trunc(rx[curIdx] / VELOCITY_CELL_UNIT);
      let stepsY = Math.trunc(ry[curIdx] / VELOCITY_CELL_UNIT);
      rx[curIdx] -= stepsX * VELOCITY_CELL_UNIT;
      ry[curIdx] -= stepsY * VELOCITY_CELL_UNIT;

      // Clamp step count so a single cell cannot traverse the whole grid.
      const maxSteps = 4;
      if (stepsX > maxSteps) stepsX = maxSteps;
      if (stepsX < -maxSteps) stepsX = -maxSteps;
      if (stepsY > maxSteps) stepsY = maxSteps;
      if (stepsY < -maxSteps) stepsY = -maxSteps;

      // --- Bresenham-style multi-cell move ---
      // Walk the dominant axis one cell at a time, alternating to the minor axis
      // via error accumulation, so a diagonal velocity produces a diagonal stair.
      const absX = Math.abs(stepsX);
      const absY = Math.abs(stepsY);
      const total = Math.max(absX, absY);
      const stepX = stepsX === 0 ? 0 : Math.sign(stepsX);
      const stepY = stepsY === 0 ? 0 : Math.sign(stepsY);
      let err = absX - absY;

      for (let s = 0; s < total; s++) {
        // Bresenham error update: step the minor axis when the error crosses zero.
        err -= absY;
        let dx = 0, dy = 0;
        if (err < 0 && absY > 0) {
          dy = stepY;
          err += absX;
        } else {
          dx = stepX;
        }
        // If both axes have steps and they're equal, step diagonally.
        if (absX > 0 && absY > 0 && err >= 0) { dx = stepX; }
        if (dx === 0 && dy === 0) break;

        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) break;

        // Can the parcel move into the target? Allow EMPTY, less-dense material,
        // OR the same material (a fountain cell punching through a liquid column
        // of its own kind). The same-material case is what lets a pressure-
        // launched lava cell rise through the conduit fill above the vent —
        // without it, the routed lava blocks the fountain. Unlike the checkerboard,
        // we do NOT check `updated` on the target.
        const nIdx = ny * w + nx;
        const nMat = grid[nIdx];
        const curMat = grid[curIdx];
        if (nMat === MaterialType.EMPTY
          || materialDefs[curMat].density > materialDefs[nMat].density
          || nMat === curMat) {
          // Perform the swap. This transfers velocity to the target cell and
          // clears it from the source (via swap's exchange). Both cells are
          // marked updated.
          this.swap(cx, cy, nx, ny);
          curIdx = nIdx;
          cx = nx; cy = ny;
          this._velocityMovesThisFrame++;
        } else {
          // Collision: stop dead. Zero velocity and break.
          cvx = 0; cvy = 0;
          break;
        }
        if (updated[curIdx]) break; // already processed this frame
      }

      // Write back the integrated velocity. If it reached zero, remove from the
      // active set (and clear the remainder so it starts clean if re-impulsed).
      vx[curIdx] = cvx;
      vy[curIdx] = cvy;
      if (cvx | cvy) {
        this.velCells.add(curIdx);
        // Remove the old index from the set if the cell moved.
        if (curIdx !== idx) this.velCells.delete(idx);
      } else {
        this.velCells.delete(curIdx);
        if (curIdx !== idx) this.velCells.delete(idx);
        rx[curIdx] = 0; ry[curIdx] = 0;
      }
    }
    void probe;
  }

  // --------------------------------------------------------------- pressure
  //
  // Connected pressure transport: route an injected liquid volume from its
  // source through a contiguous body of the same liquid to a real boundary
  // outlet, accounting for gravitational head and path resistance. The design
  // is documented in docs/plan-pressure.md; this is its Phase 2 (one-shot
  // lava injection). V1 is lava-only: a material without `pressureResistance`
  // is rejected before any search starts.
  //
  // The router is a bounded Dijkstra search. It draws no RNG, so a world that
  // never injects is byte-for-byte identical to one without the feature, and a
  // world that does inject is deterministic from the request stream alone.

  /**
   * Queue a liquid injection for the next {@link update}. Returns a request id
   * that correlates with the later {@link InjectionResult}.
   *
   * This is a new API style for the engine: existing host methods mutate
   * immediately, but pressure must drain inside `update` so that processed
   * flags, chunk wake-up, routing, and ordinary movement share one
   * deterministic transaction. Requests are drained FIFO in public-call order;
   * that order is part of the "same seed + same sequence of public calls"
   * determinism contract. Reversing two competing requests is allowed (and
   * tested) to reverse their outcome.
   */
  injectLiquid(request: LiquidInjection): number {
    const id = this._nextRequestId++;
    this._injectionQueue.push({
      id,
      req: {
        x: request.x,
        y: request.y,
        material: request.material,
        amount: Math.max(0, Math.floor(request.amount)),
        pressure: Math.max(0, request.pressure),
        temperature: request.temperature,
        color: request.color,
      },
    });
    return id;
  }

  /**
   * Drain and return the injection results accumulated during the last
   * {@link update}. The returned array is reused; copy it if you need to keep
   * it across calls.
   */
  consumeInjectionResults(): readonly InjectionResult[] {
    const out = this._injectionResults;
    this._injectionResults = [];
    return out;
  }

  /** Pressure path shifts performed during the most recent {@link update}. */
  get pressureMovesLastFrame(): number {
    return this._pressureMovesThisFrame;
  }

  /** Cells visited by pressure routing during the most recent {@link update}. */
  get pressureCellsVisitedLastFrame(): number {
    return this._pressureCellsVisitedThisFrame;
  }

  /** Injection requests blocked in whole or part during the last update. */
  get blockedInjectionsLastFrame(): number {
    return this._blockedInjectionsThisFrame;
  }

  /** Solid cells fractured by pressure during the last update. */
  get fracturesLastFrame(): number {
    return this._fracturesThisFrame;
  }

  // ----------------------------------------------------------- velocity (6A)

  /**
   * Set a cell's velocity directly, in fixed-point sub-cell units (see
   * {@link VELOCITY_CELL_UNIT}). Replaces any existing velocity. Allocates the
   * velocity field on first use. Values are clamped to ±127 to prevent `Int8`
   * wraparound. A velocity of zero removes the cell from the active set.
   */
  setVelocity(x: number, y: number, vx: number, vy: number): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    this.allocVelocity();
    const idx = this.getIndex(x, y);
    const cx = Math.max(-127, Math.min(127, Math.trunc(vx)));
    const cy = Math.max(-127, Math.min(127, Math.trunc(vy)));
    this.velX![idx] = cx;
    this.velY![idx] = cy;
    // Remainder is reset — a fresh velocity starts from a clean fractional slate.
    this.velRemX![idx] = 0;
    this.velRemY![idx] = 0;
    if (cx | cy) this.velCells.add(idx);
    else this.velCells.delete(idx);
  }

  /**
   * Add to a cell's existing velocity (impulse = additive delta). Allocates the
   * velocity field on first use. The result is clamped to ±127. An impulse that
   * brings velocity to zero removes the cell from the active set.
   */
  applyImpulse(x: number, y: number, dvx: number, dvy: number): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    this.allocVelocity();
    const idx = this.getIndex(x, y);
    const cx = Math.max(-127, Math.min(127, this.velX![idx] + Math.trunc(dvx)));
    const cy = Math.max(-127, Math.min(127, this.velY![idx] + Math.trunc(dvy)));
    this.velX![idx] = cx;
    this.velY![idx] = cy;
    if (cx | cy) this.velCells.add(idx);
    else { this.velCells.delete(idx); this.velRemX![idx] = 0; this.velRemY![idx] = 0; }
  }

  /** Read a cell's velocity. Returns `{0, 0}` when the field is unallocated. */
  getVelocity(x: number, y: number): { vx: number; vy: number } {
    if (!this.velX || x < 0 || x >= this.width || y < 0 || y >= this.height) return { vx: 0, vy: 0 };
    const idx = this.getIndex(x, y);
    return { vx: this.velX[idx], vy: this.velY![idx] };
  }

  /** Velocity-driven moves performed during the most recent {@link update}. */
  get velocityMovesLastFrame(): number {
    return this._velocityMovesThisFrame;
  }

  /** Cells with nonzero velocity (the active-velocity set size). */
  get activeVelocityCount(): number {
    return this.velCells.size;
  }

  /**
   * Register a persistent pressure source. Each {@link update} the source
   * accrues whole-cell volume in `pending` at `rate` and available head at
   * `pressureRate`, then routes as much pending volume as its head allows
   * through the connected body. While blocked, both accrue up to their caps;
   * when an outlet opens the backlog releases as a bounded surge.
   *
   * Sources are processed in creation order each frame, which is another
   * explicit part of the call-sequence determinism contract. Returns an id for
   * {@link removePressureSource}.
   *
   * This is the steady-flow controller the one-shot {@link injectLiquid} is
   * intentionally awkward as: no host call is needed every frame to maintain
   * the rate, and pressure accumulated behind a block is not discarded.
   */
  addPressureSource(opts: PressureSourceOptions): number {
    const id = this._nextSourceId++;
    this._pressureSources.push({
      id,
      x: opts.x,
      y: opts.y,
      material: opts.material,
      rate: Math.max(0, opts.rate),
      pressureRate: Math.max(0, opts.pressureRate),
      maxPressure: Math.max(0, opts.maxPressure),
      maxPending: Math.max(0, opts.maxPending),
      temperature: opts.temperature,
      outletVelocityEfficiency: Math.max(0, Math.min(1, opts.outletVelocityEfficiency ?? OUTLET_VELOCITY_EFFICIENCY)),
      pending: 0,
      pendingRem: 0,
      availablePressure: 0,
    });
    return id;
  }

  /**
   * Remove a persistent source. Accrual stops immediately; material already in
   * the grid is not deleted. A removed id is not reused.
   */
  removePressureSource(id: number): void {
    const i = this._pressureSources.findIndex(s => s.id === id);
    if (i >= 0) this._pressureSources.splice(i, 1);
  }

  /**
   * Read a source's accumulated `pending` volume and available pressure. Returns
   * `null` if the id is not a live source.
   */
  getPressureSourceState(id: number): PressureSourceState | null {
    const s = this._pressureSources.find(s => s.id === id);
    if (!s) return null;
    return {
      id: s.id, x: s.x, y: s.y, material: s.material,
      pending: s.pending, availablePressure: s.availablePressure,
    };
  }

  /**
   * Allocate the Dijkstra scratch arrays on first use. Sized to the grid, so a
   * pressure-free world pays nothing.
   */
  private allocPressureScratch(): void {
    if (this._pressVisited) return;
    const n = this.width * this.height;
    this._pressVisited = new Uint32Array(n);
    this._pressCost = new Float64Array(n);
    this._pressParent = new Int32Array(n);
    this._pressHops = new Int32Array(n);
    // The heap never holds more cells than the visited ceiling, but sizing it
    // to the grid is simpler and the allocation is one-time.
    this._pressHeap = new Int32Array(n);
    this._pressHeapCost = new Float64Array(n);
  }

  /** Min-heap push. */
  private _heapPush(idx: number, cost: number): void {
    const heap = this._pressHeap!;
    const hCost = this._pressHeapCost!;
    let i = this._pressHeapSize++;
    heap[i] = idx;
    hCost[i] = cost;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (hCost[parent] <= hCost[i]) break;
      const ti = heap[i]; heap[i] = heap[parent]; heap[parent] = ti;
      const tc = hCost[i]; hCost[i] = hCost[parent]; hCost[parent] = tc;
      i = parent;
    }
  }

  /** Min-heap pop. Returns the cell index, or -1 if empty. */
  private _heapPop(): number {
    const heap = this._pressHeap!;
    const hCost = this._pressHeapCost!;
    if (this._pressHeapSize === 0) return -1;
    const top = heap[0];
    const size = --this._pressHeapSize;
    heap[0] = heap[size];
    hCost[0] = hCost[size];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let smallest = i;
      if (l < size && hCost[l] < hCost[smallest]) smallest = l;
      if (r < size && hCost[r] < hCost[smallest]) smallest = r;
      if (smallest === i) break;
      const ti = heap[i]; heap[i] = heap[smallest]; heap[smallest] = ti;
      const tc = hCost[i]; hCost[i] = hCost[smallest]; hCost[smallest] = tc;
      i = smallest;
    }
    return top;
  }

  /**
   * Process every queued injection in FIFO order. Each request's volumes are
   * routed one at a time against the live grid; a request stops at its first
   * rejected volume and reports the remainder as blocked.
   *
   * Routing draws no RNG — it is a pure function of the grid and the request
   * — so the only determinism-relevant ordering is the public-call order of
   * {@link injectLiquid}, which the queue preserves.
   */
  private runPressureInjections(): void {
    if (this._injectionQueue.length === 0 && this._pressureSources.length === 0) return;
    this.allocPressureScratch();

    // Snapshot the queue: routing does not enqueue further requests, but taking
    // a stable copy keeps the contract explicit if that ever changes.
    const queue = this._injectionQueue;
    this._injectionQueue = [];

    for (const { id, req } of queue) {
      let accepted = 0;
      let blocked = 0;
      let maxCost = 0;
      let reason: InjectionRejectionReason | undefined;

      // Pre-flight rejections that cost no search.
      const srcMat = this.getMaterial(req.x, req.y);
      if (!hasPressure[req.material]) {
        reason = 'unsupportedMaterial';
        blocked = req.amount;
      } else if (this._potentialAt === null) {
        reason = 'missingPotential';
        blocked = req.amount;
      } else if (srcMat !== req.material && srcMat !== MaterialType.EMPTY) {
        reason = 'incompatibleSource';
        blocked = req.amount;
      } else {
        // Route volumes one at a time. Each accepted shift mutates the grid, so
        // the next volume searches the new state.
        let stopped = false;
        for (let v = 0; v < req.amount && !stopped; v++) {
          const r = this._routeOneVolume(req);
          if (r.kind === 'accepted') {
            accepted++;
            // One-shot: convert surplus to outlet velocity. No source to deduct
            // from, so the kinetic head is not reclaimed — the energy comes from
            // the one-shot budget, not an accumulator.
            this._applyOutletVelocity(r, req.pressure);
            if (r.cost > maxCost) maxCost = r.cost;
          } else {
            stopped = true;
            reason = r.reason;
            blocked = req.amount - v;
          }
        }
      }

      if (blocked > 0) this._blockedInjectionsThisFrame++;
      this._injectionResults.push({
        requestId: id,
        requested: req.amount,
        accepted,
        blocked,
        maxCost,
        reason,
      });
    }

    // Persistent sources, processed in creation order. Each source accrues
    // volume and pressure, then routes as much pending volume as its head
    // allows. This is the steady-flow controller the one-shot API is
    // intentionally awkward as: no host call is needed every frame, and
    // pressure accumulated behind a block is not discarded.
    if (this._pressureSources.length > 0) {
      this._runPressureSources();
    }
  }

  /**
   * Advance every persistent source one frame: accrue, then route. Source
   * creation order is the processing order, and is part of the call-sequence
   * determinism contract.
   */
  private _runPressureSources(): void {
    for (const s of this._pressureSources) {
      // Accrue whole-cell volume, with a fixed-point remainder for rates < 1.
      s.pendingRem += s.rate;
      const grown = Math.floor(s.pendingRem);
      s.pendingRem -= grown;
      s.pending = Math.min(s.pending + grown, s.maxPending);
      // Accrue available head, capped. Represents continuous pumping; spent by
      // successful routes below.
      s.availablePressure = Math.min(s.availablePressure + s.pressureRate, s.maxPressure);

      if (s.pending <= 0) continue;

      // Pre-flight: unsupported material / missing potential / incompatible
      // source skip routing but keep the accrued state for next frame.
      const srcMat = this.getMaterial(s.x, s.y);
      if (!hasPressure[s.material] || this._potentialAt === null) continue;
      if (srcMat !== s.material && srcMat !== MaterialType.EMPTY) continue;

      // Route pending volume one cell at a time against the source's
      // accumulated head. Each accepted volume deducts its path cost from the
      // available pressure; a rejection stops the source for this frame and
      // leaves the remaining pending volume + pressure for next frame.
      let accepted = 0;
      let maxCost = 0;
      const req: LiquidInjection = {
        x: s.x, y: s.y, material: s.material,
        amount: 1, pressure: s.availablePressure,
        temperature: s.temperature,
      };
      while (s.pending > 0 && s.availablePressure > 0) {
        req.pressure = s.availablePressure;
        const r = this._routeOneVolume(req);
        if (r.kind === 'accepted') {
          accepted++;
          s.pending--;
          // Convert surplus head to outlet velocity (Torricelli), and deduct
          // both transport cost and kinetic head from the source's available
          // pressure. This closes the energy double-count: the head that became
          // velocity is not available to launch the next parcel.
          const kineticHead = this._applyOutletVelocity(r, s.availablePressure, s.outletVelocityEfficiency);
          s.availablePressure = Math.max(0, s.availablePressure - r.cost - kineticHead);
          if (r.cost > maxCost) maxCost = r.cost;
        } else {
          // No affordable liquid outlet. Try to fracture a reachable solid
          // boundary: convert the weakest affordable one to the source material,
          // consuming pressure equal to its strength. The converted cell opens
          // a path that routing will find on a subsequent frame (or the next
          // loop iteration, since the grid has changed). The doc specifies
          // retry "on the next frame"; in practice the converted cell is
          // immediately traversable, so the loop re-enters and routes through
          // it this frame. The per-frame fracture cap bounds the work.
          const fractured = this._tryFracture(s);
          if (!fractured) break; // nothing to break; stop for this frame
        }
      }

      if (accepted > 0) {
        this._injectionResults.push({
          requestId: s.id,
          requested: accepted,
          accepted,
          blocked: 0,
          maxCost,
          reason: undefined,
        });
      }
    }
  }

  /**
   * Find the weakest affordable solid boundary of the source's connected liquid
   * body and fracture it: convert the solid to the source material, deduct its
   * `pressureStrength` from the source's available pressure, and count it
   * against the per-frame fracture cap. Returns `true` if a cell was fractured.
   *
   * The boundary scan is a bounded flood fill from the source, not a Dijkstra —
   * fracture does not need a cost-optimal path, only reachability. The flood
   * reuses the pressure scratch arrays' generation stamp so it costs no full
   * clear.
   */
  private _tryFracture(s: PressureSource): boolean {
    if (this._fracturesThisFrame >= this.fracturePerFrame) return false;
    if (s.availablePressure <= 0) return false;

    const w = this.width;
    const h = this.height;
    const mat = s.material;
    const gen = ++this._pressGen;
    const visited = this._pressVisited!;
    const srcIdx = this.getIndex(s.x, s.y);

    // If the source cell itself is empty, there is no body to flood from.
    if (this.grid[srcIdx] !== mat) return false;

    // Flood fill the connected liquid body, collecting opted-in solid
    // boundaries. Track the weakest affordable one (lowest strength that the
    // available pressure exceeds), breaking ties by lowest cell index for
    // determinism.
    let weakestIdx = -1;
    let weakestStrength = Infinity;
    const stack = this._pressHeap!; // reuse as a LIFO stack
    let stackTop = 0;
    stack[0] = srcIdx;
    visited[srcIdx] = gen;
    let visitedCount = 1;

    while (stackTop >= 0) {
      const cur = stack[stackTop--];
      const cx = cur % w;
      const cy = (cur - cx) / w;
      // Four cardinal neighbours.
      const nbs: number[] = [];
      if (cx > 0) nbs.push(cur - 1);
      if (cx < w - 1) nbs.push(cur + 1);
      if (cy > 0) nbs.push(cur - w);
      if (cy < h - 1) nbs.push(cur + w);

      for (const nb of nbs) {
        const nbMat = this.grid[nb];
        if (nbMat === mat) {
          if (visited[nb] !== gen) {
            visited[nb] = gen;
            visitedCount++;
            if (visitedCount > this.pressureVisitLimit) {
              // Flood exceeded the ceiling: stop expanding, but still fracture
              // from the boundaries found so far rather than silently aborting.
              continue;
            }
            stack[++stackTop] = nb;
          }
        } else if (nbMat !== MaterialType.EMPTY && hasPressureStrength[nbMat]) {
          // Solid boundary that opted into fracture.
          const strength = materialDefs[nbMat].pressureStrength!;
          if (
            s.availablePressure > strength &&
            (strength < weakestStrength ||
              (strength === weakestStrength && nb < weakestIdx))
          ) {
            weakestStrength = strength;
            weakestIdx = nb;
          }
        }
      }
    }

    if (weakestIdx < 0) return false;

    // Fracture: convert the solid to the source material, opening the conduit.
    // This conserves mass (the rock becomes part of the flow) rather than
    // deleting it. The converted cell carries the source temperature if set.
    const fx = weakestIdx % w;
    const fy = (weakestIdx - fx) / w;
    this.setMaterial(fx, fy, mat);
    if (this.heatGrid && s.temperature !== undefined) {
      this.heatGrid[weakestIdx] = s.temperature;
      this.wakeThermalChunk(fx, fy);
    }
    // Consume pressure equal to the strength, so a weakened source stops
    // breaking until it has accumulated more.
    s.availablePressure = Math.max(0, s.availablePressure - weakestStrength);
    this._fracturesThisFrame++;
    this._pressureMovesThisFrame++;
    return true;
  }

  /** The first volume into an EMPTY source cell materializes that cell. */
  private _seedSource(req: LiquidInjection): boolean {
    const idx = this.getIndex(req.x, req.y);
    if (this.grid[idx] !== MaterialType.EMPTY) return false;
    this.setMaterial(req.x, req.y, req.material);
    // `setMaterial` set the heat to spawnTemp (or ambient); override with the
    // requested temperature if the host supplied one. Mirrors how `_shiftPath`
    // seeds the injected parcel at p0.
    if (this.heatGrid && req.temperature !== undefined) {
      this.heatGrid[idx] = req.temperature;
      this.wakeThermalChunk(req.x, req.y);
    }
    if (req.color !== undefined) {
      if (!this.colorGrid) this.colorGrid = new Uint32Array(this.width * this.height);
      this.colorGrid[idx] = req.color;
    }
    this.updated[idx] = 1;
    this._pressureMovesThisFrame++;
    return true;
  }

  /**
   * Route a single whole-cell volume from the request's source to the cheapest
   * affordable outlet, or report why it could not. The search is a bounded
   * Dijkstra over cardinal neighbours.
   *
   * @returns `{ kind: 'accepted', cost, outlet, path }` on success, or
   *          `{ kind: 'rejected', reason }`.
   */
  private _routeOneVolume(
    req: LiquidInjection,
  ):
    | { kind: 'accepted'; cost: number; outletIdx: number; path: number[] }
    | { kind: 'rejected'; reason: InjectionRejectionReason } {
    const pot = this._potentialAt!;
    const w = this.width;
    const h = this.height;
    const mat = req.material;
    const resistance = materialDefs[mat].pressureResistance!;
    const pressure = req.pressure;
    const gen = ++this._pressGen;
    const visited = this._pressVisited!;
    const cost = this._pressCost!;
    const parent = this._pressParent!;
    const hops = this._pressHops!;
    this._pressHeapSize = 0;

    // If the source is empty, the first volume seeds it (an explicit source
    // creation that costs no route head). Subsequent volumes then route through
    // the newly seeded body.
    const srcIdx = this.getIndex(req.x, req.y);
    if (this.grid[srcIdx] === MaterialType.EMPTY) {
      this._seedSource(req);
      return { kind: 'accepted', cost: 0, outletIdx: srcIdx, path: [srcIdx] };
    }

    // Track the cheapest affordable outlet discovered. An outlet is an EMPTY
    // cardinal neighbour of a traversed liquid cell; its candidate cost is the
    // path cost to its parent plus the final edge cost. We evaluate outlets
    // lazily as cells are settled, which is correct because Dijkstra settles
    // cells in nondecreasing cost order — the first affordable outlet found at
    // a given cost tier is globally cheapest up to the tiebreak.
    let bestOutlet = -1;
    let bestOutletCost = Infinity;
    let bestOutletParent = -1;
    let anyOutletSeen = false; // distinguishes `noOutlet` from `insufficientHead`
    let searchLimited = false;

    visited[srcIdx] = gen;
    cost[srcIdx] = 0;
    parent[srcIdx] = -1;
    hops[srcIdx] = 0;
    this._heapPush(srcIdx, 0);

    let visitedCount = 1;

    while (this._pressHeapSize > 0) {
      const cur = this._heapPop();
      const curCost = cost[cur];

      // First-push-wins Dijkstra: each cell is pushed at most once per search
      // (see `if (visited[nb] === gen) continue` below), so there are no stale
      // heap entries to skip. The first time a cell is reached is via its
      // cheapest predecessor, because the heap yields cells in cost order.

      // Once the settled cost exceeds the pressure budget, no cheaper outlet
      // remains reachable (Dijkstra invariant), so stop.
      if (curCost > pressure) break;

      // Expand the four cardinal neighbours in ascending-index order (-x, +x,
      // -y, +y) so the tiebreak is a pure function of cell indices.
      const cx = cur % w;
      const cy = (cur - cx) / w;
      const neighbours: number[] = [];
      if (cx > 0) neighbours.push(cur - 1);
      if (cx < w - 1) neighbours.push(cur + 1);
      if (cy > 0) neighbours.push(cur - w);
      if (cy < h - 1) neighbours.push(cur + w);

      for (const nb of neighbours) {
        const nbMat = this.grid[nb];
        const nbx = nb % w;
        const nby = (nb - nbx) / w;

        if (nbMat === MaterialType.EMPTY) {
          // Outlet candidate. Candidate cost = path cost to `cur` + final edge.
          anyOutletSeen = true;
          const potDiff = Math.max(0, pot(nbx, nby) - pot(cx, cy));
          const candCost = curCost + potDiff + resistance;
          if (candCost > pressure) continue; // unaffordable; keep searching
          if (this._outletBetter(candCost, nb, cur, bestOutletCost, bestOutlet, bestOutletParent)) {
            bestOutletCost = candCost;
            bestOutlet = nb;
            bestOutletParent = cur;
          }
          continue;
        }

        if (nbMat !== mat) continue; // V1 does not route through other liquids

        // Traversable liquid neighbour.
        if (visited[nb] === gen) continue; // already settled or pending
        const potDiff = Math.max(0, pot(nbx, nby) - pot(cx, cy));
        const newCost = curCost + potDiff + resistance;
        if (newCost > pressure) continue; // beyond budget; don't expand
        visited[nb] = gen;
        cost[nb] = newCost;
        parent[nb] = cur;
        hops[nb] = hops[cur] + 1;
        visitedCount++;
        this._pressureCellsVisitedThisFrame++;
        if (visitedCount > this.pressureVisitLimit) {
          searchLimited = true;
          break;
        }
        this._heapPush(nb, newCost);
      }
      if (searchLimited) break;

      // Early exit: if the cheapest affordable outlet has been found and the
      // next cell to settle would cost at least as much, no better outlet can
      // appear (Dijkstra invariant). The outlet's parent is already settled, so
      // a cheaper path to it cannot turn up later.
      if (bestOutlet >= 0 && this._pressHeapSize > 0) {
        if (this._pressHeapCost![0] >= bestOutletCost) break;
      }
    }

    if (searchLimited) {
      // Never accept a partial candidate: a valid outlet may lie beyond the
      // ceiling, so report the limit honestly.
      return { kind: 'rejected', reason: 'searchLimit' };
    }
    if (bestOutlet < 0) {
      // No affordable outlet. `anyOutletSeen` distinguishes the two physical
      // cases: a sealed body (no EMPTY neighbour anywhere) from one whose
      // outlets all cost more than the pressure budget.
      return { kind: 'rejected', reason: anyOutletSeen ? 'insufficientHead' : 'noOutlet' };
    }

    // Reconstruct the path source -> ... -> bestOutletParent.
    const path: number[] = [];
    let node = bestOutletParent;
    while (node >= 0) {
      path.push(node);
      node = parent[node];
    }
    path.reverse(); // source first

    this._shiftPath(req, path, bestOutlet);
    return { kind: 'accepted', cost: bestOutletCost, outletIdx: bestOutlet, path };
  }

  /**
   * Tiebreak for outlet selection. Order: lower total cost, then shorter path
   * (fewer hops to the parent), then lower destination index, then lower
   * predecessor index. A total order with no dependence on `Math.random`,
   * frame parity, or sort stability — see docs/plan-pressure.md.
   */
  private _outletBetter(
    candCost: number, candOutlet: number, candParent: number,
    bestCost: number, bestOutlet: number, bestParent: number,
  ): boolean {
    if (candCost !== bestCost) return candCost < bestCost;
    const candHops = this._pressHops![candParent] + 1;
    const bestHops = bestParent >= 0 ? this._pressHops![bestParent] + 1 : Infinity;
    if (candHops !== bestHops) return candHops < bestHops;
    if (candOutlet !== bestOutlet) return candOutlet < bestOutlet;
    return candParent < bestParent;
  }

  /**
   * Shift parcel state along the path into the outlet and write the injected
   * parcel at the source. For path `p0..pn = bestOutletParent` and outlet `d`:
   * copy `pn -> d`, walk backward `p(n-1) -> pn`, …, then write the injected
   * parcel into `p0`. Material count rises by exactly one.
   *
   * `liquidVel` is cleared on every touched cell: a pressure route is not a
   * surface flow, and a parcel carried up a conduit must not inherit a lateral
   * preference that was meaningful only in the geometry it left.
   */
  /**
   * Convert surplus pressure head to velocity at the outlet cell (Torricelli's
   * law: v = √(2gh)·efficiency), writing it via {@link setVelocity}. Returns the
   * kinetic-energy equivalent in head units, so the caller can deduct it from
   * the source alongside the route cost — closing the energy double-count.
   *
   * Below {@link MIN_OUTLET_SURPLUS} no velocity is written (the effusive case:
   * the cell just extrudes and falls). The direction is the parent→outlet
   * cardinal vector, which is the conduit's exit heading.
   *
   * @param r         The accepted route result (carries outlet index and path).
   * @param headBefore The source's available pressure *before* cost deduction.
   * @returns The kinetic head consumed, or 0 if below threshold.
   */
  private _applyOutletVelocity(
    r: { cost: number; outletIdx: number; path: number[] },
    headBefore: number,
    efficiency: number = OUTLET_VELOCITY_EFFICIENCY,
  ): number {
    const surplus = headBefore - r.cost;
    if (surplus < MIN_OUTLET_SURPLUS) return 0;

    // Torricelli: speed in cells/frame = √(2 · surplus) · efficiency.
    const speedCellsPerFrame = Math.sqrt(2 * surplus) * efficiency;
    const speedFP = Math.round(speedCellsPerFrame * VELOCITY_CELL_UNIT);
    if (speedFP === 0) return 0;

    // Direction: parent → outlet (the conduit's exit heading), plus a lateral
    // spread so the fountain fans outward rather than building a spire. The
    // spread is deterministic — derived from the cell index via a hash, not from
    // the global RNG — so it does not perturb fire/growth randomness. The spread
    // magnitude scales with speed: a faster launch spreads wider.
    const w = this.width;
    const path = r.path;
    const pIdx = path[path.length - 1];
    const px = pIdx % w, py = (pIdx - px) / w;
    const ox = r.outletIdx % w, oy = (r.outletIdx - ox) / w;
    // Base direction along the exit heading.
    let dvx = (ox - px) * speedFP;
    let dvy = (oy - py) * speedFP;
    // Lateral spread: a per-cell deterministic angle in [-spread, +spread].
    // The hash gives a uniform spread; multiplied by speed so faster = wider.
    const hash = ((r.outletIdx * 2654435761) >>> 0) / 4294967296; // 0..1
    const lateral = (hash - 0.5) * 2 * speedFP * OUTLET_LATERAL_SPREAD;
    // Apply lateral along the gravity-perpendicular axis (left/right of the
    // exit heading). For a vertical exit (dvx=0, dvy≠0), lateral is horizontal.
    if (dvx === 0) {
      dvx = Math.round(lateral);
    } else {
      dvy = Math.round(lateral);
    }

    this.setVelocity(ox, oy, dvx, dvy);

    // Kinetic head = v² / (2g), computed from the TOTAL speed (vertical +
    // lateral), so the source pays for all the kinetic energy it imparts. The
    // lateral component is not free energy.
    const totalSpeedCellsPerFrame = Math.sqrt(dvx * dvx + dvy * dvy) / VELOCITY_CELL_UNIT;
    return (totalSpeedCellsPerFrame * totalSpeedCellsPerFrame) / 2;
  }

  private _shiftPath(
    req: LiquidInjection,
    path: number[],
    outletIdx: number,
  ): void {
    const n = path.length;
    // Copy pn -> outlet.
    const pn = path[n - 1];
    const outletX = outletIdx % this.width;
    const outletY = (outletIdx - outletX) / this.width;
    this.copyParcel(pn, outletIdx, outletX, outletY, true);

    // Walk backward: p(i) -> p(i+1) for i from n-2 down to 0.
    for (let i = n - 2; i >= 0; i--) {
      const from = path[i];
      const to = path[i + 1];
      const toX = to % this.width;
      const toY = (to - toX) / this.width;
      this.copyParcel(from, to, toX, toY, true);
    }

    // Write the injected parcel into p0. `setMaterial` resets heat to the
    // material's spawnTemp (or ambient); override with the requested temperature
    // if the host supplied one.
    const p0 = path[0];
    const p0X = p0 % this.width;
    const p0Y = (p0 - p0X) / this.width;
    this.setMaterial(p0X, p0Y, req.material);
    if (this.heatGrid && req.temperature !== undefined) {
      this.heatGrid[p0] = req.temperature;
      this.wakeThermalChunk(p0X, p0Y);
    }
    if (req.color !== undefined) {
      if (!this.colorGrid) this.colorGrid = new Uint32Array(this.width * this.height);
      this.colorGrid[p0] = req.color;
    }
    this.liquidVel[p0] = 0;

    // Mark every touched cell updated so the checkerboard pass does not pull the
    // freshly extruded cell back down the conduit this frame, and wake/dirty
    // every chunk the path crosses. The outlet is touched in addition to the
    // path cells.
    for (const idx of path) {
      this.updated[idx] = 1;
      const x = idx % this.width;
      const y = (idx - x) / this.width;
      this.wakeChunk(x, y);
      this.markRenderDirty(x, y);
    }
    this.updated[outletIdx] = 1;
    {
      const x = outletIdx % this.width;
      const y = (outletIdx - x) / this.width;
      this.wakeChunk(x, y);
      this.markRenderDirty(x, y);
    }
    this._pressureMovesThisFrame++;
  }

  /**
   * The 2×2 checkerboard update pattern.
   *
   * The grid is traversed in four passes, each covering one cell of a 2×2
   * checkerboard tile. Vertical scan is bottom-to-top (so falling materials
   * resolve correctly); horizontal scan direction alternates per frame to
   * remove left/right bias. Only cells in active chunks are processed.
   *
   * All movement is gravity-relative: each cell fetches its
   * {@link NeighborFrame} and uses `down`/`downLeft`/`downRight`/`left`/
   * `right` instead of literal offsets.
   */
  private runCheckerboardUpdate(deferredExplosions: { x: number; y: number }[]): void {
    const passes = [
      { yOff: 0, xOff: 0 },
      { yOff: 0, xOff: 1 },
      { yOff: 1, xOff: 0 },
      { yOff: 1, xOff: 1 },
    ];
    const frame = this._frame;

    for (const pass of passes) {
      for (let cy = this.chunkHeight - 1 - pass.yOff; cy >= 0; cy -= 2) {
        const dir = this.frameCount % 2 === 0 ? 1 : -1;

        let startCX: number;
        let endCX: number;
        if (dir === 1) {
          startCX = pass.xOff;
          endCX = this.chunkWidth;
        } else {
          startCX = this.chunkWidth - 1;
          if (startCX % 2 !== pass.xOff) startCX--;
          endCX = -1;
        }

        for (let cx = startCX; dir === 1 ? cx < endCX : cx > endCX; cx += dir * 2) {
          if (!this.activeChunks[cy * this.chunkWidth + cx]) continue;

          const startY = Math.min(this.height - 1, (cy + 1) * this.CHUNK_SIZE - 1);
          const endY = cy * this.CHUNK_SIZE;

          for (let y = startY; y >= endY; y--) {
            const startX = dir === 1 ? cx * this.CHUNK_SIZE : Math.min(this.width - 1, (cx + 1) * this.CHUNK_SIZE - 1);
            const endX = dir === 1 ? Math.min(this.width, (cx + 1) * this.CHUNK_SIZE) : cx * this.CHUNK_SIZE - 1;

            for (let x = startX; x !== endX; x += dir) {
              const sourceIdx = this.getIndex(x, y);
              if (this.updated[sourceIdx]) continue;

              const mat = this.grid[sourceIdx] as MaterialType;
              if (mat === MaterialType.EMPTY || isImmobile[mat]) continue;

              if (needsSupport[mat]) {
                // Cardinal only, and deliberately so: a diagonally-braced cell
                // falls. This was WOOD's private rule before LEAF needed it.
                const hasSupport =
                  this.isStructural(x, y - 1) ||
                  this.isStructural(x, y + 1) ||
                  this.isStructural(x - 1, y) ||
                  this.isStructural(x + 1, y);
                if (hasSupport) continue;
              }

              const def = materialDefs[mat];

              // --- Gravity-relative movement frame for this cell ---
              fillNeighborFrame(x, y, this.gravity, frame);
              const dDX = frame.down.dx, dDY = frame.down.dy;
              const dlDX = frame.downLeft.dx, dlDY = frame.downLeft.dy;
              const drDX = frame.downRight.dx, drDY = frame.downRight.dy;
              const lDX = frame.left.dx, lDY = frame.left.dy;
              const rDX = frame.right.dx, rDY = frame.right.dy;

              // --- Interactions (lava/fire/acid/FGAS) ---
              if (mat === MaterialType.LAVA || mat === MaterialType.FIRE) {
                if (this.stepLavaOrFire(x, y, sourceIdx, mat, deferredExplosions)) continue;
                if (mat === MaterialType.FIRE) {
                  if (this.random() < 0.1) {
                    const next = this.random() < 0.5 ? MaterialType.SMOKE : MaterialType.EMPTY;
                    this.grid[sourceIdx] = next;
                    this.updated[sourceIdx] = 1;
                    this.wakeChunk(x, y);
                    this.markRenderDirty(x, y);
                    continue;
                  }
                }
              }

              if (mat === MaterialType.ACID) {
                if (this.stepAcid(x, y, sourceIdx)) continue;
              }

              if (mat === MaterialType.FGAS) {
                if (this.stepFgas(x, y, sourceIdx, deferredExplosions)) continue;
              }

              // --- Gas rising (gravity-relative: "up" = -down) ---
              if (def.isGas) {
                // Rise straight up.
                if (this.canDisplace(x, y, x - dDX, y - dDY)) {
                  this.swap(x, y, x - dDX, y - dDY);
                } else {
                  // Try rising diagonally: "up-diagonals" = (-down) + left/right.
                  const upLeftX = lDX - dDX;
                  const upLeftY = lDY - dDY;
                  const upRightX = rDX - dDX;
                  const upRightY = rDY - dDY;
                  const canUL = this.canDisplace(x, y, x + upLeftX, y + upLeftY);
                  const canUR = this.canDisplace(x, y, x + upRightX, y + upRightY);

                  if (canUL && canUR) {
                    if (this.random() < 0.5) this.swap(x, y, x + upLeftX, y + upLeftY);
                    else this.swap(x, y, x + upRightX, y + upRightY);
                  } else if (canUL) {
                    this.swap(x, y, x + upLeftX, y + upLeftY);
                  } else if (canUR) {
                    this.swap(x, y, x + upRightX, y + upRightY);
                  } else {
                    // Gas flowing horizontally along the "ceiling" (level axis).
                    const flowLeft = this.canDisplace(x, y, x + lDX, y + lDY);
                    const flowRight = this.canDisplace(x, y, x + rDX, y + rDY);
                    if (flowLeft && flowRight) {
                      if (this.random() < 0.5) this.swap(x, y, x + lDX, y + lDY);
                      else this.swap(x, y, x + rDX, y + rDY);
                    } else if (flowLeft) {
                      this.swap(x, y, x + lDX, y + lDY);
                    } else if (flowRight) {
                      this.swap(x, y, x + rDX, y + rDY);
                    } else if (mat === MaterialType.STEAM && this.random() < 0.05) {
                      this.grid[sourceIdx] = MaterialType.EMPTY;
                      this.updated[sourceIdx] = 1;
                      this.wakeChunk(x, y);
                      this.markRenderDirty(x, y);
                    } else if (mat === MaterialType.SMOKE && this.random() < 0.02) {
                      this.grid[sourceIdx] = MaterialType.EMPTY;
                      this.updated[sourceIdx] = 1;
                      this.wakeChunk(x, y);
                      this.markRenderDirty(x, y);
                    }
                  }
                }
                continue;
              }

              // --- Falling + liquid flow (gravity-relative) ---
              if (this.canDisplace(x, y, x + dDX, y + dDY)) {
                this.swap(x, y, x + dDX, y + dDY);
              } else if (this.belowYield(x, y, mat, dDX, dDY)) {
                // Yield strength: this parcel is too thin to overcome its own
                // strength, so it stops. Both the diagonals and the level step
                // are blocked; only falling straight down (handled above) stays
                // open, so a cell still in the air keeps falling normally and
                // stiffens only once it has landed.
                //
                // The diagonals have to be included. On a curved planet the
                // quantized movement frame turns every surface into a staircase
                // of one-cell steps, so a diagonal is nearly always available
                // and becomes the creep path: with the diagonals left open, a
                // one-cell-thick sheet crept the whole 180° around the planet at
                // every cooling rate tried, no matter what the level-axis gate
                // said.
                //
                // What keeps that from freezing flows solid is that the
                // threshold is not a constant — see `stiffnessGrid`. Fresh lava
                // is set nearly fluid and moves freely; it stiffens as it cools,
                // so a flow runs while hot and locks where it has chilled.
                this.liquidVel[sourceIdx] = 0;
              } else {
                const canGoLeft = this.canDisplace(x, y, x + dlDX, y + dlDY);
                const canGoRight = this.canDisplace(x, y, x + drDX, y + drDY);
                if (canGoLeft && canGoRight) {
                  if (this.random() < 0.5) this.swap(x, y, x + dlDX, y + dlDY);
                  else this.swap(x, y, x + drDX, y + drDY);
                } else if (canGoLeft) {
                  this.swap(x, y, x + dlDX, y + dlDY);
                } else if (canGoRight) {
                  this.swap(x, y, x + drDX, y + drDY);
                } else if (def.isLiquid) {
                  // Liquid lateral flow, gated on actually getting somewhere.
                  //
                  // A liquid steps along its level axis only if that direction
                  // leads to a cell it could descend from within
                  // `liquidDispersion` steps. With no such gate a liquid slides
                  // sideways into any adjacent hole, which in a partially-filled
                  // pool means every cell moves every frame forever — and
                  // because a lateral swap marks both endpoints `updated`, it
                  // also blocks the cell above from falling in, so the pool can
                  // never compact.
                  //
                  // `liquidVel` is kept as the tiebreak when both directions are
                  // viable, so a flow commits to its direction instead of
                  // dithering. No RNG: the rule is fully deterministic. Offsets
                  // are gravity-relative, so this works unchanged under any
                  // GravityModel. Gases keep their own rising logic.
                  const leftRun = this.flowRun(x, y, mat, lDX, lDY, dDX, dDY, true);
                  const rightRun = this.flowRun(x, y, mat, rDX, rDY, dDX, dDY, false);
                  let chosen: 'L' | 'R' | null = null;
                  // Potential gate: a "level" step must not carry the liquid
                  // uphill. The level axis is quantized to 8 compass
                  // directions, so under curved gravity it is only
                  // approximately level — measured on a planet, 38% of level
                  // steps drift outward by up to 0.54 cells of head. Ungated,
                  // that becomes a ratchet: 379 of 483 liquid moves in a
                  // settled planet lens climb, pumping the body uphill
                  // indefinitely. Real descents are a full cell or more, so
                  // rejecting *any* rise separates noise from genuine flow
                  // without touching the latter. Exactly neutral under flat
                  // gravity, where a level step never changes y.
                  const leftOk = leftRun > 0 && !this.stepRaisesPotential(x, y, lDX, lDY);
                  const rightOk = rightRun > 0 && !this.stepRaisesPotential(x, y, rDX, rDY);
                  if (leftOk && rightOk) {
                    const vel = this.liquidVel[sourceIdx];
                    if (vel < 0) chosen = 'L';
                    else if (vel > 0) chosen = 'R';
                    else if (leftRun < rightRun) chosen = 'L';
                    else if (rightRun < leftRun) chosen = 'R';
                    else chosen = dir === 1 ? 'R' : 'L';
                  } else if (leftOk) {
                    chosen = 'L';
                  } else if (rightOk) {
                    chosen = 'R';
                  } else {
                    // At rest: no descent reachable either way. Drop the flow
                    // memory so a future disturbance starts clean.
                    this.liquidVel[sourceIdx] = 0;
                  }
                  if (chosen === 'L') {
                    this.swap(x, y, x + lDX, y + lDY);
                    this.liquidVel[this.getIndex(x + lDX, y + lDY)] = -1;
                  } else if (chosen === 'R') {
                    this.swap(x, y, x + rDX, y + rDY);
                    this.liquidVel[this.getIndex(x + rDX, y + rDY)] = 1;
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  /**
   * Lava/fire neighbor interactions. Returns true if the cell reacted (and
   * the caller should skip further movement for it this frame).
   *
   * Preserved from the original: FGAS→fire+explosion, ICE→water, lava+water
   * →rock+steam, flammable neighbor ignition, fire+water→empty.
   */
  private stepLavaOrFire(
    x: number,
    y: number,
    sourceIdx: number,
    mat: MaterialType,
    deferredExplosions: { x: number; y: number }[],
  ): boolean {
    // When the heat field is live, the three *phase* reactions below stop being
    // instant contact rules and become temperature-mediated: conduction warms
    // the neighbour and `applyPhaseChanges` transforms it once it crosses a
    // threshold. Left instant, they would pre-empt the entire heat field --
    // ICE.meltsAt would be decorative in any world containing fire, lava would
    // turn to rock on touching water however white-hot it was, and fire beside
    // water would be deleted on frame one, so it could never dry out a moat
    // "given time" because it never gets the time.
    //
    // Combustion is deliberately NOT mediated: the flammability branch below
    // and the FGAS ignition above stay instant whether or not heat is enabled.
    // Ignition here is a probabilistic chemical event rolled against
    // `MaterialDef.flammability`, not a thermal threshold, and thermalising it
    // would mean adding an ignition temperature and re-deriving every
    // flammability value against a heat curve. The line is: phase changes of a
    // substance become thermal, combustion does not.
    //
    // With heat off this is byte-for-byte the original behaviour.
    const heatMediated = this.heatGrid !== null;

    const neighbors = [
      { nx: x, ny: y - 1 },
      { nx: x, ny: y + 1 },
      { nx: x - 1, ny: y },
      { nx: x + 1, ny: y },
    ];
    for (const n of neighbors) {
      if (n.nx < 0 || n.nx >= this.width || n.ny < 0 || n.ny >= this.height) continue;
      const nIdx = this.getIndex(n.nx, n.ny);
      const nMat = this.grid[nIdx] as MaterialType;

      if (nMat === MaterialType.FGAS) {
        this.grid[nIdx] = MaterialType.FIRE;
        this.updated[nIdx] = 1;
        this.wakeChunk(n.nx, n.ny);
        this.markRenderDirty(n.nx, n.ny);
        deferredExplosions.push({ x: n.nx, y: n.ny });
        continue;
      }

      if (nMat === MaterialType.ICE) {
        if (!heatMediated) {
          this.grid[nIdx] = MaterialType.WATER;
          this.updated[nIdx] = 1;
          this.wakeChunk(n.nx, n.ny);
          this.markRenderDirty(n.nx, n.ny);
        }
        // Under heat, conduction warms the ice and ICE.meltsAt melts it.
        continue;
      }

      if (this.updated[nIdx]) continue;

      const nDef = materialDefs[nMat];

      if (mat === MaterialType.LAVA && nMat === MaterialType.WATER && !heatMediated) {
        this.grid[sourceIdx] = MaterialType.ROCK;
        this.updated[sourceIdx] = 1;
        this.grid[nIdx] = MaterialType.STEAM;
        this.updated[nIdx] = 1;
        this.wakeChunk(x, y);
        this.wakeChunk(n.nx, n.ny);
        this.markRenderDirty(x, y);
        this.markRenderDirty(n.nx, n.ny);
        return true;
      } else if (nDef.flammability > 0) {
        if (this.random() * 100 < nDef.flammability) {
          this.grid[nIdx] = MaterialType.FIRE;
          this.updated[nIdx] = 1;
          this.wakeChunk(n.nx, n.ny);
          this.markRenderDirty(n.nx, n.ny);
        }
      } else if (mat === MaterialType.FIRE && nMat === MaterialType.WATER && !heatMediated) {
        this.grid[sourceIdx] = MaterialType.EMPTY;
        this.updated[sourceIdx] = 1;
        this.wakeChunk(x, y);
        this.markRenderDirty(x, y);
        return true;
      }
    }
    return false;
  }

  /** Acid interactions: neutralized by water, dissolves solids. Returns true if reacted. */
  private stepAcid(x: number, y: number, sourceIdx: number): boolean {
    const neighbors = [
      { nx: x, ny: y + 1 },
      { nx: x, ny: y - 1 },
      { nx: x - 1, ny: y },
      { nx: x + 1, ny: y },
    ];
    for (const n of neighbors) {
      if (n.nx < 0 || n.nx >= this.width || n.ny < 0 || n.ny >= this.height) continue;
      const nIdx = this.getIndex(n.nx, n.ny);
      if (this.updated[nIdx]) continue;
      const nMat = this.grid[nIdx] as MaterialType;
      if (nMat === MaterialType.WATER) {
        this.grid[sourceIdx] = MaterialType.WATER;
        this.updated[sourceIdx] = 1;
        this.wakeChunk(x, y);
        this.markRenderDirty(x, y);
        return true;
      } else if (
        nMat === MaterialType.WOOD ||
        nMat === MaterialType.ROCK ||
        nMat === MaterialType.SAND ||
        nMat === MaterialType.WALL
      ) {
        if (this.random() < 0.2) {
          this.grid[nIdx] = MaterialType.EMPTY;
          this.updated[nIdx] = 1;
          this.grid[sourceIdx] = MaterialType.EMPTY;
          this.updated[sourceIdx] = 1;
          this.wakeChunk(x, y);
          this.wakeChunk(n.nx, n.ny);
          this.markRenderDirty(x, y);
          this.markRenderDirty(n.nx, n.ny);
          return true;
        }
      }
    }
    return false;
  }

  /** FGAS ignition by adjacent fire/lava. Returns true if ignited. */
  private stepFgas(
    x: number,
    y: number,
    sourceIdx: number,
    deferredExplosions: { x: number; y: number }[],
  ): boolean {
    const neighbors = [
      { nx: x, ny: y - 1 },
      { nx: x, ny: y + 1 },
      { nx: x - 1, ny: y },
      { nx: x + 1, ny: y },
    ];
    for (const n of neighbors) {
      if (n.nx < 0 || n.nx >= this.width || n.ny < 0 || n.ny >= this.height) continue;
      const nMat = this.grid[this.getIndex(n.nx, n.ny)] as MaterialType;
      if (nMat === MaterialType.FIRE || nMat === MaterialType.LAVA) {
        this.grid[sourceIdx] = MaterialType.FIRE;
        this.updated[sourceIdx] = 1;
        this.wakeChunk(x, y);
        this.markRenderDirty(x, y);
        deferredExplosions.push({ x, y });
        return true;
      }
    }
    return false;
  }

  /**
   * Detonate a circular explosion.
   *
   * Carves the terrain within `radius`: WALL/ROCK within `falloff > 0.7` is
   * cleared outright, within `> 0.3` is pulverized into colored SAND debris
   * and scattered outward. Flammable materials scatter as FIRE. A fire/smoke
   * core ignites in the inner 40% of the radius. Affected chunks are woken
   * and flagged render-dirty.
   *
   * The optional {@link ExplosionHook} (set at construction) is fired at the
   * end with the explosion metadata, so a rigid-body layer or the host game
   * can react (apply impulses, play audio, etc.). v1's default hook is a
   * no-op.
   */
  explode(centerX: number, centerY: number, radius: number, force = 5): void {
    const r2 = radius * radius;
    const scattered: { mat: MaterialType; dx: number; dy: number; color?: number }[] = [];

    const minX = Math.max(0, Math.floor(centerX - radius));
    const maxX = Math.min(this.width - 1, Math.ceil(centerX + radius));
    const minY = Math.max(0, Math.floor(centerY - radius));
    const maxY = Math.min(this.height - 1, Math.ceil(centerY + radius));

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - centerX;
        const dy = y - centerY;
        const dist2 = dx * dx + dy * dy;
        if (dist2 > r2) continue;

        const mat = this.getMaterial(x, y);
        if (mat === MaterialType.EMPTY) continue;

        const dist = Math.sqrt(dist2);
        const falloff = 1 - dist / radius;

        if (mat === MaterialType.WALL || mat === MaterialType.ROCK) {
          if (falloff > 0.7) {
            this.setMaterial(x, y, MaterialType.EMPTY);
          } else if (falloff > 0.3) {
            const idx = y * this.width + x;
            let color: number;
            if (this.colorGrid && this.colorGrid[idx]) {
              color = this.colorGrid[idx];
            } else {
              const c = Materials[mat].color;
              const noise = (((idx * 2654435761) >>> 0) % 21) - 10;
              const r = Math.min(255, Math.max(0, c[0] + noise));
              const g = Math.min(255, Math.max(0, c[1] + noise));
              const b = Math.min(255, Math.max(0, c[2] + noise));
              color = (255 << 24) | (b << 16) | (g << 8) | r;
            }
            scattered.push({ mat: MaterialType.SAND, dx, dy, color });
            this.setMaterial(x, y, MaterialType.EMPTY);
          }
          continue;
        }

        this.setMaterial(x, y, MaterialType.EMPTY);

        if (materialDefs[mat].isGas) continue;

        if (falloff > 0.7) {
          if (materialDefs[mat].flammability > 0) {
            scattered.push({ mat: MaterialType.FIRE, dx, dy });
          }
          continue;
        }

        scattered.push({ mat: materialDefs[mat].flammability > 0 ? MaterialType.FIRE : mat, dx, dy });
      }
    }

    for (const particle of scattered) {
      const dist = Math.sqrt(particle.dx * particle.dx + particle.dy * particle.dy);
      let dirX: number;
      let dirY: number;
      if (dist > 0.001) {
        dirX = particle.dx / dist;
        dirY = particle.dy / dist;
      } else {
        // Gravity-relative up-bias fallback: scatter "up" (away from down).
        fillNeighborFrame(centerX, centerY, this.gravity, this._frame);
        dirX = -this._frame.down.dx;
        dirY = -this._frame.down.dy;
        if (dirX === 0 && dirY === 0) dirY = -1;
      }

      // Launch the debris from its origin cell (cleared to EMPTY by the gather
      // loop above) with a velocity impulse, rather than teleporting it to a
      // guessed destination. The origin cell borders the cleared blast interior,
      // so the velocity pass can step it outward over subsequent frames until it
      // hits uncleared terrain and stops. `force` finally matters: it scales the
      // impulse magnitude.
      const originX = centerX + particle.dx;
      const originY = centerY + particle.dy;
      if (originX >= 0 && originX < this.width && originY >= 0 && originY < this.height) {
        if (this.getMaterial(originX, originY) === MaterialType.EMPTY) {
          this.setMaterial(originX, originY, particle.mat);
          if (particle.color !== undefined) {
            if (!this.colorGrid) this.colorGrid = new Uint32Array(this.width * this.height);
            this.colorGrid[originY * this.width + originX] = particle.color;
          }
          // Velocity impulse: outward direction × force × a small randomised
          // jitter. Explosion is host-invoked and non-frame-driven, so drawing
          // from the engine RNG here does not perturb per-frame determinism.
          const speed = Math.round(force * EXPLOSION_VELOCITY_SCALE * (0.7 + this.random() * 0.6));
          if (speed > 0) {
            this.applyImpulse(originX, originY,
              Math.round(dirX * speed), Math.round(dirY * speed));
          }
        }
      }
    }

    const fireRadius = Math.max(3, Math.floor(radius * 0.4));
    const fr2 = fireRadius * fireRadius;
    for (let y = Math.max(0, Math.floor(centerY - fireRadius)); y <= Math.min(this.height - 1, Math.ceil(centerY + fireRadius)); y++) {
      for (let x = Math.max(0, Math.floor(centerX - fireRadius)); x <= Math.min(this.width - 1, Math.ceil(centerX + fireRadius)); x++) {
        const dx = x - centerX;
        const dy = y - centerY;
        if (dx * dx + dy * dy <= fr2 && this.getMaterial(x, y) === MaterialType.EMPTY) {
          this.setMaterial(x, y, this.random() < 0.6 ? MaterialType.FIRE : MaterialType.SMOKE);
        }
      }
    }

    for (let cy = 0; cy < this.chunkHeight; cy++) {
      for (let cx = 0; cx < this.chunkWidth; cx++) {
        const chunkMinX = cx * this.CHUNK_SIZE;
        const chunkMaxX = chunkMinX + this.CHUNK_SIZE;
        const chunkMinY = cy * this.CHUNK_SIZE;
        const chunkMaxY = chunkMinY + this.CHUNK_SIZE;
        if (
          chunkMaxX >= minX - radius &&
          chunkMinX <= maxX + radius &&
          chunkMaxY >= minY - radius &&
          chunkMinY <= maxY + radius
        ) {
          this.nextActiveChunks[cy * this.chunkWidth + cx] = 1;
          this.renderDirtyChunks[cy * this.chunkWidth + cx] = 1;
        }
      }
    }

    this._onExplode(centerX, centerY, radius, force);
  }

  /** Begin tracking settle. Call after the player's last action in a turn. */
  beginSettle(): void {
    this._settling = true;
    this._settled = false;
    this._settleFrameCount = 0;
    this._stableFrames = 0;
  }

  /** True once settle has completed (stable or timed out). */
  get isSettled(): boolean {
    return this._settled;
  }

  /** True while settle is in progress. */
  get isSettling(): boolean {
    return this._settling;
  }

  /** Frames elapsed since {@link beginSettle}. */
  get settleFrameCount(): number {
    return this._settleFrameCount;
  }

  /** True if settle completed by timeout (rather than natural stability). */
  get settleTimedOut(): boolean {
    return this._settled && this._settleFrameCount >= SETTLE_TIMEOUT_FRAMES;
  }

  /** Swaps performed during the most recent {@link update}. */
  get swapsLastFrame(): number {
    return this._swapsThisFrame;
  }

  /** Force every chunk active and render-dirty (e.g. after a full repaint). */
  markAllDirty(): void {
    this._renderDirtyAll = true;
    this.activeChunks.fill(1);
    this.nextActiveChunks.fill(1);
    this.renderDirtyChunks.fill(1);
    if (this.thermalChunks) this.thermalChunks.fill(1);
    if (this.nextThermalChunks) this.nextThermalChunks.fill(1);
  }

  /**
   * How many chunks still have heat in motion. `0` once the thermal field has
   * settled (or when heat is disabled).
   *
   * This — not {@link swapsLastFrame} — is the settle signal for the heat
   * field. Diffusion performs no swaps, so a swap count says nothing about
   * whether heat is still moving.
   */
  get activeThermalChunkCount(): number {
    const t = this.thermalChunks;
    if (t === null) return 0;
    let n = 0;
    for (let i = 0; i < t.length; i++) if (t[i]) n++;
    return n;
  }
}
