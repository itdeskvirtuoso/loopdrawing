// ZIP writer that streams into a sink (a file on disk or memory): every file is written as it is made, so a set of any size
// can be made without holding it in memory. Files are stored (PDF pages and DWG files are compressed already). ZIP64 when needed.

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

const enc = new TextEncoder();
const U32 = 0xffffffff;

function dosTime(d = new Date()) {
  return [((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff, (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff];
}

/** sink: { write(Uint8Array): Promise, close(): Promise }. */
export class ZipWriter {
  constructor(sink) {
    this.sink = sink;
    this.offset = 0;
    this.entries = [];
    this.names = new Map();
    this.chain = Promise.resolve(); // writes happen in order
  }

  async _write(b) { await this.sink.write(b); this.offset += b.length; }

  /** Adds one file (never two with the same name: "name (2).ext"). Returns the name used. */
  add(name, data) {
    const n = (this.names.get(name) || 0) + 1;
    this.names.set(name, n);
    if (n > 1) { const i = name.lastIndexOf("."); name = i > 0 ? `${name.slice(0, i)} (${n})${name.slice(i)}` : `${name} (${n})`; }
    const p = this.chain.then(() => this._addNow(name, data));
    this.chain = p.catch(() => {});
    return p.then(() => name);
  }

  async _addNow(name, data) {
    const nameB = enc.encode(name), crc = crc32(data), size = data.length;
    const [t, d] = dosTime();
    const big = size >= U32;
    const extra = big ? new Uint8Array(20) : new Uint8Array(0);
    const h = new Uint8Array(30 + nameB.length + extra.length), dv = new DataView(h.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, big ? 45 : 20, true); dv.setUint16(6, 0x0800, true); dv.setUint16(8, 0, true);
    dv.setUint16(10, t, true); dv.setUint16(12, d, true); dv.setUint32(14, crc, true);
    dv.setUint32(18, big ? U32 : size, true); dv.setUint32(22, big ? U32 : size, true);
    dv.setUint16(26, nameB.length, true); dv.setUint16(28, extra.length, true);
    h.set(nameB, 30);
    if (big) { const e = new DataView(h.buffer, 30 + nameB.length); e.setUint16(0, 1, true); e.setUint16(2, 16, true); e.setBigUint64(4, BigInt(size), true); e.setBigUint64(12, BigInt(size), true); }
    const offset = this.offset;
    await this._write(h);
    await this._write(data);
    this.entries.push({ nameB, crc, size, offset, t, d, big });
  }

  async close() {
    await this.chain;
    const cdStart = this.offset;
    for (const e of this.entries) {
      const bigOff = e.offset >= U32;
      const ex = e.big || bigOff ? 4 + (e.big ? 16 : 0) + (bigOff ? 8 : 0) : 0;
      const h = new Uint8Array(46 + e.nameB.length + ex), dv = new DataView(h.buffer);
      dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 0x031e, true); dv.setUint16(6, ex ? 45 : 20, true); dv.setUint16(8, 0x0800, true);
      dv.setUint16(12, e.t, true); dv.setUint16(14, e.d, true); dv.setUint32(16, e.crc, true);
      dv.setUint32(20, e.big ? U32 : e.size, true); dv.setUint32(24, e.big ? U32 : e.size, true);
      dv.setUint16(28, e.nameB.length, true); dv.setUint16(30, ex, true);
      dv.setUint32(38, 0x81a40000, true); // unix mode 0644
      dv.setUint32(42, bigOff ? U32 : e.offset, true);
      h.set(e.nameB, 46);
      if (ex) {
        const x = new DataView(h.buffer, 46 + e.nameB.length);
        x.setUint16(0, 1, true); x.setUint16(2, ex - 4, true);
        let o = 4;
        if (e.big) { x.setBigUint64(o, BigInt(e.size), true); x.setBigUint64(o + 8, BigInt(e.size), true); o += 16; }
        if (bigOff) x.setBigUint64(o, BigInt(e.offset), true);
      }
      await this._write(h);
    }
    const cdSize = this.offset - cdStart, n = this.entries.length;
    const zip64 = n >= 0xffff || cdStart >= U32 || cdSize >= U32;
    if (zip64) {
      const r = new Uint8Array(56 + 20), dv = new DataView(r.buffer);
      dv.setUint32(0, 0x06064b50, true); dv.setBigUint64(4, 44n, true); dv.setUint16(12, 45, true); dv.setUint16(14, 45, true);
      dv.setBigUint64(24, BigInt(n), true); dv.setBigUint64(32, BigInt(n), true); dv.setBigUint64(40, BigInt(cdSize), true); dv.setBigUint64(48, BigInt(cdStart), true);
      dv.setUint32(56, 0x07064b50, true); dv.setBigUint64(64, BigInt(this.offset), true); dv.setUint32(72, 1, true);
      await this._write(r);
    }
    const e = new Uint8Array(22), dv = new DataView(e.buffer);
    dv.setUint32(0, 0x06054b50, true);
    dv.setUint16(8, zip64 ? 0xffff : n, true); dv.setUint16(10, zip64 ? 0xffff : n, true);
    dv.setUint32(12, zip64 ? U32 : cdSize, true); dv.setUint32(16, zip64 ? U32 : cdStart, true);
    await this._write(e);
    await this.sink.close();
    return { files: n, size: this.offset };
  }
}

/** Sink that collects the parts in memory (Blob parts: the browser may keep them on disk). */
export class MemorySink {
  constructor(type = "application/zip") { this.parts = []; this.type = type; }
  async write(b) { this.parts.push(b.slice()); }
  async close() { this.blob = new Blob(this.parts, { type: this.type }); this.parts = []; }
}

/** Sink that writes to a file the user chose (File System Access API). */
export class FileSink {
  constructor(writable) { this.w = writable; }
  async write(b) { await this.w.write(b); }
  async close() { await this.w.close(); }
  async abort() { try { await this.w.abort(); } catch { /* already closed */ } }
}
