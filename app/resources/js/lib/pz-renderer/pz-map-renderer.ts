/**
 * PzMapRenderer — корневой объект рендерера карты.
 *
 * State machine: idle → fetching-manifests → preloading-atlas → preloading-cells
 *                → finalizing → ready → disposed/error/cancelled.
 *
 * Phase 1 (текущая): только manifest + atlas preload + debug viewer одной
 * atlas page. Без cells, без rendering карты.
 *
 * Phase 2-6 расширят: cell preload, vertex shader instance gen, Leaflet layer.
 */

import debugVertSrc from './shaders/debug-atlas.vert.glsl?raw';
import debugFragSrc from './shaders/debug-atlas.frag.glsl?raw';
import mainVertSrc from './shaders/pz-map.vert.glsl?raw';
import mainFragSrc from './shaders/pz-map.frag.glsl?raw';

import { createGlContext, WebGL2NotSupportedError } from './gpu/gl-context';
import {
    compileShaderProgram,
    destroyShaderProgram,
    type CompiledShaderProgram,
} from './gpu/shader-program';
import { CellTextureManager } from './gpu/cell-texture-manager';
import {
    buildSpriteInfoTexture,
    type SpriteInfoTexture,
} from './gpu/sprite-info-texture';
import { AtlasLoader, type LodTexture } from './loaders/atlas-loader';
import { CellLoader, buildSpriteNameToId, type CellLoaderStats } from './loaders/cell-loader';
import { loadAllManifests, type AllManifests } from './loaders/manifest-loader';
import { cellBoundsInPixels, makeOrthoMatrix } from './utils/coords';
import { ProgressAggregator } from './utils/progress';
import { WorkerPool } from './workers/worker-pool';
import type {
    GlCapabilities,
    PzMapRendererOptions,
    RendererState,
} from './types';

/**
 * Дебаг-режим для Phase 3: 'atlas' = просмотр atlas pages, 'cell' = рендер
 * одной cell во весь canvas (sprite-perfect view для верификации шейдеров).
 */
export type DebugMode = 'atlas' | 'cell';

/** Текущая фаза для debug HUD. */
interface DebugViewState {
    mode: DebugMode;
    // 'atlas' params:
    lod: number;
    page: number;
    brightness: number;
    // 'cell' params:
    cellX: number;
    cellY: number;
    isometric: boolean;
    sqr: number;
    pps: number;
    /** Показывать этажи 0..maxFloor. Slider 0..3. */
    maxFloor: number;
    /** Высота одного этажа в native px. PZ B42 стандарт ≈ 96 (= 1.5×sqr),
     *  но точное значение проверяется визуально — slider в UI. */
    floorHeightPx: number;
    /** Pan offset в native pixels. Прибавляется к cell center при
     *  построении ortho. Mouse drag в pz-map-view.tsx инкрементирует. */
    panX: number;
    panY: number;
    /** Skip cells: при cellStride=N рендерим только cells где
     *  (cx-min) % stride == 0 && (cy-min) % stride == 0. CPU side. */
    cellStride: number;
    /** Skip sprites внутри cell: vertex shader делает collapse если
     *  sx % stride != 0 или sy % stride != 0. Оставшиеся sprites
     *  scaled × stride чтобы closure gaps. */
    squareStride: number;
    /** 0 = normal, 1 = magenta solid, 2 = UV gradient. */
    fragDebug: number;
}

export class PzMapRenderer {
    private readonly opts: PzMapRendererOptions;
    private gl: WebGL2RenderingContext | null = null;
    private capabilities: GlCapabilities | null = null;
    private manifests: AllManifests | null = null;
    private atlasLoader: AtlasLoader | null = null;
    private atlasTextures: Map<number, LodTexture> | null = null;
    private debugProgram: CompiledShaderProgram | null = null;
    private mainProgram: CompiledShaderProgram | null = null;
    private debugVao: WebGLVertexArrayObject | null = null;
    private cellTextureMgr: CellTextureManager | null = null;
    private spriteInfoTex: SpriteInfoTexture | null = null;
    private workerPool: WorkerPool | null = null;
    private cellStats: CellLoaderStats | null = null;

