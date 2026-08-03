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

**Tuning liquid leveling (`liquidDispersion`).** A liquid only steps sideways when that direction leads to a cell it could descend from within `liquidDispersion` cells along its level axis — this gate is what lets a settled pool go quiet instead of shimmering, and it leaves the `updated` flags clear so the pool can compact. The probe re-derives the movement frame at each step, so under `RadialGravity` it follows the planet surface instead of running off along the tangent it started on. Steady-state cost is zero at any value: once a pool is packed the scan exits at the first cell. Default 16. Trade-off summary:

| `liquidDispersion` | flat leveling | radial (planet) | cost while flowing | cost when settled |
|---|---|---|---|---|
| 2–8 | rough surface (~4 rows) | quietest | lowest | 0 |
| **16 (default)** | good (~2-row residual staircase) | quiet (ocean shell settles dead still) | moderate | 0 |
| 32+ | near-flat (~1 row) | small residual jitter | higher (flowing only) | 0 |

The two gravity models pull in opposite directions here, which is why the default is 16 rather than higher: a flat pool is perfectly still at *any* value, so raising it only buys surface flatness — but on a planet a long probe wraps far enough around the curve to keep finding descents in geometry that no longer matches the source cell, leaving a residual shimmer. If your game is flat-only, 32 is a good choice.

**Liquid levelling.** A liquid cannot displace its own kind, so a contiguous body is rigid except at its free surface — which on its own gives water a sand-like angle of repose (visible as lumpy piles on open floors and planet surfaces). The engine corrects this with a levelling pass that walks each free surface and transfers a cell to the nearest resting place at least one cell lower in gravitational *potential*, a scalar "height" supplied by `GravityModel.potentialAt`. Both shipped gravity models provide it; a custom model that omits it simply opts out and behaves as the engine did before.

Levelling is automatic — there is nothing to configure. It settles to a dead stop (every transfer strictly lowers total potential, so the system provably reaches a fixed point) and costs nothing once settled, because it skips inactive chunks.

Remaining limits, all static rather than shimmering:
- A gentle residual slope of roughly **one cell per 32 cells of span** — about 5 rows across a 300-wide pool. Set by how far the pass looks along the surface.
- **No pressurised flow.** This acts on free surfaces only: water in a sealed pipe will not rise, and a U-tube will not equalise. That needs a full pressure solve.
- **Sub-cell volumes.** A blob too small to cover its span at one cell deep pools into a lens rather than a film — a 9-cell brush blob on a 220-wide planet is 0.4 cells thick spread out, which no rule can render evenly. Use more water for a full shell.

**Yield strength (`yieldThickness`) — liquids that are not water.** Levelling above describes a *Newtonian* liquid: it flows until level however thin the film gets. Lava does not behave that way. It is a Bingham plastic with a real yield strength, so a flow only advances while the driving stress — which scales with its thickness — beats that strength, and it simply stops where it thins out.

A material opts in by setting `yieldThickness` in its `MaterialDef` (lava does; water, oil, and acid do not and are completely unaffected). The engine then refuses sideways and levelling moves for any parcel of that material thinner than the threshold, measured as the contiguous run through the cell along the gravity axis. Falling straight down is never gated, so airborne material still falls normally and only stiffens once it lands.

This is what produces every shape lava is known for: a blunt flow front instead of a feather edge, chilled margins that stall into levees and channel the still-mobile core, and an edifice that can stack up at all. Without it a liquid on a planet has only two states — spreading toward an equipotential shell, or frozen solid — with nothing in between. Measured on a lava-fed planet before the term existed, a cooling rate of 0.02 let the flow wrap 180° around the planet as an orange ocean, while 0.5 froze it within 32° of the vent; a flow that travels a bounded distance downslope and *stops* was not reachable at any cooling rate.

