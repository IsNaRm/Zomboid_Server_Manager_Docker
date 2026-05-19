/**
 * Tile-to-cell mapping and cell data fetching for the PZ WebGL renderer.
 *
 * Implements the bridge between Leaflet tile coordinates (z, x, y) and
 * PZ map cell coordinates, then fetches and parses cell binaries via
 * the worker pool.
 *
 * Entry point: fetchCellsForTile() — called by WebGLPZLayer.fetchCellData.
 *
 * Math overview (isometric projection):
 *   Forward (PZ square sx, sy → native pixel coords):
 *     px = (sx - sy) * sqr/2 + x0
 *     py = (sx + sy) * sqr/4 + y0 + sqr/4
 *
 *   Inverse (native pixel px, py → PZ square sx, sy):
 *     halfSqr = sqr / 2
 *     quarterSqr = sqr / 4
 *     yOffset = y0 + quarterSqr
 *     dX = (px - x0) / halfSqr        ← equals (sx - sy)
 *     dY = (py - yOffset) / quarterSqr ← equals (sx + sy)
 *     sx = (dY + dX) / 2
 *     sy = (dY - dX) / 2
 *
 *   Top-view projection:
 *     px = sx * sqr + x0
 *     py = sy * sqr + y0
 *     (inverse: sx = (px - x0) / sqr, sy = (py - y0) / sqr)
 *
 *   Square → cell:
 *     cellX_min = floor(sxMin / cellSize)   ← first cell that the range enters
 *     cellX_max = ceil(sxMax  / cellSize)   ← last  cell the range touches
 *
 *   NOTE: the max boundary uses ceil(), not floor(). Using floor() for the max
 *   causes the boundary cell to be omitted whenever sxMax falls strictly inside
 *   that cell (which is almost always). The result is that every tile returns
 *   only the single cell that contains the tile's top-left corner — manifesting
 *   as "(0, 0) for every tile" when the map origin is near pixel (0, 0).
 *
 * For a given Leaflet tile (z, x, y) with tileSize px, the tile covers native
 * pixels [x * tileSize * scale, (x+1) * tileSize * scale] where
 * scale = 2^(maxNativeZoom - z). We compute the bounding square range and
 * collect the unique set of cells that overlap it.
 */

import type { CellData, CellMetadata, DziProjection, LotpackData, SquareLayerData } from './types';
import type { WorkerPool } from './workers/worker-pool';
import type { CellCache } from './cell-cache';
import { extractCellsFromChunk, fetchChunkBinary, loadChunkIndex } from './cell-chunks';

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export type CellCoord = readonly [cellX: number, cellY: number];

/**
 * Persistent module-level Set of cells the server has already 404'd on.
 * Without this, every Leaflet pan/zoom re-fetches the same missing cell
 * because L.GridLayer doesn't remember failures across tile rebuilds — the
 * worst offender is map regions with sparse data where (0,0) is requested
 * dozens of times per second and floods the throttle:admin limiter.
 */
const missingCellsCache = new Set<string>();

/** @internal Exposed for testing only — clears the module-level missing-cells cache. */
export function _clearMissingCellsCache(): void {
    missingCellsCache.clear();
}

function cellKey(cellX: number, cellY: number): string {
    return cellX + '_' + cellY;
}

/**
 * Global concurrency limit for cell binary fetches.
 *
 * Without it, a viewport of ~30 WebGL tiles × ~10 cells × 2 binaries spawns
 * 600+ parallel fetch() calls and Chrome rejects them with
 * `net::ERR_INSUFFICIENT_RESOURCES`. 12 keeps the pipe full without flooding
 * the kernel-side socket pool — browsers cap parallel HTTP/1.1 connections
 * to one host at 6, so 12 leaves headroom for HTTP/2 multiplexing without
 * starving the rest of the page.
 */
const FETCH_CONCURRENCY = 12;
let inFlight = 0;
const waiters: Array<() => void> = [];

async function acquireFetchSlot(): Promise<void> {
    if (inFlight < FETCH_CONCURRENCY) {
        inFlight++;
        return;
    }
    // Wait for a slot. The releaser hands the slot to us without decrementing
    // inFlight, so we MUST NOT increment it again — otherwise a concurrent
    // releaseFetchSlot can race with a brand-new acquireFetchSlot and let
    // inFlight overflow past FETCH_CONCURRENCY. Once overflowed every
    // subsequent caller waits forever (this manifested as the lotpack
    // request never firing after a few pan/zoom cycles).
    await new Promise<void>((resolve) => { waiters.push(resolve); });
}

