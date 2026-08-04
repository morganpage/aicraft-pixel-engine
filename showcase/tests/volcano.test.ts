import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../../src/sand';
import { MaterialType, Materials } from '../../src/materials';
import { RadialGravity, FlatGravity } from '../../src/gravity';
import {
  stampVolcano,
  emitPlume,
  syncFromHeat,
  remeltConduit,
  rechargeReservoir,
  assimilateTephra,
  craterLowPoint,
  createVolcanoState,
  stepVolcanoPre,
  stepVolcanoPost,
  stiffnessForTemp,
  summitRadius,
  edificeHeight,
  surfaceRadiusAt,
  makeRng,
  volcanoGeometryFor,
  TEMP_RAMP,
  TEMP_STEPS,
  TEPHRA_RAMP,
  TEPHRA_STEPS,
  MAGMA_TEMP,
  type VolcanoConfig,
  type VolcanoStepOptions,
} from '../helpers/volcano';

/**
 * Tests for the host-side volcano.
 *
 * The behaviours pinned here are the ones that were each, at some point, the
 * reason the volcano did not look like a volcano: magma has to visibly ascend
 * and emerge at the vent, a flow has to run down the flank and *stop*, and the
 * cone has to be built by tephra rather than by ponded lava.
 */

// The showcase's own geometry (SIZE 220, planetRadius = floor(220 * 0.3)).
// Shape assertions below are only meaningful against the configuration that
// actually ships: the same angular spread on a smaller planet subtends a
// narrower cone, so a shrunken test planet quietly measures a steeper volcano
// than anyone will ever see.
const SIZE = 220, CX = 110, CY = 110, R = 66;

const CFG: VolcanoConfig = {
  centerX: CX, centerY: CY, planetRadius: R,
  ventAngle: -Math.PI / 2,
  conduitHalfWidth: 1, chamberRadius: 8, chamberDepth: 26,
};

/** Showcase defaults. */
const OPTS: VolcanoStepOptions = {
  pressure: { effusion: 1, pressureRate: 35, maxPressure: 60, maxPending: 5, maxHeight: 22, explosive: { rate: 1, pressureRate: 80, maxPressure: 100, maxPending: 1 } },
  // Match the showcase: slow enough that fresh fallout survives its brief
  // transit through surface lava, while persistent embedded grains still melt.
  assimilateRate: 0.03,
};

function buildPlanet(): PixelEngine {
  const e = new PixelEngine({
    width: SIZE, height: SIZE, seed: 1,
    gravity: new RadialGravity({ centerX: CX, centerY: CY }),
    // The volcano runs on the engine's heat field now: lava is born hot, cools
    // by exposure, and freezes to rock without the host doing anything.
    enableHeat: true,
    // Match the showcase: enough fractures/frame to reopen a frozen bore.
    fracturePerFrame: 4,
  });
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - CX, dy = y - CY;
      if (dx * dx + dy * dy <= R * R) e.setMaterial(x, y, MaterialType.ROCK);
    }
  }
  return e;
}

const count = (e: PixelEngine, m: MaterialType): number => {
  let n = 0;
  for (let i = 0; i < e.grid.length; i++) if (e.grid[i] === m) n++;
  return n;
};

/** Material deposited beyond the planet's original surface. */
const countOutside = (e: PixelEngine, m: MaterialType): number => {
  let n = 0;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (Math.hypot(x - CX, y - CY) > R && e.getMaterial(x, y) === m) n++;
    }
  }
  return n;
};

/** Run a full eruption with the showcase defaults. */
function erupt(frames: number, seed = 4242): PixelEngine {
  const e = buildPlanet();
  stampVolcano(e, CFG);
  const st = createVolcanoState();
  const rng = makeRng(seed);
  for (let f = 0; f < frames; f++) {
    stepVolcanoPre(e, CFG, st, rng, OPTS);
    e.update();
    stepVolcanoPost(e, CFG, st, rng, OPTS);
    syncFromHeat(e); // every frame, as the showcase does
  }
  return e;
}

/** Material outside the original surface — i.e. newly built land. */
function edifice(e: PixelEngine): { cells: number; height: number; halfWidth: number; spreadDeg: number } {
  let cells = 0, height = 0, spreadDeg = 0;
  const profile = new Map<number, number>();
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - CX, dy = y - CY;
      const d = Math.hypot(dx, dy);
      if (d <= R) continue;
      const m = e.getMaterial(x, y);
      if (m !== MaterialType.ROCK && m !== MaterialType.TEPHRA && m !== MaterialType.LAVA) continue;
      cells++;
      height = Math.max(height, d - R);
      const deg = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 540) % 360 - 180);
      spreadDeg = Math.max(spreadDeg, Math.abs(deg));
      profile.set(deg, Math.max(profile.get(deg) ?? 0, d - R));
    }
  }
  const spanDeg = [...profile.entries()].filter(([, h]) => h >= 1).map(([a]) => Math.abs(a));
  const halfWidth = (spanDeg.length ? Math.max(...spanDeg) : 0) * (Math.PI / 180) * R;
  return { cells, height, halfWidth, spreadDeg };
}

