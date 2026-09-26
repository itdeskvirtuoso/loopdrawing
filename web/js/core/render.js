// Drawing (Dxf) -> display list of paths in drawing coordinates: strokes (hairlines) and fills (glyphs, wide polylines).
// The same list is written into the PDF of a sheet and into the SVG of the on-screen preview.
import { plainText, textAlignment, anchorOf, ARIAL } from "./text.js";
import { parseMText } from "./mtext.js";

// ------------------------------------------------------------------------------------------------ matrices [a b c d e f]
export const IDENT = [1, 0, 0, 1, 0, 0];
export const mulM = (o, i) => [
  o[0] * i[0] + o[2] * i[1], o[1] * i[0] + o[3] * i[1],
  o[0] * i[2] + o[2] * i[3], o[1] * i[2] + o[3] * i[3],
  o[0] * i[4] + o[2] * i[5] + o[4], o[1] * i[4] + o[3] * i[5] + o[5],
]; // outer(inner(p))
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const trans = (x, y) => [1, 0, 0, 1, x, y];
export const scaleM = (x, y) => [x, 0, 0, y, 0, 0];
export const rotM = (deg) => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return [c, s, -s, c, 0, 0]; };
const flipZ = (ent) => (ent.num(230, 1) < 0 ? [-1, 0, 0, 1, 0, 0] : IDENT); // OCS -> WCS for the extrusion (0, 0, -1)

export function insertMatrix(ins, block) {
  const bp = block ? block.begin.point() : { x: 0, y: 0 };
  const sx = ins.num(41, 1), sy = ins.num(42, 1);
  const p = ins.point();
  let m = mulM(trans(p.x, p.y), mulM(rotM(ins.num(50, 0)), mulM(scaleM(sx, sy), trans(-bp.x, -bp.y))));
  return mulM(flipZ(ins), m);
}

// ------------------------------------------------------------------------------------------------ curves
/** Cubic Béziers of the ellipse C + U cos t + V sin t from t0 to t1 (t1 < t0 walks clockwise); adds an initial 'M' when first. */
function ellipseCmds(c, u, v, t0, t1, m, out, first = true) {
  const n = Math.max(1, Math.ceil(Math.abs(t1 - t0) / (Math.PI / 2) - 1e-9));
  const dt = (t1 - t0) / n, k = (4 / 3) * Math.tan(dt / 4);
  const pt = (t) => [c[0] + u[0] * Math.cos(t) + v[0] * Math.sin(t), c[1] + u[1] * Math.cos(t) + v[1] * Math.sin(t)];
  const dv = (t) => [-u[0] * Math.sin(t) + v[0] * Math.cos(t), -u[1] * Math.sin(t) + v[1] * Math.cos(t)];
  const T = (p) => apply(m, p[0], p[1]);
  if (first) out.push({ t: "M", p: T(pt(t0)) });
  for (let i = 0; i < n; i++) {
    const a = t0 + i * dt, b = a + dt;
    const pa = pt(a), pb = pt(b), da = dv(a), db = dv(b);
    out.push({ t: "C", p: [...T([pa[0] + k * da[0], pa[1] + k * da[1]]), ...T([pb[0] - k * db[0], pb[1] - k * db[1]]), ...T(pb)] });
  }
}

function bulgeSegment(p1, p2, bulge, m, out) {
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1], d = Math.hypot(dx, dy);
  if (d < 1e-12) return;
  const theta = 4 * Math.atan(bulge);              // signed sweep, ccw for a positive bulge
  const r = d / (2 * Math.sin(Math.abs(theta) / 2));
  const off = d / 2 / Math.tan(theta / 2);         // centre: from the middle of the chord, along its left normal
  const cx = (p1[0] + p2[0]) / 2 + (-dy / d) * off, cy = (p1[1] + p2[1]) / 2 + (dx / d) * off;
  const a0 = Math.atan2(p1[1] - cy, p1[0] - cx);
  ellipseCmds([cx, cy], [r, 0], [0, r], a0, a0 + theta, m, out, false);
}

