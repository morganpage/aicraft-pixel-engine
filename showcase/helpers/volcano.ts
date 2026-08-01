/**
 * Volcano — built entirely on the engine's public API, with no engine changes.
 *
 * This is the stage-0 prototype from `.zcode/plans/design-volcano.md`: it exists
 * to answer whether a volcano needs new engine features (a heat field, a
 * pressure term) or whether the host can supply the missing pieces itself.
 *
 * Three things the engine does not do, and how this fills them in:
 *
 *  1. **Magma does not rise.** Liquids only ever move to equal or lower
 *     gravitational potential, so nothing can climb a conduit. Measured: a
 *     lava-filled conduit is completely static — 0 swaps over 1500 frames.
 *     That stability is useful, so the conduit is treated as a *reservoir* and
 *     {@link emitAtVent} stands in for pressure by feeding the vent directly.
 *
 *  2. **Lava never solidifies except on contact with water.** `LAVA` reaches
 *     `ROCK` only through the lava+water reaction, so on a dry planet a flow
 *     stays molten forever and no edifice can ever build (measured: rock +0
 *     after 2500 frames of eruption). {@link coolLava} supplies the missing
 *     transition.
 *
 *  3. **Lava is a liquid, so it now levels.** Since the height-field levelling
 *     pass, a large uncooled flow spreads toward an equipotential shell rather
 *     than piling into a cone. Cooling therefore has to outpace levelling —
 *     that race is the whole reason a volcano looks like a volcano and not like
 *     an orange ocean.
 *
 * DOM-free and deterministic, so it runs and is tested under Node — the same
 * split the sections use for `renderer.ts`.
 */

import { fillNeighborFrame, type PixelEngine, type NeighborFrame } from '../../src/sand';
import { MaterialType } from '../../src/materials';

/** Geometry of a volcano stamped into a radial-gravity planet. */
export interface VolcanoConfig {
  /** Planet center, in cells. */
  centerX: number;
  centerY: number;
  /** Planet surface radius, in cells. */
  planetRadius: number;
  /** Where the vent sits on the planet, in radians. `-PI/2` is screen-up. */
  ventAngle: number;
  /** Half-width of the conduit shaft, in cells. 1 gives a 3-wide shaft. */
  conduitHalfWidth: number;
  /** Radius of the spherical magma chamber, in cells. */
  chamberRadius: number;
  /** How far below the surface the chamber's center sits, in cells. */
  chamberDepth: number;
}

/** A small deterministic PRNG, kept separate from the engine's own stream. */
export function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The cell just outside the surface at the vent — where lava is fed in. */
export function ventPosition(cfg: VolcanoConfig): { x: number; y: number } {
  return {
    x: Math.round(cfg.centerX + Math.cos(cfg.ventAngle) * (cfg.planetRadius + 1)),
    y: Math.round(cfg.centerY + Math.sin(cfg.ventAngle) * (cfg.planetRadius + 1)),
  };
}

/**
 * Carve a magma chamber and a conduit up to the surface, and fill both with
 * lava.
 *
 * The filled conduit is a static reservoir: every cell is supported by the one
 * below it and walled by rock, so it neither drains nor rises on its own.
 */
export function stampVolcano(engine: PixelEngine, cfg: VolcanoConfig): void {
  const ux = Math.cos(cfg.ventAngle);
  const uy = Math.sin(cfg.ventAngle);
  // Perpendicular to the vent axis, for the shaft's width.
  const px = -uy;
  const py = ux;

  const chamberR = cfg.planetRadius - cfg.chamberDepth;

  // Conduit: from the chamber up to (and just past) the surface.
  for (let r = chamberR; r <= cfg.planetRadius + 1; r++) {
    for (let w = -cfg.conduitHalfWidth; w <= cfg.conduitHalfWidth; w++) {
      const x = Math.round(cfg.centerX + ux * r + px * w);
      const y = Math.round(cfg.centerY + uy * r + py * w);
      engine.setMaterial(x, y, MaterialType.LAVA);
    }
  }

  // Chamber: a disc of lava at the base of the conduit.
  const cxc = cfg.centerX + ux * chamberR;
  const cyc = cfg.centerY + uy * chamberR;
  for (let dy = -cfg.chamberRadius; dy <= cfg.chamberRadius; dy++) {
    for (let dx = -cfg.chamberRadius; dx <= cfg.chamberRadius; dx++) {
      if (dx * dx + dy * dy > cfg.chamberRadius * cfg.chamberRadius) continue;
      engine.setMaterial(Math.round(cxc + dx), Math.round(cyc + dy), MaterialType.LAVA);
    }
  }
}

