# Plan: temperature field

> Design document, not yet implemented. Status: proposed.

## The problem

There is no temperature in the engine, and every host that needs one reinvents
the same machinery. The volcano showcase (`showcase/helpers/volcano.ts:40-289`)
is the worked example: to make lava cool into rock on a dry planet, it stores
heat by **abusing `colorGrid` as a heat store** — quantizing the 0–1 range into
48 incandescence ramp colours (`TEMP_RAMP`, `TEMP_STEPS = 48`) and reverse-looking
a cell's temperature back out of its packed RGBA (`tempAt` at line 267). That is
a hack born of necessity: the engine already swaps `colorGrid` alongside `grid`
on every move, so heat rides with the material for free — but it costs a whole
colour channel, limits heat to 48 discrete levels, and forces every host to
re-implement the encode/decode.

It also creates a constraint nobody should have to maintain. Because `tempAt`
identifies a hot cell by looking its *exact* packed colour up in a reverse map,
the ramp colours and the tephra tints written by `tintTephra` must stay disjoint
forever, or tephra reads as warm rock and gets cooled as if it were lava. There
is a test pinning that disjointness (`showcase/tests/volcano.test.ts:137`). A
real heat grid dissolves the invariant outright — that alone is worth the work.

A god game needs temperature as a first-class quantity. It unlocks:

- **Lava that cools on its own** — no host step required. Retires the volcano's
  `coolLava`, `setTemp`, `tempAt`, and the entire `RAMP`/`TEMP_STEPS` apparatus.
- **Ice ↔ water ↔ steam phase changes** — seasons, climate, habitable zones.
  Turning the world's ambient temperature down should freeze the oceans.
