/**
 * Static chunk loader for pre-packed PZ cell data.
 *
 * Backend command `php artisan zomboid:build-cell-archives` writes:
 *   /pz-cell-data/index.json     — {version, chunkSize, cells:{"X_Y":"chunkKey"}}
 *   /pz-cell-data/chunk-N_M.bin  — same binary layout as cellsBulk endpoint
 *   /pz-cell-data/chunk-N_M.bin.gz — pre-compressed; nginx gzip_static picks it
 *
 * nginx serves chunks directly with immutable+1y cache, bypassing PHP-FPM
 * entirely. After the first visit each chunk lives in the browser cache
 * forever, so repeat sessions have zero network cost.
 */

import { getCachedChunk, setCachedChunk } from './atlas-idb-cache';

export interface ChunkIndex {
    version: number;
    chunkSize: number;
    /** "cellX_cellY" → "chunkX_chunkY" */
    cells: Record<string, string>;
}

let cachedIndex: ChunkIndex | null = null;
let indexPromise: Promise<ChunkIndex | null> | null = null;

/**
 * Fetch and cache the chunk manifest. Returns null when the manifest is
 * absent (artisan command never run) — callers should fall back to the
 * PHP bulk endpoint in that case.
 */
export async function loadChunkIndex(baseUrl = '/pz-cell-data'): Promise<ChunkIndex | null> {
    if (cachedIndex) return cachedIndex;
    if (indexPromise) return indexPromise;

    indexPromise = (async (): Promise<ChunkIndex | null> => {
        try {
            const res = await fetch(`${baseUrl}/index.json`, { credentials: 'same-origin' });
            if (!res.ok) return null;
            const idx = (await res.json()) as ChunkIndex;
            cachedIndex = idx;
            return idx;
        } catch {
            return null;
        } finally {
            indexPromise = null;
        }
    })();

    return indexPromise;
}

// ---------------------------------------------------------------------------
// Chunk fetch — in-flight dedupe + bounded in-memory cache.
//
// `chunkBuffers` is an LRU keyed by chunk coord. Capping it prevents the
// preloadAllChunks() path from pinning the full map (70 × ~5 MB = 350 MB)
// in JS heap for the lifetime of the session: chunks remain on disk via
// IndexedDB so a cache miss after eviction is cheap, but the resident
// working set stays bounded.
// ---------------------------------------------------------------------------

const CHUNK_LRU_CAPACITY = 24;
const chunkBuffers = new Map<string, ArrayBuffer>();
const chunkPromises = new Map<string, Promise<ArrayBuffer | null>>();

function getCachedChunkBuffer(key: string): ArrayBuffer | undefined {
    const buf = chunkBuffers.get(key);
    if (!buf) return undefined;
    // Promote to MRU.
    chunkBuffers.delete(key);
    chunkBuffers.set(key, buf);
    return buf;
}

function setCachedChunkBuffer(key: string, buf: ArrayBuffer): void {
    if (chunkBuffers.has(key)) {
        chunkBuffers.delete(key);
    } else if (chunkBuffers.size >= CHUNK_LRU_CAPACITY) {
        const lruKey = chunkBuffers.keys().next().value;
        if (lruKey !== undefined) {
            chunkBuffers.delete(lruKey);
        }
    }
    chunkBuffers.set(key, buf);
}

/**
 * Eagerly download every chunk listed in the index. Used by the page's
 * preload overlay so the user sees an explicit progress bar instead of
 * mid-pan hiccups when chunks stream in.
 */
