// In-repo import; when copying this file into a game, change to:
//   import { ... } from './surface-walkers';
import { FEAR_STARE, type SurfaceWalkers, type Walker } from './surface-walkers.js';

/**
 * Bridge [`surface-walkers.ts`](./surface-walkers.ts) onto the slime-knight rig
 * from [`games/assets/slime-rig/`](../games/assets/slime-rig/), and through it
 * onto `aicraft-engine`'s animation library.
 *
 * **This is the creature path, not an upgrade to one.** `drawSurfaceWalkers`
 * in the sibling recipe is a bring-up placeholder; this is what ships.
 *
 * ## Where the quality actually comes from
 *
 * It is worth being blunt about the layering, because the middle file is the
 * one that looks like the interesting part and is not:
 *
 * ```
 * surface-walkers.ts   behaviour — footing, fear, spawn contract
 * legged-walkers.ts    this file — 40 lines of coupling
 * slime-knight.ts      composition — proportions, palette, drawing
 *         ↓ 22 imports
 * aicraft-engine       ALL of the motion
 * ```
 *
 * `slime-knight.ts` is ~2,200 lines and contains **no original animation
 * maths**. Every moving part is a library call: `solveLimb` bends the knees,
 * `advanceLocomotionByDisplacement` + `evaluateLocomotion` + `DEFAULT_GAIT`
 * drive the stride from ground covered, `blendLocomotionToStance` settles the
 * feet at rest, `blendAirborneTuck` + `advanceJump` handle the hop,
 * `advanceSpringChain` runs the antennae, `breathe` breathes, and
 * `generatePalette` colours each individual. Take `aicraft-engine` away and the
 * rig does not degrade — it stops compiling.
 *
 * Which means: a host that skips the dependency is not choosing a simpler
 * creature, it is choosing to reimplement a 2,500-line animation library by
 * hand. Both builds that tried produced something rejected on sight.
 *
 * ## The failure it prevents
 *
 * The reference god-game build's creatures were a ~2,200-line procedural rig:
 * two-bone IK legs with a real gait, spring-driven antennae, a mouth that
 * morphs between a smile and a nervous "o", generated palettes. When the
 * creature *behaviour* was promoted into `surface-walkers.ts`, the rig was not
 * — it lives on as a copy-in asset with a README that says to write "a thin
 * adapter" and does not ship one. So the adapter, which is the only part
 * anybody was missing, had to be re-derived from scratch by every build. None
 * of them did. Two shipped blobs instead, and a reviewer of the second asked
 * "the walkers have no legs, not really walkers then are they".
 *
 * The adapter is about forty lines, and every one of them is a decision that
 * is wrong by default:
 *
 *  1. **The rig composes in its own 320px canvas with the feet on
 *     `HERO_GROUND_Y`** — not at the origin, and not centred. Mapping it onto
 *     a planet is: translate to the walker's foot point, rotate so local +Y
 *     points at the core, scale, then re-centre by
 *     `(-HERO_CANVAS_SIZE / 2, -HERO_GROUND_Y)`. Skip the re-centre and the
 *     creatures orbit a quarter-screen off their own feet.
 *  2. **`walkDx` is in rig-canvas px, and the walker's `gridDx` is in grid
 *     px.** Feed the grid value straight in and the gait advances at a
 *     fraction of the distance travelled, which is the foot-sliding tell.
 *     Divide by the draw scale first.
 *  3. **The rig also *translates* by `walkDx`.** Position is owned here, in
 *     polar coordinates, so the rig's own canvas-space traversal has to be
 *     cancelled every tick (`frame.x = 0`) or the creature drifts away from
 *     the feet point the transform is pinned to.
 *  4. **Hops roll on the population's seeded stream**, not `Math.random` — the
 *     reference adapter used `Math.random` here and quietly gave up
 *     reproducibility for a jump.
 *
 * ## Using it
 *
 * Copy this file and `slime-knight.ts` into your game, then
 * `npm install --save-exact aicraft-engine@0.22.0` — all 22 symbols the rig
 * needs are on that package's root barrel:
 *
 * ```ts
 * import * as rig from './slime-knight';
 * const pop    = createSurfaceWalkers(engine, { centerX: CX, centerY: CY, seed: SEED });
 * const rigged = createRiggedWalkers(pop, rig);
 * // per tick, after stepSurfaceWalkers:
 * stepRiggedWalkers(pop, rigged, rig);
 * // per frame, under the camera transform:
 * drawRiggedWalkers(ctx, pop, rigged, rig, tick);
 * ```
 *
 * The rig is typed structurally below rather than imported, so this recipe
 * typechecks in CI with no dependency on `aicraft-engine` and accepts the rig
 * module namespace as-is.
 */

