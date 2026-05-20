/**
 * CellLoader — координирует загрузку всех cells:
 *   1. fetch binary через bulk endpoint
 *   2. dispatch parse в worker pool
 *   3. append packed Uint32Array в CellTextureManager
 *   4. progress reporting
 *
 * Backend bulk endpoint формат (один HTTP запрос → много cells):
 *   GET /admin/api/pz-map/cells/bulk?coords=x_y,x_y,...
 *   Response: binary stream
 *     [count: uint32 LE]
 *     [per cell: x u16, y u16, headerLen u32, lotpackLen u32]
 *     [body: header bytes + lotpack bytes concatenated]
 *
 * Максимум 256 cells на запрос (server throttle). Concurrency: 6
 * параллельных запросов (browser HTTP/2 limit-friendly).
 */

import type { CellTextureManager } from '../gpu/cell-texture-manager';
import type { CellsManifest, SpritesManifest } from '../types';
import type { WorkerPool } from '../workers/worker-pool';
import { mapLimit } from '../utils/concurrency';
import {
    getCachedCellBinary,
    putCachedCellBinary,
} from '../cache/cell-chunk-cache';
import {
    getCachedPackedCell,
    putCachedPackedCell,
} from '../cache/cell-packed-cache';

/**
 * Server hard cap = 256 cells/request, но при ~1 MB lotpack за cell это
 * 256 MB загруженных в PHP memory за один request → 500 (memory_limit).
 * 32 cells × 1 MB = 32 MB — комфортно укладывается в PHP defaults.
 */
const BULK_REQUEST_LIMIT = 32;
const PARALLEL_BULK_REQUESTS = 6;

export interface CellLoaderOptions {
    pool: WorkerPool;
    textureMgr: CellTextureManager;
    cellsManifest: CellsManifest;
    cellsBaseUrl: string;
    /** Версия atlas (для IDB cache keying). */
    atlasVersion: string;
    /** Прогресс per cell (loaded из N total). */
    onCellProgress?: (loaded: number, total: number) => void;
    /**
     * Phase 4.3b.3: progressive ready. Callback вызывается ОДИН РАЗ когда
     * `parsedCells` достигает `progressiveReadyThreshold`. Renderer
     * переключается в ready state и начинает rendering, остальные cells
     * загружаются background-потоком.
     */
    progressiveReadyThreshold?: number;
    onProgressiveReady?: () => void;
    signal?: AbortSignal;
}

export interface CellLoaderStats {
    totalCells: number;
    parsedCells: number;
    skippedCells: number;
    totalEntries: number;
    bytesFromCache: number;
    bytesFromNetwork: number;
    /** Cells loaded из packed cache (skip worker parse). */
    packedCacheHits: number;
}

export class CellLoader {
    private parsedCells = 0;
    private skippedCells = 0;
    private bytesFromCache = 0;
    private bytesFromNetwork = 0;
    private packedCacheHits = 0;
    private progressiveReadyFired = false;

    private maybeFireProgressiveReady(): void {
        if (this.progressiveReadyFired) return;
        const threshold = this.opts.progressiveReadyThreshold ?? 0;
        if (threshold > 0 && this.parsedCells >= threshold) {
            this.progressiveReadyFired = true;
            this.opts.onProgressiveReady?.();
        }
    }

    constructor(private readonly opts: CellLoaderOptions) {}

    async loadAll(): Promise<CellLoaderStats> {
        const cells = this.opts.cellsManifest.cells;
        const total = cells.length;

        // Разбиваем на батчи по BULK_REQUEST_LIMIT.
        const batches: Array<typeof cells> = [];
        for (let i = 0; i < cells.length; i += BULK_REQUEST_LIMIT) {
            batches.push(cells.slice(i, i + BULK_REQUEST_LIMIT));
        }

        // Параллельные bulk requests.
        await mapLimit(batches, PARALLEL_BULK_REQUESTS, async (batch) => {
            await this.processBatch(batch, total);
        });

        // Финальный flush GPU buffers.
        this.opts.textureMgr.flush();

        return {
            totalCells: total,
            parsedCells: this.parsedCells,
            skippedCells: this.skippedCells,
            totalEntries: this.opts.textureMgr.getInfo().totalEntries,
            bytesFromCache: this.bytesFromCache,
            bytesFromNetwork: this.bytesFromNetwork,
            packedCacheHits: this.packedCacheHits,
        };
    }

