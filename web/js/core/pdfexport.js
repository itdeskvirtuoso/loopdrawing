// PDF of loop drawing sheets: the blank sheet of a template (vector drawing + logos) as a form XObject, and the texts of every
// sheet written on it in Helvetica at their place (port of server.make_pdf / put_text; text_fit of dwg_export).
import { CAP, ARIAL } from "./text.js";
import { pdfContent, pageSize } from "./output.js";

export const A1_W = 2383.94, A1_H = 1683.78; // pt
export const MIN_CONDENSE = 0.6;

export const cleanText = (s) => String(s ?? "").replace(/[\r\n\t]/g, " ").trim().slice(0, 300);

/** Width of a text in Helvetica (= Arial): sum of advance widths, no kerning. */
export function helvWidth(engine, text, size) {
  let w = 0;
  for (const ch of text) w += engine.glyph(ch).adv;
  return (w * size) / ARIAL.upem;
}

/** How to squeeze a text into the room it has: [width factor, height factor]. Same rule for the PDF, the DWG and the screen. */
export function textFit(engine, text, info) {
  const room = info.w;
  if (!text || !room || room <= 0) return [1, 1];
  const width = helvWidth(engine, text, info.s / CAP);
  if (width <= room) return [1, 1];
  const sx = Math.max(room / width, MIN_CONDENSE);
  return [sx, width * sx > room ? room / (width * sx) : 1];
}

const n3 = (v) => Math.round(v * 1000) / 1000;

/**
 * lib: pdf-lib (PDFLib global in the browser). set: analysed template set ({box, templates}). blanks: {tid: {content, logos}} .
 * sheets: [{tid, texts: {handle: value}, numbering: [sheet, total] | null}]. Returns the PDF bytes.
 */
export async function buildPdf(lib, engine, set, blanks, sheets, title = "Loop drawings", onProgress = null) {
  const { PDFDocument, StandardFonts, PDFName, beginText, endText, setFontAndSize, setTextMatrix, showText, drawObject, pushGraphicsState, popGraphicsState, concatTransformationMatrix } = lib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const charset = new Set(font.getCharacterSet());
  const safe = (t) => { let o = ""; for (const ch of t) o += charset.has(ch.codePointAt(0)) ? ch : "?"; return o; };
  const box = set.box;
  const [pw, ph] = pageSize(box);
  const offX = (A1_W - pw) / 2;
  const s = pw / (box[2] - box[0]);

  const forms = {};
  const formFor = async (tid) => {
    if (forms[tid]) return forms[tid];
    const b = blanks[tid];
    const xobj = {};
    for (let i = 0; i < b.logos.length; i++) xobj[`Im${i}`] = (await doc.embedPng(b.logos[i].png)).ref;
    const stream = doc.context.flateStream(b.content, {
      Type: "XObject", Subtype: "Form", BBox: [0, 0, pw, ph], Resources: { XObject: xobj },
    });
    return (forms[tid] = doc.context.register(stream));
  };

  const fields = {};
  const fieldsOf = (tid) => {
    if (!fields[tid]) {
      const t = set.templates[tid], m = {};
      for (const f of [...Object.values(t.header), ...(t.jblines || []), ...(t.jbtags || []), ...(t.chlabels || []), ...t.tags, ...t.descs, ...t.terms]) m[f.h] = f;
      fields[tid] = m;
    }
    return fields[tid];
  };

  let n = 0;
  for (const sh of sheets) {
    const t = set.templates[sh.tid];
    const page = doc.addPage([A1_W, A1_H]);
    const formName = page.node.newXObject("Blank", await formFor(sh.tid));
    const fontName = page.node.newFontDictionary(font.name, font.ref);
    const ops = [pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, offX, 0), drawObject(formName), popGraphicsState()];
    const put = (info, raw) => {
      const text = safe(cleanText(raw));
      if (!text) return;
      const [sx, sh2] = textFit(engine, text, info);
      const size = ((info.s * s) / CAP) * sh2;
      const w = helvWidth(engine, text, size) * sx;
      let x = offX + (info.x - box[0]) * s;
      let y = (info.y - box[1]) * s; // PDF y (up)
      if (info.ha === 1 || info.ha === 4) x -= w / 2; else if (info.ha === 2) x -= w;
      if (info.va === 2 || info.ha === 4) y -= (info.s * sh2 * s) / 2;
      else if (info.va === 3) y -= info.s * sh2 * s;
      ops.push(beginText(), setFontAndSize(fontName, n3(size)), setTextMatrix(n3(sx), 0, 0, 1, n3(x), n3(y)), showText(font.encodeText(text)), endText());
    };
    const fmap = fieldsOf(sh.tid);
    for (const [h, v] of Object.entries(sh.texts)) if (fmap[h]) put(fmap[h], v);
    const numbering = sh.numbering || [n + 1, sheets.length];
    if (t.sheetno) put(t.sheetno, t.sheetno.fmt.replace("{}", String(numbering[0]).padStart(t.sheetno.digits, "0")));
    if (t.frameTotal) put(t.frameTotal, t.frameTotal.fmt.replace("{}", String(numbering[1]).padStart(t.frameTotal.digits, "0")));
    page.pushOperators(...ops);
    n++;
    if (onProgress && n % 25 === 0) await onProgress(n, sheets.length);
  }
  doc.setTitle(title);
  doc.setCreator("Loop drawing generator");
  doc.setProducer("Loop drawing generator");
  return doc.save({ useObjectStreams: true });
}

export { pdfContent };
