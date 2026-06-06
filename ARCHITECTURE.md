# 3d-nexrad architecture

A walkthrough of every source file and function. The app is a browser-only
WebGL viewer for NEXRAD/TDWR Level II radar data — there is no server. All
parsing, voxelization, and rendering happens in the browser.

## File map

| File | Purpose |
|---|---|
| `index.html` | DOM scaffolding, control panel, loads three.js + Leaflet |
| `style.css` | Styling for the panels, map, legend, and toasts |
| `js/app.js` | UI glue: tabs, sliders, map pickers, button handlers |
| `js/renderer.js` | Three.js scene; converts a volume or mosaic into points |
| `js/mosaic.js` | Multi-radar discovery, S3 fetch, voxel-grid stitching |
| `js/nexrad.js` | NEXRAD/TDWR Archive II Level II parser |
| `js/synthetic.js` | Procedural demo volume so the app shows something on load |
| `js/synthetic-mosaic.js` | Multi-radar synthetic scene (shared wind field + vortex) for dual-Doppler |
| `js/dualdoppler.js` | Multi-radar wind synthesis + rotation (vorticity) detection |
| `js/stations.js` | Station coordinates and per-type range constants |
| `js/geo.js` | Haversine distance, ENU projection, beam-height formula |
| `js/colormap.js` | Reflectivity, velocity, and vorticity color scales |
| `js/osm-ground.js` | OSM/CARTO tile basemap drawn under the 3D scene |

## Data flow

```
   [single radar]           [mosaic]
   pick station        click center on map
       │                       │
   findLatestKey /         findNearbyStations
   findClosestKey               │
       │                  per-station findClosestKey
   fetchLevel2                  │
       │                   per-station fetchLevel2
   parseLevel2                  │
       │                   per-station parseLevel2
       │                        │
       │                   ingestVolume → VoxelGrid (max-merge)
       │                        │
   scene.setVolume()        scene.setMosaic()
       └────────── three.js Points geometry ───────────┘
```

Everything renders as a `THREE.Points` object whose vertex positions are in
**kilometers** in a local ENU frame (East = +X, Up = +Y, North = -Z), with
per-vertex colors from the active product's scale — reflectivity (dBZ),
velocity (m/s), or, for the dual-Doppler mosaic, vorticity (s⁻¹).

---

## `js/geo.js`

Geographic helpers. Tangent-plane (ENU) approximations are accurate enough
for the ~250 km radii the app cares about.

### `deg2rad(d)`
Degrees to radians.

### `haversineKm(lat1, lon1, lat2, lon2)`
Great-circle distance between two lat/lon points in kilometers. Used to
score how close a station is to a click point.

### `lonLatToEnuKm(lat, lon, elevM, lat0, lon0, elev0M) → { e, n, u }`
Returns the local East/North/Up offset (km) of `(lat, lon, elev)` relative
to a tangent plane at `(lat0, lon0, elev0)`. Used to place each radar's
gates into a common Cartesian frame for the mosaic, and to position
station markers in the 3D scene.

### `enuKmToLonLat(eKm, nKm, lat0, lon0) → { lat, lon }`
Inverse of `lonLatToEnuKm` (horizontal only): turns a local East/North offset
back into geographic coordinates. Used to label rotation cores with a real
lat/lon the user can cross-reference against the radar display.

### `beamHeightKm(slantKm, elevationRad)`
Height above the tangent plane of a radar gate at the given slant range and
elevation angle, using the standard 4/3-Earth-radius refractivity model.
Used by both the single-volume renderer and `ingestVolume` so cloud tops
sit at realistic heights instead of straight-line beam projections.

---

## `js/colormap.js`

Color scales for each product. The velocity and vorticity scales are
deliberately colorblind-safe diverging ramps (ColorBrewer RdBu and PuOr) in
different hue families so the products read distinctly.

### `STOPS` / `dbzToColor(dbz)` / `legendStops()`
Standard NWS reflectivity scale: a table of `{ dbz, [r,g,b] }` stops from -30
to 75 dBZ with linear interpolation. `dbzToColor` clamps outside the range and
returns black for non-finite input; `legendStops` returns the 5–70 dBZ subset.

### `velToColor(v, vmax)` / `velLegendStops(vmax)`
Radial velocity (m/s) on a RdBu diverging scale over `[-vmax, vmax]`: blue =
inbound (toward radar), red = outbound. `vmax` is fit to the data per volume.

### `vortToColor(vort, vmax)` / `vortLegendStops(vmax)`
Vertical vorticity (s⁻¹) on a PuOr diverging scale: purple = anticyclonic,
orange = cyclonic. Legend ticks are labeled in 10⁻³ s⁻¹.

### `lobeColor(q)`
Green ground shading for the dual-Doppler lobe overlay, brightening with the
beam-crossing quality `q` (`|sin β|`). Green keeps it distinct from the radar
data and the cyan range rings.