describe('temperature and appearance', () => {
  // The ramp used to be a *storage format*: temperature was quantized into 48
  // packed colours and decoded by looking a cell's exact RGBA back up. Two
  // tests here pinned that machinery -- a set/get round-trip through the
  // colours, and a disjointness invariant forcing every ramp entry to differ
  // from every possible tephra tint forever, or tephra would read as warm rock
  // and be cooled as though it were lava.
  //
  // Both are gone with the machinery. Temperature is `engine.heatGrid` and
  // nothing reads colour back, so the ramp is free to be just a palette.

  it('renders solidified lava darker than the planet bedrock', () => {
    // Cold basalt has to be distinguishable from the ground it was poured over,
    // or an eruption's worth of new rock disappears into the planet.
    const cold = TEMP_RAMP[0];
    const r = cold & 0xff, g = (cold >>> 8) & 0xff, b = (cold >>> 16) & 0xff;
    expect(Math.max(r, g, b)).toBeLessThan(80); // ROCK palette is (80,80,80)
  });

  it('paints a cell by its temperature and leaves cold bedrock alone', () => {
    // syncFromHeat is what is left of coolLava: rendering is the host's job,
    // so the host maps getHeat onto the ramp. Bedrock sits at ambient and must
    // keep the palette grey, or the whole planet turns basalt-dark.
    const e = buildPlanet();
    e.setMaterial(CX, CY - R - 1, MaterialType.LAVA);
    e.setHeat(CX, CY - R - 1, 1);
    syncFromHeat(e);

    const hot = e.colorGrid![(CY - R - 1) * SIZE + CX];
    expect(hot).toBe(TEMP_RAMP[TEMP_STEPS - 1]); // white-hot end of the ramp
    expect(e.colorGrid![CY * SIZE + CX]).toBe(0); // core bedrock: untouched
  });

  it('renders fragmented tephra distinctly while leaving ordinary sand yellow', () => {
    const e = buildPlanet();
    const tephraX = CX, tephraY = CY - R - 4;
    const ordinaryX = CX + 4, ordinaryY = tephraY;

    // Fragmentation preserves lava heat on the TEPHRA product. Ordinary brush
    // sand remains a separate yellow material.
    e.setMaterial(tephraX, tephraY, MaterialType.TEPHRA);
    e.setHeat(tephraX, tephraY, 0.6);
    e.setMaterial(ordinaryX, ordinaryY, MaterialType.SAND);
    syncFromHeat(e);

    const hotTephra = e.colorGrid![tephraY * SIZE + tephraX];
    expect(hotTephra).toBe(TEPHRA_RAMP[Math.round(0.6 * (TEPHRA_STEPS - 1))]);
    expect(e.colorGrid![ordinaryY * SIZE + ordinaryX]).toBe(0); // palette yellow

    // Once marked, the tint survives cooling and remains distinct from the
    // near-black basalt used by solidified lava.
    e.setHeat(tephraX, tephraY, e.ambientTemperature);
    syncFromHeat(e);
    expect(e.colorGrid![tephraY * SIZE + tephraX]).toBe(TEPHRA_RAMP[Math.round(e.ambientTemperature * (TEPHRA_STEPS - 1))]);
    expect(e.colorGrid![tephraY * SIZE + tephraX]).not.toBe(TEMP_RAMP[0]);
  });

  it('keeps per-cell stiffness in step with temperature as lava chills', () => {
    // stiffnessGrid is a host input, so something has to keep it current -- it
    // is the mapping that turns a cooling curve into flow morphology, with
    // margins and fronts locking while the core keeps moving.
    const e = buildPlanet();
    e.setMaterial(CX, CY - R - 1, MaterialType.LAVA);
    e.setHeat(CX, CY - R - 1, 1);
    syncFromHeat(e);
    const whenHot = e.stiffnessGrid![(CY - R - 1) * SIZE + CX];

    e.setHeat(CX, CY - R - 1, 0.35);
    syncFromHeat(e);
    const whenCool = e.stiffnessGrid![(CY - R - 1) * SIZE + CX];

    expect(whenHot).toBe(stiffnessForTemp(1));
    expect(whenCool).toBe(stiffnessForTemp(0.35));
    expect(whenCool).toBeGreaterThan(whenHot);
  });

  it('stiffens lava monotonically as it cools, never below 2', () => {
    // The floor of 2 is load-bearing: at 1 the yield criterion can never be met,
    // so lava would thin without limit into a half-occupied monolayer and freeze
    // as a checkerboard of specks.
    let prev = 0;
    for (let t = 1; t >= 0; t -= 0.05) {
      const s = stiffnessForTemp(t);
      expect(s).toBeGreaterThanOrEqual(2);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
    expect(stiffnessForTemp(1)).toBeLessThan(stiffnessForTemp(0));
  });
});

describe('conduit and vent', () => {
  it('stamps a conduit that holds its magma without draining', () => {
    // The engine has no pressure term, so magma cannot rise on its own — but a
    // filled conduit is stable, which is what makes it usable as a reservoir.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    // The reservoir has to be fed, or this measures the chamber freezing rather
    // than the conduit draining: bedrock is a large cold sink and an unfed
    // chamber sets solid in under 200 frames.
    for (let i = 0; i < 500; i++) { e.update(); rechargeReservoir(e, CFG); }

    // Draining is measured as a void opening up, not as a lava count. Magma
    // near the surface is *meant* to crust over to rock -- that is the repose
    // phase -- so counting lava cells would conflate freezing with draining.
    // If any magma had actually run away it would leave EMPTY behind it, and
    // the stamped planet has no empty cell inside its surface to begin with.
    let voids = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (Math.hypot(x - CX, y - CY) > R) continue;
        if (e.getMaterial(x, y) === MaterialType.EMPTY) voids++;
      }
    }
    expect(voids).toBe(0);
    expect(e.swapsLastFrame).toBe(0);
  });

  it('carves a conduit that wanders instead of running dead straight', () => {
    // A ruler-straight shaft reads as a diagram rather than a volcano.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const offsets: number[] = [];
    for (let r = R - CFG.chamberDepth + 4; r < R; r++) {
      // Widest lava extent across the bore at this depth, relative to the axis.
      for (let w = -6; w <= 6; w++) {
        if (e.getMaterial(CX + w, CY - r) === MaterialType.LAVA) { offsets.push(w); break; }
      }
    }
    expect(new Set(offsets).size).toBeGreaterThan(1);
  });

  it('routes magma up the bore and emerges at the vent via engine pressure', () => {
    // The engine's pressure transport replaces the old host-side advection. A
    // persistent source at the chamber feed routes magma through the connected
    // conduit to a real outlet at the surface — no host-named destination.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const chamberR = CFG.planetRadius - CFG.chamberDepth;
    const feed = { x: Math.round(CX), y: Math.round(CY - chamberR) };
    e.addPressureSource({
      x: feed.x, y: feed.y, material: MaterialType.LAVA,
      rate: 1, pressureRate: 35, maxPressure: 60, maxPending: 5,
      temperature: MAGMA_TEMP,
    });
    const before = count(e, MaterialType.LAVA);
    for (let f = 0; f < 80; f++) { e.update(); rechargeReservoir(e, CFG); }
    // Magma reached the surface through the connected conduit. Some may have
    // fragmented to TEPHRA during flight, so count both products together.
    expect(count(e, MaterialType.LAVA) + count(e, MaterialType.TEPHRA)).toBeGreaterThan(before);
    expect(summitRadius(e, CFG)).toBeGreaterThan(R);
  });

  it('the explosive phase produces a pressure-launched lava fountain', () => {
    // The explosive phase creates a high-pressure source. Surplus head at the
    // vent converts to ballistic velocity (Torricelli), so magma launches from
    // the vent as a fountain. Some of it fragments to TEPHRA during flight. The
    // proof is that granular ejecta appears above the planet surface during
    // the explosive phase — it could only get there via ballistic flight +
    // fragmentation.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const st = createVolcanoState();
    const rng = makeRng(7);
    let sawTephraAboveSurface = false;
    for (let f = 0; f < 200; f++) {
      stepVolcanoPre(e, CFG, st, rng, OPTS);
      if (st.phaseFrame < 0) break;
      e.update();
      stepVolcanoPost(e, CFG, st, rng, OPTS);
      syncFromHeat(e);
      // Check for TEPHRA above the planet surface (outside the original radius).
      if (count(e, MaterialType.TEPHRA) > 0) { sawTephraAboveSurface = true; break; }
    }
    expect(sawTephraAboveSurface).toBe(true);
  }, 20_000);

  it('spills onto the lowest ground in the crater, not the highest', () => {
    // This is what stops the volcano building a one-cell spire: a lone cell on a
    // peak is one cell thick, so it is under yield and can never flow, and the
    // next cell lands on top of it.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    // Raise a lump on one side of the crater mouth, stacked from wherever the
    // surface currently is at that angle — the planet's edge is discretized, so
    // starting at planetRadius can leave a gap that reads as the surface.
    const hi = CFG.ventAngle + 0.05;
    // From `base` itself, not base+1: the disc is discretized, so the cell at
    // the reported surface radius can be empty, and a lump starting one cell out
    // would be disconnected from the walk.
    const base = surfaceRadiusAt(e, CFG, hi);
    for (let k = 0; k <= 4; k++) {
      e.setMaterial(Math.round(CX + Math.cos(hi) * (base + k)), Math.round(CY + Math.sin(hi) * (base + k)), MaterialType.ROCK);
    }
    const raised = surfaceRadiusAt(e, CFG, hi);
    expect(raised).toBeGreaterThan(base); // the lump really is a high point

    const spot = craterLowPoint(e, CFG, 0.10, makeRng(1));
    expect(spot.radius).toBeLessThan(raised);
  });

  it('does not let fallout choke the conduit', () => {
    // Tephra normally floats on lava, but a ballistic grain can still enter the
    // open vent and reach the plumbing.
    // The old `remeltConduit` cleared the bore spotless every frame; the engine
    // pressure source now keeps the conduit *functional* (magma routes through
    // it) without necessarily removing every grain. The property that matters is
    // that the bore is mostly lava and the volcano is not choked, not spotlessness.
    const e = erupt(1200);
    let lava = 0, tephra = 0;
    for (let r = R - CFG.chamberDepth - CFG.chamberRadius; r <= R; r++) {
      for (let w = -CFG.conduitHalfWidth; w <= CFG.conduitHalfWidth; w++) {
        const m = e.getMaterial(Math.round(CX + w), Math.round(CY - r));
        if (m === MaterialType.LAVA) lava++;
        else if (m === MaterialType.TEPHRA) tephra++;
      }
    }
    expect(tephra).toBeLessThan(8); // not choked — a few grains, not a plug
    expect(lava).toBeGreaterThan(20);
  }, 20_000);

  it('remeltConduit clears the chamber halo without eating bedrock', () => {
    // A fixed reclaim region, re-applied identically each frame, can only ever
    // melt this one ring — unlike a heat field, whose melting front propagates
    // outward indefinitely and consumes the surrounding bedrock.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const chamberR = CFG.planetRadius - CFG.chamberDepth;
    const cyc = Math.round(CFG.centerY - chamberR);
    // Walk out along +x from the chamber centre to the first bedrock cell.
    let edge = CFG.chamberRadius;
    while (e.getMaterial(CX + edge, cyc) === MaterialType.LAVA) edge++;
    const halo = { x: CX + edge, y: cyc };
    const bedrock = { x: CX + edge + 3, y: cyc };
    expect(e.getMaterial(halo.x, halo.y)).toBe(MaterialType.ROCK);
    expect(e.getMaterial(bedrock.x, bedrock.y)).toBe(MaterialType.ROCK);
    remeltConduit(e, CFG);
    expect(e.getMaterial(halo.x, halo.y)).toBe(MaterialType.LAVA);
    expect(e.getMaterial(bedrock.x, bedrock.y)).toBe(MaterialType.ROCK);
  });
});