- **Fire warming its surroundings** — heat radiates from burning wood, and water
  in sustained contact with flame boils away rather than being an absolute
  barrier. Note the shape of what this can deliver: a heat source can never
  drive a neighbour past its own temperature, so this is a statement about
  contact geometry, not about time alone. See
  [Reachability](#reachability-what-a-heat-source-can-and-cannot-do).
- **Habitable-zone queries** — "is this tile in the temperature range where life
  can take hold?" — which the [growth plan](./plan-growth.md) builds on.

## Design

Mirror the pattern proven by `yieldThickness` + `stiffnessGrid`: optional
`MaterialDef` fields, a per-cell grid that rides with the material through swaps
and levelling transfers, and a bounded step in `update()`. Opt-in throughout — a
host that never touches heat sees zero change.

### Two mechanisms, not one

The single most important structural point, and the one an earlier draft of this
plan got wrong: **conduction alone cannot reproduce the behaviour we are
replacing.**

`coolLava` (`volcano.ts:896`) cools a cell in proportion to its *exposure* — how
many of its four orthogonal neighbours are air, water, steam, smoke or fire
(`isCold`, line 853). That is radiative and convective loss to the environment,
and it is the term that does essentially all of the visible work: a flow's skin
chills far ahead of its core, a buried conduit stays live, and the flow front —
the most exposed part of the flow — stalls first, which is what gives a tongue
its blunt snout and its levees.

Conduction between cells cannot express that, because the thing an exposed cell
is losing heat *to* is `EMPTY`, and `EMPTY` is not a material with a temperature.
Under a conduction-only model an exposed cell has nobody to conduct into and
therefore cools **slower** than a buried one — exactly inverted from the
behaviour being ported. A surface flow would stay molten forever.

Making `EMPTY` a thermal participant is not the fix. Heat stored in vacuum cells
would advect through `swap()` as hot air parcels, and would be silently destroyed
whenever `setMaterial` overwrote the cell. Conservation would be fiction.

So the heat step has two terms:

1. **Conduction** — cell ↔ cell, between two materials that both carry heat.
   Symmetric and exactly conservative: what one loses, the other gains.
2. **Environment exchange** — cell ↔ world, scaled by how many faces are `EMPTY`.
   Non-conservative by construction, because the environment is an infinite
   reservoir at `ambientTemperature`. This is `coolLava`'s exposure rule,
   generalised.

Conduction smooths the interior. Environment exchange is what actually cools a
flow, and what makes "turn the world's ambient down and watch the oceans freeze"
a one-line host change.

### Data model — `src/materials/materials.ts`

The earlier draft had a single `ambientTemp` field doing three unrelated jobs at
once (initial condition, equilibrium target, and thermal-participation flag),
which is why it could not answer whether a lava cell re-asserts its temperature
each frame. Those are three different questions, so they get three fields.

```ts
export interface MaterialDef {
  // ...existing fields...

  /**
   * Temperature a freshly-placed cell of this material is born at, 0–1.
   * Absent = born at the world's `ambientTemperature`.
   *
   * This is an *initial condition*, nothing more. A LAVA cell is born at 1.0
   * and then cools like any other cell; it does not tend back toward 1.0.
   */
  spawnTemp?: number;

  /**
   * If true, this material is held at `spawnTemp` — an infinite heat source
   * that neither cools nor equilibrates. Default false.
   *
   * "Held" is precise, and it is not the same as "skipped". A heat source
   * participates fully in conduction *as a source*: its neighbours draw heat
   * across the shared edge exactly as they would from any other cell, and the
   * source is then re-asserted to `spawnTemp` at the end of the step. It is a
   * Dirichlet boundary condition, not an inert cell.
   *
   * Skipping it entirely would be a different and useless thing — a fire that
   * nothing can warm itself against. The heat a source supplies is created from
   * nothing, which is why the conservation guarantee below is stated for the
   * source-free case.
   *
   * FIRE is one (it is a combustion reaction, not a hot object). LAVA is
   * emphatically not: a finite body of lava must cool, or nothing ever freezes.
   */
  heatSource?: boolean;

  /**
   * Conduction coefficient, 0–1, *relative*. Not a diffusion rate — the engine
   * scales it by `CONDUCTION_MAX` to keep the stencil stable (see below), so
   * 1.0 means "conducts as fast as the scheme safely allows", not "moves the
   * entire temperature difference in one frame".
   */
  conductivity?: number;

  /**
   * Rate of exchange with the environment through an exposed (`EMPTY`) face,
   * 0–1. This is the dominant cooling term for anything at the surface.
   */
  emissivity?: number;

  /** Temperature at/below which this transforms, and into what. */
  freezesAt?: number;
  freezesInto?: MaterialType;
  /** Temperature at/above which this transforms, and into what. */
  meltsAt?: number;
  meltsInto?: MaterialType;
}
```

Making the transformation *targets* data rather than a hardcoded switch in the
engine keeps the step declarative, matching the shape the
[growth plan](./plan-growth.md) proposes for `GrowthRule`.

**Thermal participation** is implied: a material is thermal if it sets *any* of
these fields. Precompute a `readonly isThermal: boolean[]` alongside
`materialDefs` at module load, so the hot loop is one array read rather than six
`undefined` checks.

Initial material values:

| Material | spawnTemp | heatSource | conductivity | emissivity | freezes | melts |
|----------|-----------|------------|--------------|------------|---------|-------|
| LAVA  | 1.00 | — | 0.6 | 0.13 | 0.30 → ROCK | — |
| FIRE  | 1.00 | yes | 0.8 | 0.10 | — | — |
| ICE   | 0.00 | — | 0.3 | 0.20 | — | 0.15 → WATER |
| WATER | 0.15 | — | 0.9 | 0.05 | 0.05 → ICE | 0.70 → STEAM |
| STEAM | 0.75 | — | 0.4 | 0.05 | 0.65 → WATER | — |
| ROCK  | — | — | 0.2 | 0.15 | — | — |
| SAND / WOOD / WALL | — | — | 0.2 | 0.10 | — | — |

Materials absent from this table — EMPTY, OIL, ACID, SMOKE, FGAS — set no
thermal field and are therefore **non-thermal**: they neither conduct nor
exchange nor transform, and the heat step skips them entirely. That is a
deliberate first cut, not an oversight. Giving OIL a boiling point or ACID a
freezing point is purely additive and can happen whenever a host needs it; the
one that will actually be missed is EMPTY, and the "Two mechanisms" section
above explains why it must stay out.

Four of these numbers are load-bearing and derived rather than guessed:

- **`ambientTemperature` defaults to 0.10** — chosen so nothing spontaneously
  transforms on a default world. Water (freezes at 0.05) stays liquid, ice
  (melts at 0.15) stays solid, and both are stable at the same ambient. A host
  that wants a snowball planet sets `ambientTemperature: 0.02` and the oceans
  freeze on their own. That is the climate feature, for free.
- **`LAVA.emissivity = 0.13`** reproduces today's default cooling. The showcase
  slider defaults to `cooling: 0.12` (`showcase/index.html:127`), an *absolute*
  loss per frame for a fully exposed cell. Ours is proportional to `T − ambient`
  (Newton's law), so matching at the hot end: a surface cell (exposure factor
  0.55, see below) at `T = 1.0` with `ambient = 0.10` should lose
  `0.12 × 0.55 ≈ 0.066` per frame, giving `e = 0.066 / (0.55 × 0.9) ≈ 0.13`.
- **`ROCK` has no `spawnTemp` but is still thermal.** A rock the host places is
  born at ambient; a rock created by lava freezing *keeps the lava's
  temperature* and fades from there. That is deliberate — see the phase-change
  section.
- **`WATER.emissivity = 0.05` and `WATER.meltsAt = 0.70`** are set by the
  reachability constraint below, not chosen for their own sake. They are coupled
  to `FIRE.spawnTemp` and must be calibrated as a group.

### Reachability: what a heat source can and cannot do

Worth stating as a rule, because it silently invalidates otherwise reasonable
threshold choices: **a `heatSource` held at `T_s` can never drive any neighbour
above `T_s`.** Conduction moves a fraction of the *difference*, so a neighbour
approaches `T_s` asymptotically and never crosses it. Any threshold set above a
source's hold temperature is unreachable by that source, full stop.

The real bound is tighter, because environment exchange pulls the other way. For
a cell with `n` faces touching a source at `T_s` and exposure factor `k`, the
steady state is where the two terms balance:

```
n · f · (T_s − T)  =  emissivity · k · (T − ambient)
```

Solving for the equilibrium temperature gives the honest answer to "can fire
boil water?", and at the values an earlier draft of this table carried — FIRE at
0.90, WATER boiling at 0.95, `WATER.emissivity` 0.30 — the answer was **no, at
any contact geometry**. Two faces of flame equilibrated at ~0.69 and three at
~0.77, both far short, and the threshold sat above the source temperature
anyway. The motivating example was unreachable.

Three coupled changes fix it, which is why they are grouped: raise
`FIRE.spawnTemp` to 1.00 so the source clears the threshold at all; drop
`WATER.emissivity` to 0.05, since 0.30 meant a water surface equilibrated with
air in about five frames, which badly understates water's thermal inertia; and
lower `WATER.meltsAt` to 0.70. A water cell with one flame face and one exposed
face now settles near 0.87 and boils.

That change also rescues the lava quench. At the old values, lava-adjacent water
equilibrated at ~0.48 — so `LAVA + WATER` produced ROCK but **never the STEAM**
the reaction it replaces is named for. It now reaches ~0.83 and boils.

The general lesson for whoever calibrates this: the equation above, not
intuition, decides whether a threshold is reachable. `spawnTemp` sets a ceiling
and `emissivity` sets how far below the ceiling a cell actually settles.

### Per-cell state — `src/sand/engine.ts`

```ts
/**
 * Optional per-cell temperature in [0, 1]. Allocated by `enableHeat` or on
 * first `setHeat`. Like `stiffnessGrid`, this rides with the material through
 * swaps and levelling transfers, so a hot parcel of lava stays hot as it flows.
 * A host that never allocates it pays nothing.
 */
heatGrid: Float32Array | null = null;

/** Read-neighbours-write-self scratch for the conduction pass. Same lifetime. */
private _heatScratch: Float32Array | null = null;
```

Wire it into every code path that already touches `colorGrid`/`stiffnessGrid`:

- `clear()` — refill with per-cell ambient (not `fill(0)`; see below).
- `setMaterial()` — on material change, set heat to the new material's
  `spawnTemp`, or `ambientTemperature` if absent. This is the one semantic
  difference from stiffness: a freshly-spawned LAVA cell is *born hot*, which is
  the point.
- `swap()` — swap heat alongside grid (the boilerplate block at `engine.ts:390`).
- The levelling transfer in `runLiquidLevelling()` — carry heat with the moved
  cell (the block at `engine.ts:720` that already does this for stiffness).

Cost is 4 bytes per cell for the grid plus 4 for the scratch — 388 KB on a
220×220 planet. `Uint8Array` was considered (256 levels is already 5× the 48 the
ramp hack allows, and integer arithmetic is exactly reproducible) and rejected:
at 1/255 resolution, a conduction step with a small coefficient rounds to zero
and heat stops moving across shallow gradients, producing direction-dependent
artefacts. Float32 plus an explicit equilibrium epsilon gives the same
termination guarantee without the bias.

### Allocation: `0` is a temperature, not a sentinel

`colorGrid` and `stiffnessGrid` can lazily allocate zero-filled because `0`
means "no override, use the material's own value" (`engine.ts:548`). **Heat has
no spare value.** `0` is a legitimate temperature — it is, in fact, *frozen*.

A zero-filled `heatGrid` therefore says every cell in the world is at absolute
cold. One `setHeat` call would allocate it and, on the next
`applyPhaseChanges()`, every untouched LAVA cell in the world would be below
`freezesAt` and flash to ROCK. The lazy-alloc pattern does not transfer.

So allocation always seeds:

```ts
private allocHeat(): Float32Array {
  const n = this.width * this.height;
  const h = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const st = materialDefs[this.grid[i]].spawnTemp;
    h[i] = st === undefined ? this.ambientTemperature : st;
  }
  this._heatScratch = new Float32Array(n);
  return (this.heatGrid = h);
}
```

One O(cells) sweep, once. `enableHeat: true` runs it at construction; `setHeat`
runs it on first call. This — not the per-frame branch cost the earlier draft
cited — is the real reason `enableHeat` earns its place in the API: it makes the
sweep happen at a predictable moment instead of mid-simulation.

### Thermal chunk tracking

`runLiquidLevelling` carries a load-bearing comment (`engine.ts:622-627`): it was
made chunk-major specifically because a per-cell full-grid scan cost 1.5 ms/frame
on a 220×220 planet that had been completely still since frame one. *"A settled
world must cost nothing."* The heat step must honour the same rule, and the three
obvious ways to find thermal cells are not equally good:

- **Full-grid scan** — what `coolLava` does today, so not a regression against
  the showcase, but a straight regression against the engine's stated invariant,
  and paid forever by every heat-using host.
- **Reuse `activeChunks`** — *wrong*, and subtly so. A crusted lava flow is
  motionless: zero swaps, chunk asleep. It must still be cooling. That is the
  volcano's central case, and this option breaks it.
- **A separate thermal activity set** — correct.

So: `thermalChunks` / `nextThermalChunks`, mirroring `activeChunks` /
`nextActiveChunks` exactly, including `wakeChunk`'s border-neighbour logic so
heat crossing a chunk boundary keeps the destination alive. A chunk is woken by
`setHeat`, by `setMaterial` placing a thermal material, by a `swap` that moves a
thermal cell, and by any cell within it changing temperature by more than
`HEAT_EPSILON` during the step.

That last clause is what makes the system terminate. Diffusion asymptotes but
never reaches equilibrium in floating point, so without an explicit epsilon
(`1e-4`) a hot cell and a cold neighbour exchange ever-smaller amounts forever
and no chunk ever sleeps. With it, a thermally equilibrated region goes quiet and
costs nothing, exactly like a settled pool.

Two consequences of the epsilon worth stating rather than discovering:

*Large bodies have a long settling tail.* Equilibration time scales with the
square of a body's size, and the epsilon only truncates the very last
increments — so a 200-cell-wide ocean brought off-equilibrium stays thermally
active for a long time, not because anything is wrong but because that is what
diffusion costs. The chunk tracking bounds the cost to the region genuinely still
moving, which is the right answer, but "heat settles as fast as liquid does" is
not a promise this design makes and shouldn't be tested as one.

*The epsilon is a small permanent bias.* Truncated increments are heat that is
never transferred, so a system that settles under the epsilon holds a residual
gradient of up to roughly `HEAT_EPSILON` per edge rather than being exactly flat.
That is far below both the render tint's resolution and any phase threshold, but
the conservation test must therefore assert to a tolerance derived from the
epsilon and the cell count, not to float epsilon.

The same epsilon gates `markRenderDirty`. Without it, a host tinting by heat
re-renders every chunk every frame forever and the dirty-chunk optimisation is
dead.

### The step

Insert into `update()`, after `runLiquidLevelling()` and before the deferred
explosions, gated on `this.heatGrid !== null` so non-thermal hosts skip it
entirely:

```ts
this.runCheckerboardUpdate(deferredExplosions);
this.runLiquidLevelling();
if (this.heatGrid) {
  this.conductHeat();        // cell <-> cell, conservative
  this.exchangeEnvironment(); // cell <-> world, exposure-scaled
  this.applyPhaseChanges();
}
```

Three sequential sub-steps rather than one fused pass, because each is
individually contractive (neither can push a cell outside the range it started
in) and composing contractive operators stays contractive. Fusing them would
require reasoning about the combined stability bound, which is how the earlier
draft ended up with coefficients that diverge.

**`conductHeat()`** — read from `heatGrid`, write to `_heatScratch`, swap the
references at the end. For each edge between two thermal cells:

```
f = CONDUCTION_MAX * min(conductivity[a], conductivity[b])
q = f * (T[a] - T[b])       // a loses q, b gains q
```

Two properties this buys that the earlier draft's formulation did not:

*It conserves heat.* Precisely: **conservation comes from the coefficient being
a property of the edge rather than of the cell reading it.** In a Jacobi pass,
any coefficient both endpoints agree on makes the pass exactly conservative in
the absence of sources — `min` is not special in that respect, and `max`, the
arithmetic mean, or a constant would all conserve equally well. What the earlier
draft got wrong was using `conductivity[self]`, so the two endpoints of an edge
disagreed about how much crossed it and a hot conductor pushed out more than its
cold insulating neighbour took in.

`min` is then chosen from among the symmetric options for two reasons.
Order-independence: the value cannot depend on which endpoint the loop visits
first, which matters for determinism. And bottleneck fidelity: a good insulator
adjacent to a good conductor should throttle the pair, which `min` gives and the
arithmetic mean does not.

The physically exact choice is the harmonic mean, `2·cA·cB / (cA + cB)` — two
conductances in series, which is what an edge between dissimilar materials
actually is. It is also symmetric and order-independent, so it drops in without
touching anything else. `min` is the cheaper approximation and agrees with the
harmonic mean wherever one material dominates, which is the case that matters
(lava against air-cooled rock, water against lava). If a rock/water boundary
ever looks wrong, swap it; the change is one line and one test.

*It is stable.* `CONDUCTION_MAX = 0.2`. The earlier draft used `conductivity`
directly as the per-neighbour fraction, which is FTCS with `α = conductivity` on
a 4-neighbour stencil — and the max principle requires `α ≤ 1/4`. Every value in
the table above 0.2 would have diverged. Concretely, FIRE at 1.0
(`conductivity` 0.8) with four neighbours at 0.0 moves `0.8 × 4 = 3.2` out in one
step, landing at **−2.2** while each neighbour jumps to 0.8; the next step flips
the sign. Clamping to [0,1] stops the divergence but destroys conservation and
leaves a flickering checkerboard.

To be exact about the bound: the max principle requires the self-weight
`1 − Σf` to be non-negative, i.e. `f ≤ 0.25` on a 4-neighbour stencil, so **0.25
is the actual limit and is not itself wrong.** It is merely attained — self-weight
exactly zero, the update degenerating into a pure neighbour average that a
two-colour grid oscillates on forever — in the degenerate case where all four
neighbours have `conductivity` 1.0. 0.2 is chosen for headroom rather than
correctness: it holds the self-weight at `≥ 0.2` for every value the table can
produce, and costs only a slightly slower approach to equilibrium.

**`exchangeEnvironment()`** — applied in place, after conduction. For each
thermal cell, count `exposed` = orthogonal neighbours that are `EMPTY`:

```
k = exposed > 0 ? 0.4 + 0.6 * exposed / 4 : INSULATED_EXPOSURE  // 0.02
T += emissivity * k * (ambientTemperature - T)
```

The curve is deliberately steep at the first exposed face and shallow after,
copied from `coolLava` (`volcano.ts:~930`) along with the reason it is not
linear: touching air at all is most of the heat loss, and a cell exposed on four
sides is not four times as cold as one exposed on one. A linear `exposed / 4` let
a flow's top surface — exposed on exactly one face, which is nearly every cell of
a flow — cool at a quarter rate, and tongues stayed molten long enough to run
right around the planet as a sheet.

`INSULATED_EXPOSURE = 0.02` is small but nonzero, so a fully buried flow
eventually sets instead of staying molten forever, while a conduit that is
recharged every frame stays live. Same value the showcase uses today.

Since `emissivity ≤ 1` and `k ≤ 1`, the factor is at most 1 and the cell lands
exactly on `ambientTemperature` in the worst case — never past it.

**Heat sources are re-asserted, not excluded.** A `heatSource` cell is read
normally by `conductHeat` — its neighbours draw across the shared edge exactly as
they would from any other cell — and both sub-steps compute a new value for it as
usual. That value is then overwritten with `spawnTemp` in a third short sweep
before `applyPhaseChanges` runs. Excluding sources from conduction instead would
give a fire that nothing can warm itself against, which defeats the purpose.

The order matters: re-assert *after* conduction has read the old buffer, so a
source supplies heat to every neighbour at its full temperature rather than at
whatever it decayed to mid-step. This is the one place heat is created rather
than moved, which is why the conservation property above is scoped to source-free
systems, and why the conservation test must be written on a grid with no
`heatSource` material in it.

**`applyPhaseChanges()`** — a cell whose temperature crossed a threshold
transforms into `freezesInto` / `meltsInto`. Two rules govern it:

*Phase change preserves temperature.* The earlier draft reset the new cell to its
material's ambient, which silently destroys a behaviour the volcano deliberately
has: `FREEZE_TEMP` is 0.30 rather than 0 precisely so that rock keeps cooling
below the freeze point, and *"a flow that has just crusted over still glows and
fades over the next few seconds instead of snapping to grey the instant it stops
moving"* (`volcano.ts:191-197`). Reset-to-ambient is exactly that snap. Lava
freezing at 0.30 becomes rock at 0.30 and fades from there.

Mechanically this means the heat write must come *after* `setMaterial`, which
clears per-cell state on a real material change. The volcano already documents
this ordering hazard for `setTemp` (`volcano.ts:282-286`) and `setMagma` already
gets it right; the engine must do the same.

*Freezing is one-way.* ROCK has no `meltsAt`, so reheating never remelts terrain.
That is intended — the volcano remelts its conduit deliberately and by hand
(`remeltConduit`), and making rock spontaneously liquefy near lava would eat the
conduit walls. Stated here so it is a decision rather than an omission.

Hysteresis where a pair is reversible: WATER boils at 0.70, STEAM condenses at
0.65. The gap matters because a cell hovering mid-band would otherwise flip
between a density-5 liquid that falls and a density-−1 gas that rises every
frame, thrashing the grid. 0.05 is narrow; if it proves too narrow in practice
the fix is a latent-heat budget (accumulate energy at the threshold before
flipping) rather than a wider band, since a wider band makes boiling visibly
lag. The existing steam→empty dissipation in the gas-rising path
(`engine.ts:943`) stays as-is; this only adds the temperature-driven leg.

Determinism: no RNG is involved, and float32 round-trips are exactly specified by
IEEE 754, so identical inputs give identical `heatGrid`s across engines —
**provided the implementation uses only `+ - * /`**. `Math.exp`/`Math.pow` are
implementation-defined in ECMAScript, so an exponential cooling curve would
quietly break cross-engine determinism. Newton's-law cooling above is linear on
purpose.

### Interaction with the existing contact reactions

The earlier draft was silent on this, and it is the difference between a coherent
feature and a decorative one. `stepLavaOrFire` already does, in a single frame
and with no reference to temperature:

- ICE → WATER on contact with lava or fire (`engine.ts:1091`). This branch sits
  *above* the `updated` check at `engine.ts:1099`, so it is genuinely
  unconditional — it fires even on a neighbour already processed this frame.
- LAVA + WATER → ROCK + STEAM (`engine.ts:1103`) — *regardless of the lava's
  temperature*, so a white-hot cell touching one water cell becomes rock.
- FIRE + WATER → the fire becomes EMPTY (`engine.ts:1120`).

The last two sit *below* the `updated` check, so they are gated on the neighbour
not having been processed yet this frame. That gate is worth naming accurately,
because it is weaker than it sounds: it can defer a reaction by a frame, never
prevent one. A lava cell beside water still converts on the next frame the pair
comes up unprocessed. Treating them as merely "conditional" would be the wrong
conclusion — as far as this plan is concerned all three are effectively instant,
and only the reasoning about *why* differs.

Left alone, these pre-empt every phase change this plan proposes. `ICE.meltsAt`
would be decorative in any world containing fire or lava. And the plan's own
motivating example — fire drying out a moat so it can cross *given time* — is
unreachable, because fire adjacent to water is deleted on frame one and never
gets the time.

**Decision: when `heatGrid` is allocated, these three special cases are skipped
and conduction plus phase change does the work instead.** When `heatGrid` is
`null`, the existing instant path runs unchanged, byte for byte.

This keeps the opt-in guarantee exactly (`src/tests/sand-reactions.test.ts`
allocates no heat grid and passes untouched) while making the feature coherent
where it is enabled. The outcomes are the same, just temperature-gated: water
next to lava heats until it boils, lava next to water chills until it sets.

**The other two branches in the same loop stay instant, deliberately.** Neither
the flammability ignition at `engine.ts:1113` nor the FGAS ignition at
`engine.ts:1082` is touched, whether or not heat is enabled. Ignition is not a
thermal threshold in this engine — it is a probabilistic chemical event rolled
against `MaterialDef.flammability`, and wood beside fire catching at 30% per
neighbour-touch is a tuned behaviour with its own tests. Making it thermal would
mean adding an `ignitesAt` and re-deriving every flammability value against a
heat curve, which is a substantially larger change for no benefit this plan
needs. The line is: **phase changes of a substance become thermal; combustion
does not.** If that ever looks inconsistent, `ignitesAt` is purely additive and
can arrive later.

The cost is that quenching stops being instantaneous. With `WATER.conductivity`
0.9 and `LAVA.conductivity` 0.6, `f = 0.2 × 0.6 = 0.12` per edge and a lava cell
at 1.0 touching water at 0.15 moves ~0.10 per frame per contact face — so a
single-face contact converts in roughly seven frames, a three-face contact in
two or three. At 60 fps that reads as a brief flash of white-hot water rather
than an instant swap, which is arguably the better effect, but it is a real
change and the showcase's water sections need a look before it ships.

### Public API

- `setHeat(x, y, t: number): void` — host writes a temperature, allocating and
  seeding `heatGrid` on first call.
- `getHeat(x, y): number` — reads, or returns the material's `spawnTemp` (or
  `ambientTemperature`) when `heatGrid` is unallocated. Once allocated there is
  no fallback path, because every cell holds a real value.
