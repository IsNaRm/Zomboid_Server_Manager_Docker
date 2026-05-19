/**
 * Atlas loader — fetches manifest.json, sprites.json, cell-pages.json and
 * individual atlas page blobs.
 *
 * The renderer initialises with metadata only (~3 MB total); atlas pages
 * themselves are downloaded lazily by AtlasPageManager as the renderer
 * encounters cells that reference them.
 *
 * Endpoints consumed:
 *   GET /pz-atlas/manifest.json            — version + LOD descriptors
 *   GET /pz-atlas/sprites.json             — full sprite → UV map
 *   GET /pz-atlas/cell-pages.json          — cell → atlas-page mapping (optional)
 *   GET /pz-atlas/atlas-v...-N-lodL.{webp,ktx2}  — per-LOD atlas page
 *   GET /pz-atlas/atlas-v...-N.webp        — legacy single-LOD fallback
 */

import { buildSpriteIndex } from './sprite-lookup';
import {
    type AtlasLodInfo,
    type AtlasPageFormat,
    type CellPagesMap,
    type LoadedAtlas,
    type SpriteIndex,
    type SpritesManifest,
} from './types';
import { getCachedAtlasPage, setCachedAtlasPage } from './atlas-idb-cache';

// ---------------------------------------------------------------------------
// Manifest type (extended for multi-LOD pipeline)
// ---------------------------------------------------------------------------

interface PzManifest {
    version: string;
    atlas_count: number;
    sprite_count: number;
    /** Present when the backend was rebuilt with LOD support. */
    lods?: AtlasLodInfo[];
    /** Whether the backend wrote KTX2 variants of each LOD. */
    has_ktx2?: boolean;
    /** 'BC7' or 'ASTC_4x4'. */
    ktx2_format?: 'BC7' | 'ASTC_4x4';
    /** Whether cell-pages.json is published. */
    has_cell_pages?: boolean;
}

// ---------------------------------------------------------------------------
// Progress callback
// ---------------------------------------------------------------------------

export type AtlasLoadProgress = (
    phase: 'manifest' | 'sprites' | 'cell-pages' | 'atlas',
    loaded: number,
    total: number,
) => void;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AtlasMetadata {
    version: string;
    sprites: SpriteIndex;
    /** All atlas pages — descriptor only; bytes are fetched on demand. */
    pages: Array<{
        id: number;
        file: string;
        width: number;
        height: number;
        url: string;
    }>;
    /** LOD descriptors. Falls back to single LOD0 when the server is pre-LOD. */
    lods: AtlasLodInfo[];
    /** Whether the server published KTX2 variants. */
    serverHasKtx2: boolean;
    /** UV format used by sprites.json. */
    uvFormat: 'pixels' | 'normalized';
    /** Optional cell → pageId map. Null when the server didn't publish it. */
    cellPages: CellPagesMap | null;
    /** Total page count (matches manifest.atlas_count). */
    pageCount: number;
}

/**
 * Download manifest + sprites.json + cell-pages.json (if present). The
 * heavy atlas pages are NOT fetched here — AtlasPageManager handles that
 * lazily during render.
 *
 * Older atlas builds (no `lods` field, no cell-pages.json) load fine:
 *   - lods defaults to a single entry [{id:0, scale:1.0, size:atlas_size}]
 *   - cellPages stays null and the renderer treats every page as required
 */
