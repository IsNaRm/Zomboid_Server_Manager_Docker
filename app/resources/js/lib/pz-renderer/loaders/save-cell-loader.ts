/**
 * SaveCellLoader — загружает pre-parsed save cells, выпеченных серверным
 * Python скриптом (rebuild_save_cache.py).
 *
 * Никакого парсинга .bin на клиенте! Сервер уже распаковал save chunks
 * через pzdataspec и сложил packed Uint32Array в `cell-{cx}_{cy}.packed`.
 * Мы скачиваем готовые байты через nginx alias `/pz-save-data/` и
 * заливаем в GPU без обработки.
 *
 * Endpoints (все статика через nginx, Last-Modified handles caching):
 *   GET /pz-save-data/manifest.json
 *       { version, world, save_version, cells: [[cx, cy, mtime], ...], generated_at }
 *   GET /pz-save-data/cell-{cx}_{cy}.packed     (raw Uint32Array)
 *   GET /pz-save-data/cell-{cx}_{cy}.strides    (Uint32Array(7))
 */

import type { CellTextureManager } from '../gpu/cell-texture-manager';
import { mapLimit } from '../utils/concurrency';

const PARALLEL_CELL_FETCHES = 8;

export interface SaveCellsManifest {
    version: string;
    world: string;
    save_version: number;
    cells: Array<[x: number, y: number, mtime: number]>;
    generated_at: number;
}

export interface SaveCellLoaderOptions {
    textureMgr: CellTextureManager;
    /** Base URL для save-cache, e.g. `/pz-save-data`. */
    saveBaseUrl: string;
    signal?: AbortSignal;
    onCellLoaded?: (cellX: number, cellY: number, entriesCount: number) => void;
    onProgress?: (loaded: number, total: number) => void;
}

export interface SaveCellLoaderStats {
    parsedCells: number;
    skippedCells: number;
    totalEntries: number;
    bytesFromNetwork: number;
    saveVersion: number | null;
}

export class SaveCellLoader {
    private parsedCells = 0;
    private skippedCells = 0;
    private bytesFromNetwork = 0;
    private saveVersion: number | null = null;
    private readonly loadedMtimes = new Map<string, number>();
    private highestMtime = 0;

    constructor(private readonly opts: SaveCellLoaderOptions) {}

    getStats(): SaveCellLoaderStats {
        return {
            parsedCells: this.parsedCells,
            skippedCells: this.skippedCells,
            totalEntries: this.opts.textureMgr.getInfo().totalEntries,
            bytesFromNetwork: this.bytesFromNetwork,
            saveVersion: this.saveVersion,
        };
    }

    getHighestMtime(): number {
        return this.highestMtime;
    }

    async loadManifest(): Promise<SaveCellsManifest | null> {
        const url = new URL(
            `${this.opts.saveBaseUrl}/manifest.json`,
            window.location.origin,
        );
        try {
            const res = await fetch(url.toString(), {
                credentials: 'same-origin',
                signal: this.opts.signal,
                headers: { Accept: 'application/json' },
            });
            if (!res.ok) {
                if (res.status === 404) {
                    return null;
                }
                console.warn(`[save-loader] manifest HTTP ${res.status}`);
                return null;
            }
            return (await res.json()) as SaveCellsManifest;
        } catch (err) {
            if ((err as Error).name === 'AbortError') throw err;
            console.warn('[save-loader] manifest fetch:', err);
            return null;
        }
    }

    /**
     * Initial load: manifest + parallel fetch всех cells. Browser HTTP cache
     * (Last-Modified от nginx) автоматически делает 304 на повторные запросы.
     */
    async loadAll(): Promise<SaveCellLoaderStats> {
        const manifest = await this.loadManifest();
        if (!manifest) {
            return this.getStats();
        }
        this.saveVersion = manifest.save_version;
        await this.loadCells(manifest.cells);
        this.opts.textureMgr.flush();
        return this.getStats();
    }

    /**
     * Дозагрузка/обновление конкретных cells (вызывается watcher'ом при
     * получении изменений из manifest).
     */
    async loadCells(cells: Array<[number, number, number]>): Promise<void> {
        if (cells.length === 0) return;

        const needFetch: Array<[number, number, number]> = [];
        for (const [cx, cy, mtime] of cells) {
            if (mtime > this.highestMtime) this.highestMtime = mtime;
            const key = `${cx}_${cy}`;
            const known = this.loadedMtimes.get(key) ?? 0;
            if (mtime > known) {
                needFetch.push([cx, cy, mtime]);
            }
        }

        if (needFetch.length === 0) return;

        let progress = 0;
        await mapLimit(needFetch, PARALLEL_CELL_FETCHES, async ([cx, cy, mtime]) => {
            try {
                await this.fetchAndUploadCell(cx, cy);
                this.loadedMtimes.set(`${cx}_${cy}`, mtime);
                this.parsedCells++;
            } catch (err) {
                this.skippedCells++;
                if ((err as Error).name !== 'AbortError') {
                    console.warn(`[save-loader] cell (${cx},${cy}) failed:`, err);
                }
            }
            progress++;
            this.opts.onProgress?.(progress, needFetch.length);
        });

        this.opts.textureMgr.flush();
    }

    private async fetchAndUploadCell(cellX: number, cellY: number): Promise<void> {
        const base = this.opts.saveBaseUrl;
        const packedUrl = new URL(
            `${base}/cell-${cellX}_${cellY}.packed`,
            window.location.origin,
        );
        const stridesUrl = new URL(
            `${base}/cell-${cellX}_${cellY}.strides`,
            window.location.origin,
        );

        const [packedRes, stridesRes] = await Promise.all([
            fetch(packedUrl.toString(), {
                credentials: 'same-origin',
                signal: this.opts.signal,
            }),
            fetch(stridesUrl.toString(), {
                credentials: 'same-origin',
                signal: this.opts.signal,
            }),
        ]);

        if (!packedRes.ok) {
            throw new Error(`packed HTTP ${packedRes.status}`);
        }
        if (!stridesRes.ok) {
            throw new Error(`strides HTTP ${stridesRes.status}`);
        }

        const [packedBuf, stridesBuf] = await Promise.all([
            packedRes.arrayBuffer(),
            stridesRes.arrayBuffer(),
        ]);

        this.bytesFromNetwork += packedBuf.byteLength + stridesBuf.byteLength;

        const packed = new Uint32Array(packedBuf);
        const strideOffsets = new Uint32Array(stridesBuf);
        this.opts.textureMgr.append(cellX, cellY, packed, strideOffsets);

        this.opts.onCellLoaded?.(cellX, cellY, packed.length);
    }
}
