import { describe, it, expect } from 'vitest';
import {
  MaterialType,
  Materials,
  materialDefs,
  TERRAIN_SOLIDS,
  isTerrainSolid,
} from '../materials';

/**
 * Numeric ids only — a numeric enum's Object.values also includes name strings.
 *
 * **Extend this when adding a material.** It drives the table-coverage tests
 * below, so a new id left out of it does not fail anything: the suite stays
 * green while quietly not checking the material at all, which is worse than a
 * red test. The guard below catches the omission.
 */
const IDS: MaterialType[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
  14, 15, 16, 17, 18, 19, 20, 21, 22,
];

describe('materials table', () => {
  it('exposes a definition for every enum value', () => {
    for (const id of IDS) {
      expect(Materials[id], `material ${id} defined`).toBeDefined();
      expect(Materials[id].id).toBe(id);
    }
  });

  it('materialDefs is sorted ascending by id and indexable by material id', () => {
    for (let i = 1; i < materialDefs.length; i++) {
      expect(materialDefs[i].id).toBeGreaterThan(materialDefs[i - 1].id);
    }
    for (const id of IDS) {
      expect(materialDefs[id].id).toBe(id);
    }
  });

  // Makes the omission above impossible to miss: if a material is added to the
  // table and not to IDS, this fails rather than the coverage silently shrinking.
  it('IDS covers every material in the table', () => {
    expect(IDS.length).toBe(materialDefs.length);
    expect(IDS).toEqual(materialDefs.map((d) => d.id));
  });

  it('EMPTY is id 0 and has zero density', () => {
    expect(MaterialType.EMPTY).toBe(0);
    expect(Materials[MaterialType.EMPTY].density).toBe(0);
  });

  it('density sign reflects phase: gases negative, liquids/solids non-negative', () => {
    for (const def of materialDefs) {
      if (def.id === MaterialType.EMPTY) continue;
      if (def.isGas) {
        expect(def.density, `${def.name} gas density negative`).toBeLessThan(0);
      } else {
        expect(def.density, `${def.name} non-gas density non-negative`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('liquids are flagged isLiquid and not isGas', () => {
    const liquids = materialDefs.filter((d) => d.isLiquid);
    for (const d of liquids) {
      expect(d.isGas).toBe(false);
    }
    // Sanity: water, lava, oil, acid are liquids.
    expect(Materials[MaterialType.WATER].isLiquid).toBe(true);
    expect(Materials[MaterialType.LAVA].isLiquid).toBe(true);
    expect(Materials[MaterialType.OIL].isLiquid).toBe(true);
    expect(Materials[MaterialType.ACID].isLiquid).toBe(true);
  });

  it('tephra is granular and floats on lava', () => {
    const tephra = Materials[MaterialType.TEPHRA];
    expect(tephra.isLiquid).toBe(false);
    expect(tephra.isGas).toBe(false);
    expect(tephra.isStatic).not.toBe(true);
    expect(tephra.density).toBeLessThan(Materials[MaterialType.LAVA].density);
    expect(tephra.density).toBeGreaterThan(Materials[MaterialType.WATER].density);
  });

  it('flammability is in 0..100 and oil/fgas/wood are flammable', () => {
    for (const d of materialDefs) {
      expect(d.flammability).toBeGreaterThanOrEqual(0);
      expect(d.flammability).toBeLessThanOrEqual(100);
    }
    expect(Materials[MaterialType.OIL].flammability).toBe(100);
    expect(Materials[MaterialType.FGAS].flammability).toBe(100);
    expect(Materials[MaterialType.WOOD].flammability).toBe(30);
    expect(Materials[MaterialType.WATER].flammability).toBe(0);
  });

  it('per-tick decay chances are probabilities and smoke opts in', () => {
    for (const def of materialDefs) {
      if (def.decayChance === undefined) continue;
      expect(def.decayChance, `${def.name} decay chance`).toBeGreaterThanOrEqual(0);
      expect(def.decayChance, `${def.name} decay chance`).toBeLessThanOrEqual(1);
    }
    expect(Materials[MaterialType.SMOKE].decayChance).toBe(0.02);
    expect(Materials[MaterialType.SMOKE].escapesAtBoundary).toBe(true);
  });

  it('isTerrainSolid flags exactly WALL/ROCK/WOOD/ICE', () => {
    expect([...TERRAIN_SOLIDS].sort((a, b) => a - b)).toEqual(
      [MaterialType.WALL, MaterialType.ROCK, MaterialType.WOOD, MaterialType.ICE].sort((a, b) => a - b),
    );
    for (const id of IDS) {
      expect(isTerrainSolid(id)).toBe(TERRAIN_SOLIDS.has(id));
    }
  });

  it('colors are 4-tuples [r,g,b,a]', () => {
    for (const d of materialDefs) {
      expect(d.color).toHaveLength(4);
      for (const c of d.color) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(255);
      }
    }
  });
});