---

## `js/stations.js`

Curated subset of WSR-88D and TDWR sites with per-type range constants.

### `STATIONS` (exported array)
Each entry: `{ id, name, lat, lon, elev, type }`. The bottom of the file
strips placeholder section markers (entries with empty `name`) and defaults
any missing `type` to `'wsr88d'` so callers can rely on the field being set.

### `STATION_REACH_KM`
`{ wsr88d: 460, tdwr: 90 }` — maximum distance (km) at which the radar
publishes any reflectivity data. WSR-88D extends to ~460 km in long-range
mode; TDWR is short-range C-band capped near 90 km. Used by
`findNearbyStations` to decide whether a station can possibly see a click
point.

### `STATION_GATE_KM`
`{ wsr88d: 230, tdwr: 90 }` — quality cutoff for individual gates during
voxel ingest. WSR-88D's reach goes well past where the data is trustworthy,
so the legacy "Z" useful range (~230 km) is the actual cap on what gets
merged into the voxel grid. TDWR's physical reach already matches its
useful reach.

### `stationReachKm(s)` / `stationGateKm(s)`
Lookup helpers that fall back to the WSR-88D values if `s.type` is unknown.

---

## `js/synthetic.js`

Procedural demo volume so the app shows something interesting on first
load (and via the "Regenerate demo" button). Output structure matches
`parseLevel2`'s `{ tilts: [...] }` so the renderer can't tell the
difference.

### `rng(seed)`
Mulberry32 PRNG. Returns a function producing reproducible 0–1 floats.

### `defaultCells(rand)`
Picks 4–6 random storm cells: `{ az, range, top, intensity, rH, rV,
anvilDir }`. Each cell becomes a 3D Gaussian core plus a downwind-spreading
anvil.

### `reflectivityAt(xKm, yKm, zKm, cells, rand)`
Evaluates dBZ at one point in space by max-merging contributions from each
cell's core and anvil, plus a low-altitude stratiform background and a
small noise term. Below -30 dBZ becomes NaN (no echo).

### `windAt(xKm, yKm, zKm, cells)`
Synthetic horizontal wind (m/s, east/north): a southwesterly flow that veers
and strengthens with height, plus cyclonic rotation near each storm cell so the
VEL product shows recognizable inbound/outbound couplets.

### `buildSyntheticVolume(opts) → Volume`
Sweeps 14 elevation tilts across a full 360° azimuth at 1° spacing and
460 gates of 250 m spacing. For every (tilt, azimuth, gate) it computes
beam ground range and height with the 4/3-Earth approximation, samples
`reflectivityAt`, and — where there's an echo — projects `windAt` onto the beam
to get a radial velocity. Both moments are packed into the same
`{ moments: { REF, VEL }, ... }` shape parsed Level II files use (so `setVolume`
and `tiltMoment` are shared), plus `synthetic: true`.

---

## `js/nexrad.js`

Hand-rolled NEXRAD/TDWR Archive II (Level II) parser. References the
NWS RDA/RPG ICD ("Build 19"). Only what's needed for visualization is
implemented — the `REF` (reflectivity, dBZ) and `VEL` (base radial
velocity, m/s) moments from Type 31 digital radar messages. The set of
extracted moments is the `MOMENTS` constant; spectrum width and dual-pol
moments are present in the file but skipped.

### `getBzip2()`
Lazily imports `seek-bzip` from esm.sh on first use. Cached as a Promise
so concurrent callers share one fetch.

### `STATION_LOCATIONS`
At-import lookup of `{ lat, lon, elev }` keyed by station ID, derived from
`STATIONS`. Lets `parseLevel2` attach coordinates to the parsed volume.

### `class BinReader`
Cursor-based big-endian reader over a `Uint8Array`. Methods: `i8`, `u8r`,
`i16`, `u16`, `i32`, `u32`, `f32`, `ascii(n)`, `slice(n)`, `skip(n)`,
`remaining()`. The Level II format is all big-endian and full of variable
offsets, so a positional reader is the cleanest approach.

### `concatU8(parts)`
Concatenates an array of `Uint8Array`s into one. Currently unused but kept
because LDM record reassembly across segments could need it.

### `parseMomentBlock(u8, blockPos, msgEndPos)`
Decodes one moment data block. Returns `{ name, numGates, firstGate,
gateSpacing, data: Float32Array }`, or null if the block isn't a moment in
`MOMENTS` or runs past the message bounds. Reads the block's
scale/offset/word-size header and dequantizes raw byte/halfword values into
physical units (dBZ for REF, m/s for VEL). Raw values 0 (below threshold)
and 1 (range folded) become NaN so they don't render.

