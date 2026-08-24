# God Game — a circular-planet terraforming toy on `aicraft-pixel-engine@0.1.2`

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

**This is NOT a tech demo.** The simulation reacting to the player *is* the
game. There is no UI beyond the toolbar — no score, no levels, no menus.

**Target a playable MVP in one sitting, not a polished product.**

**Non-negotiable: build the entire game on top of `aicraft-pixel-engine@0.1.2`.**
Do not add a physics library, hand-roll temperature, growth, or pressure, or
write your own falling-sand rules — those are all in the engine. See §9.2 for
the forbidden-pattern checks.

---

## 1. Tech Stack & Install

```bash
npm create vite@latest god-game -- --template vanilla-ts
cd god-game
npm install --save-exact aicraft-pixel-engine@0.1.2
```

(`--save-exact` matters: a plain `npm install pkg@0.1.2` writes `"^0.1.2"` to
package.json, and the brief targets the `0.1.2` API exactly — a version, not
a range.)

- **TypeScript**, strict. **Vite** dev server + build. Single `<canvas>` in
  `index.html`.
- **`aicraft-pixel-engine` is your only runtime dependency.** Import from the
  **root barrel only** — the published package exposes a single `.` entry:
  ```ts
  // The entire public API — all from the package root.
  import {
    PixelEngine,
    FlatGravity,
    RadialGravity,
    MaterialType,
    Materials,
    materialDefs,
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
- **Fixed-step loop.** A 60 Hz `setInterval` calling `engine.update()` then
  `render()`. One simulation step per tick — the engine already decouples
  simulation cost from frame cost internally (active-chunk optimization), so
  there is nothing to gain and determinism to lose by variable-stepping.
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
| Volcano | `addPressureSource({...})` (+ `removePressureSource`, `getPressureSourceState`) — native conduit routing, ballistic ejecta, `TEPHRA` fragmentation, freezing (§8.2) |
| Lightning smite | Host-drawn one-frame bolt + `setMaterial(x, y, FIRE)` + `explode(x, y, r)` (§8.3) |
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
| **Volcano** | Open a magma vent: lava is pressure-fed up a conduit, ejects from the summit, flows downslope, and cools to rock. Ejecta fragments into tephra and builds a cone. | `engine.addPressureSource(...)` — the engine handles eruption, flow, cooling, and cone |
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

### 8.2 Volcano (pure engine — copy this)

A single `addPressureSource({...})` call opens a magma vent. The engine
pressure-routes lava up a connected conduit, ejects it from the first open
outlet (with ballistic velocity + a lateral spread so ejecta fans across the
flanks), fragments airborne cells into `TEPHRA` as they cool (which builds the
cone), and freezes grounded lava to `ROCK` once it cools past its threshold. If
the vent seals, configure `fracture` so pressure builds and the cap pops in a
visible seal-then-reopen cycle.

```ts
// A vent at the planet surface, magma chamber below it. cx/cy are the planet
// center; angle points from center to the vent.
const ventX = Math.round(cx + Math.cos(angle) * planetR);
const ventY = Math.round(cy + Math.sin(angle) * planetR);

engine.addPressureSource({
  x: ventX,
  y: ventY,
  material: MaterialType.LAVA,
  rate: 1.5,                 // lava cells accrued per frame
  pressureRate: 1,           // head accrued per frame while blocked
  maxPressure: 18,           // how hard it can eventually push
  maxPending: 40,            // cap on backlog (bounds the post-unblock surge)
  outletVelocityEfficiency: 0.7,  // fraction of surplus head → launch speed
  outletLateralSpread: 0.25,       // ±half-angle of the jet (tangent form)
  temperature: 1.0,          // born at full melt; cools from there
  // Keep the eruption on the vent axis so summit spread doesn't become extra vents:
  ventAnchor: { cx, cy, angle, corridorRadius: 6 },
  // Seal-then-pop: pressure accrues while blocked, then fractures the cap.
  fracture: { minSealedFrames: 24, pressureRate: 1, maxPressure: 18 },
});
```

Remove it with `engine.removePressureSource(id)` (the id `addPressureSource`
returned) to end the eruption. The state of a live source — accrued volume and
available pressure — is readable via `getPressureSourceState(id)`.

**Forest** and **Ocean** are one-liners by comparison:

- **Forest.** `setMaterial(x, y, SEED)` is all you need — the seed falls,
  germinates into a growing tip on contact with `SAND`/`GRASS`, and grows into a
  tree (trunk → branches → canopy → leaves) with its own genome. `GRASS` placed
  near water spreads outward on its own to a bounded radius. For a guaranteed
  instant tree at a spot, use `engine.plant(x, y, TREE_TIP, { energy: 12 })`.
- **Ocean.** `setMaterial(x, y, WATER)` — it flows, levels, and (with heat on)
  freezes near the poles / melts near lava, all natively.

### 8.3 Smiting with lightning (copy this)

Lightning is pure presentation on top of two engine calls — the strike itself is
a one-frame jagged line you draw from the top of the canvas to the cursor, then
the engine takes over: a `FIRE` cell ignites at the impact and spreads through
anything flammable, and an `explode()` carves a small scorch. The drama is the
flash and the ignition; the engine does the consequences.

```ts
// A live bolt lasts exactly one rendered frame, then clears.
let bolt: { points: { x: number; y: number }[] } | null = null;

function smite(engine: any, gx: number, gy: number, ctx: CanvasRenderingContext2D) {
  // 1. The visual: a jagged polyline from the canvas top to the strike point.
  //    Midpoint-displacement lightning — a few segments of randomized offset.
  bolt = makeBolt(gx, gy);                 // see below
  // 2. The ignition + scorch, at the actual grid cell under the cursor.
  engine.setMaterial(gx, gy, MaterialType.FIRE);
  engine.explode(gx, gy, 3, 4);            // small crater, light debris
}

// Draw `bolt` in render() right after putImageData/drawImage, then set
// bolt = null so it flashes for exactly one frame. White core + pale-blue glow
// reads instantly as lightning against the planet.

function makeBolt(gx: number, gy: number) {
  const points = [{ x: gx, y: 0 }];        // top of the grid
  let y = 0;
  while (y < gy) {
    y += 4 + Math.floor(Math.random() * 6); // step down 4–9 cells
    const xJitter = (Math.random() - 0.5) * 12;
    points.push({ x: gx + xJitter, y });    // points are in GRID space —
  }                                         // apply the camera in render()
  points.push({ x: gx, y: gy });            // land exactly on the cursor
  return { points };
}
```

Keep the bolt one-frame — a strike is an event, not a state. `Math.random()` is
fine *for the visual only* (per §2); the grid writes go through the engine.

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
- **No hand-rolled temperature, growth, or pressure.** All three are native
  engine features. Turn them on with `enableHeat` / the growth rules /
  `addPressureSource` and let the engine do it.
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
7. Open a volcano with `addPressureSource`. **Goal: a fountaining, cone-building eruption.**
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
