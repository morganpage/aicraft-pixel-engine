// In-repo import; when copying this file into a game, change to:
//   import { MaterialType, mulberry32, type PixelEngine } from 'aicraft-pixel-engine';
import { MaterialType, mulberry32 } from '../src/index.js';
import type { PixelEngine } from '../src/index.js';

/**
 * Surface walkers: polar-coordinate creatures living on a radial-gravity
 * planet. Each walker holds `(angle, radius)` in the planet's frame and
 * samples the terrain along its angle — WALKABLE solids stride and hop,
 * LIQUID bobs and paddles, DEADLY kills with a respawn later. The surface
 * comes to the walker as its angle advances, so no physics is needed.
 *
 * ## The spawn contract (the failure this recipe exists to prevent)
 *
 * Two builds of the same god-game brief diverged on spawn policy. One
 * spawned 16 walkers within seconds of boot, on any walkable footing —
 * bare rock counts. The other gated its population on the grass census
 * ("no grass → no walkers") and hid every creature behind minutes of
 * gardening; a reviewer of a fresh world concluded the creatures had
 * never been built. The brief's "watch a dead rock become a living world"
 * refers to the terrain, not to withholding the creatures.
 *
 * The contract, pinned here in code: the population is established AT
 * BOOT — `count` slots created with staggered spawn timers (all alive
 * within a few seconds), spawning on any walkable footing, never gated on
 * grass, forest, or any census threshold. Population may grow with a
 * greening world at the host's discretion, but its floor is never zero.
 *
 * ## Other rules it bakes in
 *
 * - **Strictly visual.** Walkers never write a grid cell, so they cannot
 *   perturb the simulation or its determinism.
 * - **Dedicated RNG stream.** Behavior rolls a `mulberry32` seeded from
 *   the world seed — not `Math.random` (breaks determinism) and not
 *   `engine.random()` (shifts the simulation's shared draw sequence).
 * - **Fear is event-driven with decay.** Pass strike memories (a smite's
 *   ground point, remembered for ~4s) and live vents (continuous threat
 *   while present). A scared walker freezes and stares at the threat;
 *   a more scared one flees along the surface, panic-hopping.
 *
 * Usage: create after the planet stamp, step once per fixed 1/60s tick
 * (see `fixed-tick-clock.ts`) feeding your power code's threat state,
 * draw under the camera transform in grid space.
 *
 * ## The look lives elsewhere — and it is not optional
 *
 * This file owns **behaviour only**. The creature you actually ship is the
 * slime rig composed on `aicraft-engine`, reached through
 * [`legged-walkers.ts`](./legged-walkers.ts):
 *
 * ```ts
 * import * as rig from './slime-knight';
 * const rigged = createRiggedWalkers(pop, rig);
 * stepRiggedWalkers(pop, rigged, rig);      // per tick, after stepSurfaceWalkers
 * drawRiggedWalkers(ctx, pop, rigged, rig, tick);
 * ```
 *
 * `drawSurfaceWalkers` below is a **bring-up placeholder**, not a second
 * supported look. It exists so a host can see its population on screen before
 * the rig is wired, and it must not survive into a finished build — it
 * re-derives, worse, three things `aicraft-engine` already does properly
 * (`solveLimb`, `advanceLocomotionByDisplacement`, `blendLocomotionToStance`).
 *
 * This file used to draw an ellipse with an eye and describe it as "minimal —
 * swap in a richer rig later". Nobody ever did: two builds shipped creatures a
 * reviewer summed up as "no legs, not really walkers then are they", and the
 * reason both stopped there is that the prose let them.
 */

/** Footing a walker can stand on. Bare rock counts — see the header. */
const WALKABLE = new Set<MaterialType>([
  MaterialType.WALL, MaterialType.SAND, MaterialType.ROCK, MaterialType.ICE,
  MaterialType.WOOD, MaterialType.GRASS, MaterialType.SEED, MaterialType.TREE_TIP,
  MaterialType.LEAF, MaterialType.FERN_TIP, MaterialType.CORAL,
  MaterialType.FROND, MaterialType.TEPHRA,
]);
/** Buoyant but not breathable — bob and paddle. */
const LIQUID = new Set<MaterialType>([MaterialType.WATER, MaterialType.OIL]);
/** Instant death on contact. */
const DEADLY = new Set<MaterialType>([MaterialType.LAVA, MaterialType.FIRE, MaterialType.ACID]);

