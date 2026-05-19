/**
 * Shared TypeScript types for the PZ WebGL renderer.
 * Used across parsers, atlas loader, cache, and Web Worker.
 */

// ---------------------------------------------------------------------------
// Sprite / atlas types
// ---------------------------------------------------------------------------

/** UV rectangle within a single atlas page. All values in pixels (not 0-1). */
export interface MipLevel {
    /** Left edge in atlas pixels. */
    u: number;
    /** Top edge in atlas pixels. */
    v: number;
    /** Width in atlas pixels. */
    w: number;
    /** Height in atlas pixels. */
    h: number;
}

/** Full sprite descriptor as stored in sprites.json and the in-memory index. */
export interface SpriteEntry {
    /** Index of the atlas page (0-based). */
    atlas: number;
    /** Mip chain: mips[0] = native size, mips[N] = 1×1. */
    mips: MipLevel[];
    /** Horizontal rendering offset (px). May be negative. */
    offset_x: number;
    /** Vertical rendering offset (px). May be negative. */
    offset_y: number;
}

/** Fast name → entry lookup built from sprites.json. */
export type SpriteIndex = Map<string, SpriteEntry>;

/** Single atlas page descriptor as returned by the server. */
export interface AtlasPageInfo {
    id: number;
    file: string;
    width: number;
    height: number;
    size_bytes: number;
}

/** Parsed sprites.json manifest. */
export interface SpritesManifest {
    version: string;
    atlas_size: number;
    atlases: AtlasPageInfo[];
    /** Raw sprite map from JSON — values have mips as number[][] not MipLevel[]. */
    sprites: Record<
        string,
        {
            atlas: number;
            mips: [number, number, number, number][];
            offset_x: number;
            offset_y: number;
        }
    >;
}

/** Fully loaded atlas ready for WebGL upload. */
export interface LoadedAtlas {
    /** One ImageBitmap per atlas page (GPU-uploadable). */
    pages: ImageBitmap[];
    /** Sprite name → entry for fast lookups. */
    sprites: SpriteIndex;
    /** Server-reported version string. */
    version: string;
}

// ---------------------------------------------------------------------------
// PZ version constants
// ---------------------------------------------------------------------------

export const VERSION_LIMITATIONS = {
    0: {
        PZ_VERSION: 'B41' as const,
        CELL_SIZE_IN_BLOCKS: 30,
        BLOCK_SIZE_IN_SQUARES: 10,
        MIN_LAYER: 0,
        MAX_LAYER: 8,
    },
    1: {
        PZ_VERSION: 'B42' as const,
        CELL_SIZE_IN_BLOCKS: 32,
        BLOCK_SIZE_IN_SQUARES: 8,
        MIN_LAYER: -32,
        MAX_LAYER: 32,
    },
} as const;

export type HeaderVersion = keyof typeof VERSION_LIMITATIONS;

// ---------------------------------------------------------------------------
// Lotheader types
// ---------------------------------------------------------------------------

/** Parsed content of a .lotheader file. */
export interface CellMetadata {
    /** Raw lotheader version (0 = B41, 1 = B42). */
    version: HeaderVersion;
    /** PZ game version string ("B41" | "B42"). */
    pzVersion: string;
    /** Cell X coordinate (from filename). */
    cellX: number;
    /** Cell Y coordinate (from filename). */
    cellY: number;
    /** Sprite name list (tile definitions). Index used in lotpack. */
    spriteNames: string[];
    /** Cell width in squares. */
    width: number;
    /** Cell height in squares. */
    height: number;
    /** Minimum layer index (inclusive). */
    minLayer: number;
    /** Maximum layer index (exclusive). */
    maxLayer: number;
    /** Blocks per cell dimension (CELL_SIZE_IN_BLOCKS). */
    cellSizeInBlocks: number;
    /** Squares per block dimension (BLOCK_SIZE_IN_SQUARES). */
    blockSize: number;
    /** Room descriptors (used for map overlays). */
    rooms: RoomDescriptor[];
    /** Building descriptors. */
    buildings: BuildingDescriptor[];
    /** Zombie population grid [blockX][blockY] uint8. */
    zpop: number[][];
}

export interface RoomRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface RoomObject {
    metaType: number;
    x: number;
    y: number;
}

export interface RoomDescriptor {
    id: number;
    name: string;
    layer: number;
    rects: RoomRect[];
    objects: RoomObject[];
    area: number;
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
}

export interface BuildingDescriptor {
    id: number;
    /** Room IDs belonging to this building. */
    rooms: number[];
}

// ---------------------------------------------------------------------------
// Lotpack types
// ---------------------------------------------------------------------------

/**
 * Sparse 4-D structure: [layer_index][blockX][blockY] → sprite index list.
 * Null means "no data" (identical to Python None).
 *
 * layer_index is offset by -minLayer so it always starts at 0.
 */
export type BlockLayer = Array<Array<Array<number[] | null> | null> | null>;

