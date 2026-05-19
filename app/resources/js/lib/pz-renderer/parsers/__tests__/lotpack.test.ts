/**
 * Unit tests for the .lotpack binary parser.
 *
 * Tests verify the sparse block read_block encoding is correctly decoded,
 * including the lotpack_data_parser (room_id discarded, tile indices kept).
 */

import { describe, expect, it } from 'vitest';
import { buildSquareAccessor, parseLotpack } from '../lotpack';
import { makeB42LotheaderBuffer, makeB42LotpackBuffer } from './fixtures/make-fixtures';
import { parseLotheader } from '../lotheader';
import type { CellMetadata } from '../../types';

// ---------------------------------------------------------------------------
// Helper: minimal B42 header for 32×32-block cell
// ---------------------------------------------------------------------------

function getB42Header(): CellMetadata {
    const buf = makeB42LotheaderBuffer();
    return parseLotheader(buf, 30, 30);
}

// ---------------------------------------------------------------------------
// Basic parsing tests
// ---------------------------------------------------------------------------

describe('parseLotpack — basic structure', () => {
    it('parses LOTP magic and version', () => {
        const header = getB42Header();
        const buf = makeB42LotpackBuffer(32 * 32);
        const result = parseLotpack(buf, header);
        expect(result.version).toBe(1);
    });

    it('returns correct number of blocks (32×32=1024 for B42)', () => {
        const header = getB42Header();
        const buf = makeB42LotpackBuffer(32 * 32);
        const result = parseLotpack(buf, header);
        expect(result.blocks).toHaveLength(1024);
    });

    it('throws on version mismatch', () => {
        const header = getB42Header();
        // Make a B41 lotpack (no LOTP magic → version=0) but use B42 header
        const buf = new ArrayBuffer(8);
        const view = new DataView(buf);
        view.setUint32(0, 0, true); // version=0, no magic (reads as uint32)
        expect(() => parseLotpack(buf, header)).toThrow(/mismatch/i);
    });
});

// ---------------------------------------------------------------------------
// Block data access via SquareLayerData
// ---------------------------------------------------------------------------

describe('parseLotpack — SquareLayerData.getSquare', () => {
    it('returns null for out-of-layer-range queries', () => {
        const header = getB42Header();
        const buf = makeB42LotpackBuffer(32 * 32);
        const data = parseLotpack(buf, header);
        const accessor = buildSquareAccessor(header, data);

        // layer 100 is out of range for B42 (max=8)
        expect(accessor.getSquare(0, 0, 100)).toBeNull();
        // layer -100 is out of range (min=-32)
        expect(accessor.getSquare(0, 0, -100)).toBeNull();
    });

    it('returns tiles at block 0, square (2,3), layer 0 in non-empty block', () => {
        const header = getB42Header();
        const buf = makeB42LotpackBuffer(32 * 32);
        const data = parseLotpack(buf, header);
        const accessor = buildSquareAccessor(header, data);

        // Block 0 fixture has tiles [0, 1] at x=2, y=3, layer=0 (layerIdx=32 for B42)
        const tiles = accessor.getSquare(2, 3, 0);
        expect(tiles).not.toBeNull();
        expect(tiles).toEqual([0, 1]);
    });

    it('returns null for empty squares', () => {
        const header = getB42Header();
        const buf = makeB42LotpackBuffer(32 * 32);
        const data = parseLotpack(buf, header);
        const accessor = buildSquareAccessor(header, data);

        // Square (0,0) at layer 0 should be empty
        expect(accessor.getSquare(0, 0, 0)).toBeNull();
        // Square (7,7) at layer -1 should be empty
        expect(accessor.getSquare(7, 7, -1)).toBeNull();
    });

    it('exposes header on accessor', () => {
        const header = getB42Header();
        const buf = makeB42LotpackBuffer(32 * 32);
        const data = parseLotpack(buf, header);
        const accessor = buildSquareAccessor(header, data);
        expect(accessor.header).toBe(header);
        expect(accessor.lotpack).toBe(data);
    });
});

// ---------------------------------------------------------------------------
// Block index mapping test
// ---------------------------------------------------------------------------

describe('parseLotpack — block index mapping', () => {
    it('maps (bx, by) to block index as bx * cellSizeInBlocks + by', () => {
        const header = getB42Header();
        const buf = makeB42LotpackBuffer(32 * 32);
        const data = parseLotpack(buf, header);

        // Block at bx=0, by=0 → index 0 → has data
        // Block at bx=0, by=1 → index 1 → empty
        // This verifies the index formula: bx * 32 + by
        const accessor = buildSquareAccessor(header, data);

        // subx=2, suby=3 → bx=floor(2/8)=0, x=2%8=2, by=floor(3/8)=0, y=3%8=3
        const tilesBx0By0 = accessor.getSquare(2, 3, 0);
        expect(tilesBx0By0).toEqual([0, 1]);

        // subx=10, suby=3 → bx=1, by=0 → index=32 → empty block
        const tilesBx1By0 = accessor.getSquare(10, 3, 0);
        expect(tilesBx1By0).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Tile name resolution via header
// ---------------------------------------------------------------------------

describe('parseLotpack — tile name resolution', () => {
    it('tile indices map to correct sprite names via header.spriteNames', () => {
        const header = getB42Header();
        const buf = makeB42LotpackBuffer(32 * 32);
        const data = parseLotpack(buf, header);
        const accessor = buildSquareAccessor(header, data);

        const tileIndices = accessor.getSquare(2, 3, 0);
        expect(tileIndices).not.toBeNull();

        // index 0 → 'tile_floors_01_0'
        // index 1 → 'tile_walls_exterior_house_01_0'
        const name0 = accessor.header.spriteNames[tileIndices![0]!];
        const name1 = accessor.header.spriteNames[tileIndices![1]!];
        expect(name0).toBe('tile_floors_01_0');
        expect(name1).toBe('tile_walls_exterior_house_01_0');
    });
});
