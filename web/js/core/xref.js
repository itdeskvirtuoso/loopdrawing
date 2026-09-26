// A template that references the FRAME drawing (XREF): the frame is bound into the template as an ordinary block, so that the sheet
// is one drawing (port of ezdxf's xref.embed with conflict policy KEEP: a layer / style / block the template has already stays).
import { Ent, Block } from "./dxf.js";

/** Removes groups that point at objects of the other drawing (extension dictionary, reactors, ...). */
function stripRefs(pairs) {
  const out = [];
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (p[0] === 102) { // { ... } group
      if (p[1].startsWith("{")) { while (i < pairs.length && !(pairs[i][0] === 102 && pairs[i][1].trim() === "}")) i++; }
      continue;
    }
    if ([360, 347, 390, 430, 431, 432, 433, 434, 435, 436, 437, 438, 439, 340, 342, 343].includes(p[0])) continue;
    out.push([p[0], p[1]]);
  }
  return out;
}

function cloneEntity(e, map, defaultOwner) {
  const c = new Ent(e.type, stripRefs(e.pairs));
  let seen = false;
  for (const p of c.pairs) {
    if (p[0] === 5) p[1] = map.get(p[1].toUpperCase()) || p[1];
    else if (p[0] === 330) { p[1] = map.get(p[1].toUpperCase()) || defaultOwner; seen = true; }
  }
  if (e.type === "HATCH") { // the boundary objects of the old drawing are gone: the hatch keeps its own boundary
    c.pairs = c.pairs.filter((p, i) => !(p[0] === 330 && c.pairs.findIndex((q) => q[0] === 330) !== i));
    for (const p of c.pairs) if (p[0] === 97) p[1] = "0";
  }
  return c;
}

function copyMissing(doc, fdoc, table) {
  const t = doc.table(table), f = fdoc.table(table);
  if (!t || !f) return;
  const have = new Set(t.records.map((r) => r.get(2, "").toUpperCase()));
  const owner = t.head.get(5, "");
  for (const r of f.records) {
    const name = r.get(2, "").toUpperCase();
    if (have.has(name)) continue;
    const c = new Ent(r.type, stripRefs(r.pairs));
    for (const p of c.pairs) { if (p[0] === 5) p[1] = doc.newHandle(); else if (p[0] === 330) p[1] = owner; }
    t.records.push(c);
    have.add(name);
  }
}

function usedBlocks(fdoc, ents, out = new Set(), depth = 0) {
  for (const e of ents) {
    if (e.type !== "INSERT" || depth > 6) continue;
    const n = e.get(2, "");
    if (out.has(n)) continue;
    out.add(n);
    const b = fdoc.block(n);
    if (b) usedBlocks(fdoc, b.ents, out, depth + 1);
  }
  return out;
}

function copyBlock(doc, fdoc, name) {
  const fb = fdoc.block(name);
  const rt = doc.table("BLOCK_RECORD");
  if (!fb || !rt || doc.blocks.has(name)) return;
  const frec = fdoc.table("BLOCK_RECORD") && fdoc.table("BLOCK_RECORD").records.find((r) => r.get(2, "") === name);
  const recHandle = doc.newHandle();
  const rec = new Ent("BLOCK_RECORD", stripRefs(frec ? frec.pairs : [[0, "BLOCK_RECORD"], [100, "AcDbSymbolTableRecord"], [100, "AcDbBlockTableRecord"], [2, name]]));
  for (const p of rec.pairs) { if (p[0] === 5) p[1] = recHandle; else if (p[0] === 330) p[1] = rt.head.get(5, ""); }
  if (!rec.has(5)) rec.pairs.splice(1, 0, [5, recHandle]);
  rt.records.push(rec);
  const map = new Map();
  for (const e of fb.ents) if (e.handle) map.set(e.handle.toUpperCase(), doc.newHandle());
  map.set(fb.begin.handle.toUpperCase(), doc.newHandle());
  map.set(fb.end.handle.toUpperCase(), doc.newHandle());
  const begin = cloneEntity(fb.begin, map, recHandle), end = cloneEntity(fb.end, map, recHandle);
  const ents = fb.ents.map((e) => cloneEntity(e, map, recHandle));
  doc.blocks.set(name, new Block(begin, ents, end));
  doc.invalidate();
}

/** block: the XREF block of the template (Block); fdoc: the parsed FRAME drawing. */
export function embedFrame(doc, block, fdoc) {
  for (const t of ["LAYER", "STYLE", "LTYPE"]) copyMissing(doc, fdoc, t);
  for (const n of usedBlocks(fdoc, fdoc.msp)) copyBlock(doc, fdoc, n);
  const owner = block.begin.get(330, "");
  const map = new Map();
  for (const e of fdoc.msp) if (e.handle) map.set(e.handle.toUpperCase(), doc.newHandle());
  block.ents = fdoc.msp.map((e) => cloneEntity(e, map, owner));
  block.begin.set(70, "0");
  block.begin.remove(1);
  const rec = doc.table("BLOCK_RECORD") && doc.table("BLOCK_RECORD").records.find((r) => r.get(2, "") === block.name);
  if (rec) { rec.set(70, "0"); rec.remove(1); }
  doc.invalidate();
}
