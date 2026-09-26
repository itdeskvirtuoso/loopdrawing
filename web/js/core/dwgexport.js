// DXF / DWG of loop drawing sheets: the texts that come from Excel are written into the template drawing at their own TEXT entities
// (same handle, style, layer and alignment as in the template); a DWG (AutoCAD 2000) is made from that DXF by LibreDWG (WebAssembly).
import { Ent, parseDxf, writeDxf } from "./dxf.js";
import { layoutMText, insertMatrix, mulM, apply, IDENT, rotM } from "./render.js";
import { textFit } from "./pdfexport.js";
import { setTextNumber } from "./edit.js";

const PLAIN_GEOMETRY = new Set(["LINE", "LWPOLYLINE", "ARC", "CIRCLE", "ELLIPSE"]);

// ------------------------------------------------------------------------------------------------ making the template writable as DWG
function withOwner(doc, owner, layer, color, type) {
  const e = new Ent(type, [[0, type], [5, doc.newHandle()]]);
  if (owner) e.pairs.push([330, owner]);
  e.pairs.push([100, "AcDbEntity"], [8, layer]);
  if (color !== undefined) e.pairs.push([62, String(color)]);
  return e;
}

/** MTEXT loses its text height in LibreDWG's DXF -> DWG writer: the same lines are written as single line TEXT entities. */
function explodeMText(doc, list, engine) {
  for (const e of [...list]) {
    if (e.type !== "MTEXT") continue;
    const lay = layoutMText(e, engine, doc);
    const at = list.indexOf(e);
    const out = [];
    if (lay) {
      const rot = (lay.rot * Math.PI) / 180, c = Math.cos(rot), s = Math.sin(rot);
      const style = e.get(7, "Standard"), owner = e.get(330, ""), layer = e.layer;
      const color = e.has(62) ? e.int(62) : undefined;
      for (const run of lay.runs) {
        const t = withOwner(doc, owner, layer, color, "TEXT");
        const y = lay.flipY ? -run.y : run.y;
        t.pairs.push([100, "AcDbText"], [10, String(lay.ins.x + run.x * c - y * s)], [20, String(lay.ins.y + run.x * s + y * c)], [30, String(lay.ins.z)],
          [40, String(run.cap)], [1, run.text]);
        if (Math.abs(lay.rot) > 1e-9) t.pairs.push([50, String(lay.rot)]);
        if (Math.abs(run.wf - 1) > 1e-9) t.pairs.push([41, String(run.wf)]);
        t.pairs.push([7, style], [100, "AcDbText"]);
        out.push(t);
      }
    }
    list.splice(at, 1, ...out);
  }
}

/** Blocks of plain geometry are written as loose geometry: LibreDWG's writer does not link the entities of some blocks to their block
 *  (the block opens empty in AutoCAD). The frame (text, logo) stays a block. */
function explodePlainBlocks(doc) {
  const used = new Set();
  const out = [];
  for (const e of doc.msp) {
    if (e.type === "INSERT") {
      const b = doc.block(e.get(2, ""));
      if (b && !b.isXref && b.ents.length && b.ents.every((x) => PLAIN_GEOMETRY.has(x.type))) {
        const m = insertMatrix(e, b);
        const parts = [];
        for (const x of b.ents) { const t = transformEntity(doc, x, m, e); if (!t) { parts.length = 0; break; } parts.push(t); }
        if (parts.length) { out.push(...parts); used.add(b.name); continue; }
      }
    }
    out.push(e);
  }
  doc.msp = out;
  for (const name of used) if (!doc.msp.some((x) => x.type === "INSERT" && x.get(2, "") === name)) doc.blocks.delete(name);
  doc.invalidate();
}

