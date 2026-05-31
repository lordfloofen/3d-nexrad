# 3D NEXRAD Viewer

A static HTML5 web app that renders NEXRAD Level II radar volumes in 3D
using [Three.js](https://threejs.org/). Runs entirely in the browser — no
server, no build step.

Live site: https://lordfloofen.github.io/3d-nexrad/ (after first Pages deploy)

## What it does

- Renders the entire radar volume (all elevation tilts) as a colored point
  cloud, using the NWS reflectivity color scale.
- A **Product** dropdown switches a single-radar volume between reflectivity
  (`REF`, dBZ) and base radial velocity (`VEL`, m/s).
- Beam paths use a 4/3-earth approximation, so points sit at the correct
  height for their slant range and elevation angle.
- Stitches multiple nearby radars into a 3D reflectivity **mosaic**, and can
  combine their velocities into a **dual-Doppler rotation** product —
  retrieving the horizontal wind and rendering vertical vorticity so
  mesocyclones show up objectively (with a one-click synthetic demo).
- Interactive controls for dBZ threshold (or min velocity / min rotation),
  vertical exaggeration, point size, and gate stride (downsampling).
- Ships with a built-in synthetic storm generator so the page is alive on
  first visit.
- Drop in a real NEXRAD Archive II file (`*_V06`, optionally `.bz2`-wrapped)
  or a TDWR Archive II file (`*_V08`) and it parses + renders client-side.
- The single-radar map and the mosaic both include FAA TDWR sites alongside
  WSR-88D — TDWR markers are rendered cyan and WSR-88D yellow.

## Getting NEXRAD Level II data

The full NEXRAD archive is mirrored by Unidata in the public
`unidata-nexrad-level2` S3 bucket (same key layout as NOAA's, but
anonymously accessible and CORS-enabled — the same bucket
[supercell-wx](https://github.com/dpaulat/supercell-wx) uses):

- Browse: https://unidata-nexrad-level2.s3.amazonaws.com/index.html
- File pattern: `YYYY/MM/DD/{ICAO}/{ICAO}YYYYMMDD_HHMMSS_V06`

Pick a file, download it, and either drag it onto the page or use the upload
button.

> NOAA's `noaa-nexrad-level2` bucket no longer permits unsigned anonymous
> requests (every browser fetch returns 403), which is why this app fetches
> from the Unidata mirror instead.

## Multi-radar mosaic

The mosaic mode fetches Level II files directly from S3 in the browser. The
Unidata mirror serves `Access-Control-Allow-Origin: *`, so the browser can
fetch directly with no proxy.

The single-radar upload mode reads local files and is unaffected by CORS.

## Running locally

It's a static site — any static file server works:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

You can't open `index.html` via `file://` because the app uses ES module
imports.

## Deployment

The included workflow at `.github/workflows/pages.yml` deploys the repo to
GitHub Pages on every push to `main`. To enable:

1. Go to the repo's **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Push to `main` and watch the action run.

## Implementation notes

- Three.js is loaded from `unpkg` via an import map.
- The bzip2 decoder ([`seek-bzip`](https://www.npmjs.com/package/seek-bzip))
  is loaded on-demand from `esm.sh` only when the user uploads a real file.
- Two moments are parsed from Type 31 messages: reflectivity (`REF`, dBZ) and
  base radial velocity (`VEL`, m/s). Pick between them with the **Product**
  dropdown. Spectrum width and dual-pol moments are still ignored. Split cuts
  are handled per moment, so the velocity Doppler cut renders even when it's a
  separate elevation scan from the reflectivity surveillance cut.
- The velocity scale is a colorblind-friendly diverging ramp (ColorBrewer
  RdBu): cool/blue = inbound (toward the radar), warm/red = outbound (away).
  This avoids the classic green/red Doppler scheme, which is the hardest case
  for red-green color-vision deficiency.
- Raw radial velocity is a single-radar product. The multi-radar mosaic
  instead offers a **dual-Doppler rotation** product: it combines the radial
  velocities from overlapping radars to retrieve the horizontal wind `(u, v)`
  and renders the resulting vertical vorticity `ζ = ∂v/∂x − ∂u/∂y` so rotation
  (e.g. mesocyclones) shows up objectively rather than as eyeballed couplets.
  Vorticity uses a separate colorblind-safe diverging scale (ColorBrewer PuOr):
  purple = anticyclonic, orange = cyclonic. Detected rotation cores are marked
  with vertical columns.
- The synthesis solves a per-cell least-squares system and gates it on
  beam-crossing geometry (the classic 30°–150° dual-Doppler lobe criterion).
  Vertical velocity is neglected (low tilts only), and **raw Level II velocity
  is not yet dealiased** — folded gates can distort real-data retrievals, so a
  QC warning is shown. The bundled *synthetic rotation demo* (several virtual
  radars sampling a shared wind field with a known vortex) is alias-free and
  validates the method end to end.

## License

MIT
