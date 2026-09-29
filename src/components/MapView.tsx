"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { squareCorners, localToLngLat, kmPerDegLng, KM_PER_DEG_LAT, type RotatedSquare } from "@/lib/geo";

type BasemapId = "osm" | "topo" | "satellite" | "satellite-hillshade";

const BASEMAPS: Record<
  BasemapId,
  { label: string; sources: maplibregl.StyleSpecification["sources"]; layers: maplibregl.LayerSpecification[] }
> = {
  osm: {
    label: "Streets",
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors",
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  },
  topo: {
    label: "Topo",
    sources: {
      topo: {
        type: "raster",
        tiles: [
          "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
          "https://b.tile.opentopomap.org/{z}/{x}/{y}.png",
          "https://c.tile.opentopomap.org/{z}/{x}/{y}.png",
        ],
        tileSize: 256,
        attribution: "© OpenTopoMap (CC-BY-SA), © OpenStreetMap contributors, SRTM",
      },
    },
    layers: [{ id: "topo", type: "raster", source: "topo" }],
  },
  satellite: {
    label: "Satellite",
    sources: {
      sat: {
        type: "raster",
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        attribution: "© Esri, Maxar, Earthstar Geographics",
      },
    },
    layers: [{ id: "sat", type: "raster", source: "sat" }],
  },
  "satellite-hillshade": {
    label: "Satellite + Relief",
    sources: {
      sat: {
        type: "raster",
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        attribution: "© Esri, Maxar, Earthstar Geographics",
      },
      hillshade: {
        type: "raster",
        tiles: [
          "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
        ],
        tileSize: 256,
        attribution: "© Esri",
      },
    },
    layers: [
      { id: "sat", type: "raster", source: "sat" },
      { id: "hillshade", type: "raster", source: "hillshade", paint: { "raster-opacity": 0.45 } },
    ],
  },
};

const MAX_AREA_KM2 = 100 * 100;
const RESOLUTIONS = [512, 1024, 2048, 4096] as const;
const FORMATS = [
  { id: "png16", label: "16-bit PNG" },
  { id: "png8", label: "8-bit PNG" },
  { id: "r16", label: "RAW .r16 (16-bit)" },
  { id: "geotiff", label: "GeoTIFF (32-bit float)" },
] as const;

function styleFor(id: BasemapId): maplibregl.StyleSpecification {
  const b = BASEMAPS[id];
  return {
    version: 8,
    sources: b.sources,
    layers: b.layers,
  } as maplibregl.StyleSpecification;
}

function squareToGeoJSON(square: RotatedSquare): GeoJSON.Feature<GeoJSON.Polygon> {
  const corners = squareCorners(square).map((c) => [c.lng, c.lat] as [number, number]);
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [[...corners, corners[0]]] },
  };
}

