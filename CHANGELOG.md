# Changelog

All notable changes to **aicraft-pixel-engine** are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://www.npmjs.com/package/aicraft-pixel-engine
