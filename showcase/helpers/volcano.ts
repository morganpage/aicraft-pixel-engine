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

import type { PixelEngine } from '../../src/sand';
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

/**
 * Feed lava at the vent — the host standing in for magma pressure.
 *
 * Deliberately unconditional. An earlier version only emitted into an *empty*
 * vent cell, which silently produced almost no lava at all: surface lava plugs
 * its own vent (measured: ±2° of spread and zero motion after 1200 frames), so
 * the guard was nearly always false. If a source can be blocked, it needs to
 * say what happens when it is.
 *
 * @returns how many cells actually changed to lava this call.
 */
export function emitAtVent(engine: PixelEngine, cfg: VolcanoConfig): number {
  const ux = Math.cos(cfg.ventAngle);
  const uy = Math.sin(cfg.ventAngle);
  const px = -uy;
  const py = ux;
  let emitted = 0;
  for (let w = -cfg.conduitHalfWidth; w <= cfg.conduitHalfWidth; w++) {
    const x = Math.round(cfg.centerX + ux * (cfg.planetRadius + 1) + px * w);
    const y = Math.round(cfg.centerY + uy * (cfg.planetRadius + 1) + py * w);
    if (engine.getMaterial(x, y) === MaterialType.LAVA) continue;
    engine.setMaterial(x, y, MaterialType.LAVA);
    emitted++;
  }
  return emitted;
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
  let frozen = 0;
  for (let y = 0; y < engine.height; y++) {
    for (let x = 0; x < engine.width; x++) {
      if (engine.getMaterial(x, y) !== MaterialType.LAVA) continue;
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
