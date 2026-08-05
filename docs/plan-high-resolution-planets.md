# Plan: high-resolution planets (up to 1000×1000)

> Design and optimisation plan. Status: proposed.

## Objective

Raise the planet showcase's simulation ceiling from 400×400 to 1000×1000
without making the interface unresponsive or changing the scene's behaviour by
accident.

The engine already accepts a 1000×1000 grid. The current 400-cell ceiling is an
HTML slider limit, not an engine or typed-array limit. The work is therefore
mostly about removing full-grid work from the steady-state frame, making the
renderer genuinely dirty-region based, and deciding how cell-sized mechanics
should scale when the same apparent planet contains more cells.

## Benchmark protocol and success criteria

Performance claims must be reproducible rather than depend on phrases such as
"normal activity" or "representative desktop." Each benchmark report records
the browser/version, operating system, CPU, device-pixel ratio, viewport size,
build mode, and commit. Measurements use a production build, a 560-CSS-pixel
planet viewport, a 10-second sample after warm-up, and at least five runs. Report
the median and p95 rather than only the best run.

The named 1000×1000 scenarios are:

- **S0 — Settled:** freshly built planet after movement and thermal chunks have
  gone to sleep;
- **S1 — Brush:** continuous painting and erasing while zoomed in;
- **S2 — Scatter:** one default Scatter event, sampled once while falling and
  once during final settling;
- **S3 — Cloud:** one default cloud raining until depletion;
- **S4 — Explosive volcano:** default explosive phase with ash emission;
- **S5 — Effusive volcano:** default lava emission, flow, cooling, and freezing;
- **S6 — Growth:** one default seed growing to a mature plant on prepared soil;
- **S7 — Spin:** a visually spinning but physically settled planet;
- **S8 — Rebuild:** five alternating 400 ↔ 1000 resolution rebuilds.

"Normal activity" means each of S1–S6 run individually, not all features piled
onto the same frame. "Moderate activity" means S1, S2, or S3 individually. A
combined spinning volcano with multiple clouds is a stress test whose results
are reported but do not gate the first release.

On the recorded reference machine at 1000×1000:

- S0 performs no full-grid host scan, pixel upload, or visible-canvas redraw;
- S1–S6 advance 58–62 physics ticks per wall-clock second and render at least
  30 frames per second over 95% of one-second windows;
- S7 performs no offscreen pixel upload while the base grid is unchanged;
- S8 completes each rebuild within one second, presents progress, and produces
  no main-thread task longer than 50 ms; zoom, pan, and page input remain
  responsive while painting into the outgoing world is explicitly disabled;
- Scatter, clouds, growth, volcano construction, cooling, and dormancy remain
  functional across the full resolution and diameter ranges;
- memory returns to within 10% of the post-first-build baseline after S8 and a
  garbage-collection observation window;
- the performance readout reports complete frame cost, upload bytes/calls,
  update rate, and render rate.

A stretch target is 60 rendered frames per second during S1–S3. It is not a
prerequisite for the first production-quality version.

## Current baseline

The area increase is the important number:

| Resolution | Cells | Relative area | RGBA image size |
|---|---:|---:|---:|
| 400×400 | 160,000 | 1× | 0.64 MB |
| 1000×1000 | 1,000,000 | 6.25× | 4 MB |

Measurements from the current implementation:

- the running showcase at 400×400 takes approximately 2 ms per idle tick for
  the timed simulation/host section;
- a Scatter workload at 400×400 measured approximately 3.4 ms per tick while
  active (about 25,000 scanned cells and 200 swaps per tick in the sampled
  window);
- a Node microbenchmark showed `syncFromHeat` scaling from about 7.6 ms at
  400×400 to 47.8 ms at 1000×1000;
- full CPU pixel packing scaled from about 1.35 ms to 8.57 ms in the same
  benchmark;
- constructing and stamping the 1000×1000 world took about 88 ms in Node, and
  its first fully active heat/simulation tick was substantially more expensive
  than a settled tick.