### `parseMessage31(r, msgEndPos)`
Parses one Type 31 digital radar message (one radial). Returns
`{ elevation, azimuth, elevationNumber, moments }` where `moments` is a map
keyed by moment name (e.g. `{ REF, VEL }`) and may be empty. The radial
header gives the data-block pointers; the parser walks them and runs each
through `parseMomentBlock`, keeping the ones it handles.

### `parseMessageStream(buf, station, accum)`
Walks one decompressed LDM block byte-by-byte. Each Level II message has
a 16-byte header preceded by a 12-byte CTM padding (sometimes). For
messages whose type field is 31, hands off to `parseMessage31` and pushes
the result into the `Accumulator`. Other message types are skipped using
the standard 2416-byte length, except Type 31 which uses the size-halfwords
field. Walks forward a byte at a time when alignment is lost rather than
giving up.

### `class Accumulator`
Groups radials into elevation tilts as they arrive.
- `addRadial(station, m)` — keys by `elevationNumber` (or rounded
  elevation as a fallback). Appends each radial's azimuth and its full
  `moments` map.
- `finalize()` — sorts tilts by elevation angle, sorts radials within each
  tilt by azimuth, and packs each moment separately into the
  renderer-friendly form. Each tilt becomes
  `{ elevationDeg, azimuthsDeg: Float32Array, moments: { REF, VEL, ... },
  reflectivity, missingValue: NaN }`, where every packed moment is
  `{ gates, gateSpacingM, firstGateM, data: Float32Array(azCount * gates) }`
  and `reflectivity` is kept as a legacy alias for `moments.REF.data`. Moments
  are packed independently, so a split cut (velocity on a separate elevation
  scan from reflectivity) is handled per moment. Short rows are NaN-padded so
  all radials in a tilt share one stride.

### `tiltMoment(tilt, name)`
Accessor that returns a tilt's packed moment by name (`'REF'`/`'VEL'`), or
null. Falls back to the legacy top-level `reflectivity` shape for `'REF'`, so
both parsed volumes and the synthetic generators work through one interface.

### `parseLevel2(arrayBuffer, filename) → Volume`
Top-level entry point. Steps:
1. Detect outer `BZh` magic — some servers gzip-then-bzip; if the file
   isn't already `AR2V` magic, decode the outer bzip2.
2. Validate the 24-byte AR2V volume header and read the station ICAO.
3. Walk LDM records (length-prefixed). Sign of the control word *should*
   indicate bzip2 but isn't reliable, so the parser sniffs `BZh` magic
   instead. Some records have a 4-byte length prefix before the bzip2
   stream — falls back to skipping that on first decode failure.
4. For each decoded record, hand to `parseMessageStream`.
5. Returns `{ station, lat, lon, elevMeters, timestamp, synthetic: false,
   sourceFile, tilts }`. Currently the timestamp is `new Date()` (now)
   rather than the volume's actual scan time — `findClosestKey` /
   `findLatestKey` already give the caller a real timestamp via the
   filename, so the renderer uses that.

---

## `js/mosaic.js`

Multi-radar 3D mosaic. Discovers nearby radars, fetches each station's
Level II from the public Unidata S3 mirror, parses, reprojects every gate
into a common ENU frame, and max-merges into a sparse voxel grid.

### Constants
- `S3_HOST` — Unidata's `unidata-nexrad-level2.s3.amazonaws.com`. NOAA's
  bucket now rejects unsigned anonymous requests, and Unidata serves
  permissive CORS, so the browser can fetch directly.

### `s3Url(path)`
Just `${S3_HOST}${path}`.

### `corsFetch(url, label)`
Wraps `fetch` to translate `TypeError` (the symptom of a CORS or DNS
failure) into a labeled error so the toast tells the user what was being
fetched.

### `findNearbyStations(centerLat, centerLon, radiusKm, maxCount = 6)`
Returns the closest `maxCount` stations to the click point, where each
station passes both filters: `distKm <= radiusKm` (user search budget)
and `distKm <= stationReachKm(station)` (station can actually see the
point). The reach filter is what keeps a TDWR 200 km from a click point
out of the list — it would otherwise burn a slot that should go to a
WSR-88D actually covering the point. Each returned station has `distKm`
attached for display.

### `pad2(n)` / `dateToPrefix(d, station)`
Build the `YYYY/MM/DD/STATION/` S3 prefix from a Date.

### `timeFromKey(key)`
Extracts a UTC `Date` from a Level II filename like
`KTLX20240515_223000_V06`. Returns null if the regex misses.

### `listKeys(prefix)`
Pages through ListObjectsV2 until the day's prefix is exhausted. The
pagination matters: TDWR sites publish ~1440 scans/day, S3 caps a single
page at 1000, and keys come back in lexicographic = chronological order,
so an un-paginated request would silently return the *earliest* scans of
the day and miss the latest one. Filters out `_MDM` metadata-only files
and keeps only `_V03/V04/V06` (WSR-88D Archive II builds) and `_V08`
(FAA TDWR Archive II), with optional `.gz` suffix.