/** Slots created at boot; staggered timers establish the population fast. */
const DEFAULT_COUNT = 16;
const SPAWN_STAGGER_TICKS = 12;
/** Grid-px body height used for hazard/support sampling. */
const BODY_H = 12;
const GRAVITY = 0.06;
const MAX_FALL = 1.8;
/** Calm wander, tangential grid px/tick. */
const WALK_SPEED = 0.22;
const FLEE_SPEED = 0.62;
const SWIM_SPEED = 0.08;
const WANDER_MIN = 90;
const WANDER_MAX = 320;
const SUPPORT_GAP = 1.6;
const STEP_PROBE = 8;
const WALL_THRESHOLD = 5;
const RESPAWN_TICKS = 240;
const MAX_SPAWN_ATTEMPTS = 40;
/** How long a strike's memory keeps scaring nearby walkers. */
const FEAR_TICKS = 260;
/** Strike relevance radius in grid px. */
const FEAR_RADIUS = 120;
/**
 * Below STARE they carry on; between the two they freeze and stare; above FLEE
 * they run. Exported because an alternative look — `legged-walkers.ts` — has to
 * map the same thresholds onto its own gaze and mouth, and two copies of a
 * tuning value drift.
 */
export const FEAR_STARE = 0.2;
export const FEAR_FLEE = 0.5;

// --- the walk cycle -------------------------------------------------------
//
// Grid pixels. Sized against BODY_H (12) so the drawn creature matches the
// body the hazard probes sample: hip height plus the body above it comes to
// ~11px from the feet, which sits just inside it. Change these together or the
// feet stop reaching the ground.

/** Thigh and shin. Their sum is the leg's reach; HIP_HEIGHT is its rest height. */
const THIGH = 2.9;
const SHIN = 2.9;
/**
 * Hip height at rest, as a fraction under full reach. Legs start slightly bent
 * so the IK solver has room to extend on the swing — at full reach the knee
 * has no bend direction to resolve and the leg reads as a rigid stick.
 */
const HIP_HEIGHT = (THIGH + SHIN) * 0.86;
/**
 * How far the hip joint sits *inside* the body's lower edge.
 *
 * Zero looks wrong in a way that is easy to ship by accident: put the hips
 * exactly on the body's boundary and the rounded silhouette curves away from
 * them, leaving a visible sliver of background between body and legs. The
 * creature then reads as a head hovering over a pair of legs rather than as
 * one animal. Tucking the joint up inside the fill closes it at every point of
 * the stride, including the lean.
 */
const HIP_INSET = 1.5;
/** How far a foot swings fore/aft of the hip. Roughly one body width. */
const STRIDE_LENGTH = 2.6;
/** Peak toe clearance on the swing phase. */
const STRIDE_HEIGHT = 1.6;
/** Centre-to-centre foot distance in the idle stance. */
const FOOT_SPREAD = 3.4;
/** Hip separation. Narrower than the stance, so legs splay outward slightly. */
const HIP_SPREAD = 2.2;
const LEG_WIDTH = 1.5;
const FOOT_WIDTH = 1.2;
const FOOT_LENGTH = 1.4;
/** Body rise/fall over the stride, and the lean it carries into a run. */
const BODY_BOUNCE = 0.7;
const LEAN = 0.45;
const BODY_RX = 4.4;
const BODY_RY = 3.6;
/**
 * Ticks a walker takes to settle from a stride into a two-foot stance, and to
 * pick a stride back up. Ramping rather than switching is what stops a walker
 * freezing with one foot in the air the instant it stops.
 */
const STANCE_BLEND_TICKS = 8;
const OUTLINE = '#141a12';

