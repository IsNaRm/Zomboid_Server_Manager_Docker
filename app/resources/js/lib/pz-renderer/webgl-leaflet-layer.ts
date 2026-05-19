/**
 * WebGLPZLayer — Leaflet GridLayer extension that renders PZ map tiles via WebGL2.
 *
 * This layer is wired into pz-map.tsx by Milestone 5.  It keeps the WebGL
 * context alive for the lifetime of the layer and dispatches renderTile()
 * calls as Leaflet requests each 256×256 tile.
 *
 * The layer does NOT fetch cell data itself — it calls the provided
 * `fetchCellData` callback and expects the caller (M5) to supply a cell-cache
 * that returns CellData[] asynchronously.
 *
 * Usage:
 *   const layer = new WebGLPZLayer(renderer, {
 *     atlas,
 *     spriteIndex,
 *     projection,
 *     fetchCellData: async (z, x, y) => cache.get(z, x, y),
 *   });
 *   layer.addTo(map);
 */

import L from 'leaflet';
import { PzGLRenderer, type TileRenderInput } from './tile-renderer';
import type { AtlasPageManager } from './atlas-page-manager';
import { selectLod } from './lod-selection';
import {
    cellStrideForTuning,
    onRenderTuningChange,
    selectLodFromTuning,
} from './render-tuning';
import type { AtlasLodInfo, CellData, CellPagesMap, DziProjection, SpriteIndex } from './types';

// ---------------------------------------------------------------------------
// Render queue — frame-budgeted with viewport-distance priority + tile-
// unload cancellation. Without this Leaflet hands us 30+ tiles synchronously
// on each pan/zoom and the renderTile loop blocks main thread for seconds.
//
// Priority: jobs are sorted by squared distance from the layer's current
// viewport centre so the user sees the centre of the screen first and the
// periphery last (a tile in the corner is far less important than one
// directly under the cursor).
//
// Cancellation: when Leaflet emits tileunload for a tile coord, the
// corresponding queued job is dropped before it gets a chance to do any
// CPU work. At max zoom-out a flick pan can enqueue 30 tiles and unload 25
// of them within ~100 ms — without cancellation we'd render all 30.
// ---------------------------------------------------------------------------

interface RenderJob {
    /** Layer that scheduled the job (used for tileunload matching). */
    layer: WebGLPZLayer;
    /** Tile key `z_x_y` — matches the key used in tileunload events. */
    key: string;
    /** Squared distance from the layer's viewport centre (px²). Lower = sooner. */
    priority: number;
    /** Actual draw. Returns true if the tile was rendered, false if it bailed. */
    run: () => void;
}

const renderQueue: RenderJob[] = [];
let frameScheduled = false;
/**
 * Budget per frame (ms). Bumped to 50 ms because users were seeing
 * half-rendered viewports — the queue was processing 1-2 tiles per
 * 14 ms frame and 30 visible tiles took ~half a second to finish.
 * Brief frame stretches up to 50 ms are imperceptible during a pan/zoom
 * while shaving render-complete time to ~50 ms total.
 */
const FRAME_BUDGET_MS = 50;

let dbgFramesProcessed = 0;
let dbgTilesProcessed = 0;
let dbgLogStart = 0;

/**
 * Pop the lowest-priority job (closest to viewport centre). The queue is
 * kept loosely sorted: we insert in-order so popping the head is O(1).
 */
function popNext(): RenderJob | undefined {
    return renderQueue.shift();
}

function scheduleFrame(): void {
    if (frameScheduled) return;
    frameScheduled = true;
    requestAnimationFrame(() => {
        frameScheduled = false;
        const start = performance.now();
        if (dbgLogStart === 0) dbgLogStart = start;
        let tilesThisFrame = 0;
        while (renderQueue.length > 0 && performance.now() - start < FRAME_BUDGET_MS) {
            const job = popNext();
            if (!job) break;
            try {
                job.run();
            } catch (err) {
                console.warn('[render-queue] job threw:', err);
            }
            tilesThisFrame++;
        }
        dbgFramesProcessed++;
        dbgTilesProcessed += tilesThisFrame;
        if (renderQueue.length > 0) {
            scheduleFrame();
        } else if (dbgTilesProcessed > 0) {
            const elapsed = (performance.now() - dbgLogStart).toFixed(0);
            console.log(`[render-queue] burst done: ${dbgTilesProcessed} tiles in ${dbgFramesProcessed} frames, ${elapsed} ms total`);
            dbgFramesProcessed = 0;
            dbgTilesProcessed = 0;
            dbgLogStart = 0;
        }
    });
}

