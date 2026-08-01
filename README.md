# aicraft-pixel-engine

A pixel-based **falling-sand cellular-automaton physics engine** for AI Craft games. Zero runtime dependencies. Deterministic. DOM-free core, fully testable in Node.

Inspired by Noita / Worms-style destructible-terrain sims. Extracted from the `arcane-antics` game into a reusable, dependency-free library that ships in the same sibling-repo style as [`aicraft-engine`](../aicraft-engine).

## What it does

- **Falling-sand simulation.** A typed-array pixel grid (`Uint8Array`) of materials — sand, water, lava, oil, acid, fire, smoke, steam, gas, rock, wood, ice, walls. Density-driven displacement, granular flow, liquid leveling, gas rising.
- **Material interactions.** Lava + water → rock + steam. Acid dissolves solids. Fire spreads via flammability and is extinguished by water. Flammable gas ignites and explodes. Ice melts near heat.
- **Destructible terrain + explosions.** Carve circles out of walls/rock, scatter colored debris as sand particles, ignite fire/smoke cores.
- **Pluggable gravity models.** Movement rules ask "which way is down here?" instead of assuming `+Y`.
  - `FlatGravity` (default) — classic top-down gravity, byte-identical to a flat-world sim.
  - `RadialGravity` — gravity toward a single planet center. For **Reus / Godfinger-style circular-planet god games**.
- **Deterministic.** Seeded mulberry32 RNG; same seed + same inputs → identical grid evolution. Validated by golden tests under both gravity models.
- **Active-chunk optimization.** Only simulate cells in 32×32 chunks flagged active, with border propagation so flow across chunk edges keeps regions alive.
- **Render-dirty tracking.** Consumers ask `consumeRenderDirtyChunks()` to know which regions of the grid changed since the last frame.
- **Settle detection.** Turn-based games can `beginSettle()` and wait until the grid calms (or times out).

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
├── index.ts     # top-level barrel
└── tests/       # vitest suites
```

**Layer discipline** (mirrors `aicraft-engine`): the entire v1 library is the *deterministic core* — pure functions, no DOM, no `Math.random`, no `Date.now`, no side effects. This keeps it fast to test in Node and safe to run headless or in a worker.

## License

MIT