The absolute Node timings are not browser predictions. Their useful signal is
the near-exact 6.25× area scaling. Applying that ratio to the browser's idle
measurement puts the existing 1000×1000 path near 12–13 ms before the current
full canvas upload and draw.

### Approximate memory at 1000×1000

The base high-resolution planet allocates roughly:

| Storage | Approximate size |
|---|---:|
| Material, updated, and liquid-velocity grids | 3 MB |
| Heat grid and heat-delta grid | 8 MB |
| Colour grid (currently allocated by `syncFromHeat`) | 4 MB |
| Persistent `ImageData` | 4 MB |
| Visible and offscreen canvas backing stores | at least 8 MB |

That is about 27 MB of raw world/render storage before browser and GPU
overhead. A stiffness grid adds 1 MB and a growth grid adds 2 MB. Memory is not
the primary blocker, but buffer lifetime must be checked during repeated slider
rebuilds.

## Identified bottlenecks and correctness issues

### 1. `syncFromHeat` performs a full-grid scan every tick

`showcase/helpers/volcano.ts` scans every cell to find lava and hot rock even
when `PixelEngine.runHeatStep` has already put the entire thermal world to
sleep. This defeats the engine's thermal chunk optimisation and dominates the
idle high-resolution cost.

It also allocates `colorGrid`, adding four bytes per cell. The allocation is
lazy via `ensureColorGrid`, but because the planet disc is ROCK (which is in the
scan set), it lands on the first `syncFromHeat` call — before any volcano or
custom tint actually needs a tint.

### 2. Rendering is only partially dirty-aware

`paintGridInto` restricts CPU colour packing to dirty chunks, but
`showcase/sections/planet.ts` still calls full-image `putImageData`, clears the
visible canvas, and draws the full offscreen canvas every tick. At 1000×1000,
the raw `putImageData` payload alone is 4 MB per rendered frame, or 240 MB/s at
60 FPS before the following canvas copy.

### 3. The frame timer does not include rendering

The performance timer is sampled before `render()` runs. Raising the ceiling
using that number would size the feature against an incomplete budget.

### 4. The update loop is a fixed `setInterval`

When a high-resolution tick overruns 16.7 ms, `setInterval` provides no useful
back-pressure, interpolation, or controlled separation between physics and
presentation. Simulation and rendering are forced to run at the same rate.

### 5. Rebuilding is a synchronous main-thread operation

The 1000×1000 diagnostic took about 88 ms in Node to construct and stamp, and
the first fully active tick was substantially more expensive. The current
`buildWorld` performs the work synchronously, so dirty rendering and a better
steady-state scheduler cannot prevent a visible rebuild freeze. Meeting the
responsiveness criterion requires either cooperative construction with bounded
yields or moving construction and simulation off the main thread. This cannot
be left as an incidental benefit of the optional Worker phase.

### 6. Volcano surface queries have a fixed 60-cell search limit

`surfaceRadiusAt`, `summitRadius`, and calls through `edificeHeight` default to
a 60-cell search. At 1000×1000 and the default 60% diameter, the initial volcano
cap (`capStart`) is 90 cells; `capMax` is 165 (`capMax` is
`min(round(planetRadius·0.55), headroom−2)`; with planetRadius 300 and headroom
200 that is `min(165, 198)` = 165 — 198 is the `headroom−2` bound, which does not
bind at 60% diameter). The query cannot observe even the 90-cell initial target
height, breaking cap checks and dormancy before the higher ceiling matters.

### 7. Higher resolution currently means a larger world, not the same world in
greater detail

Several behaviours are expressed in absolute cells (verified against the code):

- brush radius (a cell count; default 3);
- cloud radius (7 cells) and per-cell water capacity (60), though rain *width*
  is already derived from radius (`max(0.5, r·0.8)`), not fixed;