export interface Walker {
  readonly seed: number;
  /** Fill colour, fixed at creation so individuals are recognizable. */
  readonly color: string;
  /**
   * Limb shades, near and far, derived from {@link color} at creation.
   *
   * Fixed dark greens were tried first and the legs vanished: at this scale a
   * limb is one or two pixels wide, and a colour picked to read against one
   * background reads as empty space against another. Tying the limbs to the
   * body's own hue keeps an individual coherent and keeps the legs visible on
   * any terrain, which matters more than it sounds — invisible legs are
   * indistinguishable from no legs, which is the bug this look exists to fix.
   */
  readonly limbNear: string;
  readonly limbFar: string;
  angle: number;
  radius: number;
  vRadial: number;
  facing: 1 | -1;
  walkSpeed: number;
  walking: boolean;
  wanderTimer: number;
  /** Smoothed fear in [0, 1] — drives the stare/flee states and the eye. */
  fear: number;
  /** Hop phase; advances with actual movement so idle bodies are still. */
  bobPhase: number;
  /**
   * How much of the striding pose is applied, 0..1. Ramps toward 1 while the
   * walker is covering ground and toward 0 when it stops, over
   * {@link STANCE_BLEND_TICKS} — see `drawSurfaceWalkers`.
   */
  locomotion: number;
  alive: boolean;
  respawnTimer: number;
}

export interface SurfaceWalkers {
  readonly list: readonly Walker[];
  readonly centerX: number;
  readonly centerY: number;
  readonly maxRadius: number;
  /** Internal: the dedicated behavior stream and the footing sets. */
  readonly rng: () => number;
  readonly footing: {
    readonly walkable: Set<MaterialType>;
    readonly liquid: Set<MaterialType>;
    readonly deadly: Set<MaterialType>;
  };
}

export interface SurfaceWalkersOptions {
  /** Planet centre in grid coordinates. */
  centerX: number;
  centerY: number;
  /** World seed — derives the walkers' dedicated RNG stream. */
  seed: number;
  /** Population established at boot (default 16, staggered over ~3s). */
  count?: number;
  /** Outermost radius probes scan inward from (default: to the grid edge). */
  maxRadius?: number;
  /** Override the footing sets (e.g. add a custom material). */
  walkable?: Set<MaterialType>;
  liquid?: Set<MaterialType>;
  deadly?: Set<MaterialType>;
}

/** A remembered strike: scares walkers near `(x, y)` for ~4s after `tick`. */
export interface StrikeMemory {
  x: number;
  y: number;
  tick: number;
}

/** A continuous threat while present, e.g. a live volcanic vent. */
export interface VentPoint {
  x: number;
  y: number;
}

export interface Threats {
  strikes?: readonly StrikeMemory[];
  vents?: readonly VentPoint[];
}

export function createSurfaceWalkers(
  engine: PixelEngine,
  opts: SurfaceWalkersOptions,
): SurfaceWalkers {
  const maxRadius = opts.maxRadius ?? Math.min(opts.centerX, opts.centerY) - 1;
  const rng = mulberry32((opts.seed * 7919 + 13) >>> 0);
  const list: Walker[] = [];
  const pop: SurfaceWalkers = {
    list,
    centerX: opts.centerX,
    centerY: opts.centerY,
    maxRadius,
    rng,
    footing: {
      walkable: opts.walkable ?? WALKABLE,
      liquid: opts.liquid ?? LIQUID,
      deadly: opts.deadly ?? DEADLY,
    },
  };
  const count = opts.count ?? DEFAULT_COUNT;
  for (let i = 0; i < count; i++) {
    const seed = (rng() * 0xffffffff) >>> 0;
    const hue = 96 + (seed % 1000) / 1000 * 80; // green → teal → mint
    const h = hue.toFixed(0);
    const light = 46 + (seed % 97) / 97 * 12;
    list.push({
      seed,
      color: `hsl(${h}, 62%, ${light.toFixed(0)}%)`,
      // Two steps down in lightness, up in saturation: reads as the same
      // creature in shadow rather than as a different material.
      limbNear: `hsl(${h}, 48%, ${(light - 17).toFixed(0)}%)`,
      limbFar: `hsl(${h}, 44%, ${(light - 27).toFixed(0)}%)`,
      angle: 0,
      radius: opts.centerY,
      vRadial: 0,
      facing: rng() < 0.5 ? 1 : -1,
      walkSpeed: WALK_SPEED * (0.8 + rng() * 0.4),
      walking: true,
      wanderTimer: WANDER_MIN + rng() * (WANDER_MAX - WANDER_MIN),
      fear: 0,
      bobPhase: rng() * Math.PI,
      locomotion: 0,
      alive: false,
      // Staggered boot spawn: the whole population within a few seconds.
      respawnTimer: i * SPAWN_STAGGER_TICKS,
    });
  }
  // Establish the population immediately where the terrain allows it.
  const f = pop.footing;
  for (const w of list) {
    if (w.respawnTimer === 0) trySpawn(engine, pop, w, f.walkable, f.liquid, f.deadly, rng);
  }
  return pop;
}