/** Insert a job in priority order (lowest priority value first). */
function enqueueRender(job: RenderJob): void {
    // Insertion sort over a queue of ~30 elements is cheaper than a heap
    // and keeps the head pop O(1). At max zoom-out the queue rarely
    // exceeds 50 entries.
    let lo = 0;
    let hi = renderQueue.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (renderQueue[mid]!.priority <= job.priority) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    renderQueue.splice(lo, 0, job);
    scheduleFrame();
}

/** Remove every queued job for a given layer + tile coord. */
function cancelQueuedTile(layer: WebGLPZLayer, key: string): void {
    for (let i = renderQueue.length - 1; i >= 0; i--) {
        const j = renderQueue[i]!;
        if (j.layer === layer && j.key === key) {
            renderQueue.splice(i, 1);
        }
    }
}

/** Remove every queued job belonging to a given layer (used on onRemove). */
function cancelAllForLayer(layer: WebGLPZLayer): void {
    for (let i = renderQueue.length - 1; i >= 0; i--) {
        if (renderQueue[i]!.layer === layer) {
            renderQueue.splice(i, 1);
        }
    }
}

function tileKey(z: number, x: number, y: number): string {
    return `${z}_${x}_${y}`;
}

// ---------------------------------------------------------------------------
// Rendered-tile LRU — caches the *raster* output of renderTile keyed by
// tile coordinate. When Leaflet's GridLayer disposes a tile (e.g. pan
// outside keepBuffer) and later re-creates it for the same coords, we
// blit the cached image instead of re-running the entire fetch + collect
// + draw pipeline. At max zoom-out re-pans are common and each tile costs
// hundreds of ms, so caching here is the highest-leverage trick after the
// loop rewrite.
//
// Each entry holds an ImageBitmap (≈ 1024² × 4 bytes ≈ 4 MB on RAM
// budget, but typically GPU-resident in the browser). 64 entries ≈ 256 MB
// upper bound, lower in practice because most tiles are sparse.
// ---------------------------------------------------------------------------

const TILE_BITMAP_LRU_CAPACITY = 64;
const tileBitmapLru = new Map<string, ImageBitmap>();

function tileBitmapKey(layer: WebGLPZLayer, z: number, x: number, y: number): string {
    // Include a per-layer salt so two layers don't collide. The layer
    // reference is unique per session, so its stringified address (or
    // any unique-per-instance value) is fine.
    return `${(layer as unknown as { _leaflet_id?: number })._leaflet_id ?? 'l'}|${z}_${x}_${y}`;
}

function getCachedTile(key: string): ImageBitmap | undefined {
    const bmp = tileBitmapLru.get(key);
    if (!bmp) return undefined;
    // Promote to MRU.
    tileBitmapLru.delete(key);
    tileBitmapLru.set(key, bmp);
    return bmp;
}

function setCachedTile(key: string, bmp: ImageBitmap): void {
    if (tileBitmapLru.has(key)) {
        tileBitmapLru.delete(key);
    } else if (tileBitmapLru.size >= TILE_BITMAP_LRU_CAPACITY) {
        const lruKey = tileBitmapLru.keys().next().value;
        if (lruKey !== undefined) {
            const old = tileBitmapLru.get(lruKey);
            tileBitmapLru.delete(lruKey);
            old?.close();
        }
    }
    tileBitmapLru.set(key, bmp);
}

/** Public so the React component can flush the cache after an atlas-version bump. */
export function clearTileBitmapCache(): void {
    for (const bmp of tileBitmapLru.values()) {
        bmp.close();
    }
    tileBitmapLru.clear();
}

export interface WebGLPZLayerOptions extends L.GridLayerOptions {
    /** Lazy atlas-page residency manager (replaces the old single atlas tex). */
    atlasManager: AtlasPageManager;
    /** Available atlas LODs, sorted by id ascending. */
    lods: AtlasLodInfo[];
    /**
     * cell-pages.json mapping. When non-null the layer narrows ensurePages
     * to exactly the pages needed by visible cells; when null every page
     * is treated as potentially needed (legacy fallback).
     */
    cellPages: CellPagesMap | null;
    /** UV layout of sprites.json — affects how the renderer normalises mips. */
    uvFormat: 'pixels' | 'normalized';
    /** Sprite name → SpriteEntry. */
    spriteIndex: SpriteIndex;
    /** DZI projection parameters. */
    projection: DziProjection;
    /** Returns cell data for a Leaflet tile coordinate. */
    fetchCellData: (z: number, x: number, y: number) => Promise<CellData[]>;
    /**
     * Inclusive PZ layer range to render. Default {min:0, max:0} = ground floor.
     */
    layerRange?: { min: number; max: number };
}

