import { RadarScene } from './renderer.js';
import { buildSyntheticVolume } from './synthetic.js';
import { parseLevel2 } from './nexrad.js';
import { dbzToColor, legendStops } from './colormap.js';
import { buildMosaic, findNearbyStations, findClosestKey, findLatestKey, fetchLevel2, revoxelizeMosaic } from './mosaic.js';
import { STATIONS } from './stations.js';

const $ = (id) => document.getElementById(id);

const canvas = $('scene');
const scene = new RadarScene(canvas);

// ---------- Legend ----------
function buildLegend() {
  const el = $('legend');
  el.innerHTML = '';
  for (const stop of legendStops()) {
    const c = dbzToColor(stop.dbz);
    const row = document.createElement('div');
    row.className = 'legend-row';
    const sw = document.createElement('span');
    sw.className = 'legend-swatch';
    sw.style.background = `rgb(${Math.round(c[0]*255)},${Math.round(c[1]*255)},${Math.round(c[2]*255)})`;
    const lbl = document.createElement('span');
    lbl.textContent = `${stop.dbz} dBZ`;
    row.appendChild(sw);
    row.appendChild(lbl);
    el.appendChild(row);
  }
}
buildLegend();

// ---------- Loader / toast ----------
function showLoader(text) {
  $('loader-text').textContent = text || 'Loading…';
  $('loader').classList.remove('hidden');
}
function hideLoader() { $('loader').classList.add('hidden'); }

let toastTimer = null;
function toast(msg, kind = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('warn', kind === 'warn');
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}

// ---------- Stats panel ----------
function updateVolumeStats(volume, info) {
  $('stat-mode').textContent = volume.synthetic ? 'Synthetic' : 'Single';
  $('stat-station').textContent = volume.station || '—';
  $('stat-tilts').textContent = String(volume.tilts.length);
  const totalGates = volume.tilts.reduce((s, t) => s + t.azimuthsDeg.length * t.gates, 0);
  $('stat-gates').textContent = totalGates.toLocaleString();
  $('stat-max').textContent = info.maxDbz != null ? `${info.maxDbz.toFixed(1)} dBZ` : '—';
  $('stat-points').textContent = info.pointCount.toLocaleString();
  const ts = volume.timestamp ? volume.timestamp.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '';
  if (volume.synthetic) {
    $('volume-label').textContent = `Synthetic demo volume — ${volume.tilts.length} tilts`;
  } else {
    $('volume-label').textContent = `${volume.station} • ${ts} • ${volume.tilts.length} tilts`;
  }
}

function updateMosaicStats(mosaic, info) {
  $('stat-mode').textContent = 'Mosaic';
  $('stat-station').textContent = mosaic.stations.map(s => s.station.id).join(' ');
  $('stat-tilts').textContent = `${mosaic.stations.length} files`;
  $('stat-gates').textContent = mosaic.points.length.toLocaleString() + ' voxels';
  $('stat-max').textContent = info.maxDbz != null ? `${info.maxDbz.toFixed(1)} dBZ` : '—';
  $('stat-points').textContent = info.pointCount.toLocaleString();
  const t = mosaic.targetTime.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  $('volume-label').textContent =
    `Mosaic • ${mosaic.center.lat.toFixed(2)}°,${mosaic.center.lon.toFixed(2)}° • ${t} • ${mosaic.stations.length} radars`;
}

function applyVolume(volume) {
  const info = scene.setVolume(volume);
  updateVolumeStats(volume, info);
}

// ---------- Initial demo ----------
applyVolume(buildSyntheticVolume({ seed: Math.floor(Math.random() * 1000) }));
// Single-radar tab is active by default; init its picker map up front.
queueMicrotask(() => ensureSingleMap());

