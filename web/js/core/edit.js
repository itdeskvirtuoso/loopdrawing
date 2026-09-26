// Small edits of a Dxf: new TEXT / LINE / CIRCLE / LWPOLYLINE entities, text placement, MTEXT strings.
import { Ent } from "./dxf.js";
import { mtextPlain } from "./mtext.js";

export const CHAR_W = 0.77; // average character width / cap height (Arial), only used to estimate label centres

export const r2 = (v) => {
  const s = Number(v) * 100, f = Math.floor(s), d = s - f;
  if (d === 0.5) return (f % 2 === 0 ? f : f + 1) / 100; // Python's round(): halves go to the even neighbour
  return Math.round(s) / 100;
};

/** Text of a TEXT entity. */
export const textOf = (e) => e.get(1, "");

export function mtextString(e) { return e.getAll(3).join("") + e.get(1, ""); }
export function mtextPlainText(e) { return mtextPlain(mtextString(e)); }
export function setMTextString(e, s) {
  e.pairs = e.pairs.filter((p) => p[0] !== 3);
  const i = e.pairs.findIndex((p) => p[0] === 1);
  const chunks = [];
  let rest = s;
  while (rest.length > 250) { chunks.push([3, rest.slice(0, 250)]); rest = rest.slice(250); }
  const pairs = [...chunks, [1, rest]];
  if (i >= 0) e.pairs.splice(i, 1, ...pairs); else e.pairs.push(...pairs);
}

/** Owner handle (group 330) the entities of model space carry. */
export function mspOwner(doc) {
  for (const e of doc.msp) { const o = e.get(330); if (o) return o; }
  const b = doc.blocks.get("*Model_Space");
  return b ? b.begin.get(330, "") : "";
}

function base(doc, type, layer, extra = {}) {
  const e = new Ent(type, [[0, type], [5, doc.newHandle()]]);
  const owner = extra.owner || mspOwner(doc);
  if (owner) e.pairs.push([330, owner]);
  e.pairs.push([100, "AcDbEntity"], [8, layer || "0"]);
  if (extra.color !== undefined && extra.color !== 256) e.pairs.push([62, String(extra.color)]);
  return e;
}

/** A new TEXT entity in model space. attrs: {layer, style, color, width}. */
export function newText(doc, text, height, attrs = {}) {
  const e = base(doc, "TEXT", attrs.layer, attrs);
  e.pairs.push([100, "AcDbText"], [10, "0"], [20, "0"], [30, "0"], [40, String(height)], [1, text]);
  if (attrs.width !== undefined && attrs.width !== 1) e.pairs.push([41, String(attrs.width)]);
  e.pairs.push([7, attrs.style || "Standard"], [100, "AcDbText"]);
  doc.msp.push(e);
  return e;
}

export function newLine(doc, a, b, layer) {
  const e = base(doc, "LINE", layer);
  e.pairs.push([100, "AcDbLine"], [10, String(a[0])], [20, String(a[1])], [30, "0"], [11, String(b[0])], [21, String(b[1])], [31, "0"]);
  doc.msp.push(e);
  return e;
}

export function newCircle(doc, c, r, layer) {
  const e = base(doc, "CIRCLE", layer);
  e.pairs.push([100, "AcDbCircle"], [10, String(c[0])], [20, String(c[1])], [30, "0"], [40, String(r)]);
  doc.msp.push(e);
  return e;
}

export function newLwPolyline(doc, pts, layer, constWidth = 0, target = doc.msp, color = 256, owner = "") {
  const e = base(doc, "LWPOLYLINE", layer, { color, owner });
  e.pairs.push([100, "AcDbPolyline"], [90, String(pts.length)], [70, "0"]);
  if (constWidth) e.pairs.push([43, String(constWidth)]);
  for (const p of pts) e.pairs.push([10, String(p[0])], [20, String(p[1])]);
  target.push(e);
  return e;
}

/** Sets the alignment of a TEXT: halign (72) and valign (73) and the alignment point (11): the insert point stays as it is.
 *  72 and 11 belong to the first AcDbText subclass, 73 to the second one (LibreDWG reads the group codes by subclass). */
export function setPlacement(e, x, y, z, ha, va) {
  const pairs = e.pairs.filter((p) => ![72, 73, 11, 21, 31].includes(p[0]));
  const idx = [];
  pairs.forEach((p, i) => { if (p[0] === 100 && p[1] === "AcDbText") idx.push(i); });
  if (idx.length < 2) { pairs.push([100, "AcDbText"]); idx.push(pairs.length - 1); }
  const k = idx[idx.length - 1];
  pairs.splice(k, 0, [72, String(ha)], [11, String(x)], [21, String(y)], [31, String(z)]);
  pairs.push([73, String(va)]);
  e.pairs = pairs;
}

export function setInsert(e, x, y, z) {
  e.set(10, String(x)).set(20, String(y)).set(30, String(z));
}

export function removeEntity(list, e) {
  const i = list.indexOf(e);
  if (i >= 0) list.splice(i, 1);
}

export function textHeight(e) { return e.num(40, 0); }

/** Sets the width factor (41) or the height (40) of a TEXT inside the first AcDbText subclass, where LibreDWG expects them. */
export function setTextNumber(e, code, value) {
  const v = String(value);
  const i = e.pairs.findIndex((p) => p[0] === code);
  if (i >= 0) { e.pairs[i][1] = v; return; }
  let at = e.pairs.findIndex((p) => p[0] === 1) + 1;
  if (at > 0 && e.pairs[at] && e.pairs[at][0] === 50) at++;
  e.pairs.splice(at > 0 ? at : e.pairs.length, 0, [code, v]);
}
