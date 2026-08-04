# Plan: pressure-driven liquid transport

> Design document, not yet implemented. Status: proposed, revised after
> code-level review of the engine and volcano migration boundary.

## The problem

The engine can make lava fall, spread, cool, stiffen, and freeze, but it cannot
make magma rise. Liquid motion is currently driven by density and gravitational
potential alone:

- a liquid falls into a less-dense or empty cell;
- it may move sideways when that leads to a descent;
- it is explicitly prevented from taking a lateral step that raises its
  gravitational potential;
- a liquid cannot displace another cell of the same liquid.

Those rules are correct for an unpressurized body of liquid. They make a pool
settle and let a lava flow run downhill to a finite front. They cannot represent
a chamber pushing a full column of magma uphill through a conduit.

The volcano showcase works around the gap in
`showcase/helpers/volcano.ts::pressurizeConduit`. On each rise step it:

1. rewrites every already-full conduit cell with the material and heat of the
   cell below it;
2. refreshes the base from the chamber;
3. creates a new lava cell at the crater or on the flank;
4. sends most of the effusion directly to `breachToe`, downstream of the vent.

This moves a heat pattern up the bore, but it does not move a conserved volume
of magma through it. The downstream `setMagma` is a spawn, not an outlet. At the
showcase default, `breachFraction: 0.85` means most of the apparent flow is
created on the flank instead of emerging from the connected conduit.

The tests reproduce the same blind spot. The test named “pushes magma up the
bore” asserts that the lava count increased and that lava appeared above the
surface. Both claims can be satisfied by spawning a cell outside. It does not
assert that a parcel travelled through a connected path, that the outlet was
adjacent to the liquid body, or that volume was conserved apart from an
explicit source.

The same missing dynamics appear in `PixelEngine.explode`. Its `force` argument
is reported to the host callback, but the engine itself teleports debris a
random distance independent of that force. There is no velocity for an expelled
parcel to retain after the pressure that launched it is gone.

## Outcome

A host should be able to inject hot liquid under a specified pressure at the
base of a connected body. The engine should then:

- find an actual connected route through that liquid;
- account for gravitational head and flow resistance;
- extrude material only from a real boundary of the connected body;
- carry heat, stiffness, colour, and other parcel state along the route;
- create volume only at an explicit source;
- report a blocked injection without silently creating material elsewhere;
- optionally turn surplus outlet pressure into velocity.

For the volcano, this means magma visibly advances from the chamber, through
the conduit, into the crater, and over a real low point in the rim. The host
should no longer need to choose a flank destination and paint lava onto it.

## Scope

The first transport version is deliberately **lava-only**. It is a bounded
cellular hydraulic pass for small connected chambers and conduits, not a
Navier–Stokes solver or a general pump for oceans. A material participates only
when it defines `pressureResistance`; V1 gives that field to LAVA alone. WATER
and OIL requests return `unsupportedMaterial` without starting a search.

That scope decision is load-bearing. A low-resistance liquid in a broad lake
can make every cell physically reachable within a modest head budget, turning
the router's visited-cell ceiling into a correctness limit rather than a mere
safety guard. General water pressure needs a separate performance design—most
likely component caching or a different solver—and must not be implied by the
volcano-sized V1.

V1 should preserve the engine's existing strengths:

- deterministic results for a fixed seed and call sequence;
- bounded work proportional to active pressure requests;
- no new allocation or update cost in worlds that never use pressure
  (`liquidVel` is already baseline state and is unrelated to this guarantee);
- pressure support for flat and radial gravity; custom models remain compatible
  but must expose `potentialAt` before they can accept pressure requests;
- exact transfer of the engine's per-cell companion state.

The first version does not need to model turbulence, realistic compressibility,
continuous sub-cell volume, shock waves, or dissolved volcanic gases. Those can
be layered on after a connected pressurized column works.

Cooling plugs are heat-gated. Phase changes run inside `runHeatStep`, so a world
constructed without heat cannot freeze lava into a rock cap. The shipping
volcano enables heat; all plug, pressure-build, and fracture acceptance tests
must do the same. Pressure routing itself remains useful without heat.

## Design principles

### Pressure is allowed to oppose gravity

