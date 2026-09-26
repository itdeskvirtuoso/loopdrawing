import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import opentype from "opentype.js";
import { TextEngine } from "../web/js/core/text.js";
import { buildDisplay } from "../web/js/core/render.js";
import { pdfContent, svgSheet, pageSize } from "../web/js/core/output.js";
import { sampleDoc } from "./fixtures.mjs";

const b = fs.readFileSync("web/fonts/LiberationSans-Regular.ttf");
const engine = new TextEngine(opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
const bounds = (cmds) => {
  const xs = [], ys = [];
  for (const c of cmds) if (c.p) for (let i = 0; i < c.p.length; i += 2) { xs.push(c.p[i]); ys.push(c.p[i + 1]); }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

test("the sample drawing is drawn: lines, polygon, circle, block with a mirrored scale, text", () => {
  const disp = buildDisplay(sampleDoc(), { engine });
  assert.equal(disp.errors || 0, 0);
  assert.equal(disp.strokes.length, 3); // the block line, the polyline, the circle
  assert.ok(disp.fills.length >= 1);    // the text
  // INSERT at (100, 50) with x scale -2, y scale 2: the line (0,0)-(10,0) runs from (100,50) to (80,50)
  assert.deepEqual(disp.strokes[0].map((c) => c.p.map((v) => Math.round(v))), [[100, 50], [80, 50]]);
  const poly = disp.strokes[1];
  assert.equal(poly[poly.length - 1].t, "Z");
});

test("a text with center alignment is centred on its alignment point", () => {
  const disp = buildDisplay(sampleDoc(), { engine });
  const [x0, , x1] = bounds(disp.fills[0].cmds);
  assert.ok(Math.abs((x0 + x1) / 2 - 50) < 2, `${x0} ${x1}`);
});

test("a blanked text is not drawn; the page is the frame box at A1 height", () => {
  const disp = buildDisplay(sampleDoc(), { engine, blank: new Set(["31"]) });
  assert.equal(disp.fills.length, 0);
  const [w, h] = pageSize([0, 0, 1000, 700]);
  assert.equal(h, 1683.78);
  assert.ok(Math.abs(w - (1683.78 * 1000) / 700) < 1e-6);
  assert.ok(pdfContent(disp, [0, 0, 1000, 700]).includes("S"));
  assert.ok(svgSheet(disp, [0, 0, 1000, 700]).startsWith("<svg"));
});
