import { describe, it, expect } from 'vitest';
import { PixelEngine, fillNeighborFrame, type NeighborFrame } from '../../src/sand';
import { MaterialType } from '../../src/materials';
import { RadialGravity, FlatGravity } from '../../src/gravity';
import {
  stampVolcano,
  emitPlume,
  coolLava,
  remeltConduit,
  assimilateTephra,
  makeRng,
  ventPosition,
  type VolcanoConfig,
} from '../helpers/volcano';

/**
 * Tests for the host-side volcano (stage 0 of `.zcode/plans/design-volcano.md`).
 *
 * The point of this prototype is to establish which volcano features actually
 * need engine support. These tests pin the two findings that came out of it:
 * cooling has to exist at all (the engine has no lava→rock path except water),
 * and emission has to be lofted (feeding a vent directly just plugs it).
 */

const SIZE = 180, CX = 90, CY = 90, R = 54;

/** Showcase defaults: a mostly-tephra plume capped at a 16-cell summit. */
const PLUME = { perFrame: 8, spread: 0.21, loft: 5, lavaFraction: 0.3, maxHeight: 16 };

const CFG: VolcanoConfig = {
  centerX: CX, centerY: CY, planetRadius: R,
  ventAngle: -Math.PI / 2,
  conduitHalfWidth: 1, chamberRadius: 8, chamberDepth: 26,
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

/**
 * Material sitting outside the original planet surface — i.e. newly built land.
 * Counts tephra (`SAND`) as well as frozen lava (`ROCK`), since the cone is
 * mostly the former.
 */
function edifice(e: PixelEngine): { cells: number; height: number; halfWidth: number } {
  let cells = 0, height = 0;
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
      // Height profile per degree, measured from the vent.
      const deg = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 540) % 360 - 180);
      profile.set(deg, Math.max(profile.get(deg) ?? 0, d - R));
    }
  }
  const spanDeg = [...profile.entries()].filter(([, h]) => h >= 1).map(([a]) => Math.abs(a));
  const halfWidth = (spanDeg.length ? Math.max(...spanDeg) : 0) * (Math.PI / 180) * R;
  return { cells, height, halfWidth };
}