- `PixelEngineOptions.enableHeat?: boolean` — allocate and seed at construction.
- `PixelEngineOptions.ambientTemperature?: number` — the environment temperature
  every exposed cell exchanges toward. Default 0.10. This is the climate dial.

## Migration: simplifying the volcano helper

This is the proof the design is right. Once heat exists in the engine, the
volcano helper loses ~250 lines:

- **Delete** `TEMP_STEPS`, `FREEZE_TEMP`, `RAMP_STOPS`, `TEMP_RAMP`,
  `RAMP_INDEX`, `tempAt`, `setTemp`, `tempFor`, `magmaTexture`, `reservoirTemp`
  (`volcano.ts:188-296`). All of it becomes `engine.setHeat(x, y, t)`.
- **Delete `coolLava`** (`volcano.ts:896-968`) — the engine's
  `exchangeEnvironment` is the same exposure rule with the same curve and the
  same insulated factor, and `applyPhaseChanges` handles lava→rock including the
  supported-only guard.
- **Keep** the conduit pressurization and plume emission — those are *geometry*,
  not thermodynamics, and legitimately belong to the host. The `stiffnessGrid`
  write in `pressurizeConduit` becomes a `setHeat` write: fresh magma is hot
  (fluid), aged magma is cool (stiff), and the engine's freeze threshold does
  the rest.
