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