/** Tuning for {@link emitPlume}. */
export interface PlumeOptions {
  /** Cells of ejecta to launch per frame. */
  perFrame: number;
  /** Half-angle of the launch arc, in radians. Wider = broader, flatter cone. */
  spread: number;
  /** How far above the summit ejecta appears, in cells. */
  loft: number;
  /**
   * Fraction of ejecta launched as molten lava; the remainder is granular
   * tephra. **This is what controls the silhouette.**
   *
   * Lava freezes into `ROCK`, which is a static solid — it never settles, so
   * lava-only eruptions build lumpy mesas full of voids rather than cones.
   * Granular tephra falls and piles at its own angle of repose, which is
   * exactly the mechanism that gives a real cinder cone its shape, and which
   * the engine already models well. A little lava threaded through it reads as
   * active flows without flattening the profile.
   */
  lavaFraction: number;
  /**
   * Stop building once the summit reaches this height above the original
   * surface, in cells. Without a cap the vent tracks its own deposits upward
   * and the cone grows until it hits the edge of the grid.
   */
  maxHeight: number;
}

/**
 * Radius of the summit along the vent axis — the outermost solid cell before
 * the first gap.
 *
 * The vent has to track the growing cone, or the volcano buries its own
 * source: emission is skipped when the target cell is occupied, so a vent
 * pinned to the original planet radius simply stops erupting once its own
 * deposits cover it (measured: the cone stalls at ~5 cells tall). Take the
 * first gap and not the last solid — scanning for the outermost non-empty cell
 * instead picks up airborne ejecta, which drags the vent off into space.
 */
export function surfaceRadiusAt(engine: PixelEngine, cfg: VolcanoConfig, angle: number, limit = 60): number {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  let surface = cfg.planetRadius;
  for (let r = cfg.planetRadius; r < cfg.planetRadius + limit; r++) {
    const x = Math.round(cfg.centerX + ux * r);
    const y = Math.round(cfg.centerY + uy * r);
    if (engine.getMaterial(x, y) === MaterialType.EMPTY) break;
    surface = r;
  }
  return surface;
}

export function summitRadius(engine: PixelEngine, cfg: VolcanoConfig, limit = 60): number {
  const ux = Math.cos(cfg.ventAngle);
  const uy = Math.sin(cfg.ventAngle);
  let summit = cfg.planetRadius;
  for (let r = cfg.planetRadius; r < cfg.planetRadius + limit; r++) {
    const x = Math.round(cfg.centerX + ux * r);
    const y = Math.round(cfg.centerY + uy * r);
    if (engine.getMaterial(x, y) === MaterialType.EMPTY) break;
    summit = r;
  }
  return summit;
}

/**
 * True once the cone has reached `maxHeight` and the eruption is over.
 *
 * Ask this rather than watching for {@link emitPlume} to return 0 — a plume
 * also places nothing on frames where its sampled cells all happen to be
 * occupied, so a zero return means "nothing landed this frame", not
 * "finished". Conflating the two ends an eruption at a random early moment.
 */
export function isDormant(engine: PixelEngine, cfg: VolcanoConfig, maxHeight: number): boolean {
  return summitRadius(engine, cfg) >= cfg.planetRadius + maxHeight;
}

/** Dark basalt tint for tephra, so it does not read as yellow desert sand. */
function tintTephra(engine: PixelEngine, x: number, y: number, rng: () => number): void {
  if (!engine.colorGrid) engine.colorGrid = new Uint32Array(engine.width * engine.height);
  const n = Math.floor(rng() * 18);
  const r = 38 + n, g = 34 + n, b = 36 + n;
  engine.colorGrid[y * engine.width + x] = (255 << 24) | (b << 16) | (g << 8) | r;
}

