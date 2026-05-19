/**
 * Unit tests for plants-config.ts — TypeScript port of pzmap2dzi/plants.py.
 *
 * Verifies that seasonal remapping, jumbo trees, grass, bushes, and edge
 * cases match the reference Python implementation.
 *
 * Run:
 *   cd app && npm run test -- --reporter=verbose
 */

import { describe, it, expect } from 'vitest';
import {
    PlantsInfo,
    remapSpriteName,
    defaultPlantsInfo,
    DEFAULT_PLANTS_CONFIG,
    type PlantsConfig,
    type Season,
} from '../plants-config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInfo(conf: PlantsConfig = {}): PlantsInfo {
    return new PlantsInfo(conf);
}

// ---------------------------------------------------------------------------
// Default config smoke test
// ---------------------------------------------------------------------------

describe('DEFAULT_PLANTS_CONFIG', () => {
    it('has correct summer2 defaults', () => {
        expect(DEFAULT_PLANTS_CONFIG.season).toBe('summer2');
        expect(DEFAULT_PLANTS_CONFIG.snow).toBe(false);
        expect(DEFAULT_PLANTS_CONFIG.flower).toBe(false);
        expect(DEFAULT_PLANTS_CONFIG.tree_size).toBe(2);
        expect(DEFAULT_PLANTS_CONFIG.jumbo_tree_size).toBe(3);
        expect(DEFAULT_PLANTS_CONFIG.jumbo_tree_type).toBe(1);
        expect(DEFAULT_PLANTS_CONFIG.no_ground_cover).toBe(false);
        expect(DEFAULT_PLANTS_CONFIG.unify_tree_type).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// remapSpriteName — pass-through for unknown sprites
// ---------------------------------------------------------------------------

describe('remapSpriteName pass-through', () => {
    it('returns original name for unknown sprite names', () => {
        const result = remapSpriteName('walls_exterior_01_0', defaultPlantsInfo);
        expect(result).toEqual(['walls_exterior_01_0']);
    });

    it('returns original for floor tile', () => {
        const result = remapSpriteName('floors_interior_carpet_01_0', defaultPlantsInfo);
        expect(result).toEqual(['floors_interior_carpet_01_0']);
    });
});

// ---------------------------------------------------------------------------
// Grass (vegetation_groundcover_01_N)
// ---------------------------------------------------------------------------

describe('grass remapping', () => {
    it('summer2: groundcover returns d_plants_1 sprite', () => {
        const info = makeInfo({ season: 'summer2' });
        const result = info.resolve('vegetation_groundcover_01_0');
        expect(result).not.toBeNull();
        expect(result!.length).toBeGreaterThan(0);
        // summer2 uses offset-based sprite, not sprite 0 which is spring
        expect(result![0]).toMatch(/^d_plants_1_\d+$/);
    });

    it('spring: groundcover returns sprite 0 (imod8=0)', () => {
        const info = makeInfo({ season: 'spring' });
        const result = info.resolve('vegetation_groundcover_01_0');
        expect(result).toEqual(['d_plants_1_0']);
    });

    it('autumn: groundcover returns sprite 8 (8 + imod8)', () => {
        const info = makeInfo({ season: 'autumn' });
        const result = info.resolve('vegetation_groundcover_01_0');
        expect(result).toEqual(['d_plants_1_8']);
    });

    it('no_ground_cover: grass resolves to empty array', () => {
        const info = makeInfo({ no_ground_cover: true });
        const result = info.resolve('vegetation_groundcover_01_0');
        expect(result).toEqual([]);
    });

    it('remapSpriteName with no_ground_cover returns empty (draw nothing)', () => {
        const info = makeInfo({ no_ground_cover: true });
        const result = remapSpriteName('vegetation_groundcover_01_5', info);
        expect(result).toEqual([]);
    });

    it('flower adds extra sprite in summer2', () => {
        const withFlower    = makeInfo({ season: 'summer2', flower: true });
        const withoutFlower = makeInfo({ season: 'summer2', flower: false });
        const wf  = withFlower.resolve('vegetation_groundcover_01_0')!;
        const wof = withoutFlower.resolve('vegetation_groundcover_01_0')!;
        expect(wf.length).toBeGreaterThan(wof.length);
    });

    it('covers all 48 groundcover indices', () => {
        const info = makeInfo({});
        for (let i = 0; i < 48; i++) {
            const result = info.resolve(`vegetation_groundcover_01_${i}`);
            // summer2 with no snow → should have at least 1 sprite
            expect(result).not.toBeNull();
            expect(result!.length).toBeGreaterThan(0);
        }
    });
});

// ---------------------------------------------------------------------------
// Bushes (vegetation_foliage_01_N)
// ---------------------------------------------------------------------------

describe('bush remapping', () => {
    it('spring: foliage_01_0 trunk + spring overlay', () => {
        const info = makeInfo({ season: 'spring' });
        const result = info.resolve('vegetation_foliage_01_0')!;
        // trunk (offset 0) + spring overlay (+32)
        expect(result).toContain('f_bushes_1_0');
        expect(result).toContain('f_bushes_1_32');
    });

    it('snow: only snow variant', () => {
        const info = makeInfo({ snow: true });
        const result = info.resolve('vegetation_foliage_01_0')!;
        // snow → trunk + 16
        expect(result).toHaveLength(1);
        expect(result[0]).toBe('f_bushes_1_16');
    });

    it('large_bush shifts to offset 8 for trunk', () => {
        const normalInfo = makeInfo({ season: 'summer2' });
        const largeInfo  = makeInfo({ season: 'summer2', large_bush: true });
        const normal = normalInfo.resolve('vegetation_foliage_01_0')![0]!;
        const large  = largeInfo.resolve('vegetation_foliage_01_0')![0]!;
        // large_bush: offset1 = 8, so trunk = 0 + 8 = 8
        const normalIdx = parseInt(normal.replace('f_bushes_1_', ''));
        const largeIdx  = parseInt(large.replace('f_bushes_1_', ''));
        expect(largeIdx).toBe(normalIdx + 8);
    });

    it('no_ground_cover hides bushes too', () => {
        const info = makeInfo({ no_ground_cover: true });
        const result = info.resolve('vegetation_foliage_01_3');
        expect(result).toEqual([]);
    });

    it('covers all 16 foliage indices', () => {
        const info = makeInfo({});
        for (let i = 0; i < 16; i++) {
            expect(info.resolve(`vegetation_foliage_01_${i}`)).not.toBeNull();
        }
    });
});

// ---------------------------------------------------------------------------
// Small trees (vegetation_trees_01_N)
// ---------------------------------------------------------------------------

describe('tree remapping', () => {
    it('summer2 with default tree_size=2: uses size 2 slot (idx=2)', () => {
        const info = makeInfo({ season: 'summer2', tree_size: 2 });
        const result = info.resolve('vegetation_trees_01_0')!;
        // americanholly at size 2: prefix = e_americanholly_1_, idx=2
        // summer2 is non-evergreen → base + leaf overlay
        expect(result.length).toBeGreaterThan(0);
        expect(result[0]).toMatch(/^e_americanholly_1_/);
    });

    it('winter (snow) renders only base sprite', () => {
        const info = makeInfo({ snow: true });
        const result = info.resolve('vegetation_trees_01_0')!;
        expect(result).toHaveLength(1);
    });

    it('spring adds one seasonal overlay (non-evergreen)', () => {
        // americanholly is evergreen — use americanlinden (idx 1, 0-based) = trees_01_1
        const info = makeInfo({ season: 'spring' });
        const result = info.resolve('vegetation_trees_01_1')!; // americanlinden (deciduous)
        expect(result).toHaveLength(2);
        expect(result[1]).toMatch(/^e_americanlinden_1_/);
    });

    it('unify_tree_type forces all trees to one species', () => {
        const info = makeInfo({ unify_tree_type: 3 }); // canadianhemlock
        const t0  = info.resolve('vegetation_trees_01_0')![0]!;
        const t10 = info.resolve('vegetation_trees_01_10')![0]!;
        // Both should use canadianhemlock
        expect(t0).toMatch(/canadianhemlock/);
        expect(t10).toMatch(/canadianhemlock/);
    });

    it('covers all 33 tree indices', () => {
        const info = makeInfo({});
        for (let i = 0; i < 33; i++) {
            const result = info.resolve(`vegetation_trees_01_${i}`);
            expect(result).not.toBeNull();
            expect(result!.length).toBeGreaterThan(0);
        }
    });
});

// ---------------------------------------------------------------------------
// Jumbo trees
// ---------------------------------------------------------------------------

describe('jumbo tree remapping', () => {
    it('jumbo_tree_01_0 is mapped', () => {
        const info = makeInfo({});
        const result = info.resolve('jumbo_tree_01_0');
        expect(result).not.toBeNull();
        expect(result!.length).toBeGreaterThan(0);
    });

    it('jumbo_tree uses JUMBO prefix when size >= 4', () => {
        const info = makeInfo({ jumbo_tree_size: 4 });
        const result = info.resolve('jumbo_tree_01_0')![0]!;
        expect(result).toContain('JUMBO');
    });

    it('jumbo_tree with size 3 uses normal prefix', () => {
        const info = makeInfo({ jumbo_tree_size: 3 });
        const result = info.resolve('jumbo_tree_01_0')![0]!;
        // size 3 → not jumbo (< 4)
        expect(result).not.toContain('JUMBO');
    });

    it('jumbo_tree_type=8 uses redmaple species', () => {
        const info = makeInfo({ jumbo_tree_size: 4, jumbo_tree_type: 8 }); // redmaple
        const result = info.resolve('jumbo_tree_01_0')![0]!;
        expect(result).toContain('redmaple');
    });

    it('unify_tree overrides jumbo_tree_type', () => {
        const info = makeInfo({ unify_tree_type: 10, jumbo_tree_type: 1 }); // virginiapine
        const result = info.resolve('jumbo_tree_01_0')![0]!;
        expect(result).toContain('virginiapine');
    });

    it('jumbo_tree_type clamped to [1..11]', () => {
        const tooLow  = makeInfo({ jumbo_tree_type: 0 });
        const tooHigh = makeInfo({ jumbo_tree_type: 99 });
        // Both should not throw
        expect(tooLow.resolve('jumbo_tree_01_0')).not.toBeNull();
        expect(tooHigh.resolve('jumbo_tree_01_0')).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// All seasons produce non-empty output for a known vegetation sprite
// ---------------------------------------------------------------------------

describe('season coverage', () => {
    const seasons: Season[] = ['spring', 'summer', 'summer2', 'autumn', 'winter'];

    for (const season of seasons) {
        it(`season=${season}: vegetation_groundcover_01_0 handled`, () => {
            const info = makeInfo({ season, snow: season === 'winter' });
            const result = info.resolve('vegetation_groundcover_01_0');
            if (season === 'winter') {
                // winter has no grass season variant → empty (no snow either, and spring/summer/autumn not matched)
                // Note: Python produces [] for winter grass with no snow flag because
                // the grass loop only pushes for spring/summer/summer2/autumn.
                expect(result).toEqual([]);
            } else {
                expect(result).not.toBeNull();
                expect(result!.length).toBeGreaterThan(0);
            }
        });
    }
});

// ---------------------------------------------------------------------------
// hasMappingFor
// ---------------------------------------------------------------------------

describe('hasMappingFor', () => {
    it('returns true for vegetation sprite', () => {
        expect(defaultPlantsInfo.hasMappingFor('vegetation_trees_01_0')).toBe(true);
    });

    it('returns false for wall sprite', () => {
        expect(defaultPlantsInfo.hasMappingFor('walls_exterior_01_0')).toBe(false);
    });

    it('returns true for jumbo tree', () => {
        expect(defaultPlantsInfo.hasMappingFor('jumbo_tree_01_0')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// entries() iterator
// ---------------------------------------------------------------------------

describe('entries()', () => {
    it('yields all expected vegetation keys', () => {
        const info = makeInfo({});
        const keys = Array.from(info.entries()).map(([k]) => k);

        // Should have foliage (16), groundcover (48), trees (33), jumbo (1) = 98
        expect(keys.length).toBe(16 + 48 + 33 + 1);
    });
});
