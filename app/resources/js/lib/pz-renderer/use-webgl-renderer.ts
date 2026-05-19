/**
 * React hook that prepares the WebGL2 PZ map renderer.
 *
 * Post-refactor pipeline (multi-LOD + lazy pages):
 *   1. Fetch manifest.json + sprites.json + cell-pages.json (~3 MB total).
 *   2. Initialise the WebGL context (creates the shared canvas).
 *   3. Build an AtlasPageManager — no atlas bytes have been fetched yet.
 *   4. Resolve `ready` immediately. Atlas pages stream in lazily as the
 *      Leaflet layer requests tiles.
 *
 * Total time to "ready" drops from ~20 s (eager-loading 3.4 GB of WebP)
 * to ~3 s (metadata-only). Initial frames may show progressive sprite
 * fill — the renderer skips not-yet-resident pages and the layer
 * invalidates tiles when fresh pages arrive.
 */
import { useEffect, useRef, useState } from 'react';

import {
    buildAtlasPageUrl,
    loadAtlasMetadata,
    preloadAllAtlasPages,
    type AtlasLoadProgress,
} from './atlas-loader';
import { AtlasPageManager } from './atlas-page-manager';
import { clearStaleVersions } from './atlas-idb-cache';
import { preloadAllChunks } from './cell-chunks';
import { isWebGL2Available } from './gl/context';
import { PzGLRenderer } from './tile-renderer';
import type { AtlasLodInfo, CellPagesMap, SpriteIndex } from './types';

export interface PzWebGLState {
    renderer: PzGLRenderer | null;
    /** Atlas page residency manager (replaces the single atlasTexture handle). */
    atlasManager: AtlasPageManager | null;
    spriteIndex: SpriteIndex | null;
    /** LOD descriptors published by the server. */
    lods: AtlasLodInfo[] | null;
    /** cell-pages map; null when the server didn't publish it. */
    cellPages: CellPagesMap | null;
    /** Whether sprite UVs are stored as ratios (post-refactor) or absolute pixels (legacy). */
    uvFormat: 'pixels' | 'normalized';
    /** Total pages in the atlas. */
    pageCount: number;
    version: string | null;
    progress: number | null;
    /** Human-readable label for the current init phase. */
    progressLabel: string | null;
    error: string | null;
    supported: boolean;
}

const INITIAL: PzWebGLState = {
    renderer: null,
    atlasManager: null,
    spriteIndex: null,
    lods: null,
    cellPages: null,
    uvFormat: 'normalized',
    pageCount: 0,
    version: null,
    progress: 0,
    progressLabel: 'Подготовка…',
    error: null,
    supported: true,
};

// ---------------------------------------------------------------------------
// Module-level singleton — survives component unmount/remount.
// ---------------------------------------------------------------------------

interface ReadyAtlas {
    renderer: PzGLRenderer;
    atlasManager: AtlasPageManager;
    spriteIndex: SpriteIndex;
    lods: AtlasLodInfo[];
    cellPages: CellPagesMap | null;
    uvFormat: 'pixels' | 'normalized';
    pageCount: number;
    version: string;
    canvas: HTMLCanvasElement;
}

let cachedReady: ReadyAtlas | null = null;
let inflightLoad: Promise<ReadyAtlas | null> | null = null;

async function loadOnce(atlasBaseUrl: string, onProgress: AtlasLoadProgress): Promise<ReadyAtlas | null> {
    if (cachedReady) return cachedReady;
    if (inflightLoad) return inflightLoad;

    inflightLoad = (async (): Promise<ReadyAtlas | null> => {
        const glCanvas = document.createElement('canvas');
        glCanvas.width = 256;
        glCanvas.height = 256;

        const renderer = new PzGLRenderer(glCanvas);

        const ok = await renderer.init();
        if (!ok) {
            console.error('[atlas-singleton] renderer.init() failed');
            return null;
        }

        const gl = renderer.getGLContext();
        if (!gl) {
            console.error('[atlas-singleton] GL context unavailable');
            return null;
        }

        const meta = await loadAtlasMetadata(atlasBaseUrl, onProgress);

        if (meta.pages.length === 0) {
            console.error('[atlas-singleton] atlas has no pages');
            return null;
        }

        // Sweep stale-version blobs in the background.
        void clearStaleVersions(meta.version);

        // Build the lazy page manager. No bytes uploaded yet — the layer
        // ensures pages as it renders tiles.
        const atlasManager = new AtlasPageManager({
            gl,
            lods: meta.lods,
            version: meta.version,
            pageCount: meta.pageCount,
            baseUrl: atlasBaseUrl,
            serverHasKtx2: meta.serverHasKtx2,
            fileTemplate: (lod, pageId, format) => buildAtlasPageUrl(meta.version, pageId, lod, format),
        });

        console.log(
            `[atlas-singleton] ready — version=${meta.version} pages=${meta.pageCount} lods=${meta.lods.length} ktx2=${atlasManager.pageFormat === 'ktx2'} uv=${meta.uvFormat}`,
        );

        const ready: ReadyAtlas = {
            renderer,
            atlasManager,
            spriteIndex: meta.sprites,
            lods: meta.lods,
            cellPages: meta.cellPages,
            uvFormat: meta.uvFormat,
            pageCount: meta.pageCount,
            version: meta.version,
            canvas: glCanvas,
        };
        cachedReady = ready;
        return ready;
    })();

    try {
        return await inflightLoad;
    } finally {
        inflightLoad = null;
    }
}

