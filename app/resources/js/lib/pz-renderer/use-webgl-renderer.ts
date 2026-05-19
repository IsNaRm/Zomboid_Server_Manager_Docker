/**
 * React hook: initialises the WebGL2 PZ map renderer end-to-end.
 *
 * The renderer + atlas array are cached at module level so that navigating
 * away from /admin/players/map and back does NOT re-download/re-upload
 * the ~370 MB atlas — texture stays resident in GPU for the whole session.
 *
 * Returns null while loading (or on failure). Consumers fall back to the
 * legacy static-tile loader when this returns null.
 */
import { useEffect, useRef, useState } from 'react';
import { fetchAtlasPage, loadAtlasMetadata, type AtlasLoadProgress } from './atlas-loader';
import { clearStaleVersions } from './atlas-idb-cache';
import { preloadAllChunks } from './cell-chunks';
import { isWebGL2Available } from './gl/context';
import { createAtlasArray, uploadAtlasArrayLayer, destroyTexture } from './gl/textures';
import { PzGLRenderer } from './tile-renderer';
import type { SpriteIndex } from './types';

export interface PzWebGLState {
    renderer: PzGLRenderer | null;
    /** TEXTURE_2D_ARRAY holding every atlas page as a layer. */
    atlasTexture: WebGLTexture | null;
    spriteIndex: SpriteIndex | null;
    version: string | null;
    progress: number | null;
    /** Human-readable label for the current preload phase (atlases / chunks). */
    progressLabel: string | null;
    error: string | null;
    supported: boolean;
}

const INITIAL: PzWebGLState = {
    renderer: null,
    atlasTexture: null,
    spriteIndex: null,
    version: null,
    progress: 0,
    progressLabel: 'Подготовка…',
    error: null,
    supported: true,
};

const ATLAS_SIZE = 4096;

// ---------------------------------------------------------------------------
// Module-level singleton — survives component unmount/remount.
// ---------------------------------------------------------------------------

interface ReadyAtlas {
    renderer: PzGLRenderer;
    atlasTexture: WebGLTexture;
    spriteIndex: SpriteIndex;
    version: string;
    /** Hidden canvas backing the GL context — keep alive so context isn't lost. */
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

        const meta = await loadAtlasMetadata(atlasBaseUrl, onProgress);

        if (meta.pages.length === 0) {
            console.error('[atlas-singleton] atlas has no pages');
            return null;
        }

        const gl = renderer.getGLContext();
        if (!gl) {
            console.error('[atlas-singleton] GL context unavailable');
            return null;
        }

        const textureArray = createAtlasArray(gl, ATLAS_SIZE, meta.pages.length);
        const glErr = gl.getError();
        if (glErr !== gl.NO_ERROR) {
            console.error(`[atlas-singleton] GL error after texStorage3D: 0x${glErr.toString(16)}`);
            return null;
        }

        // Parallel decode + GPU upload via bounded worker pool. GL is the
        // serial bottleneck (single context), so 12 workers just keep the
        // decode pipeline saturated so the next bitmap is always ready
        // when GPU wants the next layer.
        const CONCURRENCY = 12;
        const tStart = performance.now();
        let nextIndex = 0;
        let completed = 0;
        let firstError: Error | null = null;

        // Sweep stale-version blobs in the background — non-blocking.
        void clearStaleVersions(meta.version);

        const worker = async (): Promise<void> => {
            while (true) {
                const i = nextIndex++;
                if (i >= meta.pages.length || firstError) return;
                const page = meta.pages[i]!;
                try {
                    const bitmap = await fetchAtlasPage(page.url, meta.version, page.id);
                    if (firstError) { bitmap.close(); return; }
                    uploadAtlasArrayLayer(gl, textureArray, i, bitmap);
                    const err = gl.getError();
                    bitmap.close();
                    if (err !== gl.NO_ERROR) {
                        firstError = new Error(`GL error 0x${err.toString(16)} uploading page ${i}`);
                        return;
                    }
                } catch (e) {
                    firstError = e instanceof Error ? e : new Error(String(e));
                    return;
                }
                completed++;
                if (completed === 1 || completed % 10 === 0 || completed === meta.pages.length) {
                    const elapsed = ((performance.now() - tStart) / 1000).toFixed(1);
                    console.log(`[atlas-singleton] uploaded ${completed}/${meta.pages.length} (${elapsed}s)`);
                }
                onProgress('atlas', completed, meta.pages.length);
            }
        };

        await Promise.all(Array.from({ length: CONCURRENCY }, worker));

        if (firstError) {
            console.error('[atlas-singleton] upload pipeline failed:', firstError);
            destroyTexture(gl, textureArray);
            return null;
        }

        const ready: ReadyAtlas = {
            renderer,
            atlasTexture: textureArray,
            spriteIndex: meta.sprites,
            version: meta.version,
            canvas: glCanvas,
        };
        cachedReady = ready;
        console.log('[atlas-singleton] READY — cached for the session');
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
                atlasTexture: cachedReady.atlasTexture,
                spriteIndex: cachedReady.spriteIndex,
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
                renderer: null,
                atlasTexture: null,
                spriteIndex: null,
                version: null,
                progress: null,
                progressLabel: null,
                error: 'WebGL2 is not supported by this browser',
                supported: false,
            });
            return;
        }

        let disposed = false;

        // Total budget split: atlases 0–60 %, cell-chunks 60–100 %.
        const ATLAS_BUDGET = 0.6;
        // Throttle: re-rendering the React tree on every uploaded page (51×
        // for atlases, 70× for chunks) blocks the main thread between
        // uploads and turned a ~3 s load into ~9 s. Coalesce updates to one
        // every ~100 ms — humans don't perceive the difference.
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
            const phaseProgress = total > 0 ? loaded / total : 0;
            const within =
                phase === 'manifest' ? phaseProgress * 0.02
                    : phase === 'sprites' ? 0.02 + phaseProgress * 0.03
                        : 0.05 + phaseProgress * 0.95;
            const cumulative = within * ATLAS_BUDGET;
            const label = phase === 'atlas'
                ? `Загрузка атласа ${loaded}/${total}`
                : phase === 'sprites' ? 'Загрузка спрайт-индекса'
                    : 'Загрузка манифеста атласа';
            pushProgress(cumulative, label, loaded === total);
        };

        const onChunkProgress = (done: number, total: number): void => {
            if (disposed) return;
            const within = total > 0 ? done / total : 1;
            const cumulative = ATLAS_BUDGET + within * (1 - ATLAS_BUDGET);
            pushProgress(cumulative, `Загрузка карты ${done}/${total}`, done === total);
        };

        loadOnce(atlasBaseUrl, onProgress)
            .then(async (ready) => {
                if (disposed) return;
                if (!ready) {
                    setState((s) => ({ ...s, error: 'atlas load failed', progress: null, progressLabel: null, supported: false }));
                    return;
                }
                // Atlas done — now warm every cell-data chunk so panning is
                // immediate (no mid-interaction downloads).
                try {
                    await preloadAllChunks(onChunkProgress);
                } catch (err) {
                    console.warn('[atlas-singleton] chunk preload failed:', err);
                    // Non-fatal: chunks load lazily on demand if preload errored.
                }
                if (disposed) return;
                setState({
                    renderer: ready.renderer,
                    atlasTexture: ready.atlasTexture,
                    spriteIndex: ready.spriteIndex,
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
            // Intentionally NOT calling renderer.dispose() — the renderer is
            // a session-wide singleton. Disposing it would tear down the
            // texture array and force a 5-10 s re-upload on the next visit.
        };
    }, [atlasBaseUrl]);

    return state;
}
