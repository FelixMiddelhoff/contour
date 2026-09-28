import sharp from "sharp";
import { fetchTiles, getTileRange, lngLatToTile, TILE_PIXEL_SIZE } from "./tiles";

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

/**
 * Fetch and decode all tiles covering the bbox at the given zoom, stitch them
 * into one elevation grid, then crop to the exact bbox (fractional pixel
 * precision) and resample to the target output resolution (bilinear).
 */
export async function buildElevationGrid(
  bbox: [number, number, number, number],
  zoom: number,
  outputResolution: number
): Promise<ElevationGrid> {
  const range = getTileRange(bbox, zoom);
  const tiles = await fetchTiles(range);

  const cols = range.maxX - range.minX + 1;
  const rows = range.maxY - range.minY + 1;
  const stitchedW = cols * TILE_PIXEL_SIZE;
  const stitchedH = rows * TILE_PIXEL_SIZE;
  const stitched = new Float32Array(stitchedW * stitchedH);

  for (const tile of tiles) {
    const { data, info } = await sharp(Buffer.from(tile.buffer))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const channels = info.channels;
    const offsetX = (tile.x - range.minX) * TILE_PIXEL_SIZE;
    const offsetY = (tile.y - range.minY) * TILE_PIXEL_SIZE;

    for (let py = 0; py < TILE_PIXEL_SIZE; py++) {
      for (let px = 0; px < TILE_PIXEL_SIZE; px++) {
        const srcIdx = (py * TILE_PIXEL_SIZE + px) * channels;
        const r = data[srcIdx];
        const g = data[srcIdx + 1];
        const b = data[srcIdx + 2];
        const dstX = offsetX + px;
        const dstY = offsetY + py;
        stitched[dstY * stitchedW + dstX] = decodeTerrarium(r, g, b);
      }
    }
  }

  // exact pixel-space crop window within the stitched grid, at tile-pixel resolution
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const topLeftPx = lngLatToTile(minLng, maxLat, zoom);
  const bottomRightPx = lngLatToTile(maxLng, minLat, zoom);
  const cropX0 = (topLeftPx.x - range.minX) * TILE_PIXEL_SIZE;
  const cropY0 = (topLeftPx.y - range.minY) * TILE_PIXEL_SIZE;
  const cropX1 = (bottomRightPx.x - range.minX) * TILE_PIXEL_SIZE;
  const cropY1 = (bottomRightPx.y - range.minY) * TILE_PIXEL_SIZE;
  const cropW = cropX1 - cropX0;
  const cropH = cropY1 - cropY0;

  const out = new Float32Array(outputResolution * outputResolution);
  let min = Infinity;
  let max = -Infinity;

  for (let oy = 0; oy < outputResolution; oy++) {
    const srcYf = cropY0 + (oy / (outputResolution - 1)) * cropH;
    const y0 = Math.max(0, Math.min(stitchedH - 1, Math.floor(srcYf)));
    const y1 = Math.min(stitchedH - 1, y0 + 1);
    const fy = srcYf - y0;

    for (let ox = 0; ox < outputResolution; ox++) {
      const srcXf = cropX0 + (ox / (outputResolution - 1)) * cropW;
      const x0 = Math.max(0, Math.min(stitchedW - 1, Math.floor(srcXf)));
      const x1 = Math.min(stitchedW - 1, x0 + 1);
      const fx = srcXf - x0;

      const v00 = stitched[y0 * stitchedW + x0];
      const v10 = stitched[y0 * stitchedW + x1];
      const v01 = stitched[y1 * stitchedW + x0];
      const v11 = stitched[y1 * stitchedW + x1];
      const v0 = v00 * (1 - fx) + v10 * fx;
      const v1 = v01 * (1 - fx) + v11 * fx;
      const v = v0 * (1 - fy) + v1 * fy;

      // ocean/water in Terrarium data is close to 0 already; clamp negative
      // (below-sea-level artifacts / voids) to 0 as the design's flat-water rule
      const clamped = Math.max(0, v);

      out[oy * outputResolution + ox] = clamped;
      if (clamped < min) min = clamped;
      if (clamped > max) max = clamped;
    }
  }

  return { width: outputResolution, height: outputResolution, data: out, min, max };
}
