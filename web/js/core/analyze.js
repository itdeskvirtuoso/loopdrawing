// What a loop template contains that changes from module to module (port of tplset.analyze and its helpers).
// A template is recognised by its texts ("IOP :", "MODULE NAME:", "FIELD TAG:", "AITBXX", "JB No.", terminal numbers ...).
import { r2, CHAR_W, mtextPlainText, mtextString, setMTextString, newText, newLwPolyline, newLine, newCircle, setPlacement, setInsert, removeEntity } from "./edit.js";
import { insertMatrix, mulM, apply, IDENT } from "./render.js";

export class TemplateError extends Error {}

// ------------------------------------------------------------------------------------------------ patterns
const rx = (p, f = "i") => new RegExp(p, f);
const reMatch = (p, s) => new RegExp("^(?:" + p + ")", "i").test(s);
const reFull = (p, s) => new RegExp("^(?:" + p + ")$", "i").test(s);

export const HEADER = [ // key, pattern of the text (the topmost match is the sheet header)
  ["iop", "^IOP\\s*:"],
  ["iota", "^IOTA\\s*:"],
  ["iotype", "^IO\\s*TYPE\\s*:"],
  ["link", "^(IO\\s*)?LINK\\s*(No\\.?|NUMBER)?\\s*:"],
  ["module", "^MODULE\\s*(NAME|NO\\.?|NUMBER)\\s*:"],
  ["iom", "^IOM\\s*(No\\.?|NUMBER)?\\s*:"],
  ["tbname", "^([A-Z0-9]*(?<!R)TBX{2,}|[A-Z0-9]+(?<!R)TB\\d{2,})$"],
  ["rtpname", "^([A-Z0-9]*RT[BP]X{2,}|[A-Z0-9]+RT[BP]\\d{2,}[A-Z]?)$"],
  ["sysgroup", "^TB\\s?\\d+$"],
  ["jbname", "^JB\\s*(No\\.?|NUMBER|NAME)\\s*:?$"],
];
const COLUMN_LABELS = [["sysgroup", "sys"], ["tbname", "tb"], ["rtpname", "rtp"], ["jbname", "jb"]];
const IO_TYPE = /^[A-Z]{2,4}$/;
const TITLE_TYPES = [["ANALOG\\s+INPUT", "AI"], ["ANALOG\\s+OUTPUT", "AO"], ["\\bRTD\\b", "RTD"], ["DIGITAL\\s+INPUT", "DI"], ["DIGITAL\\s+OUTPUT", "DO"]];
const NOT_A_VALUE = "(\\d+|CH\\d+|CHNL\\s*NO\\.?|CHANNEL.*)";
export const TYPE_WORDS = { AI: "ANALOG INPUT", AO: "ANALOG OUTPUT", DI: "DIGITAL INPUT", DO: "DIGITAL OUTPUT" };

// ------------------------------------------------------------------------------------------------ helpers
const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const cmp = (a, b) => { // numbers or tuples (arrays), compared like Python does
  if (!Array.isArray(a)) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < a.length; i++) { const c = cmp(a[i], b[i]); if (c) return c; }
  return 0;
};
const minBy = (a, f) => { let best, bv, first = true; for (const x of a) { const v = f(x); if (first || cmp(v, bv) < 0) { bv = v; best = x; first = false; } } return best; };
const maxBy = (a, f) => { let best, bv, first = true; for (const x of a) { const v = f(x); if (first || cmp(v, bv) > 0) { bv = v; best = x; first = false; } } return best; };
const strip = (s) => s.trim();

export function textInfo(e) {
  const ha = e.int(72, 0), va = e.int(73, 0);
  const p = ha || va ? e.point(11, 21, 31) : e.point(10, 20, 30);
  return { h: e.handle, t: e.get(1, ""), x: r2(p.x), y: r2(p.y), s: r2(e.num(40, 0)), ha, va };
}

export function find(texts, pattern) { return texts.filter((t) => reMatch(pattern, strip(t.t))); }
export const labelCentre = (t) => (t.ha === 1 || t.ha === 4 ? t.x : t.x + (strip(t.t).length * CHAR_W * t.s) / 2);
export function textCentre(t) {
  const w = strip(t.t).length * CHAR_W * t.s;
  const x = t.x + ({ 0: w / 2, 1: 0, 2: -w / 2, 4: 0 }[t.ha] ?? w / 2);
  const y = t.y + ({ 0: 0.36, 1: 0.5, 2: 0, 3: -0.5 }[t.va] ?? 0.36) * t.s;
  return [x, y];
}
export function textSpan(t) {
  const w = strip(t.t).length * CHAR_W * t.s;
  const left = t.x - ({ 0: 0, 1: w / 2, 2: w, 4: w / 2 }[t.ha] ?? 0);
  return [left, left + w];
}

