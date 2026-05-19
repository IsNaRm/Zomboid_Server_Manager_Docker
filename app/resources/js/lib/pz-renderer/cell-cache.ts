/**
 * LRU cache for parsed map cells.
 *
 * Two budgets enforce capacity:
 *   - hard entry cap (MAX_ENTRIES) prevents the Map itself from growing too
 *     large (each entry has Map overhead independent of CellData size)
 *   - byte budget (MAX_BYTES) tracks the approximate RSS held by parsed
 *     lotpacks so a handful of dense urban cells can't blow past 400 MB
 *     while leaving the entry count low
 *
 * Eviction strategy: when either budget is exceeded, repeatedly drop the
 * least-recently-used entry until both are under their limits.
 *
 * The byte estimate is a coarse approximation — we count non-null block
 * layers × an average sprite-list length. That's enough fidelity to
 * distinguish a sparse rural cell (~0.5 MB) from a dense urban one
 * (~4-6 MB) without walking every sprite list.
 *
 * M7 extension: separate save-data LRU cache (`saveCache`) mirrors the
 * base cache but holds SaveGameData | null. Null means "server returned 404
 * (no player modifications for this cell)" — still cached to avoid repeat
 * requests. Use `invalidateSaves()` to flush after a version bump.
 */

import { type CellData, type SaveGameData } from './types';
import { parseSavegame, isSaveGameBuffer } from './parsers/savegame';

/** Maximum entries regardless of byte budget. */
const MAX_ENTRIES = 96;
/** Soft byte budget (256 MB). Holds the largest realistic working set
 *  (~3 viewport tiles' worth of cells) without runaway memory growth. */
const MAX_BYTES = 256 * 1024 * 1024;

/** Format a cell key from coordinates. */
export function cellKey(cellX: number, cellY: number): string {
    return `${cellX}_${cellY}`;
}

/**
 * Estimate the in-RAM cost of a parsed CellData. We count non-null block
 * layers and per-block sprite stacks; constants are calibrated against a
 * Muldraugh sample (rural ≈ 0.4 MB, downtown ≈ 5 MB).
 *
 * Cost is dominated by the nested arrays of sprite-index integers held
 * inside each block; JS engines typically use ~40 bytes per array + 8
 * bytes per number element with sparse-element overhead. The constant
 * factor below is conservative — we'd rather over-estimate and evict
 * a hair more aggressively than under-estimate and OOM.
 */
function estimateBytes(data: CellData): number {
    const blocks = data.cell.lotpack.blocks;
    let cost = 4096; // fixed overhead (header, room descriptors, etc.)
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (!block) continue;
        cost += 64; // outer block overhead
        for (let l = 0; l < block.length; l++) {
            const layer = block[l];
            if (!layer) continue;
            cost += 64;
            for (let lx = 0; lx < layer.length; lx++) {
                const col = layer[lx];
                if (!col) continue;
                cost += 32;
                for (let ly = 0; ly < col.length; ly++) {
                    const cell = col[ly];
                    if (!cell) continue;
                    // each int sprite index ≈ 8 bytes V8 SMI + array slot overhead
                    cost += 32 + cell.length * 12;
                }
            }
        }
    }
    return cost;
}

interface CacheEntry {
    data: CellData;
    bytes: number;
}

export class CellCache {
    private readonly cache: Map<string, CacheEntry> = new Map();
    /** Separate LRU for save-game binaries. null = confirmed 404 (no save data). */
    private readonly saveCache: Map<string, SaveGameData | null> = new Map();
    private readonly maxEntries: number;
    private readonly maxBytes: number;
    private bytesUsed = 0;

    constructor(maxEntries: number = MAX_ENTRIES, maxBytes: number = MAX_BYTES) {
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
    }

    /**
     * Retrieve a cell from cache, promoting it to MRU position.
     * Returns undefined on cache miss.
     */
    get(cellX: number, cellY: number): CellData | undefined {
        const key = cellKey(cellX, cellY);
        const entry = this.cache.get(key);
        if (entry === undefined) {
            return undefined;
        }
        // Promote to MRU: delete and re-insert
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.data;
    }