export async function loadAtlasMetadata(
    baseUrl: string,
    onProgress?: AtlasLoadProgress,
): Promise<AtlasMetadata> {
    onProgress?.('manifest', 0, 1);
    const manifestRes = await fetch(`${baseUrl}/manifest.json`, { credentials: 'same-origin' });
    if (!manifestRes.ok) {
        throw new Error(`[atlas-loader] Failed to fetch manifest: ${manifestRes.status}`);
    }
    const manifest = (await manifestRes.json()) as PzManifest;
    onProgress?.('manifest', 1, 1);

    onProgress?.('sprites', 0, 1);
    const spritesRes = await fetch(`${baseUrl}/sprites.json`, { credentials: 'same-origin' });
    if (!spritesRes.ok) {
        throw new Error(`[atlas-loader] Failed to fetch sprites.json: ${spritesRes.status}`);
    }
    const spritesManifest = (await spritesRes.json()) as SpritesManifest;
    onProgress?.('sprites', 1, 1);

    const sprites = buildSpriteIndex(spritesManifest);

    // cell-pages.json is optional — when the backend hasn't generated it,
    // the manager falls back to "treat all pages as required" which is
    // identical to the old behaviour.
    let cellPages: CellPagesMap | null = null;
    if (manifest.has_cell_pages !== false) {
        onProgress?.('cell-pages', 0, 1);
        try {
            const cpRes = await fetch(`${baseUrl}/cell-pages.json`, { credentials: 'same-origin' });
            if (cpRes.ok) {
                cellPages = (await cpRes.json()) as CellPagesMap;
            }
        } catch {
            // Non-fatal — degrade gracefully.
        }
        onProgress?.('cell-pages', 1, 1);
    }

    const atlasSize = spritesManifest.atlas_size;
    const lods: AtlasLodInfo[] = manifest.lods ?? [
        { id: 0, scale: 1.0, size: atlasSize },
    ];

    return {
        version: manifest.version,
        sprites,
        pages: spritesManifest.atlases.map((a) => ({
            id: a.id,
            file: a.file,
            width: a.width,
            height: a.height,
            url: `${baseUrl}/${a.file}`,
        })),
        lods,
        serverHasKtx2: manifest.has_ktx2 === true,
        uvFormat: spritesManifest.uv_format ?? 'pixels',
        cellPages,
        pageCount: manifest.atlas_count,
    };
}

/**
 * URL template helper for atlas-page filenames. Multi-LOD pipeline uses
 * the new format; the renderer also falls back to the legacy single-LOD
 * layout when LOD=0 / format=webp and the new-format URL 404s.
 */
export function buildAtlasPageUrl(
    version: string,
    pageId: number,
    lod: number,
    format: AtlasPageFormat,
): string {
    if (lod === 0 && format === 'webp') {
        // Modern multi-LOD layout still puts lod0/webp in this exact filename:
        return `atlas-${version}-${pageId}-lod0.webp`;
    }
    return `atlas-${version}-${pageId}-lod${lod}.${format}`;
}

/**
 * Fetch a single atlas page as a Blob (raw bytes). Uses IDB cache. Returns
 * null on 404 so the manager can mark the page as permanently missing.
 *
 * Falls back to the legacy URL `atlas-{version}-{pageId}.webp` when the
 * multi-LOD URL doesn't exist (pre-LOD atlas) — only for LOD=0 / WebP.
 */
export async function fetchAtlasPageBlob(
    url: string,
    version: string,
    pageId: number,
    lod = 0,
    format: AtlasPageFormat = 'webp',
): Promise<Blob | null> {
    const cached = await getCachedAtlasPage(version, pageId, lod, format);
    if (cached) return cached;

    let res = await fetch(url, { credentials: 'same-origin' });

    // Pre-LOD fallback — single-LOD legacy atlas files don't have the
    // `-lod0` suffix. Try the un-suffixed name when the LOD URL 404s.
    if (!res.ok && res.status === 404 && lod === 0 && format === 'webp' && url.includes('-lod0.webp')) {
        const legacyUrl = url.replace('-lod0.webp', '.webp');
        res = await fetch(legacyUrl, { credentials: 'same-origin' });
    }

    if (!res.ok) {
        if (res.status !== 404) {
            console.warn(`[atlas-loader] page fetch failed ${res.status}: ${url}`);
        }
        return null;
    }
    const blob = await res.blob();
    void setCachedAtlasPage(version, pageId, blob, lod, format);
    return blob;
}

/**
 * Fetch and decode a single atlas page as ImageBitmap. Used in tests
 * and the legacy initialisation path. Callers must close() the returned
 * bitmap after upload.
 */
export async function fetchAtlasPage(
    url: string,
    version?: string,
    pageId?: number,
): Promise<ImageBitmap> {
    if (version !== undefined && pageId !== undefined) {
        const cached = await getCachedAtlasPage(version, pageId);
        if (cached) {
            return createImageBitmap(cached, { imageOrientation: 'none', premultiplyAlpha: 'none' });
        }
    }
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
        throw new Error(`[atlas-loader] Failed to fetch ${url}: ${res.status}`);
    }
    const blob = await res.blob();
    if (version !== undefined && pageId !== undefined) {
        void setCachedAtlasPage(version, pageId, blob);
    }
    return createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none' });
}

