/**
 * PzGLRenderer — WebGL2 tile renderer for Project Zomboid maps.
 *
 * Architecture (post-rewrite for multi-page atlas + batched drawing):
 *  - Atlas lives in a TEXTURE_2D_ARRAY (one layer per page in sprites.json).
 *  - Every sprite-on-square pair is a single GPU instance carrying its own
 *    UV rect, atlas layer index and half-water flag in vertex attributes.
 *  - A single drawArraysInstanced call paints all instances for one tile
 *    (sorted by paint order so alpha compositing stays correct).
 */

import vertSrc from './shaders/tile.vert.glsl?raw';
import fragSrc from './shaders/tile.frag.glsl?raw';

import { createGL2Context, type GL2Context } from './gl/context';
import { createProgram, setUniform1i, setUniform1f, setUniform2f, setUniform1b } from './gl/shaders';
import {
    createTileBuffers,
    uploadInstanceData,
    destroyTileBuffers,
    INSTANCE_STRIDE_F32,
    type TileBuffers,
    type AttribLocations,
} from './gl/buffers';
import { bindAtlasArray } from './gl/textures';

import type { CellData, SpriteIndex, DziProjection, SaveGameData } from './types';
import { isHalfWater } from './sprite-lookup';
import { type PlantsConfig, PlantsInfo, remapSpriteName, defaultPlantsInfo } from './plants-config';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TileRenderInput {
    z: number;
    x: number;
    y: number;
    /** Canvas size in pixels (256). */
    tileSize: number;
    /** Parsed cell data covering this tile. */
    cells: CellData[];
    /** TEXTURE_2D_ARRAY containing every atlas page as a layer. */
    atlas: WebGLTexture;
    /** Sprite name → entry (with atlas page index + UV rects per mip). */
    spriteIndex: SpriteIndex;
    /** DZI projection parameters. */
    projection: DziProjection;
    /** Atlas page width in pixels (normalises sprite UVs). Default 4096. */
    atlasWidth?: number;
    /** Atlas page height in pixels. Default 4096. */
    atlasHeight?: number;
    /** Optional seasonal plants remap. */
    plantsConfig?: PlantsConfig;
    /**
     * Optional set of atlas page indices already uploaded to the GPU.
     * Instances referring to pages outside this set are skipped.
     */
    availablePages?: Set<number> | null;
    /**
     * Inclusive PZ layer range to render. Default {min:0, max:0} — only the
     * ground floor. Pass higher max to include upper floors / roofs.
     */
    layerRange?: { min: number; max: number };
}

/** Fallback cell-edge size in PZ squares when no cell data is loaded. */
const DEFAULT_CELL_SIZE_IN_SQUARES = 256;

/**
 * Largest divisor of `n` that is ≤ `target`. Always returns ≥ 1.
 *
 * Used to pick a `decimateStep` that divides `cellEdge` evenly — otherwise
 * the iteration `for (wsx = 0; wsx < cellEdge; wsx += step)` skips a strip
 * of (cellEdge mod step) squares on the right/bottom of every cell, which
 * shows up as grey triangular holes on the bottom of the iso-projected
 * rhombus at far zoom-out.
 */
export function pickDivisorAtMost(n: number, target: number): number {
    const cap = Math.max(1, Math.min(n | 0, target | 0));
    for (let d = cap; d >= 1; d--) {
        if (n % d === 0) { return d; }
    }
    return 1;
}

// ---------------------------------------------------------------------------
// Uniform names
// ---------------------------------------------------------------------------

const U = {
    atlas: 'u_atlas',
    tileOriginSq: 'u_tileOriginSq',
    tileSize: 'u_tileSize',
    canvasSize: 'u_canvasSize',
    sqr: 'u_sqr',
    isometric: 'u_isometric',
    worldOriginPx: 'u_worldOriginPx',
    pixelsPerSquare: 'u_pixelsPerSquare',
    cellSizeInSquares: 'u_cellSizeInSquares',
    nativeToEffective: 'u_nativeToEffective',
} as const;

// ---------------------------------------------------------------------------
// Renderer class
// ---------------------------------------------------------------------------