/**
 * Erupt lava as a lofted plume — the host standing in for magma pressure.
 *
 * **The loft is the whole trick, and it is not obvious.** Feeding lava straight
 * into the vent does not work: the first cell to arrive has nowhere to flow (a
 * planet's summit is locally flat, so there is no one-cell descent and no
 * one-cell drop in potential for the levelling pass either), so it freezes
 * where it lands and walls the vent in. Measured over 1500 frames of
 * vent-feeding: 218 cells emitted, a 2-cell cap, no cone at all.
 *
 * Launching each cell a few cells *above* the surface at a randomised angle
 * lets it fall and land spread across the summit instead of stacking on one
 * spot. Same cooling, same everything else — but an edifice actually builds
 * (measured: 265 cells, 5.3 cells tall, and it still settles to 0 swaps).
 *
 * This is what stands in for the engine's missing pressure term. It is a
 * ballistic approximation, not real hydrostatics — but it produces a volcano.
 *
 * @returns how many cells were placed this call.
 */
export function emitPlume(
  engine: PixelEngine,
  cfg: VolcanoConfig,
  rng: () => number,
  opts: PlumeOptions,
): number {
  const summit = summitRadius(engine, cfg);

  // Cone is at full height. Do NOT simply stop: the cone reaches the cap in
  // ~90 frames, and cutting emission dead leaves the whole scene settled at 0
  // swaps within a second or two, which reads as the app having frozen rather
  // than as an eruption ending.
  //
  // The eruption is finished once the cone reaches its cap.
  //
  // This is a *finite* eruption by design, and the caller must surface that —
  // see the `onDormant` note below. Keeping it running forever was tried and
  // does not work, because nothing in the simulation removes material, so any
  // continuous emission grows the cone without bound. Measured attempts:
  //   - fill the crater each frame  -> scene still frozen (5865 still frames);
  //     a cell at the summit has no one-cell descent so it never moves.
  //   - lava-only from near the peak -> stays alive but cone grew to height 63.
  //   - lava on the flanks only      -> stays alive but cone still grew to 61,
  //     since flank deposits thicken and lift the summit anyway.
  // Bounding it needs a removal mechanism (e.g. periodic `erupt()` blasts
  // excavating the summit), which is a bigger design than this prototype needs.
  if (summit >= cfg.planetRadius + opts.maxHeight) return 0;

  let placed = 0;
  for (let i = 0; i < opts.perFrame; i++) {
    const angle = cfg.ventAngle + (rng() * 2 - 1) * opts.spread;
    const r = summit + 1 + rng() * opts.loft;
    const x = Math.round(cfg.centerX + Math.cos(angle) * r);
    const y = Math.round(cfg.centerY + Math.sin(angle) * r);
    if (engine.getMaterial(x, y) !== MaterialType.EMPTY) continue;
    if (rng() < opts.lavaFraction) {
      engine.setMaterial(x, y, MaterialType.LAVA);
    } else {
      engine.setMaterial(x, y, MaterialType.SAND);
      tintTephra(engine, x, y, rng);
    }
    placed++;
  }
  return placed;
}

/**
 * Remelt anything that has fallen back into the plumbing.
 *
 * **Required, not cosmetic.** Tephra is `SAND` at density 10 and lava is
 * density 8, so ejecta landing on the open vent does not sit on top of the
 * magma — it *sinks through it*, filling the conduit and chamber from the top
 * down. Measured without this: the plumbing went from 163 lava / 0 tephra to
 * **73 lava / 93 tephra within 300 frames** and stayed there. The volcano
 * chokes on its own fallout and the chamber turns to a bag of sand.
 *
 * Magma remelts what falls into it, so restoring the bore each frame is both
 * the physical answer and the cheap one — it touches only the conduit and
 * chamber cells, and keeps the conduit visibly molten.
 *
 * @returns how many cells were remelted this call.
 */