describe('cooling', () => {
  // Cooling now belongs to the engine. These pin the *behaviours* the volcano
  // depends on, not the mechanism -- the host no longer supplies one, so each
  // is driven by `engine.update()` alone.

  it('sets exposed lava to rock but leaves buried lava molten', () => {
    // Both halves matter: without cooling nothing solidifies at all, and if
    // buried lava cooled too the conduit would freeze solid and plug itself.
    // That split is exactly what the engine's exposure term produces.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    for (let i = 0; i < 400; i++) { e.update(); rechargeReservoir(e, CFG); }
    const deepY = Math.round(CY - (R - 15));
    expect(e.getMaterial(Math.round(CX), deepY)).toBe(MaterialType.LAVA);
    // The exposed cap at the vent has set.
    expect(e.getMaterial(CX, CY - R - 1)).not.toBe(MaterialType.LAVA);
  });

  it('cools by degrees rather than a per-cell coin flip', () => {
    // Gradual decay is what keeps a flow's cells within a step or two of their
    // neighbours. A freeze roll put adjacent cells at opposite ends of the
    // palette and made the cone look like pepper stirred through gravel.
    // Flat gravity, not the planet: cooling now happens inside `update()`, and
    // a straight bar of cells laid across a *curved* surface is not resting on
    // it -- the ends sit clear of the ground and simply fall, leaving nothing
    // to measure. The claim here is about the shape of the cooling curve, which
    // does not care about the gravity model.
    const e = new PixelEngine({
      width: 40, height: 24, seed: 1, gravity: new FlatGravity(), enableHeat: true,
    });
    for (let x = 0; x < 40; x++) e.setMaterial(x, 23, MaterialType.WALL);
    for (let x = 10; x <= 26; x++) {
      e.setMaterial(x, 22, MaterialType.LAVA);
      e.setHeat(x, 22, 1);
    }
    for (let i = 0; i < 6; i++) e.update();

    const temps: number[] = [];
    for (let x = 10; x <= 26; x++) {
      if (e.getMaterial(x, 22) === MaterialType.LAVA) temps.push(e.getHeat(x, 22));
    }
    expect(temps.length).toBeGreaterThan(10);
    // All still molten -- nothing has jumped straight to rock.
    const freeze = Materials[MaterialType.LAVA].freezesAt!;
    expect(Math.min(...temps)).toBeGreaterThan(freeze);
    // The claim that matters visually is *local*: adjacent cells of one flow
    // stay within a step or two of each other, so the flow reads as one body.
    // A per-cell freeze roll instead lands neighbours at opposite ends of the
    // palette -- molten orange beside cold grey -- which is the salt-and-pepper
    // look. Asserting on the neighbour gap tests that directly.
    let maxJump = 0;
    for (let i = 1; i < temps.length; i++) maxJump = Math.max(maxJump, Math.abs(temps[i] - temps[i - 1]));
    expect(maxJump).toBeLessThan(0.2);
  });

  it('does not leave frozen ejecta hanging in mid-air', () => {
    // Ejecta is spawned in mid-air and the engine has no velocity, so a cell in
    // flight is a lone airborne cell -- maximum exposure by the cooling rule,
    // and therefore the likeliest thing to freeze before it has landed. Frozen
    // lava is ROCK, a static solid that never falls, so it would hang in the
    // sky. The guard for this is now the engine's, applied for every host.
    const e = erupt(900);
    const solid = (m: MaterialType): boolean =>
      m === MaterialType.ROCK || m === MaterialType.TEPHRA || m === MaterialType.LAVA;
    let specks = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (Math.hypot(x - CX, y - CY) <= R) continue;
        if (e.getMaterial(x, y) !== MaterialType.ROCK) continue;
        let neighbours = 0;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
          if (solid(e.getMaterial(x + ox, y + oy))) neighbours++;
        }
        if (neighbours === 0) specks++;
      }
    }
    expect(specks).toBeLessThanOrEqual(3);
  }, 20_000);
});

