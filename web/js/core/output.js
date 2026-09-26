// Display list -> PDF page content / SVG. The sheet is the frame box of the drawing scaled to an A1 page (PAGE_H points high).
export const PAGE_H = 1683.78;
export const HAIRLINE = 0.1; // pt, the stroke width of the drawing lines

export function pageSize(box) {
  const [x0, y0, x1, y1] = box;
  return [(PAGE_H * (x1 - x0)) / (y1 - y0), PAGE_H];
}

const n3 = (v) => (Math.round(v * 1000) / 1000).toString();

function pdfPath(cmds, tx, ty, s) {
  const X = (x) => n3((x - tx) * s), Y = (y) => n3((y - ty) * s);
  const out = [];
  for (const c of cmds) {
    if (c.t === "M") out.push(`${X(c.p[0])} ${Y(c.p[1])} m`);
    else if (c.t === "L") out.push(`${X(c.p[0])} ${Y(c.p[1])} l`);
    else if (c.t === "C") out.push(`${X(c.p[0])} ${Y(c.p[1])} ${X(c.p[2])} ${Y(c.p[3])} ${X(c.p[4])} ${Y(c.p[5])} c`);
    else if (c.t === "Z") out.push("h");
  }
  return out.join("\n");
}

/** PDF content stream of the blank sheet (white paper, hairlines, glyph fills, logos as image Im<n>). */
export function pdfContent(disp, box, logos = []) {
  const [x0, y0, x1, y1] = box;
  const [w, h] = pageSize(box);
  const s = w / (x1 - x0);
  const out = [`1 g\n0 0 ${n3(w)} ${n3(h)} re\nf`, `0 G\n${HAIRLINE} w\n1 J\n1 j`];
  for (const p of disp.strokes) out.push(pdfPath(p, x0, y0, s) + "\nS");
  out.push("0 g");
  for (const f of disp.fills) out.push(pdfPath(f.cmds, x0, y0, s) + (f.rule === "nonzero" ? "\nf" : "\nf*"));
  logos.forEach((l, i) => {
    const [lx0, ly0, lx1, ly1] = l.rect;
    out.push(`q ${n3((lx1 - lx0) * s)} 0 0 ${n3((ly1 - ly0) * s)} ${n3((lx0 - x0) * s)} ${n3((ly0 - y0) * s)} cm /Im${i} Do Q`);
  });
  return out.join("\n");
}

function svgPath(cmds, tx, ty, s, H) {
  const X = (x) => n3((x - tx) * s), Y = (y) => n3(H - (y - ty) * s);
  const out = [];
  for (const c of cmds) {
    if (c.t === "M") out.push(`M${X(c.p[0])} ${Y(c.p[1])}`);
    else if (c.t === "L") out.push(`L${X(c.p[0])} ${Y(c.p[1])}`);
    else if (c.t === "C") out.push(`C${X(c.p[0])} ${Y(c.p[1])} ${X(c.p[2])} ${Y(c.p[3])} ${X(c.p[4])} ${Y(c.p[5])}`);
    else if (c.t === "Z") out.push("Z");
  }
  return out.join("");
}

/** SVG of the blank sheet (viewBox in page points, like the PDF); logos: [{rect, href}] */
export function svgSheet(disp, box, logos = []) {
  const [x0, y0, x1, y1] = box;
  const [w, h] = pageSize(box);
  const s = w / (x1 - x0);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${n3(w)} ${n3(h)}" width="${n3(w)}" height="${n3(h)}">`,
    `<rect width="${n3(w)}" height="${n3(h)}" fill="#fff"/>`];
  parts.push(`<path fill="none" stroke="#000" stroke-width="${HAIRLINE}" stroke-linecap="round" stroke-linejoin="round" d="${disp.strokes.map((p) => svgPath(p, x0, y0, s, h)).join("")}"/>`);
  const ev = disp.fills.filter((f) => f.rule !== "nonzero"), nz = disp.fills.filter((f) => f.rule === "nonzero");
  if (ev.length) parts.push(`<path fill="#000" fill-rule="evenodd" d="${ev.map((f) => svgPath(f.cmds, x0, y0, s, h)).join("")}"/>`);
  if (nz.length) parts.push(`<path fill="#000" fill-rule="nonzero" d="${nz.map((f) => svgPath(f.cmds, x0, y0, s, h)).join("")}"/>`);
  for (const l of logos) {
    const [lx0, ly0, lx1, ly1] = l.rect;
    parts.push(`<image x="${n3((lx0 - x0) * s)}" y="${n3(h - (ly1 - y0) * s)}" width="${n3((lx1 - lx0) * s)}" height="${n3((ly1 - ly0) * s)}" preserveAspectRatio="none" xlink:href="${l.href}"/>`);
  }
  parts.push("</svg>");
  return parts.join("\n");
}
