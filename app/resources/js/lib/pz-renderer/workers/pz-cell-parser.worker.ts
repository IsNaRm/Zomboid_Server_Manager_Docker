/**
 * Web Worker entry для парсинга PZ cell binaries.
 *
 * Stateless после init: получает sprite name → id mapping один раз через
 * `WorkerInitMessage`, далее на каждый `WorkerParseMessage` возвращает
 * packed Uint32Array (sprite stream для cellAtlas).
 *
 * Никаких retained state map'ов cellData, никаких LRU. Воркер — pure
 * функция input → output. После init phase main thread terminate'ит pool.
 */

import { parseLotheader } from './lotheader-parser';
import { packLotpackEntries, parseLotpack } from './lotpack-parser';
import type {
    WorkerMessageIn,
    WorkerMessageOut,
} from '../types';

const spriteNameToId = new Map<string, number>();

const post = self as unknown as {
    postMessage(msg: WorkerMessageOut, transfer?: Transferable[]): void;
};

self.onmessage = (ev: MessageEvent<WorkerMessageIn>) => {
    const msg = ev.data;

    if (msg.type === 'init') {
        spriteNameToId.clear();
        for (const [name, id] of msg.spriteNameToId) {
            spriteNameToId.set(name, id);
        }
        return;
    }

    if (msg.type !== 'parse') return;

    const { taskId, cellX, cellY, headerBuf, lotpackBuf } = msg;

    try {
        const t0 = performance.now();
        const header = parseLotheader(headerBuf, /* includeOverlays */ false);
        const lotpack = parseLotpack(lotpackBuf, {
            minLayer: header.minLayer,
            maxLayer: header.maxLayer,
            blockSize: header.blockSize,
            cellSizeInBlocks: header.cellSizeInBlocks,
        });
        // Keep ТОЛЬКО ground layer (layer=0). VRAM economy 4×: atlas 8192h
        // вместо 16384h = 512MB вместо 1GB. Upper floors можно включить
        // через UI toggle (отдельная подгрузка из IDB cache).
        const { packed, entriesCount, strideOffsets } = packLotpackEntries(
            lotpack,
            header.cellSizeInBlocks,
            header.spriteNames,
            spriteNameToId,
            { keepMinLayer: 0, keepMaxLayer: 1 },
        );
        const parseTimeMs = performance.now() - t0;

        const buf = packed.buffer as ArrayBuffer;
        const offsetsBuf = strideOffsets.buffer as ArrayBuffer;
        post.postMessage(
            {
                type: 'parse-result',
                taskId,
                cellX,
                cellY,
                packed: buf,
                entriesCount,
                strideOffsets: offsetsBuf,
                parseTimeMs,
            },
            [buf, offsetsBuf],
        );
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        post.postMessage({
            type: 'error',
            taskId,
            error: `parse cell (${cellX},${cellY}): ${error}`,
        });
    }
};
