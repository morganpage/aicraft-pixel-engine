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
import { MaterialType, Materials, materialDefs, isTerrainSolid } from '../materials';
import { FlatGravity, type GravityModel } from '../gravity';
import type { NeighborFrame } from './types';
import { fillNeighborFrame } from './neighbors';

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
 * 32 (not 16) is the default: it flattens a deep pour's residual staircase to
 * ~1 row at no measured steady-state cost (the scan exits at the first
 * non-passable cell in a packed pool, so a higher value only costs while the
 * liquid is genuinely in motion with open space ahead).
 */
const DEFAULT_LIQUID_DISPERSION = 32;

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

  /** The gravity model driving movement direction. */
  readonly gravity: GravityModel;

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

  constructor(options: PixelEngineOptions) {
    const { width, height } = options;
    this.width = width;
    this.height = height;
    this.grid = new Uint8Array(width * height);
    this.updated = new Uint8Array(width * height);
    this.liquidVel = new Int8Array(width * height);
    this._rngState = (options.seed ?? DEFAULT_SEED) | 0;
    this.gravity = options.gravity ?? new FlatGravity();
    this.CHUNK_SIZE = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.liquidDispersion = options.liquidDispersion ?? DEFAULT_LIQUID_DISPERSION;
    this._onExplode = options.onExplode ?? (() => {});

    this.chunkWidth = Math.ceil(width / this.CHUNK_SIZE);
    this.chunkHeight = Math.ceil(height / this.CHUNK_SIZE);
    this.activeChunks = new Uint8Array(this.chunkWidth * this.chunkHeight);
    this.nextActiveChunks = new Uint8Array(this.chunkWidth * this.chunkHeight);
    this.renderDirtyChunks = new Uint8Array(this.chunkWidth * this.chunkHeight);

    this.clear();
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
    if (oldMat !== mat && this.colorGrid) {
      this.colorGrid[idx] = 0;
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
   * How far along the level axis `(ldx, ldy)` this liquid must travel to reach
   * a cell it could descend from, or 0 if no descent is reachable within
   * {@link liquidDispersion} steps.
   *
   * This is the gate that stops a liquid from flowing for the sake of flowing.
   * A liquid that returns 0 in both directions is at rest and does not move —
   * which is what lets a pool actually go quiet, and what leaves the `updated`
   * flags clear so the cell above can settle downward into it.
   *
   * The path must stay passable the whole way (empty, or a material this one
   * outweighs), so oil floating on water still layers correctly rather than
   * tunnelling through it.
   */
  private flowRun(
    x: number, y: number, mover: number,
    ldx: number, ldy: number,
    ddx: number, ddy: number,
  ): number {
    const moverDensity = materialDefs[mover].density;
    // The first lateral step must be a legal move right now (updated flags).
    if (!this.canDisplace(x, y, x + ldx, y + ldy)) return 0;
    for (let d = 1; d <= this.liquidDispersion; d++) {
      const tx = x + ldx * d, ty = y + ldy * d;
      if (tx < 0 || tx >= this.width || ty < 0 || ty >= this.height) return 0;
      const tMat = this.grid[this.getIndex(tx, ty)];
      // Path must stay passable: empty, or something we outweigh.
      if (tMat !== MaterialType.EMPTY && materialDefs[tMat].density >= moverDensity) return 0;
      // Can we descend from here?
      const bx = tx + ddx, by = ty + ddy;
      if (bx >= 0 && bx < this.width && by >= 0 && by < this.height) {
        const bMat = this.grid[this.getIndex(bx, by)];
        if (bMat === MaterialType.EMPTY || materialDefs[bMat].density < moverDensity) return d;
      }
    }
    return 0;
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

    this.runCheckerboardUpdate(deferredExplosions);

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
                  const leftRun = this.flowRun(x, y, mat, lDX, lDY, dDX, dDY);
                  const rightRun = this.flowRun(x, y, mat, rDX, rDY, dDX, dDY);
                  let chosen: 'L' | 'R' | null = null;
                  if (leftRun > 0 && rightRun > 0) {
                    const vel = this.liquidVel[sourceIdx];
                    if (vel < 0) chosen = 'L';
                    else if (vel > 0) chosen = 'R';
                    else if (leftRun < rightRun) chosen = 'L';
                    else if (rightRun < leftRun) chosen = 'R';
                    else chosen = dir === 1 ? 'R' : 'L';
                  } else if (leftRun > 0) {
                    chosen = 'L';
                  } else if (rightRun > 0) {
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
        this.grid[nIdx] = MaterialType.WATER;
        this.updated[nIdx] = 1;
        this.wakeChunk(n.nx, n.ny);
        this.markRenderDirty(n.nx, n.ny);
        continue;
      }

      if (this.updated[nIdx]) continue;

      const nDef = materialDefs[nMat];

      if (mat === MaterialType.LAVA && nMat === MaterialType.WATER) {
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
      } else if (mat === MaterialType.FIRE && nMat === MaterialType.WATER) {
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
  }
}
