# 3D NEXRAD Viewer

A static HTML5 web app that renders NEXRAD Level II reflectivity volumes in 3D
using [Three.js](https://threejs.org/). Runs entirely in the browser — no
server, no build step.

Live site: https://lordfloofen.github.io/3d-nexrad/ (after first Pages deploy)

## What it does

- Renders the entire radar volume (all elevation tilts) as a colored point
  cloud, using the NWS reflectivity color scale.
- Beam paths use a 4/3-earth approximation, so points sit at the correct
  height for their slant range and elevation angle.
- Interactive controls for dBZ threshold, vertical exaggeration, point size,
  and gate stride (downsampling).
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
- Only the reflectivity (`REF`) moment from Type 31 messages is parsed. Velocity,
  spectrum width, dual-pol moments, and split cuts are ignored. This keeps the
  parser small while still producing a recognizable storm structure.

## License

MIT