- **Keep `stiffnessForTemp`** and the per-frame `stiffnessGrid` write for now.
  Deriving stiffness from heat inside the engine is the obvious follow-up, but it
  is a separate decision (it would make `stiffnessGrid` a *derived* quantity
  rather than a host input, which is a bigger contract change than this plan
  should carry) and is deliberately out of scope.
- The thermally-coloured render the showcase currently gets for free from the
  ramp-in-`colorGrid` moves to the host's renderer: the host maps `getHeat` → a
  colour tint. This is the one regression — it's cosmetic, and it's the right
  place for it (rendering is the host's job per the engine's contract). It also
  retires the ramp/tephra disjointness invariant entirely.
- **`showcase/tests/volcano.test.ts` is rewritten, not merely kept green.** It
  imports `coolLava`, `tempAt`, `setTemp`, `TEMP_RAMP`, `TEMP_STEPS` and
  `FREEZE_TEMP` directly (lines 8–26) and asserts on ramp internals. Roughly a
  third of that file goes away with the apparatus it pins; the behavioural
  assertions (flows stop, fronts stall, the cone builds) port over and are the
  real acceptance test for the engine-side implementation.

Net: the volcano helper shrinks to its geometric essence, and any future host
gets temperature for free instead of re-implementing the ramp hack.

