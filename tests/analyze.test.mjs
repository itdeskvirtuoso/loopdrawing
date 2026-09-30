import test from "node:test";
import assert from "node:assert/strict";
import { parseDxf } from "../web/js/core/dxf.js";
import { analyze } from "../web/js/core/analyze.js";

/** A drawing of TEXT entities only: [[text, x, y], ...] */
function textDoc(texts) {
  let h = 0x100;
  const ents = texts.flatMap(([t, x, y]) => ["0", "TEXT", "5", (h++).toString(16).toUpperCase(), "8", "0", "10", String(x), "20", String(y), "30", "0.0", "40", "10.0", "1", t]);
  const pairs = ["0", "SECTION", "2", "HEADER", "9", "$HANDSEED", "5", "FFFF", "0", "ENDSEC", "0", "SECTION", "2", "TABLES", "0", "ENDSEC",
    "0", "SECTION", "2", "BLOCKS", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES", ...ents, "0", "ENDSEC", "0", "EOF"];
  return parseDxf(pairs.join("\n") + "\n");
}

test("a template with 'CH 01', 'TAG NO:' and 'SERVICE:' labels is read; its channel labels can be renumbered", () => {
  const texts = [["MODULE NAME: XXXX", 100, 1500], ["IOP : XXXX", 100, 1450]];
  for (let i = 0; i < 4; i++) {
    const y = 1200 - i * 200;
    texts.push([`CH ${String(i + 1).padStart(2, "0")}`, 100, y], ["TAG NO:", 900, y], ["SERVICE:", 900, y - 40]);
  }
  const t = analyze(textDoc(texts), "X", null, [0, 0, 2000, 1600], "AI");
  assert.deepEqual(t.channels, [1, 2, 3, 4]);
  assert.equal(t.tags.length, 4);
  assert.equal(t.descs.length, 4);
  assert.deepEqual(t.chlabels.map((f) => [f.prefix, f.pad, f.ch]), [["CH ", 2, 1], ["CH ", 2, 2], ["CH ", 2, 3], ["CH ", 2, 4]]);
});

test("a template with two columns of channels: every FIELD TAG / DESCRIPTION belongs to the channel next to it", () => {
  const texts = [["MODULE NAME: XXXX", 100, 1500], ["IOP : XXXX", 100, 1450]];
  for (let i = 0; i < 4; i++) { // CH1-4 on the left, CH5-8 on the right, four rows
    const y = 1200 - i * 200;
    texts.push([`CH${i + 1}`, 100, y], ["FIELD TAG:", 300, y], ["DESCRIPTION:", 300, y - 40]);
    texts.push([`CH${i + 5}`, 1100, y], ["FIELD TAG:", 1300, y], ["DESCRIPTION:", 1300, y - 40]);
  }
  const t = analyze(textDoc(texts), "X", null, [0, 0, 2000, 1600], "AI");
  assert.deepEqual(t.channels, [1, 5, 2, 6, 3, 7, 4, 8]);
  // the tag / description of a channel is the one in its own column, not the first one on the row
  assert.deepEqual(t.channels.map((ch, i) => [ch, t.tags[i].x, t.descs[i].x]),
    [[1, 300, 300], [5, 1300, 1300], [2, 300, 300], [6, 1300, 1300], [3, 300, 300], [7, 1300, 1300], [4, 300, 300], [8, 1300, 1300]]);
});

test("a channel label drawn twice is not a broken template: the channel exists once, both labels are renumbered", () => {
  const texts = [["MODULE NAME: XXXX", 100, 1500]];
  for (let i = 0; i < 4; i++) {
    const y = 1200 - i * 200;
    texts.push([`CH${i + 1}`, 100, y], ["FIELD TAG:", 900, y], ["DESCRIPTION:", 900, y - 40]);
  }
  texts.push(["CH1", 1500, 300]); // the same label again, at the field device
  const t = analyze(textDoc(texts), "X", null, [0, 0, 2000, 1600], "AI");
  assert.deepEqual(t.channels, [1, 2, 3, 4]);
  assert.deepEqual(t.chlabels.map((f) => f.ch), [1, 2, 3, 4, 1]);
  assert.ok(t.warnings.some((w) => /drawn more than once/.test(w)));
});
