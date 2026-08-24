# The slime-knight rig

A ~2,200-line procedural creature rig, extracted verbatim from the god-game
reference build: a chunky outlined body with gazing eye, blinking, a mouth
that morphs (smile ↔ nervous "o"), two-bounce-spring walking feet, and
antenna Verlet strands with bend constraints. Fully deterministic — seeded
via `deriveHeroConfig(seed)`, no `Math.random`.

Copy `slime-knight.ts` into your game (`src/` or `src/recipes/`) next to a
thin adapter that owns the world coupling: the rig knows nothing about the
engine or gravity. The reference adapter kept each creature at
`(angle, radius)` in the planet's polar frame, sampled the terrain under the
angle to decide footing/bobbing/death, and drove `stepHero` + `drawSlimeKnight`
per frame. See the god-game brief §8.5 for the pattern.

Public surface: `deriveHeroConfig`, `createHeroFrameState`, `stepHero`,
`drawSlimeKnight`, `applyAntennaBendConstraints`, `applyAntennaRestPose`,
`applyAntennaTipWeight`, `HERO_CANVAS_SIZE`, `HERO_GROUND_Y`, `HERO_RANGES`,
and the `HeroConfig`/`HeroFrameState`/`HeroInputs` types.

**Dependencies:** the rig builds on the sibling package's animation
primitives — `npm install --save-exact aicraft-engine` (imports `solveLimb`,
`advanceSpringChain`, `generatePalette`, `mulberry32` and friends from it).

**License:** MIT, same as this repository.
