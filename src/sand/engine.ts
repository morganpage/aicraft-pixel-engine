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
import { MaterialType, Materials, materialDefs, isTerrainSolid, isThermal, isImmobile } from '../materials/index.js';
import { FlatGravity, type GravityModel } from '../gravity/index.js';
import type { NeighborFrame } from './types.js';
import { fillNeighborFrame } from './neighbors.js';

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

  private _rngState: number;
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
    this.CHUNK_SIZE = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.liquidDispersion = options.liquidDispersion ?? DEFAULT_LIQUID_DISPERSION;
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
    // Ambient, not zero: the grid is now all EMPTY, and EMPTY has no spawnTemp.
    // Zero-filling would leave a cleared world at absolute cold.
    if (this.heatGrid) this.heatGrid.fill(this.ambientTemperature);
    if (this.thermalChunks) this.thermalChunks.fill(1);
    if (this.nextThermalChunks) this.nextThermalChunks.fill(1);
    this.updated.fill(0);
    this.liquidVel.fill(0);
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
    if (this.heatGrid) {
      const h1 = this.heatGrid[idx1];
      this.heatGrid[idx1] = this.heatGrid[idx2];
      this.heatGrid[idx2] = h1;
      // Heat that moved is heat out of equilibrium with its new surroundings,
      // even if neither cell's temperature changed.
      this.wakeThermalChunk(x1, y1);
      this.wakeThermalChunk(x2, y2);
    }
    this.wakeChunk(x1, y1);
    this.wakeChunk(x2, y2);
    this.markRenderDirty(x1, y1);
    this.markRenderDirty(x2, y2);
    this._swapsThisFrame++;
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

        // Transfer (not a swap — the path between is solid liquid).
        const dIdx = this.getIndex(destX, destY);
        this.grid[dIdx] = mat;
        this.grid[idx] = MaterialType.EMPTY;
        this.updated[dIdx] = 1;
        this.updated[idx] = 1;
        if (this.colorGrid) {
          this.colorGrid[dIdx] = this.colorGrid[idx];
          this.colorGrid[idx] = 0;
        }
        if (this.stiffnessGrid) {
          this.stiffnessGrid[dIdx] = this.stiffnessGrid[idx];
          this.stiffnessGrid[idx] = 0;
        }
        if (this.heatGrid) {
          // The source cell becomes EMPTY, which has no spawnTemp — so it
          // returns to ambient rather than to 0, matching what `clear` does.
          this.heatGrid[dIdx] = this.heatGrid[idx];
          this.heatGrid[idx] = this.ambientTemperature;
          this.wakeThermalChunk(x, y);
          this.wakeThermalChunk(destX, destY);
        }
        this.liquidVel[dIdx] = 0;
        this.liquidVel[idx] = 0;
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
            this.setMaterial(x, y, into);
            heat[idx] = t;
            this.wakeThermalChunk(x, y);
          }
        }
      }
    }
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
   * Step order (preserved from the original engine):
   *  1. Clear `updated` flags within active chunks; bump frame counter.
   *  2. Swap active/next chunk buffers.
   *  3. Run the 2×2 checkerboard update (4 passes, frame-alternating
   *     horizontal scan) — material interactions, gas rising, falling +
   *     liquid flow, all gravity-relative.
   *  4. Fire deferred explosions (from FGAS ignition, etc.).
   *  5. Update settle bookkeeping.
   */
  update(): void {
    this.clearUpdatedInActiveChunks();
    this._swapsThisFrame = 0;
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

    this.runCheckerboardUpdate(deferredExplosions);
    // Falling and reactions resolve first; levelling then acts on where they
    // left the liquid, which is the correct physical order.
    this.runLiquidLevelling();
    // Heat last, so it acts on where the material actually ended up this
    // frame rather than on where it started. No-op when heat is disabled.
    this.runHeatStep();

    for (const pt of deferredExplosions) {
      this.explode(pt.x, pt.y, 8, 3);
    }

    if (this._settling) {
      this._settleFrameCount++;
      const gridStable = this._swapsThisFrame < 5;
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
              if (mat === MaterialType.EMPTY || mat === MaterialType.WALL || mat === MaterialType.ROCK || mat === MaterialType.ICE) continue;

              if (mat === MaterialType.WOOD) {
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

      const scatterDist = radius * 0.5 + this.random() * radius * 1.0;
      const tx = Math.round(centerX + dirX * scatterDist);
      const ty = Math.round(centerY + dirY * scatterDist);

      if (tx >= 0 && tx < this.width && ty >= 0 && ty < this.height) {
        if (this.getMaterial(tx, ty) === MaterialType.EMPTY) {
          this.setMaterial(tx, ty, particle.mat);
          if (particle.color !== undefined) {
            if (!this.colorGrid) this.colorGrid = new Uint32Array(this.width * this.height);
            this.colorGrid[ty * this.width + tx] = particle.color;
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