## Backward compatibility

Strictly additive and opt-in:

- Every new `MaterialDef` field is optional. A material that sets none is
  completely untouched by the heat step.
- `heatGrid` is `null` by default. `conductHeat` / `exchangeEnvironment` /
  `applyPhaseChanges` are guarded on `this.heatGrid !== null`, so a host that
  never calls `setHeat` and does not set `enableHeat` pays literally zero — the
  branch is never taken and no chunk is ever marked thermally active.
- The contact-reaction change in `stepLavaOrFire` is behind the same guard, so
  the existing instant path is byte-identical when heat is off.
- No existing test changes for the engine commit. The 83 engine tests allocate no
  heat grid and keep passing unchanged.

The one behavioural change is LAVA gaining `spawnTemp`/`freezesAt` — but only on
hosts that opt into heat. A host that doesn't allocate `heatGrid` gets the same
molten-forever lava as today. This is the same opt-in discipline that made
`yieldThickness` safe to ship.

## Files touched

- `src/materials/materials.ts` — add the thermal `MaterialDef` fields, values on
  LAVA/FIRE/ICE/WATER/STEAM/ROCK/SAND/WOOD/WALL, and the `isThermal` lookup.
- `src/materials/index.ts` — export `isThermal`. This barrel is an explicit
  named-export list, not `export *`, so a new symbol that isn't added here is
  invisible to the package root even though `materials.ts` exports it.