export function aliveWalkers(pop: SurfaceWalkers): number {
  let n = 0;
  for (const w of pop.list) if (w.alive) n++;
  return n;
}

/** Material of the grid cell `radius` px from the centre along `angle`. */
function matAtRadius(
  engine: PixelEngine,
  pop: SurfaceWalkers,
  angle: number,
  radius: number,
): MaterialType {
  const x = Math.round(pop.centerX + radius * Math.cos(angle));
  const y = Math.round(pop.centerY + radius * Math.sin(angle));
  if (x < 0 || x >= engine.width || y < 0 || y >= engine.height) return MaterialType.EMPTY;
  return engine.getMaterial(x, y);
}

/**
 * Outermost walkable radius along `angle`, scanning inward from `fromRadius`.
 * Returns 1 if nothing walkable remains — the rock core makes that
 * unreachable in practice, and 1 parks a walker at the centre rather than NaN.
 */
function sampleSurface(
  engine: PixelEngine,
  pop: SurfaceWalkers,
  angle: number,
  fromRadius: number,
  walkable: Set<MaterialType>,
): number {
  for (let r = Math.min(fromRadius, pop.maxRadius); r > 1; r--) {
    if (walkable.has(matAtRadius(engine, pop, angle, r))) return r;
  }
  return 1;
}

function trySpawn(
  engine: PixelEngine,
  pop: SurfaceWalkers,
  w: Walker,
  walkable: Set<MaterialType>,
  liquid: Set<MaterialType>,
  deadly: Set<MaterialType>,
  rng: () => number,
): boolean {
  for (let i = 0; i < MAX_SPAWN_ATTEMPTS; i++) {
    const angle = rng() * Math.PI * 2;
    // Any walkable footing — bare rock counts. This is the spawn contract.
    const surface = sampleSurface(engine, pop, angle, pop.maxRadius, walkable);
    if (surface <= 1) continue;
    const chest = matAtRadius(engine, pop, angle, surface + 4);
    const head = matAtRadius(engine, pop, angle, surface + BODY_H - 4);
    if (liquid.has(chest) || liquid.has(head)) continue;
    if (deadly.has(chest) || deadly.has(head)) continue;
    w.angle = angle;
    w.radius = surface + 0.5;
    w.vRadial = 0;
    w.fear = 0;
    w.walking = true;
    w.wanderTimer = WANDER_MIN + rng() * (WANDER_MAX - WANDER_MIN);
    w.facing = rng() < 0.5 ? 1 : -1;
    w.alive = true;
    return true;
  }
  return false;
}

function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * One fixed 1/60s step. `threats` carries your power code's state: strike
 * memories (each scares its neighbourhood as it decays) and live vents
 * (continuous threat while present). `tick` is the game tick, used only to
 * age strike memories.
 */
