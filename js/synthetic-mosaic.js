// Synthetic multi-radar scene for validating (and demoing) dual-Doppler wind
// synthesis. Several virtual radars all sample the SAME analytic wind field, so
// a correct synthesis must recover that field — and the vorticity must peak at
// the prescribed vortex. Being analytic, the scene is free of velocity aliasing,
// which is the main thing that corrupts real-data retrievals.

import { lonLatToEnuKm, beamHeightKm } from './geo.js';

const TILT_ELEVATIONS = [0.5, 0.9, 1.3, 1.8, 2.4, 3.1, 4.0];

// Shared field, defined in mosaic-centred ENU kilometres. A uniform base flow
// plus a cyclonic Rankine vortex (solid-body core, potential flow outside).
function makeField({ baseU = 8, baseV = 4, vortexE = 0, vortexN = 0, vmax = 25, rmKm = 3 } = {}) {
  return function field(eKm, nKm /*, uKm */) {
    const dx = eKm - vortexE;
    const dy = nKm - vortexN;
    const r = Math.hypot(dx, dy);
    let u = baseU, v = baseV;
    if (r > 1e-3) {
      const vt = r <= rmKm ? vmax * (r / rmKm) : vmax * (rmKm / r); // tangential (m/s)
      // counterclockwise (cyclonic, N. hemisphere): tangential dir = (-dy, dx)/r
      u += vt * (-dy / r);
      v += vt * (dx / r);
    }
    return { u, v };
  };
}

// Reflectivity blob centred on the vortex so the REF composite and the velocity
// coverage line up roughly with a "storm".
function reflectivityAt(eKm, nKm, vortexE, vortexN) {
  const r = Math.hypot(eKm - vortexE, nKm - vortexN);
  const dbz = 50 * Math.exp(-(r * r) / (2 * 9 * 9)); // ~9 km wide core
  return dbz < 8 ? NaN : dbz;
}

// Sample the shared field with one virtual radar, producing a parsed-volume-like
// object (tilts carrying REF + VEL moments) compatible with the renderer and the
// dual-Doppler ingest.
function buildRadarVolume(station, center, field, vortex, opts) {
  const azimuths = opts.azimuths ?? 360;
  const gates = opts.gates ?? 600;
  const gateSpacingM = opts.gateSpacingM ?? 250;
  const firstGateM = opts.firstGateM ?? 2125;
  const echoRadiusKm = opts.echoRadiusKm ?? 70;

  const { e: e0, n: n0, u: u0 } = lonLatToEnuKm(
    station.lat, station.lon, station.elev, center.lat, center.lon, center.elev ?? 0
  );

  const tilts = TILT_ELEVATIONS.map((elevationDeg) => {
    const elevRad = elevationDeg * Math.PI / 180;
    const cosE = Math.cos(elevRad);
    const az = new Float32Array(azimuths);
    const refl = new Float32Array(azimuths * gates);
    const vel = new Float32Array(azimuths * gates);
    for (let ai = 0; ai < azimuths; ai++) {
      az[ai] = ai;
      const azRad = ai * Math.PI / 180;
      const sinA = Math.sin(azRad);
      const cosA = Math.cos(azRad);
      for (let g = 0; g < gates; g++) {
        const slantKm = (firstGateM + g * gateSpacingM) / 1000;
        const groundKm = slantKm * cosE;
        const heightKm = beamHeightKm(slantKm, elevRad);
        const dx = sinA * groundKm, dy = cosA * groundKm, dz = heightKm;
        const e = e0 + dx, n = n0 + dy;
        const idx = ai * gates + g;
        const dbz = reflectivityAt(e, n, vortex.e, vortex.n);
        const inEcho = Math.hypot(e - vortex.e, n - vortex.n) <= echoRadiusKm && Number.isFinite(dbz);
        refl[idx] = inEcho ? dbz : NaN;
        if (inEcho) {
          const L = Math.hypot(dx, dy, dz) || 1;
          const a = dx / L, b = dy / L; // (c = dz/L ~ 0 at low tilts; field has no w)
          const { u, v } = field(e, n, u0 + heightKm);
          vel[idx] = a * u + b * v; // radial velocity, + = away from radar
        } else {
          vel[idx] = NaN;
        }
      }
    }
    return {
      elevationDeg,
      azimuthsDeg: az,
      gateSpacingM, firstGateM, gates,
      reflectivity: refl,
      missingValue: NaN,
      moments: {
        REF: { gates, gateSpacingM, firstGateM, data: refl },
        VEL: { gates, gateSpacingM, firstGateM, data: vel },
      },
    };
  });

  return {
    station: station.id,
    lat: station.lat, lon: station.lon, elevMeters: station.elev,
    timestamp: new Date(),
    synthetic: true,
    tilts,
  };
}

// Build a complete synthetic mosaic (a couple of radars surrounding a vortex)
// ready for revoxelizeMosaic (REF) and buildRotationField (VEL).
export function buildSyntheticMosaic(opts = {}) {
  const center = opts.center || { lat: 35.0, lon: -97.5, elev: 350 };
  const vortex = opts.vortex || { e: 0, n: 0 };
  const vmax = opts.vmax ?? 25, rmKm = opts.rmKm ?? 3;
  // Storm motion (m/s east/north) and per-radar scan-time spread (s). With
  // motion, each radar sees the vortex at its own scan time, displaced along the
  // motion vector — exactly the situation advection correction is meant to undo.
  const motion = opts.motion || { u: 0, v: 0 };
  const spreadSec = opts.spreadSec ?? 60;

  // Three virtual radars ~45 km from centre on different bearings, so the
  // vortex sits well inside the dual-Doppler lobes of every pair.
  const defaults = [
    { id: 'SYN1', name: 'Synthetic radar 1', lat: 34.70, lon: -97.95, elev: 350, type: 'wsr88d' },
    { id: 'SYN2', name: 'Synthetic radar 2', lat: 34.70, lon: -97.05, elev: 350, type: 'wsr88d' },
    { id: 'SYN3', name: 'Synthetic radar 3', lat: 35.45, lon: -97.50, elev: 350, type: 'wsr88d' },
  ];
  const stationDefs = opts.stations || defaults;

  const now = Date.now(); // reference time the vortex sits at `vortex`
  const stations = stationDefs.map((s, i) => {
    const timeMs = now - i * spreadSec * 1000;
    const dtSec = (timeMs - now) / 1000; // <= 0 for earlier scans
    // Where this radar actually sees the vortex, given the storm's motion.
    const vp = { e: vortex.e + motion.u * dtSec / 1000, n: vortex.n + motion.v * dtSec / 1000 };
    const field = makeField({ vortexE: vp.e, vortexN: vp.n, vmax, rmKm });
    return {
      station: s,
      time: new Date(timeMs),
      key: `${s.id}/synthetic`,
      volume: buildRadarVolume(s, center, field, vp, opts),
    };
  });

  return {
    center,
    targetTime: new Date(now),
    radiusKm: opts.radiusKm ?? 120,
    stations,
    skipped: [],
    voxelSize: opts.voxelSize || { x: 2, y: 2, z: 1 },
    points: [],
    stride: opts.stride ?? 2,
    minDbz: opts.minDbz ?? 5,
    synthetic: true,
  };
}