// ------------------------------------------------------------------------------------------------ the display list
export class Display {
  constructor() { this.strokes = []; this.fills = []; this.images = []; }
}

/**
 * options: { engine: TextEngine, blank: Set of handles whose text is not drawn, maxDepth }
 * Returns a Display; every coordinate is a drawing coordinate (y up).
 */
export function buildDisplay(doc, options) {
  const disp = new Display();
  const ctx = { doc, disp, engine: options.engine, blank: options.blank || new Set(), depth: options.maxDepth ?? 6, textOf: options.textOf };
  drawEntities(ctx, doc.msp, IDENT, 0);
  return disp;
}

function styleOf(doc, name) {
  const s = doc.style(name);
  return { width: s ? s.num(41, 1) || 1 : 1, oblique: s ? s.num(51, 0) : 0, font: s ? s.get(3, "") : "" };
}

function drawEntities(ctx, ents, m, depth) {
  for (const e of ents) {
    try {
      drawEntity(ctx, e, m, depth);
    } catch (err) {
      ctx.disp.errors = (ctx.disp.errors || 0) + 1;
    }
  }
}

function pushPath(ctx, cmds, closed) {
  if (closed) cmds.push({ t: "Z" });
  ctx.disp.strokes.push(cmds);
}

function drawEntity(ctx, e, m, depth) {
  const T = (x, y) => apply(m, x, y);
  switch (e.type) {
    case "LINE": {
      const a = e.point(10, 20, 30), b = e.point(11, 21, 31);
      pushPath(ctx, [{ t: "M", p: T(a.x, a.y) }, { t: "L", p: T(b.x, b.y) }], false);
      break;
    }
    case "LWPOLYLINE": lwpolyline(ctx, e, m); break;
    case "CIRCLE": {
      const c = e.point(), r = e.num(40), mm = mulM(m, flipZ(e));
      const out = [];
      ellipseCmds([c.x, c.y], [r, 0], [0, r], 0, 2 * Math.PI, mm, out);
      pushPath(ctx, out, true);
      break;
    }
    case "ARC": {
      const c = e.point(), r = e.num(40), mm = mulM(m, flipZ(e));
      let a0 = (e.num(50) * Math.PI) / 180, a1 = (e.num(51) * Math.PI) / 180;
      while (a1 <= a0) a1 += 2 * Math.PI;
      const out = [];
      ellipseCmds([c.x, c.y], [r, 0], [0, r], a0, a1, mm, out);
      pushPath(ctx, out, false);
      break;
    }
    case "ELLIPSE": {
      const c = e.point(), mj = e.point(11, 21, 31), ratio = e.num(40, 1);
      const n = e.point(210, 220, 230);
      const nz = e.has(230) ? n.z : 1;
      // minor axis = normal x major axis * ratio (2D: rotate the major axis by 90 degrees, mirrored when the normal points down)
      const mn = nz < 0 ? [mj.y * ratio, -mj.x * ratio] : [-mj.y * ratio, mj.x * ratio];
      let t0 = e.num(41, 0), t1 = e.num(42, 2 * Math.PI);
      while (t1 <= t0) t1 += 2 * Math.PI;
      const out = [];
      ellipseCmds([c.x, c.y], [mj.x, mj.y], mn, t0, t1, m, out);
      pushPath(ctx, out, Math.abs(t1 - t0 - 2 * Math.PI) < 1e-6);
      break;
    }
    case "INSERT": {
      if (depth >= ctx.depth) break;
      const block = ctx.doc.block(e.get(2, ""));
      if (!block || block.isXref) break;
      const mm = mulM(m, insertMatrix(e, block));
      drawEntities(ctx, block.ents, mm, depth + 1);
      break;
    }
    case "TEXT": drawText(ctx, e, m); break;
    case "ATTRIB": if (!(e.int(70, 0) & 1)) drawText(ctx, e, m); break; // an attribute value of an INSERT (invisible ones are not drawn)
    case "HATCH": drawHatch(ctx, e, m); break;
    case "MTEXT": drawMText(ctx, e, m); break;
    case "SOLID": {
      const p = [e.point(10, 20, 30), e.point(11, 21, 31), e.point(12, 22, 32), e.point(13, 23, 33)];
      const order = [0, 1, 3, 2];
      const cmds = order.map((i, k) => ({ t: k ? "L" : "M", p: T(p[i].x, p[i].y) }));
      cmds.push({ t: "Z" });
      ctx.disp.fills.push({ cmds, rule: "nonzero" });
      break;
    }
    default: break; // OLE2FRAME (logos are placed separately), attributes, dimensions ... are not drawn
  }
}

