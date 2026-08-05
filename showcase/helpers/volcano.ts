/**
 * Volcano — a vent-fed, thermally-coloured eruption on a radial-gravity planet.
 *
 * ## How a volcano actually builds, and what each part needs from the sim
 *
 * A stratovolcano is built by *alternating* effusive and explosive episodes:
 * lava wells out of the vent and runs downslope in tongues that chill to rock,
 * and explosive bursts blanket the cone in granular tephra. The interleaved
 * strata — lobes and tongues, not continuous shells — are what give the classic
 * steep cone. Three mechanisms carry that, and each maps onto one piece here:
 *
 *  1. **Magma ascends under pressure and emerges at the vent.** The engine has
 *     no pressure term — liquids only ever move to equal or lower gravitational
 *     potential, so nothing climbs a conduit on its own. {@link pressurizeConduit}
 *     supplies it by advecting the magma column upward a cell at a time and
 *     spilling the top of it into the crater. Because temperature rides along
 *     with the material, you see bright pulses climb the bore.
 *
 *  2. **A flow travels a bounded distance downslope and then stops.** This is
 *     the one that needed engine support. Lava is a Bingham plastic with a
 *     yield strength; water is Newtonian. Treating lava as Newtonian gave two
 *     useless regimes and nothing between them — measured on a lava-fed planet,
 *     a cooling rate of 0.02 let the flow wrap 180° around the planet as an
 *     orange ocean, while 0.5 froze it within 32° of the vent. See
 *     `MaterialDef.yieldThickness`, which lava now sets; it is what produces a
 *     blunt flow front, cooling margins that stall into levees, and an edifice
 *     that can stack at all.
 *
 *  3. **Lava cools through incandescence to dark rock.** This used to be the
 *     helper's largest job. It is now the engine's: `LAVA` sets `spawnTemp`,
 *     `emissivity` and `freezesAt`, and the engine's heat step cools it,
 *     freezes it to `ROCK`, and refuses to freeze a parcel still in flight.
 *
 * ## The temperature field
 *
 * Heat is `engine.heatGrid`, written with `setHeat` and read with `getHeat`.
 *
 * It used to live in the engine's `colorGrid`, quantized into {@link TEMP_STEPS}
 * ramp colours and decoded by looking a cell's exact packed colour back up. That
 * was not perverse — the engine already swaps `colorGrid` alongside `grid` on
 * every swap and levelling transfer, so heat followed its material for free,
 * which a host-side side-array could never do. But it cost a whole colour
 * channel, capped temperature at 48 levels, and forced the ramp to stay
 * disjoint from every tephra tint forever so the decode could tell them apart.
 *
 * The engine now carries temperature as a first-class per-cell field with the
 * same ride-along guarantee, so all of that is gone. What is left here is the
 * part that really is the host's: {@link syncFromHeat} maps temperature onto
 * rheology and colour, and the ramp survives as a palette only.
 *
 * DOM-free and deterministic, so it runs and is tested under Node — the same
 * split the sections use for `renderer.ts`.
 */

import { type PixelEngine } from '../../src/sand';
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
  /**
   * Cells beyond {@link chamberRadius} that {@link remeltConduit} reclaims each
   * frame, to clear ejecta that overshoots the stamped chamber disc and freezes
   * to rock in the halo around it. Default 1.
   *
   * This is the bounded replacement for an engine heat field: a heat step's
   * melting front propagates outward indefinitely (a freshly-melted cell becomes
   * a new heat source for the next ring), but a fixed reclaim disc is re-applied
   * identically every frame, so it can only ever melt this one ring and stops
   * short of the bedrock beyond.
   */
  chamberReclaimHalo?: number;
}

/**
 * A volcano's geometry plus the growth caps that go with it, all derived from
 * one planet radius.
 */
export interface VolcanoGeometry {
  /** Geometry to stamp and step. */
  cfg: VolcanoConfig;
  /** Edifice height the first eruption builds to, in cells above the surface. */
  capStart: number;
  /** How much each subsequent "Erupt again" raises the cap. */
  capStep: number;
  /** Ceiling the cap may never exceed — bounded by the room above the surface. */
  capMax: number;
}

/**
 * Widest the chamber wall ever bulges, as a multiple of `chamberRadius` — the
 * maximum of {@link chamberWall}, `1 + 0.2 + 0.11`. The clearances below are
 * expressed against this rather than against `chamberRadius` itself, because
 * the bulge is what actually decides whether the chamber breaks out.
 */
const CHAMBER_BULGE = 1.31;

/**
 * Derive a volcano's geometry from the planet it sits on.
 *
 * Every dimension here used to be an absolute cell count tuned against one
 * planet radius (66). Those constants do not survive a resizable planet: at a
 * radius of 36 a `chamberDepth` of 26 puts the chamber center 10 cells from the
 * planet core while the chamber body bulges 10.5 cells, so the magma chamber
 * punches straight through the middle of the world.
 *
 * Expressing them as ratios fixes that, and the ratios are chosen to reproduce
 * the hand-tuned values exactly at radius 66 — so the default scene is
 * unchanged and only off-default radii are affected.
 *
 * Two clearances are structural rather than aesthetic, and hold at every radius:
 *
 *  - the chamber stays *below the surface* — `chamberDepth` is never less than
 *    the chamber's own bulge, or the reservoir would be stamped out into open
 *    space above the ground;
 *  - the chamber stays *outside the core* — its center sits far enough from the
 *    planet center that the bulge cannot reach across it.
 *
 * @param centerX - planet center, in cells
 * @param centerY - planet center, in cells
 * @param planetRadius - planet surface radius, in cells
 * @param headroom - free cells between the surface and the nearest grid edge.
 *   Caps the edifice so a tall cone cannot grow off the side of the grid.
 * @param ventAngle - where the vent sits, in radians. Defaults to screen-up.
 */
export function volcanoGeometryFor(
  centerX: number,
  centerY: number,
  planetRadius: number,
  headroom: number,
  ventAngle = -Math.PI / 2,
): VolcanoGeometry {
  const chamberRadius = Math.max(2, Math.round(planetRadius * 0.12));
  const bulge = Math.ceil(chamberRadius * CHAMBER_BULGE);

  // Deep enough to stay buried, but never deeper than leaves the chamber
  // clear of the core. On a small planet those two bounds converge, and the
  // second wins — a chamber that surfaces is cosmetic, one through the core
  // breaks the planet in half.
  const wanted = Math.round(planetRadius * 0.4);
  const deepest = planetRadius - bulge - 2;
  const chamberDepth = Math.max(bulge + 1, Math.min(wanted, deepest));

  // Room between the surface and the grid edge, less a 2-cell margin so the
  // summit never renders hard against the boundary.
  const capMax = Math.max(4, Math.min(Math.round(planetRadius * 0.66), headroom - 2));

  return {
    cfg: {
      centerX,
      centerY,
      planetRadius,
      ventAngle,
      conduitHalfWidth: Math.max(1, Math.min(3, Math.round(planetRadius * 0.018))),
      chamberRadius,
      chamberDepth,
    },
    capStart: Math.min(Math.round(planetRadius * 0.3), capMax),
    capStep: Math.max(2, Math.round(planetRadius * 0.12)),
    capMax,
  };
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

// ---------------------------------------------------------------------------
// Temperature
// ---------------------------------------------------------------------------

/** Quantization of the 0..1 temperature range into ramp colours. */
export const TEMP_STEPS = 48;

/**
 * Incandescence ramp control points, `[t, [r, g, b]]`.
 *
 * The cold end is deliberately *darker* than the `ROCK` palette grey the planet
 * bedrock renders as. Solidified lava is fresh basalt and reads nearly black;
 * ending the ramp lighter than bedrock made every flow settle into a pale slab
 * that was indistinguishable from the ground it had just been poured over, so a
 * whole eruption's worth of new rock simply vanished into the planet.
 *
 * The ramp and the dark basalt tints {@link tintTephra} writes share one
 * `colorGrid`, and they used to be required to stay disjoint forever: the old
 * decode identified a hot cell by looking its exact packed colour back up, so
 * an overlap would have made tephra read as warm rock and be cooled as if it
 * were lava. Nothing reads colour back now, so that constraint is retired
 * along with the test that pinned it.
 */
const RAMP_STOPS: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [0.00, [ 40,  38,  44]], // cold basalt — darker than bedrock grey
  [0.14, [ 62,  50,  52]],
  [0.28, [110,  48,  38]], // dark red glow
  [0.42, [172,  58,  24]],
  [0.56, [226,  94,  20]], // orange
  [0.70, [250, 140,  32]],
  [0.85, [255, 198,  88]], // yellow
  [1.00, [255, 246, 198]], // white-hot
];

/** Packed 0xAABBGGRR ramp colours, indexed 0..TEMP_STEPS-1. */
export const TEMP_RAMP: Uint32Array = (() => {
  const ramp = new Uint32Array(TEMP_STEPS);
  for (let i = 0; i < TEMP_STEPS; i++) {
    const t = i / (TEMP_STEPS - 1);
    let a = RAMP_STOPS[0];
    let b = RAMP_STOPS[RAMP_STOPS.length - 1];
    for (let s = 0; s < RAMP_STOPS.length - 1; s++) {
      if (t >= RAMP_STOPS[s][0] && t <= RAMP_STOPS[s + 1][0]) {
        a = RAMP_STOPS[s];
        b = RAMP_STOPS[s + 1];
        break;
      }
    }
    const span = b[0] - a[0];
    const f = span <= 0 ? 0 : (t - a[0]) / span;
    const r = Math.round(a[1][0] + (b[1][0] - a[1][0]) * f);
    const g = Math.round(a[1][1] + (b[1][1] - a[1][1]) * f);
    const bl = Math.round(a[1][2] + (b[1][2] - a[1][2]) * f);
    ramp[i] = ((255 << 24) | (bl << 16) | (g << 8) | r) >>> 0;
  }
  return ramp;
})();

