import { describe, expect, it } from 'vitest';
import {
    parseKtx2,
    GL_COMPRESSED_RGBA_BPTC_UNORM_EXT,
    GL_COMPRESSED_RGBA_ASTC_4x4_KHR,
} from '../ktx2-decoder';

/**
 * Build a minimal-but-valid KTX2 buffer for a 2x2 BC7 texture.
 *
 * Layout: 80-byte header + 24-byte level index + 16 bytes BC7 payload.
 * One BC7 block encodes 4x4 texels; for a 2x2 image we still need one
 * full 16-byte block (BC7 always block-quantises up).
 */
function buildKtx2(vkFormat = 145, width = 2, height = 2, payloadBytes = 16): ArrayBuffer {
    const headerSize = 80;
    const indexEntry = 24;
    const total = headerSize + indexEntry + payloadBytes;
    const buf = new ArrayBuffer(total);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);

    // Magic identifier
    const magic = [
        0xAB, 0x4B, 0x54, 0x58,
        0x20, 0x32, 0x30, 0xBB,
        0x0D, 0x0A, 0x1A, 0x0A,
    ];
    for (let i = 0; i < magic.length; i++) {
        bytes[i] = magic[i]!;
    }

    view.setUint32(12, vkFormat, true);       // vkFormat
    view.setUint32(16, 1, true);              // typeSize
    view.setUint32(20, width, true);          // pixelWidth
    view.setUint32(24, height, true);         // pixelHeight
    view.setUint32(28, 0, true);              // pixelDepth (2D)
    view.setUint32(32, 0, true);              // layerCount (non-array)
    view.setUint32(36, 1, true);              // faceCount (non-cubemap)
    view.setUint32(40, 1, true);              // levelCount
    view.setUint32(44, 0, true);              // supercompressionScheme

    // Level index entry 0: byteOffset (uint64), byteLength (uint64),
    // uncompressedByteLength (uint64). All values fit in lo half.
    const payloadOffset = headerSize + indexEntry;
    view.setUint32(80, payloadOffset, true);
    view.setUint32(84, 0, true);
    view.setUint32(88, payloadBytes, true);
    view.setUint32(92, 0, true);
    view.setUint32(96, payloadBytes, true);
    view.setUint32(100, 0, true);

    // Fill payload with a recognisable pattern.
    for (let i = 0; i < payloadBytes; i++) {
        bytes[payloadOffset + i] = (i * 7 + 3) & 0xFF;
    }

    return buf;
}

describe('parseKtx2', () => {
    it('parses BC7 UNORM container into level-0 payload + GL format', () => {
        const buf = buildKtx2(145, 4, 4, 16);
        const tex = parseKtx2(buf);
        expect(tex.glInternalFormat).toBe(GL_COMPRESSED_RGBA_BPTC_UNORM_EXT);
        expect(tex.width).toBe(4);
        expect(tex.height).toBe(4);
        expect(tex.data.byteLength).toBe(16);
        expect(tex.data[0]).toBe(3);   // (0*7+3) & 0xFF
        expect(tex.data[1]).toBe(10);  // (1*7+3) & 0xFF
    });

    it('recognises ASTC_4x4 UNORM (vkFormat=157)', () => {
        const buf = buildKtx2(157, 4, 4, 16);
        expect(parseKtx2(buf).glInternalFormat).toBe(GL_COMPRESSED_RGBA_ASTC_4x4_KHR);
    });

    it('rejects buffers without the KTX2 magic identifier', () => {
        const bogus = new ArrayBuffer(200);
        expect(() => parseKtx2(bogus)).toThrow(/magic/);
    });

    it('rejects unknown VkFormat values', () => {
        const buf = buildKtx2(0xDEAD, 4, 4, 16);
        expect(() => parseKtx2(buf)).toThrow(/VkFormat/);
    });

    it('rejects multi-layer arrays (we only support 2D textures)', () => {
        const buf = buildKtx2(145, 4, 4, 16);
        new DataView(buf).setUint32(32, 4, true);  // layerCount=4
        expect(() => parseKtx2(buf)).toThrow(/multi-layer/);
    });

    it('rejects supercompressed containers (we only handle uncompressed BC7/ASTC)', () => {
        const buf = buildKtx2(145, 4, 4, 16);
        new DataView(buf).setUint32(44, 1, true); // supercompressionScheme=Basis
        expect(() => parseKtx2(buf)).toThrow(/supercompression/);
    });
});
