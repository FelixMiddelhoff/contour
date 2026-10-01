const TILE_SIZE = 256;
const TERRARIUM_URL = (z: number, x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

export function lngLatToTile(lng: number, lat: number, zoom: number) {
  const n = 2 ** zoom;
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

export function tileToLngLat(x: number, y: number, zoom: number) {
  const n = 2 ** zoom;
  const lng = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const lat = (latRad * 180) / Math.PI;
  return { lng, lat };
}

export interface TileRange {
  zoom: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Pick a zoom level whose tile pixel resolution is close to the requested output resolution for this bbox. */
export function pickZoom(
  bbox: [number, number, number, number],
  targetResolution: number,
  maxZoom = 14
): number {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  for (let z = 1; z <= maxZoom; z++) {
    const p1 = lngLatToTile(minLng, maxLat, z);
    const p2 = lngLatToTile(maxLng, minLat, z);
    const pixelsAcross = Math.abs(p2.x - p1.x) * TILE_SIZE;
    if (pixelsAcross >= targetResolution) return z;
  }
  return maxZoom;
}

export function getTileRange(bbox: [number, number, number, number], zoom: number): TileRange {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const topLeft = lngLatToTile(minLng, maxLat, zoom);
  const bottomRight = lngLatToTile(maxLng, minLat, zoom);
  return {
    zoom,
    minX: Math.floor(topLeft.x),
    maxX: Math.floor(bottomRight.x),
    minY: Math.floor(topLeft.y),
    maxY: Math.floor(bottomRight.y),
  };
}

export interface FetchedTile {
  x: number;
  y: number;
  buffer: ArrayBuffer;
}

const MAX_RETRIES = 3;

async function fetchTileWithRetry(zoom: number, x: number, y: number): Promise<FetchedTile> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(TERRARIUM_URL(zoom, x, y));
      if (!res.ok) {
        throw new Error(`Tile fetch failed for ${zoom}/${x}/${y}: ${res.status}`);
      }
      return { x, y, buffer: await res.arrayBuffer() };
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        // transient network blips (fetch failed, timeout, S3 hiccup) are common —
        // a short backoff and retry clears most of them without bothering the user
        await new Promise((resolve) => setTimeout(resolve, attempt * 300));
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Tile fetch failed for ${zoom}/${x}/${y}`);
}

export async function fetchTiles(
  range: TileRange,
  onTileFetched?: (done: number, total: number) => void
): Promise<FetchedTile[]> {
  const jobs: Promise<FetchedTile>[] = [];
  let done = 0;
  const total = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
  for (let x = range.minX; x <= range.maxX; x++) {
    for (let y = range.minY; y <= range.maxY; y++) {
      jobs.push(
        fetchTileWithRetry(range.zoom, x, y).then((tile) => {
          done++;
          onTileFetched?.(done, total);
          return tile;
        })
      );
    }
  }
  return Promise.all(jobs);
}

export const TILE_PIXEL_SIZE = TILE_SIZE;