export function stepSurfaceWalkers(
  engine: PixelEngine,
  pop: SurfaceWalkers,
  threats: Threats,
  tick: number,
): void {
  const { walkable, liquid, deadly } = pop.footing;
  const rng = pop.rng;

  for (const w of pop.list) {
    if (!w.alive) {
      if (--w.respawnTimer <= 0) {
        // On success the timer is ignored while alive and reset at the next
        // death; on failure (no footing found) retry shortly.
        w.respawnTimer = trySpawn(engine, pop, w, walkable, liquid, deadly, rng)
          ? RESPAWN_TICKS
          : 30;
      }
      continue;
    }

    const feet = matAtRadius(engine, pop, w.angle, w.radius - 0.5);
    const chest = matAtRadius(engine, pop, w.angle, w.radius + BODY_H / 2);
    const head = matAtRadius(engine, pop, w.angle, w.radius + BODY_H - 4);

    if (deadly.has(feet) || deadly.has(chest) || deadly.has(head)) {
      w.alive = false;
      w.respawnTimer = RESPAWN_TICKS;
      continue;
    }

    let gridDx = 0;
    let supported = false;
    let swimming = false;

    if (liquid.has(chest)) {
      // Walkers don't drown — bob contentedly until the liquid drains.
      swimming = true;
      const floor = sampleSurface(engine, pop, w.angle, w.radius + BODY_H, walkable);
      w.vRadial += (-0.12 - w.vRadial) * 0.08;
      w.radius -= w.vRadial;
      if (w.radius < floor + 0.5) {
        w.radius = floor + 0.5;
        w.vRadial = 0;
      }
      if (--w.wanderTimer <= 0) {
        w.wanderTimer = WANDER_MIN + rng() * (WANDER_MAX - WANDER_MIN);
        if (rng() < 0.5) w.facing = -w.facing as 1 | -1;
      }
      w.angle += (w.facing * SWIM_SPEED) / Math.max(w.radius, 30);
      gridDx = SWIM_SPEED * w.facing;
    } else {
      if (walkable.has(chest)) {
        // Walked into a slope — snap up onto the new surface.
        w.radius = sampleSurface(engine, pop, w.angle, w.radius + BODY_H + 6, walkable) + 0.5;
        w.vRadial = 0;
      }
      const ground = sampleSurface(engine, pop, w.angle, w.radius + BODY_H, walkable);
      supported = w.radius - ground < SUPPORT_GAP;

      if (supported) {
        w.radius = ground + 0.5;
        w.vRadial = 0;
        if (--w.wanderTimer <= 0) {
          w.wanderTimer = WANDER_MIN + rng() * (WANDER_MAX - WANDER_MIN);
          w.walking = rng() < 0.6;
          if (rng() < 0.5) w.facing = -w.facing as 1 | -1;
        }
        if (w.walking) {
          const aheadAngle = w.angle + (w.facing * STEP_PROBE) / Math.max(w.radius, 30);
          const aheadGround = sampleSurface(engine, pop, aheadAngle, w.radius + BODY_H, walkable);
          if (aheadGround > ground + WALL_THRESHOLD) {
            w.facing = -w.facing as 1 | -1;
          } else {
            w.angle += (w.facing * w.walkSpeed) / w.radius;
            gridDx = w.walkSpeed * w.facing;
          }
        }
      } else {
        w.vRadial = Math.min(w.vRadial + GRAVITY, MAX_FALL);
        w.radius -= w.vRadial;
        if (w.radius <= ground + 0.5) {
          w.radius = ground + 0.5;
          supported = true;
          w.vRadial = 0;
        }
      }
    }

    // --- fear: nearest threat → stare → flee -----------------------------
    const fx = pop.centerX + w.radius * Math.cos(w.angle);
    const fy = pop.centerY + w.radius * Math.sin(w.angle);
    let targetFear = 0;
    let threatX = 0, threatY = 0, haveThreat = false;
    const consider = (tx: number, ty: number, f: number): void => {
      if (f <= 0) return;
      const nearer = haveThreat &&
        Math.hypot(fx - tx, fy - ty) < Math.hypot(fx - threatX, fy - threatY);
      if (f > targetFear || (f === targetFear && nearer) || !haveThreat) {
        targetFear = Math.max(targetFear, f);
        threatX = tx;
        threatY = ty;
        haveThreat = true;
      }
    };
    if (threats.strikes) {
      for (const s of threats.strikes) {
        const age = tick - s.tick;
        if (age < 0 || age >= FEAR_TICKS) continue;
        consider(s.x, s.y,
          Math.min(1, 1.3 - Math.hypot(fx - s.x, fy - s.y) / FEAR_RADIUS) * (1 - age / FEAR_TICKS));
      }
    }
    if (threats.vents) {
      for (const v of threats.vents) {
        consider(v.x, v.y, Math.min(1, 1.3 - Math.hypot(fx - v.x, fy - v.y) / FEAR_RADIUS));
      }
    }
    const threat = haveThreat ? { x: threatX, y: threatY } : null;
    if (!supported && !swimming) targetFear = Math.max(targetFear, 0.5); // falling
    w.fear += (targetFear - w.fear) * 0.12;

    if (w.fear > FEAR_FLEE && supported && !swimming) {
      // Panic: run away from the threat, hopping.
      if (threat) {
        const da = wrapPi(Math.atan2(threat.y - pop.centerY, threat.x - pop.centerX) - w.angle);
        w.facing = da >= 0 ? -1 : 1;
      }
      w.walking = true;
      const ground = sampleSurface(engine, pop, w.angle, w.radius + BODY_H, walkable);
      const aheadAngle = w.angle + (-w.facing * STEP_PROBE) / Math.max(w.radius, 30);
      const aheadGround = sampleSurface(engine, pop, aheadAngle, w.radius + BODY_H, walkable);
      if (aheadGround > ground + WALL_THRESHOLD) {
        w.facing = -w.facing as 1 | -1; // cornered — flee the other way
      } else {
        w.angle += (w.facing * FLEE_SPEED) / w.radius;
        gridDx = FLEE_SPEED * w.facing;
      }
    } else if (w.fear > FEAR_STARE && supported && !swimming && threat) {
      // Freeze and stare at the threat.
      w.walking = false;
      gridDx = 0;
      const da = wrapPi(Math.atan2(threat.y - pop.centerY, threat.x - pop.centerX) - w.angle);
      w.facing = da >= 0 ? 1 : -1;
    }

    w.bobPhase += Math.abs(gridDx) * 0.9;
    // Ramp the drawn stride with whether the walker is actually covering
    // ground, not with its `walking` intent: a walker pressed against a wall
    // still intends to walk, and should not be striding on the spot.
    const target = Math.abs(gridDx) > 0.001 ? 1 : 0;
    w.locomotion += (target - w.locomotion) / STANCE_BLEND_TICKS;
    w.locomotion = Math.max(0, Math.min(1, w.locomotion));
    if (w.angle < 0) w.angle += Math.PI * 2;
    if (w.angle >= Math.PI * 2) w.angle -= Math.PI * 2;
  }
}