function releaseFetchSlot(): void {
    const next = waiters.shift();
    if (next) {
        // Hand the slot directly to the next waiter; inFlight stays the same.
        next();
    } else {
        inFlight--;
    }
}

async function throttledFetch(url: string, init?: RequestInit): Promise<Response> {
    await acquireFetchSlot();
    try {
        return await fetch(url, init);
    } finally {
        releaseFetchSlot();
    }
}

// ---------------------------------------------------------------------------
// computeCellsForTile
// ---------------------------------------------------------------------------

/**
 * Compute which PZ cells overlap a Leaflet tile.
 *
 * @param z           Leaflet zoom level.
 * @param x           Tile column index.
 * @param y           Tile row index.
 * @param tileSize    Tile edge length in pixels (typically 256).
 * @param projection  DZI projection parameters (may include optional width/height for bounds checking).
 * @param cellSize    Cell edge length in squares (B41 = 300, B42 = 256).
 * @param mapBounds   Optional clamp limits: max valid cellX and cellY indices on disk.
 *                    When supplied, cells outside these bounds are excluded without a
 *                    network round-trip. Defaults to {maxCellX: Infinity, maxCellY: Infinity}.
 * @returns           Unique list of [cellX, cellY] pairs that overlap the tile.
 */
export function computeCellsForTile(
    z: number,
    x: number,
    y: number,
    tileSize: number,
    projection: DziProjection,
    cellSize: number,
    mapBounds?: { maxCellX: number; maxCellY: number },
): CellCoord[] {
    const { sqr, x0, y0, maxNativeZoom, isometric, width: dziWidth, height: dziHeight } = projection;
    // pzmap2dzi forward projection writes image_pixel = world_pixel + x0_pzmap,
    // where x0_pzmap is the value stored in map_info.json (passed here as
    // worldX0). To translate Leaflet's image-space tile coordinates back into
    // the real PZ world-pixel space we must SUBTRACT worldX0 / worldY0.
    // The previous implementation added it, which for the typical large
    // positive x0 (~1e6) produced world-square indices in the millions and
    // an all-negative sy range, so every cell was rejected by the
    // availableCells filter before any header.bin request was made.
    const worldX0 = projection.worldX0 ?? x0;
    const worldY0 = projection.worldY0 ?? y0;
    const maxCellX = mapBounds?.maxCellX ?? Infinity;
    const maxCellY = mapBounds?.maxCellY ?? Infinity;

    // Scale factor: how many native pixels does one tile pixel represent?
    const scale = Math.pow(2, maxNativeZoom - z);

    // Image-space tile bounding box (used for dziWidth/dziHeight bounds check).
    const pxMinImg = x * tileSize * scale;
    const pxMaxImg = (x + 1) * tileSize * scale;
    const pyMinImg = y * tileSize * scale;
    const pyMaxImg = (y + 1) * tileSize * scale;

    // Fast-reject: tile is entirely outside the DZI image bounds.
    // This avoids unnecessary inverse projection and prevents flooding the
    // negative-cell cache with coords that will never exist on disk.
    if (dziWidth !== undefined && (pxMaxImg <= 0 || pxMinImg >= dziWidth)) {
        return [];
    }
    if (dziHeight !== undefined && (pyMaxImg <= 0 || pyMinImg >= dziHeight)) {
        return [];
    }

    // Translate image-space pixel coords to world-space for the iso inverse.
    const pxMin = pxMinImg - worldX0;
    const pxMax = pxMaxImg - worldX0;
    const pyMin = pyMinImg - worldY0;
    const pyMax = pyMaxImg - worldY0;

    let sxMin: number;
    let sxMax: number;
    let syMin: number;
    let syMax: number;

    if (isometric) {
        // Inverse isometric projection for all 4 corners of the tile rectangle.
        //
        // The isometric rhombus rotates the (sx, sy) axes by 45 degrees
        // relative to pixel space.  A rectangular tile in pixel space maps to a
        // rotated rectangle (parallelogram) in square space.  We must evaluate
        // all four corners and take the axis-aligned bounding box.
        //
        // Without this, only the top-left corner is projected, which always
        // yields the same cell when the tile covers less than one cell-width in
        // square space.
        const halfSqr = sqr / 2;
        const quarterSqr = sqr / 4;
        const yOffset = y0 + quarterSqr;

        const pixelToSquare = (px: number, py: number): [number, number] => {
            const dX = (px - x0) / halfSqr;        // equals (sx - sy)
            const dY = (py - yOffset) / quarterSqr; // equals (sx + sy)
            const sx = (dY + dX) / 2;
            const sy = (dY - dX) / 2;
            return [sx, sy];
        };

        const corners: Array<[number, number]> = [
            pixelToSquare(pxMin, pyMin),
            pixelToSquare(pxMax, pyMin),
            pixelToSquare(pxMin, pyMax),
            pixelToSquare(pxMax, pyMax),
        ];

        sxMin = Math.min(...corners.map(([sx]) => sx));
        sxMax = Math.max(...corners.map(([sx]) => sx));
        syMin = Math.min(...corners.map(([, sy]) => sy));
        syMax = Math.max(...corners.map(([, sy]) => sy));
    } else {
        // Top-view: px = sx * sqr + x0 → sx = (px - x0) / sqr
        sxMin = (pxMin - x0) / sqr;
        sxMax = (pxMax - x0) / sqr;
        syMin = (pyMin - y0) / sqr;
        syMax = (pyMax - y0) / sqr;
    }

    // Convert square range to cell range.
    //
    // Floor for the minimum (first cell the range enters) and ceil for the
    // maximum (last cell the range touches).  Previously both used floor(),
    // which caused the upper-boundary cell to be silently dropped whenever
    // sxMax/syMax fell strictly inside that cell — almost always.  The result
    // was that all tiles produced a single cell at the map origin (0, 0).
    const cxMin = Math.floor(sxMin / cellSize);
    const cxMax = Math.ceil(sxMax / cellSize);
    const cyMin = Math.floor(syMin / cellSize);
    const cyMax = Math.ceil(syMax / cellSize);

    // Guard against pathologically huge ranges (loop blow-up). The actual
    // network/render cost is bounded by `availableCells` filtering + the
    // tile-renderer's decimation, so the cap can safely span the full PZ
    // map (~78×63 cells for Muldraugh) on the deepest overview zooms — any
    // smaller value cut off whole tiles, producing visible triangular
    // map slices.
    const MAX_SPAN = 1024;
    if (cxMax - cxMin > MAX_SPAN || cyMax - cyMin > MAX_SPAN) {
        return [];
    }

    const cells: CellCoord[] = [];
    for (let cx = cxMin; cx <= cxMax; cx++) {
        // Skip negative coordinates (PZ world starts at (0, 0)) and cells
        // beyond the known on-disk bounds (avoids guaranteed 404 round-trips).
        if (cx < 0 || cx > maxCellX) continue;
        for (let cy = cyMin; cy <= cyMax; cy++) {
            if (cy < 0 || cy > maxCellY) continue;
            cells.push([cx, cy] as const);
        }
    }

    return cells;
}