/** A 'LABEL:' text with nothing behind the colon whose value is a text of its own on the same line, right of it. */
export function withValue(label, texts) {
  const s = strip(label.t);
  label = { ...label };
  const mm = /^(.*?:\s*)/.exec(label.t);
  label.prefix = mm ? mm[1] : "";
  if (!s.endsWith(":") || strip(label.prefix) !== s) return label;
  const cy = textCentre(label)[1];
  const [lo, hi] = textSpan(label);
  let best = null;
  for (const o of texts) {
    const v = strip(o.t);
    if (o.h === label.h || !v || v.endsWith(":") || reMatch(NOT_A_VALUE, v) || HEADER.some(([, p]) => reMatch(p, v))) continue;
    const left = textSpan(o)[0];
    if (Math.abs(textCentre(o)[1] - cy) <= 0.5 * label.s && lo + 0.6 * (hi - lo) <= left && left <= hi + 8 * label.s) {
      if (best === null || left < best[0]) best = [left, o];
    }
  }
  if (best === null) return label;
  return { ...best[1], prefix: "", label: label.t };
}

// ------------------------------------------------------------------------------------------------ frame texts
/** TEXT entities of a block (and of the blocks inserted in it) as [{e, m}]; m puts them into the drawing. */
export function walkTexts(doc, blockName) {
  const out = [];
  const rec = (ents, m, depth) => {
    for (const e of ents) {
      if (e.type === "TEXT") out.push({ e, m });
      else if (e.type === "INSERT" && depth < 4) {
        const b = doc.block(e.get(2, ""));
        if (b) rec(b.ents, mulM(m, insertMatrix(e, b)), depth + 1);
      }
    }
  };
  const blk = doc.block(blockName);
  if (!blk) return out;
  for (const ins of doc.msp.filter((x) => x.type === "INSERT" && x.get(2, "") === blockName)) rec(blk.ents, insertMatrix(ins, blk), 1);
  return out;
}
export function walkAllTexts(doc) {
  const names = new Set(doc.msp.filter((e) => e.type === "INSERT").map((e) => e.get(2, "")));
  const out = [];
  for (const n of names) if (doc.block(n)) out.push(...walkTexts(doc, n));
  return out;
}
function frameTextInfo(e, m) {
  const ha = e.int(72, 0), va = e.int(73, 0);
  const p = ha || va ? e.point(11, 21, 31) : e.point(10, 20, 30);
  const w = apply(m, p.x, p.y);
  const h = e.num(40, 0);
  const s = h * Math.hypot(m[2], m[3]);
  return { h: e.handle, t: e.get(1, ""), x: r2(w[0]), y: r2(w[1]), s: r2(s), ha, va };
}

function findSheetTexts(texts, frameTexts) {
  const labels = [...frameTexts, ...texts].filter((t) => reFull("(SHEET|SHT)\\.?\\s*:?", strip(t.t)));
  if (!labels.length) return [null, null];
  const lab = maxBy(labels, (t) => t.x - t.y); // title block is at the bottom right
  const near = texts.filter((t) => reFull("\\d+", strip(t.t)) && t.x - lab.x >= -80 && t.x - lab.x <= 320 && t.y - lab.y >= -170 && t.y - lab.y <= 70);
  if (!near.length) return [null, null];
  const no = minBy(near, (t) => (t.x - lab.x) ** 2 + (t.y - lab.y) ** 2);
  const totals = frameTexts.filter((t) => reFull("\\s*/?\\s*\\d+\\s*", t.t) && t.s >= 0.8 * no.s && (t.x - no.x) ** 2 + (t.y - no.y) ** 2 < 160 ** 2);
  const tot = totals.length ? minBy(totals, (t) => (t.x - no.x) ** 2 + (t.y - no.y) ** 2) : null;
  return [no, tot];
}

function numberFormat(text) {
  const m = /\d+/.exec(text);
  return m ? [text.slice(0, m.index) + "{}" + text.slice(m.index + m[0].length), m[0].length] : ["{}", 2];
}

// ------------------------------------------------------------------------------------------------ geometry
/** Horizontal and vertical line pieces of the drawing (frame included): [[x, y0, y1]...], [[y, x0, x1]...]. */
export function axisSegments(doc) {
  const vert = [], horiz = [];
  const add = (a, b) => {
    if (Math.abs(a[0] - b[0]) < 0.3 && Math.abs(a[1] - b[1]) > 0.3) vert.push([a[0], Math.min(a[1], b[1]), Math.max(a[1], b[1])]);
    else if (Math.abs(a[1] - b[1]) < 0.3 && Math.abs(a[0] - b[0]) > 0.3) horiz.push([a[1], Math.min(a[0], b[0]), Math.max(a[0], b[0])]);
  };
  const walk = (ents, m, depth) => {
    for (const e of ents) {
      if (e.type === "LINE") add(apply(m, e.num(10), e.num(20)), apply(m, e.num(11), e.num(21)));
      else if (e.type === "LWPOLYLINE") {
        const pts = [];
        let cur = null;
        for (const [c, v] of e.pairs) { if (c === 10) { cur = [parseFloat(v), 0]; pts.push(cur); } else if (c === 20 && cur) cur[1] = parseFloat(v); }
        const wp = pts.map((p) => apply(m, p[0], p[1]));
        if ((e.int(70, 0) & 1) && wp.length) wp.push(wp[0]);
        for (let i = 0; i + 1 < wp.length; i++) add(wp[i], wp[i + 1]);
      } else if (e.type === "INSERT" && depth < 3) {
        const b = doc.block(e.get(2, ""));
        if (b) { try { walk(b.ents, mulM(m, insertMatrix(e, b)), depth + 1); } catch { /* a broken block must not stop the analysis */ } }
      }
    }
  };
  walk(doc.msp, IDENT, 0);
  return [vert, horiz];
}

