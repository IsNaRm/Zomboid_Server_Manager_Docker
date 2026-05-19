/**
 * LRU cache for parsed map cells.
 *
 * Stores up to MAX_SIZE CellData objects. When capacity is exceeded, the
 * least-recently-used entry is evicted.
 *
 * Implementation: a Map maintains insertion order. On each get/set we
 * delete + re-insert the key so the "oldest" (LRU) entry is always at
 * the front of the Map's iteration order — eviction is O(1).
 *
 * Max size: 100 cells (~400 MB RAM max, based on ~4 MB average cell).
 *
 * M7 extension: separate save-data LRU cache (`saveCache`) mirrors the
 * base cache but holds SaveGameData | null. Null means "server returned 404
 * (no player modifications for this cell)" — still cached to avoid repeat
 * requests. Use `invalidateSaves()` to flush after a version bump.
 */

import { type CellData, type SaveGameData } from './types';
import { parseSavegame, isSaveGameBuffer } from './parsers/savegame';

const MAX_SIZE = 100;

/** Format a cell key from coordinates. */
export function cellKey(cellX: number, cellY: number): string {
    return `${cellX}_${cellY}`;
}

export class CellCache {
    private readonly cache: Map<string, CellData> = new Map();
    /** Separate LRU for save-game binaries. null = confirmed 404 (no save data). */
    private readonly saveCache: Map<string, SaveGameData | null> = new Map();
    private readonly maxSize: number;

    constructor(maxSize: number = MAX_SIZE) {
        this.maxSize = maxSize;
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
        return entry;
    }

    /**
     * Store a cell. Evicts LRU entry if at capacity.
     */
    set(data: CellData): void {
        const key = cellKey(data.cellX, data.cellY);

        // If already present, delete first (will re-insert as MRU)
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // Evict LRU (first entry in Map iteration order)
            const lruKey = this.cache.keys().next().value;
            if (lruKey !== undefined) {
                this.cache.delete(lruKey);
            }
        }

        this.cache.set(key, data);
    }

    /**
     * Remove a specific cell from cache (e.g. after atlas rebuild).
     */
    delete(cellX: number, cellY: number): void {
        this.cache.delete(cellKey(cellX, cellY));
    }

    /**
     * Evict all cached cells. Call after atlas version change.
     */
    clear(): void {
        this.cache.clear();
        this.saveCache.clear();
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

    /** Maximum capacity. */
    get capacity(): number {
        return this.maxSize;
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
    entries(): IterableIterator<[string, CellData]> {
        return this.cache.entries();
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
        if (this.saveCache.size >= this.maxSize) {
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
export const defaultCellCache = new CellCache(MAX_SIZE);
