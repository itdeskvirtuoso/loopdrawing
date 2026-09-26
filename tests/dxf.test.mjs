import test from "node:test";
import assert from "node:assert/strict";
import { parseDxf, writeDxf } from "../web/js/core/dxf.js";
import { SAMPLE_DXF, sampleDoc } from "./fixtures.mjs";

test("a DXF is read into sections, tables, blocks and entities", () => {
  const d = sampleDoc();
  assert.deepEqual(d.order, ["HEADER", "TABLES", "BLOCKS", "ENTITIES", "OBJECTS"]);
  assert.equal(d.layers().length, 1);
  assert.equal(d.style("standard").get(3), "arial.ttf");
  assert.equal(d.blocks.get("B1").ents.length, 1);
  assert.deepEqual(d.msp.map((e) => e.type), ["INSERT", "TEXT", "LWPOLYLINE", "CIRCLE"]);
  assert.equal(d.entityByHandle("31").get(1), "HELLO");
  assert.equal(d.headerPoint("$EXTMIN").x, 0);
});

test("writing gives back every group code pair", () => {
  const norm = (t) => t.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter((l, i, a) => !(i === a.length - 1 && l === ""));
  assert.deepEqual(norm(writeDxf(parseDxf(SAMPLE_DXF))), norm(SAMPLE_DXF));
});

test("new handles are above every handle and $HANDSEED follows", () => {
  const d = sampleDoc();
  const h = d.newHandle();
  assert.equal(parseInt(h, 16), 0x100); // $HANDSEED is 100 (hex): the next free handle
  d.syncHandseed();
  assert.ok(parseInt(d.headerVar("$HANDSEED")[0][1], 16) > 0x100);
});

test("editing an entity changes only that entity", () => {
  const d = sampleDoc();
  d.entityByHandle("31").set(1, "WORLD");
  assert.ok(writeDxf(d).includes("WORLD"));
  assert.ok(!writeDxf(d).includes("HELLO"));
});
