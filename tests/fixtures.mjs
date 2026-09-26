// Small synthetic drawings and workbooks for the tests (no customer data).
import JSZip from "jszip";
import { parseDxf } from "../web/js/core/dxf.js";

const pairs = (a) => a.join("\n") + "\n";
export const SAMPLE_DXF = pairs([
  "0", "SECTION", "2", "HEADER", "9", "$HANDSEED", "5", "100", "9", "$EXTMIN", "10", "0.0", "20", "0.0", "30", "0.0", "0", "ENDSEC",
  "0", "SECTION", "2", "TABLES",
  "0", "TABLE", "2", "LAYER", "5", "2", "0", "LAYER", "5", "10", "330", "2", "2", "0", "70", "0", "62", "7", "0", "ENDTAB",
  "0", "TABLE", "2", "STYLE", "5", "3", "0", "STYLE", "5", "11", "330", "3", "2", "Standard", "3", "arial.ttf", "0", "ENDTAB",
  "0", "ENDSEC",
  "0", "SECTION", "2", "BLOCKS",
  "0", "BLOCK", "5", "20", "8", "0", "2", "B1", "70", "0", "10", "0.0", "20", "0.0", "30", "0.0",
  "0", "LINE", "5", "21", "8", "0", "10", "0.0", "20", "0.0", "30", "0.0", "11", "10.0", "21", "0.0", "31", "0.0",
  "0", "ENDBLK", "5", "22", "8", "0",
  "0", "ENDSEC",
  "0", "SECTION", "2", "ENTITIES",
  "0", "INSERT", "5", "30", "8", "0", "2", "B1", "10", "100.0", "20", "50.0", "30", "0.0", "41", "-2.0", "42", "2.0", "43", "2.0",
  "0", "TEXT", "5", "31", "8", "0", "10", "50.0", "20", "60.0", "30", "0.0", "40", "10.0", "1", "HELLO", "7", "Standard", "72", "1", "11", "50.0", "21", "60.0", "31", "0.0", "73", "0",
  "0", "LWPOLYLINE", "5", "32", "8", "0", "90", "4", "70", "1", "10", "0.0", "20", "0.0", "10", "20.0", "20", "0.0", "10", "20.0", "20", "10.0", "10", "0.0", "20", "10.0",
  "0", "CIRCLE", "5", "33", "8", "0", "10", "5.0", "20", "5.0", "30", "0.0", "40", "2.0",
  "0", "ENDSEC",
  "0", "SECTION", "2", "OBJECTS", "0", "DICTIONARY", "5", "40", "0", "ENDSEC", "0", "EOF",
]);
export const sampleDoc = () => parseDxf(SAMPLE_DXF);

/** A minimal .xlsx with inline strings: rows = arrays of values; yellowRows = row numbers (1 based) filled yellow. */
export async function makeXlsx(rows, yellowRows = []) {
  const col = (i) => String.fromCharCode(65 + i);
  const cell = (v, r, i) => {
    if (v === null || v === undefined || v === "") return "";
    const ref = col(i) + r, s = yellowRows.includes(r) ? ' s="1"' : "";
    return typeof v === "number"
      ? `<c r="${ref}"${s}><v>${v}</v></c>`
      : `<c r="${ref}"${s} t="inlineStr"><is><t>${String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></is></c>`;
  };
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map((row, k) => `<row r="${k + 1}">${row.map((v, i) => cell(v, k + 1, i)).join("")}</row>`).join("")}</sheetData></worksheet>`;
  const z = new JSZip();
  z.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  z.file("xl/workbook.xml", '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="IO ASSIGNMENT" sheetId="1" r:id="rId1"/></sheets></workbook>');
  z.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
  z.file("xl/styles.xml", '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills><cellXfs count="2"><xf fillId="0"/><xf fillId="2"/></cellXfs></styleSheet>');
  z.file("xl/worksheets/sheet1.xml", sheet);
  return z.generateAsync({ type: "uint8array" });
}

/** A template set with one template of 2 channels (CH1-2): every text has a handle, the field list is what the reader needs. */
export function fakeSet() {
  const f = (h, t, extra = {}) => ({ h, t, x: 0, y: 0, s: 10, ha: 0, va: 0, prefix: "", w: 100, ...extra });
  const t = {
    file: "AI.dwg", sheet: 1, type: "AI", wire: "", title: "", channels: [1, 2], perChannel: false,
    header: { module: f("M1", "MODULE NAME: XXX", { prefix: "MODULE NAME: " }), iotype: f("T1", "IO TYPE : AI", { prefix: "IO TYPE : " }) },
    tags: [f("G1", "TAG"), f("G2", "TAG")], descs: [f("D1", "DESC"), f("D2", "DESC")],
    terms: [f("S1", "1", { role: "sys", side: 0, k: 0, ch: 1 }), f("S2", "2", { role: "sys", side: 0, k: 0, ch: 2 })],
    jblines: [], jbtags: [], sheetno: null, frameTotal: null, warnings: [],
  };
  return { id: "t", builtAt: 1, box: [0, 0, 1000, 700], templates: { AI: t } };
}
