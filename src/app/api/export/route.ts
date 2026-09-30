import { NextRequest, NextResponse } from "next/server";
import { buildElevationGrid } from "@/lib/elevation";
import { encodeExport, buildSidecar, type ExportFormat, type Normalization } from "@/lib/export";
import type { RotatedSquare } from "@/lib/geo";

const MAX_AREA_KM2 = 100 * 100;
const IS_DESKTOP = process.env.NEXT_PUBLIC_IS_DESKTOP === "1";
const VALID_FORMATS: ExportFormat[] = ["png16", "png8", "r16", "geotiff"];
// 16K's resampling cost times out on the web app's serverless function —
// only safe with no execution-time limit, i.e. the desktop app
const VALID_RESOLUTIONS = IS_DESKTOP
  ? [512, 1024, 2048, 4096, 8192, 16384]
  : [512, 1024, 2048, 4096, 8192];

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const square = body?.square as RotatedSquare | undefined;
  const format = body?.format as ExportFormat | undefined;
  const resolution = body?.resolution as number | undefined;
  const normalization = (body?.normalization as Normalization | undefined) ?? "selection";
  const sidecar = Boolean(body?.sidecar);

  if (
    !square ||
    typeof square.centerLng !== "number" ||
    typeof square.centerLat !== "number" ||
    typeof square.sideKm !== "number" ||
    typeof square.rotationDeg !== "number"
  ) {
    return NextResponse.json({ error: "Missing or invalid square" }, { status: 400 });
  }
  if (!format || !VALID_FORMATS.includes(format)) {
    return NextResponse.json({ error: "Invalid format" }, { status: 400 });
  }
  if (!resolution || !VALID_RESOLUTIONS.includes(resolution)) {
    return NextResponse.json({ error: "Invalid resolution" }, { status: 400 });
  }
  if (format === "geotiff" && resolution > 4096) {
    return NextResponse.json(
      { error: "GeoTIFF is disabled above 4K — uncompressed 32-bit float would be too large" },
      { status: 400 }
    );
  }
  if (square.sideKm * square.sideKm > MAX_AREA_KM2) {
    return NextResponse.json(
      { error: `Selection exceeds ${Math.round(Math.sqrt(MAX_AREA_KM2))}km max side length` },
      { status: 400 }
    );
  }

  try {
    const grid = await buildElevationGrid(square, resolution);
    const { buffer, contentType } = await encodeExport(grid, format, normalization, square);

    if (!sidecar) {
      return new NextResponse(new Uint8Array(buffer), {
        headers: { "Content-Type": contentType, "Content-Disposition": "attachment" },
      });
    }

    // with sidecar requested, return a small JSON envelope the client can use
    // to trigger two downloads (kept simple: base64 the image + sidecar JSON)
    const meta = buildSidecar(square, grid, format, normalization);
    return NextResponse.json({
      image: Buffer.from(buffer).toString("base64"),
      contentType,
      sidecar: meta,
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: friendlyErrorMessage(err) }, { status: 500 });
  }
}

function friendlyErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : "";
  const isNetworkGlitch = /fetch failed|tile fetch failed|ECONNRESET|ETIMEDOUT|timeout/i.test(
    message
  );
  if (isNetworkGlitch) {
    return "Temporary network error fetching elevation data — please try exporting again.";
  }
  return message || "Export failed — please try again.";
}
