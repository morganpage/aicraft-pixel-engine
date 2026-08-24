/**
 * The canonical slime-knight — a single composed character built from library
 * primitives. One seed produces one character forever: palette, body
 * proportions, gait rhythm, antenna physics, and breathing amplitudes are all
 * derived deterministically from the seed.
 *
 * Composition stack:
 *   - Body:    rounded-rectangle squircle (flat fill + chunky outline pass).
 *   - Eye:     canvas circle in `palette.feature` + outline pupil + white
 *              highlight (matches the in-game-shapes aesthetic). The pupil
 *              offsets toward a per-frame gaze vector (`look`) so the eye
 *              tracks the travel direction, and the face renders as 1 eye
 *              (cyclops, the default) or 2 eyes (showcase toggle).
 *   - Legs:    two 2-bone IK limbs via `solveLimb`, driven by foot targets
 *              from `evaluateLocomotion`.
 *   - Antenna: a Verlet spring chain via `advanceSpringChain`, anchored at
 *              the body top and swaying under gravity + hip motion.
 *   - Breath:  volume-preserving scale via `breathe` / `volumeScale`, applied
 *              around the body center.
 *
 * Ported from `aicraft-engine/showcase/helpers/slime-knight.ts` (same repo
 * family) with imports rewritten to the installed `aicraft-engine` package —
 * the library provides the building blocks; this file assembles them. Kept
 * close to the original so the two can be diffed/synced.
 */

import {
  breathe,
  advanceSpringChain,
  advanceLocomotion,
  advanceLocomotionByDisplacement,
  advanceJump,
  createJumpState,
  evaluateLocomotion,
  evaluateJump,
  blendAirborneTuck,
  blendLocomotionToStance,
  solveLimb,
  DEFAULT_BREATH,
  DEFAULT_GAIT,
  DEFAULT_JUMP,
  DEFAULT_SPRING,
  DEFAULT_TUCK,
  type BreathConfig,
  type GaitConfig,
  type JumpInputs,
  type JumpState,
  type LocomotionState,
  type LocomotionPose,
  type SpringConfig,
  type VerletNode,
} from 'aicraft-engine';
import { DEFAULT_OUTLINE_COLOR, lerp } from 'aicraft-engine';
import { mulberry32, nextFloat, nextInt } from 'aicraft-engine';
import { generatePalette, type Palette } from 'aicraft-engine';

// ---------------------------------------------------------------------------
// Layout constants — canvas-local. Tunable.
// ---------------------------------------------------------------------------

/** Hero canvas size (square). The character is composed in this coordinate space. */
export const HERO_CANVAS_SIZE = 320;

/** Body center X (canvas px). */
const HERO_CENTER_X = HERO_CANVAS_SIZE / 2;

/**
 * Vertical position of the foot-plant line (canvas px). Fixed regardless of
 * seed so the shadow and ground line (drawn by the section) never drift from
 * where the feet actually land. Exported so `sections/hero.ts` draws the
 * ground line + shadow at exactly this Y.
 *
 * Ratio 0.82: the feet plant ~262px down the 320px canvas, leaving ~58px of
 * headroom above the body for the antenna ball + bounce arc. Since
 * `heroCenterY(config)` is derived from `HERO_GROUND_Y`, the body / head /
 * antenna all anchor to this line.
 */
export const HERO_GROUND_Y = HERO_CANVAS_SIZE * 0.82;

/**
 * Body center Y for a given config, derived FROM the ground line so the
 * feet always plant on `HERO_GROUND_Y` at rest. Working up from the ground:
 *   ground  = hip + reach
 *   hip     = bodyCenter + bodyHeight/2
 *   → bodyCenter = ground − bodyHeight/2 − reach
 *
 * Per-seed body heights and bone lengths move the body center up/down, but
 * the feet stay anchored to the ground line.
 */
function heroCenterY(config: HeroConfig): number {
  const reach =
    (config.boneLengths.thigh + config.boneLengths.shin) * LEG_REACH_RATIO;
  return HERO_GROUND_Y - config.bodyHeight / 2 - reach;
}

/** Outline width (canvas px) used for the chunky Sokpop outline pass. */
const CHUNKY_OUTLINE_WIDTH = 3;

/**
 * Ratio of the hip→foot vertical distance to the total leg-bone length.
 *
 * `0.9` means the legs start slightly bent (foot distance is 90% of full
 * reach), so `solveLimb` produces a natural knee bend at rest and has room
 * to compress during the walk cycle without fully extending.
 */
const LEG_REACH_RATIO = 0.9;

/**
 * Time in seconds for the hero's feet to settle to a neutral standing pose
 * when the hero stops walking (walkDx === 0). The locomotion phase freezes on
 * stop; without this blend, the feet would freeze mid-stride (one foot in the
 * air). The blend ramps the locomotion foot + hip offsets toward neutral
 * (0,0) over this duration so both feet lower to the ground smoothly.
 *
 * 0.2s = 12 frames at 60fps — fast enough to feel responsive, slow enough to
 * look like a natural settle rather than a snap. Tunable.
 */
const IDLE_SETTLE_TIME = 0.2;

/**
 * Off-screen buffer added to `bodyWidth/2` when the hero walks off one canvas
 * edge and reappears at the other. With co-located hips (Change B) and the
 * forward-foot shoe offset (Change C), the forward foot's WORST-CASE reach
 * from the body center is `strideLength + shoeForward + shoeW/2 = 18 + 10.4 +
 * 13 = 41.4px` (max post-jitter strideLength 4 × 4.5 = 18; shoeForward 0.4 ×
 * 26 = 10.4; half of the 26-wide shoe = 13). The wrap fires at `bodyWidth/2
 * + 16 = 51-61px` (bodyWidth 70-90), so even the longest-striding seed
 * clears the foot by 9.6-19.6px — the foot never pokes past the wrap edge
 * and the hero fully exits the frame before reappearing on the opposite side.
 */
const HERO_WALK_WRAP_MARGIN_FOOT = 16;

/**
 * Gap between the lowered body's bottom edge and the ground line at rest, in
 * `'simpleFeet'` mode (canvas px). The simple-feet alternative has no IK legs,
 * so the body drops down to sit near the ground (`simpleBodyShiftDown` removes
 * the IK leg-reach headroom); this constant is the residual visible gap between
 * the body bottom and `HERO_GROUND_Y`.
 *
 * The feet are GROUND-ANCHORED (`drawHeroSimpleFeet` draws each foot with its
 * bottom on `HERO_GROUND_Y`), so `PEEK` controls the air gap between the body
 * bottom and the top of each foot: the body bottom sits `PEEK` px above the
 * ground, the foot top sits `SIMPLE_FEET_FOOT_H` px (= 20) above the ground.
 * When `PEEK > SIMPLE_FEET_FOOT_H` there is a visible AIR GAP of
 * `PEEK − SIMPLE_FEET_FOOT_H` px between the body bottom and each foot's top,
 * and the full `SIMPLE_FEET_FOOT_H` of each foot is visible below the gap.
 *
 * 26px: with SIMPLE_FEET_FOOT_H = 20, the body bottom sits 26px above the
 * ground and each foot top sits 20px above it → a 6px visible AIR GAP between
 * the body and the top of each foot, with the full 20px of each foot visible
 * below the gap. Reads as the blob hovering above its shoes — a clean cartoon
 * silhouette for a slime character. Tunable (one constant).
 */
const SIMPLE_FEET_BODY_PEEK = 26;

/**
 * Simple-feet dimensions — 4× the playground's small devil feet (7×5).
 * The hero canvas is 320px and the body is 70–90px wide, so 28×20px feet read
 * as substantial planted shoes rather than tiny dots.
 *
 * `SIMPLE_FEET_IDLE_SPREAD = 0` matches the engine's `IK_PARITY_FEET` preset:
 * both feet center on the body midline and the locomotion pose's
 * `cos(phase) · strideLength` term drives them symmetrically across it. At
 * each footfall endpoint the feet have equal magnitude from the midline on
 * opposite sides and swap sides each half-cycle — the same foot-target
 * trajectory as the full IK rig with co-located hips, drawn with this
 * showcase-local chunky rounded-rect renderer. See the simple-feet gait
 * decision (`docs/design/simple-feet-gait-decision.md`).
 */
const SIMPLE_FEET_FOOT_W = 28;
const SIMPLE_FEET_FOOT_H = 20;
const SIMPLE_FEET_IDLE_SPREAD = 0;

/**
 * Total center-to-center foot distance at full idle stance (px). The stance
 * target for each foot is `±HERO_IDLE_FOOT_SPREAD / 2` from the body
 * midline. `footW + desiredGap` (= 28 + 2 = 30) yields a tight 2 px visible
 * gap between the inner edges of the two foot rectangles at full blend:
 * each foot sits `±15 px` from the midline, inner edges at `±1 px`, total
 * gap = 2 px. Matches the locked semantics in
 * `docs/design/idle-foot-stance-decision.md` (hero spread = 30) and feeds
 * `blendLocomotionToStance` in `drawSlimeKnight`. Tunable — raise for a
 * wider stance, lower for feet that almost touch.
 */
const HERO_IDLE_FOOT_SPREAD = SIMPLE_FEET_FOOT_W + 2;

/**
 * Corner radius for the simple-feet rounded rects. Matches the body squircle's
 * ~20% corner ratio (0.2 × SIMPLE_FEET_FOOT_H = 4), so the feet share the
 * body's soft silhouette rather than reading as sharp mechanical boxes.
 */
const SIMPLE_FEET_CORNER_RADIUS = 4;

// ---------------------------------------------------------------------------
// HERO_RANGES — every tunable magic number lives here.
// ---------------------------------------------------------------------------

/**
 * Tunable generation ranges for the hero. Consumers can override individual
 * fields by spreading their own config.
 *
 * `base + nextInt(rng, 0, jitter)` produces an inclusive `[base, base+jitter]`
 * range. `lerp(min, max, nextFloat(rng, 0, 1))` produces a continuous
 * `[min, max)` range.
 */
export const HERO_RANGES = {
  bodyWidth: { base: 70, jitter: 20 }, // [70, 90]
  bodyHeight: { base: 60, jitter: 16 }, // [60, 76]
  eyeRadius: { base: 13, jitter: 5 }, // [13, 18]
  thigh: { base: 22, jitter: 8 }, // [22, 30]
  shin: { base: 20, jitter: 8 }, // [20, 28]
  antennaSegments: { base: 3, jitter: 3 }, // [3, 6]
  antennaSegmentLength: { base: 9, jitter: 5 }, // [9, 14]
  gaitFrequencyMul: { min: 0.8, max: 1.2 }, // × DEFAULT_GAIT.baseFrequency
  // Bigger steps: {1.5, 2.5} → {3.0, 4.5} so feet swing further forward/back
  // (post-jitter stride DEFAULT_GAIT.strideLength(4) × [3.0, 4.5] = 12-18px,
  // vs 6-10px before — a clearly bigger step, still well within the ~70-90px
  // body width). The wider splay is what makes the legs visibly cross during
  // the walk cycle. RNG draw type unchanged (still nextFloat → lerp); only
  // the lerp endpoints moved.
  gaitStrideLenMul: { min: 3.0, max: 4.5 }, // × DEFAULT_GAIT.strideLength
  // Proportional lift bump: {0.6, 1.4} → {1.5, 2.5} so bigger strides read as
  // real steps (post-jitter lift DEFAULT_GAIT.strideHeight(3) × [1.5, 2.5] =
  // 4.5-7.5px), not flat shuffling feet.
  gaitStrideHtMul: { min: 1.5, max: 2.5 }, // × DEFAULT_GAIT.strideHeight
  gaitHipBobMul: { min: 0.5, max: 1.5 }, // × DEFAULT_GAIT.hipBobHeight
  gaitHipSwayMul: { min: 0.5, max: 1.5 }, // × DEFAULT_GAIT.hipSwayWidth
  springGravityMul: { min: 0.8, max: 1.2 }, // × DEFAULT_SPRING.gravityY
  springDrag: { min: 0.92, max: 0.98 },
  breathFreqMul: { min: 0.8, max: 1.2 }, // × DEFAULT_BREATH.frequency
  breathAmpMul: { min: 0.7, max: 1.3 }, // × DEFAULT_BREATH.amplitude
} as const;

// ---------------------------------------------------------------------------
// Antenna physics tuning — showcase-local springy-rod model
// ---------------------------------------------------------------------------
//
// Target read: "ball on the end of a springy, bendy metal rod." The antenna
//   1. leans slightly FORWARD (in the facing direction);
//   2. is springy/bendy, NOT a rigid mast;
//   3. has a weighted ball at the tip that SAGS under its own weight and
//      BOUNCES during walk/jump (velocity-driven, not just static sag);
//   4. does NOT flop like a scarf (issue #4 — the original problem the old
//      singleton `ANTENNA_STIFFNESS = 0.7` rigidity was added to fix).
//
// The new model replaces that singleton with FOUR named constants composed
// across two showcase-local passes run AFTER the library `advanceSpringChain`
// step in `stepHero`:
//   - `applyAntennaRestPose`  — directional spring toward a forward-tilted
//     rest vector, with BASE→TIP tapered stiffness (below).
//   - `applyAntennaTipWeight` — positional downward nudge proportional to
//     node position along the chain (the ball's weight bending the rod).
//
// The base>tip stiffness ordering + the tip-weight gradient compound toward
// the tip → sag concentrates at the tip → "rod bending under a point load,"
// not tentacle/whip. This is the middle ground between the old rigid mast
// (too stiff, no life) and the original un-stiffened scarf-flop (issue #4):
// springy but not floppy. All four values are starting points — the
// benchmarker may tune. They are named constants so tuning is a one-line
// change per value.

