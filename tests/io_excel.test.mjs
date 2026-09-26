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
  const data = await makeXlsx([HEAD, ["M", 1, "A", "a", 1, 2], ["M", 2, "B", "b", 3, 4], ["M", 1, "C", "c", 1, 2]], [4]);
  const res = await readIoExcel(JSZip, data, "x.xlsx", fakeSet());
  assert.equal(res.mode, "yellow");
  assert.deepEqual(res.yellowRows, [4]);
  assert.equal(res.modules.length, 2);
});

test("a workbook without MODULE NAME / CHANNEL is refused", async () => {
  await assert.rejects(readIoExcel(JSZip, await makeXlsx([["A", "B"], [1, 2]]), "x.xlsx", fakeSet()), /MODULE NAME/);
  await assert.rejects(readIoExcel(JSZip, new Uint8Array([1, 2, 3]), "x.xlsx", fakeSet()), /not a readable/);
});