### `findLatestKey(stationId, maxDaysBack = 3)`
Walks back day-by-day from now (UTC) looking for the most recent file.
Returns `{ key, time }` or null. Listing failures are *not* swallowed —
a transient S3/CORS error on today's prefix would otherwise let
yesterday's "latest" stand in for the real latest, and the user would
silently get stale data.

### `findClosestKey(stationId, targetDate)`
Searches the target UTC day plus ±1 day if needed, picks the file whose
filename timestamp is closest to `targetDate`. Returns `{ key, time,
diffMs }`.

### `fetchLevel2(key)`
Downloads the bytes for a key as an `ArrayBuffer`. Throws on non-2xx.

### `class VoxelGrid`
Sparse 3D grid keyed by `"ix|iy|iz"` strings in a `Map`.
- `constructor(sxKm, syKm, szKm)` — cell sizes. Defaults 2 × 2 × 0.5 km.
- `add(eKm, nKm, uKm, dbz)` — quantizes coords to cell indices and
  **max-merges** into the cell. If two radars cover the same voxel, the
  higher dBZ wins. (Side-effect: a stronger AP/clutter return from one
  radar overrides a clean reading from another.)
- `toPoints() → [{ x, y, z, dbz }]` — emits voxel centers as flat points
  for the renderer.
- `size` getter — number of occupied cells.

### `ingestVolume(grid, volume, station, center, opts)`
Reprojects every gate in one parsed volume into the mosaic's ENU frame
and inserts into the shared `VoxelGrid`. For each tilt and azimuth, walks
gates with `stride` decimation, skips gates whose dBZ is below `minDbz`,
skips gates whose slant range exceeds `stationGateKm(station)` (per-type
quality cutoff — 230 km for WSR-88D, 90 km for TDWR), and converts
(slant, az, elev) → (east, north, up) in km via `lonLatToEnuKm` plus
`beamHeightKm`.

### `buildMosaic({ centerLat, centerLon, centerElev, targetTime, radiusKm,
maxStations, voxel, stride, minDbz, onProgress })`
Top-level orchestration:
1. `findNearbyStations` → throws if none.
2. In parallel per station, `findClosestKey(stationId, targetTime)`.
   Per-station failures here become `{ error }` entries instead of
   aborting (one station with a missing day shouldn't kill a mosaic that
   still has 5 others).
3. Sequentially per usable station: `fetchLevel2` → `parseLevel2`. The
   sequential pass is so the loader can show "downloading KTLX (3/6)…".
   Each parsed volume is **stashed** on the mosaic entry so changing
   stride or threshold later doesn't have to re-download.
4. Builds a `mosaic` object then calls `revoxelizeMosaic` to populate
   `mosaic.points`.
5. `onProgress` callback receives `{ phase, station?, message?, current?,
   total? }` events for UI status updates. Phases: `discover`, `list`,
   `fetch`, `parse`, `error`, `merge`.

Returned mosaic shape:
```
{ center, targetTime, radiusKm, stations: [{ station, time, key, tilts,
  volume }], skipped: [{ station, error }], voxelSize, points, stride,
  minDbz }
