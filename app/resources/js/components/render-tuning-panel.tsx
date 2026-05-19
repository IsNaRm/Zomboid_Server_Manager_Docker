/**
 * Floating dev panel — live A/B-test of map render trade-offs.
 *
 * Two independent knobs:
 *   1. Cell-stride at extreme zoom-out (4 / 9 / 16 / 25 / 36 / 49
 *      cells collapse into one sampled cell).
 *   2. LOD activation thresholds (when each atlas LOD kicks in by
 *      pixelsPerSquare).
 *
 * All changes are live: `setRenderTuning` fires listeners that the
 * WebGLPZLayer subscribes to, which clears the bitmap cache and asks
 * Leaflet to rebuild every visible tile with the new settings.
 *
 * Settings persist in localStorage; revert with "Reset".
 */
import { useEffect, useState } from 'react';
import L from 'leaflet';
import {
    CELL_STRIDE_OPTIONS,
    DEFAULT_TUNING,
    cellStrideLabel,
    getRenderTuning,
    onRenderTuningChange,
    resetRenderTuning,
    setRenderTuning,
    type RenderTuning,
} from '@/lib/pz-renderer/render-tuning';

interface Props {
    map: L.Map | null;
    /** Current projection — used to display pixelsPerSquare live. */
    projection: { sqr: number; maxNativeZoom: number } | null;
}