// ---------- Display controls (shared) ----------
$('threshold').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  $('threshold-value').textContent = String(v);
  const info = scene.setOption('threshold', v);
  if (info) {
    if (scene.mode === 'volume') updateVolumeStats(scene.lastVolume, info);
    else if (scene.mode === 'mosaic') updateMosaicStats(scene.lastMosaic, info);
  }
});
$('vexag').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  $('vexag-value').textContent = `${v}×`;
  scene.setOption('verticalExaggeration', v);
});
$('psize').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  $('psize-value').textContent = v.toFixed(1);
  scene.setOption('pointSize', v);
});
// In single-radar mode the stride is applied at render time, so it's cheap
// and we re-render every input event. In mosaic mode the stride controls
// gate decimation during voxel ingest, so we have to rebuild the voxel grid
// from the cached per-station volumes — debounce so we only do that once
// the user stops dragging the slider.
let mosaicStrideTimer = null;
$('stride').addEventListener('input', (e) => {
  const v = parseInt(e.target.value, 10);
  $('stride-value').textContent = String(v);
  if (scene.mode === 'mosaic' && scene.lastMosaic) {
    scene.options.stride = v;
    clearTimeout(mosaicStrideTimer);
    mosaicStrideTimer = setTimeout(() => {
      const m = scene.lastMosaic;
      if (!m) return;
      revoxelizeMosaic(m, { stride: v });
      const info = scene.setMosaic(m);
      updateMosaicStats(m, info);
    }, 120);
    return;
  }
  const info = scene.setOption('stride', v);
  if (info) {
    if (scene.mode === 'volume') updateVolumeStats(scene.lastVolume, info);
  }
});
$('show-basemap').addEventListener('change', (e) => scene.setShowBasemap(e.target.checked));
$('show-ground').addEventListener('change', (e) => scene.setShowGround(e.target.checked));
$('show-rings').addEventListener('change', (e) => scene.setShowRings(e.target.checked));
$('auto-rotate').addEventListener('change', (e) => scene.setAutoRotate(e.target.checked));
scene.setShowGround($('show-ground').checked);

// ---------- Mode tabs ----------
const tabs = document.querySelectorAll('.mode-tab');
const panes = document.querySelectorAll('.mode-pane');
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.toggle('active', t === tab));
    const mode = tab.dataset.mode;
    panes.forEach(p => p.classList.toggle('hidden', p.dataset.mode !== mode));
    if (mode === 'mosaic') ensureMap();
    else if (mode === 'single') ensureSingleMap();
  });
});

// ---------- Single-radar: map picker, file upload, demo ----------
const singleState = {
  map: null,
  stationLayer: null,
  selectedMarker: null,
  station: null,
};

