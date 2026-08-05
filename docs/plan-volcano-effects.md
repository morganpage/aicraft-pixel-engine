# Plan: volcanic ash, gas, and eruption effects

> Status: proposed. This plan builds on the existing pressure-driven volcano in
> `showcase/helpers/volcano.ts` and the host-rendered entity pattern established
> by `showcase/helpers/cloud.ts`.

## Problem

The volcano already has a convincing physical foundation:

- pressure routes magma through a chamber and conduit;
- explosive episodes launch lava that cools and fragments into tephra;
- effusive episodes create lava flows that stiffen and freeze;
- explosive, effusive, and repose phases produce distinct terrain changes.

What is missing is the atmospheric and presentational layer that makes those
events read immediately as an eruption. The explosive phase has no sustained
ash column, the effusive phase has no vent gas, and phase transitions lack the
brief glow, flash, and motion cues that communicate their force.

The engine already contains a `SMOKE` material, but using it for the whole plume
would not produce the desired result. A gas cell rises one grid cell away from
the radial-gravity center and spreads only when obstructed. `SMOKE` now has an
independent per-tick decay chance, so freely rising cells can dissipate instead
of persisting at a grid boundary. It also leaves the simulation immediately
when its outward rise crosses the canvas edge. Filling enough cells to create a
large, opaque plume would still keep many simulation chunks active.

Volcanic plumes are mostly ash and hot gases rather than combustion smoke. The
feature should therefore be called an **ash plume** in code and UI copy, even if
its overlapping grey puffs give it a smoke-like appearance.

## Outcome

At the end of this work:

1. explosive episodes build a dense, expanding ash column above the live vent;
2. effusive episodes release sparse, lighter gas wisps;
3. repose and dormancy stop emission while existing puffs disperse naturally;
4. the plume remains aligned with a growing and visually spinning planet;
5. eruption starts receive restrained glow, flash, and reduced-motion-aware
   shake cues;
6. effect state is deterministic, bounded, resettable, and inexpensive;
7. the physical terrain simulation remains unchanged.

## Recommended architecture

Implement the main plume as a host-side visual entity, following the precedent
set by the rain-cloud helper. Keep atmospheric presentation separate from the
material grid while allowing the volcano state machine to drive its behaviour.

Add a DOM-free helper:

```text
showcase/helpers/volcano-effects.ts
```

The helper should own effect state and stepping, but not the browser canvas.
The section should remain responsible for drawing, as it already is for weather
clouds. A representative data model is:

```ts
export type VolcanoEffectMode =
  | EruptionPhase
  | 'paused'
  | 'dormant';

export interface AshPuff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  initialRadius: number;
  opacity: number;
  initialOpacity: number;
  shade: number;
  initialShade: number;
  age: number;
  lifetime: number;
  shapeSeed: number;
}

export interface VolcanoEffectsState {
  puffs: AshPuff[];
  emissionCarry: number;
  vent: { x: number; y: number } | null;
  flash: number;
  glow: number;
  shakeX: number;
  shakeY: number;
  previousMode: VolcanoEffectMode;
  previousEpisode: number;
}
```

The exact fields may change, but use ash/plume terminology rather than smoke
terminology. State must remain plain data so behaviour can be tested under Node
without a DOM or canvas. Rendering must also be pure: it may derive values from
the puff fields and normalized age, but it must never call `Math.random()` or
advance the effects RNG.

### Why the main plume is host-rendered

- A volumetric-looking plume needs expanding, overlapping bodies rather than a
  one-cell-wide gas stream.
- Lifetime and opacity can be explicit instead of depending on whether a gas
  cell happens to become blocked.
- Tangential drift can suggest wind without adding wind physics to the engine.
- A hard puff cap makes performance predictable.
- The effect can rotate with the planet using the section's existing canvas
  transform without rotating the simulation grid.
- The plume remains presentation rather than terrain and therefore does not
  interfere with pressure routing, tephra deposits, heat, or lava flow.

## Phase 1: ash-plume state and lifecycle

### 1.1 Create deterministic effect state

Add `createVolcanoEffectsState()` and keep its state independent of
`VolcanoState`. The eruption state owns simulation phases and pressure-source
ids; the effects state owns temporary visual entities. This keeps pausing,
resetting, and future non-volcanic effects straightforward.

Use the existing volcano PRNG pattern rather than `Math.random()`. Give effects
their own fixed seed and their own RNG instance, re-seeded on scene reset. Do
not share the volcano RNG: changing the number of puffs or their shape must not
advance the physical eruption's random stream or alter its grid result.

