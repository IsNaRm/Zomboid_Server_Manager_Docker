/**
 * AtlasPageManager — lazy, LOD-aware atlas page residency.
 *
 * Replaces the old "load all 51 pages × 4096² RGBA8 = 3.3 GB VRAM" model.
 * The manager keeps one TEXTURE_2D_ARRAY per active LOD, lazily uploading
 * only the pages the renderer asks for. When the user pans away from an
 * area and the resident-page LRU overflows, the manager frees the layer
 * (clears the slot for re-use) without destroying the texture itself.
 *
 * Memory model
 * ============
 *   - One WebGLTexture per LOD in `textures`.
 *   - Each texture is allocated for MAX_LAYERS slots (decoupled from the
 *     atlas page count: 24 layers × 4 LODs is enough for any practical
 *     viewport even on Knox County).
 *   - `pageToSlot` maps `pageId` to a slot index in the array. When the
 *     LRU evicts a slot, its mapping is dropped and the next ensurePages
 *     can reuse it.
 *
 * Quality fallback
 * ================
 * When the renderer asks for a page at a LOD that hasn't loaded yet,
 * `hasPage` returns false for that exact (page, lod) pair. The tile
 * renderer uses this set as `availablePages` and silently skips sprites
 * on missing pages — the result is a progressively-filling tile, never
 * a freeze. As pages finish uploading the layer triggers a re-render
 * via the redraw callback.
 *
 * UV format
 * =========
 * Spreads across LODs trivially because sprites.json stores UVs as
 * normalised ratios [0..1]. The same sample rectangle works whether the
 * page is 4096² or 512²; only the GL_TEXTURE_2D_ARRAY internal storage
 * differs. (For backwards compatibility with the pre-normalisation atlas
 * the renderer detects via `manifest.uv_format` — see tile-renderer.ts.)
 */

import { fetchAtlasPageBlob } from './atlas-loader';
import {
    bindAtlasArray,
    createAtlasArray,
    createCompressedAtlasArray,
    detectCompressedFormat,
    type CompressedTextureSupport,
    uploadAtlasArrayLayer,
    uploadCompressedAtlasArrayLayer,
} from './gl/textures';
import { parseKtx2 } from './ktx2-decoder';
import type { AtlasLodInfo, AtlasPageFormat } from './types';

/**
 * Per-LOD slot allocation strategy.
 *
 * Each LOD has its own TEXTURE_2D_ARRAY pre-allocated with N slots
 * (immutable storage via texStorage3D — can't grow without realloc).
 * We want N big enough to avoid LRU thrash (the viewport's unique-pages
 * set must fit), but small enough to fit in VRAM. The two constraints
 * are reconciled by capping N at min(pageCount, VRAM_BUDGET / pageSize).
 *
 * Defaults give:
 *   lod0 (4096²×4 = 64 MB/page): min(51, 32) = 32 slots ≈ 2.0 GB VRAM
 *   lod1 (2048²×4 = 16 MB/page): min(51, 128) = 51 slots ≈ 850 MB VRAM
 *   lod2 (1024²×4 = 4 MB/page):  51 slots ≈ 200 MB VRAM
 *   lod3 (512²×4 = 1 MB/page):   51 slots ≈ 50 MB VRAM
 *
 * Inactive LODs are released by `releaseLod()` so VRAM at any moment is
 * bounded by the *active* LOD's allocation.
 *
 * If the viewport requires more unique pages than the active LOD's slot
 * cap at lod0, sprites on non-resident pages render as gaps (renderer
 * checks `slotForPage >= 0`) — no thrash, no infinite redraw.
 */
const MIN_SLOTS_PER_LOD = 8;
const VRAM_BUDGET_PER_LOD_MB = 2048;

/** Pages to fetch in parallel per `ensurePages` call. Same as old WORK_POOL. */
const FETCH_CONCURRENCY = 6;

/** Per-page download progress callback. */
export type AtlasProgressCallback = (loadedPages: number, totalPages: number) => void;

