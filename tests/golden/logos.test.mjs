import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import CFB from "cfb";
import { dwgToDxf } from "../../web/js/core/libredwg.js";
import { parseDxf } from "../../web/js/core/dxf.js";
import { findLogos } from "../../web/js/core/logos.js";

test("the MATRIX logo of the frame is found: place and picture", async () => {
  const doc = parseDxf(await dwgToDxf(fs.readFileSync("C:/Users/Hitesh ingale/Downloads/DO.dwg")));
  const warn = [];
  const logos = await findLogos(doc, CFB, warn);
  assert.deepEqual(warn, []);
  assert.equal(logos.length, 1);
  const [x0, y0, x1, y1] = [6.18, 5.98, 4135.57, 2948.58], s = 1683.78 / (y1 - y0);
  const [a, b, c, d] = logos[0].rect;
  // pymupdf coordinates of the golden logo: (1281.108, 1485.962, 1664.684, 1567.554), y down
  const got = [(a - x0) * s, (y1 - d) * s, (c - x0) * s, (y1 - b) * s];
  console.log("logo rect (pdf pt, y down)", got.map((v) => v.toFixed(2)).join(" "), "png bytes", logos[0].png.length);
  [1281.108, 1485.962, 1664.684, 1567.554].forEach((v, i) => assert.ok(Math.abs(got[i] - v) < 0.2, `edge ${i}: ${got[i]} vs ${v}`));
  fs.writeFileSync("C:/Users/Hitesh ingale/Desktop/wasm-build/out/logo_js.png", logos[0].png);
});
