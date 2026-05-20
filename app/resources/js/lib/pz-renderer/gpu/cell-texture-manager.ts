/**
 * CellTextureManager — упаковывает packed sprite streams всех cells в
 * один большой R32UI texture (`cellAtlas`) + RG32UI mapping
 * `(cellX, cellY) → (offset, length)` в `cellIndex`.
 *
 * Архитектурный выбор: одна большая GPU texture лучше чем N маленьких
 * (один `bindTexture` на весь draw call, никакого texture-swap
 * overhead). Sparse через prefix-sum: empty cells просто имеют length=0
 * в cellIndex.
 *
 * Layout cellAtlas (R32UI):
 *   Линейный u32 stream. Каждые 2 u32 = одна sprite entry (см. types.ts
 *   `ParsedCell`). Адресация через `texelFetch(atlas, ivec2(idx % W, idx / W))`.
 *
 * Layout cellIndex (RG32UI):
 *   2D grid по (cellX - originX, cellY - originY). Texel:
 *     R = offset в cellAtlas (в u32 индексах)
 *     G = length (количество sprite entries × 2 u32)
 *
 * Capacity: WebGL2 max texture = 16384×16384 = 268M texels. Достаточно
 * для ~134M sprite entries (одна cell ~5k entries → ~27k cells fit).
 */

export interface CellTextureManagerOptions {
    gl: WebGL2RenderingContext;
    /** Размер cellAtlas texture в texels. width = atlasWidth, height = atlasHeight. */
    atlasWidth: number;
    atlasHeight: number;
    /** Размер cellIndex grid (макс cells по X/Y). */
    indexGridWidth: number;
    indexGridHeight: number;
    /** Origin cell coords (если карта имеет cells в отрицательных координатах). */
    originCellX: number;
    originCellY: number;
}

export interface CellTextureInfo {
    cellAtlas: WebGLTexture;
    cellIndex: WebGLTexture;
    atlasWidth: number;
    atlasHeight: number;
    indexGridWidth: number;
    indexGridHeight: number;
    originCellX: number;
    originCellY: number;
    /** Сколько entries реально занято в cellAtlas (для статистики). */
    totalEntries: number;
}

export class CellTextureManager {
    private readonly gl: WebGL2RenderingContext;
    private readonly opts: CellTextureManagerOptions;
    private cellAtlas: WebGLTexture;
    private cellIndex: WebGLTexture;
    /** Текущий cursor в cellAtlas (в u32 индексах). */
    private cursor = 0;
    /** Staging для cellIndex: 2 u32 per cell (offset, length). */
    private readonly indexData: Uint32Array;
    /** Pending batches для cellAtlas (FIFO flush в RAF). */
    private pendingAtlasUploads: Array<{
        offset: number;
        data: Uint32Array;
    }> = [];
    /** Пометка какие cells были appended (для commit cellIndex). */
    private pendingIndexUpdates: Array<{ x: number; y: number }> = [];
    /**
     * Per-cell stride bucket offsets. Key = localY × indexGridWidth + localX.
     * Value = Uint32Array(7) где [K] = cumulative entries with strideLevel ≥ K.
     * Render использует это для drawArraysInstanced(..., strideOffsets[K]).
     */
    private readonly strideOffsetsByCell = new Map<number, Uint32Array>();

