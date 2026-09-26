// Logos: OLE2FRAME entities of a drawing (a bitmap embedded by AutoCAD) -> rectangle in the drawing + PNG picture.
import { insertMatrix, mulM, apply, IDENT } from "./render.js";

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function hexBytes(hex) {
  const n = hex.length >> 1, out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** The bytes of an OLE2FRAME entity (its binary chunks, group code 310). */
export function oleData(e) {
  const chunks = e.getAll(310).map((h) => hexBytes(h.trim()));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

function indexOfMagic(b) {
  outer: for (let i = 0; i + 8 <= b.length; i++) {
    for (let k = 0; k < 8; k++) if (b[i + k] !== OLE_MAGIC[k]) continue outer;
    return i;
  }
  return -1;
}

/** { w, h, rgba } of a BMP (uncompressed 8 / 24 / 32 bit). */
export function decodeBmp(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] !== 0x42 || b[1] !== 0x4d) return null;
  const off = dv.getUint32(10, true), hdr = dv.getUint32(14, true);
  const w = dv.getInt32(18, true); let h = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true), comp = dv.getUint32(30, true);
  const top = h < 0; h = Math.abs(h);
  if (![8, 16, 24, 32].includes(bpp) || (comp !== 0 && comp !== 3)) return null;
  const rgba = new Uint8Array(w * h * 4);
  let masks = [0xff0000, 0xff00, 0xff, 0xff000000];
  if (bpp === 16) masks = comp === 3 ? [dv.getUint32(14 + hdr, true), dv.getUint32(18 + hdr, true), dv.getUint32(22 + hdr, true), 0] : [0x7c00, 0x03e0, 0x001f, 0];
  if (bpp === 32 && comp === 3) masks = [dv.getUint32(14 + hdr, true), dv.getUint32(18 + hdr, true), dv.getUint32(22 + hdr, true), hdr >= 56 ? dv.getUint32(26 + hdr, true) : 0];
  const shift = (m) => { let s = 0; while (m && !(m & 1)) { m >>>= 1; s++; } return [s, m]; };
  const [rs, rm] = shift(masks[0]), [gs, gm] = shift(masks[1]), [bs, bm] = shift(masks[2]);
  const pal = [];
  if (bpp === 8) { const n = dv.getUint32(46, true) || 256; for (let i = 0; i < n; i++) { const p = 14 + hdr + i * 4; pal.push([b[p + 2], b[p + 1], b[p]]); } }
  const stride = ((w * bpp + 31) >> 5) << 2;
  for (let y = 0; y < h; y++) {
    const row = off + (top ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (bpp === 24) { const p = row + x * 3; rgba[o] = b[p + 2]; rgba[o + 1] = b[p + 1]; rgba[o + 2] = b[p]; }
      else if (bpp === 16) {
        const v = dv.getUint16(row + x * 2, true);
        rgba[o] = (((v >>> rs) & rm) * 255) / rm; rgba[o + 1] = (((v >>> gs) & gm) * 255) / gm; rgba[o + 2] = (((v >>> bs) & bm) * 255) / bm;
      } else if (bpp === 32) {
        const v = dv.getUint32(row + x * 4, true);
        rgba[o] = rm === 255 ? (v >>> rs) & 255 : (((v >>> rs) & rm) * 255) / rm; rgba[o + 1] = gm === 255 ? (v >>> gs) & 255 : (((v >>> gs) & gm) * 255) / gm; rgba[o + 2] = bm === 255 ? (v >>> bs) & 255 : (((v >>> bs) & bm) * 255) / bm;
      } else { const c = pal[b[row + x]] || [0, 0, 0]; rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; }
      rgba[o + 3] = 255;
    }
  }
  return { w, h, rgba };
}

/** The bitmap of an EMF metafile (pictures pasted into AutoCAD are a metafile around one bitmap: STRETCHDIBITS / BITBLT). */
export function emfBitmap(c) {
  let sig = -1;
  for (let i = 0; i < Math.min(64, c.length - 4); i++) if (c[i] === 0x20 && c[i + 1] === 0x45 && c[i + 2] === 0x4d && c[i + 3] === 0x46) { sig = i; break; }
  if (sig < 40) return null;
  const emf = c.subarray(sig - 40), dv = new DataView(emf.buffer, emf.byteOffset, emf.byteLength);
  let best = null;
  for (let p = 0; p + 8 <= emf.length;) {
    const type = dv.getUint32(p, true), size = dv.getUint32(p + 4, true);
    if (size < 8) break;
    if ((type === 81 || type === 76 || type === 80) && size >= 80) { // STRETCHDIBITS / BITBLT / SETDIBITSTODEVICE
      const [offBmi, cbBmi, offBits, cbBits] = type === 76 ? [dv.getUint32(p + 68, true), dv.getUint32(p + 72, true), dv.getUint32(p + 76, true), dv.getUint32(p + 80, true)]
        : [dv.getUint32(p + 48, true), dv.getUint32(p + 52, true), dv.getUint32(p + 56, true), dv.getUint32(p + 60, true)];
      if (cbBmi >= 40 && cbBits > 0 && p + offBits + cbBits <= emf.length) {
        const bmp = new Uint8Array(14 + cbBmi + cbBits), b = new DataView(bmp.buffer);
        bmp[0] = 0x42; bmp[1] = 0x4d; b.setUint32(2, bmp.length, true); b.setUint32(10, 14 + cbBmi, true);
        bmp.set(emf.subarray(p + offBmi, p + offBmi + cbBmi), 14);
        bmp.set(emf.subarray(p + offBits, p + offBits + cbBits), 14 + cbBmi);
        const img = decodeBmp(bmp);
        if (img && (!best || img.w * img.h > best.w * best.h)) best = img;
      }
    }
    if (type === 14) break;
    p += size;
  }
  return best;
}

