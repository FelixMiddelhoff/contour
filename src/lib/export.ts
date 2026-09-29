import type { ElevationGrid } from "./elevation";
import { encodeGrayPng } from "./png";
import { encodeFloatGeoTiff } from "./geotiff";
import { squareCorners, type RotatedSquare } from "./geo";

export type ExportFormat = "png16" | "png8" | "r16" | "geotiff";
export type Normalization = "selection" | "fixed";

const FIXED_SCALE_MAX = 9000; // meters, per design decision

function normalize(grid: ElevationGrid, mode: Normalization): Uint16Array {
  const { data } = grid;
  const lo = mode === "selection" ? grid.min : 0;
  const hi = mode === "selection" ? grid.max : FIXED_SCALE_MAX;
  const range = hi - lo || 1;
  const out = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const t = Math.max(0, Math.min(1, (data[i] - lo) / range));
    out[i] = Math.round(t * 65535);
  }
  return out;
}

export async function encodeExport(
  grid: ElevationGrid,
  format: ExportFormat,
  normalization: Normalization,
  square: RotatedSquare
): Promise<{ buffer: Buffer; contentType: string }> {
  if (format === "geotiff") {
    // GeoTIFF carries real elevation values (meters), not normalized 0-65535 —
    // normalization doesn't apply, the raw floats are georeferenced instead.
    const buffer = encodeFloatGeoTiff(grid.data, grid.width, grid.height, square);
    return { buffer, contentType: "image/tiff" };
  }

  const normalized = normalize(grid, normalization);

  if (format === "r16") {
    // headerless 16-bit unsigned little-endian, row-major
    const buf = Buffer.alloc(normalized.length * 2);
    for (let i = 0; i < normalized.length; i++) {
      buf.writeUInt16LE(normalized[i], i * 2);
    }
    return { buffer: buf, contentType: "application/octet-stream" };
  }

  if (format === "png8") {
    const eight = new Uint8Array(normalized.length);
    for (let i = 0; i < normalized.length; i++) eight[i] = normalized[i] >> 8;
    const buffer = encodeGrayPng(eight, grid.width, grid.height, 8);
    return { buffer, contentType: "image/png" };
  }

  // png16
  const buffer = encodeGrayPng(normalized, grid.width, grid.height, 16);
  return { buffer, contentType: "image/png" };
}

export function buildSidecar(
  square: RotatedSquare,
  grid: ElevationGrid,
  format: ExportFormat,
  normalization: Normalization
) {
  const corners = squareCorners(square);
  return {
    center: { lng: square.centerLng, lat: square.centerLat },
    sideKm: square.sideKm,
    rotationDeg: square.rotationDeg,
    corners: { nw: corners[0], ne: corners[1], se: corners[2], sw: corners[3] },
    resolution: { width: grid.width, height: grid.height },
    elevationMeters: { min: grid.min, max: grid.max },
    normalization,
    normalizationScale: normalization === "fixed" ? { min: 0, max: FIXED_SCALE_MAX } : null,
    format,
    crs: "EPSG:4326",
  };
}
