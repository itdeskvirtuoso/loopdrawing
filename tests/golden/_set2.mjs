// Second dataset: the MEGA EPC set (FRAME.dwg referenced by XREF, range templates, RTD, AI 4 wire).
import fs from "node:fs";
import opentype from "opentype.js";
import CFB from "cfb";
import { TextEngine } from "../../web/js/core/text.js";
import { buildSet } from "../../web/js/core/tplbuild.js";
const W = "C:/Users/Hitesh ingale/Desktop/wasm-build/";
const b = fs.readFileSync("web/fonts/LiberationSans-Regular.ttf");
const engine = new TextEngine(opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
const dir = "source/templates/";
const files = fs.readdirSync(dir).filter((n) => n.endsWith(".dwg")).map((n) => ({ name: n, bytes: new Uint8Array(fs.readFileSync(dir + n)) }));
const set = await buildSet("mega", "mega", files, { engine, CFB, log: () => {} });
const golden = JSON.parse(fs.readFileSync(W + "golden2/set/set.json", "utf8"));
console.log("templates js", Object.keys(set.info.templates).join(","), "| golden", Object.keys(golden.templates).join(","));
console.log("frame", set.info.frame, golden.frame, "box", set.info.box, golden.box);
console.log("warnings js", set.info.warnings);
console.log("warnings golden", golden.warnings);
function diff(a, b, path, out, tol = 0.011) {
  if (typeof a === "number" && typeof b === "number") { if (Math.abs(a - b) > tol) out.push(`${path}: ${a} != ${b}`); return; }
  if (Array.isArray(a) && Array.isArray(b)) { if (a.length !== b.length) out.push(`${path}: length ${a.length} != ${b.length}`); for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out, tol); return; }
  if (a && b && typeof a === "object") { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if (k === "h") continue; if (!(k in a)) out.push(`${path}.${k}: missing in js`); else if (!(k in b)) out.push(`${path}.${k}: extra in js`); else diff(a[k], b[k], `${path}.${k}`, out, tol); } return; }
  if (a !== b) out.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
for (const tid of Object.keys(golden.templates)) {
  const out = [];
  const j = { ...set.info.templates[tid] }, g = { ...golden.templates[tid] };
  for (const k of ["file", "sheet", "logos", "page"]) { delete j[k]; delete g[k]; }
  if (!set.info.templates[tid]) { console.log(tid, "MISSING in js"); continue; }
  diff(j, g, tid, out);
  console.log(tid.padEnd(6), out.length ? out.length + " differences: " + out.slice(0, 6).join(" | ") : "identical");
}
