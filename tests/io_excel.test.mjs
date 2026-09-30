import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { readIoExcel } from "../web/js/core/io_excel.js";
import { makeXlsx, fakeSet } from "./fixtures.mjs";

const HEAD = ["MODULE NAME", "CHANNEL", "CHANNEL NAME", "DESCRIPTION", "TB1", "TB2"];

test("modules are found by MODULE NAME and their texts are set by column name", async () => {
  const data = await makeXlsx([HEAD, ["C1L1AI01", 1, "80-PT36", "TANK PRESSURE", 1, 2], ["C1L1AI01", 2, "SPARE", "SPARE", 3, 4], ["C1L1AI02", 1, "80-TT01", "TEMP", 1, 2]]);
  const res = await readIoExcel(JSZip, data, "x.xlsx", fakeSet());
  assert.equal(res.mode, "module");
  assert.equal(res.modules.length, 2);
  assert.equal(res.counts.AI.sheets, 2);
  const s = res.modules[0].sheets[0];
  assert.equal(s.texts.M1, "MODULE NAME: C1L1AI01");
  assert.equal(s.texts.G1, "80-PT36");
  assert.equal(s.texts.D1, "TANK PRESSURE");
  assert.equal(s.texts.G2, "SPARE");
  assert.equal(s.texts.S1, "1");
  assert.equal(s.texts.S2, "3");
  assert.equal(res.modules[0].used, 1);
  assert.equal(res.modules[0].spare, 1);
});

test("yellow rows start a new module", async () => {
  const data = await makeXlsx([HEAD, ["C1L1AI01", 1, "A", "a", 1, 2], ["C1L1AI01", 2, "B", "b", 3, 4], ["C1L1AI01", 1, "C", "c", 1, 2]], [4]);
  const res = await readIoExcel(JSZip, data, "x.xlsx", fakeSet());
  assert.equal(res.mode, "yellow");
  assert.deepEqual(res.yellowRows, [4]);
  assert.equal(res.modules.length, 2);
});

test("a workbook without MODULE NAME / CHANNEL is refused", async () => {
  await assert.rejects(readIoExcel(JSZip, await makeXlsx([["A", "B"], [1, 2]]), "x.xlsx", fakeSet()), /MODULE NAME/);
  await assert.rejects(readIoExcel(JSZip, new Uint8Array([1, 2, 3]), "x.xlsx", fakeSet()), /not a readable/);
});

test("other workbook layouts: TAG NO / SERVICE / I/O TYPE, channels 'CH01', modules told apart by rack + slot", async () => {
  const head = ["RACK", "SLOT", "CH NO", "TAG NO", "SERVICE", "I/O TYPE"];
  const data = await makeXlsx([["IO LIST"], head, [1, 3, "CH01", "FT-101", "FLOW", "AI HART"], [1, 3, "CH-02", "FT-102", "FLOW 2", "Analog Input"], [1, 4, 1, "PT-1", "P", "A.I."]]);
  const res = await readIoExcel(JSZip, data, "x.xlsx", fakeSet());
  assert.equal(res.headerRow, 2);
  assert.equal(res.modules.length, 2);
  assert.deepEqual(res.modules.map((m) => m.module), ["RACK 1 SLOT 3", "RACK 1 SLOT 4"]);
  assert.deepEqual(res.modules.map((m) => m.type), ["AI", "AI"]);
  const s = res.modules[0].sheets[0];
  assert.equal(s.texts.G1, "FT-101");
  assert.equal(s.texts.G2, "FT-102");
  assert.equal(s.texts.D2, "FLOW 2");
  assert.equal(s.texts.M1, "MODULE NAME: XXX"); // no MODULE NAME column: the template text stays
  assert.equal(s.texts.T1, "IO TYPE : AI");
});

test("channels counted from 0 in the workbook go onto CH1.. of the template", async () => {
  const data = await makeXlsx([HEAD, ["C1L1AI01", 0, "A", "a", 1, 2], ["C1L1AI01", 1, "B", "b", 3, 4]]);
  const res = await readIoExcel(JSZip, data, "x.xlsx", fakeSet());
  const s = res.modules[0].sheets[0];
  assert.equal(s.texts.G1, "A");
  assert.equal(s.texts.G2, "B");
  assert.ok(res.warnings.some((w) => /counted from 0/.test(w)));
});