// ---------------------------------------------------------------------------
// buildSquareLayerData
// ---------------------------------------------------------------------------

/**
 * Wrap a parsed header + lotpack into a SquareLayerData accessor.
 * Implements the getSquare(subx, suby, layer) interface from types.ts.
 */
function buildSquareLayerData(header: CellMetadata, lotpack: LotpackData): SquareLayerData {
    return {
        header,
        lotpack,
        getSquare(subx: number, suby: number, layer: number): number[] | null {
            const { cellSizeInBlocks, blockSize, minLayer } = header;
            const blockX = Math.floor(subx / blockSize);
            const blockY = Math.floor(suby / blockSize);

            if (blockX < 0 || blockX >= cellSizeInBlocks) return null;
            if (blockY < 0 || blockY >= cellSizeInBlocks) return null;

            const blockIdx = blockX * cellSizeInBlocks + blockY;
            const blockData = lotpack.blocks[blockIdx];
            if (!blockData) return null;

            const layerIdx = layer - minLayer;
            const layerData = blockData[layerIdx];
            if (!layerData) return null;

            const localX = subx % blockSize;
            const localY = suby % blockSize;
            const squareData = layerData[localX];
            if (!squareData) return null;
            return squareData[localY] ?? null;
        },
    };
}

// ---------------------------------------------------------------------------
// fetchAndParseCell
// ---------------------------------------------------------------------------

