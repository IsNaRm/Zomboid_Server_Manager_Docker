/**
 * Sprite name → atlas UV + mip info lookup.
 *
 * Builds a fast Map<string, SpriteEntry> from the sprites.json manifest.
 * Used by the WebGL renderer to resolve tile names to texture coordinates.
 */

import { type MipLevel, type SpriteEntry, type SpriteIndex, type SpritesManifest } from './types';

// ---------------------------------------------------------------------------
// Half-water sprites  (from pzmap2dzi/render_impl/base.py:_half_water)
// These water blend tiles are rendered at alpha 0.5 instead of full opacity.
// ---------------------------------------------------------------------------

/**
 * Set of sprite names that must be composited at 50 % alpha.
 * Corresponds to Python's `_half_water` set in base.py.
 */
export const HALF_WATER_SPRITES: ReadonlySet<string> = new Set([
    'blends_natural_02_1',
    'blends_natural_02_2',
    'blends_natural_02_3',
    'blends_natural_02_4',
]);

/**
 * Return true when the sprite should be rendered at half (0.5) opacity.
 * Used by the tile renderer to set the u_halfAlpha shader uniform.
 */
export function isHalfWater(name: string): boolean {
    return HALF_WATER_SPRITES.has(name);
}

/**
 * Build a fast SpriteIndex (Map) from the raw sprites.json manifest.
 *
 * Converts the raw number[][] mips format from JSON into typed MipLevel objects.
 *
 * @param manifest  Parsed sprites.json object.
 * @returns         Fast Map for O(1) sprite name lookup.
 */
export function buildSpriteIndex(manifest: SpritesManifest): SpriteIndex {
    const index: SpriteIndex = new Map();

    for (const [name, raw] of Object.entries(manifest.sprites)) {
        const mips: MipLevel[] = raw.mips.map(([u, v, w, h]) => ({ u, v, w, h }));

        const entry: SpriteEntry = {
            atlas: raw.atlas,
            mips,
            offset_x: raw.offset_x,
            offset_y: raw.offset_y,
        };

        index.set(name, entry);
    }

    return index;
}

/**
 * Look up a sprite by name.
 *
 * @param index   Built SpriteIndex.
 * @param name    Sprite name (e.g. "tile_floors_01_0").
 * @returns       SpriteEntry or undefined if not found.
 */
export function lookupSprite(index: SpriteIndex, name: string): SpriteEntry | undefined {
    return index.get(name);
}

/**
 * Get the mip level best matching the given on-screen pixel size.
 *
 * @param entry      Sprite entry.
 * @param pixelSize  How many screen pixels the sprite should cover (min dimension).
 * @returns          Appropriate MipLevel.
 */
export function getMipForPixelSize(entry: SpriteEntry, pixelSize: number): MipLevel {
    const mips = entry.mips;
    if (mips.length === 0) {
        throw new Error('[sprite-lookup] SpriteEntry has no mip levels');
    }

    // mips[0] = native (largest), mips[N] = 1×1 (smallest)
    // Find the mip level where the mip width >= pixelSize
    for (let i = mips.length - 1; i >= 0; i--) {
        const mip = mips[i];
        if (mip !== undefined && mip.w >= pixelSize) {
            return mip;
        }
    }

    // Fallback: native mip
    return mips[0]!;
}
