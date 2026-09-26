// Worker of the exports: makes the PDF / DWG / DXF of a part of the sheets (each worker has its own copy of LibreDWG).
import * as PDFLib from "../../vendor/pdf-lib.esm.min.js";
import opentype from "../../vendor/opentype.module.js";
import { TextEngine } from "./text.js";
import { buildPdf } from "./pdfexport.js";
import { SheetWriter } from "./dwgexport.js";
import { dxfToDwg } from "./libredwg.js";

let state = null;

const safe = (s) => String(s).replace(/[\/:*?"<>|]+/g, "_").trim().replace(/^[ .]+|[ .]+$/g, "") || "sheet";
const numbering = (it) => (Number.isInteger(it.sheet) && Number.isInteger(it.total) && it.sheet >= 1 && it.sheet <= it.total ? [it.sheet, it.total] : null);

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.cmd === "init") {
      const buf = await (await fetch(m.fontUrl)).arrayBuffer();
      state = { set: m.set, dxf: m.dxf, blank: m.blank, engine: new TextEngine(opentype.parse(buf)), writers: {} };
      self.postMessage({ id: m.id, ok: true });
    } else if (m.cmd === "pdf") {
      const sheets = m.items.map((it) => ({ tid: it.template, texts: it.texts, numbering: numbering(it) }));
      const bytes = await buildPdf(PDFLib, state.engine, state.set, state.blank, sheets, m.title || "Loop drawings");
      self.postMessage({ id: m.id, files: [{ name: `${m.stem}.pdf`, bytes }] }, [bytes.buffer]);
    } else if (m.cmd === "cad") {
      const files = [];
      const dwg = m.kind === "dwg";
      for (const [k, it] of m.items.entries()) {
        const key = it.template + (dwg ? "/dwg" : "/dxf");
        const w = (state.writers[key] ||= new SheetWriter(state.dxf[it.template], state.set.templates[it.template], state.engine, dwg));
        const n = numbering(it) || [k + 1, m.items.length];
        const dxf = w.make(it.texts, n[0], n[1]);
        const bytes = dwg ? await dxfToDwg(dxf) : new TextEncoder().encode(dxf);
        files.push({ name: `${safe(it.name || `sheet ${String(k + 1).padStart(6, "0")}`)}.${m.kind}`, bytes });
      }
      self.postMessage({ id: m.id, files }, files.map((f) => f.bytes.buffer));
    }
  } catch (e) {
    self.postMessage({ id: m.id, error: e && e.message ? e.message : String(e) });
  }
};
