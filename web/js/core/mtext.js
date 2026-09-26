// MTEXT inline codes -> paragraphs of words (with their own height / width factor), and the plain text of an MTEXT.

/**
 * @param {string} src   MTEXT string
 * @param {{cap:number, wf:number, oblique:number, align:number}} base  start values (align 0 left / 1 centre / 2 right)
 * @returns {{paragraphs: {align:number, words:{text:string, cap:number, wf:number, oblique:number, space:boolean, dy:number}[]}[]}}
 */
export function parseMText(src, base) {
  const stack = [];
  let ctx = { cap: base.cap, wf: base.wf, oblique: base.oblique || 0 };
  let align = base.align ?? 0;
  const paragraphs = [];
  let words = [];
  let cur = "";
  const flushWord = () => {
    if (cur) { words.push({ text: cur, ...ctx, space: false, dy: 0 }); cur = ""; }
  };
  const endParagraph = () => {
    flushWord();
    paragraphs.push({ align, words });
    words = [];
  };
  const put = (ch) => {
    if (ch === " ") { flushWord(); words.push({ text: " ", ...ctx, space: true, dy: 0 }); }
    else cur += ch;
  };
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const c = src[i];
    if (c === "{") { flushWord(); stack.push({ ...ctx }); continue; }
    if (c === "}") { flushWord(); if (stack.length) ctx = stack.pop(); continue; }
    if (c === "\n") { endParagraph(); continue; }
    if (c !== "\\") { put(c); continue; }
    const d = src[++i];
    if (d === undefined) break;
    if (d === "\\" || d === "{" || d === "}") { put(d); continue; }
    if (d === "P" || d === "X") { endParagraph(); continue; }
    if (d === "N") continue;
    if (d === "~") { put(" "); continue; }
    if ("LlOoKk".includes(d)) continue; // underline / overline / strike-through are not drawn
    if (d === "U" && src[i + 1] === "+") { // \U+00B2
      const hex = src.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) { put(String.fromCodePoint(parseInt(hex, 16))); i += 5; continue; }
    }
    // codes with a value up to ';'
    const semi = src.indexOf(";", i + 1);
    if (semi < 0) break;
    const val = src.slice(i + 1, semi);
    i = semi;
    switch (d) {
      case "H": {
        flushWord();
        const m = /^([\d.]+)(x?)$/i.exec(val);
        if (m) ctx = { ...ctx, cap: m[2] ? ctx.cap * parseFloat(m[1]) : parseFloat(m[1]) };
        break;
      }
      case "W": flushWord(); if (/^[\d.]+$/.test(val)) ctx = { ...ctx, wf: parseFloat(val) }; break;
      case "Q": flushWord(); if (/^-?[\d.]+$/.test(val)) ctx = { ...ctx, oblique: parseFloat(val) }; break;
      case "p": { // paragraph properties: ...q<l|r|c|j|d>...
        const m = /q([lrcjd])/.exec(val);
        if (m) { flushWord(); align = m[1] === "c" ? 1 : m[1] === "r" ? 2 : 0; }
        break;
      }
      case "S": { // stacking  a^b  a/b  a#b : plain text, a superscript for '^'
        flushWord();
        const m = /^(.*?)([\^/#])(.*)$/.exec(val);
        if (!m) { put(val); break; }
        const [, up, kind, low] = m;
        if (kind === "^") {
          if (up) words.push({ text: up, ...ctx, cap: ctx.cap * 0.7, space: false, dy: ctx.cap * 0.45 });
          if (low) words.push({ text: low, ...ctx, cap: ctx.cap * 0.7, space: false, dy: -ctx.cap * 0.25 });
        } else words.push({ text: up + kind + low, ...ctx, space: false, dy: 0 });
        break;
      }
      default: break; // A (alignment), f / F (font), C / c (colour), T (tracking), ... do not change the outlines
    }
  }
  if (cur || words.length || !paragraphs.length) endParagraph();
  else if (paragraphs.length) { /* text ended with a paragraph break: no extra empty line */ }
  return { paragraphs };
}

/** Plain text of an MTEXT (line breaks as \n), like ezdxf's plain_text(). */
export function mtextPlain(src) {
  const par = parseMText(src, { cap: 1, wf: 1, oblique: 0, align: 0 });
  return par.paragraphs.map((p) => p.words.map((w) => w.text).join("")).join("\n");
}
