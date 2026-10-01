import { NextRequest, NextResponse } from "next/server";
import { buildElevationGrid, type ExportProgress } from "@/lib/elevation";
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

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sendLine = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));

      try {
        const onProgress = (p: ExportProgress) => sendLine({ type: "progress", ...p });

        const grid = await buildElevationGrid(square, resolution, onProgress);
        sendLine({ type: "progress", stage: "encoding", current: 0, total: 1 });
        const { buffer, contentType } = await encodeExport(grid, format, normalization, square);

        const meta = sidecar ? buildSidecar(square, grid, format, normalization) : null;
        sendLine({ type: "result", contentType, sidecar: meta });
        controller.enqueue(new Uint8Array(buffer));
        controller.close();
      } catch (err) {
        console.error(err);
        sendLine({ type: "error", message: friendlyErrorMessage(err) });
        controller.close();
      }
    },
  });

  return new NextResponse(stream, { headers: { "Content-Type": "application/octet-stream" } });
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
