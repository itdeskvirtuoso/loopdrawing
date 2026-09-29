// Template sets: import loop-drawing template DWG files (with their FRAME) and read them automatically (port of tplset.build_set).
//
// A DWG with "CH1..CHn" and "FIELD TAG:" texts is a template, any other DWG is the frame. Building a set gives
//   info            what was found in every template (type, wiring, channels, every text that is filled from Excel)
//   dxf[tid]        the template drawing as DXF text (used for the DWG / DXF download)
//   blank[tid]      the blank sheet: PDF content stream, SVG, logos (used for the PDF download and the on-screen preview)
import { dwgToDxf } from "./libredwg.js";
import { parseDxf, writeDxf } from "./dxf.js";
import { buildDisplay } from "./render.js";
import { pdfContent, svgSheet, pageSize, PAGE_H } from "./output.js";
import { findLogos } from "./logos.js";
import { embedFrame } from "./xref.js";
import { r2 } from "./edit.js";
import {
  analyze, assignIds, correctLabels, deriveVariant, DERIVED, dropSortTables, frameExtent, simpleMTextToText, superscriptsToCharacters,
  TemplateError, wingdingsToTick, CH_LABEL, TAG_LABELS,
} from "./analyze.js";

export const VERSION = 16; // raise when the analysis changes: sets built with an older version are rebuilt

const stem = (n) => n.replace(/\.[^.]*$/, "");
const allFields = (t) => [...Object.values(t.header), ...(t.jblines || []), ...(t.jbtags || []), ...(t.chlabels || []), ...t.tags, ...t.descs, ...t.terms];
export { allFields };