    /**
     * Store a cell. Evicts LRU entries until both the entry- and byte
     * budgets are within limits.
     */
    set(data: CellData): void {
        const key = cellKey(data.cellX, data.cellY);

        // Replace existing entry's bytes if present.
        const existing = this.cache.get(key);
        if (existing) {
            this.bytesUsed -= existing.bytes;
            this.cache.delete(key);
        }

        const bytes = estimateBytes(data);
        this.cache.set(key, { data, bytes });
        this.bytesUsed += bytes;

        // Evict LRU entries until under both budgets. We never evict the
        // entry we just inserted, but its bytes count toward the budget.
        const it = this.cache.keys();
        while (
            (this.cache.size > this.maxEntries || this.bytesUsed > this.maxBytes)
            && this.cache.size > 1
        ) {
            const lruKey = it.next().value;
            if (lruKey === undefined || lruKey === key) break;
            const lruEntry = this.cache.get(lruKey);
            if (lruEntry) {
                this.bytesUsed -= lruEntry.bytes;
            }
            this.cache.delete(lruKey);
        }
    }

    /**
     * Remove a specific cell from cache (e.g. after atlas rebuild).
     */
    delete(cellX: number, cellY: number): void {
        const key = cellKey(cellX, cellY);
        const entry = this.cache.get(key);
        if (entry) {
            this.bytesUsed -= entry.bytes;
            this.cache.delete(key);
        }
    }

    /**
     * Evict all cached cells. Call after atlas version change.
     */
    clear(): void {
        this.cache.clear();
        this.saveCache.clear();
        this.bytesUsed = 0;
    }

    /**
     * Evict only save-game data (base cells are reused).
     * Call when the manifest version bumps but the atlas hasn't changed.
     */
    invalidateSaves(): void {
        this.saveCache.clear();
    }

    /** Current number of cached cells. */
    get size(): number {
        return this.cache.size;
    }

    /** Maximum entry count. */
    get capacity(): number {
        return this.maxEntries;
    }

    /** Current byte usage according to estimateBytes(). */
    get bytes(): number {
        return this.bytesUsed;
    }

    /**
     * Check if a cell is cached without changing LRU order.
     */
    has(cellX: number, cellY: number): boolean {
        return this.cache.has(cellKey(cellX, cellY));
    }

    /**
     * Iterate over all cached entries (oldest first = LRU order).
     */
    *entries(): IterableIterator<[string, CellData]> {
        for (const [key, entry] of this.cache) {
            yield [key, entry.data];
        }
    }

    // ---------------------------------------------------------------------------
    // M7: Save-game data cache
    // ---------------------------------------------------------------------------

    /**
     * Fetch and cache the save-game binary for a given cell.
     *
     * - Returns SaveGameData when the server has player modifications.
     * - Returns null when the cell has no save data (404 → new/unvisited area).
     * - Caches both outcomes (null = confirmed absent) to avoid repeat requests.
     *
     * @param cellX   Cell X coordinate.
     * @param cellY   Cell Y coordinate.
     * @param baseUrl Base URL used for API calls (e.g. '' for same-origin).
     */
    async getSave(cellX: number, cellY: number, baseUrl: string = ''): Promise<SaveGameData | null> {
        const key = cellKey(cellX, cellY);

        // Cache hit (including cached null)
        if (this.saveCache.has(key)) {
            const hit = this.saveCache.get(key)!;
            // Promote to MRU
            this.saveCache.delete(key);
            this.saveCache.set(key, hit);
            return hit;
        }

        // Evict oldest save entry if over capacity
        if (this.saveCache.size >= this.maxEntries) {
            const lruKey = this.saveCache.keys().next().value;
            if (lruKey !== undefined) {
                this.saveCache.delete(lruKey);
            }
        }

        // Fetch from server
        let saveData: SaveGameData | null = null;
        try {
            const url = `${baseUrl}/pz-map/cell/${cellX}/${cellY}/save`;
            const res = await fetch(url);

            if (res.status === 404) {
                // No save data for this cell — valid state (unmodified area)
                saveData = null;
            } else if (res.ok) {
                const buf = await res.arrayBuffer();
                if (isSaveGameBuffer(buf)) {
                    saveData = parseSavegame(buf);
                } else {
                    saveData = null;
                }
            } else {
                // Other server error — don't cache, let next tile request retry
                return null;
            }
        } catch {
            // Network error — don't cache
            return null;
        }

        this.saveCache.set(key, saveData);
        return saveData;
    }
}

/** Singleton default cache instance shared across all map tiles. */
export const defaultCellCache = new CellCache(MAX_ENTRIES, MAX_BYTES);