- tree energy, branch lengths, and canopy radius (energy 10, canopy radius 2);
- grass resource range (6 cells);
- among the volcano parameters, most are already `planetRadius` ratios (chamber
  radius/depth, cap start/step/maximum; ejecta loft and breach thresholds are
  host-supplied or in head/pressure units). The genuinely fixed cell counts are
  the cap on the otherwise ratio-derived conduit half-width (3) and the repose
  feed's 3-cell short-stop below the surface;
- liquid dispersion (default 16, though per-engine overridable) and lava yield
  thickness (material default 3, though the host overrides it per-cell from a
  temperature curve);
- particle speed, which is one cell per tick for the gravity/checkerboard core
  but up to four cells per tick for velocity/ballistic cells (explosions,
  pressure fountains).

If these remain unchanged, a 1000-cell planet will have much smaller trees,
clouds, brushes, and flow features than the 220-cell reference scene. That may
be desirable if resolution is intended to create a physically larger world. It
is incorrect if the intent is to show the same apparent planet with more
detail. This decision must be explicit before tuning is locked in.

Most volcano geometry is already resolution-aware: chamber radius/depth and the
cap start, step, and maximum are derived from planet radius and headroom. The
remaining volcano scaling audit is therefore narrower than the general world
scale audit and should not retune geometry that is already proportional.

### 8. Fit view cannot display every high-resolution cell

The planet viewport is approximately 560 CSS pixels wide. A 1000-cell canvas is
downsampled in Fit view, so the additional detail becomes visible principally
when zoomed in. The existing zoom/pan controls make this usable, but the UI
should communicate the distinction between simulation resolution and display
size.

## Proposed architecture

Use the existing chunk system as the shared unit of simulation, heat styling,
and rendering. Avoid introducing a Worker or WebGL in the first pass; first
remove the known unconditional work and measure what remains. Rebuilds are the
exception: cooperative main-thread construction is part of the required plan,
and failure to keep its individual tasks below 50 ms promotes Worker work from
optional to required.

The intended frame flow is:

1. advance zero or more fixed 60 Hz simulation ticks using an accumulator;
2. after each update, read `engine.thermalChunks`, which at that point contains
   the chunks processed by the heat step that just completed, and scan only
   those chunks to update host-owned stiffness and tint;
3. consume render-dirty chunks and repaint only those chunks into the persistent
   `ImageData`;
4. choose between coalesced dirty chunk runs, a dirty bounding rectangle, and a
   full upload based on measured call overhead and dirty coverage;
5. redraw the visible canvas only when the base image, spin angle, cloud layer,
   or overlay changed;
6. present at 30 FPS in high-resolution mode, while physics remains at 60 ticks
   per second.

The showcase should pause simulation while the document is hidden and discard
hidden elapsed time on resume rather than attempting wall-clock catch-up. No
visibility handling exists in the showcase today — background tabs are merely
throttled by the browser — so this is a Phase 3 deliverable, not current
behaviour. It is the intended showcase power/CPU policy: backgrounding pauses
growth, rain, cooling, and eruptions. A future game that promises offline
progression must implement that separately from this rendering scheduler.

## Implementation phases

### Phase 0 — Add repeatable performance instrumentation

Do this before changing behaviour so each optimisation has a measurable effect.

- Expand the performance record to include:
  - input/host pre-step;
  - `engine.update()`;
  - host heat synchronisation;
  - CPU dirty-pixel packing;
  - `putImageData` upload;
  - visible canvas composition;
  - total frame time;
  - active movement chunks, active thermal chunks, and dirty render chunks;
  - pixel-upload calls and bytes;
  - longest main-thread task and total rebuild duration.
- Report update rate and render rate separately.
- Implement the named S0–S8 scenarios from the benchmark protocol, plus the
  combined stress scenario.
- Capture baselines at 400, 600, 800, and 1000.
- Store the environment metadata and median/p95 results with the benchmark
  output so numbers from different machines are not silently combined.

