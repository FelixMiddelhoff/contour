"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

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

const MAX_AREA_KM2 = 50 * 50;
const RESOLUTIONS = [512, 1024, 2048, 4096] as const;
const FORMATS = [
  { id: "png16", label: "16-bit PNG" },
  { id: "png8", label: "8-bit PNG" },
  { id: "r16", label: "RAW .r16 (16-bit)" },
  { id: "geotiff", label: "GeoTIFF (32-bit float) — coming soon", disabled: true },
] as const;

function styleFor(id: BasemapId): maplibregl.StyleSpecification {
  const b = BASEMAPS[id];
  return {
    version: 8,
    sources: b.sources,
    layers: b.layers,
  } as maplibregl.StyleSpecification;
}

// haversine-based square side length in km for a given lng/lat delta at a center lat
function kmPerDegLng(lat: number) {
  return 111.32 * Math.cos((lat * Math.PI) / 180);
}
const KM_PER_DEG_LAT = 111.32;

export default function MapView() {
  const mapDiv = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const drawingRef = useRef(false);
  const startLngLatRef = useRef<{ lng: number; lat: number } | null>(null);
  const isFirstBasemapRender = useRef(true);

  const [basemap, setBasemap] = useState<BasemapId>("osm");
  const [bbox, setBbox] = useState<[number, number, number, number] | null>(null); // [minLng, minLat, maxLng, maxLat]
  const [sideKm, setSideKm] = useState(0);
  const [format, setFormat] = useState<(typeof FORMATS)[number]["id"]>("png16");
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]>(2048);
  const [normalization, setNormalization] = useState<"selection" | "fixed">("selection");
  const [sidecar, setSidecar] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExportTooltip, setShowExportTooltip] = useState(false);

  const tooBig = sideKm * sideKm > MAX_AREA_KM2;

  const drawSquare = useCallback((map: MLMap, start: { lng: number; lat: number }, cur: { lng: number; lat: number }) => {
    // constrain to a square in km-space, anchored at start
    const kmPerLng = kmPerDegLng(start.lat);
    const dxKm = (cur.lng - start.lng) * kmPerLng;
    const dyKm = (cur.lat - start.lat) * KM_PER_DEG_LAT;
    const side = Math.max(Math.abs(dxKm), Math.abs(dyKm));
    const signX = dxKm >= 0 ? 1 : -1;
    const signY = dyKm >= 0 ? 1 : -1;
    const endLng = start.lng + (signX * side) / kmPerLng;
    const endLat = start.lat + (signY * side) / KM_PER_DEG_LAT;

    const minLng = Math.min(start.lng, endLng);
    const maxLng = Math.max(start.lng, endLng);
    const minLat = Math.min(start.lat, endLat);
    const maxLat = Math.max(start.lat, endLat);

    setBbox([minLng, minLat, maxLng, maxLat]);
    setSideKm(side);

    const src = map.getSource("selection") as maplibregl.GeoJSONSource | undefined;
    const geojson: GeoJSON.Feature<GeoJSON.Polygon> = {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [minLng, minLat],
            [maxLng, minLat],
            [maxLng, maxLat],
            [minLng, maxLat],
            [minLng, minLat],
          ],
        ],
      },
    };
    if (src) src.setData(geojson);
  }, []);

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

    const canvas = map.getCanvasContainer();

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
          data: bbox
            ? {
                type: "Feature",
                properties: {},
                geometry: {
                  type: "Polygon",
                  coordinates: [
                    [
                      [bbox[0], bbox[1]],
                      [bbox[2], bbox[1]],
                      [bbox[2], bbox[3]],
                      [bbox[0], bbox[3]],
                      [bbox[0], bbox[1]],
                    ],
                  ],
                },
              }
            : { type: "FeatureCollection", features: [] },
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
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap]);

  async function handleExport() {
    if (!bbox) return;
    setExporting(true);
    setError(null);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bbox, format, resolution, normalization, sidecar }),
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
        download(new Blob([imgBytes], { type: imgType }), `contour-heightmap.${ext}`);
        download(
          new Blob([JSON.stringify(sidecarData, null, 2)], { type: "application/json" }),
          "contour-heightmap.json"
        );
      } else {
        download(await res.blob(), `contour-heightmap.${ext}`);
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
      {!bbox && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 rounded-lg bg-white/90 px-3 py-1.5 text-xs text-zinc-600 shadow backdrop-blur dark:bg-black/70 dark:text-zinc-300">
          Shift + drag to select a square region
        </div>
      )}

      {/* Export panel */}
      <div className="absolute top-3 right-3 w-64 rounded-xl bg-white/95 p-4 shadow-lg backdrop-blur dark:bg-black/80">
        <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Export heightmap</h2>

        {bbox ? (
          <p className={`mb-3 text-xs ${tooBig ? "text-red-600" : "text-zinc-500 dark:text-zinc-400"}`}>
            {sideKm.toFixed(1)} km × {sideKm.toFixed(1)} km
            {tooBig && ` — exceeds ${Math.round(Math.sqrt(MAX_AREA_KM2))}km max`}
          </p>
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
            <option key={f.id} value={f.id} disabled={"disabled" in f && f.disabled}>
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
            disabled={!bbox || tooBig || exporting}
            className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-black"
          >
            {exporting ? "Exporting…" : "Export"}
          </button>

          {showExportTooltip && !bbox && (
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
