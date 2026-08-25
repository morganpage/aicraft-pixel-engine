# Changelog

All notable changes to **aicraft-pixel-engine** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.1] — 2026-08-25

### Added
- **`recipes/surface-walkers.ts`** — polar-coordinate surface creatures as a
  copy-in module: footing via WALKABLE/LIQUID/DEADLY material sets, swim-bob,
  hazards with respawn, event-driven fear (freeze-stare → flee; strike
  memories plus live vents), and a minimal body + eye + hop look.

  Two builds of the god-game brief diverged on spawn policy. One populated
  the world at boot on any walkable footing — bare rock counts. The other
  gated its population on the grass census ("no grass → no walkers") and hid
  every creature behind minutes of gardening; a reviewer of a fresh world
  concluded the creatures had never been built. The brief described *how*
  walkers move but never *when they appear*, so each build invented a policy.
  The recipe pins the contract in tested code: ≈16 slots created at boot with
  staggered timers, spawning on any walkable footing, never gated on grass,
  forest, or any census threshold. Walkers are strictly visual (zero grid
  writes) and roll a dedicated `mulberry32` stream — not `engine.random()`,
  which would shift the simulation's draw sequence. The brief's §8.5 now
  states the spawn contract, §9 has an acceptance checkbox, §10 has a build
  step, and §12 trap 12 forbids the census gate.

- **`recipes/headless-shot.mjs`** — copy-in headless-screenshot harness:
  reads the canvas in-page via `getImageData` (the CPU path), composites the
  ground-truth bitmap over the page screenshot with pngjs, launches with
  `--disable-accelerated-2d-canvas`, detects garbage sessions (near-black
  canvas centre) by exiting 42 for wrapper retries, and verifies with pixel
  probes (`--probe x,y,w,h,r,g,b,tol --probe-min N`).

  Trustworthy visual evidence from a headless browser cost a real build its
  longest detour: `page.screenshot()` and `canvas.toDataURL()` both ride the
  GPU-compositing path and intermittently return a black canvas while the
  bitmap is pixel-perfect (proven by counting cells through `getImageData`),
  and the GPU-disable flags did not help. A vision model describing
  screenshots then misread axes and hallucinated features that pixel counts
  disproved. The recipe encodes both lessons: trust the CPU readback, and
  count pixels instead of asking a model.

- **The volcano silhouette contract** — `measureVolcanoShape` /
  `assertVolcanoShape` (`src/tests/helpers/volcano-fixtures.ts`), with
  `src/tests/volcano-shape.test.ts` guarding the library subsystem and a new
  suite guarding the god-game recipe.

  Every volcano assertion in this repo measured **magnitude**: height, volume,
  ejecta spread, new rock, centre-above-shoulders, does it settle. A player
  screenshot showed all thirteen passing on a straight-sided grey chimney with
  a magma blob at its foot — because a chimney standing on a skirt satisfies
  every one of them. It is tall. It has volume. Its centre is above its
  shoulders. What nothing measured is **taper**.

  The metric works in the vent frame — height above the surface against tangent
  offset — and reports the longest run of rows over which the width fails to
  decrease. A cone loses width on essentially every row and scores 0-1. The
  shipped recipe scored **11, 11 and 6 at three of five vent angles**; at due
  north it held a constant width of 16 for eleven consecutive rows. It also
  catches overhangs (a bulb re-widens, which no granular pile does), flanks too
  steep to stand, and material floating free of the planet.

  The metric is itself calibrated against synthetic edifices whose answer is
  known by construction — cone passes; chimney, mesa, bulb-on-a-stalk and
  needle each fail with the specific diagnosis. A shape test nobody has
  calibrated is a shape test that quietly passes everything.

- **`MaterialDef.yieldThicknessCurve`** — yield thickness as a function of
  temperature, `[minTemp, thickness]` tiers. Consulted by the movement core
  when the heat field is live and the cell has no explicit `stiffnessGrid`
  override, so a host that writes its own rheology still wins and a world
  without heat is untouched. `LAVA` declares the curve.

  This closes a silent footgun. Yield strength is not a constant of a melt —
  for lava it climbs by orders of magnitude as it crystallizes, and that one
  dependence is what makes a flow blunt-fronted, levee-bounded and
  finite-length. The engine shipped a bare `yieldThickness: 3` and *documented*
  that hosts should write `stiffnessGrid` from temperature, but a host that
  did not got lava needing three cells of depth before it could shear sideways
  at all. On a volcano summit no parcel is ever three cells deep, so extruded
  lava could not move, froze where it landed, and the next parcel stacked on
  the last. `stiffnessForTemp` in the volcano subsystem now delegates to the
  material curve, so the two tier tables that used to disagree about the cold
  end by a factor of nearly three are one table.