Ordinary liquid motion minimizes gravitational potential. Pressurized motion
instead minimizes total hydraulic head. In cell-scale units:

```text
available pressure head
    >= uphill gravitational head
     + path resistance
     + outlet resistance
```

The gravity model already exposes `potentialAt(x, y)` in cell-head units. A
rise of one unit therefore costs roughly one unit of pressure head. Moving
downhill costs no pressure head, though it still has viscous resistance.

This comparison belongs in a pressure pass. The existing potential gate should
remain strict for ordinary unpressurized lateral flow, or settled planetary
liquids will resume ratcheting uphill.

### Pressure must act through connected liquid

The engine must never choose an arbitrary empty cell and call that an outlet.
Every extruded cell must be reachable through a contiguous path of compatible
liquid from the pressure source.

V1 should use four-neighbour connectivity. It prevents corner tunnelling
through a diagonally sealed wall and matches the heat stencil. A conduit that
is intended to carry pressure must therefore have a cardinally connected bore.
The stamped volcano conduit is wide enough to satisfy that constraint.

### Volume creation must be explicit

Pressure alone does not create material. A pressurized source may inject a new
cell-volume, representing a mantle feed or pump, but the engine should count and
identify that as source volume.

If the source is blocked, the requested volume remains pending or is rejected;
it must not appear at a guessed destination. This distinction makes conservation
testable:

```text
material after = material before + accepted source volume - explicit sinks
```

### A full conduit needs a path shift, not same-material swaps

Swapping adjacent lava cells changes nothing in `grid`, and a naïve sequence of
same-material swaps would also fail to advect temperature or stiffness in a
meaningful order. A successful injection should shift the complete parcel state
along the selected path in one operation.

For a path `source = p0, p1, ... pn = boundary` and empty outlet `d`:

1. copy the parcel at `pn` to `d`;
2. copy `p(n-1)` to `pn`, continuing backward to `p0 -> p1`;
3. write the explicitly injected parcel into `p0`.

That increases material count by exactly one accepted source cell. A
non-injecting pressure impulse can use the same primitive but clear `p0`,
keeping the count exactly constant.

## Proposed public API

Pressure should be opt-in and request-driven. A starting API could be:

```ts
export interface LiquidInjection {
  x: number;
  y: number;
  material: MaterialType;
  /** Requested whole-cell volumes for the next update. */
  amount: number;
  /** Maximum hydraulic head available to each volume. */
  pressure: number;
  /** Optional initial parcel temperature. Material spawnTemp by default. */
  temperature?: number;
  /** Optional initial packed colour. */
  color?: number;
}

export interface InjectionResult {
  requestId: number;
  requested: number;
  accepted: number;
  blocked: number;
  /** Greatest path cost paid by an accepted volume. */
  maxCost: number;
  /** Why work was rejected, when the result was not fully accepted. */
  reason?:
    | 'noOutlet'
    | 'insufficientHead'
    | 'searchLimit'
    | 'unsupportedMaterial'
    | 'incompatibleSource'
    | 'missingPotential';
}

engine.injectLiquid(request: LiquidInjection): number;
engine.consumeInjectionResults(): readonly InjectionResult[];
```

`injectLiquid` queues work rather than mutating the grid immediately. This is a
new public-API style for the engine: existing host methods mutate immediately.
The determinism contract must therefore name the queue order rather than leave
it implicit.

The returned id correlates a queued call with its later result. Requests are
drained FIFO in public-call order. Volumes within one request are
processed in ascending volume index. Two requests competing for an outlet are
allowed to produce different results when their enqueue order is reversed;
that order is part of the “same seed + same sequence of public calls” contract.
The engine must not group, sort, or coalesce requests unless that transformation
is later made part of the public contract and pinned by tests.

Queueing keeps processed flags, chunk wake-up, pressure routing, and ordinary
movement in one deterministic transaction. It also means errors such as
`unsupportedMaterial` are reported after the drain, not thrown from the enqueue
call.

The exact return mechanism is an implementation choice. Returning the result
from `update()`, exposing per-frame counters, or consuming a result buffer are
all acceptable. What matters is that the host can distinguish accepted volume
from blocked pressure without inspecting the grid heuristically.

Useful diagnostics should include:

```ts
engine.pressureMovesLastFrame
engine.pressureCellsVisitedLastFrame
engine.blockedInjectionsLastFrame
```

They serve the same purpose as `swapsLastFrame`: tests, performance readouts,
and host feedback without changing simulation behaviour.

### Dry-source semantics

The first accepted volume into an `EMPTY` source cell seeds that source. It is
an explicit source creation, costs no route head, and counts as one accepted
volume. Remaining volumes in the same request may then route through the newly
seeded body. This gives a generic pump a defined startup path without pretending
an empty cell was already a connected liquid component.

A source containing another liquid or a solid returns `incompatibleSource` in
V1. It is not overwritten. A host that wants reactions, dissolution, or drilling
must invoke those behaviours separately.

The one-shot `amount` API is useful for unit tests and direct player actions,
but it is intentionally awkward as a steady flow controller: a host must
re-enqueue it every frame and handle partial acceptance. The volcano migration
therefore waits for the persistent, rate-based source API described below.

## Material properties

`yieldThickness` answers whether a surface flow can shear. Pressure routing
also needs a resistance along a filled path. Add one opt-in liquid property:

```ts
export interface MaterialDef {
  // ...existing fields...

  /**
   * Hydraulic head lost per routed cell under pressure.
   * Absent means pressure transport is unsupported for this material.
   */
  pressureResistance?: number;
}
```

The initial LAVA value should be established by behavioural tests rather than
treated as an SI measurement. WATER and OIL deliberately leave the field absent
in V1, making pressure requests for them unsupported instead of risking an
unbounded search through a lake or ocean.

Temperature-dependent lava viscosity is a later extension. When added, it
should mirror the existing `stiffnessGrid` pattern with an optional per-cell
resistance override that rides with the parcel. V1 can use the material
constant while the existing temperature-dependent yield rule continues to
shape the surface flow after extrusion.

That constant is a real capability limit, not a tuning simplification. A
cooling-but-still-liquid conduit cell routes exactly like a fresh one in V1.
Magma cannot deflect around a stiffening partial plug; the route changes only
after the cell freezes to ROCK and becomes a hard block. Per-cell,
temperature-dependent resistance is required before anyone should expect
rerouting around partially crystallized magma.

Do not repurpose `friction`. It is currently documented as a surface property
for consumers and is unused by the displacement core. Hydraulic resistance is
a different quantity and deserves a name that states what the pressure pass
actually consumes.

## Routing algorithm

Each requested volume performs a bounded least-cost search from its source.
A Dijkstra-style search is appropriate because path costs are non-negative and
the cheapest outlet may not be the geometrically nearest one.

### Traversable cells

A path may traverse a cell when:

- it contains the requested liquid material; or
- it is the source cell and can accept that material under the source rules.

V1 should not route through a different liquid. Mixing, dissolving, and gas
displacement are separate behaviours and should not be smuggled into the first
pressure implementation.

### Edge cost

For an edge from `a` to cardinal neighbour `b`:

```text
gravityCost = max(0, potential(b) - potential(a))
edgeCost    = gravityCost + pressureResistance
```

There is no density multiplier. Pressure is expressed as hydraulic head—energy
per unit weight—so `potentialAt` and the request pressure already share the same
cell-head unit. Introducing material density here would both double-count the
unit conversion and break the useful invariant that raising liquid one cell
costs approximately one head unit.

Under flat gravity, pushing one cell upward costs approximately one head unit
plus resistance. Under radial gravity, the same equation works without a
volcano-specific direction: moving away from the centre costs head, moving
toward it does not.

When a custom gravity model has no `potentialAt`, V1 returns `missingPotential`.
It must not silently pretend that uphill is free. A resistance-only mode can be
designed later as an explicit option if a zero-gravity host actually needs it.

### Outlet candidates

An outlet is an empty cardinal neighbour of a traversed liquid cell. V1 should
only extrude into `EMPTY`; overwriting a gas or lighter liquid would destroy
material unless a second displacement path were also found.

Candidate cost is the path cost plus the final edge cost. The search accepts
the cheapest candidate whose cost does not exceed the request pressure.

Tie-breaking must be explicit and deterministic:

1. lower total cost;
2. shorter path;
3. lower destination index;
4. lower predecessor index while reconstructing an otherwise identical path.