const CENTRE_VA = { 0: 0, 1: 1, 2: 2, 3: 3 }; // TextEntityAlignment.CENTER / BOTTOM_CENTER / MIDDLE_CENTER / TOP_CENTER: (1, va)

/** Centre a TEXT entity (and its info) on x = cx, same height / baseline as before. */
function recentre(doc, e, t, cx) {
  const h = e.num(40, 0), z = e.num(30, 0);
  const va = CENTRE_VA[t.va] ?? 0;
  setPlacement(e, cx, t.y, z, 1, va);
  const width = strip(t.t).length * CHAR_W * h;
  // like simple_mtext_to_text: LibreDWG's DWG writer needs insert != alignment point
  setInsert(e, cx - width / 2, t.y - ({ 0: 0, 1: 0, 2: h / 2, 3: h }[t.va] ?? 0) - 0.01, z);
  t.x = r2(cx);
  t.ha = 1;
}

function cellOf(t, vert) {
  const [cx, cy] = textCentre(t);
  const xs = vert.filter(([, y0, y1]) => y0 - 1 <= cy && cy <= y1 + 1).map((v) => v[0]).sort((a, b) => a - b);
  const left = xs.filter((x) => x < cx - 1), right = xs.filter((x) => x > cx + 1);
  if (!left.length || !right.length) return null;
  return [left[left.length - 1], right[0]];
}

function fitTerminalsToCells(doc, terms, vert) {
  for (const t of terms) {
    const c = cellOf(t, vert);
    const e = doc.entityByHandle(t.h);
    if (!c || !e || e.type !== "TEXT") continue;
    const width = c[1] - c[0];
    if (!(width >= 25 && width <= 260)) continue;
    recentre(doc, e, t, (c[0] + c[1]) / 2);
    t.w = r2(width - 8);
    t.cell = [r2(c[0]), r2(c[1])];
  }
}

function newTextLike(doc, e0, height) {
  const attrs = { layer: e0.layer, style: e0.get(7, "Standard"), width: e0.num(41, 1) };
  if (e0.has(62)) attrs.color = e0.int(62);
  return newText(doc, "", height, attrs);
}

function jbLines(doc, header, texts, box, vert, horiz, warn) {
  const jb = header.jbname;
  if (!jb) return [];
  const e = doc.entityByHandle(jb.h);
  const tall = vert.filter(([, y0, y1]) => y1 - y0 >= 0.45 * (box[3] - box[1])).map((v) => v[0]).sort((a, b) => a - b);
  const left = tall.filter((x) => x <= jb.x + 5), right = tall.filter((x) => x > jb.x + 5);
  if (!e || e.type !== "TEXT" || !left.length || !right.length || !(right[0] - left[left.length - 1] >= 150 && right[0] - left[left.length - 1] <= 900)) {
    warn.push("JB section of the drawing not found - the JB text is not fitted into it");
    return [];
  }
  const lo = left[left.length - 1], hi = right[0];
  const above = horiz.filter(([y, x0, x1]) => y > jb.y + jb.s * 1.5 && x0 <= lo + 20 && x1 >= hi - 20).map((h) => h[0]);
  const titles = texts.filter((o) => strip(o.t) && lo <= textCentre(o)[0] && textCentre(o)[0] <= hi && o.y > jb.y + 1.5 * jb.s).map((o) => o.y - 0.3 * o.s);
  const cands = [...above, ...titles];
  const yTop = cands.length ? Math.min(...cands) : jb.y + 4 * 2 * jb.s;
  const pitch = r2(1.75 * jb.s);
  let slots = 1;
  while (jb.y + slots * pitch + 0.6 * jb.s < yTop - 6) slots++;
  const cx = (lo + hi) / 2;
  recentre(doc, e, jb, cx);
  jb.w = r2(hi - lo - 36);
  jb.cell = [r2(lo), r2(hi)];
  const extra = [];
  const h = e.num(40, 0);
  for (let k = 1; k < slots; k++) {
    const c = newTextLike(doc, e, h);
    c.set(1, "JB");
    const y = jb.y + k * pitch;
    setPlacement(c, cx, y, 0, 1, CENTRE_VA[jb.va] ?? 0);
    const w0 = 2 * CHAR_W * h;
    setInsert(c, cx - w0 / 2, y - ({ 0: 0, 1: 0, 2: h / 2, 3: h }[jb.va] ?? 0) - 0.01, 0);
    const info = textInfo(c);
    Object.assign(info, { t: "", prefix: "", w: jb.w, cell: jb.cell, slot: k });
    extra.push(info);
    c.set(1, "");
  }
  return extra;
}

