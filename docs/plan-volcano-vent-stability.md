# Plan: stable volcanic vents and localized plug fracture

> Status: Phase 2 mostly implemented. The axial vent corridor restricts both
> routing outlets and fracture targets to cells near the vent axis (not a fixed
> surface point), tracking cone growth across repeated eruptions. Dormant frames
> maintain the chamber and buried conduit at repose depth so restarts can route
> magma. Both explosive and effusive sources use corridor-constrained directional
> fracture with separate budgets. A three-cycle restart scenario test verifies
> every eruption produces exterior discharge.
>
> **Superseded in part.** This plan treats a sealing vent as a fracture-tuning
> problem, and the premise turned out to be wrong: the conduit was only
> maintained up to the *original* planet radius, so an active vent was buried by
> the volcano's own deposits within tens of frames and fracture was doing the
> work of the vent. `ventTopRadius` now maintains the bore up to the point where
> it opens to the sky, and fracture is back to opening the repose cap only.
> Phase 3's "feed buried throat cells" is therefore done, by a different route
> than described; its mouth flare is not, and is probably unnecessary now.
> Phase 4's discharge limit is in place for both sources.
>
> **Remaining:** `fractureFront` is tracked but its local-continuation search is
> not implemented — fracture may still hop between parallel lanes inside the
> corridor. The restart test does not mirror production cap progression and
> accepts weak later eruptions. Phase 5 (debris accounting) and full Phase 6
> verification (visual captures, full test matrix) are outstanding.
>
> **New, not covered here:** the growth cap outruns the erupted volume, so a
> tall cap funnels the deposit into a spire rather than broadening the cone; the
> fountain's ballistic range does not grow with the edifice; and
> `VolcanoState.breach` (flank breakouts instead of summit overflow) is declared
> and unused, which is what long flank flows want.

## Summary

The volcano currently has an implausible failure cycle:

1. a narrow, exposed throat cools and seals quickly;
2. the same pressure budget used for ordinary magma transport is immediately
   available for fracture;
3. a sealed source may select breakable terrain outside the actual plug;
4. more than one cell can fracture and route in the same update; and
5. accumulated magma can be released faster than the configured steady flow.

The result reads as a vent repeatedly gumming shut and then mining or flooding
the cone. Fixing this by raising injection temperature or lowering
`maxPending` changes the frequency and size of the symptom, but does not make
the failure mechanism safe.

The durable fix is to separate four responsibilities:

- **transport head** keeps magma moving through an open conduit;
- **fracture overpressure** accumulates slowly only while the conduit is truly
  sealed;
- **the fracture front** opens one localized outward channel through the plug;
- **the discharge limit** prevents stored volume from dumping faster than the
  source's configured flow rate.

The volcano host must also keep the buried throat hot while allowing only its
exposed skin to crust during repose. This targets the vent without globally
slowing lava cooling or changing the morphology of surface flows.

## Goals

At the end of this work:

1. an actively erupting vent remains open under ordinary continuous flow;
2. a repose crust can form, hold briefly, and reopen after a visible pressure
   buildup;
3. fracture advances through a narrow plug channel rather than selecting weak
   solids around the chamber or cone;
4. an unbreakable foremost obstruction stalls the source instead of redirecting
   fracture sideways;
5. no pressure source fractures more than one cell per update;
6. stored volume cannot discharge faster than an explicit per-frame limit;
7. the Fountain Rate control remains monotonic across its full range;
8. rock outside the authored vent corridor is unchanged after repeated
   eruption cycles; and
9. lava fountains, fragmentation, finite flows, cooling, and cone growth retain
   their existing behavior.

## Non-goals

This plan does not:

- lower `LAVA.emissivity` globally;
- replace the engine's heat model or add general latent-heat simulation;
- remove pressure-routed ascent or Torricelli outlet velocity;
- turn the pressure solver into a full stress or continuum-fracture model;
- use host-painted flank destinations to bypass the real vent;
- solve ash-plume rendering or other cosmetic eruption effects; or
- tune every source around a single screenshot before behavioral invariants are
  protected by tests.

## Current behavior and remaining gaps

### Vent geometry and heat

At the default planet size, `conduitHalfWidth` normally produces a three-cell
bore with occasional five-cell swells. The final bore section is exposed to the
environment and the reservoir feed stops three cells short of the surface.
Those choices make a small amount of cooled lava or fallen tephra sufficient to
seal every outlet.

Changing the explosive source temperature from `MAGMA_TEMP` (`0.75`) to
`VENT_TEMP` (`0.95`) is not a complete solution:

- the source temperature is written at the chamber feed, not directly at the
  surface;
- the hotter parcel must be shifted through the conduit before it reaches the
  vent; and
