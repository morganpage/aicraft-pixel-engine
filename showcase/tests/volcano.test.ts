import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../../src/sand';
import { MaterialType } from '../../src/materials';
import { RadialGravity, FlatGravity } from '../../src/gravity';
import {
  stampVolcano,
  emitPlume,
  coolLava,
  remeltConduit,
  assimilateTephra,
  pressurizeConduit,
  craterLowPoint,
  createVolcanoState,
  stepVolcanoPre,
  stepVolcanoPost,
  stiffnessForTemp,
  summitRadius,
  edificeHeight,
  surfaceRadiusAt,
  tempAt,
  setTemp,
  makeRng,
  volcanoGeometryFor,
  TEMP_RAMP,
  TEMP_STEPS,
  FREEZE_TEMP,
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
  plume: { perFrame: 8, spread: 0.36, loft: 5, lavaFraction: 0.05, maxHeight: 20, rimBias: 0.45 },
  pressure: { riseInterval: 1, effusion: 1, craterHalfAngle: 0.06, maxHeight: 22, breachFraction: 0.85 },
  cool: { rate: 0.12, insulatedFactor: 0.02 },
  assimilateRate: 0.5,
};

function buildPlanet(): PixelEngine {
  const e = new PixelEngine({
    width: SIZE, height: SIZE, seed: 1,
    gravity: new RadialGravity({ centerX: CX, centerY: CY }),
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
      if (m !== MaterialType.ROCK && m !== MaterialType.SAND && m !== MaterialType.LAVA) continue;
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

describe('temperature field', () => {
  it('round-trips a temperature through the colour ramp', () => {
    const e = buildPlanet();
    setTemp(e, 10, 10, 0.5);
    expect(tempAt(e, 10, 10)).toBeCloseTo(0.5, 1);
    setTemp(e, 11, 10, 1);
    expect(tempAt(e, 11, 10)).toBe(1);
  });

  it('reports -1 for cells carrying no ramp colour', () => {
    const e = buildPlanet();
    expect(tempAt(e, CX, CY)).toBe(-1); // plain bedrock
  });

  it('keeps the ramp disjoint from every possible tephra tint', () => {
    // Both live in the same colorGrid, and a cell is identified as hot by
    // looking its exact packed colour up in the ramp. An overlap would make a
    // tephra cell read as warm rock and be cooled as though it were lava.
    const ramp = new Set<number>(Array.from(TEMP_RAMP));
    for (let n = 0; n < 18; n++) {
      const r = 38 + n, g = 34 + n, b = 36 + n;
      const packed = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
      expect(ramp.has(packed)).toBe(false);
    }
    expect(ramp.size).toBe(TEMP_STEPS); // no duplicate steps either
  });

  it('renders solidified lava darker than the planet bedrock', () => {
    // Cold basalt has to be distinguishable from the ground it was poured over,
    // or an eruption's worth of new rock disappears into the planet.
    const cold = TEMP_RAMP[0];
    const r = cold & 0xff, g = (cold >>> 8) & 0xff, b = (cold >>> 16) & 0xff;
    expect(Math.max(r, g, b)).toBeLessThan(80); // ROCK palette is (80,80,80)
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
    const before = count(e, MaterialType.LAVA);
    for (let i = 0; i < 500; i++) e.update();
    expect(count(e, MaterialType.LAVA)).toBe(before);
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

  it('pushes magma up the bore and spills it into the crater', () => {
    // The stand-in for pressure: the column is advected upward and its head is
    // delivered to the surface, so magma visibly ascends and emerges.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const rng = makeRng(3);
    const before = count(e, MaterialType.LAVA);
    let spilled = 0;
    for (let f = 0; f < 40; f++) {
      spilled += pressurizeConduit(e, CFG, f, rng, OPTS.pressure);
      e.update();
    }
    expect(spilled).toBeGreaterThan(0);
    expect(count(e, MaterialType.LAVA)).toBeGreaterThan(before);
    // And the delivered magma is at the surface, not buried.
    expect(summitRadius(e, CFG)).toBeGreaterThan(R);
  });

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
    // Tephra is SAND (density 10) and lava is 8, so ejecta landing on the open
    // vent sinks *through* the magma column and fills the plumbing top-down.
    const e = erupt(1200);
    let lava = 0, tephra = 0;
    for (let r = R - CFG.chamberDepth - CFG.chamberRadius; r <= R; r++) {
      for (let w = -CFG.conduitHalfWidth; w <= CFG.conduitHalfWidth; w++) {
        const m = e.getMaterial(Math.round(CX + w), Math.round(CY - r));
        if (m === MaterialType.LAVA) lava++;
        else if (m === MaterialType.SAND) tephra++;
      }
    }
    expect(tephra).toBe(0);
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
  it('sets exposed lava to rock but leaves buried lava molten', () => {
    // Both halves matter: without cooling nothing solidifies at all, and if
    // buried lava cooled too the conduit would freeze solid and plug itself.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const rng = makeRng(7);
    for (let i = 0; i < 400; i++) { e.update(); coolLava(e, rng, OPTS.cool); }
    const deepY = Math.round(CY - (R - 15));
    expect(e.getMaterial(Math.round(CX), deepY)).toBe(MaterialType.LAVA);
    // The exposed cap at the vent has set.
    expect(e.getMaterial(CX, CY - R - 1)).not.toBe(MaterialType.LAVA);
  });

  it('cools by degrees rather than a per-cell coin flip', () => {
    // Gradual decay is what keeps a flow's cells within a step or two of their
    // neighbours. A freeze roll put adjacent cells at opposite ends of the
    // palette and made the cone look like pepper stirred through gravel.
    const e = buildPlanet();
    // A bar of lava resting on the bedrock, all at the same starting heat.
    for (let x = CX - 8; x <= CX + 8; x++) {
      e.setMaterial(x, CY - R - 1, MaterialType.LAVA);
      setTemp(e, x, CY - R - 1, 1);
    }
    const rng = makeRng(5);
    for (let i = 0; i < 6; i++) coolLava(e, rng, OPTS.cool);
    const temps: number[] = [];
    for (let x = CX - 8; x <= CX + 8; x++) {
      const t = tempAt(e, x, CY - R - 1);
      if (t >= 0) temps.push(t);
    }
    expect(temps.length).toBeGreaterThan(10);
    // All still molten — nothing has jumped straight to rock.
    expect(Math.min(...temps)).toBeGreaterThan(FREEZE_TEMP);
    // The claim that matters visually is *local*: adjacent cells of one flow
    // stay within a step or two of each other, so the flow reads as one body.
    // A per-cell freeze roll instead lands neighbours at opposite ends of the
    // palette — molten orange beside cold grey — which is the salt-and-pepper
    // look. Asserting on the neighbour gap tests that directly, and unlike a
    // bound on the overall range it does not drift when the cooling rate does.
    let maxJump = 0;
    for (let i = 1; i < temps.length; i++) maxJump = Math.max(maxJump, Math.abs(temps[i] - temps[i - 1]));
    expect(maxJump).toBeLessThan(0.2);
  });

  it('does not leave frozen ejecta hanging in mid-air', () => {
    // Ejecta is spawned in mid-air and the engine has no velocity, so a cell in
    // flight is a lone airborne cell — maximum exposure by the cooling rule, and
    // therefore the likeliest thing to freeze, before it has landed. Frozen lava
    // is ROCK, a static solid that never falls, so it would hang in the sky.
    const e = erupt(900);
    const solid = (m: MaterialType): boolean =>
      m === MaterialType.ROCK || m === MaterialType.SAND || m === MaterialType.LAVA;
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

    expect(peak).toBeGreaterThan(10);
    // Granular repose in this engine is steeper than a real cone's ~30°, but it
    // must be nothing like the near-vertical wall a uniform slab ends in.
    expect(meanFlank).toBeLessThan(45);
    expect(meanFlank).toBeGreaterThan(15); // and not a puddle either
  }, 30_000);

  it('keeps a crater without letting it become a chasm', () => {
    // `rimBias` centres fallout on the rim so the summit gets a crater. It has
    // to taper *inward* as well as outward: as a hard edge that nothing lands
    // inside, the crater floor never rises while the rim climbs, and the profile
    // ends up as two separate peaks with a canyon between them.
    const e = erupt(2600);
    const hs = heightProfile(e);
    const peak = Math.max(...hs);
    const axis = hs[50]; // the vent axis
    const crater = peak - axis;
    expect(crater).toBeGreaterThan(0);        // there is a crater
    expect(crater).toBeLessThan(peak * 0.75); // but the floor rises with the cone
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
  it('cycles explosive → effusive → repose', () => {
    // Real stratovolcanoes alternate, and the interleaved strata are what build
    // the cone. Running both at once averages them into a uniform grey mound.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const st = createVolcanoState();
    const rng = makeRng(1);
    const seen: string[] = [];
    expect(st.phase).toBe('explosive'); // opens with a burst
    for (let f = 0; f < 1400; f++) {
      if (seen[seen.length - 1] !== st.phase) seen.push(st.phase);
      stepVolcanoPre(e, CFG, st, rng, OPTS);
      e.update();
      stepVolcanoPost(e, CFG, st, rng, OPTS);
    }
    expect(seen.slice(0, 4)).toEqual(['explosive', 'effusive', 'repose', 'explosive']);
    expect(st.cycle).toBeGreaterThan(0);
  }, 20_000);

  it('builds a steep cone, not a flat shield or a mesa', () => {
    // Shape regression. The cone's taper comes from granular tephra piling at its
    // angle of repose; lava ponds level out and freeze with cliff edges, so a
    // lava-built edifice is a flat-topped mesa.
    const e = erupt(2400);
    const built = edifice(e);
    expect(built.height).toBeGreaterThan(10);
    // Slope = half-width : height. Lower is steeper; a shield was ~5.7.
    expect(built.halfWidth / built.height).toBeLessThan(2.8);
    // The cap must actually bound the growth.
    expect(built.height).toBeLessThan(OPTS.pressure.maxHeight + 10);
  }, 30_000);

  it('runs lava down the flanks without drowning the planet', () => {
    // The behaviour the whole yield-strength term exists for: a flow that
    // travels a bounded distance downslope and stops. Too little and the lava
    // never leaves the crater; too much and it wraps the planet as an ocean.
    const e = erupt(2400);
    const built = edifice(e);
    // Lava reached well beyond the summit...
    expect(built.spreadDeg).toBeGreaterThan(12);
    // ...but nothing like the 180° an unbounded liquid reached.
    expect(built.spreadDeg).toBeLessThan(110);
    // And the edifice is mostly solid, not a molten blob.
    const lava = count(e, MaterialType.LAVA);
    expect(lava).toBeLessThan(built.cells * 0.5);
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
    // Tap off: keep cooling so the remaining flows set, then let it rest.
    for (let f = 0; f < 1500; f++) { e.update(); coolLava(e, rng, OPTS.cool); }
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
    flat.setMaterial(6, 6, MaterialType.SAND);
    if (!flat.colorGrid) flat.colorGrid = new Uint32Array(12 * 12);
    flat.colorGrid[6 * 12 + 6] = 0xff242428; // dark basalt tint, nonzero

    const before = count(flat, MaterialType.LAVA) + count(flat, MaterialType.SAND);
    assimilateTephra(flat, makeRng(1), { rate: 1 });
    const after = count(flat, MaterialType.LAVA) + count(flat, MaterialType.SAND);

    expect(flat.getMaterial(6, 6)).toBe(MaterialType.LAVA);
    expect(after).toBe(before); // 1:1 conserved
    // The tint is replaced by a ramp colour, so it renders molten, not grey.
    expect(tempAt(flat, 6, 6)).toBeCloseTo(MAGMA_TEMP, 1);
  });

  it('leaves mere flank contact untouched', () => {
    // The threshold gate: tephra touching lava on only one side — the cone's
    // flank against a thin surface flow — is NOT embedded, so it must survive.
    // This is what keeps the structural cone from being eaten.
    const flat = new PixelEngine({ width: 12, height: 12, seed: 1, gravity: new FlatGravity() });
    flat.setMaterial(6, 5, MaterialType.LAVA);
    flat.setMaterial(6, 6, MaterialType.SAND);
    flat.setMaterial(6, 7, MaterialType.SAND);
    assimilateTephra(flat, makeRng(1), { rate: 1 });
    expect(flat.getMaterial(6, 6)).toBe(MaterialType.SAND);
    expect(flat.getMaterial(6, 7)).toBe(MaterialType.SAND);
  });

  it('does not collapse the cone', () => {
    // End-to-end guard for the runaway the threshold prevents.
    const e = erupt(2400);
    expect(count(e, MaterialType.SAND)).toBeGreaterThan(50);
    expect(edifice(e).halfWidth / edifice(e).height).toBeLessThan(2.8);
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
    for (let f = 0; f < 600; f++) {
      emitPlume(e, CFG, rng, OPTS.plume);
      e.update();
      remeltConduit(e, CFG);
      coolLava(e, rng, OPTS.cool);
    }
    const axis = surfaceRadiusAt(e, CFG, CFG.ventAngle);
    const rimL = surfaceRadiusAt(e, CFG, CFG.ventAngle - OPTS.plume.spread * 0.8);
    const rimR = surfaceRadiusAt(e, CFG, CFG.ventAngle + OPTS.plume.spread * 0.8);
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
