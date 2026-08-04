# Plan: pressure-launched volcanic tephra

> Status: implemented with validated design changes. Follow-on to Phase 6 of
> [plan-pressure.md](./plan-pressure.md). This plan addresses the gap between the
> engine's working pressure/velocity primitives and a visible, physics-driven
> volcanic fountain.

> **As built:** threshold sweeps from `0.65` through `0.80` did not increase the
> deposit because fountain parcels were already fragmenting. The actual loss
> occurred after fragmentation: ordinary SAND (density 10) sank through LAVA
> (density 8), returned to the reservoir, and remelted. The implementation
> therefore adds dedicated TEPHRA (density 7), preserves its launch state, and
> limits the explosive outlet to one route per frame to prevent same-frame
> lateral branching. These findings supersede the SAND-only and multi-volume
> assumptions in the original proposal below.

## Problem

The explosive phase was configured to route LAVA from the chamber to a real
outlet, convert surplus pressure into velocity, cool the launched material, and
fragment it into SAND. Every individual capability existed, but its update
semantics cancelled the intended result.

The shipping radial-volcano fixture demonstrates the failure:

- a 300-frame explosive phase creates at most about 21 SAND cells and ends with
  about 17;
- only four frames have any active velocity, with at most one moving cell;
- the pressure-launched fountain integration test fails because it observes no
  velocity near the vent during its first 100 frames;
- the cone test accepts `SAND >= 0`, so it cannot detect the absence of tephra.

The direct cause is the order and meaning of the current operations:

1. `runVelocityStep()` executes before `runPressureInjections()`.
2. Pressure shifts a parcel into an outlet and gives it launch velocity.
3. `runHeatStep()` executes later in the same update.
4. The exposed outlet parcel cools below LAVA's `fragmentsAt` threshold and is
   transformed into SAND.
5. Phase change calls `setMaterial`, whose placement semantics intentionally
   reset velocity. The fragment is therefore stationary before it ever reaches
   a velocity pass.

This is not just an update-order bug. Fragmentation is a physical transformation
of an existing parcel, while `setMaterial` means "place a new material here".
Those operations need different state-transfer policies. A fragment should keep
the parent parcel's momentum and temperature; a brush placement should not.

Three secondary issues make the failure less visible:

- `OUTLET_VELOCITY_EFFICIENCY` is `1.0`. Kinetic head then consumes all surplus
  head, so the first accepted parcel generally drains the source even when its
  configured rate is three cells per frame. Pending volume remains backed up
  instead of becoming a dense fountain.
- the broad terminal bore exposes side outlets. The pressure router correctly
  treats those as real boundaries, but the final path edge can point sideways
  rather than radially away from the planet.
- the removed host plume tinted SAND dark grey. Engine-created fragments use
  ordinary SAND appearance, so the few stationary products read as yellow sand
  rather than volcanic ejecta.

## Outcome

At the end of this work, the explosive phase should be engine-driven from
source to deposit:

1. a persistent chamber source moves conserved parcel state through the
   connected conduit;
2. surplus head launches multiple parcels from a real vent;
3. launched LAVA travels away from local gravity for multiple frames;
4. cooling LAVA fragments in flight;
5. the resulting granular material inherits momentum, falls under radial
   gravity, and piles on both flanks;
6. the deposit has an unambiguous volcanic appearance;
7. no host helper selects fallout destinations or directly places plume cells.

Ordinary unpressurized lava, brush placement, freezing, deterministic replay,
and pressure-free worlds must retain their existing behaviour.

## Scope

This work completes the LAVA-to-TEPHRA path. It does not add ash clouds, gas
expansion, shock waves, particle size distributions, or a Navier-Stokes solver.

Validation proved that volcanic fragments do need behaviour distinct from
ordinary SAND: they must be less dense than LAVA to avoid sinking and remelting.
TEPHRA therefore has a dedicated material id, granular motion, density 7, and an
ash-brown base palette. Preserved fragment heat remains the provenance used by
the showcase for its hot-to-cool colour ramp.

## Design

### 1. Separate parcel transformation from material placement

Keep `PixelEngine.setMaterial` unchanged. Its current contract is correct for a
brush, source write, reaction spawn, or host placement: changing material clears
old colour, stiffness, growth state, and velocity.

Add one internal transformation primitive with explicit state policy. A
representative shape is:

```ts
interface ParcelTransformPolicy {
  preserveHeat?: boolean;
  preserveVelocity?: boolean;
  preserveColor?: boolean;
  preserveStiffness?: boolean;
}

private transformMaterial(
  x: number,
  y: number,
  into: MaterialType,
  policy: ParcelTransformPolicy,
): void;
```

The exact name is not important; the semantic distinction is. The helper must:

- capture the selected companion fields before changing the material;
- perform the same growth-membership, chunk-wake, thermal-wake, and render-dirty
  maintenance as `setMaterial`;
- restore selected state after the material change;
- keep `velCells` consistent when velocity is preserved or cleared;
- preserve both velocity components and both fixed-point remainder components;
- avoid allocating velocity or colour grids in worlds that have never used
  those features.

Use the following policies in the heat phase:

| Transition | Heat | Velocity | Remainder | Colour | Stiffness |
| --- | --- | --- | --- | --- | --- |
| LAVA -> TEPHRA fragmentation | preserve | preserve | preserve | replace | clear |
| LAVA -> ROCK freezing | preserve | clear | clear | replace | clear |
| ordinary melting/freezing | preserve | clear | clear | replace | clear |

Only fragmentation preserves momentum. Applying that behaviour to every phase
change would allow an immobile ROCK product to remain in the active velocity set
and would undermine the existing airborne-freeze guard.

The resulting launch pipeline spans two updates and must be pinned explicitly:

1. update N runs its velocity pass before the new parcel exists;
2. pressure then writes outlet velocity;
3. heat fragments the parcel while preserving that velocity;
4. the rendered end-state of update N is TEPHRA at the outlet with nonzero
   velocity;
5. update N+1 runs velocity first and moves the SAND before the next pressure
   injection.

This creates one rendered frame of latency between launch and displacement. Do
not reorder the engine passes merely to hide it: pressure relies on running
before ordinary falling, and velocity relies on processing the preceding
frame's outlet cells first. The Phase 0 test must prove that a fragment present
at the end of update N moves on update N+1. Manual tuning must also check for an
objectionable stationary flash at the nozzle. Add a flight-age field only if
that artifact is visible after momentum preservation works; it is not part of
the minimum correctness fix.

### 2. Keep tephra appearance in the showcase

Do not add `fragmentColor` to `MaterialDef`. That would put the product's
appearance on the source material and mix a showcase rendering concern into the
core phase-change model. The engine contract already leaves interpretation of
`colorGrid` and temperature to the host.

Extend the showcase's `syncFromHeat` instead:

- a TEPHRA cell above the showcase glow floor is treated as newly fragmented hot
  ejecta and receives a temperature-derived volcanic colour;
- that colour rides with the parcel through the existing `colorGrid` transfer
  rules and therefore serves as its rendering provenance after it cools;
- a TEPHRA cell already carrying one of the tephra palette colours is updated
  toward the final dark basalt tint as its temperature falls;
- ambient, uncoloured brush-placed SAND remains ordinary yellow sand;
- allocation of `colorGrid` remains host-controlled and already occurs in the
  volcano showcase.

Use a fixed temperature palette or coordinate hash, never the engine's global
RNG. Cosmetic painting must not change fire, growth, or reaction outcomes. Keep
the palette recognisable so `syncFromHeat` can distinguish an already-marked
tephra parcel from unrelated custom-coloured cells without adding another
per-cell state grid.

The showcase's `tintTephra` helper can remain for the standalone legacy
`emitPlume` test, but the active eruption path must not depend on it.

### 3. Make source rate meaningful without duplicating energy

Retain the current energy accounting:

```text
available head after launch
  = available head before launch
  - route cost
  - kinetic head
```

The defect is the `1.0` conversion efficiency. At that value, kinetic head is
the entire surplus, leaving nothing for another pending volume. Start with the
documented `0.7` default, for which kinetic head is `surplus * 0.7^2`.

That speed must be the **total** launch-speed budget, including lateral spread.
The current implementation computes a forward Torricelli component and then
adds a lateral component, but deducts kinetic head using only the forward speed.
That creates uncharged kinetic energy.

Build a normalized launch vector instead. For forward outlet normal `n`, tangent
`t`, and deterministic lateral ratio `q`:

```text
direction = (n + q*t) / sqrt(1 + q^2)
velocity  = torricelliSpeed * direction
```

After fixed-point rounding and Int8 clamping, compute the charged kinetic head
from the velocity actually assigned:

```text
actualSpeed  = hypot(dvx, dvy) / VELOCITY_CELL_UNIT
kineticHead  = actualSpeed^2 / 2
```

Rounding must never make `routeCost + kineticHead` exceed the available head;
scale or round the components down if necessary. This keeps spread inside the
same energy envelope rather than treating cone width as free energy.

Prefer exposing efficiency as a pressure-source option rather than permanently
tuning one global constant:

```ts
interface PressureSourceOptions {
  // existing fields...
  outletVelocityEfficiency?: number; // default 0.7, clamped to 0..1
}
```

One-shot injections can use the engine default. The volcano's explosive source
can then be tuned independently without making ordinary effusion ballistic.
`MIN_OUTLET_SURPLUS` remains the effusive/explosive gate.