No `Math.random()`, frame-parity strategy, aesthetic fallback, or dependence on
JavaScript sort stability. A directional bias discovered later is a reason to
design and test a named alternative strategy, not to make the tie-break
conditional on what looks visible.

### Search bound

The pressure budget creates a natural cost bound: stop expanding a node once
its accumulated cost exceeds the request pressure. Add a hard visited-cell
ceiling as a second bound.

The ceiling is also a correctness ceiling. A valid low-resistance component can
contain an affordable outlet beyond it; stopping early must return
`searchLimit`, not claim that no outlet exists. That trade is acceptable only
because V1 supports high-resistance lava in bounded chambers and conduits.
General WATER routing is out of scope until the engine has an algorithm that
does not trade a whole-lake search against false blocking.

Never accept the best candidate seen before hitting the ceiling: doing so makes
the chosen outlet depend on the arbitrary work budget. Expose the visited count
and distinct `searchLimit` result so a host and benchmark can identify the
limit rather than misdiagnose insufficient pressure.

### Multiple injected volumes

Process one whole-cell volume at a time. After each successful path shift, the
grid and parcel state have changed, so the next volume searches the new state.
The showcase's maximum effusion is five cells per frame, making this simple
approach comfortably bounded for the current use case.

Stop a request at its first rejected volume and report every unprocessed
remainder as blocked with that reason. With no successful mutation at the
failure point, immediately repeating the same search cannot discover a new
outlet and would only spend the work budget again. This also gives the aggregate
`InjectionResult` one unambiguous rejection reason.

If large pumps later make repeated searches expensive, cache the source
component and invalidate it on changed cells. Do not add that complexity until
profiling shows it is necessary.

## Parcel-state transfer

Pressure movement must carry every state field that ordinary movement carries:

- `grid` material;
- `colorGrid`;
- `heatGrid`;
- `stiffnessGrid`;
- `growthGrid` and growth-set membership, even though current liquids do not
  grow;
- the future impulse/velocity field.

`liquidVel` is the exception. It is surface-flow direction memory, not a
physical parcel property. A pressure shift through a conduit gives that memory
no meaningful interpretation, and preserving it can make an extruded crater
cell inherit a lateral preference established underground. Clear `liquidVel`
for every pressure-shifted path cell and the outlet. Future physical velocity,
by contrast, is parcel state and must be carried.

The engine currently implements this bookkeeping separately in `swap`, liquid
levelling transfers, phase changes, explosions, and host-side placement. Before
adding path shifts, extract internal parcel helpers such as:

```ts
copyParcel(fromIdx: number, toIdx: number, policy?: ParcelCopyPolicy): void
clearParcel(idx: number): void
writeParcel(idx: number, parcel: ParcelSeed): void
```

These are private implementation helpers, not necessarily public API. Their
purpose is to make it difficult for a new movement path to forget heat or
stiffness while still allowing movement-specific state such as `liquidVel` to
be reset deliberately. The refactor should be behaviour-preserving and land
with the existing test suite green before pressure routing is introduced.

Explosion scatter exposes why the policy matters: it currently reconstructs
material and sometimes colour at a distant cell rather than transferring the
original parcel, so heat, stiffness, growth state, and flow memory are not
preserved. That is a latent state-loss bug, but silently fixing it inside a
“behaviour-preserving” refactor would be dishonest. Phase 1 should pin and
document the current explosion result; Phase 6 should deliberately change it
when explosion scatter migrates onto the physical impulse/parcel path.

Every changed path cell must wake movement and thermal chunks as appropriate,
mark render-dirty chunks, set processed flags, and preserve growth membership
invariants.

## Update order

The pressure pass should run after active/updated buffers are prepared and
before ordinary falling:

1. clear `updated` in active chunks and advance the frame;
2. swap active/next chunk buffers;
3. process queued pressure injections and mark moved parcels updated;
4. run checkerboard reactions, falling, gas, and ordinary liquid flow;
5. run liquid levelling;
6. run heat, whose fourth internal pass applies phase changes;
7. run growth and deferred explosions.

Marking the pressure path and outlet updated prevents newly extruded lava from
being pulled straight back down the conduit in the same frame. On the following
frame it participates normally in gravity, yield, levelling, cooling, and
reactions.

