import { NextRequest, NextResponse } from "next/server";
import { pickZoom } from "@/lib/tiles";
import { buildElevationGrid } from "@/lib/elevation";

// coarse resolution — this is just for a quick min/max readout, not the export itself
const STATS_RESOLUTION = 64;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const bbox = body?.bbox as [number, number, number, number] | undefined;

  if (!bbox || bbox.length !== 4) {
    return NextResponse.json({ error: "Missing or invalid bbox" }, { status: 400 });
  }

  try {
    const zoom = pickZoom(bbox, STATS_RESOLUTION);
    const grid = await buildElevationGrid(bbox, zoom, STATS_RESOLUTION);
    return NextResponse.json({ min: grid.min, max: grid.max });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Failed to compute elevation stats";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