- `src/sand/engine.ts` — add `heatGrid`, `_heatScratch`, `thermalChunks`,
  `setHeat`/`getHeat`, wire into `clear`/`setMaterial`/`swap`/levelling, add
  `conductHeat`/`exchangeEnvironment`/`applyPhaseChanges` to `update()`, gate the
  three contact reactions in `stepLavaOrFire`, and add `enableHeat` /
  `ambientTemperature` to `PixelEngineOptions` — which lives **here**, at
  `engine.ts:93`, not in `types.ts`. `src/sand/types.ts` holds only
  `NeighborFrame` and `CellOffset` and is not touched by this work.
- `src/sand/index.ts` — already re-exports `PixelEngineOptions`, so the new
  options need no change here; add any new public constants
  (`CONDUCTION_MAX`, `HEAT_EPSILON`) if they are exported.
- `src/index.ts` — no change needed beyond what the two barrels above carry, but
  worth a check: everything public reaches the package root through them.
- `src/tests/heat.test.ts` (new) — see below.
- `docs/integration.md` — new "Temperature" section, mirroring the yield-strength
  section's depth; note the interaction with the `stiffnessGrid` guidance at
  line 90.
- `showcase/helpers/volcano.ts` — migrate to `setHeat`/`getHeat`, delete the
  ramp apparatus (separate commit, after the engine lands).
