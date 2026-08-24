# Game prompts for `aicraft-pixel-engine`

A catalog of build-briefs (prompts) for games built **on top of** the
[`aicraft-pixel-engine`](https://www.npmjs.com/package/aicraft-pixel-engine)
falling-sand simulation library. Each file is a self-contained prompt — paste it
to a coding agent (Claude / Cursor / etc.) and it produces a runnable game that
imports everything from the engine and writes no re-implementations of what the
engine already provides.

[god-game.md](./god-game.md) pins `aicraft-pixel-engine@0.2.0` — a version,
not a range (install with `npm install --save-exact`, or npm writes `^0.2.0`
into package.json) — and every import it claims compiles against the `0.2.0`
surface. The brief was validated end-to-end by building the game from it
against the package and testing every power in a browser; its volcano section
calls the library's tested eruption subsystem rather than re-deriving one.

> **0.2.0 is not on the npm registry yet** (publish pending the owner's npm
> auth). Until it lands, builds against this brief need the engine from
> source (`file:` dependency or a checkout); the moment `npm publish` runs,
> `npm install --save-exact aicraft-pixel-engine@0.2.0` works as written.

For a maximum-quality run, [god-game-gauntlet-prompt.txt](./god-game-gauntlet-prompt.txt)
is a launcher prompt: it points the agent at the hosted brief and adds a
sub-agent fan-out loop with a harsh visual critic that keeps iterating until
the result stands side-by-side with commercial god games. Paste that instead of
the brief when you want the gauntlet, not just the build.

The common contract every prompt here enforces:

- **Deterministic simulation** — no `Math.random()` / `Date.now()` feeding the
  grid. `engine.random()` (the seeded mulberry32) drives every decision that
  writes a cell; `Math.random` is allowed only for pure visuals that never feed
  back into game state (e.g. the lightning bolt's jitter).
- **Fixed-step loop** (60 Hz): `engine.update()` then `render()`, one
  simulation step per tick.
- **No physics library** — the engine has no rigid bodies by design; everything
  is a cell.
- **No hand-rolled temperature, growth, or pressure** — `enableHeat`, the
  growth rules, and `addPressureSource` are native engine features.
- **Renderer discipline** — backing store matches the grid resolution, the CSS
  box stays square (no stretching), repaint honours
  `consumeRenderDirtyChunks()` (mind the `putImageData` dirty-offset trap), and
  the camera is a `ctx` transform that never touches the engine.
- **Pointer-capture hygiene** — canvas games that `setPointerCapture` must also
  stop painting/panning on window-level `pointerup` / `pointercancel` / `blur`
  and release the capture; a pointer stream that ends without a clean
  `pointerup` on the captured element otherwise leaves the canvas swallowing
  every later click (observed in the wild during the god-game build).
- **Root-barrel imports only** from the npm package — the `exports` map
  publishes a single `.` entry; deep subpaths like `aicraft-pixel-engine/src/…`
  are not part of the public surface.

> **Reusable wiring lives in [`../recipes/`](../recipes/)**, not in these
> briefs: the throttle-proof fixed-step clock, the pointer-hygiene camera,
> the dirty-chunk renderer, and the census scanner. Recipes are typechecked
> and unit-tested against the engine source in CI, so they cannot drift from
> the shipped API the way inline sketches in briefs did. New briefs: point at
> a recipe; do not paste its code.

## Prompts

| Game | File | Genre | Engine pillars exercised |
|---|---|---|---|
| **God Game** | [god-game.md](./god-game.md) | One-screen circular-planet terraforming toy with a living population (*Reus* / *Godfinger*) | `RadialGravity` planet setup, `beginBulk`/`endBulk` stamping, native heat & climate, growth (`SEED` → trees, fertile-ash grass spread), the volcano subsystem (`stampVolcano`/`stepVolcanoFrame`), explosions + the velocity field, dirty-chunk rendering under a host camera, census/milestone game layer, polar-frame surface-walker population |

_More to come — see "Adding a new prompt" below._

## Adding a new prompt

1. Create `<slug>.md` in this directory (e.g. `flat-sandbox.md`).
2. Follow the structure of `god-game.md`: §0 concept → §1 tech stack &
   exact-version install (root-barrel import) → §2 determinism rules →
   §3 engine module → game system map → per-system specs → acceptance criteria
   (incl. the forbidden-pattern checks) → implementation workflow → stretch
   goals. Compile the claimed public imports in a clean, strict TypeScript
   consumer project against the published version before shipping the brief.
3. Add a row to the table above with the genre and the engine pillars it
   stresses — pick game ideas that **differ in which pillars they lean on** so
   the catalog collectively exercises the whole engine.

## Candidate ideas (not yet written)

- **Flat-world sandbox** (Powder-Toy style) — `FlatGravity`, the full
  material/reaction matrix (acid, oil, flammable-gas explosions, steam cycles);
  the breadth stress test.
- **Volcano lab** — pressure transport and fragmentation as the star: dikes,
  seal-then-fracture cycles, tephra cones, instrumented readouts via
  `getPressureSourceState`.
- **Erosion & river sim** — liquid leveling, host rain entities, freeze/thaw
  cycles driven by `ambientTemperature`.
- **Demolition sandbox** — `explode()` carving, debris scatter, fire spread
  through flammables, collapse under `needsSupport` materials.

## Reference — what the engine gives a game

Context for prompt authors (games lean on this; briefs restate only what they
use):

- **23 materials**: EMPTY, WALL, SAND, WATER, LAVA, ROCK, STEAM, FIRE, SMOKE,
  OIL, ACID, WOOD, FGAS (flammable gas), ICE, GRASS, SEED, TREE_TIP, LEAF,
  FERN_TIP, SPORE, CORAL, FROND, TEPHRA. The life/ejecta materials are inert
  until their growth rule fires or a host places them, so a world that never
  uses them pays nothing.
- **Density-driven displacement** — denser sinks through lighter; gases
  (negative density) rise.
- **Reactions** — lava+water→rock+steam, fire spreads via flammability and is
  quenched by water, acid dissolves solids, FGAS ignites and explodes.
- **Native heat / temperature field** — turn on with `enableHeat: true`. Every
  thermal material conducts to its neighbours, radiates to the environment
  through exposed faces, and phase-changes: lava → rock, water → steam / ice,
  steam → water, ice → water. `FIRE` is an infinite heat source (a Dirichlet
  boundary); `LAVA` is a finite body that cools. `ambientTemperature` is the
  climate dial.
- **Native growth system** — three rule kinds: `spread` (grass/moss,
  isotropic, moisture-gated with a travel `range`), `tip` (trees/ferns, a
  directed stateful growing point that leaves a trunk and branches behind it),
  and `aggregate` (seeds germinating, spores accreting onto coral). Tips always
  die, which is why a forest converges instead of consuming the grid.
  `engine.plant()` seeds a tip; `growthInterval` paces it. Growth is
  gravity-relative, so on a planet a tree grows radially outward.
- **Native pressure transport** — `addPressureSource` routes a liquid (V1:
  lava only) through its connected body to a real boundary outlet via a
  Dijkstra search, accounting for gravitational head and per-material
  resistance. Blocked sources accrue pressure and can fracture solids
  (`ROCK`/`TEPHRA` opt in; `WALL` stays permanent). `injectLiquid` is the
  one-shot version. This is the volcano engine.
- **Fragmentation** — an airborne lava cell that cools past `fragmentsAt` while
  still in flight becomes granular `TEPHRA`, which piles at its angle of repose
  and builds a cone. Grounded cells never fragment — they freeze to `ROCK`.
- **Explosions** — `engine.explode(x, y, radius)` carves terrain and scatters
  debris; pass `onExplode` in the constructor for a hook.
- **Velocity field** — `setVelocity` / `applyImpulse` give a cell a sub-cell
  velocity that integrates across frames. Pressure outlets use this to launch
  ejecta ballistically; hosts can use it for anything.
- **Liquid leveling** — water seeks an equipotential and then goes quiet (0
  swaps/frame), so oceans settle, they don't shimmer forever.
- **Yield strength (`yieldThickness`)** — lava is a Bingham plastic: it flows
  only while thick enough, stopping at a blunt front. This is why lava *looks*
  like lava and not like orange water. Override per-cell with
  `engine.stiffnessGrid`.
- **Deterministic** — seeded RNG (`engine.random()`, never `Math.random()`).
  Same seed + same inputs → identical evolution.
- **Active-chunk optimization** — only 32×32 chunks with activity are simulated.
- **Volcano subsystem** (`0.2.0`+) — the eruption cycle itself, composed from
  the primitives above: `stampVolcano` cuts a chamber and conduit,
  `stepVolcanoFrame` runs one frame of explosive → effusive → repose, and
  `syncFromHeat` maps each lava cell's temperature onto its yield thickness so
  a flow runs while molten and stalls into a blunt front as it chills. Lives at
  `src/volcano/`; nothing in the core imports it.

## Reference — engine limits (the boundaries of the sandbox)

- **No rigid bodies.** Everything is a cell. Creatures would be sprite overlays
  you move yourself, reading the grid for collisions.
- **No water pressure transport.** Pressure routing is lava-only in V1 (only
  LAVA sets `pressureResistance`). A U-tube of water won't equalize; aqueducts
  aren't expressible without host help.
- **No buoyancy for gases.** Gases rise away from gravity and exit the grid —
  hence clouds must be host-tracked, not a gas material. (Steam is the
  exception: it rises, cools, and condenses back to water natively.)
- **No rendering.** You draw every pixel. This is also why ash plumes, vent
  glow, and screen shake are *not* in the volcano subsystem — they are
  renderable entities, and the engine ships no renderer. See
  `showcase/helpers/volcano-effects.ts` for a worked host-side implementation.
