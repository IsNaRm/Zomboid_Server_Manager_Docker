/**
 * Runtime-tunable knobs for the WebGL map renderer.
 *
 * Exposed via a small UI panel (see render-tuning-panel.tsx) so users
 * can A/B-test stride/LOD trade-offs without touching code or
 * rebuilding the frontend. Settings persist via localStorage.
 *
 * Two independent knobs:
 *
 *   1. Cell-stride: how many cells we collapse into one sampled cell
 *      at extreme zoom-out. stride=N means we fetch & render 1 cell
 *      out of every N×N block, then "smear" it by scaling each sprite
 *      N× in the shader so it covers the area of the skipped cells.
 *
 *   2. LOD pixelsPerSquare thresholds: which atlas LOD activates at
 *      which zoom. lod0 (highest detail) at the top, lod3 (lowest) at
 *      the bottom. Below the smallest threshold we use lod3.
 */

import type { AtlasLodInfo } from './types';

const STORAGE_KEY = 'pz-render-tuning-v1';

/** Available cell-stride choices. `1` = no stride (every cell rendered). */
export const CELL_STRIDE_OPTIONS = [1, 2, 3, 4, 5, 6, 7] as const;
/** Human-friendly label for a stride: "N cells per sample". */
export function cellStrideLabel(stride: number): string {
    return stride === 1 ? '1 (off)' : `${stride * stride} cells/sample`;
}

export interface LodThresholds {
    /** pixelsPerSquare ≥ this → use LOD 0. */
    lod0: number;
    /** pixelsPerSquare ≥ this → use LOD 1. */
    lod1: number;
    /** pixelsPerSquare ≥ this → use LOD 2. */
    lod2: number;
    // Below lod2 threshold → LOD 3.
}

export interface RenderTuning {
    /**
     * User-forced cell-stride. `null` = auto (computed from
     * pixelsPerSquare so each sampled cell covers ≥ 8 screen pixels).
     * Any value > 1 forces a fixed stride at the
     * `forcedStrideThreshold` zoom and below; `auto` is used above.
     */
    forcedCellStride: number | null;
    /**
     * pixelsPerSquare below which the forced stride applies. Above
     * this we always render every cell. Default 1.0 (i.e. one PZ
     * square ≥ 1 screen pixel → no stride needed).
     */
    forcedStrideThreshold: number;
    /** LOD activation thresholds. */
    lodThresholds: LodThresholds;
}

export const DEFAULT_TUNING: RenderTuning = {
    forcedCellStride: null,
    forcedStrideThreshold: 1.0,
    lodThresholds: {
        lod0: 64,
        lod1: 16,
        lod2: 4,
    },
};

function loadFromStorage(): RenderTuning {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_TUNING };
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_TUNING };
        const parsed = JSON.parse(raw) as Partial<RenderTuning>;
        return {
            forcedCellStride: parsed.forcedCellStride ?? null,
            forcedStrideThreshold: parsed.forcedStrideThreshold ?? DEFAULT_TUNING.forcedStrideThreshold,
            lodThresholds: {
                lod0: parsed.lodThresholds?.lod0 ?? DEFAULT_TUNING.lodThresholds.lod0,
                lod1: parsed.lodThresholds?.lod1 ?? DEFAULT_TUNING.lodThresholds.lod1,
                lod2: parsed.lodThresholds?.lod2 ?? DEFAULT_TUNING.lodThresholds.lod2,
            },
        };
    } catch {
        return { ...DEFAULT_TUNING };
    }
}

let current: RenderTuning = loadFromStorage();
const listeners = new Set<(t: RenderTuning) => void>();

/** Current tuning snapshot (mutate via `setRenderTuning`). */
export function getRenderTuning(): RenderTuning {
    return current;
}

export function setRenderTuning(patch: Partial<RenderTuning>): void {
    current = {
        ...current,
        ...patch,
        lodThresholds: {
            ...current.lodThresholds,
            ...(patch.lodThresholds ?? {}),
        },
    };
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
        }
    } catch {
        /* private mode or quota — non-fatal */
    }
    for (const cb of listeners) {
        try {
            cb(current);
        } catch (err) {
            console.warn('[render-tuning] listener threw:', err);
        }
    }
}

export function resetRenderTuning(): void {
    setRenderTuning(DEFAULT_TUNING);
}

/**
 * Subscribe to tuning changes. Returns an unsubscribe function. The
 * webgl layer uses this to invalidate its tile bitmap cache + redraw
 * whenever the user nudges a slider.
 */
export function onRenderTuningChange(cb: (t: RenderTuning) => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

/**
 * Apply tuning's LOD thresholds to a raw pixelsPerSquare value. Mirrors
 * the policy in lod-selection.ts but reads the user's overrides.
 */
export function selectLodFromTuning(
    pixelsPerSquare: number,
    availableLods: AtlasLodInfo[],
): number {
    if (availableLods.length === 0) return 0;
    const { lod0, lod1, lod2 } = current.lodThresholds;
    let preferred: number;
    if (pixelsPerSquare >= lod0) preferred = 0;
    else if (pixelsPerSquare >= lod1) preferred = 1;
    else if (pixelsPerSquare >= lod2) preferred = 2;
    else preferred = 3;
    const maxId = availableLods[availableLods.length - 1]!.id;
    return Math.min(preferred, maxId);
}

/**
 * Compute the effective cell-stride for a given pixelsPerSquare. Honours
 * the user's forced override; otherwise falls back to the auto policy
 * (stride scales inversely with cellPixels so each sampled cell is at
 * least MIN_CELL_PIXELS wide on screen).
 */
export function cellStrideForTuning(
    pixelsPerSquare: number,
    cellSize: number,
    autoMinCellPixels = 8,
): number {
    const cellPixels = pixelsPerSquare * cellSize;
    if (current.forcedCellStride !== null && current.forcedCellStride > 1) {
        return pixelsPerSquare < current.forcedStrideThreshold
            ? current.forcedCellStride
            : 1;
    }
    if (cellPixels >= autoMinCellPixels) return 1;
    return Math.max(1, Math.round(autoMinCellPixels / Math.max(cellPixels, 0.001)));
}
