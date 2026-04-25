// Small geographic helpers. Tangent-plane (ENU) approximations are accurate
// enough for the ~250 km mosaic radius we care about.

const R_EARTH_KM = 6371.0;

export function deg2rad(d) { return d * Math.PI / 180; }

export function haversineKm(lat1, lon1, lat2, lon2) {
  const φ1 = deg2rad(lat1), φ2 = deg2rad(lat2);
  const dφ = deg2rad(lat2 - lat1);
  const dλ = deg2rad(lon2 - lon1);
  const a = Math.sin(dφ / 2) ** 2 +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.sqrt(a));
}

// Local ENU offset of (lat, lon, elevM) relative to (lat0, lon0, elev0M),
// returned in kilometers as { e, n, u }.
export function lonLatToEnuKm(lat, lon, elevM, lat0, lon0, elev0M) {
  const φ0 = deg2rad(lat0);
  const e = deg2rad(lon - lon0) * R_EARTH_KM * Math.cos(φ0);
  const n = deg2rad(lat - lat0) * R_EARTH_KM;
  const u = ((elevM ?? 0) - (elev0M ?? 0)) / 1000;
  return { e, n, u };
}

// 4/3-earth beam height for a given slant range (km) and elevation angle (rad).
const R_EFFECTIVE_KM = R_EARTH_KM * 4 / 3;
export function beamHeightKm(slantKm, elevationRad) {
  return Math.sqrt(
    slantKm * slantKm +
    R_EFFECTIVE_KM * R_EFFECTIVE_KM +
    2 * slantKm * R_EFFECTIVE_KM * Math.sin(elevationRad)
  ) - R_EFFECTIVE_KM;
}