function jbTags(doc, header, terms, channels, horiz) {
  const jb = header.jbname;
  const e0 = jb ? doc.entityByHandle(jb.h) : null;
  const side0 = terms.filter((t) => t.role === "jb" && t.side === 0 && "cell" in t);
  const side1 = terms.filter((t) => t.role === "jb" && t.side === 1 && "cell" in t);
  if (!jb || !("cell" in jb) || !e0 || !side0.length) return [];
  let lo, hi, between;
  if (side1.length && side1[0].cell[0] - side0[0].cell[1] >= 30) { lo = side0[0].cell[1]; hi = side1[0].cell[0]; between = true; }
  else { lo = jb.cell[0]; hi = side0[0].cell[0]; between = false; }
  if (hi - lo < 30) return [];
  const cx = (lo + hi) / 2, out = [];
  for (const ch of channels) {
    const mine = side0.filter((t) => t.ch === ch);
    if (!mine.length) continue;
    let cy = mean(mine.map((t) => textCentre(t)[1]));
    let h = e0.num(40, 0);
    if (between) {
      const lines = [...new Set(horiz.filter(([y, x0, x1]) => x0 <= lo + 2 && x1 >= hi - 2 && Math.abs(y - cy) < 60).map((l) => Math.round(l[0] * 10) / 10))].sort((a, b) => a - b);
      const bands = [];
      for (let i = 0; i + 1 < lines.length; i++) if (lines[i + 1] - lines[i] >= 12) bands.push([lines[i], lines[i + 1]]);
      if (bands.length) { // the free band nearest to the middle of the box, the upper one when two are as near
        const [a, b] = minBy(bands, (ab) => [Math.abs((ab[0] + ab[1]) / 2 - cy), -(ab[0] + ab[1])]);
        cy = (a + b) / 2;
        h = Math.max(8.0, Math.min(0.7 * h, b - a - 5.0));
      } else h *= 0.6;
    }
    const c = newTextLike(doc, e0, h);
    setPlacement(c, cx, cy, 0, 1, 2);
    setInsert(c, cx - h, cy - h / 2 - 0.01, 0);
    const info = textInfo(c);
    Object.assign(info, { t: "", prefix: "", w: r2(hi - lo - 6), ch, cell: [r2(lo), r2(hi)] });
    out.push(info);
    c.set(1, "");
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ analysis
function relayTerms(texts, label, ch) {
  const lc = labelCentre(label);
  const near = texts.filter((t) => t.h !== label.h && label.y - t.y > 0 && label.y - t.y <= 260 && Math.abs(textCentre(t)[0] - lc) <= 200 && reFull("[A-Z]?\\d+[+-]?", strip(t.t)));
  const centre = near.filter((t) => reFull("R\\d+", strip(t.t)));
  const sides = near.filter((t) => !centre.includes(t));
  if (centre.length !== 1 || sides.length !== 4) return [];
  const cx = textCentre(centre[0])[0];
  const groups = [sides.filter((t) => textCentre(t)[0] < cx), sides.filter((t) => textCentre(t)[0] >= cx)];
  if (groups.some((g) => g.length !== 2)) return [];
  const out = [{ ...centre[0], role: "rtp", side: 2, k: 0, ch, prefix: "", w: 60, relay: true, derive: "R" }];
  groups.forEach((group, side) => {
    [...group].sort((a, b) => b.y - a.y).forEach((t, k) => {
      const sign = /[+-]$/.exec(strip(t.t));
      out.push({ ...t, role: side === 0 ? "sys" : "rtp", side: side === 0 ? 1 : 0, k, ch, prefix: "", sfx: sign ? sign[0] : "", w: 60, relay: true });
    });
  });
  return out;
}

function typeVotes(texts, header, title) {
  const votes = [];
  const srcs = [["module no.", "(RTD|AI|AO|DI|DO)\\d+$", header.module ? strip(header.module.t).toUpperCase() : ""],
    ["TB name", "(RTD|AI|AO|DI|DO)(TB|RTP)", header.tbname ? strip(header.tbname.t).toUpperCase() : ""]];
  for (const [src, pat, s] of srcs) { const m = new RegExp(pat).exec(s); if (m) votes.push([src, m[1]]); }
  for (const t of texts) { // part numbers: 'IOM :8C-PDILA1', 'IOTA : 8C-TAIXA1' (P / T + type)
    const m = new RegExp("^IO(TA|M|P)\\s*(No\\.?)?\\s*:.*?-[TP](AI|AO|DI|DO)[A-Z]", "i").exec(strip(t.t));
    if (m) votes.push([m[0].split(":")[0].trim().toUpperCase() + " part no.", m[3].toUpperCase()]);
  }
  for (const [p, k] of TITLE_TYPES) if (new RegExp(p, "i").test(title)) votes.push(["title", k]);
  for (const t of texts) if (/^(AI|AO|RTD|DI|DO)$/.test(strip(t.t))) votes.push(["type label", strip(t.t)]);
  return votes;
}
function voteType(texts, header, title) {
  const votes = typeVotes(texts, header, title);
  const counts = {};
  for (const [, k] of votes) counts[k] = (counts[k] || 0) + 1;
  const keys = Object.keys(counts);
  if (!keys.length) return "";
  return maxBy(keys, (k) => counts[k] * 1e6 - votes.findIndex((v) => v[1] === k));
}

/** A template whose title or type label names another IO type than the rest of the drawing is corrected. */
export function correctLabels(doc, info) {
  const typ = info.type;
  if (!(typ in TYPE_WORDS)) return;
  for (const e of doc.msp) {
    if (e.type !== "TEXT") continue;
    const s = strip(e.get(1, ""));
    if (reMatch("^LOOP\\s+(TEMPLATE|DRAWING)", s)) {
      for (const [p, k] of TITLE_TYPES) {
        if (k !== typ && k in TYPE_WORDS && new RegExp(p, "i").test(s)) {
          e.set(1, e.get(1, "").replace(new RegExp(p, "i"), TYPE_WORDS[typ]));
          info.title = strip(e.get(1, ""));
          info.warnings.push(`the title said '${s}' but this is a ${typ} loop: changed to '${info.title}'`);
          break;
        }
      }
    } else if (["AI", "AO", "DI", "DO", "RTD"].includes(s) && s !== typ) {
      e.set(1, typ);
      info.warnings.push(`the type label above the field device said '${s}' but this is a ${typ} loop: changed to '${typ}'`);
    }
  }
}

export function analyze(doc, tid, frameName, box, forceType = null) {
  const warn = [];
  const texts = doc.msp.filter((e) => e.type === "TEXT" && Math.abs(e.num(50, 0)) < 0.01).map(textInfo);
  // the frame of the set (an xref bound into the template), or - a drawing that has its own frame - every inserted block
  const frameTexts = (frameName ? walkTexts(doc, frameName) : walkAllTexts(doc)).map(({ e, m }) => frameTextInfo(e, m));

  const chs = [...find(texts, "^CH\\d+$")].sort((a, b) => b.y - a.y);
  let tags = [...find(texts, "^FIELD\\s*TAG\\s*:")].sort((a, b) => b.y - a.y);
  let descs = [...find(texts, "^DESCRIPTION\\s*:")].sort((a, b) => b.y - a.y);
  if (!chs.length) throw new TemplateError("no 'CH1, CH2 ...' channel labels found");
  if (!(tags.length === descs.length && descs.length === chs.length))
    throw new TemplateError(`${chs.length} channel labels but ${tags.length} 'FIELD TAG:' and ${descs.length} 'DESCRIPTION:' texts`);
  const channels = chs.map((c) => parseInt(strip(c.t).slice(2), 10));
  const perChannel = channels.length === 1; // a sheet of one channel: the workbook gives one such sheet per channel

  const x1 = box[2];
  const rightLimit = x1 - 115; // inner border of the frame (x1 - 85) and a margin, so long texts never touch it
  const header = {};
  for (const [key, pat] of HEADER) {
    const m = find(texts, pat);
    if (m.length) header[key] = withValue(maxBy(m, (t) => t.y), texts); // the sheet header is above the controller card
  }
  // 'IOM : 8C-PAIHA1' is the module's part number (the IOP), 'IOM Number : 1' its number
  if ("iom" in header && !("iop" in header) && !/^[\dX\s]*$/i.test(header.iom.t.replace(/^.*?:\s*/, "").toUpperCase())) {
    const v = header.iom; delete header.iom;
    header.iop = { ...v, fromIOM: true };
  }
  for (const key of ["iop", "module", "iom"]) {
    if (!(key in header) && !(key === "iom" && "iop" in header)) warn.push(`no '${key.toUpperCase()}' text found - it is left as drawn`);
  }
  if ("jbname" in header) header.jbname.prefix = strip(header.jbname.t).replace(/:+$/, "").trimEnd() + " : ";

  // Header texts must not run into the text on their right
  const hdr = Object.values(header);
  for (const t of hdr) {
    const right = hdr.filter((o) => o !== t && o.x > t.x + 50 && Math.abs(o.y - t.y) < 60).map((o) => o.x);
    const left = hdr.filter((o) => o !== t && o.x < t.x - 50 && Math.abs(o.y - t.y) < 60).map((o) => o.x);
    if (t.ha === 1 || t.ha === 4) {
      const half = Math.min(...left.map((x) => t.x - x), ...right.map((x) => x - t.x), 600) / 2 - 10;
      t.w = r2(2 * Math.max(half, 60));
    } else t.w = r2((right.length ? Math.min(...right) - 20 : rightLimit) - t.x);
  }
  tags = tags.map((t) => withValue(t, texts));
  descs = descs.map((t) => withValue(t, texts));
  for (const t of [...tags, ...descs]) { t.limit = rightLimit; t.w = r2(rightLimit - t.x); }

  // Sheet number / total
  let [sheetno, total] = findSheetTexts(texts, frameTexts);
  if (!sheetno) {
    const cand = texts.filter((t) => reFull("\\d+", strip(t.t)) && t.x > box[0] + 0.9 * (x1 - box[0]) && t.y < box[1] + 0.06 * (box[3] - box[1]));
    sheetno = cand.length === 1 ? cand[0] : null;
  }
  if (!sheetno) warn.push("sheet number text not found - sheets will not be numbered");
  else {
    sheetno = { ...sheetno };
    [sheetno.fmt, sheetno.digits] = numberFormat(sheetno.t);
  }
  if (sheetno && !total) warn.push("sheet total text not found in the frame");
  if (total) {
    total = { ...total };
    [total.fmt, total.digits] = numberFormat(total.t);
  }

  // Terminal numbers next to every channel: columns of numbers, told apart by the label above them
  let terms = [];
  const pitch = chs.length > 1 ? median(chs.slice(0, -1).map((a, i) => a.y - chs[i + 1].y)) : 100;
  const tagX = Math.min(...tags.map((t) => t.x));
  const lo = chs[chs.length - 1].y - 0.6 * pitch, hi = chs[0].y + 0.6 * pitch;
  const cand = texts.filter((t) => reFull("\\d+", strip(t.t)) && t.x < tagX - 20 && lo <= t.y && t.y <= hi && (!sheetno || t.h !== sheetno.h));
  let cols = [];
  for (const t of [...cand].sort((a, b) => a.x - b.x)) {
    if (cols.length && t.x - cols[cols.length - 1][cols[cols.length - 1].length - 1].x < 60) cols[cols.length - 1].push(t);
    else cols.push([t]);
  }
  const minLen = perChannel ? 2 : Math.max(3, 0.7 * chs.length);
  cols = cols.filter((c) => c.length >= minLen);
  const labels = COLUMN_LABELS.filter(([k]) => k in header).map(([k, role]) => [role, labelCentre(header[k])]);
  const centres = cols.map((c) => median(c.map((t) => t.x)));
  const gaps = centres.slice(1).map((b, i) => b - centres[i]);
  const cell = gaps.length ? r2(Math.min(75, 0.5 * Math.min(...gaps))) : 75;
  let roles = centres.map((cx) => {
    const role = labels.length ? minBy(labels, (l) => Math.abs(l[1] - cx)) : null;
    return role && Math.abs(role[1] - cx) <= 220 ? role[0] : null;
  });
  // The system TB column sits in the module's box and often has no label of its own: the column(s) left of the first labelled one
  if (!roles.includes("sys") && roles.some((r) => r)) {
    const first = Math.min(...centres.filter((cx, i) => roles[i]));
    roles = roles.map((r, i) => (r === null && centres[i] < first ? "sys" : r));
  }
  const seenSide = {};
  cols.forEach((c, ci) => {
    const cx = centres[ci], role = roles[ci];
    if (!role) { warn.push(`terminal column at x=${cx.toFixed(0)} has no TB / RTP / JB label above it - left as drawn`); return; }
    seenSide[role] = (seenSide[role] ?? -1) + 1;
    const side = seenSide[role];
    const rows = new Map();
    for (const t of c) {
      const i = minBy(chs.map((_, i) => i), (i) => Math.abs(chs[i].y - t.y));
      if (!rows.has(i)) rows.set(i, []);
      rows.get(i).push(t);
    }
    for (const [i, ts] of rows) {
      [...ts].sort((a, b) => b.y - a.y).forEach((t, k) => terms.push({ ...t, role, side, k, ch: channels[i], prefix: "", w: r2(cell * 0.85) }));
    }
  });
  if (perChannel && "rtpname" in header) terms = terms.concat(relayTerms(texts, header.rtpname, channels[0])); // a DO loop: the relay module
  const [vert, horiz] = axisSegments(doc);
  for (const t of Object.values(header)) { // a header text never runs over the border of its box
    if (t.ha === 0) {
      const cy = textCentre(t)[1];
      const lines = vert.filter(([x, y0, y1]) => y0 - 1 <= cy && cy <= y1 + 1 && x > t.x + 30).map((v) => v[0]);
      if (lines.length) t.w = r2(Math.max(40, Math.min(t.w, Math.min(...lines) - t.x - 8)));
    }
  }
  fitTerminalsToCells(doc, terms, vert);
  const jblines = jbLines(doc, header, texts, box, vert, horiz, warn);
  const jbtags = perChannel ? [] : jbTags(doc, header, terms, channels, horiz); // a one-channel sheet lists its JB in the JB section only
  const counts = new Map();
  for (const x of terms) if (!x.relay) { const k = x.role + "|" + x.side; counts.set(k, (counts.get(k) || 0) + 1); }
  if (new Set(counts.values()).size > 1) {
    warn.push("terminal columns do not have the same number of numbers: " + [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, n]) => { const [r, s] = k.split("|"); return `${r}#${+s + 1}=${n}`; }).join(", "));
  }

  // Type, wiring, title
  let ioType = "";
  if ("iotype" in header) ioType = header.iotype.t.replace(/^.*?:\s*/, "").trim().toUpperCase();
  if (!IO_TYPE.test(ioType)) {
    const m = texts.map((t) => /SIGNAL\s*TYPE\s*:\s*([A-Z]{2,4})/i.exec(t.t));
    ioType = (m.find((x) => x) || [null, ""])[1].toUpperCase();
  }
  const titleT = texts.find((t) => reMatch("^LOOP\\s+(TEMPLATE|DRAWING)", strip(t.t)));
  const title = titleT ? strip(titleT.t) : "";
  if (!IO_TYPE.test(ioType)) ioType = voteType(texts, header, title); // no 'IO TYPE: AI' text: every text that names the type votes
  ioType = forceType || ioType;
  const wt = texts.find((t) => reFull("[2-4]\\s*-?\\s*WIRE", strip(t.t)));
  let wire = wt ? `${strip(wt.t)[0]} WIRE` : "";
  if (!wire && ioType === "AI" && terms.length) { // 2 terminals per channel and column = 2 wire, 4 = 4 wire
    const n = Math.max(...terms.map((x) => x.k)) + 1;
    wire = n === 2 || n === 4 ? `${n} WIRE` : "";
  }
  if (perChannel) { // the channel label is written again on every sheet; it sits in a box of its own
    const c = { ...chs[0] };
    const cellc = cellOf(c, vert);
    const cx = labelCentre(c);
    c.prefix = "CH";
    c.w = cellc && cellc[0] < cx && cx < cellc[1] ? r2(2 * (Math.min(cx - cellc[0], cellc[1] - cx) - 4)) : 80;
    header.chlabel = c;
  }
  return { type: ioType, wire, title, channels, perChannel, header, tags, descs, terms, jblines, jbtags, sheetno, frameTotal: total, warnings: warn };
}