/** Extend Leaflet GridLayer for WebGL rendering. */
export class WebGLPZLayer extends L.GridLayer {
    private renderer: PzGLRenderer;
    private readonly layerOptions: WebGLPZLayerOptions;
    private initPromise: Promise<boolean> | null = null;
    /** Latest viewport centre in tile-coord space (set on every moveend/zoomend). */
    private _viewportCentre: { z: number; cx: number; cy: number } | null = null;
    /** Tiles that have already started fetch — used to dedupe rapid Leaflet recreations. */
    private _pendingTiles = new Set<string>();

    constructor(renderer: PzGLRenderer, options: WebGLPZLayerOptions) {
        super({
            // Bigger tiles → far fewer per-viewport: 30 tiles @ 256px → 4-6
            // tiles @ 1024px. Each tile costs more to render, but total
            // wall-clock and per-tile dispatch overhead drop massively,
            // and the "appearing one by one" effect goes away because the
            // whole viewport is just a handful of canvases.
            tileSize: 1024,
            noWrap: true,
            keepBuffer: 2,
            ...options,
        });
        this.renderer = renderer;
        this.layerOptions = options;
    }

    /** Track which LOD we're rendering at; flips on zoom cross of a boundary. */
    private _activeLod = -1;

    onAdd(map: L.Map): this {
        super.onAdd(map);
        this._refreshViewportCentre();
        this._refreshActiveLod();
        map.on('moveend zoomend', this._refreshViewportCentre, this);
        map.on('zoomend', this._refreshActiveLod, this);
        // Drop both queued render jobs and pending-flags when Leaflet unloads
        // a tile. This is what makes flick-pans cheap: hundreds of in-flight
        // jobs are dropped instead of completing into pixels nobody will see.
        this.on('tileunload', this._onTileUnload, this);
        // Re-render tiles when fresh atlas pages arrive — pages that were
        // missing during the initial draw now have data. A flood of
        // ensurePages calls (one per tile × 30 tiles) would call us as
        // many times in quick succession, but Leaflet's redraw is cheap
        // and the bitmap cache already debounces by tile coords. Coalesce
        // the redraws on a 100 ms trailing edge so we don't fire 30
        // redraws within one frame.
        this.layerOptions.atlasManager.onRedraw(this._scheduleRedraw);
        // Live-tuning panel: any nudge to stride/LOD thresholds wipes
        // the bitmap cache and re-asks Leaflet to rebuild every tile
        // with the new settings.
        this._tuningUnsubscribe = onRenderTuningChange(() => {
            this._refreshActiveLod();
            this._scheduleRedraw();
        });
        return this;
    }

    private _tuningUnsubscribe: (() => void) | null = null;

    private _redrawTimer: ReturnType<typeof setTimeout> | null = null;

    private _scheduleRedraw = (): void => {
        if (this._redrawTimer !== null) return;
        this._redrawTimer = setTimeout(() => {
            this._redrawTimer = null;
            clearTileBitmapCache();
            try {
                this.redraw();
            } catch {
                /* layer may have been removed */
            }
        }, 100);
    };

    /**
     * Pick the LOD matching the current viewport zoom. When it changes the
     * bitmap LRU is flushed because cached pixels were rendered against a
     * different atlas LOD and would look subtly wrong if re-blitted.
     */
    private _refreshActiveLod = (): void => {
        const map = this._map;
        if (!map) return;
        const proj = this.layerOptions.projection;
        const pixelsPerSquare = proj.sqr * Math.pow(2, map.getZoom() - proj.maxNativeZoom);
        // Always go through the tuning module — its defaults match the
        // built-in lod-selection thresholds, but the user can override
        // them at runtime via the RenderTuningPanel.
        const next = selectLodFromTuning(pixelsPerSquare, this.layerOptions.lods);
        if (next !== this._activeLod) {
            const previous = this._activeLod;
            if (previous >= 0) {
                // Bitmap cache is keyed per layer; entries for the previous
                // LOD are now stale.
                clearTileBitmapCache();
                // Release the texture array of the LOD we're leaving so
                // VRAM doesn't snowball as the user zooms across LODs.
                this.layerOptions.atlasManager.releaseLod(previous);
            }
            this._activeLod = next;
        }
    };

    /** Called by Leaflet to create a tile DOM element. */
    createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
        const tile = document.createElement('canvas');
        const tileSize = (this.options.tileSize as number) ?? 1024;
        tile.width = tileSize;
        tile.height = tileSize;

