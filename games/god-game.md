# God Game — a circular-planet terraforming toy on `aicraft-pixel-engine@0.2.0`

> Paste this entire document to a coding agent (Claude / Cursor / etc.). It is a complete, self-contained build brief: concept, engine wiring, rendering discipline, god-power specs, acceptance criteria, and build order. The agent should produce a single runnable Vite + plain-TypeScript browser game that imports everything from `aicraft-pixel-engine` (the npm package) and writes **no** re-implementations of what the engine already provides.

---

## 0. What You Are Building

**God Game** — a minimal but genuinely fun one-screen, circular-planet
terraforming toy in the spirit of *Reus* / *Godfinger*, built on the
[`aicraft-pixel-engine`](https://www.npmjs.com/package/aicraft-pixel-engine)
falling-sand simulation library.

You are a god hovering over a small circular planet. The planet is alive:
materials fall toward its center, water pools into oceans, lava erupts and
flows, forests seed themselves and grow. You sculpt it with a handful of
god-powers — raise land, summon rain clouds, drop forests, ignite a volcano —
and the simulation does the rest. There is no lose state; the joy is watching a
dead rock become a living world. Make it *feel* good: every action should have
immediate, visible, satisfying consequences.

**This is NOT a tech demo, but it is a toy, not a product.** The simulation
reacting to the player *is* the game. The only chrome is the toolbar, a
footer line (the live census + the selected power's description + controls
hint), and milestone toasts — no score screen, no levels, no menus.

**Target a playable MVP in one sitting, not a polished product.**

**Non-negotiable: build the entire game on top of `aicraft-pixel-engine@0.2.0`.**
Do not add a physics library, hand-roll temperature, growth, or pressure, or
write your own falling-sand rules — those are all in the engine. See §9.2 for
the forbidden-pattern checks.

---

## 1. Tech Stack & Install

```bash
npm create vite@latest god-game -- --template vanilla-ts
cd god-game
npm install --save-exact aicraft-pixel-engine@0.2.0
```

(`--save-exact` matters: a plain `npm install pkg@0.2.0` writes `"^0.2.0"` to
package.json, and the brief targets the `0.2.0` API exactly — a version, not
a range.)

- **TypeScript**, strict. **Vite** dev server + build. Single `<canvas>` in
  `index.html`.
- **`aicraft-pixel-engine` is your only *required* runtime dependency** (the
  optional slime rig in §8.5 adds `aicraft-engine`). Import from the
  **root barrel only** — the published package exposes a single `.` entry:
  ```ts
  // The public API — all from the package root.
  import {
    PixelEngine,
    FlatGravity,
    RadialGravity,
    MaterialType,
    Materials,
    materialDefs,
    // The volcano subsystem (0.2.0): the tested eruption, as library calls.
    volcanoGeometryFor, stampVolcano, createVolcanoState, buildVolcanoOpts,
    stepVolcanoFrame, makeRng, DEFAULT_VOLCANO_INPUTS,
    type VolcanoConfig, type VolcanoState, type VolcanoStepOptions, type VolcanoRuntime,
  } from 'aicraft-pixel-engine';
  ```
  (Never deep-import subpaths like `aicraft-pixel-engine/src/sand`; the `exports`
  map does not publish them.)

---

## 2. Determinism & Discipline Rules (enforced by the engine — follow them)

- **No `Math.random()` for anything that touches the engine grid.** The engine
  is deterministic: same seed + same inputs → identical grid evolution, which is
  what makes replay and regression-testing possible. Use `engine.random()` (the
  seeded mulberry32) for every decision that writes a cell. `Math.random()` is
  OK **only** for purely decorative visuals that never feed back into the grid
  (e.g. the lightning bolt's jitter, §8.3).
- **No `Date.now()` in the sim.** Time is frame count; the loop drives
  everything.
- **Fixed-step loop.** A 60 Hz timer calling `engine.update()` then `render()`,
  one simulation step per tick — the engine already decouples simulation cost
  from frame cost internally (active-chunk optimization), so there is nothing
  to gain and determinism to lose by variable-stepping. **Beware timer
  throttling:** occluded/background tabs throttle `setInterval` to ~1 Hz, which
  crawls a naive tick-per-interval loop 60× (measured in the wild). Drive the
  fixed steps from a wall-clock accumulator (`performance.now()` delta, clamped
  catch-up of ~100 ms) so every step is exactly 1/60 s of sim time regardless
  of how the browser starves the timer.
- **The camera never touches the engine.** Zoom/pan is a `ctx` transform in
  `render()`; mouse input inverts the same transform to recover the grid cell
  (§6).

---

## 3. Architecture — Engine Module → Game System Map

| Game system | Engine API |
|---|---|
| Circular-planet gravity | `RadialGravity({ centerX, centerY })` via the `gravity` option |
| Planet body stamping | `setMaterial(x, y, ROCK)` inside `beginBulk()` / `endBulk()` |
| Climate & thermodynamics | `enableHeat: true` + `ambientTemperature` — native conduction, radiation, phase change (§4) |
| Ocean | `setMaterial(x, y, WATER)` — flows, levels into seas, freezes/melts with the climate |
| Rain clouds | Host-tracked entity + `setMaterial(x, y, WATER)` per tick — **the one power that needs host logic** (§8.1) |
| Forest | `setMaterial(x, y, SEED)` + native growth rules; `plant(x, y, TREE_TIP, { energy })` for an instant tree |
| Volcano | The library subsystem: `volcanoGeometryFor` → `stampVolcano` → `stepVolcanoFrame` (+ `createVolcanoState`, `buildVolcanoOpts`, `makeRng`) — the tested cone-building eruption (§8.2) |
| Lightning smite | Host-drawn arcing bolt + `explode(x, y, r)` (which owns the fire core) (§8.3) |
| Game feel | Census HUD (`engine.grid` scan, 1/s), milestone toasts, day/night tint (§8.4) |
| Rendering | `grid`, `colorGrid`, `consumeRenderDirtyChunks()`, `CHUNK_SIZE` (§5, §7) |
| Reproducibility | `engine.random()` — seeded; never `Math.random` for grid decisions |

---

## 4. World Setup (the part that makes it a *planet*)

This is the engine's sweet spot — copy it directly. The only difference from a
flat world is the gravity model and the heat/climate dials:

```ts
const SIZE = 640;
const cx = SIZE / 2, cy = SIZE / 2;
const planetR = Math.round(SIZE * 0.32); // ~205 cells

const engine = new PixelEngine({
  width: SIZE,
  height: SIZE,
  seed: 1,
  gravity: new RadialGravity({ centerX: cx, centerY: cy }),
  // Native temperature field — drives lava cooling, water freezing, ice melt,
  // steam condensation, and the temperature-gated growth rules. Off by default.
  enableHeat: true,
  // The climate dial. 0.12 ≈ a temperate world (oceans stay liquid, lava cools
  // over a few seconds). Drop it toward 0 and oceans freeze on their own.
  ambientTemperature: 0.12,
  // Frames between growth ticks. Lower = faster forests. Default 4.
  growthInterval: 4,
  // REQUIRED at this scale for the volcano subsystem (see §8.2). With the
  // defaults the pressure router's visit budget exhausts before any route
  // from a chamber this deep reaches the surface — the eruption cycles
  // through its phases emitting nothing, with no error to debug (measured:
  // above ~700² no cone formed at all; the god-game's 640²/R205 sits just
  // inside the same regime, needing a budget of ~6,400 vs the default 2,048).
  pressureVisitLimit: Math.max(2048, Math.round(2048 * 205 / 66)),
  // Fracture must clear a ~26-cell bore in one eruption; the default 1/frame
  // is too slow and the vent never opens.
  fracturePerFrame: 4,
});

// Stamp a rock disc — the planet body everything falls onto.
// beginBulk()/endBulk() is the fast path for stamping many cells: it skips the
// per-cell wake/dirty/heat bookkeeping and recovers it once for the whole stamp.
engine.beginBulk();
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy <= planetR * planetR) {
      engine.setMaterial(x, y, MaterialType.ROCK);
    }
  }
}
engine.endBulk();
```

Now every `setMaterial` of sand/water/lava anywhere in the void curves inward
and settles on the surface. That single behavior *is* the god-game feel — lean
into it.

---

## 5. Rendering — you own the canvas

The engine owns the simulation; you own the pixels.

**Pin the canvas to the grid, or the planet will look stretched.** The single
most common rendering bug is a canvas whose internal resolution doesn't match
the grid (640×640 cells → a 640×640 backing store), or whose CSS size stretches
it into a non-square box. Both turn the circular planet into an ellipse and
desynchronize the mouse-to-grid mapping. Three rules prevent it:

1. **Set the backing store once, in pixels:** `canvas.width = canvas.height = SIZE`.
   `width`/`height` are the resolution; never let CSS override them. Allocate
   `ImageData` from this same `SIZE`.
2. **Keep the CSS box square and at a whole-number scale** (e.g. `style="width:640px;height:640px"`
   or `width: min(90vw, 90vh)` so it stays square on any screen). Do **not**
   stretch a square canvas to a wide/tall flex child — that is exactly what
   elongates the disc.
3. **Scale via the camera (§6), not CSS.** Zoom/pan is a `ctx` transform on the
   square backing store; the CSS box stays fixed and square.

**Size the canvas box from JavaScript, measured against the space the page
actually gives it** (`min(stage.clientWidth, stage.clientHeight)` on resize),
not from a CSS `vmin`/`vmin-px` formula. A CSS magic-number reserve for the
toolbar/footer breaks the moment the toolbar wraps to a second row at a narrow
window — the exact "canvas covers the buttons" bug — and a JS measurement
cannot drift from the real chrome.

```ts
canvas.width = canvas.height = SIZE;          // backing store = grid (once)
canvas.style.width = canvas.style.height = `${SIZE}px`; // square CSS box, no stretch
```

Minimal renderer:

```ts
// Palette: index by MaterialType id → packed RGBA.
// Materials[id].color is [r, g, b, a]. Precompute a Uint32Array once.
// `Materials` is keyed by MaterialType id, so its length is the material count.
const palette = new Uint32Array(Object.keys(Materials).length);
for (const m of materialDefs) {
  const [r, g, b, a] = m.color;
  palette[m.id] = (a << 24) | (b << 16) | (g << 8) | r; // 0xAABBGGRR
}

// Each frame: write grid → ImageData → canvas.
const img = ctx.createImageData(SIZE, SIZE);
function render() {
  const dirty = engine.consumeRenderDirtyChunks(); // only repaint changed chunks
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // (Optimize later: skip clean chunks using `dirty` + CHUNK_SIZE.)
      const mat = engine.grid[y * SIZE + x];
      img.data.set(
        new Uint8Array([0, 0, 0, 255]), // background
        (y * SIZE + x) * 4,
      );
      if (mat !== MaterialType.EMPTY) {
        const c = palette[mat];
        const o = (y * SIZE + x) * 4;
        img.data[o]     = c & 0xff;
        img.data[o + 1] = (c >> 8) & 0xff;
        img.data[o + 2] = (c >> 16) & 0xff;
        img.data[o + 3] = (c >> 24) & 0xff;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}
```

That full-canvas repaint is fine to ship the MVP with. The optimization — only
repainting chunks the simulation actually changed — is important enough at
640×640 to do up front, because it's also where the single most common rendering
bug lives. See **§7**.

The game loop is a fixed-step `setInterval` (60 Hz) calling `engine.update()`
then `render()`. Mouse → grid cell must go through the **camera** (§6), not a
plain scale.

---

## 6. Camera — zoom and pan (standard mouse controls)

At 640×640 the planet is detailed enough that players want to get close. Add a
2D camera with the controls every map/canvas app uses — no modifiers to
remember:

- **Scroll wheel** — zoom toward the cursor. Clamp zoom in `[1, ~8]`× so you
  can't lose the planet by zooming out past 1× or pixel-peep past ~8×.
- **Drag with the middle mouse button** (or space + left) — pan.
- **Double-click** — reset to the default centered fit.

The camera is just a scale + translate applied in `render()`; it never touches
the engine grid. Because every grid cell maps to a fixed source rectangle,
`ctx.drawImage()` (or `putImageData` into an offscreen canvas, then `drawImage`
scaled) is the clean path — draw the grid once at native resolution and let the
camera transform the blit. Mouse input then has to invert the same transform to
recover the grid cell:

```ts
// Camera state. originX/originY is the grid cell currently at the canvas
// top-left; zoom is pixels-per-cell.
const camera = { originX: 0, originY: 0, zoom: 1 };

// Screen → grid cell: invert the camera. `rect` is the canvas bounding rect.
function screenToGrid(e: MouseEvent) {
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  return {
    gx: Math.floor(camera.originX + sx / camera.zoom),
    gy: Math.floor(camera.originY + sy / camera.zoom),
  };
}

// Zoom toward the cursor: keep the cell under the cursor pinned.
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const before = screenToGrid(e);
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  camera.zoom = Math.min(8, Math.max(1, camera.zoom * factor));
  const after = screenToGrid(e);
  camera.originX += before.gx - after.gx;
  camera.originY += before.gy - after.gy;
}, { passive: false });

// Pan: drag updates origin by the delta divided by zoom (cells, not pixels).
// Middle-mouse drag, or space + left drag — pick one and stay consistent.
```

> **⚠️ Pointer-capture hygiene — read this if you call `setPointerCapture`.**
> The natural pattern (capture on `pointerdown`, stop painting/panning on the
> canvas's `pointerup`) hangs when a pointer stream ends without a clean
> `pointerup` on the captured element — synthetic/automated drags, alt-tab
> mid-drag, some touch drivers. The canvas then keeps capture forever: the
> brush keeps pouring at the last cell and every later click (toolbar
> included) is swallowed. This was observed in the wild during the reference
> build. Harden it: also stop on **window-level** `pointerup`, `pointercancel`,
> and `blur`, and call `releasePointerCapture(id)` (in a `try`/`catch`) when
> you stop.

Brush radii and cloud placement use grid coordinates, so they automatically scale
correctly with zoom without extra work.

> **Resolution note.** 640×640 is 16× the cells of a 160×160 demo grid. A naive
> full-canvas repaint every frame still runs, but once the world is busy the
> proper move is to honour `consumeRenderDirtyChunks()`: only the 32×32 chunks
> it flags need repainting, and the rest of the canvas keeps its last frame.
> `update()` itself already skips inactive chunks, so simulation cost stays
> bounded to where things are actually happening.

---

## 7. Repainting dirty chunks (do this — and read the `putImageData` warning)

`engine.consumeRenderDirtyChunks()` returns a `Uint8Array` with one byte per
32×32 chunk; a non-zero byte means that chunk's pixels changed this frame and
need repainting. The **first call after construction (or `clear()`) reports
every chunk dirty** — the engine hands you your initial full paint for free,
so the loop below is all you need; there is no separate boot-paint path. The
structure is an offscreen canvas at grid resolution that you write into and
then blit through the camera:

```ts
const CHUNK = engine.CHUNK_SIZE;          // 32
const chunksPerRow = engine.width / CHUNK;
const gridCanvas = document.createElement('canvas');
gridCanvas.width = engine.width;
gridCanvas.height = engine.height;
const gctx = gridCanvas.getContext('2d')!;
const img = gctx.createImageData(engine.width, engine.height);

// Repaint one 32×32 chunk whose origin is (x0, y0), writing its pixels into
// `img` at offset (x0, y0), then blitting JUST that region to gridCanvas.
function paintChunk(x0: number, y0: number) {
  for (let y = y0; y < y0 + CHUNK; y++) {
    for (let x = x0; x < x0 + CHUNK; x++) {
      const o = (y * engine.width + x) * 4;
      const mat = engine.grid[y * engine.width + x];
      if (mat === MaterialType.EMPTY) { /* background colour into img[o..o+3] */ }
      else { /* palette[mat] unpacked into img[o..o+3] */ }
    }
  }
  // ⚠️ The source dirty-offset is (0,0), NOT (x0,y0). See warning below.
  gctx.putImageData(img, 0, 0, x0, y0, CHUNK, CHUNK);
}

// In the game loop, after engine.update():
const dirty = engine.consumeRenderDirtyChunks();
for (let i = 0; i < dirty.length; i++) {
  if (!dirty[i]) continue;
  const cx = i % chunksPerRow;
  const cy = (i / chunksPerRow) | 0;
  paintChunk(cx * CHUNK, cy * CHUNK);
}
// Then blit gridCanvas through the camera with ctx.drawImage(gridCanvas, 0, 0)
// under the camera transform — see §6.
```

> **⚠️ `putImageData` argument trap — read this.** This is the #1 rendering bug
> in engine-built games, and it renders the planet *invisible* while the grid
> data is perfectly correct, which makes it maddening to debug.
>
> `putImageData(imageData, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH)` — the
> `dirtyX`/`dirtyY` parameters are an offset **into the source `imageData`**,
> *not* a destination coordinate. When you write a chunk's pixels into `img` at
> offset `(x0, y0)`, the correct source offset to read them back from is `0, 0`:
>
> ```ts
> gctx.putImageData(img, 0, 0, x0, y0, CHUNK, CHUNK);  // ✅ correct
> gctx.putImageData(img, x0, y0, x0, y0, CHUNK, CHUNK); // ❌ reads img from the
>                                                       //    wrong offset; only
>                                                       //    chunk (0,0) works
> ```
>
> With the wrong call, chunk `(0,0)` happens to render fine (because `x0=y0=0`
> makes the source offset correct by accident) and **every other chunk shows
> nothing or garbage.** If your planet is stamped but invisible and only a
> fragment appears in the top-left corner, this is it.

---

## 8. God-Powers

A toolbar of god-powers (left side or top). The player picks one and clicks/drags
on the planet. Each power maps to one or two engine calls. Keep the set tiny and
distinct; six is plenty:

| Power | Effect | Maps to |
|-------|--------|---------|
| **Raise Land** | Drop sand/rock at the cursor; it piles up into hills/mountains under gravity. | `setMaterial(x, y, SAND)` or `ROCK` with a brush radius |
| **Summon Cloud** | Paint a cloud above the surface that rains water and shrinks as it empties. | Spawn a host-tracked cloud; each tick emit `WATER` at its base |
| **Ocean** | Pour water; it flows and levels into seas around the planet. | `setMaterial(x, y, WATER)` |
| **Forest** | Scatter `SEED` that falls, germinates on soil, and grows into a tree. `GRASS` creeps outward from water on its own. | `engine.plant(...)` / `setMaterial(x, y, SEED)` |
| **Volcano** | Open a magma vent: lava is pressure-fed up a conduit, ejects from the summit, flows downslope, and cools to rock. Ejecta fragments into tephra and builds a cone — then, once cooled, the ash greens over. | `stampVolcano` + `stepVolcanoFrame` (the library's tested eruption subsystem) |
| **Smite** | Lightning bolt strikes the cursor: a jagged flash, an ignition at the impact, and a small scorch. | Host-drawn bolt (one-frame visual) + `setMaterial(x, y, FIRE)` / `engine.explode(x, y, r)` at the strike point |

The engine provides the cellular-automaton core, heat, growth, and pressure —
so most powers are a single call. **Only one** power still needs host code,
because of a deliberate engine boundary (§8.1).

### 8.1 Clouds that hover and rain (the one host-logic power)

The engine's heat field has **no buoyancy term** — a gas only ever rises *away*
from the gravity center and escapes the grid. So a cloud is a **host-tracked
visual entity** (a circle you draw on the canvas), and each tick you spawn real
`WATER` cells at its underside. The water falls under `RadialGravity` — genuine
rain. Track a water budget per cloud, shrink the drawn radius as it depletes,
and drop it when empty.

This is small enough to inline in full — a cloud is just a tracked point with
a water budget, and a per-tick step that spends some of it as real `WATER`
cells. The engine does the rest (the rain falls under gravity, pools, levels):

```ts
import { MaterialType } from 'aicraft-pixel-engine';

interface Cloud {
  x: number; y: number;          // center, grid cells
  radius: number;                // current visible radius, shrinks with water
  initialRadius: number;
  water: number;                 // remaining budget; 0 = exhausted
  initialWater: number;
}

const WATER_PER_CELL = 60;       // budget per cell of initial radius
const RAIN_OFFSET = 0.7;         // how far below center rain spawns (× radius)

// Place a cloud only in the void above the surface; null inside the planet
// disc or off the grid. Clamp radius so it never draws past the grid edge.
function placeCloud(
  cx: number, cy: number, planetR: number, size: number,
  x: number, y: number, radius = 7,
): Cloud | null {
  const dx = x - cx, dy = y - cy;
  if (dx * dx + dy * dy <= planetR * planetR) return null; // inside planet
  if (x < 0 || x >= size || y < 0 || y >= size) return null; // off grid
  const maxR = Math.max(1, Math.min(x, size - 1 - x, y, size - 1 - y, radius));
  const initialWater = maxR * WATER_PER_CELL;
  return { x, y, radius: maxR, initialRadius: maxR, water: initialWater, initialWater };
}

// Advance one cloud one tick, before engine.update() so fresh rain moves same
// frame. Spends rain as WATER cells jittered across the underside; only writes
// into EMPTY so rain never carves into terrain. Radius tracks the water left.
function stepCloud(engine: any, cloud: Cloud, rainPerTick: number, rng: () => number): void {
  if (cloud.water <= 0) { cloud.radius = 0; return; }
  const spend = Math.min(rainPerTick, cloud.water);
  const halfWidth = Math.max(0.5, cloud.initialRadius * 0.8);
  const yOffset = cloud.initialRadius * RAIN_OFFSET;
  for (let i = 0; i < spend; i++) {
    const t = rng() * 2 - 1;                                   // [-1, 1]
    const rx = Math.round(cloud.x + t * halfWidth);
    const ry = Math.round(cloud.y + yOffset + rng() * 2);      // small jitter
    if (engine.getMaterial(rx, ry) === MaterialType.EMPTY) {   // out-of-bounds reads as WALL
      engine.setMaterial(rx, ry, MaterialType.WATER);
    }
  }
  cloud.water -= spend;
  cloud.radius = cloud.water > 0 ? cloud.initialRadius * (cloud.water / cloud.initialWater) : 0;
}

// Render: draw each cloud as a soft circle on the canvas overlay (alpha
// fading with remaining water). Call removeDead(clouds) each frame to drop
// spent clouds, and throttle placement on drag to ~2*radius cells apart so a
// pointer sweep leaves distinct clouds, not a solid white mass.
```

(Pass `engine.random` as `rng` — cloud rain spends grid cells, so it belongs on
the seeded stream per §2.)

### 8.2 Volcano (library calls — copy this)

**0.2.0 shipped the eruption as a tested subsystem.** `stampVolcano` /
`stepVolcanoFrame` (exported from the package root) compose pressure sources,
the heat field, fragmentation and the velocity field into the one arrangement
of them that is hard to derive from scratch: an eruption that clears its
throat with tephra, fountains ballistically, extrudes flows, and stacks a cone
that stops growing. The engine repo guards it with a silhouette contract
(cone **taper**, not just magnitude — chimneys-on-skirts fail it) at five vent
angles. Using the library means inheriting all of that. Do NOT re-derive the
eruption by hand: four successive hand-written recipes failed the acceptance
test before the library one passed.

```ts
// --- once, at boot ---
// headroom = free cells above the surface (SIZE/2 - PLANET_R = 115 here). It
// sizes the cap ladder: capMax = min(headroom - 2, scaled-by-radius); a value
// smaller than the world's actual sky stunts the cone to that height and
// collapses the ladder (capStart == capMax).
const HEADROOM = 320 - PLANET_R;
const volcanoGeom = volcanoGeometryFor(CX, CY, PLANET_R, HEADROOM);
let volcanoState = createVolcanoState();
const volcanoRng = makeRng(seed);          // dedicated stream: the eruption's
                                           // randomness never perturbs the sim's

// --- on Volcano click (the angle is the click direction from the centre) ---
const cfg = volcanoGeometryFor(CX, CY, PLANET_R, HEADROOM, Math.atan2(gy - CY, gx - CX)).cfg;
if (!volcanoStarted) {
  stampVolcano(engine, cfg);               // chamber + conduit + vent
  volcanoStarted = true;
} else {
  capHeight = Math.min(capHeight + volcanoGeom.capStep, volcanoGeom.capMax);
  // ^ re-eruption grows the cap, so the cone builds in stages
}
volcanoState = createVolcanoState();        // REQUIRED: restart the cycle on its
                                            // explosive phase. Without this the
                                            // completed state machine sits in
                                            // repose forever and every later
                                            // click is 150 frames of nothing.
erupting = true;

// --- every tick, unconditionally (the dormant branch matters too — see below).
// Rebuild opts fresh each tick so the live cap applies:
const volcanoOpts = buildVolcanoOpts(cfg, {
  ...DEFAULT_VOLCANO_INPUTS,               // the shipped, acceptance-tested tuning
  maxHeight: capHeight,                    // the operative cap; capStart for cycle 1
});
const runtime: VolcanoRuntime = { erupting, capHeight };
stepVolcanoFrame(engine, cfg, volcanoState, volcanoRng, volcanoOpts, runtime);
erupting = runtime.erupting;               // false once the cycle completes
```

Four contracts to respect — each one is a measured failure mode:

- **`stepVolcanoFrame` runs `engine.update()` itself, and it must be called
  EVERY tick, erupting or not.** Do not also call `engine.update()` in the
  same tick (double-stepping breaks phases and caps). And do not stop calling
  it when the eruption ends: the dormant branch recharges the reservoir (an
  unfed chamber sets solid in under 200 frames) and keeps `syncFromHeat`
  running so cooling lava renders as dark basalt through `colorGrid` instead
  of falling back to flat bedrock grey.
- **The volcano owns its RNG.** Pass `makeRng(seed)`, never `engine.random` —
  the eruption must not perturb the simulation's shared stream, and
  re-seeding per world makes replays identical.
- **The cap is `maxHeight` in the opts, not the runtime field.**
  `VolcanoRuntime.capHeight` is advisory; the eruption stops growing at
  `opts.pressure.maxHeight`, which `buildVolcanoOpts` derives from
  `inputs.maxHeight`. Start at `volcanoGeom.capStart`, raise by `capStep` on
  each re-eruption, capped at `capMax`.
- **`volcanoGeometryFor` is positional** — `(centerX, centerY, planetRadius,
  headroom, ventAngle?)`, where headroom is the free sky above the surface
  (`SIZE/2 − planetR`) — and returns `{ cfg, capStart, capStep, capMax }`;
  pass `geom.cfg` (the `VolcanoConfig`) to the engine calls, and keep the
  wrapper for the cap ladder. §4's `pressureVisitLimit`/`fracturePerFrame`
  are load-bearing at 640² — with defaults, this code emits nothing.

**Fertile ash is the payoff.** The cone it builds is `TEPHRA`, which counts as
soil for both life rules once cooled: rain on a settled cone and grass
colonizes the flanks (§8 Forest). Destroy-then-garden is the point of the
power. And render through `engine.colorGrid`: the subsystem writes per-cell
incandescence and cooled-rock tints there (0 = fall back to the palette) — a
renderer that ignores it shows a flat grey cone where the showcase glows.

### 8.3 Smiting with lightning (copy this)

Lightning is pure presentation on top of one engine call — the player touches
the sky and the bolt **arcs down to the ground below the touch** ("down" on a
radial-gravity world is toward the planet centre), then `explode()` carves a
small crater and ignites its own fire core at the strike. March radially inward
from the touch point to the first solid cell; treat `WATER` as transparent so a
strike through rain or onto an ocean grounds out on the floor. A touch already
on terrain backs off outward to open sky first so the arc is always visible.
The drama is the flash and the ignition; the engine does the consequences.

```ts
function smite(engine: any, gx: number, gy: number) {
  const dxC = cx - gx, dyC = cy - gy;
  const dist = Math.hypot(dxC, dyC) || 1;
  const ux = dxC / dist, uy = dyC / dist;      // inward ("down") unit vector

  // Bolt origin: the touch point — or, on terrain, back off outward to the
  // first EMPTY cell (up to 64) so the arc has sky to travel through.
  let fx = gx, fy = gy;
  if (engine.getMaterial(gx, gy) !== MaterialType.EMPTY) {
    for (let t = 1; t <= 64; t++) {
      const x = Math.round(gx - ux * t), y = Math.round(gy - uy * t);
      if (x < 0 || x >= width || y < 0 || y >= height) break;
      if (engine.getMaterial(x, y) === MaterialType.EMPTY) { fx = x; fy = y; break; }
    }
  }

  // Strike point: march inward to the first non-empty, non-water cell.
  let sx = gx, sy = gy;
  for (let t = 0; t <= Math.ceil(dist); t++) {
    const x = Math.round(gx + ux * t), y = Math.round(gy + uy * t);
    const m = engine.getMaterial(x, y);
    if (m === MaterialType.WALL) break;        // out of bounds
    if (m !== MaterialType.EMPTY && m !== MaterialType.WATER) { sx = x; sy = y; break; }
  }

  engine.explode(sx, sy, 3, 4);                // carves the crater + fire core
  return makeBolt(fx, fy, sx, sy);             // jagged polyline, see below
}

// makeBolt(from, to): step along the segment in 4–9 cell increments with
// perpendicular midpoint-displacement jitter. Draw it in render() under the
// camera transform (line widths divided by zoom), fade it over ~8 frames
// rather than a single frame — a 16ms flash is invisible in practice.
```

Keep the bolt short-lived — a strike is an event, not a state. `Math.random()`
is fine *for the visual only* (per §2); the grid writes go through the engine.

---

### 8.4 The game layer: census, milestones, day/night

Three small systems turn the toy into something that reads as a game. All
host-side; none touch the engine beyond reads.

- **World census** (the readable-feedback pillar). Once a second — on wall
  clock, not tick count, or throttled tabs under-report — scan `engine.grid`
  and show the counts: `🌊 12 · 🏔 3.4k · 🌋 210 · 🔥 0 · 🌲 87`. Use the
  engine repo's [`recipes/census.ts`](../recipes/census.ts); it also exposes
  `forestGrown` (WOOD/LEAF/TREE_TIP, no seeds), because gating anything on
  "a forest exists" must not count a handful of scattered seeds.
- **Milestone toasts.** One-time achievements for shaping the world (first
  ocean, first forest, the land rises, the world erupts, wrath from above),
  toasted top-right. Two measured lessons: gate them on the *grown* census
  (a seed scatter is not a forest), and fire **event-driven milestones from
  the per-frame event detection, not the 1s census** — a strike's visual
  lasts 8 frames, so a census-gated "first smite" fires on ~13% of strikes.
- **Day/night.** A ~90-second cycle as a canvas tint overlay (device-space
  fill after the camera blit — a grid-space tint slides off the sky when you
  pan). Purely presentational; do not modulate engine state for it.

### 8.5 Population: surface walkers

 Creatures are what make it feel alive. The pattern that works on a
 radial-gravity world is **polar-coordinate surface walkers**: each creature
 lives at `(angle, radius)` in the planet's frame, samples the terrain along
 its angle (`WALKABLE`/`LIQUID`/`DEADLY` material sets decide footing,
 bobbing, and death), and moves by advancing its angle — the surface comes to
 you, so no physics is needed. React to the god's acts: a lightning strike
 nearby makes them freeze and stare at the point (then flee if it continues);
 a live volcano keeps them scared and at a distance. Fear is an event-driven
 scalar with decay — read the strike/vent state your power code already has.

 The reference build's creature art is a ~2,200-line procedural rig (gazing
 eye, blinking, mouth morphs, antenna physics) shipped as a copy-in asset:
 [`games/assets/slime-rig/`](./assets/slime-rig/). It builds on the sibling
 package's animation primitives, so using it means one extra dependency:
 `npm install --save-exact aicraft-engine` (its `solveLimb`,
 `advanceSpringChain` and palette helpers — see the rig's README). Compose
 the rig; do not reinvent it. A minimal slime (body + eye + hop) satisfies
 the acceptance criteria; the rig is polish.

---

## 9. Acceptance Criteria

### 9.1 What "done" looks like

A single page where, within a few minutes of loading, a player can:
- [ ] See a circular planet with gravity pulling toward its center.
- [ ] Zoom with the scroll wheel and pan by dragging — get close to the surface.
- [ ] Drag to raise mountains out of sand/rock.
- [ ] Summon a cloud and watch rain pool into oceans.
- [ ] Open a volcano and watch lava fountain, flow, fragment into a tephra cone, and cool into new land.
- [ ] Scatter seeds and watch forests grow (and grass creep outward from water).
- [ ] Smite with lightning and watch the bolt flash, the impact ignite, and fire spread through flammables.
- There is **no UI beyond the toolbar**. No score, no levels, no menus. The
  simulation reacting to the player *is* the game.

### 9.2 Forbidden patterns — do NOT

Static checks (grep the game source) must find:

- **No physics library** (no `planck`/matter.js). The engine has no rigid bodies
  and isn't trying to. Trees, buildings, creatures are pixels, not
  sprites-with-colliders.
- **No hand-rolled temperature, growth, pressure, or eruptions.** All native
  engine features: `enableHeat`, the growth rules, `addPressureSource`, and
  the volcano subsystem. Do not re-derive the eruption by hand — four
  hand-written recipes failed the volcano acceptance test before the library
  one passed (§8.2).
- **No tile/sprite renderer first.** Get raw material colors on screen as fast
  as possible; the look comes later. A correct loop with ugly pixels beats a
  pretty loop that doesn't simulate.
- **No permanent skip of `consumeRenderDirtyChunks()`** — it's fine to ignore
  for the MVP (full repaint), but at 640×640 frame rate will eventually want it.
- **No CSS-stretched canvas.** Set `canvas.width = canvas.height = SIZE` and
  keep the CSS box square (§5). A stretched backing store turns the circular
  planet into an ellipse and breaks the mouse-to-grid mapping.
- **No `Math.random` / `Date.now` feeding the grid** — §2 applies.

---

## 10. Implementation Workflow (get something on screen in 15 minutes)

Build in this order:

1. Vite + TS scaffold, install the engine, stamp the planet disc, render raw
   grid colors in a `setInterval` loop. Use the dirty-chunk repaint from §7
   (and mind the `putImageData` warning) — a full-canvas
   `putImageData(img, 0, 0)` also works to start. **Goal: see a grey disc.**
2. Add mouse→grid + a sand brush; drag to drop sand that piles on the surface.
   **Goal: feel the gravity.**
3. Add the camera: wheel-zoom toward cursor, middle-drag pan, double-click
   reset. Reroute mouse input through `screenToGrid()`. **Goal: get close.**
4. Add the water brush; watch it flow and level into seas. **Goal: the first
   "wow".**
5. Turn on heat (`enableHeat: true`); drop a `LAVA` cell and watch it cool to
   rock on its own. **Goal: geology without host code.**
6. Add the cloud power (host entity + rain spawn). **Goal: weather.**
7. Wire the library volcano (`stampVolcano` + per-tick `stepVolcanoFrame`, §8.2). **Goal: a fountaining, cone-building eruption.**
8. Scatter `SEED` / `plant()` a tree; watch a forest establish. **Goal: life.**
9. Add lightning smite (host-drawn bolt + `FIRE`/`explode` at the strike).
   **Goal: wrath.**
10. Polish: nicer colors, brush-size slider, a "clear world" button.

---

## 11. Stretch Goals (only after §9 acceptance criteria pass)

- **Day/night** — modulate `ambientTemperature` on a slow cycle; oceans freeze
  at night and thaw at dawn, natively. Add a canvas tint overlay for mood.
- **Population** — simple sprites that walk on the surface and need water +
  food. Read the grid to find walkable ground.
- **Challenges** — "create an ocean of ≥N water cells", "grow a forest of ≥N
  trees", with a counter.
- **Biomes** — tint rock by depth, sand by moisture, etc., in your renderer.
- **Save/load** — `grid` is a `Uint8Array`; serialize to base64 in
  `localStorage`.

---

## 12. Known traps — the pre-flight checklist

Every item below cost a debugging round to learn. Read once before building,
once before declaring done.

1. **`putImageData` dirty offsets are source offsets.** The correct chunk
   repaint is `putImageData(img, 0, 0, x0, y0, CHUNK, CHUNK)` — anything else
   renders every chunk but (0,0) invisible (§7).
2. **The first `consumeRenderDirtyChunks()` reports everything dirty.** No
   boot-paint special case is needed — or allowed to double-paint.
3. **Bulk-stamped lava carries no heat.** If you ever stamp lava by hand,
   `setHeat(1.0)` every stamped cell after `endBulk()`, or the body freezes
   without ever flowing. (The library volcano handles this internally; the
   measured story is in the engine CHANGELOG's 0.2.0 section.)
4. **A pressure source buried in another material is skipped forever.** The
   source cell must be EMPTY or its own material.
5. **Timer throttling.** Occluded tabs throttle `setInterval` to ~1 Hz; drive
   fixed steps from a wall-clock accumulator with a clamped catch-up (§2,
   [`recipes/fixed-tick-clock.ts`](../recipes/fixed-tick-clock.ts)).
6. **Pointer-capture hygiene.** Stop painting/panning on window-level
   `pointerup`/`pointercancel`/`blur` and release the capture, or one broken
   drag wedges all input (§6, [`recipes/radial-camera.ts`](../recipes/radial-camera.ts)).
7. **Size the canvas from JS against the stage**, not a CSS `vmin` formula —
   toolbar wrap breaks the reserve and the canvas covers the buttons (§5).
8. **Never CSS-stretch the backing store** — the planet becomes an ellipse
   and mouse mapping desynchronizes (§5).
9. **Volcano = library calls, and `stepVolcanoFrame` owns `engine.update()`**
   while erupting. Double-stepping breaks phases and caps (§8.2).
10. **Event-driven feedback needs per-frame detection.** Anything gated on a
    1 Hz census misses sub-second events (§8.4).
11. **Grass needs a colonist and adjacency to water** — sprinkle a little
    GRASS with the forest brush, or the meadow never starts; the moisture
    scan reaches an adjacent cell, not one further along (§8).