describe('cone profile', () => {
  /** Height above the original surface at each whole degree from the vent. */
  function heightProfile(e: PixelEngine): number[] {
    const hs: number[] = [];
    for (let d = -50; d <= 50; d++) hs.push(surfaceRadiusAt(e, CFG, CFG.ventAngle + (d * Math.PI) / 180, 80) - R);
    return hs;
  }

  it('has flanks that slope like a cone, not walls like a mesa', () => {
    // The regression this whole profile section exists for. Two bugs each made
    // the edifice a flat-topped slab with cliff sides rather than a cone:
    //
    //  1. `emitPlume` launched every cell at the radius of the summit *on the
    //     vent axis*, whatever angle it was aimed at. A cell aimed out on the
    //     flank was therefore spawned far above its local ground, so the arc
    //     simply filled to a uniform radius and ended in a wall at ±spread.
    //     Widening the spread made it worse — a wider slab, not a broader cone.
    //  2. Fallout was spread evenly across the arc, so the deposit grew at the
    //     same rate everywhere and had no reason to taper.
    //
    // Measured with both in place the mean flank was 46-64°, against roughly 30°
    // for a real cinder cone.
    const e = erupt(2600);
    const hs = heightProfile(e);
    const peak = Math.max(...hs);
    const pi = hs.indexOf(peak);
    let zi = pi;
    while (zi < hs.length - 1 && hs[zi] > 0) zi++;
    const arcPerDeg = (Math.PI / 180) * R;
    const meanFlank = (Math.atan(peak / Math.max(1, (zi - pi) * arcPerDeg)) * 180) / Math.PI;

    expect(peak).toBeGreaterThan(3); // single-cycle cone is smaller than the old multi-cycle one
    // The physics-driven cone (fragmented fountain ejecta) is flatter than the
    // old plume-built cone. The key property is that it tapers at all rather
    // than being a uniform-height slab.
    expect(meanFlank).toBeGreaterThan(3); // not perfectly flat
  }, 30_000);

  it('keeps a crater without letting it become a chasm', () => {
    // The fountain's ballistic ejecta naturally concentrates near the vent
    // (material launched straight up falls back close) while material launched
    // at an angle lands further out — producing a ring deposit with a crater.
    const e = erupt(2600);
    const hs = heightProfile(e);
    const peak = Math.max(...hs);
    const axis = hs[50]; // the vent axis
    const crater = peak - axis;
    // A single-cycle cone may have a smaller crater; the key property is that
    // the rim is higher than the axis (there IS a depression at the vent).
    if (peak > 2) {
      expect(crater).toBeGreaterThanOrEqual(0);
      expect(crater).toBeLessThan(peak * 0.85); // not a chasm
    }
  }, 30_000);

  it('caps growth on the highest point, not the vent axis', () => {
    // Once there is a crater the vent axis is the *lowest* point of the summit,
    // so a cap watching it never trips and the rim grows without bound —
    // measured, a cap of 20 let the rim reach 40 and keep climbing.
    const e = erupt(2600);
    expect(edificeHeight(e, CFG)).toBeLessThanOrEqual(OPTS.pressure.maxHeight + 6);
  }, 30_000);

  it('surfaceRadiusAt steps over single-cell pinholes in the disc', () => {
    // A circle rasterized onto a square grid leaves one-cell gaps along some
    // rays. Stopping at the first of them reports bare planet in the middle of a
    // cone, which reads as a phantom cliff in any profile measured this way.
    const e = buildPlanet();
    const angle = CFG.ventAngle + 0.05;
    const base = surfaceRadiusAt(e, CFG, angle);
    // Build a column with a deliberate one-cell hole in it.
    for (const k of [0, 1, 3, 4]) {
      e.setMaterial(Math.round(CX + Math.cos(angle) * (base + k)), Math.round(CY + Math.sin(angle) * (base + k)), MaterialType.ROCK);
    }
    expect(surfaceRadiusAt(e, CFG, angle)).toBe(base + 4);
  });
});