function lwpolyline(ctx, e, m) {
  const flag = e.int(70, 0), closed = (flag & 1) !== 0;
  const mm = mulM(m, flipZ(e));
  const pts = [];
  let cur = null;
  for (const [code, val] of e.pairs) {
    if (code === 10) { cur = { x: parseFloat(val), y: 0, b: 0, sw: null, ew: null }; pts.push(cur); }
    else if (code === 20 && cur) cur.y = parseFloat(val);
    else if (code === 42 && cur) cur.b = parseFloat(val);
    else if (code === 40 && cur) cur.sw = parseFloat(val);
    else if (code === 41 && cur) cur.ew = parseFloat(val);
  }
  if (pts.length < 2) return;
  const cw = e.num(43, 0);
  const wide = cw > 0 || pts.some((p) => (p.sw || 0) > 0 || (p.ew || 0) > 0);
  const n = pts.length, segs = closed ? n : n - 1;
  if (wide) { // segments of a wide polyline are filled quads
    const quads = [];
    for (let i = 0; i < segs; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      if (Math.abs(p.b) > 1e-9) continue; // wide arcs are not drawn wide
      const sw = cw > 0 ? cw : p.sw || 0, ew = cw > 0 ? cw : p.ew || sw;
      const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1, nx = -dy / d, ny = dx / d;
      const c = [[p.x + (nx * sw) / 2, p.y + (ny * sw) / 2], [q.x + (nx * ew) / 2, q.y + (ny * ew) / 2], [q.x - (nx * ew) / 2, q.y - (ny * ew) / 2], [p.x - (nx * sw) / 2, p.y - (ny * sw) / 2]];
      const cmds = c.map((pt, k) => ({ t: k ? "L" : "M", p: apply(mm, pt[0], pt[1]) }));
      cmds.push({ t: "Z" });
      quads.push({ cmds, rule: "nonzero" });
    }
    ctx.disp.fills.push(...quads);
    return;
  }
  const out = [{ t: "M", p: apply(mm, pts[0].x, pts[0].y) }];
  for (let i = 0; i < segs; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    if (Math.abs(p.b) > 1e-9) bulgeSegment([p.x, p.y], [q.x, q.y], p.b, mm, out);
    else out.push({ t: "L", p: apply(mm, q.x, q.y) });
  }
  pushPath(ctx, out, closed);
}