export class PzGLRenderer {
    private ctx: GL2Context | null = null;
    private program: WebGLProgram | null = null;
    private buffers: TileBuffers | null = null;
    private attribs: AttribLocations | null = null;
    private instanceData: Float32Array = new Float32Array(8192 * INSTANCE_STRIDE_F32);
    private _disposed = false;
    /** Diagnostic counter — log a few tiles in detail then go quiet. */
    private _diagTilesLogged = 0;
    private static readonly DIAG_TILES_TO_LOG = 5;

    private _plantsCache = new Map<string, PlantsInfo>();

    constructor(private readonly canvas: HTMLCanvasElement) {}

    getGLContext(): WebGL2RenderingContext | null {
        return this.ctx?.gl ?? null;
    }

    async init(): Promise<boolean> {
        if (this._disposed) { return false; }

        const ctx = createGL2Context(this.canvas);
        if (!ctx) { return false; }
        this.ctx = ctx;
        const { gl } = ctx;

        if (gl.getError() !== gl.NO_ERROR) { return false; }

        try {
            this.program = createProgram(gl, vertSrc, fragSrc);
        } catch (e) {
            console.error(e);
            return false;
        }

        const attribs: AttribLocations = {
            a_quadCoord:  gl.getAttribLocation(this.program, 'a_quadCoord'),
            a_squareX:    gl.getAttribLocation(this.program, 'a_squareX'),
            a_squareY:    gl.getAttribLocation(this.program, 'a_squareY'),
            a_cellX:      gl.getAttribLocation(this.program, 'a_cellX'),
            a_cellY:      gl.getAttribLocation(this.program, 'a_cellY'),
            a_spriteUV:   gl.getAttribLocation(this.program, 'a_spriteUV'),
            a_atlasLayer: gl.getAttribLocation(this.program, 'a_atlasLayer'),
            a_halfWater:  gl.getAttribLocation(this.program, 'a_halfWater'),
            a_spriteW:    gl.getAttribLocation(this.program, 'a_spriteW'),
            a_spriteH:    gl.getAttribLocation(this.program, 'a_spriteH'),
            a_offsetX:    gl.getAttribLocation(this.program, 'a_offsetX'),
            a_offsetY:    gl.getAttribLocation(this.program, 'a_offsetY'),
        };
        this.attribs = attribs;

        this.buffers = createTileBuffers(gl, attribs);

        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);

