"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import JSZip from "jszip";
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
const IS_DESKTOP = process.env.NEXT_PUBLIC_IS_DESKTOP === "1";
// 16K's pixel-resampling cost times out on the web app's serverless function —
// only safe with no execution-time limit, i.e. the desktop app
const ALL_RESOLUTIONS = [512, 1024, 2048, 4096, 8192, 16384] as const;
const RESOLUTIONS = IS_DESKTOP ? ALL_RESOLUTIONS : ALL_RESOLUTIONS.filter((r) => r <= 8192);
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

interface ExportRequestOptions {
  square: RotatedSquare;
  format: (typeof FORMATS)[number]["id"];
  resolution: number;
  normalization: "selection" | "fixed";
  sidecar: boolean;
  onProgress?: (p: { stage: "tiles" | "resample" | "encoding"; current: number; total: number }) => void;
}

async function runExportRequest({
  square,
  format,
  resolution,
  normalization,
  sidecar,
  onProgress,
}: ExportRequestOptions): Promise<{ blob: Blob; contentType: string; sidecar: Record<string, unknown> | null }> {
  const res = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ square, format, resolution, normalization, sidecar }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error ?? `Export failed (${res.status})`);
  }
  if (!res.body) throw new Error("Export failed — no response body");

  const reader = res.body.getReader();
  let headerDone = false;
  let pending = new Uint8Array(0);
  const binaryChunks: Uint8Array[] = [];
  let result: { contentType: string; sidecar: Record<string, unknown> | null } | null = null;

  const concat = (a: Uint8Array, b: Uint8Array) => {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };

  while (!headerDone) {
    const { done, value } = await reader.read();
    if (done) break;
    pending = concat(pending, value);

    let newlineIdx: number;
    while (!headerDone && (newlineIdx = pending.indexOf(10)) !== -1) {
      const lineBytes = pending.slice(0, newlineIdx);
      pending = pending.slice(newlineIdx + 1);
      const line = JSON.parse(new TextDecoder().decode(lineBytes));

      if (line.type === "progress") {
        onProgress?.({ stage: line.stage, current: line.current, total: line.total });
      } else if (line.type === "error") {
        throw new Error(line.message);
      } else if (line.type === "result") {
        result = { contentType: line.contentType, sidecar: line.sidecar };
        headerDone = true;
        if (pending.length > 0) binaryChunks.push(pending);
      }
    }
  }
  if (!result) throw new Error("Export failed — stream ended unexpectedly");

  // drain the rest of the stream as raw binary (the file itself)
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    binaryChunks.push(value);
  }

  return {
    blob: new Blob(binaryChunks as BlobPart[], { type: result.contentType }),
    contentType: result.contentType,
    sidecar: result.sidecar,
  };
}

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
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
  const skipNextSearchRef = useRef(false);

  const [basemap, setBasemap] = useState<BasemapId>("osm");
  const [square, setSquare] = useState<RotatedSquare | null>(null);
  const [format, setFormat] = useState<(typeof FORMATS)[number]["id"]>("png16");
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]>(2048);
  const [normalization, setNormalization] = useState<"selection" | "fixed">("selection");
  const [sidecar, setSidecar] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{
    stage: "tiles" | "resample" | "encoding";
    current: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showExportTooltip, setShowExportTooltip] = useState(false);
  const [elevationStats, setElevationStats] = useState<{ min: number; max: number } | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [tilingEnabled, setTilingEnabled] = useState(false);
  const [showTilingInfo, setShowTilingInfo] = useState(false);
  const [ghostSquare, setGhostSquare] = useState<RotatedSquare | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    { label: string; lng: number; lat: number }[]
  >([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [gridRows, setGridRows] = useState(2);
  const [gridCols, setGridCols] = useState(2);
  const [batchGridEnabled, setBatchGridEnabled] = useState(false);
  const [showBatchGridInfo, setShowBatchGridInfo] = useState(false);
  const [batchExporting, setBatchExporting] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null);

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

  const placeAdjacent = useCallback(
    (direction: "up" | "down" | "left" | "right") => {
      const map = mapRef.current;
      if (!map || !ghostSquare) return;
      const offsets: Record<typeof direction, [number, number]> = {
        right: [ghostSquare.sideKm, 0],
        left: [-ghostSquare.sideKm, 0],
        up: [0, ghostSquare.sideKm],
        down: [0, -ghostSquare.sideKm],
      };
      const [u, v] = offsets[direction];
      const { lng, lat } = localToLngLat(ghostSquare, u, v);
      const next: RotatedSquare = {
        centerLng: lng,
        centerLat: lat,
        sideKm: ghostSquare.sideKm,
        rotationDeg: ghostSquare.rotationDeg,
      };
      setSquare(next);
      renderSelection(map, next);
      map.easeTo({ center: [lng, lat], duration: 300 });
    },
    [ghostSquare, renderSelection]
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
      map.addSource("ghost", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "ghost-fill",
        type: "fill",
        source: "ghost",
        paint: { "fill-color": "#3b82f6", "fill-opacity": 0.08 },
      });
      map.addLayer({
        id: "ghost-line",
        type: "line",
        source: "ghost",
        paint: { "line-color": "#3b82f6", "line-width": 2, "line-dasharray": [2, 2] },
      });

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
  }, [drawSquare, renderSelection]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (isFirstBasemapRender.current) {
      isFirstBasemapRender.current = false;
      return;
    }
    map.setStyle(styleFor(basemap));
    map.once("styledata", () => {
      if (!map.getSource("ghost")) {
        map.addSource("ghost", {
          type: "geojson",
          data:
            ghostSquare && tilingEnabled
              ? squareToGeoJSON(ghostSquare)
              : { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "ghost-fill",
          type: "fill",
          source: "ghost",
          paint: { "fill-color": "#3b82f6", "fill-opacity": 0.08 },
        });
        map.addLayer({
          id: "ghost-line",
          type: "line",
          source: "ghost",
          paint: { "line-color": "#3b82f6", "line-width": 2, "line-dasharray": [2, 2] },
        });
      }
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
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource("ghost") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(
      ghostSquare && tilingEnabled ? squareToGeoJSON(ghostSquare) : { type: "FeatureCollection", features: [] }
    );
  }, [ghostSquare, tilingEnabled]);

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
        if (!cancelled) {
          setElevationStats({ min: data.min, max: data.max });
          setPreviewImage(data.preview ?? null);
        }
      } catch {
        if (!cancelled) {
          setElevationStats(null);
          setPreviewImage(null);
        }
      } finally {
        if (!cancelled) setStatsLoading(false);
      }
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [square, tooBig]);

  useEffect(() => {
    if (skipNextSearchRef.current) {
      skipNextSearchRef.current = false;
      return;
    }
    const query = searchQuery.trim();
    // dropdown is already gated on searchResults.length > 0, so a short query
    // just needs to skip fetching — the JSX guard handles not showing stale results
    if (query.length < 3) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { display_name: string; lon: string; lat: string }[];
        if (!cancelled) {
          setSearchResults(
            data.map((d) => ({ label: d.display_name, lng: parseFloat(d.lon), lat: parseFloat(d.lat) }))
          );
          setShowSearchResults(true);
        }
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery]);

  function flyToSearchResult(result: { label: string; lng: number; lat: number }) {
    mapRef.current?.flyTo({ center: [result.lng, result.lat], zoom: 12 });
    skipNextSearchRef.current = true;
    setSearchQuery(result.label);
    setShowSearchResults(false);
  }

  async function handleExport() {
    if (!square) return;
    setExporting(true);
    setError(null);
    setExportProgress(null);
    try {
      const ext = format === "geotiff" ? "tif" : format === "r16" ? "r16" : "png";
      const { blob, sidecar: sidecarData } = await runExportRequest({
        square,
        format,
        resolution,
        normalization,
        sidecar,
        onProgress: setExportProgress,
      });

      triggerDownload(blob, `heightmap.${ext}`);
      if (sidecarData) {
        triggerDownload(
          new Blob([JSON.stringify(sidecarData, null, 2)], { type: "application/json" }),
          "heightmap.json"
        );
      }

      if (tilingEnabled) setGhostSquare(square);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  }

  async function handleBatchExport() {
    if (!square) return;
    setBatchExporting(true);
    setError(null);
    setBatchProgress({ current: 0, total: gridRows * gridCols });
    try {
      const zip = new JSZip();
      const ext = format === "geotiff" ? "tif" : format === "r16" ? "r16" : "png";
      let done = 0;

      for (let r = 0; r < gridRows; r++) {
        for (let c = 0; c < gridCols; c++) {
          const { lng, lat } = localToLngLat(square, c * square.sideKm, -r * square.sideKm);
          const cellSquare: RotatedSquare = {
            centerLng: lng,
            centerLat: lat,
            sideKm: square.sideKm,
            rotationDeg: square.rotationDeg,
          };
          const name = `heightmap_r${r}_c${c}`;
          const { blob, sidecar: sidecarData } = await runExportRequest({
            square: cellSquare,
            format,
            resolution,
            normalization,
            sidecar,
            onProgress: setExportProgress,
          });
          zip.file(`${name}.${ext}`, blob);
          if (sidecarData) zip.file(`${name}.json`, JSON.stringify(sidecarData, null, 2));

          done++;
          setBatchProgress({ current: done, total: gridRows * gridCols });
        }
      }

      const zipBlob = await zip.generateAsync({ type: "blob" });
      triggerDownload(zipBlob, `heightmap_grid_${gridRows}x${gridCols}.zip`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Batch export failed");
    } finally {
      setBatchExporting(false);
      setBatchProgress(null);
      setExportProgress(null);
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

      {/* Search */}
      <div className="absolute top-14 left-3 w-56">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onFocus={() => searchResults.length > 0 && setShowSearchResults(true)}
          onBlur={() => setTimeout(() => setShowSearchResults(false), 150)}
          placeholder="Search for a place…"
          className="w-full rounded-lg border border-zinc-300 bg-white/90 px-3 py-1.5 text-xs shadow backdrop-blur placeholder:text-zinc-400 dark:border-zinc-600 dark:bg-black/70 dark:text-zinc-100"
        />
        {showSearchResults && (searchResults.length > 0 || searchLoading) && (
          <div className="mt-1 max-h-64 overflow-y-auto rounded-lg bg-white/95 shadow-lg backdrop-blur dark:bg-black/90">
            {searchLoading && (
              <p className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">Searching…</p>
            )}
            {!searchLoading &&
              searchResults.map((r, i) => (
                <button
                  key={i}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => flyToSearchResult(r)}
                  className="block w-full truncate px-3 py-1.5 text-left text-xs text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  {r.label}
                </button>
              ))}
          </div>
        )}
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
              <div className="flex items-center gap-2">
                <p className="flex-1 text-xs text-zinc-500 dark:text-zinc-400">
                  Elevation:{" "}
                  {statsLoading && !elevationStats
                    ? "…"
                    : elevationStats
                    ? `${Math.round(elevationStats.min)}–${Math.round(elevationStats.max)} m`
                    : "—"}
                </p>
                {previewImage && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={previewImage}
                    alt="Elevation preview"
                    className="h-16 w-16 shrink-0 rounded border border-zinc-300 object-cover dark:border-zinc-600"
                  />
                )}
              </div>
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
          {FORMATS.map((f) => {
            const disabled = f.id === "geotiff" && resolution > 4096;
            return (
              <option key={f.id} value={f.id} disabled={disabled}>
                {f.label}
                {disabled ? " — disabled above 4K (uncompressed, too large)" : ""}
              </option>
            );
          })}
        </select>

        <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">Resolution</label>
        <select
          value={resolution}
          onChange={(e) => {
            const next = Number(e.target.value) as typeof resolution;
            setResolution(next);
            if (next > 4096 && format === "geotiff") setFormat("png16");
          }}
          className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          {RESOLUTIONS.map((r) => (
            <option key={r} value={r}>
              {r} × {r}
              {r === 8192 ? " (8K)" : r === 16384 ? " (16K)" : ""}
            </option>
          ))}
        </select>

        {resolution > 4096 && (
          <p className="mb-3 mt-1 text-xs text-amber-600 dark:text-amber-500">
            Resolutions above 4K produce very large files. RAW .r16 isn&apos;t
            compressed (~{resolution === 16384 ? "512 MB" : "128 MB"}); PNG
            compresses better but can still be 100MB+. GeoTIFF is disabled at
            this size — uncompressed 32-bit float would be roughly{" "}
            {resolution === 16384 ? "1 GB" : "256 MB"}. Export may take a
            while.
          </p>
        )}
        {!(resolution > 4096) && <div className="mb-3" />}

        <label className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">Normalization</label>
        <select
          value={normalization}
          onChange={(e) => setNormalization(e.target.value as typeof normalization)}
          className="mb-3 w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="selection">Best contrast (per-export)</option>
          <option value="fixed">Fixed scale (0–9000m)</option>
        </select>

        <label className="mb-3 flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={sidecar} onChange={(e) => setSidecar(e.target.checked)} />
          Include georeference sidecar (.json)
        </label>

        <div className="mb-1 flex items-center gap-1.5">
          <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={tilingEnabled}
              onChange={(e) => {
                setTilingEnabled(e.target.checked);
                if (!e.target.checked) setGhostSquare(null);
              }}
            />
            Tiling mode
          </label>
          <div className="relative">
            <button
              onClick={() => setShowTilingInfo((v) => !v)}
              aria-label="What is tiling mode?"
              className="flex h-4 w-4 items-center justify-center rounded-full border border-zinc-300 text-[10px] font-semibold text-zinc-500 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              ?
            </button>
            {showTilingInfo && (
              <div className="absolute right-0 top-full z-10 mt-2 w-64 rounded-lg bg-white p-3 text-xs leading-relaxed text-zinc-700 shadow-xl dark:bg-zinc-900 dark:text-zinc-300">
                After each export, keeps a dashed outline (the &quot;ghost&quot;)
                of that square on the map, plus buttons to place a new
                identical square exactly touching one of its edges — useful
                for exporting several tiles and stitching them into one
                larger heightmap in a photo editor.
              </div>
            )}
          </div>
        </div>

        {tilingEnabled && ghostSquare && (
          <div className="mb-3 flex items-center justify-center gap-1">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">Place adjacent:</span>
            {(["left", "up", "down", "right"] as const).map((dir) => (
              <button
                key={dir}
                onClick={() => placeAdjacent(dir)}
                aria-label={`Place adjacent square (${dir})`}
                className="flex h-6 w-6 items-center justify-center rounded-md border border-zinc-300 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                {dir === "left" ? "←" : dir === "up" ? "↑" : dir === "down" ? "↓" : "→"}
              </button>
            ))}
          </div>
        )}
        {!(tilingEnabled && ghostSquare) && <div className="mb-3" />}

        <div className="mb-1 flex items-center gap-1.5">
          <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={batchGridEnabled}
              onChange={(e) => setBatchGridEnabled(e.target.checked)}
            />
            Batch grid export
          </label>
          <div className="relative">
            <button
              onClick={() => setShowBatchGridInfo((v) => !v)}
              aria-label="What is batch grid export?"
              className="flex h-4 w-4 items-center justify-center rounded-full border border-zinc-300 text-[10px] font-semibold text-zinc-500 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              ?
            </button>
            {showBatchGridInfo && (
              <div className="absolute right-0 top-full z-10 mt-2 w-64 rounded-lg bg-white p-3 text-xs leading-relaxed text-zinc-700 shadow-xl dark:bg-zinc-900 dark:text-zinc-300">
                Exports a whole grid of tiles in one go, starting at the
                current square (top-left corner) and extending right/down —
                same size and rotation each tile, bundled into one .zip.
              </div>
            )}
          </div>
        </div>

        {batchGridEnabled && square && !tooBig && (
          <div className="mb-3 rounded-md border border-zinc-200 p-2 dark:border-zinc-700">
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                Rows
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={gridRows}
                  onChange={(e) => setGridRows(Math.min(5, Math.max(1, Number(e.target.value) || 1)))}
                  className="w-12 rounded border border-zinc-300 bg-white px-1 py-0.5 text-xs dark:border-zinc-600 dark:bg-zinc-900"
                />
              </label>
              <label className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                Cols
                <input
                  type="number"
                  min={1}
                  max={5}
                  value={gridCols}
                  onChange={(e) => setGridCols(Math.min(5, Math.max(1, Number(e.target.value) || 1)))}
                  className="w-12 rounded border border-zinc-300 bg-white px-1 py-0.5 text-xs dark:border-zinc-600 dark:bg-zinc-900"
                />
              </label>
              <button
                onClick={handleBatchExport}
                disabled={batchExporting || exporting}
                className="ml-auto rounded-md bg-zinc-700 px-2 py-1 text-xs font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-300 dark:text-black"
              >
                {batchExporting
                  ? `Exporting ${batchProgress?.current ?? 0}/${batchProgress?.total ?? gridRows * gridCols}…`
                  : `Export ${gridRows}×${gridCols} grid`}
              </button>
            </div>
          </div>
        )}

        <div
          className="relative"
          onMouseEnter={() => setShowExportTooltip(true)}
          onMouseLeave={() => setShowExportTooltip(false)}
        >
          <button
            onClick={handleExport}
            disabled={!square || tooBig || exporting || batchExporting}
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

        {(exporting || batchExporting) && exportProgress && (
          <div className="mt-2">
            <div className="mb-1 flex justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
              <span>
                {exportProgress.stage === "tiles"
                  ? "Fetching elevation tiles"
                  : exportProgress.stage === "resample"
                  ? "Resampling"
                  : "Encoding"}
              </span>
              <span>
                {exportProgress.stage === "encoding"
                  ? ""
                  : `${exportProgress.current}/${exportProgress.total}`}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
              <div
                className="h-full rounded-full bg-zinc-900 transition-all duration-150 dark:bg-white"
                style={{
                  width: `${Math.min(
                    100,
                    (exportProgress.current / Math.max(1, exportProgress.total)) * 100
                  )}%`,
                }}
              />
            </div>
          </div>
        )}

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