### Fixed
- **Black-canvas boot race — `consumeRenderDirtyChunks()` no longer burns
  the all-dirty report before the first `update()`.** The initial
  full-paint report was a one-shot consumable, so anything consuming it
  before the renderer's first `render()` — a Vite dep-optimization
  full-reload re-evaluating game modules, HMR state — left a correct grid
  rendering as a permanently blank canvas. Seen in the wild as the worst
  bug of a god-game build. The report now repeats on every consume while
  `frameCount === 0` and hands over to delta reporting at the first consume
  after a tick; the cost is at most one redundant full-chunk repaint before
  the world's first update. The brief's §7 and trap 2 were rewritten to
  match: paint every chunk once at renderer init and let the engine's
  report double-paint.

- **The god-game volcano built a chimney instead of a cone** at three of five
  vent angles. Two causes, both now measured rather than guessed:

  - **Effusion delivery rate.** A lava pool levels to an equipotential, which
    on a radial-gravity planet is a spherical shell — a **flat top**. Whether
    a summit ponds or drains is a race between delivery rate and how fast a
    flow runs down the flank and stiffens. At 3 parcels/frame the summit was
    refilled faster than it drained, never fell below the hot end of the yield
    curve (0.85, where the gate is off entirely), and froze as a slab: width
    pinned at 74 cells for fifteen consecutive rows. Isolated by running each
    phase alone — fountain-only scored 1, effusion-only scored 14. Now 1
    parcel/frame, which drops the worst non-tapering run from 13 rows to 1.
  - **Fountain duration.** Tephra is granular and finds its angle of repose, so
    the fountain is the phase that builds a *cone*; frozen lava sets where it
    stops, so the effusion only adds rock to one. At 300 frames the footprint
    was still narrow when the effusion took over and the edifice stood at a
    0.57 height/width ratio — a ~48-degree flank. 500 frames brings it to 0.48
    at the same 24-cell target height.

  Final cones across all five vent angles: 16-27 cells tall on 45-60 cell
  footprints, height/width 0.32-0.49, longest non-tapering run 1. The brief
  (`games/god-game.md` §8.2) carries both numbers and the reasoning.

### Added
- **Volcanic ash is fertile.** `TEPHRA` now counts as soil for both life
  rules: grass creeps onto a cooled cone's flanks (`GRASS.growth.intoMaterial`)
  and seeds germinate on it (`SEED.growth.contact`), so an eruption's scar
  greens over by the same primary succession it would in nature — a rain cloud
  over fresh ash becomes a meadow. Both rules gained `tempRange: [0.05, 0.65]`
  (the gate existed in the growth pass; this is its first use): still-hot
  ejecta stays sterile, and frozen worlds grow nothing. Seeds also dropped
  from density 9 to 7 — at 9 they sank out of sight into loose ash (density 7)
  before they could sprout; at 7 they rest on tephra and still fall through
  water. Five tests in `src/tests/tephra-fertility.test.ts`.

## [0.2.0] — 2026-08-24

### Added
- **The volcano subsystem is now part of the library** (`src/volcano/`, exported
  from the package root). It was `showcase/helpers/volcano.ts` — demo code by
  location, general-purpose by content: ~2,000 lines composing pressure
  sources, the heat field, fragmentation, `stiffnessGrid` and the velocity
  field into an eruption that ascends a conduit, fountains ballistically,
  fragments into tephra, and stacks a cone that stops growing. Three things
  were wrong with that address. It carried **its own copy of the engine's
  mulberry32**, with nothing checking the two still agreed. The engine
  documented `stiffnessGrid` as "a host that tracks temperature writes it
  here" while the only such host was unpublished. And the god-game brief had to
  encode the whole eruption recipe **as prose**, manually kept in sync with a
  test that re-derived it by hand. Public surface: `stampVolcano`,
  `stepVolcanoFrame` / `stepVolcanoPre` / `stepVolcanoPost`,
  `createVolcanoState`, `buildVolcanoOpts`, `syncFromHeat`, `stiffnessForTemp`,
  `rechargeReservoir`, `remeltConduit`, `assimilateTephra`, `emitPlume`,
  `erupt`, the geometry helpers, and the incandescence/tephra palettes.
  Nothing in `sand/`, `materials/` or `gravity/` imports it, so a world that
  never builds a volcano never loads it.
- **`src/rng.ts` — `mulberry32`, `mulberry32Next`, `mulberry32Value`.** One
  implementation of the generator, now used by both `PixelEngine.random()`
  (which keeps its state as an inspectable field, for a future mid-stream
  save/resume) and by host side-streams like the volcano's, which want the
  closure form. `makeRng` is an alias of `mulberry32`, kept for the volcano's
  callers.