```

### `revoxelizeMosaic(mosaic, { stride, minDbz })`
Rebuilds `mosaic.points` from the cached per-station `volume`s after a
slider change. Optionally updates the stored `stride`/`minDbz` first.
Cheap relative to a full rebuild because it skips network and parsing.

---

## `js/osm-ground.js`

Drapes OSM/CARTO "dark_all" tiles under the 3D scene as textured planes,
so the user sees coastlines and roads beneath the radar data instead of a
plain grid.

### `lonLatToTile(lat, lon, z)` / `tileToLonLat(x, y, z)`
Standard slippy-map coordinate transforms (Web Mercator).

### `pickZoom(radiusKm)`
Picks a tile zoom level so each tile is roughly 1/4 of the visualization
radius. Clamped to z=4..10 — tighter than that pulls too many tiles, looser
loses detail at the click point. This is the heuristic that keeps tile
count to a few dozen.

### `loadTexture(loader, url)`
`THREE.TextureLoader.load` wrapped in a Promise that resolves with the
texture (or `null` on error) — never rejects, so one missing tile doesn't
abort the rest.

### `createOsmGround(centerLat, centerLon, radiusKm, opts) → { group, attribution, zoom }`
Computes the rectangle of tiles needed to cover `radiusKm` around the
center and instantiates a `THREE.Mesh` per tile with a `PlaneGeometry`
sized in km. Each plane gets a placeholder color material immediately and
the actual texture is swapped in once it loads (so the scene appears
instantly rather than blocking on a slow tile). Tiles whose center is
beyond `radiusKm + tileKm` are culled. Returns the group plus the
attribution string (for the corner credit).

---

## `js/renderer.js`

The three.js scene. World units are kilometers; East = +X, Up = +Y,
North = -Z. The whole `world` group has its Y scale set to
`verticalExaggeration` so vertical features pop visually without
distorting horizontal placement.

### `class RadarScene`

Owns one `WebGLRenderer`, one `PerspectiveCamera` with `OrbitControls`,
and a `world` group containing:
- `ground` — kilometers-grid + dark disc (toggle-able)
- `basemap` — OSM tile group (toggle-able)
- `rings` — range rings every 50 km (or 100 km past 250 km radius)
- `compass` — N/S/E/W axis lines
- `markers` — center beacon and station dots
- `points` — the actual radar voxels/gates

#### Constructor
Wires up renderer/camera/controls/lighting, builds initial ground/rings/
compass at a 460 km world radius, registers a `resize` listener, and
starts the render loop.

#### `setAutoRotate(enabled)`
Toggles `OrbitControls.autoRotate` at a fixed 0.6 rad/s.

#### `setShowGround(v)` / `setShowRings(v)` / `setShowBasemap(v)`
Toggle visibility of the named decoration group. `setShowBasemap` also
remembers the user's preference so re-creating the basemap on a new click
respects it.

#### `getBasemapAttribution()`
Returns the OSM/CARTO credit string so the UI can render it in the
corner.

#### Product state: `product` / `mosaicProduct` / `effectiveProduct()`
Single-radar volumes use `product` (`'REF'`|`'VEL'`); mosaics use
`mosaicProduct` (`'REF'`|`'ROT'`). `effectiveProduct()` returns whichever
applies to the current mode, and the UI legend follows it. `setProduct(p)`
and `setMosaicProduct(p)` set the field and re-render the current scene if it
matches that mode.

#### `setOption(key, value)`
Updates one of `threshold` (REF dBZ floor), `velMin` (VEL min |velocity|),
`vortMinShow` (ROT min |vorticity| display filter), `verticalExaggeration`,
`pointSize`, or `stride`. A change that affects geometry/coloring triggers a
full re-render via `setVolume`/`setMosaic` (returning the new info object so
the stats panel can update); `velMin` only re-renders volumes and
`vortMinShow` only re-renders mosaics. Vertical exaggeration just rescales
the world group; point size just mutates the material.

#### `setVolume(volume)`
Single-radar render path, product-aware. Clears existing points, resizes
decorations to 230 km, drops a basemap if the volume has lat/lon, then walks
every (tilt, azimuth, gate) of the selected moment (`tiltMoment`):
- REF skips gates below `threshold` dBZ; VEL skips gates with |velocity| below
  `velMin`. Both skip gates beyond 230 km slant range.
- Computes ground range from `slantKm * cos(elev)`, height from
  `beamHeightKm`, and pushes a point at `(sinA*ground, height,
  -cosA*ground)` (azimuth 0 = north).
- Colors from `dbzToColor` (REF) or `velToColor` (VEL). Velocity uses a
  symmetric, data-fit domain: a pre-pass finds the max |velocity| (clamped to
  20–60 m/s) so the diverging scale spans the actual extremes; that `vmax` is
  stashed on `lastVelMax` for the legend.

Returns `{ pointCount, product, isVel, units, peak, maxDbz }` for the stats
panel.

#### `setMosaic(mosaic)`
Multi-radar render path. Clears points/markers and resizes decorations, then
dispatches on `mosaicProduct`: `_renderRotation` if `'ROT'` and a rotation
field is present, otherwise `_renderReflectivityMosaic`. Afterwards it adds a
teal center beacon at the origin and a station marker per contributing radar
(yellow dot for WSR-88D, smaller cyan dot for TDWR, with a vertical stem so
they don't get lost in the cloud). Returns the chosen path's info object.

#### `_renderReflectivityMosaic(mosaic)`
Walks `mosaic.points` (already in ENU km from `buildMosaic`/
`revoxelizeMosaic`) and pushes those above `threshold` as world-space points
colored by `dbzToColor`. Returns `{ pointCount, product: 'REF', maxDbz, ... }`.

#### `_renderRotation(mosaic)`
Renders `mosaic.rotation.points`: each solved cell colored by vertical
vorticity via `vortToColor` over a symmetric, data-fit domain (clamped to
0.008–0.04 s⁻¹, stashed on `lastVortMax` for the legend), skipping cells below
the `vortMinShow` filter. Adds a `_makeRotationCore` column marker per detected
core. Returns `{ pointCount, product: 'ROT', isRotation, peak, vortMax,
coreCount, ... }`.

#### `_installPoints(positions, colors)`
Builds a `BufferGeometry` from flat number arrays, attaches it to a
`PointsMaterial` with `vertexColors`, `transparent`, `depthWrite: false`,
and adds it to `world`. Resets `world.scale.y` to the current
verticalExaggeration in case it had drifted.

#### `_clearPoints()` / `_clearMarkers()` / `_clearBasemap()`
Remove from parent and dispose geometries/materials/textures. Three.js
doesn't garbage-collect GPU resources, so explicit disposal is required
to avoid leaks across reloads.

#### `_setBasemap(lat, lon, radiusKm)`
Caches a `lat|lon|radius` signature and skips the rebuild if unchanged.
Otherwise tears down the old basemap and calls `createOsmGround` for the
new one.

#### `_resizeDecorations(radiusKm)`
Replaces ground / rings / compass when the visualization scale changes
(e.g. switching from a single-radar 230 km view to a wide mosaic). Picks
ring spacing of 50 km up to 250 km, 100 km beyond. Preserves visibility
state across the rebuild.

#### `_makeGround(size, div)` / `_makeRangeRings(radii)` / `_makeCompass(reach)`
Construct the static decoration meshes. Cyan range rings, light grid,
faint dark disc, single bright cyan north arrow with three dim
counter-axes.

#### `_makeCenterMarker()`
Teal cone + ring at the click point.

#### `_makeStationMarker(station, enu)`
Colored dot (yellow for WSR-88D, cyan for TDWR) plus a translucent stem
6 km tall so the marker is visible through dense voxel clouds. Position
comes from the precomputed `enu` offset.

#### `_makeRotationCore(core, vmax)`
A ground-anchored pin at a detected rotation core: a thin vertical locator
stem up to the core's altitude, capped by a horizontal ring + bead tinted by
`vortToColor(core.vort, vmax)` (orange = cyclonic, purple = anticyclonic). The
cap lives in the horizontal plane so its apparent size stays stable under
vertical exaggeration; only the stem stretches, which correctly tracks height.

#### `_resize()` / `_animate()`
Standard three.js DPR-aware resize and `requestAnimationFrame` loop.
`controls.update()` is needed because `enableDamping` is on.

---

## `js/app.js`

Wires the DOM controls to the scene and the network code. There are no
classes — just module-level state objects (`singleState`, `mosaicState`)
and event listeners.

### `$(id)`
Tiny `document.getElementById` shorthand.

### `legendRow(c, text)` / `refreshLegend()`
`refreshLegend()` rebuilds the on-screen legend to match whatever the renderer
is actually drawing, keyed off `scene.effectiveProduct()`: the dBZ scale
(`legendStops`) for REF, the data-fit velocity scale (`velLegendStops`,
`scene.lastVelMax`) for VEL, or the vorticity scale (`vortLegendStops`,
`scene.lastVortMax`) for ROT. `legendRow` renders one swatch + label. Called at
startup and after every product/render change.

### `showLoader(text)` / `hideLoader()`
Toggle the full-screen loading overlay with a status message.

### `toast(msg, kind)`
Auto-dismissing notification (5 s). `kind === 'warn'` switches it to red.

### `updateVolumeStats(volume, info)` / `updateMosaicStats(mosaic, info)`
Refresh the stats panel after a (re)render. Mosaic version lists every
contributing station ID, voxel count, and the target time; volume version
shows the station, scan timestamp, and tilt/gate counts.

### `applyVolume(volume)`
Hands a volume to `scene.setVolume` and updates the stats panel.

### Product selector (`PRODUCT_UI`, `applyProductUI`, `setProductOptions`, `selectMosaicProduct`)
The Product dropdown is mode-aware: `setProductOptions(mode)` repopulates it
with REF/VEL for single radar or REF/ROT for mosaics. `PRODUCT_UI` maps each
product to how the shared threshold slider behaves (a dBZ floor for REF, min
|velocity| for VEL, min rotation for ROT), and each product remembers its own
slider value. The change handler routes single-radar products to
`scene.setProduct`; for mosaics, `selectMosaicProduct` lazily synthesizes the
rotation field (`buildRotationField`, under a loader) on first switch to ROT,
re-renders, refreshes the legend, and surfaces QC toasts (too few velocity
radars, or the aliasing caveat).

### Display-control listeners (`threshold`, `vexag`, `psize`, `stride`,
`show-basemap`, `show-ground`, `show-rings`, `auto-rotate`)
Forward slider/checkbox changes to `scene.setOption` (or directly to
`scene.set*` for boolean toggles). The `threshold` slider is reused per
product via `PRODUCT_UI[effectiveProduct()].optKey`. The `stride` listener has
a special case for mosaic mode: changing stride means re-running `ingestVolume`
for every cached station, so it debounces 120 ms to coalesce drag events into
one `revoxelizeMosaic` call (and invalidates any cached rotation field).

### Mode tabs
Two tabs: "Single radar" and "Mosaic". Switching tabs shows/hides panes,
lazily initializes the corresponding Leaflet map (`ensureSingleMap` or
`ensureMap`) — neither map exists until its tab is first shown — and
repopulates the Product dropdown for the active mode via `setProductOptions`.

### Single-radar mode
- `singleState` — `{ map, stationLayer, selectedMarker, station }`.
- `ensureSingleMap()` — Lazily creates the Leaflet map with a CARTO dark
  basemap and one circle marker per station (yellow WSR-88D, cyan TDWR).
  Clicking a marker calls `selectSingleStation`.
- `selectSingleStation(station)` — Highlights the chosen station, pans
  the map, enables the load buttons.
- `singleTargetTime()` — Reads the time picker, treats it as UTC, falls
  back to "30 minutes ago" if invalid.
- `loadSingleScan({ findKey, label })` — Generic loader: calls the
  caller-supplied finder (`findClosestKey` or `findLatestKey`), then
  `fetchLevel2` → `parseLevel2` → `applyVolume`. Reflects the loaded
  scan's actual timestamp back into the picker so stepping works.
- Two button handlers wire `Load scan` / `Load latest` to that loader.
- `demo-btn` regenerates a synthetic volume.
- `file-input` change handler — accepts a local Level II file via the
  hidden file input.
- `dragover` / `drop` window listeners — accept drag-and-drop into the
  single-radar pane (mosaic pane ignores drops).

### Mosaic mode
- `mosaicState` — `{ center, marker, map, stationLayer, searchCircle }`.
- `ensureMap()` — Mirror of `ensureSingleMap` but clicking the map calls
  `setMosaicCenter` instead of selecting a station.
- `setMosaicCenter(lat, lon)` — Drops a teal pin, redraws the search
  circle, refreshes the nearby-stations preview, enables the build
  buttons.
- `currentRadiusKm()` / `currentMaxStations()` — Read the two sliders.
- `refreshSearchCircle()` — Redraws the dashed cyan radius circle on the
  Leaflet map.
- `refreshNearbyPreview()` — Re-runs `findNearbyStations` and renders an
  `<li>` per station with id, name, distance, and an `idle`/`busy`/`ok`/
  `err` status chip.
- `setStationStatus(id, label, kind)` — Updates one row's status chip
  during a build.
- `defaultTime()` / `formatTime(d)` / `pad(n)` — Default the time picker
  to ~30 min ago in UTC; format/parse as `YYYY-MM-DDTHH:MM`.
- `mosaic-grab-latest-btn` handler — Samples up to 3 nearby stations'
  most recent file via `findLatestKey`, picks the freshest, sets the
  picker to that time, and chains into `runMosaicBuild`. Per-station
  errors here are *not* swallowed — a transient failure on the freshest
  station would otherwise let a stale "latest" stand in.
- `mosaic-radius` / `mosaic-maxstations` listeners — Update the labels
  and refresh the preview live.
- `mosaicBuildInFlight` — Module-level flag preventing two concurrent
  `buildMosaic` runs. The build button's disabled state would normally
  prevent that for click handlers, but Grab Latest also calls
  `runMosaicBuild` directly, so the flag covers the second path.
- `runMosaicBuild()` — Reads the picker, calls `buildMosaic` with the
  current sliders, threads a progress callback that updates per-station
  status chips and the full-screen loader, synthesizes the rotation field
  first if the ROT product is selected, then hands the finished mosaic to
  `scene.setMosaic` and updates the stats panel and legend. Failures show
  a toast.
- `mosaic-build` button click handler — Just calls `runMosaicBuild`.
- `rotation-demo` button handler — Builds a synthetic multi-radar scene
  (`buildSyntheticMosaic`), voxelizes it (`revoxelizeMosaic`), synthesizes
  the rotation field (`buildRotationField`), then renders it as the ROT
  product. An alias-free, no-network way to see and validate dual-Doppler.

### Initial state
- A synthetic demo volume is rendered immediately on first paint so the
  scene isn't empty.
- The single-radar tab is active by default; its map is initialized in a
  `queueMicrotask` to avoid measuring zero-size containers.

---

## `js/dualdoppler.js`

Multi-radar (dual-Doppler) wind synthesis and rotation detection. A single
radar measures only the radial wind component `Vr = u·a + v·b + w·c` (where
`(a,b,c)` is the radar→gate unit vector); two or more radars viewing a cell
from different angles give independent projections, so the horizontal wind
`(u, v)` can be recovered. Vertical velocity `w` is neglected (valid at low
tilts where `c ≈ 0`).

### `class DualDopplerGrid`
A sparse Cartesian grid (`"ix|iy|iz"` keys). Each cell accumulates the
least-squares **normal-equation sums** (`Saa, Sab, Sbb, Sav, Sbv`), a sample
count, and a station bitmask — rather than storing every sample.

### `ingestVelocity(grid, volume, station, center, bit, opts)`
Projects one volume's VEL gates into the grid: computes each gate's ENU
position and the horizontal beam unit vector `(a, b)`, then accumulates the
normal equations weighted by `cos²(elevation)` (down-weighting high tilts).
Only tilts ≤ `maxElevDeg` (default 7°) are used. `opts.shiftE/shiftN`
apply an **advection** offset (km) so a volume scanned before the reference
time is moved downstream to align with the others.

### `solveGrid(grid, opts)`
Per cell with ≥2 contributing radars, solves the 2×2 system for `(u, v)`.
`det = Saa·Sbb − Sab²` gates geometry: the normalized quality
`q = 2·√det/(Saa+Sbb)` equals `|sin β|` for two beams crossing at angle β, so
`q ≥ qMin` (default 0.5) reproduces the classic 30°–150° dual-Doppler lobe
criterion. A second pass computes vorticity `ζ = ∂v/∂x − ∂u/∂y` by central
differences against same-height neighbours.

### `detectCores(points, opts)` / `nmsCores(...)`
Cells whose `|ζ|` exceeds `vortMin` (default 0.005 s⁻¹), reduced to one core
per rotation by Euclidean non-maximum suppression.

### `crossingQualityAt(eKm, nKm, radars)` / `computeLobeGrid(radars, radiusKm, opts)`
`crossingQualityAt` returns the best beam-crossing quality (`|sin β|`) among
all radar pairs viewing a point — 0 along a baseline, 1 at a 90° cross.
`computeLobeGrid` samples it over a horizontal grid to produce the
**dual-Doppler lobe** (where the geometry is trustworthy); it depends only on
radar positions, not the data, so it shows even where there's no echo.

### `enrichCores(cores, radars, center)`
Decorates each detected core with a real-world position (`lat`, `lon` via
`enuKmToLonLat`, `heightKm`, `rangeKm`, `bearingDeg`) and a trust flag
(`qGeom`, `inLobe`) so the UI can list and locate it.

### `buildRotationField(mosaic, opts) → { points, cores, lobe, qc }`
Orchestrates the above over a mosaic's already-cached per-station volumes (no
refetch — the same volumes the reflectivity composite uses). Computes a
reference time and a per-radar advection offset from `opts.advection`
(`{u, v}` m/s, default off), enriches the cores, and builds the lobe grid.
Stashes the result on `mosaic.rotation`. `qc` reports radars contributing
velocity, scan-time spread, whether advection is on, and — for non-synthetic
data — an aliasing caveat (raw Level II velocity is not dealiased, so folded
gates can distort the retrieval).

---

## `js/synthetic-mosaic.js`

Builds a synthetic multi-radar scene for validating and demoing dual-Doppler.
Several virtual radars all sample the **same** analytic wind field (a uniform
base flow plus a cyclonic Rankine vortex), so a correct synthesis must recover
that field and the vorticity must peak at the prescribed vortex. Being
analytic, the scene is free of velocity aliasing. `buildSyntheticMosaic(opts)`
returns a mosaic object compatible with `revoxelizeMosaic` (REF) and
`buildRotationField` (VEL). An optional `motion` (m/s) + `spreadSec` make each
radar see the vortex at its own scan time, displaced along the motion vector —
the exact situation advection correction is built to undo, so the harness can
validate it.

## Rotation in the renderer / UI

- `renderer.js` tracks `mosaicProduct` (`'REF'` | `'ROT'`). `_renderRotation`
  colors each solved cell by vorticity (`vortToColor`, data-fit symmetric
  domain), draws the lobe overlay (`_setLobe`, green ground dots), and drops a
  compact pin marker (`_makeRotationCore` — a ground-anchored stem capped by a
  ring/bead that stays sized sensibly under vertical exaggeration) on each core.
  `setShowLobe` toggles the overlay; `focusOn(e, n, u)` flies the camera to a
  core. The display filter `vortMinShow` (10⁻³ s⁻¹) hides weak cells.
- `app.js` makes the Product dropdown mode-aware: single radar offers REF/VEL,
  mosaic offers REF/ROT. Selecting ROT synthesizes the rotation field lazily
  (under a loader) from the cached volumes, then surfaces QC toasts. The
  **Rotation tools** panel (visible in mosaic+ROT) adds the lobe-overlay toggle,
  a **storm-motion** control (`readStormMotion` → advection vector; editing it
  re-synthesizes), and a **core inspector** (`updateRotationPanel`) listing each
  core's strength/sense/height/position with an in-lobe badge — clicking a row
  calls `scene.focusOn`. A **synthetic rotation demo** button renders the
  synthetic scene immediately.