/** A copy of a geometry entity of a block, placed by the insert matrix m (uniform scale, possibly mirrored). Null when not possible. */
function transformEntity(doc, x, m, ins) {
  const a = m[0], b = m[1], c = m[2], d = m[3];
  const sx = Math.hypot(a, b), sy = Math.hypot(c, d), det = a * d - b * c;
  if (Math.abs(sx - sy) > 1e-6 * Math.max(sx, sy)) return null; // not a uniform scale
  const k = sx, mirrored = det < 0;
  const owner = ins.get(330, ""), t = withOwner(doc, owner, x.layer, x.has(62) ? x.int(62) : undefined, x.type);
  const ang = (deg) => { const r = (deg * Math.PI) / 180; return (Math.atan2(b * Math.cos(r) + d * Math.sin(r), a * Math.cos(r) + c * Math.sin(r)) * 180) / Math.PI; };
  const norm = (deg) => ((deg % 360) + 360) % 360;
  const P = (px, py, cx, cy) => { const [X, Y] = apply(m, px, py); return [String(X), String(Y)]; };
  const marker = { LINE: "AcDbLine", LWPOLYLINE: "AcDbPolyline", CIRCLE: "AcDbCircle", ARC: "AcDbCircle", ELLIPSE: "AcDbEllipse" }[x.type];
  t.pairs.push([100, marker]);
  if (x.type === "LINE") {
    const p = P(x.num(10), x.num(20)), q = P(x.num(11), x.num(21));
    t.pairs.push([10, p[0]], [20, p[1]], [30, "0"], [11, q[0]], [21, q[1]], [31, "0"]);
  } else if (x.type === "CIRCLE") {
    const p = P(x.num(10), x.num(20));
    t.pairs.push([10, p[0]], [20, p[1]], [30, "0"], [40, String(x.num(40) * k)]);
  } else if (x.type === "ARC") {
    const p = P(x.num(10), x.num(20));
    let s0 = ang(x.num(50)), s1 = ang(x.num(51));
    if (mirrored) [s0, s1] = [s1, s0]; // a mirrored arc runs the other way round: its start is the old end
    t.pairs.push([10, p[0]], [20, p[1]], [30, "0"], [40, String(x.num(40) * k)], [100, "AcDbArc"], [50, String(norm(s0))], [51, String(norm(s1))]);
  } else if (x.type === "ELLIPSE") {
    const p = P(x.num(10), x.num(20));
    const mj = [a * x.num(11) + c * x.num(21), b * x.num(11) + d * x.num(21)];
    let t0 = x.num(41, 0), t1 = x.num(42, 2 * Math.PI);
    if (mirrored && Math.abs(t1 - t0 - 2 * Math.PI) > 1e-9) return null; // a mirrored part of an ellipse is not made here
    t.pairs.push([10, p[0]], [20, p[1]], [30, "0"], [11, String(mj[0])], [21, String(mj[1])], [31, "0"], [210, "0"], [220, "0"], [230, "1"], [40, String(x.num(40, 1))], [41, String(t0)], [42, String(t1)]);
  } else if (x.type === "LWPOLYLINE") {
    const flag = x.int(70, 0), out = [];
    let count = 0;
    for (const [code, val] of x.pairs) if (code === 10) count++;
    t.pairs.push([90, String(count)], [70, String(flag)]);
    if (x.has(43)) t.pairs.push([43, String(x.num(43) * k)]);
    for (const [code, val] of x.pairs) {
      if (code === 10) { out.pendingX = parseFloat(val); }
      else if (code === 20) { const p = P(out.pendingX, parseFloat(val)); t.pairs.push([10, p[0]], [20, p[1]]); }
      else if (code === 42) t.pairs.push([42, String(mirrored ? -parseFloat(val) : parseFloat(val))]);
      else if (code === 40 || code === 41) t.pairs.push([code, String(parseFloat(val) * k)]);
    }
  } else return null;
  return t;
}

/** Attribute tags with '.' or ':' are dropped by the DWG writer. */
function fixAttributeTags(doc) {
  const fix = (e) => { if (e.type === "ATTDEF" || e.type === "ATTRIB") { const tag = e.get(2); if (tag) e.set(2, tag.toUpperCase().replace(/[^A-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "TAG"); } };
  doc.msp.forEach(fix);
  for (const b of doc.blocks.values()) b.ents.forEach(fix);
}

/** Work around what LibreDWG's DXF -> DWG writer loses, without changing how the sheet looks. */
export function prepareForDwg(doc, engine) {
  explodePlainBlocks(doc);
  explodeMText(doc, doc.msp, engine);
  for (const b of doc.blocks.values()) if (!b.isLayout) explodeMText(doc, b.ents, engine);
  fixAttributeTags(doc);
  doc.invalidate();
}

// ------------------------------------------------------------------------------------------------ one sheet
export class SheetWriter {
  /** dxfText: the template DXF (as the set stores it); tpl: its analysis; forDwg: prepare it for the DWG writer. */
  constructor(dxfText, tpl, engine, forDwg) {
    this.doc = parseDxf(dxfText);
    this.tpl = tpl;
    this.engine = engine;
    if (forDwg) prepareForDwg(this.doc, engine);
    this.fields = new Map();
    for (const f of [...Object.values(tpl.header), ...(tpl.jblines || []), ...(tpl.jbtags || []), ...tpl.tags, ...tpl.descs, ...tpl.terms]) this.fields.set(f.h, f);
    if (tpl.sheetno) this.fields.set(tpl.sheetno.h, tpl.sheetno);
    if (tpl.frameTotal) this.fields.set(tpl.frameTotal.h, tpl.frameTotal);
    this.ents = new Map();
    for (const h of this.fields.keys()) {
      const e = this.doc.entityByHandle(h);
      if (!e || e.type !== "TEXT") throw new Error(`text ${h} not found in the template drawing`);
      this.ents.set(h, e);
    }
    this.doc.syncHandseed();
  }

  /** DXF text of one filled sheet. */
  make(texts, sheet, total) {
    const t = this.tpl, values = { ...texts };
    if (t.sheetno) values[t.sheetno.h] = t.sheetno.fmt.replace("{}", String(sheet).padStart(t.sheetno.digits, "0"));
    if (t.frameTotal) values[t.frameTotal.h] = t.frameTotal.fmt.replace("{}", String(total).padStart(t.frameTotal.digits, "0"));
    const saved = [];
    try {
      for (const [h, value] of Object.entries(values)) {
        const e = this.ents.get(h);
        if (!e) throw new Error(`unknown text ${h}`);
        saved.push([e, e.pairs.map((p) => p.slice())]);
        const [sx, sh] = textFit(this.engine, value, this.fields.get(h));
        e.set(1, value);
        if (sx !== 1) setTextNumber(e, 41, e.num(41, 1) * sx);
        if (sh !== 1) setTextNumber(e, 40, e.num(40, 1) * sh);
      }
      return writeDxf(this.doc);
    } finally {
      for (const [e, pairs] of saved) e.pairs = pairs;
    }
  }
}
