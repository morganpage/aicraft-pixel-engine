# Plan: growth — spreading, branching, and aggregating life

> Status: **implemented**. See `src/tests/sand-growth.test.ts` and the "Growth"
> section of [integration.md](./integration.md). The design below stands as
> written; the ways contact with the engine changed it are recorded under
> [As built](#as-built) at the end.

## As built

Seven things the design got wrong or left out, each found by running it. They are
listed here rather than edited silently into the text above, because in every
case the reasoning that produced the wrong answer is the interesting part.

1. **`needs` had to move to the source, and grew a `range`.** The plan argued at
   length that every spread condition belongs at the target. That is right for
   crowding and wrong for a resource: target-side moisture confines grass to the
   one ring of cells physically touching water, so a pond grows a fringe and a
   meadow is unreachable at any `chance`. `needs` is now checked at the source
   and carries a `range` — a reach counter that refreshes on contact, decrements
   into each child, and stops at zero. It rides in the spread cell's state word,
   which was otherwise only holding a backoff counter.

2. **Ground cover needed `needsFooting`.** Grass permitted to spread upward at
   all did so without limit and built a tangle standing several cells clear of
   the soil. The reach limit bounds how far it gets, not whether it is touching
   anything. Footing must also exclude the growing material itself, or grass
   grows its own footing and goes up in one-wide columns.

3. **Diagonal limbs collapsed, so tips brace their corners.** The support test
   is cardinal-only, so a 45° chain of trunk cells touches only at the corners
   and is unsupported along its whole length. Traced on a 24-energy tree: every
   trunk cell written after a diagonal step fell one row on the following frame.
   Tips now fill one corner cell per diagonal step.

4. **Wobble had to stop being a turn.** Storing the wobbled heading let it
   accumulate with no restoring force: one wobble on frame 3 sent a whole trunk
   off at 45° for its life. Only a genuine blockage now rewrites the heading —
   `preferOpen` and wobble decide the step, not the direction.

5. **The canopy-collapses-when-burnt idea had to be abandoned, and it was the
   design's favourite argument.** `LEAF` was `needsSupport` so that burning a
   trunk would bring its foliage down — cited throughout as the proof that
   growth composes with the destructive rules. It cannot work. Support is
   satisfied only by structural cells and `LEAF` must not be one (leaves holding
   up leaves turns a collapse into a one-cell-per-frame drizzle), so a leaf can
   survive only cardinally adjacent to wood. That permits a one-cell fringe
   along a branch and makes a *canopy* — leaves two or more cells from any
   branch — physically impossible. An 11-energy tree grew as a bare stick with a
   few green specks, which is precisely what the rules allowed and nothing like
   a tree. Foliage is now static; fire clears it instead, which is the
   genre-standard behaviour and still a real composition. `FROND` (21), added
   because a fern built of `LEAF` collapsed into a heap, now earns its id on
   palette alone.

6. **Scale is a parameter, and the default was wrong by 3×.** Germination at
   `energy: 26` put a tree three quarters of the way to the centre of the
   showcase's r=66 planet. Trees are silhouettes seen against a world, so the
   number has to be set against that world's size; 10 reads correctly. Branch
   taper came down with it — at 0.55 over three generations the lowest limbs
   were longer than the trunk was tall, and the tree read as a spider.

7. **The membership invariant is a superset, not an equivalence.** The reaction
   steps write `this.grid[i]` directly, so grass burning to FIRE leaves its index
   behind. This is safe because no direct write anywhere in the engine produces a
   material that has a growth rule — stale entries can only ever be spurious,
   never missing — and the pass drops them as it goes. The behaviour depends on
   the superset half; exactness returns after each growth tick.

The estimate held: five phases, ~6 days of scope. Phase 2 was indeed where the
time went, and for the reason predicted — items 2 through 6 above are all "run
it and look at it", which does not compress. Note how many of them are the same
mistake: a rule that was sound in the abstract, and wrong once something had to
be *looked at*. None of them would have been caught by reasoning harder.

---

> Original design document below, unchanged (v2, supersedes the spread-only v1).
> Builds on [temperature](./plan-temperature.md) but is independently useful.

## The problem

Every reaction in the engine today is **destructive**: lava consumes water, acid
dissolves solids, fire burns flammables, FGAS ignites. There is no rule where a
cell *creates* a new cell from its neighbours. That single gap is the fourth
pillar of a terraforming god game — the "watch a dead rock come alive" fantasy.

Land, sea, and fire are well-served. Life is not.

But "life" is two different problems wearing one word, and v1 of this plan only
solved the easy one:

- **Spreading** — moss, grass, algae, mould. Isotropic, stateless, memoryless. A
  cell looks at its neighbours and maybe copies itself. This is a one-function
  feature.
- **Structure** — trees, ferns, vines, coral. *Directed* and *stateful*. A trunk
  knows which way it is going, how much budget it has left, and how deep in the
  branch hierarchy it sits. No amount of isotropic spreading produces a tree; it
  produces a blob. Grass is a texture. A tree is a silhouette, and silhouettes
  are what make a world read as alive.

This plan covers both, because the second one is where the pillar actually lands
— and because, as the survey below shows, the second one is a small amount of
extra machinery on top of the first.

## How other sims do it

Every falling-sand sim that grows convincing plants converged on the same three
ideas, and the ones that skipped them grow blobs. Worth stating plainly, because
it is the strongest argument for the shape below.

**The Powder Toy: VINE** is the naïve version, and it is instructive. Each tick
it picks a random offset in `(-1..1, -1..1)`, and if that cell is empty spawns a
new VINE there, then converts *itself* to PLNT
([source](https://github.com/The-Powder-Toy/The-Powder-Toy/blob/master/src/simulation/elements/VINE.cpp)).
The tip-advances-and-leaves-structure-behind mechanic is exactly right. The
random direction is what makes it a creeper and not a tree — with no directional
memory, there is no trunk.

**The Powder Toy: PLNT in tree mode** is the mature version, and it is close to
what is proposed here. Each particle packs a growth word into `ctype`:
`(life << PLNT_LIFE) | (direction << PLNT_DIR) | (phase << PLNT_PHASE) | tree_flag`
([source](https://github.com/The-Powder-Toy/The-Powder-Toy/blob/master/src/simulation/elements/PLNT.cpp)).
Concretely:

- `life` is a growth budget that decrements as the tip advances; at zero, growth
  stops and the cell converts to WOOD (or GOO with lateral wood, for thick stems).
- `direction` is a **3-bit octant**. Branches are `ndir = (dir + phi + 6) % 8`
  for `phi` in `0..4`, i.e. −90°, −45°, 0°, +45°, +90° off the parent heading.
- Branch budget tapers: `nlife = (2 * life) / 3`.
- **Gravity matters**: `Element_PLNT_detectDown()` normalizes the actual gravity
  field (`hypot(pGravX, pGravY)`) and penalizes downward branches — straight
  down gets `life / 3`, sideways-down `life / 2`. That is gravitropism, computed
  from a *field*, in a sim that also has non-uniform gravity.
- A 5-bit `bmask = prog & 0x1F` decides which of the five branch directions this
  particular plant is allowed to use — a per-plant **genome**, so one material
  yields many silhouettes.
- Growth is throttled (`chance(9,10)` to skip) and **temperature-gated**:
  `if (temp > 343.15f || temp < 278.15f) return 0` — 5 °C to 70 °C.
- On termination it may fire a SEED forward, closing the life cycle.

**Sandspiel** stores two spare bytes per cell — `Cell { species, ra, rb, clock }`
— and uses them for exactly this
([species.rs](https://github.com/MaxBittker/sandspiel/blob/master/crate/src/species.rs)).
Its SEED is a three-stage state machine: `rb == 0` means still falling; landing
on Sand/Plant/Fungus germinates it by setting `rb = rand(1..253)` (a per-plant
genome); then `ra` runs down through stem (`ra > 60`), petals (`40 < ra < 60`),
and reproduction (`ra < 40`, drops a new Seed into adjacent water). The stem step
moves the tip up one cell, decrements `ra`, and writes `Plant` into the cell it
vacated. Two details worth stealing outright:

- It refuses to grow if the cells flanking the *target* already hold Plant —
  crowding is checked around the **destination**, not the source.
- A tip that cannot advance is set to `EMPTY_CELL`. Tips die. Nothing in
  Sandspiel can become an infinite plant factory.

**Noita** grows grass spontaneously from exposed soil and ships Seed / Plant
Material / Vine as powder materials with growth variants — the isotropic tier,
driven off material data rather than code
([Grass](https://noita.wiki.gg/wiki/Grass), [Seed](https://noita.wiki.gg/wiki/Seed_(Material))).

Outside the falling-sand genre, two classical algorithms are worth naming
because they cover the shapes a directed tip does *not*:

- **Diffusion-limited aggregation** — random walkers that stick on contact with
  a cluster. It is the canonical model for coral, frost, lichen, dendrites and
  mineral deposits ([overview](https://en.wikipedia.org/wiki/Diffusion-limited_aggregation)).
  Textbook DLA needs *isotropic* walkers, which this engine does not have — see
  the honest accounting under `AggregateRule` below — but the contact-and-stick
  half of it is one rule away.
- **Space colonization** (Runions et al.,
  [paper](https://algorithmicbotany.org/papers/colonization.egwnp2007.large.pdf))
  treats competition for space as the thing that determines branch structure.
  The full algorithm needs attraction points and nearest-node queries, which do
  not belong in a per-cell CA — but its premise reduces to a cheap heuristic:
  *prefer the heading with the most open space*. That single line buys
  phototropism and stops neighbouring trees from growing through each other.

**Takeaway.** Three tiers, not one: isotropic **spread** (grass, moss), directed
stateful **tips** (trees, ferns, vines), and contact **aggregation** (coral,
germination). Every one of them needs a small per-cell state word, and every
mature implementation has one.

## What v1 got wrong

v1 put a `stepGrowth` branch inside the reaction dispatch at engine.ts:889-909.
Three facts about the engine make that placement unworkable, and all three are
fixed by moving growth to its own pass:

1. **Sleeping chunks kill growth.** `runCheckerboardUpdate` skips inactive
   chunks ([engine.ts:853](../src/sand/engine.ts:853)), and chunks only stay
   awake via `wakeChunk`. A settled world stops growing forever — which is
   precisely the "place water, walk away, come back to a forest" scenario.
2. **Static materials never reach the dispatch.** The movement loop early-outs
   on `EMPTY/WALL/ROCK/ICE` ([engine.ts:867](../src/sand/engine.ts:867)) before
   any reaction runs, and supported WOOD `continue`s at
   [engine.ts:875](../src/sand/engine.ts:875). So a plant is either mobile
   (wrong — v1's GRASS had `density: 20` and would have sunk through SAND at 10)
   or never dispatched.
3. **Growth is spontaneous; the engine is event-driven.** Movement is triggered
   by imbalance and stops. Growth has no trigger — it just proceeds. Bolting it
   onto the movement scan forces a choice between "never grows" and "never
   sleeps."

A separate pass over a maintained candidate set resolves all three at once, and
makes cost proportional to the number of *living* growth cells rather than to
grid area.

## Why this belongs in the engine, when clouds and volcanoes don't

The showcase deliberately keeps two "alive"-looking systems *outside* the
engine, and [cloud.ts:4](../showcase/helpers/cloud.ts:4) opens with a section
titled "Why this is a host-side helper, not an engine material." A plan that
moves in the opposite direction owes an argument.

The cloud's reason is a **capability gap**: the engine has no buoyancy or
pressure term, so a body of vapour cannot hold station at an altitude — a cloud
is not expressible as a per-cell rule *at all*, at any level of engine support
short of a pressure solve. It is a non-local logical entity that happens to
spawn WATER. The volcano's conduit is the same shape of thing: geometry the host
advects, which merely writes cells.

Growth is the opposite case, and the line is clean:

> **Local per-cell rules belong to the engine; non-local logical entities belong
> to the host.**

A tip is a single cell reading its own state word and its immediate
neighbourhood — the same shape as `stepAcid`, and nothing like a cloud. Three
properties then force it inside rather than beside:

- **Determinism.** integration.md promises "same seed + same sequence of public
  calls → identical grid evolution," and the seeded RNG is engine-owned. A
  host-side growth loop either draws from `engine.random()` — perturbing the
  stream mid-frame in a way no other host does — or from its own generator, and
  the guarantee stops being a guarantee.
- **Serialization.** A tree must survive a save/load round-trip. Engine-owned
  state does, by the same mechanism as `stiffnessGrid`; a parallel host-side map
  keyed by cell index does not survive the cells moving.
- **Chunk coupling.** Growth has to see sleeping chunks and wake them, which
  means reaching into `activeChunks`/`nextActiveChunks` — bookkeeping
  integration.md explicitly assigns to the engine as "the simulation authority."

A cloud needs none of the three: it is not deterministic-critical, it is not
saved, and it never touches chunk state. That is the actual dividing line, and
it puts growth inside without contradicting either helper.

## Design

Three growth kinds, one opt-in field, one shared per-cell state word.

```
MaterialDef.growth?: GrowthRule
                       ├── kind: 'spread'     — grass, moss, algae      (Phase 1)
                       ├── kind: 'tip'        — trees, ferns, vines     (Phase 2)
                       └── kind: 'aggregate'  — coral, germination      (Phase 3)
```

A material that sets no `growth` is untouched — byte-identical to today.

### Engine prerequisite 1: two hardcoded rules become data

`MaterialDef` gains two flags that *describe behaviour the engine already has*,
so new materials stop requiring edits to hardcoded lists:

```ts
/**
 * This material never moves under gravity. The movement scan skips it
 * outright, exactly as it already hardcodes EMPTY/WALL/ROCK/ICE.
 *
 * Vegetation needs this. A plant is not a powder: without it a GRASS cell
 * with density 20 outweighs SAND at 10 and sinks through the soil it is
 * supposed to be rooted in.
 */
isStatic?: boolean;

/**
 * This material falls unless an adjacent cell is structural — the rule WOOD
 * already has, generalised. Absent = no support requirement.
 *
 * This is what makes a burning forest collapse instead of leaving foliage
 * hanging in the air, and it is the reason LEAF is not simply `isStatic`.
 */
needsSupport?: boolean;
```

`isStatic` replaces the literal list at [engine.ts:867](../src/sand/engine.ts:867);
ROCK/WALL/ICE set it, and the comparison chain becomes `def.isStatic`.
`needsSupport` replaces the WOOD special-case at
[engine.ts:869-876](../src/sand/engine.ts:869); WOOD sets it.

These are refactors, not rewrites, but "byte-identical by construction" is the
wrong claim for them — they are identical *if the migration is complete*, which
is a property of the port, not of the design. Two specifics the port must
preserve exactly: the existing support check consults only the four **cardinal**
neighbours (a diagonally-braced WOOD cell falls today), and it tests
`isStructural`, which is `WALL/ROCK/WOOD/ICE` — not "any solid." Before treating
the refactor as free, confirm the existing suite actually covers the diagonal
case; if it doesn't, that test comes first.

### Engine prerequisite 2: growth is its own pass

```ts
update(): void {
  this.clearUpdatedInActiveChunks();
  // ...
  this.runCheckerboardUpdate(deferredExplosions);
  this.runLiquidLevelling();
  if (this.growthCells.size > 0) this.runGrowth();   // ← new
  for (const pt of deferredExplosions) this.explode(pt.x, pt.y, 8, 3);
  // ...settle bookkeeping
}
```

- **Candidate set.** `growthCells: Set<number>` holds the indices of cells whose
  material has a `growth` rule. Maintained in `setMaterial` (add/remove on
  material change), `swap` (transfer membership), and `clear` (empty it). Cost
  is O(living growth cells), not O(grid).

  **Membership invariant** — the load-bearing one, and worth stating outright
  rather than leaving implicit:

  > `idx ∈ growthCells` ⟺ `materialDefs[grid[idx]].growth !== undefined`

  Membership is a *pure function of the grid*, never of history. That is what
  makes a world reconstructed from a serialized grid behave identically to one
  built incrementally — the set carries no information the grid doesn't already
  hold. `rebuildGrowthCells()` (a full scan, host-callable after
  deserialization) restores it from nothing, and asserting the invariant
  directly is a cheaper, sharper test than comparing two evolved worlds.

  Note the set is keyed by cell index, so it dedupes by construction: one cell
  holds one material and therefore contributes at most one entry. That is the
  intent, not lost state.
- **Chunk-independent.** The pass does not consult `activeChunks`, so a settled
  world keeps growing. It still calls `wakeChunk`/`markRenderDirty` on every
  write, so anything it creates rejoins the normal simulation.
- **Throttled.** Runs only when `frameCount % growthInterval === 0` (default 4).
  At 60 fps a tip advances 15 cells/second, so a 26-cell tree takes under two
  seconds — legible, not instant.
- **Snapshot + stable order.** The pass iterates a snapshot of the set sorted
  ascending by cell index. Snapshotting means a cell created this tick does not
  act until the next one, so a whole tree cannot appear in one frame. Sorting by
  index (rather than `Set` insertion order) means growth is reproducible from a
  *serialized grid*, not merely from an identical run — which matters for save
  files and for the determinism test.
- **No `updated` writes.** Both movement passes are already finished when growth
  runs, so there is nothing to guard against in-frame, and skipping it avoids a
  stale-flag hazard (`clearUpdatedInActiveChunks` runs before the active/next
  swap, so a chunk woken during growth is cleared a frame late).

### Engine prerequisite 3: `growthGrid`, the per-cell state word

The engine already ships this pattern twice — `colorGrid` and `stiffnessGrid`:
an optional, lazily-allocated per-cell array that rides with the material
through swaps and levelling transfers. (The temperature plan proposes a third,
`heatGrid`, on the same shape; that one is a proposal, not precedent, and the
argument here doesn't lean on it.) Growth needs one of its own, and it is what
separates a tree from a stain.

```ts
/**
 * Optional per-cell growth state, lazily allocated on first `plant()`/growth
 * write. Rides with the material through swaps, like `stiffnessGrid`.
 *
 * The word is interpreted by the cell's growth *kind*:
 *
 *   tip:     bits 0–6   energy   0–127 remaining growth budget
 *            bits 7–9   dir      0–7   gravity-relative octant heading
 *            bits 10–11 gen      0–3   branch depth
 *            bits 12–15 variant  0–15  per-plant genome (branch mask)
 *
 *   spread:  bits 0–6   retryIn        ticks until the next attempt
 *            bits 7–15  unused
 *
 * 2 bytes/cell, and only for hosts that grow anything. The layout mirrors The
 * Powder Toy's PLNT `ctype` word and Sandspiel's `ra`/`rb` registers, for the
 * same reason both arrived there: directed growth is impossible without
 * per-cell memory, and a packed word is the cheapest place to keep it.
 */
growthGrid: Uint16Array | null = null;
```

`packGrowth(energy, dir, gen, variant)` / `unpackGrowth(word)` helpers live
beside it. `setMaterial` clears the word on material change, matching how it
already clears `colorGrid` and `stiffnessGrid`
([engine.ts:360-365](../src/sand/engine.ts:360)).

**On the field widths.** Energy gets 7 bits rather than the 6 a naïve port of
TPT's `life` would use, because TPT's trees are particle-scale and these are
silhouette-scale. At the documented 15 cells/second, a 63-cell budget caps a
tree at ~4 seconds of growth and leaves no headroom to tune "taller" — 127
doubles that ceiling at zero cost. The bit comes from `gen`, which only needs to
express `maxGen`; capping branch depth at 3 is a real constraint, but a
4-generation tree from a 26-energy trunk has twigs of one cell, so the width is
not what limits it.

**`variant` is the genome.** Seeded once per plant from `random()` and inherited
unchanged by every branch, it selects which turns that plant may branch into.
Sixteen silhouettes from one material, all deterministic — TPT's `bmask` idea,
which is why its forests do not look stamped.

### Engine prerequisite 4: gravity-relative octants

Directed growth needs all eight headings, and it needs them relative to gravity
so a tree on a planet grows radially outward rather than toward screen-up. This
is the one place gravity-relativity genuinely earns its keep (v1 applied it to
an unordered 4-neighbour set, where it is a no-op).

`NeighborFrame` supplies five of the eight
([neighbors.ts:99-103](../src/sand/neighbors.ts:99)); the other three are
negations. Added to `neighbors.ts`, which the module header names as the *only*
module that knows about gravity direction:

```ts
/** Octant 0–7, clockwise from "up" (= −down). */
export function octantOffset(frame: NeighborFrame, octant: number, out: Vec2): void
//  0 up        = −down          4 down
//  1 upRight   = −downLeft      5 downLeft
//  2 right                      6 left
//  3 downRight                  7 upLeft = −downRight
```

Worth verifying once and then trusting: at 45° gravity `down = (1,1)`,
`left = (-1,1)`, `downLeft = (0,1)`, `downRight = (1,0)`, which makes the eight
octants `{(-1,-1),(0,-1),(1,-1),(1,0),(1,1),(0,1),(-1,1),(-1,0)}` — the full
8-neighbourhood, rotated. The octant set is a permutation of the neighbourhood at
*any* gravity angle, which is exactly why eight directions work where v1's
four-direction subset did not.

## Data model — `src/materials/materials.ts`

```ts
export type GrowthRule = SpreadRule | TipRule | AggregateRule;

/** Gravity-relative octant, 0 = up (away from gravity), clockwise. */
export type Octant = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
```

### `SpreadRule` — grass, moss, algae

Isotropic copying, with the v1 bugs fixed: crowding is measured around the
target, the target is chosen uniformly instead of first-wins, and a saturated
cell backs off instead of re-checking forever.

```ts
export interface SpreadRule {
  kind: 'spread';

  /** What appears in the target cell. Usually the material itself. */
  into: MaterialType;

  /** What the source becomes after a successful spawn. Absent = unchanged. */
  becomes?: MaterialType;

  /** Materials the target may overwrite. Default `[EMPTY]`. */
  intoMaterial?: MaterialType[];

  /**
   * Required materials in the **target's** 8-neighbourhood — pinned to the
   * target, not the source, and not "somewhere nearby". Grass needs WATER, so
   * a lawn advances toward moisture and stops where the ground is dry.
   */
  needs?: MaterialType[];

  /** Headings allowed, gravity-relative. Default: all eight. */
  directions?: Octant[];

  /**
   * Refuse to spawn if the **target** already has more than this many `into`
   * neighbours. Counted at the destination, which is what actually bounds
   * coverage — a source-side count only slows the interior down while the
   * frontier keeps expanding at the same final extent.
   */
  maxNeighbors?: number;

  /** Probability per growth tick, 0–1. Rolled against `engine.random()`. */
  chance: number;
}
```

**Dormancy.** A spread cell that finds no eligible target writes an exponential
backoff into its state word (1, 2, 4 … capped at 64 growth ticks) and skips
until it expires. Any `wakeChunk` covering the cell resets it to 1. A mature
grass field therefore costs one neighbourhood scan per cell every ~256 frames,
and — the part that matters for turn-based hosts — emits zero growth events, so
settle detection still reaches a dead stop.

### `TipRule` — trees, ferns, vines

The structural tier. A tip is a mobile, ephemeral cell that advances along its
heading, leaves structural material behind, occasionally forks, and dies.

```ts
export interface TipRule {
  kind: 'tip';

  /** What the tip leaves behind as it advances — the trunk/stem. */
  becomes: MaterialType;

  /** What the tip turns into when it stops (out of energy, or blocked). */
  terminal: MaterialType;

  /** Materials the tip may grow into. Default `[EMPTY]`. */
  intoMaterial?: MaterialType[];

  /** Chance per advance of veering ±1 octant. 0 = ruler-straight. */
  wobble?: number;

  /** Octant turns a branch may take, e.g. `[-1, 1]` (45°) or `[-2, 2]` (90°). */
  branchTurns?: number[];

  /** Stochastic branching (trees). Probability per advance per turn. */
  branchChance?: number;

  /**
   * Deterministic branching (ferns): fork every N cells of energy instead of
   * by chance. A frond's pinnae are regularly spaced; a tree's limbs are not.
   * This one field is the difference between the two silhouettes.
   */
  branchEvery?: number;

  /** Child energy = floor(parent energy × taper). Default 0.6. */
  branchTaper?: number;

  /** Maximum branch depth. Default 3, and 3 is the ceiling (`gen` is 2 bits). */
  maxGen?: 0 | 1 | 2 | 3;

  /** Don't branch below this energy — keeps twigs from forking. Default 4. */
  branchMinEnergy?: number;

  /**
   * Bias each advance toward the heading with the most open space within a
   * 2-cell probe. The cheap CA reduction of space colonization's premise: what
   * shapes a canopy is competition for room. Costs ~6 lookups per advance and
   * stops adjacent trees from growing through each other.
   *
   * Ties must break deterministically — toward the current heading, then by
   * ascending octant. A sort whose behaviour on equal keys is unspecified would
   * quietly make the determinism guarantee depend on the engine's sort.
   */
  preferOpen?: boolean;

  /** Foliage scattered along the branches as the tip advances. */
  foliage?: { into: MaterialType; chance: number };

  /** Cluster stamped where a tip terminates. Radius in cells, 1 = the 8-ring. */
  canopy?: { into: MaterialType; radius: number };

  /** On termination, maybe drop a seed — closes the life cycle. */
  seeds?: { into: MaterialType; chance: number };
}
```

### `AggregateRule` — coral, germination

The contact tier, and the cheapest of the three: a cell transforms *itself* on
contact, rather than writing into a neighbour.

```ts
export interface AggregateRule {
  kind: 'aggregate';

  /** Transform when adjacent to any of these. */
  contact: MaterialType[];

  /** What this cell becomes. */
  into: MaterialType;

  /** Probability per growth tick. */
  chance: number;

  /** Initial growth state for the produced cell — used to sprout a tip. */
  state?: { energy: number; dir: Octant | 'up'; variant?: 'random' | number };
}
```

Two jobs, one rule. A SEED with `contact: [SAND], into: TREE_TIP, state: {
energy: 26, dir: 'up', variant: 'random' }` is germination — the job v1 could not
express at all (v1's SEED wrote WOOD into a *neighbour* and never consumed
itself, making it an infinite wood factory).

**What the coral case actually is, stated honestly.** The tempting claim is that
a SPORE gas plus a contact rule gives diffusion-limited aggregation free, since
the walk is already implemented. It doesn't, and the distinction matters. DLA's
dendrites come from *isotropic* walkers: a walker is equally likely to approach
from any direction, so protrusions shadow the interior and the cluster
branches. The engine's gas path is not isotropic — it tries straight up first,
then the up-diagonals, then lateral along the ceiling
([engine.ts:912-957](../src/sand/engine.ts:912)) — so SPORE approaches almost
always arrive from below. The result is an upward-combed aggregate, not a
radially symmetric dendrite.

Two honest options, and the first is the one to take:

1. **Keep the bias and stop calling it DLA.** Upward-combed accretion toward the
   light is what coral and most encrusting growth actually do; the bias is a
   feature for this use case, not an artefact to correct. Cost: unchanged, and
   genuinely nearly free.
2. **Add an isotropic walker.** A `randomWalk?: boolean` movement flag that
   steps uniformly among the eight neighbours, ignoring gravity. That is new
   machinery in the movement scan — small, but it is not free, and it should be
   costed as such rather than smuggled in under "the gas path already does this."

Frost on a ceiling is the case that would genuinely need option 2. It is not in
scope for Phase 3.

## The steps

### `stepSpread(idx, mat, rule): boolean`

1. If the backoff counter in `growthGrid[idx]` is non-zero, decrement and return.
2. Collect eligible targets among the allowed octants: material in
   `intoMaterial`, all `needs` present in the target's 8-neighbourhood, and
   `countNeighbors(target, into) <= maxNeighbors`.
3. No eligible target → double the backoff (cap 64), return `false`.
4. Pick one target uniformly via `random()`; roll `chance`; on success
   `setMaterial(target, into)`, apply `becomes` to the source, reset backoff,
   wake both chunks, return `true`.

### `stepTip(idx, mat, rule): boolean`

The tree engine. Structurally this is TPT's PLNT growth step and Sandspiel's stem
phase, expressed as data.

1. Unpack `energy`, `dir`, `gen`, `variant`. If `energy === 0` → **terminate**:
   `setMaterial(self, terminal)`, stamp `canopy` into the empty cells within its
   radius, roll `seeds`, clear the state word, return.
2. Apply `wobble`: with probability `wobble`, `dir += ±1`.
3. Build candidate headings `[dir, dir−1, dir+1]`. If `preferOpen`, stable-sort
   them by open-cell count in a 2-cell probe.
4. Walk the candidates. The first whose target is in `intoMaterial` wins:
   - `setMaterial(source, becomes)` — the trunk the tip leaves behind.
   - `setMaterial(target, mat)`; `growthGrid[target] = pack(energy − 1, heading,
     gen, variant)` — the tip moves.
   - **Branch** from the source node, for each turn `t` in `branchTurns`, if
     `gen < maxGen`, `energy >= branchMinEnergy`, and bit `t` of `variant` is
     set: fire on `branchEvery ? energy % branchEvery === 0 : random() <
     branchChance`. Child gets `pack(floor(energy × taper), dir + t, gen + 1,
     variant)`.
   - **Foliage**: roll `foliage.chance`, write `foliage.into` into one random
     empty neighbour of the source.
   - Return `true`.
5. No candidate → blocked → terminate as in step 1. **Tips always die.** They
   are the only self-limiting element in the design and the reason a forest
   converges instead of consuming the grid.

Gravitropism falls out for free: `dir` is a gravity-relative octant, so a tip
planted anywhere on a `RadialGravity` planet grows radially outward. TPT had to
compute this explicitly from the gravity field; here the frame already carries it.

### `stepAggregate(idx, mat, rule): boolean`

Scan the 8-neighbourhood for any material in `contact`; roll `chance`;
`setMaterial(self, into)` and, if `state` is present, seed
`growthGrid[idx]` (resolving `dir: 'up'` to octant 0 and `variant: 'random'` to
`floor(random() * 16)`).

## New materials

| id | Name | Flags | Rule |
|----|------|-------|------|
| 14 | GRASS | `isStatic`, flammability 40 | spread |
| 15 | SEED | powder (falls), flammability 50 | aggregate → sprout TREE_TIP |
| 16 | TREE_TIP | `isStatic`, ephemeral | tip → WOOD / LEAF |
| 17 | LEAF | `needsSupport`, flammability 60 | — |
| 18 | FERN_TIP | `isStatic`, ephemeral | tip → LEAF |
| 19 | SPORE | gas, density −1 | aggregate → CORAL *(Phase 3)* |
| 20 | CORAL | `isStatic` | — *(Phase 3)* |

Trunks reuse the existing WOOD (id 11), which already burns and already has the
support rule this plan generalises. Ids stay under 255, so the `Uint8Array` grid
is unaffected, and the renderer palette is built from `Materials`
([renderer.ts:87](../showcase/helpers/renderer.ts:87)) so new colours appear
automatically.

LEAF using `needsSupport` rather than `isStatic` is deliberate: foliage stays put
while the trunk holds it and rains down when fire takes the trunk out. That
collapse is the single most legible proof that growth composes with the
destructive reactions instead of sitting beside them.

**None of the new materials join `TERRAIN_SOLIDS`**, and for LEAF that is a
correctness constraint rather than a preference. `isStructural` is
`WALL/ROCK/WOOD/ICE`, so **LEAF does not support LEAF**. When a trunk burns,
every leaf it was holding loses support in the same frame and falls
independently, one row per frame. Add LEAF to the structural set and each
falling leaf briefly braces the one above it, turning a clean canopy collapse
into a chain that unwinds one cell at a time — a slow, visibly wrong drizzle.
The same reasoning keeps TREE_TIP and CORAL out: neither is load-bearing
terrain, and neither should be able to prop up anything else.

## Worked morphologies

The same `stepTip` produces all of these; only the data differs.

```ts
// Tree — irregular, self-similar, branches at 45°.
{ kind: 'tip', becomes: WOOD, terminal: LEAF,
  branchTurns: [-1, 1], branchChance: 0.12, branchTaper: 0.55, maxGen: 3,
  wobble: 0.15, preferOpen: true,
  foliage: { into: LEAF, chance: 0.25 },        // sparse, along the branches
  canopy:  { into: LEAF, radius: 1 },           // cluster at each dead tip
  seeds:   { into: SEED, chance: 0.1 } }        // planted with energy 26

// Fern — regular pinnae at 90°, shallow hierarchy, no wood.
{ kind: 'tip', becomes: LEAF, terminal: LEAF,
  branchTurns: [-2, 2], branchEvery: 2, branchTaper: 0.35, maxGen: 2,
  wobble: 0.05 }                                 // planted with energy 14

// Grass — the texture tier.
{ kind: 'spread', into: GRASS, needs: [WATER],
  intoMaterial: [SAND, EMPTY], directions: [7, 0, 1, 6, 2],  // upper hemisphere
  maxNeighbors: 3, chance: 0.05 }

// Coral — contact accretion. SPORE is a gas, so approaches arrive from below
// and the cluster combs upward. Not DLA; the right shape for coral anyway.
{ kind: 'aggregate', contact: [CORAL, ROCK], into: CORAL, chance: 0.4 }
```

```
  tree (energy 26)              fern (energy 14)
        ❦ ❦ ❦                      \ | /
      ❦ ╲ │ ╱ ❦                   ─ ╲│╱ ─
     ❦   ╲│╱                       \ │ /
      ╲   │   ╱ ❦                 ─ ╲│╱ ─
       ╲  │  ╱                      \ │ /
        ╲ │ ╱                     ─ ╲│╱ ─
          │                           │
          │                           │
  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓            ▓▓▓▓▓▓▓▓▓▓▓▓
```

Schematic, but the distinction is the real one: `branchChance` + taper + depth 3
gives the irregular self-similar silhouette; `branchEvery` + 90° turns + depth 2
gives the regular pinnate frond. Vines are the same rule with `dir` pointing
down-ish and `branchChance` near zero.

## Integration with temperature

Additive, not a dependency — the rules above deliver the fantasy without heat.
Once [temperature](./plan-temperature.md) lands, every rule kind gains an
optional `tempRange?: [min, max]`, checked against `engine.getHeat(x, y)` before
any roll. This is not speculative: TPT gates tree growth on exactly this, at
278.15 K–343.15 K.

What it buys: grass that will not grow on a frozen pole or beside an erupting
vent, forests that creep poleward as a world warms and recede as it cools, and a
habitable zone that is *emergent* — the intersection of two independent systems
rather than an authored band.

## Backward compatibility

- `growth`, `isStatic`, `needsSupport` are all optional. Every material today
  sets none, so behaviour is byte-identical.
- `runGrowth()` returns immediately on `growthCells.size === 0` — before any
  `random()` call. This is the load-bearing invariant: the RNG stream is a
  shared sequence, so a new draw anywhere shifts every subsequent cell's rolls.
  No growth materials in the world → no draws → identical grids.
- `growthGrid` is `null` until something is planted.
- New materials append ids 14–20; existing ids are unchanged, so serialized
  grids stay valid.
- The `isStatic`/`needsSupport` refactors are the one part that is *not*
  identical by construction — moving a rule from a hardcoded list into data is
  identical only if the migration is complete. The existing suite passing
  unchanged is the check, with the cardinal-only support caveat noted above.

## Public API

```ts
plant(x, y, mat, opts?: { energy?, dir?, variant? }): void  // place a tip, seed its state
getGrowthState(x, y): { energy, dir, gen, variant } | null
setGrowthState(x, y, s): void
rebuildGrowthCells(): void          // restore the candidate set after deserialization
get growthEventsLastFrame(): number
// PixelEngineOptions
growthInterval?: number;            // frames between growth ticks, default 4
```

`settle` gains growth as an activity source: `gridStable` becomes
`swaps < 5 && growthEvents === 0`. Without this a turn-based host resumes while a
tree is mid-growth — and note that v1's proposed "settles" test could never have
caught it, since growth never touches `_swapsThisFrame`
([engine.ts:404](../src/sand/engine.ts:404)). Backoff dormancy is what makes this
safe: a saturated world genuinely reaches zero growth events.

There is deliberately **no `settleIgnoresGrowth` opt-out**. An earlier draft had
one and could not motivate it: backoff means a mature world settles on its own,
so the flag only exists for a host that wants to resume mid-tree — which is a
tuning problem (`growthInterval`), not a semantics problem. Unmotivated flags are
API surface that has to be honoured forever.

## Files touched

- `src/materials/materials.ts` — `GrowthRule` union, `isStatic`/`needsSupport`/
  `growth` fields, seven new material definitions, enum ids 14–20.
- `src/sand/neighbors.ts` — `octantOffset()`.
- `src/sand/engine.ts` — `growthGrid`, `growthCells`, `runGrowth()`,
  `stepSpread`/`stepTip`/`stepAggregate`, `plant()`/`getGrowthState()`, the
  `isStatic`/`needsSupport` refactors at lines 867 and 869-876, `setMaterial`/
  `swap`/`clear` wiring, settle accounting.
- `src/sand/types.ts` — `growthInterval`.
- `src/tests/materials.test.ts` — **extend `IDS` to 14–20**
  ([materials.test.ts:11](../src/tests/materials.test.ts:11)). This array is
  hardcoded `[0…13]` and drives both the "exposes a definition for every enum
  value" and "materialDefs is sorted ascending" tests. Adding materials without
  touching it leaves the suite green while silently not covering any of them —
  a passing test that has stopped testing, which is worse than a failing one.
- `src/tests/sand-growth.test.ts` (new) — matching the `sand-*` naming used by
  the other twelve suites.
- `docs/integration.md` — "Growth" section, at the depth of the yield-strength one.
- `showcase/index.html` — Grass/Seed brush buttons (`data-mat="14"`, `"15"`)
  alongside the existing `.planet-brush` set at lines 91-98; they auto-wire
  through the existing query in `showcase/sections/planet.ts:234`.

## Test plan

Each test opens with a comment naming the regression it pins (house style).

**Compatibility**
- **Opt-in no-op**: a world with no growth materials is byte-identical over N
  frames, including an unallocated `growthGrid`. The guarantee.
- **Static refactor is inert**: ROCK/WALL/ICE via `isStatic` and WOOD via
  `needsSupport` behave exactly as the existing suite already asserts —
  including the cardinal-only support check (a diagonally-braced WOOD cell still
  falls), which needs its own test first if the suite doesn't already cover it.
- **Every new material is covered**: `materials.test.ts` `IDS` extended to
  14–20, so the table tests actually see them.

**Geometry**
- **`octantOffset` is a rotation of the 8-neighbourhood**: for flat, radial, and
  45° gravity, the eight octants are eight distinct offsets covering the full
  neighbourhood, ordered clockwise from `−down`. Direct and cheap; the
  radial-planet growth test covers this only indirectly and points at the wrong
  place when it fails.

**Spread**
- **Grows toward water**: GRASS beside SAND+WATER spreads into the SAND within
  bounded ticks; with no water in the target's neighbourhood, never.
- **`chance` throttles**: 0 → no growth; 1 → one spawn per eligible tick.
- **`maxNeighbors` is target-side**: a cell whose *target* already has
  `maxNeighbors` `into` neighbours does not spawn, and a field stops expanding
  at a bounded extent rather than filling the grid.
- **`intoMaterial` respected**: `[SAND]` never overwrites WATER or ROCK.
- **Backoff**: a saturated GRASS cell stops emitting growth events, and
  `wakeChunk` on a neighbour re-arms it.

**Tips**
- **A tree is taller than it is wide**: plant with energy 26, run to completion,
  assert extent along `up` exceeds lateral extent — the "not a blob" pin, and
  the one v1 could not have satisfied at all.
- **Energy bounds height**: trunk length ≤ initial energy.
- **Tips always die**: after bounded ticks, zero TREE_TIP cells remain and
  `growthCells` contains no tips. No infinite plant factories.
- **Blocked tip terminates**: a tip pointed into ROCK becomes `terminal` rather
  than stalling or vanishing.
- **Branching respects `maxGen`/taper**: no cell exceeds depth `maxGen`; child
  energy equals `floor(parent × taper)`.
- **`branchEvery` is regular**: a fern's fork points are evenly spaced along the
  rachis; a tree's (same energy, `branchChance`) are not.
- **`variant` diversifies**: two plants with different variants produce
  different silhouettes; the same variant reproduces the same silhouette.
- **Radial planet**: a tip planted at four points around a `RadialGravity`
  planet grows radially outward at each, never toward screen-up. The
  planet-correctness pin — and now a meaningful one, since `dir` is genuinely
  gravity-relative.

**Aggregate / composition**
- **Seed sprouts on soil, not in air**: SEED germinates on SAND contact and
  falls inert otherwise.
- **Aggregation grows upward, and that is the documented behaviour**: SPORE
  accreting onto CORAL produces a cluster whose extent along `−down` exceeds its
  lateral extent. Asserting the bias rather than dendritic-ness is deliberate —
  a perimeter-to-area threshold would pass on a combed clump too, and would let
  the plan keep claiming DLA it doesn't implement.
- **Fire composes**: FIRE ignites GRASS and WOOD, and the LEAF canopy falls once
  its trunk burns away — `needsSupport` earning its place.
- **Canopy collapse doesn't chain**: a leaf column above a burned trunk clears at
  one row per frame, with no cell held up by the leaf below it. Pins LEAF's
  exclusion from `TERRAIN_SOLIDS`.
- **Acid composes**: ACID dissolves grown WOOD as readily as placed WOOD.

**System**
- **Determinism**: same seed + same `plant()` calls → identical grid *and*
  `growthGrid`.
- **Membership invariant**: after an arbitrary run, `growthCells` equals exactly
  the set of indices whose material has a `growth` rule — asserted directly, and
  re-asserted after `rebuildGrowthCells()` on a world built by a different path.
  Sharper than comparing two evolved worlds, and it fails at the cause.
- **`preferOpen` ties are stable**: a tip with two equally open headings picks
  the same one every run.
- **Settles**: after growth completes, `swapsLastFrame === 0` *and*
  `growthEventsLastFrame === 0`.
- **Sleeping chunks still grow**: run to settle, then place water beside grass
  with no other activity, and assert growth resumes. The v1-killer, pinned.

## Open questions

**Resolved before Phase 2 (was open, decided):** *foliage placement.* Both, with
`foliage` sparse along the branches and `canopy` stamping a radius-1 cluster
where each tip dies. Along-branch alone is blobby; terminal alone concentrates
everything at the extremities. This changes the `stepTip` termination path and
the silhouette-diversity test, so deferring it into implementation would have
meant reworking Phase 2 mid-flight. Provisional on how it looks, but the shape
of the code is settled.

1. **Should tips be visible?** A TREE_TIP is on-grid for a few frames per cell
   and will render as a distinct colour. Leaning: give it a bright bud colour and
   treat it as a feature — visible growing points are legible and appealing.
   Alternative is rendering it as `becomes`, hiding the machinery.
2. **Multi-species tips.** One tip material per species (TREE_TIP, FERN_TIP) is
   data-driven and needs no new machinery, but the enum grows with the flora. If
   it passes ~6 species, move species into the `variant` nibble and keep a single
   TIP material with a rule table. Not needed for the MVP.
3. **Backoff cap.** 64 growth ticks (~256 frames) is a guess. If a re-armed field
   feels sluggish after a water placement, the chunk-wake reset should cover it —
   but this wants measuring on a real planet, not reasoning about.
4. **Root systems.** A downward tip with `becomes: WOOD` into SAND would grow
   roots, which is nearly free. Cosmetic below the surface, so: deferred.
5. **Isotropic walkers.** Deferred out of Phase 3 with the DLA reframing above.
   Worth revisiting only if frost-on-a-ceiling becomes a wanted material — it is
   the one morphology the gravity-biased walk cannot produce.

## Phasing and estimation

Phased so each stage is independently shippable and independently useful.

| Phase | Scope | Est. |
|-------|-------|------|
| 0 | `isStatic`/`needsSupport` refactor; `growthCells` + invariant; `runGrowth()` skeleton | 0.5 d |
| 1 | `SpreadRule` + backoff + GRASS; spread tests | 1 d |
| 2 | `growthGrid`, octants, `TipRule` + TREE_TIP/FERN_TIP/LEAF; tip tests | 3 d |
| 3 | `AggregateRule` + SEED germination, SPORE/CORAL; composition tests | 0.75 d |
| 4 | `docs/integration.md`, showcase brushes, a Forest tool | 0.75 d |

**~6 days.** v1 estimated 1.5 for the spread tier alone, on the assumption that
`stepGrowth` would be structurally identical to `stepAcid`. It isn't: `stepAcid`
is a destructive reaction on a cell the movement scan already woke, and growth is
a spontaneous process on a cell that is asleep. Phases 0–1 deliver the v1 scope
honestly costed at 1.5 days; Phase 2 is the pillar.

Phase 2 carries the estimate risk, and it is priced at 3 days rather than 2 on
precedent: the temperature plan went 2.5 → 5 days once chunk tracking, a seeding
sweep, and interaction with the existing reactions turned up during design
([plan-temperature.md:613](./plan-temperature.md:613)). Phase 2 has the same
tells — `preferOpen`'s probe is specified as "~6 lookups" without a written
tiebreak-and-cost pass, silhouette-diversity is asserted before anyone has seen
one on screen, and tuning `branchTaper`/`branchChance` until a forest reads as a
forest is iteration that does not compress. 4 days would not be a surprise.

## References

- The Powder Toy — [VINE.cpp](https://github.com/The-Powder-Toy/The-Powder-Toy/blob/master/src/simulation/elements/VINE.cpp),
  [PLNT.cpp](https://github.com/The-Powder-Toy/The-Powder-Toy/blob/master/src/simulation/elements/PLNT.cpp)
  (packed growth word, octant branching, gravity-aware taper, genome mask,
  temperature gating)
- Sandspiel — [species.rs](https://github.com/MaxBittker/sandspiel/blob/master/crate/src/species.rs)
  (`ra`/`rb` per-cell registers, seed → stem → petals → reproduction staging,
  target-side crowding checks, tips that die)
- Noita — [Grass](https://noita.wiki.gg/wiki/Grass), [Seed (Material)](https://noita.wiki.gg/wiki/Seed_(Material))
  (data-driven spontaneous growth from soil)
- [Diffusion-limited aggregation](https://en.wikipedia.org/wiki/Diffusion-limited_aggregation)
  (coral, frost, lichen, dendrites — cited as the contrast case: this plan does
  contact accretion with a gravity-biased walker, not DLA)
- Runions et al., [Modeling Trees with a Space Colonization Algorithm](https://algorithmicbotany.org/papers/colonization.egwnp2007.large.pdf)
  (competition for space as the shaping force; source of `preferOpen`)
