// Reads an IO ASSIGNMENT workbook and turns it into loop drawing sheets for a template set (port of io_excel.py).
//
// The workbook is read by what its columns are called, not by where they are, so the layouts of different projects work alike
// (see ALIASES / GROUPS). Rows are grouped into modules: a new module starts at every yellow highlighted row, or - when the sheet
// has no yellow rows - at every new MODULE NAME (a workbook without that column: every new controller / link / rack / slot / IOM).
import { openWorkbook } from "./xlsx.js";

export const TYPES = ["AI", "AO", "RTD", "DI", "DO"]; // order of the drawing set; other types follow

// key -> header names (first match wins; "#2" = the second column with that name)
const ALIASES = {
  sr: ["SR NO", "S NO", "SL NO"], c300: ["C300 CONTROL MODULE NAME", "C300 TAG", "DCS TAG NAME", "DCS TAG", "CONTROL MODULE NAME"],
  tag: ["CHANNEL NAME", "FIELD TAG", "FIELD TAG NO", "TAG NO", "TAG NUMBER", "TAG NAME", "INSTRUMENT TAG", "INSTRUMENT TAG NO", "LOOP TAG", "TAG"],
  desc: ["DESCRIPTION", "SERVICE DESCRIPTION", "TAG DESCRIPTION", "LOOP DESCRIPTION", "INSTRUMENT DESCRIPTION", "SERVICE"],
  dcs_desc: ["DCS DESCRIPTION"], equipment: ["EQUIPMENT TYPE"], area: ["AREA", "SECTION"], signal: ["SIGNAL", "SIGNAL POTENTIAL"], wire: ["SIGNAL TYPE", "WIRING", "WIRE TYPE"],
  controller: ["CONTROLLER NAME", "CONTROLLER"], link: ["LINK NO", "LINK"], iom: ["IOM NO", "IOM NUM", "IOM NUMBER", "MODULE NO", "CARD NO", "CARD"],
  rack: ["RACK NO", "RACK"], slot: ["SLOT NO", "SLOT"],
  channel: ["CHANNEL", "CHANNEL NO", "CH NO", "CHNL NO", "CHANNEL NUMBER", "CH", "CHNL", "IO CHANNEL", "IOM CHANNEL", "CARD CHANNEL"],
  module: ["MODULE NAME", "IOM NAME", "CARD NAME", "IO MODULE NAME", "MODULE TAG", "MODULE"], iop: ["MODULE PART NO", "IOM MODEL NO", "IOP", "MODULE MODEL NO", "CARD PART NO"],
  iota: ["IOTA PART NO", "IOTA MODEL NO", "IOTA"],
  sysgroup: ["SYSTEM TB GROUP", "IOTA TB GRP 1", "IOTA TB GROUP"], sys1: ["TB1", "TB 1"], sys2: ["TB2", "TB 2"], sys3: ["TB3", "TB 3"],
};
const MODULE_ID = ["controller", "link", "rack", "slot", "iom"]; // what tells the modules apart when there is no MODULE NAME column
// A name column followed by its terminal columns: TB NAME | TERMINAL NO | TERMINAL NO
const GROUPS = { tb: ["TB NAME"], rtp: ["RTP NAME", "RTP NO", "RTB NAME", "RTB NO"], jb: ["JB NAME", "JB NO"] }; // RTP / RTB = the relay terminal panel / base of a DO loop
const TERMINAL = /^(TERMINAL(NO)?\d*|TBNO\d*|RTPRTB\d*|RTB\d*|JBTERMINAL(NO)?\d*|DOTERMINAL(NO)?\d*)$/;
const ROW_KEYS = [...Object.keys(ALIASES), "iotype"];
const MODULE_KEYS = ["module", "iotype", "iop", "iota", "link", "iom", "controller"];
const NOT_A_VALUE = new Set(["", "NA", "N/A", "-", "--", "—"]);

export function clean(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" && Number.isInteger(v)) return String(v);
  return String(v).split(/\s+/).filter(Boolean).join(" ");
}
export const real = (v) => !NOT_A_VALUE.has(clean(v).toUpperCase());
const normName = (v) => clean(v).toUpperCase().replace(/[\s._\-/()]+/g, "");