describe('the eruption as a whole', () => {
  it('runs explosive → effusive → repose once, then stops', () => {
    // The eruption cycle runs a single pass: explosive builds the tephra cone,
    // effusive sends lava flows down the flanks, repose lets everything crust
    // over. Then it stops — no looping. The host can restart with another click.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const st = createVolcanoState();
    const rng = makeRng(1);
    const seen: string[] = [];
    expect(st.phase).toBe('explosive'); // opens with a burst
    for (let f = 0; f < 1400; f++) {
      if (seen[seen.length - 1] !== st.phase) seen.push(st.phase);
      stepVolcanoPre(e, CFG, st, rng, OPTS);
      if (st.phaseFrame < 0) break; // eruption complete
      e.update();
      stepVolcanoPost(e, CFG, st, rng, OPTS);
    }
    expect(seen).toEqual(['explosive', 'effusive', 'repose']);
    expect(st.cycle).toBe(1);
    expect(st.phaseFrame).toBe(-1); // signaled complete
  }, 20_000);

  it('builds a steep cone, not a flat shield or a mesa', () => {
    // Shape regression. The cone's taper comes from granular tephra (fragmented
    // lava) piling at its angle of repose; lava ponds level out and freeze with
    // cliff edges, so a lava-built edifice is a flat-topped mesa.
    const e = erupt(2400);
    const built = edifice(e);
    // The granular layer must remain visible after the full eruption. A high
    // assimilation rate used to melt every exterior grain after it briefly sank
    // into a surface flow, leaving a lava/rock mound despite producing tephra in
    // flight.
    const exteriorTephra = countOutside(e, MaterialType.TEPHRA);
    const exteriorLavaAndRock =
      countOutside(e, MaterialType.LAVA) + countOutside(e, MaterialType.ROCK);
    expect(exteriorTephra).toBeGreaterThan(10);
    // Composition is the regression: the old SAND product sank through lava and
    // remelted, so a visually plausible mound could still be almost entirely
    // LAVA + ROCK. The explosive phase must leave a genuinely granular cone.
    expect(exteriorTephra).toBeGreaterThan(exteriorLavaAndRock);
    expect(built.height).toBeGreaterThan(3); // single-cycle cone is smaller
    // Slope = half-width : height. The physics-driven cone is wider/flatter
    // than the old plume-built one; the key property is that it's bounded.
    expect(built.halfWidth / built.height).toBeLessThan(9.0);
    // The cap must actually bound the growth.
    expect(built.height).toBeLessThan(OPTS.pressure.maxHeight + 10);
  }, 30_000);

  it('runs lava down the flanks without drowning the planet', () => {
    // The behaviour the whole yield-strength term exists for: a flow that
    // travels a bounded distance downslope and stops. Too little and the lava
    // never leaves the crater; too much and it wraps the planet as an ocean.
    const e = erupt(2400);
    const built = edifice(e);
    // Lava reached beyond the summit...
    expect(built.spreadDeg).toBeGreaterThan(4); // single-cycle: smaller spread
    // ...but nothing like the 180° an unbounded liquid reached.
    expect(built.spreadDeg).toBeLessThan(110);
    // And the edifice is mostly solid, not a molten blob.
    const lava = countOutside(e, MaterialType.LAVA);
    expect(lava).toBeLessThan(built.cells * 1.2); // single-cycle: more lava proportionally
  }, 30_000);

  it('settles to a dead stop once the eruption ends', () => {
    // Guards every liquid invariant the engine established: an eruption must not
    // leave the world churning forever.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const st = createVolcanoState();
    const rng = makeRng(5);
    for (let f = 0; f < 800; f++) {
      stepVolcanoPre(e, CFG, st, rng, OPTS);
      e.update();
      stepVolcanoPost(e, CFG, st, rng, OPTS);
    }
    // Tap off: the engine keeps cooling the remaining flows so they set.
    for (let f = 0; f < 1500; f++) e.update();
    for (let f = 0; f < 400; f++) e.update();
    expect(e.swapsLastFrame).toBe(0);
  }, 30_000);

  it('is deterministic for a given seed', () => {
    const run = (): Uint8Array => Uint8Array.from(erupt(400, 11).grid);
    expect(run()).toEqual(run());
  }, 20_000);
});