/**
 * **Bring-up placeholder. Do not ship this.** Use `drawRiggedWalkers` from
 * [`legged-walkers.ts`](./legged-walkers.ts) instead — see the file header.
 *
 * Draw the population in grid space — call under the camera transform (after
 * the planet blit, before UI).
 *
 * ## Why this exists at all, and why it is not the answer
 *
 * `aicraft-pixel-engine` ships with zero runtime dependencies, and this recipe
 * has to be usable the moment it is copied in — before the host has installed
 * `aicraft-engine` or copied the rig. So there is a look here. It is a
 * stopgap for that gap and nothing more.
 *
 * Everything below re-derives, worse, code that `aicraft-engine` already
 * ships: `solveKnee` is a poorer `solveLimb`, the `bobPhase` stride is a
 * poorer `advanceLocomotionByDisplacement`, the `locomotion` ramp is a poorer
 * `blendLocomotionToStance`. It has no antenna physics, no breathing, no mouth,
 * no generated palette, and no tuning behind its proportions. A build that
 * ships it has hand-rolled its creatures, which is the failure the whole
 * §8.5 section of the brief exists to prevent.
 *
 * The first version of this function drew an ellipse with an eye on it, and
 * two independent builds shipped creatures a reviewer described as "no legs,
 * not really walkers then are they" — one by copying this file, one by
 * reinventing it from the same prose. Legs alone were not the fix; the fix is
 * the rig. What follows is at least honest about being a placeholder.
 *
 * Three properties keep it from reading as a sliding decal, and they are the
 * same three the library implements properly:
 *
 *  1. **The stride is driven by distance, not by time.** `bobPhase` advances
 *     with `|gridDx|` in {@link stepSurfaceWalkers}, so feet cover exactly the
 *     ground the body covers. A time-driven phase skates — the classic
 *     foot-sliding tell — and skating looks worse than not animating at all.
 *  2. **Idle blends to a stance.** Cutting locomotion dead the instant a
 *     walker stops leaves one foot frozen in mid-air. The pose lerps toward a
 *     neutral two-foot stance instead, over {@link STANCE_BLEND_TICKS}.
 *  3. **The knee bends forward.** The IK solver has two solutions and picking
 *     the wrong one per-frame makes the joint pop inside out; the bend is
 *     pinned to the facing direction.
 *
 * The rest — squash on the hop, a gazing eye that looks at the threatening sky
 * when afraid, a blink — is the same as it was.
 */