The host should also increment an `eruptionEpisode` integer every time the user
starts or restarts an eruption. Pass it into the effects step. Comparing it with
`previousEpisode` makes explosive-entry flash and shake reliable even when a
user pauses and resumes between two simulation ticks, when a mode-only edge
detector could miss the intervening paused state.

### 1.2 Scale effects with the world

Express linear tuning relative to the shipped default planet radius rather than
as fixed cell counts. For example, use:

```ts
const effectScale = cfg.planetRadius / 66;
```

Apply this scale to initial radius, vent offset, velocity, acceleration, spread,
and maximum shake displacement. Keep emission and lifetime in ticks so particle
count remains independent of resolution. Clamp individual values only where a
sub-cell result would become invisible or unstable.

This keeps the apparent plume size stable when the 1-pixel-per-cell backing
store changes from 120 to 400 cells, while still making it proportional to the
displayed planet. Tune and visually check all four resolution/diameter corners,
not only the default and 400-cell default-diameter cases.

### 1.3 Emit from the live summit

Do not use the original `ventPosition()` as the visual origin after the cone has
begun growing. Derive the origin from `summitRadius()` along the vent axis and
offset it one or two cells into open space. This prevents a mature cone from
burying its own plume origin. Scale this clearance as described above and check
that the final point is empty; if necessary, walk a few cells farther outward
with a small, bounded search.

Apply small tangential jitter across the crater mouth. Puffs should appear to
come from an area rather than a single perfectly straight pixel column.

### 1.4 Use fractional emission

Allow emission rates below one puff per frame by accumulating a fractional
carry. This is needed for sparse effusive wisps without a frame-modulo pattern:

```ts
state.emissionCarry += rate;
while (state.emissionCarry >= 1) {
  emitPuff(...);
  state.emissionCarry -= 1;
}
```

Reset `emissionCarry` to zero when the mode changes between explosive,
effusive, and a non-emitting mode. A fractional remainder from dense ash must
not become a gas wisp, and a pause must not retain emission debt for the next
episode.

### 1.5 Step and cull puffs

Each tick should:

- advance position by velocity;
- accelerate slightly away from the planet center to suggest buoyant rise;
- apply drag or a terminal radial speed so acceleration cannot grow without
  bound;
- apply deterministic, bounded tangential drift chosen at emission time;
- expand the radius over time;
- fade opacity using normalized age;
- lighten dark ash toward grey as it disperses;
- remove expired or invisible puffs;
- remove off-grid puffs only once their full radius is outside the canvas, so a
  puff does not pop when its center crosses an edge;
- enforce a hard maximum puff count.

Do not delete a live puff solely to admit a new one: that makes the leading edge
of a saturated plume pop out before its specified lifetime. Treat the cap as an
emergency invariant. If it is reached, consume and skip that emission attempt
without allowing `emissionCarry` to accumulate a later burst. Shipped tuning
must remain below the cap in the normal phase sequence.

### Suggested initial tuning

These values are starting points for visual tuning, not public engine defaults:

| Phase | Emission | Appearance | Lifetime | Motion |
| --- | ---: | --- | ---: | --- |
| Explosive | 0.55–0.75 puffs/tick | dark, dense ash clusters | 140–180 ticks | fast radial rise, moderate spread |
| Effusive | 0.08–0.15 puffs/tick | lighter gas wisps | 90–120 ticks | slow radial rise, low spread |
| Repose | 0 | existing puffs only | unchanged | continued expansion and fade |
| Dormant | 0 | existing puffs only | unchanged | continued expansion and fade |

Start with a maximum of 160 live puffs. The worst normal overlap must fit below
it: `0.75 × 180 = 135` explosive puffs, plus at most `0.15 × 40 = 6` effusive
puffs before the oldest ash expires, for a conservative peak of 141. Keep at
least this much headroom when tuning. If density is insufficient, first make
each puff a deterministic two- or three-lobe cluster; do not raise emission,
lifetime, or the cap independently of the budget calculation.

## Phase 2: eruption-phase integration

Add a function such as `stepVolcanoEffects()` that accepts:

- the engine and `VolcanoConfig`, for live summit geometry;
- the `VolcanoEffectMode` for the tick being simulated;
- the current `eruptionEpisode` integer;
- the effects state;
- a deterministic RNG;
- effect tuning.

The volcano changes `state.phase` inside `stepVolcanoPre()`, after performing the
old phase's work but before `engine.update()`. Reading `volcanoState.phase` after
the pre/post pair would therefore make the visual effect run one phase ahead on
transition ticks. Capture the phase at the start of the tick and use this exact
ordering:

```ts
const effectModeThisTick: VolcanoEffectMode = erupting
  ? volcanoState.phase
  : stoppedEffectMode;
let eruptionCompleted = false;

if (erupting) {
  stepVolcanoPre(...);
  engine.update();
  stepVolcanoPost(...);
  eruptionCompleted =
    volcanoState.phaseFrame < 0 ||
    isDormant(engine, volcanoCfg, capHeight);
} else {
  engine.update();
}

stepVolcanoEffects(..., effectModeThisTick, eruptionEpisode, ...);

// Only now convert a completed/capped eruption to dormant host state.
if (eruptionCompleted) goDormant();
```

This aligns the visible plume with the phase that was active at tick entry and
avoids showing the next phase before its source is created. A transition to
effusive or repose becomes visible on the following tick, when that phase
actually performs its first work. The effects helper may inspect summit geometry
while emitting, but must remain unable to change materials. Store the last live
vent position in effects state so glow and flash can render without duplicating
summit lookup in the canvas code.

Maintain `stoppedEffectMode` in the host: the stop button sets it to `paused`,
natural completion sets it to `dormant`, and reset restores `dormant`.

Phase behaviour:

- **Explosive:** continuously emit dense ash. When either the mode enters
  explosive or `eruptionEpisode` changes, trigger one short flash and shake
  impulse.
- **Effusive:** reduce emission to occasional pale gas wisps and let the ash
  column already in the air continue dispersing.
- **Repose:** emit nothing. Existing puffs continue to age and fade.
- **Dormant or paused:** emit nothing. Existing puffs, glow, flash, and shake
  continue decaying instead of freezing in place.

Within `stepVolcanoEffects()`, first advance and cull puffs that existed at the
start of the tick and decay existing scalar cues. Then process mode/episode
entry, update the live vent, and emit new puffs. A newborn puff therefore
renders at age zero, and a new flash/shake renders at full initial intensity.
Finally update `previousMode` and `previousEpisode`.

Reset effect state and re-seed its RNG when:

- the user clears the scene;
- resolution or planet diameter rebuilds the world;
- a completely new volcano is stamped.

Starting a later eruption should increment `eruptionEpisode` but keep any
still-living puffs from the preceding episode unless the scene was reset. This
makes closely spaced eruptions build a continuous-looking atmosphere without
retaining permanent state, while guaranteeing one entry flash and shake per
explicit start.

Avoid summit scans when they cannot affect output. If the mode is paused or
dormant and all puffs and scalar effects have expired, return immediately with
no allocations. This is the dormant fast path; the host still performs one
constant-time call so it can detect a later start.

## Phase 3: rendering

Render puffs in `showcase/sections/planet.ts`:

1. render the material grid;
2. enter the existing planet rotation transform;
3. render a small vent-glow overlay;
4. render ash puffs over the terrain;
5. render user-created weather clouds over the volcanic plume;
6. restore the transform and draw fixed UI overlays.

Keeping the plume inside the rotation transform makes grid-space positions
remain aligned with the visually spinning planet. No effect coordinate needs to
be rewritten when spin is toggled.

The grid is already a single flattened image, so an effect drawn afterward
cannot sit “behind” selected terrain. Treat the glow as a tightly bounded
overlay above the vent. Start puffs in verified empty space beyond the summit so
the base does not appear to pass through the cone. True terrain occlusion would
require a separate mask/pass and is outside the first slice.

### Puff appearance

Use overlapping translucent circles or small irregular clusters. Each puff
should have deterministic radius, lobe shape, and shade variation derived from
its stored `shapeSeed`; drawing the same state twice must produce identical
pixels. Begin with solid-alpha low-resolution lobes. Do not create a radial
gradient per puff per frame unless measurement shows it remains inside the
render budget. The result should retain the showcase's pixel-art character
rather than appearing like a high-resolution blur pasted on top of the grid.

Useful constraints:

- use a dark core and softer edge during the explosive phase;
- avoid pure black, which disappears into the space background;
- keep alpha low enough that overlapping puffs build density naturally;
- add a small amount of warm brown near the base to connect the cloud visually
  to tephra;
- do not use additive blending for ash.

## Phase 4: supporting effects

Add these only after the plume lifecycle and performance are stable.

### 4.1 Vent glow

Draw a small orange-red halo at the live vent during explosive and effusive
phases. Scale intensity with phase and fade it during repose. Keep the radius
small so it supports, rather than washes out, the engine's temperature colours.
Store or deterministically update `state.glow` so pause and dormancy can finish
the fade without consulting DOM state.

