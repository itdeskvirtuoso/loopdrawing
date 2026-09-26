import fs from "node:fs";
import opentype from "opentype.js";
import CFB from "cfb";
import JSZip from "jszip";
import { TextEngine } from "../../web/js/core/text.js";
import { buildSet } from "../../web/js/core/tplbuild.js";
import { readIoExcel } from "../../web/js/core/io_excel.js";
import { SheetWriter } from "../../web/js/core/dwgexport.js";
import { dxfToDwg } from "../../web/js/core/libredwg.js";
const W = "C:/Users/Hitesh ingale/Desktop/wasm-build/";
const b = fs.readFileSync("web/fonts/LiberationSans-Regular.ttf");
const engine = new TextEngine(opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
const dir = "source/templates/";
const files = fs.readdirSync(dir).filter((n) => n.endsWith(".dwg")).map((n) => ({ name: n, bytes: new Uint8Array(fs.readFileSync(dir + n)) }));
const set = await buildSet("mega", "mega", files, { engine, CFB, log: () => {} });
const io = await readIoExcel(JSZip, fs.readFileSync("source/1662.MEGA EPC-25004_IO ASSIGNMENT-08-08-2026.xlsx"), "mega.xlsx", set.info);
const order = { AI: 0, AO: 1, RTD: 2, DI: 3, DO: 4 };
const mods = [...io.modules].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.index - b.index);
const sheets = []; for (const m of mods) for (const sh of m.sheets) sheets.push({ tid: sh.template, texts: sh.texts, name: m.module });
fs.mkdirSync(W + "out/js2/dwg", { recursive: true });
const pick = JSON.parse(fs.readFileSync(W + "golden2/dwg_sample.json", "utf8"));
const writers = {};
for (const n of pick) {
  const s = sheets[n];
  const w = (writers[s.tid] ||= new SheetWriter(set.dxf[s.tid], set.info.templates[s.tid], engine, true));
  fs.writeFileSync(W + `out/js2/dwg/${String(n + 1).padStart(4, "0")}_${s.name}.dwg`, await dxfToDwg(w.make(s.texts, n + 1, sheets.length)));
}
console.log("written", pick.length);