describe('volcano (host-side, no engine changes)', () => {
  it('stamps a conduit that holds its magma without draining', () => {
    // The engine has no pressure term, so magma cannot rise — but a filled
    // conduit is stable, which is what makes it usable as a reservoir.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const before = count(e, MaterialType.LAVA);
    for (let i = 0; i < 500; i++) e.update();
    expect(count(e, MaterialType.LAVA)).toBe(before);
    expect(e.swapsLastFrame).toBe(0);
  });

  it('cooling turns exposed lava to rock but leaves buried lava molten', () => {
    // Both halves matter: without cooling nothing solidifies at all, and if
    // buried lava cooled too the conduit would freeze solid and plug itself.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const rng = makeRng(7);
    const vent = ventPosition(CFG);
    for (let i = 0; i < 200; i++) { e.update(); coolLava(e, rng, { rate: 0.5 }); }

    // Deep conduit lava (well below the surface) is insulated and survives.
    const deepX = Math.round(CX);
    const deepY = Math.round(CY - (R - 15));
    expect(e.getMaterial(deepX, deepY)).toBe(MaterialType.LAVA);
    // The exposed cap at the vent has frozen.
    expect(e.getMaterial(vent.x, vent.y)).not.toBe(MaterialType.LAVA);
  });

  it('a summit-tracking vent builds; a vent pinned to the surface stalls', () => {
    // The core finding of stage 0. Emission is skipped when its target cell is
    // occupied, so a vent fixed at the original planet radius is buried by its
    // own first deposits and the volcano stops erupting. `emitPlume` tracks the
    // summit for exactly this reason; this pins the difference by comparing it
    // against a deliberately naive fixed-radius emitter.
    const rngA = makeRng(99);
    const tracking = buildPlanet();
    stampVolcano(tracking, CFG);
    for (let f = 0; f < 900; f++) {
      emitPlume(tracking, CFG, rngA, PLUME);
      tracking.update();
      coolLava(tracking, rngA, { rate: 0.25 });
    }

    const rngB = makeRng(99);
    const pinned = buildPlanet();
    stampVolcano(pinned, CFG);
    for (let f = 0; f < 900; f++) {
      // Naive: always launch from the original surface radius.
      for (let k = 0; k < PLUME.perFrame; k++) {
        const a = CFG.ventAngle + (rngB() * 2 - 1) * PLUME.spread;
        const r = R + 1 + rngB() * PLUME.loft;
        const x = Math.round(CX + Math.cos(a) * r);
        const y = Math.round(CY + Math.sin(a) * r);
        if (pinned.getMaterial(x, y) !== MaterialType.EMPTY) continue;
        pinned.setMaterial(x, y, rngB() < PLUME.lavaFraction ? MaterialType.LAVA : MaterialType.SAND);
      }
      pinned.update();
      coolLava(pinned, rngB, { rate: 0.25 });
    }

    const built = edifice(tracking);
    const stalled = edifice(pinned);
    expect(built.height).toBeGreaterThan(10);
    expect(built.height).toBeGreaterThan(stalled.height * 1.5);
    // Two full simulations at showcase scale; keep clear of the 5s default.
  }, 20_000);

  it('fallout does not choke the conduit', () => {
    // Tephra is SAND (density 10) and lava is density 8, so ejecta landing on
    // the open vent sinks *through* the magma column and fills the plumbing
    // from the top down. Without remeltConduit the conduit+chamber went from
    // 163 lava / 0 tephra to 73 lava / 93 tephra within 300 frames and stayed
    // choked — the volcano buries its own throat.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const rng = makeRng(99);
    for (let f = 0; f < 1200; f++) {
      emitPlume(e, CFG, rng, PLUME);
      e.update();
      remeltConduit(e, CFG);
      coolLava(e, rng, { rate: 0.25 });
    }
    // Sample the bore and chamber along the vent axis.
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

  it('does not leave frozen ejecta hanging in mid-air', () => {
    // Ejecta is spawned in mid-air and the engine has no velocity, so a cell in
    // flight is a lone airborne cell — maximum "exposure" by the cooling rule,
    // and therefore the most likely thing to freeze, before it has landed.
    // Frozen lava is ROCK, a static solid that never falls, so it hung in the
    // sky as grey dots. Measured before requiring support: 38 of 208 frozen
    // cells were unsupported, and visibly speckled the space above the cone.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const rng = makeRng(4242);
    for (let f = 0; f < 900; f++) {
      emitPlume(e, CFG, rng, PLUME);
      e.update();
      remeltConduit(e, CFG);
      coolLava(e, rng, { rate: 0.25 });
    }

    // A speck is rock with nothing under it AND no solid neighbour at all.
    // Unsupported-but-attached cells are fine — those are overhangs on the cone.
    //
    // The bound is small-but-nonzero rather than 0, honestly: a handful of
    // cells still freeze while resting on granular tephra that then settles
    // away, stranding them. Rock is static in this engine so it cannot fall
    // afterwards. That residual is 1-2 cells and invisible; the bug this
    // guards against was ~38 and clearly visible.
    const frame: NeighborFrame = {
      down: { dx: 0, dy: 0 }, downLeft: { dx: 0, dy: 0 }, downRight: { dx: 0, dy: 0 },
      left: { dx: 0, dy: 0 }, right: { dx: 0, dy: 0 },
    };
    const solid = (m: MaterialType): boolean =>
      m === MaterialType.ROCK || m === MaterialType.SAND || m === MaterialType.LAVA;
    let specks = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (Math.hypot(x - CX, y - CY) <= R) continue;
        if (e.getMaterial(x, y) !== MaterialType.ROCK) continue;
        fillNeighborFrame(x, y, e.gravity, frame);
        if (e.getMaterial(x + frame.down.dx, y + frame.down.dy) !== MaterialType.EMPTY) continue;
        let neighbours = 0;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
          if (solid(e.getMaterial(x + ox, y + oy))) neighbours++;
        }
        if (neighbours === 0) specks++;
      }
    }
    expect(specks).toBeLessThanOrEqual(3);
  }, 20_000);

  it('builds a steep cone, not a flat shield', () => {
    // Shape regression. Erupting pure lava built a broad lumpy mesa (slope
    // ~1:5.7) because frozen lava is a static solid that never settles.
    // Granular tephra piles at its own angle of repose and gives a classic
    // cone (~1:1.3). A shallower result means the tephra fraction or the
    // summit cap has drifted.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const rng = makeRng(99);
    for (let f = 0; f < 1500; f++) {
      emitPlume(e, CFG, rng, PLUME);
      e.update();
      remeltConduit(e, CFG);
      coolLava(e, rng, { rate: 0.25 });
    }
    const built = edifice(e);
    expect(built.height).toBeGreaterThan(10);
    // Slope = half-width : height. Lower is steeper; a shield was ~5.7.
    expect(built.halfWidth / built.height).toBeLessThan(2.5);
    // The summit cap must actually bound the growth — uncapped, the vent
    // tracks its own deposits until the cone reaches the edge of the grid.
    expect(built.height).toBeLessThan(PLUME.maxHeight + 8);
  }, 20_000);

  it('the planet still settles once the eruption stops', () => {
    // Guards every liquid invariant the engine established: an eruption must
    // not leave the world churning forever.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const rng = makeRng(5);
    for (let f = 0; f < 600; f++) {
      emitPlume(e, CFG, rng, PLUME);
      e.update();
      coolLava(e, rng, { rate: 0.18 });
    }
    // Tap off: keep cooling so the remaining flows freeze, then let it rest.
    for (let f = 0; f < 1500; f++) { e.update(); coolLava(e, rng, { rate: 0.18 }); }
    for (let f = 0; f < 400; f++) e.update();
    expect(e.swapsLastFrame).toBe(0);
  });

  it('is deterministic for a given seed', () => {
    const run = (): Uint8Array => {
      const e = buildPlanet();
      stampVolcano(e, CFG);
      const rng = makeRng(11);
      for (let f = 0; f < 300; f++) {
        emitPlume(e, CFG, rng, PLUME);
        e.update();
        coolLava(e, rng, { rate: 0.18 });
      }
      return Uint8Array.from(e.grid);
    };
    expect(run()).toEqual(run());
  });

  it('assimilates embedded tephra into lava and clears its tint', () => {
    // The fix for grey particles hanging in the magma: a tephra cell engulfed by
    // lava (>= threshold lava neighbours) melts into lava 1:1 and drops its dark
    // basalt tint, or the renderer keeps showing the tephra colour over the new
    // material. Embedding, not mere contact — surface tephra touching a flow on
    // one side is left alone (covered by the cone test below).
    const flat = new PixelEngine({ width: 12, height: 12, seed: 1, gravity: new FlatGravity() });
    // Tephra at (6,6) surrounded by lava on all four sides — fully embedded.
    flat.setMaterial(6, 5, MaterialType.LAVA);
    flat.setMaterial(6, 7, MaterialType.LAVA);
    flat.setMaterial(5, 6, MaterialType.LAVA);
    flat.setMaterial(7, 6, MaterialType.LAVA);
    flat.setMaterial(6, 6, MaterialType.SAND);
    if (!flat.colorGrid) flat.colorGrid = new Uint32Array(12 * 12);
    flat.colorGrid[6 * 12 + 6] = 0xff242428; // dark basalt tint, nonzero

    const before = count(flat, MaterialType.LAVA) + count(flat, MaterialType.SAND);
    assimilateTephra(flat, makeRng(1), { rate: 1 }); // rate 1 = deterministic
    const after = count(flat, MaterialType.LAVA) + count(flat, MaterialType.SAND);

    expect(flat.getMaterial(6, 6)).toBe(MaterialType.LAVA); // melted
    expect(after).toBe(before);                              // 1:1 conserved
    expect(flat.colorGrid![6 * 12 + 6]).toBe(0);             // tint cleared
  });

  it('assimilation leaves mere flank contact untouched', () => {
    // The threshold gate: tephra touching lava on only one side — the cone's
    // flank against a thin surface flow — is NOT embedded, so it must survive.
    // This is what keeps the structural cone from being eaten.
    const flat = new PixelEngine({ width: 12, height: 12, seed: 1, gravity: new FlatGravity() });
    // A tephra bed with lava resting on top of it (one lava neighbour).
    flat.setMaterial(6, 5, MaterialType.LAVA);
    flat.setMaterial(6, 6, MaterialType.SAND);
    flat.setMaterial(6, 7, MaterialType.SAND);

    assimilateTephra(flat, makeRng(1), { rate: 1 }); // rate 1, still no melt
    expect(flat.getMaterial(6, 6)).toBe(MaterialType.SAND); // untouched
    expect(flat.getMaterial(6, 7)).toBe(MaterialType.SAND);
  });

  it('assimilation does not collapse the cone', () => {
    // End-to-end guard for the runaway the threshold prevents. With assimilation
    // in the loop the cone must still stand: it keeps most of its tephra and its
    // slope stays steep (the existing steep-cone test runs without assimilation,
    // so it does not catch a rule that dissolves the flank).
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const rng = makeRng(99);
    for (let f = 0; f < 1500; f++) {
      emitPlume(e, CFG, rng, PLUME);
      e.update();
      remeltConduit(e, CFG);
      coolLava(e, rng, { rate: 0.15 });
      assimilateTephra(e, rng, { rate: 0.5 });
    }
    const built = edifice(e);
    // Tephra survives — the cone was not dissolved into lava.
    expect(count(e, MaterialType.SAND)).toBeGreaterThan(50);
    // Slope stays within the steep-cone contract (halfWidth : height < 2.5).
    expect(built.halfWidth / built.height).toBeLessThan(2.5);
  }, 20_000);

  it('a scene with assimilation still settles to 0 swaps', () => {
    // Assimilation must not leave the world churning once the eruption ends.
    const e = buildPlanet();
    stampVolcano(e, CFG);
    const rng = makeRng(5);
    for (let f = 0; f < 600; f++) {
      emitPlume(e, CFG, rng, PLUME);
      e.update();
      coolLava(e, rng, { rate: 0.15 });
      assimilateTephra(e, rng, { rate: 0.1 });
    }
    for (let f = 0; f < 1500; f++) { e.update(); coolLava(e, rng, { rate: 0.15 }); }
    for (let f = 0; f < 400; f++) e.update();
    expect(e.swapsLastFrame).toBe(0);
  }, 20_000);
});