        return gl.getError() === gl.NO_ERROR;
    }

    renderTile(input: TileRenderInput): HTMLCanvasElement {
        if (!this.ctx || !this.program || !this.buffers) {
            throw new Error('[pz-renderer] Renderer not initialised — call init() first');
        }

        const { gl } = this.ctx;
        const { tileSize, cells, atlas, spriteIndex, projection } = input;
        const atlasWidth = input.atlasWidth ?? 4096;
        const atlasHeight = input.atlasHeight ?? 4096;
        const plantsInfo = this._resolvePlantsInfo(input.plantsConfig);

        if (this.canvas.width !== tileSize || this.canvas.height !== tileSize) {
            this.canvas.width = tileSize;
            this.canvas.height = tileSize;
        }

        gl.viewport(0, 0, tileSize, tileSize);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(this.program);

        bindAtlasArray(gl, atlas, 0);
        setUniform1i(gl, this.program, U.atlas, 0);

        const pixelsPerSquare = this._computePixelsPerSquare(input, projection);
        const tileOriginSq = this._computeTileOriginSquares(input, projection);
        const cellSizeInSquares = this._cellSizeFromCells(cells);
        const worldOriginX = projection.worldX0 ?? projection.x0;
        const worldOriginY = projection.worldY0 ?? projection.y0;

        // pzmap2dzi native pixel → effective DZI pixel scale. Falls back to
        // 1.0 if the backend didn't supply it (treat as already-effective).
        const nativeToEffective = projection.nativeToEffective ?? 1.0;

        // Default to ground floor only — multi-floor stacking would obscure
        // the lower one. Caller (pz-map.tsx) can pass a different range.
        const layerRange = input.layerRange ?? { min: 0, max: 0 };

        setUniform2f(gl, this.program, U.tileOriginSq, tileOriginSq[0], tileOriginSq[1]);
        setUniform2f(gl, this.program, U.tileSize, tileSize, tileSize);
        setUniform2f(gl, this.program, U.canvasSize, tileSize, tileSize);
        setUniform1f(gl, this.program, U.sqr, projection.sqr);
        setUniform1b(gl, this.program, U.isometric, projection.isometric);
        setUniform2f(gl, this.program, U.worldOriginPx, worldOriginX, worldOriginY);
        setUniform1f(gl, this.program, U.pixelsPerSquare, pixelsPerSquare);
        setUniform1f(gl, this.program, U.cellSizeInSquares, cellSizeInSquares);
        setUniform1f(gl, this.program, U.nativeToEffective, nativeToEffective);

        const verbose = this._diagTilesLogged < PzGLRenderer.DIAG_TILES_TO_LOG && cells.length > 0;
        const instanceCount = this._collectInstances(
            cells, spriteIndex, plantsInfo, atlasWidth, atlasHeight,
            input.availablePages ?? null,
            layerRange,
            cellSizeInSquares,
            pixelsPerSquare,
            verbose,
        );

        if (instanceCount === 0) {
            if (verbose) {
                console.log(`[DBG][render] tile z=${input.z} x=${input.x} y=${input.y} cells=${cells.length} → 0 instances, skipped draw`);
                this._diagTilesLogged++;
            }
            gl.flush();
            return this.canvas;
        }

        uploadInstanceData(gl, this.buffers, this.instanceData, instanceCount);

        gl.bindVertexArray(this.buffers.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instanceCount);
        gl.bindVertexArray(null);

        const err = gl.getError();
        if (err !== gl.NO_ERROR) {
            console.warn(`[DBG][render] GL error after draw (tile ${input.z}/${input.x}/${input.y}): 0x${err.toString(16)}`);
        } else if (verbose) {
            console.log(`[DBG][render] tile z=${input.z} x=${input.x} y=${input.y} cells=${cells.length} instances=${instanceCount} → drew OK`);
            this._diagTilesLogged++;
        }

        gl.flush();
        return this.canvas;
    }

    /**
     * No-op until B42 savegame sprite extraction lands (pzdataspec dependency).
     */
    renderSaveOverlay(_input: TileRenderInput, _saveData: SaveGameData | null): HTMLCanvasElement {
        return this.canvas;
    }

    dispose(): void {
        if (this._disposed) { return; }
        this._disposed = true;
        const gl = this.ctx?.gl;
        if (gl) {
            if (this.buffers) { destroyTileBuffers(gl, this.buffers); }
            if (this.program) { gl.deleteProgram(this.program); }
        }
        this.ctx = null;
        this.program = null;
        this.buffers = null;
        this._plantsCache.clear();
    }

    // ---------------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------------

    private _resolvePlantsInfo(conf: PlantsConfig | undefined): PlantsInfo {
        if (!conf) { return defaultPlantsInfo; }
        const key = JSON.stringify(conf);
        let info = this._plantsCache.get(key);
        if (!info) {
            info = new PlantsInfo(conf);
            this._plantsCache.set(key, info);
        }
        return info;
    }

    private _computePixelsPerSquare(input: TileRenderInput, proj: DziProjection): number {
        const zoomDelta = input.z - proj.maxNativeZoom;
        return proj.sqr * Math.pow(2, zoomDelta);
    }

    /**
     * Top-left world-square coordinate of this Leaflet tile. Matches the
     * world-square system used by the shader's worldSX = a_cellX * cellSize
     * + a_squareX, so the inverse subtracts worldX0/worldY0.
     */
    private _computeTileOriginSquares(input: TileRenderInput, proj: DziProjection): [number, number] {
        const { z, x, y, tileSize } = input;

        const tilePixelX = x * tileSize;
        const tilePixelY = y * tileSize;
        const scale = Math.pow(2, proj.maxNativeZoom - z);
        const dziX = tilePixelX * scale;
        const dziY = tilePixelY * scale;

        const worldX0 = proj.worldX0 ?? proj.x0;
        const worldY0 = proj.worldY0 ?? proj.y0;

        if (proj.isometric) {
            const halfSqr = proj.sqr / 2;
            const quarterSqr = proj.sqr / 4;
            const pxAdj = (dziX - worldX0) / halfSqr;
            const pyAdj = (dziY - worldY0 - quarterSqr) / quarterSqr;
            const sx = (pxAdj + pyAdj) / 2;
            const sy = (pyAdj - pxAdj) / 2;
            return [sx, sy];
        }
        return [
            (dziX - worldX0) / proj.sqr,
            (dziY - worldY0) / proj.sqr,
        ];
    }

    private _cellSizeFromCells(cells: CellData[]): number {
        const first = cells[0];
        if (!first) { return DEFAULT_CELL_SIZE_IN_SQUARES; }
        return first.header.cellSizeInBlocks * first.header.blockSize;
    }

    /**
     * Pack every visible (square, sprite) pair into the instance buffer.
     * Returns the total instance count actually written.
     *
     * Order is layer-ascending then sprite-stack ascending so alpha blending
     * paints lower sprites first.
     */
    private _collectInstances(
        cells: CellData[],
        spriteIndex: SpriteIndex,
        plantsInfo: PlantsInfo,
        atlasWidth: number,
        atlasHeight: number,
        availablePages: Set<number> | null,
        layerRange: { min: number; max: number },
        cellSizeInSquares: number,
        pixelsPerSquare: number,
        verbose: boolean,
    ): number {
        // Overview LOD strategy: when one PZ square covers < 1 screen pixel
        // we get massive overdraw + sub-pixel aliasing (the "triangle"
        // artefacts on zoom-out). Two defenses:
        //   1. Pick a smaller mip from each sprite's pre-baked mip chain
        //      so the atlas sample matches the on-screen size.
        //   2. Decimate: draw only every Nth square; the remaining squares
        //      visually represent their neighbours at sub-pixel scales.
        // Both kick in only when pixelsPerSquare < 1.
        //
        // The step MUST divide cellEdge evenly — otherwise the loop
        // `wsx < cellEdge` stops short of the right edge by (cellEdge mod
        // step) squares, and that strip becomes the bottom-right grey
        // triangle artefact in the iso projection.
        const targetMipPx = Math.max(1, pixelsPerSquare * 2); // sample at ≥1 atlas px per screen px
        const targetStep = pixelsPerSquare >= 1
            ? 1
            : Math.max(1, Math.round(1 / pixelsPerSquare));
        const decimateStep = pickDivisorAtMost(cellSizeInSquares, targetStep);
        // Single-pass write directly into the shared instance buffer. No
        // per-cell allocations, no two-pass count+fill, no intermediate
        // arrays — the GC was killing us with anything else.
        //
        // The buffer GROWS dynamically when full. A static cap (with `break`
        // on overflow) produced the bottom-right grey triangle: the outer
        // loop iterates `wsx` from 0 → cellEdge, so dropped instances
        // accumulate on high-`wsx` squares, which project to the right-bottom
        // edge of every cell rhombus in the iso projection. A single dense
        // cell (e.g. an urban one with multi-floor sprite stacks) needs
        // ~200K instances on the ground layer alone — the old 16384 / cell
        // estimate clipped ~92% of them.
        //
        // The first call still pre-allocates a sensible starting size based
        // on average cell density; subsequent calls reuse whatever ended up
        // being needed (the buffer only ever grows across the renderer's
        // lifetime, so steady-state is one Float32Array allocation).
        const estimateInstances = Math.max(8192, cells.length * 65536);
        const initialNeed = estimateInstances * INSTANCE_STRIDE_F32;
        if (this.instanceData.length < initialNeed) {
            this.instanceData = new Float32Array(initialNeed);
        }
        let data = this.instanceData;
        let cap = (data.length / INSTANCE_STRIDE_F32) | 0;

        const ensureCapacity = (need: number): void => {
            if (need <= cap) { return; }
            let newCap = cap;
            while (newCap < need) { newCap *= 2; }
            const grown = new Float32Array(newCap * INSTANCE_STRIDE_F32);
            grown.set(data);
            this.instanceData = grown;
            data = grown;
            cap = newCap;
        };

        let n = 0;
        let spritesAttempted = 0;
        let spritesMatched = 0;
        let spritesMissing = 0;
        let spritesSkippedPage = 0;
        const missingNamesSample: string[] = [];

        for (const cell of cells) {
            const { cellX, cellY, header, cell: squareLayerData } = cell;
            const { cellSizeInBlocks, blockSize, minLayer, maxLayer } = header;
            const lp = squareLayerData.lotpack;

            const lMin = Math.max(minLayer, layerRange.min);
            const lMax = Math.min(maxLayer - 1, layerRange.max);

            const cellEdge = cellSizeInBlocks * blockSize;

            for (let layer = lMin; layer <= lMax; layer++) {
                const layerIdx = layer - minLayer;

                // World-square step iteration. For decimateStep=1 we walk
                // every square (no skip); for high steps (overview zooms) we
                // visit only one in N², which is N² less work — critical so
                // a viewport spanning the whole map doesn't freeze the UI.
                for (let wsx = 0; wsx < cellEdge; wsx += decimateStep) {
                    const bx = (wsx / blockSize) | 0;
                    const lsx = wsx - bx * blockSize;
                    for (let wsy = 0; wsy < cellEdge; wsy += decimateStep) {
                        const by = (wsy / blockSize) | 0;
                        const lsy = wsy - by * blockSize;

                        const blockData = lp.blocks[bx * cellSizeInBlocks + by];
                        if (!blockData) continue;
                        const layerData = blockData[layerIdx];
                        if (!layerData) continue;
                        const col = layerData[lsx];
                        if (!col) continue;
                        const spriteIndices = col[lsy];
                        if (!spriteIndices || spriteIndices.length === 0) continue;

                        for (let ii = 0; ii < spriteIndices.length; ii++) {
                            const idx = spriteIndices[ii]!;
                            const originalName = header.spriteNames[idx];
                            if (!originalName) continue;
                            const resolvedNames = remapSpriteName(originalName, plantsInfo);
                            for (let rn = 0; rn < resolvedNames.length; rn++) {
                                const name = resolvedNames[rn]!;
                                spritesAttempted++;
                                const entry = spriteIndex.get(name);
                                if (!entry || entry.mips.length === 0) {
                                    spritesMissing++;
                                    if (missingNamesSample.length < 5
                                        && !missingNamesSample.includes(name)) {
                                        missingNamesSample.push(name);
                                    }
                                    continue;
                                }
                                if (availablePages !== null && !availablePages.has(entry.atlas)) {
                                    spritesSkippedPage++;
                                    continue;
                                }
                                if (n >= cap) { ensureCapacity(n + 1); }
                                spritesMatched++;

                                // Sprite ALWAYS rendered at native pixel size (mips[0]);
                                // pick a smaller mip rect only for UV sampling to kill
                                // minification aliasing at low zoom.
                                const nativeMip = entry.mips[0]!;
                                let sampleMip = nativeMip;
                                if (targetMipPx < sampleMip.w) {
                                    for (let mi = 1; mi < entry.mips.length; mi++) {
                                        const next = entry.mips[mi]!;
                                        if (next.w >= targetMipPx) {
                                            sampleMip = next;
                                        } else {
                                            break;
                                        }
                                    }
                                }
                                const off = n * INSTANCE_STRIDE_F32;
                                data[off +  0] = wsx;
                                data[off +  1] = wsy;
                                data[off +  2] = cellX;
                                data[off +  3] = cellY;
                                data[off +  4] = sampleMip.u / atlasWidth;
                                data[off +  5] = sampleMip.v / atlasHeight;
                                data[off +  6] = sampleMip.w / atlasWidth;
                                data[off +  7] = sampleMip.h / atlasHeight;
                                data[off +  8] = entry.atlas;
                                data[off +  9] = isHalfWater(name) ? 1.0 : 0.0;
                                data[off + 10] = nativeMip.w;
                                data[off + 11] = nativeMip.h;
                                data[off + 12] = entry.offset_x;
                                data[off + 13] = entry.offset_y;
                                n++;
                            }
                        }
                    }
                }
            }
        }

        if (verbose) {
            console.log(
                `[DBG][collect] cells=${cells.length} instances=${n} `
                + `attempted=${spritesAttempted} matched=${spritesMatched} `
                + `missing=${spritesMissing} pageSkipped=${spritesSkippedPage} `
                + `layerRange=[${layerRange.min}..${layerRange.max}]`
                + (missingNamesSample.length > 0 ? ` sampleMissing=${JSON.stringify(missingNamesSample)}` : ''),
            );
        }

        return n;
    }
}