/**
 * Fetch and parse a single PZ cell (header + lotpack) from the API.
 *
 * Returns null if the cell does not exist (HTTP 404) or on network error.
 * Other HTTP errors are also swallowed and logged — the renderer degrades
 * gracefully by skipping missing cells.
 *
 * @param cellX      Cell X coordinate.
 * @param cellY      Cell Y coordinate.
 * @param baseUrl    API base URL e.g. '/admin/api/pz-map'.
 * @param pool       Worker pool instance for off-main-thread parsing.
 * @returns          Parsed CellData or null.
 */
export async function fetchAndParseCell(
    cellX: number,
    cellY: number,
    baseUrl: string,
    pool: WorkerPool,
): Promise<CellData | null> {
    const headerUrl = `${baseUrl}/cell/${cellX}/${cellY}/header`;
    const lotpackUrl = `${baseUrl}/cell/${cellX}/${cellY}/lotpack`;

    // --- Fetch lotheader ---
    let headerBuffer: ArrayBuffer;
    try {
        const resp = await throttledFetch(headerUrl, { credentials: 'same-origin' });
        if (resp.status === 404) return null; // cell doesn't exist — normal case
        if (!resp.ok) {
            console.warn(`[tile-cells] Header fetch failed for (${cellX},${cellY}): HTTP ${resp.status}`);
            return null;
        }
        headerBuffer = await resp.arrayBuffer();
    } catch (err) {
        console.warn(`[tile-cells] Header network error for (${cellX},${cellY}):`, err);
        return null;
    }

    // --- Parse lotheader in worker ---
    let header: CellMetadata;
    try {
        header = await pool.parseLotheader(headerBuffer, cellX, cellY);
    } catch (err) {
        console.warn(`[DBG] Header parse error for (${cellX},${cellY}):`, err);
        return null;
    }

    // --- Fetch lotpack ---
    let lotpackBuffer: ArrayBuffer;
    try {
        const resp = await throttledFetch(lotpackUrl, { credentials: 'same-origin' });
        if (resp.status === 404) return null;
        if (!resp.ok) {
            console.warn(`[tile-cells] Lotpack fetch failed for (${cellX},${cellY}): HTTP ${resp.status}`);
            return null;
        }
        lotpackBuffer = await resp.arrayBuffer();
    } catch (err) {
        console.warn(`[tile-cells] Lotpack network error for (${cellX},${cellY}):`, err);
        return null;
    }

    // --- Parse lotpack in worker ---
    let lotpack: LotpackData;
    try {
        lotpack = await pool.parseLotpack(lotpackBuffer, header);
    } catch (err) {
        console.warn(`[DBG] Lotpack parse error for (${cellX},${cellY}):`, err);
        return null;
    }

    const cell: SquareLayerData = buildSquareLayerData(header, lotpack);

    return {
        cellX,
        cellY,
        header,
        cell,
        save: null,
        fetchedAt: Date.now(),
    };
}

// ---------------------------------------------------------------------------
// fetchCellsForTile — main entry point
// ---------------------------------------------------------------------------

/**
 * Fetch all cell data overlapping a Leaflet tile, using LRU cache.
 *
 * 1. Compute which cells overlap the tile via inverse isometric projection.
 * 2. For each cell: return from cache if present, else fetch + parse + cache.
 * 3. Fan out all missing cells in parallel via Promise.all.
 * 4. Filter out null results (missing cells on disk are normal).
 *
 * @param z               Leaflet zoom level.
 * @param x               Tile column.
 * @param y               Tile row.
 * @param tileSize        Tile edge length (pixels).
 * @param projection      DZI projection parameters.
 * @param cellSize        Squares per cell edge (B41=300, B42=256).
 * @param baseUrl         API base URL.
 * @param pool            Worker pool.
 * @param cache           LRU cell cache.
 * @param availableCells  Optional Set of known on-disk cells (keys: "x_y").
 *                        When provided and non-null, cells absent from the set
 *                        are skipped without a network round-trip. Pass null
 *                        while the manifest is still loading to disable filtering.
 * @returns               Array of parsed cells (empty when tile is out of map bounds).
 */
