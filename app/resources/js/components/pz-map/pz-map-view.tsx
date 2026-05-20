/**
 * <PzMapView /> — root React-компонент новой архитектуры рендера карты.
 *
 * Phase 1-3: создаёт canvas, монтирует PzMapRenderer, рисует
 * progress overlay во время preload. После ready — debug viewer с
 * двумя режимами:
 *   - 'atlas': пролистывание atlas pages (Phase 1)
 *   - 'cell':  рендеринг одной cell во весь canvas (Phase 3)
 *
 * Phase 4+ добавит Leaflet интеграцию для полного map view.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { PzMapError } from './pz-map-error';
import { PzMapPreloader } from './pz-map-preloader';
import { useMapRenderer } from '@/hooks/use-map-renderer';
import type { PzMapRenderer } from '@/lib/pz-renderer';

export interface PzMapViewProps {
    className?: string;
    atlasBaseUrl?: string;
    cellsBaseUrl?: string;
}

type DebugMode = 'atlas' | 'cell';

export function PzMapView({
    className = '',
    atlasBaseUrl,
    cellsBaseUrl,
}: PzMapViewProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const { renderer, progress, error, isReady } = useMapRenderer({
        canvasRef,
        atlasBaseUrl,
        cellsBaseUrl,
    });

    const [mode, setMode] = useState<DebugMode>('atlas');
    const [atlasLod, setAtlasLod] = useState(0);
    const [atlasPage, setAtlasPage] = useState(0);
    const [atlasBrightness, setAtlasBrightness] = useState(1.0);

    const [cellX, setCellX] = useState(0);
    const [cellY, setCellY] = useState(0);
    const [cellLod, setCellLod] = useState(0);
    const [isometric, setIsometric] = useState(true);
    const [sqr, setSqr] = useState(64);
    const [pps, setPps] = useState(1.0);
    const [maxFloor, setMaxFloor] = useState(3);
    const [floorHeightPx, setFloorHeightPx] = useState(192);
    const [panX, setPanX] = useState(0);
    const [panY, setPanY] = useState(0);
    const [autoTuning, setAutoTuning] = useState(true);
    const [manualCellStride, setManualCellStride] = useState(1);
    const [manualSquareStride, setManualSquareStride] = useState(1);

    // Auto LOD / stride на основании pps. Hysteresis: запоминаем
    // предыдущий level и переключаемся только если ушло за ±0.35
    // от boundary (≈3 wheel ticks).
    const tuningLevelRef = useRef(0);
    const tuning = useMemo(() => {
        // Phase 4.3a: pack pre-sorted в stride buckets, поэтому squareStride
        // даёт реальный instanceCount cut (vertex shader НЕ запускается для
        // skipped sprites). cellStride deprecated — создавал visual holes.
        // squareStride ∈ {1, 2, 4, 8, 16, 32, 64} — power-of-2, bucket index
        // K = log2(stride).
        const TABLE: Array<{ cellStride: number; squareStride: number; lod: number }> = [
            { cellStride: 1, squareStride: 1, lod: 0 },   // 0: pps ≥ 1.0
            { cellStride: 1, squareStride: 1, lod: 0 },   // 1: pps ≥ 0.5
            { cellStride: 1, squareStride: 2, lod: 0 },   // 2: pps ≥ 0.25
            { cellStride: 1, squareStride: 4, lod: 1 },   // 3: pps ≥ 0.125
            { cellStride: 1, squareStride: 8, lod: 2 },   // 4: pps ≥ 0.0625
            { cellStride: 1, squareStride: 16, lod: 3 },  // 5: pps ≥ 0.03
            { cellStride: 1, squareStride: 32, lod: 3 },  // 6: pps ≥ 0.015
            { cellStride: 1, squareStride: 64, lod: 3 },  // 7: pps < 0.015
        ];
        if (!autoTuning) {
            return {
                cellStride: manualCellStride,
                squareStride: manualSquareStride,
                lod: cellLod,
                level: -1,
            };
        }
        const exact = -Math.log2(Math.max(0.001, pps));
        let level = tuningLevelRef.current;
        while (exact > level + 0.35 && level < TABLE.length - 1) level++;
        while (exact < level - 0.35 && level > 0) level--;
        tuningLevelRef.current = level;
        return { ...TABLE[level]!, level };
    }, [autoTuning, pps, manualCellStride, manualSquareStride, cellLod]);

    // Сбрасываем pan при смене cell — иначе пользователь оказывается
    // глубоко в неотрендеренной зоне.
    useEffect(() => {
        setPanX(0);
        setPanY(0);
    }, [cellX, cellY]);

    // Mouse drag для pan. pps определяет soft canvas→native px ratio.
    const dragRef = useRef<{
        active: boolean;
        lastX: number;
        lastY: number;
    }>({ active: false, lastX: 0, lastY: 0 });
    const ppsRef = useRef(pps);
    ppsRef.current = pps;

    const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>): void => {
        if (e.button !== 0) return;
        dragRef.current = { active: true, lastX: e.clientX, lastY: e.clientY };
        if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
    };
    const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>): void => {
        if (!dragRef.current.active) return;
        const dx = e.clientX - dragRef.current.lastX;
        const dy = e.clientY - dragRef.current.lastY;
        dragRef.current.lastX = e.clientX;
        dragRef.current.lastY = e.clientY;
        const p = ppsRef.current || 1;
        setPanX((prev) => prev - dx / p);
        setPanY((prev) => prev - dy / p);
    };
    const handleMouseUp = (): void => {
        dragRef.current.active = false;
        if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
    };

    // Wheel zoom: zoom вокруг точки под курсором (как Google/Leaflet).
    // ΔY < 0 (scroll up) → zoom in. World position под cursor должен
    // оставаться неподвижным: компенсируем pan через изменение 1/pps.
    const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
        e.preventDefault();
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left - rect.width / 2;
        const my = e.clientY - rect.top - rect.height / 2;
        // 1.4x на tick: 5 кликов = 5.4× zoom (быстрее пробежать через
        // все 8 уровней tuning). С Ctrl — 2.0× для ещё резкого jump.
        const baseFactor = e.ctrlKey ? 2.0 : 1.4;
        const factor = e.deltaY < 0 ? baseFactor : 1 / baseFactor;
        const oldPps = pps;
        const newPps = Math.max(0.005, Math.min(8, oldPps * factor));
        if (newPps === oldPps) return;
        const dPan = 1 / oldPps - 1 / newPps;
        setPanX((px) => px + mx * dPan);
        setPanY((py) => py + my * dPan);
        setPps(newPps);
    };

    // При смене mode/values — push в renderer.
    useEffect(() => {
        if (!renderer || !isReady) return;
        renderer.setDebugView({
            mode,
            lod: mode === 'atlas' ? atlasLod : tuning.lod,
            page: atlasPage,
            brightness: atlasBrightness,
            cellX,
            cellY,
            isometric,
            sqr,
            pps,
            maxFloor,
            floorHeightPx,
            panX,
            panY,
            cellStride: tuning.cellStride,
            squareStride: tuning.squareStride,
        });
    }, [
        renderer,
        isReady,
        mode,
        atlasLod,
        atlasPage,
        atlasBrightness,
        cellX,
        cellY,
        isometric,
        sqr,
        pps,
        maxFloor,
        floorHeightPx,
        panX,
        panY,
        tuning.lod,
        tuning.cellStride,
        tuning.squareStride,
    ]);

    const showPreloader = !isReady && !error;
    const lodCount = renderer?.getLodCount() ?? 1;
    const pageCount = renderer?.getPageCount() ?? 1;
    const cellRange = renderer?.getCellRange();
    const entryCount = renderer?.getCellEntryCount(cellX, cellY) ?? 0;

    /**
     * Сканирует grid от текущей позиции и находит ближайшую non-empty
     * cell. Полезно когда (0,0) попало в пустую область карты.
     */
    const findNonEmpty = (): void => {
        if (!renderer || !cellRange) return;
        for (let dy = 0; dy <= cellRange.maxY - cellRange.minY; dy++) {
            for (let dx = 0; dx <= cellRange.maxX - cellRange.minX; dx++) {
                const tx = cellRange.minX + dx;
                const ty = cellRange.minY + dy;
                if (renderer.getCellEntryCount(tx, ty) > 0) {
                    setCellX(tx);
                    setCellY(ty);
                    return;
                }
            }
        }
    };

    /**
     * Auto-jump: при первом переключении в cell mode (после ready), если
     * текущая cell пустая — найти первую непустую. Также авто-зумит
     * чтобы cell поместилась в canvas (cell ≈ 16000 px wide на native
     * zoom, default pps=1.0 показывает только малый угол).
     */
    const autoJumpedRef = useRef(false);
    useEffect(() => {
        if (!isReady || mode !== 'cell' || autoJumpedRef.current) return;
        if (!renderer || !cellRange) return;
        if (renderer.getCellEntryCount(cellX, cellY) === 0) {
            findNonEmpty();
        }
        const fitPps = renderer.computeAutoFitPps();
        if (fitPps > 0) setPps(Math.max(0.05, Math.min(8, fitPps)));
        autoJumpedRef.current = true;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isReady, mode, renderer, cellRange]);

    /** Debug fragment mode (0 normal, 1 magenta, 2 UV gradient). */
    const [fragDebug, setFragDebug] = useState(0);
    useEffect(() => {
        if (!renderer || !isReady) return;
        renderer.setDebugView({ fragDebug });
    }, [renderer, isReady, fragDebug]);

    return (
        <div className={`relative isolate h-full w-full ${className}`}>
            <canvas
                ref={canvasRef}
                className="absolute inset-0 h-full w-full"
                style={{ cursor: mode === 'cell' ? 'grab' : 'default' }}
                onMouseDown={mode === 'cell' ? handleMouseDown : undefined}
                onMouseMove={mode === 'cell' ? handleMouseMove : undefined}
                onMouseUp={mode === 'cell' ? handleMouseUp : undefined}
                onMouseLeave={mode === 'cell' ? handleMouseUp : undefined}
                onWheel={mode === 'cell' ? handleWheel : undefined}
            />
            {showPreloader && <PzMapPreloader progress={progress} />}
            {error && <PzMapError error={error} />}
            {isReady && (
                <>
                    <DebugControls
                        mode={mode}
                        setMode={setMode}
                        atlasLod={atlasLod}
                        setAtlasLod={setAtlasLod}
                        atlasPage={atlasPage}
                        setAtlasPage={setAtlasPage}
                        atlasBrightness={atlasBrightness}
                        setAtlasBrightness={setAtlasBrightness}
                        cellX={cellX}
                        setCellX={setCellX}
                        cellY={cellY}
                        setCellY={setCellY}
                        cellLod={cellLod}
                        setCellLod={setCellLod}
                        isometric={isometric}
                        setIsometric={setIsometric}
                        sqr={sqr}
                        setSqr={setSqr}
                        pps={pps}
                        setPps={setPps}
                        maxFloor={maxFloor}
                        setMaxFloor={setMaxFloor}
                        floorHeightPx={floorHeightPx}
                        setFloorHeightPx={setFloorHeightPx}
                        panX={panX}
                        panY={panY}
                        resetPan={() => {
                            setPanX(0);
                            setPanY(0);
                        }}
                        autoTuning={autoTuning}
                        setAutoTuning={setAutoTuning}
                        tuning={tuning}
                        manualCellStride={manualCellStride}
                        setManualCellStride={setManualCellStride}
                        manualSquareStride={manualSquareStride}
                        setManualSquareStride={setManualSquareStride}
                        lodCount={lodCount}
                        pageCount={pageCount}
                        cellRange={cellRange}
                        entryCount={entryCount}
                        findNonEmpty={findNonEmpty}
                        fragDebug={fragDebug}
                        setFragDebug={setFragDebug}
                    />
                    <CellStatsHud renderer={renderer} />
                </>
            )}
        </div>
    );
}

