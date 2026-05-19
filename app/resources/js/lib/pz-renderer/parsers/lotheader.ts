/**
 * Parser for PZ .lotheader binary files.
 *
 * Port of:
 *   pzmap2dzi/lotheader.py  (load_lotheader, read_zpop)
 *   pzmap2dzi/binfile.py    (get_version, read_tile_defs, read_rooms, read_buildings)
 *   pzmap2dzi/util.py       (read_uint8, read_uint32, read_int32, read_line)
 *
 * Format overview (lotheader.py::load_lotheader):
 *   MAGIC:    "LOTH" (4 bytes) — if present, version follows; absent → B41 default
 *   version:  uint32 LE  (0 = B41, 1 = B42)
 *   tile defs: uint32 count + count newline-terminated UTF-8 strings
 *   [B41 only] 0x00 padding byte
 *   width:    uint32 LE
 *   height:   uint32 LE
 *   [B41]  maxlayer: int32
 *   [B42]  minlayer: int32, maxlayer: int32  (maxlayer stored as last_layer; actual = stored + 1)
 *   rooms:    see read_rooms
 *   buildings: see read_buildings
 *   zpop:     cellSizeInBlocks × cellSizeInBlocks uint8 grid
 */

import {
    type Cursor,
    checkMagic,
    readInt32,
    readLine,
    readUint8,
    readUint32,
} from './binary-reader';
import {
    type BuildingDescriptor,
    type CellMetadata,
    type HeaderVersion,
    type RoomDescriptor,
    type RoomObject,
    type RoomRect,
    VERSION_LIMITATIONS,
} from '../types';

// Magic bytes: "LOTH"
const MAGIC_LOTH = new Uint8Array([0x4c, 0x4f, 0x54, 0x48]);

// ---------------------------------------------------------------------------
// Internal helpers (mirror of binfile.py)
// ---------------------------------------------------------------------------

/**
 * Read tile definitions list.
 * binfile.py::read_tile_defs
 *
 * Format: uint32 count + count × newline-terminated UTF-8 strings.
 */
function readTileDefs(view: DataView, cursor: Cursor): string[] {
    const count = readUint32(view, cursor);
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
        const name = readLine(view, cursor);
        names.push(name.trim());
    }
    return names;
}

/**
 * Read room rectangle list.
 */
function readRects(view: DataView, cursor: Cursor, count: number): RoomRect[] {
    const rects: RoomRect[] = [];
    for (let i = 0; i < count; i++) {
        const x = readInt32(view, cursor);
        const y = readInt32(view, cursor);
        const w = readInt32(view, cursor);
        const h = readInt32(view, cursor);
        rects.push({ x, y, w, h });
    }
    return rects;
}

/**
 * Read room meta objects list.
 */
function readRoomObjects(view: DataView, cursor: Cursor, count: number): RoomObject[] {
    const objects: RoomObject[] = [];
    for (let i = 0; i < count; i++) {
        const metaType = readInt32(view, cursor);
        const x = readInt32(view, cursor);
        const y = readInt32(view, cursor);
        objects.push({ metaType, x, y });
    }
    return objects;
}

/**
 * Compute bounding box of a room from its rects.
 * binfile.py::calc_room_bound
 */
function calcRoomBound(rects: RoomRect[]): {
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
} {
    let xMin = Infinity,
        xMax = -Infinity,
        yMin = Infinity,
        yMax = -Infinity;
    for (const { x, y, w, h } of rects) {
        if (x < xMin) xMin = x;
        if (x + w > xMax) xMax = x + w;
        if (y < yMin) yMin = y;
        if (y + h > yMax) yMax = y + h;
    }
    return { xMin, xMax, yMin, yMax };
}

/**
 * Read a single room descriptor.
 * binfile.py::read_room
 *
 * Format:
 *   name: newline-terminated string
 *   layer: int32
 *   rect_num: uint32
 *   rects: rect_num × (x, y, w, h) int32 each
 *   meta_num: uint32
 *   metas: meta_num × (type, x, y) int32 each
 */
function readRoom(view: DataView, cursor: Cursor, id: number): RoomDescriptor {
    const name = readLine(view, cursor);
    const layer = readInt32(view, cursor);
    const rectCount = readUint32(view, cursor);
    const rects = readRects(view, cursor, rectCount);

    let area = 0;
    for (const { w, h } of rects) {
        area += w * h;
    }

    const { xMin, xMax, yMin, yMax } = calcRoomBound(rects);

    const metaCount = readUint32(view, cursor);
    const objects = readRoomObjects(view, cursor, metaCount);

    return { id, name, layer, rects, objects, area, xMin, xMax, yMin, yMax };
}