/**
 * Legacy eager-load path. Retained for tests; production now uses
 * loadAtlasMetadata + AtlasPageManager which avoids the 3.4 GB VRAM spike.
 */
export async function loadAtlas(
    baseUrl: string,
    onProgress?: AtlasLoadProgress,
): Promise<LoadedAtlas> {
    onProgress?.('manifest', 0, 1);
    const manifestRes = await fetch(`${baseUrl}/manifest.json`, { credentials: 'same-origin' });
    if (!manifestRes.ok) {
        throw new Error(`[atlas-loader] Failed to fetch manifest: ${manifestRes.status}`);
    }
    const manifest = (await manifestRes.json()) as PzManifest;
    onProgress?.('manifest', 1, 1);

    onProgress?.('sprites', 0, 1);
    const spritesRes = await fetch(`${baseUrl}/sprites.json`, { credentials: 'same-origin' });
    if (!spritesRes.ok) {
        throw new Error(`[atlas-loader] Failed to fetch sprites.json: ${spritesRes.status}`);
    }
    const spritesManifest = (await spritesRes.json()) as SpritesManifest;
    onProgress?.('sprites', 1, 1);

    const atlasCount = manifest.atlas_count;
    const pagePromises = spritesManifest.atlases.map(async (atlasInfo, idx) => {
        const url = `${baseUrl}/${atlasInfo.file}`;
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) {
            throw new Error(`[atlas-loader] Failed to fetch atlas page ${idx}: ${res.status}`);
        }
        const blob = await res.blob();
        onProgress?.('atlas', idx + 1, atlasCount);
        return createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none' });
    });

    const pages = await Promise.all(pagePromises);
    const sprites = buildSpriteIndex(spritesManifest);

    return { pages, sprites, version: manifest.version };
}

/**
 * Eagerly download every atlas page × every LOD into IndexedDB.
 *
 * Solves the "lazy-load mid-pan stutter" problem: when the user
 * pans into a new area we don't want to wait for a network round-trip
 * for each new atlas page. IDB persistence + immutable Cache-Control
 * means each WebP/KTX2 blob is downloaded ONCE per atlas version and
 * survives reloads forever (until the next `php artisan
 * zomboid:build-atlas`).
 *
 * Pages stay on disk; GPU upload is still lazy (per `AtlasPageManager`).
 * Total IDB cost ≈ on-disk atlas size (e.g. 350 MB for a 51-page Knox
 * atlas across 4 LODs).
 */
export async function preloadAllAtlasPages(
    baseUrl: string,
    version: string,
    pages: ReadonlyArray<{ id: number }>,
    lods: ReadonlyArray<{ id: number }>,
    format: AtlasPageFormat,
    onProgress?: (done: number, total: number) => void,
    concurrency = 8,
): Promise<void> {
    const tasks: Array<{ pageId: number; lod: number; url: string }> = [];
    for (const lod of lods) {
        for (const page of pages) {
            tasks.push({
                pageId: page.id,
                lod: lod.id,
                url: `${baseUrl}/${buildAtlasPageUrl(version, page.id, lod.id, format)}`,
            });
        }
    }
    const total = tasks.length;
    let done = 0;
    onProgress?.(0, total);
    let cursor = 0;
    const worker = async (): Promise<void> => {
        while (true) {
            const i = cursor++;
            if (i >= tasks.length) return;
            const t = tasks[i]!;
            // fetchAtlasPageBlob writes to IDB internally; we don't use
            // the returned blob (just want the side-effect of caching).
            await fetchAtlasPageBlob(t.url, version, t.pageId, t.lod, format);
            done++;
            onProgress?.(done, total);
        }
    };
    await Promise.all(
        Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker),
    );
}

/**
 * Fetch only the manifest to check if a newer atlas version is available.
 * Used for polling to detect atlas rebuilds.
 */
export async function fetchAtlasVersion(baseUrl: string): Promise<string | null> {
    try {
        const res = await fetch(`${baseUrl}/manifest.json`, {
            credentials: 'same-origin',
            cache: 'no-store',
        });
        if (!res.ok) return null;
        const manifest = (await res.json()) as PzManifest;
        return manifest.version;
    } catch {
        return null;
    }
}
