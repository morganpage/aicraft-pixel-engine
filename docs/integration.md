# Integration

End-to-end wiring guide for using `aicraft-pixel-engine` in a game.

---

## 1. Install

### Option A: Git submodule (recommended for AI Craft sibling games)

Preserves the consumer's zero-runtime-deps invariant and keeps source greppable for AI agents.

```bash
# From your game repo root
git submodule add <aicraft-pixel-engine-git-url> src/lib/aicraft-pixel-engine
git commit -m "Add aicraft-pixel-engine submodule"
```

Then import from a relative path:

```ts
import { PixelEngine } from './lib/aicraft-pixel-engine/src/sand';
import { MaterialType } from './lib/aicraft-pixel-engine/src/materials';
import { FlatGravity, RadialGravity } from './lib/aicraft-pixel-engine/src/gravity';
```

**TypeScript config:** `moduleResolution: "bundler"` + `include: ["src"]` covers the submodule path. No consumer `tsconfig.json` change needed.

**Vite config:** no change needed. Vite resolves relative paths transparently.

**Test config:** if you don't want the submodule's own tests to run in your suite, scope your `vitest.config.ts` `include` (e.g. `['src/**/*.test.ts', '!**/lib/aicraft-pixel-engine/**']`).

### Option B: Vendored copy

```bash
cp -r /path/to/aicraft-pixel-engine/src /path/to/game/src/lib/aicraft-pixel-engine/
```

Add a `README.md` at the copy root noting the canonical upstream so re-syncs are easy.

### Option C: npm package (external consumers)

The library is publishable, but doing so adds a `dependencies` entry to the consumer's `package.json`. Sibling AI Craft games deliberately keep zero `dependencies` as a minimalist invariant; for those, use Option A or B. This option is fine for external consumers.

---

## 2. The mental model

```
[Your Game]  ──setMaterial / explode──▶  [PixelEngine]  ──grid + dirty chunks──▶  [Your Renderer]
                │                              ▲
                └──── gravity model ───────────┘
```

**The `PixelEngine` is the simulation authority.** It owns the material grid, the optional color grid, the active-chunk and render-dirty bookkeeping, and the seeded RNG. You mutate it via `setMaterial`, `swap`, and `explode`; you step it via `update()`.

**Gravity is pluggable.** The engine never assumes "down = +Y". It asks its `GravityModel` which way is down at each cell. `FlatGravity` reproduces classic flat-world behavior; `RadialGravity` points toward a single planet center for circular-world god games.

**The renderer is your job.** Read `engine.grid` (a `Uint8Array` of `MaterialType`), optionally `engine.colorGrid` (a `Uint32Array` of packed RGBA), and `engine.consumeRenderDirtyChunks()` (which 32×32 regions changed since last frame). Draw however you like — Canvas2D, WebGL, whatever.

**Determinism is guaranteed by construction.** Same seed + same sequence of public calls + same gravity model → identical grid evolution over any number of frames. Validated by golden tests. Never call `Math.random()` inside game-affecting logic; use `engine.random()`.

**Tuning liquid leveling (`liquidDispersion`).** A liquid only steps sideways when that direction leads to a cell it could descend from within `liquidDispersion` cells along its level axis — this gate is what lets a settled pool go quiet instead of shimmering, and it leaves the `updated` flags clear so the pool can compact. Higher values level a pool flatter at the cost of a longer per-cell scan *while the liquid is in motion*; once a pool is packed the scan exits at the first cell, so steady-state cost is zero regardless of the value. Default 32. Trade-off summary:

| `liquidDispersion` | leveling (flatness) | cost while flowing | cost when settled |
|---|---|---|---|
| 2–4 | rougher surface | lowest | 0 |
| 16 | good (~2-row residual staircase) | moderate | 0 |
| **32 (default)** | near-flat (~1 row) | higher (flowing only) | 0 |
| 64+ | flat | higher (flowing only) | 0 |

A residual staircase (step width ≈ `liquidDispersion`) remains on a deep pour's surface; it is fully static. Removing it entirely requires a pressure field (a future, larger change).

---

## 3. Minimum viable sandbox

A complete, interactive falling-sand canvas in ~40 lines.