        const key = tileKey(coords.z, coords.x, coords.y);

        // Fast path — bitmap cache hit. Avoids fetch + collect + draw entirely.
        const bmpKey = tileBitmapKey(this, coords.z, coords.x, coords.y);
        const cached = getCachedTile(bmpKey);
        if (cached) {
            const ctx = tile.getContext('2d');
            if (ctx) {
                ctx.drawImage(cached, 0, 0);
            }
            // Defer the done() callback so Leaflet doesn't try to do layout
            // mid-createTile (it expects async completion).
            queueMicrotask(() => done(undefined, tile));
            return tile;
        }

        this._pendingTiles.add(key);

        // Ensure renderer is initialised before first tile
        this._ensureInit()
            .then((ok) => {
                if (!ok) {
                    this._pendingTiles.delete(key);
                    done(new Error('[pz-renderer] WebGL2 unavailable'), tile);
                    return;
                }
                return this._renderTileAsync(coords, tile, done);
            })
            .catch((err: unknown) => {
                this._pendingTiles.delete(key);
                done(err instanceof Error ? err : new Error(String(err)), tile);
            });

        return tile;
    }

    /** Remove all tiles when the layer is removed. The renderer is owned by
     *  the caller (M5 hook) and disposed when the React component unmounts —
     *  not here. Killing it here would orphan the atlas texture if the layer
     *  is briefly removed and re-added (e.g. zoom-band switch). */
    onRemove(map: L.Map): this {
        map.off('moveend zoomend', this._refreshViewportCentre, this);
        map.off('zoomend', this._refreshActiveLod, this);
        this.off('tileunload', this._onTileUnload, this);
        cancelAllForLayer(this);
        this._pendingTiles.clear();
        if (this._tuningUnsubscribe) {
            this._tuningUnsubscribe();
            this._tuningUnsubscribe = null;
        }
        super.onRemove(map);
        return this;
    }

    /**
     * Recompute the viewport centre in tile coordinates. Used as the origin
     * for priority sorting so the centre of the viewport always renders
     * first regardless of how Leaflet ordered its createTile() calls.
     */
    private _refreshViewportCentre = (): void => {
        const map = this._map;
        if (!map) return;
        const z = map.getZoom();
        const tileSize = (this.options.tileSize as number) ?? 1024;
        const centrePx = map.project(map.getCenter(), z);
        this._viewportCentre = {
            z,
            cx: centrePx.x / tileSize,
            cy: centrePx.y / tileSize,
        };
    };

    private _onTileUnload = (e: L.TileEvent): void => {
        const c = e.coords;
        const key = tileKey(c.z, c.x, c.y);
        cancelQueuedTile(this, key);
        this._pendingTiles.delete(key);
    };

    private _priorityFor(coords: L.Coords): number {
        const vp = this._viewportCentre;
        if (!vp) return 0;
        // Tiles at the current zoom always beat tiles at a different zoom
        // (zoom mismatch usually means leftover from an in-flight zoom-out).
        const zPenalty = Math.abs(vp.z - coords.z) * 10000;
        const dx = coords.x + 0.5 - vp.cx;
        const dy = coords.y + 0.5 - vp.cy;
        return zPenalty + dx * dx + dy * dy;
    }

    // ---------------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------------

    private _ensureInit(): Promise<boolean> {
        if (!this.initPromise) {
            // Caller (M5 / pz-map.tsx) is expected to pass an already-initialised
            // PzGLRenderer to the constructor (so the atlas texture lives on the
            // same GL context). Re-initialising here would create a brand-new
            // context and orphan the atlas.
            this.initPromise = Promise.resolve(this.renderer.getGLContext() !== null);
        }
        return this.initPromise;
    }

    private async _renderTileAsync(
        coords: L.Coords,
        tileCanvas: HTMLCanvasElement,
        done: L.DoneCallback,
    ): Promise<void> {
        const {
            atlasManager,
            cellPages,
            uvFormat,
            spriteIndex,
            projection,
            fetchCellData,
            layerRange,
        } = this.layerOptions;
        const key = tileKey(coords.z, coords.x, coords.y);

        let cells: CellData[];
        try {
            cells = await fetchCellData(coords.z, coords.x, coords.y);
        } catch (err) {
            this._pendingTiles.delete(key);
            done(err instanceof Error ? err : new Error(String(err)), tileCanvas);
            return;
        }

        // If Leaflet unloaded the tile while we were waiting on fetch, bail
        // out — its DOM canvas may still be alive in the keepBuffer ring,
        // but the layer has already moved on and the user will never see
        // the result. Drawing to it just wastes a render and risks GL state
        // churn.
        if (!this._pendingTiles.has(key)) {
            done(undefined, tileCanvas);
            return;
        }

        // Sync the active LOD with the viewport (handles createTile firing
        // before zoomend has propagated).
        this._refreshActiveLod();
        const lod = Math.max(0, this._activeLod);

        // Collect the set of atlas pages required to paint this tile.
        // When cell-pages.json is published the mapping is a single
        // hash-lookup per cell; otherwise we derive the set from the
        // header.spriteNames list (still cheap, ~200 hash lookups per
        // cell). Either way we kick off a parallel lazy load and rely
        // on the AtlasPageManager redraw listener to refresh tiles as
        // pages stream in.
        const required = new Set<number>();
        if (cellPages !== null) {
            for (const cell of cells) {
                const list = cellPages[`${cell.cellX}_${cell.cellY}`];
                if (list) {
                    for (const id of list) required.add(id);
                }
            }
        } else {
            for (const cell of cells) {
                for (const name of cell.header.spriteNames) {
                    const entry = spriteIndex.get(name);
                    if (entry !== undefined) required.add(entry.atlas);
                }
            }
        }
        void atlasManager.ensurePages(required, lod);

        const tileSize = (this.options.tileSize as number) ?? 1024;
        const atlasTexture = atlasManager.getTextureForLod(lod);
        // availablePages always reflects the residency set: the renderer
        // skips sprites on non-resident pages instead of blocking the
        // tile while it streams. Passing null would defeat the
        // progressive-loading guarantee.
        const availablePages = atlasManager.residentPages(lod);
        // Compute the cell-stride applied to THIS render. Must match
        // the stride computeCellsForTile used so the shader scales each
        // sampled cell to cover the skipped block correctly.
        const tileCellSize = cells[0]?.header.cellSizeInBlocks
            && cells[0]!.header.blockSize
            ? cells[0]!.header.cellSizeInBlocks * cells[0]!.header.blockSize
            : 256;
        const tilePps = projection.sqr * Math.pow(2, coords.z - projection.maxNativeZoom);
        const cellStride = cellStrideForTuning(tilePps, tileCellSize);
        const input: TileRenderInput = {
            z: coords.z,
            x: coords.x,
            y: coords.y,
            tileSize,
            cells,
            atlas: atlasTexture,
            lod,
            pageLookup: atlasManager,
            spriteIndex,
            projection,
            uvFormat,
            availablePages,
            layerRange,
            cellStride,
        };

        // Hand the actual GPU draw to the shared rAF queue with a priority
        // computed from distance to the viewport centre. Centre tiles draw
        // first, peripheral last, and anything Leaflet has since unloaded
        // never draws at all.
        const priority = this._priorityFor(coords);
        const bmpKey = tileBitmapKey(this, coords.z, coords.x, coords.y);

        enqueueRender({
            layer: this,
            key,
            priority,
            run: () => {
                // Double-check the tile is still wanted by the time the
                // frame budget gets around to us.
                if (!this._pendingTiles.has(key)) {
                    done(undefined, tileCanvas);
                    return;
                }
                this._pendingTiles.delete(key);
                try {
                    const rendered = this.renderer.renderTile(input);
                    const ctx = tileCanvas.getContext('2d');
                    if (ctx) {
                        ctx.drawImage(rendered, 0, 0);
                    }
                    done(undefined, tileCanvas);

                    // Snapshot the rendered tile into an ImageBitmap so the
                    // next createTile for the same coord can skip the full
                    // pipeline. We do this on the *tile* canvas (which is a
                    // bare copy of the renderer canvas) so it isn't clobbered
                    // by the next renderTile call.
                    if (typeof createImageBitmap === 'function') {
                        // Fire-and-forget — the cache miss path just re-renders.
                        void createImageBitmap(tileCanvas).then((bmp) => {
                            setCachedTile(bmpKey, bmp);
                        }).catch(() => {
                            // createImageBitmap can fail (very large canvas
                            // on Safari, etc.) — silently skip caching.
                        });
                    }
                } catch (err) {
                    done(err instanceof Error ? err : new Error(String(err)), tileCanvas);
                }
            },
        });
    }
}

/**
 * Factory helper — mirrors Leaflet's L.tileLayer() pattern.
 */
export function webGLPZLayer(
    renderer: PzGLRenderer,
    options: WebGLPZLayerOptions,
): WebGLPZLayer {
    return new WebGLPZLayer(renderer, options);
}