### 4.2 Eruption flash

On transition into the explosive phase, create a brief warm flash lasting only
a few ticks. It should be localized to the vent, not a full-screen white frame.

### 4.3 Subtle screen shake

Apply a short, decaying canvas translation when the explosive phase begins.
Shake must affect rendered world pixels only; it must not alter planet geometry
or the physics grid. Cap displacement to roughly one or two grid cells at the
default resolution and respect reduced-motion preferences.

Generate deterministic `shakeX` and `shakeY` in the effects step; rendering must
not choose random offsets. Apply the translation outside the planet rotation so
it shakes in screen axes, and restore before fixed overlays. The section should
query `prefers-reduced-motion` and render zero translation when it is enabled;
the DOM-free effects state should remain identical either way.

Rendering-only translation otherwise makes a click land one or two cells away
from the pixels under the pointer. Extract the canvas/grid coordinate conversion
into a pure helper and have it subtract the currently rendered shake offset
before applying inverse spin. Unit-test that composition. When reduced motion
is active, pass a zero offset to both rendering and pointer conversion.

### 4.4 Embers

Optionally reuse the effects helper for a small bounded list of warm particles
near the plume base. Embers should be sparse and short-lived; actual lava bombs
remain the engine's responsibility.

### 4.5 Plume shadow

If the column still lacks depth, derive a faint, broad shadow on the cone from
near-vent puff density. Treat this as polish and omit it if it reduces terrain
legibility.

## Phase 5: optional physical smoke

Do not make this part of the first implementation. Add simulated `SMOKE` cells
only if a later gameplay requirement needs ash or gas to interact with other
materials.

Keep the existing smoke lifetime semantics: `SMOKE` opts into the material-level
`decayChance`, which is evaluated before movement so freely rising cells can
expire. `escapesAtBoundary` also lets an outward rise leave the canvas instead
of falling back to edge-parallel movement. Preserve the deterministic flat- and
radial-gravity regression tests if the lifetime model later changes to explicit
per-cell state.

If physical smoke is added later:

- emit only a few cells close to the vent;
- give them a small outward velocity with `setVelocity()`;
- keep the large visual plume host-rendered;
- verify that smoke cannot block the pressure outlet;
- ensure the smoke count reaches zero after an eruption;
- measure active chunks after dormancy.

## Controls and product behaviour

Do not add more tuning sliders in the first slice. The volcano panel already
contains several temporary fountain and fragmentation controls. Ship sensible
effect defaults first and tune them against the default scene.

If a user-facing control proves useful later, prefer one **Plume density** or
**Effects** control over separate sliders for opacity, expansion, lifetime, and
drift. Internal options can remain granular for tests and development.

Pausing an eruption should stop new emissions but should not freeze existing
puffs. Turning the volcano back on starts a new explosive phase and therefore a
new flash and shake impulse.

## Testing

The showcase Vitest configuration intentionally runs under Node and cannot
import the DOM/canvas-coupled planet section. Keep effects, transition handling,
reset helpers, scaling, and pointer-transform math DOM-free so they can be
tested directly. Do not label browser event wiring as a Node integration test.

Add `showcase/tests/volcano-effects.test.ts` for these behaviours:

### Emission and phases

- explosive phase emits dark ash;
- effusive phase emits fewer and lighter puffs;
- repose, dormant, and paused states emit nothing;
- the origin follows a cone whose summit has grown above the original surface;
- the origin clearance ends in an empty cell;
- a phase transition uses the phase captured at the start of the physical tick;
- explosive entry triggers flash and shake only once;
- incrementing `eruptionEpisode` retriggers entry effects even if a pause and
  resume occur between effect ticks.

### Lifecycle and bounds

- puffs move away from the gravity center;
- radius increases and opacity decreases with age;
- expired and off-grid puffs are removed;
- a partly visible edge puff remains until its full radius is off-grid;
- the live count never exceeds the configured cap;
- normal shipped tuning peaks below the cap for the full phase sequence;
- forced saturation skips emissions without evicting still-live puffs or
  accumulating a later burst;
- phase changes and pauses clear fractional emission carry;
- a dormant scene eventually has zero puffs.

### Scaling and coordinates

- radii, speeds, vent clearance, and shake scale with planet radius;
- the 120/30%, 120/80%, 400/30%, and 400/80% world corners produce valid origins
  and finite effect state;
- screen-to-grid conversion composes inverse shake and inverse spin in the
  correct order;
- zero shake produces exactly the existing pointer mapping.

### Determinism