export function remeltConduit(engine: PixelEngine, cfg: VolcanoConfig): number {
  const ux = Math.cos(cfg.ventAngle);
  const uy = Math.sin(cfg.ventAngle);
  const px = -uy;
  const py = ux;
  const chamberR = cfg.planetRadius - cfg.chamberDepth;
  let melted = 0;

  const melt = (x: number, y: number): void => {
    const m = engine.getMaterial(x, y);
    // Only reclaim fallen debris — never eat the surrounding bedrock outside
    // the bore, which is what keeps the conduit walls intact.
    if (m !== MaterialType.SAND && m !== MaterialType.ROCK) return;
    engine.setMaterial(x, y, MaterialType.LAVA);
    melted++;
  };

  for (let r = chamberR; r <= cfg.planetRadius; r++) {
    for (let w = -cfg.conduitHalfWidth; w <= cfg.conduitHalfWidth; w++) {
      melt(Math.round(cfg.centerX + ux * r + px * w), Math.round(cfg.centerY + uy * r + py * w));
    }
  }
  const cxc = cfg.centerX + ux * chamberR;
  const cyc = cfg.centerY + uy * chamberR;
  for (let dy = -cfg.chamberRadius; dy <= cfg.chamberRadius; dy++) {
    for (let dx = -cfg.chamberRadius; dx <= cfg.chamberRadius; dx++) {
      if (dx * dx + dy * dy > cfg.chamberRadius * cfg.chamberRadius) continue;
      melt(Math.round(cxc + dx), Math.round(cyc + dy));
    }
  }
  return melted;
}

/** Cells that count as "cold" for the purposes of chilling a lava cell. */
function isCold(mat: MaterialType): boolean {
  return (
    mat === MaterialType.EMPTY ||
    mat === MaterialType.WATER ||
    mat === MaterialType.STEAM ||
    mat === MaterialType.SMOKE ||
    mat === MaterialType.FIRE
  );
}

/** Tuning for {@link coolLava}. */
export interface CoolOptions {
  /** Per-frame chance a fully-exposed lava cell freezes. 0..1. */
  rate: number;
}

/**
 * Solidify lava that is exposed to air or water — the engine's missing
 * lava→rock transition, supplied host-side.
 *
 * Only *exposed* lava cools: a cell whose neighbours are all lava or rock is
 * insulated and stays molten. That single rule does two jobs. It produces a
 * chilled crust over a molten interior, which is what makes a flow read
 * correctly; and it stops the buried conduit from freezing solid and plugging
 * the volcano permanently, which a naive "lava sometimes becomes rock" rule
 * would do within seconds.
 *
 * @returns how many cells solidified this call.
 */
export function coolLava(engine: PixelEngine, rng: () => number, opts: CoolOptions): number {
  const frame: NeighborFrame = {
    down: { dx: 0, dy: 0 },
    downLeft: { dx: 0, dy: 0 },
    downRight: { dx: 0, dy: 0 },
    left: { dx: 0, dy: 0 },
    right: { dx: 0, dy: 0 },
  };
  let frozen = 0;
  for (let y = 0; y < engine.height; y++) {
    for (let x = 0; x < engine.width; x++) {
      if (engine.getMaterial(x, y) !== MaterialType.LAVA) continue;

      // Only freeze lava that is resting on something.
      //
      // Ejecta is spawned in mid-air (the loft in `emitPlume` is the stand-in
      // for pressure) and the engine has no velocity, so a cell in flight
      // spends several frames as a lone airborne cell with empty neighbours on
      // every side — which is *maximum* exposure by the rule below, i.e. the
      // highest freeze chance, before it has landed anywhere. It then becomes
      // ROCK, a static solid that never falls, and hangs in the sky forever.
      // Measured without this check: 38 of 208 frozen cells were unsupported.
      //
      // Requiring support inverts that correctly — airborne lava stays molten
      // until it lands, and a cell within a flow still has support, so crust
      // formation on real flows is unaffected.
      fillNeighborFrame(x, y, engine.gravity, frame);
      if (engine.getMaterial(x + frame.down.dx, y + frame.down.dy) === MaterialType.EMPTY) continue;

      let exposure = 0;
      if (isCold(engine.getMaterial(x, y - 1))) exposure++;
      if (isCold(engine.getMaterial(x, y + 1))) exposure++;
      if (isCold(engine.getMaterial(x - 1, y))) exposure++;
      if (isCold(engine.getMaterial(x + 1, y))) exposure++;
      if (exposure === 0) continue; // insulated — stays molten
      if (rng() < (opts.rate * exposure) / 4) {
        engine.setMaterial(x, y, MaterialType.ROCK);
        frozen++;
      }
    }
  }
  return frozen;
}