```ts
import { PixelEngine } from './lib/aicraft-pixel-engine/src/sand';
import { MaterialType, Materials } from './lib/aicraft-pixel-engine/src/materials';
import { FlatGravity } from './lib/aicraft-pixel-engine/src/gravity';

const W = 240, H = 160;
const engine = new PixelEngine({ width: W, height: H, seed: 12345, gravity: new FlatGravity() });

// Floor of walls so particles collect
for (let x = 0; x < W; x++) engine.setMaterial(x, H - 1, MaterialType.WALL);

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const ctx = canvas.getContext('2d')!;
const img = ctx.createImageData(W, H);

function render() {
  const dirty = engine.consumeRenderDirtyChunks();
  const data = img.data;
  for (let cy = 0; cy < engine.chunkHeight; cy++) {
    for (let cx = 0; cx < engine.chunkWidth; cx++) {
      if (!dirty[cy * engine.chunkWidth + cx]) continue;
      for (let y = cy * engine.CHUNK_SIZE; y < Math.min(H, (cy + 1) * engine.CHUNK_SIZE); y++) {
        for (let x = cx * engine.CHUNK_SIZE; x < Math.min(W, (cx + 1) * engine.CHUNK_SIZE); x++) {
          const mat = engine.getMaterial(x, y);
          const [r, g, b, a] = Materials[mat].color;
          const o = (y * W + x) * 4;
          data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// Pour sand under the cursor
canvas.addEventListener('pointermove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / rect.width * W);
  const y = Math.floor((e.clientY - rect.top) / rect.height * H);
  engine.setMaterial(x, y, MaterialType.SAND);
});

// Fixed-step loop at 60 Hz
setInterval(() => { engine.update(); render(); }, 1000 / 60);
```

---

## 4. Circular planet (god-game mode)

Swap `FlatGravity` for `RadialGravity` centered on your planet. The same `update()` loop, the same materials, the same rendering — particles now fall toward the planet center.

```ts
import { PixelEngine } from './lib/aicraft-pixel-engine/src/sand';
import { RadialGravity } from './lib/aicraft-pixel-engine/src/gravity';
import { MaterialType } from './lib/aicraft-pixel-engine/src/materials';

const W = 256, H = 256, cx = 128, cy = 128;
const engine = new PixelEngine({
  width: W, height: H, seed: 1,
  gravity: new RadialGravity({ centerX: cx, centerY: cy }),
});

// Stamp a disc planet
const R = 40;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy <= R * R) engine.setMaterial(x, y, MaterialType.ROCK);
  }
}

// Scatter sand and water in orbit; they fall to the nearest surface point
for (let i = 0; i < 2000; i++) {
  const a = (i / 2000) * Math.PI * 2;
  const r = R + 20 + (i % 7);
  engine.setMaterial(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r),
    i % 3 === 0 ? MaterialType.WATER : MaterialType.SAND);
}

engine.update();
```

**Why this works on a square grid:** radial gravity on a square pixel grid is inherently "chunky" at the 8 octant boundaries, but it is stable and deterministic — exactly the technique used by Sandspiel-style planet sims. The frame-alternating scan direction and the per-cell `updated` flag prevent double-processing and left/right bias.

---

## 5. Explosions and destructible terrain

```ts
engine.explode(centerX, centerY, radius, force);
```

`explode` carves a circle: walls/rock within `falloff > 0.7` are cleared, within `> 0.3` are pulverized into colored sand debris and scattered outward, and a fire/smoke core ignites in the inner 40% of the radius. The optional explosion hook (set via engine config) receives the explosion metadata if you want to layer rigid-body impulses on top in a future integration.

---

## 6. Customizing gravity

Implement `GravityModel`:

```ts
import type { GravityModel, Vec2 } from './lib/aicraft-pixel-engine/src/gravity';

// Example: gravity tilts based on an external "wind" vector
class WindGravity implements GravityModel {
  constructor(private wind: Vec2) {}
  gravityAt(_x: number, _y: number): Vec2 {
    // normalize (down + wind)
    const x = this.wind.x, y = 1 + this.wind.y;
    const len = Math.hypot(x, y) || 1;
    return { x: x / len, y: y / len };
  }
}
```

**v1 note:** `PixelEngine` is a displacement-based CA — particles move one cell (or not) per frame, with no per-particle velocity. Gravity *direction* affects motion cleanly; gravity *magnitude* does not, because there is nothing to integrate without injecting probability (which would break determinism). So all v1 models are effectively uniform-magnitude. The `magnitudeAt` field on the interface is reserved for a future velocity-integrated layer.

---

## 7. Synchronization strategy

When `aicraft-pixel-engine` evolves, consumers update via:

- **Submodule:** `git submodule update --remote src/lib/aicraft-pixel-engine && git commit`
- **Vendored:** re-run the copy command and review the diff
- **npm:** `npm update aicraft-pixel-engine`

The library follows semver. Breaking changes to public APIs bump the major version.