- the same seed and phase sequence reproduce identical effect state;
- different seeds vary positions and appearance while producing the same counts
  for the same fractional emission schedule;
- drawing or inspecting state does not advance the effects RNG;
- effect RNG changes do not alter the physical volcano's grid result.

### DOM-free orchestration

- reset returns empty effects, resets episode/mode bookkeeping, and restores the
  fixed effects seed;
- pause stops emission while lifecycle stepping continues;
- the full explosive → effusive → repose cycle leaves no permanent visual
  entities;
- existing volcano, cloud, renderer, and viewport tests continue to pass.

### Required browser verification

Because `planet.ts` is not imported by the Node test suite, verify its wiring in
the running showcase and record the result in the implementation handoff:

- Clear and both rebuild sliders remove all puffs, glow, flash, and shake;
- pause ages existing puffs without emitting, and resume produces one new entry
  cue without clearing them;
- spin keeps the plume attached to the summit;
- pointer painting remains aligned during non-zero shake;
- reduced-motion mode applies zero rendered and pointer-compensation shake;
- weather clouds render over the plume and fixed overlays do not shake;
- default and all four resolution/diameter corners retain a legible plume.

Canvas appearance requires this browser check because state tests cannot decide
whether alpha, ordering, clustering, and scale read correctly.

## Performance gates

The implementation is acceptable when:

- live puffs are hard-capped at the configured maximum;
- stepping is O(live puffs), with no full-grid scan;
- the empty paused/dormant fast path performs no summit scan and no allocation;
- no additional engine chunks are woken by the visual plume;
- normal shipped tuning never reaches the emergency cap;
- Clear and resize do not retain arrays or canvas state from the old world.

The existing performance readout stops before `render()`, so extend local
instrumentation to record effect-step time, render time, and total callback work.
At 400×400, capture a full eruption before and after the change in the same
browser on the same machine. The gate is:

- average effect step plus effect draw is at most 2 ms;
- p95 total callback work remains below the 16.7 ms 60 Hz budget;
- p95 total callback work increases by no more than the greater of 2 ms or 20%
  of the no-effects baseline; and
- engine `cells/tick` and active-chunk counts are unchanged apart from normal
  deterministic eruption variation, which should be zero when the physical RNG
  stream is correctly isolated.

Report both the baseline and result. A stable `cells/tick` figure alone does not
prove that a canvas overlay is inexpensive.

## Acceptance criteria

The first release is complete when all of the following are true:

- an explosive episode forms an unmistakable dark ash column;
- effusive and repose phases are visually distinct from the explosive phase;
- emission stays attached to the live summit as the cone grows;
- puffs expand, lighten, and disappear within a bounded lifetime;
- paused and dormant volcanoes create no new ash;
- identical seeds reproduce identical effect state;
- the effect count and per-frame work remain bounded;
- shipped tuning stays below the emergency cap without premature eviction;
- Clear, resize, and rebuild remove all residual effects;
- the plume rotates with the displayed planet and does not disturb pointer
  interaction or physics coordinates;
- explosive entry produces exactly one localized flash and one bounded shake;
- reduced-motion mode renders no shake;
- all engine and showcase tests pass;
- the required browser-verification checklist passes;
- maximum-resolution measurements pass all numeric performance gates.

## Delivery sequence

1. Add scaled DOM-free effects state, a dedicated RNG, deterministic emitter,
   lifecycle step, particle-budget tests, and phase-capture tests.
2. Extract and test shake-aware pointer-coordinate composition.
3. Integrate episode counting, exact tick ordering, state creation, pausing,
   dormancy, and reset behaviour in the planet section.
4. Render deterministic ash clusters inside the existing rotation transform and
   tune them at the default and four world-range corners.
5. Add restrained vent glow, phase-entry flash, and required
   reduced-motion-aware shake.
6. Measure the 400×400 baseline and effect-enabled loop, then complete the
   browser-verification checklist. Add optional embers only if the plume and
   required entry cues still lack impact and remain inside the same budget.
7. Revisit physical `SMOKE` cells only if material interaction becomes a real
   gameplay requirement.

## Deferred work

- wind as a world-level simulation field;
- atmospheric circulation around the planet;
- ash accumulation as a material distinct from `SAND`;
- gas expansion and shock-wave physics;
- rain washing ash from the air;
- toxic-gas or visibility gameplay;
- audio and haptic feedback;
- a general-purpose particle-effects framework shared by unrelated showcase
  features.

These can build on the bounded effects helper later, but none is required to
make the current volcano visibly emit a convincing ash-and-gas plume.