function bytesToBase64(b) {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * files: [{name, bytes}]  (bytes: Uint8Array of a .dwg)
 * env: { engine (TextEngine), CFB (cfb library), log(msg) }
 * Returns { info, dxf: {tid: text}, blank: {tid: {content, svg, logos:[{rect, png}]}} }
 */
export async function buildSet(setId, name, files, env) {
  const log = env.log || (() => {});
  const list = [...files].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  if (!list.length) throw new TemplateError("the set has no DWG files");
  const warnings = [], rejected = [], found = [], dxfOf = new Map(), frames = new Map();

  for (const f of list) { // every DWG once: a template has channel labels, the others are frames
    log(`Reading ${f.name}`);
    try {
      if (f.bytes.length < 1000 || String.fromCharCode(...f.bytes.subarray(0, 4)) !== "AC10") throw new TemplateError(`${f.name}: not a DWG drawing`);
      dxfOf.set(f.name, await dwgToDxf(f.bytes));
    } catch (e) { rejected.push({ file: f.name, error: e.message }); }
  }
  const templ = [];
  for (const [n, text] of dxfOf) {
    const doc = parseDxf(text);
    const words = doc.msp.filter((e) => e.type === "TEXT").map((e) => e.get(1, "").trim());
    const isTpl = words.some((w) => new RegExp(`^(?:${CH_LABEL})$`, "i").test(w)) && words.some((w) => TAG_LABELS.some((p) => new RegExp(p, "i").test(w)));
    if (isTpl) templ.push(n); else frames.set(n, doc);
  }
  if (!templ.length) throw new TemplateError("none of the DWG files is a loop template (a template has 'CH1', 'CH2' ... and 'FIELD TAG:' texts). A frame alone cannot be used: add it to a set that has the templates (\"Add to ...\")");

  // Which frame belongs to the templates: the one they reference (XREF), else the only one
  const xrefStems = new Set();
  for (const n of templ) for (const b of parseDxf(dxfOf.get(n)).blocks.values()) if (b.isXref) xrefStems.add(stem((b.begin.get(1, "") || "").split(/[\\/]/).pop()).toUpperCase());
  const frameName = [...frames.keys()].find((n) => xrefStems.has(stem(n).toUpperCase())) || [...frames.keys()][0] || null;
  if (frames.size > 1) warnings.push(`${frames.size} frame drawings found, ${frameName} is used`);
  let box = frameName ? frameExtent(frames.get(frameName)) : null;
  frames.clear();

  const analyse = async (fname, derive = null) => {
    const doc = parseDxf(dxfOf.get(fname));
    let fblock = null, gone = "";
    const xrefs = [...doc.blocks.values()].filter((b) => b.isXref);
    if (xrefs.length && frameName) { // the frame is bound into the template as an ordinary block
      const fdoc = parseDxf(dxfOf.get(frameName));
      for (const b of xrefs) { embedFrame(doc, b, fdoc); fblock = b.name; }
    } else if (xrefs.length) gone = (xrefs[0].begin.get(1, "") || "").split(/[\\/]/).pop();
    dropSortTables(doc);
    simpleMTextToText(doc);
    wingdingsToTick(doc);
    superscriptsToCharacters(doc);
    if (derive) deriveVariant(doc, derive);
    if (box === null) box = frameExtent(doc);
    if (box === null) throw new TemplateError("the extent of the drawing could not be found");
    const info = analyze(doc, fname, fblock, box, derive);
    if (!derive) correctLabels(doc, info);
    return { info, doc, gone };
  };

  const docs = {};
  for (const n of templ) {
    log(`Analysing ${n}`);
    try { const r = await analyse(n); found.push([n, r.info]); docs[n] = r; }
    catch (e) { rejected.push({ file: n, error: e instanceof TemplateError ? e.message : `${e.name}: ${e.message}` }); }
  }
  // IO types the set has no template for, while it has a one-channel AI loop: the loops of the other types are the same drawing with
  // another field device, so they are made from it (a real template of the type, imported later, replaces them)
  const have = new Set(found.map(([, i]) => i.type));
  const base = (found.find(([, i]) => i.perChannel && i.type === "AI") || [null])[0];
  for (const typ of base ? Object.keys(DERIVED) : []) {
    if (have.has(typ)) continue;
    const label = `${stem(base)} (${typ} derived).dwg`;
    log(`Making the ${typ} loop from ${base}`);
    try {
      const r = await analyse(base, typ);
      r.info.derived = true;
      found.push([label, r.info]); docs[label] = r;
      warnings.push(`No ${typ} template in the set: the ${typ} sheets are made from ${base} (${DERIVED[typ][1]}). Import a ${typ} template of your own to replace them.`);
    } catch (e) { warnings.push(`The ${typ} sheets could not be made from ${base}: ${e.message}`); }
  }
  const [templates, notes] = assignIds(found);
  warnings.push(...notes);
  for (const t of Object.values(templates)) {
    const g = docs[t.file];
    if (g && g.gone) warnings.push(`${t.file} needs the frame drawing it references (${g.gone}), which is not in the set - drawn without a frame`);
  }
  if (!Object.keys(templates).length) throw new TemplateError(rejected.map((r) => `${r.file}: ${r.error}`).join("; ") || "no template could be read");

  const dxf = {}, blank = {};
  const [pw] = pageSize(box);
  for (const [tid, t] of Object.entries(templates)) {
    log(`Rendering ${tid}`);
    const r = docs[t.file];
    const hs = new Set(allFields(t).map((f) => f.h));
    if (t.sheetno) hs.add(t.sheetno.h);
    if (t.frameTotal) hs.add(t.frameTotal.h);
    const disp = buildDisplay(r.doc, { engine: env.engine, blank: hs });
    const lw = [];
    const logos = await findLogos(r.doc, env.CFB, lw);
    t.logos = logos.length;
    t.warnings.push(...lw);
    blank[tid] = {
      content: pdfContent(disp, box, logos),
      svg: svgSheet(disp, box, logos.map((l) => ({ rect: l.rect, href: "data:image/png;base64," + bytesToBase64(l.png) }))),
      logos,
    };
    r.doc.syncHandseed();
    dxf[tid] = writeDxf(r.doc);
    t.page = [r2(pw), PAGE_H];
    for (const w of t.warnings) warnings.push(`${t.file}: ${w}`);
    delete docs[t.file];
  }
  for (const r of rejected) warnings.push(`${r.file} was not used: ${r.error}`);
  const info = {
    id: setId, version: VERSION, name: name || setId, builtAt: Date.now(), frame: frameName, box, page: [r2(pw), PAGE_H],
    types: [...new Set(Object.values(templates).map((t) => t.type).filter(Boolean))].sort(), templates, rejected, warnings,
  };
  return { info, dxf, blank };
}