Acceptance: the displayed total frame time includes `render()` and can expose a
render bottleneck even when the engine reports zero scanned cells. S0–S8 can be
repeated with the same deterministic inputs and produce comparable reports.

### Phase 1 — Make host heat synchronisation chunk-aware

- Change `syncFromHeat` to accept `engine.thermalChunks` and scan only those
  chunks. `PixelEngine.update()` swaps the thermal buffers before running heat,
  so after it returns this public mask is the set processed by the heat step that
  just completed. Document this host-facing lifecycle contract next to the call.
- Do not add a separate `heatDirtyChunks` API unless implementation work proves
  the existing post-update contract insufficient.
- Keep the first synchronisation a full paint so a newly built or loaded world
  is visually complete.
- Allocate `colorGrid` only when a cell actually needs a custom tint. Do not
  allocate it merely to discover that no hot cell exists.
- Make the existing colour sentinel explicit: packed colour `0` means "no
  override; use the material palette" and is reserved. Opaque black remains
  representable as `0xff000000`; a transparent-black custom override is not.
- Avoid rewriting `stiffnessGrid` when the derived value has not changed.
- Add tests for:
  - hot cells inside an active thermal chunk are updated;
  - cells outside the mask are untouched;
  - a cooling cell remains synchronised until its thermal chunk sleeps;
  - a cell starting immediately above and below every tint and stiffness
    threshold is synchronised on the exact tick its stored temperature crosses
    the threshold, including a final change close to `HEAT_EPSILON`;
  - a phase change is styled correctly on the tick it happens;
  - an entirely cold planet does not allocate `colorGrid`;
  - colour `0` falls back to the palette and opaque black remains a valid tint.

The heat engine stores every computed temperature, but it only wakes a thermal
chunk and marks a cell render-dirty when the change exceeds `HEAT_EPSILON`; the
host styles that stored value after the step. The boundary tests must pin this
wake-threshold relationship specifically — a sub-`HEAT_EPSILON` drift *is*
stored but does not re-wake the chunk, so it will not be re-synced until the
next above-threshold wake. The tests guard against a future change to heat-sleep
semantics silently leaving a tint or stiffness band one step behind.

Acceptance: a settled 1000×1000 planet performs no full-grid host scan and heat
synchronisation cost is proportional to the hot region rather than world area.

### Phase 2 — Complete the dirty-region renderer

- Have the renderer return whether anything changed and the affected chunk
  runs or dirty bounds.
- Coalesce horizontally adjacent dirty chunks into row runs.
- Use the dirty rectangle form of `putImageData` for each coalesced run instead
  of uploading the entire image.
- Skip `putImageData` when there are no dirty chunks.
- Skip visible-canvas composition when all of the following are unchanged:
  - offscreen base image;
  - spin angle;
  - cloud visuals;
  - crosshair/overlay state;
  - viewport-independent presentation state.
- Continue redrawing the visible canvas while spinning or while clouds animate,
  but do not re-upload an unchanged offscreen base.
- Benchmark a single dirty chunk, a local cluster, the Scatter ring, and a full
  dirty frame. If many small `putImageData` calls are slower than a bounding
  rectangle, select between run, bounds, and full-upload strategies using dirty
  coverage and run count. Instrument the chosen call count and uploaded bytes.
- Extend renderer tests to cover partial edge chunks at sizes that are not
  multiples of `CHUNK_SIZE`.

Acceptance: a stationary planet performs zero pixel upload and zero visible
canvas redraw. A local brush stroke does not upload the entire 1000×1000 image.
During S2, the adaptive strategy remains within the 33.3 ms render budget at
p95, never uploads more than one full-image equivalent per rendered frame, and
keeps upload call count bounded by the number of chunk rows rather than the
number of individual dirty chunks.

### Phase 3 — Decouple simulation ticks from rendered frames

- Replace `setInterval` with a `requestAnimationFrame` loop and a fixed-step
  accumulator.
- Keep the simulation step at 60 Hz so cooling, growth, rainfall, and eruption
  tuning retain their existing time semantics.