- **Settle detection is tunable per-engine**: `settleStableThreshold`,
  `settleTimeoutFrames`, and `settleSwapThreshold` options, with
  `SETTLE_SWAP_THRESHOLD` exported alongside the two existing constants. A
  1000×1000 planet takes proportionally longer to quiet down than a 200×150
  sandbox, and the swap threshold — previously a bare `5` in the middle of
  `update()` — scales with a world's residual churn.
- **`velocityDrag` option**, clamped to `[0, 1]`. `DEFAULT_VELOCITY_DRAG` was
  already exported, implying tunability the constructor did not offer.
- **`DEFAULT_GROWTH_INTERVAL` and `DEFAULT_LIQUID_DISPERSION` are exported.**
  Both were referenced from public JSDoc `{@link}`s that consumers could not
  resolve, because the symbols were module-private.
- **`VELOCITY_MAX_STEPS` and `VELOCITY_REMAINDER_HEADROOM` are exported**, the
  latter documenting the arithmetic that forces the remainder accumulators to
  be 16-bit.
- **CI** (`.github/workflows/ci.yml`) and an `npm run verify` gate: both
  typechecks and both fast suites, in fail-soonest order. A separate job runs
  the scenario suite, and a third builds `dist/`, packs, and builds the
  showcase — so the published artifact is proven to emit. Nothing enforced any
  of this before; the working tree had a red `showcase:typecheck` while every
  test suite was green.
- **A `materialDefs` contiguity test.** Every hot loop indexes `materialDefs`
  by raw material id, which only resolves correctly while the `MaterialType`
  ids are gapless from 0. Reserve a gap and sand would silently read as water,
  with nothing thrown. The test fails instead.
- **The god-game volcano acceptance scenario** (`showcase/tests/godgame-volcano.scenario.test.ts`,
  runs with `showcase:test:scenario`). Defines a good volcano as nine measurable
  criteria — buried magma chamber, sustained vent activity, ballistic ejecta,
  fragmentation into a spreading tephra fan, a cone that is a mound (≥8 of 11
  tangent bins) with volume, new frozen rock, an eruption that settles, and
  byte-determinism — and pins the brief §8.2 recipe that passes them. The
  recipe it enforces: a bulk-stamped magma chamber + conduit with explicit
  `setHeat` after `endBulk` (bulk stamps carry no heat); the pressure source
  inside the stamped body (a buried source is skipped forever); **no carved
  mouth** — the source fractures its own vent open (an open crater lets
  fallback tephra choke the conduit and kill the source, measured: effusion
  discharged zero for 500 frames); head refilled in full each frame and
  dimensioned as `ascent × parcels + surplus` (a one-launch budget throttles
  the jet to ~1 parcel/frame); a host-side throat remelt every 20 frames
  (fallback tephra plugs the vent mid-eruption); a host-side edifice height
  cap measured in built solids only (an uncapped fountain builds a 66-cell
  chimney, not a cone); and a two-phase fountain→effusion schedule. Measured
  on the due-north cardinal vent: ~524 fountain parcels, ~1,000 effusion
  cells, 11/11 criteria green; the previous recipes failed 8/11, 3/11 and 4/11.
  **Strengthened after a player screenshot showed a runaway spire** the
  original criteria missed: added 6d (max final height ≤34 — no runaway
  needle), 6e (centre ≤18 cells over the shoulders), and **five-angle
  coverage** (N/E/S/W + diagonal), because the eruption's granular fate is
  angle-dependent. The spire reproduced at one angle (74 cells — the effusive
  phase extruding onto a narrow summit where fully-exposed lava freezes
  faster than it flows); the fix caps the effusion's height too, widens its
  outlet corridor to the cone's shoulders, and widens the throat remelt band
  to keep those shoulder outlets open. All 13 criteria now pass at every
  angle.
- **`engine.stampDisc(cx, cy, radius, mat, opts?)` — the brush primitive.**
  Stamps a filled Euclidean disc of material through the full `setMaterial`
  bookkeeping (wake + render-dirty + heat ride-along), bounds-clipped, and
  returns the number of cells written. By default it paints only `EMPTY` cells
  — god-game brush semantics, so painting over terrain never carves into it;
  pass `{ overwrite: true }` for `setMaterial` semantics. Pure function of its
  arguments (no RNG, no frame state). Extracted from the god-game build: every
  paint-style host was re-writing the same bounds-checked disc loop by hand.
  For a large one-off world stamp, `beginBulk()`/`setMaterial`/`endBulk()`
  remains the fast path.