    /**
     * Обрабатывает один batch cells: смотрит IDB cache, fetch missing,
     * dispatch в worker, append в texture.
     */
    private async processBatch(
        batch: Array<[number, number]>,
        total: number,
    ): Promise<void> {
        // 0. Packed cache check: cells где уже есть готовый Uint32Array
        //    skipping worker parse. Direct GPU append.
        const stillNeedingParse: Array<[number, number]> = [];
        for (const [cx, cy] of batch) {
            const cached = await getCachedPackedCell(
                this.opts.atlasVersion,
                cx,
                cy,
            );
            if (cached) {
                const packed = new Uint32Array(cached.packed);
                const strideOffsets = new Uint32Array(cached.strideOffsets);
                this.opts.textureMgr.append(cx, cy, packed, strideOffsets);
                this.parsedCells++;
                this.packedCacheHits++;
                this.bytesFromCache
                    += cached.packed.byteLength + cached.strideOffsets.byteLength;
                this.opts.onCellProgress?.(
                    this.parsedCells + this.skippedCells,
                    total,
                );
                this.maybeFireProgressiveReady();
            } else {
                stillNeedingParse.push([cx, cy]);
            }
        }

        if (stillNeedingParse.length === 0) {
            // Весь batch from packed cache — skip остальные шаги.
            this.opts.textureMgr.flush();
            return;
        }

        // 1. Разделяем на cached / missing (raw binaries).
        const cachedBinaries = new Map<
            string,
            { header: ArrayBuffer; lotpack: ArrayBuffer }
        >();
        const missing: Array<[number, number]> = [];

        for (const [cx, cy] of stillNeedingParse) {
            const [hdr, lp] = await Promise.all([
                getCachedCellBinary(this.opts.atlasVersion, cx, cy, 'header'),
                getCachedCellBinary(this.opts.atlasVersion, cx, cy, 'lotpack'),
            ]);
            if (hdr && lp) {
                cachedBinaries.set(`${cx}_${cy}`, { header: hdr, lotpack: lp });
                this.bytesFromCache += hdr.byteLength + lp.byteLength;
            } else {
                missing.push([cx, cy]);
            }
        }

        // 2. Bulk fetch missing.
        const fetchedBinaries = await this.bulkFetch(missing);
        for (const [key, bins] of fetchedBinaries) {
            cachedBinaries.set(key, bins);
            this.bytesFromNetwork += bins.header.byteLength + bins.lotpack.byteLength;
            // Сохраняем в IDB (fire-and-forget).
            const [cx, cy] = key.split('_').map(Number) as [number, number];
            void putCachedCellBinary(
                this.opts.atlasVersion,
                cx,
                cy,
                'header',
                bins.header,
            ).catch(() => {/* IDB quota — non-fatal */});
            void putCachedCellBinary(
                this.opts.atlasVersion,
                cx,
                cy,
                'lotpack',
                bins.lotpack,
            ).catch(() => {});
        }

        // 3. Parse через workers (параллельно) + append в texture.
        const parseTasks = Array.from(cachedBinaries.entries()).map(
            async ([key, bins]) => {
                const [cx, cy] = key.split('_').map(Number) as [number, number];
                try {
                    // Worker transferable использует ArrayBuffer'ы — после
                    // postMessage main thread не может их читать. IDB cache
                    // надо положить ДО transfer (мы уже сделали выше).
                    // Делаем slice() копию для worker, оригинал остаётся в IDB
                    // (был помещён через putCachedCellBinary — копия в IDB).
                    const headerCopy = bins.header.slice(0);
                    const lotpackCopy = bins.lotpack.slice(0);
                    const result = await this.opts.pool.parseCell(
                        cx,
                        cy,
                        headerCopy,
                        lotpackCopy,
                    );
                    const packed = new Uint32Array(result.packed);
                    const strideOffsets = new Uint32Array(result.strideOffsets);
                    // Сохраняем в packed cache (fire-and-forget). IDB делает
                    // structured clone на commit — для GPU upload buffer
                    // остаётся валидным (texSubImage2D synchronous).
                    void putCachedPackedCell(this.opts.atlasVersion, cx, cy, {
                        packed: packed.buffer as ArrayBuffer,
                        strideOffsets: strideOffsets.buffer as ArrayBuffer,
                        entriesCount: result.entriesCount,
                    }).catch(() => {/* IDB quota — non-fatal */});
                    this.opts.textureMgr.append(cx, cy, packed, strideOffsets);
                    this.parsedCells++;
                    this.maybeFireProgressiveReady();
                } catch (err) {
                    this.skippedCells++;
                    console.warn(
                        `[cell-loader] cell (${cx},${cy}) parse failed:`,
                        err,
                    );
                }
                this.opts.onCellProgress?.(
                    this.parsedCells + this.skippedCells,
                    total,
                );
            },
        );
        await Promise.all(parseTasks);

        // Flush GPU buffers пакетно (каждый batch).
        this.opts.textureMgr.flush();
    }