interface DebugControlsProps {
    mode: DebugMode;
    setMode: (m: DebugMode) => void;
    atlasLod: number;
    setAtlasLod: (v: number) => void;
    atlasPage: number;
    setAtlasPage: (v: number) => void;
    atlasBrightness: number;
    setAtlasBrightness: (v: number) => void;
    cellX: number;
    setCellX: (v: number) => void;
    cellY: number;
    setCellY: (v: number) => void;
    cellLod: number;
    setCellLod: (v: number) => void;
    isometric: boolean;
    setIsometric: (v: boolean) => void;
    sqr: number;
    setSqr: (v: number) => void;
    pps: number;
    setPps: (v: number) => void;
    maxFloor: number;
    setMaxFloor: (v: number) => void;
    floorHeightPx: number;
    setFloorHeightPx: (v: number) => void;
    panX: number;
    panY: number;
    resetPan: () => void;
    autoTuning: boolean;
    setAutoTuning: (v: boolean) => void;
    tuning: { cellStride: number; squareStride: number; lod: number; level: number };
    manualCellStride: number;
    setManualCellStride: (v: number) => void;
    manualSquareStride: number;
    setManualSquareStride: (v: number) => void;
    lodCount: number;
    pageCount: number;
    cellRange: { minX: number; maxX: number; minY: number; maxY: number } | null | undefined;
    entryCount: number;
    findNonEmpty: () => void;
    fragDebug: number;
    setFragDebug: (v: number) => void;
}