### Fixed
- **`explode()` with a zero or negative radius.** `falloff = 1 - dist/radius`
  is `NaN` at radius 0, so every threshold test read false: solids at the
  centre survived while non-solids were deleted *and* scattered as debris, and
  a 3-cell fire core spawned regardless because its radius has a floor. A
  negative radius skipped the carve loop and still lit the core. Now a no-op.
- **`settleTimedOut` reported a false timeout.** It re-derived the reason as
  `settled && frameCount >= TIMEOUT`, but the two completion conditions are
  checked with `||` — so a world reaching natural stability on exactly the
  timeout frame satisfied both and was reported as having given up. The reason
  is now recorded at completion, and natural stability wins the tie.
- **The velocity remainder accumulators are `Int16Array`, not `Int8Array`.**
  The pass does `rem += v` and drains whole cells out, leaving `|rem| ≤ 7`; at
  `|v| = 127` that peaks at 134, which does not fit in an Int8. The wrap is a
  **sign flip**, not a rounding error: 134 stores as −122, the step count comes
  out −15, clamps to −4, and the parcel flies backwards out of the explosion
  that launched it. Safety previously rested entirely on the drag constant
  (`trunc(127 × 0.92) = 116`, so `7 + 116 = 123` squeaked under) — an invariant
  resting on a tuning value the new `velocityDrag` option now invites hosts to
  change. Regression-tested at `velocityDrag: 1`.
- **`liquidDispersion`'s documented default was wrong** — the JSDoc said 32,
  the constant is 16, and the constant's own note argues *for* 16 over 32 on
  radial gravity.
- **`runVelocityStep`'s ordering rationale was backwards**, claiming the pass
  runs before `clearUpdatedInActiveChunks` when that is `update()`'s first
  statement. The real reason (stale flags in chunks that were not active) was
  already documented correctly a few lines below.

### Removed
- **An empty `if` block on every `setMaterial` call** — two `Set` lookups per
  call in the library's hottest write path, guarding a body that did nothing.
  The intent it recorded (a terrain-dirty flag for a future rigid-body layer)
  is now a comment, which records it just as well for free.
- **`void probe;` in `runVelocityStep`** — a binding held solely so a `void`
  statement could silence `noUnusedLocals`.
- **`flowRun`'s `ddx`/`ddy` parameters**, unconditionally overwritten by
  `fillNeighborFrame` before first use on every iteration. `noUnusedParameters`
  could not see it because the initialiser counts as a read.
- **`performance.now()` from the volcano module.** Now that it is library code
  it may not read a wall clock; instrumentation takes an injected
  `VolcanoRuntime.now`, which the browser host supplies and headless callers
  omit.

### Changed
- **Scripts renamed.** `build` was `tsc --noEmit` (a typecheck) while
  `build:dist` was the actual build. Now `typecheck` and `build`. `prepack`
  and `prepublishOnly` updated; `prepublishOnly` runs the full `verify` gate.
- **`.claude/launch.json` is no longer gitignored.** It is shared project
  config (how to run the showcase dev server); only `settings.local.json` is
  per-machine.
- **README** now documents the heat/climate field, growth, pressure transport,
  the velocity field, fragmentation, yield strength, and the volcano
  subsystem — six systems it omitted entirely — plus the eight life materials,
  the ESM-only constraint, and a link to `docs/integration.md`.

## [0.1.2] — 2026-08-06

### Changed
- **The volcano per-frame loop is now a shared controller.**
  `stepVolcanoFrame` (`showcase/helpers/volcano.ts`) is the single source of
  truth for one simulation frame, used by both the browser loop
  (`sections/planet.ts`) and the headless test harness. It reproduces the
  browser's active/dormant transition exactly: the eruption steps
  (`stepVolcanoPre`/`Post`) run only while active, and once the cycle completes
  (`phaseFrame === -1`) or the cone reaches the cap, the source is removed and
  subsequent frames run `engine.update()` + `syncFromHeat()` only — the
  reservoir is no longer recharged and tephra is no longer assimilated during
  dormancy. Previously the test harness ran the active sequence forever, so
  every post-eruption checkpoint drifted from production by hundreds of cells
  (measured at frame 600: 9 grid / 1342 heat / 676 colour / 273 stiffness).
  The parity test now checks the trajectory against an *independent*
  hand-written browser-loop reproduction (not the controller) so the check is
  no longer circular.
