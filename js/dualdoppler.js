// Dual-Doppler (multi-radar) wind synthesis and rotation detection.
//
// A single radar measures only the radial component of the wind,
//   Vr = V · r̂ = u·a + v·b + w·c,
// where (a, b, c) is the unit vector from the radar to the gate. With two or
// more radars viewing the same point from different angles we get independent
// projections and can solve for the horizontal wind (u, v). Vertical velocity
// w is neglected — valid at low elevation angles where c ≈ 0 — and the small
// residual is absorbed by the least-squares fit.
//
// We accumulate the least-squares *normal equations* per grid cell (six running
// sums) rather than storing every sample, then solve a 2×2 system per cell:
//
//   [ Saa  Sab ] [u]   [ Sav ]
//   [ Sab  Sbb ] [v] = [ Sbv ]
//
// det = Saa·Sbb − Sab² collapses to zero when all contributing beams are
// parallel (a single radar, or the baseline between two radars), so it doubles
// as a geometry-quality gate. The normalized quality q = 2·√det / (Saa+Sbb)
// equals |sin β| for two equal-weight beams crossing at angle β, so q ≥ 0.5
// reproduces the classic 30°–150° dual-Doppler lobe criterion.
//
// Rotation is then the vertical vorticity ζ = ∂v/∂x − ∂u/∂y of the retrieved
// field, computed by central differences on the synthesis grid.

import { lonLatToEnuKm, beamHeightKm } from './geo.js';
import { tiltMoment } from './nexrad.js';

class DualDopplerGrid {
  constructor(sizeXkm = 2, sizeYkm = 2, sizeZkm = 1) {
    this.sx = sizeXkm; this.sy = sizeYkm; this.sz = sizeZkm;
    this.map = new Map(); // "ix|iy|iz" -> normal-equation accumulator
  }
  // a, b: horizontal components of the radar->gate unit vector.
  // vr: radial velocity (m/s, + = away). w: sample weight. bit: station bit.
  add(eKm, nKm, uKm, a, b, vr, weight, bit) {
    const ix = Math.floor(eKm / this.sx);
    const iy = Math.floor(nKm / this.sy);
    const iz = Math.floor(uKm / this.sz);
    const key = ix + '|' + iy + '|' + iz;
    let c = this.map.get(key);
    if (!c) {
      c = { Saa: 0, Sab: 0, Sbb: 0, Sav: 0, Sbv: 0, n: 0, mask: 0 };
      this.map.set(key, c);
    }
    c.Saa += weight * a * a;
    c.Sab += weight * a * b;
    c.Sbb += weight * b * b;
    c.Sav += weight * a * vr;
    c.Sbv += weight * b * vr;
    c.n++;
    c.mask |= bit;
  }
}

function popcount(x) {
  let n = 0;
  while (x) { x &= x - 1; n++; }
  return n;
}

// Project one parsed volume's velocity gates into the synthesis grid.
function ingestVelocity(grid, volume, station, center, bit, opts) {
  const { e: e0, n: n0, u: u0 } = lonLatToEnuKm(
    station.lat, station.lon, station.elev,
    center.lat, center.lon, center.elev ?? 0
  );
  const stride = opts.stride || 2;
  const maxRangeKm = opts.maxRangeKm ?? 230;
  const maxElevDeg = opts.maxElevDeg ?? 7; // low tilts only: keeps the neglected-w error small

  for (const tilt of volume.tilts) {
    if (tilt.elevationDeg > maxElevDeg) continue;
    const vel = tiltMoment(tilt, 'VEL');
    if (!vel) continue;
    const elevRad = tilt.elevationDeg * Math.PI / 180;
    const cosE = Math.cos(elevRad);
    // Down-weight higher tilts, where the neglected vertical-velocity term grows.
    const weight = Math.max(0.05, cosE * cosE);
    const { gates, gateSpacingM, firstGateM, data } = vel;
    const { azimuthsDeg } = tilt;
    const azCount = azimuthsDeg.length;
    for (let ai = 0; ai < azCount; ai++) {
      const az = azimuthsDeg[ai];
      if (!Number.isFinite(az)) continue;
      const azRad = az * Math.PI / 180;
      const sinA = Math.sin(azRad);
      const cosA = Math.cos(azRad);
      const rowOff = ai * gates;
      for (let g = 0; g < gates; g += stride) {
        const vr = data[rowOff + g];
        if (!Number.isFinite(vr)) continue;
        const slantKm = (firstGateM + g * gateSpacingM) / 1000;
        if (slantKm > maxRangeKm) continue;
        const groundKm = slantKm * cosE;
        const heightKm = beamHeightKm(slantKm, elevRad);
        // Displacement radar -> gate, in ENU km. Normalize for the beam unit vector.
        const dx = sinA * groundKm;
        const dy = cosA * groundKm;
        const dz = heightKm;
        const L = Math.hypot(dx, dy, dz) || 1;
        const a = dx / L, b = dy / L; // horizontal beam components (c = dz/L neglected)
        grid.add(e0 + dx, n0 + dy, u0 + heightKm, a, b, vr, weight, bit);
      }
    }
  }
}