export interface AtlasPageManagerOptions {
    gl: WebGL2RenderingContext;
    /** Atlas LOD descriptors, ordered by id ascending. lod[0] is mandatory. */
    lods: AtlasLodInfo[];
    /** Atlas version string (used for cache busting / IDB keys). */
    version: string;
    /** Atlas page count (total pages in the manifest). */
    pageCount: number;
    /** Base URL the manager fetches pages from (e.g. `/pz-atlas`). */
    baseUrl: string;
    /**
     * Server claims KTX2 is available. The manager still verifies the
     * client has the matching GL extension before using it.
     */
    serverHasKtx2: boolean;
    /**
     * Atlas-page filename pattern. Receives a `{lod, pageId, format}` tuple
     * and returns the URL relative to baseUrl. Lets us swap the legacy
     * single-LOD layout (`atlas-{ver}-{pageId}.webp`) with the new
     * multi-LOD layout (`atlas-{ver}-{pageId}-lod{lod}.{format}`).
     */
    fileTemplate: (lod: number, pageId: number, format: AtlasPageFormat) => string;
}

interface LodState {
    info: AtlasLodInfo;
    /** GL texture array allocated for this LOD. */
    texture: WebGLTexture;
    /**
     * pageId → slot index in the array. Missing key = page not resident.
     */
    pageToSlot: Map<number, number>;
    /** Reverse map slot → pageId for fast LRU eviction. */
    slotToPage: Map<number, number>;
    /**
     * LRU order — most-recently-used at the tail. Items are pageIds.
     */
    lru: number[];
    /** Set of free slot indices ready for re-use. */
    freeSlots: number[];
    /** In-flight load promise per page so concurrent ensurePages dedupe. */
    inflight: Map<number, Promise<boolean>>;
    /** Pages that genuinely failed to load (404) — skip on next request. */
    failed: Set<number>;
}

export class AtlasPageManager {
    private readonly gl: WebGL2RenderingContext;
    private readonly opts: AtlasPageManagerOptions;
    private readonly lodStates: Map<number, LodState> = new Map();
    private readonly compressedSupport: CompressedTextureSupport;
    /**
     * Which format to actually fetch. Webp when GPU can't do KTX2 or the
     * server didn't ship a KTX2 variant.
     */
    private readonly format: AtlasPageFormat;
    /** Listener invoked when pages become resident — triggers tile redraw. */
    private redrawListener: (() => void) | null = null;

    constructor(opts: AtlasPageManagerOptions) {
        this.gl = opts.gl;
        this.opts = opts;
        this.compressedSupport = detectCompressedFormat(this.gl);
        this.format = this.compressedSupport.format !== null && opts.serverHasKtx2
            ? 'ktx2'
            : 'webp';
    }

    /** Format the manager actually uses (after compatibility check). */
    get pageFormat(): AtlasPageFormat {
        return this.format;
    }

    /**
     * Register a redraw callback that fires when pages finish loading.
     * The layer uses this to invalidate cached tile bitmaps so a tile that
     * was rendered with missing pages gets re-rendered.
     */
    onRedraw(cb: () => void): void {
        this.redrawListener = cb;
    }

    /**
     * Allocate the GPU array for a LOD on first use. Idempotent. The array
     * is sized to hold every atlas page (pageCount slots) so the LRU
     * never thrashes — even when the visible viewport requires every page
     * (e.g. at max zoom-out across the whole map).
     */
    private ensureLodAllocated(lodId: number): LodState {
        const existing = this.lodStates.get(lodId);
        if (existing) return existing;

        const info = this.opts.lods.find((l) => l.id === lodId);
        if (!info) {
            throw new Error(`[atlas-page-manager] no descriptor for LOD ${lodId}`);
        }

        const slotCount = this._slotCountForLod(info);

        let texture: WebGLTexture;
        if (this.format === 'ktx2') {
            texture = createCompressedAtlasArray(
                this.gl,
                info.size,
                slotCount,
                this.compressedSupport.glInternalFormat,
            );
        } else {
            texture = createAtlasArray(this.gl, info.size, slotCount);
        }

        const state: LodState = {
            info,
            texture,
            pageToSlot: new Map(),
            slotToPage: new Map(),
            lru: [],
            freeSlots: Array.from({ length: slotCount }, (_, i) => i),
            inflight: new Map(),
            failed: new Set(),
        };
        this.lodStates.set(lodId, state);
        return state;
    }

