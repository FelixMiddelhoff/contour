import { NextRequest, NextResponse } from "next/server";
import { pickZoom } from "@/lib/tiles";
import { buildElevationGrid } from "@/lib/elevation";
import { encodeExport, buildSidecar, type ExportFormat, type Normalization } from "@/lib/export";

const MAX_AREA_KM2 = 50 * 50;
const KM_PER_DEG_LAT = 111.32;
const VALID_FORMATS: ExportFormat[] = ["png16", "png8", "r16"];
const VALID_RESOLUTIONS = [512, 1024, 2048, 4096];

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const bbox = body?.bbox as [number, number, number, number] | undefined;
  const format = body?.format as ExportFormat | undefined;
  const resolution = body?.resolution as number | undefined;
  const normalization = (body?.normalization as Normalization | undefined) ?? "selection";
  const sidecar = Boolean(body?.sidecar);

  if (!bbox || bbox.length !== 4) {
    return NextResponse.json({ error: "Missing or invalid bbox" }, { status: 400 });
  }
  if (!format || (format === "geotiff" as string) || !VALID_FORMATS.includes(format)) {
    if ((format as string) === "geotiff") {
      return NextResponse.json({ error: "GeoTIFF export not implemented yet" }, { status: 501 });
    }
    return NextResponse.json({ error: "Invalid format" }, { status: 400 });
  }
  if (!resolution || !VALID_RESOLUTIONS.includes(resolution)) {
    return NextResponse.json({ error: "Invalid resolution" }, { status: 400 });
  }

  const [minLng, minLat, maxLng, maxLat] = bbox;
  const kmPerLng = 111.32 * Math.cos(((minLat + maxLat) / 2 * Math.PI) / 180);
  const sideKm = Math.max((maxLng - minLng) * kmPerLng, (maxLat - minLat) * KM_PER_DEG_LAT);
  if (sideKm * sideKm > MAX_AREA_KM2) {
    return NextResponse.json({ error: `Selection exceeds ${Math.round(Math.sqrt(MAX_AREA_KM2))}km max side length` }, { status: 400 });
  }

  try {
    const zoom = pickZoom(bbox, resolution);
    const grid = await buildElevationGrid(bbox, zoom, resolution);
    const { buffer, contentType } = await encodeExport(grid, format, normalization);

    if (!sidecar) {
      return new NextResponse(new Uint8Array(buffer), {
        headers: { "Content-Type": contentType, "Content-Disposition": "attachment" },
      });
    }

    // with sidecar requested, return a small JSON envelope the client can use
    // to trigger two downloads (kept simple: base64 the image + sidecar JSON)
    const meta = buildSidecar(bbox, grid, format, normalization);
    return NextResponse.json({
      image: Buffer.from(buffer).toString("base64"),
      contentType,
      sidecar: meta,
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Export failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