Tests must prove both sides of the accounting:

- lowering efficiency reduces launch speed and kinetic head together;
- changing lateral spread rotates the launch vector without increasing its
  total speed or kinetic head;
- kinetic deduction matches the final quantized and clamped velocity components;
- no route spends more head than the source owns;
- a source with `rate > 1` can launch more than one parcel in a frame when its
  route and pressure budget permit it;
- pending volume remains bounded when the requested rate exceeds affordable
  throughput.

Do not solve throughput by skipping the kinetic-head deduction or by giving
each pending parcel the source's original full pressure. Either approach would
double-count energy.

### 4. Make the showcase expose one real outward vent

The engine router should continue choosing a real, affordable boundary. It
should not gain volcano-specific knowledge or silently ignore valid side leaks.

Instead, change the terminal two or three cells of the stamped conduit into a
narrow radial nozzle:

- taper the multi-cell bore to its centreline near the surface;
- leave one EMPTY cell beyond the radial end;
- keep ROCK on the lateral sides of the terminal segment;
- allow pressure fracture to reopen the radial cap if it freezes.

This makes the cheapest real outlet point opposite local gravity without adding
an `upwardOnly` routing mode. Verify this geometry at every supported planet
resolution and diameter, because rounding can otherwise reopen a diagonal or
side boundary.

If a generic outlet-direction problem remains after the geometry is corrected,
address it separately with an outlet-normal design. Do not bias the least-cost
router toward upward outlets merely to make this showcase pass.

### 5. Keep temperature transport physical

Preserve the current `_shiftPath` temperature behaviour. `copyParcel` moves the
existing top parcel and its heat into the outlet, while the requested source
temperature is written only to `p0`. Repeated shifts then advect that hot pulse
through the conduit. Assigning source temperature directly to the outlet would
teleport heat and erase the conduit-length delay that pressure transport is
intended to model.

The upper conduit may therefore eject relatively cool material at the start of
an episode. With momentum-preserving fragmentation this becomes an initial
tephra-rich clearing burst, followed by hotter lava bombs as the reservoir pulse
arrives. That is a useful eruption shape rather than a defect.

### 6. Align comments and controls with the implemented rule

After the behaviour is stable:

- update `MaterialDef.fragmentsAt` documentation to match the actual velocity
  criterion and the final default threshold;
- remove references claiming that the active eruption still calls
  `emitPlume`;
- make the fragmentation slider initialize the live material value, not only
  update it after the first input event;
- ensure restarting or rebuilding the planet resets mutable global material
  tuning so one showcase session cannot leak into another test or world.

## Delivery sequence

### Phase 0 - pin the failure

- Add a unit regression in `src/tests/sand-fragmentation.test.ts` where pressure
  launches a cool LAVA parcel, heat fragments it in the same update, and the
  resulting TEPHRA still has nonzero velocity.
- Assert separately that it remains at the outlet at the rendered end of that
  update, moves on exactly the following update, and later falls under gravity.
- Add a radial fixture using the shipping conduit geometry and record outlet
  position, material, temperature, and velocity without relying on rendered
  pixels.
- Replace the permissive count with a composition assertion requiring exterior
  TEPHRA to exceed exterior LAVA plus ROCK.
- Keep the currently failing fountain test as the integration-level red test.

### Phase 1 - implement momentum-preserving fragmentation

- Add the internal parcel-transform primitive.
- Route fragmentation through it with heat, velocity, and remainder preserved.
- Keep other phase changes on their current clear-momentum policy.
- Add active-set and material-conservation tests.
- Run all existing pressure, velocity, heat, phase-change, determinism, and
  settling tests before continuing.

This is the minimum correctness fix and should land independently of visual
tuning.

### Phase 2 - focus pressure throughput

- Keep outlet conversion efficiency configurable per persistent source.
- Preserve the existing energy-ledger tests.
- Tune explosive pressure rate and cap with `maxPending: 1`; multiple routes in
  one update branch around the first still-liquid outlet parcel before the heat
  pass can fragment it.
- Confirm that effusive settings remain below the ballistic threshold in the
  shipping volcano.

### Phase 3 - constrain the real vent

- Retain the existing stamped bore; tapering did not improve the measured cone.
- Use the one-route pending cap to keep the selected opening focused.
- Test that launched material reaches the exterior at supported planet sizes.
- Retain fracture behaviour for a cooled radial cap.

### Phase 4 - restore tephra appearance

- Extend showcase `syncFromHeat` to recognise hot TEPHRA and let
  its volcanic colour travel with the parcel in `colorGrid`.
- Transition marked tephra toward a dark basalt tint as it cools.
- Verify that engine-created fallout renders as volcanic material and ordinary
  brush-placed SAND remains unchanged.

### Phase 5 - tune and remove stale assumptions