/**
 * Antenna directional spring — base stiffness. The showcase-local
 * `applyAntennaRestPose` correction pulls every node toward a forward-tilted
 * rest vector (see ANTENNA_FORWARD_LEAN_X) by a tapered fraction of the
 * deviation: the BASE node (index 1, just above the anchor) is pulled by
 * ANTENNA_BASE_STIFFNESS, the TIP node (last) by ANTENNA_TIP_STIFFNESS, and
 * nodes between by linear interpolation. Base-stiffer-than-tip concentrates
 * freedom at the tip so the rod bends like a beam under a point load, not
 * like a tentacle or whip.
 *
 * Lower than the old singleton ANTENNA_STIFFNESS=0.7 because the target read
 * is "springy rod," not "rigid mast." If the benchmarker reads it as too
 * floppy (scarf regression, issue #4), RAISE BOTH constants together; if too
 * rigid, LOWER BOTH. Keep the base>tip ordering.
 */
const ANTENNA_BASE_STIFFNESS = 0.35;

/** Paired with ANTENNA_BASE_STIFFNESS — the TIP-end stiffness. See its JSDoc. */
const ANTENNA_TIP_STIFFNESS = 0.22;

/**
 * Antenna forward lean (showcase-local). The per-segment rest vector tilts
 * forward by this fraction of the segment length, in the FACING direction in
 * screen space. `applyAntennaRestPose` multiplies the rest vector X by
 * `facing`, and the antenna is drawn OUTSIDE the facing mirror in
 * `drawSlimeKnight`, so the physics owns a screen-space lean directly — no
 * draw-time mirror to rely on. This makes the walk inertia symmetric: in both
 * walk directions the tip lags backward relative to facing (opposing the lean)
 * by the same magnitude.
 *
 * The rest vector per segment is
 *   { x: seg * lean * facing, y: -sqrt(seg² - (seg*lean)²) },
 * i.e. a unit segment rotated forward by atan(lean) from vertical, mirrored
 * by facing in screen space. 0.32 ≈ 17.7° forward (raised from 0.22 / ~12.4°
 * per user feedback "point a little further forward"). Feeds
 * `applyAntennaRestPose`'s per-segment rest vector AND
 * `createHeroFrameState`'s initial chain layout (both read this constant, so
 * one change updates both; the init lays out facing=+1 and the rest-pose
 * correction smoothly swings the chain when facing changes). The bend
 * constraint (`applyAntennaBendConstraints`) is unaffected — it uses
 * `2 * segmentLength` (straight-rod rest length) independently of the lean.
 */
const ANTENNA_FORWARD_LEAN_X = 0.32;

/**
 * Antenna tip weight (showcase-local). A positional downward nudge applied
 * AFTER the rest-pose correction, proportional to node position along the
 * chain (i/(n-1)): the base gets ~0, the tip gets the full weight. This
 * models the ball's mass bending the rod. Move curr AND prev by the same
 * delta to preserve implicit Verlet velocity (same discipline as the rest-
 * pose correction).
 *
 * NOTE (architect): at these magnitudes the STATIC-equilibrium tip sag is
 * sub-pixel (~weight/tipStiff ≈ 0.5px). The "bouncing ball" read comes from
 * VELOCITY-DRIVEN dynamics during walk/jump — anchor motion transfers
 * velocity through the chain, the tip lags, and this weight nudge amplifies
 * the lag into visible bounce. If the dynamic read is too subtle, RAISE THIS
 * CONSTANT FIRST (visible sag = target feel) before lowering the stiffness
 * constants (lowering stiffness risks the scarf-flop regression, issue #4).
 */
const ANTENNA_TIP_WEIGHT = 0.12;

/**
 * Antenna gravity scale (showcase-local). The library's `advanceSpringChain`
 * applies `gravityY` during Verlet integration. Set to `0`: solver gravity is
 * now redundant with the showcase-local `applyAntennaTipWeight` nudge, which
 * owns the downward ball-weight sag explicitly (and in a tapered, tip-focused
 * way a uniform solver gravity could not). Keeping solver gravity on would
 * double-apply the sag AND fight the rest-pose correction during jump
 * landings (the old up-float read). With zero solver gravity, the only
 * vertical sag is the showcase-local tip weight; the only sway is velocity
 * transfer through the chain from anchor motion = gentle tip lag + bounce.
 *
 * The RNG draw for `springGravityMul` (seed-contract draw #13) is preserved in
 * `deriveHeroConfig` and multiplied through, so this scale can be raised later
 * without touching the 16-draw seed order.
 */
const ANTENNA_GRAVITY_SCALE = 0;

// ---------------------------------------------------------------------------
// Antenna bend resistance — showcase-local Provot next-nearest-neighbor springs
// ---------------------------------------------------------------------------
//
// Target read: "ball on the end of a springy, bendy metal ROD," not a rope or
// chain. The library solver only enforces ADJACENT-node distances (free-hinge
// joints), so under violent anchor motion (jump landings) the chain can buckle
// and kink — the "rope/chain" read the user flagged. The Provot bend constraint
// adds distance constraints between NEXT-NEAREST neighbors (i, i+2) with rest
// length 2·segmentLength (the straight-rod distance). This resists bending so
// the chain reads as a bendy solid rod. COEXISTS with `applyAntennaRestPose`:
// the bend springs own inter-segment smoothness (anti-buckling); the absolute
// forward-lean spring owns world-space orientation. Both run every tick (see
// `applyAntennaBendConstraints`).

/**
 * Antenna bend stiffness — base joint (closest to the body anchor). The
 * showcase-local Provot bend constraint (applyAntennaBendConstraints) pulls
 * each i-to-i+2 node pair toward its straight-rod rest distance; the base
 * joint gets this stiffness, the tip joint gets ANTENNA_BEND_STIFFNESS_TIP,
 * linearly tapered between. Higher = more rod-like resistance to buckling.
 *
 * Raised from the prototype's 0.6 after the benchmarker found 0.6 too weak
 * (the bend correction was overwhelmed by velocity transfer during jump
 * landings). 0.9 gave visible smooth-rod resistance without freezing the
 * chain rigid; bumped again to 0.95 per user feedback ("still be a bit
 * stiffer") alongside the matching tip raise. Tunable.
 */
const ANTENNA_BEND_STIFFNESS_BASE = 0.95;

/**
 * Antenna bend stiffness — tip joint (furthest from the anchor, where the
 * ball sits). Lower than the base so the tip has more freedom to bend under
 * the ball's weight — the rod bends most near the load, not at the root.
 * Tapered linearly from the base value across the i-to-i+2 pairs. Raised
 * from 0.65 → 0.75 per user feedback ("still be a bit stiffer"); the base>
 * tip ordering is preserved.
 */
const ANTENNA_BEND_STIFFNESS_TIP = 0.75;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Seed-derived static configuration. The same seed always yields the exact
 * same `HeroConfig`. The `speed` field is the runtime gait speed multiplier
 * (0 = idle, 1 = walk, 2 = run); it is NOT derived from the seed and may be
 * mutated by the caller (e.g. from a slider) before drawing.
 */
export interface HeroConfig {
  /** The seed this config was derived from. */
  readonly seed: number;
  /** Generated palette (independent rng stream — see deriveHeroConfig). */
  readonly palette: Palette;
  /** Gait amplitudes + cadence for the locomotion cycle. */
  readonly gaitConfig: GaitConfig;
  /** Verlet spring parameters for the antenna. */
  readonly springConfig: SpringConfig;
  /** Volume-preserving breathing parameters. */
  readonly breathConfig: BreathConfig;
  /** Bone lengths for each leg (thigh + shin), in canvas px. */
  readonly boneLengths: { thigh: number; shin: number };
  /** Antenna node count (including the immovable root). */
  readonly antennaSegments: number;
  /** Rest distance between adjacent antenna nodes. */
  readonly antennaSegmentLength: number;
  /** Cyclops eye radius in canvas px. */
  readonly eyeRadius: number;
  /** Body bounding-box width in canvas px (drawn centered on the body origin). */
  readonly bodyWidth: number;
  /** Body bounding-box height in canvas px. */
  readonly bodyHeight: number;
  /** Runtime gait speed multiplier (NOT seed-derived; caller-owned). */
  speed: number;
}

/**
 * Per-frame mutable state carried between ticks. The fields below are the
 * ONLY pieces of state that depend on prior frames (phase memory for
 * locomotion, velocity memory for the Verlet chain). Everything else is a
 * pure function of `config` + `tick`.
 */
export interface HeroFrameState {
  /** Seed-derived static config (immutable; `speed` may be mutated). */
  readonly config: HeroConfig;
  /** Locomotion phase accumulator (advanced each tick). */
  locomotion: LocomotionState;
  /** Antenna Verlet chain (advanced each tick). */
  antenna: VerletNode[];
  /** Jump state machine (advanced each tick; grounded no-op until triggered). */
  jump: JumpState;
  /**
   * Horizontal offset from the canvas center in px (positive = right). Used
   * only by the displacement-driven walk path (`HeroInputs.walkDx`); stays at
   * `0` for the legacy time-driven walk-in-place path. Wraps at the canvas
   * edges so the hero traverses endlessly without a visible pop.
   */
  x: number;
  /**
   * Horizontal facing direction. `+1` = face right (the un-mirrored default;
   * knees point right, the platformer convention), `-1` = face left (the
   * character is mirrored horizontally around its body center at draw time).
   * Persisted across ticks: when the caller stops passing a concrete `facing`
   * (e.g. on key release / idle), the previous value is kept so the character
   * does not snap back to a default. Initialized to `+1` (right) for
   * backward-compat with the benchmark path that never passes `facing`.
   */
  facing: 1 | -1;
  /**
   * Eye count for the face: `1` = cyclops (the seed-canonical default, drawn
   * as a single sclera centered on the body), `2` = two-eyed (two smaller
   * sclerae at ±eyeSpacing). Showcase-only state — NOT seed-derived (the RNG
   * consumption order in `deriveHeroConfig` is untouched); defaults to `1` so
   * the benchmark path (`stepHero(frame, dt)` with no inputs) and any caller
   * that never passes `eyeCount` get the original cyclops and byte-identical
   * `hero-final-*.png` output. Persisted across ticks the same way `facing`
   * is: omit `eyeCount` in `HeroInputs` to carry the previous value forward.
   */
  eyeCount: 1 | 2;
  /**
   * Idle settle blend factor in [0, 1]. Ramps toward 1 when the hero is idle
   * (walkDx === 0), toward 0 when walking. At 1, the locomotion foot + hip
   * offsets are fully blended toward neutral (both feet planted, hips
   * centered) so the hero settles into a natural standing pose instead of
   * freezing mid-stride. At 0, the full locomotion offsets are used (normal
   * walk cycle). Scaled by (1 - airborneBlend) so the airborne tuck takes
   * priority when jumping (jump from idle → feet go to tuck, not neutral).
   */
  idleSettle: number;
}

/**
 * Per-tick inputs from the showcase, combining jump edges with the optional
 * horizontal walk displacement. Replaces the old `stepHero(state, dt,
 * jumpInputs?)` shape so callers no longer pass `isGrounded` (collision is
 * owned by the showcase and computed internally from `state.jump.y`).
 *
 * **Walk mode discriminator:** `walkDx` decides how the locomotion phase
 * advances. If `walkDx` is `undefined`, `stepHero` falls back to the legacy
 * time-driven `advanceLocomotion` (walk-in-place, used by benchmark renders).
 * If `walkDx` is provided (even `0`), the phase is displacement-driven via
 * `advanceLocomotionByDisplacement` — `0` freezes the cycle (feet planted,
 * idle pose); nonzero walks the hero across the canvas with phase synced to
 * translation so feet don't slide.
 */
export interface HeroInputs {
  /** Edge-triggered jump press this tick (button click / spacebar down). */
  readonly jumpPressed?: boolean;
  /** Continuous jump hold (held = full jump; released early = short hop). */
  readonly jumpHeld?: boolean;
  /**
   * Horizontal displacement this tick in WORLD-space canvas px (positive =
   * right). `0` = idle (phase frozen, feet planted); nonzero = walk with phase
   * synced to translation; `undefined` = legacy time-driven walk-in-place
   * (back-compat for benchmarks). The world-space `walkDx` also advances the
   * hero's `x` offset directly; for PHASE advancement, `stepHero` converts it
   * to local space (`walkDx * facing`) before calling
   * `advanceLocomotionByDisplacement` so the gait always advances forward
   * regardless of facing (the renderer's mirror handles the visual direction).
   */
  readonly walkDx?: number;
  /**
   * Desired facing this tick. `+1` = face right, `-1` = face left. When
   * provided, the returned state's `facing` is set to it; when omitted, the
   * previous `facing` is carried forward (so the character keeps its last
   * facing while idle). The benchmark path omits it and stays at the initial
   * `+1` (face right) forever.
   */
  readonly facing?: 1 | -1;
  /**
   * Desired eye count this tick. `1` = cyclops (default), `2` = two-eyed. When
   * provided, the returned state's `eyeCount` is set to it; when omitted, the
   * previous `eyeCount` is carried forward (so toggling once persists until
   * toggled again). The benchmark path omits it and stays at the initial `1`
   * (cyclops) forever → `hero-final-*.png` stays byte-identical.
   */
  readonly eyeCount?: 1 | 2;
}

// ---------------------------------------------------------------------------
// deriveHeroConfig — the seed contract
// ---------------------------------------------------------------------------