function DebugControls(p: DebugControlsProps) {
    return (
        <div className="absolute right-3 top-3 z-[900] w-80 space-y-3 rounded-md border border-zinc-700 bg-zinc-900/90 p-3 text-xs text-zinc-200 backdrop-blur">
            <div className="flex gap-2">
                <ModeButton
                    active={p.mode === 'atlas'}
                    onClick={() => p.setMode('atlas')}
                >
                    Atlas viewer
                </ModeButton>
                <ModeButton
                    active={p.mode === 'cell'}
                    onClick={() => p.setMode('cell')}
                >
                    Cell render
                </ModeButton>
            </div>

            {p.mode === 'atlas' && (
                <>
                    <Slider
                        label="LOD"
                        value={p.atlasLod}
                        min={0}
                        max={p.lodCount - 1}
                        onChange={p.setAtlasLod}
                    />
                    <Slider
                        label="Page"
                        value={p.atlasPage}
                        min={0}
                        max={p.pageCount - 1}
                        onChange={p.setAtlasPage}
                        valueFmt={(v) => `${v} / ${p.pageCount - 1}`}
                    />
                    <Slider
                        label="Brightness"
                        value={p.atlasBrightness}
                        min={0.5}
                        max={4}
                        step={0.1}
                        onChange={p.setAtlasBrightness}
                        valueFmt={(v) => `${v.toFixed(1)}×`}
                    />
                </>
            )}

            {p.mode === 'cell' && (
                <>
                    {p.cellRange && (
                        <>
                            <CellCoordRow
                                label="Cell X"
                                value={p.cellX}
                                min={p.cellRange.minX}
                                max={p.cellRange.maxX}
                                onChange={p.setCellX}
                            />
                            <CellCoordRow
                                label="Cell Y"
                                value={p.cellY}
                                min={p.cellRange.minY}
                                max={p.cellRange.maxY}
                                onChange={p.setCellY}
                            />
                        </>
                    )}
                    <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-400">
                        <span>
                            Entries:{' '}
                            <span className="font-mono text-emerald-400">
                                {p.entryCount.toLocaleString()}
                            </span>
                        </span>
                        <button
                            onClick={() => p.findNonEmpty()}
                            className="rounded bg-emerald-700 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-emerald-600"
                        >
                            Find non-empty →
                        </button>
                    </div>
                    <div className="space-y-1 border-t border-zinc-800 pt-2">
                        <p className="text-[10px] uppercase tracking-wider text-amber-400">
                            Fragment debug
                        </p>
                        <div className="flex gap-1">
                            {(['Normal', 'Magenta', 'UV viz'] as const).map((label, idx) => (
                                <button
                                    key={label}
                                    onClick={() => p.setFragDebug?.(idx)}
                                    className={`flex-1 rounded px-2 py-1 text-[10px] transition ${
                                        p.fragDebug === idx
                                            ? 'bg-amber-700 text-white'
                                            : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                                    }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                        <p className="text-[9px] text-zinc-500">
                            Magenta = quads видны → проекция OK. UV = градиент
                            каждого спрайта → UV декод OK.
                        </p>
                    </div>
                    {p.entryCount === 0 && (
                        <p className="text-[10px] text-amber-400">
                            Cell пустая. Двигай слайдер X/Y, вводи число в input,
                            или жми «Find non-empty».
                        </p>
                    )}
                    <div className="space-y-1 border-t border-zinc-800 pt-2">
                        <label className="flex cursor-pointer items-center gap-2 text-xs">
                            <input
                                type="checkbox"
                                checked={p.autoTuning}
                                onChange={(e) => p.setAutoTuning(e.target.checked)}
                            />
                            <span>Auto LOD / stride</span>
                        </label>
                        {p.autoTuning ? (
                            <div className="flex justify-between font-mono text-[10px] text-zinc-400">
                                <span>
                                    level <span className="text-cyan-400">{p.tuning.level}</span>
                                </span>
                                <span>
                                    cs<span className="text-emerald-400">{p.tuning.cellStride}</span>{' '}
                                    ss<span className="text-emerald-400">{p.tuning.squareStride}</span>{' '}
                                    lod<span className="text-emerald-400">{p.tuning.lod}</span>
                                </span>
                            </div>
                        ) : (
                            <>
                                <Slider
                                    label="LOD"
                                    value={p.cellLod}
                                    min={0}
                                    max={p.lodCount - 1}
                                    onChange={p.setCellLod}
                                />
                                <Slider
                                    label="cellStride"
                                    value={p.manualCellStride}
                                    min={1}
                                    max={16}
                                    step={1}
                                    onChange={p.setManualCellStride}
                                />
                                <Slider
                                    label="squareStride"
                                    value={p.manualSquareStride}
                                    min={1}
                                    max={64}
                                    step={1}
                                    onChange={p.setManualSquareStride}
                                />
                            </>
                        )}
                    </div>
                    <label className="flex cursor-pointer items-center gap-2 text-xs">
                        <input
                            type="checkbox"
                            checked={p.isometric}
                            onChange={(e) => p.setIsometric(e.target.checked)}
                        />
                        <span>Isometric projection</span>
                    </label>
                    <Slider
                        label="sqr (px/sq)"
                        value={p.sqr}
                        min={8}
                        max={256}
                        step={8}
                        onChange={p.setSqr}
                    />
                    <Slider
                        label="zoom (pps mult)"
                        value={p.pps}
                        min={0.005}
                        max={8}
                        step={0.005}
                        onChange={p.setPps}
                        valueFmt={(v) =>
                            v >= 0.1 ? `${v.toFixed(1)}×` : `${v.toFixed(3)}×`
                        }
                    />
                    <div className="space-y-1 border-t border-zinc-800 pt-2">
                        <Slider
                            label="Max floor"
                            value={p.maxFloor}
                            min={0}
                            max={3}
                            step={1}
                            onChange={p.setMaxFloor}
                            valueFmt={(v) =>
                                v === 0 ? 'ground only' : `0..${v}`
                            }
                        />
                        <Slider
                            label="Floor height (px)"
                            value={p.floorHeightPx}
                            min={0}
                            max={400}
                            step={4}
                            onChange={p.setFloorHeightPx}
                            valueFmt={(v) => `${v} px`}
                        />
                        <p className="text-[9px] text-zinc-500">
                            Если этажи накладываются на нижние — крути floor
                            height. PZ B42 стандарт = 192 (pzmap2dzi
                            LAYER_HEIGHT). 0 = все этажи на ground (debug).
                        </p>
                    </div>
                    <div className="space-y-1 border-t border-zinc-800 pt-2">
                        <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-400">
                            <span>
                                Pan:{' '}
                                <span className="font-mono text-cyan-400">
                                    {Math.round(p.panX)}, {Math.round(p.panY)}
                                </span>
                            </span>
                            <button
                                onClick={p.resetPan}
                                className="rounded bg-cyan-700 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-cyan-600"
                            >
                                Reset pan
                            </button>
                        </div>
                        <p className="text-[9px] text-zinc-500">
                            Зажми ЛКМ на canvas и тащи чтобы перемещаться.
                        </p>
                    </div>
                </>
            )}
        </div>
    );
}

function ModeButton({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            onClick={onClick}
            className={`flex-1 rounded-md px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider transition ${
                active
                    ? 'bg-emerald-600 text-white'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
            }`}
        >
            {children}
        </button>
    );
}

interface SliderProps {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    onChange: (v: number) => void;
    valueFmt?: (v: number) => string;
}

function Slider({
    label,
    value,
    min,
    max,
    step = 1,
    onChange,
    valueFmt,
}: SliderProps) {
    return (
        <label className="block space-y-1">
            <span className="flex justify-between font-mono">
                <span>{label}</span>
                <span className="text-emerald-400">
                    {valueFmt ? valueFmt(value) : value}
                </span>
            </span>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                className="w-full"
            />
        </label>
    );
}

/**
 * Cell coord widget: slider + numeric input в одной строке. Позволяет
 * быстро таскать слайдером для разведки или впечатать точный coord.
 */
interface CellCoordRowProps {
    label: string;
    value: number;
    min: number;
    max: number;
    onChange: (v: number) => void;
}

function CellCoordRow({ label, value, min, max, onChange }: CellCoordRowProps) {
    const clamp = (v: number): number => Math.max(min, Math.min(max, v | 0));
    return (
        <label className="block space-y-1">
            <span className="flex justify-between font-mono">
                <span>{label}</span>
                <span className="text-zinc-500">
                    [{min}..{max}]
                </span>
            </span>
            <div className="flex gap-2">
                <input
                    type="range"
                    min={min}
                    max={max}
                    step={1}
                    value={value}
                    onChange={(e) => onChange(clamp(Number(e.target.value)))}
                    className="flex-1"
                />
                <input
                    type="number"
                    min={min}
                    max={max}
                    step={1}
                    value={value}
                    onChange={(e) => onChange(clamp(Number(e.target.value)))}
                    className="w-16 rounded bg-zinc-800 px-1 py-0.5 text-right font-mono text-emerald-400"
                />
            </div>
        </label>
    );
}

function CellStatsHud({ renderer }: { renderer: PzMapRenderer | null }) {
    const stats = renderer?.getCellStats();
    const texInfo = renderer?.getCellTextureInfo();
    const [drawnCells, setDrawnCells] = useState(0);
    const [drawnInstances, setDrawnInstances] = useState(0);
    const [fps, setFps] = useState(0);
    useEffect(() => {
        if (!renderer) return;
        // FPS counter через rAF: накапливаем frames за 0.5s.
        let frames = 0;
        let lastT = performance.now();
        let raf = 0;
        const tick = (): void => {
            frames++;
            const now = performance.now();
            if (now - lastT >= 500) {
                setFps(Math.round((frames * 1000) / (now - lastT)));
                frames = 0;
                lastT = now;
            }
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        const id = setInterval(() => {
            setDrawnCells(renderer.getLastDrawnCellsCount());
            setDrawnInstances(renderer.getLastDrawnInstanceCount());
        }, 250);
        return () => {
            cancelAnimationFrame(raf);
            clearInterval(id);
        };
    }, [renderer]);
    if (!stats || !texInfo) return null;

    const mbAtlas = (texInfo.totalEntries * 8) / (1024 * 1024);
    const cacheRatio = stats.bytesFromCache
        / Math.max(1, stats.bytesFromCache + stats.bytesFromNetwork);
    const fpsColor = fps >= 50 ? 'text-emerald-400' : fps >= 30 ? 'text-amber-400' : 'text-red-400';

    return (
        <div className="absolute bottom-3 left-3 z-[900] w-72 space-y-1 rounded-md border border-zinc-700 bg-zinc-900/90 p-3 font-mono text-[10px] text-zinc-300 backdrop-blur">
            <p className="text-[10px] uppercase tracking-wider text-emerald-400">
                Phase 4.3a — stride-bucket sorted pack
            </p>
            <div className="flex justify-between">
                <span>FPS</span>
                <span className={fpsColor}>{fps}</span>
            </div>
            <div className="flex justify-between">
                <span>Cells / instances drawn</span>
                <span className="text-cyan-400">
                    {drawnCells} / {drawnInstances.toLocaleString()}
                </span>
            </div>
            <div className="flex justify-between">
                <span>Cells parsed</span>
                <span>
                    {stats.parsedCells} / {stats.totalCells}
                </span>
            </div>
            <div className="flex justify-between">
                <span>Cells skipped</span>
                <span>{stats.skippedCells}</span>
            </div>
            <div className="flex justify-between">
                <span>Sprite entries</span>
                <span>{texInfo.totalEntries.toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
                <span>cellAtlas size</span>
                <span>{mbAtlas.toFixed(1)} MB</span>
            </div>
            <div className="flex justify-between">
                <span>IDB cache hit</span>
                <span>{(cacheRatio * 100).toFixed(0)}%</span>
            </div>
            <div className="flex justify-between text-zinc-500">
                <span>Origin</span>
                <span>
                    ({texInfo.originCellX}, {texInfo.originCellY})
                </span>
            </div>
            <div className="flex justify-between text-zinc-500">
                <span>Grid</span>
                <span>
                    {texInfo.indexGridWidth} × {texInfo.indexGridHeight}
                </span>
            </div>
        </div>
    );
}
