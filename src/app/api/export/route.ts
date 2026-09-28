import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.bbox) {
    return NextResponse.json({ error: "Missing bbox" }, { status: 400 });
  }

  // TODO: tile fetch -> elevation decode -> resample -> image export pipeline
  return NextResponse.json(
    { error: "Export pipeline not implemented yet" },
    { status: 501 }
  );
}