    private state: RendererState = 'idle';
    private readonly progress: ProgressAggregator;
    private rafHandle: number | null = null;
    private debugView: DebugViewState = {
        mode: 'atlas',
        lod: 0,
        page: 0,
        brightness: 1.0,
        cellX: 0,
        cellY: 0,
        isometric: true,
        sqr: 64,
        pps: 1.0,
        maxFloor: 3,
        floorHeightPx: 192,
        panX: 0,
        panY: 0,
        cellStride: 1,
        squareStride: 1,
        fragDebug: 0,
    };

    constructor(opts: PzMapRendererOptions) {
        this.opts = opts;
        this.progress = new ProgressAggregator(
            [
                { name: 'manifests', weight: 0.05, label: 'Загрузка манифестов' },
                { name: 'atlas', weight: 0.40, label: 'Загрузка атласа' },
                { name: 'cells', weight: 0.50, label: 'Загрузка карты' },
                { name: 'finalize', weight: 0.05, label: 'Подготовка GPU' },
            ],
            (snapshot) => this.opts.onProgress?.(snapshot),
            100,
        );
    }

    /** Текущее состояние state machine. */
    getState(): RendererState {
        return this.state;
    }

    /** Доступ к загруженным манифестам (для debug UI). */
    getManifests(): AllManifests | null {
        return this.manifests;
    }

    /** Сколько pages в атласе (для UI слайдера). */
    getPageCount(): number {
        return this.manifests?.atlas.atlas_count ?? 0;
    }

    /** Сколько LOD уровней (для UI слайдера). */
    getLodCount(): number {
        return this.manifests?.atlas.lods.length ?? 0;
    }

    /** Статистика загруженных cells (для debug HUD). */
    getCellStats(): CellLoaderStats | null {
        return this.cellStats;
    }

    /** Информация про cell texture (для debug HUD). */
    getCellTextureInfo() {
        return this.cellTextureMgr?.getInfo() ?? null;
    }

