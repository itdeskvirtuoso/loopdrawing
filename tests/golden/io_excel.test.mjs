import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import JSZip from "jszip";
import { readIoExcel } from "../../web/js/core/io_excel.js";

const W = "C:/Users/Hitesh ingale/Desktop/wasm-build/golden/";
test("the IO ASSIGNMENT workbook gives the same modules, sheets and texts as the Python reader", async () => {
  const set = JSON.parse(fs.readFileSync(W + "set/set.json", "utf8"));
  const golden = JSON.parse(fs.readFileSync(W + "io.json", "utf8"));
  const t0 = Date.now();
  const res = await readIoExcel(JSZip, fs.readFileSync("C:/Users/Hitesh ingale/Downloads/DO.xlsx"), "DO.xlsx", set);
  console.log("read in", Date.now() - t0, "ms;", res.modules.length, "modules", res.dataRows, "rows");
  const bad = [];
  for (const k of ["file", "sheet", "headerRow", "mode", "dataRows", "yellowRows", "counts", "warnings", "needs", "set", "setBuilt", "columns"]) {
    try { assert.deepEqual(res[k], golden[k]); } catch (e) { bad.push(k + ": " + JSON.stringify(res[k]).slice(0, 200) + " vs " + JSON.stringify(golden[k]).slice(0, 200)); }
  }
  assert.equal(res.modules.length, golden.modules.length);
  res.modules.forEach((m, i) => {
    const g = golden.modules[i];
    const a = { ...m, sheets: undefined }, b = { ...g, sheets: undefined };
    try { assert.deepEqual(a, b); } catch (e) { bad.push(`module ${m.module}: ${e.message.split("\n").slice(0, 8).join(" ")}`); }
    assert.equal(m.sheets.length, g.sheets.length, m.module);
    m.sheets.forEach((sh, j) => { try { assert.deepEqual(sh, g.sheets[j]); } catch (e) { bad.push(`sheet ${m.module}/${j}: ` + e.message.split("\n").filter((l) => /^[+-]/.test(l)).slice(0, 6).join(" ")); } });
  });
  if (bad.length) console.log(bad.slice(0, 12).join("\n"), "\n total differences:", bad.length);
  assert.equal(bad.length, 0);
});
