// All 1184 sheets of the golden data with the JS renderer + JS PDF assembly -> out/all.js.pdf (compare with golden/all.pdf)
import fs from "node:fs";
import opentype from "opentype.js";
import CFB from "cfb";
import * as lib from "pdf-lib";
import { dwgToDxf } from "../../web/js/core/libredwg.js";
import { parseDxf } from "../../web/js/core/dxf.js";
import { TextEngine } from "../../web/js/core/text.js";
import { buildDisplay } from "../../web/js/core/render.js";
import { pdfContent } from "../../web/js/core/output.js";
import { findLogos } from "../../web/js/core/logos.js";
import { buildPdf } from "../../web/js/core/pdfexport.js";

const W = "C:/Users/Hitesh ingale/Desktop/wasm-build/";
const N = parseInt(process.argv[2] || "0", 10); // 0 = all
const set = JSON.parse(fs.readFileSync(W + "golden/set/set.json", "utf8"));
const b = fs.readFileSync("web/fonts/LiberationSans-Regular.ttf");
const engine = new TextEngine(opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
const files = { AI2W: "AI", AO: "AO", DI: "DI", DO: "DO" };
const blanks = {};
for (const [tid, f] of Object.entries(files)) {
  const t = set.templates[tid];
  const doc = parseDxf(fs.readFileSync(W + `golden/set/${tid}.dxf`, "utf8"));
  const fields = [...Object.values(t.header), ...(t.jblines || []), ...(t.jbtags || []), ...t.tags, ...t.descs, ...t.terms];
  const blank = new Set(fields.map((x) => x.h)); if (t.sheetno) blank.add(t.sheetno.h); if (t.frameTotal) blank.add(t.frameTotal.h);
  const disp = buildDisplay(doc, { engine, blank });
  const logos = await findLogos(parseDxf(await dwgToDxf(fs.readFileSync(`C:/Users/Hitesh ingale/Downloads/${f}.dwg`))), CFB, []);
  blanks[tid] = { content: pdfContent(disp, set.box, logos), logos };
}
const io = JSON.parse(fs.readFileSync(W + "golden/io.json", "utf8"));
const order = { AI: 0, AO: 1, RTD: 2, DI: 3, DO: 4 };
const mods = [...io.modules].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.index - b.index);
let sheets = [];
for (const m of mods) for (const sh of m.sheets) sheets.push({ tid: sh.template, texts: sh.texts, numbering: null });
const total = sheets.length;
sheets.forEach((s, i) => (s.numbering = [i + 1, total]));
if (N) sheets = sheets.slice(0, N);
const t0 = Date.now();
const pdf = await buildPdf(lib, engine, set, blanks, sheets, "golden");
fs.writeFileSync(W + "out/all.js.pdf", pdf);
console.log("sheets", sheets.length, "bytes", pdf.length, "seconds", ((Date.now() - t0) / 1000).toFixed(1));
