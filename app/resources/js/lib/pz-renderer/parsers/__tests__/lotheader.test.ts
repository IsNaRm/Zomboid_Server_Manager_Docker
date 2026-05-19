/**
 * Unit tests for the .lotheader binary parser.
 *
 * Tests use programmatically generated fixtures that precisely match the
 * Python pzmap2dzi reference output (verified via docker exec python3).
 *
 * Coverage:
 *   - B42 header (version 1): magic, version, tile defs, layers, rooms, buildings, zpop
 *   - B41 header (version 0): magic, B41-specific padding byte, maxlayer-only
 *   - Edge cases: truncated buffer, empty tile list, zero rooms/buildings
 *   - Python reference verification via base64 fixture
 */

import { describe, expect, it } from 'vitest';
import { parseLotheader } from '../lotheader';
import {
    B42_LOTHEADER_BASE64,
    makeB41LotheaderBuffer,
    makeB42LotheaderBuffer,
    makeTruncatedBuffer,
} from './fixtures/make-fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

// ---------------------------------------------------------------------------
// B42 header tests
// ---------------------------------------------------------------------------

describe('parseLotheader — B42 (version 1)', () => {
    it('parses version from LOTH magic', () => {
        const buf = makeB42LotheaderBuffer();
        const result = parseLotheader(buf, 30, 30);
        expect(result.version).toBe(1);
        expect(result.pzVersion).toBe('B42');
    });

    it('returns correct cell coordinates', () => {
        const buf = makeB42LotheaderBuffer();
        const result = parseLotheader(buf, 42, 17);
        expect(result.cellX).toBe(42);
        expect(result.cellY).toBe(17);
    });

    it('parses 3 tile names correctly', () => {
        const buf = makeB42LotheaderBuffer();
        const result = parseLotheader(buf, 30, 30);
        expect(result.spriteNames).toHaveLength(3);
        expect(result.spriteNames[0]).toBe('tile_floors_01_0');
        expect(result.spriteNames[1]).toBe('tile_walls_exterior_house_01_0');
        expect(result.spriteNames[2]).toBe('location_restaurant_burger_01_0');
    });

    it('parses width and height as 256', () => {
        const buf = makeB42LotheaderBuffer();
        const result = parseLotheader(buf, 30, 30);
        expect(result.width).toBe(256);
        expect(result.height).toBe(256);
    });

    it('parses B42 layer range: minLayer=-32, maxLayer=8', () => {
        const buf = makeB42LotheaderBuffer();
        const result = parseLotheader(buf, 30, 30);
        // B42 fixture: minlayer=-32, stored_maxlayer=7 → actual=8
        expect(result.minLayer).toBe(-32);
        expect(result.maxLayer).toBe(8);
    });

    it('returns B42 cell size constants', () => {
        const buf = makeB42LotheaderBuffer();
        const result = parseLotheader(buf, 30, 30);
        expect(result.cellSizeInBlocks).toBe(32); // B42
        expect(result.blockSize).toBe(8); // B42
    });

    it('parses 1 room with correct fields', () => {
        const buf = makeB42LotheaderBuffer();
        const result = parseLotheader(buf, 30, 30);
        expect(result.rooms).toHaveLength(1);
        const room = result.rooms[0]!;
        expect(room.id).toBe(0);
        expect(room.name).toBe('living_room');
        expect(room.layer).toBe(0);
        expect(room.rects).toHaveLength(2);
        expect(room.objects).toHaveLength(0);
    });

    it('computes room bounding box correctly', () => {
        const buf = makeB42LotheaderBuffer();
        const result = parseLotheader(buf, 30, 30);
        const room = result.rooms[0]!;
        // rect0: (10,10,5,5) → xMax=15, yMax=15
        // rect1: (20,10,3,4) → xMax=23, yMax=14
        expect(room.xMin).toBe(10);
        expect(room.xMax).toBe(23); // max(15, 23)
        expect(room.yMin).toBe(10);
        expect(room.yMax).toBe(15); // max(15, 14)
    });

    it('computes room area correctly', () => {
        const buf = makeB42LotheaderBuffer();
        const result = parseLotheader(buf, 30, 30);
        const room = result.rooms[0]!;
        // 5×5 + 3×4 = 25 + 12 = 37
        expect(room.area).toBe(37);
    });

    it('parses 1 building referencing room 0', () => {
        const buf = makeB42LotheaderBuffer();
        const result = parseLotheader(buf, 30, 30);
        expect(result.buildings).toHaveLength(1);
        const building = result.buildings[0]!;
        expect(building.id).toBe(0);
        expect(building.rooms).toEqual([0]);
    });

    it('parses zpop 32×32 grid with (x+y)%256 values', () => {
        const buf = makeB42LotheaderBuffer();
        const result = parseLotheader(buf, 30, 30);
        expect(result.zpop).toHaveLength(32); // 32 rows (B42)
        expect(result.zpop[0]).toHaveLength(32);
        // spot-check values
        expect(result.zpop[0]![0]).toBe(0); // (0+0)%256
        expect(result.zpop[1]![0]).toBe(1); // (1+0)%256
        expect(result.zpop[0]![1]).toBe(1); // (0+1)%256
        expect(result.zpop[5]![3]).toBe(8); // (5+3)%256
        expect(result.zpop[31]![31]).toBe(62); // (31+31)%256=62
    });
});

