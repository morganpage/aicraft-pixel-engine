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
  // The floor is 2, never 1. At 1 the criterion can never be met — a single cell
  // is already one cell thick — so lava would be free to move at any depth and
  // would thin without limit as it spread. It does exactly that: the flow
  // fans out into a half-occupied monolayer, and when that finally chills it
  // locks cell-by-cell into a checkerboard of specks across the whole flank.
  // A floor of 2 is what stops a sheet thinning past two cells.
  if (t >= 0.72) return 2; // mobile
  if (t >= 0.52) return 3;
  if (t >= 0.38) return 5;
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

/** Tuning for {@link pressurizeConduit}. */
export interface PressureOptions {
  /**
   * Frames per one-cell rise of the magma column. 1 is a cell per frame; higher
   * is a slower, more viscous ascent.
   */
  riseInterval: number;
  /** Cells of magma spilled into the crater per rise step. */
  effusion: number;
  /**
   * Half-angle of the crater mouth, in radians. Magma is spilled at a random
   * angle within this of the vent axis rather than always on the axis itself.
   *
   * Emitting on the axis alone stacks a one-cell-wide spire: each new cell lands
   * on the previous one, and the column grows faster than it can topple. Filling
   * across the crater's width instead lets the pool find its own level, thicken
   * past lava's yield thickness, and overflow the rim as a flow.
   */
  craterHalfAngle: number;
  /**
   * Stop spilling once the summit reaches this height above the original
   * surface, in cells.
   *
   * Effusion needs the same cap the plume has. Nothing in the simulation removes
   * material, so an uncapped vent keeps feeding a cone that keeps lifting the
   * summit the vent tracks, and the edifice grows until it runs off the grid.
   */
  maxHeight: number;
  /**
   * Fraction of the effusion delivered to the breach rather than the crater
   * pond, 0..1. Default 0.75.
   *
   * A vent that only fills its crater has two states and neither is what a
   * volcano looks like. Feed it gently and the pond sits there and chills, never
   * overtopping the rim: measured, 0–14 cells of lava ever reached the flanks.
   * Feed it hard enough to overtop and it does not run *down* — it floods the
   * whole summit and levels, freezing as a wide lens with straight diagonal
   * edges standing proud of the cone.
   *
   * Real flows mostly leave through a notch in the rim or a flank fissure rather
   * than by brimming over a full crater, and that is also the only version that
   * looks right: lava delivered onto the outer flank is on ground that already
   * falls away, so it runs as a tongue immediately.
   */
  breachFraction?: number;
}

/**
 * Drive magma up the conduit and spill it into the crater — the host standing in
 * for the pressure term the engine does not have.
 *
 * The column is *advected*, not teleported: on each rise step every bore cell
 * takes the material and heat of the cell below it, the top of the column is
 * pushed out into the crater, and the base is recharged from the chamber. So
 * the conduit is a moving column rather than a painted stripe — hot magma
 * visibly climbs it, since heat rides in `colorGrid` and moves with the cells.
 *
 * @returns how many cells of magma were spilled into the crater.
 */
