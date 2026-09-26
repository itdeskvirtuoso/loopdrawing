// DXF reader / writer. A drawing is kept as the list of group code pairs of every entity, so that whatever this program does not
// look at is written back unchanged (LibreDWG reads the file again when a DWG is made from it).

export class Ent {
  constructor(type, pairs = []) {
    this.type = type;
    this.pairs = pairs; // [[code (number), value (string)]], the first pair is (0, type)
  }
  get(code, dflt = undefined) {
    for (const p of this.pairs) if (p[0] === code) return p[1];
    return dflt;
  }
  num(code, dflt = 0) {
    const v = this.get(code);
    return v === undefined ? dflt : parseFloat(v);
  }
  int(code, dflt = 0) {
    const v = this.get(code);
    return v === undefined ? dflt : parseInt(v, 10);
  }
  getAll(code) {
    const out = [];
    for (const p of this.pairs) if (p[0] === code) out.push(p[1]);
    return out;
  }
  has(code) {
    return this.pairs.some((p) => p[0] === code);
  }
  set(code, value) {
    const v = typeof value === "number" ? fmt(value) : String(value);
    for (const p of this.pairs) if (p[0] === code) { p[1] = v; return this; }
    this.pairs.push([code, v]);
    return this;
  }
  remove(code) {
    this.pairs = this.pairs.filter((p) => p[0] !== code);
    return this;
  }
  get handle() { return this.get(5) || this.get(105) || ""; }
  set handle(h) { if (this.has(5)) this.set(5, h); else if (this.has(105)) this.set(105, h); else this.pairs.splice(1, 0, [5, h]); }
  get layer() { return this.get(8, "0"); }
  set layer(l) { this.set(8, l); }
  point(cx = 10, cy = 20, cz = 30) { return { x: this.num(cx), y: this.num(cy), z: this.num(cz) }; }
  clone() { return new Ent(this.type, this.pairs.map((p) => [p[0], p[1]])); }
}

export function fmt(n) {
  if (!Number.isFinite(n)) return "0";
  if (Object.is(n, -0)) return "0";
  return String(n);
}

export class Block {
  constructor(begin, ents, end) {
    this.begin = begin; // BLOCK entity
    this.ents = ents;   // entities of the block
    this.end = end;     // ENDBLK entity
  }
  get name() { return this.begin.get(2, ""); }
  get isXref() { return (this.begin.int(70) & 4) !== 0; }
  get isLayout() { const n = this.name.toLowerCase(); return n === "*model_space" || n.startsWith("*paper_space"); }
}

export class Table {
  constructor(head, records, end) {
    this.head = head; this.records = records; this.end = end;
    this.name = head.get(2, "");
  }
}

export class Dxf {
  constructor() {
    this.headerPairs = [];       // pairs between SECTION/HEADER and ENDSEC (group 9 names the variables)
    this.classes = [];           // entities of the CLASSES section
    this.tables = [];            // Table[]
    this.blocks = new Map();     // name -> Block  (insertion order = file order)
    this.msp = [];               // entities of the ENTITIES section (model space)
    this.objects = [];           // entities of the OBJECTS section
    this.other = [];             // [{name, pairs}] sections that are not known (ACDSDATA, THUMBNAILIMAGE ...)
    this.preamble = [];          // comments (999) before the first section
    this.order = [];             // section names in file order
    this._maxHandle = 0;
  }

  // ------------------------------------------------------------------------------------------------------------ header
  headerVar(name) {
    const p = this.headerPairs;
    for (let i = 0; i < p.length; i++) {
      if (p[i][0] === 9 && p[i][1] === name) {
        const out = [];
        for (let j = i + 1; j < p.length && p[j][0] !== 9; j++) out.push(p[j]);
        return out;
      }
    }
    return null;
  }
  headerPoint(name) {
    const v = this.headerVar(name);
    if (!v) return null;
    const get = (c) => { const q = v.find((x) => x[0] === c); return q ? parseFloat(q[1]) : 0; };
    return { x: get(10), y: get(20), z: get(30) };
  }
  headerValue(name) {
    const v = this.headerVar(name);
    return v && v.length ? v[0][1] : null;
  }

