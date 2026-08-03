# Prompt: build an MVP god game on aicraft-pixel-engine

> Paste the **"Build brief"** section below into your coding agent (or hand it to a
> developer). The rest of this document is context the author needs; the brief is
> the self-contained instruction.

---

## Build brief

Build a minimal but genuinely fun **god game** — a one-screen, circular-planet
terraforming toy in the spirit of *Reus* / *Godfinger* — on top of the
[`aicraft-pixel-engine`](https://www.npmjs.com/package/aicraft-pixel-engine)
falling-sand simulation library. **Single HTML page, no framework, Vite + plain
TypeScript.** Target a playable MVP in one sitting, not a polished product.

### The one-paragraph pitch

You are a god hovering over a small circular planet. The planet is alive:
materials fall toward its center, water pools into oceans, lava erupts and
flows. You sculpt it with a handful of god-powers — raise land, summon rain
clouds, drop forests, ignite fire — and the simulation does the rest. There is
no lose state; the joy is watching a dead rock become a living world. Make it
*feel* good: every action should have immediate, visible, satisfying
consequences.

### Install the engine

```bash
npm install aicraft-pixel-engine
```

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

### Core loop — what the player does

A toolbar of god-powers (left side or top). The player picks one and clicks/drags
on the planet. Each power maps to one or two engine calls. Keep the set tiny and
distinct; six is plenty:

| Power | Effect | Maps to |
|-------|--------|---------|
| **Raise Land** | Drop sand/rock at the cursor; it piles up into hills/mountains under gravity. | `setMaterial(x, y, SAND)` or `ROCK` with a brush radius |
| **Summon Cloud** | Paint a cloud above the surface that rains water and shrinks as it empties. | Spawn a host-tracked cloud; each tick emit `WATER` at its base |
| **Ocean** | Pour water; it flows and levels into seas around the planet. | `setMaterial(x, y, WATER)` |
| **Forest** | Plant wood/vegetation that (with water nearby) spreads or just decorates. | `setMaterial(x, y, WOOD)` |
| **Volcano** | Trigger an eruption: lava fountains from the vent, flows downslope, cools to rock. | Lava placement + a host-side cooling step (see below) |
| **Smite** | Lightning/fire — ignite flammables, scorch terrain. | `setMaterial(x, y, FIRE)` or `explode(x, y, r)` |

### World setup (the part that makes it a *planet*)

This is the engine's sweet spot — copy it directly:

```ts
const SIZE = 240;
const cx = SIZE / 2, cy = SIZE / 2;
const planetR = Math.round(SIZE * 0.3); // ~72 cells

const engine = new PixelEngine({
  width: SIZE,
  height: SIZE,
  seed: 1,
  gravity: new RadialGravity({ centerX: cx, centerY: cy }),
});

// Stamp a rock disc — the planet body everything falls onto.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy <= planetR * planetR) {
      engine.setMaterial(x, y, MaterialType.ROCK);
    }
  }
}
```

Now every `setMaterial` of sand/water/lava anywhere in the void curves inward
and settles on the surface. That single behavior *is* the god-game feel — lean
into it.

### Rendering — you own the canvas

The engine owns the simulation; you own the pixels. Minimal renderer:

```ts
// Palette: index by MaterialType id → packed RGBA.
// Materials[id].color is [r, g, b, a]. Precompute a Uint32Array once.
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

The game loop is a fixed-step `setInterval` (60 Hz) calling `engine.update()`
then `render()`. Mouse → grid cell is a plain scale: `gx = floor((e.clientX -
rect.left) / rect.width * SIZE)`.

### God-powers that need host logic (read this carefully)

The engine is *deliberately minimal* — it provides the cellular-automaton core
and nothing multi-cell. Three of the powers need a tiny bit of host-side code
on top of `engine.update()`. This is by design (see `docs/integration.md` in the
engine repo); don't try to push these into the engine.

1. **Clouds that hover and rain.** The engine has **no buoyancy/pressure term** —
   a gas only ever rises *away* from the gravity center and escapes the grid. So
   a cloud is a **host-tracked visual entity** (a circle you draw on the canvas),
   and each tick you spawn real `WATER` cells at its underside. The water falls
   under `RadialGravity` — genuine rain. Track a water budget per cloud; shrink
   the drawn radius as it depletes; delete when empty. (A reference
   implementation exists at `showcase/helpers/cloud.ts` in the engine repo —
   read it, then write your own.)

2. **Volcano / lava cooling.** The engine only turns lava→rock via the
   lava+water reaction, so on a dry planet lava stays molten forever. You need a
   per-tick cooling step *after* `engine.update()`: scan lava cells, gradually
   reduce a stored temperature, and flip to `ROCK` below a threshold. Store
   temperature in `engine.colorGrid` (a `Uint32Array` the engine swaps with the
   material) so it rides with the flow for free. Tie the yield/stiffness to
   temperature via `engine.stiffnessGrid` so hot lava flows and cold lava locks.
   (Reference: `showcase/helpers/volcano.ts`.)

3. **Forest spread (optional).** The engine has no growth mechanic. If you want
   forests to creep, run a host step that occasionally turns adjacent `GRASS`/
   `EMPTY` near water into `WOOD`. Or skip it — static forests are fine for an MVP.

### MVP scope — what "done" looks like

A single page where, within a few minutes of loading, a player can:
- [ ] See a circular planet with gravity pulling toward its center.
- [ ] Drag to raise mountains out of sand/rock.
- [ ] Summon a cloud and watch rain pool into oceans.
- [ ] Trigger a volcano and watch lava flow and cool into new land.
- [ ] Plant a forest and (optionally) watch it spread.
- [ ] Smite with fire and watch it spread through flammables.
- There is **no UI beyond the toolbar**. No score, no levels, no menus. The
  simulation reacting to the player *is* the game.

### Hard constraints — do NOT

- **Do not add a physics library** (no `planck`/matter.js). The engine has no
  rigid bodies and isn't trying to. Trees, buildings, creatures are pixels, not
  sprites-with-colliders.
- **Do not try to make the engine do pressure or temperature.** Those are
  host-side (above). The engine's job is displacement, gravity, leveling, and
  reactions.
- **Do not build a tile/sprite renderer first.** Get raw material colors on
  screen as fast as possible; the look comes later. A correct loop with ugly
  pixels beats a pretty loop that doesn't simulate.
- **Do not skip `consumeRenderDirtyChunks()` forever** — it's fine to ignore for
  the MVP (full repaint), but know the optimization exists when frame rate
  matters.

### Suggested build order (get something on screen in 15 minutes)

1. Vite + TS scaffold, install the engine, stamp the planet disc, render raw
   grid colors in a `setInterval` loop. **Goal: see a grey disc.**
2. Add mouse→grid + a sand brush; drag to drop sand that piles on the surface.
   **Goal: feel the gravity.**
3. Add the water brush; watch it flow and level into seas. **Goal: the first
   "wow".**
4. Add the cloud power (host entity + rain spawn). **Goal: weather.**
5. Add volcano (lava placement + cooling step). **Goal: geological drama.**
6. Add forest + fire. **Goal: life and destruction.**
7. Polish: nicer colors, brush-size slider, a "clear world" button.

---

## Context for the author (not part of the brief)

### Why this engine, and why this game shape

`aicraft-pixel-engine` is a falling-sand cellular automaton with a pluggable
gravity seam. Its `RadialGravity` model makes every cell fall toward a planet
center — which is precisely the defining mechanic of circular-planet god games.
The engine already ships a planet demo (`showcase/sections/planet.ts`) that
proves the feel: paint sand in the void and watch it curve inward and settle as
a ring. This MVP is that demo, turned into a toy with goals and weather.

### Engine capabilities you get for free

- **14 materials**: EMPTY, WALL, SAND, WATER, LAVA, ROCK, STEAM, FIRE, SMOKE,
  OIL, ACID, WOOD, FGAS (flammable gas), ICE.
- **Density-driven displacement** — denser sinks through lighter; gases (negative
  density) rise.
- **Reactions** — lava+water→rock+steam, fire spreads via flammability and is
  quenched by water, acid dissolves solids, FGAS ignites and explodes.
- **Explosions** — `engine.explode(x, y, radius)` carves terrain and scatters
  debris; pass `onExplode` in the constructor for a hook.
- **Liquid leveling** — water seeks an equipotential and then goes quiet (0
  swaps/frame), so oceans settle, they don't shimmer forever.
- **Yield strength (`yieldThickness`)** — lava is a Bingham plastic: it flows
  only while thick enough, stopping at a blunt front. This is why lava *looks*
  like lava and not like orange water. Override per-cell with
  `engine.stiffnessGrid` (the lever a temperature system uses).
- **Deterministic** — seeded RNG (`engine.random()`, never `Math.random()`).
  Same seed + same inputs → identical evolution. Useful for replay/testing.
- **Active-chunk optimization** — only 32×32 chunks with activity are simulated.

### Engine limits (the boundaries of the sandbox)

- **No rigid bodies.** Everything is a cell. Creatures would be sprite overlays
  you move yourself, reading the grid for collisions.
- **No pressure.** Water in a sealed pipe won't rise; a U-tube won't equalize.
  Pipes/aqueducts aren't expressible without host help.
- **No temperature field.** Lava stays molten unless the host cools it (above).
- **No buoyancy for gases.** Gases rise away from gravity and exit the grid —
  hence clouds must be host-tracked, not a gas material.
- **No rendering.** You draw every pixel.

### Reference material in the engine repo

If you cloned it, these files are gold (they're not in the npm tarball):

- `showcase/sections/planet.ts` — the full planet demo: world setup, mouse
  painting, the render loop, even a visual spin toggle. Copy its shape.
- `showcase/helpers/cloud.ts` + `cloud.test.ts` — a complete, tested
  rain-cloud implementation. The cleanest reference for the Summon Cloud power.
- `showcase/helpers/volcano.ts` — a full eruption system (conduit, plume,
  cooling, tephra). Heavy, but shows exactly how to host-side temperature.
- `docs/integration.md` — the authoritative guide to the host/engine boundary.
  Read the section on yield strength and `stiffnessGrid` before building the
  volcano.

### Stretch goals (only after the MVP is fun)

- **Day/night** — just a canvas tint overlay; costs nothing, adds mood.
- **Population** — simple sprites that walk on the surface and need water +
  food. Read the grid to find walkable ground.
- **Challenges** — "create an ocean of ≥N water cells", "grow a forest of ≥N
  trees", with a counter.
- **Biomes** — tint rock by depth, sand by moisture, etc., in your renderer.
- **Save/load** — `grid` is a `Uint8Array`; serialize to base64 in
  `localStorage`.
