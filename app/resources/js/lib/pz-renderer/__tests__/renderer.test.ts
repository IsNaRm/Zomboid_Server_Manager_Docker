import { describe, expect, it } from 'vitest';
import { isWebGL2Available } from '../gl/context';
import { PzGLRenderer, pickDivisorAtMost } from '../tile-renderer';

describe('PzGLRenderer (jsdom env)', () => {
    it('isWebGL2Available returns false outside browser GPU context', () => {
        expect(isWebGL2Available()).toBe(false);
    });

    it('init returns false when WebGL2 is unavailable', async () => {
        const canvas = document.createElement('canvas');
        const renderer = new PzGLRenderer(canvas);
        await expect(renderer.init()).resolves.toBe(false);
        renderer.dispose();
    });

    it('getGLContext returns null before init', () => {
        const canvas = document.createElement('canvas');
        const renderer = new PzGLRenderer(canvas);
        expect(renderer.getGLContext()).toBeNull();
        renderer.dispose();
    });
});

describe('pickDivisorAtMost', () => {
    // B42 cellEdge = 256 = 2^8 — divisors are powers of two only.
    it.each([
        [256, 1, 1],
        [256, 2, 2],
        [256, 3, 2],     // 3 → snap down to 2
        [256, 7, 4],     // 7 → snap down to 4
        [256, 10, 8],
        [256, 100, 64],  // 100 → snap down to 64
        [256, 128, 128],
        [256, 200, 128], // 200 → snap down to 128
        [256, 256, 256],
        [256, 1000, 256], // clamp to n
    ])('pickDivisorAtMost(%i, %i) → %i', (n, t, expected) => {
        expect(pickDivisorAtMost(n, t)).toBe(expected);
    });

    // B41 cellEdge = 300 = 2² × 3 × 5².
    it.each([
        [300, 1, 1],
        [300, 4, 4],
        [300, 7, 6],      // 7 → snap to 6
        [300, 50, 50],
        [300, 100, 100],
        [300, 128, 100],  // 128 → snap to 100
        [300, 200, 150],
        [300, 300, 300],
        [300, 1000, 300],
    ])('pickDivisorAtMost(%i, %i) → %i', (n, t, expected) => {
        expect(pickDivisorAtMost(n, t)).toBe(expected);
    });

    it('never returns a value that leaves a remainder', () => {
        for (const n of [256, 300]) {
            for (let t = 1; t <= n + 5; t++) {
                const d = pickDivisorAtMost(n, t);
                expect(n % d).toBe(0);
                expect(d).toBeLessThanOrEqual(t);
                expect(d).toBeGreaterThanOrEqual(1);
            }
        }
    });

    it('returns 1 when target is 0 or negative (guarded)', () => {
        expect(pickDivisorAtMost(256, 0)).toBe(1);
        expect(pickDivisorAtMost(256, -5)).toBe(1);
    });
});

describe('block-major iteration step alignment (regression: missing strips)', () => {
    /**
     * Mirrors the new block-major loop in _collectInstances. For each
     * (bx, by) block we compute the first step-aligned LOCAL coordinate
     * inside the block, then walk `lsx += decimateStep` until blockSize.
     * The union of all visited world-square coords must EQUAL the set
     * visited by the simple flat loop `for (wsx=0; wsx<cellEdge; wsx+=step)`.
     *
     * If the block-major formula skips any wsx value, the rendered tile
     * has visible holes (vertical or horizontal stripes), which is exactly
     * what the original triangle-artefact fix protected against.
     */
    function blockMajorVisited(
        cellEdge: number,
        blockSize: number,
        decimateStep: number,
    ): Set<number> {
        const visited = new Set<number>();
        const blocksPerEdge = cellEdge / blockSize;
        for (let bx = 0; bx < blocksPerEdge; bx++) {
            const blockOriginX = bx * blockSize;
            const lsxStart = ((decimateStep - (blockOriginX % decimateStep)) % decimateStep);
            if (lsxStart >= blockSize) continue;
            for (let lsx = lsxStart; lsx < blockSize; lsx += decimateStep) {
                visited.add(blockOriginX + lsx);
            }
        }
        return visited;
    }

    function flatVisited(cellEdge: number, decimateStep: number): Set<number> {
        const visited = new Set<number>();
        for (let w = 0; w < cellEdge; w += decimateStep) { visited.add(w); }
        return visited;
    }

    // B42: blockSize=8, cellSizeInBlocks=32 → cellEdge=256
    // B41: blockSize=10, cellSizeInBlocks=30 → cellEdge=300
    it.each([
        [256, 8, 1],
        [256, 8, 2],
        [256, 8, 4],
        [256, 8, 8],
        [256, 8, 16],
        [256, 8, 32],
        [256, 8, 64],
        [256, 8, 128],
        [256, 8, 256],
        [300, 10, 1],
        [300, 10, 2],
        [300, 10, 5],
        [300, 10, 10],
        [300, 10, 50],
        [300, 10, 100],
    ])('cellEdge=%i blockSize=%i step=%i — block-major covers same set as flat loop',
        (cellEdge, blockSize, decimateStep) => {
            const blockMajor = blockMajorVisited(cellEdge, blockSize, decimateStep);
            const flat = flatVisited(cellEdge, decimateStep);
            expect(blockMajor.size).toBe(flat.size);
            for (const v of flat) {
                expect(blockMajor.has(v)).toBe(true);
            }
        },
    );

    it('every visited coord lies on a step-multiple', () => {
        const visited = blockMajorVisited(256, 8, 16);
        for (const v of visited) {
            expect(v % 16).toBe(0);
        }
    });
});

describe('decimation loop edge coverage (regression: bottom-right grey triangles)', () => {
    // Mirrors the iteration in _collectInstances after the fix.
    function lastIteratedSquare(cellEdge: number, decimateStep: number): number {
        let last = -1;
        for (let w = 0; w < cellEdge; w += decimateStep) { last = w; }
        return last;
    }

    it.each([
        [256, 100, 64, 192],   // B42, target 100 → step 64; last sample at 192 covers [192..255]
        [256, 200, 128, 128],  // B42, target 200 → step 128; last sample at 128 covers [128..255]
        [256, 50, 32, 224],
        [256, 7, 4, 252],
        [300, 100, 100, 200],  // B41, target 100 → step 100 (300%100==0); last sample 200 covers [200..299]
        [300, 128, 100, 200],
        [300, 200, 150, 150],
    ])('cellEdge=%i target=%i → step=%i, last iter=%i ; covers right strip',
        (cellEdge, target, expectedStep, expectedLast) => {
            const step = pickDivisorAtMost(cellEdge, target);
            expect(step).toBe(expectedStep);
            expect(lastIteratedSquare(cellEdge, step)).toBe(expectedLast);
            // CRITICAL: the gap between last iter and cellEdge is exactly `step`
            // (one final iteration step), which means a sprite placed there
            // visually represents the entire right edge of the cell — no hole.
            expect(cellEdge - expectedLast).toBe(step);
        },
    );
});
