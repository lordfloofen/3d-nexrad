// Generate a synthetic NEXRAD-like volume scan.
// Produces a Volume object compatible with the renderer:
//   {
//     station: string,
//     lat, lon, elevMeters,
//     timestamp: Date,
//     tilts: [{ elevationDeg, azimuthsDeg: Float32Array,
//               gateSpacingM, firstGateM, gates: number,
//               reflectivity: Float32Array (azimuths * gates), missingValue }]
//   }

const TILT_ELEVATIONS = [
  0.5, 0.9, 1.3, 1.8, 2.4, 3.1, 4.0, 5.1, 6.4, 8.0, 10.0, 12.5, 15.6, 19.5,
];

function rng(seed) {
  // mulberry32
  let t = seed >>> 0;
  return function () {
    t |= 0; t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// Storm cell: (range km, azimuth deg, top km, intensity dBZ, horiz radius km, vert radius km)
function defaultCells(rand) {
  const n = 4 + Math.floor(rand() * 3);
  const cells = [];
  for (let i = 0; i < n; i++) {
    const az = rand() * 360;
    const range = 25 + rand() * 90;
    const top = 8 + rand() * 8;          // 8–16 km tops
    const intensity = 50 + rand() * 18;  // 50–68 dBZ peak
    const rH = 4 + rand() * 7;
    const rV = 2 + rand() * 3;
    cells.push({ az, range, top, intensity, rH, rV, anvilDir: rand() * 360 });
  }
  return cells;
}

function reflectivityAt(xKm, yKm, zKm, cells, rand) {
  let dbz = -32; // background
  for (const cell of cells) {
    const azRad = cell.az * Math.PI / 180;
    const cx = Math.sin(azRad) * cell.range;
    const cy = Math.cos(azRad) * cell.range;
    const cz = cell.top * 0.45; // mid-level peak

    const dx = xKm - cx;
    const dy = yKm - cy;
    const dz = zKm - cz;

    // Anisotropic gaussian core
    const r2 = (dx * dx + dy * dy) / (cell.rH * cell.rH) + (dz * dz) / (cell.rV * cell.rV);
    const core = cell.intensity * Math.exp(-r2 * 0.9);

    // Anvil: spreads horizontally near echo top, downwind
    const anvilZ = cell.top * 0.85;
    const azA = cell.anvilDir * Math.PI / 180;
    const ax = Math.sin(azA);
    const ay = Math.cos(azA);
    const downwind = (xKm - cx) * ax + (yKm - cy) * ay;
    const cross = -(xKm - cx) * ay + (yKm - cy) * ax;
    const anvilR2 =
      (downwind > 0 ? Math.pow(downwind / (cell.rH * 2.2), 2) : Math.pow(downwind / (cell.rH * 0.6), 2))
      + Math.pow(cross / (cell.rH * 1.4), 2)
      + Math.pow((zKm - anvilZ) / (cell.rV * 0.6), 2);
    const anvil = (cell.intensity * 0.55) * Math.exp(-anvilR2);

    const contrib = Math.max(core, anvil);
    if (contrib > dbz) dbz = contrib;
  }

  // Stratiform rain background near surface
  if (zKm < 4) {
    const strat = 12 + 6 * Math.sin(xKm * 0.07) * Math.cos(yKm * 0.05);
    if (strat > dbz) dbz = strat;
  }
  // Add a touch of texture
  dbz += (rand() - 0.5) * 4;
  return dbz;
}

export function buildSyntheticVolume({
  station = 'DEMO',
  lat = 35.3331,
  lon = -97.2778,
  elevMeters = 370,
  azimuths = 360,
  gates = 460,
  gateSpacingM = 250,
  firstGateM = 2125,
  seed = 7,
} = {}) {
  const rand = rng(seed);
  const cells = defaultCells(rand);

  const tilts = TILT_ELEVATIONS.map((elevationDeg) => {
    const elevRad = elevationDeg * Math.PI / 180;
    const azArr = new Float32Array(azimuths);
    const refl = new Float32Array(azimuths * gates);
    for (let a = 0; a < azimuths; a++) {
      azArr[a] = a; // 1° spacing
      const azRad = a * Math.PI / 180;
      const sinA = Math.sin(azRad);
      const cosA = Math.cos(azRad);
      for (let g = 0; g < gates; g++) {
        const slant = (firstGateM + g * gateSpacingM) / 1000;
        // Approximate beam height with 4/3 earth radius assumption
        const Re = 6371 * 4 / 3;
        const h = Math.sqrt(slant * slant + Re * Re + 2 * slant * Re * Math.sin(elevRad)) - Re;
        const ground = slant * Math.cos(elevRad);
        const x = sinA * ground;
        const y = cosA * ground;
        const z = h;
        let dbz = reflectivityAt(x, y, z, cells, rand);
        // Beam broadening loss at far ranges, mild
        dbz -= Math.max(0, (slant - 60)) * 0.05;
        if (dbz < -30) dbz = NaN;
        refl[a * gates + g] = dbz;
      }
    }
    return {
      elevationDeg,
      azimuthsDeg: azArr,
      gateSpacingM,
      firstGateM,
      gates,
      reflectivity: refl,
      missingValue: NaN,
    };
  });

  return {
    station,
    lat,
    lon,
    elevMeters,
    timestamp: new Date(),
    synthetic: true,
    tilts,
  };
}
