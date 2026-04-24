import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { dbzToColor } from './colormap.js';

// World units = kilometers. Scene Y is up.

const EARTH_R_KM = 6371 * 4 / 3; // 4/3-earth approximation for beam path

function beamHeightKm(slantKm, elevationRad) {
  return Math.sqrt(
    slantKm * slantKm +
    EARTH_R_KM * EARTH_R_KM +
    2 * slantKm * EARTH_R_KM * Math.sin(elevationRad)
  ) - EARTH_R_KM;
}

export class RadarScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true, powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x04101f, 0.0018);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 4000);
    this.camera.position.set(180, 90, 180);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxDistance = 1500;
    this.controls.minDistance = 10;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 0.5);
    sun.position.set(200, 400, 200);
    this.scene.add(sun);

    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.ground = this._makeGround();
    this.world.add(this.ground);
    this.rings = this._makeRangeRings();
    this.world.add(this.rings);
    this.compass = this._makeCompass();
    this.world.add(this.compass);

    this.points = null;
    this.volume = null;
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

  setOption(key, value) {
    this.options[key] = value;
    if (key === 'threshold' || key === 'stride') {
      if (this.volume) return this.setVolume(this.volume);
    } else if (key === 'verticalExaggeration') {
      this.world.scale.y = value;
    } else if (key === 'pointSize') {
      if (this.points) this.points.material.size = value;
    }
    return null;
  }

  // Returns { pointCount, maxDbz }
  setVolume(volume) {
    this.volume = volume;

    if (this.points) {
      this.world.remove(this.points);
      this.points.geometry.dispose();
      this.points.material.dispose();
      this.points = null;
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
        const rowOffset = a * gates;
        for (let g = 0; g < gates; g += stride) {
          const dbz = reflectivity[rowOffset + g];
          if (!Number.isFinite(dbz)) continue;
          if (dbz < threshold) continue;
          const slantKm = (firstGateM + g * gateSpacingM) / 1000;
          if (slantKm > 230) continue; // unambiguous range cutoff
          const groundKm = slantKm * cosE;
          const heightKm = beamHeightKm(slantKm, elevRad);
          const x = sinA * groundKm;
          const z = -cosA * groundKm; // azimuth 0 = north => -Z so visually "up the screen"
          const y = heightKm;
          positions.push(x, y, z);
          const c = dbzToColor(dbz);
          colors.push(c[0], c[1], c[2]);
          if (dbz > maxDbz) maxDbz = dbz;
        }
      }
    }

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

    return { pointCount: positions.length / 3, maxDbz: Number.isFinite(maxDbz) ? maxDbz : null };
  }

  _makeGround() {
    const group = new THREE.Group();
    const size = 460;
    const div = 46;
    const grid = new THREE.GridHelper(size, div, 0x1a4a6e, 0x0a2438);
    grid.position.y = 0;
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    group.add(grid);

    // Subtle disc to suggest ground
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(230, 96),
      new THREE.MeshBasicMaterial({ color: 0x051a2e, transparent: true, opacity: 0.55 })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -0.05;
    group.add(disc);
    return group;
  }

  _makeRangeRings() {
    const group = new THREE.Group();
    for (let r = 50; r <= 230; r += 50) {
      const geo = new THREE.RingGeometry(r - 0.25, r + 0.25, 128);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x00d4ff, transparent: true, opacity: 0.32, side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(geo, mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      group.add(ring);
    }
    return group;
  }

  _makeCompass() {
    const group = new THREE.Group();
    const arrow = (dir, color) => {
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 });
      const pts = [new THREE.Vector3(0, 0.05, 0), dir.clone().multiplyScalar(240)];
      pts[1].y = 0.05;
      return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
    };
    group.add(arrow(new THREE.Vector3(0, 0, -1), 0x00d4ff)); // N
    group.add(arrow(new THREE.Vector3(0, 0, 1), 0x224a66));
    group.add(arrow(new THREE.Vector3(1, 0, 0), 0x224a66));
    group.add(arrow(new THREE.Vector3(-1, 0, 0), 0x224a66));
    return group;
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
