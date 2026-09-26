import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseDxf, writeDxf } from "../../web/js/core/dxf.js";

const W = "C:/Users/Hitesh ingale/Desktop/wasm-build/";
test("parse + write keeps every group code pair (LibreDWG DXF)", () => {
  const src = fs.readFileSync(W + "out/DO.wasm.dxf", "utf8");
  const doc = parseDxf(src);
  const back = writeDxf(doc);
  const norm = (t) => t.replace(/\r/g, "").split("\n").map((l) => l.trim());
  const a = norm(src).filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
  const b = norm(back).filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
  assert.equal(b.length, a.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) assert.fail(`line ${i}: '${a[i]}' vs '${b[i]}'`);
  console.log("sections", doc.order.join(","), "| msp", doc.msp.length, "| blocks", [...doc.blocks.keys()].join("; "), "| tables", doc.tables.map((t) => t.name).join(","));
});

test("parse the ezdxf template of the golden set", () => {
  const doc = parseDxf(fs.readFileSync(W + "golden/set/DO.dxf", "utf8"));
  const c = {};
  doc.msp.forEach((e) => (c[e.type] = (c[e.type] || 0) + 1));
  console.log("golden DO.dxf msp", c, "EXTMIN", doc.headerPoint("$EXTMIN"));
  assert.equal(c.TEXT, 79); assert.equal(c.LWPOLYLINE, 34); assert.equal(c.LINE, 24);
  assert.equal(doc.blocks.get("SIEV TITEL SHEET").ents.length, 201);
});
