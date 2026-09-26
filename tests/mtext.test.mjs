import test from "node:test";
import assert from "node:assert/strict";
import { parseMText, mtextPlain } from "../web/js/core/mtext.js";

const base = { cap: 10, wf: 1, oblique: 0, align: 0 };

test("plain text: paragraphs, escapes, unicode, groups", () => {
  assert.equal(mtextPlain("A\\PB"), "A\nB");
  assert.equal(mtextPlain("{\\H0.7x;small} big"), "small big");
  assert.equal(mtextPlain("\\U+00B2 \\\\ \\{"), "² \\ {");
  assert.equal(mtextPlain("\\A1;0.75mm\\S2^;"), "0.75mm2");
});

test("height, width factor and paragraph alignment codes", () => {
  const p = parseMText("\\pxqc;{\\H2x;\\W0.5;AB} CD", base);
  assert.equal(p.paragraphs[0].align, 1);
  const w = p.paragraphs[0].words;
  assert.equal(w[0].cap, 20);
  assert.equal(w[0].wf, 0.5);
  assert.equal(w[2].cap, 10); // the group ended
  assert.equal(w[2].wf, 1);
});
