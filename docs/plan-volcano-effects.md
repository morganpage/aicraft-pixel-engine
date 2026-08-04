# Plan: volcanic ash, smoke, and eruption effects

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
the radial-gravity center and spreads only when obstructed. `SMOKE` also only
has a chance to disappear while blocked, so freely rising smoke tends to form a
thin trail that persists until it reaches a grid boundary. Filling enough cells
to create a large, opaque plume would also keep many simulation chunks active.

Volcanic plumes are mostly ash and hot gases rather than combustion smoke. The
feature should therefore be called an **ash plume** in code and UI copy, even if
its overlapping grey puffs give it a smoke-like appearance.

## Outcome

At the end of this work:

1. explosive episodes build a dense, expanding ash column above the live vent;
2. effusive episodes release sparse, lighter gas wisps;
3. repose and dormancy stop emission while existing puffs disperse naturally;
4. the plume remains aligned with a growing and visually spinning planet;
5. eruption starts receive restrained glow, flash, ember, and shake cues;
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
export interface SmokePuff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  initialRadius: number;
  opacity: number;
  shade: number;
  age: number;
  lifetime: number;
}

export interface VolcanoEffectsState {
  puffs: SmokePuff[];
  emissionCarry: number;
  flash: number;
  shake: number;
  previousPhase: EruptionPhase | 'dormant';
}
```

The exact names may change, but the state must remain plain data so behaviour
can be tested under Node without a DOM or canvas.

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

Use the existing volcano PRNG pattern rather than `Math.random()`. Either give
effects their own fixed seed or derive a separate stream from `VOLCANO_SEED` so
changing plume tuning does not silently change the physical eruption.

### 1.2 Emit from the live summit

Do not use the original `ventPosition()` as the visual origin after the cone has
begun growing. Derive the origin from `summitRadius()` along the vent axis and
offset it one or two cells into open space. This prevents a mature cone from
burying its own plume origin.

Apply small tangential jitter across the crater mouth. Puffs should appear to
come from an area rather than a single perfectly straight pixel column.

### 1.3 Use fractional emission

Allow emission rates below one puff per frame by accumulating a fractional
carry. This is needed for sparse effusive wisps without a frame-modulo pattern:

```ts
state.emissionCarry += rate;
while (state.emissionCarry >= 1) {
  emitPuff(...);
  state.emissionCarry -= 1;
}
```

### 1.4 Step and cull puffs

Each tick should:

- advance position by velocity;
- accelerate slightly away from the planet center to suggest buoyant rise;
- apply bounded tangential drift;
- expand the radius over time;
- fade opacity using normalized age;
- lighten dark ash toward grey as it disperses;
- remove expired, invisible, or off-grid puffs;
- enforce a hard maximum puff count.

Prefer dropping the oldest puffs when the cap is reached. This keeps the active
vent readable and makes both runtime and memory use constant.

### Suggested initial tuning

These values are starting points for visual tuning, not public engine defaults:

| Phase | Emission | Appearance | Lifetime | Motion |
| --- | ---: | --- | ---: | --- |
| Explosive | 1.5–2.5 puffs/tick | dark, dense ash | 150–240 ticks | fast radial rise, moderate spread |
| Effusive | 0.08–0.20 puffs/tick | lighter gas wisps | 90–150 ticks | slow radial rise, low spread |
| Repose | 0 | existing puffs only | unchanged | continued expansion and fade |
| Dormant | 0 | existing puffs only | unchanged | continued expansion and fade |

Start with a maximum of 128 live puffs. Adjust only after measuring the default
and maximum-resolution scenes.

## Phase 2: eruption-phase integration

Add a function such as `stepVolcanoEffects()` that accepts:

- the engine and `VolcanoConfig`, for live summit geometry;
- the current eruption phase or dormant status;
- the effects state;
- a deterministic RNG;
- effect tuning.

Call it once per simulation tick after the volcano's pre/post update pair. This
ensures the helper sees the current phase and summit while remaining unable to
change engine materials.

Phase behaviour:

- **Explosive:** continuously emit dense ash. On entry, trigger a short flash
  and shake impulse.
- **Effusive:** reduce emission to occasional pale gas wisps and let the ash
  column already in the air continue dispersing.
- **Repose:** emit nothing. Existing puffs continue to age and fade.
- **Dormant or paused:** emit nothing. Existing puffs should still finish their
  lifecycle instead of freezing in place.

Reset effect state when:

- the user clears the scene;
- resolution or planet diameter rebuilds the world;
- a completely new volcano is stamped.

Starting a later eruption should keep any still-living puffs from the preceding
episode unless the scene was reset. This makes closely spaced eruptions build a
continuous-looking atmosphere without retaining permanent state.

## Phase 3: rendering

Render puffs in `showcase/sections/planet.ts`:

1. render the material grid;
2. enter the existing planet rotation transform;
3. render eruption glow behind or immediately above the vent;
4. render ash puffs over the terrain;
5. render user-created weather clouds over the volcanic plume;
6. restore the transform and draw fixed UI overlays.

Keeping the plume inside the rotation transform makes grid-space positions
remain aligned with the visually spinning planet. No effect coordinate needs to
be rewritten when spin is toggled.

### Puff appearance

Use overlapping translucent circles or small irregular clusters. Each puff
should have deterministic radius and shade variation. A radial gradient may be
used sparingly, but the result should retain the showcase's low-resolution,
pixel-art character rather than appearing like a high-resolution blur pasted on
top of the grid.

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

### 4.2 Eruption flash

On transition into the explosive phase, create a brief warm flash lasting only
a few ticks. It should be localized to the vent, not a full-screen white frame.

### 4.3 Subtle screen shake

Apply a short, decaying canvas translation when the explosive phase begins.
Shake must affect the rendered world only; it must not move pointer mapping,
planet geometry, or the physics grid. Cap displacement to roughly one or two
grid cells at the default resolution and respect reduced-motion preferences.

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

Before doing so, change smoke lifetime semantics so freely moving cells can
expire. The current gas step only attempts smoke dissipation after all rise and
sideways movement paths are blocked. A suitable engine-level extension would
give selected gases an independent per-tick decay probability or explicit
lifetime state, with deterministic tests under both flat and radial gravity.

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

Add `showcase/tests/volcano-effects.test.ts`. Keep state stepping DOM-free and
test these behaviours directly:

### Emission and phases

- explosive phase emits dark ash;
- effusive phase emits fewer and lighter puffs;
- repose, dormant, and paused states emit nothing;
- the origin follows a cone whose summit has grown above the original surface;
- phase entry triggers flash and shake only once.

### Lifecycle and bounds

- puffs move away from the gravity center;
- radius increases and opacity decreases with age;
- expired and off-grid puffs are removed;
- the live count never exceeds the configured cap;
- a dormant scene eventually has zero puffs.

### Determinism

- the same seed and phase sequence reproduce identical effect state;
- different seeds vary positions and appearance without changing counts beyond
  defined stochastic bounds;
- effect RNG changes do not alter the physical volcano's grid result.

### Integration

- Clear and world rebuild reset effect state;
- pause stops emission while lifecycle stepping continues;
- the full explosive → effusive → repose cycle leaves no permanent visual
  entities;
- existing volcano, cloud, renderer, and viewport tests continue to pass.

Canvas appearance should receive a manual visual check at minimum, because
state tests cannot determine whether overlapping alpha, ordering, and scale read
correctly on the actual showcase.

## Performance gates

The implementation is acceptable when:

- live puffs are hard-capped at the configured maximum;
- stepping is O(live puffs), with no full-grid scan;
- dormant effects settle to zero work after their final puff expires;
- no additional engine chunks are woken by the visual plume;
- the 400×400 showcase remains smooth through a full eruption;
- Clear and resize do not retain arrays or canvas state from the old world.

The existing performance readout measures simulation work before rendering, so
also inspect total frame time or separately time effect drawing while tuning the
puff cap. A stable engine `cells/tick` figure does not prove that a canvas
overlay is inexpensive.

## Acceptance criteria

The first release is complete when all of the following are true:

- an explosive episode forms an unmistakable dark ash column;
- effusive and repose phases are visually distinct from the explosive phase;
- emission stays attached to the live summit as the cone grows;
- puffs expand, lighten, and disappear within a bounded lifetime;
- paused and dormant volcanoes create no new ash;
- identical seeds reproduce identical effect state;
- the effect count and per-frame work remain bounded;
- Clear, resize, and rebuild remove all residual effects;
- the plume rotates with the displayed planet and does not disturb pointer
  interaction or physics coordinates;
- all engine and showcase tests pass;
- maximum-resolution performance remains within the existing 60 Hz target.

## Delivery sequence

1. Add the DOM-free effects state, deterministic emitter, lifecycle step, and
   unit tests.
2. Integrate state creation, stepping, pausing, and reset behaviour in the
   planet section.
3. Render the ash plume inside the existing rotation transform and tune it at
   default and maximum resolution.
4. Add restrained vent glow and phase-entry flash.
5. Add reduced-motion-aware shake and optional embers if the plume alone does
   not provide enough eruption impact.
6. Revisit physical `SMOKE` cells only if material interaction becomes a real
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