    constructor(opts: CellTextureManagerOptions) {
        this.gl = opts.gl;
        this.opts = opts;
        this.indexData = new Uint32Array(
            opts.indexGridWidth * opts.indexGridHeight * 2,
        );

        const cellAtlas = this.gl.createTexture();
        const cellIndex = this.gl.createTexture();
        if (!cellAtlas || !cellIndex) {
            throw new Error('[cell-texture] createTexture failed');
        }
        this.cellAtlas = cellAtlas;
        this.cellIndex = cellIndex;

        // cellAtlas — R32UI 2D texture.
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.cellAtlas);
        this.gl.texStorage2D(
            this.gl.TEXTURE_2D,
            1,
            this.gl.R32UI,
            opts.atlasWidth,
            opts.atlasHeight,
        );
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);

        // cellIndex — RG32UI 2D texture.
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.cellIndex);
        this.gl.texStorage2D(
            this.gl.TEXTURE_2D,
            1,
            this.gl.RG32UI,
            opts.indexGridWidth,
            opts.indexGridHeight,
        );
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    }

    /**
     * Аппендит одну cell в cellAtlas + помечает её в cellIndex.
     *
     * Возвращает `true` если cell записана, `false` если был overflow
     * (тогда cell записывается в cellIndex с length=0 и draw call её
     * пропустит).
     */
    append(
        cellX: number,
        cellY: number,
        packed: Uint32Array,
        strideOffsets?: Uint32Array,
    ): boolean {
        const localX = cellX - this.opts.originCellX;
        const localY = cellY - this.opts.originCellY;
        if (
            localX < 0
            || localY < 0
            || localX >= this.opts.indexGridWidth
            || localY >= this.opts.indexGridHeight
        ) {
            console.warn(
                `[cell-texture] cell (${cellX},${cellY}) outside indexGrid origin (${this.opts.originCellX},${this.opts.originCellY})`,
            );
            return false;
        }

        const offset = this.cursor;
        const length = packed.length;
        const totalCapacity = this.opts.atlasWidth * this.opts.atlasHeight;

        const indexIdx = (localY * this.opts.indexGridWidth + localX) * 2;
        this.pendingIndexUpdates.push({ x: localX, y: localY });

        if (offset + length > totalCapacity) {
            // Overflow: помечаем cell как пустую (length=0), draw пропустит.
            // Один раз логируем (повторные overflow в той же сессии нерелевантны).
            if (!this.overflowReported) {
                this.overflowReported = true;
                console.warn(
                    `[cell-texture] atlas overflow: cell (${cellX},${cellY}) с ${length} entries не помещается. Capacity=${totalCapacity}, cursor=${offset}. Дальнейшие cells будут пропущены.`,
                );
            }
            this.indexData[indexIdx] = 0;
            this.indexData[indexIdx + 1] = 0;
            return false;
        }

        this.indexData[indexIdx] = offset;
        this.indexData[indexIdx + 1] = length;
        if (length > 0) {
            this.pendingAtlasUploads.push({ offset, data: packed });
        }
        if (strideOffsets) {
            this.strideOffsetsByCell.set(
                localY * this.opts.indexGridWidth + localX,
                strideOffsets,
            );
        }
        this.cursor += length;
        return true;
    }

    private overflowReported = false;

    /** Сколько cells были скипнуты из-за overflow (для статистики). */
    get hasOverflowed(): boolean {
        return this.overflowReported;
    }

    /**
     * Lookup `(offset, length)` для конкретной cell. Возвращает null
     * если cell вне grid или у неё нет данных.
     *
     * offset в u32 индексах cellAtlas.
     * length = entries × 2 (количество u32 texels).
     */
    getCellInfo(
        cellX: number,
        cellY: number,
    ): {
        offset: number;
        length: number;
        strideOffsets?: Uint32Array;
    } | null {
        const localX = cellX - this.opts.originCellX;
        const localY = cellY - this.opts.originCellY;
        if (
            localX < 0
            || localY < 0
            || localX >= this.opts.indexGridWidth
            || localY >= this.opts.indexGridHeight
        ) {
            return null;
        }
        const idx = (localY * this.opts.indexGridWidth + localX) * 2;
        const offset = this.indexData[idx]!;
        const length = this.indexData[idx + 1]!;
        if (length === 0) return null;
        const strideOffsets = this.strideOffsetsByCell.get(
            localY * this.opts.indexGridWidth + localX,
        );
        return { offset, length, strideOffsets };
    }

    /**
     * Сбрасывает все pending uploads на GPU.
     *
     * Phase 4.3b.2: coalesce contiguous uploads. Cells appended
     * последовательно через cursor — все pending uploads contiguous в
     * cellAtlas. Объединяем в один staging buffer + один upload через
     * uploadAtlasRange (он split'ит per row of cellAtlas). 4000 cells ×
     * 30 row uploads = 120K texSubImage2D → ~100-1000 texSubImage2D.
     *
     * Для cellIndex: один большой texSubImage2D обновляющий весь grid
     * (это всего ~8 MB).
     */
    flush(): void {
        if (this.pendingAtlasUploads.length > 0) {
            this.gl.bindTexture(this.gl.TEXTURE_2D, this.cellAtlas);
            // Pending uploads — contiguous (cursor increments через append).
            // Coalesce в один staging Uint32Array.
            const first = this.pendingAtlasUploads[0]!;
            const startOffset = first.offset;
            let totalLength = 0;
            for (const b of this.pendingAtlasUploads) totalLength += b.data.length;
            const staging = new Uint32Array(totalLength);
            let pos = 0;
            for (const b of this.pendingAtlasUploads) {
                staging.set(b.data, pos);
                pos += b.data.length;
            }
            this.uploadAtlasRange(startOffset, staging);
            this.pendingAtlasUploads.length = 0;
        }

        if (this.pendingIndexUpdates.length > 0) {
            this.gl.bindTexture(this.gl.TEXTURE_2D, this.cellIndex);
            this.gl.texSubImage2D(
                this.gl.TEXTURE_2D,
                0, // level
                0, // xoffset
                0, // yoffset
                this.opts.indexGridWidth,
                this.opts.indexGridHeight,
                this.gl.RG_INTEGER,
                this.gl.UNSIGNED_INT,
                this.indexData,
            );
            this.pendingIndexUpdates.length = 0;
        }

        this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    }

    /** Загрузить произвольный range в cellAtlas (offset в u32 → 2D rect). */
    private uploadAtlasRange(offset: number, data: Uint32Array): void {
        const W = this.opts.atlasWidth;
        let dataPos = 0;
        let remaining = data.length;
        let absOffset = offset;

        while (remaining > 0) {
            const x = absOffset % W;
            const y = Math.floor(absOffset / W);
            // Сколько texels можем загрузить в этой строке (от x до конца строки).
            const lineRemaining = W - x;
            const chunkLen = Math.min(remaining, lineRemaining);
            const chunk = data.subarray(dataPos, dataPos + chunkLen);
            this.gl.texSubImage2D(
                this.gl.TEXTURE_2D,
                0, // level
                x,
                y,
                chunkLen,
                1,
                this.gl.RED_INTEGER,
                this.gl.UNSIGNED_INT,
                chunk,
            );
            dataPos += chunkLen;
            absOffset += chunkLen;
            remaining -= chunkLen;
        }
    }

    /** Текущая информация о текстурах (для shader binding). */
    getInfo(): CellTextureInfo {
        return {
            cellAtlas: this.cellAtlas,
            cellIndex: this.cellIndex,
            atlasWidth: this.opts.atlasWidth,
            atlasHeight: this.opts.atlasHeight,
            indexGridWidth: this.opts.indexGridWidth,
            indexGridHeight: this.opts.indexGridHeight,
            originCellX: this.opts.originCellX,
            originCellY: this.opts.originCellY,
            totalEntries: this.cursor / 2,
        };
    }

    dispose(): void {
        this.gl.deleteTexture(this.cellAtlas);
        this.gl.deleteTexture(this.cellIndex);
        this.pendingAtlasUploads.length = 0;
        this.pendingIndexUpdates.length = 0;
    }
}
