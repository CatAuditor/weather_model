/* Minimal NetCDF-3 reader (classic + 64-bit offset) and classic writer.
 * Enough for UTrack: fixed-size float/int/short vars on lat/lon grids.
 * NetCDF-4/HDF5 files are detected and rejected with a helpful message. */
"use strict";

const NC = (() => {
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 };
  const TYPE_ARRAY = { 1: Int8Array, 3: Int16Array, 4: Int32Array, 5: Float32Array, 6: Float64Array };

  function parse(buf) {
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    if (u8[0] === 0x89 && u8[1] === 0x48) {
      throw new Error("This is a NetCDF-4/HDF5 file, which the browser reader does not support. Model outputs are NetCDF-3 and load fine.");
    }
    if (!(u8[0] === 67 && u8[1] === 68 && u8[2] === 70)) throw new Error("Not a NetCDF file.");
    const version = u8[3];
    if (version !== 1 && version !== 2) throw new Error("Unsupported NetCDF variant (version byte " + version + ").");

    let p = 4;
    const readU32 = () => { const v = dv.getUint32(p); p += 4; return v; };
    const readName = () => {
      const n = readU32();
      const s = new TextDecoder().decode(u8.subarray(p, p + n));
      p += Math.ceil(n / 4) * 4;
      return s;
    };
    const readVal = (type, off) => {
      switch (type) {
        case 1: return dv.getInt8(off);
        case 3: return dv.getInt16(off);
        case 4: return dv.getInt32(off);
        case 5: return dv.getFloat32(off);
        case 6: return dv.getFloat64(off);
      }
    };
    const readAtts = () => {
      const tag = readU32(), count = readU32();
      const atts = {};
      if (tag !== 0x0C) return atts;
      for (let i = 0; i < count; i++) {
        const name = readName(), type = readU32(), n = readU32();
        let val;
        if (type === 2) {
          val = new TextDecoder().decode(u8.subarray(p, p + n));
        } else {
          val = [];
          for (let k = 0; k < n; k++) val.push(readVal(type, p + k * TYPE_SIZE[type]));
          if (n === 1) val = val[0];
        }
        p += Math.ceil(TYPE_SIZE[type] * n / 4) * 4;
        atts[name] = val;
      }
      return atts;
    };

    const numrecs = readU32();
    let tag = readU32(), count = readU32();
    const dims = [];
    if (tag === 0x0A) for (let i = 0; i < count; i++) dims.push({ name: readName(), size: readU32() });
    const gatts = readAtts();

    tag = readU32(); count = readU32();
    const vars = {};
    const recVars = [];
    if (tag === 0x0B) for (let i = 0; i < count; i++) {
      const name = readName();
      const nd = readU32();
      const dimids = [];
      for (let k = 0; k < nd; k++) dimids.push(readU32());
      const atts = readAtts();
      const type = readU32();
      const vsize = readU32();
      let begin;
      if (version === 2) { begin = dv.getUint32(p) * 4294967296 + dv.getUint32(p + 4); p += 8; }
      else begin = readU32();
      const v = { name, type, atts, vsize, begin, dims: dimids.map(d => dims[d]) };
      v.isRecord = v.dims.length > 0 && v.dims[0].size === 0;
      if (v.isRecord) recVars.push(v);
      vars[name] = v;
    }
    const recSize = recVars.reduce((a, v) => a + v.vsize, 0);

    for (const v of Object.values(vars)) {
      v.shape = v.dims.map(d => (d.size === 0 ? numrecs : d.size));
      v.read = () => {
        const n = v.shape.reduce((a, b) => a * b, 1);
        const T = TYPE_ARRAY[v.type];
        if (!T) throw new Error("Unsupported type for variable " + v.name);
        const out = new T(n);
        const sz = TYPE_SIZE[v.type];
        if (!v.isRecord || recVars.length === 1) {
          for (let k = 0; k < n; k++) out[k] = readVal(v.type, v.begin + k * sz);
        } else {
          const perRec = n / numrecs;
          for (let r = 0; r < numrecs; r++)
            for (let k = 0; k < perRec; k++)
              out[r * perRec + k] = readVal(v.type, v.begin + r * recSize + k * sz);
        }
        // Apply CF packing if present so callers always get physical values
        const scale = v.atts.scale_factor, add = v.atts.add_offset;
        if (scale !== undefined || add !== undefined) {
          const f = new Float64Array(n);
          const s = scale === undefined ? 1 : scale, a = add === undefined ? 0 : add;
          for (let k = 0; k < n; k++) f[k] = out[k] * s + a;
          f.shape = v.shape;
          return f;
        }
        out.shape = v.shape;
        return out;
      };
    }
    return { version, dims, gatts, vars, numrecs };
  }

  /* Writer: classic NetCDF-3 release mask that UTrack's get_input() reads. */
  function writeMask(mask, nlat, nlon) {
    const enc = new TextEncoder();
    const parts = [];
    let size = 0;
    const push = (bytes) => { parts.push(bytes); size += bytes.length; };
    const pushU32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); push(b); };
    const pushName = (s) => {
      const b = enc.encode(s);
      pushU32(b.length);
      const padded = new Uint8Array(Math.ceil(b.length / 4) * 4);
      padded.set(b);
      push(padded);
    };
    const pushTextAtt = (name, text) => {
      pushName(name); pushU32(2);
      const b = enc.encode(text);
      pushU32(b.length);
      const padded = new Uint8Array(Math.ceil(b.length / 4) * 4);
      padded.set(b);
      push(padded);
    };

    push(new Uint8Array([67, 68, 70, 1])); // CDF v1
    pushU32(0);                             // numrecs
    pushU32(0x0A); pushU32(2);              // dim list
    pushName("lat"); pushU32(nlat);
    pushName("lon"); pushU32(nlon);
    pushU32(0x0C); pushU32(2);              // global atts
    pushTextAtt("description", "UTrack release mask (1 = source cell)");
    pushTextAtt("history", "Created " + new Date().toISOString() + " by the UTrack web workbench");

    // variable list: lat(f32[lat]), lon(f32[lon]), release(i32[lat,lon])
    pushU32(0x0B); pushU32(3);
    const beginPatches = [];
    const pushVar = (name, dimids, type, attsFn, vsize) => {
      pushName(name);
      pushU32(dimids.length);
      dimids.forEach(pushU32);
      attsFn();
      pushU32(type);
      pushU32(vsize);
      beginPatches.push(size);
      pushU32(0); // begin placeholder
    };
    pushVar("lat", [0], 5, () => {
      pushU32(0x0C); pushU32(1); pushTextAtt("units", "degrees north");
    }, nlat * 4);
    pushVar("lon", [1], 5, () => {
      pushU32(0x0C); pushU32(1); pushTextAtt("units", "degrees east");
    }, nlon * 4);
    pushVar("release", [0, 1], 4, () => { pushU32(0); pushU32(0); }, nlat * nlon * 4);

    const headerSize = size;
    const begins = [headerSize, headerSize + nlat * 4, headerSize + nlat * 4 + nlon * 4];
    const total = begins[2] + nlat * nlon * 4;
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of parts) { out.set(b, off); off += b.length; }
    const dv = new DataView(out.buffer);
    beginPatches.forEach((pos, i) => dv.setUint32(pos, begins[i]));

    for (let i = 0; i < nlat; i++) dv.setFloat32(begins[0] + i * 4, 90 - 0.25 * i);
    for (let j = 0; j < nlon; j++) dv.setFloat32(begins[1] + j * 4, 0.25 * j);
    for (let k = 0; k < nlat * nlon; k++) dv.setInt32(begins[2] + k * 4, mask[k]);
    return out;
  }

  return { parse, writeMask };
})();
