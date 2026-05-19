import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RenderTuningPanel } from '@/components/render-tuning-panel';
import { defaultCellCache } from '@/lib/pz-renderer/cell-cache';
import { fetchCellsForTile } from '@/lib/pz-renderer/tile-cells';
import type { CellData, DziProjection } from '@/lib/pz-renderer/types';
import { VERSION_LIMITATIONS } from '@/lib/pz-renderer/types';
import { usePzWebGLRenderer } from '@/lib/pz-renderer/use-webgl-renderer';
import { workerPool } from '@/lib/pz-renderer/workers/worker-pool';
import { WebGLPZLayer } from '@/lib/pz-renderer/webgl-leaflet-layer';
import type { DziInfo, MapConfig, PlayerMarker } from '@/types/server';

type MarkerAction = 'kick' | 'ban' | 'access' | 'inventory';

export type ZoneOverlay = {
    id: string;
    name: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    color: string;
};

export type DrawnZone = {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
};

export type EventMarker = {
    id: number;
    x: number;
    y: number;
    type: string;
    player: string;
    target: string | null;
    label: string;
};

type PzMapProps = {
    markers?: PlayerMarker[];
    mapConfig: MapConfig;
    hasTiles: boolean;
    className?: string;
    interactive?: boolean;
    onMarkerClick?: (marker: PlayerMarker) => void;
    onMarkerAction?: (marker: PlayerMarker, action: MarkerAction) => void;
    zones?: ZoneOverlay[];
    drawingMode?: boolean;
    onZoneDrawn?: (zone: DrawnZone) => void;
    selectedZoneId?: string | null;
    onZoneClick?: (zone: ZoneOverlay) => void;
    eventMarkers?: EventMarker[];
    onEventMarkerClick?: (marker: EventMarker) => void;
    onMapReady?: (map: L.Map) => void;
};

const statusColors: Record<PlayerMarker['status'], string> = {
    online: '#22c55e',
    offline: '#9ca3af',
    dead: '#ef4444',
};

const labelColors: Record<PlayerMarker['status'], string> = {
    online: '#4ade80',
    offline: '#d1d5db',
    dead: '#f87171',
};

function createMarkerIcon(status: PlayerMarker['status'], name: string): L.DivIcon {
    const color = statusColors[status];
    const labelColor = labelColors[status];
    return L.divIcon({
        className: 'pz-marker',
        html: `<div style="display:flex;align-items:center;gap:5px;white-space:nowrap;">
            <div style="
                width: 18px;
                height: 18px;
                min-width: 18px;
                border-radius: 50%;
                background: ${color};
                border: 2px solid white;
                box-shadow: 0 1px 4px rgba(0,0,0,0.5);
            "></div>
            <span style="
                font-size: 13px;
                font-weight: 600;
                color: ${labelColor};
                text-shadow: 0 0 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6);
                pointer-events: none;
            ">${name}</span>
        </div>`,
        iconSize: [140, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -12],
    });
}

