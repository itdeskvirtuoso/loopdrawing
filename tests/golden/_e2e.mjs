// Whole chain in JS: DWG templates -> set, Excel -> sheets, PDF of all sheets, DWG of a few sheets.
import fs from "node:fs";
import opentype from "opentype.js";
import CFB from "cfb";
import JSZip from "jszip";
import * as lib from "pdf-lib";
import { TextEngine } from "../../web/js/core/text.js";
import { buildSet } from "../../web/js/core/tplbuild.js";
import { readIoExcel } from "../../web/js/core/io_excel.js";
import { buildPdf } from "../../web/js/core/pdfexport.js";
import { SheetWriter } from "../../web/js/core/dwgexport.js";
import { dxfToDwg } from "../../web/js/core/libredwg.js";

const W = "C:/Users/Hitesh ingale/Desktop/wasm-build/", OUT = W + "out/js/";
fs.mkdirSync(OUT + "dwg", { recursive: true });
const b = fs.readFileSync("web/fonts/LiberationSans-Regular.ttf");
const engine = new TextEngine(opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
const files = ["AI", "AO", "DI", "DO"].map((n) => ({ name: n + ".dwg", bytes: new Uint8Array(fs.readFileSync(`C:/Users/Hitesh ingale/Downloads/${n}.dwg`)) }));
let t0 = Date.now();
const set = await buildSet("do", "do", files, { engine, CFB, log: () => {} });
console.log("set built", ((Date.now() - t0) / 1000).toFixed(1), "s; templates", Object.keys(set.info.templates).join(","), "warnings", set.info.warnings);
fs.writeFileSync(OUT + "set.json", JSON.stringify(set.info));
for (const [tid, x] of Object.entries(set.dxf)) fs.writeFileSync(OUT + tid + ".dxf", x);
t0 = Date.now();
const io = await readIoExcel(JSZip, fs.readFileSync("C:/Users/Hitesh ingale/Downloads/DO.xlsx"), "DO.xlsx", set.info);
console.log("excel", Date.now() - t0, "ms", io.counts);
const order = { AI: 0, AO: 1, RTD: 2, DI: 3, DO: 4 };
const mods = [...io.modules].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.index - b.index);
const sheets = [];
for (const m of mods) for (const sh of m.sheets) sheets.push({ tid: sh.template, texts: sh.texts, numbering: null, name: `${m.module}_CH${sh.first}` });
sheets.forEach((s, i) => (s.numbering = [i + 1, sheets.length]));
t0 = Date.now();
fs.writeFileSync(OUT + "all.pdf", await buildPdf(lib, engine, set.info, set.blank, sheets, "js"));
console.log("pdf", sheets.length, "sheets", ((Date.now() - t0) / 1000).toFixed(1), "s");
const pick = JSON.parse(fs.readFileSync(W + "golden/dwg_sample.json", "utf8"));
const writers = {};
t0 = Date.now();
for (const n of pick) {
  const s = sheets[n];
  const w = (writers[s.tid] ||= new SheetWriter(set.dxf[s.tid], set.info.templates[s.tid], engine, true));
  const dxf = w.make(s.texts, s.numbering[0], s.numbering[1]);
  const dwg = await dxfToDwg(dxf);
  fs.writeFileSync(OUT + "dwg/" + `${String(n + 1).padStart(4, "0")}_${s.name}.dwg`, dwg);
}
console.log("dwg", pick.length, "files", ((Date.now() - t0) / 1000).toFixed(1), "s");