function ensureSingleMap() {
  if (singleState.map || typeof L === 'undefined') {
    if (singleState.map) setTimeout(() => singleState.map.invalidateSize(), 50);
    return;
  }
  const map = L.map('single-map', {
    center: [37.5, -97],
    zoom: 4,
    minZoom: 3,
    maxZoom: 10,
    zoomControl: true,
    attributionControl: true,
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap, © CARTO',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  const stationLayer = L.layerGroup().addTo(map);
  for (const s of STATIONS) {
    const isTdwr = s.type === 'tdwr';
    const color = isTdwr ? '#7af0ff' : '#ffd86b';
    const marker = L.circleMarker([s.lat, s.lon], {
      radius: isTdwr ? 3 : 4,
      color,
      weight: 1,
      fillColor: color,
      fillOpacity: 0.55,
    });
    const typeLabel = isTdwr ? 'TDWR' : 'WSR-88D';
    marker.bindTooltip(`${s.id} — ${s.name} (${typeLabel})`, { direction: 'top', offset: [0, -4] });
    marker.on('click', () => selectSingleStation(s));
    marker.addTo(stationLayer);
  }

  singleState.map = map;
  singleState.stationLayer = stationLayer;
  setTimeout(() => map.invalidateSize(), 60);
}

function selectSingleStation(station) {
  singleState.station = station;
  const typeLabel = station.type === 'tdwr' ? 'TDWR' : 'WSR-88D';
  $('single-station-label').textContent = `${station.id} — ${station.name} (${typeLabel})`;
  $('single-load-btn').disabled = false;
  $('single-grab-latest-btn').disabled = false;
  const map = singleState.map;
  if (map) {
    if (singleState.selectedMarker) singleState.selectedMarker.remove();
    singleState.selectedMarker = L.circleMarker([station.lat, station.lon], {
      radius: 9, color: '#4cffd5', weight: 2, fillColor: '#4cffd5', fillOpacity: 0.4,
    }).addTo(map);
    map.panTo([station.lat, station.lon], { animate: true });
  }
}

function singleTargetTime() {
  const v = $('single-time').value;
  if (!v) return new Date(Date.now() - 30 * 60 * 1000);
  const d = new Date(v + 'Z');
  return Number.isNaN(d.getTime()) ? new Date(Date.now() - 30 * 60 * 1000) : d;
}

$('single-time').value = defaultTime();

async function loadSingleScan({ findKey, label }) {
  const station = singleState.station;
  if (!station) return;
  $('single-load-btn').disabled = true;
  $('single-grab-latest-btn').disabled = true;
  showLoader(`Finding ${label} for ${station.id}…`);
  try {
    const found = await findKey();
    if (!found) throw new Error(`No archived files found for ${station.id}.`);
    showLoader(`Downloading ${found.key.split('/').pop()}…`);
    const buf = await fetchLevel2(found.key);
    showLoader('Parsing Level II (decompressing radials)…');
    const volume = await parseLevel2(buf, found.key);
    applyVolume(volume);
    // Reflect the loaded scan's timestamp back into the picker so the user
    // can see exactly what they got and step from there.
    if (found.time) $('single-time').value = formatTime(found.time);
    const tStr = (volume.timestamp || found.time).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    toast(`Loaded ${station.id} • ${tStr} • ${volume.tilts.length} tilts.`);
  } catch (err) {
    console.error(err);
    toast(`Failed: ${err.message}`, 'warn');
  } finally {
    hideLoader();
    $('single-load-btn').disabled = false;
    $('single-grab-latest-btn').disabled = false;
  }
}

$('single-load-btn').addEventListener('click', () => {
  const target = singleTargetTime();
  loadSingleScan({
    findKey: () => findClosestKey(singleState.station.id, target),
    label: 'scan',
  });
});

$('single-grab-latest-btn').addEventListener('click', () => {
  loadSingleScan({
    findKey: () => findLatestKey(singleState.station.id),
    label: 'latest scan',
  });
});

$('demo-btn').addEventListener('click', () => {
  applyVolume(buildSyntheticVolume({ seed: Math.floor(Math.random() * 1000) }));
  toast('Synthetic demo regenerated.');
});
$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  showLoader(`Reading ${file.name}…`);
  try {
    const buf = await file.arrayBuffer();
    showLoader('Parsing Level II (decompressing radials)…');
    const volume = await parseLevel2(buf, file.name);
    applyVolume(volume);
    toast(`Loaded ${file.name} — ${volume.tilts.length} tilts.`);
  } catch (err) {
    console.error(err);
    toast(`Failed to load file: ${err.message}`, 'warn');
  } finally {
    hideLoader();
    e.target.value = '';
  }
});

// Drag-and-drop on the whole window (single-radar mode only)
['dragover', 'drop'].forEach((evt) => window.addEventListener(evt, (e) => e.preventDefault()));
window.addEventListener('drop', (e) => {
  if (document.querySelector('.mode-tab.active')?.dataset.mode !== 'single') return;
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  $('file-input').files = e.dataTransfer.files;
  $('file-input').dispatchEvent(new Event('change'));
});

// ---------- Mosaic ----------
const mosaicState = {
  center: null,        // { lat, lon }
  marker: null,
  map: null,
  stationLayer: null,
  searchCircle: null,
};