  // ------------------------------------------------------------------------------------------------------------ lookup
  table(name) { return this.tables.find((t) => t.name === name.toUpperCase()); }
  layers() { const t = this.table("LAYER"); return t ? t.records : []; }
  styles() { const t = this.table("STYLE"); return t ? t.records : []; }
  style(name) {
    const n = (name || "").toLowerCase();
    return this.styles().find((s) => s.get(2, "").toLowerCase() === n);
  }
  layer(name) { return this.layers().find((l) => l.get(2, "") === name); }
  block(name) { return this.blocks.get(name); }

  /** Handle -> entity of everything that has a handle (model space, blocks, tables, objects). Rebuilt on demand. */
  handleMap() {
    const m = new Map();
    const add = (e) => { const h = e.handle; if (h) m.set(h.toUpperCase(), e); };
    this.msp.forEach(add);
    for (const b of this.blocks.values()) { add(b.begin); b.ents.forEach(add); add(b.end); }
    this.tables.forEach((t) => { add(t.head); t.records.forEach(add); });
    this.objects.forEach(add);
    return m;
  }
  entityByHandle(h) {
    if (!this._hm) this._hm = this.handleMap();
    return this._hm.get(String(h).toUpperCase());
  }
  invalidate() { this._hm = null; }

  newHandle() {
    if (!this._maxHandle) {
      let mx = 0;
      const scan = (e) => { const h = parseInt(e.handle || "0", 16); if (h > mx) mx = h; };
      this.msp.forEach(scan);
      for (const b of this.blocks.values()) { scan(b.begin); b.ents.forEach(scan); scan(b.end); }
      this.tables.forEach((t) => { scan(t.head); t.records.forEach(scan); });
      this.objects.forEach(scan);
      const seed = this.headerValue("$HANDSEED");
      if (seed) mx = Math.max(mx, parseInt(seed, 16) - 1);
      this._maxHandle = mx;
    }
    this._maxHandle += 1;
    this.invalidate();
    return this._maxHandle.toString(16).toUpperCase();
  }

  /** $HANDSEED must stay above every handle (new entities were given handles above the old maximum). */
  syncHandseed() {
    if (!this._maxHandle) return;
    const p = this.headerPairs;
    for (let i = 0; i < p.length; i++) {
      if (p[i][0] === 9 && p[i][1] === "$HANDSEED") {
        for (let j = i + 1; j < p.length && p[j][0] !== 9; j++) {
          if (p[j][0] === 5 && parseInt(p[j][1], 16) <= this._maxHandle) p[j][1] = (this._maxHandle + 1).toString(16).toUpperCase();
        }
        return;
      }
    }
  }

  /** All entities that are drawn: model space, then the blocks (used to look for entities by handle). */
  *allEntities() {
    yield* this.msp;
    for (const b of this.blocks.values()) yield* b.ents;
  }
}