    /**
     * Release a LOD's texture array entirely. Called by the layer when
     * the active LOD changes — keeping every LOD allocated would balloon
     * VRAM (lod0 alone is ~3.4 GB for a 51-page atlas, plus lod1/2/3).
     * The caller is responsible for re-uploading pages if it switches
     * back to this LOD (the manifest URL is the source of truth).
     */
    releaseLod(lodId: number): void {
        const state = this.lodStates.get(lodId);
        if (!state) return;
        this.gl.deleteTexture(state.texture);
        this.lodStates.delete(lodId);
    }

    /**
     * Fetch a single page binary and upload it to the next free slot.
     * Returns true when the page is now resident, false on permanent
     * failure (404 etc.) so the caller can stop retrying.
     */
    private async loadPage(state: LodState, pageId: number, onProgress?: AtlasProgressCallback, totalPages?: number, loadedRef?: { count: number }): Promise<boolean> {
        if (state.pageToSlot.has(pageId)) return true;
        if (state.failed.has(pageId)) return false;
        const existing = state.inflight.get(pageId);
        if (existing) return existing;

        const url = this.opts.baseUrl + '/' + this.opts.fileTemplate(state.info.id, pageId, this.format);
        const promise = (async (): Promise<boolean> => {
            try {
                const blob = await fetchAtlasPageBlob(url, this.opts.version, pageId, state.info.id, this.format);
                if (!blob) {
                    state.failed.add(pageId);
                    return false;
                }
                // Allocate a slot — evict LRU if necessary.
                if (state.freeSlots.length === 0) {
                    this.evictOne(state);
                }
                const slot = state.freeSlots.shift()!;
                if (this.format === 'ktx2') {
                    const buf = await blob.arrayBuffer();
                    const tex = parseKtx2(buf);
                    uploadCompressedAtlasArrayLayer(this.gl, state.texture, slot, tex);
                } else {
                    const bitmap = await createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none' });
                    uploadAtlasArrayLayer(this.gl, state.texture, slot, bitmap);
                    bitmap.close();
                }
                state.pageToSlot.set(pageId, slot);
                state.slotToPage.set(slot, pageId);
                state.lru.push(pageId);
                if (loadedRef) {
                    loadedRef.count++;
                    if (onProgress && totalPages !== undefined) {
                        onProgress(loadedRef.count, totalPages);
                    }
                }
                return true;
            } catch (err) {
                console.warn(`[atlas-page-manager] failed to load page ${pageId} lod ${state.info.id}:`, err);
                state.failed.add(pageId);
                return false;
            } finally {
                state.inflight.delete(pageId);
            }
        })();
        state.inflight.set(pageId, promise);
        return promise;
    }

    /**
     * LRU eviction policy. Free the slot of the LRU page — the texture
     * memory itself stays allocated (it's a fixed-size array), but the
     * slot becomes free for re-use by the next load.
     */
    private evictOne(state: LodState): void {
        const victim = state.lru.shift();
        if (victim === undefined) return;
        const slot = state.pageToSlot.get(victim);
        if (slot === undefined) return;
        state.pageToSlot.delete(victim);
        state.slotToPage.delete(slot);
        state.freeSlots.push(slot);
    }

