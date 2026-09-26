import fs from "node:fs";
import opentype from "opentype.js";
import CFB from "cfb";
import { PDFDocument, PDFName, drawObject } from "pdf-lib";
import { TextEngine } from "../../web/js/core/text.js";
import { buildSet } from "../../web/js/core/tplbuild.js";
import { pageSize } from "../../web/js/core/output.js";
const W = "C:/Users/Hitesh ingale/Desktop/wasm-build/";
const b = fs.readFileSync("web/fonts/LiberationSans-Regular.ttf");
const engine = new TextEngine(opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
const dir = "source/templates/";
const files = fs.readdirSync(dir).filter((n) => n.endsWith(".dwg")).map((n) => ({ name: n, bytes: new Uint8Array(fs.readFileSync(dir + n)) }));
const set = await buildSet("mega", "mega", files, { engine, CFB, log: () => {} });
fs.mkdirSync(W + "out/mega", { recursive: true });
const [w, h] = pageSize(set.info.box);
for (const [tid, x] of Object.entries(set.blank)) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([w, h]);
  const xo = {};
  for (let i = 0; i < x.logos.length; i++) xo["Im" + i] = (await pdf.embedPng(x.logos[i].png)).ref;
  const stream = pdf.context.flateStream(x.content, { Type: "XObject", Subtype: "Form", BBox: [0, 0, w, h], Resources: { XObject: xo } });
  const nm = page.node.newXObject("F", pdf.context.register(stream));
  page.pushOperators(drawObject(nm));
  fs.writeFileSync(W + `out/mega/${tid}.pdf`, await pdf.save());
  fs.writeFileSync(W + `out/mega/${tid}.svg`, x.svg);
}
console.log("written", Object.keys(set.blank).join(","));
