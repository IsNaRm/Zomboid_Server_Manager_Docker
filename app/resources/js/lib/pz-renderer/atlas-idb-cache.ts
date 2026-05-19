/**
 * IndexedDB persistence layer for atlas WebP blobs.
 *
 * The browser HTTP cache evicts ~370 MB of immutable atlas pages under
 * memory pressure on a lot of machines (Chrome's heuristics aren't generous
 * when an origin uses lots of cache headroom). IndexedDB is bounded only
 * by per-origin storage quota (usually ~half the free disk), which means
 * once we've decoded an atlas page once it survives every reload.
 *
 * Keying is "{atlasVersion}/{pageId}" so a new atlas build automatically
 * invalidates the old pages (next call sees no hit and re-fetches). An
 * out-of-band sweep removes blobs from old versions to keep storage tidy.
 */

const DB_NAME = 'pz-atlas-cache';
const DB_VERSION = 2;
const STORE = 'atlas-pages';
export const CHUNK_STORE = 'cell-chunks';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDB(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        if (typeof indexedDB === 'undefined') {
            resolve(null);
            return;
        }
        // Request persistent storage so the browser does not silently evict
        // our ~370 MB blob cache under memory pressure. Fire-and-forget —
        // user denial just means we fall back to fresh downloads.
        if (typeof navigator !== 'undefined'
            && navigator.storage
            && typeof navigator.storage.persist === 'function') {
            navigator.storage.persist().then((granted) => {
                if (!granted) {
                    console.warn('[atlas-idb-cache] persistent storage not granted; cache may be evicted');
                }
            }).catch(() => { /* swallow */ });
        }

        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE);
            }
            if (!db.objectStoreNames.contains(CHUNK_STORE)) {
                db.createObjectStore(CHUNK_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
            console.warn('[atlas-idb-cache] open failed:', req.error);
            resolve(null);
        };
        req.onblocked = () => resolve(null);
    });
    return dbPromise;
}

function key(version: string, pageId: number): string {
    return `${version}/${pageId}`;
}

let dbgHits = 0;
let dbgMisses = 0;
let dbgStores = 0;
let dbgStoreFails = 0;

export async function getCachedAtlasPage(version: string, pageId: number): Promise<Blob | null> {
    const db = await openDB();
    if (!db) {
        if (pageId === 0) console.warn('[atlas-idb] DB unavailable on get');
        return null;
    }
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).get(key(version, pageId));
            req.onsuccess = () => {
                const val = req.result;
                const hit = val instanceof Blob;
                if (hit) dbgHits++; else dbgMisses++;
                if ((dbgHits + dbgMisses) % 10 === 0) {
                    console.log(`[atlas-idb] reads so far: ${dbgHits} hits, ${dbgMisses} misses`);
                }
                resolve(hit ? val : null);
            };
            req.onerror = () => {
                console.warn('[atlas-idb] get error:', req.error);
                resolve(null);
            };
        } catch (e) {
            console.warn('[atlas-idb] get threw:', e);
            resolve(null);
        }
    });
}

export async function setCachedAtlasPage(version: string, pageId: number, blob: Blob): Promise<void> {
    const db = await openDB();
    if (!db) {
        if (pageId === 0) console.warn('[atlas-idb] DB unavailable on set');
        return;
    }
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(blob, key(version, pageId));
            tx.oncomplete = () => {
                dbgStores++;
                if (dbgStores === 1 || dbgStores % 10 === 0) {
                    console.log(`[atlas-idb] stored ${dbgStores} pages (failures: ${dbgStoreFails})`);
                }
                resolve();
            };
            tx.onerror = () => {
                dbgStoreFails++;
                console.warn('[atlas-idb] store tx error:', tx.error);
                resolve();
            };
            tx.onabort = () => {
                dbgStoreFails++;
                console.warn('[atlas-idb] store tx aborted:', tx.error);
                resolve();
            };
        } catch (e) {
            dbgStoreFails++;
            console.warn('[atlas-idb] set threw:', e);
            resolve();
        }
    });
}

// ---------------------------------------------------------------------------
// Chunk binary cache — same IDB, separate object store. Persists raw bytes
// of /pz-cell-data/chunk-X_Y.bin so reloads don't re-download even when the
// browser HTTP cache evicts immutable responses.
// ---------------------------------------------------------------------------

let chunkHits = 0;
let chunkMisses = 0;
let chunkStores = 0;

export async function getCachedChunk(version: string, chunkKey: string): Promise<ArrayBuffer | null> {
    const db = await openDB();
    if (!db) return null;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(CHUNK_STORE, 'readonly');
            const req = tx.objectStore(CHUNK_STORE).get(`${version}/${chunkKey}`);
            req.onsuccess = () => {
                const val = req.result;
                if (val instanceof ArrayBuffer) {
                    chunkHits++;
                    if (chunkHits === 1 || chunkHits % 20 === 0) {
                        console.log(`[chunk-idb] reads: ${chunkHits} hits, ${chunkMisses} misses`);
                    }
                    resolve(val);
                } else {
                    chunkMisses++;
                    resolve(null);
                }
            };
            req.onerror = () => resolve(null);
        } catch {
            resolve(null);
        }
    });
}

export async function setCachedChunk(version: string, chunkKey: string, buf: ArrayBuffer): Promise<void> {
    const db = await openDB();
    if (!db) return;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(CHUNK_STORE, 'readwrite');
            tx.objectStore(CHUNK_STORE).put(buf, `${version}/${chunkKey}`);
            tx.oncomplete = () => {
                chunkStores++;
                if (chunkStores === 1 || chunkStores % 20 === 0) {
                    console.log(`[chunk-idb] stored ${chunkStores} chunks`);
                }
                resolve();
            };
            tx.onerror = () => resolve();
            tx.onabort = () => resolve();
        } catch {
            resolve();
        }
    });
}

/** Background sweep: remove blobs whose version != currentVersion. */
export async function clearStaleVersions(currentVersion: string): Promise<void> {
    const db = await openDB();
    if (!db) return;
    return new Promise((resolve) => {
        try {
            const tx = db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            const req = store.openKeyCursor();
            req.onsuccess = () => {
                const cur = req.result;
                if (!cur) { resolve(); return; }
                const k = String(cur.key);
                if (!k.startsWith(currentVersion + '/')) {
                    store.delete(cur.key);
                }
                cur.continue();
            };
            req.onerror = () => resolve();
        } catch {
            resolve();
        }
    });
}