Pressure routing should wake the relevant chunks for the next frame. A blocked
request should not wake an entire connected ocean indefinitely; only its
bounded search region and persistent source state need attention.

Because freezing and melting are internal to `runHeatStep`, disabling heat also
disables cooling-created ROCK plugs. Tests that exercise cap formation or
fracture must construct the engine with `enableHeat: true`; routing tests that
only exercise head and resistance should not require heat.

## Persistent pressure and blocked sources

The one-shot API is enough to prove connected transport through an open pipe.
It is not enough to migrate the volcano. A steady host would have to re-request
`amount` every frame, would flicker between accepted and blocked results as the
outlet changed, and would discard the physical meaning of pressure accumulated
behind a cooling cap.

Persistent source pressure is therefore a prerequisite for the showcase
migration, not a post-migration enhancement:

```ts
const sourceId = engine.addPressureSource({
  x,
  y,
  material: MaterialType.LAVA,
  rate: 1,
  pressureRate: 1,
  maxPressure: 40,
  maxPending: 8,
  temperature: 0.75,
});

engine.removePressureSource(sourceId);
```

A source accumulates whole-cell volume in `pending` at `rate`, using a
fixed-point remainder if fractional rates are later admitted. While pending
volume cannot find an affordable outlet, available head increases by
`pressureRate` up to `maxPressure`; pending volume is bounded by `maxPending`.
On success, path cost is deducted from available head and pending volume is
decremented. Exact recharge and discharge curves should be pinned by tests
rather than inferred by hosts.

This produces a bounded surge after a plug clears instead of discarding every
blocked frame or growing an unbounded invisible backlog. Source processing is
in source-creation order, which becomes another explicit part of the public
call-sequence determinism contract.

This state belongs to the source, not to every empty cell in the world. A full
Eulerian `Float32Array pressureGrid` may later be useful for gas compression,
pressure visualization, and interacting pressure waves, but it is not required
to solve conduit transport. Avoid allocating it unless the routing algorithm
demonstrably needs it.

## Momentum and impulse

Pressure transport gets magma to the real vent. Without momentum, the extruded
cell becomes an ordinary falling-sand cell on the next frame and cannot form a
fountain. A second, independently useful engine feature should convert surplus
outlet pressure into velocity.

The minimal design is an optional per-cell velocity field allocated on first
impulse:

```ts
engine.applyImpulse(x, y, vx, vy): void;
```

Requirements:

- velocity rides with the parcel through every movement path;
- gravity changes velocity each frame;
- a parcel attempts a bounded number of steps along its velocity before the
  ordinary gravity rule;
- collisions dissipate or redirect velocity deterministically;
- drag depends on material, with lava losing momentum faster than tephra;
- `explode(..., force)` uses the same mechanism instead of ignoring `force`.

Fixed-point integer velocity is preferable to unbounded floating-point state:
it is deterministic, compact, and naturally capped. The precise representation
should be chosen after a small prototype establishes how many sub-cell bits and
maximum steps are visually useful.

Momentum is not a prerequisite for connected effusion. It follows the complete
effusive-volcano migration, adding fountains and ballistic ejecta without
holding up pressure, plugging, and fracture.

## Rock plugs and fracture

A pressure system becomes much more convincing when a blocked vent can fail.
Rock fracture should not be bundled into the first transport patch, but it must
land before the showcase gives up its host-side escape hatches. Otherwise the
migrated volcano is conservation-correct but less capable than the workaround:
the first cap silently stops it forever.

A later material field can define pressure strength:

```ts
pressureStrength?: number;
```

When no liquid outlet is affordable, the search can record adjacent solid
boundaries. If persistent pressure exceeds a boundary's strength, the engine
may fracture the cheapest or weakest reachable cell into debris, release some
pressure, and retry routing on the next frame.

Important constraints:

- only solids explicitly opting into fracture may break;
- fracture converts material rather than deleting it silently;
- the selected fracture must be adjacent to the connected pressurized body;
- pressure release must be bounded to avoid clearing an entire mountain in one
  update;
- existing `WALL` semantics should remain unbreakable unless configured
  otherwise.

This supports crusted vent caps, flank fissures, and sudden explosive clearing.
Volatile exsolution and compressible gas can build on the same source and
fracture concepts later.

