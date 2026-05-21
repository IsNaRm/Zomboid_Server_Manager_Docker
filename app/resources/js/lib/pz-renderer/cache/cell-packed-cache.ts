/**
 * IDB persistence для уже распарсенных (packed) cell данных.
 *
 * Сохраняем результат worker'a — `Uint32Array.buffer` + stride offsets.
 * На warm load skip worker parse: read из IDB → direct GPU upload.
 *
 * Backend cell binaries кэшируются отдельно в `cell-chunks` store (для
 * cold load после атлас version bump). `cell-packed` invalidated по
 * version + sort-mode (если меняется логика pack — bumping версии
 * исключает stale данные).
 *
 * Ключ: `{version}_{cellX}_{cellY}`.
 * Value: `{ packed: ArrayBuffer, strideOffsets: ArrayBuffer, entriesCount: number }`.
 */

import { CELL_PACKED_STORE, idbGet, idbPut, openCacheDb } from './idb-cache';
import { ensureVersionMatches } from '../utils/version';

export interface CachedPackedCell {
    packed: ArrayBuffer;
    strideOffsets: ArrayBuffer;
    entriesCount: number;
}

/**
 * Bump'ить этот suffix если меняется bit layout packed entry, sort algorithm,
 * keepMinLayer/keepMaxLayer и т.п. — invalidate всех закэшированных cells.
 */
const PACK_VERSION_SUFFIX = 'p5_g2';  // ground only, compact 1-texel entry format (forced cache rebuild)

function cellKey(version: string, cellX: number, cellY: number): string {
    return `${version}_${PACK_VERSION_SUFFIX}_${cellX}_${cellY}`;
}

export async function getCachedPackedCell(
    version: string,
    cellX: number,
    cellY: number,
): Promise<CachedPackedCell | null> {
    const db = await openCacheDb();
    await ensureVersionMatches(db, CELL_PACKED_STORE, `${version}_${PACK_VERSION_SUFFIX}`);
    const v = await idbGet<CachedPackedCell>(
        db,
        CELL_PACKED_STORE,
        cellKey(version, cellX, cellY),
    );
    return v ?? null;
}

export async function putCachedPackedCell(
    version: string,
    cellX: number,
    cellY: number,
    value: CachedPackedCell,
): Promise<void> {
    const db = await openCacheDb();
    await idbPut(db, CELL_PACKED_STORE, cellKey(version, cellX, cellY), value);
}
