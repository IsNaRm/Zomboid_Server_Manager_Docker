/**
 * Programmatic fixture builders for PZ binary format tests.
 *
 * These produce binary buffers that match exactly what the Python reference
 * implementation (pzmap2dzi) would generate / parse.
 *
 * Naming convention: make<Format><Variant>Buffer()
 */

// ---------------------------------------------------------------------------
// Low-level helpers — mirror struct.pack('<I'/'<i'/'B') from Python
// ---------------------------------------------------------------------------

function uint32LE(n: number): Uint8Array {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    return b;
}

function int32LE(n: number): Uint8Array {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, n, true);
    return b;
}

function uint8(n: number): Uint8Array {
    return new Uint8Array([n & 0xff]);
}

function utf8Line(s: string): Uint8Array {
    const encoded = new TextEncoder().encode(s + '\n');
    return encoded;
}

function concat(...parts: Uint8Array[]): ArrayBuffer {
    const totalLength = parts.reduce((acc, p) => acc + p.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const p of parts) {
        result.set(p, offset);
        offset += p.byteLength;
    }
    return result.buffer;
}

// ---------------------------------------------------------------------------
// Lotheader fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal valid B42 .lotheader with:
 *   - 3 tile names
 *   - 1 room with 2 rects, 0 meta objects
 *   - 1 building with 1 room
 *   - zpop 32×32 grid with (x+y)%256 values
 */
export function makeB42LotheaderBuffer(): ArrayBuffer {
    const tiles = [
        'tile_floors_01_0',
        'tile_walls_exterior_house_01_0',
        'location_restaurant_burger_01_0',
    ];

    const parts: Uint8Array[] = [];

    // MAGIC + version
    parts.push(new Uint8Array([0x4c, 0x4f, 0x54, 0x48])); // "LOTH"
    parts.push(uint32LE(1)); // version 1 = B42

    // Tile defs
    parts.push(uint32LE(tiles.length));
    for (const t of tiles) {
        parts.push(utf8Line(t));
    }

    // width, height (256×256)
    parts.push(uint32LE(256));
    parts.push(uint32LE(256));

    // B42: minlayer=-32, maxlayer stored=7 (actual exclusive = 8)
    parts.push(int32LE(-32));
    parts.push(int32LE(7));

    // 1 room
    parts.push(uint32LE(1));
    parts.push(utf8Line('living_room'));
    parts.push(int32LE(0)); // layer
    parts.push(uint32LE(2)); // 2 rects
    // rect 0
    parts.push(int32LE(10));
    parts.push(int32LE(10));
    parts.push(int32LE(5));
    parts.push(int32LE(5));
    // rect 1
    parts.push(int32LE(20));
    parts.push(int32LE(10));
    parts.push(int32LE(3));
    parts.push(int32LE(4));
    parts.push(uint32LE(0)); // 0 meta objects

    // 1 building
    parts.push(uint32LE(1));
    parts.push(uint32LE(1)); // 1 room
    parts.push(uint32LE(0)); // room id 0

    // zpop 32×32
    for (let x = 0; x < 32; x++) {
        for (let y = 0; y < 32; y++) {
            parts.push(uint8((x + y) % 256));
        }
    }

    return concat(...parts);
}

/**
 * Minimal valid B41 .lotheader with:
 *   - LOTH magic + version 0
 *   - 2 tile names
 *   - 0x00 padding byte (B41 specific)
 *   - 0 rooms, 0 buildings
 *   - zpop 30×30
 */
export function makeB41LotheaderBuffer(): ArrayBuffer {
    const tiles = ['tile_floors_01_0', 'tile_walls_exterior_house_01_0'];

    const parts: Uint8Array[] = [];

    // MAGIC + version
    parts.push(new Uint8Array([0x4c, 0x4f, 0x54, 0x48])); // "LOTH"
    parts.push(uint32LE(0)); // version 0 = B41

    // Tile defs
    parts.push(uint32LE(tiles.length));
    for (const t of tiles) {
        parts.push(utf8Line(t));
    }

    // B41 padding byte
    parts.push(uint8(0));

    // width, height
    parts.push(uint32LE(300));
    parts.push(uint32LE(300));

    // B41: only maxlayer stored
    parts.push(int32LE(7));

    // 0 rooms
    parts.push(uint32LE(0));

    // 0 buildings
    parts.push(uint32LE(0));

    // zpop 30×30 (B41 CELL_SIZE_IN_BLOCKS=30)
    for (let x = 0; x < 30; x++) {
        for (let y = 0; y < 30; y++) {
            parts.push(uint8(1));
        }
    }

    return concat(...parts);
}

/**
 * Lotheader with no LOTH magic — should fall back to B41 (version 0).
 * In practice pzmap2dzi would call the default function read_uint32 at pos=0.
 * Without magic, version is determined by reading uint32 at pos=0 directly.
 * This scenario means our parser should handle magic-absent gracefully.
 */
export function makeTruncatedBuffer(): ArrayBuffer {
    // Just 3 bytes — too short for anything meaningful
    return new Uint8Array([0x4c, 0x4f, 0x54]).buffer;
}

// ---------------------------------------------------------------------------
// Lotpack fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal valid B42 .lotpack for a 32×32-block cell (1024 blocks total).
 *
 * All blocks are empty (no tile data) except block at index (bx=0, by=0)
 * which has one square with data at layer 0, x=2, y=3.
 *
 * The lotpack_data_parser reads: room_id (int32, discarded) + tile indices.
 *
 * Block table entry format: [uint32 offset][uint32 padding_zero]
 */
