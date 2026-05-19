/**
 * Parser for PZ .lotpack binary files.
 *
 * Port of:
 *   pzmap2dzi/cell.py        (Cell.__init__, Cell.get_square, load_cell)
 *   pzmap2dzi/binfile.py     (get_version, read_block, lotpack_data_parser)
 *   pzmap2dzi/util.py        (read_uint32, read_int32)
 *
 * Format overview (cell.py::Cell.__init__):
 *   MAGIC: "LOTP" (4 bytes) — if present, version follows; absent → version 0
 *   version: uint32 LE
 *   block_num: uint32  (= cellSizeInBlocks²)
 *   block_table: block_num × 8 bytes  (each entry: uint32 offset + uint32 padding)
 *   block data at each offset: read_block output
 *
 * read_block (binfile.py) — sparse encoding:
 *   For each layer in [minlayer, maxlayer):
 *     For each x in [0, block_size):
 *       For each y in [0, block_size):
 *         count: int32
 *           count == -1 → skip: int32 squares to skip ahead
 *           count == 0  → empty square (no tiles)
 *           count > 1   → room_id: int32 (discarded) + (count-1) tile indices: int32 each
 *
 * lotpack_data_parser (binfile.py):
 *   reads room_id (discarded) then (count-1) tile int32 indices.
 */

import { type Cursor, readInt32, readUint32 } from './binary-reader';
import { type CellMetadata, type LotpackData, type SquareLayerData } from '../types';

// Magic bytes: "LOTP"
const MAGIC_LOTP = new Uint8Array([0x4c, 0x4f, 0x54, 0x50]);

// ---------------------------------------------------------------------------
// Internal: sparse block reader
// ---------------------------------------------------------------------------

/**
 * Parse one block using the sparse run-length scheme from binfile.py::read_block.
 *
 * Returns a BlockLayer (sparse 3-D array indexed as [layerIdx][x][y]).
 * layerIdx = 0 corresponds to minlayer.
 */
function readBlock(
    view: DataView,
    cursor: Cursor,
    blockSize: number,
    minLayer: number,
    maxLayer: number,
): Array<Array<Array<number[] | null> | null> | null> {
    const layerCount = maxLayer - minLayer;
    const squarePerLayer = blockSize * blockSize;

    // Result: indexed [layerIdx][x][y]
    const blockData: Array<Array<Array<number[] | null> | null> | null> = new Array(
        layerCount,
    ).fill(null);

    let skip = 0;

    for (let z = minLayer; z < maxLayer; z++) {
        const layerIdx = z - minLayer;

        if (skip >= squarePerLayer) {
            skip -= squarePerLayer;
            continue;
        }

        const layerData: Array<Array<number[] | null> | null> = new Array(blockSize).fill(null);
        let layerHasData = false;

        for (let x = 0; x < blockSize; x++) {
            if (skip >= blockSize) {
                skip -= blockSize;
                continue;
            }

            const rowData: Array<number[] | null> = new Array(blockSize).fill(null);
            let rowHasData = false;

            for (let y = 0; y < blockSize; y++) {
                if (skip > 0) {
                    skip -= 1;
                    continue;
                }

                const count = readInt32(view, cursor);

                if (count === -1) {
                    // Run-length skip
                    skip = readInt32(view, cursor);
                    if (skip > 0) {
                        skip -= 1;
                        continue;
                    }
                    // skip == 0 means this square has no tiles either — continue
                    continue;
                }

                if (count > 1) {
                    // lotpack_data_parser: read room_id (discard) then (count-1) tile indices
                    readInt32(view, cursor); // room_id — discarded per Python reference
                    const tiles: number[] = [];
                    for (let t = 0; t < count - 1; t++) {
                        tiles.push(readInt32(view, cursor));
                    }
                    rowData[y] = tiles;
                    rowHasData = true;
                }
                // count == 0: empty square, rowData[y] stays null
            }

            if (rowHasData) {
                layerData[x] = rowData;
                layerHasData = true;
            }
        }

        if (layerHasData) {
            blockData[layerIdx] = layerData;
        }
    }

    return blockData;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a .lotpack binary buffer into a LotpackData object.
 *
 * @param buffer   Raw bytes from the server endpoint.
 * @param header   Parsed CellMetadata from the corresponding .lotheader.
 * @returns        Parsed LotpackData.
 * @throws         Error if magic bytes don't match or versions are inconsistent.
 */
export function parseLotpack(buffer: ArrayBuffer, header: CellMetadata): LotpackData {
    const view = new DataView(buffer);
    const cursor: Cursor = { pos: 0 };

    // --- Magic + version (binfile.py::get_version) ---
    let version: number;
    const buf = new Uint8Array(buffer);
    const magicMatches =
        buf[0] === MAGIC_LOTP[0] &&
        buf[1] === MAGIC_LOTP[1] &&
        buf[2] === MAGIC_LOTP[2] &&
        buf[3] === MAGIC_LOTP[3];

    if (magicMatches) {
        cursor.pos = 4;
        version = readUint32(view, cursor);
    } else {
        // No magic — version 0, cursor stays at 0
        version = 0;
    }

    if (version !== header.version) {
        throw new Error(
            `[lotpack] Version mismatch: header=${header.version}, lotpack=${version}`,
        );
    }

    const { cellSizeInBlocks, blockSize, minLayer, maxLayer } = header;
    const blockNum = readUint32(view, cursor);
    const expectedBlocks = cellSizeInBlocks * cellSizeInBlocks;

    if (blockNum !== expectedBlocks) {
        throw new Error(
            `[lotpack] Block count mismatch: got ${blockNum}, expected ${expectedBlocks}`,
        );
    }

    // Block table: blockNum × 8 bytes, each = [uint32 offset][uint32 unused]
    const blockTableStart = cursor.pos;
    const blocks: LotpackData['blocks'] = [];

    for (let i = 0; i < blockNum; i++) {
        // Read offset from table entry (8 bytes each)
        const tableEntry: Cursor = { pos: blockTableStart + i * 8 };
        const dataOffset = readUint32(view, tableEntry);

        // Jump to block data
        const blockCursor: Cursor = { pos: dataOffset };
        const block = readBlock(view, blockCursor, blockSize, minLayer, maxLayer);
        blocks.push(block);
    }

    return { version, blocks };
}

// ---------------------------------------------------------------------------
// SquareLayerData accessor
// ---------------------------------------------------------------------------

/**
 * Build a SquareLayerData accessor from parsed header + lotpack data.
 * Mirrors the Python Cell.get_square() method.
 */
export function buildSquareAccessor(header: CellMetadata, lotpack: LotpackData): SquareLayerData {
    const { cellSizeInBlocks, blockSize, minLayer, maxLayer } = header;

    return {
        header,
        lotpack,

        getSquare(subx: number, suby: number, layer: number): number[] | null {
            if (layer < minLayer || layer >= maxLayer) {
                return null;
            }

            const bx = Math.floor(subx / blockSize);
            const x = subx % blockSize;
            const by = Math.floor(suby / blockSize);
            const y = suby % blockSize;

            const blockIdx = bx * cellSizeInBlocks + by;
            const block = lotpack.blocks[blockIdx];
            if (!block) return null;

            const layerIdx = layer - minLayer;
            const layerData = block[layerIdx];
            if (!layerData) return null;

            const rowData = layerData[x];
            if (!rowData) return null;

            return rowData[y] ?? null;
        },
    };
}
