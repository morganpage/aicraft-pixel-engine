# aicraft-pixel-engine

A pixel-based **falling-sand cellular-automaton physics engine** for AI Craft games. Zero runtime dependencies. Deterministic. DOM-free core, fully testable in Node.

Inspired by Noita / Worms-style destructible-terrain sims. Extracted from the `arcane-antics` game into a reusable, dependency-free library that ships in the same sibling-repo style as [`aicraft-engine`](../aicraft-engine).

## What it does

### Simulation core

- **Falling-sand simulation.** A typed-array pixel grid (`Uint8Array`) of 23 materials — sand, tephra, water, lava, oil, acid, fire, smoke, steam, flammable gas, rock, wood, ice, walls, plus the life materials (grass, seed, tree tip, leaf, fern tip, frond, spore, coral). Density-driven displacement, granular flow, liquid leveling, gas rising.
- **Material interactions.** Lava + water → rock + steam. Acid dissolves solids. Fire spreads via flammability and is extinguished by water. Flammable gas ignites and explodes. Ice melts near heat.
- **Destructible terrain + explosions.** Carve circles out of walls/rock, scatter colored debris as ballistic particles, ignite fire/smoke cores.
- **Pluggable gravity models.** Movement rules ask "which way is down here?" instead of assuming `+Y`.
  - `FlatGravity` (default) — classic top-down gravity, byte-identical to a flat-world sim.
  - `RadialGravity` — gravity toward a single planet center. For **Reus / Godfinger-style circular-planet god games**.
- **Deterministic.** Seeded mulberry32 RNG; same seed + same inputs → identical grid evolution. Validated by golden tests under both gravity models.

### Physical systems (all opt-in — a world that never uses one pays nothing)

- **Heat and climate.** Turn on with `enableHeat: true`. Every thermal material conducts to its neighbours, radiates to the environment through exposed faces, and phase-changes: lava → rock, water → steam / ice, steam → water, ice → water. `FIRE` is an infinite heat source; `LAVA` is a finite body that cools. `ambientTemperature` is the climate dial — turn it down and the oceans freeze on their own.
- **Growth.** Three rule kinds: `spread` (grass/moss — isotropic, moisture-gated, with a travel `range`), `tip` (trees/ferns — a directed, stateful growing point that leaves a trunk and branches behind it), and `aggregate` (seeds germinating, spores accreting onto coral). Growth is gravity-relative, so on a planet a tree grows radially outward. Tips always die, so a forest converges instead of consuming the grid.
- **Pressure transport.** `addPressureSource` routes a liquid (v1: lava only) through its connected body to a real boundary outlet via a Dijkstra search, accounting for gravitational head and per-material resistance. Blocked sources accrue pressure and can fracture solids. `injectLiquid` is the one-shot version. This is the volcano engine.
- **Velocity field.** `setVelocity` / `applyImpulse` give a cell a sub-cell velocity that integrates ballistically across frames under gravity and drag. Explosions and pressure outlets use it; hosts can use it for anything.
- **Fragmentation.** An airborne lava cell that cools past its `fragmentsAt` threshold while still in flight becomes granular `TEPHRA`, which piles at its angle of repose and builds a cone. Grounded cells never fragment — they freeze to `ROCK`.
- **Yield strength.** Lava is a Bingham plastic: it flows only while thick enough, stopping at a blunt front, which is why it looks like lava and not like orange water. Override per-cell via `engine.stiffnessGrid` as the melt cools.

### Volcano subsystem (`aicraft-pixel-engine` → `src/volcano/`)

- **A complete eruption cycle**, composed from the primitives above rather than bolted on beside them: `stampVolcano` cuts a chamber and conduit into a planet, `stepVolcanoFrame` runs one frame of the explosive → effusive → repose cycle, and the plumbing maintenance (`rechargeReservoir`, `remeltConduit`, `assimilateTephra`) keeps a vent usable between episodes.
- **Temperature-driven rheology.** `stiffnessForTemp` maps a lava cell's heat onto its yield thickness and `syncFromHeat` writes it back each frame, so a flow runs while molten, stalls into a blunt front as it chills, and sets into rock — the curve that makes lava read as lava.
- Ash plumes, vent glow, and screen shake are **not** here; they are host-side renderables that never touch the grid, and this library ships no renderer. See `showcase/helpers/volcano-effects.ts` for a worked example.

### Host-facing plumbing

- **Active-chunk optimization.** Only simulate cells in 32×32 chunks flagged active, with border propagation so flow across chunk edges keeps regions alive. The heat field keeps its own independent chunk set, so a motionless flow still cools.
- **Render-dirty tracking.** Consumers ask `consumeRenderDirtyChunks()` to know which regions of the grid changed since the last frame.
- **Settle detection.** Turn-based games can `beginSettle()` and wait until the grid calms (or times out). Tunable per-engine via `settleStableThreshold` / `settleTimeoutFrames` / `settleSwapThreshold`.
- **Bulk stamping.** `beginBulk()` / `endBulk()` skip per-cell bookkeeping while building a large world; `stampDisc()` is the brush primitive for everything smaller.