// ------------------------------------------------------------------------------------------------ ids of the templates
export function assignIds(found) {
  const groups = new Map();
  for (const [fname, info] of found) {
    const stem = fname.replace(/\.[^.]*$/, "");
    const base = (info.type || stem.toUpperCase().replace(/ /g, "").slice(0, 8)) + (info.wire ? info.wire[0] + "W" : "");
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push([fname, info]);
  }
  const out = {}, notes = [];
  for (const [base, items0] of groups) {
    let items = items0;
    const single = items.filter((it) => it[1].perChannel);
    if (single.length && single.length < items.length) {
      const keepOne = single[single.length - 1];
      for (const it of items) if (it !== keepOne) notes.push(`${it[0]} is not used: ${keepOne[0]} (one sheet per channel) covers ${base}`);
      items = [keepOne];
    }
    items.sort((a, b) => a[1].channels[0] - b[1].channels[0] || (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : a[0].toLowerCase() > b[0].toLowerCase() ? 1 : 0));
    const keep = [];
    for (const it of items) {
      if (keep.length && keep[keep.length - 1][1].channels[0] === it[1].channels[0]) {
        const k = keep[keep.length - 1];
        notes.push(`${k[0]} and ${it[0]} are both ${base} CH${it[1].channels[0]}-${it[1].channels[it[1].channels.length - 1]}: ${it[0]} is used`);
        keep[keep.length - 1] = it;
      } else keep.push(it);
    }
    keep.forEach(([fname, info], i) => {
      const tid = keep.length === 1 ? base : `${base}${i + 1}`;
      out[tid] = { file: fname, sheet: i + 1, ...info };
    });
  }
  return [out, notes];
}

