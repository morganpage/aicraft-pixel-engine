import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../../src/sand';
import { MaterialType, Materials } from '../../src/materials';
import { RadialGravity, FlatGravity } from '../../src/gravity';
import {
  stampVolcano,
  syncFromHeat,
  remeltConduit,
  rechargeReservoir,
  craterLowPoint,
  assimilateTephra,
  stiffnessForTemp,
  summitRadius,
  surfaceRadiusAt,
  makeRng,
  volcanoGeometryFor,
  MAGMA_TEMP,
  TEMP_RAMP,
  TEMP_STEPS,
  TEPHRA_RAMP,
  TEPHRA_STEPS,
} from '../helpers/volcano';
import {
  DEFAULT_VOLCANO_CFG as CFG,
  VOLCANO_SIZE as SIZE,
  VOLCANO_CX as CX,
  VOLCANO_CY as CY,
  VOLCANO_R as R,
  buildVolcanoPlanet,
  countMaterial,
} from '../helpers/volcano-scenario';

/**
 * Fast volcano contracts.
 *
 * The behaviours pinned here are the ones that were each, at some point, the
 * reason the volcano did not look like a volcano: magma has to visibly ascend
 * and emerge at the vent, a flow has to run down the flank and *stop*, and the
 * cone has to be built by tephra rather than by ponded lava.
 *
 * This file holds only tiny-grid and pure-function tests — each runs in
 * milliseconds. The slow, multi-thousand-frame scenarios that exercise the same
 * code on the full 220×220 shipping planet live in `volcano.scenario.test.ts`,
 * which is excluded from the default `showcase:test` run.
 */

// The showcase's own geometry (SIZE 220, planetRadius = floor(220 * 0.3)).
// Shape assertions are only meaningful against the configuration that actually
// ships: the same angular spread on a smaller planet subtends a narrower cone,
// so a shrunken test planet quietly measures a steeper volcano than anyone will
// ever see.

/** Showcase defaults. */
const buildPlanet = (): PixelEngine => buildVolcanoPlanet(CFG, SIZE);

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

  it('stiffens lava monotonically as it cools, and only vent-fresh lava is free', () => {
    // A yield thickness of 1 means "free to move at any depth" — the criterion
    // can never be met by a single cell — so held there a flow thins without
    // limit into a half-occupied monolayer and freezes as a checkerboard of
    // specks. It is confined to a narrow window at the top of the range, which
    // in practice is the vent and a cell or two beyond it: an exposed film
    // loses roughly 0.08 per frame, so nothing stays above 0.85 for long.
    //
    // The window has to exist at all, though. With a floor of 2, a flow needed
    // two cells of depth before it could move *anywhere*, which is more than a
    // vent delivers onto a slope: the effusive phase ponded at the summit and
    // froze as a flat slab instead of running down the cone.
    let prev = 0;
    for (let t = 1; t >= 0; t -= 0.05) {
      const s = stiffnessForTemp(t);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s, `t=${t.toFixed(2)} must be depth-gated below vent heat`)
        .toBeGreaterThanOrEqual(t >= 0.85 ? 1 : 2);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
    expect(stiffnessForTemp(1)).toBeLessThan(stiffnessForTemp(0));
  });
});