export function pressurizeConduit(
  engine: PixelEngine,
  cfg: VolcanoConfig,
  frame: number,
  rng: () => number,
  opts: PressureOptions,
  /** Angular offset of the active rim breach from the vent axis, in radians. */
  breachOffset = 0,
): number {
  if (opts.riseInterval > 1 && frame % opts.riseInterval !== 0) return 0;
  if (edificeHeight(engine, cfg) >= opts.maxHeight) return 0;

  const chamberR = cfg.planetRadius - cfg.chamberDepth;
  const topR = cfg.planetRadius;

  // Advect each lane of the bore upward by one cell. Walking from the top down
  // means every cell is read before it is overwritten.
  for (let r = topR; r > chamberR; r--) {
    const hw = boreHalfWidth(cfg, r);
    for (let w = -hw; w <= hw; w++) {
      const p = borePos(cfg, r, w);
      const b = borePos(cfg, r - 1, w);
      // A lane that has no source below it (the bore swells here) starts from
      // reservoir heat rather than inheriting nothing. Asking the material
      // directly replaces what used to be a sentinel from the colour decode:
      // `tempAt` returned -1 for any cell carrying no ramp colour, which was
      // only ever a proxy for "not magma".
      const belowIsMagma = engine.getMaterial(b.x, b.y) === MaterialType.LAVA;
      setMagma(
        engine,
        p.x,
        p.y,
        belowIsMagma ? engine.getHeat(b.x, b.y) : reservoirTemp(p.x, p.y),
      );
    }
  }
  // Recharge the base of the bore from the chamber.
  const baseHw = boreHalfWidth(cfg, chamberR);
  for (let w = -baseHw; w <= baseHw; w++) {
    const p = borePos(cfg, chamberR, w);
    setMagma(engine, p.x, p.y, reservoirTemp(p.x, p.y));
  }

  // Spill the head of the column onto the lowest ground in the crater.
  //
  // Finding the low point is what makes the difference between a volcano and a
  // stalagmite. Spilling on the vent axis instead puts every new cell on top of
  // the last one, and a lone cell on a peak can never flow: its column is one
  // cell deep, which is under lava's yield thickness, so it freezes exactly
  // where it lands and the next cell lands on *that*. The result is a
  // one-cell-wide spire climbing out of the summit.
  //
  // Filling the low point instead makes the crater pond. A pond is many cells
  // deep, so it is over the yield thickness and behaves as a fluid body: it
  // finds its own level, rises to the rim, and then spills over the lowest
  // notch and runs down the flank as a tongue. Which is what a lava flow is.
  const breachFraction = breachOffset === 0 ? 0 : (opts.breachFraction ?? 0.75);
  const summitH = edificeHeight(engine, cfg);
  let placed = 0;
  for (let i = 0; i < opts.effusion; i++) {
    let angle: number;
    let radius: number;
    const toe = rng() < breachFraction ? breachToe(engine, cfg, breachOffset, summitH) : null;
    if (toe) {
      // Out through the notch and onto the toe of the flow.
      angle = toe.angle + (rng() * 2 - 1) * opts.craterHalfAngle * 0.5;
      radius = surfaceRadiusAt(engine, cfg, angle);
    } else {
      // The rest keeps the crater itself molten and glowing.
      const spot = craterLowPoint(engine, cfg, opts.craterHalfAngle, rng);
      angle = spot.angle;
      radius = spot.radius;
    }
    const x = Math.round(cfg.centerX + Math.cos(angle) * (radius + 1));
    const y = Math.round(cfg.centerY + Math.sin(angle) * (radius + 1));
    if (engine.getMaterial(x, y) !== MaterialType.EMPTY) continue;
    setMagma(engine, x, y, VENT_TEMP);
    placed++;
  }
  return placed;
}

/**
 * Cells below the summit that ground must be before the breach will feed it.
 *
 * Small, but not zero: it is what makes the flow advance instead of thicken.
 */
const BREACH_MIN_DROP = 5;

/**
 * Where along the breach side to deliver lava — the first ground far enough
 * below the summit to count as downhill. Returns `null` when the whole flank is
 * already built up to near the summit.
 *
 * Feeding a *fixed* point on the flank instead is what built a mesa on one side
 * of the cone. Effusion is only capped globally, on the highest point anywhere,
 * so a breach sitting where the cone is lower kept accepting lava until its own
 * pile reached summit height — and because a lava pond levels and then stops at
 * a blunt yield-strength front, the result was a flat terrace 14° wide and as
 * tall as the summit, ending in a cliff. Measured, that one terrace took the
 * flank from a 42° taper to a 54° wall.
 *
 * Following the toe fixes it at the source: as the near flank fills, the
 * delivery point walks further down, so the flow *extends* rather than
 * thickening — which is also what a real channel-fed flow does, delivering to
 * its own front through an insulated tube.
 */