    /**
     * Запустить полный init pipeline. Завершается переходом в 'ready'
     * (вызывает opts.onReady) или в 'error' (вызывает opts.onError).
     */
    async init(): Promise<void> {
        const { canvas, signal } = this.opts;
        try {
            this.setState('fetching-manifests');
            this.progress.enterPhase('manifests');

            // 1. GL context.
            const ctx = createGlContext(canvas);
            this.gl = ctx.gl;
            this.capabilities = ctx.capabilities;

            // 2. Manifests parallel fetch.
            this.manifests = await loadAllManifests({
                atlasBaseUrl: this.opts.atlasBaseUrl,
                cellsBaseUrl: this.opts.cellsBaseUrl,
                chunksBaseUrl: '/pz-cell-data',
                signal,
            });
            this.progress.setPhaseProgress('manifests', 1);

            // 3. Atlas preload.
            this.setState('preloading-atlas');
            this.progress.enterPhase('atlas');

            let totalBytes = this.manifests.atlas.total_bytes;
            // total_bytes из manifest — суммарный размер всех LOD WebP.
            // Если 0 — fallback к оценке.
            if (!totalBytes || totalBytes < 1024) {
                totalBytes = this.manifests.atlas.atlas_count
                    * this.manifests.atlas.lods.reduce(
                        (sum, l) => sum + l.size * l.size * 4,
                        0,
                    );
            }
            let bytesLoaded = 0;
            let pagesLoaded = 0;
            // Phase 4.3b.4: progress показывается по initial LOD только.
            const initialLod = 0;
            const initialPages = this.manifests.atlas.atlas_count;

            this.atlasLoader = new AtlasLoader({
                gl: this.gl,
                capabilities: this.capabilities,
                manifest: this.manifests.atlas,
                atlasBaseUrl: this.opts.atlasBaseUrl,
                signal,
                onPageLoaded: (_pageId, lod) => {
                    if (lod === initialLod) {
                        pagesLoaded++;
                        this.progress.setPhaseProgress(
                            'atlas',
                            pagesLoaded / initialPages,
                        );
                    }
                },
                onBytes: (bytes) => {
                    bytesLoaded += bytes;
                },
            });
            // Грузим только active LOD (default 0). Остальные — в фоне после ready.
            this.atlasTextures = await this.atlasLoader.loadInitialLod(initialLod);
            this.progress.setPhaseProgress('atlas', 1);
            void bytesLoaded; // используется для будущих ETA метрик

            // Background load остальных LODs — не блокирует init.
            const atlasLoaderRef = this.atlasLoader;
            void atlasLoaderRef
                .loadOthersInBackground(initialLod)
                .catch((err) => {
                    if ((err as Error).name === 'AbortError') return;
                    console.warn('[renderer] background LOD load:', err);
                });

            // 4. Cells preload (Phase 2).
            this.setState('preloading-cells');
            this.progress.enterPhase('cells');

            // Compute cell bounds для CellTextureManager.
            const cellCoords = this.manifests.cells.cells;
            let minCx = Infinity;
            let minCy = Infinity;
            let maxCx = -Infinity;
            let maxCy = -Infinity;
            for (const [cx, cy] of cellCoords) {
                if (cx < minCx) minCx = cx;
                if (cy < minCy) minCy = cy;
                if (cx > maxCx) maxCx = cx;
                if (cy > maxCy) maxCy = cy;
            }
            if (cellCoords.length === 0) {
                minCx = 0;
                minCy = 0;
                maxCx = 0;
                maxCy = 0;
            }

            const indexGridWidth = Math.max(1, maxCx - minCx + 1);
            const indexGridHeight = Math.max(1, maxCy - minCy + 1);
            // cellAtlas size: до 16384×16384 R32UI (= 268M texels = 1 GB).
            // При keepMaxLayer=4 (4 этажа) ожидаемый объём entries ≈
            // 100-130M (ground 67M + sparse upper floors). 268M = двойной
            // запас. Phase 4 (streaming) уберёт необходимость хранить
            // всё одновременно.
            const maxTex = this.capabilities.maxTextureSize;
            const ATLAS_WIDTH = Math.min(16384, maxTex);
            const ATLAS_HEIGHT = Math.min(16384, maxTex);

            this.cellTextureMgr = new CellTextureManager({
                gl: this.gl,
                atlasWidth: ATLAS_WIDTH,
                atlasHeight: ATLAS_HEIGHT,
                indexGridWidth,
                indexGridHeight,
                originCellX: minCx,
                originCellY: minCy,
            });

            // Worker pool + sprite name → id mapping.
            this.workerPool = new WorkerPool();
            const spriteNameToId = buildSpriteNameToId(this.manifests.sprites);
            this.workerPool.initSpriteIndex(spriteNameToId);

            // Phase 4.3b.3: progressive ready. Cell loading в background;
            // ready после первых N cells. Сначала промис на этот сигнал.
            let firstReadyResolve!: () => void;
            const firstReadyPromise = new Promise<void>((r) => {
                firstReadyResolve = r;
            });

            const cellLoader = new CellLoader({
                pool: this.workerPool,
                textureMgr: this.cellTextureMgr,
                cellsManifest: this.manifests.cells,
                cellsBaseUrl: this.opts.cellsBaseUrl,
                atlasVersion: this.manifests.atlas.version,
                signal,
                onCellProgress: (loaded, total) => {
                    this.progress.setPhaseProgress('cells', loaded / total);
                },
                progressiveReadyThreshold: 100,
                onProgressiveReady: () => firstReadyResolve(),
            });

            // Запускаем cell loading в фоне.
            const workerPoolRef = this.workerPool;
            const cellLoadPromise = cellLoader.loadAll()
                .then((stats) => {
                    this.cellStats = stats;
                    this.progress.setPhaseProgress('cells', 1);
                    workerPoolRef.dispose();
                    if (this.workerPool === workerPoolRef) {
                        this.workerPool = null;
                    }
                })
                .catch((err) => {
                    if ((err as Error).name === 'AbortError') return;
                    console.error('[renderer] cell loader failed:', err);
                });
            void cellLoadPromise;

            // Если cells меньше threshold или быстро прогрузились — resolve
            // на complete, не дожидаемся ровно 100.
            void cellLoadPromise.then(() => firstReadyResolve());

            this.setState('finalizing');
            this.progress.enterPhase('finalize');

            // Sprite info texture (RGBA32F lookup для всех sprites × LOD).
            this.spriteInfoTex = buildSpriteInfoTexture({
                gl: this.gl,
                sprites: this.manifests.sprites,
                spriteNameToId,
                nLods: this.manifests.atlas.lods.length,
                maxTextureSize: this.capabilities.maxTextureSize,
            });

            // Debug shader (atlas viewer).
            this.debugProgram = compileShaderProgram(
                this.gl,
                debugVertSrc,
                debugFragSrc,
                ['uAtlasArray', 'uLayer', 'uBrightness'],
            );

            // Main shader (cell renderer).
            this.mainProgram = compileShaderProgram(
                this.gl,
                mainVertSrc,
                mainFragSrc,
                [
                    'uViewProj',
                    'uCellOriginSq',
                    'uCellOffsetInAtlas',
                    'uSqr',
                    'uIsometric',
                    'uLod',
                    'uNLods',
                    'uCellAtlas',
                    'uCellAtlasWidth',
                    'uSpriteInfo',
                    'uSpriteInfoWidth',
                    'uAtlasArray',
                    'uDebugMode',
                    'uNativeSqr',
                    'uAtlasNativeSize',
                    'uMaxFloor',
                    'uFloorHeightPx',
                    'uMaxWorldDepth',
                    'uSquareStride',
                ],
            );

            // Empty VAO — оба shader используют gl_VertexID без attribs.
            this.debugVao = this.gl.createVertexArray();
            if (!this.debugVao) throw new Error('[renderer] createVertexArray failed');

            // Phase 4.3b.3: ждём первый batch cells перед ready. Это даёт
            // пользователю первую картинку через ~200ms (вместо 30 sec).
            await firstReadyPromise;

            this.progress.setPhaseProgress('finalize', 1);
            this.setState('ready');
            this.startRenderLoop();
            this.opts.onReady?.();
        } catch (err) {
            if ((err as Error).name === 'AbortError') {
                this.setState('cancelled');
                return;
            }
            const message
                = err instanceof WebGL2NotSupportedError
                    ? 'WebGL2 не поддерживается'
                    : err instanceof Error
                        ? err.message
                        : String(err);
            this.progress.setError(message);
            this.setState('error');
            this.opts.onError?.(err instanceof Error ? err : new Error(message));
        }
    }