- `showcase/tests/volcano.test.ts` — rewritten alongside the helper.
- The showcase renderer — grows a `getHeat` → tint path to replace the ramp.

## Test plan

Each test opens with a comment naming the regression it pins (house style):

- **Opt-in no-op**: a host with no `heatGrid` produces byte-identical grids to
  today across N frames, including through lava/water/ice contact. (The
  backward-compat guarantee — the load-bearing one, and it now has to cover the
  gated contact reactions too.)
- **Conduction conserves heat**: sum of `heatGrid` over a closed system with
  zero exposure and **no `heatSource` material present** is invariant across 100
  frames, to a tolerance of `HEAT_EPSILON × cellCount` rather than float epsilon.
  Both qualifiers are load-bearing: a source creates heat by design, and the
  settling epsilon truncates transfers by design, so a stricter test would fail
  on correct code. (Catches the one-sided-coefficient bug directly.)
- **Heat sources conduct rather than sit inert**: a cell adjacent to FIRE rises
  toward `FIRE.spawnTemp`, and FIRE itself reads exactly `spawnTemp` after the
  step regardless of what its neighbours did. (Pins the Dirichlet-node
  semantics — an implementation that skips sources in `conductHeat` passes the
  second half and fails the first.)
- **Thresholds above a source are unreachable**: a water cell fully enclosed by a
  source held below `WATER.meltsAt` never boils, however many frames run. (Pins
  the asymptote constraint, and fails loudly if someone later raises a threshold
  past a source temperature.)
