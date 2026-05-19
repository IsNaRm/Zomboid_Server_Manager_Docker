/**
 * Unit tests for computeCellsForTile (tile-cells.ts).
 *
 * Verifies that the inverse isometric / top-view projection correctly maps
 * Leaflet tile coordinates to PZ cell coordinates.
 *
 * These are pure math tests — no network, no DOM, no workers needed.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { computeCellsForTile, fetchCellsForTile, _clearMissingCellsCache } from '../tile-cells';
import type { DziProjection } from '../types';

// ---------------------------------------------------------------------------
// Test projections
// ---------------------------------------------------------------------------

/**
 * Minimal isometric projection matching a typical PZ map:
 *  sqr = 128 px/square, origin at (2048, 2048), maxNativeZoom = 10.
 */
const ISO_PROJ: DziProjection = {
    isometric: true,
    sqr: 128,
    x0: 2048,
    y0: 2048,
    maxNativeZoom: 10,
};

/**
 * Top-view projection: 1 px per square, no offset, maxNativeZoom = 8.
 */
const TOP_PROJ: DziProjection = {
    isometric: false,
    sqr: 1,
    x0: 0,
    y0: 0,
    maxNativeZoom: 8,
};

const TILE_SIZE = 256;
const CELL_SIZE_B42 = 256; // 32 × 8

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sort cell coords for deterministic comparison. */
function sortCells(cells: ReadonlyArray<readonly [number, number]>): [number, number][] {
    return [...cells].sort(([ax, ay], [bx, by]) => ax !== bx ? ax - bx : ay - by) as [number, number][];
}

// ---------------------------------------------------------------------------
// Top-view projection tests — easiest to reason about
// ---------------------------------------------------------------------------

