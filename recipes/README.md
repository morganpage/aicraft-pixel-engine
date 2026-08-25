# Recipes — tested wiring for pixel-engine hosts

Reusable host-side wiring, in the spirit of the `aicraft-engine` recipes
directory: when the same glue kept being re-sketched (and re-broken) inside
build briefs, it graduates to a recipe here. Recipes are **copy-in modules**:
copy the file you need into your game under `src/recipes/`, change the import
path from the repo-relative `'../src/index.js'` to `'aicraft-pixel-engine'`,
and use it. They are typechecked and unit-tested in CI against the engine
source, so they cannot drift from the shipped API the way inline sketches in
briefs did.

| Recipe | What it is | The failure it prevents |
|---|---|---|
| [`fixed-tick-clock.ts`](./fixed-tick-clock.ts) | Wall-clock accumulator driving fixed 1/60s steps | A naive tick-per-`setInterval` slows 60× in throttled (occluded) tabs — measured in the wild during the god-game build |
| [`radial-camera.ts`](./radial-camera.ts) | Zoom/pan camera + grid mapping + pointer-capture hygiene | A pointer stream that ends without a `pointerup` on the captured element leaves the canvas swallowing every later click — toolbar included |
| [`dirty-chunk-renderer.ts`](./dirty-chunk-renderer.ts) | Offscreen-canvas dirty-chunk painter with palette, grain and depth shading — does a deterministic full paint at bind time | The `putImageData` dirty-offset trap (chunks render invisible except the top-left one), CSS-stretched planets, and the black-canvas boot race (anything consuming the engine's one-shot all-dirty flag before the first render — e.g. a bundler dep-opt full-reload) |
| [`census.ts`](./census.ts) | Live world census from `engine.grid` | — (the game-feel layer: readable feedback of what the world holds) |
| [`surface-walkers.ts`](./surface-walkers.ts) | Polar-coordinate surface creatures: footing, swimming, hazards, fear (freeze-stare → flee), minimal body+eye+hop look | The grass-gate divergence: two builds of the same brief, one spawning walkers at boot on bare rock, the other hiding them behind a grass census until a reviewer concluded they were never built |
| [`headless-shot.mjs`](./headless-shot.mjs) | Copy-in headless-browser screenshot harness with CPU canvas readback, compositing, garbage-session retry and pixel probes | Black canvas shots from headless-Chrome GPU compositing (`page.screenshot`/`toDataURL` both flaky), and vision models misdescribing screenshots that pixel counts would have settled |

Each recipe's header comment carries the measured story of the bug it exists
to prevent. The tests in [`tests/`](./tests/) pin the load-bearing behavior;
the DOM-touching recipes (camera, renderer, walkers' draw pass) are
typechecked in CI and exercised by the games that use them.

## Verifying builds headlessly — two lessons worth an hour each

1. **Trust the CPU readback, not the GPU one.** In headless Chrome,
   `page.screenshot()` and `canvas.toDataURL()` intermittently return a
   black canvas while the game is pixel-perfect — count cells through
   in-page `getImageData` and you'll see the truth. Launch with
   `--disable-accelerated-2d-canvas` and treat a near-black probe of where
   the planet should be as a garbage session: retry (exit 42), don't debug
   the game. [`headless-shot.mjs`](./headless-shot.mjs) is all of this
   wired up.
2. **Count pixels; don't ask a model.** Vision models describing
   screenshots mislead in both directions — flipped axes, hallucinated
   "forest pixels" on a pristine boot, toolbars read into toast stacks.
   A probe that counts pixels within a colour tolerance (`--probe x,y,w,h,
   r,g,b,tol`) is the evidence that holds up in a bisect.
