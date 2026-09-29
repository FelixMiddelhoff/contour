import sharp from "sharp";
import { fetchTiles, getTileRange, lngLatToTile, pickZoom, TILE_PIXEL_SIZE } from "./tiles";
import { boundingBoxOf, localToLngLat, type RotatedSquare } from "./geo";

/** Terrarium encoding: height = (R*256 + G + B/256) - 32768 */
function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

export interface ElevationGrid {
  width: number;
  height: number;
  data: Float32Array;
  min: number;
  max: number;
}

interface StitchedGrid {
  width: number;
  height: number;
  data: Float32Array;
  zoom: number;
  originX: number; // tile-x of stitched grid's pixel (0,0), in tile units
  originY: number;
}

async function fetchAndStitch(
  bbox: [number, number, number, number],
  zoom: number
): Promise<StitchedGrid> {
  const range = getTileRange(bbox, zoom);
  const tiles = await fetchTiles(range);

  const cols = range.maxX - range.minX + 1;
  const rows = range.maxY - range.minY + 1;
  const width = cols * TILE_PIXEL_SIZE;
  const height = rows * TILE_PIXEL_SIZE;
  const data = new Float32Array(width * height);

  for (const tile of tiles) {
    const { data: pixels, info } = await sharp(Buffer.from(tile.buffer))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const offsetX = (tile.x - range.minX) * TILE_PIXEL_SIZE;
    const offsetY = (tile.y - range.minY) * TILE_PIXEL_SIZE;

    for (let py = 0; py < TILE_PIXEL_SIZE; py++) {
      for (let px = 0; px < TILE_PIXEL_SIZE; px++) {
        const srcIdx = (py * TILE_PIXEL_SIZE + px) * channels;
        const r = pixels[srcIdx];
        const g = pixels[srcIdx + 1];
        const b = pixels[srcIdx + 2];
        data[(offsetY + py) * width + (offsetX + px)] = decodeTerrarium(r, g, b);
      }
    }
  }

  return { width, height, data, zoom, originX: range.minX, originY: range.minY };
}

function sampleBilinear(grid: StitchedGrid, lng: number, lat: number): number {
  const p = lngLatToTile(lng, lat, grid.zoom);
  const xf = (p.x - grid.originX) * TILE_PIXEL_SIZE;
  const yf = (p.y - grid.originY) * TILE_PIXEL_SIZE;

  const x0 = Math.max(0, Math.min(grid.width - 1, Math.floor(xf)));
  const x1 = Math.min(grid.width - 1, x0 + 1);
  const y0 = Math.max(0, Math.min(grid.height - 1, Math.floor(yf)));
  const y1 = Math.min(grid.height - 1, y0 + 1);
  const fx = Math.max(0, Math.min(1, xf - x0));
  const fy = Math.max(0, Math.min(1, yf - y0));

  const v00 = grid.data[y0 * grid.width + x0];
  const v10 = grid.data[y0 * grid.width + x1];
  const v01 = grid.data[y1 * grid.width + x0];
  const v11 = grid.data[y1 * grid.width + x1];
  const v0 = v00 * (1 - fx) + v10 * fx;
  const v1 = v01 * (1 - fx) + v11 * fx;
  return v0 * (1 - fy) + v1 * fy;
}

/**
 * Fetch and decode all tiles covering the (possibly rotated) square, then
 * sample an upright output grid in the square's own local frame — so the
 * exported image is always a plain upright square, regardless of how it's
 * rotated relative to true north.
 */
export async function buildElevationGrid(
  square: RotatedSquare,
  outputResolution: number
): Promise<ElevationGrid> {
  // small margin so bilinear sampling near the rotated square's edges never
  // reads outside the fetched/stitched tile area
  const bbox = boundingBoxOf(square, square.sideKm * 0.05);
  const zoom = pickZoom(bbox, outputResolution);
  const stitched = await fetchAndStitch(bbox, zoom);

  const out = new Float32Array(outputResolution * outputResolution);
  let min = Infinity;
  let max = -Infinity;
  const half = square.sideKm / 2;

  for (let oy = 0; oy < outputResolution; oy++) {
    // oy=0 is the top of the image = north edge of the square (before rotation)
    const v = half - (oy / (outputResolution - 1)) * square.sideKm;
    for (let ox = 0; ox < outputResolution; ox++) {
      const u = -half + (ox / (outputResolution - 1)) * square.sideKm;
      const { lng, lat } = localToLngLat(square, u, v);
      const raw = sampleBilinear(stitched, lng, lat);
      // ocean/water in Terrarium data is close to 0 already; clamp negative
      // (below-sea-level artifacts / voids) to 0 as the design's flat-water rule
      const clamped = Math.max(0, raw);
      out[oy * outputResolution + ox] = clamped;
      if (clamped < min) min = clamped;
      if (clamped > max) max = clamped;
    }
  }

  return { width: outputResolution, height: outputResolution, data: out, min, max };
}