    /**
     * Bulk fetch missing cells через /cells/bulk endpoint.
     *
     * Response binary format:
     *   [count uint32 LE]
     *   per cell: x u16, y u16, headerLen u32, lotpackLen u32
     *   bodies: header + lotpack concatenated
     */
    private async bulkFetch(
        coords: Array<[number, number]>,
    ): Promise<Map<string, { header: ArrayBuffer; lotpack: ArrayBuffer }>> {
        const result = new Map<
            string,
            { header: ArrayBuffer; lotpack: ArrayBuffer }
        >();
        if (coords.length === 0) return result;

        const url = new URL(`${this.opts.cellsBaseUrl}/cells/bulk`, window.location.origin);
        url.searchParams.set(
            'coords',
            coords.map(([x, y]) => `${x}_${y}`).join(','),
        );

        const res = await fetch(url.toString(), {
            credentials: 'same-origin',
            signal: this.opts.signal,
        });
        if (!res.ok) {
            console.warn(
                `[cell-loader] bulk fetch HTTP ${res.status} для ${coords.length} cells`,
            );
            return result;
        }
        const buffer = await res.arrayBuffer();
        const dv = new DataView(buffer);
        let pos = 0;
        const count = dv.getUint32(pos, /* LE */ true);
        pos += 4;

        // Sub-header table: count × (x u16, y u16, headerLen u32, lotpackLen u32) = 12 bytes/entry
        const headerSize = 12;
        const entries: Array<{
            x: number;
            y: number;
            headerLen: number;
            lotpackLen: number;
        }> = [];
        for (let i = 0; i < count; i++) {
            const x = dv.getUint16(pos, true);
            const y = dv.getUint16(pos + 2, true);
            const headerLen = dv.getUint32(pos + 4, true);
            const lotpackLen = dv.getUint32(pos + 8, true);
            entries.push({ x, y, headerLen, lotpackLen });
            pos += headerSize;
        }

        // Bodies.
        for (const entry of entries) {
            const headerBuf = buffer.slice(pos, pos + entry.headerLen);
            pos += entry.headerLen;
            const lotpackBuf = buffer.slice(pos, pos + entry.lotpackLen);
            pos += entry.lotpackLen;
            // PZ cell coords могут быть negative — server использует u16 как
            // unsigned, но логически они signed. Если carry-bit unset, value < 32768
            // → коорд > 0. Большинство map'ов используют unsigned coords.
            result.set(`${entry.x}_${entry.y}`, {
                header: headerBuf,
                lotpack: lotpackBuf,
            });
        }

        return result;
    }
}

/**
 * Построить sprite name → id map из sprites manifest.
 * Used by worker init.
 */
export function buildSpriteNameToId(
    sprites: SpritesManifest,
): Map<string, number> {
    const map = new Map<string, number>();
    let nextId = 0;
    for (const name of Object.keys(sprites.sprites)) {
        map.set(name, nextId++);
    }
    return map;
}