/** The channel number of a cell: 5, '05', '5.0', 'CH5', 'CH-05', 'CHNL 5', 'R1-S2-CH5'. null when there is none. */
export function parseChannel(v) {
  const s = clean(v).toUpperCase();
  let m = /^(\d+)(\.0+)?$/.exec(s) || /^CH(?:ANNEL|NL)?\s*(?:NO\.?)?\s*[-.:#]?\s*(\d+)$/.exec(s) || /(?:^|[^A-Z])CH(?:ANNEL|NL)?\s*[-.:#]?\s*(\d+)$/.exec(s);
  return m ? parseInt(m[1], 10) : null;
}

/** The IO type of a text: 'AI', 'A.I.', 'AI HART', 'ANALOG INPUT', 'DI-24VDC', 'RTD/TC' ... -> one of the template set's types
 *  (or AI / AO / DI / DO / RTD). '' when the text names no type. */
export function canonType(v, known = new Set()) {
  const s = clean(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) return "";
  if (known.has(s)) return s;
  const rules = [[/RTD|THERMOCOUPLE|PT100|^TC|^LLAI|^LLMUX/, "RTD"], [/^ANALOGU?E?INPUT/, "AI"], [/^ANALOGU?E?OUTPUT/, "AO"], [/^(DIGITAL|BINARY)INPUT/, "DI"],
    [/^(DIGITAL|BINARY)OUTPUT/, "DO"], [/^AI/, "AI"], [/^AO/, "AO"], [/^(DI|BI$)/, "DI"], [/^(DO|BO$)/, "DO"]];
  for (const [re, t] of rules) if (re.test(s)) return t === "RTD" && !known.has("RTD") && known.has("TC") ? "TC" : t;
  return "";
}
/** The IO type of a module part number: Honeywell 'CC-PAIH01', '8C-PAINA1' (AI), 'CC-PAIM01' (low level = RTD), '8C-PDODA1' (DO) ... */
function partType(v) {
  const m = /(?:^|[^A-Z])P(AI|AO|DI|DO)([A-Z])?/.exec(clean(v).toUpperCase());
  if (!m) return "";
  return m[1] === "AI" && m[2] === "M" ? "RTD" : m[1];
}
const mostCommon = (values) => {
  const vs = values.filter(Boolean);
  if (!vs.length) return "";
  const cnt = new Map();
  for (const v of vs) cnt.set(v, (cnt.get(v) || 0) + 1);
  let best = vs[0], bn = 0;
  for (const v of vs) if (cnt.get(v) > bn) { best = v; bn = cnt.get(v); }
  return best;
};

/** rows: the first rows of the sheet as arrays of values. Returns [row number, column map, score] or [null, null, 0]: the row that
 *  names the most known columns among those with a channel column, a tag or description column and something that tells the
 *  modules apart (MODULE NAME, IOM / card, rack / slot). */
function findHeader(rows) {
  let best = [null, null, 0];
  for (const [r, row] of rows) {
    const names = row.map((v) => normName(v));
    const col = {}, groups = {};
    for (const [key, options] of Object.entries(ALIASES)) {
      for (const opt of options) {
        const [n, nth = "1"] = opt.split("#");
        const name = normName(n);
        const hits = []; names.forEach((x, i) => { if (x === name) hits.push(i); });
        if (hits.length >= parseInt(nth, 10)) { col[key] = hits[parseInt(nth, 10) - 1]; break; }
      }
    }
    for (const [key, options] of Object.entries(GROUPS)) {
      for (const opt of options) {
        const i = names.indexOf(normName(opt));
        if (i >= 0) {
          const terms = [];
          let j = i + 1;
          while (j < names.length && TERMINAL.test(names[j] ?? "")) { terms.push(j); j++; }
          groups[key] = [i, terms];
          break;
        }
      }
    }
    // IO type: the TYPE column after LINK when there are two (old layout), else the only one
    const types = []; names.forEach((n, i) => { if (n === "TYPE" || n === "IOTYPE") types.push(i); });
    const after = types.filter((i) => i > (col.link ?? -1));
    if (after.length || types.length) col.iotype = (after.length ? after : types)[0];
    if (!("channel" in col) || !["tag", "desc", "c300"].some((k) => k in col) || !["module", "iom", "rack", "slot"].some((k) => k in col)) continue;
    const score = Object.keys(col).length + Object.keys(groups).length;
    col._groups = groups;
    if (score > best[2]) best = [r, col, score];
  }
  return best;
}

/** IO type of a row: its IO TYPE column, else the module part number, the SIGNAL TYPE column or the module name ('C1L1AI01'). */
function normType(rec, known) {
  const raw = rec.iotype.toUpperCase().replace(/ /g, "");
  if (raw && raw !== "TYPE") return canonType(raw, known) || raw;
  const t = partType(rec.iop) || canonType(rec.wire, known) || canonType(rec.signal, known);
  if (t) return t;
  const m = rec.module.toUpperCase();
  for (const name of ["RTD", "AI", "AO", "DI", "DO"]) if (new RegExp(`(^|[^A-Z])${name}|${name}($|[^A-Z])|\\d${name}\\d`).test(m)) return name; // RTD before the 2-letter names
  return "";
}
function normWire(v) {
  const m = /([2-4])\s*-?\s*WIRE/.exec(v.toUpperCase());
  return m ? `${m[1]} WIRE` : "";
}
const cellValue = (cells, i) => (i !== undefined && i !== null ? clean(cells[i]) : "");

const isSpare = (c) => !c || c.tag.toUpperCase().includes("SPARE") || ["", "SPARE"].includes(c.desc.toUpperCase());

export async function readIoExcel(JSZip, data, filename = "", tpl = null, progress = null) {
  const wb = await openWorkbook(JSZip, data);
  let sheet = null, hdr = null, col = null, score = 0;
  for (const sh of wb.sheets) { // the sheet whose header names the most known columns (an IO list is often next to summary sheets)
    const head = [];
    await wb.scan(sh, (r, values) => { head.push([r, values]); return r < 30; });
    const [r, c, s] = findHeader(head);
    if (r && s > score) [sheet, hdr, col, score] = [sh, r, c, s];
  }
  if (!sheet) throw new Error("no sheet has a header row with 'MODULE NAME' (or IOM / CARD / SLOT) and 'CHANNEL' and a 'FIELD TAG' / 'TAG NO' / 'DESCRIPTION' column");
  const groups = col._groups; delete col._groups;
  const colWarnings = [];
  if (!("tag" in col)) colWarnings.push(`No FIELD TAG / TAG NO column in sheet '${sheet.name}': ${"c300" in col ? "the DCS tag is used as field tag" : "the field tags are left empty"}.`);
  if (!("desc" in col)) colWarnings.push(`No DESCRIPTION column in sheet '${sheet.name}': the descriptions stay SPARE.`);
  if (!("module" in col)) colWarnings.push(`No MODULE NAME column in sheet '${sheet.name}': modules are told apart by ${MODULE_ID.filter((k) => k in col).map((k) => k.toUpperCase()).join(" / ")}.`);

  const yellowCols = [...new Set(["tag", "desc", "module", "channel"].filter((k) => k in col).map((k) => col[k]))].sort((a, b) => a - b);
  const rows = [];
  let blankRun = 0, seen = 0;
  await wb.scan(sheet, (r, cells, flags) => {
    if (r <= hdr) return true;
    const rec = {};
    for (const k of ROW_KEYS) rec[k] = cellValue(cells, col[k]);
    for (const [g, [nameI, termIs]] of Object.entries(groups)) { rec[g] = cellValue(cells, nameI); rec[g + "T"] = termIs.map((i) => cellValue(cells, i)); }
    if (!("tag" in col)) rec.tag = rec.c300;
    if (!(rec.module || rec.channel || rec.tag || rec.desc)) { blankRun++; return blankRun <= 300; } // formatted but empty rows below the data
    blankRun = 0;
    rec.row = r;
    rec.ch = parseChannel(rec.channel);
    // the module a row belongs to: its MODULE NAME, else controller / link / rack / slot / IOM ('C1 L1 IOM 3')
    rec.key = rec.module || MODULE_ID.filter((k) => real(rec[k])).map((k) => (k === "iom" ? "IOM " : k === "slot" ? "SLOT " : k === "rack" ? "RACK " : "") + rec[k]).join(" ");
    let yellow = 0;
    for (const i of yellowCols) if (flags[i]) yellow++;
    rec.yellow = yellowCols.length > 0 && yellow >= Math.max(2, Math.floor(yellowCols.length / 2));
    rows.push(rec);
    if (progress && ++seen % 5000 === 0) progress(seen);
    return true;
  });

  const yellowRows = rows.filter((x) => x.yellow).map((x) => x.row);
  const groupsOfRows = [];
  let mode;
  if (yellowRows.length) {
    mode = "yellow";
    for (const rec of rows) { if (rec.yellow || !groupsOfRows.length) groupsOfRows.push([]); groupsOfRows[groupsOfRows.length - 1].push(rec); }
  } else {
    mode = "module";
    const index = new Map();
    for (const rec of rows) {
      const key = rec.key || "(no module name)";
      if (!index.has(key)) { index.set(key, groupsOfRows.length); groupsOfRows.push([]); }
      groupsOfRows[index.get(key)].push(rec);
    }
  }

  const templates = (tpl || {}).templates || {};
  const known = new Set(Object.values(templates).map((t) => t.type).filter(Boolean));
  for (const rec of rows) rec.type = normType(rec, known);
  // Channels counted from 0 in the workbook and from 1 in the templates (or the other way round): the rows are moved onto the
  // channel of the drawing, per IO type ('CH0' of the workbook is CH1 of the sheet)
  const shift = {};
  for (const type of new Set(rows.map((rec) => rec.type))) {
    const tchs = Object.values(templates).filter((t) => t.type === type && !t.perChannel).flatMap((t) => t.channels);
    const xchs = rows.filter((rec) => rec.type === type && rec.ch !== null).map((rec) => rec.ch);
    if (!tchs.length || !xchs.length) continue;
    const tBase = Math.min(...tchs), xBase = xchs.includes(0) ? 0 : 1;
    if (tBase <= 1 && tBase !== xBase) {
      shift[type] = tBase - xBase;
      colWarnings.push(`${type} channels are counted from ${xBase} in the workbook and from ${tBase} in the template: workbook channel ${xBase} is drawn as CH${tBase}, ${xBase + 1} as CH${tBase + 1} ...`);
    }
  }
  const modules = groupsOfRows.map((g, n) => makeModule(n + 1, g, templates, shift));
  const has = new Set(["iop", "iota", "iotype", "link", "module", "iom", "sysgroup"].filter((k) => k in col));
  has.add("chlabel"); // 'CH5' of a one-channel sheet
  if (["sys1", "sys2", "sys3"].some((k) => k in col)) has.add("sys");
  for (const g of Object.keys(groups)) has.add(g);
  if ("tb" in groups || "rtp" in groups) for (const k of ["tbname", "rtpname", "tb", "rtp"]) has.add(k);
  if ("jb" in groups) has.add("jbname");
  for (const m of modules) for (const sh of m.sheets) sh.texts = sheetTexts(m, sh, templates[sh.template], has);

  const missingSheets = {}, fallbackSheets = {}, needs = {};
  for (const m of modules) {
    for (const label of m.need) {
      if (!needs[label]) needs[label] = { label, modules: 0, have: !m.missing.includes(label) };
      needs[label].modules++;
    }
    const target = m.fallback ? fallbackSheets : missingSheets;
    for (const w of m.missing) (target[w] ||= []).push(m.module);
    delete m.need; delete m.fallback; delete m.missing;
  }
  const warnings = [...colWarnings];
  const blankRoles = new Set();
  for (const m of modules) for (const sh of m.sheets) if (sh.offset) for (const f of templates[sh.template].terms) if (!has.has(f.role) && !(f.relay && has.has("rtp"))) blankRoles.add(f.role);
  if (blankRoles.size) warnings.push(`Some sheets repeat a template for higher channels, and the workbook has no ${[...blankRoles].map((r) => ({ sys: "TB1 / TB2 (system TB)", tb: "TB NAME + terminal", rtp: "RTP NAME + terminal", jb: "JB NAME + terminal" })[r] || r).join(", ")} columns: those terminal numbers are left empty there. Add the columns to the workbook, or import a template for those channels.`);
  // A field tag on two channels is almost always a copy / paste error in the workbook
  const tagRows = new Map();
  for (const rec of rows) if (real(rec.tag) && !/SPARE/i.test(rec.tag)) tagRows.set(rec.tag, [...(tagRows.get(rec.tag) || []), rec.row]);
  const twice = [...tagRows].filter(([, rs]) => rs.length > 1);
  if (twice.length) warnings.push(`${twice.length} field tag(s) are on more than one channel: ${twice.slice(0, 6).map(([tag, rs]) => `${tag} (rows ${rs.join(", ")})`).join("; ")}${twice.length > 6 ? " …" : ""}.`);
  // Placeholders of the template ('LINK No: XXXX') the workbook has no column for stay as drawn
  for (const [key, label] of [["iota", "IOTA"], ["link", "LINK No"], ["iom", "IOM number"], ["module", "MODULE NAME"], ["iop", "IOP"]]) {
    if (has.has(key)) continue;
    const left = new Set();
    for (const m of modules) for (const sh of m.sheets) { const t = templates[sh.template]; if (key in t.header && /X{2,}/.test(t.header[key].t)) left.add(t.header[key].t); }
    if (left.size) warnings.push(`The workbook has no ${label} column: the template text stays as drawn (${[...left].sort().join(", ")}).`);
  }
  const byName = Object.fromEntries(modules.map((m) => [m.module, m]));
  const list = (mods) => `${mods.slice(0, 6).join(", ")}${mods.length > 6 ? " …" : ""}`;
  for (const [w, mods] of Object.entries(missingSheets)) {
    const n = mods.reduce((a, x) => a + (byName[x] ? byName[x].used : 0), 0);
    warnings.push(`The template set has no ${w} template - ${mods.length} module(s) (${n} used channels at most) get no sheet (${list(mods)}). Import that template on the Templates page.`);
  }
  for (const [w, mods] of Object.entries(fallbackSheets)) {
    warnings.push(`The template set has no ${w} template - its channels in ${mods.length} module(s) are drawn on the template of the same IO type (${list(mods)}). Import a ${w} template for a drawing of its own.`);
  }
  const counts = {};
  for (const m of modules) {
    const c = (counts[m.type] ||= { modules: 0, sheets: 0, used: 0, spare: 0 });
    c.modules++; c.sheets += m.sheets.length; c.used += m.used; c.spare += m.spare;
  }
  return {
    file: filename, sheet: sheet.name, headerRow: hdr, mode, dataRows: rows.length, yellowRows, modules, counts, warnings, needs: Object.values(needs),
    set: (tpl || {}).id || "", setBuilt: (tpl || {}).builtAt,
    columns: [...Object.keys(col).filter((k) => k in ALIASES).sort(), ...Object.keys(groups).sort()],
  };
}

/** {text handle: full text} of one sheet: what the drawing shows for this module. A value the workbook has no column for stays as the
 *  template draws it; a column that is empty for this module / channel gives an empty text (a wrong number is worse than none). */
export function sheetTexts(m, sh, t, has) {
  const out = {};
  const chNo = (f, ch) => (f.prefix ?? "CH") + String(ch).padStart(f.pad || 0, "0");
  const values = { iop: m.iop, iota: m.iota, iotype: m.type || m.iotype, link: m.link, module: m.module, iom: m.iom, tbname: sh.names.tb, rtpname: sh.names.rtp,
    sysgroup: sh.sysgroup, jbname: sh.jb };
  for (const [key, f] of Object.entries(t.header)) {
    if (key === "chlabel") { out[f.h] = chNo(f, sh.first); continue; }
    const v = values[key] ?? "";
    out[f.h] = has.has(key) ? f.prefix + (real(v) ? v : "") : f.t;
  }
  for (const f of t.chlabels || []) out[f.h] = chNo(f, f.ch + (sh.offset || 0)); // the channel numbers of this sheet
  const jbf = t.header.jbname, slots = t.jblines || [];
  for (const f of slots) out[f.h] = "";
  if (jbf && has.has("jbname") && slots.length) {
    const lines = listNames(sh.jbs || [], jbf, slots.length + 1);
    lines.forEach((line, i) => { // first line at the top, the last one on the line of the template
      const slot = lines.length - 1 - i;
      out[(slot === 0 ? jbf : slots[slot - 1]).h] = line;
    });
  }
  t.channels.forEach((ch, i) => {
    const c = sh.channels[i];
    let tag = "SPARE", desc = "SPARE";
    if (c && c.refer) { tag = "-"; desc = `REFER ${c.refer} SHEET (${c.tag})`; }
    else if (c) { tag = c.tag || "SPARE"; desc = c.desc || c.dcs_desc || "SPARE"; }
    out[t.tags[i].h] = t.tags[i].prefix + tag;
    out[t.descs[i].h] = t.descs[i].prefix + desc;
  });
  const index = new Map(t.channels.map((ch, i) => [ch, i]));
  for (const f of t.jbtags || []) { // the JB of every channel box, written again at each box
    const c = sh.channels[index.get(f.ch)];
    out[f.h] = has.has("jbname") && c && real(c.jb) ? c.jb : "";
  }
  for (const f of t.terms) {
    // no column for it: the number as drawn - except on a repeated sheet (CH9-16 on a CH1-8 template), where it would be CH1-8's
    if (!has.has(f.role) && !(f.relay && has.has("rtp"))) { out[f.h] = sh.offset ? "" : f.t; continue; }
    const c = sh.channels[index.get(f.ch)];
    const vals = c ? c.terms[f.role] || [] : [];
    const rtp = c ? c.terms.rtp || [] : [];
    const digits = (v) => { const n = /\d+/.exec(v); return n ? f.derive + n[0] : ""; };
    if (f.relay && rtp.length >= 4 && has.has("rtp")) { // the workbook lists all four relay terminals (1+ | 1- | P1 | O1): each is drawn as written
      const pos = f.role === "rtp" && !f.derive ? 2 + f.k : f.k;
      out[f.h] = f.derive ? digits(rtp[2]) : rtp[pos];
      continue;
    }
    let v = f.k < vals.length ? vals[f.k] : "";
    if (f.derive) v = digits(v); // the relay number 'R2' from its RTP terminal 'P2'
    out[f.h] = v ? v + (f.sfx || "") : "";
  }
  return out;
}

/** The JB names as a list: 'JB No. :' on top, then one JB per line. Every name is listed; only when there are more names than the
 *  drawing has lines, the last line takes the rest ('AJB-20 / AJB-21'). */
function listNames(names, f, maxLines) {
  let lines = [f.prefix.trim(), ...names];
  if (lines.length > maxLines) lines = [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(" / ")];
  return lines;
}

function terminalValues(rec) {
  const vals = (xs) => { const out = xs.map((x) => (real(x) ? x : "")); while (out.length && !out[out.length - 1]) out.pop(); return out; };
  const tb = vals(rec.tbT || []), rtp = vals(rec.rtpT || []), jb = vals(rec.jbT || []);
  const sys = vals([rec.sys1, rec.sys2, rec.sys3]);
  return { sys, tb: tb.length ? tb : rtp, rtp: rtp.length ? rtp : tb, jb };
}

/** [template ids, missing kinds, wiring kinds of the channels] for a module of this IO type. */
function pickTemplates(mtype, channels, templates) {
  const group = Object.entries(templates).filter(([, t]) => t.type === mtype)
    .sort((a, b) => (a[1].wire < b[1].wire ? -1 : a[1].wire > b[1].wire ? 1 : 0) || a[1].channels[0] - b[1].channels[0]);
  if (!group.length) return [[], [mtype || "?"], []];
  if (!group.some(([, t]) => t.wire)) return [group.map(([tid]) => tid), [], []];
  const def = group[0][1].wire;
  let kinds = [...new Set(Object.values(channels).map((c) => normWire(c.wire) || def))].sort();
  if (!kinds.length) kinds = [def];
  const ids = [], missing = [];
  for (const k of kinds) {
    const have = group.filter(([, t]) => t.wire === k).map(([tid]) => tid);
    // a one-channel-per-sheet template is drawn for every channel, so it also serves a wiring it was not made for
    const fallback = !have.length ? group.filter(([, t]) => t.perChannel).map(([tid]) => tid) : [];
    for (const tid of [...have, ...fallback]) if (!ids.includes(tid)) ids.push(tid);
    if (!have.length) missing.push(`${mtype} ${k}`);
  }
  return [ids, missing, kinds];
}

const MAX_CHANNEL = 256; // a channel number above this is a typing error, not a module that big

function makeModule(n, group, templates, shift = {}) {
  const head = {};
  for (const k of MODULE_KEYS) head[k] = mostCommon(group.map((rec) => rec[k]));
  head.type = mostCommon(group.map((rec) => rec.type));
  const m = { index: n, ...head, startRow: group[0].row, endRow: group[group.length - 1].row, rows: group.length };
  if (!m.module) m.module = mostCommon(group.map((rec) => rec.key)) || `Module ${n}`; // the name shown on the page (not written into the drawing)
  const warn = [];
  const names = [...new Set(group.filter((r) => r.module).map((r) => r.module))].sort();
  if (names.length > 1) warn.push(`Several MODULE NAMEs in one block: ${names.join(", ")}.`);
  const types = [...new Set(group.filter((r) => r.iotype).map((r) => r.type))].sort();
  if (types.length > 1) warn.push(`Several IO types in one block: ${types.join(", ")}.`);
  if (!m.type) warn.push("The IO type of this module is not known (no IO TYPE column, part number or module name that names it).");

  // The channel range of the templates of this type (a template of one channel per sheet does not say how many channels the module
  // has: only the ranges of the others do). When the workbook has more channels than the templates draw, the templates are drawn
  // again for the next channels (CH9-16 on a second CH1-8 sheet), as long as the templates can renumber their channel labels.
  const same = Object.values(templates).filter((t) => t.type === m.type && !t.perChannel);
  const tchs = same.flatMap((t) => t.channels);
  const lo = tchs.length ? Math.min(...tchs) : (shift[m.type] ?? 0) < 0 ? 0 : 1;
  const hi = tchs.length ? Math.max(...tchs) : ["DI", "DO"].includes(m.type) ? 32 : 16;
  const span = hi - lo + 1;
  const toCh = (rec) => (rec.ch === null ? null : rec.ch + (shift[m.type] || 0));
  const top = Math.max(0, ...group.map(toCh).filter((ch) => ch !== null && ch <= MAX_CHANNEL));
  const repeat = same.length > 0 && same.every((t) => t.chlabels && t.chlabels.length === t.channels.length);
  const pages = repeat && top > hi ? Math.ceil((top - lo + 1) / span) : 1;
  const capacity = lo - 1 + pages * span;
  if (pages > 1) warn.push(`The workbook has channels up to CH${top}, the template${same.length > 1 ? "s" : ""} draw${same.length > 1 ? "" : "s"} CH${lo}-${hi}: ${same.length > 1 ? "they are" : "it is"} drawn ${pages} times (CH${lo}-${hi}, CH${lo + span}-${hi + span}${pages > 2 ? " …" : ""}).`);
  else if (!repeat && same.length && top > hi) warn.push(`The template set is older than this program version: import the templates again to draw CH${hi + 1}-${top} too.`);
  const channels = {};
  for (const rec of group) {
    const ch = toCh(rec);
    if (ch === null) { warn.push(`Row ${rec.row}: CHANNEL '${rec.channel}' is not a channel number - row skipped.`); continue; }
    if (ch in channels) { warn.push(`Row ${rec.row}: CHANNEL ${rec.channel} is repeated (row ${channels[ch].row} has it too) - row skipped.`); continue; }
    if (!(ch >= lo && ch <= capacity)) { warn.push(`Row ${rec.row}: CHANNEL ${rec.channel} is outside ${lo}-${capacity} - row skipped.`); continue; }
    const c = {};
    for (const k of ["row", "tag", "c300", "desc", "dcs_desc", "wire", "sysgroup"]) c[k] = rec[k];
    c.tb = rec.tb ?? ""; c.rtp = rec.rtp ?? ""; c.jb = rec.jb ?? "";
    c.terms = terminalValues(rec);
    const tbT = (rec.tbT && rec.tbT.length ? rec.tbT : rec.rtpT) || [];
    c.tbname = real(c.tb) ? c.tb : c.rtp;
    [c.t1, c.t2, c.t3] = [...tbT, "", "", ""].slice(0, 3);
    channels[ch] = c;
  }
  const absent = []; for (let ch = lo; ch <= capacity; ch++) if (!(ch in channels)) absent.push(ch);
  if (absent.length) warn.push(`No Excel row for CH${absent.slice(0, 10).join(", CH")}${absent.length > 10 ? " …" : ""} - shown as SPARE.`);
  m.capacity = capacity - lo + 1;
  m.used = Object.values(channels).filter((c) => !isSpare(c)).length;
  m.spare = m.capacity - m.used;

  const [ids, missing, kinds] = pickTemplates(m.type, channels, templates);
  if (!Object.keys(templates).length) warn.push("No template set is loaded.");
  else if (missing.length && !ids.length) warn.push(`The template set has no template for ${missing[0]}.`);
  else if (missing.length && ids.every((i) => templates[i].perChannel)) warn.push(`No template for ${missing.join(", ")}: those channels are drawn on the ${ids.map((i) => templates[i].wire || "available").join(" / ")} template.`);
  else if (missing.length) warn.push(`No template for ${missing.join(", ")}: those channels are shown as 'REFER ... SHEET' only.`);
  if (kinds.length > 1 && !ids.every((i) => templates[i].perChannel)) warn.push("Module mixes " + kinds.join(" and ") + " channels: one sheet of each; the other kind is marked 'REFER ... SHEET'.");

  const sheets = [];
  for (let page = 0; page < pages; page++) for (const tid of ids) {
    const t = templates[tid], offset = page * span;
    if (t.perChannel && page) continue;
    if (t.perChannel) {
      // one sheet for every channel of the workbook, spare ones too (drawn as SPARE, so no channel number is missing in the set).
      // A channel goes to the template of its own wiring; when there is none, to this one (see pickTemplates)
      const exact = new Set(ids.map((i) => templates[i].wire));
      for (const ch of Object.keys(channels).map(Number).sort((a, b) => a - b)) {
        const c = channels[ch];
        const k = normWire(c.wire) || kinds[0];
        if (t.wire && k !== t.wire && exact.has(k)) continue;
        const tb = real(c.tb) ? c.tb : "", rtp = real(c.rtp) ? c.rtp : "";
        const jb = real(c.jb) ? [c.jb] : [];
        sheets.push({
          uid: `${tid}@${ch}`, per: true, template: tid, first: ch, last: ch, tbname: tb || rtp, names: { tb: tb || rtp, rtp: rtp || tb },
          sysgroup: real(c.sysgroup) ? c.sysgroup : "", jb: jb.join(" / "), jbs: jb, channels: [{ ...c, ch, refer: "" }], used: isSpare(c) ? 0 : 1,
        });
      }
      continue;
    }
    const chs = t.channels.map((ch) => ch + offset);
    const rowsOut = chs.map((ch) => {
      const c = channels[ch];
      let refer = "";
      if (c && kinds.length > 1 && !isSpare(c)) { // a spare channel is spare on every sheet
        const k = normWire(c.wire) || kinds[0];
        if (t.wire && k !== t.wire) refer = k[0] + "-WIRE";
      }
      return c ? { ...c, ch, refer } : null;
    });
    const present = rowsOut.filter(Boolean);
    const pick = (key) => mostCommon(present.filter((c) => real(c[key])).map((c) => c[key]));
    const jb = [];
    for (const c of present) if (real(c.jb) && !jb.includes(c.jb)) jb.push(c.jb);
    const tb = pick("tb"), rtp = pick("rtp");
    sheets.push({
      uid: offset ? `${tid}+${offset}` : tid, per: false, template: tid, first: chs[0], last: chs[chs.length - 1], offset, chs,
      tbname: tb || rtp, names: { tb: tb || rtp, rtp: rtp || tb },
      sysgroup: pick("sysgroup"), jb: jb.join(" / "), jbs: jb, channels: rowsOut, used: present.filter((c) => !isSpare(c) && !c.refer).length,
    });
  }
  m.sheets = sheets;
  m.warnings = warn;
  m.missing = missing;
  m.fallback = !!(missing.length && ids.length && ids.every((i) => templates[i].perChannel));
  m.need = kinds.length ? kinds.map((k) => `${m.type} ${k}`) : [m.type || "?"];
  return m;
}