// ------------------------------------------------------------------------------------------------ hatch (solid fills)
/** Boundary loops of a HATCH as arrays of commands in the entity's coordinates. */
function hatchLoops(e, m) {
  const P = e.pairs;
  let i = P.findIndex((p) => p[0] === 91);
  if (i < 0) return [];
  const nLoops = parseInt(P[i][1], 10);
  i++;
  const loops = [];
  const num = (k) => parseFloat(P[k][1]);
  for (let l = 0; l < nLoops && i < P.length; l++) {
    while (i < P.length && P[i][0] !== 92) i++;
    if (i >= P.length) break;
    const flags = parseInt(P[i][1], 10); i++;
    const cmds = [];
    if (flags & 2) { // polyline path: [72 bulge flag] [73 closed] [93 vertices] then 10 / 20 [/ 42]
      let bulgeFlag = 0, n = 0;
      while (i < P.length && [72, 73, 93].includes(P[i][0])) { if (P[i][0] === 72) bulgeFlag = parseInt(P[i][1], 10); if (P[i][0] === 93) n = parseInt(P[i][1], 10); i++; }
      const v = [];
      for (let k = 0; k < n && i < P.length; k++) {
        const x = num(i), y = num(i + 1); i += 2;
        let b = 0;
        if (bulgeFlag && P[i] && P[i][0] === 42) { b = num(i); i++; }
        v.push([x, y, b]);
      }
      if (v.length) {
        cmds.push({ t: "M", p: apply(m, v[0][0], v[0][1]) });
        for (let k = 0; k < v.length; k++) {
          const a = v[k], c = v[(k + 1) % v.length];
          if (Math.abs(a[2]) > 1e-9) bulgeSegment([a[0], a[1]], [c[0], c[1]], a[2], m, cmds);
          else cmds.push({ t: "L", p: apply(m, c[0], c[1]) });
        }
        cmds.push({ t: "Z" });
      }
    } else { // edge path: 93 edge count, then edges (72 type)
      const nEdges = parseInt(P[i][1], 10); i++;
      let cur = null;
      for (let k = 0; k < nEdges && i < P.length; k++) {
        const type = parseInt(P[i][1], 10); i++;
        if (type === 1) { const a = [num(i), num(i + 1)], b = [num(i + 2), num(i + 3)]; i += 4; if (!cur) cmds.push({ t: "M", p: apply(m, a[0], a[1]) }); cmds.push({ t: "L", p: apply(m, b[0], b[1]) }); cur = b; }
        else if (type === 2) { // arc: center, radius, start / end angle (degrees), counterclockwise flag
          const c = [num(i), num(i + 1)], r = num(i + 2); let a0 = (num(i + 3) * Math.PI) / 180, a1 = (num(i + 4) * Math.PI) / 180; const ccw = parseInt(P[i + 5][1], 10); i += 6;
          if (!ccw) { [a0, a1] = [2 * Math.PI - a0, 2 * Math.PI - a1]; }
          while (ccw ? a1 <= a0 : a1 >= a0) a1 += ccw ? 2 * Math.PI : -2 * Math.PI;
          const sign = ccw ? 1 : -1;
          ellipseCmds(c, [r, 0], [0, r * sign], a0 * sign, a1 * sign, m, cmds, !cur);
          cur = [c[0] + r * Math.cos(a1), c[1] + r * Math.sin(a1) * sign];
        } else if (type === 3) { // ellipse: center, major axis end point (relative), ratio, start / end angle, ccw
          const c = [num(i), num(i + 1)], mj = [num(i + 2), num(i + 3)], ratio = num(i + 4); let t0 = (num(i + 5) * Math.PI) / 180, t1 = (num(i + 6) * Math.PI) / 180; i += 8;
          while (t1 <= t0) t1 += 2 * Math.PI;
          ellipseCmds(c, mj, [-mj[1] * ratio, mj[0] * ratio], t0, t1, m, cmds, !cur);
          cur = [c[0] + mj[0] * Math.cos(t1) - mj[1] * ratio * Math.sin(t1), c[1] + mj[1] * Math.cos(t1) + mj[0] * ratio * Math.sin(t1)];
        } else { // spline: the fit / control points as a polyline
          i++; i++; const nk = parseInt(P[i][1], 10); i++; const nc = parseInt(P[i][1], 10); i++;
          i += nk; const pts = [];
          for (let q = 0; q < nc; q++) { pts.push([num(i), num(i + 1)]); i += 2; }
          for (const pt of pts) cmds.push({ t: cmds.length ? "L" : "M", p: apply(m, pt[0], pt[1]) });
        }
      }
      if (cmds.length) cmds.push({ t: "Z" });
    }
    while (i < P.length && P[i][0] === 97) { const n = parseInt(P[i][1], 10); i++; i += n; } // source boundary objects
    if (cmds.length) loops.push(cmds);
  }
  return loops;
}