- Render at:
  - up to 60 FPS for lower resolutions;
  - 30 FPS by default above a measured threshold, initially 600 or 800;
  - immediately after direct user painting, a world rebuild, or a flagged
    high-priority visual event.
- Add an explicit presentation-priority signal for one-tick transients such as
  explosion peaks or flashes. A priority event forces presentation after that
  simulation tick so a 30-FPS renderer cannot skip both its appearance and
  disappearance. Persistent state changes continue to use ordinary dirty chunks.
- Cap the number of catch-up ticks per animation frame to prevent a long pause
  from causing an unbounded update spiral.
- Record dropped/capped simulation time in development diagnostics.
- On `visibilitychange` to hidden, stop scheduling simulation and rendering. On
  return, reset the accumulator timestamp and discard hidden elapsed time rather
  than attempting catch-up. Document that backgrounding pauses showcase time.

Acceptance: rendering at 30 FPS does not slow physics, and an expensive frame
does not create an ever-growing timer backlog. A one-tick priority-event fixture
is visible in an automated presentation trace, and a five-minute hidden interval
does not advance or trigger a catch-up burst on resume.

### Phase 4 — Keep high-resolution rebuilds responsive

- Split `buildWorld` into an asynchronous preparation step and an atomic world
  swap. Keep the outgoing world visible while the replacement is prepared.
- Show rebuild progress and disable painting/world-mutating controls during
  preparation so input is not accepted into a world that is about to be
  discarded. Keep page scrolling, zoom, pan, and non-world UI responsive.
- Perform disc stamping and other row/chunk work in bounded batches, yielding to
  the browser when the current task approaches an 8 ms construction budget.
- Measure engine allocation, heat-grid seeding, disc stamping, initial heat
  processing, initial pixel packing, and canvas allocation separately.
- If constructor allocation or heat seeding alone produces a task over 50 ms,
  add a bulk/deferred initialisation seam to `PixelEngine`. Avoid hundreds of
  thousands of `setMaterial` wake/dirty calls when a one-time bulk stamp can
  initialise chunk state once after filling.
- Cancel a pending build when a newer debounced resolution/diameter request
  supersedes it. Release its buffers and never swap it into view.
- After the atomic swap, schedule the expensive first thermal work through the
  same bounded frame scheduler rather than hiding it inside the rebuild callback.
- If these steps cannot keep every construction task below 50 ms on the
  reference machine, promote the Worker design in Phase 8 to a release
  requirement. Do not weaken the responsiveness criterion silently.

Acceptance: S8 meets both limits: each rebuild finishes within one second and no
main-thread task exceeds 50 ms. Superseded builds never flash into view, and
painting is visibly disabled only for the bounded preparation interval.

### Phase 5 — Remove resolution-dependent correctness limits

- Replace the volcano's fixed 60-cell surface scan with a limit derived from
  planet radius, configured cap, headroom, or the ray's distance to the grid
  boundary.
- Ensure the limit always exceeds `capMax` plus gap tolerance without probing
  out of bounds unnecessarily.
- Audit all other fixed search distances and caps in the planet helpers.
- Expand slider-range geometry tests through 1000. For cheap arithmetic tests,
  cover every slider value. For simulation-heavy tests, use representative
  endpoints and the default:
  - 120;
  - 220;
  - 400;
  - 600;
  - 800;
  - 1000.
- Add a regression proving that a default-diameter 1000×1000 volcano can observe
  its 90-cell initial cap and enter dormancy.

Acceptance: every slider position has valid chamber/core clearance, valid
headroom, observable cap heights, and terminating eruption states.

### Phase 6 — Define and implement scale semantics

Choose one of the following modes before adjusting tuning constants.

#### Recommended: reference-scale mode

Treat 220×220 as the authored reference and define:

```ts
const worldScale = world.size / 220;
```

Scale host-authored lengths so the planet retains its apparent composition:

- brush footprint;
- cloud radius and rain footprint;
- eruption loft and fixed volcano clearances;
- the absolute cap on ratio-derived conduit width (remove or raise it where
  safe);
- any showcase-only explosion radius;
- tree initial energy and canopy dimensions when planted in this world.

Do not rescale the chamber or cap geometry a second time: chamber radius/depth,
cap start, cap step, and cap maximum already derive from planet radius and
headroom. Preserve those formulas unless a high-resolution behaviour test finds
a specific defect.

Do not blindly scale every engine constant. Audit each independently:

- scaling liquid dispersion preserves a similar world-space reach but increases
  the worst-case liquid scan cost;
- scaling lava yield thickness changes morphology and requires new golden tests;
- scaling growth energy can exceed the current packed 7-bit energy range at
  future resolutions, though 1000 remains manageable for the present tree;
- one-cell-per-tick movement makes large worlds take longer to cross even when
  feature dimensions scale.

Where the engine currently reads global material definitions, add an explicit
per-world or per-engine tuning seam instead of mutating global material data.

#### Alternative: larger-world mode

Keep all engine cell constants unchanged and document that increasing resolution
makes the planet physically larger. This is simpler and cheaper but produces
smaller-looking vegetation, clouds, brushes, and volcano details. If selected,
the UI should not describe the result as merely a higher-detail version of the
same planet.

Acceptance: screenshots and behaviour tests demonstrate the chosen semantics at
220, 400, and 1000; the choice is documented in the showcase UI/README.

### Phase 7 — Raise the slider ceiling and add quality tiers

Only raise the public ceiling after Phases 0–6 pass their acceptance checks.

- Change the resolution input maximum from 400 to 1000.
- Consider a non-linear set of useful values rather than 45 positions at a
  constant 20-cell step, for example 120, 160, 220, 300, 400, 600, 800, 1000.
  A `<select>` or stepped presets may communicate cost better than a continuous
  range slider.
- Label high-resolution modes with their presentation target, for example:
  - 400: Performance;
  - 600: Balanced;
  - 800: Detail;
  - 1000: Maximum detail (30 FPS rendering).
- Show estimated cell count and measured total frame cost in development mode.
- Preserve the current default of 220 until profiling supports changing it.

Acceptance: 1000 can be selected normally, rebuilds once after the existing
debounce, and the UI accurately describes the active quality/performance mode.

## Conditional Phase 8 — Worker and `OffscreenCanvas`

Do not start here solely on the assumption that one million cells require a
Worker. Re-measure after the sparse heat, renderer, and cooperative rebuild
work. This phase becomes required, however, if Phase 4 cannot keep construction
tasks below the 50 ms responsiveness limit.

If 1000×1000 still cannot meet the target during S2, S4, and S5:

- move `PixelEngine`, volcano stepping, heat styling, and base-grid rendering to
  a Web Worker;
- use `OffscreenCanvas` so the worker owns the large pixel upload;
- send compact input commands (paint stroke, slider change, clear, scatter)
  rather than copying the full grid each frame;
- send presentation metadata and performance counters back to the main thread;
- keep cloud/overlay rendering either in the worker or in a separate main-thread
  layer, but avoid transferring a 4 MB buffer at 60 Hz;
- retain a non-Worker fallback if required by supported browsers.

This phase improves responsiveness more reliably than it improves total CPU
cost. It is justified when main-thread latency remains the problem after
unconditional work has been removed.

## Files likely to change

- `showcase/index.html`
  - resolution control and quality labels;
- `showcase/sections/planet.ts`
  - frame scheduler, complete timing, asynchronous rebuild state, priority
    presentation events, dirty upload/composition, scale wiring;
- `showcase/helpers/renderer.ts`
  - dirty run/bounds reporting and partial-render helpers;
- `showcase/helpers/volcano.ts`
  - chunk-aware heat styling, dynamic surface limits, scaled host constants;
- `showcase/helpers/cloud.ts`
  - explicit scaled radius/capacity semantics;