function createPopupHtml(marker: PlayerMarker): string {
    const statusLabel = `<span style="color: ${statusColors[marker.status]}; text-transform: capitalize; font-size: 12px;">${marker.status}</span>`;
    const coords = `<small style="color: #9ca3af;">X: ${marker.x.toFixed(0)}, Y: ${marker.y.toFixed(0)}, Z: ${marker.z}</small>`;

    const btnStyle = 'display:inline-block;padding:3px 8px;font-size:11px;border-radius:4px;cursor:pointer;border:1px solid #374151;background:#1f2937;color:#e5e7eb;margin:2px;';
    const btnDanger = 'display:inline-block;padding:3px 8px;font-size:11px;border-radius:4px;cursor:pointer;border:1px solid #7f1d1d;background:#991b1b;color:#fecaca;margin:2px;';

    const actions = marker.is_online
        ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:2px;">
            <button class="pz-action" data-action="inventory" style="${btnStyle}">Inventory</button>
            <button class="pz-action" data-action="access" style="${btnStyle}">Access</button>
            <button class="pz-action" data-action="kick" style="${btnStyle}">Kick</button>
            <button class="pz-action" data-action="ban" style="${btnDanger}">Ban</button>
          </div>`
        : `<div style="margin-top:6px;">
            <button class="pz-action" data-action="inventory" style="${btnStyle}">Inventory</button>
          </div>`;

    return `<div style="min-width:140px;">
        <strong style="font-size:13px;">${marker.name}</strong><br/>
        ${statusLabel}<br/>${coords}
        ${actions}
    </div>`;
}

/**
 * Create a DZI tile layer.
 * pzmap2dzi outputs tiles as {z}/{x}_{y}.webp (underscore separator).
 */
function createDziTileLayer(templateUrl: string, options: L.TileLayerOptions): L.TileLayer {
    const Layer = L.TileLayer.extend({
        getTileUrl(coords: L.Coords) {
            return templateUrl
                .replace('{z}', String(coords.z))
                .replace('{x}', String(coords.x))
                .replace('{y}', String(coords.y));
        },
    }) as unknown as new (url: string, opts: L.TileLayerOptions) => L.TileLayer;

    return new Layer(templateUrl, options);
}

/**
 * Create a CRS that maps PZ game coordinates (squares) to DZI tile coordinates.
 *
 * Two modes:
 * - Top-view (sqr=1): Simple linear mapping, PZ coords → pixels 1:1
 * - Isometric (sqr=128): Rotated diamond projection (PZ's 2:1 isometric)
 *
 * The projection converts PZ coords to DZI pixel coords at full resolution.
 * The transformation scales by 1/2^maxNativeZoom so Leaflet tile indices
 * match the DZI pyramid at every zoom level.
 */
function createPzCRS(dzi: DziInfo): L.CRS {
    const scale = 1 / Math.pow(2, dzi.maxNativeZoom);

    if (dzi.isometric) {
        // Isometric: PZ (sx, sy) → diamond rotation → DZI pixels
        // px = (sx - sy) * sqr/2 + x0
        // py = (sx + sy) * sqr/4 + y0 + sqr/4
        const halfSqr = dzi.sqr / 2;
        const quarterSqr = dzi.sqr / 4;
        const yOffset = dzi.y0 + quarterSqr;

        const projection = {
            project(latlng: L.LatLng): L.Point {
                const sx = latlng.lng;
                const sy = -latlng.lat;
                return new L.Point(
                    (sx - sy) * halfSqr + dzi.x0,
                    (sx + sy) * quarterSqr + yOffset,
                );
            },
            unproject(point: L.Point): L.LatLng {
                const pxAdj = (point.x - dzi.x0) / halfSqr;
                const pyAdj = (point.y - yOffset) / quarterSqr;
                const sx = (pxAdj + pyAdj) / 2;
                const sy = (pyAdj - pxAdj) / 2;
                return L.latLng(-sy, sx);
            },
            bounds: L.bounds([0, 0], [dzi.width, dzi.height]),
        };

        return L.Util.extend({}, L.CRS, {
            projection,
            transformation: new L.Transformation(scale, 0, scale, 0),
            scale(zoom: number) { return Math.pow(2, zoom); },
            zoom(s: number) { return Math.log(s) / Math.LN2; },
            infinite: false,
        }) as unknown as L.CRS;
    }

    // Top-view: simple linear mapping
    const pixelScale = dzi.sqr * scale;
    return L.Util.extend({}, L.CRS.Simple, {
        transformation: new L.Transformation(
            pixelScale,
            dzi.x0 * scale,
            -pixelScale,
            -dzi.y0 * scale,
        ),
    });
}

/** Convert a Leaflet LatLng to PZ game coordinates. */
function latLngToPz(ll: L.LatLng): { x: number; y: number } {
    return { x: ll.lng, y: -ll.lat };
}

const eventTypeColors: Record<string, string> = {
    pvp_hit: '#ef4444',
    death: '#9ca3af',
    connect: '#22c55e',
    disconnect: '#f59e0b',
};

export default function PzMap({
    markers = [],
    mapConfig,
    hasTiles,
    className = '',
    interactive = true,
    onMarkerClick,
    onMarkerAction,
    zones,
    drawingMode = false,
    onZoneDrawn,
    selectedZoneId,
    onZoneClick,
    eventMarkers,
    onEventMarkerClick,
    onMapReady,
}: PzMapProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<L.Map | null>(null);
    const markersLayerRef = useRef<L.LayerGroup | null>(null);
    const zonesLayerRef = useRef<L.LayerGroup | null>(null);
    const eventsLayerRef = useRef<L.LayerGroup | null>(null);
    const webglLayerRef = useRef<WebGLPZLayer | null>(null);

    // Browser-side WebGL2 renderer. Auto-loads the atlas when the server signals
    // that one is available (mapConfig.useWebGL) and the browser supports WebGL2.
    const wantWebGL = Boolean(mapConfig.useWebGL && mapConfig.dzi);
    const atlasBaseUrl = mapConfig.webGLAtlasUrl ?? '/pz-atlas';
    const webgl = usePzWebGLRenderer(wantWebGL ? atlasBaseUrl : '');

    // Available-cells manifest: Set<"x_y"> built from cells.json once.
    // null = still loading (filter disabled); populated Set = filter active.
    const [availableCells, setAvailableCells] = useState<Set<string> | null>(null);

    // Fetch cells manifest once when WebGL is active and a manifest URL is known.
    useEffect(() => {
        const manifestUrl = mapConfig.cellsManifestUrl;
        if (!wantWebGL || !manifestUrl) return;

        let cancelled = false;
        fetch(manifestUrl, { credentials: 'same-origin' })
            .then((res) => {
                if (!res.ok) return null;
                return res.json() as Promise<{ cells: [number, number][] }>;
            })
            .then((data) => {
                if (cancelled) return;
                // Even on 503 (no map data) install an empty Set rather than
                // leaving null — the tile renderer blocks on null waiting for
                // the manifest, so a permanent null would freeze rendering.
                const set = new Set<string>(
                    data ? data.cells.map(([cx, cy]) => `${cx}_${cy}`) : [],
                );
                setAvailableCells(set);
            })
            .catch(() => {
                if (cancelled) return;
                setAvailableCells(new Set());
            });

        return () => { cancelled = true; };
    }, [wantWebGL, mapConfig.cellsManifestUrl]); // eslint-disable-line react-hooks/exhaustive-deps

    const drawStateRef = useRef<{
        drawing: boolean;
        startLatLng: L.LatLng | null;
        previewRect: L.Rectangle | null;
    }>({ drawing: false, startLatLng: null, previewRect: null });

    // Stable refs for callbacks so event handlers always see latest values
    const onZoneDrawnRef = useRef(onZoneDrawn);
    onZoneDrawnRef.current = onZoneDrawn;
    const drawingModeRef = useRef(drawingMode);
    drawingModeRef.current = drawingMode;

    // Initialize map
    useEffect(() => {
        if (!containerRef.current || mapRef.current) return;

        const dzi = mapConfig.dzi;
        const crs = dzi ? createPzCRS(dzi) : L.CRS.Simple;
        const maxNativeZoom = dzi?.maxNativeZoom ?? mapConfig.maxZoom;

        const map = L.map(containerRef.current, {
            crs,
            minZoom: mapConfig.minZoom,
            maxZoom: mapConfig.maxZoom,
            // Default zoom control sits at topleft with 10px margin and gets
            // hidden behind the floating "Player Map" header. We add our own
            // control with a zoom-level readout below the header instead.
            zoomControl: false,
            dragging: interactive,
            scrollWheelZoom: interactive,
            doubleClickZoom: interactive,
            touchZoom: interactive,
            boxZoom: false, // Disable boxZoom so shift-drag doesn't conflict with drawing
            keyboard: interactive,
            attributionControl: false,
        });

        // PZ coords: Leaflet uses [lat, lng] = [-y, x]
        const center = L.latLng(-mapConfig.center.y, mapConfig.center.x);
        map.setView(center, mapConfig.defaultZoom);

        // No raster fallback — WebGL is the sole renderer. The coordinate
        // grid stays so the viewport always has a positional reference
        // when no cells are in view (e.g. overview zoom where WebGL
        // intentionally skips heavy lotpack loading).
        addCoordinateGrid(map);

        // DEBUG: log what Leaflet thinks the viewport is, so we can see whether
        // it sits over real cells.
        setTimeout(() => {
            const c = map.getCenter();
            const b = map.getBounds();
            console.log(
                `[DBG][view] mapConfig.center=(${mapConfig.center.x},${mapConfig.center.y}) defaultZoom=${mapConfig.defaultZoom} `
                + `→ leaflet center=lat${c.lat.toFixed(1)},lng${c.lng.toFixed(1)} `
                + `bounds=lat[${b.getSouth().toFixed(1)}..${b.getNorth().toFixed(1)}] `
                + `lng[${b.getWest().toFixed(1)}..${b.getEast().toFixed(1)}]`,
            );
        }, 500);

        const markersLayer = L.layerGroup().addTo(map);
        markersLayerRef.current = markersLayer;

        const zonesLayer = L.layerGroup().addTo(map);
        zonesLayerRef.current = zonesLayer;

        const eventsLayer = L.layerGroup().addTo(map);
        eventsLayerRef.current = eventsLayer;

        mapRef.current = map;

        if (interactive) {
            addZoomControlWithDisplay(map);
            addCoordinatesDisplay(map, mapConfig.dzi);
        }

        onMapReady?.(map);

        // Drawing event handlers
        map.on('mousedown', (e: L.LeafletMouseEvent) => {
            if (!drawingModeRef.current) return;
            const state = drawStateRef.current;
            state.drawing = true;
            state.startLatLng = e.latlng;
            map.dragging.disable();

            // Create preview rectangle
            state.previewRect = L.rectangle(
                [e.latlng, e.latlng],
                { color: '#22c55e', weight: 2, fillOpacity: 0.15, dashArray: '6 4' },
            ).addTo(map);
        });

        map.on('mousemove', (e: L.LeafletMouseEvent) => {
            const state = drawStateRef.current;
            if (!state.drawing || !state.startLatLng || !state.previewRect) return;
            state.previewRect.setBounds(L.latLngBounds(state.startLatLng, e.latlng));
        });

        map.on('mouseup', (e: L.LeafletMouseEvent) => {
            const state = drawStateRef.current;
            if (!state.drawing || !state.startLatLng) return;

            const start = latLngToPz(state.startLatLng);
            const end = latLngToPz(e.latlng);

            // Clean up preview
            if (state.previewRect) {
                map.removeLayer(state.previewRect);
                state.previewRect = null;
            }
            state.drawing = false;
            state.startLatLng = null;

            if (interactive) {
                map.dragging.enable();
            }

            // Minimum 10-unit size check prevents accidental micro-zones
            const x1 = Math.round(Math.min(start.x, end.x));
            const y1 = Math.round(Math.min(start.y, end.y));
            const x2 = Math.round(Math.max(start.x, end.x));
            const y2 = Math.round(Math.max(start.y, end.y));

            if (x2 - x1 < 10 || y2 - y1 < 10) return;

            onZoneDrawnRef.current?.({ x1, y1, x2, y2 });
        });

        return () => {
            map.remove();
            mapRef.current = null;
            markersLayerRef.current = null;
            zonesLayerRef.current = null;
            eventsLayerRef.current = null;
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // ---------------------------------------------------------------------------
    // Attach WebGLPZLayer once the renderer + atlas + sprite index are ready.
    //
    // The static-tile L.TileLayer added during init() stays underneath as a
    // fallback (it covers the same coordinates from pre-rendered pyramid).
    // When WebGL is ready we overlay the dynamic renderer on top — its tiles
    // are transparent where there's no cell data, so static tiles bleed
    // through for now.  As fetchCellData fills in, WebGL output takes over.
    // ---------------------------------------------------------------------------
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapConfig.dzi) {
            console.log(`[DBG][layer] skip: map=${!!map} dzi=${!!mapConfig.dzi}`);
            return;
        }
        if (!webgl.renderer || !webgl.atlasManager || !webgl.spriteIndex || !webgl.lods) {
            console.log(`[DBG][layer] WebGL not ready: renderer=${!!webgl.renderer} atlasManager=${!!webgl.atlasManager} sprites=${!!webgl.spriteIndex} lods=${!!webgl.lods} progress=${webgl.progress} error=${webgl.error}`);
            return;
        }
        console.log(`[DBG][layer] attaching WebGLPZLayer, availableCells=${availableCells?.size ?? 'undefined/null'} lods=${webgl.lods.length} cellPages=${webgl.cellPages !== null}`);

        const projection: DziProjection = {
            x0: mapConfig.dzi.x0,
            y0: mapConfig.dzi.y0,
            worldX0: mapConfig.dzi.worldX0,
            worldY0: mapConfig.dzi.worldY0,
            sqr: mapConfig.dzi.sqr,
            maxNativeZoom: mapConfig.dzi.maxNativeZoom,
            isometric: mapConfig.dzi.isometric,
            width: mapConfig.dzi.width,
            height: mapConfig.dzi.height,
            // Converts pzmap2dzi native pixels (sprite atlas, offsets) to
            // effective DZI pixels. = 1/2^skip; required by vertex shader
            // to place native-sized sprites correctly.
            nativeToEffective: mapConfig.dzi.nativeToEffective,
        };

        // Determine cell size in squares from version constants.
        // B41: 30 blocks × 10 sq/block = 300 squares per cell side.
        // B42: 32 blocks × 8 sq/block  = 256 squares per cell side.
        // We use B42 as the default; the actual cell header version is parsed
        // per-cell by the worker, so this value only affects which cells we
        // request — the cell-size determines cell-coordinate → URL mapping.
        const cellSize =
            VERSION_LIMITATIONS[1].CELL_SIZE_IN_BLOCKS *
            VERSION_LIMITATIONS[1].BLOCK_SIZE_IN_SQUARES; // 256 (B42)

        const apiBaseUrl = '/admin/api/pz-map';

        // We now render at every zoom. The renderer decimates squares and
        // picks a smaller mip level automatically when pixelsPerSquare drops
        // below 1, so an overview tile is cheap to compute and visually
        // correct (no sub-pixel aliasing / "triangles" from massive overdraw).
        const webglMinZoom = mapConfig.minZoom;

        // WebGL layer uses tileSize=1024 (see WebGLPZLayer constructor) — must
        // match here so cell selection covers the full tile pixel range.
        const WEBGL_TILE_SIZE = 1024;
        const fetchCellData = (z: number, x: number, y: number): Promise<CellData[]> => {
            return fetchCellsForTile(
                z,
                x,
                y,
                WEBGL_TILE_SIZE,
                projection,
                cellSize,
                apiBaseUrl,
                workerPool,
                defaultCellCache,
                availableCells,
            );
        };

        const layer = new WebGLPZLayer(webgl.renderer, {
            atlasManager: webgl.atlasManager,
            lods: webgl.lods,
            cellPages: webgl.cellPages,
            uvFormat: webgl.uvFormat,
            spriteIndex: webgl.spriteIndex,
            projection,
            fetchCellData,
            minZoom: webglMinZoom,
            maxZoom: mapConfig.maxZoom,
            // Ground floor only by default — upper floors would occlude the
            // walkable layer. Future UI lets the user pick a floor.
            layerRange: { min: 0, max: 0 },
        });
        layer.addTo(map);
        webglLayerRef.current = layer;

        return () => {
            if (webglLayerRef.current) {
                map.removeLayer(webglLayerRef.current);
                webglLayerRef.current = null;
            }
        };
    }, [webgl.renderer, webgl.atlasManager, webgl.spriteIndex, webgl.lods, webgl.cellPages, webgl.uvFormat, mapConfig.dzi, mapConfig.minZoom, mapConfig.maxZoom, availableCells]);

    // Update cursor for drawing mode
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        container.style.cursor = drawingMode ? 'crosshair' : '';
    }, [drawingMode]);

    // Cancel drawing on Escape
    const handleKeyDown = useCallback((e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            const state = drawStateRef.current;
            if (state.previewRect && mapRef.current) {
                mapRef.current.removeLayer(state.previewRect);
            }
            state.drawing = false;
            state.startLatLng = null;
            state.previewRect = null;
            if (interactive && mapRef.current) {
                mapRef.current.dragging.enable();
            }
        }
    }, [interactive]);

    useEffect(() => {
        if (drawingMode) {
            window.addEventListener('keydown', handleKeyDown);
            return () => window.removeEventListener('keydown', handleKeyDown);
        }
    }, [drawingMode, handleKeyDown]);

    // Update markers when data changes
    useEffect(() => {
        const layer = markersLayerRef.current;
        if (!layer) return;

        layer.clearLayers();

        markers.forEach((marker) => {
            const label = marker.name && marker.name !== marker.username
                ? `${marker.name} (${marker.username})`
                : marker.username;
            const icon = createMarkerIcon(marker.status, label);
            const popup = L.popup().setContent(createPopupHtml(marker));
            const lMarker = L.marker([-marker.y, marker.x], { icon })
                .bindPopup(popup)
                .addTo(layer);

            lMarker.on('popupopen', () => {
                const container = popup.getElement();
                if (!container) return;
                container.querySelectorAll<HTMLButtonElement>('.pz-action').forEach((btn) => {
                    btn.addEventListener('click', (ev) => {
                        const action = (ev.currentTarget as HTMLButtonElement).dataset.action as MarkerAction;
                        if (action && onMarkerAction) {
                            onMarkerAction(marker, action);
                            lMarker.closePopup();
                        }
                    });
                });
            });

            if (onMarkerClick) {
                lMarker.on('click', () => onMarkerClick(marker));
            }
        });
    }, [markers, onMarkerClick, onMarkerAction]);

    // Update zone overlays
    useEffect(() => {
        const layer = zonesLayerRef.current;
        if (!layer) return;

        layer.clearLayers();
        if (!zones) return;

        zones.forEach((zone) => {
            const bounds = L.latLngBounds(
                L.latLng(-zone.y1, zone.x1),
                L.latLng(-zone.y2, zone.x2),
            );

            const isSelected = selectedZoneId === zone.id;
            const rect = L.rectangle(bounds, {
                color: zone.color,
                weight: isSelected ? 3 : 2,
                fillOpacity: isSelected ? 0.25 : 0.1,
                dashArray: isSelected ? undefined : '8 4',
            }).addTo(layer);

            rect.bindTooltip(zone.name, {
                permanent: true,
                direction: 'center',
                className: 'pz-zone-tooltip',
            });

            if (onZoneClick) {
                rect.on('click', () => onZoneClick(zone));
            }
        });
    }, [zones, selectedZoneId, onZoneClick]);

    // Update event markers
    useEffect(() => {
        const layer = eventsLayerRef.current;
        if (!layer) return;

        layer.clearLayers();
        if (!eventMarkers) return;

        eventMarkers.forEach((em) => {
            const color = eventTypeColors[em.type] ?? '#9ca3af';
            const circle = L.circleMarker([-em.y, em.x], {
                radius: 7,
                color,
                fillColor: color,
                fillOpacity: 0.7,
                weight: 2,
            }).addTo(layer);

            const typeLabel = em.type.replace('_', ' ');
            const targetInfo = em.target ? `<br/><small>Target: ${em.target}</small>` : '';
            circle.bindPopup(
                `<div style="min-width:120px;">
                    <strong>${em.player}</strong><br/>
                    <span style="color:${color};text-transform:capitalize;">${typeLabel}</span>
                    ${targetInfo}<br/>
                    <small style="color:#9ca3af;">X: ${em.x}, Y: ${em.y}</small>
                </div>`,
            );

            if (onEventMarkerClick) {
                circle.on('click', () => onEventMarkerClick(em));
            }
        });
    }, [eventMarkers, onEventMarkerClick]);

    const showOverlay = webgl.progress !== null && webgl.error === null;
    const pct = Math.round((webgl.progress ?? 0) * 100);

    return (
        <div className={`relative isolate h-full w-full ${className}`}>
            <div ref={containerRef} className="absolute inset-0" />
            {wantWebGL && webgl.renderer && mapConfig.dzi && (
                <RenderTuningPanel
                    map={mapRef.current}
                    projection={{
                        sqr: mapConfig.dzi.sqr,
                        maxNativeZoom: mapConfig.dzi.maxNativeZoom,
                    }}
                />
            )}
            {showOverlay && (
                <div className="absolute inset-0 z-[1000] flex flex-col items-center justify-center bg-zinc-950/85 text-zinc-100 backdrop-blur-sm">
                    <div className="w-72 max-w-[80%] space-y-3">
                        <div className="flex items-baseline justify-between">
                            <span className="text-sm font-medium">{webgl.progressLabel ?? 'Загрузка…'}</span>
                            <span className="font-mono text-xs text-zinc-400">{pct}%</span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                            <div
                                className="h-full bg-emerald-500 transition-[width] duration-150 ease-out"
                                style={{ width: `${pct}%` }}
                            />
                        </div>
                        <p className="text-center text-xs text-zinc-500">
                            Первая загрузка скачивает спрайты и геометрию карты целиком.
                            Следующие визиты будут мгновенными благодаря кэшу.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * Cursor coordinates readout in the bottom-left corner.
 *
 * Shows BOTH coordinate systems so we can diagnose render bugs:
 *   - Local PZ X/Y     — what Leaflet's latlng natively maps to (origin = DZI 0,0)
 *   - World PZ X/Y     — global PZ square coords used by the WebGL renderer and
 *                        the on-disk cell filename (Cell X_Y .lotheader)
 *   - Cell  X_Y        — world cell index = floor(world XY / cellSize)
 *
 * The two systems differ when the local DZI image is shifted from the PZ world
 * origin (see MapConfigBuilder::getLocalDziConfig — x0/y0 anchored at 0, but
 * worldX0/worldY0 carry the actual shift).
 */
function addCoordinatesDisplay(map: L.Map, dzi: DziInfo | null | undefined): L.Control {
    const CELL_SIZE = 256; // B42; B41 = 300 (see VERSION_LIMITATIONS).

    // Pre-compute the local→world offset in PZ-square units. The math is the
    // closed form of: leaflet.latlng → DZI pixel (with x0=0) → subtract
    // worldX0/Y0 → world square. The result is a linear shift in (sx, sy).
    let dx = 0, dy = 0;
    if (dzi && dzi.isometric) {
        const halfSqr = dzi.sqr / 2;
        const quarterSqr = dzi.sqr / 4;
        const wX0 = dzi.worldX0 ?? dzi.x0 ?? 0;
        const wY0 = dzi.worldY0 ?? dzi.y0 ?? 0;
        // sx_world = sx_local - (worldX0/halfSqr + worldY0/quarterSqr) / 2
        // sy_world = sy_local - (worldY0/quarterSqr - worldX0/halfSqr) / 2
        dx = (wX0 / halfSqr + wY0 / quarterSqr) / 2;
        dy = (wY0 / quarterSqr - wX0 / halfSqr) / 2;
    } else if (dzi) {
        const sqr = dzi.sqr || 1;
        const wX0 = dzi.worldX0 ?? dzi.x0 ?? 0;
        const wY0 = dzi.worldY0 ?? dzi.y0 ?? 0;
        dx = wX0 / sqr;
        dy = wY0 / sqr;
    }

    const Display = L.Control.extend({
        options: { position: 'bottomleft' as L.ControlPosition },
        onAdd(this: L.Control) {
            const container = L.DomUtil.create('div', 'leaflet-control pz-coords-display');
            container.style.padding = '4px 8px';
            container.style.fontSize = '11px';
            container.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
            container.style.background = 'rgba(15,15,15,0.78)';
            container.style.color = '#e5e7eb';
            container.style.borderRadius = '4px';
            container.style.boxShadow = '0 1px 3px rgba(0,0,0,0.4)';
            container.style.userSelect = 'text';
            container.style.pointerEvents = 'none';
            container.style.whiteSpace = 'nowrap';
            container.textContent = 'world —   local —   cell —';

            const handleMove = (e: L.LeafletMouseEvent) => {
                const localX = e.latlng.lng;
                const localY = -e.latlng.lat;
                const worldX = Math.round(localX - dx);
                const worldY = Math.round(localY - dy);
                const cellX = Math.floor(worldX / CELL_SIZE);
                const cellY = Math.floor(worldY / CELL_SIZE);
                container.textContent =
                    `world ${worldX}, ${worldY}   local ${Math.round(localX)}, ${Math.round(localY)}   cell ${cellX}_${cellY}`;
            };
            const handleOut = () => {
                container.textContent = 'world —   local —   cell —';
            };

            map.on('mousemove', handleMove);
            map.on('mouseout', handleOut);
            (container as HTMLElement & { _coordsCleanup?: () => void })._coordsCleanup = () => {
                map.off('mousemove', handleMove);
                map.off('mouseout', handleOut);
            };
            return container;
        },
        onRemove(this: L.Control) {
            const el = this.getContainer() as (HTMLElement & { _coordsCleanup?: () => void }) | null;
            el?._coordsCleanup?.();
        },
    });

    const ctrl = new Display();
    ctrl.addTo(map);
    return ctrl;
}

/**
 * Custom zoom control: [ + ] [ current zoom ] [ − ], stacked vertically below
 * the floating header. Replaces the default Leaflet zoom control which gets
 * occluded by the header.
 */
function addZoomControlWithDisplay(map: L.Map): L.Control {
    const ZoomDisplay = L.Control.extend({
        options: { position: 'topleft' as L.ControlPosition },
        onAdd(this: L.Control) {
            const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control pz-zoom-control');
            // Push below the floating "Player Map" header (top-3 + header height).
            container.style.marginTop = '80px';
            L.DomEvent.disableClickPropagation(container);
            L.DomEvent.disableScrollPropagation(container);

            const makeBtn = (label: string, title: string, onClick: () => void): HTMLAnchorElement => {
                const a = L.DomUtil.create('a', '', container) as HTMLAnchorElement;
                a.href = '#';
                a.title = title;
                a.setAttribute('role', 'button');
                a.setAttribute('aria-label', title);
                a.innerHTML = label;
                L.DomEvent.on(a, 'click', (e) => {
                    L.DomEvent.preventDefault(e);
                    onClick();
                });
                return a;
            };

            const plusBtn = makeBtn('+', 'Zoom in', () => map.zoomIn());

            const zoomLabel = L.DomUtil.create('span', 'pz-zoom-display', container);
            zoomLabel.style.display = 'block';
            zoomLabel.style.textAlign = 'center';
            zoomLabel.style.minWidth = '30px';
            zoomLabel.style.height = '26px';
            zoomLabel.style.lineHeight = '26px';
            zoomLabel.style.fontSize = '11px';
            zoomLabel.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
            zoomLabel.style.background = '#fff';
            zoomLabel.style.color = '#000';
            zoomLabel.style.borderTop = '1px solid #ccc';
            zoomLabel.style.borderBottom = '1px solid #ccc';
            zoomLabel.style.userSelect = 'none';
            zoomLabel.setAttribute('title', 'Current zoom level');

            const minusBtn = makeBtn('&minus;', 'Zoom out', () => map.zoomOut());

            const updateZoom = () => {
                const z = map.getZoom();
                // Two decimals — Leaflet zoom is a float when scrollWheelZoom
                // is enabled, so .5/.25 steps are common.
                zoomLabel.textContent = (Math.round(z * 100) / 100).toString();
                const min = map.getMinZoom();
                const max = map.getMaxZoom();
                plusBtn.classList.toggle('leaflet-disabled', z >= max);
                minusBtn.classList.toggle('leaflet-disabled', z <= min);
            };
            updateZoom();
            map.on('zoom zoomend', updateZoom);
            // Store cleanup on the container so onRemove can find it.
            (container as HTMLElement & { _zoomCleanup?: () => void })._zoomCleanup = () => {
                map.off('zoom zoomend', updateZoom);
            };

            return container;
        },
        onRemove(this: L.Control) {
            const el = this.getContainer() as (HTMLElement & { _zoomCleanup?: () => void }) | null;
            el?._zoomCleanup?.();
        },
    });

    const ctrl = new ZoomDisplay();
    ctrl.addTo(map);
    return ctrl;
}

function addCoordinateGrid(map: L.Map) {
    const gridStyle: L.PolylineOptions = {
        color: '#374151',
        weight: 0.5,
        opacity: 0.5,
    };

    // Draw grid lines every 1000 PZ units
    for (let coord = 0; coord <= 20000; coord += 1000) {
        // Vertical lines (constant x)
        L.polyline(
            [
                [-0, coord],
                [-20000, coord],
            ],
            gridStyle,
        ).addTo(map);

        // Horizontal lines (constant y)
        L.polyline(
            [
                [-coord, 0],
                [-coord, 20000],
            ],
            gridStyle,
        ).addTo(map);
    }

    // Add coordinate labels at grid intersections for key points
    const labelPoints = [5000, 10000, 15000];
    labelPoints.forEach((x) => {
        labelPoints.forEach((y) => {
            L.marker([-y, x], {
                icon: L.divIcon({
                    className: 'pz-grid-label',
                    html: `<span style="
                        font-size: 10px;
                        color: #6b7280;
                        white-space: nowrap;
                        pointer-events: none;
                    ">${x},${y}</span>`,
                    iconSize: [50, 14],
                    iconAnchor: [25, 7],
                }),
                interactive: false,
            }).addTo(map);
        });
    });
}
