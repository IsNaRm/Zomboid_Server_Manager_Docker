/**
 * LOD-selection policy — picks which atlas LOD to sample for a given
 * on-screen sprite density.
 *
 * The relevant metric is `pixelsPerSquare`: how many screen pixels one
 * PZ-square edge occupies at the current zoom.
 *
 * VRAM trade-off: every active LOD pre-allocates a TEXTURE_2D_ARRAY of
 * pageCount × pageSize². At lod0 that's 51×4096²×4 ≈ 3.4 GB. Cards with
 * less than ~4 GB VRAM crash with WEBGL_OUT_OF_MEMORY. We therefore pick
 * the LOWEST LOD that still produces full sprite quality at the current
 * zoom — and rely on the per-sprite mipchain *inside* each atlas page
 * (pre-baked by pzpack_to_atlas.py) to handle sub-pixel detail.
 *
 * For pixelsPerSquare = 8 (typical default zoom), a lod3 atlas page
 * stores sprites at 1/8 size; sampling its highest mip gives the same
 * pixel coverage as sampling lod0's mip-3. Visually identical, ~64×
 * less VRAM.
 *
 *   pixelsPerSquare ≥ 64    →  LOD 0 (native, 4096²)  — extreme zoom-in
 *   16 ≤ pps < 64           →  LOD 1 (2048²)
 *   4 ≤ pps < 16            →  LOD 2 (1024²)
 *   pps < 4                 →  LOD 3 (512²)            — default zoom + zoom-out
 *
 * If the backend didn't publish all four LODs we clamp to the highest
 * id present so the renderer never asks for a non-existent variant.
 */

import type { AtlasLodInfo } from './types';

/**
 * Select a LOD id given current pixelsPerSquare and available LODs.
 *
 * @param pixelsPerSquare   Output of `proj.sqr * 2^(zoom - maxNativeZoom)`.
 * @param availableLods     Sorted ascending by id (LOD 0 first).
 * @returns                  The id of the LOD to use.
 */
export function selectLod(pixelsPerSquare: number, availableLods: AtlasLodInfo[]): number {
    if (availableLods.length === 0) {
        throw new Error('[lod-selection] availableLods must not be empty');
    }
    let preferred: number;
    if (pixelsPerSquare >= 64) {
        preferred = 0;
    } else if (pixelsPerSquare >= 16) {
        preferred = 1;
    } else if (pixelsPerSquare >= 4) {
        preferred = 2;
    } else {
        preferred = 3;
    }
    // Clamp to highest LOD actually published by the backend. When the
    // user is zoomed way out but the server only shipped LOD 0 we still
    // render with LOD 0 (just bigger memory footprint, no functional
    // regression vs the pre-LOD pipeline).
    const maxId = availableLods[availableLods.length - 1]!.id;
    return Math.min(preferred, maxId);
}

/**
 * Inverse query — pixelsPerSquare boundaries at which the LOD should
 * change. Used by the layer to pre-fetch the neighbouring LOD when the
 * viewport approaches the transition.
 */
export function lodBoundaries(): ReadonlyArray<{ lod: number; lower: number; upper: number }> {
    return [
        { lod: 0, lower: 64, upper: Infinity },
        { lod: 1, lower: 16, upper: 64 },
        { lod: 2, lower: 4, upper: 16 },
        { lod: 3, lower: 0, upper: 4 },
    ];
}
