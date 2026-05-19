import { describe, expect, it } from 'vitest';
import { selectLod } from '../lod-selection';
import type { AtlasLodInfo } from '../types';

const FULL: AtlasLodInfo[] = [
    { id: 0, scale: 1.0, size: 4096 },
    { id: 1, scale: 0.5, size: 2048 },
    { id: 2, scale: 0.25, size: 1024 },
    { id: 3, scale: 0.125, size: 512 },
];

describe('selectLod', () => {
    it.each([
        [128, 0],
        [64, 0],
        [63.99, 1],
        [16, 1],
        [15.99, 2],
        [4, 2],
        [3.99, 3],
        [0.01, 3],
        [8, 2], // default zoom typically lands here
    ])('pixelsPerSquare=%f → lod %i (all four LODs available)', (pps, expected) => {
        expect(selectLod(pps, FULL)).toBe(expected);
    });

    it('clamps to highest published LOD when fewer than four are available', () => {
        const onlyTwo = FULL.slice(0, 2);
        // pps=0.01 normally wants lod3 but server only published lod0+lod1.
        expect(selectLod(0.01, onlyTwo)).toBe(1);
    });

    it('returns LOD 0 when only one LOD is published', () => {
        const onlyZero = FULL.slice(0, 1);
        expect(selectLod(0.001, onlyZero)).toBe(0);
        expect(selectLod(1000, onlyZero)).toBe(0);
    });

    it('throws when given an empty LOD list', () => {
        expect(() => selectLod(1, [])).toThrow();
    });
});