/**
 * Derive a complete hero configuration from a single 32-bit seed.
 *
 * Same seed → same config → same hero, forever. No `Math.random`, no
 * `Date.now`.
 *
 * **RNG consumption order** (the seed contract):
 * The palette is generated FIRST via `generatePalette(seed)`, which creates
 * its OWN internal `mulberry32(seed)` stream. The local `rng` below starts
 * FRESH from the same seed — two independent streams from the same seed.
 * Then the local `rng` is consumed in this exact order:
 *
 *   1.  bodyWidth           (nextInt)
 *   2.  bodyHeight          (nextInt)
 *   3.  eyeRadius           (nextInt)
 *   4.  thigh               (nextInt)
 *   5.  shin                (nextInt)
 *   6.  gait.baseFrequency  (nextFloat → lerp)
 *   7.  gait.strideLength   (nextFloat → lerp)
 *   8.  gait.strideHeight   (nextFloat → lerp)
 *   9.  gait.hipBobHeight   (nextFloat → lerp)
 *   10. gait.hipSwayWidth   (nextFloat → lerp)
 *   11. antennaSegments     (nextInt)
 *   12. antennaSegmentLength(nextFloat)
 *   13. spring.gravityY     (nextFloat → lerp)
 *   14. spring.drag         (nextFloat → lerp)
 *   15. breath.frequency    (nextFloat → lerp)
 *   16. breath.amplitude    (nextFloat → lerp)
 *
 * Reordering these calls would change every golden hero. Do not reorder.
 *
 * @param seed - 32-bit unsigned integer seed
 * @returns a fully populated, frozen-ish HeroConfig (the `speed` field is
 *   intentionally writable for runtime control)
 */
export function deriveHeroConfig(seed: number): HeroConfig {
  const rng = mulberry32(seed);
  const R = HERO_RANGES;

  // Palette: generatePalette creates its own mulberry32(seed) internally.
  // Our rng below starts fresh from the same seed for body proportions —
  // two independent streams from the same seed.
  const palette = generatePalette(seed);

  // Body proportions — draw order 1..3.
  const bodyWidth = R.bodyWidth.base + nextInt(rng, 0, R.bodyWidth.jitter);
  const bodyHeight = R.bodyHeight.base + nextInt(rng, 0, R.bodyHeight.jitter);
  const eyeRadius = R.eyeRadius.base + nextInt(rng, 0, R.eyeRadius.jitter);

  // Bone lengths — draw order 4..5.
  const thigh = R.thigh.base + nextInt(rng, 0, R.thigh.jitter);
  const shin = R.shin.base + nextInt(rng, 0, R.shin.jitter);

  // Gait — jittered multiplicatively from DEFAULT_GAIT. Draw order 6..10.
  const gaitConfig: GaitConfig = {
    baseFrequency:
      DEFAULT_GAIT.baseFrequency *
      lerp(R.gaitFrequencyMul.min, R.gaitFrequencyMul.max, nextFloat(rng, 0, 1)),
    strideLength:
      DEFAULT_GAIT.strideLength *
      lerp(R.gaitStrideLenMul.min, R.gaitStrideLenMul.max, nextFloat(rng, 0, 1)),
    strideHeight:
      DEFAULT_GAIT.strideHeight *
      lerp(R.gaitStrideHtMul.min, R.gaitStrideHtMul.max, nextFloat(rng, 0, 1)),
    hipBobHeight:
      DEFAULT_GAIT.hipBobHeight *
      lerp(R.gaitHipBobMul.min, R.gaitHipBobMul.max, nextFloat(rng, 0, 1)),
    hipSwayWidth:
      DEFAULT_GAIT.hipSwayWidth *
      lerp(R.gaitHipSwayMul.min, R.gaitHipSwayMul.max, nextFloat(rng, 0, 1)),
  };

  // Antenna geometry + spring physics — draw order 11..14.
  const antennaSegments = R.antennaSegments.base + nextInt(rng, 0, R.antennaSegments.jitter);
  const antennaSegmentLength =
    R.antennaSegmentLength.base + nextFloat(rng, 0, R.antennaSegmentLength.jitter);
  const springConfig: SpringConfig = {
    ...DEFAULT_SPRING,
    segmentLength: antennaSegmentLength,
    // Antenna is an UPWARD element, so gravity must bias it upward
    // (negative Y). `-Math.abs(...)` keeps the sign negative regardless of
    // the multiplier draw and is self-documenting: the minus signals "this
    // is an upward antenna, not a hanging tail." The absolute magnitude
    // still scales with DEFAULT_SPRING.gravityY × the springGravityMul draw.
    //
    // ANTENNA_GRAVITY_SCALE (currently 0) zeroes solver gravity: the
    // showcase-local `applyAntennaTipWeight` nudge now owns the ball's
    // downward sag explicitly (in a tapered, tip-focused way a uniform
    // solver gravity could not), and solver gravity would double-apply it
    // AND fight `applyAntennaRestPose` during landings. The RNG draw #13
    // (springGravityMul) is still consumed here so the seed contract's 16-draw
    // order is unchanged; raising ANTENNA_GRAVITY_SCALE re-activates it.
    gravityY:
      -Math.abs(DEFAULT_SPRING.gravityY) *
      lerp(R.springGravityMul.min, R.springGravityMul.max, nextFloat(rng, 0, 1)) *
      ANTENNA_GRAVITY_SCALE,
    drag: lerp(R.springDrag.min, R.springDrag.max, nextFloat(rng, 0, 1)),
  };

  // Breathing — draw order 15..16.
  const breathConfig: BreathConfig = {
    frequency:
      DEFAULT_BREATH.frequency *
      lerp(R.breathFreqMul.min, R.breathFreqMul.max, nextFloat(rng, 0, 1)),
    amplitude:
      DEFAULT_BREATH.amplitude *
      lerp(R.breathAmpMul.min, R.breathAmpMul.max, nextFloat(rng, 0, 1)),
  };

  return {
    seed,
    palette,
    gaitConfig,
    springConfig,
    breathConfig,
    boneLengths: { thigh, shin },
    antennaSegments,
    antennaSegmentLength,
    eyeRadius,
    bodyWidth,
    bodyHeight,
    speed: 1,
  };
}

// ---------------------------------------------------------------------------
// Frame state — create + step
// ---------------------------------------------------------------------------

/**
 * Create the initial per-frame state for a hero at rest. The locomotion
 * phase starts at 0; the antenna chain extends along the FORWARD-TILTED rest
 * vector used by `applyAntennaRestPose` (lean ANTENNA_FORWARD_LEAN_X forward
 * from vertical) with zero implicit velocity, so the first frame is at rest
 * — no initial-frame whip.
 *
 * The antenna is an UPWARD element (not a hanging tail), so we build the
 * nodes manually here — `createSpringChain` from the library is correctly
 * designed for DOWNWARD-hanging chains (tails, hair) and would lay the
 * antenna nodes out over the hero's face. Mirroring its node shape but
 * inverting the Y direction (and tilting +X by the forward lean) gives the
 * rest pose; the `advanceSpringChain` solver is direction-agnostic (it pins
 * node[0] to the anchor each tick and only enforces segment lengths), so the
 * tilted init composes with it cleanly.
 *
 * @param config - seed-derived static config
 * @returns the initial frame state
 */
export function createHeroFrameState(config: HeroConfig): HeroFrameState {
  const anchor = bodyTopAtRest(config);
  const antenna: VerletNode[] = [];
  // Forward-tilted rest vector — MUST match applyAntennaRestPose's per-segment
  // vector so the first frame is at rest (no initial-frame whip). See that
  // function for the geometry.
  const rx = config.antennaSegmentLength * ANTENNA_FORWARD_LEAN_X;
  const ry = -Math.sqrt(
    config.antennaSegmentLength * config.antennaSegmentLength - rx * rx,
  );
  for (let i = 0; i < config.antennaSegments; i++) {
    const x = anchor.x + i * rx;
    const y = anchor.y + i * ry;
    antenna.push({ x, y, prevX: x, prevY: y });
  }
  return {
    config,
    locomotion: { phase: 0 },
    antenna,
    jump: createJumpState(DEFAULT_JUMP),
    x: 0,
    facing: 1,
    eyeCount: 1,
    idleSettle: 0,
  };
}

/**
 * Apply Provot next-nearest-neighbor bend springs to the antenna chain.
 *
 * For each node pair (i, i+2), a distance constraint with rest length
 * 2*segmentLength (the straight-rod distance) resists bending. This prevents
 * the chain from buckling or kinking under violent anchor motion (jump
 * landings) — the "rope/chain" read the user flagged. COEXISTS with
 * applyAntennaRestPose: the bend springs own inter-segment smoothness
 * (anti-buckling); the absolute forward-lean spring owns world-space
 * orientation. Pipeline in stepHero:
 *
 *   advanceSpringChain → applyAntennaBendConstraints → applyAntennaRestPose → applyAntennaTipWeight
 *
 * Root handling: when i === 0, node 0 (the pinned root) is immovable and
 * node 2 takes the full correction — mirrors the distance constraint's i===1
 * special case in spring.ts. For i > 0, the correction splits 50/50.
 *
 * Tapered stiffness: pair i=0 (base) → ANTENNA_BEND_STIFFNESS_BASE, last pair
 * (tip) → ANTENNA_BEND_STIFFNESS_TIP, linear between.
 *
 * Operates in place on the fresh chain from advanceSpringChain (already a deep
 * copy — state.antenna is never mutated). Moves curr AND prev by the same
 * delta to preserve implicit Verlet velocity (same discipline as
 * applyAntennaRestPose / applyAntennaTipWeight).
 *
 * @param nodes - fresh chain from advanceSpringChain (mutated + returned)
 * @param segmentLength - rest distance between adjacent nodes
 * @returns the same array (mutated in place) for chaining
 */
export function applyAntennaBendConstraints(
  nodes: VerletNode[],
  segmentLength: number,
): VerletNode[] {
  const restLen = 2 * segmentLength;
  const pairs = nodes.length - 2; // i ranges 0..n-3
  for (let i = 0; i < pairs; i++) {
    const a = nodes[i];
    const b = nodes[i + 2];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d === 0) continue;
    const diff = restLen - d;
    const ox = (dx / d) * diff;
    const oy = (dy / d) * diff;
    // Tapered stiffness: pair i=0 (base) → BASE, pair i=pairs-1 (tip) → TIP.
    const t = pairs > 1 ? i / (pairs - 1) : 0;
    const stiff =
      ANTENNA_BEND_STIFFNESS_BASE +
      (ANTENNA_BEND_STIFFNESS_TIP - ANTENNA_BEND_STIFFNESS_BASE) * t;
    const corrx = ox * stiff;
    const corry = oy * stiff;
    if (i === 0) {
      // Root (node 0) immovable; node 2 takes full correction.
      b.x += corrx;
      b.y += corry;
      b.prevX += corrx;
      b.prevY += corry;
    } else {
      // Split 50/50 — move curr AND prev together (velocity preservation).
      a.x -= corrx * 0.5;
      a.y -= corry * 0.5;
      a.prevX -= corrx * 0.5;
      a.prevY -= corry * 0.5;
      b.x += corrx * 0.5;
      b.y += corry * 0.5;
      b.prevX += corrx * 0.5;
      b.prevY += corry * 0.5;
    }
  }
  return nodes;
}

/**
 * Apply the antenna's directional spring: pull every node toward a forward-
 * tilted rest pose (per-segment vector rotated ANTENNA_FORWARD_LEAN_X forward
 * from vertical), with tapered stiffness (base-stiffer-than-tip). Replaces the
 * old `stiffenAntenna` straight-up correction — the library solver has no
 * preferred-direction term, so this showcase-local positional correction owns
 * the rest pose exactly as before, just with a forward tilt + a taper.
 *
 * **Facing-aware (screen-space physics).** The rest vector's X component flips
 * sign with `facing` so the antenna leans forward in the SCREEN-space facing
 * direction regardless of which way the character walks. The antenna is drawn
 * OUTSIDE the facing mirror in `drawSlimeKnight`, so the physics must compute
 * screen-space positions directly. This is what makes the walk inertia
 * SYMMETRIC: in both walk directions the body translates, the tip lags
 * BACKWARD relative to facing (opposing the forward lean) by the same
 * magnitude. Previously the rest lean was fixed at +X in code space and the
 * draw mirror flipped it for display — but the Verlet inertia stayed in code
 * space, so walking-right inertia opposed the lean (weak) while walking-left
 * inertia reinforced it (strong). Computing the lean in screen space removes
 * the asymmetry at the source. `ry` is facing-independent (`rx²` is the same
 * for both facings).
 *
 * Operates in place on the fresh chain from `advanceSpringChain` (already a
 * deep copy — `state.antenna` is never mutated), preserving `stepHero`'s pure-
 * progression-ops boundary. Moves curr AND prev by the same delta to preserve
 * implicit Verlet velocity (otherwise the positional jump reads as a velocity
 * spike and re-excites the whip).
 *
 * Node 0 (anchor, re-pinned by the solver) untouched. Taper: node 1 uses
 * ANTENNA_BASE_STIFFNESS, the last node uses ANTENNA_TIP_STIFFNESS, between
 * linear on `i/(n-1)`. Both gradients compound toward the tip (stiffness ↓,
 * tip-weight ↑ in the separate pass below) → sag concentrates at the tip →
 * "rod bending under ball weight," not tentacle/whip.
 *
 * @param nodes - fresh chain from `advanceSpringChain` (mutated + returned)
 * @param segmentLength - rest distance between adjacent nodes
 * @param facing - character facing this tick (+1 right / -1 left); flips the
 *   rest vector's X so the lean follows the facing direction in screen space
 * @returns the same array (mutated in place) for chaining
 */