    /**
     * Phase 1 render loop — рисует одну atlas page на canvas (debug).
     * Phase 4 заменит на полноценный карт-рендер.
     */
    private startRenderLoop(): void {
        const loop = (): void => {
            if (this.state !== 'ready') return;
            if (this.debugView.mode === 'atlas') {
                this.drawAtlasDebugFrame();
            } else {
                this.drawCellDebugFrame();
            }
            this.rafHandle = requestAnimationFrame(loop);
        };
        this.rafHandle = requestAnimationFrame(loop);
    }

    private drawAtlasDebugFrame(): void {
        if (
            !this.gl
            || !this.atlasTextures
            || !this.debugProgram
            || !this.debugVao
        ) {
            return;
        }
        const gl = this.gl;
        this.resizeCanvas();
        const { width: w, height: h } = this.opts.canvas;
        gl.viewport(0, 0, w, h);
        gl.clearColor(0.1, 0.1, 0.12, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.DEPTH_TEST);

        const lodTex = this.atlasTextures.get(this.debugView.lod);
        if (!lodTex) return;

        gl.useProgram(this.debugProgram.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, lodTex.texture);
        gl.uniform1i(this.debugProgram.uniforms.uAtlasArray!, 0);
        gl.uniform1f(this.debugProgram.uniforms.uLayer!, this.debugView.page);
        gl.uniform1f(
            this.debugProgram.uniforms.uBrightness!,
            this.debugView.brightness,
        );
        gl.bindVertexArray(this.debugVao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
    }

    /**
     * Phase 4.1: рендерит все cells в viewport. Camera = центр cellX/cellY
     * + pan. Iterate по cellRange, для каждой непустой cell проверяем
     * её bounding box в pixel space против viewport AABB — если overlap,
     * выпускаем drawArraysInstanced с per-cell uniforms.
     *
     * Single GL program + bound textures (cellAtlas, spriteInfo,
     * atlasArray) переиспользуются. Per-cell мы меняем только
     * uCellOriginSq + uCellOffsetInAtlas + entriesCount.
     */
    private drawCellDebugFrame(): void {
        if (
            !this.gl
            || !this.atlasTextures
            || !this.cellTextureMgr
            || !this.spriteInfoTex
            || !this.mainProgram
            || !this.debugVao
            || !this.manifests
        ) {
            return;
        }
        const gl = this.gl;
        this.resizeCanvas();
        const { width: w, height: h } = this.opts.canvas;
        gl.viewport(0, 0, w, h);
        gl.clearColor(0.07, 0.07, 0.10, 1.0);
        gl.clearDepth(1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);

        const {
            cellX,
            cellY,
            isometric,
            sqr,
            pps,
            lod,
            maxFloor,
            floorHeightPx,
            panX,
            panY,
            cellStride,
            squareStride,
        } = this.debugView;

        // Phase 4.3b.4: fall back на LOD 0 если запрошенный ещё не догружен
        // в фоне (atlas pages для него не все приехали). LOD 0 загружен
        // полностью при init — всегда safe.
        let effectiveLod = lod;
        if (this.atlasLoader && this.manifests) {
            const expectedPages = this.manifests.atlas.atlas_count;
            if (this.atlasLoader.loadedPageCount(lod) < expectedPages) {
                effectiveLod = 0;
            }
        }
        const lodTex = this.atlasTextures.get(effectiveLod);
        if (!lodTex) return;

        // Camera center = центр выбранной cell + pan offset.
        const cellSizeInSquares = 256;
        const midSx = cellX * cellSizeInSquares + cellSizeInSquares / 2;
        const midSy = cellY * cellSizeInSquares + cellSizeInSquares / 2;
        let camCenterX: number;
        let camCenterY: number;
        if (isometric) {
            camCenterX = (midSx - midSy) * sqr;
            camCenterY = (midSx + midSy) * (sqr * 0.5) + sqr * 0.5;
        } else {
            camCenterX = midSx * sqr;
            camCenterY = midSy * sqr;
        }
        const camX = camCenterX + panX;
        const camY = camCenterY + panY;

        const orthoHalfW = w / (2 * pps);
        const orthoHalfH = h / (2 * pps);
        const viewLeft = camX - orthoHalfW;
        const viewRight = camX + orthoHalfW;
        const viewTop = camY - orthoHalfH;
        const viewBottom = camY + orthoHalfH;

        const view = makeOrthoMatrix(
            viewLeft,
            viewRight,
            viewBottom, // bottom (Y down convention)
            viewTop, // top
        );

        // ---------- Setup shared uniforms (once per frame) ----------
        gl.useProgram(this.mainProgram.program);
        const u = this.mainProgram.uniforms;
        gl.uniformMatrix4fv(u.uViewProj!, false, view);
        gl.uniform1f(u.uSqr!, sqr);
        gl.uniform1f(u.uNativeSqr!, 64);
        gl.uniform1i(u.uIsometric!, isometric ? 1 : 0);
        gl.uniform1i(u.uLod!, lod);
        gl.uniform1i(u.uNLods!, this.manifests.atlas.lods.length);
        gl.uniform1i(u.uDebugMode!, this.debugView.fragDebug);
        gl.uniform1f(u.uAtlasNativeSize!, this.manifests.sprites.atlas_size);
        gl.uniform1i(u.uMaxFloor!, maxFloor);
        gl.uniform1f(u.uFloorHeightPx!, floorHeightPx);
        // effectiveStride = sprite scale + stride-bucket selector.
        // CPU решает какой instance count передавать (через strideOffsets);
        // shader только использует stride для масштаба sprite.
        const effectiveStride = Math.max(1, squareStride);
        gl.uniform1i(u.uSquareStride!, effectiveStride);
        // strideBucketIdx K такой что 2^K = effectiveStride.
        // K=0: все entries. K=6: только stride-64-aligned.
        const strideBucketIdx = Math.max(
            0,
            Math.min(6, Math.round(Math.log2(effectiveStride))),
        );

        // Global depth normalizer: max world sx+sy across весь loaded map.
        // Buffer +cellSize×2 чтобы layer/stack punches не вылезли за [-1..1].
        const range = this.getCellRange();
        const maxWorldSum = range
            ? (range.maxX + range.maxY + 2) * cellSizeInSquares + 512
            : cellSizeInSquares * 2;
        gl.uniform1f(u.uMaxWorldDepth!, maxWorldSum);

        // ---------- Bind textures (once per frame) ----------
        const cellInfo = this.cellTextureMgr.getInfo();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, cellInfo.cellAtlas);
        gl.uniform1i(u.uCellAtlas!, 0);
        gl.uniform1i(u.uCellAtlasWidth!, cellInfo.atlasWidth);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.spriteInfoTex.texture);
        gl.uniform1i(u.uSpriteInfo!, 1);
        gl.uniform1i(u.uSpriteInfoWidth!, this.spriteInfoTex.width);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, lodTex.texture);
        gl.uniform1i(u.uAtlasArray!, 2);

        gl.enable(gl.BLEND);
        gl.blendFuncSeparate(
            gl.SRC_ALPHA,
            gl.ONE_MINUS_SRC_ALPHA,
            gl.ONE,
            gl.ONE_MINUS_SRC_ALPHA,
        );

        gl.bindVertexArray(this.debugVao);

        // ---------- Per-cell loop ----------
        // Padding для overshooting sprites (деревья высотой ≈500 px native,
        // floor offset ≈192 × 3 = 576 px). Plus margin for safety.
        const padding = (700 + 600) * (sqr / 64);

        if (!range) {
            gl.bindVertexArray(null);
            return;
        }

        let drawn = 0;
        let totalInstances = 0;
        // cellStride deprecated: visual holes между skipped cells. Используем
        // только squareStride через strideOffsets (entries pre-sorted в worker
        // pack — первые N entries это stride-aligned). При sparse rendering
        // sprites scaled × effectiveStride покрывают gaps "органически".
        for (let cy = range.minY; cy <= range.maxY; cy++) {
            for (let cx = range.minX; cx <= range.maxX; cx++) {
                const info = this.cellTextureMgr.getCellInfo(cx, cy);
                if (!info || info.length === 0) continue;

                // Bounding box cell в pixel space (4 corners projected).
                const cellOriginSx = cx * cellSizeInSquares;
                const cellOriginSy = cy * cellSizeInSquares;
                const cellEndSx = cellOriginSx + cellSizeInSquares;
                const cellEndSy = cellOriginSy + cellSizeInSquares;
                let minX: number;
                let maxX: number;
                let minY: number;
                let maxY: number;
                if (isometric) {
                    const h2 = sqr * 0.5;
                    const c1x = (cellOriginSx - cellOriginSy) * sqr;
                    const c2x = (cellEndSx - cellOriginSy) * sqr;
                    const c3x = (cellOriginSx - cellEndSy) * sqr;
                    const c4x = (cellEndSx - cellEndSy) * sqr;
                    const c1y = (cellOriginSx + cellOriginSy) * h2;
                    const c2y = (cellEndSx + cellOriginSy) * h2;
                    const c3y = (cellOriginSx + cellEndSy) * h2;
                    const c4y = (cellEndSx + cellEndSy) * h2;
                    minX = Math.min(c1x, c2x, c3x, c4x);
                    maxX = Math.max(c1x, c2x, c3x, c4x);
                    minY = Math.min(c1y, c2y, c3y, c4y);
                    maxY = Math.max(c1y, c2y, c3y, c4y);
                } else {
                    minX = cellOriginSx * sqr;
                    maxX = cellEndSx * sqr;
                    minY = cellOriginSy * sqr;
                    maxY = cellEndSy * sqr;
                }
                minX -= padding;
                minY -= padding;
                maxX += padding;
                maxY += padding;
                if (maxX < viewLeft || minX > viewRight) continue;
                if (maxY < viewTop || minY > viewBottom) continue;

                const entriesCount = info.length / 2;
                // instanceCount = strideOffsets[K]: первые N entries
                // pre-sorted в worker (stride-64 первыми, потом stride-32,
                // ..., stride-1). drawArraysInstanced пропустит лишние
                // entries полностью — vertex shader не выполняется для них.
                const instanceCount = info.strideOffsets
                    ? info.strideOffsets[strideBucketIdx]!
                    : entriesCount;
                if (instanceCount === 0) continue;
                gl.uniform2f(u.uCellOriginSq!, cellOriginSx, cellOriginSy);
                gl.uniform1ui(u.uCellOffsetInAtlas!, info.offset);
                gl.drawArraysInstanced(
                    gl.TRIANGLE_STRIP,
                    0,
                    4,
                    instanceCount,
                );
                drawn++;
                totalInstances += instanceCount;
            }
        }

        gl.bindVertexArray(null);
        this.lastDrawnCellsCount = drawn;
        this.lastDrawnInstanceCount = totalInstances;
    }

    /** Number of cells drawn в последнем frame (для HUD/debug). */
    private lastDrawnCellsCount = 0;
    private lastDrawnInstanceCount = 0;
    getLastDrawnCellsCount(): number {
        return this.lastDrawnCellsCount;
    }
    getLastDrawnInstanceCount(): number {
        return this.lastDrawnInstanceCount;
    }

    private resizeCanvas(): void {
        const { canvas } = this.opts;
        const w = canvas.clientWidth || canvas.width || 800;
        const h = canvas.clientHeight || canvas.height || 600;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
    }

    /**
     * Управление debug viewer (Phase 1-3). Phase 4+ заменит реальным
     * Leaflet рендером карты.
     */
    setDebugView(view: Partial<DebugViewState>): void {
        this.debugView = { ...this.debugView, ...view };
    }

    /** Текущий snapshot debug view (для UI controls). */
    getDebugView(): DebugViewState {
        return { ...this.debugView };
    }

    /**
     * Возвращает (offset, length) для cell — нужно UI чтобы знать,
     * какие cells непустые при выборе в debug.
     */
    getCellEntryCount(cellX: number, cellY: number): number {
        return (this.cellTextureMgr?.getCellInfo(cellX, cellY)?.length ?? 0) / 2;
    }

    /** Доступ к bound cells (для UI слайдеров). */
    getCellRange(): { minX: number; maxX: number; minY: number; maxY: number } | null {
        if (!this.cellTextureMgr) return null;
        const info = this.cellTextureMgr.getInfo();
        return {
            minX: info.originCellX,
            maxX: info.originCellX + info.indexGridWidth - 1,
            minY: info.originCellY,
            maxY: info.originCellY + info.indexGridHeight - 1,
        };
    }

    /**
     * Auto-fit pps: рассчитывает zoom factor чтобы выбранная cell
     * целиком помещалась в canvas с небольшим padding.
     *
     * Cell в isometric проекции (PZ canonical) имеет screen-bounds
     * X = ±cellSize×sqr (диагональ ромба), Y = cellSize×sqr.
     * Top-down — квадрат (cellSize × sqr) на сторону.
     */
    computeAutoFitPps(): number {
        const { canvas } = this.opts;
        const w = canvas.clientWidth || canvas.width || 800;
        const h = canvas.clientHeight || canvas.height || 600;
        const { sqr, isometric } = this.debugView;
        const cellSizeInSquares = 256;
        const cellPxW = isometric
            ? cellSizeInSquares * sqr * 2
            : cellSizeInSquares * sqr;
        const cellPxH = isometric ? cellSizeInSquares * sqr : cellSizeInSquares * sqr;
        const padding = 1.1;
        const ppsX = w / (cellPxW * padding);
        const ppsY = h / (cellPxH * padding);
        return Math.min(ppsX, ppsY);
    }

    private setState(newState: RendererState): void {
        this.state = newState;
        this.progress.setState(newState);
    }

    /** Освободить все ресурсы. */
    dispose(): void {
        if (this.rafHandle !== null) {
            cancelAnimationFrame(this.rafHandle);
            this.rafHandle = null;
        }
        if (this.gl) {
            if (this.debugProgram) {
                destroyShaderProgram(this.gl, this.debugProgram);
                this.debugProgram = null;
            }
            if (this.mainProgram) {
                destroyShaderProgram(this.gl, this.mainProgram);
                this.mainProgram = null;
            }
            if (this.debugVao) {
                this.gl.deleteVertexArray(this.debugVao);
                this.debugVao = null;
            }
            if (this.atlasLoader) {
                this.atlasLoader.dispose();
                this.atlasLoader = null;
            }
            if (this.cellTextureMgr) {
                this.cellTextureMgr.dispose();
                this.cellTextureMgr = null;
            }
            if (this.spriteInfoTex) {
                this.gl.deleteTexture(this.spriteInfoTex.texture);
                this.spriteInfoTex = null;
            }
        }
        if (this.workerPool) {
            this.workerPool.dispose();
            this.workerPool = null;
        }
        this.atlasTextures = null;
        this.gl = null;
        this.state = 'idle';
    }
}
