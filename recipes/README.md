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
| [`dirty-chunk-renderer.ts`](./dirty-chunk-renderer.ts) | Offscreen-canvas dirty-chunk painter with palette, grain and depth shading | The `putImageData` dirty-offset trap (chunks render invisible except the top-left one) and CSS-stretched canvases turning the planet into an ellipse |
| [`census.ts`](./census.ts) | Live world census from `engine.grid` | — (the game-feel layer: readable feedback of what the world holds) |

Each recipe's header comment carries the measured story of the bug it exists
to prevent. The tests in [`tests/`](./tests/) pin the load-bearing behavior;
the DOM-touching recipes (camera, renderer) are typechecked in CI and
exercised by the games that use them.