/** Tuning for {@link assimilateTephra}. */
export interface AssimilateOptions {
  /** Per-frame chance of melting an embedded tephra cell. 0..1. */
  rate: number;
  /**
   * How many of a tephra cell's four neighbours must be lava before it counts as
   * *embedded* in magma. Default 3.
   *
   * This threshold is what stops the rule from eating the cone. A tephra cell
   * *trapped inside* a lava body — the grey particles hanging in the magma — has
   * lava on three or four sides. A tephra cell of the cone's flank merely
   * *touching* a thin surface flow has lava on one or two. Threshold 3 melts the
   * former and leaves the latter: measured over a full eruption at threshold 2
   * the cone collapses (sand → 5, slope → 3.8); at threshold 3 it survives
   * (sand → 166, slope → 1.9, both within the steep-cone contract).
   */
  embedThreshold?: number;
}

/**
 * Magma dissolves the tephra trapped inside it — the melt the engine has no rule
 * for, supplied host-side.
 *
 * Tephra is `SAND` (density 10) and lava is density 8, so ejecta that lands in a
 * flow sinks *through* it and lodges there, which is exactly why grey particles
 * hang around in the magma. `remeltConduit` already reclaims debris inside the
 * plumbing; this does the same job anywhere on the cone.
 *
 * The discriminator is *embedding*, not mere contact: a tephra cell is melted
 * only when at least `embedThreshold` (default 3) of its four neighbours are
 * lava. That isolates particles actually engulfed by magma and leaves the cone's
 * flank tephra — which only touches a thin surface flow — intact. A naive
 * "lava touches tephra" rule chain-reacts: each melted cell becomes a new lava
 * source for the layer beneath, measured consuming the entire 16-cell cone and
 * leaving `sand === 0`. The embedding gate breaks that chain.
 *
 * This is a *reaction*, not a displacement: it writes the grid directly, so it
 * ignores the `canDisplace` density gate that otherwise stops lava from moving
 * into denser sand. Per-cell tints must be cleared alongside the conversion: the
 * renderer prefers a `colorGrid` entry over the material palette, so without this
 * a melted tephra cell keeps rendering dark basalt instead of molten orange.
 *
 * @returns how many tephra cells were assimilated this call.
 */
export function assimilateTephra(
  engine: PixelEngine,
  rng: () => number,
  opts: AssimilateOptions,
): number {
  const threshold = opts.embedThreshold ?? 3;
  const w = engine.width;
  const grid = engine.grid;
  let melted = 0;
  for (let y = 0; y < engine.height; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      if (grid[rowOff + x] !== MaterialType.SAND) continue;

      // Count lava among the four orthogonal neighbours. Embedding, not contact.
      let lavaN = 0;
      if (y > 0 && grid[rowOff - w + x] === MaterialType.LAVA) lavaN++;
      if (y < engine.height - 1 && grid[rowOff + w + x] === MaterialType.LAVA) lavaN++;
      if (x > 0 && grid[rowOff + x - 1] === MaterialType.LAVA) lavaN++;
      if (x < w - 1 && grid[rowOff + x + 1] === MaterialType.LAVA) lavaN++;
      if (lavaN < threshold) continue;

      if (rng() >= opts.rate) continue;
      engine.setMaterial(x, y, MaterialType.LAVA);
      // Drop the dark basalt tint, or the renderer keeps showing grey.
      if (engine.colorGrid) engine.colorGrid[rowOff + x] = 0;
      melted++;
    }
  }
  return melted;
}

/**
 * A burst eruption: blow the vent open and throw its contents outward.
 *
 * Uses the engine's existing `explode`, which scatters loose material away from
 * the center and lights a fire/smoke core — fountaining, bombs and a plume for
 * free. Note it also pulverises rock within the blast, so repeated bursts
 * excavate a summit crater; that is realistic, but a large radius will erode
 * the cone faster than flows rebuild it.
 */
export function erupt(engine: PixelEngine, cfg: VolcanoConfig, radius = 6, force = 4): void {
  const v = ventPosition(cfg);
  engine.explode(v.x, v.y, radius, force);
}
