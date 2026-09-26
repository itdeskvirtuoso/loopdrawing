import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dwgToDxf, dxfToDwg, encodeCp1252 } from "../../web/js/core/libredwg.js";
import { parseDxf } from "../../web/js/core/dxf.js";

test("cp1252 encoding: (R) and superscript 2 are one byte, other characters use the AutoCAD escape", () => {
  const b = encodeCp1252("mm\u00b2 B-SCP\u00ae \u20ac \u4e2d");
  assert.deepEqual([...b].slice(0, 4), [109, 109, 0xb2, 32]);
  assert.equal(b[9], 0xae); assert.equal(b[11], 0x80);
  assert.equal(Buffer.from(b).toString("latin1").slice(-6), "\U+4E2D");
});

test("DWG -> DXF -> DWG in WebAssembly", async () => {
  const dwg = fs.readFileSync("C:/Users/Hitesh ingale/Downloads/DO.dwg");
  const dxf = await dwgToDxf(dwg);
  const doc = parseDxf(dxf);
  assert.ok(doc.msp.length > 100);
  const back = await dxfToDwg(dxf);
  assert.equal(String.fromCharCode(...back.subarray(0, 6)), "AC1015");
  const again = parseDxf(await dwgToDxf(back));
  assert.equal(again.msp.length, doc.msp.length);
});