export function drawSurfaceWalkers(
  ctx: CanvasRenderingContext2D,
  pop: SurfaceWalkers,
  tick: number,
): void {
  for (const w of pop.list) {
    if (!w.alive) continue;
    const fx = pop.centerX + w.radius * Math.cos(w.angle);
    const fy = pop.centerY + w.radius * Math.sin(w.angle);

    // Local frame: +x is the facing tangent, -y points at the sky, y = 0 is
    // the ground contact line the feet plant on.
    ctx.save();
    ctx.translate(fx, fy);
    ctx.rotate(w.angle + Math.PI / 2);

    const pose = walkerPose(w);
    drawShadow(ctx, pose);
    drawLegs(ctx, w, pose);
    drawBody(ctx, w, pose, tick);

    ctx.restore();
  }
}

/** Resolved per-frame pose: where the feet are and how the body rides. */
interface WalkerPose {
  /** Foot targets in the local frame, `[x, y]` with y <= 0. */
  readonly feet: readonly [readonly [number, number], readonly [number, number]];
  /** Hip line height (negative = above ground). */
  readonly hipY: number;
  /** Body centre height. */
  readonly bodyY: number;
  /** Horizontal lean, positive = leaning into the facing direction. */
  readonly lean: number;
  /** Vertical squash, 1 = neutral. */
  readonly squash: number;
}

/**
 * Resolve the gait for one walker.
 *
 * `locomotion` is how much of the striding pose to apply, ramped rather than
 * switched: a walker that stops mid-stride settles into a stance over
 * {@link STANCE_BLEND_TICKS} instead of freezing with a foot in the air. It is
 * advanced in {@link stepSurfaceWalkers} alongside `bobPhase`, so this stays a
 * pure read of walker state and the draw pass writes nothing.
 */
function walkerPose(w: Walker): WalkerPose {
  const locomotion = w.locomotion;
  const phase = w.bobPhase;
  const stride = w.fear > FEAR_FLEE ? STRIDE_LENGTH * 1.35 : STRIDE_LENGTH;
  const lift = w.fear > FEAR_FLEE ? STRIDE_HEIGHT * 1.5 : STRIDE_HEIGHT;

  const feet: [number, number][] = [];
  for (let i = 0; i < 2; i++) {
    const p = phase + (i === 0 ? 0 : Math.PI);
    // Stance target: feet planted either side of the midline, toes forward.
    const stanceX = (i === 0 ? -1 : 1) * (FOOT_SPREAD / 2);
    const strideX = w.facing * stride * Math.cos(p);
    const strideY = -Math.max(0, Math.sin(p)) * lift;
    feet.push([
      stanceX * (1 - locomotion) + strideX * locomotion,
      strideY * locomotion,
    ]);
  }

  // The body rides the gait: it rises when both legs are near mid-stance and
  // dips at footfall, at twice the stride frequency.
  const bounce = -Math.abs(Math.sin(phase)) * BODY_BOUNCE * locomotion;
  const squash = 1 + 0.10 * Math.sin(phase * 2) * locomotion;
  const hipY = -HIP_HEIGHT + bounce;
  return {
    feet: feet as unknown as WalkerPose['feet'],
    hipY,
    // Body rides the hips, overlapping them by HIP_INSET so the join closes.
    bodyY: hipY - BODY_RY + HIP_INSET,
    lean: w.facing * LEAN * locomotion * (w.fear > FEAR_FLEE ? 2 : 1),
    squash,
  };
}

/**
 * Two-bone IK: given a hip and a foot, find the knee.
 *
 * The two-solution ambiguity is resolved by `bend`, which is the facing
 * direction — a knee that picks its solution from the geometry alone flips
 * inside out as the foot crosses under the hip, once per stride, and reads as
 * a snapped leg. Out-of-reach targets are clamped rather than left unsolved,
 * so the leg straightens instead of detaching.
 */
