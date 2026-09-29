# contour

Select a square region on a map and export it as a black/white heightmap —
black is low elevation, white is high. Built for feeding real-world terrain
into game engines and terrain tools (Unreal, Unity, World Machine, etc.).

**Live:** https://contour-swart.vercel.app

Built it for importing heightmaps for **Transport Fever 3**. Read furthcer below.

## How to use

1. **Pick a basemap.** Use the switcher top-left — Streets, Topo, Satellite,
   or Satellite + Relief — to help you find the region you want. These are
   just for navigation; they aren't part of the exported data.
2. **Select a region.** Hold **Shift** and drag on the map to draw a square.
   The live size (km × km) and elevation range show in the export panel.
   Selections are capped at 100 km × 100 km. Bigger regions cover more
   ground per pixel at the same resolution, so detail drops off as the
   selection grows — pick a higher resolution or a smaller area for
   sharper output.
3. **Rotate it, if needed.** Drag the green dot at the top of the square to
   rotate the selection to any angle. The exported image is always a plain
   upright square — rotation just changes which ground it covers.
4. **Choose export options** in the panel on the right:
   - **Format** — 16-bit PNG (recommended, widest compatibility), 8-bit PNG
     (lower precision), RAW `.r16` (headerless 16-bit, for direct import
     into engines like Unreal/CryEngine/World Machine), or GeoTIFF (32-bit
     float, real elevation values in meters, georeferenced WGS84 — for GIS
     tools like QGIS/ArcGIS/gdal, not a regular image viewer). GeoTIFF
     pixels hold raw elevation (e.g. `800.0`), not a normalized 0–1 range,
     so opening it in Windows Photos, a browser, or any plain image viewer
     will show solid white — those tools assume float pixels are already
     in 0–1 and everything clips. Open it in a GIS tool instead, where you
     set your own display stretch. Rotated selections are georeferenced
     correctly via a full affine transform.
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
5. Click **Export** to download the file.

Elevation data comes from the Tilezen/AWS Terrarium tile dataset (free,
global, no API key). Ocean and other below-sea-level areas are flattened to
0 (black).

# Transport Fever 3
This is what google got me:
## Importing Custom Heightmaps into Transport Fever 3

Step-by-step guide to importing custom heightmaps using the updated creation workflow.

## Phase 1: Prepare Your Heightmap Data

Before opening the game, you need a high-quality topographical image.

- **Format:** Save the file as a grayscale `.png` or `.tif`.
- **Color depth:** Use 16-bit grayscale if possible. This prevents "staircasing" (sharp, pixelated ridges) on mountains.
- **Dimensions:** The image must be perfectly square. Standard sizes are `1025x1025`, `2049x2049`, or `4097x4097` pixels, depending on the desired map scale.

## Phase 2: Direct Folder Import (Classic Method)

The fastest way to make your file visible in the game's menu is to place it in the user directory.

1. Navigate to your Transport Fever 3 user directory. For Steam users this is typically:

   ```
   ...\Steam\userdata\[YourSteamID]\1845190\local\maps\
   ```

   > **Note:** The exact Steam AppID folder number may vary based on final game build paths.

2. Create a new folder inside `maps` and name it after your project (e.g. `MyCustomMap`).
3. Rename your image file to exactly `heightmap.png` (or `heightmap.tif`).
4. Paste the file into the new folder.

## Phase 3: Loading and Tuning in the Map Editor

Transport Fever 3 processes maps through an interactive visual system.

1. Launch Transport Fever 3 and select **Map Editor** from the main menu.
2. Click **Create New Map** and choose your climate, vehicle set, and starting year.
3. In the generator window, find the **Generation Nodes / Pipeline** panel.
4. Click **Add Node** and select the **Heightmap / Image Input Node**.
5. In the node's properties, click the file browser icon and select your custom folder/file from Phase 2.
6. *(Optional but recommended)* Chain additional nodes:
   - Connect an **Erosion Node** to smooth rough real-world edges.
   - Connect a **Water/River Node** to carve realistic riverbeds into the imported topography.
7. Adjust the **Height Scale** slider in the import node to set the distance between the lowest valleys and highest peaks.
8. Click **Generate Preview** to view the 3D render. Click **Save** once you are satisfied with the layout.

> This has yet to be tested once the game has been released!!

# Desktop app

Prefer not to use a browser? Download a standalone desktop version — same
app, no npm or terminal needed. Still needs an internet connection to load
map tiles and elevation data.

- **Windows**: run the `.exe` installer, or build it yourself with
  `npm run electron:build:win` (produces `dist/contour Setup *.exe`).
- **macOS**: `.dmg` is unsigned (no Apple Developer certificate), so
  Gatekeeper blocks the first launch — right-click the app → **Open** to
  bypass it, or allow it under System Settings → Privacy & Security.
  Apple Silicon (arm64) only for now.

Both are built automatically by `.github/workflows/build-desktop.yml` on
GitHub Actions (manually via "Run workflow", or by pushing a `v*` tag) —
download the artifacts from the workflow run.

# Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Stack: Next.js (App Router) + MapLibre GL JS for the map, a small
tile-fetch/decode/resample pipeline in `src/lib/`, and a hand-rolled PNG
encoder (`src/lib/png.ts`) for correct 16-bit grayscale output. The desktop
app (`electron/main.cjs`) runs this same Next.js app locally via Electron —
no separate implementation.

# Deployment

Pushes to `main` auto-deploy to Vercel via the connected GitHub integration.