/** The rig's frame state, as much of it as the bridge touches. */
export interface RigFrame {
  /** Canvas-space walk traversal the rig accumulates. Zeroed every tick. */
  x: number;
}

/** Structural view of `slime-knight.ts` — pass the module namespace. */
export interface SlimeRigModule<Config, Frame extends RigFrame> {
  readonly HERO_CANVAS_SIZE: number;
  readonly HERO_GROUND_Y: number;
  deriveHeroConfig(seed: number): Config;
  createHeroFrameState(config: Config): Frame;
  stepHero(
    state: Frame,
    dt: number,
    inputs?: {
      readonly walkDx?: number;
      readonly facing?: 1 | -1;
      readonly jumpPressed?: boolean;
      readonly eyeCount?: 1 | 2;
    },
  ): Frame;
  drawSlimeKnight(
    ctx: CanvasRenderingContext2D,
    state: Frame,
    tick: number,
    look?: { x: number; y: number },
    options?: { blink?: boolean; emotion?: number; legStyle?: 'ik' | 'simpleFeet' },
  ): void;
}

/**
 * Draw scale. The rig composes on a 320px canvas; a planet wants a body around
 * 16–20 grid px, which is what 0.22 gives. Carried over from the reference
 * build rather than re-derived — it is the value the rig's proportions were
 * tuned against.
 */
const DEFAULT_SCALE = 0.22;
/**
 * Extra gait phase per unit of translation.
 *
 * The rig syncs stride to displacement, so in principle this is 1. In practice
 * a walker's tangential speed (~0.22 grid px/tick) is slow relative to the
 * rig's stride length, and at 1 the creatures glide with barely-moving feet.
 * 2.0 is the reference build's tuned value: legs that clearly drive the body.
 */
const PHASE_GAIN = 2.0;
/** Mouth at rest and at maximum fear. See the rig's `MouthEmotion`. */
const HAPPY = 0.35;
const WORRIED = -0.85;
/** Per-tick chance a supported walker hops — pure garnish, on the seeded stream. */
const HOP_CHANCE = 0.004;
const FLEE_HOP_CHANCE = 0.05;

/** Per-walker rig state, parallel to `pop.list` by index. */
export interface RiggedWalker<Frame extends RigFrame> {
  frame: Frame;
  emotion: number;
  lookX: number;
  lookY: number;
  eyeCount: 1 | 2;
  /** Angle last frame — the bridge's own measure of distance covered. */
  lastAngle: number;
}

export interface RiggedWalkers<Frame extends RigFrame> {
  readonly list: RiggedWalker<Frame>[];
  readonly scale: number;
}

export interface RiggedWalkersOptions {
  /** Draw scale onto the grid. Default 0.22. */
  scale?: number;
}

/**
 * Build rig state for each walker in `pop`. Call once, right after
 * `createSurfaceWalkers`.
 *
 * Each walker's `seed` drives `deriveHeroConfig`, so an individual keeps its
 * proportions, palette and gait rhythm for its whole life — and the same world
 * seed reproduces the same population.
 */
export function createRiggedWalkers<Config, Frame extends RigFrame>(
  pop: SurfaceWalkers,
  rig: SlimeRigModule<Config, Frame>,
  opts: RiggedWalkersOptions = {},
): RiggedWalkers<Frame> {
  const list = pop.list.map((w) => ({
    frame: rig.createHeroFrameState(rig.deriveHeroConfig(w.seed)),
    emotion: HAPPY,
    lookX: 0.3,
    lookY: 0.1,
    // One in three is two-eyed, so a crowd does not read as clones.
    eyeCount: (w.seed % 3 === 0 ? 2 : 1) as 1 | 2,
    lastAngle: w.angle,
  }));
  return { list, scale: opts.scale ?? DEFAULT_SCALE };
}