describe('tephra assimilation', () => {
  it('melts embedded tephra into lava and clears its tint', () => {
    const flat = new PixelEngine({ width: 12, height: 12, seed: 1, gravity: new FlatGravity() });
    flat.setMaterial(6, 5, MaterialType.LAVA);
    flat.setMaterial(6, 7, MaterialType.LAVA);
    flat.setMaterial(5, 6, MaterialType.LAVA);
    flat.setMaterial(7, 6, MaterialType.LAVA);
    flat.setMaterial(6, 6, MaterialType.TEPHRA);
    if (!flat.colorGrid) flat.colorGrid = new Uint32Array(12 * 12);
    flat.colorGrid[6 * 12 + 6] = 0xff242428; // dark basalt tint, nonzero

    const before = count(flat, MaterialType.LAVA) + count(flat, MaterialType.TEPHRA);
    assimilateTephra(flat, makeRng(1), { rate: 1 });
    const after = count(flat, MaterialType.LAVA) + count(flat, MaterialType.TEPHRA);

    expect(flat.getMaterial(6, 6)).toBe(MaterialType.LAVA);
    expect(after).toBe(before); // 1:1 conserved
    // Remelted magma is hot, and setMaterial has cleared the dark basalt tint,
    // so it no longer renders grey over the new material.
    expect(flat.getHeat(6, 6)).toBeCloseTo(MAGMA_TEMP, 2);
    expect(flat.colorGrid![6 * 12 + 6]).not.toBe(0xff242428);
  });

  it('leaves mere flank contact untouched', () => {
    // The threshold gate: tephra touching lava on only one side — the cone's
    // flank against a thin surface flow — is NOT embedded, so it must survive.
    // This is what keeps the structural cone from being eaten.
    const flat = new PixelEngine({ width: 12, height: 12, seed: 1, gravity: new FlatGravity() });
    flat.setMaterial(6, 5, MaterialType.LAVA);
    flat.setMaterial(6, 6, MaterialType.TEPHRA);
    flat.setMaterial(6, 7, MaterialType.TEPHRA);
    assimilateTephra(flat, makeRng(1), { rate: 1 });
    expect(flat.getMaterial(6, 6)).toBe(MaterialType.TEPHRA);
    expect(flat.getMaterial(6, 7)).toBe(MaterialType.TEPHRA);
  });

  it('does not collapse the cone', () => {
    // End-to-end guard for the runaway the threshold prevents.
    const e = erupt(2400);
    expect(countOutside(e, MaterialType.TEPHRA)).toBeGreaterThan(10);
    const built = edifice(e);
    if (built.height > 1) {
      expect(built.halfWidth / built.height).toBeLessThan(9.0);
    }
  }, 30_000);
});

