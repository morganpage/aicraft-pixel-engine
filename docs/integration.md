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

**ESM only.** The package is `"type": "module"` with no `require` condition in its `exports` map, so `require('aicraft-pixel-engine')` fails with `ERR_REQUIRE_ESM` on Node. Use `import`, or `await import()` from CommonJS.

**Root barrel only.** `exports` publishes a single `.` entry. Deep subpaths (`aicraft-pixel-engine/src/sand`) are not part of the public surface and will not resolve — import everything from the package root.

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
- **Pressurised flow is opt-in and lava-only (V1).** Ordinary movement acts on free surfaces, so unpressurised water in a sealed pipe will not rise. `injectLiquid` adds connected pressure transport for lava — see [§4c](#4c-pressure--connected-liquid-transport). Water and oil are not yet supported: a low-resistance body can make every cell reachable within a modest head budget, which needs a different solver before it can be enabled safely.
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

**Phase change.** A cell crossing `freezesAt` or `meltsAt` transforms into `freezesInto`/`meltsInto`, carrying its temperature across — rock created by freezing lava arrives at the freezing point and fades from there rather than snapping to ambient. A mobile material freezing into an immobile one (lava→rock, water→ice) additionally requires support underneath, or a parcel still in flight would set in mid-air and hang there, since rock never falls.

**Fragmentation.** LAVA additionally sets `fragmentsAt: 0.65` (above `freezesAt: 0.30`). A ballistic lava cell — one with velocity — that cools below this threshold during flight transforms into TEPHRA instead of waiting to land and freeze to ROCK. The fragment retains the parcel's velocity and temperature. TEPHRA is granular and less dense than LAVA, so it remains above molten flows and piles at its angle of repose; ordinary SAND is denser than LAVA and would sink back into the reservoir. Grounded lava (no velocity) is unaffected — it freezes via `freezesAt` as before. See [§5b](#5b-velocity-and-impulse).

Enabling heat also changes three existing contact reactions in `stepLavaOrFire`: lava+water, fire+water, and ice touching either. They stop being instant and become temperature-mediated, so lava chills into rock and water heats until it boils. Left instant they would pre-empt the whole field — `ICE.meltsAt` would be decorative in any world containing lava. **Combustion is deliberately not mediated:** ignition stays a probabilistic roll against `flammability`, identical with heat on or off. With heat disabled all three reactions are byte-for-byte unchanged.

`showcase/helpers/volcano.ts` is the worked example: it stores nothing itself, calls `setHeat`/`getHeat`, and maps temperature onto rheology and colour in one `syncFromHeat` pass. Note that pass runs **every frame, not only while the volcano is erupting** — the engine cools and freezes cells regardless of what the host is doing, and a freeze clears the cell's colour, so anything that sets during a quiet spell would otherwise render as bedrock.

One tuning note: steam condenses well below where water boils (0.20 vs 0.70) rather than just under it. Because temperature carries across a change, water boiling at 0.70 becomes steam at 0.70, and a threshold just below gave steam a measured lifetime of **one frame**. The wide gap stands in for latent heat — the energy real steam must shed before condensing — without needing per-cell energy state. It lowers only the condensation leg, so boiling does not lag.

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

## 4b. Growth — grass, trees, ferns, coral

Growth is the generative counterpart to the engine's destructive reactions.
Every rule is opt-in data on a `MaterialDef`, and a world containing none of the
growing materials never runs the pass, never allocates its grid, and never draws
from the RNG — so behaviour is unchanged for hosts that don't want life.

```ts
engine.setMaterial(x, y, MaterialType.GRASS);         // spreads on its own
engine.plant(x, y, MaterialType.TREE_TIP, { energy: 26, dir: 0 });
engine.setMaterial(x, y, MaterialType.SEED);          // falls, then germinates
```

**Three kinds, because "life" is three problems.** Isotropic copying is fine for
ground cover and cannot produce a tree at any setting — a tree needs a growing
point that knows which way it is heading and how much budget it has left.

| Kind | Materials | What it does |
|---|---|---|
| `spread` | `GRASS` | Copies itself into a neighbouring cell, subject to conditions at the *target*. |
| `tip` | `TREE_TIP`, `FERN_TIP` | Advances along a heading, leaves structure behind, forks, and dies. |
| `aggregate` | `SEED`, `SPORE` | Transforms *itself* on contact — germination, and accretion. |

**Per-cell state.** `engine.growthGrid` is an optional `Uint16Array`, lazily
allocated, that rides with the material through swaps exactly like
`stiffnessGrid`. For a tip it packs `energy(7) | dir(3) | gen(2) | variant(4)`;
for a spreading cell it holds a backoff counter and the remaining reach of its
`needs`. Read it with `getGrowthState(x, y)`, write it with `plant()` or
`setGrowthState()`.

`variant` is a genome: rolled once per plant, inherited by every branch, and used
as a mask over `branchTurns`. One material yields systematically different
silhouettes — a tree that only ever branches left is a different tree, not just a
different roll.

**Headings are gravity-relative octants**, `0` = away from gravity, clockwise. A
tree planted anywhere on a `RadialGravity` planet grows radially outward with no
special-casing. `octantOffset(frame, octant, out)` is exported if you need it.

**Pacing.** `growthInterval` (default 4) is frames between growth ticks — a tip
advances one cell per tick, so a 26-energy tree takes about two seconds at 60 fps.
Raise it for a slower world; there is no reason to lower it below 1.

**Settling.** Growth counts as activity: `beginSettle()` will not report settled
while anything is still growing, and `growthEventsLastFrame` exposes the count. A
mature patch backs off exponentially and goes fully quiet, so a finished world
still reaches a dead stop.

**Serialization.** `growthCells` is derived purely from the grid, so after
restoring a saved grid call `rebuildGrowthCells()` and growth resumes exactly as
before. Save `growthGrid` alongside the grid if you want mid-growth plants to
survive the round-trip.

### Writing your own

```ts
[MaterialType.MOSS]: {
  /* ...the usual fields... */
  isStatic: true,
  growth: {
    kind: 'spread',
    into: MaterialType.MOSS,
    needs: [MaterialType.WATER],  // checked at the source
    range: 4,                     // how far that licence travels
    intoMaterial: [MaterialType.ROCK, MaterialType.EMPTY],
    needsFooting: true,           // stay on surfaces
    maxNeighbors: 3,              // checked at the target
    chance: 0.05,
  },
},
```

Three settings do most of the work, and each of them exists because the obvious
alternative was tried and produced something wrong:

- **`isStatic`** — a plant is not a powder. `GRASS` at density 20 outweighs
  `SAND` at 10, so without this it sinks into the soil it is meant to root in.
- **`needs` is checked at the source, with `range`** — checking it at the target
  confines growth to the single ring of cells physically touching water, which
  grows a fringe around a pond and can never grow a meadow. `maxNeighbors`, which
  really does need to bound coverage, stays at the target.
- **`needsFooting`** — ground cover allowed to spread upward at all does so
  without limit and builds a tangle standing clear of the terrain.

For a `tip`, `becomes` must be a material that can hold itself up — in practice
`isStatic`, or `needsSupport` with something structural to hang from. `WOOD` uses
the latter, which is why tips brace the corner on a diagonal step: the support
test is cardinal-only, so an unbraced 45° limb is unsupported along its whole
length and collapses as fast as it is drawn.

**Foliage is static, deliberately.** `needsSupport` was tried on `LEAF` first, to
get a canopy that collapses when its trunk burns away. It cannot work: support is
satisfied only by structural cells, and `LEAF` must not be one — so a leaf could
survive only cardinally adjacent to wood, which permits a one-cell fringe along a
branch and makes a canopy impossible. An 11-energy tree grew as a bare stick with
a few green specks. A crown is most of what makes a small tree read as a tree, so
it won. Fire is what clears foliage now, and `LEAF` is the most flammable thing
in the table.

**Scale matters more than it looks.** `energy` is roughly the trunk length in
cells, so it wants setting against your world, not left at a default. On the
showcase's r=66 planet a 26-energy tree stood three quarters of the way to the
core; 10 puts it at about a fifth of the radius.

---

## 4c. Pressure — connected liquid transport

Ordinary liquid motion is driven by density and gravitational potential alone:
a liquid falls, spreads sideways toward a descent, and is explicitly blocked
from taking a step that raises its potential. That is correct for an
unpressurized body, and it is why a pool settles and a flow runs downhill to a
finite front. It cannot represent a chamber pushing a full column of magma
uphill through a conduit. `injectLiquid` is the opt-in pass that does.

```ts
const id = engine.injectLiquid({
  x: chamberFeed.x,
  y: chamberFeed.y,
  material: MaterialType.LAVA,
  amount: 1,        // whole-cell volumes for the next update
  pressure: 20,     // max hydraulic head available to each volume
  temperature: 0.9, // optional; LAVA spawnTemp by default
});
engine.update();
const [result] = engine.consumeInjectionResults();
// result.accepted === 1, or 0 with result.reason explaining why not
```

A material opts in by setting `pressureResistance` (lava does; water and oil do
not). The engine then finds an actual connected route from the source through
that liquid to a real boundary outlet — an EMPTY cardinal neighbour of the
body — accounting for gravitational head and path resistance along the way. It
extrudes material only at that outlet, never at a host-guessed destination.

**Why this is a new API style.** Every other host method (`setMaterial`,
`swap`, `plant`, `explode`) mutates the grid immediately. `injectLiquid` queues
work and drains it inside `update`, so that processed flags, chunk wake-up,
routing, and ordinary movement share one deterministic transaction. Requests
drain FIFO in public-call order; that order is part of the "same seed + same
sequence of public calls" determinism contract — reversing two competing
requests is allowed (and tested) to reverse their outcome. The returned id
correlates the queued call with its later `InjectionResult`.

**Cost.** The router draws no `random()` — it is a pure function of grid state
and request order — so a world that never calls `injectLiquid` is
byte-for-byte identical to one without the feature, allocates nothing, and pays
no per-frame cost. The search is bounded Dijkstra with a generation-stamped
visited array (no full clear), stopped by both the pressure budget and a
visited-cell ceiling (`pressureVisitLimit`, default 2048).

**Head, resistance, and the unit that ties them.** Pressure is hydraulic head:
energy per unit weight. The gravity model's `potentialAt` is already in
cell-head units (a difference of 1.0 = one cell of head), so raising liquid one
cell costs approximately one head unit plus the material's `pressureResistance`
(0.15 for lava). Moving downhill costs no head, though it still pays
resistance. There is no density multiplier: it would double-count the unit
conversion and break the "one cell up ≈ one head unit" invariant. Under
`RadialGravity` the same equation works with no volcano-specific direction —
moving away from the centre costs head, toward it does not.

**The ceiling is a correctness limit, not just a safety guard.** A
low-resistance liquid in a broad body can make every cell physically reachable
within a modest head budget. V1 sidesteps this by supporting lava alone (high
resistance, small connected bodies), where the head budget expires well before
the ceiling. General water routing needs a different algorithm and is out of
scope until it exists. If the ceiling *is* hit, routing returns `searchLimit`
and selects **no** candidate — a valid outlet may lie beyond, and reporting it
honestly (rather than as `noOutlet` or a guessed destination) is what keeps the
limit from silently corrupting results.

**Conservation and rejection reasons.** Pressure alone never creates material.
A one-cell injection into a body with a real outlet raises the material count
by exactly one (test it in a phase-change-disabled fixture, since lava can
become rock and confuse a bare count). A blocked request reports why without
spawning anything downstream:

- `noOutlet` — the connected component has no EMPTY cardinal neighbour (sealed).
- `insufficientHead` — outlets exist but every reachable one costs more than the pressure budget.
- `searchLimit` — the visited ceiling was reached before the search completed.
- `unsupportedMaterial` — the material sets no `pressureResistance` (anything but lava, today).
- `incompatibleSource` — the source cell holds another liquid or a solid; V1 does not overwrite it.
- `missingPotential` — the gravity model exposes no `potentialAt`, so head cannot be accounted.

**Dry sources.** The first volume into an EMPTY source cell materializes that
cell — an explicit source creation that costs no route head — after which later
volumes in the same request route through the newly seeded body. This gives a
generic pump a defined startup path without pretending an empty cell was already
a connected component.

**What the one-shot API does not do.** It is enough to prove connected
transport through an open conduit, and it is the right tool for unit tests and
one-off player actions. It is intentionally awkward as a steady flow
controller: a host would have to re-request every frame and would flicker
between accepted and blocked as the outlet changed, discarding the physical
meaning of pressure accumulated behind a cooling cap.

**Persistent sources.** `addPressureSource` is the steady-flow controller for
exactly that case. A source accrues whole-cell volume in `pending` at `rate`
and available head at `pressureRate` each frame — no host call needed — then
routes as much pending volume as its head allows through the connected body.
While blocked, both accrue up to their caps (`maxPending`, `maxPressure`); when
an outlet opens the backlog releases as a bounded surge rather than an
unbounded dump.

```ts
const sourceId = engine.addPressureSource({
  x: chamberFeed.x, y: chamberFeed.y,
  material: MaterialType.LAVA,
  rate: 1,            // whole-cell volumes per frame (fractional rates accumulate)
  pressureRate: 1,    // hydraulic head accrued per frame while blocked
  maxPressure: 40,    // cap on available head
  maxPending: 8,      // cap on accrued volume — bounds the surge
  temperature: 0.9,
});
// ...later, when the host is done with this source:
engine.removePressureSource(sourceId);
```

Sources process in creation order each frame, which is another explicit part
of the call-sequence determinism contract. Removing a source stops accrual but
does not delete material already in the grid; removed ids are not reused.
`getPressureSourceState(id)` reads the accumulated `pending` and
`availablePressure` for debugging and tuning.

**Rock fracture — when a blocked vent fails.** A solid opts into fracturing by
setting `pressureStrength` (ROCK does, at 15 head; WALL does not, so editor
geometry stays permanent). When a persistent source cannot find an affordable
liquid outlet, the engine scans the solid boundaries of the connected liquid
body and fractures the weakest one whose strength is below the source's
available pressure.

Fracture converts the solid into the source material — the rock becomes part of
the conduit, conserving mass rather than vanishing. It consumes pressure equal
to the solid's strength, so a weakened source stops breaking until it has
accumulated more. And it is capped at `fracturePerFrame` cells (default 1), so
a thick plug clears over multiple frames rather than disappearing in one step.

```ts
// A frozen vent cap (ROCK, strength 15) holding back a pressurized source.
// Once the source accumulates >15 head, the cap fractures into lava and the
// surge releases — no host remelt needed.
engine.addPressureSource({
  x: chamberFeed.x, y: chamberFeed.y,
  material: MaterialType.LAVA,
  rate: 1, pressureRate: 2, maxPressure: 30, maxPending: 5,
});
```

Cooling-created caps exist only when heat is enabled, because the LAVA→ROCK
phase change is part of the heat step. A no-heat world may still fracture
host-placed rock, but lava never freezes on its own. `engine.fracturesLastFrame`
exposes the count for debugging and tuning.

All pressure phases are implemented: connected routing (Phase 2), persistent
sources (Phase 3), fracture (Phase 4), the volcano migration (Phase 5), and
momentum/velocity (Phase 6). See [plan-pressure.md](./plan-pressure.md) for the
full design, including the "As built" notes on what the implementation learned.

---

## 5. Explosions and destructible terrain

```ts
engine.explode(centerX, centerY, radius, force);
```

A `radius` of zero or less is a no-op. `explode` carves a circle: walls/rock within `falloff > 0.7` are cleared, within `> 0.3` are pulverized into colored sand debris. Debris is launched from its origin cell with a velocity impulse scaled by `force` — greater force sends debris further along ballistic arcs before drag and gravity win. A fire/smoke core ignites in the inner 40% of the radius. The optional explosion hook (set via engine config) receives the explosion metadata.

The `force` parameter scales the impulse magnitude: `force=3` (the deferred-explosion default) produces gentle scatter; `force=9` produces violent ballistic debris. Before the velocity field existed, debris was teleported to a guessed destination; now it travels a real arc under gravity and drag (see [§5b](#5b-velocity-and-impulse)).

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

**v1 note:** `PixelEngine` is a displacement-based CA — particles move one cell (or not) per frame. Gravity *direction* affects all motion cleanly. Gravity *magnitude* affects ballistic velocity (see [§5b](#5b-velocity-and-impulse)), but does not affect the ordinary gravity-driven displacement rules, which are uniform-magnitude by design (injecting probability would break determinism). The `magnitudeAt` field on the interface is consumed by the velocity pass and defaults to 1.0 when absent.

---

## 5b. Velocity and impulse

The engine carries an optional per-cell velocity field (`velX`, `velY`) in fixed-point sub-cell units — a value of `VELOCITY_CELL_UNIT` (8) represents one cell of displacement per frame. A cell given velocity attempts to move along its velocity vector each frame, under gravity and drag, until it lands or collides. The field is lazily allocated on first use and costs nothing in a world that never imparts velocity.

```ts
engine.setVelocity(x, y, vx, vy);    // set velocity directly
engine.applyImpulse(x, y, dvx, dvy); // add to existing velocity (delta)
const { vx, vy } = engine.getVelocity(x, y);
```

Each frame the velocity pass (which runs before pressure and the checkerboard) integrates gravity, applies drag (`velocityDrag`, default 0.92/frame), accumulates a sub-cell remainder so fractional velocities are not truncated, and moves the cell via a Bresenham-style multi-cell step. Collisions (target occupied by equal/higher density) zero the velocity — no tunneling, no chain pushing. Velocity rides with the parcel through swaps and transfers (it is parcel state), and is zeroed on material change (a phase-changed cell starts at rest).

**Pressure outlet velocity (Torricelli).** When a pressure source routes magma to an outlet with surplus head, the surplus converts to launch velocity: `speed = √(2·surplus) · efficiency`. This is what produces a lava fountain — high pressure launches magma in a ballistic arc; low pressure (effusive) extrudes gently. The kinetic head is deducted from the source alongside the route cost, so the same pressure cannot launch multiple parcels (no energy double-count).

**Fragmentation.** LAVA sets `fragmentsAt: 0.65` — above `freezesAt: 0.30`. When a ballistic lava cell (one with velocity) cools below this threshold during flight, it transforms into TEPHRA rather than waiting to land and freeze to ROCK. The granular product keeps the parcel's velocity and temperature, then settles above denser molten LAVA to build a tapering cone. Grounded lava (no velocity) freezes via `freezesAt` as before — fragmentation is for airborne ejecta only.

`engine.velocityMovesLastFrame` and `engine.activeVelocityCount` are the diagnostics, paralleling `swapsLastFrame`.

---

## 6b. Volcano — the one composed subsystem

Everything above is a primitive. `src/volcano/` is the exception: a subsystem that arranges pressure sources, the heat field, fragmentation, `stiffnessGrid`, and the velocity field into a working eruption. It is exported from the package root and imports nothing from the core in reverse, so a world that never builds a volcano never loads it.

```ts
import {
  stampVolcano, createVolcanoState, stepVolcanoFrame,
  buildVolcanoOpts, volcanoGeometryFor, makeRng,
  type VolcanoConfig, type VolcanoRuntime,
} from 'aicraft-pixel-engine';

const cfg: VolcanoConfig = { /* centre, planetRadius, ventAngle, chamberDepth, ... */ };
stampVolcano(engine, cfg);                 // cut the chamber + conduit
const state = createVolcanoState();
const rng = makeRng(1234);                 // side-stream: does not shift engine.random()
const opts = buildVolcanoOpts(/* inputs */);
const runtime: VolcanoRuntime = { erupting: true, capHeight: 20 };

// Once per frame, instead of engine.update():
stepVolcanoFrame(engine, cfg, state, rng, opts, runtime);
```

`stepVolcanoFrame` **calls `engine.update()` itself** — do not call both. It runs `stepVolcanoPre → update → stepVolcanoPost` while erupting, maintains the plumbing while dormant, and syncs temperature-derived colour and rheology every frame either way.

Three things worth knowing:

- **`syncFromHeat` is what makes lava look like lava.** It maps each cell's temperature onto its yield thickness, so a flow runs while molten, stiffens as it chills, and stalls into a blunt front. `stepVolcanoFrame` calls it for you; call it yourself if you drive the phases manually.
- **Instrumentation takes an injected clock.** The subsystem is part of the deterministic core and reads no wall clock. For per-frame timings, pass `now: () => performance.now()` and a `timings` sink on the runtime; omit both and every timing branch folds away.
- **No plume, glow, or shake.** Those are renderable entities, and this library ships no renderer. `showcase/helpers/volcano-effects.ts` is a complete worked implementation to copy.

---

## 7. Synchronization strategy

When `aicraft-pixel-engine` evolves, consumers update via:

- **Submodule:** `git submodule update --remote src/lib/aicraft-pixel-engine && git commit`
- **Vendored:** re-run the copy command and review the diff
- **npm:** `npm update aicraft-pixel-engine`

The library follows semver. Breaking changes to public APIs bump the major version.
