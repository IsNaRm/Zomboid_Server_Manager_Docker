/**
 * Minimal KTX2 parser — extracts level-0 payload + GL internal format from a
 * container produced by the backend `pzpack_to_atlas.py --ktx2` pipeline.
 *
 * We intentionally do NOT pull a full libktx — we only need:
 *   1. Verify the magic identifier
 *   2. Read width/height
 *   3. Pick the GL internal format from the VkFormat field
 *   4. Locate the mip-level-0 byte range and slice it out for
 *      compressedTexSubImage3D
 *
 * That's enough for our use case: atlases use one mip-level per LOD (the
 * page itself is already at the right size) and a single VkFormat we
 * control (BC7 or ASTC).
 *
 * Spec reference: https://github.khronos.org/KTX-Specification/
 *
 * Header layout (little-endian):
 *   bytes  0..11  magic identifier «\xABKTX 20\xBB\r\n\x1A\n»
 *   bytes 12..15  vkFormat                (uint32)
 *   bytes 16..19  typeSize                (uint32)
 *   bytes 20..23  pixelWidth              (uint32)
 *   bytes 24..27  pixelHeight             (uint32)
 *   bytes 28..31  pixelDepth              (uint32, 0 for 2D)
 *   bytes 32..35  layerCount              (uint32, 0 = no array layer)
 *   bytes 36..39  faceCount               (uint32, 1 for non-cubemap)
 *   bytes 40..43  levelCount              (uint32)
 *   bytes 44..47  supercompressionScheme  (uint32)
 *   ...index follows
 *   bytes 80..    level index — `levelCount` × {uint64 byteOffset, uint64 byteLength, uint64 uncompressedByteLength}
 *
 * For our pipeline supercompressionScheme is always 0 (uncompressed
 * container around compressed texels). Multi-layer arrays are not used.
 */

/** VkFormat values we recognise. From the Vulkan registry. */
const VK_FORMAT_BC7_UNORM_BLOCK = 145;
const VK_FORMAT_BC7_SRGB_BLOCK = 146;
const VK_FORMAT_ASTC_4x4_UNORM_BLOCK = 157;
const VK_FORMAT_ASTC_4x4_SRGB_BLOCK = 158;

/** WebGL extension internal formats — keep in sync with gl/textures.ts. */
export const GL_COMPRESSED_RGBA_BPTC_UNORM_EXT = 0x8E8C;       // EXT_texture_compression_bptc / BC7
export const GL_COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT = 0x8E8D;
export const GL_COMPRESSED_RGBA_ASTC_4x4_KHR = 0x93B0;
export const GL_COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR = 0x93D0;

/** KTX2 magic: 0xAB 'K' 'T' 'X' ' ' '2' '0' 0xBB 0x0D 0x0A 0x1A 0x0A */
const KTX2_MAGIC = new Uint8Array([
    0xAB, 0x4B, 0x54, 0x58,
    0x20, 0x32, 0x30, 0xBB,
    0x0D, 0x0A, 0x1A, 0x0A,
]);

export interface Ktx2Texture {
    /** WebGL internal format to pass to compressedTexSubImage3D. */
    glInternalFormat: number;
    /** Width in pixels of the level-0 payload. */
    width: number;
    /** Height in pixels of the level-0 payload. */
    height: number;
    /** Raw compressed bytes for mip level 0. */
    data: Uint8Array;
}

/**
 * Parse a KTX2 buffer and return the level-0 payload plus the matching
 * GL internal format. Throws on malformed input or unsupported VkFormat.
 */
export function parseKtx2(buffer: ArrayBuffer): Ktx2Texture {
    if (buffer.byteLength < 80) {
        throw new Error('[ktx2] file too small to contain header');
    }
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < KTX2_MAGIC.length; i++) {
        if (bytes[i] !== KTX2_MAGIC[i]) {
            throw new Error('[ktx2] bad magic identifier');
        }
    }

    const view = new DataView(buffer);
    const vkFormat = view.getUint32(12, true);
    const pixelWidth = view.getUint32(20, true);
    const pixelHeight = view.getUint32(24, true);
    const layerCount = view.getUint32(32, true);
    const faceCount = view.getUint32(36, true);
    const levelCount = view.getUint32(40, true);
    const supercompression = view.getUint32(44, true);

    if (layerCount > 1) {
        throw new Error(`[ktx2] multi-layer KTX2 not supported (layerCount=${layerCount})`);
    }
    if (faceCount !== 1) {
        throw new Error(`[ktx2] cubemap KTX2 not supported (faceCount=${faceCount})`);
    }
    if (supercompression !== 0) {
        throw new Error(`[ktx2] supercompression not supported (scheme=${supercompression})`);
    }
    if (levelCount === 0) {
        throw new Error('[ktx2] levelCount=0 (streaming mode not supported)');
    }

    const glInternalFormat = vkFormatToGl(vkFormat);

    // Level index entry 0 starts at offset 80. Each entry is 24 bytes
    // (3 × uint64). We use level 0 (the first entry).
    const idxOffset = 80;
    const byteOffset = readUint64(view, idxOffset);
    const byteLength = readUint64(view, idxOffset + 8);

    if (byteOffset + byteLength > buffer.byteLength) {
        throw new Error('[ktx2] level-0 byte range exceeds file size');
    }

    return {
        glInternalFormat,
        width: pixelWidth,
        height: pixelHeight,
        data: new Uint8Array(buffer, byteOffset, byteLength),
    };
}

/** Map VkFormat → WebGL compressed internal format. */
function vkFormatToGl(vkFormat: number): number {
    switch (vkFormat) {
        case VK_FORMAT_BC7_UNORM_BLOCK:
            return GL_COMPRESSED_RGBA_BPTC_UNORM_EXT;
        case VK_FORMAT_BC7_SRGB_BLOCK:
            return GL_COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT;
        case VK_FORMAT_ASTC_4x4_UNORM_BLOCK:
            return GL_COMPRESSED_RGBA_ASTC_4x4_KHR;
        case VK_FORMAT_ASTC_4x4_SRGB_BLOCK:
            return GL_COMPRESSED_SRGB8_ALPHA8_ASTC_4x4_KHR;
        default:
            throw new Error(`[ktx2] unsupported VkFormat=${vkFormat}`);
    }
}

/**
 * Read a 64-bit little-endian unsigned integer as a JS number. KTX2 byte
 * offsets routinely exceed 2^32 only on absurdly large containers — atlas
 * pages are at most a few MB — so a Number is safe.
 */
function readUint64(view: DataView, offset: number): number {
    const lo = view.getUint32(offset, true);
    const hi = view.getUint32(offset + 4, true);
    return hi * 0x100000000 + lo;
}