/** Decodes an image of the OLE streams: BMP always, PNG / JPEG where the browser can (createImageBitmap), EMF around a bitmap. */
async function decodeAny(c) {
  if (c[0] === 0x42 && c[1] === 0x4d) return decodeBmp(c);
  const emf = emfBitmap(c);
  if (emf) return emf;
  if ((c[0] === 0x89 && c[1] === 0x50) || (c[0] === 0xff && c[1] === 0xd8)) {
    if (typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function") {
      const bmp = await createImageBitmap(new Blob([c]));
      const cv = new OffscreenCanvas(bmp.width, bmp.height), g = cv.getContext("2d");
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height);
      return { w: bmp.width, h: bmp.height, rgba: new Uint8Array(d.data.buffer) };
    }
  }
  return null;
}

/** The picture of an OLE object: { w, h, rgba } or null. `CFB` is the cfb library (global in the browser). */
export async function olePicture(data, CFB) {
  const pos = indexOfMagic(data);
  if (pos < 0) return null;
  let cfb;
  try { cfb = CFB.read(data.subarray(pos), { type: "array" }); } catch { return null; }
  for (const name of ["CONTENTS", "\u0002OlePres000", "Ole10Native"]) {
    const entry = CFB.find(cfb, "/" + name);
    if (!entry || !entry.content) continue;
    const img = await decodeAny(Uint8Array.from(entry.content));
    if (img) return img;
  }
  return null;
}

/** White is paper: without it a logo does not hide the lines and texts of the frame behind it. */
export function whiteToTransparent(img) {
  const p = img.rgba;
  for (let i = 0; i < p.length; i += 4) p[i + 3] = Math.min(p[i], p[i + 1], p[i + 2]) >= 250 ? 0 : 255;
  return img;
}

// ------------------------------------------------------------------------------------------------ PNG writer
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

async function deflate(bytes) {
  const cs = new CompressionStream("deflate");
  const w = cs.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

export async function encodePng(img) {
  const { w, h, rgba } = img;
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1); }
  const idat = await deflate(raw);
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ------------------------------------------------------------------------------------------------ logos of a drawing
/** [{ rect: [x0, y0, x1, y1], png: Uint8Array }] of the OLE pictures of the drawing as they sit in it (frame bound in). */
export async function findLogos(doc, CFB, warn) {
  const found = [];
  const rec = (ents, m, depth) => {
    for (const e of ents) {
      if (e.type === "OLE2FRAME") found.push({ e, m });
      else if (e.type === "INSERT" && depth < 5) {
        const b = doc.block(e.get(2, ""));
        if (b && !b.isXref) rec(b.ents, mulM(m, insertMatrix(e, b)), depth + 1);
      }
    }
  };
  rec(doc.msp, IDENT, 0);
  const cache = new Map(), out = [];
  for (const { e, m } of found) {
    const data = oleData(e);
    if (data.length < 128) continue;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length < 2 + 96) continue;
    const v = []; for (let i = 0; i < 12; i++) v.push(dv.getFloat64(2 + i * 8, true));
    const pts = [0, 3, 6, 9].map((i) => apply(m, v[i], v[i + 1]));
    if (Math.abs(pts[0][1] - pts[1][1]) > 1e-3 * Math.max(1, Math.abs(pts[0][0] - pts[1][0]))) { warn.push("a logo of the drawing is rotated - it is not shown"); continue; }
    const key = e.handle;
    if (!cache.has(key)) {
      const img = await olePicture(data, CFB);
      if (!img) { warn.push("a logo of the drawing (OLE picture) could not be read - it is not shown"); cache.set(key, null); }
      else cache.set(key, await encodePng(whiteToTransparent(img)));
    }
    const png = cache.get(key);
    if (!png) continue;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    out.push({ rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], png });
  }
  return out;
}