export default function MapView() {
  const mapDiv = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const rotateMarkerRef = useRef<maplibregl.Marker | null>(null);
  const drawingRef = useRef(false);
  const startLngLatRef = useRef<{ lng: number; lat: number } | null>(null);
  const isFirstBasemapRender = useRef(true);

  const [basemap, setBasemap] = useState<BasemapId>("osm");
  const [square, setSquare] = useState<RotatedSquare | null>(null);
  const [format, setFormat] = useState<(typeof FORMATS)[number]["id"]>("png16");
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]>(2048);
  const [normalization, setNormalization] = useState<"selection" | "fixed">("selection");
  const [sidecar, setSidecar] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExportTooltip, setShowExportTooltip] = useState(false);
  const [elevationStats, setElevationStats] = useState<{ min: number; max: number } | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const tooBig = square !== null && square.sideKm * square.sideKm > MAX_AREA_KM2;

  const renderSelection = useCallback((map: MLMap, sq: RotatedSquare) => {
    const src = map.getSource("selection") as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(squareToGeoJSON(sq));

    const handlePos = localToLngLat(sq, 0, sq.sideKm / 2);
    if (!rotateMarkerRef.current) {
      const el = document.createElement("div");
      el.style.width = "14px";
      el.style.height = "14px";
      el.style.borderRadius = "50%";
      el.style.background = "#22c55e";
      el.style.border = "2px solid white";
      el.style.boxShadow = "0 1px 3px rgba(0,0,0,0.4)";
      el.style.cursor = "grab";
      const marker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([handlePos.lng, handlePos.lat])
        .addTo(map);
      marker.on("drag", () => {
        const cur = marker.getLngLat();
        setSquare((prevSq) => {
          if (!prevSq) return prevSq;
          const kmLng = kmPerDegLng(prevSq.centerLat);
          const dx = (cur.lng - prevSq.centerLng) * kmLng;
          const dy = (cur.lat - prevSq.centerLat) * KM_PER_DEG_LAT;
          const rotationDeg = (Math.atan2(-dx, dy) * 180) / Math.PI;
          const next = { ...prevSq, rotationDeg };

          // update the polygon + marker position imperatively right away —
          // no need to go through renderSelection again for a rotation-only change
          const constrainedPos = localToLngLat(next, 0, next.sideKm / 2);
          marker.setLngLat([constrainedPos.lng, constrainedPos.lat]);
          const m = mapRef.current;
          const src = m?.getSource("selection") as maplibregl.GeoJSONSource | undefined;
          if (src) src.setData(squareToGeoJSON(next));

          return next;
        });
      });
      rotateMarkerRef.current = marker;
    } else {
      rotateMarkerRef.current.setLngLat([handlePos.lng, handlePos.lat]);
    }
  }, []);

  const drawSquare = useCallback(
    (map: MLMap, start: { lng: number; lat: number }, cur: { lng: number; lat: number }) => {
      // constrain to a square in km-space, anchored at start
      const kmPerLng = kmPerDegLng(start.lat);
      const dxKm = (cur.lng - start.lng) * kmPerLng;
      const dyKm = (cur.lat - start.lat) * KM_PER_DEG_LAT;
      const side = Math.max(Math.abs(dxKm), Math.abs(dyKm));
      const signX = dxKm >= 0 ? 1 : -1;
      const signY = dyKm >= 0 ? 1 : -1;
      const endLng = start.lng + (signX * side) / kmPerLng;
      const endLat = start.lat + (signY * side) / KM_PER_DEG_LAT;

      const centerLng = (start.lng + endLng) / 2;
      const centerLat = (start.lat + endLat) / 2;
      const sq: RotatedSquare = { centerLng, centerLat, sideKm: side, rotationDeg: 0 };

      setSquare(sq);
      renderSelection(map, sq);
    },
    [renderSelection]
  );

  useEffect(() => {
    if (!mapDiv.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapDiv.current,
      style: styleFor("osm"),
      center: [10.45, 51.16],
      zoom: 5,
    });
    mapRef.current = map;

    map.on("load", () => {
      map.addSource("selection", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "selection-fill",
        type: "fill",
        source: "selection",
        paint: { "fill-color": "#22c55e", "fill-opacity": 0.15 },
      });
      map.addLayer({
        id: "selection-line",
        type: "line",
        source: "selection",
        paint: { "line-color": "#22c55e", "line-width": 2 },
      });
    });

    const onMouseDown = (e: maplibregl.MapMouseEvent) => {
      if (!e.originalEvent.shiftKey) return; // shift+drag to draw, so normal pan still works
      e.preventDefault();
      drawingRef.current = true;
      startLngLatRef.current = { lng: e.lngLat.lng, lat: e.lngLat.lat };
      map.dragPan.disable();
    };
    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      if (!drawingRef.current || !startLngLatRef.current) return;
      drawSquare(map, startLngLatRef.current, { lng: e.lngLat.lng, lat: e.lngLat.lat });
    };
    const onMouseUp = () => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      map.dragPan.enable();
    };

    map.on("mousedown", onMouseDown);
    map.on("mousemove", onMouseMove);
    map.on("mouseup", onMouseUp);

    return () => {
      map.off("mousedown", onMouseDown);
      map.off("mousemove", onMouseMove);
      map.off("mouseup", onMouseUp);
      map.remove();
      mapRef.current = null;
    };
  }, [drawSquare]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (isFirstBasemapRender.current) {
      isFirstBasemapRender.current = false;
      return;
    }
    map.setStyle(styleFor(basemap));
    map.once("styledata", () => {
      if (!map.getSource("selection")) {
        map.addSource("selection", {
          type: "geojson",
          data: square ? squareToGeoJSON(square) : { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "selection-fill",
          type: "fill",
          source: "selection",
          paint: { "fill-color": "#22c55e", "fill-opacity": 0.15 },
        });
        map.addLayer({
          id: "selection-line",
          type: "line",
          source: "selection",
          paint: { "line-color": "#22c55e", "line-width": 2 },
        });
        if (square) renderSelection(map, square);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap]);

  useEffect(() => {
    // stale elevationStats from a previous selection is harmless here — the
    // JSX only ever displays it while `square && !tooBig`, same guard as below
    if (!square || tooBig) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setStatsLoading(true);
      try {
        const res = await fetch("/api/elevation-stats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ square }),
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) setElevationStats({ min: data.min, max: data.max });
      } catch {
        if (!cancelled) setElevationStats(null);
      } finally {
        if (!cancelled) setStatsLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [square, tooBig]);

  async function handleExport() {
    if (!square) return;
    setExporting(true);
    setError(null);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ square, format, resolution, normalization, sidecar }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error ?? `Export failed (${res.status})`);
      }

      const ext = format === "geotiff" ? "tif" : format === "r16" ? "r16" : "png";
      const contentType = res.headers.get("Content-Type") ?? "";

      const download = (blob: Blob, name: string) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      };

      if (contentType.includes("application/json")) {
        const { image, contentType: imgType, sidecar: sidecarData } = await res.json();
        const imgBytes = Uint8Array.from(atob(image), (c) => c.charCodeAt(0));
        download(new Blob([imgBytes], { type: imgType }), `heightmap.${ext}`);
        download(
          new Blob([JSON.stringify(sidecarData, null, 2)], { type: "application/json" }),
          "heightmap.json"
        );
      } else {
        download(await res.blob(), `heightmap.${ext}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="relative flex-1 w-full h-full min-h-0">
      <div ref={mapDiv} className="absolute inset-0 h-full w-full" />

      {/* Basemap switcher */}
      <div className="absolute top-3 left-3 flex gap-1 rounded-lg bg-white/90 p-1 shadow backdrop-blur dark:bg-black/70">
        {(Object.keys(BASEMAPS) as BasemapId[]).map((id) => (
          <button
            key={id}
            onClick={() => setBasemap(id)}
            className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
              basemap === id
                ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
                : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
          >
            {BASEMAPS[id].label}
          </button>
        ))}
      </div>

      {/* Hint */}
      {!square && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 rounded-lg bg-white/90 px-3 py-1.5 text-xs text-zinc-600 shadow backdrop-blur dark:bg-black/70 dark:text-zinc-300">
          Shift + drag to select a square region
        </div>
      )}
      {square && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 rounded-lg bg-white/90 px-3 py-1.5 text-xs text-zinc-600 shadow backdrop-blur dark:bg-black/70 dark:text-zinc-300">
          Drag the green dot to rotate the selection
        </div>
      )}

      {/* Export panel */}
      <div className="absolute top-3 right-3 w-64 rounded-xl bg-white/95 p-4 shadow-lg backdrop-blur dark:bg-black/80">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Export heightmap</h2>
          <div className="relative">
            <button
              onClick={() => setShowHelp((v) => !v)}
              aria-label="How to use"
              className="flex h-5 w-5 items-center justify-center rounded-full border border-zinc-300 text-[11px] font-semibold text-zinc-500 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              ?
            </button>
            {showHelp && (
              <div className="absolute right-0 top-full z-10 mt-2 w-72 rounded-lg bg-white p-3 text-xs leading-relaxed text-zinc-700 shadow-xl dark:bg-zinc-900 dark:text-zinc-300">
                <p className="mb-2 font-semibold text-zinc-900 dark:text-zinc-100">How to use</p>
                <ol className="list-decimal space-y-1.5 pl-4">
                  <li>Pick a basemap (top-left) to help find your region.</li>
                  <li>Hold <strong>Shift</strong> and drag on the map to select a square (max 100 km). Bigger regions lose detail per pixel at the same resolution.</li>
                  <li>Drag the green dot to rotate the selection, if needed.</li>
                  <li>Choose format, resolution, and normalization below.</li>
                  <li>Click <strong>Export</strong> to download.</li>
                </ol>
                <p className="mt-2 text-zinc-500 dark:text-zinc-400">
                  GeoTIFF stores raw elevation in meters (not 0–1), so it looks
                  solid white in plain image viewers — open it in a GIS tool
                  (QGIS, gdal) instead.
                </p>
              </div>
            )}
          </div>
        </div>

        {square ? (
          <>
            <p className={`text-xs ${tooBig ? "text-red-600" : "text-zinc-500 dark:text-zinc-400"}`}>
              {square.sideKm.toFixed(1)} km × {square.sideKm.toFixed(1)} km
              {tooBig && ` — exceeds ${Math.round(Math.sqrt(MAX_AREA_KM2))}km max`}
              {" · "}
              {Math.round(((square.rotationDeg % 360) + 360) % 360)}°
            </p>
            {!tooBig && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Elevation:{" "}
                {statsLoading && !elevationStats
                  ? "…"
                  : elevationStats
                  ? `${Math.round(elevationStats.min)}–${Math.round(elevationStats.max)} m`
                  : "—"}
              </p>
            )}
            {!tooBig && square.sideKm > 30 && (
              <p className="mb-3 text-xs text-amber-600 dark:text-amber-500">
                Larger regions pack less detail per pixel than smaller ones
                at the same resolution — pick a higher resolution or a
                smaller area for sharper output.
              </p>
            )}
            {(tooBig || square.sideKm <= 30) && <div className="mb-3" />}
          </>
        ) : (
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">No region selected</p>
        )}

        <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">Format</label>
        <select
          value={format}
          onChange={(e) => setFormat(e.target.value as typeof format)}
          className="mb-3 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          {FORMATS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>

        <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">Resolution</label>
        <select
          value={resolution}
          onChange={(e) => setResolution(Number(e.target.value) as typeof resolution)}
          className="mb-3 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          {RESOLUTIONS.map((r) => (
            <option key={r} value={r}>
              {r} × {r}
            </option>
          ))}
        </select>

        <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">Normalization</label>
        <select
          value={normalization}
          onChange={(e) => setNormalization(e.target.value as typeof normalization)}
          className="mb-3 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="selection">Best contrast (per-export)</option>
          <option value="fixed">Fixed scale (0–9000m)</option>
        </select>

        <label className="mb-4 flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={sidecar} onChange={(e) => setSidecar(e.target.checked)} />
          Include georeference sidecar (.json)
        </label>

        <div
          className="relative"
          onMouseEnter={() => setShowExportTooltip(true)}
          onMouseLeave={() => setShowExportTooltip(false)}
        >
          <button
            onClick={handleExport}
            disabled={!square || tooBig || exporting}
            className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-black"
          >
            {exporting ? "Exporting…" : "Export"}
          </button>

          {showExportTooltip && !square && (
            <div className="absolute bottom-full left-1/2 mb-2 w-max max-w-56 -translate-x-1/2 rounded-md bg-zinc-900 px-2.5 py-1.5 text-xs text-white shadow-lg dark:bg-white dark:text-black">
              Shift + drag on the map to select a region first
            </div>
          )}
        </div>

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </div>

      {/* Attribution footer */}
      <div className="absolute bottom-1 right-2 text-[10px] text-zinc-500 bg-white/70 dark:bg-black/50 px-1.5 py-0.5 rounded">
        {BASEMAPS[basemap].sources[Object.keys(BASEMAPS[basemap].sources)[0]] &&
          (BASEMAPS[basemap].sources[Object.keys(BASEMAPS[basemap].sources)[0]] as maplibregl.RasterSourceSpecification)
            .attribution}
        {" · Elevation: Tilezen / AWS Terrain Tiles"}
      </div>
    </div>
  );
}
