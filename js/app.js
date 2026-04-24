import { RadarScene } from './renderer.js';
import { buildSyntheticVolume } from './synthetic.js';
import { parseLevel2 } from './nexrad.js';
import { dbzToColor, legendStops } from './colormap.js';

const $ = (id) => document.getElementById(id);

const canvas = $('scene');
const scene = new RadarScene(canvas);

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

function updateStats(volume, info) {
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

function applyVolume(volume) {
  const info = scene.setVolume(volume);
  updateStats(volume, info);
}

// Initial demo
applyVolume(buildSyntheticVolume({ seed: Math.floor(Math.random() * 1000) }));

// ------- Controls -------

$('threshold').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  $('threshold-value').textContent = String(v);
  const info = scene.setOption('threshold', v);
  if (info) updateStats(scene.volume, info);
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

$('stride').addEventListener('input', (e) => {
  const v = parseInt(e.target.value, 10);
  $('stride-value').textContent = String(v);
  const info = scene.setOption('stride', v);
  if (info) updateStats(scene.volume, info);
});

$('show-ground').addEventListener('change', (e) => scene.setShowGround(e.target.checked));
$('show-rings').addEventListener('change', (e) => scene.setShowRings(e.target.checked));
$('auto-rotate').addEventListener('change', (e) => scene.setAutoRotate(e.target.checked));

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

// Drag-and-drop on the whole window
['dragover', 'drop'].forEach((evt) => {
  window.addEventListener(evt, (e) => { e.preventDefault(); });
});
window.addEventListener('drop', async (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  $('file-input').files = e.dataTransfer.files;
  $('file-input').dispatchEvent(new Event('change'));
});