export function applyAntennaRestPose(
  nodes: VerletNode[],
  segmentLength: number,
  facing: 1 | -1,
): VerletNode[] {
  // Forward-tilted per-segment rest vector, FACING-AWARE in screen space.
  // rx flips sign with facing so the antenna leans forward (in the facing
  // direction) regardless of which way the character walks. ry is the same
  // for both facings (rx² is facing-independent).
  const rx = segmentLength * ANTENNA_FORWARD_LEAN_X * facing;
  const ry = -Math.sqrt(segmentLength * segmentLength - rx * rx);
  const last = nodes.length - 1;
  for (let i = 1; i < nodes.length; i++) {
    const below = nodes[i - 1];
    const restX = below.x + rx;
    const restY = below.y + ry;
    const n = nodes[i];
    // Tapered stiffness: base (i=1) → ANTENNA_BASE_STIFFNESS, tip (i=last) →
    // ANTENNA_TIP_STIFFNESS, linear between.
    const t = last > 1 ? (i - 1) / (last - 1) : 0;
    const stiff =
      ANTENNA_BASE_STIFFNESS +
      (ANTENNA_TIP_STIFFNESS - ANTENNA_BASE_STIFFNESS) * t;
    const dx = (restX - n.x) * stiff;
    const dy = (restY - n.y) * stiff;
    // Move both current and prev by the same delta to preserve implicit Verlet
    // velocity (otherwise the position jump reads as a velocity spike and the
    // chain whips).
    n.x += dx;
    n.y += dy;
    n.prevX += dx;
    n.prevY += dy;
  }
  return nodes;
}

/**
 * Apply the antenna tip weight: a positional downward nudge proportional to
 * node position along the chain (base ~0, tip full ANTENNA_TIP_WEIGHT). Models
 * the ball's mass bending the rod. Applied AFTER `applyAntennaRestPose` so the
 * stiffness correction sets the rest orientation first and this sags the tip
 * down from there (reverse order would have stiffness un-do the sag).
 *
 * Same velocity-preservation discipline: curr AND prev move by the same delta.
 * Operates in place on the fresh chain from `advanceSpringChain`.
 *
 * @param nodes - fresh chain (mutated + returned)
 * @returns the same array (mutated in place) for chaining
 */
export function applyAntennaTipWeight(nodes: VerletNode[]): VerletNode[] {
  const last = nodes.length - 1;
  if (last < 1) return nodes;
  for (let i = 1; i < nodes.length; i++) {
    const frac = i / last; // base (i=1) → small, tip (i=last) → 1.0
    const dy = ANTENNA_TIP_WEIGHT * frac;
    const n = nodes[i];
    // curr AND prev move together — preserve implicit Verlet velocity.
    n.y += dy;
    n.prevY += dy;
  }
  return nodes;
}

/**
 * Advance the hero's per-frame state by one fixed timestep.
 *
 * Runs the jump state machine, the locomotion phase accumulator, and the
 * antenna Verlet chain. The antenna anchor is recomputed from the locomotion
 * hip offset AND the current jump lift so the chain tracks the body during a
 * jump. The breath scale is NOT advanced here — it is a pure function of
 * `tick` composed with the jump scale at draw time.
 *
 * **Grounded check:** the showcase's "collision" is trivial — flat ground at
 * `jump.y === 0`. `isGrounded = state.jump.y >= 0`. This is computed
 * internally; callers never pass it. The library never reads collision.
 *
 * **Walk mode (the `walkDx` discriminator):**
 * - `inputs === undefined` OR `inputs.walkDx === undefined` → legacy
 *   time-driven `advanceLocomotion` (walk-in-place). Used by benchmark renders
 *   so `hero-final-*.png` stays byte-identical to the pre-walk-across output.
 * - `inputs.walkDx !== undefined` AND nonzero → displacement-driven
 *   `advanceLocomotionByDisplacement` (walk-across). The phase advances by the
 *   LOCAL-space displacement `(walkDx * facing) / (strideLength · π)` — the
 *   `facing` factor converts world-space `walkDx` to local-space so the phase
 *   always advances forward (see `advanceLocomotionByDisplacement`'s
 *   facing-mirror warning); the renderer's `ctx.scale(facing, 1)` mirror
 *   handles the visual direction. The hero's world-space `x` offset still
 *   translates by signed `walkDx` and wraps at the canvas edges for endless
 *   traversal.
 * - `inputs.walkDx === 0` → displacement-driven but phase FROZEN. The hero
 *   stands still, and `idleSettle` ramps toward 1 so the feet + hips blend
 *   toward neutral (both feet planted) over `IDLE_SETTLE_TIME` (~0.2s) instead
 *   of freezing mid-stride. See `HeroFrameState.idleSettle`.
 *
 * Jump inputs (`jumpPressed` / `jumpHeld`) work in ALL three modes — jumping
 * while walking continues the horizontal translation (jump and walk are
 * independent state machines).
 *
 * **Facing:** `inputs.facing` (`+1` right / `-1` left), when provided, sets the
 * returned state's `facing`; when omitted, the previous `facing` is carried
 * forward. The renderer mirrors the character horizontally when `facing === -1`.
 * The benchmark path (no inputs) stays at the initial `+1` forever.
 *
 * **Eye count:** `inputs.eyeCount` (`1` cyclops / `2` two-eyed), when provided,
 * sets the returned state's `eyeCount`; when omitted, the previous `eyeCount`
 * is carried forward. The renderer draws one or two sclerae accordingly. The
 * benchmark path (no inputs) stays at the initial `1` (cyclops) forever →
 * `hero-final-*.png` stays byte-identical. `eyeCount` is showcase state, NOT
 * seed-derived — the 16-draw RNG order in `deriveHeroConfig` is untouched.
 *
 * Pure: returns a new `HeroFrameState`; the input is not mutated.
 *
 * @param state - current frame state
 * @param dt - fixed timestep (caller MUST keep this constant, e.g. 1/60)
 * @param inputs - optional combined jump + walk inputs; omitted entirely for
 *   the legacy walk-in-place path used by benchmarks
 * @returns the next frame state
 */
export function stepHero(
  state: HeroFrameState,
  dt: number,
  inputs?: HeroInputs,
): HeroFrameState {
  const { config } = state;

  // Facing: take the caller's value when provided, otherwise carry the
  // previous frame's facing forward. The benchmark path (no `inputs`) keeps
  // the initial `+1` (face right) forever — backward-compat. The showcase
  // always passes a concrete `facing` so the character persists its last
  // direction while idle rather than snapping back to a default.
  const facing: 1 | -1 = inputs?.facing ?? state.facing;

  // Eye count: same carry-forward pattern as `facing`. Defaults to the
  // previous frame's value when omitted, so the benchmark path
  // (`stepHero(frame, dt)` with no inputs) stays at the initial `1`
  // (cyclops) forever → `hero-final-*.png` stays byte-identical. The
  // showcase toggles it via `HeroInputs.eyeCount` and it persists.
  const eyeCount: 1 | 2 = inputs?.eyeCount ?? state.eyeCount;

  // Grounded check from the current jump state (flat ground at y = 0). Always
  // computed internally — callers never pass isGrounded.
  const isGrounded = state.jump.y >= 0;

  // Jump inputs default to a grounded no-op when the caller passes none (the
  // legacy benchmark path), preserving byte-identical walk-in-place output.
  const jumpInputs: JumpInputs = {
    jumpPressed: inputs?.jumpPressed ?? false,
    jumpHeld: inputs?.jumpHeld ?? false,
    isGrounded,
  };

  let jump = advanceJump(state.jump, jumpInputs, dt, DEFAULT_JUMP);
  if (jump.phase === 'grounded' || jump.phase === 'landing') {
    jump = { ...jump, y: 0 };
  }

  // Walk: displacement-driven when walkDx is provided (even 0 → phase frozen,
  // feet planted). Time-driven walk-in-place when walkDx is undefined (legacy
  // back-compat for benchmark renders that call stepHero(frame, dt)).
  let locomotion: LocomotionState;
  let x = state.x;
  if (inputs !== undefined && inputs.walkDx !== undefined) {
    const dx = inputs.walkDx;
    // Advance phase by LOCAL-space displacement (dx * facing), not the signed
    // world-space `dx`. The renderer mirrors geometry with `ctx.scale(facing, 1)`
    // in `drawSlimeKnight`; passing signed `dx` here would reverse the gait
    // phase for leftward walking AND the mirror would reverse the geometry — a
    // double reversal that makes walk-left look like a broken reset. Local-
    // space `dx * facing` is always positive when actually walking (rightward
    // walk: dx>0 × facing+1 = +; leftward walk: dx<0 × facing-1 = +), so the
    // phase always advances forward and the mirror alone handles the visual
    // direction. World-space position below still uses signed `dx`. See
    // docs/design/walk-cycle-correction-decision.md.
    locomotion = advanceLocomotionByDisplacement(
      state.locomotion,
      dx * facing,
      config.gaitConfig,
    );
    if (dx !== 0) {
      x = wrapHeroX(x + dx, config.bodyWidth);
    }
  } else {
    locomotion = advanceLocomotion(
      state.locomotion,
      config.speed,
      dt,
      config.gaitConfig,
    );
  }

  const pose = evaluateLocomotion(locomotion, config.gaitConfig);

  // Idle settle: ramp toward 1 when the hero is idle (walkDx === 0), toward 0
  // when walking. The benchmark path (inputs === undefined) never triggers idle
  // → idleSettle stays at 0 → byte-identical goldens preserved.
  const isIdle = inputs !== undefined && inputs.walkDx === 0;
  const idleSettle = isIdle
    ? Math.min(1, state.idleSettle + dt / IDLE_SETTLE_TIME)
    : Math.max(0, state.idleSettle - dt / IDLE_SETTLE_TIME);

  // Antenna anchor tracks the lifted body: jump yOffset (negative = up) plus
  // the airborne hip raise (legs tuck → hip rides up), AND the horizontal `x`
  // offset so the chain follows the body during a walk-across. Keeps the chain
  // pinned to the body top throughout the jump arc + traversal.
  const jumpPose = evaluateJump(jump);
  const jumpLift = jumpPose.yOffset + DEFAULT_TUCK.hipRaise * jumpPose.airborneBlend;
  // Antenna anchor tracks the SCALED body top (jump scale + landing drop) so
  // the root stays connected to the body during the landing squat. See bodyTop.
  const anchor = bodyTop(config, pose.hipOffset, jumpLift, x, jumpPose.scale.scaleY, facing);
  let antenna = advanceSpringChain(
    state.antenna,
    anchor.x,
    anchor.y,
    dt,
    config.springConfig,
  );
  // Showcase-local bend resistance (Provot next-nearest-neighbor springs):
  // enforces inter-segment smoothness so the chain reads as a bendy solid rod,
  // not a rope/chain that buckles under jump landings. COEXISTS with
  // applyAntennaRestPose below (bend = smoothness, rest-pose = forward lean).
  antenna = applyAntennaBendConstraints(antenna, config.antennaSegmentLength);
  // Showcase-local angular stiffness so the antenna stays upright with gentle
  // tip sway instead of flopping (issue #4). The library solver only enforces
  // segment lengths; this correction adds the preferred (vertical) direction.
  antenna = applyAntennaRestPose(antenna, config.antennaSegmentLength, facing);
  // Showcase-local tip weight so the ball's mass bends the rod (sag
  // concentrates at the tip). Applied last so the stiffness corrections set
  // the orientation first; reverse order would have stiffness un-do the sag.
  antenna = applyAntennaTipWeight(antenna);

  return { config, locomotion, antenna, jump, x, facing, eyeCount, idleSettle };
}

/**
 * Wrap a hero `x` offset at the canvas edges so the hero traverses endlessly
 * without a visible pop. The wrap fires when the hero's body has FULLY exited
 * one edge: margin = `bodyWidth/2 + HERO_WALK_WRAP_MARGIN_FOOT` covers the
 * body plus the forward foot's reach.
 *
 * @param x - proposed new x offset (already incremented by this tick's walkDx)
 * @param bodyWidth - the hero's body width (drives the wrap margin)
 * @returns the wrapped x offset
 */