## What it does NOT do (v1)

- **No rigid bodies.** No `planck` / Box2D, no rotated boxes, no joints. The explosion API exposes a hook so a future rigid-body layer can apply its own impulses.
- **No rendering.** The library owns the simulation; you own the canvas. Read `grid`, `colorGrid`, and `consumeRenderDirtyChunks()` and draw however you like.
- **No level generation, loading, or serialization.** Only the simulation core ships in v1.

## Install

The library is structured to be consumable three ways (mirrors `aicraft-engine`):

### Option A — Git submodule (recommended for AI Craft sibling games)

```bash
git submodule add <aicraft-pixel-engine-git-url> src/lib/aicraft-pixel-engine
```

```ts
import { PixelEngine } from './lib/aicraft-pixel-engine/src/sand';
import { FlatGravity } from './lib/aicraft-pixel-engine/src/gravity';
```

Requires `moduleResolution: "bundler"` in your `tsconfig.json`. Vite resolves the path transparently.

### Option B — Vendored copy

```bash
cp -r /path/to/aicraft-pixel-engine/src /path/to/game/src/lib/aicraft-pixel-engine/
```

### Option C — npm package

```bash
npm install aicraft-pixel-engine
```

```ts
import { PixelEngine, FlatGravity } from 'aicraft-pixel-engine';
```

**ESM only.** The package is `"type": "module"` and its `exports` map publishes
no `require` condition, so `require('aicraft-pixel-engine')` fails with
`ERR_REQUIRE_ESM` on Node. Use `import`, or `await import()` from CommonJS.
Only the package root (`.`) is exported — deep subpaths like
`aicraft-pixel-engine/src/sand` are not part of the public surface.

## Quick start

```ts
import { PixelEngine } from './lib/aicraft-pixel-engine/src/sand';
import { MaterialType } from './lib/aicraft-pixel-engine/src/materials';
import { FlatGravity } from './lib/aicraft-pixel-engine/src/gravity';

const engine = new PixelEngine({ width: 200, height: 150, seed: 12345, gravity: new FlatGravity() });

// Pour some sand
engine.setMaterial(100, 10, MaterialType.SAND);

// Step the simulation
engine.update();

// Read dirty chunks for rendering
const dirty = engine.consumeRenderDirtyChunks();
```

### Circular planet (god-game mode)

```ts
import { PixelEngine } from './lib/aicraft-pixel-engine/src/sand';
import { RadialGravity } from './lib/aicraft-pixel-engine/src/gravity';
import { MaterialType } from './lib/aicraft-pixel-engine/src/materials';

const W = 200, H = 200, cx = 100, cy = 100;
const engine = new PixelEngine({
  width: W, height: H, seed: 1,
  gravity: new RadialGravity({ centerX: cx, centerY: cy }),
});

// Stamp a disc planet out of rock, then drop sand around it.
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy <= 30 * 30) engine.setMaterial(x, y, MaterialType.ROCK);
  }
}
engine.setMaterial(cx + 35, cy, MaterialType.SAND);

engine.update(); // sand falls radially toward the planet surface
```

## Architecture

```
src/
├── materials/   # MaterialType enum + MaterialDef table (pure data)
├── gravity/     # GravityModel seam: FlatGravity (default), RadialGravity (planets)
├── sand/        # PixelEngine core + neighbor frame (the gravity-relative movement seam)
├── volcano/     # Opt-in subsystem: eruption cycle composed from the core's primitives
├── rng.ts       # mulberry32, shared by the engine stream and host side-streams
├── index.ts     # top-level barrel
└── tests/       # vitest suites (+ tests/helpers/ fixtures, never shipped)
```

`volcano/` is the one **subsystem** rather than a core module: nothing in
`sand/`, `materials/`, or `gravity/` imports it, so a world that never builds a
volcano never loads it. It composes pressure sources, the heat field,
fragmentation, `stiffnessGrid`, and the velocity field into an eruption that
ascends a conduit, fountains ballistically, and stacks a cone that stops
growing — the arrangement that is hard to rediscover from the primitives.

**Layer discipline** (mirrors `aicraft-engine`): the entire v1 library is the *deterministic core* — pure functions, no DOM, no `Math.random`, no `Date.now`, no side effects. This keeps it fast to test in Node and safe to run headless or in a worker.

End-to-end wiring — install options, the render loop, input handling, and the
per-system recipes — is in [`docs/integration.md`](./docs/integration.md).

## Game prompts

Ready-to-paste build briefs for games built on the engine live in
[`games/`](./games/README.md) — start with the [god game](./games/god-game.md),
a one-screen circular-planet terraforming toy.

## License

MIT