function drawHatch(ctx, e, m) {
  if (!e.int(70, 0)) return; // patterned hatches (lines) are not drawn, only solid fills
  const cmds = [];
  for (const l of hatchLoops(e, mulM(m, flipZ(e)))) cmds.push(...l);
  if (cmds.length) ctx.disp.fills.push({ cmds, rule: "evenodd" });
}

// ------------------------------------------------------------------------------------------------ text
function emitText(ctx, cmds, m, rule = "evenodd") {
  if (!cmds.length) return;
  ctx.disp.fills.push({ cmds: cmds.map((c) => (c.t === "Z" ? c : { t: c.t, p: mapPts(m, c.p) })), rule });
}
function mapPts(m, p) {
  const o = [];
  for (let i = 0; i < p.length; i += 2) o.push(...apply(m, p[i], p[i + 1]));
  return o;
}

function drawText(ctx, e, m) {
  if (Math.abs(e.num(210, 0)) + Math.abs(e.num(220, 0)) > 1e-9) return; // 3D text is not drawn
  const h = ctx.engine;
  let text = ctx.textOf ? ctx.textOf(e) : e.getAll(1).join("");
  if (ctx.blank.has(e.handle)) text = "";
  text = plainText(text);
  if (!text.trim()) return;
  const height = e.num(40, 0);
  if (height <= 0) return;
  const ha = e.int(72, 0), va = e.type === "ATTRIB" ? e.int(74, 0) : e.int(73, 0);
  const style = styleOf(ctx.doc, e.get(7, "Standard"));
  const wf = e.num(41, 1) || 1; // TEXT width factor (the style's factor is applied by AutoCAD too, but ezdxf ignores it)
  const [hh, vv] = textAlignment(ha, va);
  const ins = e.point(10, 20, 30), al = e.point(11, 21, 31);
  let p = ins;
  if (ha || va) p = ha === 3 || ha === 5 ? { x: (ins.x + al.x) / 2, y: (ins.y + al.y) / 2 } : al;
  const w = h.width(text, height);
  const [ax, ay, base] = anchorOf(hh, vv, w, height);
  const lineX = hh === 0 ? 0 : hh === 1 ? ax - w / 2 : ax - w;
  let sx = wf, sy = 1;
  if (ha === 3 || ha === 5) {
    const len = Math.hypot(al.x - ins.x, al.y - ins.y);
    if (len > 1e-9 && w > 1e-9) { sx = len / w; if (ha === 3) sy = sx; }
  }
  const flags = e.int(71, 0);
  if (flags & 2) sx *= -1;
  if (flags & 4) sy *= -1;
  sx *= e.num(230, 1) < 0 ? -1 : 1;
  const local = mulM(trans(p.x, p.y), mulM(rotM(e.num(50, 0)), mulM(scaleM(sx, sy), trans(lineX - ax, base - ay))));
  emitText(ctx, h.path(text, height, 1), mulM(m, local));
}

/**
 * Layout of an MTEXT: the runs of text with their baseline start relative to the insertion point (before the rotation), so that a
 * run can be drawn as glyphs (PDF / screen) or written as a TEXT entity (DWG). Null when there is nothing to draw.
 */
