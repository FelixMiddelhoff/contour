/**
 * Minimal single-strip, uncompressed, 32-bit float GeoTIFF encoder.
 * No external deps — writes the baseline TIFF tags plus GeoTIFF's
 * ModelTransformationTag (a full affine transform, which represents a
 * rotated raster as well as a plain north-up one) and GeoKeyDirectory for
 * a geographic (lat/lon, WGS84) raster.
 */
import { KM_PER_DEG_LAT, kmPerDegLng, type RotatedSquare } from "./geo";

type TiffType = "SHORT" | "LONG" | "DOUBLE";
const TYPE_CODE: Record<TiffType, number> = { SHORT: 3, LONG: 4, DOUBLE: 12 };

interface Entry {
  tag: number;
  type: TiffType;
  count: number;
  inlineValue?: number;
  data?: Buffer;
}

/** Affine transform (raster col,row -> model lng,lat) for a possibly-rotated square. */
function buildAffine(square: RotatedSquare, width: number, height: number): number[] {
  const half = square.sideKm / 2;
  const theta = (square.rotationDeg * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const kmLng = kmPerDegLng(square.centerLat);
  const sx = square.sideKm / width;
  const sy = square.sideKm / height;

  const a0 = (sx * cosT) / kmLng;
  const a1 = (sy * sinT) / kmLng;
  const a3 = square.centerLng - (half * (cosT + sinT)) / kmLng;

  const b0 = (sx * sinT) / KM_PER_DEG_LAT;
  const b1 = (-sy * cosT) / KM_PER_DEG_LAT;
  const b3 = square.centerLat + (half * (cosT - sinT)) / KM_PER_DEG_LAT;

  // row-major 4x4: [a0 a1 0 a3; b0 b1 0 b3; 0 0 0 0; 0 0 0 1]
  return [a0, a1, 0, a3, b0, b1, 0, b3, 0, 0, 0, 0, 0, 0, 0, 1];
}

export function encodeFloatGeoTiff(
  data: Float32Array,
  width: number,
  height: number,
  square: RotatedSquare
): Buffer {
  const affineValues = buildAffine(square, width, height);
  const modelTransformation = Buffer.alloc(128);
  affineValues.forEach((v, i) => modelTransformation.writeDoubleLE(v, i * 8));

  // GeoKeyDirectory: header {version,revision,minor,numKeys} + 3 keys x 4 shorts
  const geoKeys = Buffer.alloc(32);
  geoKeys.writeUInt16LE(1, 0); // KeyDirectoryVersion
  geoKeys.writeUInt16LE(1, 2); // KeyRevision
  geoKeys.writeUInt16LE(0, 4); // MinorRevision
  geoKeys.writeUInt16LE(3, 6); // NumberOfKeys
  geoKeys.writeUInt16LE(1024, 8); // GTModelTypeGeoKey
  geoKeys.writeUInt16LE(0, 10);
  geoKeys.writeUInt16LE(1, 12);
  geoKeys.writeUInt16LE(2, 14); // Geographic
  geoKeys.writeUInt16LE(1025, 16); // GTRasterTypeGeoKey
  geoKeys.writeUInt16LE(0, 18);
  geoKeys.writeUInt16LE(1, 20);
  geoKeys.writeUInt16LE(1, 22); // RasterPixelIsArea
  geoKeys.writeUInt16LE(2048, 24); // GeographicTypeGeoKey
  geoKeys.writeUInt16LE(0, 26);
  geoKeys.writeUInt16LE(1, 28);
  geoKeys.writeUInt16LE(4326, 30); // WGS84

  const pixelData = Buffer.from(data.buffer, data.byteOffset, data.byteLength);

  const entries: Entry[] = (
    [
      { tag: 256, type: "LONG", count: 1, inlineValue: width },
      { tag: 257, type: "LONG", count: 1, inlineValue: height },
      { tag: 258, type: "SHORT", count: 1, inlineValue: 32 },
      { tag: 259, type: "SHORT", count: 1, inlineValue: 1 }, // no compression
      { tag: 262, type: "SHORT", count: 1, inlineValue: 1 }, // BlackIsZero
      { tag: 273, type: "LONG", count: 1, inlineValue: 0 }, // StripOffsets, filled below
      { tag: 277, type: "SHORT", count: 1, inlineValue: 1 }, // SamplesPerPixel
      { tag: 278, type: "LONG", count: 1, inlineValue: height }, // RowsPerStrip
      { tag: 279, type: "LONG", count: 1, inlineValue: pixelData.length }, // StripByteCounts
      { tag: 339, type: "SHORT", count: 1, inlineValue: 3 }, // SampleFormat: IEEE float
      { tag: 34264, type: "DOUBLE", count: 16, data: modelTransformation },
      { tag: 34735, type: "SHORT", count: 16, data: geoKeys },
    ] as Entry[]
  ).sort((a, b) => a.tag - b.tag);

  const ifdSize = 2 + entries.length * 12 + 4;
  const ifdStart = 8;
  let externalOffset = ifdStart + ifdSize;

  for (const e of entries) {
    if (e.data) {
      (e as Entry & { offset: number }).offset = externalOffset;
      externalOffset += e.data.length;
      if (externalOffset % 2 === 1) externalOffset++; // word-align
    }
  }
  const stripOffset = externalOffset;
  const stripOffsetsEntry = entries.find((e) => e.tag === 273)!;
  stripOffsetsEntry.inlineValue = stripOffset;

  const header = Buffer.alloc(8);
  header.write("II", 0, "ascii");
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(ifdStart, 4);

  const ifd = Buffer.alloc(ifdSize);
  ifd.writeUInt16LE(entries.length, 0);
  let pos = 2;
  for (const e of entries) {
    ifd.writeUInt16LE(e.tag, pos);
    ifd.writeUInt16LE(TYPE_CODE[e.type], pos + 2);
    ifd.writeUInt32LE(e.count, pos + 4);
    if (e.data) {
      ifd.writeUInt32LE((e as Entry & { offset: number }).offset, pos + 8);
    } else {
      if (e.type === "SHORT") {
        ifd.writeUInt16LE(e.inlineValue ?? 0, pos + 8);
        ifd.writeUInt16LE(0, pos + 10);
      } else {
        ifd.writeUInt32LE(e.inlineValue ?? 0, pos + 8);
      }
    }
    pos += 12;
  }
  ifd.writeUInt32LE(0, pos); // next IFD offset (none)

  const externalChunks: Buffer[] = [];
  for (const e of entries) {
    if (e.data) {
      externalChunks.push(e.data);
      if (e.data.length % 2 === 1) externalChunks.push(Buffer.alloc(1));
    }
  }

  return Buffer.concat([header, ifd, ...externalChunks, pixelData]);
}