// ------------------------------------------------------------------------------------------------ preparing the drawing
const FIELDLIKE = "(\\d+|TB\\s?\\d+|JB.{0,12}|[A-Z]*(TB|RTP)X{2,}|CH\\d+)";
const ATTACH = { 1: [0, 3], 2: [1, 3], 3: [2, 3], 4: [0, 2], 5: [1, 2], 6: [2, 2], 7: [0, 1], 8: [1, 1], 9: [2, 1] };

/** Short single line MTEXTs that hold values ('TB1', a terminal number) become TEXT, so that they can be filled like any other text. */
export function simpleMTextToText(doc) {
  for (const e of [...doc.msp]) {
    if (e.type !== "MTEXT") continue;
    const s = mtextPlainText(e).trim();
    if (s.includes("\n") || !s || !reFull(FIELDLIKE, s) || Math.abs(e.num(50, 0)) > 0.01) continue;
    const [ha, va] = ATTACH[e.int(71, 1)] || [0, 3];
    const h = e.num(40, 0);
    const attrs = { layer: e.layer, style: e.get(7, "Standard") };
    if (e.has(62)) attrs.color = e.int(62);
    const t = newText(doc, s, h, attrs);
    const p = e.point();
    setPlacement(t, p.x, p.y, p.z, ha, va);
    // Like AutoCAD, keep the insertion point at the baseline start next to the alignment point: LibreDWG's DWG writer drops the
    // alignment point when both are the same, and the text would end up at 0,0
    const width = s.length * CHAR_W * h;
    setInsert(t, p.x - (width * ha) / 2, p.y - { 3: h, 2: h / 2, 1: 0 }[va] - 0.01, p.z);
    removeEntity(doc.msp, e);
  }
}