function wrapHeroX(x: number, bodyWidth: number): number {
  const half = HERO_CANVAS_SIZE / 2;
  const margin = bodyWidth / 2 + HERO_WALK_WRAP_MARGIN_FOOT;
  if (x > half + margin) return -half - margin;
  if (x < -half - margin) return half + margin;
  return x;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Body top center at rest (no locomotion offset). */
function bodyTopAtRest(config: HeroConfig): { x: number; y: number } {
  return { x: HERO_CENTER_X, y: heroCenterY(config) - config.bodyHeight / 2 };
}

/** Body top center given a hip offset and optional jump lift (where the
 *  antenna root sits this tick). `jumpLift` is the vertical body displacement
 *  from the jump (yOffset + airborne hip raise); defaults to 0 (rest/walk).
 *  `xOffset` shifts the anchor horizontally for the walk-across traversal;
 *  defaults to 0 (rest / legacy walk-in-place path).
 *
 *  `jumpScaleY` (defaults to 1) mirrors `drawSlimeKnight`'s landing-squat
 *  correction so the antenna anchor rides the SCALED body top during landing:
 *  center-origin body scaling with `jumpScaleY < 1` pulls the visual body top
 *  UP, which previously left the anchor floating ~26px above the squashed body.
 *  Dropping the body center by the squashed height (`landingDrop`) and scaling
 *  the half-height by `jumpScaleY` puts the anchor exactly at the drawn body
 *  top — modulo the ±~1.5px breath residual, since breath is a function of
 *  `tick` (computed at draw time) and the anchor here can only track the JUMP
 *  scale. The `landingDrop` + `effectiveBodyCy` expressions intentionally
 *  duplicate `drawSlimeKnight`'s; keep them in sync if either changes.
 *
 *  `facing` (defaults to +1) flips the returned X into SCREEN space: the
 *  antenna is drawn OUTSIDE the facing mirror in `drawSlimeKnight`, so its
 *  anchor must already be in screen coordinates. The hip sway (`hipOffset.x`)
 *  is mirrored by `facing`; the walk-offset (`xOffset`) is NOT mirrored (it is
 *  already a world-space translation applied identically in both facings). Y is
 *  never mirrored (the facing mirror is X-only). */
function bodyTop(
  config: HeroConfig,
  hipOffset: Readonly<{ x: number; y: number }>,
  jumpLift = 0,
  xOffset = 0,
  jumpScaleY = 1,
  facing: 1 | -1 = 1,
): { x: number; y: number } {
  const landingDrop = jumpScaleY < 1 ? (1 - jumpScaleY) * config.bodyHeight : 0;
  const effectiveBodyCy =
    heroCenterY(config) + hipOffset.y + jumpLift + landingDrop;
  return {
    // Screen-space X: hip sway mirrored by facing (the antenna is drawn
    // OUTSIDE the facing mirror, so the anchor must already be in screen
    // space). bodyCx in code space is HERO_CENTER_X + xOffset + hipOffset.x;
    // in screen space the hip sway flips: HERO_CENTER_X + xOffset + hipOffset.x * facing.
    x: HERO_CENTER_X + xOffset + hipOffset.x * facing,
    y: effectiveBodyCy - (config.bodyHeight / 2) * jumpScaleY,
  };
}

// ---------------------------------------------------------------------------
// drawSlimeKnight — the canonical renderer
// ---------------------------------------------------------------------------

/**
 * Render the slime-knight into a 2D canvas context. The caller owns the
 * background and the clear; this function draws only the character (body +
 * legs + eye + antenna).
 *
 * Jump composition (mirrors `benchmarks/_scripts/locomotion-walk-jump-render.ts`):
 *   - **Body lift:** `bodyCy` shifts by `jumpPose.yOffset` (negative = up) plus
 *     the airborne hip raise. Feet lift by `yOffset` only (not the hip raise),
 *     so the legs compress into the tuck pose while airborne.
 *   - **Scale composition:** `breath × jumpPose.scale` (both volume-preserving,
 *     so the product is too). Computed UP FRONT so the hip Y can track the
 *     scaled body bottom (Change A); applied to body + eye.
 *   - **Airborne tuck blend:** walk-cycle foot offsets blend toward
 *     `DEFAULT_TUCK.tuckOffset` by `jumpPose.airborneBlend` before IK.
 *
 * Side-view walk model (hero leg overhaul):
 *   - **Hip-tracking (Change A):** `hipY = bodyCy + (bodyHeight/2) ·
 *     composedScaleY`. The hip attaches to the SCALED body bottom, so breath
 *     + jump scale visibly compress / extend the knees (idle breath → subtle
 *     knee oscillation; launch stretch → knees bend; landing squash → knees
 *     extend).
 *   - **Co-located hips + crossing walk (Change B):** both hips sit at
 *     `bodyCx` (side-view stance). The forward leg is drawn ON TOP of the back
 *     leg so the shins cross properly; the draw order is decided by foot X
 *     (facing-agnostic — the outer `ctx.scale(facing, 1)` mirror preserves
 *     call order, so the on-top leg stays on-top after mirroring).
 *   - **Forward foot (Change C):** the shoe is offset +X from the ankle so
 *     the toe points forward (in un-mirrored code space); the facing mirror
 *     flips it for `facing === -1`.
 *
 * Facing (`state.facing`): the character is drawn un-mirrored = facing RIGHT
 * (knees point right, the platformer convention) and mirrored horizontally
 * around its body center when `facing === -1`. The mirror wraps ONLY the
 * character — the caller's background + shadow must be painted BEFORE this
 * call so they are not mirrored.
 *
 * @param ctx - target canvas 2D context (caller owns transform/state)
 * @param state - per-frame state (locomotion phase + antenna chain + jump +
 *   facing + eyeCount)
 * @param tick - current tick (drives the pure breath oscillator)
 * @param look - optional gaze direction this frame, each component in
 *   `[-1, 1]`. The pupil offsets toward this vector: `look.x` shifts it
 *   forward/back (sign-corrected for the facing mirror — see `drawEye`),
 *   `look.y` shifts it up (`<0`) or down (`>0`). When omitted (the benchmark
 *   path), defaults to `{x: 0, y: 0}` so the cyclops pupil stays centered and
 *   `hero-final-*.png` stays byte-identical. The showcase computes this each
 *   tick from the walk direction + jump phase.
 * @param options - optional renderer flags. `options.blink` enables the
 *   deterministic blink cycle (showcase-only; default off so benchmark renders
 *   stay byte-identical). `options.emotion` enables the parametric mouth;
 *   omitted → no mouth drawn (benchmark byte-identical, exactly like `blink`),
 *   `0` → a drawn neutral flat line, positive → a smile Bézier, negative →
 *   the flat line morphs into a small nervous "o" circle. `options.legStyle`
 *   selects the leg renderer: omitted / `'ik'` (the default) draws the 2-bone
 *   IK limbs (benchmark byte-identical); `'simpleFeet'` draws two oversized
 *   rounded-rect feet instead (`drawHeroSimpleFeet`), matching the body's own
 *   color + stroke. The simple-feet path reuses the same locomotion foot
 *   offsets the IK path consumes, so gait + jump + idle settle all drive both
 *   leg styles identically.
 */
export function drawSlimeKnight(
  ctx: CanvasRenderingContext2D,
  state: HeroFrameState,
  tick: number,
  look: { x: number; y: number } = { x: 0, y: 0 },
  options: { blink?: boolean; emotion?: MouthEmotion; legStyle?: HeroLegStyle } = {},
): void {
  const { config } = state;
  const palette = config.palette;
  // Blink openness this frame. Derived purely from `tick` (no new frame state,
  // no RNG) so it stays deterministic + reproducible. Disabled by default
  // (omitted `options.blink`) → every benchmark render stays byte-identical.
  const blinkOpen = options.blink === true ? evaluateBlink(tick) : 1;
  const pose = evaluateLocomotion(state.locomotion, config.gaitConfig);
  const jumpPose = evaluateJump(state.jump);

  // Idle settle stance blend — ramps the locomotion pose toward a neutral
  // standing stance when the hero is idle so the feet lower to the ground and
  // settle slightly apart (HERO_IDLE_FOOT_SPREAD) instead of freezing
  // mid-stride. Scaled by (1 - airborneBlend) so the airborne tuck takes
  // priority when jumping (jump from idle → feet go to tuck, not stance).
  // Composition order (locked in the decision): stance blend FIRST, then
  // `blendAirborneTuck` on each foot. The consumer (this renderer) owns the
  // stop/ground gating via `state.idleSettle * (1 - airborneBlend)`.
  const groundIdle = state.idleSettle * (1 - jumpPose.airborneBlend);
  const stancePose: LocomotionPose = blendLocomotionToStance(
    pose,
    groundIdle,
    HERO_IDLE_FOOT_SPREAD,
  );
  const hipOffset = stancePose.hipOffset;

  // Airborne tuck: blend the STANCE-BLENDED foot offsets toward the tuck pose
  // before IK. airborneBlend=0 → pure stance offset; =1 → full tuck. No-op
  // when grounded. At idle+grounded (groundIdle=1, airborneBlend=0) the feet
  // rest at ±HERO_IDLE_FOOT_SPREAD/2; at walking+airborne (groundIdle=0,
  // airborneBlend=1) the stance blend is zeroed by the (1-airborneBlend)
  // factor and the tuck overrides completely.
  const leftFootOffset = blendAirborneTuck(
    stancePose.leftFootOffset,
    jumpPose.airborneBlend,
    DEFAULT_TUCK,
  );
  const rightFootOffset = blendAirborneTuck(
    stancePose.rightFootOffset,
    jumpPose.airborneBlend,
    DEFAULT_TUCK,
  );

  // Composed scale (Change A keystone): breath × jumpPose scale, computed UP
  // FRONT so the hip Y can track the SCALED body bottom rather than the
  // unscaled body center + bodyHeight/2. Both `breathe` and `evaluateJump` are
  // pure readers; hoisting them above the hip math changes nothing about the
  // scale values themselves (the body still uses `ctx.scale(sx, sy)` below) —
  // it only makes the hip origin follow the visual body bottom as the body
  // breathes / squashes / stretches. Geometric effect:
  //   - idle breath (scaleY ≈ 1 ± 0.05): subtle hip Y oscillation → subtle
  //     knee bend oscillation (the user-visible "knees breathing" effect);
  //   - launch stretch (scaleY = 1.15): body bottom moves DOWN → hip drops →
  //     hip-to-foot distance shrinks → knees bend more (legs tuck under);
  //   - landing squash (scaleY dips to 0.7): center-origin scaling alone would
  //     move the body bottom UP and extend the legs straight ("pancake on
  //     stilts"); the landing-drop correction below translates the body center
  //     DOWN so the hip drops and the knees bend — the proper squat read.
  // This is center-origin scaling, so the bottom tracks `bodyCy + h/2 · scaleY`.
  const breath = breathe(tick, config.breathConfig);
  // TODO(Phase 8c): the event-driven squash layer (`advanceSquash` in
  // `src/platformer/squash.ts`) is NOT wired here. This hero uses `advanceJump`
  // STANDALONE (it is the hero/cosmetics character, not the platformer-kernel
  // player), so it has no `PlatformerEvents` stream to drive the per-event
  // pairs. It therefore keeps the jump slice's own anticipation/launch/landing
  // squash (`jumpPose.scale`) as its scale source. The kernel-driven LDtk play
  // host (`showcase/sections/ldtk-editor/play.ts`) is the canonical consumer of
  // the event-driven layer. Wiring this hero would require either deriving
  // events from the jump state machine or plumbing kernel events in.
  const composedScaleX = breath.scaleX * jumpPose.scale.scaleX;
  const composedScaleY = breath.scaleY * jumpPose.scale.scaleY;

  // Body lift: jump yOffset (negative = up) + airborne hip raise (tuck).
  // Body center shifts by `state.x` for the walk-across traversal (wraps at
  // the canvas edges in `stepHero`); everything below derives from `bodyCx`.
  const jumpLift = jumpPose.yOffset + DEFAULT_TUCK.hipRaise * jumpPose.airborneBlend;
  const bodyCx = HERO_CENTER_X + state.x + hipOffset.x;

  // Simple-feet mode lowers the body: no IK legs, so the leg-reach headroom
  // (`(thigh + shin) * LEG_REACH_RATIO`) is removed and replaced with a small
  // peek gap (SIMPLE_FEET_BODY_PEEK) so the body sits near the ground with the
  // oversized feet planted below. The shift = reach − PEEK (always positive
  // since reach ≈ 38–52px >> 26px). Zero in IK mode → byte-identical goldens.
  const isSimpleFeet = options.legStyle === 'simpleFeet';
  const simpleBodyShiftDown = isSimpleFeet
    ? (config.boneLengths.thigh + config.boneLengths.shin) * LEG_REACH_RATIO - SIMPLE_FEET_BODY_PEEK
    : 0;
  const bodyCy = heroCenterY(config) + hipOffset.y + jumpLift + simpleBodyShiftDown;

  // Landing squat correction. Center-origin body scaling pulls the hip UP on
  // jump-induced squash (composedScaleY < 1), which extends the legs straight
  // toward the planted feet — a "pancake on stilts" read instead of a squat.
  // Drop the body center by the squashed height so the hip moves DOWN (knees
  // bend via solveLimb) and the head comes down (deep squat read). Gated on
  // the JUMP scale only (not breath): landingDrop = 0 whenever jumpScaleY >= 1,
  // so idle breath keeps its center-origin behavior exactly and the GREENLIT
  // idle knee oscillation is unchanged.
  const jumpScaleY = jumpPose.scale.scaleY;
  const landingDrop = jumpScaleY < 1 ? (1 - jumpScaleY) * config.bodyHeight : 0;
  const effectiveBodyCy = bodyCy + landingDrop;

  // Hips — co-located at the body center X (Change B). With both hips on the
  // same vertical axis (side-view stance), the foot offsets swing the feet
  // forward/back past each other so the legs visibly cross during the walk
  // cycle. Zero X parallax keeps the silhouette cleanest; a ±1-2px depth
  // parallax would also work but adds visual noise without aiding the read.
  // The hip Y tracks the SCALED body bottom (Change A) — NOT the unscaled
  // `bodyCy + bodyHeight/2` — so breath + jump scale move the hip origin.
  const hipY = effectiveBodyCy + (config.bodyHeight / 2) * composedScaleY;
  const hipLeftX = bodyCx;
  const hipRightX = bodyCx;

  // Feet: x swings forward/back from the co-located hip; y is a LIFT height
  // (subtract from ground line). Add jumpPose.yOffset so the feet lift WITH
  // the body while airborne (the hip rises by jumpLift which includes
  // hipRaise, the feet only by yOffset → tuck).
  const gY = HERO_GROUND_Y;
  const leftFoot = {
    x: hipLeftX + leftFootOffset.x,
    y: gY - leftFootOffset.y + jumpPose.yOffset,
  };
  const rightFoot = {
    x: hipRightX + rightFootOffset.x,
    y: gY - rightFootOffset.y + jumpPose.yOffset,
  };

  // Mirror the character around its walk-offset axis when facing left. The
  // background + shadow are painted separately by the section BEFORE this
  // function is called and must NOT mirror, so this transform wraps ONLY the
  // character geometry below. `facing === +1` is a no-op (scale 1);
  // `facing === -1` mirrors horizontally around the body center.
  const charCx = HERO_CENTER_X + state.x;
  ctx.save();
  ctx.translate(charCx, 0);
  ctx.scale(state.facing, 1);
  ctx.translate(-charCx, 0);

  // 1. Legs in FIXED DEPTH ORDER. The left leg is the "near" leg (always drawn
  //    LAST / on top); the right leg is the "far" leg (always drawn FIRST /
  //    behind). There is NO swap during the walk cycle — the near leg always
  //    occludes the far leg when they cross, exactly as in a real side-view walk
  //    where one leg is permanently closer to the camera.
  //
  //    Previous versions tried to swap based on foot X (which foot is more
  //    forward) or foot Y (which foot is lifted). Both produced a visible "leg
  //    pop" at the swap point because the legs were not perfectly overlapping
  //    at the moment of the swap. A fixed near/far ordering eliminates the pop
  //    entirely — the legs simply cross with a consistent depth relationship.
  //
  //    Facing-agnostic: `ctx.scale(facing, 1)` mirrors X coordinates but does
  //    NOT change the order in which `drawLimb` is called, so the near leg
  //    stays on top after the mirror. The `bendDir = -1` on both legs is
  //    unchanged.
  const leftHip = { x: hipLeftX, y: hipY };
  const rightHip = { x: hipRightX, y: hipY };

  // Leg style toggle (showcase-only). The default (`'ik'` / omitted) runs the
  // 2-bone IK limbs unchanged so benchmark renders stay byte-identical. The
  // `'simpleFeet'` alternative draws two oversized rounded-rect feet directly
  // (NOT via the library's `drawSimpleFeet`, which renders sharp 1px-outline
  // rects sized for the playground's small devil). The hero's simple feet
  // match the character's own styling: rounded corners, `palette.base` fill
  // (same color as the body), and `CHUNKY_OUTLINE_WIDTH` stroke (same stroke
  // size as the body + IK limbs). See `drawHeroSimpleFeet` below.
  //
  // GROUND-ANCHORING (the key behavioral fix): the feet transform is anchored
  // to `(bodyCx, HERO_GROUND_Y + jumpLift)` — the GROUND LINE, lifted only by
  // the jump — NOT to the breathing `hipY`. This DECOUPLES the feet from:
  //   - the idle breath bounce (`composedScaleY` oscillation in `hipY`),
  //   - the walk hip-bob (`hipOffset.y`),
  //   - the landing squat drop (`landingDrop`).
  // At idle, `jumpLift === 0` so the feet sit exactly on `HERO_GROUND_Y` and
  // the body breathes ABOVE them independently — the "feet still on the
  // ground, not affected by idle bounce" behavior. Only the per-foot walk-
  // cycle lifts (inside `drawHeroSimpleFeet`, driven by `leftFootOffset` /
  // `rightFootOffset`) raise an individual foot during its swing phase. During
  // a jump, both the body and this anchor rise by `jumpLift`, so the feet
  // leave the ground with the character and stay connected to the body.
  if (options.legStyle === 'simpleFeet') {
    ctx.save();
    ctx.translate(bodyCx, HERO_GROUND_Y + jumpLift);
    drawHeroSimpleFeet(ctx, leftFootOffset, rightFootOffset, palette);
    ctx.restore();
  } else {
    drawLimb(ctx, rightHip, rightFoot, config.boneLengths.thigh,
      config.boneLengths.shin, -1, palette);
    drawLimb(ctx, leftHip, leftFoot, config.boneLengths.thigh,
      config.boneLengths.shin, -1, palette);
  }

  // 2. Body — rounded squircle (flat fill + chunky outline pass) + composed
  //    scale (breath × jumpScale; both volume-preserving → product is too).
  //    `composedScaleX/Y` were hoisted above the hip math (Change A) — same
  //    values as before, just reused so the hip origin and the drawn body
  //    agree on the same scale.
  ctx.save();
  ctx.translate(bodyCx, effectiveBodyCy);
  ctx.scale(composedScaleX, composedScaleY);
  drawBody(ctx, config, palette);
  ctx.restore();

  // 3. Eye — drawn AFTER the body so it sits on top. Recompute the composed
  //    body transform so the eye tracks the breathing + squashed body. The
  //    `look` vector (gaze direction) offsets the pupil toward the travel
  //    direction; `eyeCount` selects cyclops (1) vs two-eyed (2).
  ctx.save();
  ctx.translate(bodyCx, effectiveBodyCy);
  ctx.scale(composedScaleX, composedScaleY);
  drawEye(ctx, config, palette, state.eyeCount, look, blinkOpen);
  ctx.restore();

  // 3b. Mouth — drawn AFTER the eye, INSIDE the same body-local transform
  //     (fresh save/restore so it tracks breath + jump squash + facing mirror
  //     exactly like the eye). Gated on `options.emotion !== undefined` (NOT
  //     `!== 0`): omitted → no mouth drawn (benchmark byte-identical, exactly
  //     like `blink`); `emotion: 0` → a drawn neutral flat line. Positive
  //     emotion routes to the smile Bézier; negative routes to the line→circle
  //     morph (the nervous "o"). Both meet at the same flat line at emotion 0.
  if (options.emotion !== undefined) {
    ctx.save();
    ctx.translate(bodyCx, effectiveBodyCy);
    ctx.scale(composedScaleX, composedScaleY);
    drawMouth(
      ctx,
      0,
      config.bodyHeight * MOUTH_Y_OFFSET_RATIO,
      config.bodyWidth * MOUTH_WIDTH_RATIO,
      options.emotion,
      palette,
    );
    ctx.restore();
  }

  // Close the facing-mirror transform (matches the save above). The antenna
  // is drawn OUTSIDE this mirror so its physics owns a screen-space lean
  // (facing-aware in `applyAntennaRestPose`) and its draw is on TOP of both
  // the body and the eye.
  ctx.restore();

  // 4. Antenna — Verlet chain already advanced in stepHero. The physics
  //    anchor (`state.antenna[0]` from `bodyTop` in stepHero) tracks the
  //    UNBLENDED body top: jump scaleY + the UNBLENDED `pose.hipOffset` sway.
  //    Breath (a `tick` function, unavailable in stepHero) and the idle-settle
  //    hip-blend are visual-only corrections, so the physics anchor lags the
  //    drawn head top by a small residual each frame.
  //
  //    The visual base (`antennaBaseX/Y`) tracks the DRAWN body top:
  //    composed scale (breath × jumpScale), IDLE-BLENDED hip sway, landing
  //    drop, and the facing mirror. The delta between the visual base and
  //    the physics anchor (breath residual + idle-settle residual + facing-
  //    mirror adjustment) is applied as a FULL-CHAIN TRANSLATION to the
  //    draw-local antenna copy so the ENTIRE rod + ball ride with the head-
  //    top movement — not just the base point. A node-0-only re-pin left
  //    the rod + ball stationary while the base tracked the head, reading
  //    as "detached"; translating every node by the same delta preserves
  //    the physics chain's bend/bounce curve (rigid shift, no stretching)
  //    and the base ends up exactly at `(antennaBaseX, antennaBaseY)`.
  //
  //    This is a DRAW-LOCAL copy — `state.antenna` is never mutated (the
  //    `.map` produces a new array of new objects; the draw stays a pure
  //    read of state). Translating each node's `prevX/prevY` by the same
  //    delta preserves the implicit Verlet velocity in the copy, keeping
  //    it internally consistent (not that `drawAntenna` reads it — it
  //    only consumes positions). The solver in stepHero still owns the
  //    physics on the unblended anchor; this is purely a draw-time visual
  //    correction — the same pattern as the breath residual above.
  //
  //    Screen-space base: the body is drawn INSIDE the mirror at code-space
  //    `(bodyCx, effectiveBodyCy)` which maps to screen-space
  //    `(charCx + (bodyCx - charCx) * facing, effectiveBodyCy)`. bodyCx =
  //    `charCx + hipOffset.x` (the IDLE-BLENDED hip sway — see the groundIdle
  //    blend above), so `(bodyCx - charCx) = hipOffset.x` and the screen-space
  //    body center X is `charCx + hipOffset.x * facing`. The Y is unchanged
  //    (the facing mirror is X-only). Mirrors the hip Y formula (hip uses
  //    +bodyHeight/2 from center, the antenna base uses -bodyHeight/2).
  const antennaBaseX = charCx + hipOffset.x * state.facing;
  const antennaBaseY = effectiveBodyCy - (config.bodyHeight / 2) * composedScaleY;
  const adx = antennaBaseX - state.antenna[0].x;
  const ady = antennaBaseY - state.antenna[0].y;
  const antennaForDraw = state.antenna.map((n) => ({
    x: n.x + adx,
    y: n.y + ady,
    prevX: n.prevX + adx,
    prevY: n.prevY + ady,
  }));
  drawAntenna(ctx, antennaForDraw, palette);
}

// ---------------------------------------------------------------------------
// Sub-draw helpers
// ---------------------------------------------------------------------------

/**
 * Body: flat fill + chunky outline rendered as a rounded-rectangle squircle
 * (corner radius ≈ 20% of the shorter side), matching the in-game-shapes
 * aesthetic. Sharp-cornered squares read as mechanical; the radius gives
 * the soft slime silhouette the benchmarker asked for.
 *
 * Centered on the current transform origin (the caller handles translate +
 * breath scale).
 */
function drawBody(
  ctx: CanvasRenderingContext2D,
  config: HeroConfig,
  palette: Palette,
): void {
  const w = config.bodyWidth;
  const h = config.bodyHeight;
  // ~20% of the shorter side → 70×60 gives r≈12, matching the benchmark's r=10.
  const r = Math.min(w, h) * 0.2;

  // Flat fill.
  roundRectPath(ctx, -w / 2, -h / 2, w, h, r);
  ctx.fillStyle = palette.base;
  ctx.fill();

  // Chunky outline pass on the same rounded path.
  ctx.strokeStyle = palette.outline;
  ctx.lineWidth = CHUNKY_OUTLINE_WIDTH;
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Blink — deterministic, showcase-only
// ---------------------------------------------------------------------------

/** Snap-close phase length in ticks (@60fps). */
const BLINK_CLOSE_TICKS = 6;
/** Held-shut phase length in ticks (@60fps). */
const BLINK_CLOSED_TICKS = 3;
/** Slower reopen phase length in ticks (@60fps). */
const BLINK_OPEN_TICKS = 12;
/** Total blink length in ticks (close + closed + open ≈ 350ms). */
const BLINK_DURATION = BLINK_CLOSE_TICKS + BLINK_CLOSED_TICKS + BLINK_OPEN_TICKS;
/** Minimum gap between blinks in ticks (~2.5s @60fps). */
const BLINK_GAP_MIN = 150;
/** Maximum gap between blinks in ticks (~5s @60fps). */
const BLINK_GAP_MAX = 300;

/**
 * Deterministic [0,1) pseudo-random from an integer — a one-shot hash with no
 * state, fully reproducible. Used to vary the gap between blinks so the cadence
 * reads as natural rather than metronomic (a fixed interval looks robotic).
 */
function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Gap (in ticks) before the `cycle`-th blink starts. Deterministic per cycle. */
function blinkGapForCycle(cycle: number): number {
  return BLINK_GAP_MIN + hash01(cycle + 1) * (BLINK_GAP_MAX - BLINK_GAP_MIN);
}

/**
 * Eyelid openness for a given tick: `1` = fully open, `0` = fully closed, with
 * linear ramps during the close (snap) and open (slower) phases. Both eyes
 * always share this single value (computed once in `drawSlimeKnight`), so they
 * blink in perfect sync. The blink fires after a varied gap, so tick `0` is
 * always fully open. Pure function of `tick` — deterministic, reproducible, no
 * frame state, no RNG state.
 *
 * @param tick - the current render tick (advanced once per frame in the
 *   showcase loop)
 * @returns openness in `[0, 1]`
 */
function evaluateBlink(tick: number): number {
  let cursor = 0;
  let cycle = 0;
  // Walk the timeline blink-by-blink. A hero blinks a handful of times per
  // minute, so even after an hour this is well under 1000 iterations.
  for (;;) {
    const blinkStart = cursor + blinkGapForCycle(cycle);
    if (tick < blinkStart) return 1; // open gap before this blink
    if (tick < blinkStart + BLINK_DURATION) {
      const local = tick - blinkStart;
      if (local < BLINK_CLOSE_TICKS) return 1 - local / BLINK_CLOSE_TICKS;
      if (local < BLINK_CLOSE_TICKS + BLINK_CLOSED_TICKS) return 0;
      return (local - BLINK_CLOSE_TICKS - BLINK_CLOSED_TICKS) / BLINK_OPEN_TICKS;
    }
    cursor = blinkStart + BLINK_DURATION;
    cycle += 1;
  }
}

// ---------------------------------------------------------------------------
// Mouth — deterministic, showcase-only
// ---------------------------------------------------------------------------

/**
 * Parametric mouth emotion value. Drives the mouth shape from a small nervous
 * "o" (`-1`, a filled circle) through a flat neutral line (`0`) to a wide
 * happy smile (`+1`). Intermediate values produce smooth blends:
 *   - positive → cubic-Bézier smile (corners up); curvature scales with emotion;
 *   - zero → flat horizontal line;
 *   - negative → the flat line morphs into a small solid circle (the classic
 *     nervous "o" mouth). The morph parameter `t = -emotion` interpolates the
 *     ellipse's semi-width and semi-height continuously from the flat line
 *     (at `t = 0`) to the full circle (at `t = 1`). See `drawCircleMouth`.
 *
 * Showcase-only knob: passed via `drawSlimeKnight`'s `options.emotion`. Omit
 * it entirely to draw no mouth (every existing benchmark stays byte-identical,
 * exactly like `options.blink`); pass `0` to draw a neutral flat line.
 *
 * @determinism Pure function of `emotion`. No `Math.random`, no `Date.now`, no
 *   frame state, no tick dependency. The negative range reads the nervousness
 *   from the small "o" shape itself rather than from motion, so it is fully
 *   static and identical across runs at every tick.
 */
export type MouthEmotion = number; // [-1, 1] — nervous "o" … neutral … happy

/**
 * Hero leg rendering style. Omit / `'ik'` = the default 2-bone IK limbs
 * (benchmark byte-identical); `'simpleFeet'` = two oversized rounded-rect feet
 * drawn directly (`drawHeroSimpleFeet`, matching the body's own color + stroke,
 * NOT the library's `animation/simple-feet.ts` playground renderer). The
 * default (`'ik'`) MUST stay the benchmark path so any render that calls
 * `drawSlimeKnight` without `legStyle` stays byte-identical to the goldens.
 * Showcase-only state — NOT seed-derived.
 */
export type HeroLegStyle = 'ik' | 'simpleFeet';

/**
 * Vertical offset of the mouth center from the body-local center, as a
 * fraction of `bodyHeight`. Positive → below center (canvas +Y). `0.30`
 * places the mouth comfortably inside the body silhouette with clear
 * separation from the cyclops eye (which sits at `-bodyHeight * 0.12`).
 * Combined with the tightened `MOUTH_CIRCLE_RADIUS_RATIO` (0.20), the
 * nervous "o" circle clears the eye outline at full negative emotion — the
 * benchmarker measured a clean ~1.95px gap between them at these values.
 * Previously raised 0.15 → 0.25 to clear an eye/mouth collision where the
 * nervous frown curved up into the eye, then 0.25 → 0.30 to resolve a
 * residual circle/eye collision.
 */
const MOUTH_Y_OFFSET_RATIO = 0.30;
const MOUTH_WIDTH_RATIO = 0.35;

/**
 * Fraction of the mouth width used as the vertical displacement of the cubic
 * Bézier control points at full curvature (emotion = ±1). Both control points
 * share this Y offset; positive curvature pulls them down (+Y) → smile (∪),
 * negative pulls them up (-Y) → frown (∩). `0.25` at `width ≈ 28px` (bodyWidth
 * ~80 × MOUTH_WIDTH_RATIO 0.35) yields an ~7px control offset → ~5px midpoint
 * lift, the soft Sokpop mouth arc.
 */
const MOUTH_CURVATURE_CONTROL_RATIO = 0.25;

/**
 * Radius of the nervous "o" circle at full negative emotion (`emotion = -1`),
 * as a fraction of the mouth width. The morph in `drawCircleMouth` interpolates
 * an ellipse from the flat neutral line (semi-width = `width/2`, semi-height =
 * `0`) to a circle of radius `width · MOUTH_CIRCLE_RADIUS_RATIO` (semi-width =
 * semi-height = circleR). `0.20` at `width ≈ 28px` (bodyWidth ~80 ×
 * MOUTH_WIDTH_RATIO 0.35) yields an ~5.6px-radius circle — a small, tight "o"
 * that reads as clenched/nervous, not a surprised gasp. Lowering it also
 * reduces the circle/eye collision; alongside the `0.30` mouth offset the
 * benchmarker measured a clean ~1.95px gap. Tunable: lower = tighter mouth
 * (more clenched), higher = wider "o" (more surprised). Lowered from `0.3` to
 * tighten the nervous read and clear the eye.
 */
const MOUTH_CIRCLE_RADIUS_RATIO = 0.20;

/**
 * Draw the parametric mouth below the eye. Called inside the body-local
 * transform (after body + eye are drawn, still inside the composed scale +
 * facing mirror). Splits the emotion range at zero:
 *   - `emotion > 0` → `drawSmoothMouth` (cubic-Bézier smile, curvature = emotion).
 *   - `emotion <= 0` → `drawCircleMouth` (flat-line → filled-circle morph,
 *     morph parameter `t = clamp(-emotion, 0, 1)`).
 *
 * **Continuity at `emotion = 0`.** Both branches render the SAME flat
 * horizontal line at the boundary: the smile Bézier at curvature 0 is a flat
 * segment from `(cx ± width/2, cy)`; the circle morph at `t = 0` is a
 * degenerate ellipse (`ry = 0`) whose fill is empty and whose stroke is the
 * same flat segment `(cx ± width/2, cy)`. Same width, same stroke color, same
 * line width, same round caps → the boundary is invisible from either side.
 *
 * @param ctx - canvas context (body-local transform already applied)
 * @param cx - mouth center X in body-local space (0 = body midline)
 * @param cy - mouth center Y in body-local space (below the eye)
 * @param width - mouth width in body-local px (~35% of bodyWidth)
 * @param emotion - [-1, 1] emotion scalar (negative = nervous "o", positive = smile)
 * @param palette - color palette (outline slot used for stroke + fill)
 * @determinism Pure function of (cx, cy, width, emotion, palette). No RNG, no
 *   tick dependency, no frame state. Both the smile and the circle morph are
 *   fully static for given params — identical across runs at every tick.
 */
function drawMouth(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  width: number,
  emotion: MouthEmotion,
  palette: Palette,
): void {
  if (emotion > 0) {
    drawSmoothMouth(ctx, cx, cy, width, emotion, palette);
  } else {
    const t = Math.min(1, Math.max(0, -emotion));
    drawCircleMouth(ctx, cx, cy, width, t, palette);
  }
}

/**
 * Draw a smooth mouth via a single interpolated cubic Bézier (research
 * Pattern 1). The control points sit at `(cx ∓ width/4, cy + curvature·amp)`
 * where `amp = width · MOUTH_CURVATURE_CONTROL_RATIO`; positive curvature
 * pulls them down (+Y) → smile (∪), zero → flat line. Stroke-only (line-only
 * mouth, v1) using `palette.outline` at `CHUNKY_OUTLINE_WIDTH` with round caps
 * — matches the eye's chunky-outline aesthetic.
 *
 * Only called from `drawMouth` with `curvature > 0` (the smile range). The
 * function itself remains a general single-Bézier renderer that would also
 * produce a frown for `curvature < 0` and a flat line at `curvature = 0`, but
 * the negative emotion range is now owned by `drawCircleMouth`.
 *
 * @param ctx - canvas context (body-local transform already applied)
 * @param cx - mouth center X (0 = body midline)
 * @param cy - mouth center Y (below the eye)
 * @param width - mouth width in body-local px
 * @param curvature - [-1, 1] frown to smile; controls vertical displacement
 *   of the Bézier control points (only `> 0` reached from `drawMouth`)
 * @param palette - color palette (outline slot used for stroke)
 * @returns void — draws directly onto ctx
 * @determinism Pure function of (cx, cy, width, curvature, palette). No RNG,
 *   no tick dependency, no frame state. Deterministic for given params.
 */
function drawSmoothMouth(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  width: number,
  curvature: number,
  palette: Palette,
): void {
  const halfW = width / 2;
  const cpY = cy + curvature * width * MOUTH_CURVATURE_CONTROL_RATIO;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cx - halfW, cy);
  ctx.bezierCurveTo(
    cx - halfW / 2,
    cpY,
    cx + halfW / 2,
    cpY,
    cx + halfW,
    cy,
  );
  ctx.strokeStyle = palette.outline;
  ctx.lineWidth = CHUNKY_OUTLINE_WIDTH;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw the negative-emotion mouth as a flat-line → filled-circle morph (the
 * classic nervous "o"). The morph parameter `t ∈ [0, 1]` interpolates an
 * ellipse continuously:
 *   - `circleR = width · MOUTH_CIRCLE_RADIUS_RATIO`            (the full "o" radius)
 *   - `rx = lerp(width / 2, circleR, t)`                       (semi-width contracts)
 *   - `ry = lerp(0, circleR, t)`                               (semi-height grows)
 *   - draw `ellipse(cx, cy, rx, ry, 0, 0, 2π)`, then BOTH fill AND stroke in
 *     `palette.outline` at `CHUNKY_OUTLINE_WIDTH` with round caps.
 *
 * **Why fill + stroke both in outline color.** At `t = 0`, `ry = 0` → the
 * ellipse is degenerate: the fill has zero area (renders nothing) and only the
 * round-capped stroke shows — a flat horizontal line that exactly matches the
 * neutral smile-Bézier-at-0 line (same `width`, same stroke). As `t` grows,
 * the dark fill appears inside the stroked outline so the shape becomes a
 * solid dark oval; at `t = 1` it is a solid dark circle of radius `circleR`.
 * The fill and stroke share the outline color so the shape reads as a single
 * solid dark "o" with a chunky rim continuous with the neutral line's stroke.
 *
 * **Tick-independence.** The nervousness reads from the small "o" shape
 * itself, not from motion, so this path has no `tick` dependency. A static
 * frame at any tick renders the same "o" — fully deterministic.
 *
 * @param ctx - canvas context (body-local transform already applied)
 * @param cx - mouth center X (0 = body midline)
 * @param cy - mouth center Y (below the eye)
 * @param width - mouth width in body-local px
 * @param t - morph parameter in `[0, 1]` (0 = flat line, 1 = full circle)
 * @param palette - color palette (outline slot used for fill + stroke)
 * @returns void — draws directly onto ctx
 * @determinism Pure function of (cx, cy, width, t, palette). No RNG, no tick
 *   dependency, no frame state.
 */
function drawCircleMouth(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  width: number,
  t: number,
  palette: Palette,
): void {
  const circleR = width * MOUTH_CIRCLE_RADIUS_RATIO;
  const rx = lerp(width / 2, circleR, t);
  const ry = lerp(0, circleR, t);

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = palette.outline;
  ctx.fill();
  ctx.strokeStyle = palette.outline;
  ctx.lineWidth = CHUNKY_OUTLINE_WIDTH;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

/**
 * Eye rendering: cyclops (1 sclera) or two-eyed (2 smaller sclerae). The pupil
 * offsets toward the `look` gaze vector so the eye tracks the travel direction.
 *
 * **Blink.** `blinkOpen` (0 = closed, 1 = open) squashes each sclera vertically
 * toward a slit and replaces it with a horizontal lid stroke when fully closed.
 * Both eyes share the same `blinkOpen` value (computed once upstream), so they
 * blink in perfect sync.
 *
 * **Pupil offset (mirror-sign corrected).** This function runs INSIDE the
 * body-local transform, which itself runs INSIDE `drawSlimeKnight`'s facing
 * mirror (`ctx.scale(state.facing, 1)`). To make the pupil look FORWARD (the
 * walk direction) on screen, the local-space pupil offset must come out as
 * "forward" AFTER the mirror. Trace it for a left-walking hero
 * (`look.x = -1`, `facing = -1`): if we naively offset by `look.x · reach` in
 * local X we get local `-X`, which the `facing = -1` mirror maps to screen
 * `+X` (RIGHT) — backwards. The fix: offset by `Math.abs(look.x) · reach` in
 * local `+X` always. Then:
 *   - walking right (`look.x = +1`, `facing = +1`): local `+X` → screen `+X` (right). ✓
 *   - walking left  (`look.x = -1`, `facing = -1`): local `+X` → screen `-X` (left).  ✓
 *   - idle facing right (`look.x = +1`, `facing = +1`): screen right. ✓
 *   - idle facing left  (`look.x = -1`, `facing = -1`): screen left.  ✓
 * `look.x ∈ [-1, 1]` so `abs` scales continuously (a future mouse-look could
 * feed fractional values); today the showcase only passes `0`, `+1`, or `-1`.
 *
 * The Y axis is NOT mirrored (only X is), so `look.y` maps straight through:
 * negative = up (rising), positive = down (falling).
 *
 * When `look = {0, 0}` (the benchmark path) every offset is `0` → the cyclops
 * pupil + highlight land exactly where the pre-look version drew them →
 * `hero-final-*.png` stays byte-identical.
 *
 * **Two-eyed mode (`eyeCount === 2`).** Two sclerae at `±eyeSpacing`
 * (`≈ bodyWidth · 0.18`), each radius `eyeRadius · 0.7` so both fit on the
 * face with a small gap between them and well inside the body silhouette.
 * Both pupils track the SAME `look` vector (the eyes verge together toward
 * the gaze target). Highlights sit at the top of each pupil in local space —
 * the same convention as the cyclops — so the highlight language stays
 * consistent across modes.
 *
 * @param ctx - target canvas 2D context (caller owns the body-local transform)
 * @param config - hero config (supplies eyeRadius, bodyWidth, bodyHeight)
 * @param palette - color palette (feature sclera, outline pupil, white highlight)
 * @param eyeCount - `1` = cyclops, `2` = two-eyed
 * @param look - gaze vector this frame, each component in `[-1, 1]`
 * @param blinkOpen - eyelid openness this frame in `[0, 1]` (1 = open)
 */
function drawEye(
  ctx: CanvasRenderingContext2D,
  config: HeroConfig,
  palette: Palette,
  eyeCount: 1 | 2,
  look: { x: number; y: number },
  blinkOpen: number,
): void {
  const eyeCy = -config.bodyHeight * 0.12;

  if (eyeCount === 1) {
    // Cyclops — single full-size sclera centered on the body midline.
    drawSingleEye(ctx, 0, eyeCy, config.eyeRadius, look, palette, blinkOpen);
    return;
  }

  // Two-eyed — two smaller sclerae symmetric about the body midline. Spacing
  // and shrink factor chosen so both eyes fit comfortably inside the body
  // silhouette with a small gap between them (see JSDoc for the range math).
  const eyeSpacing = config.bodyWidth * 0.18;
  const scleraR = config.eyeRadius * 0.7;
  drawSingleEye(ctx, -eyeSpacing, eyeCy, scleraR, look, palette, blinkOpen);
  drawSingleEye(ctx, +eyeSpacing, eyeCy, scleraR, look, palette, blinkOpen);
}

/**
 * Draw one sclera + pupil + highlight at a given local center. Shared by the
 * cyclops and two-eyed paths so the sclera/pupil/highlight code is written
 * once. The pupil offsets toward `look` (mirror-sign corrected — see
 * `drawEye`'s JSDoc) and the white highlight sits at the top of the pupil's
 * offset position. `blinkOpen` squashes the sclera vertically; at full close
 * only a horizontal lid stroke is drawn.
 *
 * @param ctx - target canvas 2D context (caller owns the transform)
 * @param cx - sclera center X in body-local space
 * @param cy - sclera center Y in body-local space
 * @param scleraR - sclera radius in canvas px (pupil + highlight derive from it)
 * @param look - gaze vector this frame, each component in `[-1, 1]`
 * @param palette - color palette
 * @param blinkOpen - eyelid openness this frame in `[0, 1]` (1 = open)
 */
function drawSingleEye(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  scleraR: number,
  look: { x: number; y: number },
  palette: Palette,
  blinkOpen: number,
): void {
  // Fully (or near-) closed — draw just a short horizontal "lid" stroke in the
  // outline color so the eye reads as shut rather than absent. Wrapped in a
  // save/restore so the round line-cap doesn't leak into later draws.
  if (blinkOpen <= 0.05) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx - scleraR * 0.8, cy);
    ctx.lineTo(cx + scleraR * 0.8, cy);
    ctx.strokeStyle = palette.outline;
    ctx.lineWidth = CHUNKY_OUTLINE_WIDTH;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
    return;
  }

  // Sclera — feature color, chunky outline. Drawn as an ellipse whose vertical
  // radius scales with `blinkOpen` (1 = round open eye, <1 = squashed toward a
  // slit by the closing lid).
  ctx.beginPath();
  ctx.ellipse(cx, cy, scleraR, scleraR * blinkOpen, 0, 0, Math.PI * 2);
  ctx.fillStyle = palette.feature;
  ctx.fill();
  ctx.strokeStyle = palette.outline;
  ctx.lineWidth = CHUNKY_OUTLINE_WIDTH;
  ctx.stroke();

  // Pupil + highlight are hidden once the lid covers them; below the threshold
  // drawing them would poke through the thin slit.
  if (blinkOpen < 0.35) return;

  // Pupil — outline color, offset toward the gaze vector. `pupilReach` is the
  // max safe travel: sclera radius minus pupil radius ≈ scleraR · (1 - 0.42) =
  // scleraR · 0.58; 0.4 leaves a comfortable margin so the pupil never kisses
  // the sclera edge.
  const pupilR = scleraR * 0.42;
  const pupilReach = scleraR * 0.4;
  const pupilCx = cx + Math.abs(look.x) * pupilReach;
  const pupilCy = cy + look.y * pupilReach;
  ctx.beginPath();
  ctx.arc(pupilCx, pupilCy, pupilR, 0, Math.PI * 2);
  ctx.fillStyle = palette.outline;
  ctx.fill();

  // Highlight — tiny white dot at the top of the pupil's offset position.
  // Tracks the pupil so the "spark of life" stays glued to the gaze.
  ctx.beginPath();
  ctx.arc(
    pupilCx,
    pupilCy - pupilR * 0.45,
    Math.max(1, pupilR * 0.35),
    0,
    Math.PI * 2,
  );
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

/**
 * One IK-driven leg: 2-bone chain solved analytically, drawn as two thick
 * accent-colored capsules with a chunky outline and a rounded foot.
 *
 * The limb solver is defensive (never throws); if the target is unreachable
 * the leg simply extends straight toward it.
 */
function drawLimb(
  ctx: CanvasRenderingContext2D,
  hip: { x: number; y: number },
  foot: { x: number; y: number },
  thighLen: number,
  shinLen: number,
  bendDir: number,
  palette: Palette,
): void {
  const solve = solveLimb(hip, foot, thighLen, shinLen, { bendDir });
  const knee = solve.jointPos;
  const ankle = solve.endPos;

  // Outline pass — thicker, drawn first so the accent fill sits on top.
  // Two segments: hip→knee, knee→ankle. 18px matches the benchmark's thick
  // rounded-rect stubs (10px wide + 2px outline ≈ 14px visual; we go a touch
  // heavier so the IK joint still reads as a single confident limb).
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = palette.outline;
  ctx.lineWidth = 18;
  strokePolyline(ctx, [hip, knee, ankle]);

  // Accent fill — narrower, drawn on top to leave a chunky outline rim.
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 14;
  strokePolyline(ctx, [hip, knee, ankle]);

  // Foot — rounded-rect shoe placed FORWARD of the ankle (Change C). The
  // shoe's center is offset +X from the ankle by `shoeForward ≈ 0.4 · shoeW`,
  // so the ankle sits just behind the shoe's midpoint (heel-side) and the toe
  // extends forward. In un-mirrored code space +X is "forward" for facing-right
  // (the platformer default); the outer `ctx.scale(facing, 1)` mirror in
  // `drawSlimeKnight` flips +X to -X for `facing === -1`, so the toe
  // automatically points in the facing direction — no per-facing branch
  // needed here, and the same call works for both facings.
  //
  // The 0.4 ratio is a magic number local to this renderer (consistent with
  // the `shoeW` / `shoeH` locals below). It places the ankle near the heel so
  // the shoe reads as a forward-pointing foot rather than the previous
  // stub-behind-ankle silhouette.
  //
  // WIDTH MUST EXCEED THE LEG OUTLINE (lineWidth = 18 above). When shoeW was
  // 18 the shoe was the SAME width as the leg silhouette and disappeared into
  // it — the foot read as the leg stump continuing along the ground ("walking
  // on the leg stump"), not as a shoe. shoeW = 26 makes the shoe 8px wider
  // than the leg (4px of overhang on each side) so it reads as a distinct
  // foot extending past the leg outline. shoeH = 14 gives the sole more
  // vertical presence below the ankle (7px below vs the old 5px) so the foot
  // reads as planted on the ground rather than floating at the ankle. The
  // sole extends ~7px below `ankle.y` (which sits at the ground line) — this
  // is intentional and reads as the shoe planted on the ground. The 0.4
  // forward ratio and Y centering (ankle.y) are unchanged.
  const shoeW = 26; // 8px wider than the 18px leg outline — reads as a foot
  const shoeH = 14; // taller — more sole presence below the ankle
  const shoeForward = shoeW * 0.4;
  const shoeCx = ankle.x + shoeForward;
  const shoeCy = ankle.y;
  ctx.fillStyle = palette.accent;
  ctx.strokeStyle = palette.outline;
  ctx.lineWidth = CHUNKY_OUTLINE_WIDTH;
  roundRectPath(ctx, shoeCx - shoeW / 2, shoeCy - shoeH / 2, shoeW, shoeH, 3);
  ctx.fill();
  ctx.stroke();
}

/**
 * Hero simple-feet renderer (showcase-local). Two oversized rounded-rect feet
 * drawn in BODY-LOCAL coordinates relative to a GROUND-ANCHORED origin (the
 * caller in `drawSlimeKnight` translates to the body's bottom-center ON THE
 * GROUND LINE, lifted only by the jump).
 *
 * Why not use the library's `drawSimpleFeet` (`animation/simple-feet.ts`):
 * that renderer draws sharp-cornered 1px-outline rects sized for the
 * playground's small devil (7×5px). The hero needs feet that match its own
 * character styling, so this helper renders directly with `roundRectPath`:
 *   - 4× the playground size (`SIMPLE_FEET_FOOT_W/H`), so they read as
 *     substantial planted shoes on the 320px canvas.
 *   - ROUNDED corners (`SIMPLE_FEET_CORNER_RADIUS`), matching the body
 *     squircle's ~20% corner ratio.
 *   - `palette.base` fill — the SAME color as the body ("same color as
 *     character"), not `palette.accent` (which is the IK leg color).
 *   - `CHUNKY_OUTLINE_WIDTH` stroke (= 3px) — the SAME stroke size as the
 *     body and IK limbs, not the library's 1px.
 *
 * Drawn BEFORE the body. With SIMPLE_FEET_BODY_PEEK > SIMPLE_FEET_FOOT_H there
 * is a visible air gap between the body bottom and each foot's top, so the
 * full foot is visible below the body (not covered by it) — reads as the blob
 * hovering above its planted shoes.
 *
 * @param ctx             - canvas 2D context (caller owns transform: already
 *                          translated to the ground anchor + facing-mirrored)
 * @param leftFootOffset  - walk-cycle offset for the left foot (x = forward
 *                          sway, y = lift height; both in px). ~0 at idle.
 * @param rightFootOffset - walk-cycle offset for the right foot
 * @param palette         - character palette (`base` fill, `outline` stroke)
 */
function drawHeroSimpleFeet(
  ctx: CanvasRenderingContext2D,
  leftFootOffset: Readonly<{ x: number; y: number }>,
  rightFootOffset: Readonly<{ x: number; y: number }>,
  palette: Palette,
): void {
  const w = SIMPLE_FEET_FOOT_W;
  const h = SIMPLE_FEET_FOOT_H;
  const halfW = w / 2;
  // baseY = -h: the foot BOTTOM sits at the local origin (the ground anchor).
  // The caller translates the origin to `HERO_GROUND_Y + jumpLift`, so the
  // foot bottom rests on the ground line when grounded and lifts with the
  // jump. The per-foot `offset.y` (walk-cycle lift) SUBTRACTS from baseY,
  // raising an individual foot during its swing phase (the stepping anim).
  // `offset.x` shifts the foot forward/back (the stride). At idle both
  // offsets are ~0 (idle-settle blend) so both feet sit flat on the ground.
  const baseY = -h;
  const leftX = -SIMPLE_FEET_IDLE_SPREAD - halfW + leftFootOffset.x;
  const leftY = baseY - leftFootOffset.y;
  const rightX = SIMPLE_FEET_IDLE_SPREAD - halfW + rightFootOffset.x;
  const rightY = baseY - rightFootOffset.y;

  ctx.fillStyle = palette.base;
  ctx.strokeStyle = palette.outline;
  ctx.lineWidth = CHUNKY_OUTLINE_WIDTH;
  roundRectPath(ctx, leftX, leftY, w, h, SIMPLE_FEET_CORNER_RADIUS);
  ctx.fill();
  ctx.stroke();
  roundRectPath(ctx, rightX, rightY, w, h, SIMPLE_FEET_CORNER_RADIUS);
  ctx.fill();
  ctx.stroke();
}

/**
 * Antenna: stroke a chunky outline + accent core through the Verlet chain as a
 * C1-smooth midpoint Bezier curve (`strokeBezier` via `quadraticCurveTo`), then
 * cap the tip with a small accent ball. The root node is the body-top anchor
 * (drawn as part of the line, not separately). The Bezier curve gives C1 visual
 * continuity so the antenna reads as a smooth rod even where the underlying
 * nodes have slight angular changes — complementing the bend-constraint physics
 * (a slightly-kinked chain still renders as a smooth curve).
 */
function drawAntenna(
  ctx: CanvasRenderingContext2D,
  nodes: readonly VerletNode[],
  palette: Palette,
): void {
  if (nodes.length < 2) return;

  // Outline pass (thicker, drawn first).
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = palette.outline;
  ctx.lineWidth = 5;
  strokeBezier(ctx, nodes);

  // Core (narrower, on top).
  ctx.strokeStyle = palette.accent;
  ctx.lineWidth = 2;
  strokeBezier(ctx, nodes);

  // Tip ball.
  const tip = nodes[nodes.length - 1];
  const ballR = 5;
  ctx.beginPath();
  ctx.arc(tip.x, tip.y, ballR, 0, Math.PI * 2);
  ctx.fillStyle = palette.accent;
  ctx.fill();
  ctx.strokeStyle = palette.outline;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Canvas path helpers (showcase-local; not library material)
// ---------------------------------------------------------------------------

/** Stroke a polyline through an array of points with the current ctx style. */
function strokePolyline(
  ctx: CanvasRenderingContext2D,
  pts: readonly { x: number; y: number }[],
): void {
  if (pts.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
}

/** Stroke a polyline through Verlet node positions with the current ctx style. */
export function strokeVerlet(
  ctx: CanvasRenderingContext2D,
  nodes: readonly VerletNode[],
): void {
  ctx.beginPath();
  ctx.moveTo(nodes[0].x, nodes[0].y);
  for (let i = 1; i < nodes.length; i++) ctx.lineTo(nodes[i].x, nodes[i].y);
  ctx.stroke();
}

/**
 * Stroke a smooth C1 curve through Verlet nodes using midpoint Bezier
 * (`quadraticCurveTo`). The control point is the physics node; the on-curve
 * point is the midpoint between adjacent nodes. First and last nodes are
 * on-curve endpoints. Native Canvas2D — zero allocations, deterministic.
 *
 * Complementary to the bend-constraint physics: even a slightly-kinked
 * underlying chain renders as a smooth curve, compounding the rod read.
 */
function strokeBezier(
  ctx: CanvasRenderingContext2D,
  nodes: readonly VerletNode[],
): void {
  if (nodes.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(nodes[0].x, nodes[0].y);
  for (let i = 1; i < nodes.length - 1; i++) {
    const xc = (nodes[i].x + nodes[i + 1].x) / 2;
    const yc = (nodes[i].y + nodes[i + 1].y) / 2;
    ctx.quadraticCurveTo(nodes[i].x, nodes[i].y, xc, yc);
  }
  ctx.lineTo(nodes[nodes.length - 1].x, nodes[nodes.length - 1].y);
  ctx.stroke();
}

/** Build a rounded-rect path (does not fill or stroke — caller does that). */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

// Re-export so main.ts can inject the library outline color into CSS without
// a second import path. (Convenience only — main.ts already imports it directly.)
export { DEFAULT_OUTLINE_COLOR };