- `src/sand/engine.ts`
  - bulk/deferred initialisation if required by rebuild profiling, plus any
    per-world tuning seam; no heat-dirty API is expected initially because the
    existing post-update `thermalChunks` contract is sufficient;
- `showcase/tests/renderer.test.ts`
  - dirty bounds/runs, upload strategy selection, tint sentinel, and partial
    edge chunks;
- `showcase/tests/volcano.test.ts`
  - 1000-range geometry, cap visibility, and dormancy;
- `showcase/tests/cloud.test.ts`
  - high-resolution placement and scale semantics;
- relevant engine tests if liquid, growth, thermal-chunk, initialisation, or
  tuning contracts change.

## Verification matrix

For each of 220, 400, 600, 800, and 1000:

| Scenario | Behaviour checks | Performance checks |
|---|---|---|
| Fresh settled planet (S0) | correct disc and crosshair | no continuing full-grid work, upload, or redraw |
| Brush and erase | correct pointer mapping at Fit and zoom | local dirty upload only |
| Scatter (S2) | radial fall and eventual settlement | adaptive upload stays ≤ one image-equivalent and ≤ one call per chunk row |
| Cloud | placement guard, rain, depletion | cost proportional to active rain |
| Growth (S6) | radial orientation and expected apparent scale | no world-area growth scan |
| Volcano: explosive | cone and crater formation | total frame time and dirty coverage |
| Volcano: effusive | flowing, cooling, freezing, tint | thermal chunks eventually sleep |
| Volcano: dormant | cap observed and state terminates | settled cost returns near zero |
| Spin (S7) | visual rotation and pointer un-rotation | no repeated offscreen upload without dirt |
| Tint/stiffness thresholds | exact stored-temperature boundary transitions | only processed thermal chunks are scanned |
| Priority transient | one-tick event is presented at 30-FPS mode | forced frame is counted and bounded |
| Rebuild loop (S8) | correct geometry, cancellation, and deterministic reset | <1 s total, <50 ms longest task, no retained old-world memory |
| Hidden/resume | showcase time intentionally pauses | no hidden work or catch-up burst |

Also test diameter endpoints (30%, 60%, and 80%) at 120 and 1000, since those
combinations exercise the smallest core clearance and the tightest headroom.

## Rollout and fallback

1. Land instrumentation separately so before/after numbers remain comparable.
2. Land chunk-aware heat synchronisation.
3. Land partial canvas upload and idle render skipping.
4. Land the fixed-step/render scheduler.
5. Land cooperative/cancellable rebuilds; promote Worker work if the 50 ms task
   bound cannot be met.
6. Land volcano correctness limits and the 1000-only development flag.
7. Decide and land scale-semantics changes.
8. Enable 600 and 800 for validation.
9. Enable 1000 after the full verification matrix passes.

If 1000 misses the target on supported desktop hardware, keep it available as
an explicitly labelled maximum-detail/30-FPS mode while retaining 600 or 800 as
the recommended setting. Do not silently lower simulation tick rate, because
that changes cooling, growth, rain, and eruption behaviour.

## Recommended first milestone

The first implementation milestone should include Phases 0–5 and expose
1000×1000 only behind a development constant. That milestone answers the key
question with real browser data: whether sparse host work plus a genuinely dirty
renderer and cooperative construction are enough, or whether
Worker/OffscreenCanvas work is warranted.

Phase 6 scale semantics are deliberately outside that first milestone. The
development build will therefore use today's larger-world semantics: it tests
whether one million cells can run responsively, not whether the result yet looks
like the same 220-cell planet at higher detail. Review the milestone against its
performance and correctness targets, not against final feature proportions.

The expected outcome is that a settled 1000×1000 planet is cheap, moderate local
activity maintains 60 physics ticks with 30–60 rendered frames, and only broad
whole-world activity approaches the limit. That is the right point to decide
whether the additional Worker complexity buys enough to justify itself.
