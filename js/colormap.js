// Color scales for the Level II products we render.
//
// REF (reflectivity): the standard NWS dBZ scale.
// VEL (radial velocity): a colorblind-friendly diverging scale. The classic
//   green/red Doppler scheme is the worst case for the most common (red-green)
//   color-vision deficiencies, so we use ColorBrewer's RdBu diverging ramp
//   instead — it is flagged colorblind-safe and keeps the intuitive
//   cool = inbound / warm = outbound reading.

const STOPS = [
  { dbz: -30, c: [0.20, 0.20, 0.30] },
  { dbz:   5, c: [0.30, 0.30, 0.45] },
  { dbz:  10, c: [0.00, 0.93, 0.93] }, // cyan
  { dbz:  15, c: [0.00, 0.63, 0.96] }, // light blue
  { dbz:  20, c: [0.00, 0.00, 0.96] }, // blue
  { dbz:  25, c: [0.00, 0.93, 0.00] }, // green
  { dbz:  30, c: [0.00, 0.78, 0.00] },
  { dbz:  35, c: [0.00, 0.55, 0.00] }, // dark green
  { dbz:  40, c: [1.00, 1.00, 0.00] }, // yellow
  { dbz:  45, c: [0.91, 0.75, 0.00] }, // dark yellow
  { dbz:  50, c: [1.00, 0.55, 0.00] }, // orange
  { dbz:  55, c: [1.00, 0.00, 0.00] }, // red
  { dbz:  60, c: [0.78, 0.00, 0.00] }, // dark red
  { dbz:  65, c: [1.00, 0.00, 1.00] }, // magenta
  { dbz:  70, c: [0.60, 0.20, 0.80] }, // purple
  { dbz:  75, c: [1.00, 1.00, 1.00] },
];

export function dbzToColor(dbz) {
  if (!Number.isFinite(dbz)) return [0, 0, 0];
  if (dbz <= STOPS[0].dbz) return STOPS[0].c.slice();
  if (dbz >= STOPS[STOPS.length - 1].dbz) return STOPS[STOPS.length - 1].c.slice();
  for (let i = 0; i < STOPS.length - 1; i++) {
    const a = STOPS[i], b = STOPS[i + 1];
    if (dbz >= a.dbz && dbz <= b.dbz) {
      const t = (dbz - a.dbz) / (b.dbz - a.dbz);
      return [
        a.c[0] + (b.c[0] - a.c[0]) * t,
        a.c[1] + (b.c[1] - a.c[1]) * t,
        a.c[2] + (b.c[2] - a.c[2]) * t,
      ];
    }
  }
  return [1, 1, 1];
}

export function legendStops() {
  return STOPS.filter(s => s.dbz >= 5 && s.dbz <= 70);
}

// --- Velocity (m/s) -------------------------------------------------------

// ColorBrewer RdBu (11-class), ordered blue -> white -> red so that the most
// negative (inbound, toward the radar) velocities are deep blue and the most
// positive (outbound, away) are deep red. Colorblind-safe per ColorBrewer.
const VEL_STOPS = [
  [0.020, 0.188, 0.380], // #053061  most inbound
  [0.129, 0.400, 0.675], // #2166ac
  [0.263, 0.576, 0.765], // #4393c3
  [0.573, 0.773, 0.871], // #92c5de
  [0.820, 0.898, 0.941], // #d1e5f0
  [0.969, 0.969, 0.969], // #f7f7f7  ~zero
  [0.992, 0.859, 0.780], // #fddbc7
  [0.957, 0.647, 0.510], // #f4a582
  [0.839, 0.376, 0.302], // #d6604d
  [0.698, 0.094, 0.169], // #b2182b
  [0.404, 0.000, 0.122], // #67001f  most outbound
];

// Map a radial velocity (m/s) to an sRGB [r,g,b]. `vmax` sets the symmetric
// domain [-vmax, +vmax]; values beyond it saturate at the ramp ends.
export function velToColor(v, vmax = 40) {
  if (!Number.isFinite(v)) return [0, 0, 0];
  let t = (v + vmax) / (2 * vmax);
  t = Math.max(0, Math.min(1, t));
  const n = VEL_STOPS.length - 1;
  const f = t * n;
  const i = Math.min(n - 1, Math.floor(f));
  const frac = f - i;
  const a = VEL_STOPS[i], b = VEL_STOPS[i + 1];
  return [
    a[0] + (b[0] - a[0]) * frac,
    a[1] + (b[1] - a[1]) * frac,
    a[2] + (b[2] - a[2]) * frac,
  ];
}

// Legend ticks for the velocity scale, from outbound (+) down to inbound (-).
export function velLegendStops(vmax = 40) {
  return [1, 0.66, 0.33, 0, -0.33, -0.66, -1].map(f => ({ v: Math.round(f * vmax) }));
}

// --- Vorticity (rotation, s⁻¹) -------------------------------------------

// ColorBrewer PuOr ordered purple -> white -> orange so anticyclonic (negative
// vorticity) is purple and cyclonic (positive) is orange. Colorblind-safe, and
// deliberately a different hue family than the velocity RdBu scale so the two
// products read distinctly. (purple/orange, not red/green or red/blue.)
const VORT_STOPS = [
  [0.176, 0.000, 0.294], // #2d004b  strong anticyclonic
  [0.329, 0.153, 0.533], // #542788
  [0.502, 0.451, 0.675], // #8073ac
  [0.698, 0.671, 0.824], // #b2abd2
  [0.847, 0.855, 0.922], // #d8daeb
  [0.969, 0.969, 0.969], // #f7f7f7  ~no rotation
  [0.996, 0.878, 0.714], // #fee0b6
  [0.992, 0.722, 0.388], // #fdb863
  [0.878, 0.510, 0.078], // #e08214
  [0.702, 0.345, 0.024], // #b35806
  [0.498, 0.231, 0.031], // #7f3b08  strong cyclonic
];

// Map vertical vorticity (s⁻¹) to sRGB over the symmetric domain [-vmax, vmax].
export function vortToColor(vort, vmax = 0.02) {
  if (!Number.isFinite(vort)) return [0, 0, 0];
  let t = (vort + vmax) / (2 * vmax);
  t = Math.max(0, Math.min(1, t));
  const n = VORT_STOPS.length - 1;
  const f = t * n;
  const i = Math.min(n - 1, Math.floor(f));
  const frac = f - i;
  const a = VORT_STOPS[i], b = VORT_STOPS[i + 1];
  return [
    a[0] + (b[0] - a[0]) * frac,
    a[1] + (b[1] - a[1]) * frac,
    a[2] + (b[2] - a[2]) * frac,
  ];
}

// Legend ticks for vorticity, cyclonic (+) at top down to anticyclonic (-).
// Labels are in 10⁻³ s⁻¹ since raw values are tiny.
export function vortLegendStops(vmax = 0.02) {
  return [1, 0.5, 0, -0.5, -1].map(f => ({
    v: f * vmax,
    milli: Math.round(f * vmax * 1000),
  }));
}

// --- Dual-Doppler lobe (geometry quality) --------------------------------

// Green ground shading for the dual-Doppler lobe, brightening with crossing
// quality q (|sin β|, 0.5 at the retrievable lobe edge up to 1.0 at an ideal
// 90° cross). Green keeps it distinct from the radar data and cyan range rings.
export function lobeColor(q) {
  const t = Math.max(0, Math.min(1, (q - 0.5) / 0.5));
  return [0.12 + 0.06 * t, 0.40 + 0.50 * t, 0.22 + 0.18 * t];
}
