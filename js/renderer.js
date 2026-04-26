import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { dbzToColor } from './colormap.js';
import { beamHeightKm, lonLatToEnuKm } from './geo.js';
import { createOsmGround } from './osm-ground.js';

// World units = kilometers. Scene Y is up. East = +X, North = -Z.

export class RadarScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true, powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x04101f, 0.0014);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 6000);
    this.camera.position.set(180, 90, 180);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxDistance = 2500;
    this.controls.minDistance = 10;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 0.5);
    sun.position.set(200, 400, 200);
    this.scene.add(sun);

    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.ground = this._makeGround(460, 46);
    this.ground.visible = false;
    this.world.add(this.ground);
    this.basemap = new THREE.Group();
    this.basemap.visible = true;
    this.world.add(this.basemap);
    this.rings = this._makeRangeRings([50, 100, 150, 200]);
    this.world.add(this.rings);
    this.compass = this._makeCompass(240);
    this.world.add(this.compass);
    this.markers = new THREE.Group();
    this.world.add(this.markers);
    this._showBasemap = true;
    this._basemapAttribution = null;

    this.points = null;
    this.mode = null;          // 'volume' | 'mosaic'
    this.lastVolume = null;
    this.lastMosaic = null;
    this.options = {
      threshold: 15,
      verticalExaggeration: 4,
      pointSize: 2.0,
      stride: 2,
    };

    window.addEventListener('resize', () => this._resize());
    this._resize();
    this._animate();
  }

  setAutoRotate(enabled) {
    this.controls.autoRotate = enabled;
    this.controls.autoRotateSpeed = 0.6;
  }
  setShowGround(v) { this.ground.visible = v; }
  setShowRings(v) { this.rings.visible = v; this.compass.visible = v; }
  setShowBasemap(v) {
    this._showBasemap = v;
    this.basemap.visible = v;
  }
  getBasemapAttribution() { return this._basemapAttribution; }

  setOption(key, value) {
    this.options[key] = value;
    if (key === 'threshold' || key === 'stride') {
      if (this.mode === 'volume' && this.lastVolume) return this.setVolume(this.lastVolume);
      if (this.mode === 'mosaic' && this.lastMosaic) return this.setMosaic(this.lastMosaic);
    } else if (key === 'verticalExaggeration') {
      this.world.scale.y = value;
    } else if (key === 'pointSize') {
      if (this.points) this.points.material.size = value;
    }
    return null;
  }

  // --- Single-radar volume rendering -------------------------------------

  setVolume(volume) {
    this.mode = 'volume';
    this.lastVolume = volume;
    this.lastMosaic = null;
    this._clearPoints();
    this._clearMarkers();
    this._resizeDecorations(230);
    if (Number.isFinite(volume?.lat) && Number.isFinite(volume?.lon)) {
      this._setBasemap(volume.lat, volume.lon, 230);
    } else {
      this._clearBasemap();
    }

    const { threshold, stride } = this.options;
    const positions = [];
    const colors = [];
    let maxDbz = -Infinity;

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
          if (!Number.isFinite(dbz) || dbz < threshold) continue;
          const slantKm = (firstGateM + g * gateSpacingM) / 1000;
          if (slantKm > 230) continue;
          const groundKm = slantKm * cosE;
          const heightKm = beamHeightKm(slantKm, elevRad);
          positions.push(sinA * groundKm, heightKm, -cosA * groundKm);
          const c = dbzToColor(dbz);
          colors.push(c[0], c[1], c[2]);
          if (dbz > maxDbz) maxDbz = dbz;
        }
      }
    }

    this._installPoints(positions, colors);
    return { pointCount: positions.length / 3, maxDbz: Number.isFinite(maxDbz) ? maxDbz : null };
  }

  // --- Multi-radar mosaic rendering --------------------------------------

  setMosaic(mosaic) {
    this.mode = 'mosaic';
    this.lastMosaic = mosaic;
    this.lastVolume = null;
    this._clearPoints();
    this._clearMarkers();

    const radius = Math.max(120, mosaic.radiusKm || 250);
    this._resizeDecorations(radius);
    if (mosaic.center && Number.isFinite(mosaic.center.lat) && Number.isFinite(mosaic.center.lon)) {
      this._setBasemap(mosaic.center.lat, mosaic.center.lon, radius);
    } else {
      this._clearBasemap();
    }

    const { threshold } = this.options;
    const positions = [];
    const colors = [];
    let maxDbz = -Infinity;

    for (const p of mosaic.points) {
      if (p.dbz < threshold) continue;
      // ENU (e=east, n=north, u=up) -> world (x=east, y=up, z=-north)
      positions.push(p.x, p.z, -p.y);
      const c = dbzToColor(p.dbz);
      colors.push(c[0], c[1], c[2]);
      if (p.dbz > maxDbz) maxDbz = p.dbz;
    }

    this._installPoints(positions, colors);

    // Center marker (the click point)
    this.markers.add(this._makeCenterMarker());

    // Station markers (offset from mosaic center in ENU km)
    const center = mosaic.center;
    for (const entry of (mosaic.stations || [])) {
      const s = entry.station || entry;
      const off = lonLatToEnuKm(s.lat, s.lon, s.elev || 0, center.lat, center.lon, center.elev || 0);
      this.markers.add(this._makeStationMarker(s, off));
    }

    return {
      pointCount: positions.length / 3,
      maxDbz: Number.isFinite(maxDbz) ? maxDbz : null,
    };
  }

  // --- Internals ---------------------------------------------------------

  _installPoints(positions, colors) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size: this.options.pointSize,
      vertexColors: true,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    this.points = new THREE.Points(geom, mat);
    this.world.add(this.points);
    this.world.scale.y = this.options.verticalExaggeration;
  }

  _clearPoints() {
    if (!this.points) return;
    this.world.remove(this.points);
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.points = null;
  }

  _clearMarkers() {
    while (this.markers.children.length) {
      const m = this.markers.children.pop();
      m.traverse?.((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    }
  }

  _clearBasemap() {
    while (this.basemap.children.length) {
      const m = this.basemap.children.pop();
      m.traverse?.((o) => {
        o.geometry?.dispose?.();
        if (o.material) {
          o.material.map?.dispose?.();
          o.material.dispose?.();
        }
      });
    }
    this._basemapAttribution = null;
    this._basemapSig = null;
  }

  _setBasemap(lat, lon, radiusKm) {
    const sig = `${lat.toFixed(4)}|${lon.toFixed(4)}|${Math.round(radiusKm)}`;
    if (this._basemapSig === sig) {
      this.basemap.visible = this._showBasemap;
      return;
    }
    this._clearBasemap();
    const { group, attribution } = createOsmGround(lat, lon, radiusKm);
    this.basemap.add(group);
    this.basemap.visible = this._showBasemap;
    this._basemapAttribution = attribution;
    this._basemapSig = sig;
  }

  _resizeDecorations(radiusKm) {
    // Replace ground / rings / compass for the current scale.
    const groundVisible = this.ground.visible;
    const ringsVisible = this.rings.visible;
    [this.ground, this.rings, this.compass].forEach(g => this.world.remove(g));
    [this.ground, this.rings, this.compass].forEach(g =>
      g.traverse?.(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); })
    );
    const size = Math.ceil(radiusKm * 2 / 50) * 50;
    const div = Math.min(60, Math.max(20, Math.round(size / 20)));
    const ringSpacing = radiusKm > 250 ? 100 : 50;
    const rings = [];
    for (let r = ringSpacing; r <= radiusKm; r += ringSpacing) rings.push(r);
    this.ground = this._makeGround(size, div);
    this.rings = this._makeRangeRings(rings);
    this.compass = this._makeCompass(radiusKm + 20);
    this.ground.visible = groundVisible;
    this.rings.visible = ringsVisible;
    this.compass.visible = ringsVisible;
    this.world.add(this.ground);
    this.world.add(this.rings);
    this.world.add(this.compass);
  }

  _makeGround(size, div) {
    const group = new THREE.Group();
    const grid = new THREE.GridHelper(size, div, 0x1a4a6e, 0x0a2438);
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    group.add(grid);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(size / 2, 96),
      new THREE.MeshBasicMaterial({ color: 0x051a2e, transparent: true, opacity: 0.55 })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -0.05;
    group.add(disc);
    return group;
  }

  _makeRangeRings(radii) {
    const group = new THREE.Group();
    for (const r of radii) {
      const geo = new THREE.RingGeometry(r - 0.3, r + 0.3, 128);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x00d4ff, transparent: true, opacity: 0.30, side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(geo, mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      group.add(ring);
    }
    return group;
  }

  _makeCompass(reach) {
    const group = new THREE.Group();
    const arrow = (dir, color) => {
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 });
      const pts = [new THREE.Vector3(0, 0.05, 0), dir.clone().multiplyScalar(reach)];
      pts[1].y = 0.05;
      return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
    };
    group.add(arrow(new THREE.Vector3(0, 0, -1), 0x00d4ff));
    group.add(arrow(new THREE.Vector3(0, 0, 1), 0x224a66));
    group.add(arrow(new THREE.Vector3(1, 0, 0), 0x224a66));
    group.add(arrow(new THREE.Vector3(-1, 0, 0), 0x224a66));
    return group;
  }

  _makeCenterMarker() {
    const g = new THREE.Group();
    const beacon = new THREE.Mesh(
      new THREE.ConeGeometry(2, 6, 16),
      new THREE.MeshBasicMaterial({ color: 0x4cffd5, transparent: true, opacity: 0.85 })
    );
    beacon.position.y = 3;
    g.add(beacon);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3, 4, 32),
      new THREE.MeshBasicMaterial({ color: 0x4cffd5, transparent: true, opacity: 0.6, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    g.add(ring);
    return g;
  }

  _makeStationMarker(station, enu) {
    // ENU east -> world +X, north -> world -Z, up -> world +Y.
    const g = new THREE.Group();
    g.position.set(enu.e, enu.u, -enu.n);
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd86b })
    );
    g.add(dot);
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 6, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd86b, transparent: true, opacity: 0.55 })
    );
    stem.position.y = 3;
    g.add(stem);
    return g;
  }

  _resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