const SUPER = { 1: "\u00b9", 2: "\u00b2", 3: "\u00b3" };
const BS = String.fromCharCode(92);
const layouts = (doc) => [doc.msp, ...[...doc.blocks.values()].filter((b) => !b.isLayout && !b.isXref).map((b) => b.ents)];

/** 'mm{\H0.7x;\S2^;}' (a stacked, smaller '2'): renderers turn the stack into '2y}', so write the real character (mm2) instead. */
export function superscriptsToCharacters(doc) {
  const re = new RegExp("\\{(?:" + BS + BS + "H[\\d.]+x;)?" + BS + BS + "S([123])\\^;\\}", "g");
  for (const lay of layouts(doc)) {
    for (const e of lay) {
      if (e.type !== "MTEXT") continue;
      const s = mtextString(e);
      const n = s.replace(re, (m, d) => SUPER[d]);
      if (n !== s) setMTextString(e, n);
    }
  }
}

/** The title block ticks its status box with a Wingdings character that CAD readers replace by a letter: draw the tick as lines. */
export function wingdingsToTick(doc) {
  for (const lay of layouts(doc)) {
    for (const e of [...lay]) {
      if (e.type !== "MTEXT" || !mtextString(e).toLowerCase().includes("wingdings")) continue;
      const h = e.num(40, 0), p = e.point();
      const pts = [[p.x + 0.10 * h, p.y - 0.55 * h], [p.x + 0.38 * h, p.y - 0.85 * h], [p.x + 0.92 * h, p.y - 0.14 * h]];
      newLwPolyline(doc, pts, e.layer, 0.09 * h, lay, e.has(62) ? e.int(62) : 256, e.get(330, ""));
      removeEntity(lay, e);
    }
  }
}