/** Quantization of the tephra temperature range. */
export const TEPHRA_STEPS = 24;

/**
 * Thermal appearance for fragmented ejecta.
 *
 * Tephra used to reuse {@link TEMP_RAMP}, which made surviving ejecta visually
 * identical to glowing lava while hot and to solidified basalt while cold. The
 * material existed in the grid but could not be read as a granular deposit.
 * This ash-brown ramp stays distinct from both the grey planet bedrock and the
 * near-black basalt ramp while retaining a warm glow in fresh fragments.
 *
 * Alpha 254 is a deliberately invisible provenance bit. `colorGrid` rides with
 * a parcel, so it lets {@link syncFromHeat} recognise cooled tephra after its
 * heat has fallen to ambient without adding another per-cell state array.
 */
export const TEPHRA_RAMP: Uint32Array = (() => {
  const ramp = new Uint32Array(TEPHRA_STEPS);
  const cold = [132, 112, 98] as const;
  const hot = [232, 108, 44] as const;
  for (let i = 0; i < TEPHRA_STEPS; i++) {
    const t = i / (TEPHRA_STEPS - 1);
    const r = Math.round(cold[0] + (hot[0] - cold[0]) * t);
    const g = Math.round(cold[1] + (hot[1] - cold[1]) * t);
    const b = Math.round(cold[2] + (hot[2] - cold[2]) * t);
    ramp[i] = ((254 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }
  return ramp;
})();

/** True when a packed colour carries the tephra provenance marker. */
function isTephraTint(packed: number): boolean {
  return packed !== 0 && (packed >>> 24) === 254;
}

function ensureColorGrid(engine: PixelEngine): Uint32Array {
  if (!engine.colorGrid) engine.colorGrid = new Uint32Array(engine.width * engine.height);
  return engine.colorGrid;
}

/**
 * Temperature of magma in the reservoir — the chamber and the conduit.
 *
 * Not the top of the ramp, on purpose. The chamber is the single largest body of
 * lava on screen, so painting it white-hot turns it into a featureless pale disc
 * that outshines the vent and flattens every flow on the cone into the same
 * cream colour. Sitting it at strong orange keeps it reading as molten rock and
 * leaves the bright end of the ramp for {@link VENT_TEMP} — the freshly-exposed
 * material at the surface, which is where the eye should go.
 */
export const MAGMA_TEMP = 0.75;

/** Temperature of magma the instant it reaches open air at the vent. */
export const VENT_TEMP = 0.95;

/**
 * Yield thickness, in cells, for lava at temperature `t` — how deep a parcel has
 * to be before it will shear sideways at all.
 *
 * Real lava's yield strength climbs by orders of magnitude over the last couple
 * of hundred degrees before it sets, as crystals nucleate and lock the melt up.
 * Everything that makes a flow look like a flow comes out of that one curve:
 *
 *  - fresh lava at the vent is nearly fluid, so it runs downhill and ponds;
 *  - the flow's chilled skin and its front stiffen first, so the front stalls
 *    into a blunt snout and the margins set into levees that channel the still-
 *    mobile core behind them;
 *  - the flow therefore stops at a finite length, set by how far it gets before
 *    it chills — a cooling-limited flow, which is what most real ones are.
 *
 * A single constant cannot do any of that. Held low, lava never stops and levels
 * into an ocean around the planet; held high, it seizes the moment it leaves the
 * vent and stacks into a spire. The whole behaviour lives in the *gradient*.
 */
export function stiffnessForTemp(t: number): number {
  // A yield thickness of 1 can never be met — a single cell is already one cell
  // thick — so it means "free to move at any depth", and a flow held there
  // thins without limit as it spreads: it fans into a half-occupied monolayer
  // and chills cell-by-cell into a checkerboard of specks across the flank.
  //
  // But a *floor* of 2 is the opposite failure, and it is the one that stopped
  // this volcano having flows at all. Two cells of depth is more than a vent
  // can deliver onto a slope: everything the effusive phase erupted stalled the
  // moment it left the crater, ponded there instead, levelled, and froze as a
  // flat-topped slab across the summit. Nothing ever ran down the cone.
  //
  // The resolution is that the fluid window is *narrow and hot*. Only lava
  // within a few hundredths of vent temperature is free to move at any depth;
  // by 0.85 it already needs two cells, and it is losing about 0.08 per frame
  // while exposed. So a flow leaves the vent as a live stream, runs while it is
  // genuinely molten, and stiffens into the ordinary depth-gated regime within
  // a handful of cells — a cooling-limited flow with a blunt stalled front,
  // which is the behaviour the whole yield term exists to produce. It cannot
  // thin indefinitely, because the temperature that permits it does not last.
  // The tiers are set against the engine's measured cooling curve rather than
  // picked by eye. Lava freezes at 0.30 (`LAVA.freezesAt`). A two-cell-thick
  // flow — the thinnest body that can move at all once it is past the live
  // window — falls from vent heat to 0.60 in about 14 frames and to 0.30 in
  // about 36, so tiering the second step at 0.60 buys a tongue roughly a dozen
  // cells of travel before it stiffens, and the front then stalls well before
  // the body has set. Tiering it at 0.72, as it was, left only six: every flow
  // seized within a couple of cells of the crater and the effusive phase read
  // as a puddle rather than a flow.
  if (t >= 0.85) return 1; // live: fresh at the vent, free to run
  if (t >= 0.60) return 2; // mobile
  if (t >= 0.45) return 3;
  if (t >= 0.32) return 5; // just above `LAVA.freezesAt` (0.30)
  return 8; // stiff enough to hold a flow front
}

/** Write a cell's yield thickness, allocating the engine's grid on demand. */
function setStiffness(engine: PixelEngine, x: number, y: number, v: number): void {
  if (!engine.stiffnessGrid) engine.stiffnessGrid = new Uint8Array(engine.width * engine.height);
  engine.stiffnessGrid[y * engine.width + x] = v;
}

/** Place a cell of molten magma, with the rheology its temperature implies. */
function setMagma(engine: PixelEngine, x: number, y: number, t = MAGMA_TEMP): void {
  engine.setMaterial(x, y, MaterialType.LAVA);
  // After setMaterial, never before: a material change resets the cell's heat
  // to the new material's spawnTemp, so a temperature written first is lost.
  engine.setHeat(x, y, t);
  if (x >= 0 && x < engine.width && y >= 0 && y < engine.height) {
    setStiffness(engine, x, y, stiffnessForTemp(t));
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** The cell just outside the surface at the vent — where lava is fed in. */
export function ventPosition(cfg: VolcanoConfig): { x: number; y: number } {
  return {
    x: Math.round(cfg.centerX + Math.cos(cfg.ventAngle) * (cfg.planetRadius + 1)),
    y: Math.round(cfg.centerY + Math.sin(cfg.ventAngle) * (cfg.planetRadius + 1)),
  };
}

/**
 * Radius of the outermost solid cell before the first gap, along `angle`.
 *
 * Take the first gap and not the last solid — scanning for the outermost
 * non-empty cell instead picks up airborne ejecta, which drags the vent off
 * into space.
 */
export function surfaceRadiusAt(
  engine: PixelEngine,
  cfg: VolcanoConfig,
  angle: number,
  limit = 60,
  gapTolerance = 1,
): number {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  let surface = cfg.planetRadius;
  let gap = 0;
  for (let r = cfg.planetRadius; r < cfg.planetRadius + limit; r++) {
    const x = Math.round(cfg.centerX + ux * r);
    const y = Math.round(cfg.centerY + uy * r);
    if (engine.getMaterial(x, y) === MaterialType.EMPTY) {
      // Step over pinholes. A circle rasterized onto a square grid leaves
      // one-cell gaps along some rays, and stopping at the first of them
      // reports bare planet in the middle of a cone — which shows up as a
      // phantom cliff in any profile measured this way, and sends ejecta aimed
      // at that angle to the wrong height.
      if (++gap > gapTolerance) break;
      continue;
    }
    gap = 0;
    surface = r;
  }
  return surface;
}

/**
 * Radius of the summit along the vent axis.
 *
 * The vent has to track the growing cone, or the volcano buries its own source:
 * emission is skipped when the target cell is occupied, so a vent pinned to the
 * original planet radius simply stops erupting once its own deposits cover it.
 */
export function summitRadius(engine: PixelEngine, cfg: VolcanoConfig, limit = 60): number {
  return surfaceRadiusAt(engine, cfg, cfg.ventAngle, limit);
}

/**
 * Height of the *highest* point of the edifice above the original surface,
 * sampled across the summit region.
 *
 * This is what every growth cap has to be measured against, not
 * {@link summitRadius}. Once the volcano has a crater, the vent axis is its
 * *lowest* point, so a cap watching the axis never trips and the rim around it
 * grows without bound — measured at a cap of 20, the rim reached 40 and was
 * still climbing.
 */
export function edificeHeight(engine: PixelEngine, cfg: VolcanoConfig, halfAngle = 0.5, samples = 21): number {
  let h = 0;
  for (let i = 0; i < samples; i++) {
    const a = cfg.ventAngle + (samples === 1 ? 0 : (i / (samples - 1)) * 2 * halfAngle - halfAngle);
    h = Math.max(h, surfaceRadiusAt(engine, cfg, a) - cfg.planetRadius);
  }
  return h;
}

/** True once the cone has reached `maxHeight` and the eruption is over. */
export function isDormant(engine: PixelEngine, cfg: VolcanoConfig, maxHeight: number): boolean {
  return edificeHeight(engine, cfg) >= maxHeight;
}

/**
 * Radius the conduit is maintained to while the volcano is erupting — the point
 * at which the bore opens to the sky, wherever that currently is.
 *
 * A real conduit rises through the edifice it has built; only a dead one ends at
 * the old ground level. So the maintained top has to track the volcano's growth,
 * and the question is what to track it against.
 *
 * Not the original `planetRadius`: within a few tens of frames the mouth is
 * buried under the volcano's own fallout and the source has to *fracture* its
 * way out, which is what built a tower instead of a cone.
 *
 * Not {@link surfaceRadiusAt} along the vent axis either, and not
 * {@link edificeHeight}: both count the lava column the source is *actively
 * pushing up the bore* as ground, so the maintained top chases its own magma
 * outward and the vent grows a spire.
 *
 * What is stable is the geometry itself. Walk the authored bore outward from
 * the chamber and stop at the first ring that is entirely open air — that ring
 * is above the mouth by construction, however tall the cone has become, and it
 * cannot be pushed outward by anything the source does, because a ring the
 * source has filled is no longer empty and a ring it has not is where the vent
 * ends. Debris that lands in the bore extends the walk by exactly as much as it
 * buries the vent.
 *
 * @returns the outermost bore radius still worth maintaining.
 */
export function ventTopRadius(engine: PixelEngine, cfg: VolcanoConfig): number {
  const chamberR = cfg.planetRadius - cfg.chamberDepth;
  // Bounded by the grid: the bore can never be maintained past the point where
  // its own lanes leave the world.
  const limit = cfg.planetRadius + Math.max(engine.width, engine.height);
  let top = chamberR;
  for (let r = chamberR; r <= limit; r++) {
    const hw = boreHalfWidth(cfg, r);
    let solid = false;
    for (let w = -hw; w <= hw && !solid; w++) {
      const p = borePos(cfg, r, w);
      if (p.x < 0 || p.x >= engine.width || p.y < 0 || p.y >= engine.height) return top;
      if (engine.getMaterial(p.x, p.y) !== MaterialType.EMPTY) solid = true;
    }
    if (!solid) return top;
    top = r;
  }
  return top;
}

/**
 * Depth of a bore radius below the chamber roof — the parameter the conduit's
 * shape varies along.
 */
function boreDepth(cfg: VolcanoConfig, r: number): number {
  return r - (cfg.planetRadius - cfg.chamberDepth);
}

/**
 * Sideways wander of the conduit axis at radius `r`, in cells.
 *
 * A conduit drawn as a perfectly straight, perfectly uniform shaft is the single
 * most artificial thing on screen — it reads as a diagram of a volcano rather
 * than a volcano. Real magma exploits fractures and the bore meanders. Two
 * incommensurable sine terms give a non-repeating wander without any state, so
 * every consumer of the geometry derives the same shape from `r` alone.
 */
function boreOffset(cfg: VolcanoConfig, r: number): number {
  const d = boreDepth(cfg, r);
  return Math.sin(d * 0.33) * 1.15 + Math.sin(d * 0.11 + 2.1) * 0.85;
}

/** Half-width of the bore at radius `r`, in cells — it pinches and swells. */
function boreHalfWidth(cfg: VolcanoConfig, r: number): number {
  const d = boreDepth(cfg, r);
  return cfg.conduitHalfWidth + (Math.sin(d * 0.21 + 0.9) > 0.35 ? 1 : 0);
}

/** Grid position of bore lane `w` at radius `r`. */
function borePos(cfg: VolcanoConfig, r: number, w: number): { x: number; y: number } {
  const ux = Math.cos(cfg.ventAngle);
  const uy = Math.sin(cfg.ventAngle);
  const off = boreOffset(cfg, r) + w;
  return {
    x: Math.round(cfg.centerX + ux * r - uy * off),
    y: Math.round(cfg.centerY + uy * r + ux * off),
  };
}

/**
 * Radial scale of the chamber wall at angle `ang`, as a multiple of
 * {@link VolcanoConfig.chamberRadius}.
 *
 * A magma chamber is a lens or a blob, never the perfect disc a naive stamp
 * produces. Same reasoning as {@link boreOffset}: stateless, deterministic, and
 * derived from the angle so any consumer agrees on the shape.
 */
function chamberWall(ang: number): number {
  return 1 + 0.2 * Math.sin(ang * 3 + 1.3) + 0.11 * Math.sin(ang * 5 - 0.7);
}

/** Slight per-cell temperature texture, so a large body is not a flat fill. */
function magmaTexture(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Temperature for a reservoir cell — {@link MAGMA_TEMP} plus a little texture. */
function reservoirTemp(x: number, y: number): number {
  return MAGMA_TEMP * (0.93 + 0.13 * magmaTexture(x, y));
}

/**
 * Carve a magma chamber and a conduit up to the surface, and fill both with
 * molten magma.
 */
export function stampVolcano(engine: PixelEngine, cfg: VolcanoConfig): void {
  const chamberR = cfg.planetRadius - cfg.chamberDepth;

  // Conduit: from the chamber up to (and just past) the surface.
  for (let r = chamberR; r <= cfg.planetRadius + 1; r++) {
    const hw = boreHalfWidth(cfg, r);
    for (let w = -hw; w <= hw; w++) {
      const p = borePos(cfg, r, w);
      setMagma(engine, p.x, p.y, reservoirTemp(p.x, p.y));
    }
  }

  // Chamber: a lumpy blob of lava at the base of the conduit.
  const ux = Math.cos(cfg.ventAngle);
  const uy = Math.sin(cfg.ventAngle);
  const cxc = cfg.centerX + ux * chamberR;
  const cyc = cfg.centerY + uy * chamberR;
  const maxR = cfg.chamberRadius * 1.35;
  for (let dy = -maxR; dy <= maxR; dy++) {
    for (let dx = -maxR; dx <= maxR; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > cfg.chamberRadius * chamberWall(Math.atan2(dy, dx))) continue;
      const x = Math.round(cxc + dx);
      const y = Math.round(cyc + dy);
      setMagma(engine, x, y, reservoirTemp(x, y));
    }
  }
}

// ---------------------------------------------------------------------------
// Conduit ascent + vent effusion
// ---------------------------------------------------------------------------

/** Tuning for the engine pressure source that drives effusive ascent. */
export interface PressureOptions {
  /**
   * Whole-cell volumes the source accrues per frame. Maps to the old `effusion`
   * slider: how vigorously magma is supplied to the conduit.
   */
  effusion: number;
  /**
   * Hydraulic head accrued per frame while the source is blocked. Together with
   * `maxPressure` this determines how long a cap must hold before fracture: at
   * `pressureRate` 1 and ROCK strength 15, a blocked vent takes ~15 frames to
   * build enough head to break through.
   */
  pressureRate: number;
  /** Cap on available head. Bounds how hard a blocked source can push. */
  maxPressure: number;
  /**
   * Fraction of surplus head the effusive source converts to launch velocity.
   * `0` makes it a pure extrusion — see {@link buildVolcanoOpts}.
   */
  outletVelocityEfficiency?: number;
  /** Cap on accrued whole-cell volume. Bounds the surge when an outlet opens. */
  maxPending: number;
  /** Per-update cap on routed parcels — the effusive discharge rate. */
  maxDischargePerFrame?: number;
  /**
   * Stop the source once the edifice reaches this height above the original
   * surface, in cells. Nothing removes material, so an uncapped vent keeps
   * feeding a cone that runs off the grid.
   */
  maxHeight: number;
  /**
   * Vent anchor for corridor-gated routing, shared by both explosive and
   * effusive sources. When set, pressure routing only exits through EMPTY cells
   * within `corridorRadius` of the anchor, so summit lava cannot become
   * additional pressure outlets during either phase.
   */
  ventAnchor?: { cx: number; cy: number; angle: number; corridorRadius: number };
  /**
   * Fracture tuning for the effusive source, shared defaults with the explosive
   * source. When set, effusive fracture uses the same sealed-frame delay, separate
   * budget, and corridor-constrained directional selection as the explosive source.
   */
  fracture?: { minSealedFrames: number; pressureRate: number; maxPressure: number };
  /**
   * Source tuning for the explosive-phase lava fountain. When present, the
   * explosive phase creates a high-pressure source alongside `emitPlume` so
   * surplus head at the vent converts to fountain velocity (Torricelli, 6B).
   * When absent, no fountain source is created and the explosive phase is plume-
   * only (the pre-6C behaviour).
   */
  explosive?: {
    rate: number;
    pressureRate: number;
    maxPressure: number;
    maxPending: number;
    /** Fraction of surplus head converted to launch speed. Default 0.7. */
    outletVelocityEfficiency?: number;
    /**
     * Lateral fan of the fountain, as a fraction of launch speed — the arc the
     * ejecta is thrown across. This is what decides whether the explosive phase
     * builds a cone or a spike: a narrow jet drops everything back down the
     * throat, while a wide arc lands tephra out on the flanks where it piles at
     * its angle of repose. The engine default (0.25 ≈ ±14°) is a plumbing
     * outlet's spread, not a volcano's.
     */
    outletLateralSpread?: number;
    /**
     * Per-update discharge cap (routed parcels). Bounds the catch-up tick when
     * a plug clears so the fountain dribbles back to its steady rate rather
     * than dumping its whole backlog in one frame. Derived from the Fountain
     * Rate slider so the control stays monotonic.
     */
    maxDischargePerFrame?: number;
    /**
     * Fracture tuning for the explosive source. A separate, slow, bounded
     * pressure budget that gates vent reopening on a deliberate timescale, so a
     * sealed plug is not exposed to full transport head the instant it forms.
     */
    fracture?: { minSealedFrames: number; pressureRate: number; maxPressure: number };
    /**
     * Vent anchor for corridor-gated routing. When set, pressure routing only
     * exits through EMPTY cells within `corridorRadius` of the anchor, so
     * laterally spreading summit lava cannot become additional pressure outlets.
     */
    ventAnchor?: { cx: number; cy: number; angle: number; corridorRadius: number };
  };
}

/**
 * The lowest surface point within the crater mouth — where spilled magma goes.
 *
 * Ties are broken at random rather than by scan order, so a flat-floored pond
 * fills evenly instead of building up against whichever edge the loop happened
 * to visit first.
 */
export function craterLowPoint(
  engine: PixelEngine,
  cfg: VolcanoConfig,
  halfAngle: number,
  rng: () => number,
  samples = 9,
): { angle: number; radius: number } {
  let bestR = Infinity;
  let ties = 0;
  let best = cfg.ventAngle;
  for (let i = 0; i < samples; i++) {
    const angle = cfg.ventAngle + (samples === 1 ? 0 : (i / (samples - 1)) * 2 * halfAngle - halfAngle);
    const r = surfaceRadiusAt(engine, cfg, angle);
    if (r < bestR) {
      bestR = r;
      best = angle;
      ties = 1;
    } else if (r === bestR) {
      ties++;
      // Reservoir sampling over the tied minima.
      if (rng() < 1 / ties) best = angle;
    }
  }
  return { angle: best, radius: bestR };
}

// ---------------------------------------------------------------------------
// Explosive plume
// ---------------------------------------------------------------------------

/** Tuning for {@link emitPlume}. */
export interface PlumeOptions {
  /** Cells of ejecta to launch per frame. */
  perFrame: number;
  /** Half-angle of the launch arc, in radians. Wider = broader, flatter cone. */
  spread: number;
  /** How far above the summit ejecta appears, in cells. */
  loft: number;
  /**
   * Fraction of ejecta launched as molten lava bombs; the remainder is granular
   * tephra, which piles at its own angle of repose and is what steepens the cone
   * between effusive episodes.
   */
  lavaFraction: number;
  /** Stop building once the summit reaches this height above the original surface. */
  maxHeight: number;
  /**
   * Fraction of the launch arc kept clear around the vent axis, 0..1. `0.5`
   * confines ejecta to the outer half of the arc, leaving a crater inside it.
   *
   * A cinder cone has a crater because material thrown straight up falls back
   * down the throat and is recycled, while material thrown at an angle lands
   * clear and stays — so the deposit is a ring, not a dome. Reproducing that
   * ring is what gives the effusive phase somewhere to pond: without it the
   * plume fills its own crater with tephra, the next lava has no basin to
   * collect in, and it goes back to dribbling onto a peak.
   */
  rimBias?: number;
}

/** Dark basalt tint for tephra, so it does not read as yellow desert sand. */
function tintTephra(engine: PixelEngine, x: number, y: number, rng: () => number): void {
  const cg = ensureColorGrid(engine);
  const n = Math.floor(rng() * 18);
  const r = 123 + n, g = 103 + n, b = 91 + n;
  // Alpha 254 marks this as tephra for syncFromHeat while remaining visually
  // indistinguishable from fully opaque at showcase scale.
  cg[y * engine.width + x] = ((254 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/**
 * Launch an explosive plume of tephra and lava bombs above the summit.
 *
 * The loft is deliberate. Ejecta placed straight onto the summit has nowhere to
 * flow — a summit is locally flat, so there is no one-cell descent — and simply
 * walls the vent in. Launching each cell a few cells *above* the surface at a
 * randomised angle lets it fall and land spread across the cone instead.
 *
 * @returns how many cells were placed this call.
 */
export function emitPlume(
  engine: PixelEngine,
  cfg: VolcanoConfig,
  rng: () => number,
  opts: PlumeOptions,
): number {
  if (edificeHeight(engine, cfg) >= opts.maxHeight) return 0;

  const rimBias = opts.rimBias ?? 0;
  let placed = 0;
  for (let i = 0; i < opts.perFrame; i++) {
    // Signed offset into the launch arc, drawn from a triangular distribution
    // centred on the rim at `rimBias` and tapering *both* ways.
    //
    // Two separate things depend on this shape. The outward taper is what makes
    // the flank a slope at all: spread material evenly across the arc and the
    // deposit grows as a slab of even thickness that ends in a wall wherever the
    // arc does, which is a plateau, not a cone.
    //
    // The inward tail is what keeps the crater a crater rather than a chasm.
    // Treating `rimBias` as a hard edge that nothing lands inside means the
    // crater floor never rises while the rim climbs, so the notch ends up as
    // deep as the cone is tall and the profile reads as two separate mountains
    // with a canyon between them. Letting fallout thin inward instead — as real
    // ballistic fallout does — fills the floor slowly and leaves a crater in
    // proportion to the cone.
    const side = rng() < 0.5 ? -1 : 1;
    const mag = Math.max(0, Math.min(1, rimBias + (1 - rimBias) * (rng() - rng())));
    const angle = cfg.ventAngle + side * mag * opts.spread;

    // Launch just above the ground *at this angle*, not above the summit.
    //
    // Using the summit radius for every cell regardless of where it was aimed
    // is what built the flat-topped mesa: a cell launched out on the flank was
    // spawned at summit height, far above its local ground, so the arc simply
    // filled up to a uniform radius and ended in a cliff at ±spread. Measured
    // that way, widening the spread made it worse rather than more conical —
    // it just produced a wider slab.
    const local = surfaceRadiusAt(engine, cfg, angle);
    const r = local + 1 + rng() * opts.loft;
    const x = Math.round(cfg.centerX + Math.cos(angle) * r);
    const y = Math.round(cfg.centerY + Math.sin(angle) * r);
    if (engine.getMaterial(x, y) !== MaterialType.EMPTY) continue;
    if (rng() < opts.lavaFraction) {
      setMagma(engine, x, y, VENT_TEMP);
    } else {
      engine.setMaterial(x, y, MaterialType.TEPHRA);
      tintTephra(engine, x, y, rng);
    }
    placed++;
  }
  return placed;
}

// ---------------------------------------------------------------------------
// Cooling
// ---------------------------------------------------------------------------

/** Cells that count as "cold" for the purposes of chilling a lava cell. */
/**
 * How far above ambient a solid must be before it is painted as incandescent.
 *
 * Bedrock sits at ambient and must keep its palette grey, or the whole planet
 * turns basalt-dark. Anything genuinely warmer — lava, rock freshly set from
 * it, country rock a flow has heated — glows.
 */
const GLOW_FLOOR = 0.005;

/**
 * Derive the two host-side consequences of a cell's temperature: how stiff it
 * is, and what colour it renders.
 *
 * This is all that remains of `coolLava`. The cooling itself — exposure-scaled
 * heat loss, the freeze to rock, the airborne guard that stopped ejecta setting
 * in mid-air — now belongs to the engine, which does it for every host rather
 * than only this one. What is left is genuinely the host's business:
 *
 *  - **Rheology.** `stiffnessGrid` is a host input, so something has to keep it
 *    in step with temperature as a flow chills. That is the mapping that turns
 *    a cooling curve into flow morphology — margins and fronts lock while the
 *    core keeps moving.
 *  - **Colour.** Rendering is the host's job per the engine's contract. The
 *    engine stores a temperature; turning it into incandescence is up to us.
 *
 * The ramp survives, but only as a *palette*. It is no longer a storage format,
 * so the constraint that used to make it fragile is gone: `tempAt` decoded a
 * cell's temperature by looking its exact packed colour back up, which forced
 * every ramp entry to stay distinct from every tephra tint forever. Nothing
 * reads colour back now, so the two sets are free to collide.
 *
 * **Call this once per frame, unconditionally** — not only while the volcano is
 * erupting. The engine cools and freezes cells regardless of what the host is
 * doing, and a freeze clears the cell's colour, so anything that sets while the
 * volcano is quiet would otherwise be left rendering as bedrock.
 *
 * @returns how many cells were painted as glowing.
 */
export function syncFromHeat(engine: PixelEngine): number {
  const cg = ensureColorGrid(engine);
  const grid = engine.grid;
  const w = engine.width;
  const floor = engine.ambientTemperature + GLOW_FLOOR;
  let glowing = 0;

  for (let y = 0; y < engine.height; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const idx = rowOff + x;
      const mat = grid[idx];
      if (mat !== MaterialType.LAVA && mat !== MaterialType.ROCK && mat !== MaterialType.TEPHRA) continue;

      const t = engine.getHeat(x, y);
      if (mat === MaterialType.LAVA) {
        setStiffness(engine, x, y, stiffnessForTemp(t));
      } else if (mat === MaterialType.TEPHRA) {
        // A hot unmarked cell is a fresh fragment. Once painted, the alpha
        // marker rides with it and identifies it after cooling so the final
        // granular deposit keeps its ash-brown tint.
        const marked = isTephraTint(cg[idx]);
        if (!marked && t <= floor) continue;

        const ti = Math.max(0, Math.min(TEPHRA_STEPS - 1, Math.round(t * (TEPHRA_STEPS - 1))));
        const tephra = TEPHRA_RAMP[ti];
        if (cg[idx] !== tephra) {
          cg[idx] = tephra;
          engine.markRenderDirty(x, y);
        }
        if (t <= floor) continue;
        glowing++;
        continue;
      } else if (t <= floor) {
        // Cold rock: bedrock that was never heated keeps the palette grey, and
        // rock that has finished cooling keeps the last dark tint it was given.
        continue;
      }

      const i = Math.max(0, Math.min(TEMP_STEPS - 1, Math.round(t * (TEMP_STEPS - 1))));
      const c = TEMP_RAMP[i];
      if (cg[idx] !== c) {
        cg[idx] = c;
        engine.markRenderDirty(x, y);
      }
      glowing++;
    }
  }
  return glowing;
}

// ---------------------------------------------------------------------------
// Plumbing maintenance
// ---------------------------------------------------------------------------

/**
 * Hold the magma reservoir at depth temperature.
 *
 * **Required, not decorative**, and it is new with the engine's heat field.
 * The old host-side cooling had no conduction term at all — a buried cell lost
 * only a token fraction of the exposed rate — so a chamber stayed molten
 * essentially for free. The engine does conduct, and a chamber is a hot blob
 * wrapped in cold bedrock, which is an enormous heat sink: measured, an
 * unfed chamber chills from 0.75 through the freezing point and sets solid in
 * under 200 frames, taking the conduit with it.
 *
 * That is the correct physics for a *closed* body of magma, and the wrong model
 * for a volcano. A real chamber is not closed — it is fed from the mantle, and
 * the heat arriving from below is why it stays molten between eruptions. This
 * supplies that feed. It is the same category of thing as
 * {@link pressurizeConduit}: plumbing the host owns, not thermodynamics the
 * engine should be guessing at.
 *
 * Only re-heats cells that are *already* magma, so it never melts the bedrock
 * walls that keep the chamber a chamber.
 *
 * @returns how many cells were recharged.
 */
export function rechargeReservoir(
  engine: PixelEngine,
  cfg: VolcanoConfig,
  phase?: EruptionPhase,
): number {
  let n = 0;

  /**
   * Feed one cell, if it is magma and still buried.
   *
   * The exposure test is what keeps the vent working as a vent. Magma open to
   * the sky is radiating, and it is *supposed* to crust over — that is the
   * whole repose phase. Feeding it would hold the summit permanently molten and
   * the cone would never close over between eruptions.
   */
  const feed = (x: number, y: number): void => {
    const m = engine.getMaterial(x, y);
    // Magma, or plumbing that has set solid since the last episode. Nothing
    // else: restricting it to these keeps the feed from eating the bedrock
    // walls that make the chamber a chamber.
    if (m !== MaterialType.LAVA && m !== MaterialType.ROCK && m !== MaterialType.TEPHRA) return;
    if (
      engine.getMaterial(x, y - 1) === MaterialType.EMPTY ||
      engine.getMaterial(x, y + 1) === MaterialType.EMPTY ||
      engine.getMaterial(x - 1, y) === MaterialType.EMPTY ||
      engine.getMaterial(x + 1, y) === MaterialType.EMPTY
    ) return;

    const t = reservoirTemp(x, y);
    if (m === MaterialType.LAVA) {
      // Only ever add heat. Letting this pull a cell *down* to reservoir
      // temperature would cool freshly-risen magma back toward the chamber
      // value on its way out.
      if (engine.getHeat(x, y) < t) engine.setHeat(x, y, t);
      setStiffness(engine, x, y, stiffnessForTemp(t));
    } else {
      // Re-melt. A volcano that has gone dormant stops being fed, so its
      // reservoir chills and sets — which is real enough (it is how a pluton
      // forms), and it is why the chamber goes dark between episodes. But the
      // next episode has to be able to wake it up again, and a frozen chamber
      // that could only ever be topped up if it were already molten would stay
      // rock forever.
      setMagma(engine, x, y, t);
    }
    n++;
  };

  /**
   * Feed a bore cell — keep it molten, remelting frozen ROCK. The bore must stay
   * molten so the pressure source can route through it immediately when an
   * eruption starts. Frozen ROCK cells (which form during dormancy) are remelted
   * back to magma.
   *
   * `open` selects the two regimes the throat has. While the volcano is
   * erupting the throat is *continuously resupplied from below*, so nothing
   * buried in it is allowed to set and fallback debris that has dropped into it
   * is assimilated. While it is in repose there is no supply, so the exposure
   * guard applies and the mouth is free to crust over. That crust is the repose
   * cap the next episode has to break, and it is the only thing fracture should
   * ever have to open.
   *
   * The exposure guard stays on in *both* regimes for TEPHRA. A grain sitting
   * on the open crater floor is part of the cone's granular deposit, not part
   * of the plumbing, and remelting it feeds the loop that turns a cinder cone
   * into a lava tower: fallout lands, is remelted, is pushed back up the bore,
   * and sets as immobile ROCK, which cannot slump. Measured with the guard off,
   * one cycle remelted 470 tephra cells against the 394 it fragmented — the
   * cone was being consumed faster than it was being built.
   */
  const feedBore = (x: number, y: number, open: boolean, ascentFrac: number): void => {
    const m = engine.getMaterial(x, y);
    const feedable =
      m === MaterialType.LAVA || m === MaterialType.ROCK || (open && m === MaterialType.TEPHRA);
    if (!feedable) return;
    if (
      (!open || m === MaterialType.TEPHRA) && (
        engine.getMaterial(x, y - 1) === MaterialType.EMPTY ||
        engine.getMaterial(x, y + 1) === MaterialType.EMPTY ||
        engine.getMaterial(x - 1, y) === MaterialType.EMPTY ||
        engine.getMaterial(x + 1, y) === MaterialType.EMPTY
      )
    ) return;
    // Temperature ramps along the bore, from chamber heat at the bottom to vent
    // heat at the mouth, rather than holding the whole column at the reservoir
    // value.
    //
    // This is what makes {@link VENT_TEMP} reach the surface at all. A pressure
    // route does not carry the injected parcel to the outlet — `_shiftPath`
    // shifts the whole column by one and the parcel that *emerges* is the one
    // that was already at the top. So the source's `temperature` only ever sets
    // the deepest cell, and everything that erupts leaves the vent at whatever
    // the conduit was being held at. Held flat at chamber heat, that is 0.75,
    // which is already two stiffness tiers into the depth-gated regime — the
    // lava arrived at the crater half-set and could not run anywhere.
    //
    // The gradient is also the right physics: the freshest, least-degassed
    // magma is at the top of an active column, and it is what the incandescence
    // ramp's bright end is for.
    const t = reservoirTemp(x, y) + (VENT_TEMP - MAGMA_TEMP) * Math.max(0, Math.min(1, ascentFrac));
    if (m === MaterialType.LAVA) {
      if (engine.getHeat(x, y) < t) engine.setHeat(x, y, t);
      setStiffness(engine, x, y, stiffnessForTemp(t));
    } else {
      // Remelt frozen ROCK (or buried fallback tephra) back to magma so the
      // conduit stays open. Without this the bore freezes solid and the next
      // eruption cannot route magma to the surface.
      setMagma(engine, x, y, t);
    }
    n++;
  };

  const chamberR = cfg.planetRadius - cfg.chamberDepth;

  // The bore.
  //
  // Feed depth is phase-aware, and while erupting it **tracks the edifice**
  // rather than stopping at the original planet radius. That is the difference
  // between a volcano and a chimney.
  //
  // A conduit maintained only up to `planetRadius` is buried by the volcano's
  // own first deposits: within a few tens of frames the mouth is under fallback
  // tephra and frozen spatter that nothing re-melts, and the source's only way
  // out is to *fracture* its way through. Fracture opens one cell per frame
  // along the steepest potential gradient, which is straight up — so the magma
  // tunnels vertically through its own pile, every subsequent parcel lands on
  // top of that tunnel, and the edifice grows as a straight-sided tower. When
  // fracture is free to pick a weaker neighbour instead (unfractured tephra on
  // the flanks is strength 6 against rock's 15) it breaks out sideways as well,
  // which is where the extra vents came from. Both are the same bug: the vent
  // was never maintained, so the pressure source had to excavate one.
  //
  // Extending the maintained bore to the rim keeps a single central vent open
  // at the summit for as long as the eruption lasts. It is bounded by the
  // authored bore footprint — three to five cells across — so it can only ever
  // keep the conduit clear, never eat into the cone around it. Fracture goes
  // back to being what it was meant for: breaking the repose cap.
  //
  // During repose (or when no phase is given) the feed stops 3 cells short of
  // the original surface, as before, so a genuine cap can form and hold.
  const erupting = phase === 'explosive' || phase === 'effusive';
  const feedLimit = erupting ? ventTopRadius(engine, cfg) : cfg.planetRadius - 3;
  const span = Math.max(1, feedLimit - chamberR);
  for (let r = chamberR; r <= feedLimit; r++) {
    const hw = boreHalfWidth(cfg, r);
    // Ramp the last third of the ascent, so only the shallow column carries
    // vent heat and the bulk of the conduit stays at reservoir temperature.
    const frac = Math.max(0, ((r - chamberR) / span - 0.66) / 0.34);
    for (let w = -hw; w <= hw; w++) {
      const p = borePos(cfg, r, w);
      feedBore(p.x, p.y, erupting, frac);
    }
  }

  // The chamber blob, same geometry `stampVolcano` lays down. The chamber can
  // remelt (ROCK→LAVA) because a dormant volcano's reservoir sets solid between
  // eruptions and the next episode has to be able to wake it.
  const ux = Math.cos(cfg.ventAngle);
  const uy = Math.sin(cfg.ventAngle);
  const cxc = cfg.centerX + ux * chamberR;
  const cyc = cfg.centerY + uy * chamberR;
  const maxR = cfg.chamberRadius * 1.35;
  for (let dy = -maxR; dy <= maxR; dy++) {
    for (let dx = -maxR; dx <= maxR; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > cfg.chamberRadius * chamberWall(Math.atan2(dy, dx))) continue;
      feed(Math.round(cxc + dx), Math.round(cyc + dy));
    }
  }
  return n;
}

/**
 * Remelt anything that has fallen back into the plumbing.
 *
 * **Required, not cosmetic.** Tephra is lighter than lava and normally remains
 * on its surface, but a ballistic grain can still enter an open conduit or be
 * buried by a later pressure pulse. Magma remelts debris that reaches the
 * plumbing, so restoring this bounded region keeps the source functional.
 *
 * @returns how many cells were remelted this call.
 */
export function remeltConduit(engine: PixelEngine, cfg: VolcanoConfig): number {
  const chamberR = cfg.planetRadius - cfg.chamberDepth;
  let melted = 0;

  const melt = (x: number, y: number): void => {
    const m = engine.getMaterial(x, y);
    // Only reclaim fallen debris — never eat the surrounding bedrock outside
    // the bore, which is what keeps the conduit walls intact.
    if (m !== MaterialType.TEPHRA && m !== MaterialType.ROCK) return;
    setMagma(engine, x, y, reservoirTemp(x, y));
    melted++;
  };

  for (let r = chamberR; r <= cfg.planetRadius; r++) {
    const hw = boreHalfWidth(cfg, r);
    for (let w = -hw; w <= hw; w++) {
      const p = borePos(cfg, r, w);
      melt(p.x, p.y);
    }
  }
  // Chamber reclaim region — the stamped chamber wall grown by the halo. Fixed
  // (not a propagating melt), so it clears only this ring and never eats the
  // bedrock beyond.
  const ux = Math.cos(cfg.ventAngle);
  const uy = Math.sin(cfg.ventAngle);
  const cxc = cfg.centerX + ux * chamberR;
  const cyc = cfg.centerY + uy * chamberR;
  const halo = cfg.chamberReclaimHalo ?? 1;
  const maxR = cfg.chamberRadius * 1.35 + halo;
  for (let dy = -maxR; dy <= maxR; dy++) {
    for (let dx = -maxR; dx <= maxR; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > cfg.chamberRadius * chamberWall(Math.atan2(dy, dx)) + halo) continue;
      melt(Math.round(cxc + dx), Math.round(cyc + dy));
    }
  }
  return melted;
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
   * trapped inside a lava body has lava on three or four sides; a cell of the
   * cone's flank merely touching a thin surface flow has lava on one or two.
   * A naive "lava touches tephra" rule chain-reacts, each melted cell becoming a
   * new lava source for the layer beneath, and consumes the whole cone.
   */
  embedThreshold?: number;
}

/**
 * Magma dissolves the tephra trapped inside it.
 *
 * Tephra normally floats on lava, but ballistic impacts and later pressure
 * pulses can still trap grains inside a molten body. Only deeply embedded
 * grains are reclaimed; surface deposits remain available to build the cone.
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
      if (grid[rowOff + x] !== MaterialType.TEPHRA) continue;

      // Count lava among the four orthogonal neighbours. Embedding, not contact.
      let lavaN = 0;
      if (y > 0 && grid[rowOff - w + x] === MaterialType.LAVA) lavaN++;
      if (y < engine.height - 1 && grid[rowOff + w + x] === MaterialType.LAVA) lavaN++;
      if (x > 0 && grid[rowOff + x - 1] === MaterialType.LAVA) lavaN++;
      if (x < w - 1 && grid[rowOff + x + 1] === MaterialType.LAVA) lavaN++;
      if (lavaN < threshold) continue;

      if (rng() >= opts.rate) continue;
      // setMagma clears the dark basalt tint by writing a ramp colour over it —
      // without that the renderer keeps showing grey over the new material.
      setMagma(engine, x, y, MAGMA_TEMP);
      melted++;
    }
  }
  return melted;
}

// ---------------------------------------------------------------------------
// Eruption cycle
// ---------------------------------------------------------------------------

/**
 * Which kind of episode the volcano is in.
 *
 * Real stratovolcanoes alternate: explosive bursts blanket the cone in tephra,
 * effusive episodes drape it in lava that sets to rock, and the interleaved
 * lobes and tongues are what build the classic steep cone. Running both at once
 * — which is what mixing lava and tephra in a single continuous plume amounts to
 * — averages the two into a uniform grey mound with orange freckles and never
 * produces a recognisable flow.
 */
export type EruptionPhase = 'effusive' | 'explosive' | 'repose';

/** Live state of an eruption in progress. */
export interface VolcanoState {
  phase: EruptionPhase;
  /** Frames elapsed in the current phase. */
  phaseFrame: number;
  /** Frames elapsed since the eruption began. */
  frame: number;
  /** Completed explosive→effusive cycles. */
  cycle: number;
  /**
   * Angular offset of this episode's rim breach from the vent axis, in radians.
   * Re-chosen when an effusive episode begins, so successive flows come out on
   * different sides and drape the cone unevenly the way real ones do.
   */
  breach: number;
  /**
   * Engine pressure source id for the active effusive episode, or `null` when
   * no source is live. Created when effusion begins, removed when it ends — the
   * engine routes magma from the chamber feed through the connected conduit to
   * a real outlet, replacing the host-side `pressurizeConduit` advection.
   */
  sourceId: number | null;
}

/** Frames each phase lasts. */
export interface PhaseDurations {
  effusive: number;
  explosive: number;
  repose: number;
}

/**
 * Frames per phase, weighted heavily toward the explosive episode.
 *
 * The balance is not cosmetic — it decides the silhouette. Granular tephra piles
 * at its own angle of repose and is the only thing here that produces a
 * *tapering* profile, so the explosive phase is what builds the cone. Ponded
 * lava levels out and then freezes with cliff edges, so an edifice built mainly
 * by effusion is a flat-topped mesa, not a volcano. Weighted the other way
 * (effusive 420 / explosive 150) that is exactly what it built.
 *
 * Effusion's job is the flows down the flanks and the glow in the crater, and a
 * short pulse does that better than a long one anyway: a surge delivers enough
 * volume to stay connected and thick while it runs, where a slow trickle chills
 * between cells and stipples the flank instead of streaming down it.
 */
export const DEFAULT_PHASES: PhaseDurations = { explosive: 300, effusive: 90, repose: 150 };

export function createVolcanoState(): VolcanoState {
  // Open explosively: a real eruption clears its throat with ash and tephra
  // before lava reaches the surface, and it gives the first flows a cone to
  // run down instead of a bare planet.
  return { phase: 'explosive', phaseFrame: 0, frame: 0, cycle: 0, breach: 0, sourceId: null };
}

/** Tuning for {@link stepVolcano}. */
export interface VolcanoStepOptions {
  /** Plume options. No longer used in the eruption path (the plume was replaced by engine pressure + fragmentation) but retained for tests that call emitPlume directly. */
  plume?: PlumeOptions;
  pressure: PressureOptions;
  /** Per-frame chance of melting an embedded tephra cell. */
  assimilateRate: number;
  phases?: PhaseDurations;
}

/**
 * Inputs to {@link buildVolcanoOpts} that vary at runtime (sliders) or per
 * cycle. Everything else about the eruption is a fixed property of the volcano
 * model and lives inside the factory, so the showcase and the headless test
 * harness construct identical options from the same code path.
 */
export interface VolcanoOptsInputs {
  /** Cells of magma supplied per frame (Effusion slider, 1–5). */
  effusion: number;
  /** Fountain Rate slider (0–4). Controls parcel density up to the cap. */
  fountainRate: number;
  /** Fountain Pressure slider (20–150). Becomes the explosive source's head. */
  fountainPressure: number;
  /**
   * Current edifice height cap, in cells. The showcase starts at `capStart` and
   * raises it by `capStep` each cycle up to `capMax`; a fixed scenario passes
   * `capStart` for the first-cycle behaviour it pins.
   */
  maxHeight: number;
}

/**
 * Construct the showcase's eruption tuning from a small set of inputs.
 *
 * This is the single source of truth shared by the browser showcase
 * (`sections/planet.ts`) and the headless test harness
 * (`helpers/volcano-scenario.ts`). The harness passes the production slider
 * defaults so the golden trajectory tests the volcano users actually run;
 * the showcase passes its live slider values. Keeping both callers on one
 * factory is what prevents the scenario and the shipped behaviour from
 * silently diverging (they did before — different fountain pressure, parcel
 * cap, and an explosive-only vent anchor instead of the shared parent one).
 *
 * The vent anchor is set at the parent (`opts.pressure.ventAnchor`) so it
 * applies to both phases; `stepVolcanoPre` falls back to it for the explosive
 * source when no nested override is present.
 */
export function buildVolcanoOpts(
  cfg: VolcanoConfig,
  inputs: VolcanoOptsInputs,
): VolcanoStepOptions {
  // Head a parcel spends just getting from the chamber feed to the vent, in
  // head units. Routing cost is the gravitational climb (one unit per cell of
  // radius, on radial gravity) plus the conduit's own flow resistance
  // (`LAVA.pressureResistance` per traversed cell), so it grows one-for-one
  // with the edifice the magma has to climb through.
  //
  // Both sources have to be dimensioned against this rather than against a
  // constant. A fixed 60 was enough to reach the original surface and *not
  // enough to reach the top of the cone the volcano builds* — past about 25
  // cells of growth the effusive phase silently stopped producing anything at
  // all, and the fountain faded as the cone grew because the same slider
  // position bought less and less surplus at the vent.
  const ascent = Math.ceil((cfg.chamberDepth + inputs.maxHeight + cfg.chamberRadius) * 1.2);
  return {
    pressure: {
      // Effusive ascent: the engine routes this from the chamber feed through
      // the connected conduit to a real outlet.
      effusion: inputs.effusion,
      // Enough head to reach the summit of a fully-grown cone, times the number
      // of parcels the Effusion slider asks for per frame.
      //
      // The multiplier is what makes that slider mean anything. Every accepted
      // route deducts its own cost from the source's head, so a budget sized for
      // one ascent affords exactly one parcel per frame however high the rate is
      // set — measured, Effusion 5 discharged at the same one cell per frame as
      // Effusion 1, and the surface lava sat at a steady ~115 cells because the
      // flows were freezing exactly as fast as they were being fed. A flow needs
      // to arrive faster than it chills to travel at all: lava is a Bingham
      // fluid here (`stiffnessForTemp`), so a tongue advances only where it is
      // at least two cells thick, and a one-cell-per-frame trickle never is.
      //
      // Refilled in full every frame, because a magma chamber's overpressure is
      // not something the vent exhausts — what limits an eruption's discharge is
      // how fast the conduit can pass magma, which is `maxDischargePerFrame`.
      pressureRate: ascent * Math.max(1, inputs.effusion) + 12,
      maxPressure: ascent * Math.max(1, inputs.effusion) + 12,
      maxPending: 5,
      // Discharge is the slider, not a side effect of the head budget.
      maxDischargePerFrame: Math.max(1, Math.round(inputs.effusion)),
      // Effusion extrudes; it does not fountain. Surplus head at the vent is
      // left as head instead of being converted to launch velocity, so lava
      // wells out of the crater and runs downslope under gravity — which is
      // the whole point of the phase, and what the yield-strength term exists
      // to shape. Without this the effusive source's surplus (which has to be
      // generous, or it cannot climb the cone at all) launches every parcel
      // ballistically and the flows never form.
      outletVelocityEfficiency: 0,
      // Just above the cone's cap: more headroom and lava stops running down
      // the cone and starts building a level slab on top of it.
      maxHeight: inputs.maxHeight + 2,
      // Shared vent anchor: both explosive and effusive routing exit only
      // through a narrow corridor (radius 3 ≈ conduit half-width + 1) around
      // the vent, so laterally spreading summit lava cannot become extra vents.
      // Shared vent axis: both explosive and effusive routing exit only through
      // cells within corridorRadius of the vent axis (the line from center
      // through the vent angle). The axis extends to any height, so the corridor
      // tracks cone growth — unlike a fixed surface point that gets buried.
      ventAnchor: { cx: cfg.centerX, cy: cfg.centerY, angle: cfg.ventAngle, corridorRadius: 3 },
      // Shared fracture config for the effusive source: faster reopening than
      // the explosive source since effusion is only 40 frames — a 24-frame delay
      // would consume the entire phase. A short delay (6 frames) + moderate
      // accrual (3 head/frame, cap 18) clears a frozen plug within the effusive
      // window while still using corridor-constrained directional selection.
      fracture: { minSealedFrames: 6, pressureRate: 3, maxPressure: 18 },
      // Explosive-phase fountain: high pressure so surplus at the vent converts
      // to ballistic velocity (Torricelli). Fragmented fountain parcels build
      // the tephra cone and leave a few visible hot bombs in the arc.
      explosive: {
        rate: inputs.fountainRate,
        // Floored at the ascent plus a working surplus, so the Fountain Pressure
        // slider keeps meaning the same thing at every cone height instead of
        // being eaten by the climb as the volcano grows.
        pressureRate: Math.max(10, inputs.fountainPressure, ascent + 20),
        maxPressure: Math.max(inputs.fountainPressure, ascent + 20),
        // The parcel cap tracks the Fountain Rate slider's ceiling (4). One
        // parcel per frame keeps a focused tephra jet; multiple same-frame
        // routes widen it into a spray. The cap bounds that widening so a
        // maxed fountain is dense but not a broad fan.
        maxPending: 4,
        // The launch arc. Roughly ±35°, matching the Spread the host-side plume
        // used to fire across, so ballistic fallout lands out on the flanks and
        // piles into a cone instead of dropping back into the crater.
        outletLateralSpread: 0.7,
        // Discharge cap: when a plug clears, the fountain returns to its steady
        // rate rather than dumping the whole backlog in one frame.
        maxDischargePerFrame: Math.max(1, Math.ceil(inputs.fountainRate)),
        // Fracture via a separate budget: the sealed vent reopens through the
        // plug (highest-potential cell), never mining cone-flank tephra sideways.
        fracture: { minSealedFrames: 24, pressureRate: 1, maxPressure: 18 },
      },
    },
    // Tephra is lighter than lava and stays above surface flows. A slow cleanup
    // rate still remelts the occasional grain trapped deep in the plumbing
    // without erasing the cone-building exterior deposit.
    assimilateRate: 0.03,
  };
}

/**
 * The production slider defaults — the volcano a user sees on first load.
 *
 * `maxHeight` defaults to `capStart` (20), the first-cycle cap; the showcase
 * raises it per cycle, a fixed scenario leaves it at the first-cycle value.
 */
export const DEFAULT_VOLCANO_INPUTS: VolcanoOptsInputs = {
  effusion: 1,
  fountainRate: 1,
  fountainPressure: 100,
  maxHeight: 20,
};

/**
 * The chamber feed cell — where the engine pressure source injects magma.
 * Deepest bore position, at the chamber radius.
 */
function chamberFeed(cfg: VolcanoConfig): { x: number; y: number } {
  const chamberR = cfg.planetRadius - cfg.chamberDepth;
  return borePos(cfg, chamberR, 0);
}

/**
 * Advance the eruption one frame. Call *around* `engine.update()`:
 * {@link stepVolcanoPre} before it, {@link stepVolcanoPost} after it.
 *
 * The effusive phase is now engine-driven: a persistent pressure source at the
 * chamber feed routes magma through the connected conduit to a real outlet, so
 * the host no longer advects the bore or spawns lava at a guessed destination.
 * The source is created when effusion begins and removed when it ends, so the
 * engine does nothing during explosive and repose phases.
 */
export function stepVolcanoPre(
  engine: PixelEngine,
  cfg: VolcanoConfig,
  state: VolcanoState,
  rng: () => number,
  opts: VolcanoStepOptions,
): void {
  void rng; // no longer used after plume removal; retained for API symmetry
  const phases = opts.phases ?? DEFAULT_PHASES;

  if (state.phase === 'explosive') {
    // The explosive phase is now entirely engine-driven: a high-pressure source
    // at the chamber feed routes magma to the vent, where surplus head converts
    // to ballistic velocity (Torricelli). Lava arcs outward, cools in flight,
    // and fragments into TEPHRA — building the cone from physics-driven
    // ejecta. No host-side plume, no host-named destinations.
    if (opts.pressure.explosive && state.sourceId === null) {
      const feed = chamberFeed(cfg);
      state.sourceId = engine.addPressureSource({
        x: feed.x, y: feed.y,
        material: MaterialType.LAVA,
        rate: opts.pressure.explosive.rate,
        pressureRate: opts.pressure.explosive.pressureRate,
        maxPressure: opts.pressure.explosive.maxPressure,
        maxPending: opts.pressure.explosive.maxPending,
        temperature: MAGMA_TEMP,
        outletVelocityEfficiency: opts.pressure.explosive.outletVelocityEfficiency,
        outletLateralSpread: opts.pressure.explosive.outletLateralSpread,
        maxDischargePerFrame: opts.pressure.explosive.maxDischargePerFrame,
        fracture: opts.pressure.explosive.fracture,
        // The explosive source uses its own nested vent anchor when set, else
        // falls back to the shared `opts.pressure.ventAnchor` documented as
        // applying to both phases. Without this fallback the production
        // explosive phase — which only sets the parent anchor — runs unanchored.
        ventAnchor: opts.pressure.explosive.ventAnchor ?? opts.pressure.ventAnchor,
      });
    }
    // Height cap applies to the explosive source too.
    if (edificeHeight(engine, cfg) >= opts.pressure.maxHeight && state.sourceId !== null) {
      engine.removePressureSource(state.sourceId);
      state.sourceId = null;
    }
  } else if (state.phase === 'effusive') {
    // Create the source on the first frame of effusion. The engine routes from
    // here through the connected conduit to a real outlet — no host advection,
    // no host-named destination. `temperature` keeps the injected magma at
    // reservoir heat so the heat field carries it visibly up the bore.
    if (state.sourceId === null) {
      const feed = chamberFeed(cfg);
      state.sourceId = engine.addPressureSource({
        x: feed.x, y: feed.y,
        material: MaterialType.LAVA,
        rate: opts.pressure.effusion,
        pressureRate: opts.pressure.pressureRate,
        maxPressure: opts.pressure.maxPressure,
        maxPending: opts.pressure.maxPending,
        // Vent temperature, not chamber temperature. A parcel written at the
        // chamber feed is the coldest thing in the conduit by the time it
        // reaches the summit, and a flow that leaves the vent already partway
        // to its yield threshold stalls within a cell or two of the crater
        // instead of running down the flank.
        temperature: VENT_TEMP,
        outletVelocityEfficiency: opts.pressure.outletVelocityEfficiency,
        maxDischargePerFrame: opts.pressure.maxDischargePerFrame,
        ventAnchor: opts.pressure.ventAnchor,
        fracture: opts.pressure.fracture,
      });
    }
    // The height cap is a host concern: the engine has no concept of an
    // edifice. Stop the source once the cone reaches the cap, and remove it so
    // the engine stops routing.
    if (edificeHeight(engine, cfg) >= opts.pressure.maxHeight && state.sourceId !== null) {
      engine.removePressureSource(state.sourceId);
      state.sourceId = null;
    }
  }
  // 'repose' emits nothing — the flows crust over and the glow fades, which is
  // what makes the next burst read as a new episode rather than more of the same.

  state.frame++;
  state.phaseFrame++;
  const limit = phases[state.phase];
  if (state.phaseFrame >= limit) {
    state.phaseFrame = 0;
    if (state.phase === 'explosive') {
      // Remove the explosive-phase source before transitioning. The effusive
      // phase creates its own moderate-pressure source on its first frame.
      if (state.sourceId !== null) {
        engine.removePressureSource(state.sourceId);
        state.sourceId = null;
      }
      state.phase = 'effusive';
    } else if (state.phase === 'effusive') {
      // End of effusion: remove the source. The engine stops routing; remaining
      // magma in the conduit cools and sets under the heat field.
      if (state.sourceId !== null) {
        engine.removePressureSource(state.sourceId);
        state.sourceId = null;
      }
      state.phase = 'repose';
    } else {
      // End of repose: the single eruption cycle is complete. Stop rather than
      // looping back to explosive. The host can restart with another click.
      state.cycle++;
      state.phaseFrame = -1; // signal: eruption complete
    }
  }
}

/**
 * The post-`update()` half of a frame: plumbing maintenance and assimilation.
 *
 * Deliberately does **not** call {@link syncFromHeat}. Cooling is the engine's
 * now and runs every frame whether or not the volcano is erupting, so the
 * appearance sync has to run every frame too — see its own docs. Bundling it
 * here would tie it to the eruption, and lava that set during a dormant spell
 * would never be repainted: freezing clears the cell's colour, so it would fall
 * back to bedrock grey instead of cooling basalt.
 *
 * Bore remelting (`remeltConduit`) is gone from the eruption path. The engine's
 * fracture handles a blocked vent, and the pressure source keeps the conduit
 * molten while effusion is active. During repose the bore is allowed to crust
 * — that is the point of repose.
 */
export function stepVolcanoPost(
  engine: PixelEngine,
  cfg: VolcanoConfig,
  state: VolcanoState,
  rng: () => number,
  opts: VolcanoStepOptions,
): void {
  // Every phase, repose included: the chamber is molten between eruptions too,
  // and left unfed it would set solid and end the volcano permanently. The bore
  // feed depth is phase-aware: during an active eruption the feed reaches one
  // cell below the surface so the throat below the vent stays molten; during
  // repose it stops short so a cap can form.
  rechargeReservoir(engine, cfg, state.phase);
  assimilateTephra(engine, rng, { rate: opts.assimilateRate });
}

/**
 * Mutable per-eruption runtime state shared between the host and the controller.
 *
 * `erupting` is the active/dormant flag the browser loop branches on; the
 * controller flips it to `false` when the eruption completes. `capHeight` is
 * the current edifice-height cap (it grows cycle by cycle in the showcase).
 * Both are mutated by {@link stepVolcanoFrame}, so a caller that wants the
 * browser's exact per-frame behaviour just holds one of these and calls the
 * controller once per frame.
 */
export interface VolcanoRuntime {
  /** False once the eruption has run its course (phaseFrame === -1 or dormant). */
  erupting: boolean;
  /** Current edifice-height cap, in cells. Grows cycle by cycle up to `capMax`. */
  capHeight: number;
}

/**
 * The pure simulation core of one showcase frame — the volcano equivalent of
 * `engine.update()`.
 *
 * This is the **single source of truth** for the per-frame sequence, shared by
 * the browser loop (`sections/planet.ts`) and the headless test harness
 * (`helpers/volcano-scenario.ts`). It reproduces the browser's active/dormant
 * transition exactly:
 *
 * - **Active:** `stepVolcanoPre → engine.update() → stepVolcanoPost`, then a
 *   completion check. The eruption completes when its cycle finishes
 *   (`state.phaseFrame < 0`), at which point the live pressure source is removed
 *   and `runtime.erupting` goes false. Reaching the height cap does *not* end
 *   the eruption — it only stops the source, inside `stepVolcanoPre`.
 * - **Dormant:** `rechargeReservoir(..., 'repose')` then `engine.update()`. The
 *   chamber and buried conduit are maintained at repose depth so a restart can
 *   route magma; only the shallow cap (top ~3 cells) is allowed to freeze.
 * - **Every frame, active or dormant:** {@link syncFromHeat}, because the engine
 *   keeps cooling and freezing cells during dormancy and a freeze clears a
 *   cell's colour, so flows that set while the volcano is quiet still need
 *   repainting.
 *
 * Cloud stepping, perf bookkeeping, spin, and rendering are presentation-only
 * and stay in the browser loop. Extracting this controller is what keeps the
 * golden test trajectory byte-identical to what a user sees: previously the
 * harness ran the active sequence forever, so every post-completion checkpoint
 * differed from the production loop by hundreds of cells.
 */
export function stepVolcanoFrame(
  engine: PixelEngine,
  cfg: VolcanoConfig,
  state: VolcanoState,
  rng: () => number,
  opts: VolcanoStepOptions,
  runtime: VolcanoRuntime,
): void {
  if (runtime.erupting) {
    stepVolcanoPre(engine, cfg, state, rng, opts);
    engine.update();
    stepVolcanoPost(engine, cfg, state, rng, opts);
    // The eruption cycle runs once: explosive → effusive → repose → done.
    // `phaseFrame === -1` signals completion (set by stepVolcanoPre).
    //
    // Reaching the height cap is *not* completion. It only means the edifice has
    // grown as far as this episode is allowed to grow it, which `stepVolcanoPre`
    // already handles by removing the live source. Ending the whole eruption
    // there cost every episode after the first its effusive phase: the cap trips
    // partway through the explosive phase, so the volcano went straight from
    // erupting ash to dormant and the lava flows — the thing the effusive phase
    // exists to show — were only ever visible on a fresh planet. Let the cycle
    // finish; a capped eruption simply has nothing left to add.
    if (state.phaseFrame < 0) {
      if (state.sourceId !== null) {
        engine.removePressureSource(state.sourceId);
        state.sourceId = null;
      }
      runtime.erupting = false;
    }
  } else {
    // Dormant: maintain the plumbing so a restart can route magma — but only
    // if a volcano has actually been stamped. Before the first click there is
    // no conduit, and running the bore geometry on bare bedrock would carve a
    // magma channel into a planet that has no volcano.
    const feed = chamberFeed(cfg);
    if (engine.getMaterial(feed.x, feed.y) === MaterialType.LAVA
      || engine.getMaterial(feed.x, feed.y) === MaterialType.ROCK) {
      // Heuristic: the chamber feed is ROCK (bedrock) even before stamping, so
      // distinguish "stamped then frozen" from "never stamped" by checking
      // whether any LAVA exists near the chamber center. A stamped volcano
      // always leaves at least some lava in the chamber blob.
      const chamberR = cfg.planetRadius - cfg.chamberDepth;
      let hasLava = false;
      for (let dy = -3; dy <= 3 && !hasLava; dy++) {
        for (let dx = -3; dx <= 3 && !hasLava; dx++) {
          const ux = Math.cos(cfg.ventAngle), uy = Math.sin(cfg.ventAngle);
          const x = Math.round(cfg.centerX + ux * chamberR + dx);
          const y = Math.round(cfg.centerY + uy * chamberR + dy);
          if (engine.getMaterial(x, y) === MaterialType.LAVA) hasLava = true;
        }
      }
      if (hasLava) {
        rechargeReservoir(engine, cfg, 'repose');
      }
    }
    engine.update();
  }
  // Every frame, erupting or not: repaint temperature-derived colour/stiffness.
  syncFromHeat(engine);
}

/**
 * A burst eruption: blow the vent open and throw its contents outward.
 *
 * Uses the engine's existing `explode`, which scatters loose material away from
 * the center and lights a fire/smoke core. Note it also pulverises rock within
 * the blast, so repeated bursts excavate a summit crater.
 */
export function erupt(engine: PixelEngine, cfg: VolcanoConfig, radius = 6, force = 4): void {
  const v = ventPosition(cfg);
  engine.explode(v.x, v.y, radius, force);
}