- **Volcano test workflow split into a fast default suite and a slow scenario
  suite.** The showcase's volcano tests previously ran every multi-thousand-frame
  full-planet eruption inside the default `showcase:test`, taking ~138s for 33
  tests. A new headless `VolcanoScenario` harness (`showcase/helpers/volcano-scenario.ts`)
  runs one deterministic 2600-frame trajectory with shared checkpoints and
  reconstructs read-only engines per assertion, so the six redundant
  multi-thousand-frame eruptions collapse into a single pass. The default
  `showcase:test` now runs only the fast (tiny-grid / pure-function) contracts in
  ~1.8s; the full-planet scenarios live in `volcano.scenario.test.ts`, excluded
  from the default run. New scripts: `showcase:test:scenario` (slow suite) and
  `showcase:test:all` (both, for CI).
- **Volcano eruption options are now built from one shared factory.**
  `buildVolcanoOpts` (`showcase/helpers/volcano.ts`) is the single source of
  truth used by both the browser showcase and the headless test harness, so the
  golden trajectory now tests the volcano users actually run. Previously the
  harness diverged (fountain pressure 80 vs the shipped 100, parcel cap 1 vs 4,
  and an explosive-only vent anchor instead of the shared parent anchor that
  gates both phases).
- **Lava's yield-thickness ladder is set against the measured cooling curve.**
  The floor of 2 meant a flow needed two cells of depth before it could move
  *anywhere*, which is more than a vent delivers onto a slope: everything the
  effusive phase erupted stalled the moment it left the crater, ponded there,
  levelled, and froze as a flat slab across the summit. `stiffnessForTemp` now
  opens a narrow live window (yield 1) above 0.85, which in practice is the vent
  and a cell or two beyond it — an exposed film loses about 0.08 per frame, so
  nothing stays that hot for long and a flow still cannot thin indefinitely. The
  second tier moves from 0.72 to 0.60: a two-cell flow falls from vent heat to
  0.60 in about 14 frames and to `freezesAt` in about 36, so a tongue now gets
  roughly a dozen cells of travel where it used to get six.
- **Effusion extrudes rather than fountains.** The effusive source sets
  `outletVelocityEfficiency: 0`, so its surplus head — which has to be generous
  or it cannot climb the cone at all — stays head instead of launching every
  parcel ballistically. The effusive phase lengthens from 40 frames to 90, which
  now produces flows rather than the pond it used to.
- **Settle test requires thermal quiescence too.** The dead-stop check now
  demands swaps, velocity moves, growth events, AND active thermal chunks all
  stay zero for 8 consecutive frames — the engine exposes
  `activeThermalChunkCount` as its thermal-settle signal, and without it the
  test could pass while lava was still cooling/freezing.

### Fixed
- **A fluid can no longer displace a packed solid.** `canDisplace` decided
  everything by density, which is the whole of the physics for two fluids or a
  grain settling through one, and the wrong question to ask about a fluid
  meeting a settled deposit whose grains bear load. Tephra exposed it: it has to
  be lighter than lava (7 against 8) so fresh ejecta rests on a melt instead of
  draining back into the reservoir, and read as a pure density comparison that
  also said lava may sink through a *cinder cone*. It did — every drop of an
  effusive episode swam down into the flank it was poured onto and froze inside
  it (791 cells of rock against 116 of tephra) rather than running down the
  outside. There were no lava flows on the cone because the lava was never on
  the cone. Liquids and gases may now displace only fluids or empty space;
  grains settling through fluids and every fluid-fluid pair are unaffected.
- **Pressure outlets launch along local up, not the cardinal exit step.** The
  parent→outlet heading is quantized to four directions by the router and lands
  on whichever face of the vent happened to be open that frame, which put
  roughly a fifth of all fountain parcels on a *horizontal* launch at full
  speed, firing lava out of the side of the cone. Gravity is continuous and
  points along the conduit, so the jet is stable and fans about the vertical.
- **Outlet spread varies per launch.** It was a pure hash of the outlet index,
  which is stable while a vent holds its position, so every parcel out of a
  steady vent took the same offset, flew the same trajectory, and landed in the
  same cell. That is a jet, not a fountain, and it builds a spire at any spread
  setting. The frame counter is now mixed in, and a new per-source
  `outletLateralSpread` lets a volcanic fountain open its arc (0.7 ≈ ±35°)
  without changing the narrow default for ordinary outlets.
- **Heat no longer livelocks at a chunk seam.** Two independent bugs in the heat
  step left a settled world alternating chunks forever with the temperature
  field completely static — on the volcano, 3 and 5 chunks trading places for
  40,000 frames after the last cell had stopped moving, which no amount of extra
  settling time resolved. First, a chunk that woke a sleeping neighbour to move
  flux across a seam went to sleep itself, so the pair was never awake together
  and the transfer never happened; it now stays awake alongside it. Second, the
  epsilon that lets diffusion's asymptotic tail go quiet gated the *write* as
  well as the wake, silently discarding flux already taken out of neighbouring
  cells — so heat stopped being conserved exactly where the gradient was
  shallowest. The value is now always written; only waking and render-dirtying
  are gated.
