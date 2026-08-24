// In-repo import; when copying this file into a game, change to:
//   import { MaterialType } from 'aicraft-pixel-engine';
import { MaterialType } from '../src/index.js';

/**
 * A live census of the world, straight from the engine grid.
 *
 * The god-game "feel" layer: a one-line readout of what the world currently
 * holds, refreshed about once a second. It costs one linear scan of the grid
 * (~0.4 M cells) per refresh — cheap next to a single simulation frame with
 * activity — and it makes terraforming legible as *progress*, which is what
 * turns a sandbox into a game.
 *
 * `forestGrown` counts only grown tree cells (WOOD/LEAF/TREE_TIP) while
 * `forest` also counts SEEDs: the distinction matters the moment you gate
 * anything on "a forest exists" — one brush stroke scatters ~100 seeds, and
 * a milestone that fires on seeds celebrates nothing (measured: the god
 * game's "Life Takes Root" toast fired within a second of scattering).
 */

export interface CensusCounts {
  water: number;
  sand: number;
  lava: number;
  fire: number;
  steam: number;
  rock: number;
  tephra: number;
  /** WOOD + LEAF + TREE_TIP + SEED. */
  forest: number;
  /** WOOD + LEAF + TREE_TIP only — a forest that actually exists. */
  forestGrown: number;
}

export function census(grid: Uint8Array): CensusCounts {
  const c: CensusCounts = {
    water: 0, sand: 0, lava: 0, fire: 0, steam: 0, rock: 0, tephra: 0,
    forest: 0, forestGrown: 0,
  };
  for (let i = 0; i < grid.length; i++) {
    switch (grid[i]) {
      case MaterialType.WATER: c.water++; break;
      case MaterialType.SAND: c.sand++; break;
      case MaterialType.LAVA: c.lava++; break;
      case MaterialType.FIRE: c.fire++; break;
      case MaterialType.STEAM: c.steam++; break;
      case MaterialType.ROCK: c.rock++; break;
      case MaterialType.TEPHRA: c.tephra++; break;
      case MaterialType.WOOD:
      case MaterialType.LEAF:
      case MaterialType.TREE_TIP:
        c.forest++; c.forestGrown++; break;
      case MaterialType.SEED: c.forest++; break;
    }
  }
  return c;
}

/** Compact readout: `🌊 12 · 🏔 3.4k · 🌋 210 · 🔥 0 · 🌲 87 · 💨 40`. */
export function formatCensus(c: CensusCounts): string {
  const fmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  let out = `🌊 ${fmt(c.water)} · 🏔 ${fmt(c.sand)} · 🌋 ${fmt(c.lava)} · 🔥 ${fmt(c.fire)}`;
  if (c.forest > 0) out += ` · 🌲 ${fmt(c.forest)}`;
  if (c.steam > 0) out += ` · 💨 ${fmt(c.steam)}`;
  return out;
}

/**
 * Wall-clock gate for "report about once a second" regardless of how the
 * simulation is clocked (throttled tabs step slowly; a tick counter would
 * under-report there).
 */
export function createCensusGate(intervalMs = 1000): (nowMs: number) => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return (nowMs: number) => {
    if (nowMs - last < intervalMs) return false;
    last = nowMs;
    return true;
  };
}
