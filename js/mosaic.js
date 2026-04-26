// Build a multi-radar 3D mosaic centered on a chosen lat/lon.
// Discovers nearby WSR-88D stations, fetches each station's Level II file
// closest in time to a target timestamp from the public AWS bucket, parses
// the reflectivity volumes, reprojects every gate into a common ENU frame
// centered on the click point, and max-merges into a sparse voxel grid.

import { STATIONS } from './stations.js';
import { haversineKm, lonLatToEnuKm, beamHeightKm } from './geo.js';
import { parseLevel2 } from './nexrad.js';

const S3_HOST = 'https://noaa-nexrad-level2.s3.amazonaws.com';

// AWS hasn't published a CORS policy on the public NEXRAD bucket, so direct
// browser fetches from another origin (e.g. github.io) are blocked. Allow the
// user to route requests through a CORS proxy of their choice. Resolution
// order: ?cors-proxy=<prefix> URL param > localStorage > window global. The
// value is a URL prefix; the target S3 URL is appended URL-encoded, which
// matches the convention used by corsproxy.io, allorigins, and most others.
function readCorsProxy() {
  try {
    const params = new URL(window.location.href).searchParams;
    if (params.has('cors-proxy')) return params.get('cors-proxy') || '';
  } catch (_) { /* non-browser context */ }
  try {
    const stored = localStorage.getItem('nexrad-cors-proxy');
    if (stored !== null) return stored;
  } catch (_) { /* storage disabled */ }
  if (typeof window !== 'undefined' && typeof window.NEXRAD_CORS_PROXY === 'string') {
    return window.NEXRAD_CORS_PROXY;
  }
  return '';
}

function s3Url(path) {
  const target = `${S3_HOST}${path}`;
  const proxy = readCorsProxy();
  return proxy ? `${proxy}${encodeURIComponent(target)}` : target;
}

async function corsFetch(url, label) {
  try {
    return await fetch(url);
  } catch (err) {
    // Browsers surface CORS rejections and offline as TypeError — disambiguate
    // for the user by pointing at the proxy knob.
    if (err instanceof TypeError) {
      const proxy = readCorsProxy();
      const hint = proxy
        ? `via proxy ${proxy}`
        : 'no CORS proxy set — append ?cors-proxy=https://corsproxy.io/? to the page URL (or set localStorage "nexrad-cors-proxy"). See README.';
      throw new Error(`${label} blocked by CORS or network: ${hint}`);
    }
    throw err;
  }
}

export function findNearbyStations(centerLat, centerLon, radiusKm, maxCount = 6) {
  return STATIONS
    .map(s => ({ ...s, distKm: haversineKm(centerLat, centerLon, s.lat, s.lon) }))
    .filter(s => s.distKm <= radiusKm)
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, maxCount);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function dateToPrefix(d, station) {
  return `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}/${station}/`;
}

