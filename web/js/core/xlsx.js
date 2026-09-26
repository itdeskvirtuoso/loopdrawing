// Small .xlsx / .xlsm reader: cell values and the fill colour (yellow rows) of the cells, fast enough for very large workbooks.
// (An .xlsx is a ZIP of XML files: sharedStrings, workbook, one file per sheet, styles.)

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unesc = (s) => (s.indexOf("&") < 0 ? s : s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e])));

function colIndex(ref) { // 'AB12' -> 27 (0 based)
  let n = 0;
  for (let i = 0; i < ref.length; i++) { const c = ref.charCodeAt(i); if (c < 65) break; n = n * 26 + (c - 64); }
  return n - 1;
}

function attr(tag, name) {
  const m = new RegExp("\\b" + name + '="([^"]*)"').exec(tag);
  return m ? m[1] : null;
}

function sharedStrings(xml) {
  const out = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (!m[1]) { out.push(""); continue; }
    let s = "";
    const t = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let x;
    while ((x = t.exec(m[1]))) s += unesc(x[1]);
    out.push(s);
  }
  return out;
}

function isYellowRgb(rgb) {
  if (!rgb || rgb.length < 6) return false;
  const h = rgb.slice(-6), r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return r >= 0xc8 && g >= 0xc8 && b <= 0x99;
}
const YELLOW_INDEXED = new Set([5, 13, 43, 51]);
function colorIsYellow(tag) {
  if (!tag) return false;
  const rgb = attr(tag, "rgb");
  if (rgb) return isYellowRgb(rgb);
  const idx = attr(tag, "indexed");
  return idx !== null && YELLOW_INDEXED.has(parseInt(idx, 10));
}

/** styleIndex -> true when the cell style has a yellow fill. */
function yellowStyles(xml) {
  if (!xml) return [];
  const fills = [];
  const fm = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(xml);
  if (fm) {
    const re = /<fill\b[^>]*>([\s\S]*?)<\/fill>/g;
    let m;
    while ((m = re.exec(fm[1]))) {
      const pf = /<patternFill\b([^>]*?)(?:\/>|>([\s\S]*?)<\/patternFill>)/.exec(m[1]);
      if (!pf) { fills.push(false); continue; }
      const type = attr(pf[1], "patternType");
      const fg = /<fgColor\b[^>]*\/?>/.exec(pf[2] || ""), bg = /<bgColor\b[^>]*\/?>/.exec(pf[2] || "");
      fills.push(!!type && type !== "none" && (colorIsYellow(fg && fg[0]) || colorIsYellow(bg && bg[0])));
    }
  }
  const xfs = [];
  const cm = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (cm) {
    const re = /<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g;
    let m;
    while ((m = re.exec(cm[1]))) { const id = attr(m[1], "fillId"); xfs.push(id !== null && !!fills[parseInt(id, 10)]); }
  }
  return xfs;
}

export class Workbook {
  constructor(files, sheets, strings, yellow) { this.files = files; this.sheets = sheets; this.strings = strings; this.yellow = yellow; }

  /**
   * Calls onRow(rowNumber, values, yellowFlags) for the rows of a sheet (values: array by column, string | number | boolean | null;
   * yellowFlags: array by column, true where the cell has a yellow fill). onRow returns false to stop.
   */
  async scan(sheet, onRow) {
    const xml = await this.files.file(sheet.path).async("string");
    const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
    let rm, autoRow = 0;
    while ((rm = rowRe.exec(xml))) {
      autoRow++;
      const rn = attr(rm[1], "r");
      const rowNo = rn ? parseInt(rn, 10) : autoRow;
      const values = [], flags = [];
      if (rm[2]) {
        const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let cm, auto = -1;
        while ((cm = cellRe.exec(rm[2]))) {
          const ref = attr(cm[1], "r");
          const ci = ref ? colIndex(ref) : ++auto;
          auto = ci;
          const t = attr(cm[1], "t"), s = attr(cm[1], "s");
          let v = null;
          if (cm[2]) {
            if (t === "inlineStr") {
              const parts = []; const tr = /<t\b[^>]*>([\s\S]*?)<\/t>/g; let x;
              while ((x = tr.exec(cm[2]))) parts.push(unesc(x[1]));
              v = parts.join("");
            } else {
              const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cm[2]);
              if (vm) {
                const raw = vm[1];
                if (t === "s") v = this.strings[parseInt(raw, 10)] ?? "";
                else if (t === "str" || t === "e") v = unesc(raw);
                else if (t === "b") v = raw === "1" ? "True" : "False";
                else v = raw === "" ? null : Number(raw);
              }
            }
          }
          if (v !== null) values[ci] = v;
          if (s !== null && this.yellow[parseInt(s, 10)]) flags[ci] = true;
        }
      }
      if (onRow(rowNo, values, flags) === false) break;
    }
  }
}

/** JSZip = the JSZip library; data: ArrayBuffer / Uint8Array of the workbook. */
export async function openWorkbook(JSZip, data) {
  let zip;
  try { zip = await JSZip.loadAsync(data); } catch { throw new Error("not a readable .xlsx / .xlsm file"); }
  const text = async (p) => { const f = zip.file(p); return f ? f.async("string") : null; };
  const wbXml = await text("xl/workbook.xml");
  if (!wbXml) throw new Error("not a readable .xlsx / .xlsm file (no xl/workbook.xml)");
  const relXml = (await text("xl/_rels/workbook.xml.rels")) || "";
  const rels = {};
  for (const m of relXml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) { const id = attr(m[1], "Id"), tg = attr(m[1], "Target"); if (id && tg) rels[id] = tg.startsWith("/") ? tg.slice(1) : "xl/" + tg.replace(/^\.\//, ""); }
  const sheets = [];
  for (const m of wbXml.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const name = unesc(attr(m[1], "name") || "");
    const rid = attr(m[1], "r:id");
    if (rid && rels[rid]) sheets.push({ name, path: rels[rid] });
  }
  const ss = await text("xl/sharedStrings.xml");
  return new Workbook(zip, sheets, ss ? sharedStrings(ss) : [], yellowStyles(await text("xl/styles.xml")));
}
