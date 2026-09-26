import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dwgToDxf } from "../../web/js/core/libredwg.js";
import { parseDxf } from "../../web/js/core/dxf.js";
import { analyze, correctLabels, simpleMTextToText, wingdingsToTick, superscriptsToCharacters, dropSortTables, frameExtent } from "../../web/js/core/analyze.js";

const G = "C:/Users/Hitesh ingale/Desktop/wasm-build/golden/set/set.json";
const golden = JSON.parse(fs.readFileSync(G, "utf8"));

async function analyse(name) {
  const doc = parseDxf(await dwgToDxf(fs.readFileSync(`C:/Users/Hitesh ingale/Downloads/${name}.dwg`)));
  dropSortTables(doc); simpleMTextToText(doc); wingdingsToTick(doc); superscriptsToCharacters(doc);
  const own = frameExtent(doc);
  const box = name === "AI" ? own : golden.box; // the box of the first template is used for the whole set
  const info = analyze(doc, name, null, box);
  correctLabels(doc, info);
  return { info, box, doc };
}

// compares two analysis results; `h` (handles) and float noise are reported separately
function diff(a, b, path, out, tol = 0.011) {
  if (typeof a === "number" && typeof b === "number") { if (Math.abs(a - b) > tol) out.push(`${path}: ${a} != ${b}`); return; }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: length ${a.length} != ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out, tol);
    return;
  }
  if (a && b && typeof a === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (k === "h") continue;
      if (!(k in a)) out.push(`${path}.${k}: missing in js (golden ${JSON.stringify(b[k])})`);
      else if (!(k in b)) out.push(`${path}.${k}: extra in js (${JSON.stringify(a[k])})`);
      else diff(a[k], b[k], `${path}.${k}`, out, tol);
    }
    return;
  }
  if (a !== b) out.push(`${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

for (const [name, tid] of [["AI", "AI2W"], ["AO", "AO"], ["DI", "DI"], ["DO", "DO"]]) {
  test(`analysis of ${name}.dwg equals the Python analysis`, async () => {
    const { info, box } = await analyse(name);
    const g = golden.templates[tid];
    assert.deepEqual(box, golden.box);
    const out = [];
    const a = { ...info }, b = { ...g };
    delete b.file; delete b.sheet; delete b.logos; delete b.page;
    diff(a, b, tid, out);
    if (out.length) console.log(out.slice(0, 40).join("\n"), "\n... total", out.length);
    assert.equal(out.length, 0);
  });
}