- for a cell with one exposed face, the idealized environment-exchange term
  changes the freeze time only from roughly 16 frames to roughly 20 frames at
  ambient `0.10`, before conduction and movement are considered.

`VENT_TEMP` may still be useful after the structural work as visual and thermal
tuning, but it should not be the mechanism that guarantees vent stability.

### Pressure and fracture

The explosive source currently restores its transport pressure to its maximum
very quickly. That is useful for maintaining a fountain, but it also means a
new plug is immediately exposed to fracture-level head. Transport and fracture
therefore operate on incompatible time scales.

The in-progress fracture changes improve two important rules:

- only a genuine `noOutlet` result may invoke fracture; and
- a higher-potential boundary is preferred to a globally weaker deep solid.

The remaining gaps are:

- only fractureable solids participate in target selection, so an unbreakable
  foremost cap can be ignored in favor of breakable terrain behind or beside
  it;
- there is no consecutive-seal delay;
- ordinary transport pressure doubles as fracture overpressure;
- the routing loop may retry immediately after a fracture and break additional
  cells in the same update;
- the selected front is not remembered across frames; and
- the current regression checks that one deep tephra canary survives, but does
  not assert that no other terrain was excavated.

### Backlog release

`maxPending` bounds total stored volume, not the desired discharge rate. Lowering
it from four to two would reduce one kind of burst, but it would also flatten the
upper half of a zero-to-four Fountain Rate control: rates two, three, and four
would all saturate the same two-cell pending ceiling.

The source instead needs a separate per-update discharge limit. Pending magma
may remain queued, but it must drain over later frames rather than being treated
as permission for an arbitrarily large catch-up tick.

## Required invariants

The following rules should be treated as engine contracts rather than showcase
tuning:

1. `insufficientHead` never fractures a solid.
2. `searchLimit` never fractures a solid.
3. Only consecutive `noOutlet` results count as a sealed interval.
4. Transport head alone never satisfies a fracture threshold.
5. The foremost outward obstruction is selected before affordability and
   breakability are considered.
6. If that obstruction is unbreakable or currently too strong, the source
   waits; it does not choose a deeper or more lateral fallback.
7. A source fractures at most one cell in an update.
8. After a fracture, that source stops processing until the next update.
9. Subsequent fracture advances from the remembered front instead of restarting
   a whole-boundary weakest-cell search.
10. Accepted discharge never exceeds the source's configured per-update limit.
11. Opening a plug consumes pending magma explicitly; fracture must not create
    unaccounted lava volume.

## Phase 0: capture the regression before changing behavior

Add deterministic tests at both the engine and volcano layers.

### Engine fixture

Construct a radial or flat conduit with:

- a connected lava chamber and bore;
- a shallow cap at the outward end;
- breakable rock and weak tephra along deeper boundaries;
- an optional unbreakable cell at the foremost point; and
- a persistent source with enough transport head to reach an open outlet.

Record the initial material grid and every frame's:

- rejection reason;
- `fracturesLastFrame`;
- pressure-source state;
- accepted volume; and
- changed solid coordinates.

The fixture must fail under the old behavior by demonstrating an off-front
solid mutation. Do not limit the assertion to a single canary cell: compare the
complete protected-region mask.

### Volcano fixture

Build the default radial planet and derive a **vent corridor mask** from the
same bore geometry used by `stampVolcano`. Include a small, explicit halo for a
surface flare and rasterization, but exclude the rest of the cone and chamber
wall.

Run at least three complete eruption cycles and retain the material originally
present at every protected cell. Assert that pressure fracture never changes an
original solid outside the corridor. Surface lava and falling tephra may cover
protected cells; the test should distinguish deposition from pressure-driven
replacement by recording fracture coordinates or an equivalent trace.

## Phase 1: separate transport head from fracture overpressure

Extend persistent pressure-source state with values equivalent to:

```ts
interface PressureSourceFractureState {
  sealedFrames: number;
  fracturePressure: number;
  fractureFront: number | null;
}
```

Add source configuration equivalent to:

```ts
interface PressureSourceFractureOptions {
  minSealedFrames: number;
  pressureRate: number;
  maxPressure: number;
}
```

The exact public shape may be nested under `fracture` or expressed as optional
fields on `PressureSourceOptions`. Prefer the shape that keeps ordinary sources
simple and makes fracture visibly opt-in.

Processing rules:

1. An accepted route resets `sealedFrames`, `fracturePressure`, and a completed
   fracture front.
2. `insufficientHead` and `searchLimit` do not accrue fracture pressure because
   the source is not proven sealed.
3. A `noOutlet` result increments `sealedFrames`.
4. Fracture pressure begins accruing only for the sealed source and is capped
   independently of transport head.