export async function fetchCellsForTile(
    z: number,
    x: number,
    y: number,
    tileSize: number,
    projection: DziProjection,
    cellSize: number,
    baseUrl: string,
    pool: WorkerPool,
    cache: CellCache,
    availableCells?: Set<string> | null,
): Promise<CellData[]> {
    // Tri-state filter:
    //   undefined → no manifest in play (legacy/tests), skip filter.
    //   null      → manifest still loading. Block every request until it
    //               arrives — otherwise the first wave of tiles fires
    //               hundreds of guaranteed-404 requests for cells that the
    //               manifest will reveal as nonexistent ~50 ms later.
    //   Set       → manifest is known; only fetch coords present in it.
    if (availableCells === null) return [];

    let coords = computeCellsForTile(z, x, y, tileSize, projection, cellSize);

    if (availableCells !== undefined) {
        coords = coords.filter(([cx, cy]) => availableCells.has(cellKey(cx, cy)));
    }
    if (coords.length === 0) return [];

    // Resolve cache hits up-front; collect actual fetches into bulk requests.
    const resolved: Array<CellData | null> = [];
    const missing: Array<[number, number]> = [];

    for (const [cellX, cellY] of coords) {
        if (cellX < 0 || cellY < 0) { resolved.push(null); continue; }
        const key = cellKey(cellX, cellY);
        if (missingCellsCache.has(key)) { resolved.push(null); continue; }
        const cached = cache.get(cellX, cellY);
        if (cached !== undefined) { resolved.push(cached); continue; }
        resolved.push(null);
        missing.push([cellX, cellY]);
    }

    if (missing.length > 0) {
        const fetched = await fetchAndParseBulk(missing, baseUrl, pool);
        for (let i = 0; i < coords.length; i++) {
            if (resolved[i] !== null) continue;
            const [cx, cy] = coords[i]!;
            const data = fetched.get(cellKey(cx, cy));
            if (data !== undefined) {
                cache.set(data);
                resolved[i] = data;
            } else {
                missingCellsCache.add(cellKey(cx, cy));
            }
        }
    }

    return resolved.filter((d): d is CellData => d !== null);
}

// ---------------------------------------------------------------------------
// Bulk fetch — one HTTP request returns header + lotpack for up to BULK_SIZE
// cells. Parses the custom binary stream emitted by PzMapDataController::cellsBulk.
// ---------------------------------------------------------------------------

const BULK_SIZE = 64;

async function fetchAndParseBulk(
    coords: Array<[number, number]>,
    baseUrl: string,
    pool: WorkerPool,
): Promise<Map<string, CellData>> {
    const out = new Map<string, CellData>();
    if (coords.length === 0) return out;

    // Try the pre-packed static chunk path first — nginx serves these with
    // immutable cache and zero PHP overhead, so once a chunk is in browser
    // cache it costs nothing to reuse. Falls back to the PHP bulk endpoint
    // when the chunks haven't been built or the index is missing.
    const index = await loadChunkIndex();
    if (index !== null) {
        return fetchViaChunks(coords, pool, index, out);
    }

    return fetchViaPhpBulk(coords, baseUrl, pool, out);
}

/**
 * Static-chunk path: group requested cells by chunk, fetch each unique
 * chunk once (parallel, throttled by browser HTTP/2 limits), extract every
 * wanted cell from each chunk, then parse via the worker pool.
 */
async function fetchViaChunks(
    coords: Array<[number, number]>,
    pool: WorkerPool,
    index: { cells: Record<string, string> },
    out: Map<string, CellData>,
): Promise<Map<string, CellData>> {
    /** chunkKey → set of wanted "cellX_cellY" keys in that chunk */
    const wantedByChunk = new Map<string, Set<string>>();
    let cellsNotInIndex = 0;
    for (const [cx, cy] of coords) {
        const key = cellKey(cx, cy);
        const chunkKey = index.cells[key];
        if (chunkKey === undefined) {
            // Not present in the static index → mark missing, skip.
            missingCellsCache.add(key);
            cellsNotInIndex++;
            continue;
        }
        let set = wantedByChunk.get(chunkKey);
        if (!set) {
            set = new Set();
            wantedByChunk.set(chunkKey, set);
        }
        set.add(key);
    }

    if (wantedByChunk.size === 0) return out;

    // Parallel chunk download — each fetchChunkBinary dedupes in-flight and
    // memoises the buffer, so the same chunk is never downloaded twice per
    // session no matter how many overlapping tiles request it.
    const chunkResults = await Promise.all(
        Array.from(wantedByChunk.entries()).map(async ([chunkKey, wantedKeys]) => {
            const buf = await fetchChunkBinary(chunkKey);
            if (!buf) return [] as CellData[];
            const extracted = extractCellsFromChunk(buf, wantedKeys);
            // Parse via workers in parallel.
            const parseJobs = extracted.map((ex) =>
                parseCellInWorker(pool, ex.cellX, ex.cellY, ex.headerBuffer, ex.lotpackBuffer),
            );
            const parsed = await Promise.all(parseJobs);
            return parsed.filter((r): r is CellData => r !== null);
        }),
    );

    for (const cells of chunkResults) {
        for (const cell of cells) {
            out.set(cellKey(cell.cellX, cell.cellY), cell);
        }
    }
    if (cellsNotInIndex > 0) {
        console.debug(`[tile-cells] chunk-path: ${cellsNotInIndex} cells absent from static index`);
    }
    return out;
}

