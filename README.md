# contour

Select a square region on a map and export it as a black/white heightmap —
black is low elevation, white is high. Built for feeding real-world terrain
into game engines and terrain tools (Unreal, Unity, World Machine, etc.).

**Live:** https://contour-swart.vercel.app

## How to use

1. **Pick a basemap.** Use the switcher top-left — Streets, Topo, Satellite,
   or Satellite + Relief — to help you find the region you want. These are
   just for navigation; they aren't part of the exported data.
2. **Select a region.** Hold **Shift** and drag on the map to draw a square.
   The live size (km × km) shows in the export panel. Selections are capped
   at 50 km × 50 km.
3. **Choose export options** in the panel on the right:
   - **Format** — 16-bit PNG (recommended, widest compatibility), 8-bit PNG
     (lower precision), or RAW `.r16` (headerless 16-bit, for direct import
     into engines like Unreal/CryEngine/World Machine). GeoTIFF is planned
     but not available yet.
   - **Resolution** — output image size (512–4096 px square).
   - **Normalization** — *Best contrast* stretches the selection's own
     min/max elevation across the full black-white range (sharpest detail,
     but flat/coastal regions can look noisy since there's little real
     elevation range to stretch). *Fixed scale (0–9000m)* maps a constant
     real-world range instead, so results are comparable across exports and
     flat areas stay dark.
   - **Georeference sidecar** — optional `.json` with the exact bounding
     box, resolution, elevation min/max, and normalization used, for
     reimporting with real-world scale.
4. Click **Export** to download the file.

Elevation data comes from the Tilezen/AWS Terrarium tile dataset (free,
global, no API key). Ocean and other below-sea-level areas are flattened to
0 (black).

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Stack: Next.js (App Router) + MapLibre GL JS for the map, a small
tile-fetch/decode/resample pipeline in `src/lib/`, and a hand-rolled PNG
encoder (`src/lib/png.ts`) for correct 16-bit grayscale output.

## Deployment

Pushes to `main` auto-deploy to Vercel via the connected GitHub integration.
