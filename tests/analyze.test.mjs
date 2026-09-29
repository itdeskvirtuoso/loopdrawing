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