- Tune against the 220x220 shipping planet first, then verify the full size and
  diameter matrix.
- Remove stale plume comments and temporary controls that are no longer useful.
- Update `docs/integration.md` and the as-built section of
  `docs/plan-pressure.md` with the final semantics and any deviations from this
  plan.

## Tests and acceptance criteria

### Engine correctness

- A pressure-launched LAVA cell that fragments before its first velocity pass
  retains exactly the assigned velocity and fixed-point remainder.
- On the following frame the TEPHRA fragment moves away from gravity.
- Drag and gravity eventually reverse the outward motion and return the fragment
  toward a surface.
- A collision can stop the fragment without duplicating or deleting it.
- Grounded, non-velocity LAVA still freezes to ROCK rather than fragmenting.
- Brush-changing LAVA to TEPHRA still clears old velocity; only the physical
  fragmentation path preserves it.
- Fragmentation preserves temperature without adding a core appearance field.
- Same seed plus the same public calls produces identical grid, heat, colour,
  velocity, and remainder fields.
- A world that never uses velocity or fragmentation retains its lazy allocation
  and deterministic baseline.

### Pressure and energy

- Kinetic head equals the head implied by the actual assigned speed.
- Forward and lateral components together remain inside that speed and head
  budget.
- Route cost plus kinetic head never exceeds available source head.
- At explosive defaults, parcels remain ballistic across frames while no more
  than one new route is opened in a single update.
- At effusive defaults, outlet cells do not receive ballistic velocity unless
  pressure has accumulated behind a genuine block.
- Pending volume and pressure remain capped under a permanently blocked source.

### Volcano integration

For the default 220x220, radius-66 planet after one 300-frame explosive phase:

- the fountain test observes moving material near the real vent;
- at least one moving cell is SAND, proving fragmentation and momentum compose;
- the maximum active-velocity count exceeds one;
- fallout exists outside the original planet radius on both sides of the vent;
- the maximum ejecta radius exceeds the original surface by several cells;
- a visible granular deposit survives assimilation at the end of the phase;
- hot and previously marked SAND is rendered with the showcase tephra palette,
  while ambient brush-placed SAND keeps its ordinary appearance;
- no active eruption helper calls `emitPlume`, directly places SAND in the sky,
  or names a fallout destination;
- the crater remains open enough for the following effusive phase;
- total source-created volume matches accepted source volume in a fixture where
  fracture and phase-change products are counted together.

After tuning, replace "visible deposit" and "several cells" with numeric
thresholds derived from the accepted reference run. As an initial target, use at
least 60 surviving fragments, at least 30 outside the original surface, and a
maximum radius at least four cells beyond it. These numbers must be adjusted if
the accepted visual result demonstrates a better stable threshold, not weakened
merely to make a regression pass.

### Verification commands

Run all of the following because the core and showcase use separate Vitest
configurations:

```sh
npm test
npm run showcase:test
npm run build
npm run showcase:typecheck
npm run showcase:build
```

The manual acceptance check is a full explosive-to-effusive cycle at the minimum,
default, and maximum supported planet sizes. The result should visibly clear the
vent, throw dark granular ejecta through arcs, deposit it on both flanks, and
then send hotter lava through the same opening without direct host placement.

## Risks and controls

- **Velocity-set corruption.** Preserving array values without maintaining
  `velCells` can create moving cells that are never processed or stale indices
  pointing at stationary material. Centralize both operations in the transform
  primitive and test the invariant after every transition.
- **Accidental mobile rock.** Do not make velocity preservation the default for
  all phase changes. It is an explicit fragmentation policy only.
- **Energy inflation.** Retain route and kinetic deductions and test the ledger
  numerically before tuning visual constants.
- **Router distortion.** Fix the terminal conduit geometry before adding a
  generic preference for upward outlets.
- **RNG drift.** Showcase tephra colour must be fixed or hash-derived, never
  selected by advancing the simulation RNG.
- **Outlet flash.** A newly fragmented parcel is rendered at the nozzle for one
  frame before its first velocity step. Pin the next-frame movement and judge
  the flash visually before adding another state field or changing update order.
- **Assimilation hiding the result.** Measure produced, airborne, deposited, and
  assimilated counts separately while tuning. A final count alone cannot tell
  whether fragmentation failed or valid fallout was later remelted.
- **Resolution dependence.** Verify vent connectivity and deposit thresholds
  across the complete planet geometry matrix, not only a reduced test planet.

## Definition of done

This fix is complete when pressure-launched LAVA can fragment into moving,
visually volcanic granular material without host-side placement; that material
travels through a measurable ballistic arc and deposits on the radial planet;
source throughput and kinetic energy remain bounded; the effusive eruption still
works; and both core and showcase suites enforce those behaviours with assertions
that fail when tephra production returns to zero.