/**
 * Legacy PHP bulk endpoint path — used only when chunk index is unavailable.
 */
async function fetchViaPhpBulk(
    coords: Array<[number, number]>,
    baseUrl: string,
    pool: WorkerPool,
    out: Map<string, CellData>,
): Promise<Map<string, CellData>> {
    const chunks: Array<Array<[number, number]>> = [];
    for (let i = 0; i < coords.length; i += BULK_SIZE) {
        chunks.push(coords.slice(i, i + BULK_SIZE));
    }

    const chunkResults = await Promise.all(
        chunks.map((c) => fetchBulkChunk(c, baseUrl, pool).catch((err) => {
            console.warn('[tile-cells] bulk chunk failed:', err);
            return [] as CellData[];
        })),
    );

    for (const cells of chunkResults) {
        for (const cell of cells) {
            out.set(cellKey(cell.cellX, cell.cellY), cell);
        }
    }
    return out;
}

async function fetchBulkChunk(
    chunk: Array<[number, number]>,
    baseUrl: string,
    pool: WorkerPool,
): Promise<CellData[]> {
    const coordsParam = chunk.map(([x, y]) => `${x}_${y}`).join(',');
    const url = `${baseUrl}/cells/bulk?coords=${coordsParam}`;

    const resp = await throttledFetch(url, { credentials: 'same-origin' });
    if (!resp.ok) {
        console.warn(`[tile-cells] bulk HTTP ${resp.status} for ${chunk.length} cells`);
        return [];
    }
    const buf = await resp.arrayBuffer();
    const view = new DataView(buf);

    if (buf.byteLength < 4) return [];

    let pos = 0;
    const count = view.getUint32(pos, true); pos += 4;

    const tableStart = pos;
    let bodyPos = tableStart + count * 12;

    const parseJobs: Array<Promise<CellData | null>> = [];

    for (let i = 0; i < count; i++) {
        const t = tableStart + i * 12;
        const cellX = view.getUint16(t, true);
        const cellY = view.getUint16(t + 2, true);
        const hLen = view.getUint32(t + 4, true);
        const lLen = view.getUint32(t + 8, true);

        const headerBuf = hLen > 0 ? buf.slice(bodyPos, bodyPos + hLen) : null;
        bodyPos += hLen;
        const lotpackBuf = lLen > 0 ? buf.slice(bodyPos, bodyPos + lLen) : null;
        bodyPos += lLen;

        if (!headerBuf || !lotpackBuf) {
            // Mark genuinely-missing cells so we don't bulk-fetch them again.
            missingCellsCache.add(cellKey(cellX, cellY));
            continue;
        }

        parseJobs.push(parseCellInWorker(pool, cellX, cellY, headerBuf, lotpackBuf));
    }

    const results = await Promise.all(parseJobs);
    return results.filter((r): r is CellData => r !== null);
}

async function parseCellInWorker(
    pool: WorkerPool,
    cellX: number,
    cellY: number,
    headerBuf: ArrayBuffer,
    lotpackBuf: ArrayBuffer,
): Promise<CellData | null> {
    try {
        const header = await pool.parseLotheader(headerBuf, cellX, cellY);
        const lotpack = await pool.parseLotpack(lotpackBuf, header);
        const cell: SquareLayerData = buildSquareLayerData(header, lotpack);
        return { cellX, cellY, header, cell, save: null, fetchedAt: Date.now() };
    } catch (err) {
        console.warn(`[tile-cells] bulk parse failed for (${cellX},${cellY}):`, err);
        return null;
    }
}
