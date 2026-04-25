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

// Parse a single Type 31 digital radar message starting at r.pos.
// `msgEndPos` is the absolute end of the message in r's buffer.
// Returns { elevation, azimuth, elevationNumber, ref } where ref may be null.
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

  let ref = null;
  for (let i = 0; i < dataBlockCount && i < blockOffsets.length; i++) {
    const off = blockOffsets[i];
    if (off === 0) continue;
    const blockPos = msgStart + off;
    if (blockPos < 0 || blockPos + 28 > msgEndPos) continue;
    // Peek block name
    const name = String.fromCharCode(
      r.u8[blockPos + 1], r.u8[blockPos + 2], r.u8[blockPos + 3]
    );
    if (name !== 'REF') continue;

    const br = new BinReader(r.u8, blockPos);
    br.u8r();                 // 'D'
    br.ascii(3);              // 'REF'
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
    if (dataStart + dataLen > msgEndPos) continue;

    const out = new Float32Array(numGates);
    for (let g = 0; g < numGates; g++) {
      let raw;
      if (bytesPerGate === 2) {
        raw = (r.u8[dataStart + g * 2] << 8) | r.u8[dataStart + g * 2 + 1];
      } else {
        raw = r.u8[dataStart + g];
      }
      if (raw < 2) {
        // 0 = below threshold, 1 = range folded
        out[g] = NaN;
      } else {
        out[g] = (raw - offset) / scale;
      }
    }
    ref = { numGates, firstGate, gateSpacing, data: out };
  }

  return { elevation, azimuth, elevationNumber, ref };
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
        if (m31.ref) accum.addRadial(station, m31);
      } catch (e) {
        // skip malformed
      }
    }
    pos = hdrStart + totalLen;
  }
}

class Accumulator {
  constructor() {
    this.tilts = new Map(); // elevationNumber -> { elevation, gateSpacing, firstGate, gates, radials: [] }
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
        gateSpacing: m.ref.gateSpacing,
        firstGate: m.ref.firstGate,
        gates: m.ref.numGates,
        radials: [],
      };
      this.tilts.set(key, tilt);
    }
    // Use the largest gate count seen for this tilt
    if (m.ref.numGates > tilt.gates) tilt.gates = m.ref.numGates;
    tilt.radials.push({ azimuth: m.azimuth, data: m.ref.data });
  }
  finalize() {
    const sorted = [...this.tilts.values()].sort((a, b) => a.elevation - b.elevation);
    return sorted.map(t => {
      // Sort radials by azimuth and pack into a 2D array
      t.radials.sort((a, b) => a.azimuth - b.azimuth);
      const az = new Float32Array(t.radials.length);
      const refl = new Float32Array(t.radials.length * t.gates);
      for (let i = 0; i < t.radials.length; i++) {
        az[i] = t.radials[i].azimuth;
        const src = t.radials[i].data;
        const off = i * t.gates;
        const n = Math.min(src.length, t.gates);
        for (let g = 0; g < n; g++) refl[off + g] = src[g];
        for (let g = n; g < t.gates; g++) refl[off + g] = NaN;
      }
      return {
        elevationDeg: t.elevation,
        azimuthsDeg: az,
        gateSpacingM: t.gateSpacing,
        firstGateM: t.firstGate,
        gates: t.gates,
        reflectivity: refl,
        missingValue: NaN,
      };
    });
  }
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
    throw new Error('Parsed file but found no reflectivity data. The file may use an unsupported moment or build.');
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
