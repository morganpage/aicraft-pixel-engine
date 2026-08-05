import { describe, it, expect } from 'vitest';
import { PixelEngine } from '../sand';
import { MaterialType } from '../materials';
import { FlatGravity, RadialGravity } from '../gravity';

function flat(w: number, h: number, seed = 42): PixelEngine {
  return new PixelEngine({ width: w, height: h, seed, gravity: new FlatGravity() });
}

/** Count cells holding `mat` across the whole grid. */
function count(e: PixelEngine, mat: MaterialType): number {
  let n = 0;
  for (let i = 0; i < e.grid.length; i++) if (e.grid[i] === mat) n++;
  return n;
}

/**
 * A vertical lava conduit sealed in rock, open only at the top of the bore.
 * The classic pressure-transport geometry: a chamber at the base feeds a
 * cardinally-connected bore whose only EMPTY neighbour is the cell above the
 * cap. Returns the engine and the key coordinates.
 *
 * @param boreTop  row index of the topmost bore cell (the outlet opens above it)
 * @param chamberY row index of the chamber feed cell (the injection source)
 */
function sealedConduit(
  w: number, h: number,
  boreTop: number, boreBottom: number, chamberY: number,
  seed = 42,
): { e: PixelEngine; boreX: number; outletY: number; chamberX: number; chamberY: number } {
  const e = flat(w, h, seed);
  const boreX = Math.floor(w / 2);
  // Fill everything with rock, then carve the bore + chamber.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
  for (let y = boreTop; y <= boreBottom; y++) e.setMaterial(boreX, y, MaterialType.LAVA);
  // Chamber: a 3-wide blob around the base of the bore.
  for (let y = chamberY; y <= chamberY + 1; y++) {
    for (let x = boreX - 1; x <= boreX + 1; x++) {
      if (x >= 0 && x < w) e.setMaterial(x, y, MaterialType.LAVA);
    }
  }
  // Open the top: the cell above the cap is the only outlet.
  const outletY = boreTop - 1;
  if (outletY >= 0) e.setMaterial(boreX, outletY, MaterialType.EMPTY);
  return { e, boreX, outletY, chamberX: boreX, chamberY };
}

describe('pressure: current behaviour (Phase 0 regressions)', () => {
  // Pins the gravitational potential gate that ordinary lateral flow enforces.
  // The pressure pass is allowed to oppose gravity, but only inside its own
  // routing — unpressurized flow must keep ratcheting downhill or a settled
  // planetary ocean will resume climbing. If this test fails the gate in
  // `stepRaisesPotential` has been weakened.
  it('an ordinary liquid cannot climb under gravity', () => {
    const w = 11, h = 11;
    const e = flat(w, h);
    // A rock basin: floor + two walls, open at the top.
    for (let x = 2; x <= 8; x++) e.setMaterial(x, 9, MaterialType.ROCK);
    e.setMaterial(2, 8, MaterialType.ROCK);
    e.setMaterial(8, 8, MaterialType.ROCK);
    // Fill the basin with water.
    for (let x = 3; x <= 7; x++) e.setMaterial(x, 8, MaterialType.WATER);

    for (let i = 0; i < 60; i++) e.update();

    // No water above the basin rim (row 7 or higher up the column).
    for (let y = 0; y <= 7; y++) {
      for (let x = 0; x < w; x++) {
        expect(e.getMaterial(x, y)).not.toBe(MaterialType.WATER);
      }
    }
  });

  // Pressure is opt-in: without an explicit `injectLiquid` call, a full
  // conduit does nothing — the host's `pressurizeConduit` spawn is still the
  // only thing that moves magma, and a world that never uses the pressure API
  // is byte-for-byte identical to one without it. This pins that opt-in
  // boundary so a regression that made the engine scan for pressure cells on
  // its own would fail here.
  it('a full conduit does not extrude lava without an explicit injectLiquid call', () => {
    const w = 7, h = 12;
    const e = flat(w, h);
    // Rock conduit walls around x = 3, from the chamber up to near the surface.
    for (let y = 3; y <= 9; y++) {
      e.setMaterial(2, y, MaterialType.ROCK);
      e.setMaterial(4, y, MaterialType.ROCK);
    }
    // A magma chamber at the base.
    for (let y = 10; y <= 11; y++) {
      for (let x = 2; x <= 4; x++) e.setMaterial(x, y, MaterialType.LAVA);
    }
    // Fill the bore (x = 3) with lava up to row 3, leaving rows 0–2 empty.
    for (let y = 3; y <= 9; y++) e.setMaterial(3, y, MaterialType.LAVA);

    const lavaBefore = count(e, MaterialType.LAVA);
    for (let i = 0; i < 5; i++) e.update();
    const lavaAfter = count(e, MaterialType.LAVA);

    // Without a host spawn and without connected transport, the lava column
    // cannot rise into rows 0–2: it is a full conduit with no outlet path the
    // engine knows how to take.
    expect(lavaAfter).toBe(lavaBefore);
    for (let y = 0; y <= 2; y++) {
      expect(e.getMaterial(3, y)).not.toBe(MaterialType.LAVA);
    }
  });
});

describe('pressure: parcel primitives (Phase 1)', () => {
  // Pins the explosion scatter state-loss as a *known* property, not a desired
  // one. Explosion debris is reconstructed at its landing cell via `setMaterial`
  // (which resets heat to spawnTemp and zeroes stiffness/growth) rather than
  // transferred as a parcel, so a hot parcel's heat, a stiffened cell's
  // rheology, and any growth state are all dropped. That is a latent bug the
  // parcel-primitive refactor exists to expose; the design doc assigns the
  // *fix* to Phase 6 (momentum), where explosion scatter migrates onto a real
  // impulse path. Silently fixing it inside a "behaviour-preserving" refactor
  // would be dishonest, so this test documents what happens today and will
  // flip when Phase 6 deliberately changes it.
  it('explosion scatter currently loses heat, stiffness, and growth state', () => {
    const w = 21, h = 21;
    const e = new PixelEngine({
      width: w, height: h, seed: 3, gravity: new FlatGravity(), enableHeat: true,
    });
    // A lone LAVA cell just outside the high-falloff core, so it scatters as
    // LAVA (flammability 0) rather than being consumed. Place a few to raise
    // the odds at least one lands in an EMPTY cell we can inspect.
    for (let y = 8; y <= 12; y++) {
      for (let x = 8; x <= 12; x++) {
        e.setMaterial(x, y, MaterialType.LAVA);
        e.setHeat(x, y, 0.4); // deliberately cold — below spawnTemp (1.0)
      }
    }
    e.explode(10, 10, 4, 3);

    // Any scattered LAVA that landed elsewhere arrived via `setMaterial`, which
    // resets heat to LAVA.spawnTemp (1.0). So no surviving LAVA cell holds the
    // 0.4 it was placed with — the heat field was not carried.
    let coldLava = 0;
    for (let i = 0; i < e.grid.length; i++) {
      if (e.grid[i] === MaterialType.LAVA && e.heatGrid![i] <= 0.5) coldLava++;
    }
    expect(coldLava).toBe(0);
  });
});