// Solve every well-conditioned cell, then compute vorticity by central
// differences against same-height neighbours. Returns gridded wind/rotation.
function solveGrid(grid, opts) {
  const qMin = opts.qMin ?? 0.5;        // |sin β| >= 0.5  -> 30°–150° crossing
  const minStations = opts.minStations ?? 2;
  const { sx, sy, sz } = grid;

  // Pass 1: per-cell horizontal wind where geometry is good.
  const solved = new Map(); // "ix|iy|iz" -> { ix,iy,iz, u, v, quality }
  for (const [key, c] of grid.map) {
    if (popcount(c.mask) < minStations) continue;
    const tr = c.Saa + c.Sbb;
    if (tr <= 0) continue;
    const det = c.Saa * c.Sbb - c.Sab * c.Sab;
    if (det <= 0) continue;
    const quality = 2 * Math.sqrt(det) / tr; // 0 (parallel) .. 1 (orthogonal)
    if (quality < qMin) continue;
    const u = (c.Sbb * c.Sav - c.Sab * c.Sbv) / det;
    const v = (c.Saa * c.Sbv - c.Sab * c.Sav) / det;
    const [ix, iy, iz] = key.split('|').map(Number);
    solved.set(key, { ix, iy, iz, u, v, quality });
  }

  // Pass 2: central-difference vorticity, ζ = ∂v/∂x − ∂u/∂y (s⁻¹).
  const dxM = 2 * sx * 1000;
  const dyM = 2 * sy * 1000;
  const points = [];
  for (const cell of solved.values()) {
    const { ix, iy, iz } = cell;
    const xp = solved.get((ix + 1) + '|' + iy + '|' + iz);
    const xm = solved.get((ix - 1) + '|' + iy + '|' + iz);
    const yp = solved.get(ix + '|' + (iy + 1) + '|' + iz);
    const ym = solved.get(ix + '|' + (iy - 1) + '|' + iz);
    let vort = NaN;
    if (xp && xm && yp && ym) {
      vort = (xp.v - xm.v) / dxM - (yp.u - ym.u) / dyM;
    }
    points.push({
      x: (ix + 0.5) * sx,
      y: (iy + 0.5) * sy,
      z: (iz + 0.5) * sz,
      u: cell.u,
      v: cell.v,
      speed: Math.hypot(cell.u, cell.v),
      quality: cell.quality,
      vort,
    });
  }
  return { points, solved };
}

// Find rotation cores: candidate cells whose |ζ| exceeds the threshold, then
// non-maximum suppression so each rotation reports a single core. Strongest
// first.
function detectCores(points, opts) {
  const vortMin = opts.vortMin ?? 0.005; // s⁻¹ (mesocyclone-ish at km grid scales)
  const maxCores = opts.maxCores ?? 12;
  const candidates = points.filter(
    p => Number.isFinite(p.vort) && Math.abs(p.vort) >= vortMin
  );
  return nmsCores(candidates, maxCores);
}

// Non-maximum suppression over the candidate set using Euclidean distance in
// the ground plane: keep the strongest, drop anything within `radiusKm`.
function nmsCores(candidates, maxCores, radiusKm = 4) {
  const sorted = candidates.slice().sort((a, b) => Math.abs(b.vort) - Math.abs(a.vort));
  const cores = [];
  for (const p of sorted) {
    if (cores.length >= maxCores) break;
    let keep = true;
    for (const c of cores) {
      const d = Math.hypot(p.x - c.x, p.y - c.y, (p.z - c.z) * 2);
      if (d < radiusKm) { keep = false; break; }
    }
    if (keep) cores.push({ x: p.x, y: p.y, z: p.z, vort: p.vort, sign: Math.sign(p.vort), speed: p.speed });
  }
  return cores;
}

// Build the rotation field for a mosaic from its already-cached per-station
// volumes (the same ones the reflectivity composite uses — no refetch needed).
// Returns { points, cores, qc } and also stashes it on mosaic.rotation.
export function buildRotationField(mosaic, opts = {}) {
  const voxel = mosaic.voxelSize || { x: 2, y: 2, z: 1 };
  const grid = new DualDopplerGrid(voxel.x, voxel.y, Math.max(0.5, voxel.z));
  const entries = mosaic.stations || [];
  let withVel = 0;
  entries.forEach((entry, i) => {
    const volume = entry.volume;
    if (!volume) return;
    const hasVel = volume.tilts.some(t => tiltMoment(t, 'VEL'));
    if (!hasVel) return;
    withVel++;
    ingestVelocity(grid, volume, entry.station, mosaic.center, 1 << i, {
      stride: opts.stride ?? mosaic.stride ?? 2,
      maxRangeKm: opts.maxRangeKm,
      maxElevDeg: opts.maxElevDeg,
    });
  });

  const { points } = solveGrid(grid, opts);
  const cores = detectCores(points, opts);

  // Velocity from Level II is folded at ±Nyquist and we do not dealias yet, so
  // real-data retrievals can be corrupted (often inside strong rotation, where
  // it matters most). Synthetic scenes are alias-free.
  const qc = {
    radarsWithVelocity: withVel,
    aliasing: mosaic.synthetic
      ? null
      : 'Raw Level II velocity is not dealiased; folded gates can distort the retrieved winds and rotation.',
    timeSpreadMin: timeSpreadMinutes(entries),
  };

  mosaic.rotation = { points, cores, qc };
  return mosaic.rotation;
}

function timeSpreadMinutes(entries) {
  const ts = entries.map(e => e.time && e.time.getTime()).filter(Boolean);
  if (ts.length < 2) return 0;
  return (Math.max(...ts) - Math.min(...ts)) / 60000;
}
