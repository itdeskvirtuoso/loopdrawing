import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import opentype from "opentype.js";
import { TextEngine, textAlignment, anchorOf, plainText } from "../web/js/core/text.js";
import { encodeCp1252 } from "../web/js/core/libredwg.js";
import { textFit } from "../web/js/core/pdfexport.js";

const b = fs.readFileSync("web/fonts/LiberationSans-Regular.ttf");
const engine = new TextEngine(opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));

test("text width is the Arial advance width scaled to the cap height", () => {
  // 'DIGITAL OUTPUT' is 8278.3 / 1000 em wide in Arial; a cap height of 10 is 10 / 0.7158 em
  assert.ok(Math.abs(engine.width("DIGITAL OUTPUT", 10) - (8278.3 / 1000) * (10 / (1466 / 2048))) < 0.1);
});

test("alignment anchors: baseline, middle, top, bottom", () => {
  assert.deepEqual(textAlignment(1, 2), [1, "mid"]);
  assert.deepEqual(textAlignment(4, 0), [1, "mid"]);
  const [ax, ay] = anchorOf(1, "mid", 100, 10);
  assert.equal(ax, 50);
  assert.equal(ay, -5);
  assert.equal(anchorOf(0, "top", 30, 10)[1], 0);
  assert.ok(anchorOf(2, "bottom", 30, 10)[1] < -10);
});

test("glyph outlines exist for letters and the (R) / superscript 2 characters", () => {
  for (const s of ["A", "®", "²"]) assert.ok(engine.path(s, 10).length > 3, s);
});

test("% codes and the DWG code page", () => {
  assert.equal(plainText("45%%d %%p1"), "45° ±1");
  const b2 = encodeCp1252("mm² B-SCP® € 中");
  assert.equal(b2[2], 0xb2);
  assert.equal(b2[9], 0xae);
  assert.equal(b2[11], 0x80);
  assert.equal(Buffer.from(b2).toString("latin1").slice(-7), "\\U+4E2D");
});

test("a text that does not fit is squeezed to its room, never below 60 %", () => {
  const info = { s: 10, w: 40 };
  const [sx, sh] = textFit(engine, "MASSECUITE TRANSFER PUMP-1 MOTOR START/STOP", info);
  assert.equal(sx, 0.6);
  assert.ok(sh < 1);
  assert.deepEqual(textFit(engine, "AB", info), [1, 1]);
  assert.deepEqual(textFit(engine, "", info), [1, 1]);
});