- **Explosive-phase pressure source now inherits the shared vent anchor.**
  `stepVolcanoPre` reads `opts.pressure.explosive.ventAnchor` only, so the
  production explosive phase — which sets the anchor at the parent
  `opts.pressure.ventAnchor` (documented as applying to both phases) — ran
  unanchored, letting summit lava become extra pressure-fed outlets during the
  fountain. The nested value is now an override with fallback to the parent.
- **Gas decay now honours `MaterialDef.decayChance` before movement.** The field
  was declared and documented as "chance per simulation tick, independently of
  whether the material moved", but the engine only attempted smoke decay once
  every movement route was blocked — so freely rising smoke could never expire
  on the tick it was rolled to. Decay now rolls `def.decayChance` at the top of
  the gas branch, before any movement. SMOKE (0.02) is affected; STEAM and FGAS
  have no `decayChance` and are unchanged (steam still disappears via
  condensation).

### Added
- **Dedicated tephra material.** Ballistic lava now fragments into granular
  `TEPHRA` rather than ordinary `SAND`. Its lower density keeps erupted grains
  above molten lava so they can settle into a persistent cone.

### Fixed
- **Volcanic fountains now build tephra cones.** Fragmented parcels retain
  their momentum and heat, use a distinct ash-brown palette, and the showcase
  limits the explosive outlet to one routed parcel per frame so the vent stays
  focused instead of branching into a broad same-frame spray.
- **Tephra crust no longer seals the eruption.** Tephra now opts into pressure
  fracture (`pressureStrength: 6`), so a vent-capping crust reopens under
  sustained magma pressure the same way a frozen rock cap already does. Without
  this, fallout deposited back over the vent formed a plug the engine could not
  route around, route through, or fracture — magma was trapped beneath it.
- **The volcano builds a cone with one central vent instead of a tower with
  several.** The conduit was only ever maintained up to the *original* planet
  radius, so the volcano buried its own vent under its first deposits and the
  pressure source's only way out was to fracture. Fracture opens one cell per
  frame along the steepest potential gradient — straight up — so the magma
  tunnelled vertically through its own pile, every subsequent parcel landed on
  top of that tunnel, and the edifice grew as a straight-sided tower; where a
  weaker neighbour was available (cone-flank tephra is strength 6 against rock's
  15) it broke out sideways as well, which is where the extra vents came from.
  Measured across five eruptions: 2273 fractures against 1415 routed parcels —
  fracture, not eruption, was the dominant material path.

  `ventTopRadius` now walks the authored bore outward and maintains it up to the
  first ring that is open air, so a single central vent stays open at the summit
  for as long as the eruption lasts. It is bounded by the bore footprint (three
  to five cells across), so it can only keep the conduit clear, never eat the
  cone around it, and it cannot chase its own magma outward the way an
  `edificeHeight`- or `surfaceRadiusAt`-tracking top does. Fracture goes back to
  being what it was meant for: breaking the repose cap. Outlets now stay within
  ±3° of the vent axis across a full eruption.

  Supersedes the earlier one-cell-deeper feed, which addressed the same symptom
  at the original surface only. During repose the feed still stops 3 cells short
  so a genuine cap can form.
- **Fallback tephra resting on the crater floor is no longer remelted.** The
  vent feed remelts debris that is genuinely buried in the throat, but a grain
  on an open crater floor is part of the cone's granular deposit. Remelting it
  fed a loop that converted the cinder cone into solid rock from the inside:
  fallout landed, was remelted, was pushed back up the bore, and set as immobile
  ROCK, which cannot slump to its angle of repose. Measured, one cycle remelted
  470 tephra cells against the 394 it fragmented — the cone was being consumed
  faster than it was being built. The exposure guard now applies to TEPHRA in
  both the erupting and repose regimes.
- **Magma reaches the vent at vent temperature.** A pressure route does not
  carry the injected parcel to the outlet — `_shiftPath` shifts the whole column
  by one and the parcel that *emerges* is the one already at the top — so a
  source's `temperature` only ever set the deepest cell and everything erupted
  at whatever the conduit was held at. Held flat at chamber heat (0.75), lava
  arrived at the crater already two stiffness tiers into the depth-gated regime
  and could not run anywhere. The bore feed now ramps from chamber heat to
  `VENT_TEMP` over the last third of the ascent.