/**
 * Read all rooms.
 * binfile.py::read_rooms
 */
function readRooms(view: DataView, cursor: Cursor): RoomDescriptor[] {
    const count = readUint32(view, cursor);
    const rooms: RoomDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        rooms.push(readRoom(view, cursor, i));
    }
    return rooms;
}

/**
 * Read a single building descriptor.
 * binfile.py::read_building
 */
function readBuilding(view: DataView, cursor: Cursor, id: number): BuildingDescriptor {
    const roomCount = readUint32(view, cursor);
    const rooms: number[] = [];
    for (let i = 0; i < roomCount; i++) {
        rooms.push(readUint32(view, cursor));
    }
    return { id, rooms };
}

/**
 * Read all buildings.
 * binfile.py::read_buildings
 */
function readBuildings(view: DataView, cursor: Cursor): BuildingDescriptor[] {
    const count = readUint32(view, cursor);
    const buildings: BuildingDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        buildings.push(readBuilding(view, cursor, i));
    }
    return buildings;
}

/**
 * Read the zombie population grid.
 * lotheader.py::read_zpop
 *
 * Grid is cellSizeInBlocks × cellSizeInBlocks, each cell a uint8.
 * Returns zpop[x][y].
 */
function readZpop(view: DataView, cursor: Cursor, cellSizeInBlocks: number): number[][] {
    const zpop: number[][] = [];
    for (let x = 0; x < cellSizeInBlocks; x++) {
        const row: number[] = [];
        for (let y = 0; y < cellSizeInBlocks; y++) {
            row.push(readUint8(view, cursor));
        }
        zpop.push(row);
    }
    return zpop;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a .lotheader binary buffer into a CellMetadata object.
 *
 * @param buffer   Raw bytes from the server endpoint (ArrayBuffer).
 * @param cellX    Cell X coordinate (from filename / URL).
 * @param cellY    Cell Y coordinate.
 * @returns        Parsed CellMetadata.
 * @throws         Error if magic bytes are missing or data is truncated.
 */
export function parseLotheader(buffer: ArrayBuffer, cellX: number, cellY: number): CellMetadata {
    const view = new DataView(buffer);
    const cursor: Cursor = { pos: 0 };

    // --- Magic + version (binfile.py::get_version) ---
    let version: HeaderVersion;
    if (checkMagic(view, cursor, MAGIC_LOTH)) {
        // Magic matched — version follows as uint32
        const raw = readUint32(view, cursor);
        if (raw !== 0 && raw !== 1) {
            throw new Error(`[lotheader] Unknown version: ${raw}`);
        }
        version = raw as HeaderVersion;
    } else {
        // No magic — treat as B41 version 0, cursor stays at 0
        version = 0;
    }

    const limits = VERSION_LIMITATIONS[version];

    // --- Tile definitions (binfile.py::read_tile_defs) ---
    const spriteNames = readTileDefs(view, cursor);

    // --- B41 has a 0x00 padding byte after tile defs ---
    if (version === 0) {
        cursor.pos += 1; // skip 0x00
    }

    // --- Width / height ---
    const width = readUint32(view, cursor);
    const height = readUint32(view, cursor);

    // --- Layer range ---
    let minLayer: number;
    let maxLayer: number;

    if (version === 0) {
        // B41: only maxlayer stored; minlayer = 0
        minLayer = 0;
        maxLayer = readInt32(view, cursor);
    } else {
        // B42: both stored; maxlayer in file = last layer index, actual exclusive = stored + 1
        minLayer = readInt32(view, cursor);
        maxLayer = readInt32(view, cursor) + 1;
    }

    // Clamp to version limits
    minLayer = Math.max(minLayer, limits.MIN_LAYER);
    maxLayer = Math.min(maxLayer, limits.MAX_LAYER);

    // --- Rooms + buildings ---
    const rooms = readRooms(view, cursor);
    const buildings = readBuildings(view, cursor);

    // --- Zombie population grid ---
    const zpop = readZpop(view, cursor, limits.CELL_SIZE_IN_BLOCKS);

    return {
        version,
        pzVersion: limits.PZ_VERSION,
        cellX,
        cellY,
        spriteNames,
        width,
        height,
        minLayer,
        maxLayer,
        cellSizeInBlocks: limits.CELL_SIZE_IN_BLOCKS,
        blockSize: limits.BLOCK_SIZE_IN_SQUARES,
        rooms,
        buildings,
        zpop,
    };
}