5. No fracture attempt occurs before `minSealedFrames`.
6. A successful fracture deducts the selected solid's strength from fracture
   pressure, not from the transport budget.

For compatibility, existing non-volcano tests may use defaults reproducing the
current immediate behavior. The shipping volcano must supply explicit delayed,
slow fracture settings. If the pressure API is still considered pre-release,
prefer safe physical defaults and update the tests deliberately instead of
preserving an unsafe default accidentally.

Suggested initial showcase values, to be tuned after tests exist:

- `minSealedFrames`: 24–36 frames;
- fracture pressure rate: `0.5–1.0` head per frame;
- maximum fracture pressure: slightly above rock strength; and
- one fracture per source per update.

These numbers are starting points, not contracts. The behavioral contract is a
visible sealed interval followed by bounded, localized failure.

## Phase 2: make the fracture front directional and local

### Select the obstruction before asking whether it can break

When a source is sealed, inspect all non-empty solid boundary cells, including
solids without `pressureStrength`. Select the foremost outward obstruction by:

1. highest gravitational potential;
2. continuity with the remembered fracture front, when one exists;
3. shortest local distance from that front;
4. lower strength only within the same outward tier; and
5. stable cell index as the final deterministic tie-break.

Only after selecting the obstruction should the engine ask:

- does the material opt into fracture?
- has sufficient fracture pressure accumulated?

If either answer is no, stop for the frame. Do not search for a weaker fallback
elsewhere. This is what makes an unbreakable cap stall rather than redirect the
solver into the cone wall.

### Remember one channel

On the first successful fracture, store its index as `fractureFront`. On later
sealed frames, prefer cardinal outward neighbors of that front. A small bounded
local search may handle rasterized corners, but the solver must not return to a
global chamber-boundary search while an unfinished front exists.

This produces a narrow fissure through a multi-cell plug and prevents repeated
frames from walking laterally across the summit.

### Stop after one fracture

Once one cell fractures:

- increment the global fracture counter;
- consume fracture pressure;
- update the front;
- wake the affected chunks; and
- stop processing that source until the next engine update.

The existing global `fracturePerFrame` remains useful when several independent
sources exist. It must not be used as permission for one volcano source to drill
four cells and route through all of them in one tick.

## Phase 3: keep the active throat open without warming every lava flow

Make vent heat maintenance geometry-aware and phase-aware inside the volcano
helper.

### Flare the mouth

Keep the deeper conduit at its existing scale, but widen the upper few cells
smoothly toward the surface. At the default planet size, target a mouth at least
five cells wide, with seven cells acceptable after visual testing. Scale the
flare depth and width with planet radius and preserve cardinal connectivity at
all supported resolutions.

The flare is not the primary safety mechanism; it makes a one-grain seal less
likely and gives the fountain more than one equivalent outlet.

### Feed buried throat cells

During explosive and effusive phases:

- maintain existing lava inside the authored bore up to just below the exposed
  surface;
- never remelt arbitrary surrounding rock;
- never clamp exposed surface lava permanently hot; and
- use a bounded temperature gradient toward the vent if testing shows that a
  constant reservoir temperature still allows premature deep freezing.

The exposure guard should be the boundary: a cell open to the sky may cool and
crust, while lava buried immediately below it remains supplied by the chamber.
Do not stop the feed three cells below the surface unconditionally.

During repose, continue feeding the buried throat but allow the outermost skin
to set. The desired repose state is a thin cap over molten plumbing, not a
three-cell frozen shaft.

### Handle fallen tephra conservatively

Tephra genuinely embedded inside the known bore may assimilate slowly when it
is surrounded by magma. Restrict this cleanup to bore geometry and an embedding
threshold. It must not propagate into the cone or remelt the bedrock walls.

Do not change global lava emissivity for this phase. Surface-flow cooling and
finite flow length depend on the existing value.

## Phase 4: limit discharge independently of stored volume

Add an explicit persistent-source discharge limit, for example:

```ts
maxDischargePerFrame?: number;
```

Source processing must stop once the limit is reached, leaving the rest of
`pending` queued for later frames. Transport and kinetic head are still deducted
for every accepted parcel exactly as they are now.

For the volcano, derive the initial limit from the selected Fountain Rate so the
control remains monotonic:

- a rate near one releases about one parcel per frame;
- a rate near two can release about two;
- rates three and four retain visibly higher steady throughput; and
- a blockage does not authorize a catch-up frame above that selected limit.

Keep `maxPending` as a memory and surge-energy bound. Do not use it as the
steady discharge control. Retune it only after discharge limiting is in place.

## Phase 5: make fractured material accounting explicit

The current fracture operation replaces the solid with the source liquid. That
looks like rock turning into magma and can also obscure whether pending source
volume was consumed.