- **Fire boils water it is in contact with**: the calibration target from the
  reachability section — one flame face plus one exposed face reaches STEAM
  within N frames. This is the test that would have caught the earlier draft's
  unreachable moat example, and it is the reason `FIRE.spawnTemp`,
  `WATER.emissivity` and `WATER.meltsAt` must move as a group.
- **Conduction obeys the max principle**: after a step, no cell exceeds the max
  of its prior 5-cell stencil or falls below the min — asserted on a
  worst-case grid (a single cell at 1.0 with `conductivity: 1` neighbours at
  0.0). The earlier draft's test — *"a neighbour rises by ≤ conductivity × ΔT"*
  — would have **passed** while the scheme diverged, which is why it is replaced
  rather than kept.
- **Diffusion is bounded in space**: a cell 3 away from a hot cell is unchanged
  after 1 frame.
- **Exposure drives cooling**: a lava cell with 3 exposed faces cools strictly
  faster than one with 1, which cools strictly faster than a fully buried one.
  (The inverted-cooling bug the two-term model exists to prevent.)
- **Ambient is the climate dial**: the same world with `ambientTemperature: 0.02`
  freezes its water within N frames; at 0.10 it does not.
- **Lava freezes below threshold**: a LAVA cell set below `freezesAt` becomes
  ROCK after a step; above it, stays LAVA.
- **Supported-only freeze**: an airborne LAVA cell below threshold does *not*
  freeze (no phantom frozen bombs — the volcano guard generalised).
- **Phase change preserves temperature**: lava freezing at 0.30 yields ROCK at
  0.30, not ROCK at ambient. (Pins the cooling-glow behaviour.)
- **Ice melts, water boils, steam condenses**, and a cell held mid-band at 0.67
  does *not* oscillate between WATER and STEAM across 100 frames.
- **Heat rides with material**: heat a LAVA cell, `update()` so it moves, assert
  the heat travelled with it — through both the swap path and the levelling
  transfer path.
- **Allocation seeds correctly**: place lava, then `setHeat` on a distant cell;
  the lava is still molten and does not flash to rock. (Pins the
  `0`-is-not-a-sentinel fix.)
- **Determinism**: same seed + same `setHeat` calls → identical `heatGrid` and
  `grid` (`expect(run()).toEqual(run())`).
- **Thermally settles to a dead stop**: after a thermal system equilibrates,
  zero thermal chunks are active and zero chunks are marked render-dirty.
  Asserting `swapsLastFrame === 0` here — as the earlier draft did — is
  meaningless, since diffusion performs no swaps and the assertion passes
  trivially while the engine burns a full-grid pass every frame.

## Open questions

None of these change the data model; they are calibration.

1. **Diffusion neighbourhood**: 4-neighbour (von Neumann) vs 8-neighbour
   (Moore)? 4 is cheaper and isotropic enough at this scale; leaning 4. Note
   that Moore tightens the stability bound (`CONDUCTION_MAX` would drop to
   ~0.1), so this is not a free swap.
2. **Quench feel**: is a ~7-frame lava/water conversion acceptable, or does it
   need a dedicated fast path? Knobs in order of preference: raise
   `WATER.conductivity`, or count water faces as partial environment exposure the
   way `isCold` does today. Leaning "ship it and look at it".
3. **Should heat capacity exist?** Today one cell of STEAM and one of ROCK are
   thermally identical masses, since there is no `ρc` term. That is a deliberate
   simplification, not an oversight — but if steam turns out to heat rock
   implausibly fast, a per-material `heatCapacity` divisor is the smallest
   possible fix and is purely additive.

## Delivery

Split into three commits. The first is independently valuable and could ship
alone.

**(a) Storage.** `heatGrid` + `_heatScratch` + thermal chunk tracking +
`setHeat`/`getHeat` + allocation seeding + the swap/levelling/clear/setMaterial
wiring. No diffusion, no phase change. The volcano migrates onto it and keeps its
own `coolLava`, which deletes the ramp hack and the disjointness invariant
immediately. ~1.5 days including tests.

**(b) The thermal step.** `conductHeat` + `exchangeEnvironment` + the equilibrium
epsilon. Retires `coolLava`. ~1.5 days, most of it calibrating against the
existing flow morphology, which is the part with real risk — the current
behaviour is tuned and the port has to match it.

**(c) Phase changes.** `applyPhaseChanges` + gating the three contact reactions +
the ice/water/steam values. ~1 day, plus the showcase water-section review.

Docs and the volcano test rewrite ride along with (a) and (b): ~1 day.

**~5 days total.** The earlier estimate of 2.5 assumed a single-term conduction
model with no chunk tracking, no seeding sweep, and no interaction with the
existing reactions. It still retires the largest piece of host-side duplication
in the project.