function ensureMap() {
  if (mosaicState.map || typeof L === 'undefined') {
    if (mosaicState.map) setTimeout(() => mosaicState.map.invalidateSize(), 50);
    return;
  }
  const map = L.map('mosaic-map', {
    center: [37.5, -97],
    zoom: 4,
    minZoom: 3,
    maxZoom: 10,
    zoomControl: true,
    attributionControl: true,
  });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap, © CARTO',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  // Add static dots for known stations (WSR-88D yellow, TDWR cyan)
  const stationLayer = L.layerGroup().addTo(map);
  for (const s of STATIONS) {
    const isTdwr = s.type === 'tdwr';
    const color = isTdwr ? '#7af0ff' : '#ffd86b';
    const typeLabel = isTdwr ? 'TDWR' : 'WSR-88D';
    L.circleMarker([s.lat, s.lon], {
      radius: isTdwr ? 2 : 3,
      color,
      weight: 1,
      fillColor: color,
      fillOpacity: 0.5,
    })
      .bindTooltip(`${s.id} — ${s.name} (${typeLabel})`, { direction: 'top', offset: [0, -4] })
      .addTo(stationLayer);
  }

  map.on('click', (e) => setMosaicCenter(e.latlng.lat, e.latlng.lng));

  mosaicState.map = map;
  mosaicState.stationLayer = stationLayer;
  setTimeout(() => map.invalidateSize(), 60);
}

function setMosaicCenter(lat, lon) {
  mosaicState.center = { lat, lon };
  $('mosaic-coords').textContent = `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
  const map = mosaicState.map;
  if (mosaicState.marker) mosaicState.marker.setLatLng([lat, lon]);
  else mosaicState.marker = L.circleMarker([lat, lon], {
    radius: 7, color: '#4cffd5', weight: 2, fillColor: '#4cffd5', fillOpacity: 0.6,
  }).addTo(map);
  refreshSearchCircle();
  refreshNearbyPreview();
  $('mosaic-build').disabled = false;
  $('mosaic-grab-latest-btn').disabled = false;
}

function currentRadiusKm() { return parseInt($('mosaic-radius').value, 10); }
function currentMaxStations() { return parseInt($('mosaic-maxstations').value, 10); }

function refreshSearchCircle() {
  if (!mosaicState.center || !mosaicState.map) return;
  const { lat, lon } = mosaicState.center;
  const r = currentRadiusKm() * 1000;
  if (mosaicState.searchCircle) mosaicState.searchCircle.remove();
  mosaicState.searchCircle = L.circle([lat, lon], {
    radius: r, color: '#00d4ff', weight: 1, fillColor: '#00d4ff', fillOpacity: 0.05, dashArray: '4 4',
  }).addTo(mosaicState.map);
}

function refreshNearbyPreview() {
  const list = $('mosaic-status');
  list.innerHTML = '';
  if (!mosaicState.center) return;
  const nearby = findNearbyStations(
    mosaicState.center.lat, mosaicState.center.lon,
    currentRadiusKm(), currentMaxStations()
  );
  for (const s of nearby) {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    li.innerHTML =
      `<span class="ss-id">${s.id}</span>` +
      `<span class="ss-name">${s.name} · ${s.distKm.toFixed(0)} km</span>` +
      `<span class="ss-status" data-status>idle</span>`;
    list.appendChild(li);
  }
}

function setStationStatus(id, label, kind) {
  const li = document.querySelector(`#mosaic-status li[data-id="${id}"]`);
  if (!li) return;
  const span = li.querySelector('[data-status]');
  span.textContent = label;
  span.className = `ss-status ${kind || ''}`;
}

