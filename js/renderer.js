import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { dbzToColor, velToColor, vortToColor } from './colormap.js';
import { tiltMoment } from './nexrad.js';
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
    this.product = 'REF';      // 'REF' | 'VEL' (single-radar volumes only)
    this.mosaicProduct = 'REF';// 'REF' | 'ROT' (multi-radar mosaics)
    this.lastVolume = null;
    this.lastMosaic = null;
    this.lastVelMax = null;    // velocity scale used by the last VEL render
    this.lastVortMax = null;   // vorticity scale used by the last ROT render
    this.options = {
      threshold: 15,           // REF: minimum dBZ to draw
      velMin: 0,               // VEL: minimum |velocity| (m/s) to draw
      vortMinShow: 0,          // ROT: minimum |vorticity| to draw, in 10⁻³ s⁻¹
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

  // The product actually displayed: single-radar volumes use `product`
  // (REF/VEL); mosaics use `mosaicProduct` (REF reflectivity composite, or ROT
  // dual-Doppler rotation).
  effectiveProduct() { return this.mode === 'mosaic' ? this.mosaicProduct : this.product; }

  setProduct(product) {
    this.product = product;
    if (this.mode === 'volume' && this.lastVolume) return this.setVolume(this.lastVolume);
    return null;
  }

  setMosaicProduct(product) {
    this.mosaicProduct = product;
    if (this.mode === 'mosaic' && this.lastMosaic) return this.setMosaic(this.lastMosaic);
    return null;
  }

  setOption(key, value) {
    this.options[key] = value;
    if (key === 'threshold' || key === 'stride') {
      if (this.mode === 'volume' && this.lastVolume) return this.setVolume(this.lastVolume);
      if (this.mode === 'mosaic' && this.lastMosaic) return this.setMosaic(this.lastMosaic);
    } else if (key === 'velMin') {
      // Velocity filtering only applies to single-radar volumes.
      if (this.mode === 'volume' && this.lastVolume) return this.setVolume(this.lastVolume);
    } else if (key === 'vortMinShow') {
      // Rotation display filter only applies to mosaics.
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

    const isVel = this.product === 'VEL';
    const moment = isVel ? 'VEL' : 'REF';
    const { threshold, velMin, stride } = this.options;

    // Velocity uses a symmetric, data-fit color domain so the diverging scale
    // spans the actual inbound/outbound extremes. Reflectivity uses its fixed
    // dBZ scale, so no pre-pass is needed.
    let vmax = 0;
    if (isVel) {
      for (const tilt of volume.tilts) {
        const m = tiltMoment(tilt, 'VEL');
        if (!m) continue;
        const d = m.data;
        for (let i = 0; i < d.length; i++) {
          const v = d[i];
          if (Number.isFinite(v)) { const a = Math.abs(v); if (a > vmax) vmax = a; }
        }
      }
      vmax = Math.min(60, Math.max(20, Math.ceil(vmax / 5) * 5));
    }
    this.lastVelMax = isVel ? vmax : null;

    const positions = [];
    const colors = [];
    let peak = -Infinity;

    for (const tilt of volume.tilts) {
      const m = tiltMoment(tilt, moment);
      if (!m) continue; // e.g. a velocity-only or reflectivity-only split cut
      const elevRad = tilt.elevationDeg * Math.PI / 180;
      const cosE = Math.cos(elevRad);
      const { gates, gateSpacingM, firstGateM, data } = m;
      const { azimuthsDeg } = tilt;
      const azCount = azimuthsDeg.length;
      for (let a = 0; a < azCount; a++) {
        const az = azimuthsDeg[a];
        if (!Number.isFinite(az)) continue;
        const azRad = az * Math.PI / 180;
        const sinA = Math.sin(azRad);
        const cosA = Math.cos(azRad);
        const rowOff = a * gates;
        for (let g = 0; g < gates; g += stride) {
          const val = data[rowOff + g];
          if (!Number.isFinite(val)) continue;
          if (isVel) { if (Math.abs(val) < velMin) continue; }
          else if (val < threshold) continue;
          const slantKm = (firstGateM + g * gateSpacingM) / 1000;
          if (slantKm > 230) continue;
          const groundKm = slantKm * cosE;
          const heightKm = beamHeightKm(slantKm, elevRad);
          positions.push(sinA * groundKm, heightKm, -cosA * groundKm);
          const c = isVel ? velToColor(val, vmax) : dbzToColor(val);
          colors.push(c[0], c[1], c[2]);
          const mag = isVel ? Math.abs(val) : val;
          if (mag > peak) peak = mag;
        }
      }
    }

    this._installPoints(positions, colors);
    return {
      pointCount: positions.length / 3,
      product: this.product,
      isVel,
      units: isVel ? 'm/s' : 'dBZ',
      peak: Number.isFinite(peak) ? peak : null,
      maxDbz: isVel ? null : (Number.isFinite(peak) ? peak : null),
      velMax: isVel ? vmax : null,
    };
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

    const info = (this.mosaicProduct === 'ROT' && mosaic.rotation)
      ? this._renderRotation(mosaic)
      : this._renderReflectivityMosaic(mosaic);

    // Center marker (the click point)
    this.markers.add(this._makeCenterMarker());

    // Station markers (offset from mosaic center in ENU km)
    const center = mosaic.center;
    for (const entry of (mosaic.stations || [])) {
      const s = entry.station || entry;
      const off = lonLatToEnuKm(s.lat, s.lon, s.elev || 0, center.lat, center.lon, center.elev || 0);
      this.markers.add(this._makeStationMarker(s, off));
    }

    return info;
  }

  _renderReflectivityMosaic(mosaic) {
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
    return {
      pointCount: positions.length / 3,
      product: 'REF',
      isVel: false,
      units: 'dBZ',
      peak: Number.isFinite(maxDbz) ? maxDbz : null,
      maxDbz: Number.isFinite(maxDbz) ? maxDbz : null,
    };
  }

  // Render the dual-Doppler rotation field: each cell colored by vertical
  // vorticity, with markers on detected rotation cores.
  _renderRotation(mosaic) {
    const pts = mosaic.rotation.points || [];
    const cores = mosaic.rotation.cores || [];
    const minShow = (this.options.vortMinShow || 0) / 1000; // 10⁻³ s⁻¹ -> s⁻¹

    // Symmetric, data-fit color domain, clamped to a sane mesocyclone range.
    let vmax = 0;
    for (const p of pts) {
      if (Number.isFinite(p.vort)) { const a = Math.abs(p.vort); if (a > vmax) vmax = a; }
    }
    vmax = Math.min(0.04, Math.max(0.008, Math.ceil(vmax * 1000) / 1000));
    this.lastVortMax = vmax;

    const positions = [];
    const colors = [];
    let peak = 0;
    for (const p of pts) {
      if (!Number.isFinite(p.vort)) continue;
      if (Math.abs(p.vort) < minShow) continue;
      positions.push(p.x, p.z, -p.y);
      const c = vortToColor(p.vort, vmax);
      colors.push(c[0], c[1], c[2]);
      const a = Math.abs(p.vort);
      if (a > peak) peak = a;
    }
    this._installPoints(positions, colors);

    for (const core of cores) this.markers.add(this._makeRotationCore(core, vmax));

    return {
      pointCount: positions.length / 3,
      product: 'ROT',
      isVel: false,
      isRotation: true,
      units: 's⁻¹',
      peak: peak || null,
      maxDbz: null,
      vortMax: vmax,
      coreCount: cores.length,
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

  // Marker on a detected rotation core: a translucent vertical column at the
  // cell, tinted by the colormap so cyclonic/anticyclonic reads at a glance.
  _makeRotationCore(core, vmax) {
    const g = new THREE.Group();
    g.position.set(core.x, core.z, -core.y); // ENU -> world
    const c = vortToColor(core.vort, vmax);
    const color = new THREE.Color(c[0], c[1], c[2]);
    const column = new THREE.Mesh(
      new THREE.CylinderGeometry(1.2, 1.2, 10, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.45, side: THREE.DoubleSide,
      })
    );
    column.position.y = 5;
    g.add(column);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.4, 2.4, 32),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.06;
    g.add(ring);
    return g;
  }

  _makeStationMarker(station, enu) {
    // ENU east -> world +X, north -> world -Z, up -> world +Y. TDWR markers
    // are tinted cyan and slightly smaller so they can be told apart from
    // the yellow WSR-88D dots when both kinds contribute to a mosaic.
    const isTdwr = station?.type === 'tdwr';
    const color = isTdwr ? 0x7af0ff : 0xffd86b;
    const dotRadius = isTdwr ? 0.9 : 1.2;
    const g = new THREE.Group();
    g.position.set(enu.e, enu.u, -enu.n);
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(dotRadius, 12, 12),
      new THREE.MeshBasicMaterial({ color })
    );
    g.add(dot);
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 6, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 })
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
