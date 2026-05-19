/**
 * Atlas loader — downloads manifest.json + sprites.json + WebP atlas pages,
 * decodes them to ImageBitmap for WebGL upload.
 *
 * Endpoints consumed:
 *   GET /pz-atlas/manifest.json   — version + atlas count + sprite count
 *   GET /pz-atlas/sprites.json    — full sprite → UV map
 *   GET /pz-atlas/atlas-v...-N.webp — atlas pages
 */

import { buildSpriteIndex } from './sprite-lookup';
import { type LoadedAtlas, type SpritesManifest } from './types';
import { getCachedAtlasPage, setCachedAtlasPage } from './atlas-idb-cache';

// ---------------------------------------------------------------------------
// Manifest type (minimal — just enough to drive atlas download)
// ---------------------------------------------------------------------------

interface PzManifest {
    version: string;
    atlas_count: number;
    sprite_count: number;
}

// ---------------------------------------------------------------------------
// Progress callback
// ---------------------------------------------------------------------------

export type AtlasLoadProgress = (
    phase: 'manifest' | 'sprites' | 'atlas',
    loaded: number,
    total: number,
) => void;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Page-by-page metadata returned by loadAtlasMetadata. Lets callers decide
 * when to download each page (e.g. stream into a TEXTURE_2D_ARRAY layer).
 */
export interface AtlasMetadata {
    version: string;
    sprites: import('./types').SpriteIndex;
    pages: Array<{
        id: number;
        file: string;
        width: number;
        height: number;
        url: string;
    }>;
}

/**
 * Download manifest + sprites.json only. Atlas pages are NOT fetched here —
 * the caller iterates over `pages` and uses `fetchAtlasPage()` to stream
 * each one into GPU memory without holding more than one decoded ImageBitmap
 * at a time. Eager Promise.all decoding all 51 pages caps out at ~3.4 GB
 * CPU RAM (51 × 67 MB raw RGBA) and tears the renderer down on most machines.
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
    };
}

/**
 * Fetch and decode a single atlas page. Caller is responsible for calling
 * `imageBitmap.close()` after uploading to GPU.
 *
 * Uses IndexedDB as a persistent blob cache. The browser HTTP cache evicts
 * ~370 MB of immutable atlas pages aggressively, so we keep our own copy
 * keyed by atlas version. Subsequent visits become an IDB lookup (~10 ms
 * for the blob + ~50 ms decode) instead of a 15 s network re-download.
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
        // Fire-and-forget; failure to persist is non-fatal (next reload retries).
        void setCachedAtlasPage(version, pageId, blob);
    }
    return createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none' });
}

/**
 * Load the full PZ atlas from the server.
 *
 * Downloads manifest → sprites.json → all atlas pages in parallel, then
 * decodes WebP images to ImageBitmap (GPU-uploadable).
 *
 * @param baseUrl   Base URL prefix (e.g. "/pz-atlas"). No trailing slash.
 * @param onProgress  Optional progress callback.
 * @returns           Fully loaded atlas ready for WebGL upload.
 */
export async function loadAtlas(
    baseUrl: string,
    onProgress?: AtlasLoadProgress,
): Promise<LoadedAtlas> {
    // Step 1: manifest.json
    onProgress?.('manifest', 0, 1);
    const manifestRes = await fetch(`${baseUrl}/manifest.json`, { credentials: 'same-origin' });
    if (!manifestRes.ok) {
        throw new Error(`[atlas-loader] Failed to fetch manifest: ${manifestRes.status}`);
    }
    const manifest = (await manifestRes.json()) as PzManifest;
    onProgress?.('manifest', 1, 1);

    // Step 2: sprites.json
    onProgress?.('sprites', 0, 1);
    const spritesRes = await fetch(`${baseUrl}/sprites.json`, { credentials: 'same-origin' });
    if (!spritesRes.ok) {
        throw new Error(`[atlas-loader] Failed to fetch sprites.json: ${spritesRes.status}`);
    }
    const spritesManifest = (await spritesRes.json()) as SpritesManifest;
    onProgress?.('sprites', 1, 1);

    // Step 3: Download all atlas pages in parallel
    const atlasCount = manifest.atlas_count;
    const pagePromises = spritesManifest.atlases.map(async (atlasInfo, idx) => {
        const url = `${baseUrl}/${atlasInfo.file}`;
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) {
            throw new Error(`[atlas-loader] Failed to fetch atlas page ${idx}: ${res.status}`);
        }
        const blob = await res.blob();
        onProgress?.('atlas', idx + 1, atlasCount);
        // Decode to ImageBitmap — GPU-uploadable, off main thread
        return createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none' });
    });

    const pages = await Promise.all(pagePromises);

    // Step 4: Build sprite index
    const sprites = buildSpriteIndex(spritesManifest);

    return {
        pages,
        sprites,
        version: manifest.version,
    };
}

/**
 * Fetch only the manifest to check if a newer atlas version is available.
 * Used for polling to detect atlas rebuilds.
 *
 * @param baseUrl  Base URL prefix.
 * @returns        Version string from manifest.
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