// ---------------------------------------------------------------------------------------------------------------- reading
export function parseDxf(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    if (Number.isNaN(code)) { if (lines[i].trim() === "") { i -= 1; continue; } throw new Error(`DXF: bad group code '${lines[i]}' at line ${i + 1}`); }
    pairs.push([code, lines[i + 1]]);
  }
  const doc = new Dxf();
  let i = 0;
  const n = pairs.length;
  const entitiesUntil = (stop) => { // entities from i up to (not including) a pair (0, stop[k])
    const out = [];
    while (i < n && !(pairs[i][0] === 0 && stop.includes(pairs[i][1].trim()))) {
      if (pairs[i][0] !== 0) { i++; continue; }
      const start = i++;
      while (i < n && pairs[i][0] !== 0) i++;
      out.push(new Ent(pairs[start][1].trim(), pairs.slice(start, i)));
    }
    return out;
  };
  while (i < n) {
    if (pairs[i][0] === 0 && pairs[i][1].trim() === "EOF") break;
    if (!(pairs[i][0] === 0 && pairs[i][1].trim() === "SECTION")) { if (!doc.order.length) doc.preamble.push(pairs[i]); i++; continue; }
    i++;
    const name = pairs[i][1].trim(); i++;
    doc.order.push(name);
    if (name === "HEADER") {
      const start = i;
      while (i < n && !(pairs[i][0] === 0 && pairs[i][1].trim() === "ENDSEC")) i++;
      doc.headerPairs = pairs.slice(start, i);
    } else if (name === "CLASSES" || name === "ENTITIES" || name === "OBJECTS") {
      const ents = entitiesUntil(["ENDSEC"]);
      if (name === "CLASSES") doc.classes = ents; else if (name === "ENTITIES") doc.msp = ents; else doc.objects = ents;
    } else if (name === "TABLES") {
      while (i < n && !(pairs[i][0] === 0 && pairs[i][1].trim() === "ENDSEC")) {
        if (pairs[i][0] === 0 && pairs[i][1].trim() === "TABLE") {
          const start = i++;
          while (i < n && pairs[i][0] !== 0) i++;
          const head = new Ent("TABLE", pairs.slice(start, i));
          const records = entitiesUntil(["ENDTAB"]);
          const s2 = i++;
          while (i < n && pairs[i][0] !== 0) i++;
          doc.tables.push(new Table(head, records, new Ent("ENDTAB", pairs.slice(s2, i))));
        } else i++;
      }
    } else if (name === "BLOCKS") {
      while (i < n && !(pairs[i][0] === 0 && pairs[i][1].trim() === "ENDSEC")) {
        if (pairs[i][0] === 0 && pairs[i][1].trim() === "BLOCK") {
          const s1 = i++;
          while (i < n && pairs[i][0] !== 0) i++;
          const begin = new Ent("BLOCK", pairs.slice(s1, i));
          const ents = entitiesUntil(["ENDBLK"]);
          const s2 = i++;
          while (i < n && pairs[i][0] !== 0) i++;
          const end = new Ent("ENDBLK", pairs.slice(s2, i));
          doc.blocks.set(begin.get(2, ""), new Block(begin, ents, end));
        } else i++;
      }
    } else {
      const start = i;
      while (i < n && !(pairs[i][0] === 0 && pairs[i][1].trim() === "ENDSEC")) i++;
      doc.other.push({ name, pairs: pairs.slice(start, i) });
    }
    i++; // ENDSEC
  }
  return doc;
}

// ---------------------------------------------------------------------------------------------------------------- writing
function pairText(p, out) {
  out.push(String(p[0]).padStart(3), p[1]);
}

export function writeDxf(doc) {
  const out = [];
  doc.preamble.forEach((p) => pairText(p, out));
  const put = (e) => e.pairs.forEach((p) => pairText(p, out));
  const section = (name, body) => { out.push("  0", "SECTION", "  2", name); body(); out.push("  0", "ENDSEC"); };
  const other = new Map(doc.other.map((s) => [s.name, s]));
  for (const name of doc.order) {
    if (name === "HEADER") section(name, () => doc.headerPairs.forEach((p) => pairText(p, out)));
    else if (name === "CLASSES") section(name, () => doc.classes.forEach(put));
    else if (name === "TABLES") section(name, () => doc.tables.forEach((t) => { put(t.head); t.records.forEach(put); put(t.end); }));
    else if (name === "BLOCKS") section(name, () => { for (const b of doc.blocks.values()) { put(b.begin); b.ents.forEach(put); put(b.end); } });
    else if (name === "ENTITIES") section(name, () => doc.msp.forEach(put));
    else if (name === "OBJECTS") section(name, () => doc.objects.forEach(put));
    else if (other.has(name)) section(name, () => other.get(name).pairs.forEach((p) => pairText(p, out)));
  }
  out.push("  0", "EOF", "");
  return out.join("\n");
}