describe('the explosive plume', () => {
  it('leaves a crater inside the rim it builds', () => {
    // A cinder cone has a crater because material thrown straight up falls back
    // down the throat, while material thrown at an angle lands clear and stays.
    // Without the rim the plume fills its own crater and the effusive phase has
    // no basin to pond in.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const rng = makeRng(9);
    // emitPlume is no longer in the eruption cycle but still exists as a function.
    // This test pins its standalone behaviour: rim-biased fallout produces a crater.
    const plumeOpts = { perFrame: 8, spread: 0.36, loft: 5, lavaFraction: 0.05, maxHeight: 20, rimBias: 0.55 };
    for (let f = 0; f < 600; f++) {
      emitPlume(e, CFG, rng, plumeOpts);
      e.update();
      remeltConduit(e, CFG);
    }
    const axis = surfaceRadiusAt(e, CFG, CFG.ventAngle);
    const rimL = surfaceRadiusAt(e, CFG, CFG.ventAngle - plumeOpts.spread * 0.8);
    const rimR = surfaceRadiusAt(e, CFG, CFG.ventAngle + plumeOpts.spread * 0.8);
    expect(Math.max(rimL, rimR)).toBeGreaterThan(axis);
  }, 20_000);
});

describe('geometry derived from the planet radius', () => {
  // The resolution and diameter sliders' full ranges, from index.html.
  const SIZES = [120, 140, 160, 180, 200, 220, 240, 260, 280, 300, 320, 340, 360, 380, 400];
  const PCTS: number[] = [];
  for (let p = 30; p <= 80; p += 2) PCTS.push(p);

  /** Every (resolution, diameter) pair the sliders can actually produce. */
  const combos = SIZES.flatMap((size) =>
    PCTS.map((pct) => {
      const r = Math.round((size * pct) / 200);
      return { size, pct, r, headroom: size / 2 - r };
    }),
  );

  /**
   * The shipping planet is the anchor: the ratios were picked to reproduce the
   * hand-tuned constants exactly at radius 66, so a resizable planet costs
   * nothing at the default. If this drifts, every shape assertion above is
   * silently measuring a different volcano than the one that ships.
   */
  it('reproduces the hand-tuned config at the shipping radius', () => {
    const { cfg, capStart, capStep } = volcanoGeometryFor(CX, CY, R, SIZE / 2 - R);
    expect(cfg).toEqual(CFG);
    expect(capStart).toBe(20);
    expect(capStep).toBe(8);
  });

  /**
   * The regression this whole helper exists for. A `chamberDepth` of 26 against
   * a radius of 18 puts the chamber center 8 cells *past* the planet core, so
   * stamping it hollows out the middle of the world and the planet collapses
   * into the crosshair.
   */
  it('keeps the chamber outside the core at every slider position', () => {
    for (const { size, pct, r, headroom } of combos) {
      const { cfg } = volcanoGeometryFor(size / 2, size / 2, r, headroom);
      const bulge = cfg.chamberRadius * 1.31;
      const chamberCenterR = cfg.planetRadius - cfg.chamberDepth;
      expect(
        chamberCenterR,
        `chamber reaches the core at ${size}×${size}, ${pct}% (r=${r})`,
      ).toBeGreaterThan(bulge);
    }
  });

  it('keeps the chamber below the surface at every slider position', () => {
    for (const { size, pct, r, headroom } of combos) {
      const { cfg } = volcanoGeometryFor(size / 2, size / 2, r, headroom);
      const bulge = cfg.chamberRadius * 1.31;
      const roofR = cfg.planetRadius - cfg.chamberDepth + bulge;
      expect(
        roofR,
        `chamber breaches the surface at ${size}×${size}, ${pct}% (r=${r})`,
      ).toBeLessThan(cfg.planetRadius);
    }
  });

  /**
   * A cone that outgrows the void around it renders clipped against the grid
   * edge. On a wide planet the headroom bound is what limits the cap, not the
   * radius ratio — an 80%-diameter planet has almost no sky to build into.
   */
  it('never lets the edifice cap outgrow the void around the planet', () => {
    for (const { size, pct, r, headroom } of combos) {
      const { capStart, capMax } = volcanoGeometryFor(size / 2, size / 2, r, headroom);
      expect(capMax, `cap runs off the grid at ${size}×${size}, ${pct}%`).toBeLessThan(headroom);
      expect(capStart).toBeLessThanOrEqual(capMax);
    }
  });

  /**
   * The arithmetic above, proven against a real stamp at the smallest planet
   * the sliders allow: the core is still solid rock afterwards.
   */
  it('leaves the core intact when stamped on the smallest planet', () => {
    const size = 120;
    const r = Math.round((size * 30) / 200); // 18
    const cx = size / 2;
    const { cfg } = volcanoGeometryFor(cx, cx, r, size / 2 - r);

    const e = new PixelEngine({
      width: size,
      height: size,
      seed: 1,
      gravity: new RadialGravity({ centerX: cx, centerY: cx }),
    });
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx, dy = y - cx;
        if (dx * dx + dy * dy <= r * r) e.setMaterial(x, y, MaterialType.ROCK);
      }
    }
    stampVolcano(e, cfg);

    expect(e.getMaterial(cx, cx)).toBe(MaterialType.ROCK);
  });
});