**Per-cell rheology (`stiffnessGrid`).** Yield strength is not really a constant of the material — for lava it climbs by orders of magnitude as the melt cools and crystallizes. `engine.stiffnessGrid` is an optional `Uint8Array` overriding `yieldThickness` per cell (`0` means "use the material's value"). Like `colorGrid` it rides with the material through swaps and levelling transfers, so a stiffened parcel stays stiff as it moves.

A host that tracks temperature writes it each frame — fresh lava mobile, chilled lava locked — which is what makes a flow run while hot and set where it has cooled. A host that does not can ignore the field entirely. Keep the mobile end at **2 or more, never 1**: at 1 the criterion can never be met (a single cell is already one cell thick), so the liquid thins without limit into a half-occupied monolayer that freezes as a checkerboard of specks. See `showcase/helpers/volcano.ts` for a worked example.

**Temperature (`heatGrid`).** An optional `Float32Array` holding a per-cell temperature in `[0, 1]`, off by default. Enable it with `enableHeat: true` at construction, or just call `setHeat` and it allocates itself. Like `stiffnessGrid` it rides with the material through swaps and levelling transfers, so a hot parcel of lava stays hot as it flows.

```ts
const engine = new PixelEngine({ width, height, enableHeat: true, ambientTemperature: 0.1 });
engine.setMaterial(x, y, MaterialType.LAVA); // born at LAVA's spawnTemp of 1.0
engine.setHeat(x, y, 0.6);                   // ...or override it
engine.getHeat(x, y);                        // 0.6
```

Three things differ from the other optional grids, and all three bite if you assume otherwise:

- **Call `setHeat` *after* `setMaterial`, never before.** A material change resets the cell to the new material's `spawnTemp`, so a temperature written first is discarded. Same ordering hazard `colorGrid` has.
- **`0` is a temperature, not "unset".** It means *frozen*. There is no sentinel value, so allocation seeds every cell from its material's `spawnTemp` rather than zero-filling — an O(cells) sweep that `enableHeat` lets you schedule rather than pay partway through a simulation.
- **`ambientTemperature` is the climate dial.** It is the temperature exposed cells exchange toward, and the default (0.1) deliberately sits above water's freezing point and below ice's melting point so nothing transforms on its own. Lower it and oceans freeze.

Materials opt in by setting any thermal field (`spawnTemp`, `conductivity`, `emissivity`, `freezesAt`/`meltsAt`, `heatSource`); `isThermal[mat]` reports the result. EMPTY, OIL, ACID, SMOKE and FGAS set none. `engine.activeThermalChunkCount` is the settle signal for heat — *not* `swapsLastFrame`, since heat moves without swapping anything.

Heat evolves through two mechanisms each frame. **Conduction** moves heat cell-to-cell and is exactly conservative — the coefficient is a property of the edge (`min` of both endpoints' `conductivity`, scaled by a stability cap), so a seam conducts at the same rate whichever side you look from. **Environment exchange** pulls each cell toward `ambientTemperature` in proportion to how many of its faces are open to `EMPTY`, which is what actually cools a surface: conduction alone cannot, since the thing an exposed cell loses heat to has no temperature. A material flagged `heatSource` (FIRE) is held at its temperature rather than skipped — neighbours draw from it at full strength, then it is pinned back.

Heat settles: changes below `HEAT_EPSILON` are discarded so chunks can sleep, and a thermally equilibrated world costs the same as one with heat disabled (measured at 0.0006 ms/frame either way on a 220×220 world). Use `engine.activeThermalChunkCount` to observe it. One consequence worth knowing: a heat source at temperature `T` can never drive a neighbour past `T`, so a phase threshold above the hottest source is unreachable by construction.

> **Status:** phase change (`freezesAt`/`meltsAt`) is defined on materials but not yet acted on, so ice does not melt and lava does not turn to rock on its own yet. The existing contact reactions in `stepLavaOrFire` still handle those instantly. See `docs/plan-temperature.md`.

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