export function layoutMText(e, engine, doc, rawOverride = null) {
  const raw = rawOverride ?? e.getAll(3).join("") + e.get(1, "");
  const ch = e.num(40, 0);
  if (ch <= 0) return null;
  const att = e.int(71, 1);
  const boxW = e.num(41, 0);
  const style = styleOf(doc, e.get(7, "Standard"));
  const par = parseMText(raw, { cap: ch, wf: style.width || 1, oblique: style.oblique, align: [0, 1, 2, 0, 1, 2, 0, 1, 2][(att - 1) % 9] ?? 0 });
  const lines = wrapMText(par, engine, boxW);
  if (!lines.length) return null;
  const box = boxW > 1e-6 ? boxW : Math.max(...lines.map((l) => l.width));
  const spacing = ch * 1.667 * e.num(44, 1);
  const first = lines[0].cap || ch;
  const ys = lines.map((l, i) => -first - i * spacing); // top of the first line = 0
  const last = ys[ys.length - 1];
  const hv = (att - 1) % 3, vv = Math.floor((att - 1) / 3); // horizontal 0 left / 1 centre / 2 right; vertical 0 top / 1 middle / 2 bottom
  const anchorX = hv === 0 ? 0 : hv === 1 ? box / 2 : box;
  const anchorY = vv === 0 ? 0 : vv === 1 ? last / 2 : last - (ARIAL.desc / ARIAL.cap) * ch;
  let rot = e.num(50, 0);
  if (e.has(11) || e.has(21)) rot = (Math.atan2(e.num(21, 0), e.num(11, 1)) * 180) / Math.PI;
  const runs = [];
  lines.forEach((l, i) => {
    let x = (l.align === 0 ? 0 : l.align === 1 ? box / 2 - l.width / 2 : box - l.width) - anchorX;
    const y = ys[i] - anchorY;
    for (const run of l.runs) {
      if (run.text.trim() || run.text) runs.push({ text: run.text, cap: run.cap, wf: run.wf, oblique: run.oblique, x, y: y + (run.dy || 0), space: run.space });
      x += run.width;
    }
  });
  return { ins: e.point(10, 20, 30), rot, flipY: e.num(230, 1) < 0, runs: runs.filter((r) => !r.space) };
}

function drawMText(ctx, e, m) {
  if (ctx.blank.has(e.handle)) return;
  const lay = layoutMText(e, ctx.engine, ctx.doc, ctx.textOf ? ctx.textOf(e, e.getAll(3).join("") + e.get(1, "")) : null);
  if (!lay) return;
  const base = mulM(m, mulM(mulM(trans(lay.ins.x, lay.ins.y), rotM(lay.rot)), lay.flipY ? scaleM(1, -1) : IDENT));
  for (const run of lay.runs) {
    const path = ctx.engine.path(run.text, run.cap, 1, run.oblique);
    emitText(ctx, path, mulM(base, mulM(trans(run.x, run.y), scaleM(run.wf, 1))));
  }
}

function wrapMText(par, engine, boxW) {
  // par: [{align, runs:[{text, cap, wf, oblique, dy}]}] -> lines [{align, width, cap, runs}]
  const out = [];
  for (const p of par.paragraphs) {
    let line = { align: p.align, runs: [], width: 0, cap: 0 };
    const flush = (force = false) => {
      if (line.runs.length || force) {
        // trailing spaces do not count
        while (line.runs.length && line.runs[line.runs.length - 1].space) { const r = line.runs.pop(); line.width -= r.width; }
        out.push(line);
      }
      line = { align: p.align, runs: [], width: 0, cap: 0 };
    };
    for (const w of p.words) {
      const wd = engine.width(w.text, w.cap, w.wf);
      const run = { text: w.text, cap: w.cap, wf: w.wf, oblique: w.oblique, dy: w.dy || 0, width: wd, space: w.space };
      if (boxW > 1e-6 && !w.space && line.width + wd > boxW + 1e-9 && line.runs.some((r) => !r.space)) flush();
      if (w.space && !line.runs.length) continue; // no space at the start of a wrapped line
      line.runs.push(run);
      line.width += wd;
      line.cap = Math.max(line.cap, w.cap);
    }
    flush(true);
  }
  return out;
}