export async function preloadAllChunks(
    onProgress: (done: number, total: number) => void,
    baseUrl = '/pz-cell-data',
): Promise<void> {
    const index = await loadChunkIndex(baseUrl);
    if (!index) return;
    const chunkKeys = Array.from(new Set(Object.values(index.cells)));
    let done = 0;
    onProgress(0, chunkKeys.length);

    // Bounded concurrency — browsers cap simultaneous requests per origin,
    // and we don't want to drown the network with 70 parallel ~5 MB fetches.
    const CONCURRENCY = 6;
    let nextIdx = 0;
    const worker = async (): Promise<void> => {
        while (true) {
            const i = nextIdx++;
            if (i >= chunkKeys.length) return;
            await fetchChunkBinary(chunkKeys[i]!, baseUrl);
            done++;
            onProgress(done, chunkKeys.length);
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

export async function fetchChunkBinary(
    chunkKey: string,
    baseUrl = '/pz-cell-data',
): Promise<ArrayBuffer | null> {
    const cached = getCachedChunkBuffer(chunkKey);
    if (cached) return cached;
    const inflight = chunkPromises.get(chunkKey);
    if (inflight) return inflight;

    const p = (async (): Promise<ArrayBuffer | null> => {
        try {
            // Try IDB first — chunks are immutable per atlas version, so a
            // hit means we can skip network entirely (browser HTTP cache is
            // unreliable across reloads at this size).
            const version = cachedIndex?.version != null ? String(cachedIndex.version) : 'unknown';
            const idbHit = await getCachedChunk(version, chunkKey);
            if (idbHit) {
                setCachedChunkBuffer(chunkKey, idbHit);
                return idbHit;
            }
            const res = await fetch(`${baseUrl}/chunk-${chunkKey}.bin`, { credentials: 'same-origin' });
            if (!res.ok) return null;
            const buf = await res.arrayBuffer();
            setCachedChunkBuffer(chunkKey, buf);
            void setCachedChunk(version, chunkKey, buf);
            return buf;
        } catch {
            return null;
        } finally {
            chunkPromises.delete(chunkKey);
        }
    })();

    chunkPromises.set(chunkKey, p);
    return p;
}

// ---------------------------------------------------------------------------
// Cell extraction from a chunk binary stream.
// Layout (matches PzMapDataController::cellsBulk / BuildCellArchivesCommand):
//   [uint32 LE count]
//   per cell:  [u16 cellX] [u16 cellY] [u32 headerLen] [u32 lotpackLen]
//   body:      concat(header bytes + lotpack bytes per cell)
// ---------------------------------------------------------------------------

export interface ExtractedCell {
    cellX: number;
    cellY: number;
    headerBuffer: ArrayBuffer;
    lotpackBuffer: ArrayBuffer;
}

export function extractCellFromChunk(
    chunkBuf: ArrayBuffer,
    targetCellX: number,
    targetCellY: number,
): ExtractedCell | null {
    if (chunkBuf.byteLength < 4) return null;
    const view = new DataView(chunkBuf);
    const count = view.getUint32(0, true);
    const tableStart = 4;
    let bodyPos = tableStart + count * 12;

    for (let i = 0; i < count; i++) {
        const t = tableStart + i * 12;
        const cellX = view.getUint16(t, true);
        const cellY = view.getUint16(t + 2, true);
        const hLen = view.getUint32(t + 4, true);
        const lLen = view.getUint32(t + 8, true);

        if (cellX === targetCellX && cellY === targetCellY) {
            if (hLen === 0 || lLen === 0) return null;
            return {
                cellX,
                cellY,
                headerBuffer: chunkBuf.slice(bodyPos, bodyPos + hLen),
                lotpackBuffer: chunkBuf.slice(bodyPos + hLen, bodyPos + hLen + lLen),
            };
        }

        bodyPos += hLen + lLen;
    }
    return null;
}

/**
 * Extract every cell in the chunk that matches one of the requested coords.
 * One scan of the table instead of N scans via extractCellFromChunk().
 */
export function extractCellsFromChunk(
    chunkBuf: ArrayBuffer,
    wanted: Set<string>,
): ExtractedCell[] {
    if (chunkBuf.byteLength < 4) return [];
    const view = new DataView(chunkBuf);
    const count = view.getUint32(0, true);
    const tableStart = 4;
    let bodyPos = tableStart + count * 12;

    const out: ExtractedCell[] = [];
    for (let i = 0; i < count; i++) {
        const t = tableStart + i * 12;
        const cellX = view.getUint16(t, true);
        const cellY = view.getUint16(t + 2, true);
        const hLen = view.getUint32(t + 4, true);
        const lLen = view.getUint32(t + 8, true);

        if (hLen > 0 && lLen > 0 && wanted.has(`${cellX}_${cellY}`)) {
            out.push({
                cellX,
                cellY,
                headerBuffer: chunkBuf.slice(bodyPos, bodyPos + hLen),
                lotpackBuffer: chunkBuf.slice(bodyPos + hLen, bodyPos + hLen + lLen),
            });
        }

        bodyPos += hLen + lLen;
    }
    return out;
}