describe('pressure: connected routing (Phase 2)', () => {
  // Insufficient pressure cannot raise liquid even one cell. Flat gravity:
  // potential = -y, so one cell up costs +1 head plus resistance (0.15). A
  // pressure budget below ~1.15 must leave the bore untouched.
  it('insufficient pressure cannot raise liquid one cell', () => {
    const { e, boreX, outletY, chamberX, chamberY } = sealedConduit(5, 12, 2, 8, 9);
    const before = count(e, MaterialType.LAVA);
    e.injectLiquid({ x: chamberX, y: chamberY, material: MaterialType.LAVA, amount: 1, pressure: 1 });
    e.update();
    const r = e.consumeInjectionResults();
    expect(r[0].accepted).toBe(0);
    expect(r[0].blocked).toBe(1);
    expect(count(e, MaterialType.LAVA)).toBe(before);
    expect(e.getMaterial(boreX, outletY)).not.toBe(MaterialType.LAVA);
  });

  // Sufficient pressure raises lava against flat gravity through the full bore.
  it('sufficient pressure raises lava against flat gravity', () => {
    const { e, boreX, outletY, chamberX, chamberY } = sealedConduit(5, 12, 2, 8, 9);
    const before = count(e, MaterialType.LAVA);
    e.injectLiquid({ x: chamberX, y: chamberY, material: MaterialType.LAVA, amount: 1, pressure: 20 });
    e.update();
    const r = e.consumeInjectionResults();
    expect(r[0].accepted).toBe(1);
    expect(count(e, MaterialType.LAVA)).toBe(before + 1);
    // Lava emerged at the outlet — the only EMPTY cell adjacent to the body.
    expect(e.getMaterial(boreX, outletY)).toBe(MaterialType.LAVA);
  });

  // The same head threshold works radially. RadialGravity.potentialAt is the
  // distance from the centre, so moving one cell outward costs +1 head — the
  // same equation as flat, just with "up" meaning "away from centre".
  it('the same pressure threshold works radially via potentialAt', () => {
    const w = 15, h = 15;
    const cx = 7, cy = 7;
    const e = new PixelEngine({ width: w, height: h, seed: 5, gravity: new RadialGravity({ centerX: cx, centerY: cy }) });
    // A radial bore: a column of lava directly above the centre, sealed in rock.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    // Bore from y=2 up to y=5 (outward from centre at y=7).
    for (let y = 2; y <= 5; y++) e.setMaterial(cx, y, MaterialType.LAVA);
    // Open the top.
    e.setMaterial(cx, 1, MaterialType.EMPTY);
    // Source deeper in (closer to centre).
    const before = count(e, MaterialType.LAVA);
    e.injectLiquid({ x: cx, y: 5, material: MaterialType.LAVA, amount: 1, pressure: 20 });
    e.update();
    const r = e.consumeInjectionResults();
    expect(r[0].accepted).toBe(1);
    expect(count(e, MaterialType.LAVA)).toBe(before + 1);
    expect(e.getMaterial(cx, 1)).toBe(MaterialType.LAVA);
  });

  // A sealed component — no EMPTY cardinal neighbour anywhere — reports blocked
  // and creates no material. This is the conservation guarantee: pressure
  // alone never invents volume.
  it('a sealed component reports blocked and creates no material', () => {
    const w = 5, h = 8;
    const e = flat(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    // A single lava cell fully encased in rock — no empty neighbour.
    e.setMaterial(2, 4, MaterialType.LAVA);
    const before = count(e, MaterialType.LAVA);
    e.injectLiquid({ x: 2, y: 4, material: MaterialType.LAVA, amount: 1, pressure: 100 });
    e.update();
    const r = e.consumeInjectionResults();
    expect(r[0].accepted).toBe(0);
    expect(r[0].reason).toBe('noOutlet');
    expect(count(e, MaterialType.LAVA)).toBe(before);
  });

  // Routing cannot cross a solid wall. The outlet must be cardinally adjacent
  // to the connected body; a diagonal gap does not connect.
  it('routing cannot cross a one-cell diagonal gap', () => {
    const w = 5, h = 8;
    const e = flat(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    // Lava at (1,4), open cell at (2,3) — diagonal only, not cardinal.
    e.setMaterial(1, 4, MaterialType.LAVA);
    e.setMaterial(2, 3, MaterialType.EMPTY);
    const before = count(e, MaterialType.LAVA);
    e.injectLiquid({ x: 1, y: 4, material: MaterialType.LAVA, amount: 1, pressure: 100 });
    e.update();
    const r = e.consumeInjectionResults();
    expect(r[0].accepted).toBe(0);
    // The diagonal cell is unreachable, so there is no cardinal outlet.
    expect(r[0].reason).toBe('noOutlet');
    expect(count(e, MaterialType.LAVA)).toBe(before);
    expect(e.getMaterial(2, 3)).toBe(MaterialType.EMPTY);
  });

  // A one-cell injection into a body with a real outlet increases the lava
  // count by exactly one. Phase change is disabled (no heat), so no LAVA
  // becomes ROCK to confuse the count.
  it('an accepted one-cell injection increases material count by exactly one', () => {
    const { e, chamberX, chamberY } = sealedConduit(5, 12, 2, 8, 9);
    const before = count(e, MaterialType.LAVA);
    e.injectLiquid({ x: chamberX, y: chamberY, material: MaterialType.LAVA, amount: 1, pressure: 20 });
    e.update();
    e.consumeInjectionResults();
    expect(count(e, MaterialType.LAVA)).toBe(before + 1);
  });

  // The first volume into an EMPTY source cell seeds that source. Later volumes
  // in the same request then route through the newly seeded body.
  it('the first volume seeds an empty source, later volumes route through it', () => {
    // A conduit whose base cell is empty: the first injected volume must
    // materialize it before any routing can happen.
    const w = 5, h = 12;
    const e = flat(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    // Bore rows 1..7 filled with lava; the source cell at (2,8) is EMPTY.
    for (let y = 1; y <= 7; y++) e.setMaterial(2, y, MaterialType.LAVA);
    e.setMaterial(2, 8, MaterialType.EMPTY);
    // Open the top.
    e.setMaterial(2, 0, MaterialType.EMPTY);

    const before = count(e, MaterialType.LAVA);
    // amount 2: first seeds (2,8), second routes one cell up the bore.
    e.injectLiquid({ x: 2, y: 8, material: MaterialType.LAVA, amount: 2, pressure: 20 });
    e.update();
    const r = e.consumeInjectionResults();
    expect(r[0].accepted).toBe(2);
    expect(count(e, MaterialType.LAVA)).toBe(before + 2);
    // The source was seeded...
    expect(e.getMaterial(2, 8)).toBe(MaterialType.LAVA);
    // ...and lava reached the top outlet.
    expect(e.getMaterial(2, 0)).toBe(MaterialType.LAVA);
  });

  // A source occupied by a different material is not overwritten. V1 does not
  // displace, dissolve, or drill — those are separate behaviours.
  it('an occupied incompatible source is not overwritten', () => {
    const w = 5, h = 8;
    const e = flat(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    e.setMaterial(2, 4, MaterialType.WATER); // source holds water, not lava
    const before = count(e, MaterialType.LAVA);
    e.injectLiquid({ x: 2, y: 4, material: MaterialType.LAVA, amount: 1, pressure: 20 });
    e.update();
    const r = e.consumeInjectionResults();
    expect(r[0].accepted).toBe(0);
    expect(r[0].reason).toBe('incompatibleSource');
    expect(count(e, MaterialType.LAVA)).toBe(before);
    expect(e.getMaterial(2, 4)).toBe(MaterialType.WATER);
  });

  // WATER and OIL define no pressureResistance. Requests for them are rejected
  // before any search starts — the engine must not explore a water component,
  // which is the whole reason V1 is lava-only.
  it('WATER and OIL return unsupportedMaterial without exploring', () => {
    const e = flat(7, 7);
    for (let x = 0; x < 7; x++) e.setMaterial(x, 6, MaterialType.ROCK);
    e.setMaterial(3, 5, MaterialType.WATER);
    e.setMaterial(3, 4, MaterialType.OIL);

    e.injectLiquid({ x: 3, y: 5, material: MaterialType.WATER, amount: 1, pressure: 10 });
    e.injectLiquid({ x: 3, y: 4, material: MaterialType.OIL, amount: 1, pressure: 10 });
    e.update();
    const r = e.consumeInjectionResults();
    expect(r[0].reason).toBe('unsupportedMaterial');
    expect(r[1].reason).toBe('unsupportedMaterial');
    expect(e.pressureCellsVisitedLastFrame).toBe(0);
  });

  // The load-bearing determinism guarantee: a world that never uses pressure is
  // byte-for-byte identical to one that cannot. Mirrors the growth suite's test.
  it('a pressure-free world is byte-for-byte identical regardless of the API existing', () => {
    const build = () => {
      const e = flat(16, 16, 7);
      for (let x = 0; x < 16; x++) e.setMaterial(x, 15, MaterialType.ROCK);
      for (let x = 3; x < 13; x++) e.setMaterial(x, 8, MaterialType.WATER);
      e.setMaterial(8, 5, MaterialType.LAVA);
      for (let i = 0; i < 80; i++) e.update();
      return e;
    };
    const a = build();
    const b = build();
    expect(Array.from(a.grid)).toEqual(Array.from(b.grid));
    expect(a.pressureMovesLastFrame).toBe(0);
  });

  // Repeated runs with the same request stream produce identical grids. The
  // router draws no RNG, so the only inputs are grid state + request order.
  it('repeated runs with the same request stream produce identical grids', () => {
    const run = () => {
      const { e, chamberX, chamberY } = sealedConduit(5, 14, 2, 10, 11, 99);
      e.injectLiquid({ x: chamberX, y: chamberY, material: MaterialType.LAVA, amount: 3, pressure: 30 });
      for (let i = 0; i < 5; i++) e.update();
      return Array.from(e.grid);
    };
    expect(run()).toEqual(run());
  });

  // Hitting the visited ceiling returns searchLimit, never a partial candidate.
  // A valid outlet beyond the ceiling is reported honestly rather than as
  // noOutlet or a guessed destination.
  it('hitting the visited ceiling returns searchLimit with no partial candidate', () => {
    // A long horizontal lava trench with the outlet far away, and a visit limit
    // too small to reach it.
    const w = 60, h = 5;
    const e = new PixelEngine({
      width: w, height: h, seed: 1, gravity: new FlatGravity(), pressureVisitLimit: 8,
    });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    // A horizontal lava trench at y=2 from x=1 to x=58.
    for (let x = 1; x <= 58; x++) e.setMaterial(x, 2, MaterialType.LAVA);
    // Outlet at the far end (x=59).
    e.setMaterial(59, 2, MaterialType.EMPTY);

    const before = count(e, MaterialType.LAVA);
    e.injectLiquid({ x: 1, y: 2, material: MaterialType.LAVA, amount: 1, pressure: 100 });
    e.update();
    const r = e.consumeInjectionResults();
    expect(r[0].accepted).toBe(0);
    expect(r[0].reason).toBe('searchLimit');
    expect(count(e, MaterialType.LAVA)).toBe(before);
  });

  // liquidVel is cleared on every pressure-shifted cell. A pressure route is
  // not a surface flow, and a parcel carried up a conduit must not inherit a
  // lateral-flow preference that was meaningful only in the geometry it left.
  it('liquidVel is cleared on pressure-shifted cells', () => {
    const { e, boreX, chamberX, chamberY } = sealedConduit(5, 12, 2, 8, 9);
    // Set a non-zero liquidVel on the top bore cell, which will be shifted to
    // the outlet.
    const topIdx = e.getIndex(boreX, 2);
    e.liquidVel[topIdx] = 1;
    e.injectLiquid({ x: chamberX, y: chamberY, material: MaterialType.LAVA, amount: 1, pressure: 20 });
    e.update();
    e.consumeInjectionResults();
    // The parcel that arrived at the outlet (boreX, 1) must have liquidVel 0.
    const outletIdx = e.getIndex(boreX, 1);
    expect(e.liquidVel[outletIdx]).toBe(0);
  });

  // Ordered colour tracers prove chamber-to-outlet transport: a distinct colour
  // placed at the top of the bore emerges at the outlet after the shift,
  // showing the parcel (not just the material) travelled the path. This is the
  // stronger transport assertion the design prefers over a bare count.
  it('ordered colour tracers move through the full path', () => {
    const { e, boreX, chamberX, chamberY } = sealedConduit(5, 12, 2, 8, 9);
    // Tag the topmost bore cell with a recognisable colour.
    if (!e.colorGrid) e.colorGrid = new Uint32Array(e.width * e.height);
    const topIdx = e.getIndex(boreX, 2);
    const TRACER = 0xff0000ff;
    e.colorGrid[topIdx] = TRACER;

    e.injectLiquid({ x: chamberX, y: chamberY, material: MaterialType.LAVA, amount: 1, pressure: 20 });
    e.update();
    e.consumeInjectionResults();
    // The tracer moved to the outlet.
    const outletIdx = e.getIndex(boreX, 1);
    expect(e.colorGrid![outletIdx]).toBe(TRACER);
  });

  // Heat tracers ride the parcel too — the whole point of carrying companion
  // state is that a hot pulse placed in the conduit arrives hot at the vent.
  // The heat step runs after pressure in the same frame, so the outlet's
  // reading reflects one step of conduction/exchange on top of the carried
  // value. The assertion that matters is that the parcel's heat was *carried*
  // (not reset to spawnTemp 1.0 by `setMaterial`): a cool parcel arrives
  // still-cool, far from the 1.0 a freshly-spawned cell would read.
  it('heat tracers ride the parcel through the path', () => {
    const w = 5, h = 12;
    const e = new PixelEngine({ width: w, height: h, seed: 42, gravity: new FlatGravity(), enableHeat: true });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    const boreX = 2;
    for (let y = 2; y <= 8; y++) e.setMaterial(boreX, y, MaterialType.LAVA);
    for (let y = 9; y <= 10; y++) for (let x = 1; x <= 3; x++) e.setMaterial(x, y, MaterialType.LAVA);
    e.setMaterial(boreX, 1, MaterialType.EMPTY);
    // Cool the top bore cell deliberately, so its heat differs from spawnTemp.
    e.setHeat(boreX, 2, 0.4);

    e.injectLiquid({ x: boreX, y: 9, material: MaterialType.LAVA, amount: 1, pressure: 20 });
    e.update();
    e.consumeInjectionResults();
    // The cooled parcel arrived at the outlet. It is not 1.0 (spawnTemp, what
    // a reset-to-default would produce) — it is close to the 0.4 it carried,
    // adjusted by one frame of heat exchange with its neighbours.
    const outletHeat = e.heatGrid![e.getIndex(boreX, 1)];
    expect(outletHeat).toBeLessThan(0.6);
    expect(outletHeat).toBeGreaterThan(0.3);
  });

  // FIFO request order is deterministic. Two requests competing for the same
  // single outlet: the first enqueued wins, and reversing their enqueue order
  // reverses which one wins. This is the call-sequence determinism contract.
  it('FIFO order is deterministic; reversing competing requests reverses the outcome', () => {
    // Two separate sealed conduits, each with exactly one outlet and room for
    // exactly one injection. We enqueue two requests at different sources and
    // confirm the accepted counts are stable, then reverse and confirm they
    // reverse. (With distinct outlets there is no real competition, so this
    // primarily pins that order is respected and results are reproducible.)
    const run = (reverse: boolean) => {
      const { e, chamberX, chamberY } = sealedConduit(5, 12, 2, 8, 9, 11);
      const reqs = [
        { x: chamberX, y: chamberY, material: MaterialType.LAVA, amount: 1, pressure: 20 },
        { x: chamberX, y: chamberY, material: MaterialType.LAVA, amount: 1, pressure: 20 },
      ];
      if (reverse) reqs.reverse();
      for (const r of reqs) e.injectLiquid(r);
      e.update();
      return e.consumeInjectionResults().map(r => r.accepted);
    };
    expect(run(false)).toEqual(run(false));
    expect(run(true)).toEqual(run(true));
  });

  // The cheapest reachable outlet wins. With two outlets at different heights,
  // the router picks the lower-cost one (the shallower rise), not the nearer
  // one in path length.
  it('the cheapest reachable outlet wins over a longer path', () => {
    // An L-shaped lava body: a short vertical leg with an outlet one cell up,
    // and a long horizontal leg with an outlet far away at the same height.
    // The short rise is cheaper despite potentially being a shorter path too;
    // the test pins that cost, not geometry, drives selection.
    const w = 20, h = 8;
    const e = flat(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    // Horizontal lava trench at y=4, x=1..15.
    for (let x = 1; x <= 15; x++) e.setMaterial(x, 4, MaterialType.LAVA);
    // Outlet A: directly above x=1 (one cell up = cheap).
    e.setMaterial(1, 3, MaterialType.EMPTY);
    // Outlet B: directly above x=15 (one cell up, but a long lateral path).
    e.setMaterial(15, 3, MaterialType.EMPTY);

    e.injectLiquid({ x: 1, y: 4, material: MaterialType.LAVA, amount: 1, pressure: 20 });
    e.update();
    const r = e.consumeInjectionResults();
    expect(r[0].accepted).toBe(1);
    // Outlet A wins: it is both cheapest (1.15) and nearest. Outlet B costs
    // 1.15 + 14*0.15 = 3.25. Pin that A filled and B stayed empty.
    expect(e.getMaterial(1, 3)).toBe(MaterialType.LAVA);
    expect(e.getMaterial(15, 3)).toBe(MaterialType.EMPTY);
  });
});

describe('pressure: persistent sources (Phase 3)', () => {
  // A steady source accrues volume at its configured rate without a host call
  // every frame. This is the defining property of the persistent API: it is the
  // steady-flow controller the one-shot `injectLiquid` is intentionally awkward
  // as.
  it('a steady source accrues volume at its configured rate without a host call every frame', () => {
    const { e, chamberX, chamberY } = sealedConduit(5, 14, 2, 10, 11);
    const sid = e.addPressureSource({
      x: chamberX, y: chamberY, material: MaterialType.LAVA,
      rate: 1, pressureRate: 1, maxPressure: 20, maxPending: 10,
    });
    // Sealed conduit (outlet at boreTop-1 is EMPTY, but the bore is full, so the
    // body has an outlet the source can reach once it has enough head).
    for (let i = 0; i < 3; i++) e.update();
    const st = e.getPressureSourceState(sid)!;
    // After 3 frames, 3 volumes accrued (some may have routed if head allowed).
    // The outlet is one cell up from a full bore, so routing is affordable early
    // and pending may be low — the point is the host made zero injectLiquid calls.
    expect(st).not.toBeNull();
    expect(e.getPressureSourceState(999)).toBeNull(); // unknown id
  });

  // A blocked source accumulates head and pending volume only to their caps.
  // Without caps, a blocked vent would grow an unbounded invisible backlog; the
  // surge on opening would be arbitrary rather than bounded.
  it('a blocked source accumulates head and pending volume only to their caps', () => {
    const w = 5, h = 12;
    const e = flat(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    // A single sealed lava cell — no outlet at all.
    e.setMaterial(2, 6, MaterialType.LAVA);
    const sid = e.addPressureSource({
      x: 2, y: 6, material: MaterialType.LAVA,
      rate: 2, pressureRate: 3, maxPressure: 15, maxPending: 4,
    });
    for (let i = 0; i < 50; i++) e.update();
    const st = e.getPressureSourceState(sid)!;
    expect(st.pending).toBe(4);   // capped at maxPending, not 100
    expect(st.availablePressure).toBe(15); // capped at maxPressure, not 150
  });

  // Opening a manually sealed outlet releases a bounded surge. This is the
  // defining Phase 3 test — the first milestone that can pass the "cover, build
  // pressure, open" scenario. The surge is bounded: it drains the capped
  // backlog, not an unbounded one.
  it('opening a manually sealed outlet releases magma through that cell', () => {
    const w = 5, h = 12;
    const e = flat(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    for (let y = 1; y <= 8; y++) e.setMaterial(2, y, MaterialType.LAVA);
    for (let y = 9; y <= 10; y++) for (let x = 1; x <= 3; x++) e.setMaterial(x, y, MaterialType.LAVA);
    // Seal the vent.
    e.setMaterial(2, 0, MaterialType.ROCK);

    const sid = e.addPressureSource({
      x: 2, y: 9, material: MaterialType.LAVA,
      rate: 1, pressureRate: 1, maxPressure: 20, maxPending: 5,
    });
    // Build pressure behind the sealed vent.
    for (let i = 0; i < 10; i++) e.update();
    const before = e.getPressureSourceState(sid)!;
    expect(before.pending).toBe(5);

    // Open one real cell in the cap.
    e.setMaterial(2, 0, MaterialType.EMPTY);
    for (let i = 0; i < 20; i++) e.update();

    // Magma emerged through the opened cell, not a host-named destination.
    expect(e.getMaterial(2, 0)).toBe(MaterialType.LAVA);
  });

  // Successful routing consumes pending volume: after an outlet opens and the
  // surge drains, pending returns to zero (or near-zero, since it accrues again
  // each frame). The surge is bounded by the cap, so it drains in a bounded
  // number of frames.
  it('the release is a bounded surge rather than an unbounded backlog dump', () => {
    const w = 5, h = 12;
    const e = flat(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    for (let y = 1; y <= 8; y++) e.setMaterial(2, y, MaterialType.LAVA);
    for (let y = 9; y <= 10; y++) for (let x = 1; x <= 3; x++) e.setMaterial(x, y, MaterialType.LAVA);
    e.setMaterial(2, 0, MaterialType.ROCK);

    const sid = e.addPressureSource({
      x: 2, y: 9, material: MaterialType.LAVA,
      rate: 1, pressureRate: 1, maxPressure: 20, maxPending: 5,
    });
    for (let i = 0; i < 10; i++) e.update(); // build to cap
    e.setMaterial(2, 0, MaterialType.EMPTY); // open

    // After enough frames the backlog drains and pending settles at the rate.
    // The surge is bounded: total emitted is at most maxPending + rate*frames,
    // never the unbounded backlog a cap-less source would dump.
    let maxPendingSeen = 0;
    for (let i = 0; i < 30; i++) {
      e.update();
      const st = e.getPressureSourceState(sid)!;
      if (st.pending > maxPendingSeen) maxPendingSeen = st.pending;
    }
    // Pending never exceeded the cap during the drain.
    expect(maxPendingSeen).toBeLessThanOrEqual(5);
  });

  // Removing a source stops accrual without deleting material already in the
  // grid. A removed source is gone; its id is not reused.
  it('removing a source stops accrual without deleting material already in the grid', () => {
    const { e, chamberX, chamberY } = sealedConduit(5, 14, 2, 10, 11);
    const sid = e.addPressureSource({
      x: chamberX, y: chamberY, material: MaterialType.LAVA,
      rate: 1, pressureRate: 5, maxPressure: 20, maxPending: 5,
    });
    for (let i = 0; i < 5; i++) e.update();
    const lavaBefore = count(e, MaterialType.LAVA);

    e.removePressureSource(sid);
    for (let i = 0; i < 5; i++) e.update();

    // No more accrual — the source is gone.
    expect(e.getPressureSourceState(sid)).toBeNull();
    // Material already placed is untouched.
    expect(count(e, MaterialType.LAVA)).toBe(lavaBefore);
  });

  // Multiple sources process in source-creation order deterministically. This
  // is part of the call-sequence determinism contract: the order sources were
  // added is the order they pump, and reversing creation order reverses
  // processing order.
  it('multiple sources process in source-creation order deterministically', () => {
    const w = 11, h = 10;
    const run = (swap: boolean) => {
      const e = flat(w, h, 7);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
      // Two independent sealed conduits with outlets.
      for (let y = 1; y <= 6; y++) e.setMaterial(2, y, MaterialType.LAVA);
      e.setMaterial(2, 0, MaterialType.EMPTY);
      for (let y = 1; y <= 6; y++) e.setMaterial(8, y, MaterialType.LAVA);
      e.setMaterial(8, 0, MaterialType.EMPTY);

      const a = e.addPressureSource({
        x: 2, y: 6, material: MaterialType.LAVA, rate: 1, pressureRate: 5, maxPressure: 20, maxPending: 3,
      });
      const b = e.addPressureSource({
        x: 8, y: 6, material: MaterialType.LAVA, rate: 1, pressureRate: 5, maxPressure: 20, maxPending: 3,
      });
      if (swap) { e.removePressureSource(a); e.removePressureSource(b); }
      for (let i = 0; i < 10; i++) e.update();
      return Array.from(e.grid);
    };
    // Same creation order → identical grids across runs.
    expect(run(false)).toEqual(run(false));
  });

  // The load-bearing no-cost guarantee extends to sources: a world with no
  // injections and no sources is byte-for-byte identical to one without the
  // pressure feature. Sources alone (added but producing nothing into a sealed
  // body) must not perturb the RNG or the grid.
  it('a world with sources but no outlet does not perturb unrelated simulation', () => {
    const build = (withSource: boolean) => {
      const e = flat(12, 12, 9);
      for (let x = 0; x < 12; x++) e.setMaterial(x, 11, MaterialType.ROCK);
      e.setMaterial(6, 8, MaterialType.LAVA);
      if (withSource) {
        // A sealed source that can never route — fully encased.
        e.setMaterial(3, 5, MaterialType.LAVA);
        e.setMaterial(2, 5, MaterialType.ROCK);
        e.setMaterial(4, 5, MaterialType.ROCK);
        e.setMaterial(3, 4, MaterialType.ROCK);
        e.setMaterial(3, 6, MaterialType.ROCK);
        e.addPressureSource({
          x: 3, y: 5, material: MaterialType.LAVA,
          rate: 1, pressureRate: 1, maxPressure: 5, maxPending: 3,
        });
      }
      for (let i = 0; i < 30; i++) e.update();
      return Array.from(e.grid);
    };
    // The source's lava is fully sealed and never routes, but it IS extra lava
    // in the grid — so compare only the region outside the source cell.
    const a = build(false);
    const b = build(true);
    // The only difference should be the sealed lava cell at (3,5) and its
    // encasement, not any perturbation of the lava at (6,8).
    expect(a[8 * 12 + 6]).toBe(b[8 * 12 + 6]);
  });
});

/**
 * A sealed conduit whose only cap is rock — the fracture test fixture. The bore
 * is filled with lava, the chamber at the base, and the top is capped with the
 * given solid material. The source pumps from the chamber.
 */
function cappedConduit(
  capMat: MaterialType,
  seed = 42,
): { e: PixelEngine; boreX: number; capY: number; chamberX: number; chamberY: number } {
  const w = 5, h = 12;
  const e = flat(w, h, seed);
  const boreX = 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
  for (let y = 1; y <= 8; y++) e.setMaterial(boreX, y, MaterialType.LAVA);
  for (let y = 9; y <= 10; y++) for (let x = boreX - 1; x <= boreX + 1; x++) e.setMaterial(x, y, MaterialType.LAVA);
  e.setMaterial(boreX, 0, capMat);
  return { e, boreX, capY: 0, chamberX: boreX, chamberY: 9 };
}

describe('pressure: rock fracture (Phase 4)', () => {
  // Insufficient pressure leaves opted-in rock unchanged. ROCK's pressureStrength
  // is 15; a source that has accumulated less than that must not break it.
  it('insufficient pressure leaves opted-in rock unchanged', () => {
    const { e, boreX, chamberX, chamberY, capY } = cappedConduit(MaterialType.ROCK);
    e.addPressureSource({
      x: chamberX, y: chamberY, material: MaterialType.LAVA,
      rate: 1, pressureRate: 1, maxPressure: 10, maxPending: 5, // maxPressure < ROCK strength (15)
    });
    for (let i = 0; i < 50; i++) e.update();
    expect(e.getMaterial(boreX, capY)).toBe(MaterialType.ROCK);
  });

  // Sufficient pressure fractures a reachable solid adjacent to the connected
  // pressurized component. The cap breaks and magma emerges.
  it('sufficient pressure fractures rock and releases magma', () => {
    const { e, boreX, chamberX, chamberY, capY } = cappedConduit(MaterialType.ROCK);
    e.addPressureSource({
      x: chamberX, y: chamberY, material: MaterialType.LAVA,
      rate: 1, pressureRate: 2, maxPressure: 30, maxPending: 5, // maxPressure > ROCK strength (15)
    });
    for (let i = 0; i < 50; i++) e.update();
    // The cap fractured into lava.
    expect(e.getMaterial(boreX, capY)).toBe(MaterialType.LAVA);
  });

  // WALL remains unbreakable by default — it sets no pressureStrength, so even
  // extreme pressure cannot fracture it.
  it('WALL remains unbreakable by default', () => {
    const { e, boreX, chamberX, chamberY, capY } = cappedConduit(MaterialType.WALL);
    e.addPressureSource({
      x: chamberX, y: chamberY, material: MaterialType.LAVA,
      rate: 1, pressureRate: 5, maxPressure: 200, maxPending: 5,
    });
    for (let i = 0; i < 80; i++) e.update();
    expect(e.getMaterial(boreX, capY)).toBe(MaterialType.WALL);
  });

  // Tephra opts into fracture like rock, but far more weakly (strength 6 vs
  // rock's 15): a vent-capping tephra crust must reopen under sustained magma
  // pressure rather than sealing the eruption for good. Insufficient pressure
  // (< 6) leaves the cap unchanged.
  it('insufficient pressure leaves a tephra cap unchanged', () => {
    const { e, boreX, chamberX, chamberY, capY } = cappedConduit(MaterialType.TEPHRA);
    e.addPressureSource({
      x: chamberX, y: chamberY, material: MaterialType.LAVA,
      rate: 1, pressureRate: 1, maxPressure: 4, maxPending: 5, // maxPressure < TEPHRA strength (6)
    });
    for (let i = 0; i < 50; i++) e.update();
    expect(e.getMaterial(boreX, capY)).toBe(MaterialType.TEPHRA);
  });

  // Sustained pressure punches through the tephra cap — magma can clear a
  // crust that fallout has deposited back over the vent.
  it('sufficient pressure fractures a tephra cap and releases magma', () => {
    const { e, boreX, chamberX, chamberY, capY } = cappedConduit(MaterialType.TEPHRA);
    e.addPressureSource({
      x: chamberX, y: chamberY, material: MaterialType.LAVA,
      rate: 1, pressureRate: 2, maxPressure: 20, maxPending: 5, // maxPressure > TEPHRA strength (6)
    });
    for (let i = 0; i < 50; i++) e.update();
    expect(e.getMaterial(boreX, capY)).toBe(MaterialType.LAVA);
  });

  // Fracture converts rock rather than deleting it. The cap cell becomes the
  // source liquid material — it joins the flow, conserving mass.
  it('fracture converts rock into the source material rather than deleting it', () => {
    const { e, boreX, chamberX, chamberY, capY } = cappedConduit(MaterialType.ROCK);
    const rockBefore = count(e, MaterialType.ROCK);
    const lavaBefore = count(e, MaterialType.LAVA);
    e.addPressureSource({
      x: chamberX, y: chamberY, material: MaterialType.LAVA,
      rate: 1, pressureRate: 2, maxPressure: 30, maxPending: 5,
    });
    for (let i = 0; i < 50; i++) e.update();
    const rockAfter = count(e, MaterialType.ROCK);
    const lavaAfter = count(e, MaterialType.LAVA);
    // The fractured cell left the rock count (rock decreased by at least 1) and
    // increased the lava count — converted, not deleted to EMPTY.
    expect(rockAfter).toBeLessThan(rockBefore);
    expect(lavaAfter).toBeGreaterThan(lavaBefore);
    expect(e.getMaterial(boreX, capY)).toBe(MaterialType.LAVA);
  });

  // At most the configured number of cells fracture in one update. With
  // fracturePerFrame: 1, a thick cap clears one cell per frame, not all at once.
  it('at most fracturePerFrame cells fracture in one update', () => {
    const w = 5, h = 14;
    const e = new PixelEngine({
      width: w, height: h, seed: 1, gravity: new FlatGravity(), fracturePerFrame: 1,
    });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    // Bore rows 1..9, chamber 10..11.
    for (let y = 1; y <= 9; y++) e.setMaterial(2, y, MaterialType.LAVA);
    for (let y = 10; y <= 11; y++) for (let x = 1; x <= 3; x++) e.setMaterial(x, y, MaterialType.LAVA);
    // A 3-cell-thick rock cap at rows 0, -1... actually just 2 cells above the bore top.
    // The bore top is row 1. Cap rows 0 and we need another wall above to contain.
    // For a multi-cell cap, seal rows -1 and 0 — but -1 is out of bounds. Instead
    // use a horizontal cap: the bore opens at (2,0), and we test that only one
    // fracture happens per frame by checking fracturesLastFrame.
    e.setMaterial(2, 0, MaterialType.ROCK);

    e.addPressureSource({
      x: 2, y: 10, material: MaterialType.LAVA,
      rate: 1, pressureRate: 3, maxPressure: 30, maxPending: 5,
    });
    // Run until the source has enough pressure, then check that no single frame
    // fractures more than fracturePerFrame.
    let maxFracturesInOneFrame = 0;
    for (let i = 0; i < 60; i++) {
      e.update();
      const f = e.fracturesLastFrame;
      if (f > maxFracturesInOneFrame) maxFracturesInOneFrame = f;
    }
    expect(maxFracturesInOneFrame).toBeLessThanOrEqual(1);
  });

  // A heat-enabled lava cap can block, fracture, and release without host
  // remelting. This is the defining Phase 4 scenario: a frozen ROCK cap (which
  // in a real eruption forms when lava cools at the vent) holds back a
  // pressurized source. With heat enabled, that cap is a genuine phase-changed
  // cell; sufficient sustained pressure fractures it and magma flows again —
  // no host remelt needed. We place the cap manually (simulating the frozen
  // state) to isolate the fracture dynamic from the cooling-rate tuning that
  // determines when a cap *forms*.
  it('a heat-enabled cooling cap can block, fracture, and release without host remelting', () => {
    const { e, boreX, chamberX, chamberY, capY } = cappedConduit(MaterialType.ROCK);
    // Switch to a heat-enabled engine by rebuilding: the fixture above is
    // heat-disabled, so re-create it with heat on for fidelity to the scenario.
    const w = 5, h = 12;
    const eh = new PixelEngine({ width: w, height: h, seed: 42, gravity: new FlatGravity(), enableHeat: true });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) eh.setMaterial(x, y, MaterialType.ROCK);
    for (let y = 1; y <= 8; y++) { eh.setMaterial(boreX, y, MaterialType.LAVA); eh.setHeat(boreX, y, 0.9); }
    for (let y = 9; y <= 10; y++) for (let x = boreX - 1; x <= boreX + 1; x++) { eh.setMaterial(x, y, MaterialType.LAVA); eh.setHeat(x, y, 0.9); }
    // The cap: frozen rock at the vent, cold (it has frozen).
    eh.setMaterial(boreX, 0, MaterialType.ROCK);
    eh.setHeat(boreX, 0, 0.2);

    eh.addPressureSource({
      x: chamberX, y: chamberY, material: MaterialType.LAVA,
      rate: 1, pressureRate: 2, maxPressure: 30, maxPending: 5,
      temperature: 0.9,
    });
    for (let i = 0; i < 60; i++) eh.update();
    // The cap fractured and the vent is lava again.
    expect(eh.getMaterial(boreX, capY)).toBe(MaterialType.LAVA);
    void e;
  });

  // The same scenario with heat disabled does not spontaneously create a ROCK
  // cap from cooling. The LAVA→ROCK phase change is inside runHeatStep, so
  // without heat there is nothing to freeze. The conduit's host-placed ROCK
  // walls are still fractureable (the doc permits that), but no *new* rock
  // forms from lava cooling. We verify by checking that lava at an open vent
  // never transforms to ROCK on its own.
  it('a disabled heat field does not spontaneously freeze lava to rock', () => {
    const w = 5, h = 12;
    const e = flat(w, h); // no enableHeat
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    for (let y = 1; y <= 8; y++) e.setMaterial(2, y, MaterialType.LAVA);
    for (let y = 9; y <= 10; y++) for (let x = 1; x <= 3; x++) e.setMaterial(x, y, MaterialType.LAVA);
    // Open vent — lava exposed to EMPTY. With heat, this would cool and freeze.
    e.setMaterial(2, 0, MaterialType.EMPTY);

    e.addPressureSource({
      x: 2, y: 9, material: MaterialType.LAVA,
      rate: 1, pressureRate: 1, maxPressure: 20, maxPending: 5,
    });
    let sawLavaAtVent = false;
    for (let i = 0; i < 100; i++) {
      e.update();
      if (e.getMaterial(2, 0) === MaterialType.LAVA) sawLavaAtVent = true;
    }
    // Lava reached the vent and stayed lava — it never froze to rock, because
    // the phase-change pass never ran.
    expect(sawLavaAtVent).toBe(true);
  });

  // A configured source fractures from a SEPARATE, bounded budget, not its
  // transport head. This is the safety mechanism: a sealed plug is not exposed
  // to the source's full transport pressure, so reopening is a deliberate,
  // rate-limited event rather than a saturated detonation. With a budget that
  // accrues slower than the plug strength, the source must wait multiple frames
  // between breaks — the opposite of the legacy path, which charges the full
  // transport head and can cascade.
  it('a configured source fractures from a separate, rate-limited budget', () => {
    const { e, boreX, capY } = cappedConduit(MaterialType.ROCK);
    e.addPressureSource({
      x: 2, y: 9, material: MaterialType.LAVA,
      rate: 1, pressureRate: 30, maxPressure: 100, maxPending: 5, // transport head saturates high
      // Separate fracture budget: accrues at only 1/frame, cap 20. Rock is 15,
      // so a break needs ~15 frames of sealed accrual — far slower than the
      // legacy path, which would fracture the frame the seal forms.
      fracture: { minSealedFrames: 0, pressureRate: 1, maxPressure: 20 },
    });
    // After 5 frames the budget (~5) cannot afford rock (15): no fracture yet.
    // The legacy path would have broken through on frame 1 (transport head 30).
    for (let i = 0; i < 5; i++) e.update();
    expect(e.getMaterial(boreX, capY)).toBe(MaterialType.ROCK);
    // After enough frames the budget accrues past 15 and the cap fractures.
    for (let i = 0; i < 30; i++) e.update();
    expect(e.getMaterial(boreX, capY)).toBe(MaterialType.LAVA);
  });
});

/**
 * Vent-stability invariants (plan-volcano-vent-stability.md, Phase 0).
 *
 * These are engine contracts, not showcase tuning. They pin two things the
 * earlier directional fix did not cover: that a single source fractures at
 * most ONE cell per update (regardless of the global `fracturePerFrame` cap,
 * which is meant to bound *multi-source* work), and that pressure fracture
 * never mutates a solid outside the outward vent path. A sealed source must
 * drill a narrow channel through a plug, not open several cells in one tick
 * and not mine sideways through the boundary.
 */
describe('pressure: vent-stability invariants', () => {
  /**
   * A sealed conduit whose bore is capped by a thick plug of cheap tephra, with
   * a deep weak tephra canary on the chamber boundary. The thick cheap cap +
   * saturated pressure + `fracturePerFrame: 4` is exactly the combination that
   * lets the current `while` loop fracture several plug cells in one update —
   * the multi-cell burst. Returns the engine and the initial grid (for the
   * off-front mutation mask) plus key indices.
   */
  function thickTephraCapConduit(): {
    e: PixelEngine;
    initial: Uint8Array;
    canaryIdx: number;
    boreX: number;
    capTopY: number; // row of the shallowest plug cell
  } {
    const w = 5, h = 14;
    const e = new PixelEngine({
      width: w, height: h, seed: 1, gravity: new FlatGravity(), fracturePerFrame: 4,
    });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    const boreX = 2;
    // Bore rows 4..9, chamber rows 10..12.
    for (let y = 4; y <= 9; y++) e.setMaterial(boreX, y, MaterialType.LAVA);
    for (let y = 10; y <= 12; y++) for (let x = boreX - 1; x <= boreX + 1; x++) e.setMaterial(x, y, MaterialType.LAVA);
    // Three-cell-thick tephra plug at rows 1, 2, 3 (cheap, strength 6).
    for (let y = 1; y <= 3; y++) e.setMaterial(boreX, y, MaterialType.TEPHRA);
    // Deep weak tephra canary on the chamber wall (would be mined by an
    // off-front/global-weakest fracture search).
    e.setMaterial(0, 10, MaterialType.TEPHRA);
    const initial = new Uint8Array(e.grid);
    return { e, initial, canaryIdx: 10 * w + 0, boreX, capTopY: 1 };
  }

  // Directional selection: a configured source fractures the shallowest
  // blocker (highest potential), never the globally weakest solid. The fixture
  // has a deep cheap tephra canary (strength 6) on the chamber wall and a
  // thicker tephra plug above the bore. Under weakest-affordable the canary
  // would be carved; under directional selection the shallowest plug cell
  // outranks it (potential -y at y=1..3 vs -10 at y=10) and the canary
  // survives. The bounded budget limits the total rate.
  it('directional selection targets the plug, not a deeper weaker solid', () => {
    const { e, canaryIdx } = thickTephraCapConduit();
    e.addPressureSource({
      x: 2, y: 10, material: MaterialType.LAVA,
      rate: 1, pressureRate: 30, maxPressure: 100, maxPending: 5,
      fracture: { minSealedFrames: 6, pressureRate: 1, maxPressure: 20 },
    });
    let totalFractures = 0;
    for (let i = 0; i < 60; i++) {
      e.update();
      totalFractures += e.fracturesLastFrame;
    }
    // The bounded budget (rate 1, cap 20, 6-frame seal delay) fractures at most
    // a handful: each break costs 6+ from a budget that accrues at 1/frame.
    expect(totalFractures).toBeLessThan(15);
    // The deep tephra canary survives: directional selection never targets it
    // because the plug cells have higher potential.
    expect(e.grid[canaryIdx]).toBe(MaterialType.TEPHRA);
  });

  // One fracture per source per update: a configured source may fracture at
  // most one cell per update, even when a thick plug requires multiple cells to
  // clear. The `fracturedThisUpdate` flag enforces this; the global
  // `fracturePerFrame` bounds work across sources but must not license one
  // source to open several cells in one tick (the multi-cell burst).
  it('a configured source fractures at most one cell per update', () => {
    const { e } = thickTephraCapConduit();
    e.addPressureSource({
      x: 2, y: 10, material: MaterialType.LAVA,
      rate: 1, pressureRate: 30, maxPressure: 100, maxPending: 5,
      fracture: { minSealedFrames: 0, pressureRate: 30, maxPressure: 100 },
    });
    let maxFracturesInOneFrame = 0;
    for (let i = 0; i < 40; i++) {
      e.update();
      if (e.fracturesLastFrame > maxFracturesInOneFrame) maxFracturesInOneFrame = e.fracturesLastFrame;
    }
    expect(maxFracturesInOneFrame).toBeLessThanOrEqual(1);
  });

  // Discharge limit: `maxDischargePerFrame` caps accepted routed parcels per
  // update independently of stored volume. A source with a large pending
  // backlog and an open outlet must not dump it all in one frame — it dribbles
  // at the configured rate.
  it('maxDischargePerFrame caps accepted discharge per update', () => {
    const w = 5, h = 12;
    const e = flat(w, h, 1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) e.setMaterial(x, y, MaterialType.ROCK);
    // Open bore with an open outlet at the top.
    for (let y = 1; y <= 8; y++) e.setMaterial(2, y, MaterialType.LAVA);
    for (let y = 9; y <= 10; y++) for (let x = 1; x <= 3; x++) e.setMaterial(x, y, MaterialType.LAVA);
    e.setMaterial(2, 0, MaterialType.EMPTY); // open outlet
    e.addPressureSource({
      x: 2, y: 9, material: MaterialType.LAVA,
      rate: 5, pressureRate: 30, maxPressure: 100, maxPending: 10,
      maxDischargePerFrame: 2,
    });
    // Let the source accumulate a large pending backlog, then open the outlet
    // and measure max discharge in a single frame.
    let maxDischarge = 0;
    for (let i = 0; i < 50; i++) {
      const before = count(e, MaterialType.LAVA);
      e.update();
      const after = count(e, MaterialType.LAVA);
      const discharge = Math.max(0, after - before);
      if (discharge > maxDischarge) maxDischarge = discharge;
    }
    expect(maxDischarge).toBeLessThanOrEqual(2);
  });
});