Cooling-created caps exist only when heat is enabled, because the LAVA→ROCK
phase change is part of `runHeatStep`. Fracture tests and the shipping migration
must enable heat explicitly. A no-heat world may still fracture host-placed
rock, but it cannot generate its own solidified vent plug.

## Volcano migration

Migrate only after connected routing, persistent sources, and bounded rock
fracture all exist. Connected one-shot injection is an engine milestone, not a
safe showcase cutover: without persistence and fracture, a cooling vent cap
blocks every frame and the host has already lost the direct-spawn mechanism that
used to guarantee an eruption.

Once those prerequisites exist, simplify the showcase rather than running both
models at once.

### Keep in the host

- chamber and conduit geometry;
- mantle source placement and eruption timing;
- source pressure, volume rate, and temperature tuning;
- incandescence colour mapping;
- tephra plume composition until momentum supports real ejecta;
- cone height caps and showcase controls.

### Remove or reduce

- the bore-wide rewrite loop in `pressurizeConduit`;
- direct `setMagma` at `craterLowPoint`;
- `breachToe` delivery and `breachFraction`;
- any test that treats “lava count increased somewhere above the surface” as
  proof of conduit ascent.

The replacement host setup should be close to:

```ts
const magmaSource = engine.addPressureSource({
  x: chamberFeed.x,
  y: chamberFeed.y,
  material: MaterialType.LAVA,
  rate: opts.effusion,
  pressureRate: opts.pressureRate,
  maxPressure: opts.maxPressure,
  maxPending: opts.maxPending,
  temperature: MAGMA_TEMP,
});
```

The engine—not the volcano helper—then decides whether the pressure is enough,
where the connected outlet is, and which real low-resistance path the magma
takes.

Replace `rechargeReservoir` with a chamber-only thermal boundary condition. It
may hold already-molten chamber cells at reservoir temperature, but it must not
replace ROCK or SAND in the bore. Remove the bore-wide behaviour of
`remeltConduit` at migration. A plugged conduit is meaningful only if host
maintenance does not silently turn the plug back into lava every frame.

This is an intentional trade from guaranteed host-authored eruption to
engine-authored failure and recovery. A sufficiently strong cap may delay or
redirect an episode; persistent pressure and fracture are what keep that from
becoming a silent permanent stop.

The eruption pacing should be tuned only after migration. Today the cycle runs
300 explosive frames before a 40-frame effusive pulse, which can hide the magma
mechanic for five seconds at 60 Hz. That is a presentation issue, but changing
it before connected transport exists would only make the teleport more visible.

## Tests

### Parcel primitives

- ordinary parcel copying transfers material, heat, colour, stiffness, flow
  direction, and growth state;
- pressure path shifting transfers the physical fields but clears `liquidVel`;
- clearing a parcel restores empty-cell heat to ambient and clears companion
  state;
- path shifting preserves the order of differently coloured or differently
  heated tracer cells;
- all affected chunks are movement-, thermal-, and render-dirty as required.

### Pressure routing

- insufficient pressure cannot raise liquid one cell;
- sufficient pressure raises it against flat gravity;
- the same pressure threshold works radially using `potentialAt`;
- a longer or more viscous path costs more than a short path;
- the cheapest reachable outlet wins;
- a sealed component reports blocked and creates no material;
- routing cannot cross a one-cell diagonal gap or solid wall;
- every outlet is adjacent to the connected source component before extrusion;
- the first accepted volume seeds an empty source, after which later volumes
  may route through it;
- an occupied incompatible source is not overwritten;
- an accepted one-cell injection increases material count by exactly one;
- a non-injecting push conserves material exactly;
- WATER and OIL return `unsupportedMaterial` without exploring their component;
- FIFO request order is deterministic and reversing two competing requests is
  allowed—and tested—to reverse their outcome;
- pressure-disabled worlds retain byte-for-byte deterministic results as a new
  pressure-specific compatibility requirement, stronger than the integration
  guide's current universal wording;
- repeated runs with the same request stream produce identical grids and
  companion fields;
- hitting the visited-cell ceiling returns `searchLimit` even if a candidate was
  seen, rather than selecting a partial or arbitrary destination.

