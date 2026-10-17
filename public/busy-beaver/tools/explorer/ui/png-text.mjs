// Insert tEXt chunks into a PNG right after IHDR (CRC32 in JS). Values are written as UTF-8 bytes
// (the label uses − … × ≡, which Latin-1 lacks; readers that assume Latin-1 show them as mojibake).

let TABLE = null;
function crcTable() {
  if (TABLE) return TABLE;
  TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c >>> 0; }
  return TABLE;
}

export function crc32(bytes, start = 0, end = bytes.length) {
  const T = crcTable();
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = T[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** png: Uint8Array; entries: [[keyword, text], ...] -> new Uint8Array. */
export function insertText(png, entries) {
  const sig = 8, ihdrLen = new DataView(png.buffer, png.byteOffset).getUint32(sig);
  const cut = sig + 12 + ihdrLen;
  const enc = new TextEncoder();
  const chunks = entries.map(([k, v]) => { const kb = enc.encode(k), vb = enc.encode(v); const d = new Uint8Array(kb.length + 1 + vb.length); d.set(kb, 0); d.set(vb, kb.length + 1); return chunk('tEXt', d); });
  const total = png.length + chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  out.set(png.subarray(0, cut), 0);
  let o = cut;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  out.set(png.subarray(cut), o);
  return out;
}

/** Read tEXt chunks (for tests): -> {keyword: text}. */
export function readText(png) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength), out = {};
  const dec = new TextDecoder();
  for (let o = 8; o + 8 <= png.length;) {
    const len = dv.getUint32(o), type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7]);
    if (type === 'tEXt') {
      const d = png.subarray(o + 8, o + 8 + len), z = d.indexOf(0);
      out[dec.decode(d.subarray(0, z))] = dec.decode(d.subarray(z + 1));
    }
    if (type === 'IEND') break;
    o += 12 + len;
  }
  return out;
}
