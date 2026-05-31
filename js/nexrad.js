// Minimal NEXRAD Archive II (Level II) parser.
// Extracts reflectivity (REF) from Message Type 31 radials and groups
// them by elevation tilt.
//
// References:
//   ICD for the RDA/RPG (NWS Document 2620002R)
//   "Build 19" Archive II Interface Control Document
//
// Only what's needed for visualization is implemented.

import { STATIONS } from './stations.js';

let _bzip2Promise = null;

async function getBzip2() {
  if (!_bzip2Promise) {
    _bzip2Promise = (async () => {
      // seek-bzip is a tiny pure-JS bzip2 decoder.
      const mod = await import('https://esm.sh/seek-bzip@2.0.0');
      const Bzip2 = mod.default || mod;
      return Bzip2;
    })();
  }
  return _bzip2Promise;
}

const STATION_LOCATIONS = (() => {
  const m = {};
  for (const s of STATIONS) m[s.id] = { lat: s.lat, lon: s.lon, elev: s.elev };
  return m;
})();

class BinReader {
  constructor(buf, offset = 0) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.u8 = buf;
    this.pos = offset;
  }
  remaining() { return this.u8.byteLength - this.pos; }
  skip(n) { this.pos += n; }
  i8() { return this.dv.getInt8(this.pos++); }
  u8r() { return this.dv.getUint8(this.pos++); }
  i16() { const v = this.dv.getInt16(this.pos, false); this.pos += 2; return v; }
  u16() { const v = this.dv.getUint16(this.pos, false); this.pos += 2; return v; }
  i32() { const v = this.dv.getInt32(this.pos, false); this.pos += 4; return v; }
  u32() { const v = this.dv.getUint32(this.pos, false); this.pos += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.pos, false); this.pos += 4; return v; }
  ascii(n) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8[this.pos + i]);
    this.pos += n;
    return s;
  }
  slice(n) {
    const out = this.u8.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

function concatU8(parts) {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

// Moments we extract from Type 31 messages. REF = reflectivity (dBZ),
// VEL = base radial velocity (m/s). Other moments (spectrum width, dual-pol)
// are present in the file but skipped.
const MOMENTS = new Set(['REF', 'VEL']);

// Decode a single moment data block (REF/VEL/...) at absolute offset blockPos.
// Returns { name, numGates, firstGate, gateSpacing, data } or null if the block
// is not a moment we handle or runs past the message bounds.
function parseMomentBlock(u8, blockPos, msgEndPos) {
  const br = new BinReader(u8, blockPos);
  br.u8r();                 // 'D'
  const name = br.ascii(3); // moment name, e.g. 'REF' / 'VEL'
  if (!MOMENTS.has(name)) return null;
  br.u32();                 // reserved
  const numGates = br.u16();
  const firstGate = br.i16();   // meters
  const gateSpacing = br.i16(); // meters
  br.i16();                 // tover (threshold)
  br.i16();                 // snr threshold
  br.u8r();                 // control flags
  const wordSize = br.u8r();
  const scale = br.f32();
  const offset = br.f32();
  const dataStart = br.pos;
  const bytesPerGate = wordSize === 16 ? 2 : 1;
  const dataLen = numGates * bytesPerGate;
  if (dataStart + dataLen > msgEndPos) return null;

  const out = new Float32Array(numGates);
  for (let g = 0; g < numGates; g++) {
    let raw;
    if (bytesPerGate === 2) {
      raw = (u8[dataStart + g * 2] << 8) | u8[dataStart + g * 2 + 1];
    } else {
      raw = u8[dataStart + g];
    }
    if (raw < 2 || !scale) {
      // 0 = below threshold, 1 = range folded (ambiguous), no scale = unusable
      out[g] = NaN;
    } else {
      out[g] = (raw - offset) / scale;
    }
  }
  return { name, numGates, firstGate, gateSpacing, data: out };
}

// Parse a single Type 31 digital radar message starting at r.pos.
// `msgEndPos` is the absolute end of the message in r's buffer.
// Returns { elevation, azimuth, elevationNumber, moments } where `moments` is a
// map keyed by moment name (e.g. { REF, VEL }) and may be empty.
function parseMessage31(r, msgEndPos) {
  const msgStart = r.pos;
  r.ascii(4);            // ICAO
  r.u32();               // ms of day
  r.u16();               // Julian date
  r.u16();               // radial number within elevation
  const azimuth = r.f32();
  r.u8r();               // compression indicator
  r.u8r();               // spare
  r.u16();               // radial length (bytes)
  r.u8r();               // azimuth resolution spacing (1 = 0.5°, 2 = 1°)
  r.u8r();               // radial status
  const elevationNumber = r.u8r();
  r.u8r();               // cut sector number
  const elevation = r.f32();
  r.u8r();               // radial spot blanking status
  r.u8r();               // azimuth indexing mode
  const dataBlockCount = r.u16();

  const blockOffsets = [];
  // 9 fixed pointers per ICD
  for (let i = 0; i < 9; i++) blockOffsets.push(r.u32());

  const moments = {};
  for (let i = 0; i < dataBlockCount && i < blockOffsets.length; i++) {
    const off = blockOffsets[i];
    if (off === 0) continue;
    const blockPos = msgStart + off;
    if (blockPos < 0 || blockPos + 28 > msgEndPos) continue;
    const mb = parseMomentBlock(r.u8, blockPos, msgEndPos);
    if (mb) moments[mb.name] = mb;
  }

  return { elevation, azimuth, elevationNumber, moments };
}

// Parse a stream of messages (one decompressed LDM block).
function parseMessageStream(buf, station, accum) {
  let pos = 0;
  while (pos + 28 <= buf.byteLength) {
    // 12-byte CTM header padding (not always present at very start, but normally is)
    // Heuristic: try with 12-byte skip first; if message size doesn't make sense, retry without.
    const tryParseAt = (start) => {
      if (start + 28 > buf.byteLength) return -1;
      const dv = new DataView(buf.buffer, buf.byteOffset + start, 16);
      const sizeHalfwords = dv.getUint16(0, false);
      const messageType = dv.getUint8(3);
      if (messageType === 0 || messageType > 50) return -1;

      let totalLen;
      if (messageType === 31) {
        totalLen = sizeHalfwords * 2; // includes 16-byte header
        if (totalLen < 16 || totalLen > 65536) return -1;
      } else {
        totalLen = 2416; // standard message: 16 hdr + 2400 data
      }
      if (start + totalLen > buf.byteLength) return -1;
      return totalLen;
    };

    // Try with CTM padding
    let ctm = 12;
    let totalLen = tryParseAt(pos + ctm);
    if (totalLen < 0) {
      ctm = 0;
      totalLen = tryParseAt(pos + ctm);
    }
    if (totalLen < 0) {
      // Walk forward a byte and try again, but bail if we're hopelessly stuck
      pos += 1;
      if (pos > buf.byteLength - 28) break;
      continue;
    }

    const hdrStart = pos + ctm;
    const r = new BinReader(buf, hdrStart);
    r.u16();                    // size halfwords
    r.u8r();                    // channels
    const messageType = r.u8r();
    r.u16();                    // seq number
    r.u16();                    // julian date
    r.u32();                    // ms of day
    r.u16();                    // num segments
    r.u16();                    // segment num

    const msgEnd = hdrStart + totalLen;
    if (messageType === 31) {
      try {
        const m31 = parseMessage31(r, msgEnd);
        if (m31.moments && (m31.moments.REF || m31.moments.VEL)) {
          accum.addRadial(station, m31);
        }
      } catch (e) {
        // skip malformed
      }
    }
    pos = hdrStart + totalLen;
  }
}

class Accumulator {
  constructor() {
    this.tilts = new Map(); // elevationNumber -> { elevation, radials: [] }
    this.station = null;
  }
  addRadial(station, m) {
    if (station && !this.station) this.station = station;
    const key = m.elevationNumber || Math.round(m.elevation * 10);
    let tilt = this.tilts.get(key);
    if (!tilt) {
      tilt = {
        elevationNumber: m.elevationNumber,
        elevation: m.elevation,
        radials: [],
      };
      this.tilts.set(key, tilt);
    }
    tilt.radials.push({ azimuth: m.azimuth, moments: m.moments });
  }
  // Pack one moment (e.g. REF/VEL) across a tilt's radials into a dense
  // azimuth-major Float32Array. Radials missing the moment (split cuts where
  // only one moment is scanned) are filled with NaN.
  _packMoment(radials, name) {
    let gates = 0, gateSpacing = 250, firstGate = 0, seen = false;
    for (const r of radials) {
      const mb = r.moments[name];
      if (!mb) continue;
      if (mb.numGates > gates) gates = mb.numGates;
      if (!seen) { gateSpacing = mb.gateSpacing; firstGate = mb.firstGate; seen = true; }
    }
    if (!seen) return null;
    const data = new Float32Array(radials.length * gates);
    for (let i = 0; i < radials.length; i++) {
      const mb = radials[i].moments[name];
      const off = i * gates;
      if (mb) {
        const n = Math.min(mb.data.length, gates);
        for (let g = 0; g < n; g++) data[off + g] = mb.data[g];
        for (let g = n; g < gates; g++) data[off + g] = NaN;
      } else {
        for (let g = 0; g < gates; g++) data[off + g] = NaN;
      }
    }
    return { gates, gateSpacingM: gateSpacing, firstGateM: firstGate, data };
  }
  finalize() {
    const sorted = [...this.tilts.values()].sort((a, b) => a.elevation - b.elevation);
    const tilts = [];
    for (const t of sorted) {
      // Sort radials by azimuth, then pack every moment present in the tilt.
      t.radials.sort((a, b) => a.azimuth - b.azimuth);
      const az = new Float32Array(t.radials.length);
      for (let i = 0; i < t.radials.length; i++) az[i] = t.radials[i].azimuth;

      const names = new Set();
      for (const r of t.radials) for (const k in r.moments) names.add(k);
      const moments = {};
      for (const name of names) {
        const packed = this._packMoment(t.radials, name);
        if (packed) moments[name] = packed;
      }
      if (!Object.keys(moments).length) continue;

      // Keep top-level REF fields as aliases so older consumers (synthetic
      // volumes, the mosaic ingest) keep working unchanged.
      const ref = moments.REF;
      tilts.push({
        elevationDeg: t.elevation,
        azimuthsDeg: az,
        moments,
        gates: ref ? ref.gates : 0,
        gateSpacingM: ref ? ref.gateSpacingM : 250,
        firstGateM: ref ? ref.firstGateM : 0,
        reflectivity: ref ? ref.data : null,
        missingValue: NaN,
      });
    }
    return tilts;
  }
}

// Look up a moment's gridded data for a tilt, tolerating both the new
// `moments` map and the legacy top-level `reflectivity` shape used by
// synthetic volumes. Returns { gates, gateSpacingM, firstGateM, data } or null.
export function tiltMoment(tilt, name) {
  if (tilt.moments && tilt.moments[name]) return tilt.moments[name];
  if (name === 'REF' && tilt.reflectivity) {
    return {
      gates: tilt.gates,
      gateSpacingM: tilt.gateSpacingM,
      firstGateM: tilt.firstGateM,
      data: tilt.reflectivity,
    };
  }
  return null;
}

export async function parseLevel2(arrayBuffer, filename = '') {
  const u8Full = new Uint8Array(arrayBuffer);

  // Detect outer bzip2 (file is one big .bz2 of an AR2V file)
  let u8 = u8Full;
  if (u8.length >= 3 && u8[0] === 0x42 && u8[1] === 0x5A && u8[2] === 0x68 &&
      String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'AR2V') {
    const Bzip2 = await getBzip2();
    u8 = new Uint8Array(Bzip2.decode(u8Full));
  }

  if (u8.length < 24 || String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'AR2V') {
    throw new Error('Not a NEXRAD Archive II file (missing AR2V header).');
  }

  const r = new BinReader(u8);
  // Volume header (24 bytes): 9-byte tape tag, 3-byte extension number,
  // 4-byte modified Julian date, 4-byte ms of day, 4-byte ICAO.
  const tape = r.ascii(9);          // e.g. "AR2V0006."
  const versionStr = tape.slice(4, 8);
  r.ascii(3);                       // extension number (e.g. "574")
  r.u32();                          // modified Julian date
  r.u32();                          // milliseconds of day
  const station = r.ascii(4);

  const accum = new Accumulator();
  accum.station = station;

  let needsBzip = parseInt(versionStr, 10) >= 2; // AR2V0002+ uses bzip2 records
  let Bzip2 = null;
  if (needsBzip) Bzip2 = await getBzip2();

  while (r.remaining() >= 4) {
    const ctrl = r.i32();
    if (ctrl === 0) break;
    const len = Math.abs(ctrl);
    if (len <= 0 || len > r.remaining()) break;
    const block = r.slice(len);

    // The control word's sign nominally indicates bzip2 compression, but
    // some AR2V0002+ records (notably the metadata record at the start)
    // carry a positive control word despite being bzip2-compressed. Detect
    // by the "BZh" magic instead so both conventions work.
    const looksBzip2 = block.byteLength >= 3 &&
      block[0] === 0x42 && block[1] === 0x5A && block[2] === 0x68;

    let decoded;
    if (looksBzip2 && needsBzip) {
      try {
        decoded = new Uint8Array(Bzip2.decode(block));
      } catch (e) {
        // Some records have a 4-byte length prefix before the bzip2 stream.
        try { decoded = new Uint8Array(Bzip2.decode(block.subarray(4))); }
        catch { continue; }
      }
    } else {
      decoded = block;
    }

    parseMessageStream(decoded, station, accum);
  }

  const tilts = accum.finalize();
  if (tilts.length === 0) {
    throw new Error('Parsed file but found no reflectivity or velocity data. The file may use an unsupported moment or build.');
  }

  const loc = STATION_LOCATIONS[station] || { lat: 0, lon: 0, elev: 0 };

  return {
    station,
    lat: loc.lat,
    lon: loc.lon,
    elevMeters: loc.elev,
    timestamp: new Date(),
    synthetic: false,
    sourceFile: filename,
    tilts,
  };
}
