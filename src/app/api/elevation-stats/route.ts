import { NextRequest, NextResponse } from "next/server";
import { buildElevationGrid } from "@/lib/elevation";
import { encodeExport } from "@/lib/export";
import type { RotatedSquare } from "@/lib/geo";

// coarse resolution — this is just for a quick min/max readout and preview
// thumbnail, not the export itself
const STATS_RESOLUTION = 64;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const square = body?.square as RotatedSquare | undefined;

  if (!square || typeof square.centerLng !== "number" || typeof square.sideKm !== "number") {
    return NextResponse.json({ error: "Missing or invalid square" }, { status: 400 });
  }

  try {
    const grid = await buildElevationGrid(square, STATS_RESOLUTION);
    const { buffer } = await encodeExport(grid, "png8", "selection", square);
    return NextResponse.json({
      min: grid.min,
      max: grid.max,
      preview: `data:image/png;base64,${buffer.toString("base64")}`,
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Failed to compute elevation stats";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
