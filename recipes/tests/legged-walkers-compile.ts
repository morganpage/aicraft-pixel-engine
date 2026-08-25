/**
 * A COMPILE GUARD for [`legged-walkers.ts`](../legged-walkers.ts): the bridge's
 * structural `SlimeRigModule` interface, checked against the **real** rig at
 * `games/assets/slime-rig/slime-knight.ts`. Run by `recipes:typecheck`.
 *
 * The bridge deliberately types the rig structurally rather than importing it,
 * so that the recipe carries no dependency on the sibling `aicraft-engine`
 * package. The cost of that choice is that nothing would notice if the rig's
 * signatures moved out from under the interface — a host would find out by
 * copying both files into a game and getting a wall of type errors. This file
 * is what notices instead.
 *
 * `aicraft-engine` itself is stubbed (see `aicraft-engine-shim.d.ts`): the rig
 * is being checked as a *consumer-facing surface*, not against its own
 * dependency, and installing a whole animation package to typecheck four
 * function signatures is not a trade worth making in CI.
 */
import * as rig from '../../games/assets/slime-rig/slime-knight';
import {
  createRiggedWalkers, stepRiggedWalkers, drawRiggedWalkers,
  type SlimeRigModule,
} from '../legged-walkers.js';
import type { SurfaceWalkers } from '../surface-walkers.js';

declare const pop: SurfaceWalkers;
declare const ctx: CanvasRenderingContext2D;

// The assignment is the assertion: if the rig's exports drift, this fails.
const asModule: SlimeRigModule<
  ReturnType<typeof rig.deriveHeroConfig>,
  ReturnType<typeof rig.createHeroFrameState>
> = rig;
void asModule;

const rigged = createRiggedWalkers(pop, rig, { scale: 0.22 });
stepRiggedWalkers(pop, rigged, rig);
drawRiggedWalkers(ctx, pop, rigged, rig, 0);
