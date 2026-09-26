// Text of drawings: glyph outlines from the bundled font and the same layout rules the PDF of the old (Python) program used,
// so that texts stand where they always did. Measures are those of Arial (cap height of 'A', x height, depth of 'p'): the bundled
// Liberation Sans has the same advance widths as Arial, its outlines are stretched vertically to Arial's cap height.

export const ARIAL = { upem: 2048, cap: 1466, xh: 1062, desc: 407 };
export const CAP = ARIAL.cap / ARIAL.upem; // 0.7158 - a DXF text height is the cap height

export class TextEngine {
  constructor(font, libCap = 1409) {
    this.font = font;                       // opentype.js font (Liberation Sans)
    this.yScale = ARIAL.cap / libCap;       // outlines are made as tall as Arial's
    this._glyph = new Map();
  }
  glyph(ch) {
    let g = this._glyph.get(ch);
    if (!g) {
      const og = this.font.charToGlyph(ch);
      const cmds = og.path.commands.map((c) => ({ ...c }));
      g = { adv: og.advanceWidth || 0, cmds };
      this._glyph.set(ch, g);
    }
    return g;
  }
  /** Length of a text line (no kerning, like Arial has none in the old program), drawing units. */
  width(text, capH, wf = 1) {
    let w = 0;
    for (const ch of text) w += this.glyph(ch).adv;
    return (w * capH * wf) / ARIAL.cap;
  }
  /** Outlines of one text line: [{t:'M'|'L'|'C'|'Z', ...}] with the baseline start at (0, 0), y up. */
  path(text, capH, wf = 1, oblique = 0) {
    const sx = (capH * wf) / ARIAL.cap, sy = (capH / ARIAL.cap) * this.yScale;
    const shear = Math.abs(oblique) > 1e-3 ? Math.tan((oblique * Math.PI) / 180) : 0;
    const out = [];
    let x = 0;
    for (const ch of text) {
      const g = this.glyph(ch);
      let cx = 0, cy = 0;
      const P = (px, py) => [x + px * sx + py * sy * shear, py * sy];
      for (const c of g.cmds) {
        if (c.type === "M") { out.push({ t: "M", p: P(c.x, c.y) }); cx = c.x; cy = c.y; }
        else if (c.type === "L") { out.push({ t: "L", p: P(c.x, c.y) }); cx = c.x; cy = c.y; }
        else if (c.type === "C") { out.push({ t: "C", p: [...P(c.x1, c.y1), ...P(c.x2, c.y2), ...P(c.x, c.y)] }); cx = c.x; cy = c.y; }
        else if (c.type === "Q") { // quadratic -> cubic
          const c1x = cx + (2 / 3) * (c.x1 - cx), c1y = cy + (2 / 3) * (c.y1 - cy);
          const c2x = c.x + (2 / 3) * (c.x1 - c.x), c2y = c.y + (2 / 3) * (c.y1 - c.y);
          out.push({ t: "C", p: [...P(c1x, c1y), ...P(c2x, c2y), ...P(c.x, c.y)] });
          cx = c.x; cy = c.y;
        } else if (c.type === "Z") out.push({ t: "Z" });
      }
      x += (g.adv * capH * wf) / ARIAL.cap;
    }
    return out;
  }
}

// AutoCAD % codes of TEXT: %%d degree, %%p plus/minus, %%c diameter, %%% percent (%%u / %%o toggles are dropped)
export function plainText(s) {
  return s
    .replace(/%%[dD]/g, "°").replace(/%%[pP]/g, "±").replace(/%%[cC]/g, "⌀").replace(/%%%/g, "%")
    .replace(/%%[uUoO]/g, "");
}

// TEXT alignment (halign, valign) -> [horizontal, vertical] as in ezdxf: h 0 left / 1 centre / 2 right, v 'base' 'bottom' 'mid' 'top'
const H = { 0: 0, 1: 1, 2: 2, 3: 1, 4: 1, 5: 1 };
export function textAlignment(ha, va) {
  if (ha === 4) return [1, "mid"];                    // MIDDLE
  if (ha === 3 || ha === 5) return [1, "base"];       // ALIGNED / FIT (stretched separately)
  return [H[ha] ?? 0, ["base", "bottom", "mid", "top"][va] ?? "base"];
}

/** Anchor (x, y) of a single text line measured from its (left, baseline) origin, like ezdxf's _apply_alignment. */
export function anchorOf(h, v, width, capH) {
  const desc = (ARIAL.desc / ARIAL.cap) * capH;
  const ax = h === 0 ? 0 : h === 1 ? width / 2 : width;
  const baseline = -capH; // ezdxf measures lines downwards from the top of the first line (top = 0)
  let ay;
  if (v === "top") ay = 0;
  else if (v === "mid") ay = (baseline + capH + baseline) / 2 - 0; // upper case centre: between cap top and baseline
  else if (v === "bottom") ay = baseline - desc;
  else ay = baseline;
  return [ax, ay, baseline];
}