function solveKnee(
  hipX: number, hipY: number,
  footX: number, footY: number,
  thigh: number, shin: number,
  bend: number,
): [number, number] {
  let dx = footX - hipX;
  let dy = footY - hipY;
  let d = Math.hypot(dx, dy);
  const min = Math.abs(thigh - shin) + 0.001;
  const max = thigh + shin - 0.001;
  if (d < min) { const s = min / (d || 1); dx *= s; dy *= s; d = min; }
  if (d > max) { const s = max / d; dx *= s; dy *= s; d = max; }
  const a = (thigh * thigh - shin * shin + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, thigh * thigh - a * a));
  const ux = dx / d, uy = dy / d;
  return [hipX + ux * a - uy * h * bend, hipY + uy * a + ux * h * bend];
}

function drawShadow(ctx: CanvasRenderingContext2D, pose: WalkerPose): void {
  ctx.fillStyle = 'rgba(8, 12, 20, 0.28)';
  ctx.beginPath();
  ctx.ellipse(0, 0.4, 4.4, 1.2, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawLegs(ctx: CanvasRenderingContext2D, w: Walker, pose: WalkerPose): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Far leg first, so the near one overlaps it and the pair reads as depth
  // rather than as one leg with a glitch.
  const order: (0 | 1)[] = (w.facing > 0) === (pose.feet[0][0] < pose.feet[1][0])
    ? [0, 1]
    : [1, 0];
  for (const i of order) {
    const [footX, footY] = pose.feet[i];
    const near = i === order[1];
    const hipX = (i === 0 ? -1 : 1) * HIP_SPREAD / 2 + pose.lean * 0.5;
    const [kneeX, kneeY] = solveKnee(
      hipX, pose.hipY, footX, footY, THIGH, SHIN, w.facing,
    );

    const limb = new Path2D();
    limb.moveTo(hipX, pose.hipY);
    limb.lineTo(kneeX, kneeY);
    limb.lineTo(footX, footY);
    const foot = new Path2D();
    foot.moveTo(footX - w.facing * 0.5, footY);
    foot.lineTo(footX + w.facing * FOOT_LENGTH, footY);

    // Outline pass then fill pass, the pixel-art way: a dark stroke one step
    // wider under the colour keeps a two-pixel limb legible against terrain of
    // any brightness.
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = LEG_WIDTH + 0.9;
    ctx.stroke(limb);
    ctx.lineWidth = FOOT_WIDTH + 0.9;
    ctx.stroke(foot);

    ctx.strokeStyle = near ? w.limbNear : w.limbFar;
    ctx.lineWidth = LEG_WIDTH;
    ctx.stroke(limb);
    ctx.lineWidth = FOOT_WIDTH;
    ctx.stroke(foot);
  }
}

function drawBody(
  ctx: CanvasRenderingContext2D,
  w: Walker,
  pose: WalkerPose,
  tick: number,
): void {
  const rx = BODY_RX / pose.squash;
  const ry = BODY_RY * pose.squash;
  ctx.save();
  ctx.translate(pose.lean, pose.bodyY);

  ctx.fillStyle = w.color;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  const blink = ((tick + (w.seed % 1024)) % 260) < 9;
  const eyeX = 1.1 * w.facing;
  const eyeY = -0.9;
  if (!blink) {
    // Pupil forward when calm, up at the threatening sky when afraid.
    const px = w.fear > FEAR_STARE ? 0.3 : 1.0 * w.facing;
    const py = w.fear > FEAR_STARE ? -0.9 : -0.2;
    ctx.fillStyle = '#f4f7ee';
    ctx.beginPath();
    ctx.ellipse(eyeX, eyeY, 1.5, 1.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = OUTLINE;
    ctx.beginPath();
    ctx.ellipse(eyeX + px, eyeY + py, 0.62, 0.72, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(eyeX - 1.1, eyeY);
    ctx.lineTo(eyeX + 1.1, eyeY);
    ctx.stroke();
  }
  ctx.restore();
}
