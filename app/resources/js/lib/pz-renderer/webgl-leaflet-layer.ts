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
import type { CellData, SpriteIndex, DziProjection } from './types';

// ---------------------------------------------------------------------------
// Render queue — one tile per animation frame. Without this Leaflet hands us
// 30+ tiles synchronously on each pan/zoom and the renderTile loop blocks
// main thread for seconds, freezing scroll/zoom/page navigation. Spreading
// renders across frames gives the browser room to handle input events
// between them — the map still finishes quickly because each render is in
// the order of milliseconds, but the gaps make the UI feel snappy.
// ---------------------------------------------------------------------------

type RenderJob = () => void;
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

function scheduleFrame(): void {
    if (frameScheduled) return;
    frameScheduled = true;
    requestAnimationFrame(() => {
        frameScheduled = false;
        const start = performance.now();
        if (dbgLogStart === 0) dbgLogStart = start;
        let tilesThisFrame = 0;
        while (renderQueue.length > 0 && performance.now() - start < FRAME_BUDGET_MS) {
            const job = renderQueue.shift()!;
            try {
                job();
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

function enqueueRender(job: RenderJob): void {
    renderQueue.push(job);
    scheduleFrame();
}

export interface WebGLPZLayerOptions extends L.GridLayerOptions {
    /** Pre-uploaded atlas texture (TEXTURE_2D_ARRAY across all pages). */
    atlas: WebGLTexture;
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

    /** Called by Leaflet to create a tile DOM element. */
    createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
        const tile = document.createElement('canvas');
        const tileSize = (this.options.tileSize as number) ?? 1024;
        tile.width = tileSize;
        tile.height = tileSize;

        // Ensure renderer is initialised before first tile
        this._ensureInit()
            .then((ok) => {
                if (!ok) {
                    done(new Error('[pz-renderer] WebGL2 unavailable'), tile);
                    return;
                }
                return this._renderTileAsync(coords, tile, done);
            })
            .catch((err: unknown) => {
                done(err instanceof Error ? err : new Error(String(err)), tile);
            });

        return tile;
    }

    /** Remove all tiles when the layer is removed. The renderer is owned by
     *  the caller (M5 hook) and disposed when the React component unmounts —
     *  not here. Killing it here would orphan the atlas texture if the layer
     *  is briefly removed and re-added (e.g. zoom-band switch). */
    onRemove(map: L.Map): this {
        super.onRemove(map);
        return this;
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
        const { atlas, spriteIndex, projection, fetchCellData, layerRange } = this.layerOptions;

        let cells: CellData[];
        try {
            cells = await fetchCellData(coords.z, coords.x, coords.y);
        } catch (err) {
            done(err instanceof Error ? err : new Error(String(err)), tileCanvas);
            return;
        }

        const tileSize = (this.options.tileSize as number) ?? 1024;
        const input: TileRenderInput = {
            z: coords.z,
            x: coords.x,
            y: coords.y,
            tileSize,
            cells,
            atlas,
            spriteIndex,
            projection,
            layerRange,
        };

        // Hand the actual GPU draw to the shared rAF queue so a flood of
        // tiles can't monopolise the main thread.
        enqueueRender(() => {
            try {
                const rendered = this.renderer.renderTile(input);
                const ctx = tileCanvas.getContext('2d');
                if (ctx) {
                    ctx.drawImage(rendered, 0, 0);
                }
                done(undefined, tileCanvas);
            } catch (err) {
                done(err instanceof Error ? err : new Error(String(err)), tileCanvas);
            }
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