export function usePzWebGLRenderer(atlasBaseUrl = '/pz-atlas'): PzWebGLState {
    const [state, setState] = useState<PzWebGLState>(() => {
        if (cachedReady) {
            return {
                renderer: cachedReady.renderer,
                atlasManager: cachedReady.atlasManager,
                spriteIndex: cachedReady.spriteIndex,
                lods: cachedReady.lods,
                cellPages: cachedReady.cellPages,
                uvFormat: cachedReady.uvFormat,
                pageCount: cachedReady.pageCount,
                version: cachedReady.version,
                progress: null,
                progressLabel: null,
                error: null,
                supported: true,
            };
        }
        return INITIAL;
    });

    const triggered = useRef(false);

    useEffect(() => {
        if (triggered.current) return;
        if (!atlasBaseUrl) {
            setState({ ...INITIAL, progress: null });
            return;
        }
        triggered.current = true;

        if (cachedReady) return; // already exposed via lazy initialiser

        if (!isWebGL2Available()) {
            setState({
                ...INITIAL,
                progress: null,
                progressLabel: null,
                error: 'WebGL2 is not supported by this browser',
                supported: false,
            });
            return;
        }

        let disposed = false;

        // Progress budget: metadata fetches (5 %) then cell chunks (95 %).
        // Atlas page preload runs in the background after chunks finish
        // and is NOT reflected in this bar — its progress is logged to
        // console only. Mixing it in would keep the overlay visible
        // while the user can already see the map underneath.
        const METADATA_BUDGET = 0.05;
        let lastProgressTs = 0;
        const PROGRESS_THROTTLE_MS = 80;
        const pushProgress = (cumulative: number, label: string, force = false): void => {
            const now = performance.now();
            if (!force && now - lastProgressTs < PROGRESS_THROTTLE_MS) return;
            lastProgressTs = now;
            setState((s) => ({ ...s, progress: cumulative, progressLabel: label }));
        };

        const onProgress: AtlasLoadProgress = (phase, loaded, total) => {
            if (disposed) return;
            const within = total > 0 ? loaded / total : 0;
            const cumulative = (() => {
                if (phase === 'manifest') return within * 0.02;
                if (phase === 'sprites') return 0.02 + within * 0.02;
                if (phase === 'cell-pages') return 0.04 + within * 0.01;
                return within * METADATA_BUDGET;
            })();
            const label =
                phase === 'manifest' ? 'Загрузка манифеста атласа'
                    : phase === 'sprites' ? 'Загрузка спрайт-индекса'
                        : phase === 'cell-pages' ? 'Загрузка карты ячеек'
                            : 'Подготовка…';
            pushProgress(cumulative, label, loaded === total);
        };

        let lastAtlasLog = 0;
        const onAtlasPreload = (done: number, total: number): void => {
            // Background-only progress: keep it OUT of the modal overlay
            // so the user isn't blocked by a 350 MB download they don't
            // need to wait for. Log to console every 25 % for sanity.
            const pct = total > 0 ? done / total : 0;
            if (done === total || pct - lastAtlasLog >= 0.25) {
                lastAtlasLog = pct;
                console.log(`[atlas-preload] ${done}/${total} (${Math.round(pct * 100)}%)`);
            }
        };

        const onChunkProgress = (done: number, total: number): void => {
            if (disposed) return;
            const within = total > 0 ? done / total : 1;
            const cumulative = METADATA_BUDGET + within * (1 - METADATA_BUDGET);
            pushProgress(cumulative, `Загрузка геометрии карты ${done}/${total}`, done === total);
        };

        loadOnce(atlasBaseUrl, onProgress)
            .then(async (ready) => {
                if (disposed) return;
                if (!ready) {
                    setState((s) => ({
                        ...s,
                        error: 'atlas load failed',
                        progress: null,
                        progressLabel: null,
                        supported: false,
                    }));
                    return;
                }
                // Warm cell-data chunks first so panning is hiccup-free.
                // This blocks `ready` because the renderer can't draw
                // anything useful without cells. The chunk LRU caps
                // in-memory residency separately.
                try {
                    await preloadAllChunks(onChunkProgress);
                } catch (err) {
                    console.warn('[atlas-singleton] chunk preload failed:', err);
                }

                // Atlas-page preload runs IN THE BACKGROUND. Pages are
                // lazy-loaded on first use anyway; the eager preload
                // just trickles every (page × LOD) blob into IDB so
                // future pans get instant cache hits. Doing it
                // up-front blocking the map would force the user to
                // wait ~30 seconds on a fresh visit while ~350 MB
                // downloads — better to show the map immediately and
                // let the cache warm asynchronously.
                const pageList = Array.from(
                    { length: ready.pageCount },
                    (_, id) => ({ id }),
                );
                void preloadAllAtlasPages(
                    atlasBaseUrl,
                    ready.version,
                    pageList,
                    ready.lods,
                    ready.atlasManager.pageFormat,
                    onAtlasPreload,
                    /* concurrency */ 4,
                ).catch((err) => {
                    console.warn('[atlas-singleton] background atlas preload failed:', err);
                });
                if (disposed) return;
                setState({
                    renderer: ready.renderer,
                    atlasManager: ready.atlasManager,
                    spriteIndex: ready.spriteIndex,
                    lods: ready.lods,
                    cellPages: ready.cellPages,
                    uvFormat: ready.uvFormat,
                    pageCount: ready.pageCount,
                    version: ready.version,
                    progress: null,
                    progressLabel: null,
                    error: null,
                    supported: true,
                });
            })
            .catch((err: unknown) => {
                if (disposed) return;
                console.error('[atlas-singleton] loadOnce threw:', err);
                setState((s) => ({
                    ...s,
                    error: err instanceof Error ? err.message : String(err),
                    progress: null,
                    progressLabel: null,
                }));
            });

        return () => {
            disposed = true;
            // Renderer + manager are session-wide singletons; we don't
            // dispose them on unmount.
        };
    }, [atlasBaseUrl]);

    return state;
}