- **The Effusion slider now controls discharge.** Every accepted route deducts
  its own cost from the source's head, so a budget sized for one ascent afforded
  exactly one parcel per frame however high the rate was set: Effusion 5
  discharged at the same one cell per frame as Effusion 1, and surface lava sat
  at a steady ~115 cells because flows were freezing exactly as fast as they
  were fed. The effusive source's head is now sized to the ascent *times* the
  requested rate, with `maxDischargePerFrame` carrying the rate itself. Its head
  also scales with the edifice: a fixed 60 could not reach the summit past about
  25 cells of growth, so the effusive phase silently stopped producing anything
  on a grown cone.
- **An eruption ends on ash, not on bare lava.** A closing ash fall
  (`PhaseDurations.coda`, 120 frames) runs between effusion and repose, so the
  cycle is now explosive → effusive → coda → repose. The last flow of an
  eruption used to be the last material placed and nothing came after it: its
  front stalls where it chilled, thickens as the supply behind keeps arriving,
  and freezes into a blunt wall that `ROCK` being static makes permanent — the
  ledges on the flank. The opening phase's fallout had been burying exactly
  those edges until it stopped. Interleaving lava tongues with granular strata
  is also what actually builds a stratovolcano's steep cone.
- **Each phase gets a share of the growth allowance.** The height cap is one
  budget for the whole eruption, and every phase checked it directly, so it was
  first-come-first-served and the opening burst always got there first. As the
  cone approached its cap the later phases were progressively starved: measured
  at the third episode, effusion fell to half its parcels and the closing ash
  fall to 9 of its 120 frames' worth — the flows the coda exists to drape are
  precisely the ones it stops being able to reach. `phaseCeiling` now reserves
  60% of the episode's growth for the opening burst, 80% through effusion, and
  the last slice for the coda, with a one-cell floor so a phase on an already-
  capped cone still emits something rather than reading as a broken button. It
  also bounds the overshoot that let a capped cone reach 59 cells against a cap
  of 46.
- **Every eruption runs its full explosive → effusive → repose arc.** Reaching
  the height cap ended the whole eruption, not just the source, so the cap
  tripping partway through the explosive phase sent the volcano straight from
  ash to dormant. Every episode after the first lost its effusive phase, and the
  lava flows were only ever visible on a fresh planet. The cap now only removes
  the source (as `stepVolcanoPre` already did); the cycle finishes.

### Changed
- **Pressure fracture gains directional targeting, seal-gating, and deliberate
  timing for configured sources** (vent-stability work, Phase 2 in progress).
  When a source sets a `fracture` config: fracture fires only on a genuine seal
  (`noOutlet`), never on `insufficientHead` or `searchLimit`; the target is
  selected from all boundary solids (including unbreakable ones) by highest
  potential before breakability is checked; at most one cell fractures per source
  per update, then the source stops until the next update; `fracturePressure`
  resets to zero on any accepted route so each seal episode builds from scratch;
  and a `maxDischargePerFrame` cap bounds the post-seal surge. The volcano's
  explosive source uses a 24-frame seal delay with 1 head/frame accrual (cap 18)
  — the plan's visible seal-then-buildup-then-reopen cycle. **Not yet complete:**
  no remembered `fractureFront` (full boundary rescan each frame), no mouth flare,
  repose heating stops 3 cells short, Phase 5 (debris accounting) not started.
  See `docs/plan-volcano-vent-stability.md` for full status. Legacy sources (no
  `fracture` config) are unchanged.

### Fixed
- **`swap()` now bounds-checks its coordinates.** Every other public accessor
  (`getMaterial`, `setMaterial`, `setHeat`, `isStructural`) guards out-of-range
  coordinates, but `swap()` called `getIndex()` (which does no bounds check)
  directly, so an out-of-range argument silently wrote to the wrong cell. `swap`
  now no-ops on out-of-bounds coordinates like its siblings. In-bounds call sites
  are unaffected.

### Changed
- **`OUTLET_LATERAL_SPREAD` and `PressureSourceFractureOptions` are now exported
  from the package root.** Both were `export`ed from `engine.ts` (and documented
  as public) but missing from the `sand` barrel, so they were unreachable from
  `aicraft-pixel-engine`. They now re-export through `src/sand/index.ts`.
- **npm metadata completed.** Added `repository`, `homepage`, `bugs`, `keywords`,
  `author`, and a `default` export condition so the npm page links back to the
  GitHub repo and is discoverable in search. Added a `prepublishOnly` gate
  (`npm run build && npm test`) so a release can never ship without a green
  typecheck and full test run.

## [0.1.1] — 2026-08-03