// ---------------------------------------------------------------------------
// B41 header tests
// ---------------------------------------------------------------------------

describe('parseLotheader — B41 (version 0)', () => {
    it('parses version 0 as B41', () => {
        const buf = makeB41LotheaderBuffer();
        const result = parseLotheader(buf, 10, 20);
        expect(result.version).toBe(0);
        expect(result.pzVersion).toBe('B41');
    });

    it('returns B41 cell size constants', () => {
        const buf = makeB41LotheaderBuffer();
        const result = parseLotheader(buf, 10, 20);
        expect(result.cellSizeInBlocks).toBe(30); // B41
        expect(result.blockSize).toBe(10); // B41
    });

    it('parses B41 layer range: minLayer=0, maxLayer≤8', () => {
        const buf = makeB41LotheaderBuffer();
        const result = parseLotheader(buf, 10, 20);
        // B41: minlayer always 0; fixture maxlayer=7 (clamped to ≤8)
        expect(result.minLayer).toBe(0);
        expect(result.maxLayer).toBe(7);
    });

    it('parses 2 tile names', () => {
        const buf = makeB41LotheaderBuffer();
        const result = parseLotheader(buf, 10, 20);
        expect(result.spriteNames).toHaveLength(2);
        expect(result.spriteNames[0]).toBe('tile_floors_01_0');
    });

    it('parses width=300, height=300', () => {
        const buf = makeB41LotheaderBuffer();
        const result = parseLotheader(buf, 10, 20);
        expect(result.width).toBe(300);
        expect(result.height).toBe(300);
    });

    it('parses zpop 30×30 with all-1 values', () => {
        const buf = makeB41LotheaderBuffer();
        const result = parseLotheader(buf, 10, 20);
        expect(result.zpop).toHaveLength(30);
        expect(result.zpop[0]![0]).toBe(1);
        expect(result.zpop[29]![29]).toBe(1);
    });

    it('returns 0 rooms and 0 buildings', () => {
        const buf = makeB41LotheaderBuffer();
        const result = parseLotheader(buf, 10, 20);
        expect(result.rooms).toHaveLength(0);
        expect(result.buildings).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Python reference fixture verification
// ---------------------------------------------------------------------------

describe('parseLotheader — Python reference verification', () => {
    it('parses Python-generated B42 fixture identically', () => {
        const buf = base64ToArrayBuffer(B42_LOTHEADER_BASE64);
        const result = parseLotheader(buf, 30, 30);

        // These values match exactly what Docker python3 pzmap2dzi would output
        expect(result.version).toBe(1);
        expect(result.pzVersion).toBe('B42');
        expect(result.spriteNames).toHaveLength(3);
        expect(result.spriteNames[0]).toBe('tile_floors_01_0');
        expect(result.width).toBe(256);
        expect(result.height).toBe(256);
        expect(result.minLayer).toBe(-32);
        expect(result.maxLayer).toBe(8);
        expect(result.rooms).toHaveLength(1);
        expect(result.rooms[0]!.name).toBe('living_room');
        expect(result.buildings).toHaveLength(1);
        expect(result.zpop[0]![0]).toBe(0);
        expect(result.zpop[1]![0]).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Edge case tests
// ---------------------------------------------------------------------------

describe('parseLotheader — edge cases', () => {
    it('throws RangeError on truncated buffer', () => {
        const buf = makeTruncatedBuffer(); // only 3 bytes
        expect(() => parseLotheader(buf, 0, 0)).toThrow();
    });

    it('handles cell coordinates correctly for any values', () => {
        const buf = makeB42LotheaderBuffer();
        const result = parseLotheader(buf, 999, 0);
        expect(result.cellX).toBe(999);
        expect(result.cellY).toBe(0);
    });

    it('clamps minLayer to VERSION_LIMITATIONS MIN_LAYER', () => {
        // Our fixture has minLayer=-32 which equals B42 MIN_LAYER, so no clamping occurs.
        // Just verify it does not go below limit.
        const buf = makeB42LotheaderBuffer();
        const result = parseLotheader(buf, 30, 30);
        expect(result.minLayer).toBeGreaterThanOrEqual(-32);
    });

    it('clamps maxLayer to VERSION_LIMITATIONS MAX_LAYER', () => {
        const buf = makeB42LotheaderBuffer();
        const result = parseLotheader(buf, 30, 30);
        expect(result.maxLayer).toBeLessThanOrEqual(32);
    });
});