At minimum:

1. require one pending source volume for a fracture to fill the newly opened
   cell;
2. decrement that pending volume exactly once; and
3. never allow the following routing retry to count the same opening as another
   injected volume in the same frame.

Preferably, add an explicit fracture product:

```ts
fracturesInto?: MaterialType;
```

Rock can produce tephra-like debris. Buried debris may be accumulated as a small
bounded source-local debt and emitted when the fissure reaches an empty outlet;
surface blockers can be displaced directly into an outward empty cell. This
keeps the single-cell material model understandable: incoming magma occupies
the fracture while the broken solid appears as ejecta instead of silently
becoming lava.

If debris accounting proves too large for this patch, land the trigger,
locality, one-cell pacing, and pending-volume correction first. Do not block the
runaway-excavation fix on a generalized debris system, but document any bounded
mass approximation that remains.

## Phase 6: tuning and full verification

Tune only after the engine invariants and regression masks pass.

Suggested order:

1. sealed-frame delay;
2. fracture-pressure rate and cap;
3. active throat feed depth;
4. mouth flare width;
5. per-frame discharge limit;
6. `maxPending`;
7. source temperature; and
8. fountain pressure and fragmentation presentation.

Changing source temperature to `VENT_TEMP` and reducing explosive `maxPending`
may still improve the final presentation. Treat them as measured tuning choices,
not substitutes for the structural work.

## Test matrix

### Engine pressure tests

Add or strengthen tests proving:

- `insufficientHead` never fractures;
- `searchLimit` never fractures;
- `noOutlet` does not fracture before the configured delay;
- fracture pressure accrues independently of transport pressure;
- an accepted route resets the sealed interval;
- an unbreakable foremost cap causes zero fallback fractures;
- weak deep tephra and every other protected solid survive;
- a multi-cell cap loses at most one cell per source per update;
- processing stops after a fracture until the next update;
- the remembered front advances outward through a plug;
- radial potential points the front away from the planet center;
- discharge never exceeds `maxDischargePerFrame`; and
- pending volume and fracture-created lava are accounted exactly once.

### Volcano tests

Add end-to-end tests proving:

- the default active vent does not remain sealed long enough to trigger routine
  fracture during healthy continuous discharge;
- repose creates only a shallow cap while the buried throat remains molten;
- the next episode waits visibly before breaking a real cap;
- reopening changes only a small number of cells inside the vent corridor;
- original rock outside the corridor remains unchanged across three cycles;
- an intentionally unbreakable vent stalls without excavating the summit;
- fountain throughput increases across representative Rate values rather than
  flattening above two;
- a released backlog respects the configured discharge limit;
- the cone retains its tephra composition and taper;
- lava still reaches the flanks, cools, stiffens, and stops; and
- identical seeds and settings produce identical grids and fracture traces.

Run the volcano checks at:

- the shipped default resolution and planet diameter;
- the smallest supported planet;
- the largest supported planet; and
- at least one high-resolution case where the conduit width scaling changes.

### Verification commands

Run:

```text
npm test
npm run build
npm run showcase:test
npm run showcase:typecheck
npm run showcase:build
```

Then perform deterministic visual captures of:

1. a normal explosive phase;
2. a normal effusive phase;
3. a repose cap;
4. the next episode reopening that cap; and
5. three completed eruption cycles.

Compare the captures for mouth width, duration of sealing, number and locality
of fracture flashes, release density, cone retention, and flow morphology.

## Acceptance criteria

The work is complete when all of the following hold:

- During normal active eruption, the vent does not repeatedly seal and fracture.
- A real repose plug remains closed for a visible, configured interval.
- Reopening consumes only a short, outward sequence of plug cells.
- No source fractures more than one cell in a frame.
- No original bedrock outside the vent corridor is fractured after three full
  cycles.
- An unbreakable foremost obstruction produces no fallback excavation.
- Temporary insufficient head produces no fracture.
- Stored volume never discharges above its explicit per-frame limit.
- Fountain Rate remains observably monotonic across its supported range.
- Pressure, heat, volcano, typecheck, and build suites pass.
- Visual captures show continuous venting with occasional localized reopening,
  not gum-then-detonate cycling or loss of the cone.

## Recommended implementation order

Land the work in reviewable slices:

1. regression masks and failure fixtures;
2. sealed-frame state and separate fracture pressure;
3. all-solid outward targeting, front memory, and one-fracture pacing;
4. active throat feed and surface flare;
5. discharge limiting;
6. pending/debris accounting;
7. tuning, documentation, and visual verification.

Each slice should leave the test suite passing. If visual tuning must be rolled
back, the engine safety invariants and off-corridor regression should remain.
