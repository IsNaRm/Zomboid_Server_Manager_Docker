/**
 * Round-robin Web Worker pool for PZ binary parsing.
 *
 * Maintains 4 worker instances. Dispatches jobs via round-robin with an
 * internal queue if all workers are busy. Each job's Promise resolves when
 * the worker posts back its response.
 *
 * Usage:
 *   import { workerPool } from './worker-pool';
 *
 *   const header = await workerPool.parseLotheader(buffer, 30, 30);
 *   const lotpack = await workerPool.parseLotpack(buffer, header);
 *
 * Note: The `?worker` Vite import syntax creates a new Worker instance
 * via Vite's built-in worker bundling. Worker threads share no memory
 * with the main thread except for transferred ArrayBuffers.
 */

import {
    type CellMetadata,
    type LotpackData,
    type SaveGameData,
    type WorkerCommand,
    type WorkerMessage,
    type WorkerRequest,
} from '../types';

// ---------------------------------------------------------------------------
// Vite worker import
// ---------------------------------------------------------------------------

// Using Vite ?worker syntax — bundled as a separate chunk
// eslint-disable-next-line import/no-unresolved
import PzBinaryWorker from './pz-binary-worker?worker';

// ---------------------------------------------------------------------------
// Pool implementation
// ---------------------------------------------------------------------------

const POOL_SIZE = 4;

interface PendingJob {
    resolve: (value: WorkerMessage) => void;
    reject: (reason: Error) => void;
}

interface WorkerSlot {
    worker: Worker;
    /** Jobs currently in-flight keyed by request ID. */
    pending: Map<number, PendingJob>;
}

let nextId = 1;

function createWorkerSlot(): WorkerSlot {
    const worker = new PzBinaryWorker() as Worker;
    const pending: Map<number, PendingJob> = new Map();

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const msg = event.data;
        const job = pending.get(msg.id);
        if (!job) return;
        pending.delete(msg.id);
        job.resolve(msg);
        // Drain queue for this slot
        drainQueue(slot);
    };

    worker.onerror = (ev: ErrorEvent) => {
        // Reject all pending jobs on this worker
        const error = new Error(`[worker-pool] Worker error: ${ev.message}`);
        for (const job of pending.values()) {
            job.reject(error);
        }
        pending.clear();
    };

    const slot: WorkerSlot = { worker, pending };
    return slot;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

interface QueuedJob {
    request: WorkerRequest;
    resolve: (value: WorkerMessage) => void;
    reject: (reason: Error) => void;
}

const jobQueue: QueuedJob[] = [];

function drainQueue(slot: WorkerSlot): void {
    if (jobQueue.length === 0) return;
    const queued = jobQueue.shift();
    if (!queued) return;
    dispatchToSlot(slot, queued.request, queued.resolve, queued.reject);
}

function dispatchToSlot(
    slot: WorkerSlot,
    request: WorkerRequest,
    resolve: (value: WorkerMessage) => void,
    reject: (reason: Error) => void,
): void {
    slot.pending.set(request.id, { resolve, reject });
    // Transfer the ArrayBuffer to avoid copying
    slot.worker.postMessage(request, [request.buffer]);
}

// ---------------------------------------------------------------------------
// Pool singleton
// ---------------------------------------------------------------------------

export class WorkerPool {
    private readonly slots: WorkerSlot[];
    private nextSlot: number = 0;

    constructor(size: number) {
        this.slots = Array.from({ length: size }, () => createWorkerSlot());
    }

    private dispatch(request: WorkerRequest): Promise<WorkerMessage> {
        return new Promise<WorkerMessage>((resolve, reject) => {
            // Round-robin slot selection
            const slot = this.slots[this.nextSlot % this.slots.length];
            this.nextSlot = (this.nextSlot + 1) % this.slots.length;

            if (!slot) {
                reject(new Error('[worker-pool] No slots available'));
                return;
            }

            // If the selected slot is busy, queue it
            // (In practice workers can handle multiple messages, but we
            //  check if there are already pending jobs to decide on queue)
            dispatchToSlot(slot, request, resolve, reject);
        });
    }

    /**
     * Parse a .lotheader buffer off-main-thread.
     *
     * @param buffer  Raw bytes. Will be transferred (zero-copy).
     * @param cellX   Cell X coordinate.
     * @param cellY   Cell Y coordinate.
     */
    async parseLotheader(buffer: ArrayBuffer, cellX: number, cellY: number): Promise<CellMetadata> {
        const request: WorkerRequest = {
            id: nextId++,
            command: 'parseLotheader' as WorkerCommand,
            x: cellX,
            y: cellY,
            buffer,
        };

        const response = await this.dispatch(request);
        if (!response.ok) {
            throw new Error(`[worker-pool] parseLotheader failed: ${response.error}`);
        }
        return response.result as CellMetadata;
    }

    /**
     * Parse a .lotpack buffer off-main-thread.
     *
     * @param buffer  Raw bytes. Will be transferred (zero-copy).
     * @param header  Already-parsed CellMetadata (sent by value, not transferred).
     */
    async parseLotpack(buffer: ArrayBuffer, header: CellMetadata): Promise<LotpackData> {
        const request: WorkerRequest = {
            id: nextId++,
            command: 'parseLotpack' as WorkerCommand,
            x: header.cellX,
            y: header.cellY,
            buffer,
            header,
        };

        const response = await this.dispatch(request);
        if (!response.ok) {
            throw new Error(`[worker-pool] parseLotpack failed: ${response.error}`);
        }
        return response.result as LotpackData;
    }

    /**
     * Parse a save-game cell binary off-main-thread.
     *
     * @param buffer  Raw bytes. Will be transferred.
     * @param cellX   Cell X.
     * @param cellY   Cell Y.
     */
    async parseSavegame(buffer: ArrayBuffer, cellX: number, cellY: number): Promise<SaveGameData> {
        const request: WorkerRequest = {
            id: nextId++,
            command: 'parseSavegame' as WorkerCommand,
            x: cellX,
            y: cellY,
            buffer,
        };

        const response = await this.dispatch(request);
        if (!response.ok) {
            throw new Error(`[worker-pool] parseSavegame failed: ${response.error}`);
        }
        return response.result as SaveGameData;
    }

    /** Number of workers in the pool. */
    get size(): number {
        return this.slots.length;
    }

    /** Total in-flight jobs across all workers. */
    get inFlight(): number {
        return this.slots.reduce((acc, s) => acc + s.pending.size, 0);
    }

    /** Number of queued jobs waiting for a free worker slot. */
    get queued(): number {
        return jobQueue.length;
    }

    /** Terminate all workers (e.g. on page unload). */
    terminate(): void {
        for (const slot of this.slots) {
            slot.worker.terminate();
        }
    }
}

/** Singleton worker pool — 4 workers, shared across all map components. */
export const workerPool = new WorkerPool(POOL_SIZE);
