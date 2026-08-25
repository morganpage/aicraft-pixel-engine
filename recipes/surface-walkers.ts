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
 * draw under the camera transform in grid space. The look is a minimal
 * body + eye + hop — swap in a richer rig later; the behavior is the part
 * worth not reinventing.
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
/** Below STARE they carry on; between the two they freeze and stare; above FLEE they run. */
const FEAR_STARE = 0.2;
const FEAR_FLEE = 0.5;

export interface Walker {
  readonly seed: number;
  /** Fill colour, fixed at creation so individuals are recognizable. */
  readonly color: string;
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
    list.push({
      seed,
      color: `hsl(${hue.toFixed(0)}, 62%, ${(46 + (seed % 97) / 97 * 12).toFixed(0)}%)`,
      angle: 0,
      radius: opts.centerY,
      vRadial: 0,
      facing: rng() < 0.5 ? 1 : -1,
      walkSpeed: WALK_SPEED * (0.8 + rng() * 0.4),
      walking: true,
      wanderTimer: WANDER_MIN + rng() * (WANDER_MAX - WANDER_MIN),
      fear: 0,
      bobPhase: rng() * Math.PI,
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
    if (w.angle < 0) w.angle += Math.PI * 2;
    if (w.angle >= Math.PI * 2) w.angle -= Math.PI * 2;
  }
}

/**
 * Draw the population in grid space — call under the camera transform
 * (after the planet blit, before UI). Minimal look: squash-and-stretch hop
 * body, gazing eye that looks at the sky when afraid, blink.
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
    const hop = Math.abs(Math.sin(w.bobPhase)) * 2;
    const stretch = 1 + 0.14 * Math.sin(w.bobPhase * 2);
    const blink = ((tick + (w.seed % 1024)) % 260) < 9;
    // Local frame: +x is the facing tangent, -y points at the sky.
    ctx.save();
    ctx.translate(fx, fy);
    ctx.rotate(w.angle + Math.PI / 2);
    ctx.translate(0, -hop);
    ctx.fillStyle = w.color;
    ctx.strokeStyle = 'rgba(18, 28, 14, 0.85)';
    ctx.lineWidth = 0.75;
    ctx.beginPath();
    ctx.ellipse(0, 0, 4.6 * stretch, 5.4 / stretch, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Eye: forward when calm, up at the threatening sky when afraid.
    if (!blink) {
      const px = w.fear > FEAR_STARE ? 0.3 : 1.1;
      const py = w.fear > FEAR_STARE ? -0.9 : -0.2;
      ctx.fillStyle = '#f4f7ee';
      ctx.beginPath();
      ctx.ellipse(1.2 * w.facing, -1.4, 1.7, 1.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1c2418';
      ctx.beginPath();
      ctx.ellipse(1.2 * w.facing + px, -1.4 + py, 0.7, 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = '#1c2418';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(0.1 * w.facing, -1.4);
      ctx.lineTo(2.3 * w.facing, -1.4);
      ctx.stroke();
    }
    ctx.restore();
  }
}