/** Draw order tables list entity handles under group code 5, which LibreDWG's DXF import takes for the table's own handle
 *  ("duplicate handle"); the drawing does not need them. */
export function dropSortTables(doc) {
  const gone = new Set(doc.objects.filter((o) => o.type === "SORTENTSTABLE").map((o) => o.handle.toUpperCase()));
  if (!gone.size) return;
  doc.objects = doc.objects.filter((o) => o.type !== "SORTENTSTABLE");
  for (const o of doc.objects) {
    if (o.type !== "DICTIONARY") continue;
    const out = [];
    for (let i = 0; i < o.pairs.length; i++) {
      const p = o.pairs[i];
      if (p[0] === 3 && o.pairs[i + 1] && o.pairs[i + 1][0] === 350 && gone.has(o.pairs[i + 1][1].toUpperCase())) { i++; continue; }
      out.push(p);
    }
    o.pairs = out;
  }
  doc.invalidate();
}

export function frameExtent(doc) {
  const lo = doc.headerPoint("$EXTMIN"), hi = doc.headerPoint("$EXTMAX");
  if (lo && hi && hi.x - lo.x > 100 && hi.y - lo.y > 100 && Math.abs(lo.x) < 1e5 && Math.abs(hi.x) < 1e5) return [r2(lo.x), r2(lo.y), r2(hi.x), r2(hi.y)];
  return null;
}

// ------------------------------------------------------------------------------------------------ AO / DI / DO made from an AI loop
export const DERIVED = {
  AO: ["ANALOG OUTPUT", "same loop, the field device is an output device"],
  DI: ["DIGITAL INPUT", "the instrument is replaced by a field contact"],
  DO: ["DIGITAL OUTPUT", "the instrument is replaced by a contact; no relay module is drawn"],
};

/** Turns a one-channel AI loop into an AO / DI / DO loop of the same drawing: new title and IO type label; for DI / DO the
 *  instrument (circle with cross, + / - boxes) gives way to a dry contact. */
export function deriveVariant(doc, typ) {
  const msp = doc.msp;
  for (const e of msp) if (e.type === "TEXT" && reMatch("^LOOP\\s+(TEMPLATE|DRAWING)", strip(e.get(1, "")))) e.set(1, `LOOP DRAWING FOR ${DERIVED[typ][0]}`);
  const lab = msp.find((e) => e.type === "TEXT" && strip(e.get(1, "")) === "AI");
  const circles = msp.filter((c) => c.type === "CIRCLE" && lab && Math.abs(c.num(10) - lab.num(10)) < 80 && c.num(20) < lab.num(20));
  if (!lab || !circles.length) throw new TemplateError("the AI loop has no 'AI' label with an instrument symbol below it");
  const circle = maxBy(circles, (c) => c.num(20));
  lab.set(1, typ);
  if (typ === "AO") return;
  const cx = circle.num(10), cy = circle.num(20), r = circle.num(40);
  const x0 = cx - 0.3 * r - 2.5 * r, x1 = cx + r + 4, y0 = cy - 1.7 * r, y1 = cy + 1.7 * r; // instrument, cross and polarity boxes
  const inside = (pts) => pts.every(([x, y]) => x0 <= x && x <= x1 && y0 <= y && y <= y1);
  const ends = [], gone = [];
  for (const e of msp) {
    if (e === lab) continue;
    if (e.type === "LINE") {
      const a = [e.num(10), e.num(20)], b = [e.num(11), e.num(21)];
      if (inside([a, b])) gone.push(e);
      else if (Math.abs(a[1] - b[1]) < 0.3 && x0 - 5 <= Math.max(a[0], b[0]) && Math.max(a[0], b[0]) <= x0 + 20 && y0 <= a[1] && a[1] <= y1 - 20) ends.push(e);
    } else if (e.type === "LWPOLYLINE") {
      const pts = []; let cur = null;
      for (const [c, v] of e.pairs) { if (c === 10) { cur = [parseFloat(v), 0]; pts.push(cur); } else if (c === 20 && cur) cur[1] = parseFloat(v); }
      if (pts.length && inside(pts)) gone.push(e);
    } else if (e.type === "CIRCLE" && inside([[e.num(10), e.num(20)]])) gone.push(e);
    else if (e.type === "TEXT" && ["+", "-"].includes(strip(e.get(1, ""))) && inside([[e.num(10), e.num(20)]])) gone.push(e);
  }
  if (ends.length !== 2) throw new TemplateError("the two wires to the instrument were not found");
  for (const e of gone) removeEntity(msp, e);
  const xe = Math.max(...ends.map((e) => Math.max(e.num(10), e.num(11))));
  const [yt, yb] = ends.map((e) => e.num(20)).sort((a, b) => b - a);
  const layer = ends[0].layer;
  const add = (a, b) => newLine(doc, a, b, layer);
  add([xe, yt], [xe + 30, yt]);
  newCircle(doc, [xe + 34, yt], 4, layer);
  add([xe + 38, yt], [xe + 80, yt + 26]);
  newCircle(doc, [xe + 84, yt], 4, layer);
  add([xe + 88, yt], [xe + 120, yt]);
  add([xe + 120, yt], [xe + 120, yb]);
  add([xe + 120, yb], [xe, yb]);
}
