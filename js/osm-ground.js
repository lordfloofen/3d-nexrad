// OSM-style basemap ground for the 3D scene.
//
// Loads slippy-map tiles from CARTO's "dark_all" basemap (which uses
// OpenStreetMap data) and lays them out as textured planes in the
// kilometer-based ENU world centered on a reference lat/lon.
//
// Each tile is its own quad whose corners come from the standard slippy-map
// (lat,lon) inverse, projected to local ENU. That keeps tile boundaries
// aligned without warping at our visualization scales (~250 km).

import * as THREE from 'three';
import { lonLatToEnuKm } from './geo.js';

const TILE_SUBDOMAINS = ['a', 'b', 'c', 'd'];
const TILE_TEMPLATE = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png';
const ATTRIBUTION = '© OpenStreetMap, © CARTO';

function lonLatToTile(lat, lon, z) {
  const latRad = lat * Math.PI / 180;
  const n = Math.pow(2, z);
  const x = ((lon + 180) / 360) * n;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y };
}

function tileToLonLat(x, y, z) {
  const n = Math.pow(2, z);
  const lon = x / n * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
  return { lat: latRad * 180 / Math.PI, lon };
}

function pickZoom(radiusKm) {
  // Choose a zoom so each tile is roughly 1/4 of the radius, which keeps
  // tile counts reasonable (a few dozen) while still showing detail.
  const targetTileKm = Math.max(20, radiusKm / 4);
  const equatorKm = 40075;
  const z = Math.round(Math.log2(equatorKm / targetTileKm));
  return Math.min(10, Math.max(4, z));
}

function loadTexture(loader, url) {
  return new Promise((resolve) => {
    loader.load(
      url,
      (tex) => resolve(tex),
      undefined,
      () => resolve(null),
    );
  });
}

// Build a Group containing tile quads covering ~radiusKm around (centerLat, centerLon).
// Returns { group, attribution } so the caller can show credit text.
export function createOsmGround(centerLat, centerLon, radiusKm, opts = {}) {
  const group = new THREE.Group();
  group.name = 'osm-ground';

  const zoom = opts.zoom ?? pickZoom(radiusKm);
  const opacity = opts.opacity ?? 0.9;
  const yOffset = opts.yOffset ?? -0.04;

  const n = Math.pow(2, zoom);
  const center = lonLatToTile(centerLat, centerLon, zoom);
  const cosLat = Math.cos(centerLat * Math.PI / 180);
  const tileKm = (40075 * cosLat) / n;
  const half = Math.ceil(radiusKm / tileKm) + 1;

  const minTx = Math.floor(center.x) - half;
  const maxTx = Math.floor(center.x) + half;
  const minTy = Math.max(0, Math.floor(center.y) - half);
  const maxTy = Math.min(n - 1, Math.floor(center.y) + half);

  const loader = new THREE.TextureLoader();
  loader.crossOrigin = 'anonymous';

  for (let tx = minTx; tx <= maxTx; tx++) {
    const wrappedTx = ((tx % n) + n) % n;
    for (let ty = minTy; ty <= maxTy; ty++) {
      const nw = tileToLonLat(tx, ty, zoom);
      const se = tileToLonLat(tx + 1, ty + 1, zoom);
      const nwEnu = lonLatToEnuKm(nw.lat, nw.lon, 0, centerLat, centerLon, 0);
      const seEnu = lonLatToEnuKm(se.lat, se.lon, 0, centerLat, centerLon, 0);

      const widthKm = seEnu.e - nwEnu.e;
      const heightKm = nwEnu.n - seEnu.n;
      if (widthKm <= 0 || heightKm <= 0) continue;

      // Skip tiles entirely outside the desired radius (rough cull).
      const cx = (nwEnu.e + seEnu.e) * 0.5;
      const cn = (nwEnu.n + seEnu.n) * 0.5;
      if (Math.hypot(cx, cn) > radiusKm + tileKm) continue;

      const sub = TILE_SUBDOMAINS[(Math.abs(tx) + Math.abs(ty)) % TILE_SUBDOMAINS.length];
      const url = TILE_TEMPLATE
        .replace('{s}', sub)
        .replace('{z}', String(zoom))
        .replace('{x}', String(wrappedTx))
        .replace('{y}', String(ty));

      // Placeholder material; texture is swapped in once loaded so we never
      // block scene construction on a slow tile.
      const mat = new THREE.MeshBasicMaterial({
        color: 0x07182a,
        transparent: true,
        opacity,
        depthWrite: false,
      });
      const geo = new THREE.PlaneGeometry(widthKm, heightKm);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      // World: x = east, z = -north.
      mesh.position.set(cx, yOffset, -cn);
      mesh.renderOrder = -1;
      group.add(mesh);

      loadTexture(loader, url).then((tex) => {
        if (!tex) return;
        if (!group.parent && !mesh.parent) { tex.dispose(); return; }
        if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        mat.map = tex;
        mat.color.set(0xffffff);
        mat.needsUpdate = true;
      });
    }
  }

  return { group, attribution: ATTRIBUTION, zoom };
}