// Extract a Date from a filename like "KTLX20240515_223000_V06".
function timeFromKey(key) {
  const base = key.split('/').pop() || '';
  const m = base.match(/[A-Z]{4}(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

async function listKeys(prefix) {
  const url = s3Url(`/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=300`);
  const res = await corsFetch(url, `S3 list ${prefix}`);
  if (!res.ok) throw new Error(`S3 list failed (${res.status}) for ${prefix}`);
  const xml = await res.text();
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const out = [];
  for (const node of doc.getElementsByTagName('Contents')) {
    const k = node.getElementsByTagName('Key')[0]?.textContent;
    if (!k) continue;
    if (k.includes('_MDM')) continue;       // metadata-only file
    if (!/_V0[346]$|_V0[346]\.gz$/.test(k)) continue;
    out.push(k);
  }
  return out;
}

export async function findClosestKey(stationId, targetDate) {
  // Search target UTC day, plus ±1 day if no close hit.
  const dayMs = 24 * 3600 * 1000;
  const candidates = [];
  for (const offset of [0, -dayMs, dayMs]) {
    const d = new Date(targetDate.getTime() + offset);
    try {
      const keys = await listKeys(dateToPrefix(d, stationId));
      candidates.push(...keys);
    } catch (e) {
      // ignore — empty or no permission
    }
    if (candidates.length > 0 && offset === 0) break; // usually enough
  }
  if (!candidates.length) return null;
  let best = null, bestDiff = Infinity;
  for (const k of candidates) {
    const t = timeFromKey(k);
    if (!t) continue;
    const diff = Math.abs(t.getTime() - targetDate.getTime());
    if (diff < bestDiff) { best = k; bestDiff = diff; }
  }
  return best ? { key: best, time: timeFromKey(best), diffMs: bestDiff } : null;
}

async function fetchLevel2(key) {
  const res = await corsFetch(s3Url(`/${key}`), `download ${key}`);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${key}`);
  return new Uint8Array(await res.arrayBuffer()).buffer;
}

// Voxel grid keyed by "ix|iy|iz".
class VoxelGrid {
  constructor(sizeXkm = 2, sizeYkm = 2, sizeZkm = 0.5) {
    this.sx = sizeXkm; this.sy = sizeYkm; this.sz = sizeZkm;
    this.map = new Map();
  }
  add(eKm, nKm, uKm, dbz) {
    const ix = Math.floor(eKm / this.sx);
    const iy = Math.floor(nKm / this.sy);
    const iz = Math.floor(uKm / this.sz);
    const key = ix + '|' + iy + '|' + iz;
    const prev = this.map.get(key);
    if (prev === undefined || dbz > prev) this.map.set(key, dbz);
  }
  toPoints() {
    const out = new Array(this.map.size);
    let i = 0;
    for (const [key, dbz] of this.map) {
      const [ix, iy, iz] = key.split('|').map(Number);
      out[i++] = {
        x: (ix + 0.5) * this.sx,
        y: (iy + 0.5) * this.sy,
        z: (iz + 0.5) * this.sz,
        dbz,
      };
    }
    return out;
  }
  get size() { return this.map.size; }
}

function ingestVolume(grid, volume, station, center, opts) {
  // Radar position in mosaic ENU
  const { e: e0, n: n0, u: u0 } = lonLatToEnuKm(
    station.lat, station.lon, station.elev,
    center.lat, center.lon, center.elev ?? 0
  );

  const stride = opts.stride || 2;
  const minDbz = opts.minDbz ?? 5;
  const maxRangeKm = opts.maxRangeKm ?? 230;

  for (const tilt of volume.tilts) {
    const elevRad = tilt.elevationDeg * Math.PI / 180;
    const cosE = Math.cos(elevRad);
    const { gates, gateSpacingM, firstGateM, azimuthsDeg, reflectivity } = tilt;
    const azCount = azimuthsDeg.length;
    for (let a = 0; a < azCount; a++) {
      const az = azimuthsDeg[a];
      if (!Number.isFinite(az)) continue;
      const azRad = az * Math.PI / 180;
      const sinA = Math.sin(azRad);
      const cosA = Math.cos(azRad);
      const rowOff = a * gates;
      for (let g = 0; g < gates; g += stride) {
        const dbz = reflectivity[rowOff + g];
        if (!Number.isFinite(dbz) || dbz < minDbz) continue;
        const slantKm = (firstGateM + g * gateSpacingM) / 1000;
        if (slantKm > maxRangeKm) continue;
        const groundKm = slantKm * cosE;
        const heightKm = beamHeightKm(slantKm, elevRad);
        const e = e0 + sinA * groundKm;
        const n = n0 + cosA * groundKm;
        const u = u0 + heightKm;
        grid.add(e, n, u, dbz);
      }
    }
  }
}

// Build the mosaic. `onProgress` receives status objects:
//   { phase, station, message, current, total }
export async function buildMosaic({
  centerLat, centerLon, centerElev = 0,
  targetTime,
  radiusKm = 250,
  maxStations = 6,
  voxel = { x: 2, y: 2, z: 0.5 },
  stride = 2,
  minDbz = 5,
  onProgress = () => {},
}) {
  const stations = findNearbyStations(centerLat, centerLon, radiusKm, maxStations);
  if (!stations.length) {
    throw new Error('No WSR-88D stations within search radius. Try a larger radius or a different point.');
  }

  onProgress({
    phase: 'discover',
    message: `Found ${stations.length} station${stations.length > 1 ? 's' : ''} within ${radiusKm} km`,
    stations,
  });

  // Discover the closest file per station (in parallel).
  const keyResults = await Promise.all(stations.map(async (s, i) => {
    onProgress({ phase: 'list', station: s, current: i + 1, total: stations.length });
    try {
      const r = await findClosestKey(s.id, targetTime);
      return r ? { station: s, ...r } : { station: s, error: 'no file' };
    } catch (e) {
      return { station: s, error: e.message };
    }
  }));

  const usable = keyResults.filter(r => !r.error);
  if (!usable.length) {
    throw new Error('No NEXRAD files found for any nearby station near that time. Try a different timestamp.');
  }

  // Fetch + parse each volume sequentially so the loader can show progress.
  const grid = new VoxelGrid(voxel.x, voxel.y, voxel.z);
  const center = { lat: centerLat, lon: centerLon, elev: centerElev };
  const ingested = [];
  for (let i = 0; i < usable.length; i++) {
    const { station, key, time } = usable[i];
    onProgress({
      phase: 'fetch', station, key, current: i + 1, total: usable.length,
    });
    try {
      const buf = await fetchLevel2(key);
      onProgress({ phase: 'parse', station, current: i + 1, total: usable.length });
      const volume = await parseLevel2(buf, key);
      ingestVolume(grid, volume, station, center, { stride, minDbz });
      ingested.push({ station, time, key, tilts: volume.tilts.length });
    } catch (e) {
      onProgress({ phase: 'error', station, message: e.message });
    }
  }

  if (!ingested.length) throw new Error('Failed to load any radar volumes.');

  onProgress({ phase: 'merge', message: `Merging ${grid.size.toLocaleString()} voxels`, voxelCount: grid.size });
  const points = grid.toPoints();

  return {
    center,
    targetTime,
    radiusKm,
    stations: ingested,
    skipped: keyResults.filter(r => r.error),
    voxelSize: voxel,
    points,
  };
}