/** Parsed .lotpack for a single cell. */
export interface LotpackData {
    /** Header version (must match lotheader). */
    version: number;
    /**
     * blocks[bx * cellSizeInBlocks + by] → BlockLayer.
     * Total count = cellSizeInBlocks * cellSizeInBlocks.
     */
    blocks: Array<BlockLayer>;
}

/**
 * Per-square data for a single cell.
 * Convenience accessor built on top of LotpackData.
 */
export interface SquareLayerData {
    /** Sprite index list for square (subx, suby) on `layer`. Returns null if empty. */
    getSquare(subx: number, suby: number, layer: number): number[] | null;
    /** Associated header for tile name resolution. */
    header: CellMetadata;
    /** Raw lotpack data. */
    lotpack: LotpackData;
}

// ---------------------------------------------------------------------------
// Save-game types
// ---------------------------------------------------------------------------

/** Sprite reference in a save-game chunk. Uses numeric IDs from WorldDictionary. */
export interface SavedSquare {
    x: number;
    y: number;
    layer: number;
    /** Numeric sprite IDs (mapped to names via WorldDictionary). */
    spriteIds: number[];
}

/** Parsed save-game cell binary. */
export interface SaveGameData {
    /** PZ version: 41 or 42. */
    saveVersion: number;
    /** Block size (10 for B41, 8 for B42). */
    blockSize: number;
    /** Modified squares in this cell. */
    squares: SavedSquare[];
}

// ---------------------------------------------------------------------------
// Cell cache types
// ---------------------------------------------------------------------------

/** Complete parsed data for one map cell. */
export interface CellData {
    /** Cell coordinates. */
    cellX: number;
    cellY: number;
    /** Parsed header. */
    header: CellMetadata;
    /** Parsed lotpack accessor. */
    cell: SquareLayerData;
    /** Optional save-game overlay (null if not loaded / not available). */
    save: SaveGameData | null;
    /** Timestamp when this entry was fetched (ms since epoch). */
    fetchedAt: number;
    /**
     * Lazy per-layer instance buffer cache. Built on first render and reused
     * by every subsequent tile that overlaps this cell. Key = PZ layer index;
     * value = packed Float32Array (instance stride = INSTANCE_STRIDE_F32).
     * Built lazily so cells that are never rendered don't pay the cost.
     */
    instanceCache?: Map<number, Float32Array>;
}

// ---------------------------------------------------------------------------
// Worker message types
// ---------------------------------------------------------------------------

export type WorkerCommand = 'parseLotheader' | 'parseLotpack' | 'parseSavegame';

export interface WorkerRequest {
    id: number;
    command: WorkerCommand;
    x: number;
    y: number;
    buffer: ArrayBuffer;
    /** For parseLotpack: the already-parsed header is required. */
    header?: CellMetadata;
}

export interface WorkerResponse {
    id: number;
    command: WorkerCommand;
    ok: true;
    result: CellMetadata | LotpackData | SaveGameData;
}

export interface WorkerErrorResponse {
    id: number;
    command: WorkerCommand;
    ok: false;
    error: string;
}

export type WorkerMessage = WorkerResponse | WorkerErrorResponse;

// ---------------------------------------------------------------------------
// Renderer projection types (M4 — WebGL renderer)
// ---------------------------------------------------------------------------

/**
 * DZI projection parameters from pz-map.tsx DziInfo.
 * Used by tile-renderer.ts and webgl-leaflet-layer.ts to map PZ world
 * coordinates into the isometric canvas space.
 */
export interface DziProjection {
    /** Whether to use isometric (true) or top-view (false) projection. */
    isometric: boolean;
    /** Pixels-per-square-edge at native zoom (128 for isometric PZ). */
    sqr: number;
    /** World pixel X origin (x0 from DZI manifest). */
    x0: number;
    /** World pixel Y origin (y0 from DZI manifest). */
    y0: number;
    /**
     * Real PZ-world pixel offset from map_info.json. When provided, this is
     * used instead of x0/y0 for cell coordinate computation. Required because
     * Leaflet's tile URLs use a 0-anchored image space (x0=y0=0), but cells
     * live in the actual PZ world coordinate space and need the real offset.
     */
    worldX0?: number;
    worldY0?: number;
    /** Maximum native zoom level from the DZI manifest. */
    maxNativeZoom: number;
    /**
     * Conversion factor from pzmap2dzi NATIVE pixels (sprite atlas, offsets,
     * sqr_height/2 anchor shift) to the EFFECTIVE pixel-space the Leaflet
     * tiles use. = 1 / 2^skip. Typical value: 1/256 ≈ 0.00390625.
     */
    nativeToEffective?: number;
    /**
     * Total width of the DZI image in native pixels.
     * When provided, tiles whose native pixel X range lies entirely outside
     * [0, width] are rejected early (return []) without an inverse projection.
     */
    width?: number;
    /**
     * Total height of the DZI image in native pixels.
     * When provided, tiles whose native pixel Y range lies entirely outside
     * [0, height] are rejected early.
     */
    height?: number;
}
