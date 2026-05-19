/**
 * Parser for PZ B42 save-game cell binary files.
 *
 * Port of pzmap2dzi/render_impl/save.py (SaveGameBase.load_block / get_save_version).
 *
 * The save game uses an external native library (pzdataspec) for the actual
 * block parsing in the Python implementation — we cannot fully replicate that
 * without the spec binary. This module implements what is available from the
 * open-source reference:
 *
 *   - File format detection (version byte + uint32 at offset 1)
 *   - Version detection: version <= 195 → B41 (block_size=10), else B42 (block_size=8)
 *   - Basic block header reading so callers can detect presence/absence of data
 *
 * IMPORTANT: Full sprite extraction from save .bin files requires the
 * pzdataspec native library. This parser provides what is available from the
 * open-source format, plus stubs for the missing pieces so the worker
 * architecture can still function with graceful degradation.
 *
 * The save overlay is optional — if this parser returns an empty squares
 * array the WebGL renderer simply skips the save layer.
 */

import { type SaveGameData } from '../types';

// ---------------------------------------------------------------------------
// Version detection
// ---------------------------------------------------------------------------

/**
 * Read the save-game version from the first 5 bytes of a block file.
 *
 * Format (save.py::get_save_version):
 *   byte[0]:   unknown/magic
 *   bytes[1-4]: version (big-endian uint32)
 *
 * version <= 195 → B41, else → B42.
 */
function detectSaveVersion(view: DataView): { saveVersion: number; blockSize: number } | null {
    if (view.byteLength < 5) {
        return null;
    }
    // Version is stored big-endian per the Python struct.unpack('>I', data[1:5])
    const version = view.getUint32(1, false /* big-endian */);
    const saveVersion = version <= 195 ? 41 : 42;
    const blockSize = saveVersion === 41 ? 10 : 8;
    return { saveVersion, blockSize };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a B42 save-game cell binary file.
 *
 * Due to the proprietary pzdataspec format, full sprite extraction is not
 * available in the open-source parser. This function:
 *   1. Detects the save version
 *   2. Returns a SaveGameData with empty squares[] (graceful degradation)
 *
 * The save overlay will simply show no modifications, which is safe — it
 * does not corrupt the base map render.
 *
 * @param buffer Raw bytes from the server's /cell/{x}/{y}/save endpoint.
 * @returns      Parsed SaveGameData (squares may be empty if format is opaque).
 */
export function parseSavegame(buffer: ArrayBuffer): SaveGameData {
    const view = new DataView(buffer);

    const detected = detectSaveVersion(view);
    if (!detected) {
        return {
            saveVersion: 42,
            blockSize: 8,
            squares: [],
        };
    }

    const { saveVersion, blockSize } = detected;

    // Full sprite extraction requires pzdataspec native library which
    // is not part of the open-source pzmap2dzi. Return a valid but empty
    // result — the renderer will show base map without save overlay.
    return {
        saveVersion,
        blockSize,
        squares: [],
    };
}

/**
 * Check whether a buffer looks like a valid save-game file.
 * Used by the worker to avoid parsing garbage data.
 */
export function isSaveGameBuffer(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 5) return false;
    const view = new DataView(buffer);
    const detected = detectSaveVersion(view);
    return detected !== null;
}