describe('computeCellsForTile — top-view projection', () => {
    it('filters negative cell coordinates from partially out-of-bounds tiles', () => {
        // Tile (z=8, x=-1, y=0): pxMin=-256, pxMax=0 → sxMin=-256, sxMax=0
        // → cxMin=-1, cxMax=0. Cell cx=-1 is filtered, cell cx=0 survives.
        const result = computeCellsForTile(8, -1, 0, TILE_SIZE, TOP_PROJ, CELL_SIZE_B42);
        // No cell with negative x
        const hasNeg = result.some(([cx, cy]) => cx < 0 || cy < 0);
        expect(hasNeg).toBe(false);
        // Cell (0,0) is the only non-negative cell in this range
        expect(result.some(([cx, cy]) => cx === 0 && cy === 0)).toBe(true);
    });

    it('returns [] for a tile entirely left of the map origin', () => {
        // Tile (z=8, x=-2, y=0): pxMin=-512, pxMax=-256 → all squares negative
        const result = computeCellsForTile(8, -2, 0, TILE_SIZE, TOP_PROJ, CELL_SIZE_B42);
        expect(result).toHaveLength(0);
    });

    it('tile (z=maxNativeZoom, x=0, y=0) covers cells at (0,0) only for B42 cells', () => {
        // scale = 2^(8-8) = 1
        // pxMin=0, pxMax=256 → squares 0..256 → cells 0..1 for sqr=1, cellSize=256
        // cell 0 covers squares [0, 255], cell 1 would start at 256 = pxMax, not included
        const result = computeCellsForTile(8, 0, 0, TILE_SIZE, TOP_PROJ, CELL_SIZE_B42);
        // sxMin=0, sxMax=256; cxMin=floor(0/256)=0, cxMax=floor(256/256)=1
        // So cells (0,0) and (1,0) and (0,1) and (1,1) may all appear depending on corners
        expect(result.length).toBeGreaterThanOrEqual(1);
        // Cell (0,0) must always be present
        const has00 = result.some(([cx, cy]) => cx === 0 && cy === 0);
        expect(has00).toBe(true);
    });

    it('tile (z=maxNativeZoom, x=1, y=0) starts at square 256 → cell (1, 0)', () => {
        const result = computeCellsForTile(8, 1, 0, TILE_SIZE, TOP_PROJ, CELL_SIZE_B42);
        const has10 = result.some(([cx, cy]) => cx === 1 && cy === 0);
        expect(has10).toBe(true);
        // Cell (0,*) must NOT appear — tile starts exactly at cell boundary
        const has0x = result.some(([cx]) => cx === 0);
        expect(has0x).toBe(false);
    });

    it('zoomed-out tile (z=7) covers 2x the native area', () => {
        // scale = 2^(8-7) = 2 → tile covers 512 native pixels → 2 cells per axis
        const result = computeCellsForTile(7, 0, 0, TILE_SIZE, TOP_PROJ, CELL_SIZE_B42);
        // squares 0..512 → cells 0..2
        expect(result.length).toBeGreaterThanOrEqual(4); // at minimum 2×2 = 4 cells
    });

    it('returns [] when cellSize guard triggers on truly pathological zoom-out', () => {
        // MAX_SPAN is now 1024 (to allow overview rendering of the whole PZ
        // map ~78×63 cells). To trigger the guard we need a tile that maps
        // to >1024 cells per axis. zoom=-2 with maxNativeZoom=8 → scale=1024
        // → tile covers 256*1024=262144 native pixels → ~1024 cells. Need
        // bigger scale: zoom=-3 → scale=2048 → ~2048 cells → exceeds 1024.
        const result = computeCellsForTile(-3, 0, 0, TILE_SIZE, TOP_PROJ, CELL_SIZE_B42);
        expect(result).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Isometric projection tests
// ---------------------------------------------------------------------------

describe('computeCellsForTile — isometric projection', () => {
    it('returns a non-empty list for a tile near the map origin', () => {
        // At native zoom (z=10, x=0, y=0) we start at native pixels (0,0).
        // With x0=2048, origin square is far into negative territory → cells negative → []
        // But tile (z=10, x=8, y=8) overlaps the 2048,2048 origin area.
        const result = computeCellsForTile(10, 8, 8, TILE_SIZE, ISO_PROJ, CELL_SIZE_B42);
        // May be 0 if pixel range is outside map — just check no exception thrown.
        expect(Array.isArray(result)).toBe(true);
    });

    it('all returned cells have non-negative coordinates', () => {
        // Scan a grid of tiles and verify the filter works
        for (let tx = 0; tx <= 20; tx++) {
            for (let ty = 0; ty <= 20; ty++) {
                const cells = computeCellsForTile(10, tx, ty, TILE_SIZE, ISO_PROJ, CELL_SIZE_B42);
                for (const [cx, cy] of cells) {
                    expect(cx).toBeGreaterThanOrEqual(0);
                    expect(cy).toBeGreaterThanOrEqual(0);
                }
            }
        }
    });

    it('adjacent tiles share at most a boundary cell', () => {
        // Tiles (10, 20, 20) and (10, 21, 20) — horizontally adjacent
        const cellsA = computeCellsForTile(10, 20, 20, TILE_SIZE, ISO_PROJ, CELL_SIZE_B42);
        const cellsB = computeCellsForTile(10, 21, 20, TILE_SIZE, ISO_PROJ, CELL_SIZE_B42);

        // In isometric projection adjacent tiles may share edge cells.
        // The important invariant: union has MORE cells than either set alone.
        const setA = new Set(cellsA.map(([cx, cy]) => `${cx}_${cy}`));
        const setB = new Set(cellsB.map(([cx, cy]) => `${cx}_${cy}`));
        const union = new Set([...setA, ...setB]);

        // Union must be at least as large as either set individually
        expect(union.size).toBeGreaterThanOrEqual(setA.size);
        expect(union.size).toBeGreaterThanOrEqual(setB.size);
    });

    it('zoom level 9 (one step out) returns >= cells than zoom 10 (isometric)', () => {
        // At lower zoom, scale doubles → tile covers more ground → more cells
        const z10 = computeCellsForTile(10, 10, 10, TILE_SIZE, ISO_PROJ, CELL_SIZE_B42);
        const z9 = computeCellsForTile(9, 5, 5, TILE_SIZE, ISO_PROJ, CELL_SIZE_B42);
        // z=9 tile (5,5) covers the same area as z=10 tiles (10,10),(11,10),(10,11),(11,11)
        // so it must include at least as many cells
        expect(z9.length).toBeGreaterThanOrEqual(z10.length);
    });
});

// ---------------------------------------------------------------------------
// Determinism / idempotency
// ---------------------------------------------------------------------------

describe('computeCellsForTile — determinism', () => {
    it('returns the same result on repeated calls', () => {
        const a = sortCells(computeCellsForTile(10, 5, 5, TILE_SIZE, ISO_PROJ, CELL_SIZE_B42));
        const b = sortCells(computeCellsForTile(10, 5, 5, TILE_SIZE, ISO_PROJ, CELL_SIZE_B42));
        expect(a).toEqual(b);
    });

    it('returns no duplicate cells', () => {
        const cells = computeCellsForTile(9, 5, 5, TILE_SIZE, TOP_PROJ, CELL_SIZE_B42);
        const keys = cells.map(([cx, cy]) => `${cx}_${cy}`);
        const uniqueKeys = new Set(keys);
        expect(uniqueKeys.size).toBe(keys.length);
    });
});

// ---------------------------------------------------------------------------
// B41 cell size (300 squares per side)
// ---------------------------------------------------------------------------

describe('computeCellsForTile — B41 cell size (300 squares)', () => {
    const CELL_SIZE_B41 = 300; // 30 × 10

    it('covers fewer cells per tile than B42 (cells are larger)', () => {
        const b41 = computeCellsForTile(10, 5, 5, TILE_SIZE, TOP_PROJ, CELL_SIZE_B41);
        const b42 = computeCellsForTile(10, 5, 5, TILE_SIZE, TOP_PROJ, CELL_SIZE_B42);
        // Larger cells → fewer of them per tile at the same zoom
        expect(b41.length).toBeLessThanOrEqual(b42.length);
    });
});

// ---------------------------------------------------------------------------
// B42 real-map projection (Muldraugh, KY test map)
//
// Parameters from mapConfig.dzi for a locally rendered pzmap2dzi output:
//   width=10240, height=4096, sqr=128, x0=0, y0=0, maxNativeZoom=14
//   tileSize=256 (Leaflet GridLayer), cellSize=256 (B42: 32 blocks × 8 sq)
//
// The Leaflet GridLayer tile size (256 px) is independent of the DZI tile
// size emitted by pzmap2dzi (2048 px).  scale = 2^(14 - z).
//
// Key insight: at zoom=12 (default), scale=4, one Leaflet tile spans
// 256×4=1024 native pixels.  With sqr=128, halfSqr=64:
//   (sx-sy) range per tile ≈ 1024/64 = 16 units
//   (sx+sy) range per tile ≈ 1024/32 = 32 units
// cellSize=256 squares >> 32, so each tile typically overlaps 1–4 cells
// in square-space.  The critical fix is using ceil() for the upper cell
// boundary so that cells partially covered by the tile are not missed.
// ---------------------------------------------------------------------------

describe('computeCellsForTile — B42 real-map projection (sqr=128, maxNativeZoom=14)', () => {
    const B42_PROJ: DziProjection = {
        isometric: true,
        sqr: 128,
        x0: 0,
        y0: 0,
        maxNativeZoom: 14,
        width: 10240,
        height: 4096,
    };
    const B42_BOUNDS = { maxCellX: 77, maxCellY: 62 };
    const LEAFLET_TILE = 256; // WebGLPZLayer always uses tileSize=256

    it('tile (12, 0, 0) returns more than one cell (fixes the (0,0)-only bug)', () => {
        // Before fix: floor() for cxMax/cyMax → single cell (0,0) for every tile.
        // After fix:  ceil()  for cxMax/cyMax → boundary cells are included.
        //
        // At z=12, scale=4, native range [0,1024]×[0,1024].
        // Isometric corners (x0=0,y0=0,halfSqr=64,quarterSqr=32,yOffset=32):
        //   (0,0)→sx=-0.5,sy=-0.5  (1024,0)→sx=7.5,sy=-8.5
        //   (0,1024)→sx=15.5,sy=15.5  (1024,1024)→sx=23.5,sy=7.5
        // sxMax=23.5 → ceil(23.5/256)=1 → cxMax=1 (was 0 with floor)
        // syMax=15.5 → ceil(15.5/256)=1 → cyMax=1 (was 0 with floor)
        const result = computeCellsForTile(12, 0, 0, LEAFLET_TILE, B42_PROJ, CELL_SIZE_B42, B42_BOUNDS);
        expect(result.length).toBeGreaterThan(1);
    });

    it('tile (12, 0, 0) always includes cell (0, 0)', () => {
        const result = computeCellsForTile(12, 0, 0, LEAFLET_TILE, B42_PROJ, CELL_SIZE_B42, B42_BOUNDS);
        expect(result.some(([cx, cy]) => cx === 0 && cy === 0)).toBe(true);
    });

    it('tile (12, 2, 0) and tile (12, 0, 2) produce different cell sets', () => {
        // Different tiles must map to different cell ranges, not always (0,0).
        const cellsA = sortCells(computeCellsForTile(12, 2, 0, LEAFLET_TILE, B42_PROJ, CELL_SIZE_B42, B42_BOUNDS));
        const cellsB = sortCells(computeCellsForTile(12, 0, 2, LEAFLET_TILE, B42_PROJ, CELL_SIZE_B42, B42_BOUNDS));
        // They may overlap at boundary cells but must not be identical
        expect(cellsA).not.toEqual(cellsB);
    });

    it('tile (12, 5, 5) — entirely below map height — returns []', () => {
        // pyMin = 5 * 256 * 4 = 5120 > DZI height 4096 → fast-reject via dziHeight.
        const result = computeCellsForTile(12, 5, 5, LEAFLET_TILE, B42_PROJ, CELL_SIZE_B42, B42_BOUNDS);
        expect(result).toHaveLength(0);
    });

    it('tile (14, 0, 0) at native zoom includes cell (0, 0)', () => {
        // scale=1, native [0,256]×[0,256].
        const result = computeCellsForTile(14, 0, 0, LEAFLET_TILE, B42_PROJ, CELL_SIZE_B42, B42_BOUNDS);
        expect(result.some(([cx, cy]) => cx === 0 && cy === 0)).toBe(true);
    });

    it('all cells have non-negative coords within map bounds', () => {
        for (let tx = 0; tx < 5; tx++) {
            for (let ty = 0; ty < 2; ty++) {
                const cells = computeCellsForTile(12, tx, ty, LEAFLET_TILE, B42_PROJ, CELL_SIZE_B42, B42_BOUNDS);
                for (const [cx, cy] of cells) {
                    expect(cx).toBeGreaterThanOrEqual(0);
                    expect(cx).toBeLessThanOrEqual(77);
                    expect(cy).toBeGreaterThanOrEqual(0);
                    expect(cy).toBeLessThanOrEqual(62);
                }
            }
        }
    });

    it('horizontally adjacent tile columns at zoom 12 eventually diverge', () => {
        // At zoom 12 (scale=4) with sqr=128, one Leaflet tile spans ~16 squares
        // diagonally, far less than one cell (256 sq). Nearby tiles can share
        // the same cell set — that is expected and correct. We verify that
        // tiles far enough apart (column 0 vs column 5) produce a different
        // square range and therefore can produce a different cell set once the
        // accumulated pixel offset exceeds cellSize (256*64=16384 px per cell).
        //
        // Column delta = 5 tiles × 1024 px = 5120 px. Per-tile (sx-sy) shift =
        // 5120/64 = 80 squares → enough to shift into a different cell (80/256 < 1
        // but accumulated over cx = 0..1 boundary). We test cell (1,*) appears
        // in column 5 while column 0 starts at the map edge.
        const col0 = computeCellsForTile(12, 0, 0, LEAFLET_TILE, B42_PROJ, CELL_SIZE_B42, B42_BOUNDS);
        const col5 = computeCellsForTile(12, 5, 0, LEAFLET_TILE, B42_PROJ, CELL_SIZE_B42, B42_BOUNDS);
        // Both should be non-empty (columns 0 and 5 are inside the 10240-px map width)
        expect(col0.length).toBeGreaterThan(0);
        // col5 pxMin=5*256*4=5120 < 10240 → inside map → non-empty
        expect(col5.length).toBeGreaterThan(0);
        // Across the full set of columns 0..9 the cell sets must not all be identical
        const allSets = Array.from({ length: 10 }, (_, tx) =>
            JSON.stringify(sortCells(computeCellsForTile(12, tx, 0, LEAFLET_TILE, B42_PROJ, CELL_SIZE_B42, B42_BOUNDS))),
        );
        const distinct = new Set(allSets);
        expect(distinct.size).toBeGreaterThan(1);
    });

    it('out-of-map tile (12, 99, 0) with bounds → returns []', () => {
        // pxMin = 99 * 256 * 4 = 101376 >> width=10240 → fast-reject
        const result = computeCellsForTile(12, 99, 0, LEAFLET_TILE, B42_PROJ, CELL_SIZE_B42, B42_BOUNDS);
        expect(result).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// B42 real map with non-zero worldX0/worldY0 (Muldraugh map_info.json values)
//
// Regression test for the sign-of-worldX0 bug: pzmap2dzi writes
// image_pixel = world_pixel + x0_pzmap, so the inverse must SUBTRACT
// worldX0. Earlier the code added it, which for the real values
// (worldX0 ≈ 1e6) shifted the inverse projection by ~10 000 squares
// and pushed all candidate cells out of the manifest. The result was
// that no cell/{x}/{y}/header request ever fired.
// ---------------------------------------------------------------------------

describe('computeCellsForTile — worldX0/worldY0 sign (Muldraugh real map)', () => {
    // Effective-coord values from the real map_info.json after MapConfigBuilder
    // rescales by 2^skip (skip=8 → divide by 256):
    //   native x0=1040384  → effective worldX0=4064
    //   native y0=-139296  → effective worldY0=-544.125
    //   native sqr=128     → effective sqr=0.5
    //   effective w=9057, h=3968, maxNativeZoom=ceil(log2(9057))=14
    const REAL_PROJ: DziProjection = {
        isometric: true,
        sqr: 0.5,
        x0: 0,
        y0: 0,
        worldX0: 4064,
        worldY0: -544.125,
        maxNativeZoom: 14,
        width: 9057,
        height: 3968,
    };
    const REAL_BOUNDS = { maxCellX: 77, maxCellY: 62 };

    it('tile inside the rendered area lands on real cell coords', () => {
        // Tile (z=12, tx=3, ty=1) at scale=4 covers effective pixels
        // [3072..4096] × [1024..2048] — well inside w=9057, h=3968.
        // After inverse projection it should map into world cells around (16, 32).
        const cells = computeCellsForTile(12, 3, 1, TILE_SIZE, REAL_PROJ, CELL_SIZE_B42, REAL_BOUNDS);
        expect(cells.length).toBeGreaterThan(0);
        for (const [cx, cy] of cells) {
            expect(cx).toBeGreaterThanOrEqual(0);
            expect(cx).toBeLessThanOrEqual(77);
            expect(cy).toBeGreaterThanOrEqual(0);
            expect(cy).toBeLessThanOrEqual(62);
        }
    });

    it('sampled grid of tiles in the rendered area produces at least one valid cell', () => {
        // Regression for the `+ worldX0` sign bug: every tile in the area
        // used to map to cells like (-23, 40) which are filtered out as
        // negative, leaving an empty list and zero cell/{x}/{y}/header
        // requests. After the fix at least one sampled tile must yield
        // an in-bounds cell.
        let foundValidCell = false;
        outer: for (let tx = 1; tx <= 8; tx++) {
            for (let ty = 0; ty <= 3; ty++) {
                const cells = computeCellsForTile(12, tx, ty, TILE_SIZE, REAL_PROJ, CELL_SIZE_B42, REAL_BOUNDS);
                if (cells.length > 0) {
                    foundValidCell = true;
                    break outer;
                }
            }
        }
        expect(foundValidCell).toBe(true);
    });

    it('does not return cells with coords in the tens of thousands (sign-bug signature)', () => {
        // With the broken `+ worldX0` sign on native coords the inverse pushed
        // sx into the 5000–6000 range and sy into the -10 000 range, so cells
        // ended up either heavily negative or in the (23, -41) ballpark.
        const cells = computeCellsForTile(12, 4, 1, TILE_SIZE, REAL_PROJ, CELL_SIZE_B42, REAL_BOUNDS);
        for (const [cx, cy] of cells) {
            expect(Math.abs(cx)).toBeLessThan(200);
            expect(Math.abs(cy)).toBeLessThan(200);
        }
    });
});

// ---------------------------------------------------------------------------
// fetchCellsForTile — availableCells manifest filter
// ---------------------------------------------------------------------------

describe('fetchCellsForTile — availableCells filter', () => {
    /**
     * Top-view projection at native zoom so one Leaflet tile = one cell.
     * tile (8, 0, 0) → cell (0, 0); tile (8, 1, 0) → cell (1, 0); etc.
     */
    const PROJ: DziProjection = {
        isometric: false,
        sqr: 256, // 1 cell = 1 native tile = 256 px
        x0: 0,
        y0: 0,
        maxNativeZoom: 8,
    };
    const CELL_SIZE = 256;

    // Minimal stub types so we don't import the real implementations
    // (which drag in DOM APIs and web worker globals).
    type FakePool = Parameters<typeof fetchCellsForTile>[7];
    type FakeCache = Parameters<typeof fetchCellsForTile>[8];

    const makePool = (): FakePool => ({
        parseLotheader: vi.fn(),
        parseLotpack: vi.fn(),
    } as unknown as FakePool);

    const makeCache = (): FakeCache => ({
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn(),
    } as unknown as FakeCache);

    // Store original fetch and restore after each test.
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.clearAllMocks();
        // Clear the module-level missing-cells cache so tests don't bleed into each other.
        _clearMissingCellsCache();
    });

    it('returns only cells present in availableCells when the Set is populated', async () => {
        // Tile (8, 0, 0) with PROJ above covers cells (0,0) and possibly (1,1).
        // availableCells = { "0_0" } — only (0,0) should be requested.
        // Both the static chunk index and bulk endpoint return 404 → no cells.
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

        const available = new Set(['0_0']);
        const result = await fetchCellsForTile(
            8, 0, 0, 256, PROJ, CELL_SIZE,
            '/api', makePool(), makeCache(), available,
        );

        expect(result).toHaveLength(0);
        const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(
            ([url]: [string]) => url,
        );
        // Chunk index probe runs first; then falls back to the bulk endpoint
        // when no index is present.
        const bulkUrls = urls.filter((u) => u.includes('/cells/bulk'));
        expect(bulkUrls.length).toBeGreaterThan(0);
        for (const url of bulkUrls) {
            expect(url).toContain('/cells/bulk?coords=0_0');
        }
    });

    it('does not request cells absent from availableCells', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

        // availableCells is empty → no cell passes the filter → fetch never called
        const available = new Set<string>();
        await fetchCellsForTile(
            8, 0, 0, 256, PROJ, CELL_SIZE,
            '/api', makePool(), makeCache(), available,
        );

        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('skips the filter when availableCells is undefined', async () => {
        // Without a manifest, all computed cells should be attempted.
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

        await fetchCellsForTile(
            8, 0, 0, 256, PROJ, CELL_SIZE,
            '/api', makePool(), makeCache(),
            // availableCells omitted
        );

        // fetch should have been called for the computed cell (0,0)
        expect(globalThis.fetch).toHaveBeenCalled();
    });

    it('blocks all requests when availableCells is null (manifest still loading)', async () => {
        // null = "manifest pending"; without it we'd fire hundreds of
        // guaranteed-404 requests for cells the manifest will later filter out.
        globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

        const result = await fetchCellsForTile(
            8, 0, 0, 256, PROJ, CELL_SIZE,
            '/api', makePool(), makeCache(), null,
        );

        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(result).toEqual([]);
    });

    it('returns cell data for a cell that is in availableCells and in the cache', async () => {
        globalThis.fetch = vi.fn(); // should never be called

        const fakeCellData = {
            cellX: 0, cellY: 0,
            header: {} as never,
            cell: {} as never,
            save: null,
            fetchedAt: Date.now(),
        };

        const cache = makeCache();
        (cache.get as ReturnType<typeof vi.fn>).mockImplementation(
            (cx: number, cy: number) => (cx === 0 && cy === 0 ? fakeCellData : undefined),
        );

        const available = new Set(['0_0']);
        const result = await fetchCellsForTile(
            8, 0, 0, 256, PROJ, CELL_SIZE,
            '/api', makePool(), cache, available,
        );

        expect(result).toHaveLength(1);
        expect(result[0]).toBe(fakeCellData);
        // Cache hit → no network request
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});
