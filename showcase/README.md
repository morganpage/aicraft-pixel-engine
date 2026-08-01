# Showcase

A standalone Vite app that consumes the `aicraft-pixel-engine` library via relative imports and demos its two headline capabilities end-to-end: **flat-world falling sand** and **radial-gravity planets**. It is **not** shipped to library consumers — it is a reference/demo app that lives inside the library repo for development and visual validation.

Each section renders an independent canvas that exercises a specific cluster of engine APIs.

---

## Run / Build / Typecheck / Test

Commands are run from the **repo root** (`aicraft-pixel-engine/`):

| Command | What it does |
|---|---|
| `npm run showcase:dev` | Dev server (prints a localhost URL) |
| `npm run showcase:build` | Production build to `showcase/dist/` |
| `npm run showcase:typecheck` | tsc gate for the showcase (separate tsconfig) |
| `npm run showcase:test` | Vitest run of the showcase's DOM-free pure-logic suite (`showcase/tests/*.test.ts`) — CI / pre-commit |
| `npm run showcase:test:watch` | Same suite in watch mode |

The showcase has its own `showcase/tsconfig.json`, `showcase/vite.config.ts`, and `showcase/vitest.config.ts`, separate from the root library toolchain. The `vite/client` ambient types provide browser-API typing.

The showcase's DOM-coupled section code (`sections/*.ts`) imports browser APIs (`document`, `canvas`, pointer events) and cannot be unit-tested under the project's Node-only Vitest setup without adding `jsdom` (forbidden by the zero-deps invariant). Instead, the pure logic the sections actually use — the grid→pixels renderer — is extracted into `helpers/renderer.ts` and tested in `tests/renderer.test.ts`.

---

## Sections

| Section | ID | Engine capabilities demonstrated |
|---|---|---|
| **Sandbox** | `#sandbox` | Flat-world falling sand: a paintable grid with a material brush palette (sand/water/lava/oil/acid/wood/wall/rock/fire/ice), brush-size slider, paint-by-drag, explosions, and clear. Density stratification, liquid flow, gas rising, and material reactions (lava+water→rock+steam, fire spread, acid) all visible. |
| **Planet** | `#planet` | Radial gravity: a disc planet under `RadialGravity`, where every material falls *toward the planet center* and settles as a ring on its surface — the defining god-game behavior. Paint materials anywhere and watch them curve inward. |

Every section renders via the dirty-chunk pipeline (`engine.consumeRenderDirtyChunks()` → `paintGridInto` → `putImageData`), proving the render-dirty tracking works end-to-end.

---

## Architecture

`main.ts` bootstraps each section via `init<Name>(container)`. Sections are independent canvases with local state — no shared store is needed (each canvas owns its own `PixelEngine`). Both sections run a fixed-step 60 Hz loop (`setInterval`) that calls `engine.update()` then renders only the chunks flagged dirty.

Rendering is shared via `helpers/renderer.ts` (`paintGridInto`): a pure function that paints material colors (or explosion-debris tint from `colorGrid`) into an `ImageData.data` buffer, restricted to the dirty chunk set. The section files supply the canvas/`ImageData` and the DOM event wiring; the helper supplies the pixel logic, which is what the test suite covers.

---

## No reduced-motion gate

Unlike the `aicraft-engine` showcase, this showcase does **not** gate on `prefers-reduced-motion`. The falling-sand simulation's motion *is* the content — a static frame defeats the purpose. Users who need reduced motion can simply not paint or can pause via their browser's tab-throttling.