function breachToe(
  engine: PixelEngine,
  cfg: VolcanoConfig,
  breachOffset: number,
  summitH: number,
): { angle: number; radius: number } | null {
  const sign = breachOffset < 0 ? -1 : 1;
  const start = Math.abs(breachOffset);
  for (let m = start; m <= start * 3.5; m += 0.02) {
    const angle = cfg.ventAngle + sign * m;
    const radius = surfaceRadiusAt(engine, cfg, angle);
    if (radius - cfg.planetRadius <= summitH - BREACH_MIN_DROP) return { angle, radius };
  }
  return null;
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
  const r = 38 + n, g = 34 + n, b = 36 + n;
  cg[y * engine.width + x] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
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
      engine.setMaterial(x, y, MaterialType.SAND);
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
      if (mat !== MaterialType.LAVA && mat !== MaterialType.ROCK) continue;

      const t = engine.getHeat(x, y);
      if (mat === MaterialType.LAVA) {
        setStiffness(engine, x, y, stiffnessForTemp(t));
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
const RECHARGE_HEADROOM = 3;

export function rechargeReservoir(engine: PixelEngine, cfg: VolcanoConfig): number {
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
    // walls that make the chamber a chamber, the same rule `remeltConduit`
    // follows for the bore.
    if (m !== MaterialType.LAVA && m !== MaterialType.ROCK && m !== MaterialType.SAND) return;
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

  const chamberR = cfg.planetRadius - cfg.chamberDepth;

  // The bore. `reservoirTemp` covers the conduit as well as the chamber, and it
  // needs the feed more: a narrow bore wrapped in bedrock is nearly all surface,
  // so it loses heat faster than the blob it rises from.
  //
  // The feed stops short of the surface. Heat arrives from the mantle, so it is
  // a function of depth — and near-surface magma is precisely what the
  // atmosphere cools. Holding the column molten right to the summit pins the
  // vent cap above the freezing point forever (it equilibrates around 0.44
  // against a fed neighbour), so the crater never crusts and repose stops
  // reading as repose.
  for (let r = chamberR; r <= cfg.planetRadius - RECHARGE_HEADROOM; r++) {
    const hw = boreHalfWidth(cfg, r);
    for (let w = -hw; w <= hw; w++) {
      const p = borePos(cfg, r, w);
      feed(p.x, p.y);
    }
  }

  // The chamber blob, same geometry `stampVolcano` lays down.
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
 * **Required, not cosmetic.** Tephra is `SAND` at density 10 and lava is density
 * 8, so ejecta landing on the open vent does not sit on top of the magma — it
 * *sinks through it*, filling the conduit and chamber from the top down. Magma
 * remelts what falls into it, so restoring the bore each frame is both the
 * physical answer and the cheap one.
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
    if (m !== MaterialType.SAND && m !== MaterialType.ROCK) return;
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
 * Tephra is `SAND` (density 10) and lava is density 8, so ejecta that lands in a
 * flow sinks *through* it and lodges there, which is why grey particles would
 * otherwise hang around in the magma.
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
export const DEFAULT_PHASES: PhaseDurations = { explosive: 300, effusive: 40, repose: 150 };

export function createVolcanoState(): VolcanoState {
  // Open explosively: a real eruption clears its throat with ash and tephra
  // before lava reaches the surface, and it gives the first flows a cone to
  // run down instead of a bare planet.
  return { phase: 'explosive', phaseFrame: 0, frame: 0, cycle: 0, breach: 0 };
}

/**
 * Pick where this episode's flows break out of the rim.
 *
 * Placed part-way out the flank rather than on the rim crest: on the crest the
 * ground is still near-level and lava ponds instead of running.
 */
function pickBreach(rng: () => number, spread: number): number {
  const side = rng() < 0.5 ? -1 : 1;
  return side * spread * (0.45 + 0.35 * rng());
}

/** Tuning for {@link stepVolcano}. */
export interface VolcanoStepOptions {
  plume: PlumeOptions;
  pressure: PressureOptions;
  /** Per-frame chance of melting an embedded tephra cell. */
  assimilateRate: number;
  phases?: PhaseDurations;
}

/**
 * Advance the eruption one frame. Call *around* `engine.update()`:
 * {@link stepVolcanoPre} before it, this after it.
 *
 * Split in two because the order matters. Emission has to happen before the
 * engine step so new cells move on the same frame they appear, while cooling and
 * plumbing maintenance have to happen after it, so a flow gets a chance to
 * travel before it is asked whether it has set.
 */
export function stepVolcanoPre(
  engine: PixelEngine,
  cfg: VolcanoConfig,
  state: VolcanoState,
  rng: () => number,
  opts: VolcanoStepOptions,
): void {
  const phases = opts.phases ?? DEFAULT_PHASES;

  if (state.phase === 'explosive') {
    emitPlume(engine, cfg, rng, opts.plume);
  } else if (state.phase === 'effusive') {
    pressurizeConduit(engine, cfg, state.frame, rng, opts.pressure, state.breach);
  }
  // 'repose' emits nothing — the flows crust over and the glow fades, which is
  // what makes the next burst read as a new episode rather than more of the same.

  state.frame++;
  state.phaseFrame++;
  const limit = phases[state.phase];
  if (state.phaseFrame >= limit) {
    state.phaseFrame = 0;
    if (state.phase === 'explosive') {
      state.phase = 'effusive';
      state.breach = pickBreach(rng, opts.plume.spread);
    } else if (state.phase === 'effusive') state.phase = 'repose';
    else { state.phase = 'explosive'; state.cycle++; }
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
 */
export function stepVolcanoPost(
  engine: PixelEngine,
  cfg: VolcanoConfig,
  state: VolcanoState,
  rng: () => number,
  opts: VolcanoStepOptions,
): void {
  // Fallout sinks through the magma (tephra is denser than lava), so the bore
  // has to be reclaimed or the volcano chokes on its own ejecta.
  if (state.phase !== 'repose') remeltConduit(engine, cfg);
  // Every phase, repose included: the chamber is molten between eruptions too,
  // and left unfed it would set solid and end the volcano permanently.
  rechargeReservoir(engine, cfg);
  assimilateTephra(engine, rng, { rate: opts.assimilateRate });
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
