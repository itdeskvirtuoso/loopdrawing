// LibreDWG (compiled to WebAssembly, see wasm/BUILD.md): DWG -> DXF and DXF -> DWG in the browser or in a worker.
// The DXF is text; strings of a DWG (code page ANSI_1252) are written as cp1252 bytes, see encodeCp1252().

let modulePromise = null;
let moduleUrl = new URL("../../wasm/libredwg.js", import.meta.url).href;

export function setModuleUrl(url) { moduleUrl = url; }

export async function getLib() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const create = (await import(/* @vite-ignore */ moduleUrl)).default;
      const messages = [];
      const M = await create({
        print: (s) => messages.push(s),
        printErr: (s) => messages.push(s),
        locateFile: (f) => new URL(f, moduleUrl).href,
      });
      M._messages = messages;
      return M;
    })();
  }
  return modulePromise;
}

let seq = 0;
function call(M, fn, inPath, outPath) {
  try { M.FS.unlink(outPath); } catch { /* not there */ }
  M._messages.length = 0;
  let rc;
  try { rc = M.ccall(fn, "number", ["string", "string"], [inPath, outPath]); }
  catch (e) { rc = "exception " + (e && (e.status ?? e.message)); }
  let out = null;
  try { out = M.FS.readFile(outPath); } catch { /* not written */ }
  for (const p of [inPath, outPath]) { try { M.FS.unlink(p); } catch { /* ignore */ } }
  return { rc, out, log: M._messages.join("\n") };
}

/** DWG bytes -> DXF text (UTF-8). Throws when the drawing cannot be read. */
export async function dwgToDxf(bytes) {
  const M = await getLib();
  const id = ++seq;
  M.FS.writeFile(`/in${id}.dwg`, bytes);
  const r = call(M, "run_dwg2dxf", `/in${id}.dwg`, `/out${id}.dxf`);
  if (!r.out || r.out.length < 100) throw new Error("the drawing could not be read as DWG" + (r.log ? " (" + lastLines(r.log) + ")" : ""));
  return new TextDecoder("utf-8").decode(r.out);
}

/** DXF text -> DWG bytes (AutoCAD 2000 format). */
export async function dxfToDwg(dxfText) {
  const M = await getLib();
  const id = ++seq;
  M.FS.writeFile(`/in${id}.dxf`, encodeCp1252(dxfText));
  const r = call(M, "run_dxf2dwg", `/in${id}.dxf`, `/out${id}.dwg`);
  if (!r.out || r.out.length < 1000) throw new Error("DWG conversion failed" + (r.log ? " (" + lastLines(r.log) + ")" : ""));
  return r.out;
}

function lastLines(s) { return s.split("\n").filter(Boolean).slice(-3).join(" | ").slice(0, 300); }

// The DWG is AutoCAD 2000 (one byte per character, code page ANSI_1252). LibreDWG copies the bytes of the DXF, so the DXF is given
// in that code page; a character it does not have is written the way AutoCAD stores it: backslash, U+, 4 hex digits.
const CP1252 = new Map();
"€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"
  .split("").forEach((ch, i) => CP1252.set(ch, 0x80 + i));

export function encodeCp1252(text) {
  let out = new Uint8Array(text.length + 64);
  let n = 0;
  const room = (k) => { if (n + k > out.length) { const b = new Uint8Array(out.length * 2 + k); b.set(out); out = b; } };
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    room(8);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) { out[n++] = c; continue; }
    const ch = text[i];
    if (CP1252.has(ch)) { out[n++] = CP1252.get(ch); continue; }
    const cp = text.codePointAt(i);
    if (cp > 0xffff) i++;
    const esc = String.fromCharCode(92) + "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
    for (let k = 0; k < esc.length; k++) out[n++] = esc.charCodeAt(k);
  }
  return out.subarray(0, n);
}