describe('chunk-aware heat sync', () => {
  // The thermal-chunk mask is what lets a settled 1000×1000 planet cost nothing
  // in the host: syncFromHeat must scan only the chunks the heat step just
  // processed, and the colour/stiffness bookkeeping must be lazy and change-gated
  // so a cold planet allocates nothing and a stable lava cell isn't rewritten.

  it('updates hot cells inside an active thermal chunk and skips inactive ones', () => {
    const e = buildPlanet();
    // Two hot lava cells in DIFFERENT chunks (chunks are 32 wide; CX=110 is in
    // chunk 3, so a cell at x≈48 sits in chunk 1 — definitely a different chunk).
    const hotX = CX, hotY = CY - R - 1;       // surface cell above center
    const otherX = CX - 60, otherY = hotY;    // different chunk, same row band
    e.setMaterial(hotX, hotY, MaterialType.LAVA);
    e.setHeat(hotX, hotY, 1);
    e.setMaterial(otherX, otherY, MaterialType.LAVA);
    e.setHeat(otherX, otherY, 1);

    // Mask: only the chunk containing hotX,hotY is "processed". The other lava
    // cell, even though hot, must be left alone by this scoped sync.
    const cw = e.chunkWidth, cs = e.CHUNK_SIZE;
    const mask = new Uint8Array(cw * e.chunkHeight);
    mask[Math.floor(hotY / cs) * cw + Math.floor(hotX / cs)] = 1;
    expect(Math.floor(otherX / cs)).not.toBe(Math.floor(hotX / cs)); // sanity: truly different chunks

    syncFromHeat(e, mask);

    expect(e.colorGrid![hotY * SIZE + hotX]).toBe(TEMP_RAMP[TEMP_STEPS - 1]);
    // otherX,otherY is hot but outside the mask → no override written.
    expect(e.colorGrid![otherY * SIZE + otherX]).toBe(0);
  });

  it('falls back to a full scan when no mask is given', () => {
    const e = buildPlanet();
    e.setMaterial(CX, CY - R - 1, MaterialType.LAVA);
    e.setHeat(CX, CY - R - 1, 0.8);
    syncFromHeat(e); // null mask → full scan
    expect(e.colorGrid![(CY - R - 1) * SIZE + CX]).toBe(
      TEMP_RAMP[Math.round(0.8 * (TEMP_STEPS - 1))],
    );
  });

  it('does not allocate colorGrid on a planet with no hot cells', () => {
    const e = buildPlanet(); // cold bedrock disc, nothing heated
    expect(e.colorGrid).toBeNull();
    syncFromHeat(e, e.thermalChunks);
    expect(e.colorGrid).toBeNull();
    // Full scan either — a cold planet must not allocate just because we walked it.
    syncFromHeat(e);
    expect(e.colorGrid).toBeNull();
  });

  it('keeps a cooling cell synchronised until its thermal chunk goes quiet', () => {
    const e = buildPlanet();
    const x = CX, y = CY - R - 1;
    e.setMaterial(x, y, MaterialType.LAVA);
    e.setHeat(x, y, 0.9);

    // Frame 1: chunk active, hot cell gets styled.
    const cw = e.chunkWidth, cs = e.CHUNK_SIZE;
    const mask = new Uint8Array(cw * e.chunkHeight);
    mask[Math.floor(y / cs) * cw + Math.floor(x / cs)] = 1;
    syncFromHeat(e, mask);
    expect(e.colorGrid![y * SIZE + x]).not.toBe(0);

    // Cell cools but its chunk is still active → still resynced to the cooler tint.
    e.setHeat(x, y, 0.5);
    syncFromHeat(e, mask);
    expect(e.colorGrid![y * SIZE + x]).toBe(TEMP_RAMP[Math.round(0.5 * (TEMP_STEPS - 1))]);

    // Same cooler temperature, but now the chunk is quiet → the cell is no longer
    // touched. Its tint is frozen at the last value the active sync wrote.
    const lastTint = e.colorGrid![y * SIZE + x];
    const quiet = new Uint8Array(cw * e.chunkHeight); // all zero
    syncFromHeat(e, quiet);
    expect(e.colorGrid![y * SIZE + x]).toBe(lastTint);
  });

  it('resyncs a cell on the tick its stored temperature crosses a tint band', () => {
    // The engine stores every computed temperature but only WAKES a thermal
    // chunk above HEAT_EPSILON. The host styles the stored value, so a crossing
    // must be reflected on the exact tick the wake happens. This pins the
    // wake-threshold relationship: a future change to heat-sleep semantics cannot
    // silently leave a tint one band behind.
    const e = buildPlanet();
    const x = CX, y = CY - R - 1;
    e.setMaterial(x, y, MaterialType.LAVA);
    // Two adjacent ramp indices; find the temperature band boundary between them.
    const i0 = 10, i1 = 11;
    const tLow = (i0 + 0.4) / (TEMP_STEPS - 1);
    const tHigh = (i1 + 0.4) / (TEMP_STEPS - 1);

    e.setHeat(x, y, tLow);
    const cw = e.chunkWidth, cs = e.CHUNK_SIZE;
    const mask = new Uint8Array(cw * e.chunkHeight);
    mask[Math.floor(y / cs) * cw + Math.floor(x / cs)] = 1;
    syncFromHeat(e, mask);
    expect(e.colorGrid![y * SIZE + x]).toBe(TEMP_RAMP[i0]);

    e.setHeat(x, y, tHigh); // crosses into band i1
    syncFromHeat(e, mask);
    expect(e.colorGrid![y * SIZE + x]).toBe(TEMP_RAMP[i1]);
  });

  it('resyncs stiffness at every stiffnessForTemp tier boundary as lava cools', () => {
    const e = buildPlanet();
    const x = CX, y = CY - R - 1;
    e.setMaterial(x, y, MaterialType.LAVA);
    const cw = e.chunkWidth, cs = e.CHUNK_SIZE;
    const mask = new Uint8Array(cw * e.chunkHeight);
    mask[Math.floor(y / cs) * cw + Math.floor(x / cs)] = 1;

    // stiffnessForTemp boundaries: 0.85 / 0.60 / 0.45 / 0.32. Sample just above
    // and just below each so each tier is visited, and confirm the stiffness
    // written matches stiffnessForTemp exactly.
    for (const t of [0.9, 0.7, 0.5, 0.36, 0.2]) {
      e.setHeat(x, y, t);
      syncFromHeat(e, mask);
      expect(e.stiffnessGrid![y * SIZE + x]).toBe(stiffnessForTemp(t));
    }
  });

  it('treats colour 0 as the palette fallback and keeps opaque black as a valid tint', () => {
    // The sentinel is 0 = "no override, use palette". Opaque black packs to
    // 0xff000000 (nonzero), so it must be honoured rather than treated as unset.
    const e = buildPlanet();
    const x = CX, y = CY - R - 1;
    e.setMaterial(x, y, MaterialType.ROCK);
    e.setHeat(x, y, 0.7);
    // Manually place opaque black, then resync at a temperature that maps to a
    // different tint — the sync must overwrite it (proving 0xff000000 is a real
    // override, not skipped like the 0 sentinel).
    if (!e.colorGrid) e.colorGrid = new Uint32Array(SIZE * SIZE);
    e.colorGrid[y * SIZE + x] = 0xff000000;
    const expected = TEMP_RAMP[Math.round(0.7 * (TEMP_STEPS - 1))];
    syncFromHeat(e, null); // full scan so we don't need a mask
    expect(e.colorGrid[y * SIZE + x]).toBe(expected);
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
    const before = countMaterial(e, MaterialType.LAVA);
    for (let f = 0; f < 80; f++) { e.update(); rechargeReservoir(e, CFG); }
    // Magma reached the surface through the connected conduit. Some may have
    // fragmented to TEPHRA during flight, so count both products together.
    expect(countMaterial(e, MaterialType.LAVA) + countMaterial(e, MaterialType.TEPHRA)).toBeGreaterThan(before);
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
});

describe('cone profile', () => {
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

    const before = countMaterial(flat, MaterialType.LAVA) + countMaterial(flat, MaterialType.TEPHRA);
    assimilateTephra(flat, makeRng(1), { rate: 1 });
    const after = countMaterial(flat, MaterialType.LAVA) + countMaterial(flat, MaterialType.TEPHRA);

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
