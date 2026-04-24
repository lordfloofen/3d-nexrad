// Standard NWS reflectivity color scale (dBZ).
// Returns sRGB [r,g,b] in 0..1 for a given dBZ value.

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
