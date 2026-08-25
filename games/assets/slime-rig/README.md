# The slime-knight rig

A ~2,200-line procedural creature rig, extracted verbatim from the god-game
reference build: a chunky outlined body with gazing eye, blinking, a mouth
that morphs (smile ↔ nervous "o"), two-bounce-spring walking feet, and
antenna Verlet strands with bend constraints. Fully deterministic — seeded
via `deriveHeroConfig(seed)`, no `Math.random`.

**It is a composition, not an implementation.** There is no original animation
maths in this file. Every moving part is a call into `aicraft-engine`:
`solveLimb` (knees), `advanceLocomotionByDisplacement` + `evaluateLocomotion` +
`DEFAULT_GAIT` (stride synced to ground covered), `blendLocomotionToStance`
(feet settling at rest), `blendAirborneTuck` + `advanceJump` (the hop),
`advanceSpringChain` (antennae), `breathe`, and `generatePalette`. What the rig
contributes is proportions, seed-derived variation and drawing. Remove the
dependency and it does not degrade — it stops compiling.

Copy `slime-knight.ts` into your game (`src/` or `src/recipes/`). The rig knows
nothing about the engine or gravity, so it needs an adapter that owns the world
coupling — **and that adapter now ships**:

- [`recipes/surface-walkers.ts`](../../../recipes/surface-walkers.ts) is the
  behaviour (polar footing, swimming, hazards, fear, the boot spawn contract).
- [`recipes/legged-walkers.ts`](../../../recipes/legged-walkers.ts) is the
  bridge onto this rig: the polar↔rig-canvas transform, the grid-px→canvas-px
  gait conversion, and the traversal cancel.

Copy both, pass this module in, and you are done:

```ts
import * as rig from './slime-knight';
const rigged = createRiggedWalkers(pop, rig);
```

This README used to say "write a thin adapter" and leave it there. Every build
that read it skipped the rig and drew an ellipse instead — the adapter was
forty lines, but forty lines of coupling nobody had written down. Its
signatures are pinned against this file by
`recipes/tests/legged-walkers-compile.ts` in CI.

Public surface: `deriveHeroConfig`, `createHeroFrameState`, `stepHero`,
`drawSlimeKnight`, `applyAntennaBendConstraints`, `applyAntennaRestPose`,
`applyAntennaTipWeight`, `HERO_CANVAS_SIZE`, `HERO_GROUND_Y`, `HERO_RANGES`,
and the `HeroConfig`/`HeroFrameState`/`HeroInputs` types.

**Dependencies:** the rig builds on the sibling package's animation
primitives — `npm install --save-exact aicraft-engine` (imports `solveLimb`,
`advanceSpringChain`, `generatePalette`, `mulberry32` and friends from it).

**License:** MIT, same as this repository.
