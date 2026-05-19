/**
 * Tests for CellCache — LRU with both entry-count and byte-budget eviction.
 */

import { describe, expect, it } from 'vitest';
import { CellCache } from '../cell-cache';
import type { CellData, CellMetadata, LotpackData, SquareLayerData, BlockLayer } from '../types';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal CellData with a controllable "density" so the byte
 * estimator can distinguish sparse from dense cells. `density` controls
 * how many non-null blocks the lotpack has.
 */
function makeCellData(cellX: number, cellY: number, density: number): CellData {
    const cellSizeInBlocks = 32;
    const blockSize = 8;
    // LotpackData.blocks is BlockLayer[] but individual entries may be
    // null in real lotpacks — the runtime type accepts nulls even though
    // TypeScript's BlockLayer alias doesn't include it explicitly. Cast
    // through `any` at the array level to mirror real-world data shape.
    const blocks: Array<BlockLayer | null> = [];
    const totalBlocks = cellSizeInBlocks * cellSizeInBlocks;
    for (let i = 0; i < totalBlocks; i++) {
        if (i < density) {
            // One layer with one filled square at (0,0) containing 4 sprites.
            const layer = [[[1, 2, 3, 4]]];
            blocks.push([layer] as unknown as BlockLayer);
        } else {
            blocks.push(null);
        }
    }
    const header: CellMetadata = {
        version: 1,
        pzVersion: 'B42',
        cellX,
        cellY,
        spriteNames: [],
        width: 256,
        height: 256,
        minLayer: 0,
        maxLayer: 1,
        cellSizeInBlocks,
        blockSize,
        rooms: [],
        buildings: [],
        zpop: [],
    };
    const lotpack: LotpackData = { version: 1, blocks: blocks as BlockLayer[] };
    const cell: SquareLayerData = {
        header,
        lotpack,
        getSquare: () => null,
    };
    return { cellX, cellY, header, cell, save: null, fetchedAt: 0 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CellCache — entry-count eviction', () => {
    it('evicts the least recently used entry once maxEntries is exceeded', () => {
        const cache = new CellCache(2, 1024 * 1024 * 1024); // huge byte budget so it never trips
        cache.set(makeCellData(0, 0, 1));
        cache.set(makeCellData(1, 0, 1));
        cache.set(makeCellData(2, 0, 1)); // should evict (0,0)

        expect(cache.has(0, 0)).toBe(false);
        expect(cache.has(1, 0)).toBe(true);
        expect(cache.has(2, 0)).toBe(true);
        expect(cache.size).toBe(2);
    });

    it('promotes get-hit entries to MRU position', () => {
        const cache = new CellCache(2, 1024 * 1024 * 1024);
        cache.set(makeCellData(0, 0, 1));
        cache.set(makeCellData(1, 0, 1));
        // Touching (0,0) promotes it; the next insert should evict (1,0).
        cache.get(0, 0);
        cache.set(makeCellData(2, 0, 1));

        expect(cache.has(0, 0)).toBe(true);
        expect(cache.has(1, 0)).toBe(false);
        expect(cache.has(2, 0)).toBe(true);
    });
});

describe('CellCache — byte-budget eviction', () => {
    it('evicts entries when bytes exceed the byte budget', () => {
        // Tiny byte budget; entry cap is huge so only bytes matter.
        const cache = new CellCache(1000, 8 * 1024);
        // density=400 → roughly 400 × (64 + 64 + 32 + 32 + 4×12) ≈ 78 KB
        cache.set(makeCellData(0, 0, 400));
        const firstBytes = cache.bytes;
        cache.set(makeCellData(1, 0, 400));

        // After the second insert we must have evicted (0,0) to fit budget.
        expect(cache.has(0, 0)).toBe(false);
        expect(cache.has(1, 0)).toBe(true);
        // Bytes are now equal to the second cell's contribution alone.
        expect(cache.bytes).toBeLessThanOrEqual(firstBytes);
    });

    it('tracks bytesUsed across set/get/delete', () => {
        const cache = new CellCache(100, 1024 * 1024 * 1024);
        expect(cache.bytes).toBe(0);

        cache.set(makeCellData(0, 0, 50));
        const after1 = cache.bytes;
        expect(after1).toBeGreaterThan(0);

        cache.set(makeCellData(1, 0, 50));
        const after2 = cache.bytes;
        expect(after2).toBeGreaterThan(after1);

        cache.delete(0, 0);
        expect(cache.bytes).toBeLessThan(after2);

        cache.clear();
        expect(cache.bytes).toBe(0);
        expect(cache.size).toBe(0);
    });

    it('replacing an existing key swaps the byte count', () => {
        const cache = new CellCache(100, 1024 * 1024 * 1024);
        cache.set(makeCellData(0, 0, 50));
        const lightBytes = cache.bytes;
        // Replace with a much denser version of the same cell.
        cache.set(makeCellData(0, 0, 500));
        expect(cache.bytes).toBeGreaterThan(lightBytes);
        expect(cache.size).toBe(1);
    });
});

describe('CellCache — entries() iteration', () => {
    it('yields stored CellData objects (not internal entry wrappers)', () => {
        const cache = new CellCache(10, 1024 * 1024 * 1024);
        const a = makeCellData(0, 0, 1);
        const b = makeCellData(1, 0, 1);
        cache.set(a);
        cache.set(b);

        const collected: CellData[] = [];
        for (const [, data] of cache.entries()) {
            collected.push(data);
        }

        expect(collected).toHaveLength(2);
        expect(collected.some((c) => c.cellX === 0 && c.cellY === 0)).toBe(true);
        expect(collected.some((c) => c.cellX === 1 && c.cellY === 0)).toBe(true);
    });
});
