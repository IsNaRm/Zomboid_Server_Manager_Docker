/**
 * Web Worker for off-main-thread PZ binary parsing.
 *
 * Accepts WorkerRequest messages and posts WorkerMessage responses.
 * The ArrayBuffer in the request is transferred (zero-copy) to avoid copying.
 *
 * Commands:
 *   'parseLotheader' — parse .lotheader buffer → CellMetadata
 *   'parseLotpack'   — parse .lotpack buffer → LotpackData (requires header)
 *   'parseSavegame'  — parse save .bin buffer → SaveGameData
 *
 * Usage in main thread:
 *   import PzWorker from './pz-binary-worker?worker';
 *   const w = new PzWorker();
 */

import { parseLotheader } from '../parsers/lotheader';
import { parseLotpack } from '../parsers/lotpack';
import { parseSavegame } from '../parsers/savegame';
import {
    type WorkerErrorResponse,
    type WorkerMessage,
    type WorkerRequest,
    type WorkerResponse,
} from '../types';

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
    const { id, command, x, y, buffer, header } = event.data;

    try {
        let result: WorkerResponse['result'];

        switch (command) {
            case 'parseLotheader': {
                result = parseLotheader(buffer, x, y);
                break;
            }

            case 'parseLotpack': {
                if (!header) {
                    throw new Error('[pz-worker] parseLotpack requires header');
                }
                result = parseLotpack(buffer, header);
                break;
            }

            case 'parseSavegame': {
                result = parseSavegame(buffer);
                break;
            }

            default: {
                // TypeScript exhaustiveness check
                const _exhaustive: never = command;
                throw new Error(`[pz-worker] Unknown command: ${String(_exhaustive)}`);
            }
        }

        const response: WorkerResponse = { id, command, ok: true, result };
        // Transfer nothing back — result is a plain object, not an ArrayBuffer
        self.postMessage(response);
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const response: WorkerErrorResponse = { id, command, ok: false, error };
        self.postMessage(response);
    }
};