Count conservation belongs in a phase-change-disabled unit fixture where every
source and sink is known. It is not the primary volcano proof: LAVA can become
ROCK, so a lava-only count describes phase, not lost volume. Ordered colour and
temperature tracers through the path are the stronger transport assertion.

### Persistent sources

- a steady source accrues volume at its configured rate without a host call
  every frame;
- a blocked source accumulates head and pending volume only to their caps;
- opening a manually sealed outlet releases a bounded surge;
- successful routing consumes the documented amount of pending volume and
  pressure head;
- removing a source stops accrual without deleting material already in the
  grid;
- multiple sources process in source-creation order deterministically.

### Fracture

- insufficient pressure leaves opted-in rock unchanged;
- sufficient pressure fractures only a reachable solid adjacent to the
  connected pressurized component;
- WALL remains unbreakable by default;
- fracture converts rock into bounded debris rather than deleting arbitrary
  mass;
- at most the configured number of cells fracture in one update;
- a heat-enabled lava cap can freeze, hold pressure, fracture, and release a
  surge;
- the same scenario with heat disabled does not spontaneously create a ROCK
  cap.

### Volcano integration

- a coloured or temperature-tagged pulse placed at the chamber feed emerges
  from the actual vent after a conduit-length delay;
- no lava appears on the flank before a connected path reaches the surface;
- removing the vent opening blocks extrusion without creating downstream lava;
- reopening the vent releases accumulated source pressure through the opening;
- the crater fills from the vent and overflows a real rim low point;
- removing `breachToe` does not prevent lava from reaching the flanks;
- no showcase helper writes LAVA outside the explicit chamber source;
- ordered colour and temperature tracers prove chamber-to-vent transport;
- the flow still cools, stiffens, stops, and settles under the existing heat and
  yield systems.

### Momentum integration

- positive outward velocity carries a parcel away from gravity for multiple
  frames before it falls;
- greater explosion force produces greater displacement or flight time;
- zero force preserves current gravity-only behaviour;
- collisions do not duplicate or delete material;
- velocity transfers with heat and colour through swaps and pressure shifts.

## Performance and determinism

Pressure work should be zero when the request queue is empty. Do not scan the
whole grid for pressure cells every frame.

For active requests:

- reuse search arrays and queues rather than allocate per volume;
- use generation stamps instead of clearing full-size visited arrays;
- stop at the pressure cost and visited-cell bounds;
- prefer integer or fixed-point costs if floating-point tie sensitivity appears
  in determinism tests;
- expose visited counts and pressure-move counts in the showcase performance
  panel while tuning.

Benchmark at least:

- the shipping 220×220 planet with one five-cell-per-frame lava source;
- a sealed source that repeatedly reaches the search bound;
- several simultaneous sources in separate chunks;
- a deliberately large connected lava body whose valid outlet lies beyond the
  visited ceiling, proving it returns `searchLimit` rather than `noOutlet` or a
  partial candidate;
- a deliberately large connected water body, proving the unsupported-material
  check returns before allocating or searching.

The target is not a particular millisecond figure in this design document. The
acceptance condition is that unused pressure has no measurable steady-state
cost and the shipping volcano remains comfortably inside its 60 Hz frame
budget.

## Delivery sequence

### Phase 0 — pin current behaviour

- add a regression demonstrating that an ordinary liquid cannot climb under
  gravity;
- add a volcano test exposing the current direct-spawn behaviour;
- retain all existing determinism, settling, heat, and yield tests.

### Phase 1 — parcel transfer primitive

- centralize companion-state copy, clear, and write operations;
- migrate `swap` and liquid levelling to the primitive where practical;
- pin explosion scatter's current state-loss behaviour instead of changing it
  accidentally during the refactor;
- prove no behaviour change with the complete test suite.

### Phase 2 — connected one-shot lava injection

- add `pressureResistance` to LAVA only;
- add the queued injection API and per-frame results;
- implement bounded least-cost routing and path shifting;
- add flat and radial pressure tests;
- add pressure performance counters;
- reject WATER and OIL before search;
- prove open-conduit transport, but do not migrate the showcase yet.

### Phase 3 — persistent sources

