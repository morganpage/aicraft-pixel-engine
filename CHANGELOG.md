# Changelog

All notable changes to **aicraft-pixel-engine** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