// Default the time picker to ~30 minutes ago (UTC)
function defaultTime() { return formatTime(new Date(Date.now() - 30 * 60 * 1000)); }
function formatTime(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
$('mosaic-time').value = defaultTime();

// "Grab latest" finds the most recent scan published by any nearby station and
// uses that as the mosaic target time, then auto-builds. We sample latest from
// up to a few stations because individual radars can lag by several minutes.
$('mosaic-grab-latest-btn').addEventListener('click', async () => {
  if (!mosaicState.center) { toast('Pick a mosaic center first.', 'warn'); return; }
  const nearby = findNearbyStations(
    mosaicState.center.lat, mosaicState.center.lon,
    currentRadiusKm(), Math.min(3, currentMaxStations())
  );
  if (!nearby.length) { toast('No stations within search radius.', 'warn'); return; }
  $('mosaic-grab-latest-btn').disabled = true;
  showLoader('Finding latest scan…');
  try {
    // We do NOT swallow per-station failures into nulls here: a transient
    // S3/CORS error that happens to hit the station with the freshest scan
    // would otherwise let a remaining station's older "latest" stand in
    // for the true latest, and we'd auto-build a mosaic at a stale time.
    // Any failure aborts the flow and surfaces a toast so the user can
    // retry rather than silently get yesterday's data.
    const results = await Promise.all(nearby.map(s => findLatestKey(s.id)));
    let bestT = -Infinity;
    for (const r of results) if (r?.time && r.time.getTime() > bestT) bestT = r.time.getTime();
    if (!Number.isFinite(bestT)) throw new Error('No recent files found for any nearby station.');
    $('mosaic-time').value = formatTime(new Date(bestT));
    hideLoader();
    $('mosaic-build').click();
  } catch (err) {
    console.error(err);
    toast(`Failed: ${err.message}`, 'warn');
    hideLoader();
  } finally {
    $('mosaic-grab-latest-btn').disabled = false;
  }
});

$('mosaic-radius').addEventListener('input', (e) => {
  $('radius-value').textContent = `${e.target.value} km`;
  refreshSearchCircle();
  refreshNearbyPreview();
});
$('mosaic-maxstations').addEventListener('input', (e) => {
  $('maxstations-value').textContent = e.target.value;
  refreshNearbyPreview();
});

$('mosaic-build').addEventListener('click', async () => {
  if (!mosaicState.center) return;
  const tStr = $('mosaic-time').value;
  if (!tStr) { toast('Pick a time first.', 'warn'); return; }
  // Treat the picker value as UTC.
  const targetTime = new Date(tStr + 'Z');
  if (Number.isNaN(targetTime.getTime())) { toast('Invalid time.', 'warn'); return; }

  refreshNearbyPreview();
  showLoader('Discovering nearby radars…');
  $('mosaic-build').disabled = true;
  try {
    const mosaic = await buildMosaic({
      centerLat: mosaicState.center.lat,
      centerLon: mosaicState.center.lon,
      targetTime,
      radiusKm: currentRadiusKm(),
      maxStations: currentMaxStations(),
      stride: parseInt($('stride').value, 10),
      minDbz: 5,
      onProgress: (p) => {
        if (p.station) {
          if (p.phase === 'list') setStationStatus(p.station.id, 'listing…', 'busy');
          else if (p.phase === 'fetch') setStationStatus(p.station.id, 'downloading…', 'busy');
          else if (p.phase === 'parse') setStationStatus(p.station.id, 'parsing…', 'busy');
          else if (p.phase === 'error') setStationStatus(p.station.id, 'failed', 'err');
        }
        if (p.phase === 'discover') showLoader(p.message);
        else if (p.phase === 'list') showLoader(`Finding files (${p.current}/${p.total})…`);
        else if (p.phase === 'fetch') showLoader(`Downloading ${p.station.id} (${p.current}/${p.total})…`);
        else if (p.phase === 'parse') showLoader(`Parsing ${p.station.id} (${p.current}/${p.total})…`);
        else if (p.phase === 'merge') showLoader(p.message);
      },
    });

    // Mark all ingested stations as ok
    for (const s of mosaic.stations) setStationStatus(s.station.id, 'ok', 'ok');
    for (const s of (mosaic.skipped || [])) setStationStatus(s.station.id, 'skipped', 'err');

    const info = scene.setMosaic(mosaic);
    updateMosaicStats(mosaic, info);
    toast(`Mosaic built from ${mosaic.stations.length} radars (${mosaic.points.length.toLocaleString()} voxels).`);
  } catch (err) {
    console.error(err);
    toast(`Mosaic failed: ${err.message}`, 'warn');
  } finally {
    hideLoader();
    $('mosaic-build').disabled = false;
  }
});

