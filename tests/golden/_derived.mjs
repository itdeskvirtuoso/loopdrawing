import fs from "node:fs";
import opentype from "opentype.js";
import CFB from "cfb";
import { TextEngine } from "../../web/js/core/text.js";
import { buildSet } from "../../web/js/core/tplbuild.js";
const W = "C:/Users/Hitesh ingale/Desktop/wasm-build/";
const b = fs.readFileSync("web/fonts/LiberationSans-Regular.ttf");
const engine = new TextEngine(opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
const set = await buildSet("aionly", "aionly", [{ name: "AI.dwg", bytes: new Uint8Array(fs.readFileSync("C:/Users/Hitesh ingale/Downloads/AI.dwg")) }], { engine, CFB, log: () => {} });
const golden = JSON.parse(fs.readFileSync(W + "golden3/set/set.json", "utf8"));
console.log("templates js", Object.keys(set.info.templates), "golden", Object.keys(golden.templates));
console.log("warnings js", set.info.warnings.map((w) => w.slice(0, 90)));
function diff(a, b, path, out, tol = 0.011) {
  if (typeof a === "number" && typeof b === "number") { if (Math.abs(a - b) > tol) out.push(`${path}: ${a} != ${b}`); return; }
  if (Array.isArray(a) && Array.isArray(b)) { if (a.length !== b.length) out.push(`${path}: length ${a.length} != ${b.length}`); for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out, tol); return; }
  if (a && b && typeof a === "object") { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if (k === "h") continue; if (!(k in a)) out.push(`${path}.${k}: missing in js`); else if (!(k in b)) out.push(`${path}.${k}: extra in js`); else diff(a[k], b[k], `${path}.${k}`, out, tol); } return; }
  if (a !== b) out.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
for (const tid of Object.keys(golden.templates)) {
  const out = []; const j = { ...set.info.templates[tid] }, g = { ...golden.templates[tid] };
  for (const k of ["file", "sheet", "logos", "page"]) { delete j[k]; delete g[k]; }
  diff(j, g, tid, out); console.log(tid.padEnd(6), out.length ? out.length + " differences: " + out.slice(0, 5).join(" | ") : "identical");
}
