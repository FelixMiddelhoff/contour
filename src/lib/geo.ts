export const KM_PER_DEG_LAT = 111.32;

export function kmPerDegLng(lat: number) {
  return KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

export interface RotatedSquare {
  centerLng: number;
  centerLat: number;
  sideKm: number;
  rotationDeg: number;
}

/** Corner points of the rotated square, in order: NW, NE, SE, SW (local up = north before rotation). */
export function squareCorners({ centerLng, centerLat, sideKm, rotationDeg }: RotatedSquare) {
  const half = sideKm / 2;
  const theta = (rotationDeg * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const kmLng = kmPerDegLng(centerLat);

  const local = [
    [-half, half], // NW
    [half, half], // NE
    [half, -half], // SE
    [-half, -half], // SW
  ];

  return local.map(([u, v]) => {
    const dx = u * cosT - v * sinT;
    const dy = u * sinT + v * cosT;
    return {
      lng: centerLng + dx / kmLng,
      lat: centerLat + dy / KM_PER_DEG_LAT,
    };
  });
}

/** Axis-aligned bounding box of the rotated square, with an optional margin in km. */
export function boundingBoxOf(square: RotatedSquare, marginKm = 0): [number, number, number, number] {
  const corners = squareCorners(square);
  const lngs = corners.map((c) => c.lng);
  const lats = corners.map((c) => c.lat);
  const kmLng = kmPerDegLng(square.centerLat);
  const marginLng = marginKm / kmLng;
  const marginLat = marginKm / KM_PER_DEG_LAT;
  return [
    Math.min(...lngs) - marginLng,
    Math.min(...lats) - marginLat,
    Math.max(...lngs) + marginLng,
    Math.max(...lats) + marginLat,
  ];
}

/** Map a point in the square's own local upright frame (u,v in km, origin at center) to lng/lat. */
export function localToLngLat(square: RotatedSquare, u: number, v: number) {
  const theta = (square.rotationDeg * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const dx = u * cosT - v * sinT;
  const dy = u * sinT + v * cosT;
  const kmLng = kmPerDegLng(square.centerLat);
  return {
    lng: square.centerLng + dx / kmLng,
    lat: square.centerLat + dy / KM_PER_DEG_LAT,
  };
}