export function makeB42LotpackBuffer(blockCount: number = 1024): ArrayBuffer {
    const parts: Uint8Array[] = [];

    // MAGIC + version
    parts.push(new Uint8Array([0x4c, 0x4f, 0x54, 0x50])); // "LOTP"
    parts.push(uint32LE(1)); // version 1 = B42

    // block_num
    parts.push(uint32LE(blockCount));

    // Block table: blockCount × 8 bytes each.
    // We need to compute offsets. The table itself starts after:
    //   4 (LOTP) + 4 (version) + 4 (block_num) = 12 bytes header
    //   then blockCount × 8 bytes of table
    // Block data follows immediately after the table.
    const tableStart = 4 + 4 + 4; // 12
    const tableSize = blockCount * 8;
    let dataOffset = tableStart + tableSize;

    // We'll build block data separately, then compose
    const blockDataParts: Uint8Array[] = [];

    for (let i = 0; i < blockCount; i++) {
        const thisOffset = dataOffset;

        let blockBytes: Uint8Array;
        if (i === 0) {
            // Block 0: non-empty — one square at layer 0 (layerIdx=32 for B42 minlayer=-32),
            // Actually minLayer=-32, so layerIdx for layer=0 is 0-(-32)=32.
            // But for simplicity of the test we write an empty block too.
            // Let's write a block that has data at the right layer.
            // B42: layerCount = maxLayer - minLayer = 8 - (-32) = 40
            // We write all 40 layers, but most are skip=-1.
            blockBytes = makeNonEmptyBlockBytes(40, 8);
        } else {
            // Empty block: 40 layers, all skip
            blockBytes = makeEmptyBlockBytes(40, 8);
        }

        blockDataParts.push(blockBytes);
        dataOffset += blockBytes.byteLength;

        // Table entry: [offset][0]
        parts.push(uint32LE(thisOffset));
        parts.push(uint32LE(0));
    }

    // Append all block data
    for (const bd of blockDataParts) {
        parts.push(bd);
    }

    return concat(...parts);
}

/**
 * Build bytes for an all-empty block (all squares are skipped).
 *
 * read_block skips via count=-1 + skip=N encoding.
 * For a fully empty block we can encode each layer as one big skip.
 */
function makeEmptyBlockBytes(layerCount: number, blockSize: number): Uint8Array {
    const squaresPerLayer = blockSize * blockSize;
    const parts: Uint8Array[] = [];

    for (let z = 0; z < layerCount; z++) {
        for (let x = 0; x < blockSize; x++) {
            for (let y = 0; y < blockSize; y++) {
                // count=0 means empty square
                parts.push(int32LE(0));
            }
        }
    }

    const total = parts.reduce((acc, p) => acc + p.byteLength, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        result.set(p, offset);
        offset += p.byteLength;
    }

    // Actually, let's use the skip encoding to be more realistic:
    // For each layer: count=-1 means skip follows
    // skip = squaresPerLayer - 1 means skip the rest of this layer from current pos
    // But it's easier to just write count=0 for each square.
    // The above is correct — just verbose. Use it.
    void squaresPerLayer; // used conceptually
    return result;
}

/**
 * Build bytes for a block with data at layer index 32 (absolute layer 0 for B42),
 * x=2, y=3, with tiles [0, 1] (indices into tile name array).
 */
function makeNonEmptyBlockBytes(layerCount: number, blockSize: number): Uint8Array {
    const parts: Uint8Array[] = [];

    for (let z = 0; z < layerCount; z++) {
        for (let x = 0; x < blockSize; x++) {
            for (let y = 0; y < blockSize; y++) {
                if (z === 32 && x === 2 && y === 3) {
                    // count=3: room_id + 2 tile indices → count-1=2 tiles
                    parts.push(int32LE(3));
                    parts.push(int32LE(999)); // room_id (discarded)
                    parts.push(int32LE(0)); // tile index 0
                    parts.push(int32LE(1)); // tile index 1
                } else {
                    parts.push(int32LE(0)); // empty
                }
            }
        }
    }

    const total = parts.reduce((acc, p) => acc + p.byteLength, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        result.set(p, offset);
        offset += p.byteLength;
    }
    return result;
}

/**
 * Export helper: return a pre-computed Base64 fixture for the B42 lotheader.
 * Generated via Docker Python to ensure byte-for-byte correctness.
 */
export const B42_LOTHEADER_BASE64 =
    'TE9USAEAAAADAAAAdGlsZV9mbG9vcnNfMDFfMAp0aWxlX3dhbGxzX2V4dGVyaW9yX2hvdXNlXzAxXzAKbG9jYXRpb25fcmVzdGF1cmFudF9idXJnZXJfMDFfMAoAAQAAAAEAAOD///8HAAAAAQAAAGxpdmluZ19yb29tCgAAAAACAAAACgAAAAoAAAAFAAAABQAAABQAAAAKAAAAAwAAAAQAAAAAAAAAAQAAAAEAAAAAAAAAAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8BAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fIAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIwUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJggJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnCQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKQsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKisNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLA4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtDxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLxESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wEhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDETFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMhQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NRcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2GBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1NjcZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3OBobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5GxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTocHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ox0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8Hh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pg==';