/**
 * Advance every rig one tick. Call after `stepSurfaceWalkers`, same tick.
 *
 * Distance covered is measured here as the change in `angle × radius` rather
 * than read from the walker, because the walker does not keep it: `bobPhase`
 * has already folded it into a scalar. Measuring it directly also means this
 * bridge stays correct if the walker gains a new way to move.
 */
export function stepRiggedWalkers<Config, Frame extends RigFrame>(
  pop: SurfaceWalkers,
  rigged: RiggedWalkers<Frame>,
  rig: SlimeRigModule<Config, Frame>,
  dt = 1 / 60,
): void {
  for (let i = 0; i < pop.list.length; i++) {
    const w = pop.list[i];
    const r = rigged.list[i];
    if (!w.alive) { r.lastAngle = w.angle; continue; }

    // Tangential distance covered this tick, in grid px. Wrap-safe.
    let dAngle = w.angle - r.lastAngle;
    if (dAngle > Math.PI) dAngle -= Math.PI * 2;
    if (dAngle < -Math.PI) dAngle += Math.PI * 2;
    r.lastAngle = w.angle;
    const gridDx = dAngle * w.radius;

    r.emotion = HAPPY + (WORRIED - HAPPY) * w.fear;
    r.lookX = w.fear > FEAR_STARE ? 1 : 0.3;
    r.lookY = w.fear > FEAR_STARE ? -0.6 : 0.1;

    const hop = w.fear > 0.5 ? FLEE_HOP_CHANCE : HOP_CHANCE;
    r.frame = rig.stepHero(r.frame, dt, {
      // Grid px → rig-canvas px, then the phase gain. Feeding the grid value
      // straight in is the foot-sliding bug.
      walkDx: (gridDx / rigged.scale) * PHASE_GAIN,
      facing: w.facing,
      jumpPressed: pop.rng() < hop,
      eyeCount: r.eyeCount,
    });
    // Position is owned in polar coordinates here, so cancel the rig's own
    // canvas-space traversal — otherwise the body walks out of the transform
    // that is pinned to its feet.
    r.frame.x = 0;
  }
}

/**
 * Draw the rigged population in grid space — call under the camera transform,
 * in place of `drawSurfaceWalkers`.
 */
export function drawRiggedWalkers<Config, Frame extends RigFrame>(
  ctx: CanvasRenderingContext2D,
  pop: SurfaceWalkers,
  rigged: RiggedWalkers<Frame>,
  rig: SlimeRigModule<Config, Frame>,
  tick: number,
): void {
  for (let i = 0; i < pop.list.length; i++) {
    const w = pop.list[i];
    if (!w.alive) continue;
    const r = rigged.list[i];
    const fx = pop.centerX + w.radius * Math.cos(w.angle);
    const fy = pop.centerY + w.radius * Math.sin(w.angle);

    ctx.save();
    ctx.translate(fx, fy);
    // Local +Y now points at the planet core, matching the rig's own "down".
    ctx.rotate(w.angle + Math.PI / 2);
    ctx.scale(rigged.scale, rigged.scale);
    // The rig composes centred horizontally with its feet on HERO_GROUND_Y,
    // not at the origin. Without this the creature draws a quarter-canvas away
    // from the point it is standing on.
    ctx.translate(-rig.HERO_CANVAS_SIZE / 2, -rig.HERO_GROUND_Y);
    rig.drawSlimeKnight(
      ctx,
      r.frame,
      tick + (w.seed % 1024),
      { x: r.lookX, y: r.lookY },
      { blink: true, emotion: r.emotion, legStyle: 'ik' },
    );
    ctx.restore();
  }
}

/** Re-exported for hosts that keep both looks behind one switch. */
export type { SurfaceWalkers, Walker };