    /**
     * Ensure every page in `pageIds` is resident at `lod`. Returns when
     * either all pages are loaded or definitely failed. The promise is
     * fast (sub-frame) when everything is already resident — that's the
     * hot path on a stationary viewport.
     *
     * Pages are uploaded in batches of FETCH_CONCURRENCY so a viewport
     * that needs 20 fresh pages doesn't open 20 simultaneous TCP
     * connections.
     */
    async ensurePages(
        pageIds: Iterable<number>,
        lodId: number,
        onProgress?: AtlasProgressCallback,
    ): Promise<void> {
        const state = this.ensureLodAllocated(lodId);

        // Promote already-resident pages to MRU and collect the misses.
        const misses: number[] = [];
        for (const pageId of pageIds) {
            if (state.pageToSlot.has(pageId)) {
                // Touch — move to MRU end.
                const idx = state.lru.indexOf(pageId);
                if (idx >= 0 && idx !== state.lru.length - 1) {
                    state.lru.splice(idx, 1);
                    state.lru.push(pageId);
                }
                continue;
            }
            if (state.failed.has(pageId)) continue;
            misses.push(pageId);
        }
        if (misses.length === 0) return;

        // Bounded parallel fetch.
        let cursor = 0;
        const loadedRef = { count: 0 };
        const total = misses.length;
        const worker = async (): Promise<void> => {
            while (true) {
                const i = cursor++;
                if (i >= misses.length) return;
                const pageId = misses[i]!;
                await this.loadPage(state, pageId, onProgress, total, loadedRef);
            }
        };
        const workers = Array.from(
            { length: Math.min(FETCH_CONCURRENCY, misses.length) },
            () => worker(),
        );
        await Promise.all(workers);

        // Notify renderer to invalidate any tile that was drawn with
        // missing pages — the next render fills them in.
        this.redrawListener?.();
    }

    /** True when the page is resident at the given LOD. */
    hasPage(pageId: number, lodId: number): boolean {
        const state = this.lodStates.get(lodId);
        return state ? state.pageToSlot.has(pageId) : false;
    }

    /**
     * Return the GL texture for a LOD, allocating it if necessary. The
     * texture is empty until ensurePages uploads layers into it.
     */
    getTextureForLod(lodId: number): WebGLTexture {
        return this.ensureLodAllocated(lodId).texture;
    }

    /**
     * Return the Set of resident page IDs for the given LOD. Used by
     * tile-renderer as `availablePages` so it can skip instances on
     * not-yet-loaded pages.
     */
    residentPages(lodId: number): Set<number> {
        const state = this.lodStates.get(lodId);
        if (!state) return new Set();
        return new Set(state.pageToSlot.keys());
    }

    /**
     * Look up the slot index a page occupies. The renderer needs this to
     * translate `entry.atlas` (page ID) into a TEXTURE_2D_ARRAY layer
     * index. Returns -1 if the page is not resident.
     */
    slotForPage(pageId: number, lodId: number): number {
        const state = this.lodStates.get(lodId);
        if (!state) return -1;
        return state.pageToSlot.get(pageId) ?? -1;
    }

    /**
     * Drop ALL pages from a given LOD. Used when the user crosses a LOD
     * boundary and we want to reclaim VRAM (the higher-LOD array is no
     * longer the active one).
     */
    clearLod(lodId: number): void {
        const state = this.lodStates.get(lodId);
        if (!state) return;
        const slotCount = this._slotCountForLod(state.info);
        state.pageToSlot.clear();
        state.slotToPage.clear();
        state.lru.length = 0;
        state.freeSlots = Array.from({ length: slotCount }, (_, i) => i);
    }

    /**
     * Compute the slot count for a LOD: capped by both the total page
     * count and the per-LOD VRAM budget so a single huge atlas can't
     * exhaust the GPU.
     */
    private _slotCountForLod(info: AtlasLodInfo): number {
        const pageSizeMB = (info.size * info.size * 4) / (1024 * 1024);
        const budgetSlots = Math.max(1, Math.floor(VRAM_BUDGET_PER_LOD_MB / pageSizeMB));
        return Math.max(
            MIN_SLOTS_PER_LOD,
            Math.min(this.opts.pageCount, budgetSlots),
        );
    }

    /** Bind the active LOD texture to a sampler unit. */
    bind(lodId: number, unit = 0): WebGLTexture {
        const tex = this.getTextureForLod(lodId);
        bindAtlasArray(this.gl, tex, unit);
        return tex;
    }

    /** Release all GL textures. Call when the component unmounts. */
    dispose(): void {
        for (const state of this.lodStates.values()) {
            this.gl.deleteTexture(state.texture);
        }
        this.lodStates.clear();
    }
}