test("more channels than the template draws: the template is drawn again with its channel labels renumbered", async () => {
  const set = fakeSet();
  set.templates.AI.chlabels = [{ h: "C1", t: "CH01", prefix: "CH", pad: 2, ch: 1 }, { h: "C2", t: "CH02", prefix: "CH", pad: 2, ch: 2 }];
  const data = await makeXlsx([HEAD, ["C1L1AI01", 1, "A", "a", 1, 2], ["C1L1AI01", 2, "B", "b", 3, 4], ["C1L1AI01", 3, "C", "c", 5, 6]]);
  const res = await readIoExcel(JSZip, data, "x.xlsx", set);
  const [p1, p2] = res.modules[0].sheets;
  assert.equal(res.modules[0].sheets.length, 2);
  assert.deepEqual([p1.texts.C1, p1.texts.C2, p1.texts.G1], ["CH01", "CH02", "A"]);
  assert.deepEqual([p2.texts.C1, p2.texts.C2, p2.texts.G1, p2.texts.G2, p2.texts.S1], ["CH03", "CH04", "C", "SPARE", "5"]);
  assert.deepEqual([p2.first, p2.last, p2.uid], [3, 4, "AI+2"]);
  assert.equal(res.modules[0].spare, 1);
});

test("bad channel numbers and repeated tags are reported", async () => {
  const data = await makeXlsx([HEAD, ["C1L1AI01", 1, "A", "a", 1, 2], ["C1L1AI01", 1, "B", "b", 3, 4], ["C1L1AI01", "x", "C", "c", 1, 2], ["N", 1, "A", "a", 1, 2]]);
  const res = await readIoExcel(JSZip, data, "x.xlsx", fakeSet());
  const w = res.modules[0].warnings.join(" ");
  assert.match(w, /CHANNEL 1 is repeated \(row 2/);
  assert.match(w, /'x' is not a channel number/);
  assert.ok(res.warnings.some((x) => /A \(rows 2, 5\)/.test(x)));
});

test("channel numbers and IO types are read from the usual spellings", async () => {
  const { parseChannel, canonType } = await import("../web/js/core/io_excel.js");
  assert.deepEqual([5, "05", "5.0", "CH5", "CH-05", "CHNL 5", "R1-S2-CH5", "", "A5", "5A"].map(parseChannel), [5, 5, 5, 5, 5, 5, 5, null, null, null]);
  assert.deepEqual(["AI", "A.I.", "AI HART", "Analog Input", "DI-24VDC", "DIGITAL OUTPUT", "RTD/TC", "HART"].map((t) => canonType(t)), ["AI", "AI", "AI", "AI", "DI", "DO", "RTD", ""]);
});

/** A set whose only AI template draws one channel per sheet. */
function perChannelSet() {
  const s = fakeSet(), t = s.templates.AI;
  t.channels = [1]; t.perChannel = true; t.chlabels = [];
  t.header.chlabel = { h: "C0", t: "CH1", x: 0, y: 0, s: 10, ha: 0, va: 0, prefix: "CH", pad: 0, w: 60 };
  t.tags = [t.tags[0]]; t.descs = [t.descs[0]]; t.terms = [t.terms[0]];
  return s;
}

test("one sheet per channel: a channel the workbook has no row for still gets its sheet, so no number is skipped", async () => {
  const data = await makeXlsx([HEAD, ["C1L1AI01", 1, "A", "a", 1, 2], ["C1L1AI01", 2, "B", "b", 3, 4], ["C1L1AI01", 4, "D", "d", 7, 8]]);
  const res = await readIoExcel(JSZip, data, "x.xlsx", perChannelSet());
  const sh = res.modules[0].sheets;
  assert.deepEqual(sh.map((s) => s.first), [1, 2, 3, 4]);
  assert.deepEqual(sh.map((s) => s.texts.C0), ["CH1", "CH2", "CH3", "CH4"]);
  assert.deepEqual(sh.map((s) => s.texts.G1), ["A", "B", "SPARE", "D"]);
  assert.deepEqual([res.modules[0].used, res.modules[0].spare], [3, 1]);
});

test("one sheet per channel: a channel above the 16 a module usually has is drawn, not dropped", async () => {
  const data = await makeXlsx([HEAD, ["C1L1AI01", 1, "A", "a", 1, 2], ["C1L1AI01", 20, "T", "t", 5, 6]]);
  const res = await readIoExcel(JSZip, data, "x.xlsx", perChannelSet());
  const sh = res.modules[0].sheets;
  assert.equal(sh.length, 20);
  assert.deepEqual([sh[0].first, sh[19].first], [1, 20]);
  assert.equal(sh[19].texts.G1, "T");
  assert.equal(res.modules[0].warnings.filter((w) => /skipped|outside/.test(w)).length, 0);
});

test("a template that draws its channel labels bottom up still fills and names its sheet by channel", async () => {
  const set = fakeSet(), t = set.templates.AI;
  t.channels = [2, 1]; // CH2 drawn above CH1
  t.tags = [t.tags[0], t.tags[1]]; t.descs = [t.descs[0], t.descs[1]];
  t.terms = [{ ...t.terms[0], ch: 2 }, { ...t.terms[1], ch: 1 }];
  const data = await makeXlsx([HEAD, ["C1L1AI01", 1, "A", "a", 1, 2], ["C1L1AI01", 2, "B", "b", 3, 4]]);
  const res = await readIoExcel(JSZip, data, "x.xlsx", set);
  const s = res.modules[0].sheets[0];
  assert.deepEqual([s.first, s.last], [1, 2]);
  assert.deepEqual([s.texts.G1, s.texts.G2], ["B", "A"]); // tags[0] is the box of CH2
  assert.deepEqual([s.texts.S1, s.texts.S2], ["3", "1"]);
});

test("the templates of a type that skip a channel range are reported instead of drawing the wrong channel", async () => {
  const set = fakeSet();
  set.templates.AI.channels = [1, 2];
  set.templates.AI2 = { ...set.templates.AI, file: "AI2.dwg", channels: [5, 6] };
  const data = await makeXlsx([HEAD, ["C1L1AI01", 1, "A", "a", 1, 2], ["C1L1AI01", 5, "E", "e", 9, 10]]);
  const res = await readIoExcel(JSZip, data, "x.xlsx", set);
  assert.ok(res.modules[0].warnings.some((w) => /not CH3, CH4/.test(w)), res.modules[0].warnings.join(" | "));
  assert.deepEqual(res.modules[0].sheets.map((s) => [s.first, s.last]), [[1, 2], [5, 6]]);
});

test("a repeated sheet goes on counting the template's terminal numbers when the workbook has no column for them", async () => {
  const set = fakeSet();
  set.templates.AI.chlabels = [{ h: "C1", t: "CH1", prefix: "CH", pad: 0, ch: 1 }, { h: "C2", t: "CH2", prefix: "CH", pad: 0, ch: 2 }];
  const head = ["MODULE NAME", "CHANNEL", "CHANNEL NAME", "DESCRIPTION"]; // no TB1 / TB2 columns
  const data = await makeXlsx([head, ["C1L1AI01", 1, "A", "a"], ["C1L1AI01", 2, "B", "b"], ["C1L1AI01", 3, "C", "c"], ["C1L1AI01", 4, "D", "d"]]);
  const res = await readIoExcel(JSZip, data, "x.xlsx", set);
  const [p1, p2] = res.modules[0].sheets;
  assert.deepEqual([p1.texts.S1, p1.texts.S2], ["1", "2"]); // as the template draws them
  assert.deepEqual([p2.texts.C1, p2.texts.C2, p2.texts.S1, p2.texts.S2], ["CH3", "CH4", "3", "4"]); // CH3-4: the column goes on
  assert.ok(res.warnings.some((w) => /go on counting/.test(w)));
});