export function RenderTuningPanel({ map, projection }: Props) {
    const [tuning, setTuning] = useState<RenderTuning>(() => getRenderTuning());
    const [zoom, setZoom] = useState<number>(map?.getZoom() ?? 0);
    const [collapsed, setCollapsed] = useState<boolean>(() => {
        try {
            return localStorage.getItem('pz-tuning-panel-collapsed') === '1';
        } catch {
            return false;
        }
    });

    useEffect(() => {
        const unsub = onRenderTuningChange((t) => setTuning(t));
        return unsub;
    }, []);

    useEffect(() => {
        if (!map) return;
        const update = (): void => setZoom(map.getZoom());
        map.on('zoom zoomend', update);
        update();
        return () => {
            map.off('zoom zoomend', update);
        };
    }, [map]);

    useEffect(() => {
        try {
            localStorage.setItem('pz-tuning-panel-collapsed', collapsed ? '1' : '0');
        } catch {
            /* private mode */
        }
    }, [collapsed]);

    const pixelsPerSquare = projection
        ? projection.sqr * Math.pow(2, zoom - projection.maxNativeZoom)
        : null;

    const activeLod = pixelsPerSquare === null
        ? null
        : pixelsPerSquare >= tuning.lodThresholds.lod0
            ? 0
            : pixelsPerSquare >= tuning.lodThresholds.lod1
                ? 1
                : pixelsPerSquare >= tuning.lodThresholds.lod2
                    ? 2
                    : 3;

    const activeStride = pixelsPerSquare !== null
        && tuning.forcedCellStride !== null
        && tuning.forcedCellStride > 1
        && pixelsPerSquare < tuning.forcedStrideThreshold
        ? tuning.forcedCellStride
        : null;

    return (
        <div
            style={{
                position: 'absolute',
                top: 12,
                right: 12,
                zIndex: 1000,
                background: 'rgba(15,15,15,0.88)',
                color: '#e5e7eb',
                border: '1px solid #374151',
                borderRadius: 6,
                padding: collapsed ? '6px 10px' : '10px 12px',
                fontSize: 11,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                maxWidth: 280,
                pointerEvents: 'auto',
                boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            }}
        >
            <div
                onClick={() => setCollapsed((c) => !c)}
                style={{
                    cursor: 'pointer',
                    fontWeight: 600,
                    color: '#a7f3d0',
                    display: 'flex',
                    justifyContent: 'space-between',
                    userSelect: 'none',
                }}
            >
                <span>Render tuning</span>
                <span>{collapsed ? '▸' : '▾'}</span>
            </div>

            {!collapsed && (
                <>
                    <div
                        style={{
                            marginTop: 6,
                            fontSize: 10,
                            color: '#9ca3af',
                            lineHeight: 1.5,
                        }}
                    >
                        zoom {zoom.toFixed(2)}{' '}
                        · pps {pixelsPerSquare === null ? '—' : pixelsPerSquare.toFixed(3)}{' '}
                        · LOD {activeLod ?? '—'}
                        {activeStride !== null
                            ? ` · stride ×${activeStride}`
                            : ''}
                    </div>

                    <fieldset
                        style={{
                            marginTop: 10,
                            padding: 6,
                            border: '1px solid #1f2937',
                            borderRadius: 4,
                        }}
                    >
                        <legend style={{ padding: '0 4px', color: '#fbbf24' }}>
                            Far-zoom cell stride
                        </legend>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {CELL_STRIDE_OPTIONS.map((stride) => {
                                const selected =
                                    (tuning.forcedCellStride ?? 1) === stride;
                                return (
                                    <button
                                        key={stride}
                                        onClick={() =>
                                            setRenderTuning({
                                                forcedCellStride:
                                                    stride === 1 ? null : stride,
                                            })
                                        }
                                        style={buttonStyle(selected)}
                                    >
                                        {cellStrideLabel(stride)}
                                    </button>
                                );
                            })}
                        </div>
                        <label
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                marginTop: 6,
                                gap: 6,
                            }}
                        >
                            <span style={{ flexShrink: 0 }}>apply when pps&nbsp;&lt;</span>
                            <input
                                type="number"
                                step={0.1}
                                min={0.01}
                                max={64}
                                value={tuning.forcedStrideThreshold}
                                onChange={(e) =>
                                    setRenderTuning({
                                        forcedStrideThreshold:
                                            Number(e.target.value) || 1,
                                    })
                                }
                                style={numberInput}
                            />
                        </label>
                    </fieldset>

                    <fieldset
                        style={{
                            marginTop: 8,
                            padding: 6,
                            border: '1px solid #1f2937',
                            borderRadius: 4,
                        }}
                    >
                        <legend style={{ padding: '0 4px', color: '#60a5fa' }}>
                            LOD thresholds (pps ≥)
                        </legend>
                        {(['lod0', 'lod1', 'lod2'] as const).map((k) => (
                            <label
                                key={k}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    margin: '4px 0',
                                }}
                            >
                                <span style={{ width: 38, flexShrink: 0 }}>
                                    {k}:
                                </span>
                                <input
                                    type="number"
                                    step={k === 'lod2' ? 0.5 : 1}
                                    min={0.01}
                                    max={1024}
                                    value={tuning.lodThresholds[k]}
                                    onChange={(e) =>
                                        setRenderTuning({
                                            lodThresholds: {
                                                ...tuning.lodThresholds,
                                                [k]: Number(e.target.value) || 0.01,
                                            },
                                        })
                                    }
                                    style={numberInput}
                                />
                                <span style={{ color: '#6b7280' }}>→ LOD {k.slice(-1)}</span>
                            </label>
                        ))}
                        <div style={{ marginTop: 4, color: '#6b7280', fontSize: 10 }}>
                            below LOD2 threshold → LOD 3 (smallest)
                        </div>
                    </fieldset>

                    <div
                        style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            marginTop: 10,
                        }}
                    >
                        <button
                            onClick={() => setRenderTuning(DEFAULT_TUNING)}
                            style={buttonStyle(false)}
                            title="Reset to built-in defaults"
                        >
                            Reset
                        </button>
                        <button
                            onClick={() => {
                                resetRenderTuning();
                            }}
                            style={buttonStyle(false)}
                            title="Same as Reset, but also clears localStorage"
                        >
                            Clear saved
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}

function buttonStyle(selected: boolean): React.CSSProperties {
    return {
        padding: '3px 7px',
        fontSize: 10,
        fontFamily: 'inherit',
        border: '1px solid ' + (selected ? '#22c55e' : '#374151'),
        background: selected ? '#14532d' : '#1f2937',
        color: selected ? '#a7f3d0' : '#e5e7eb',
        borderRadius: 3,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
    };
}

const numberInput: React.CSSProperties = {
    width: 60,
    padding: '2px 4px',
    fontSize: 10,
    fontFamily: 'inherit',
    background: '#1f2937',
    color: '#e5e7eb',
    border: '1px solid #374151',
    borderRadius: 3,
};
