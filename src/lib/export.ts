import type { ElevationGrid } from "./elevation";
import { encodeGrayPng } from "./png";

export type ExportFormat = "png16" | "png8" | "r16";
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
  normalization: Normalization
): Promise<{ buffer: Buffer; contentType: string }> {
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
  bbox: [number, number, number, number],
  grid: ElevationGrid,
  format: ExportFormat,
  normalization: Normalization
) {
  return {
    bbox: { minLng: bbox[0], minLat: bbox[1], maxLng: bbox[2], maxLat: bbox[3] },
    resolution: { width: grid.width, height: grid.height },
    elevationMeters: { min: grid.min, max: grid.max },
    normalization,
    normalizationScale: normalization === "fixed" ? { min: 0, max: FIXED_SCALE_MAX } : null,
    format,
    crs: "EPSG:4326",
  };
}