### Fixed
- **Package root entry now loads in plain Node ESM.** 0.1.0 emitted extension-less
  directory re-exports (`export * from './materials'`), which bundlers and `tsx`
  resolve but stock Node rejects with `ERR_UNSUPPORTED_DIR_IMPORT`. The build
  (`tsconfig.build.json`) now uses `module: NodeNext` / `moduleResolution: NodeNext`,
  and every relative import in `src/` carries an explicit `.js` extension, so the
  emitted `dist/` is Node-ESM-correct. No runtime behavior change; bundler and
  `tsx` consumers are unaffected.

## [0.1.0] — 2026-08-02

Initial public release. A pixel-based falling-sand cellular-automaton physics
engine for AI Craft games — zero runtime dependencies, deterministic, DOM-free
core (fully testable in Node). Extracted from `arcane-antics` as a sibling
library to `aicraft-engine`.

### Added — engine core
- **Falling-sand simulation.** Typed-array pixel grid (`Uint8Array`) of 14
  materials — sand, water, lava, oil, acid, fire, smoke, steam, gas, rock, wood,
  ice, walls. Density-driven displacement, granular flow, gas rising.
- **Material interactions.** Lava + water → rock + steam. Acid dissolves solids.
  Fire spreads via flammability and is extinguished by water. Flammable gas
  ignites and explodes. Ice melts near heat.
- **Pluggable gravity models** via a per-cell `NeighborFrame` seam: movement
  rules ask "which way is down here?" instead of assuming `+Y`.
  - `FlatGravity` (default) — classic top-down gravity.
  - `RadialGravity` — gravity toward a planet center, for Reus / Godfinger-style
    circular-planet god games.
- **Destructible terrain + explosions.** Carve circles out of walls/rock,
  scatter colored debris as sand particles, ignite fire/smoke cores. The
  explosion API exposes an `onExplode` hook for a future rigid-body layer.
- **Active-chunk optimization.** Only cells in 32×32 chunks flagged active are
  simulated, with border propagation so flow across chunk edges keeps regions
  alive.
- **Render-dirty tracking.** `consumeRenderDirtyChunks()` reports which regions
  changed since the last frame.
- **Settle detection.** Turn-based games can `beginSettle()` and wait until the
  grid calms (or times out) — for "physics resolves, then play resumes" flows.

### Added — liquid leveling & rheology
- **Potential-field liquid leveling.** A liquid only steps sideways when the
  move reaches a lower gravitational potential, so settled pools go quiet
  (0 swaps/frame) and compact (~92% fill) instead of shimmering forever.
  `liquidVel` direction memory breaks flow-direction ties deterministically.
- **Yield strength (`MaterialDef.yieldThickness`).** Non-Newtonian liquids: a
  Bingham-plastic liquid (lava) advances only while its thickness beats the
  yield threshold, stopping at a blunt flow front instead of feathering to a
  film. Water/oil/acid leave it unset and are unaffected. Lava declares
  `yieldThickness: 3`.
- **Per-cell rheology (`PixelEngine.stiffnessGrid`).** Optional `Uint8Array`
  overriding `yieldThickness` per cell (a host tracking heat makes fresh lava
  mobile and chilled lava stiff). Rides with the material through swaps and
  levelling transfers, like `colorGrid`.

### Added — showcase (not in the npm tarball)
- Standalone Vite app: a flat-gravity sandbox and a paintable radial-gravity
  planet section (with visual spin). Host-side helpers demonstrate the
  engine's public API:
  - **Volcano** — vent-fed, thermally-colored eruption built entirely on the
    engine API (host advects the magma conduit and supplies lava→rock cooling;
    the yield-strength term is what makes finite flows possible).
  - **Cloud** — toggle cloud mode and drag above the surface to paint clouds
    that rain real water and shrink as they empty.

### Documentation
- `README.md` — install (submodule / vendor / npm), quick start, architecture.
- `docs/integration.md` — integration guide: the host/engine boundary, the
  movement model, liquid leveling, yield strength, and remaining v1 limits.

### Tests
- 83 engine tests, 51 showcase tests — all passing. Suites cover determinism
  (golden tests under both gravity models), chunk propagation, reactions,
  liquid settling, yield strength, and the two showcase helpers.

### Not in scope (v1)
- No rigid bodies (`planck`/Box2D). The explosion hook is the extension point.
- No rendering — the library owns the simulation; you own the canvas.
- No level generation, loading, or serialization. Only the simulation core.

[0.1.0]: https://www.npmjs.com/package/aicraft-pixel-engine/v/0.1.0
[0.1.1]: https://www.npmjs.com/package/aicraft-pixel-engine/v/0.1.1