- add rate-based sources, bounded pending volume, and pressure accumulation;
- define source-creation processing order;
- prove a manually opened cap releases a bounded surge;
- retain the existing volcano workaround until fracture also exists.

### Phase 4 — bounded rock fracture

- add opt-in solid `pressureStrength`;
- record reachable solid boundaries when routing is blocked;
- fracture only adjacent, reachable, opted-in solids;
- cap fracture work and debris per frame;
- prove heat-enabled LAVA can freeze into a plug, hold pressure, fracture, and
  release;
- keep WALL unbreakable by default.

### Phase 5 — migrate the volcano

- create a persistent source only at the chamber feed;
- remove crater and flank lava spawning;
- remove `breachToe` and `breachFraction`;
- replace bore remelting with a chamber-only thermal boundary;
- replace the current ascent test with ordered tracer, connectivity, blocking,
  and surge tests;
- retune pressure head, resistance, source rate, phase duration, and cooling
  from the new behaviour rather than preserving old slider numbers.

### Phase 6 — momentum

- add the optional velocity field and `applyImpulse`;
- convert outlet surplus pressure into velocity;
- make explosion force affect debris and deliberately carry physical parcel
  state through the new impulse path;
- migrate the explosive plume when the ballistic result is good enough to
  replace host-side loft placement.

### Phase 7 — broader pressure physics, only if needed

- prototype per-cell temperature-dependent pressure resistance so partially
  crystallized magma can reroute before it freezes solid;
- design a large-component strategy before enabling WATER or OIL;
- consider gas compression, pressure visualization, and volatile exsolution
  only after the lava-sized solver is stable.

## Acceptance criteria

Acceptance is split by capability boundary. No earlier phase is described as a
complete volcano replacement.

### Phase 2 — transport primitive accepted

- pressure can overcome a measured number of gravitational head cells;
- every extrusion is adjacent to the actual connected liquid component;
- blocked one-shot requests create no material downstream;
- an accepted source volume changes material count exactly in a
  phase-change-disabled unit fixture;
- ordered tracer state moves through the full selected path;
- queue ordering and tie-breaking are deterministic;
- pressure-free simulations preserve their previous results and allocation
  profile;
- the lava-sized router remains within its search and frame budgets.

This milestone proves steady effusion through an already-open conduit. It does
not claim that a sealed or cooling volcano can sustain an episode.

### Phase 3 — persistent source accepted

- a blocked source accumulates bounded pressure and pending volume;
- manually opening one real cell in a cap releases magma through that cell;
- the release is a bounded surge rather than an unbounded backlog dump;
- no host call is required every frame to maintain the configured source rate.

This is the first milestone that can pass the manual “cover, build pressure,
open” test. It still cannot create its own outlet through rock.

### Phase 4 — fracture accepted

- sufficient persistent pressure can create a bounded outlet through reachable,
  opted-in weak rock;
- insufficient pressure and unbreakable WALL remain intact;
- a heat-enabled cooling cap can block, fracture, and release without host
  remelting;
- a disabled heat field does not spontaneously create the same cooling cap.

### Phase 5 — volcano workaround replaced

- magma enters the simulation only at an explicit chamber source;
- magma appearing outside the planet can be traced through a cardinally
  connected liquid path to that source;
- blocked requests create no material downstream;
- heat and stiffness pulses visibly travel through the conduit;
- the crater and rim, not a host-selected toe, determine where lava exits;
- a frozen or debris-choked vent delays, redirects, or fractures instead of
  being silently remelted by host maintenance;
- the existing lava flow still cools to a finite, settled tongue;
- the result is deterministic and remains within the showcase frame budget;
- `pressurizeConduit`, `breachToe`, `breachFraction`, and direct surface
  `setMagma` are no longer part of the eruption path.

The defining migrated-showcase test is stronger than the manual Phase 3 test:
let heat crust the vent without host intervention. Pressure should either find
a real remaining opening or fracture an opted-in weak boundary, and magma
should flow from that engine-selected outlet without the host naming a surface
destination.

### Phase 6 — momentum accepted

- expelled material retains outward motion for multiple frames before gravity
  wins;
- greater explosion force produces greater displacement or flight time;
- collision handling neither duplicates nor deletes material;
- enabling no velocity preserves the completed effusive volcano behaviour.
