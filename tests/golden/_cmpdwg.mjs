// Compares the DWG files of the Python program (golden) with those of the JS program: the drawing content read back from both.
import fs from "node:fs";
import { dwgToDxf } from "../../web/js/core/libredwg.js";
import { parseDxf } from "../../web/js/core/dxf.js";
const W = "C:/Users/Hitesh ingale/Desktop/wasm-build/";
const r = (v) => (Math.round(v * 100) / 100).toFixed(2);
async function sig(file) {
  const doc = parseDxf(await dwgToDxf(new Uint8Array(fs.readFileSync(file))));
  const out = new Map(), add = (k) => out.set(k, (out.get(k) || 0) + 1);
  const each = (ents, where) => {
    for (const e of ents) {
      if (e.type === "TEXT") {
        const ha = e.int(72, 0), va = e.int(73, 0), p = ha || va ? e.point(11, 21, 31) : e.point(10, 20, 30);
        add(`TEXT ${where} '${e.get(1, "")}' at ${r(p.x)},${r(p.y)} h${r(e.num(40))} w${r(e.num(41, 1))} rot${r(e.num(50, 0))} ha${ha} va${va} ${e.get(7)}`);
      } else if (e.type === "LINE") add(`LINE ${where} ${r(e.num(10))},${r(e.num(20))}-${r(e.num(11))},${r(e.num(21))}`.replace(/(-?\d+\.\d\d),(-?\d+\.\d\d)-(-?\d+\.\d\d),(-?\d+\.\d\d)/, (m, a, b, c, d) => (a + b < c + d ? m : `${c},${d}-${a},${b}`)));
      else if (e.type === "LWPOLYLINE") { const xs = e.pairs.filter((p) => p[0] === 10).map((p) => parseFloat(p[1])), ys = e.pairs.filter((p) => p[0] === 20).map((p) => parseFloat(p[1])); add(`LWPOLY ${where} n${xs.length} ${r(Math.min(...xs))},${r(Math.min(...ys))}-${r(Math.max(...xs))},${r(Math.max(...ys))} cw${r(e.num(43, 0))}`); }
      else if (e.type === "CIRCLE") add(`CIRCLE ${where} ${r(e.num(10))},${r(e.num(20))} r${r(e.num(40))}`);
      else if (e.type === "ARC") add(`ARC ${where} ${r(e.num(10))},${r(e.num(20))} r${r(e.num(40))} ${r(e.num(50))}-${r(e.num(51))}`);
      else if (e.type === "ELLIPSE") add(`ELLIPSE ${where} ${r(e.num(10))},${r(e.num(20))}`);
      else add(`${e.type} ${where}`);
    }
  };
  each(doc.msp, "MS");
  for (const b of doc.blocks.values()) if (!b.isLayout) each(b.ents, "B:" + b.name);
  return out;
}
const pick = JSON.parse(fs.readFileSync(W + "golden/dwg_sample.json", "utf8"));
const gfiles = fs.readdirSync(W + "golden/dwg").sort(), jfiles = fs.readdirSync(W + "out/js/dwg").sort();
let totalDiff = 0;
for (let i = 0; i < gfiles.length; i++) {
  const a = await sig(W + "golden/dwg/" + gfiles[i]), b = await sig(W + "out/js/dwg/" + jfiles[i]);
  const onlyG = [], onlyJ = [];
  for (const [k, n] of a) if ((b.get(k) || 0) < n) onlyG.push(k);
  for (const [k, n] of b) if ((a.get(k) || 0) < n) onlyJ.push(k);
  totalDiff += onlyG.length + onlyJ.length;
  console.log(gfiles[i].padEnd(34), "golden-only", onlyG.length, "js-only", onlyJ.length);
  if (process.argv[2] && i < +process.argv[2]) { onlyG.slice(0, 12).forEach((k) => console.log("   G", k)); onlyJ.slice(0, 12).forEach((k) => console.log("   J", k)); }
}
console.log("total differences", totalDiff);
