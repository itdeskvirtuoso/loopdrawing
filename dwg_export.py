"""Writes loop drawing sheets as AutoCAD drawings (DWG or DXF), one file per sheet.

The template DXF of a set (data/sets/<id>/<tid>.dxf, built by tplset.py) already has its frame bound in. For each
sheet the texts that come from Excel are written into that drawing at their own TEXT entities (same handle, style,
layer and alignment as in the template), and the DXF is converted to DWG (AutoCAD 2000 format, opens in every
AutoCAD / DWG viewer) with LibreDWG.
"""
import codecs
import io
import re
import tempfile
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import ezdxf

import tplset
from tplset import CAP, OUT, run

MIN_CONDENSE = 0.6

_font = None
_docs, _doc_locks, _load_lock = {}, {}, threading.Lock()


def text_fit(text, info):
    """How to squeeze a text into the room it has: (width factor, height factor).

    Same rule for the PDF, the DWG and the screen, so every output looks the same."""
    global _font
    room = info.get("w")
    if not text or not room or room <= 0:
        return 1.0, 1.0
    if _font is None:
        import pymupdf
        _font = pymupdf.Font("helv")  # same letter widths as Arial
    width = _font.text_length(text, fontsize=info["s"] / CAP)
    if width <= room:
        return 1.0, 1.0
    sx = max(room / width, MIN_CONDENSE)
    return sx, (room / (width * sx) if width * sx > room else 1.0)


def dwg_to_dxf(dwg, dxf):
    tplset.dwg_to_dxf(dwg, dxf)


PLAIN_GEOMETRY = {"LINE", "LWPOLYLINE", "ARC", "CIRCLE", "ELLIPSE"}


def explode_plain_blocks(doc):
    """LibreDWG's DXF -> DWG writer does not link the entities of some blocks to their block: the block opens empty in AutoCAD
    (the boxes around 'SIGNAL CABLE / 0.75mm2' disappeared). A block of plain geometry is written as loose geometry instead;
    the frame (text, logo) stays a block."""
    msp = doc.modelspace()
    used = set()
    for ins in list(msp.query("INSERT")):
        block = doc.blocks.get(ins.dxf.name)
        if block is not None and len(block) and all(e.dxftype() in PLAIN_GEOMETRY for e in block):
            used.add(ins.dxf.name)
            ins.explode()
    for name in used:
        if not any(e.dxf.name == name for e in msp.query("INSERT")):
            doc.blocks.delete_block(name, safe=False)


def prepare_for_dwg(doc):
    """Work around what LibreDWG's DXF -> DWG writer loses, without changing how the sheet looks."""
    from ezdxf.addons import MTextExplode
    explode_plain_blocks(doc)
    for layout in [doc.modelspace(), *(b for b in doc.blocks if not b.block_record.is_any_layout)]:
        mtexts = list(layout.query("MTEXT"))
        if mtexts:  # MTEXT loses its text height: write the same lines as single line TEXT
            with MTextExplode(layout, doc) as xpl:
                for m in mtexts:
                    xpl.explode(m, destroy=True)
        for e in layout.query("ATTDEF INSERT"):  # attribute tags with '.' or ':' are dropped
            for a in (e.attribs if e.dxftype() == "INSERT" else [e]):
                a.dxf.tag = re.sub(r"[^A-Z0-9_-]", "_", a.dxf.tag.upper()).strip("_") or "TAG"


def template_doc(set_id, tid, fmt):
    info, _ = tplset.load_set(set_id)
    stamp = (OUT / set_id / "set.json").stat().st_mtime_ns
    key = (set_id, tid, fmt)
    with _load_lock:
        if key not in _docs or _docs[key][0] != stamp:
            path = OUT / set_id / f"{tid}.dxf"
            if not path.exists():
                raise RuntimeError(f"template {tid} of set {set_id} is not built")
            doc = ezdxf.readfile(path)
            if fmt == "dwg":
                prepare_for_dwg(doc)
            _docs[key] = (stamp, doc, info["templates"][tid])
            _doc_locks[key] = threading.Lock()
    return _docs[key][1], _docs[key][2], _doc_locks[key]


_ole_cache = {}


def ole_pictures(set_id, tid):
    """{key: {"layer", "pairs"}} of the OLE pictures (logos) of a template, saved when the set was built."""
    path = OUT / set_id / f"{tid}.ole.json"
    if not path.exists():
        return {}
    stamp = path.stat().st_mtime_ns
    hit = _ole_cache.get(path)
    if not hit or hit[0] != stamp:
        _ole_cache[path] = hit = (stamp, tplset.read_json(path) or {})
    return hit[1]


def inject_ole(dxf, pictures):
    """ezdxf writes the OLE2FRAME entities without their picture; put the original entities back (new handle and owner)."""
    if not pictures or "OLE2FRAME" not in dxf:
        return dxf
    lines = dxf.split("\n")
    out, i, n = [], 0, len(lines)
    while i < n:
        if i + 1 < n and lines[i].strip() == "0" and lines[i + 1].strip() == "OLE2FRAME":
            j, mine = i + 2, {}
            while j + 1 < n and lines[j].strip() != "0":
                mine.setdefault(lines[j].strip(), lines[j + 1])
                j += 2
            layer = mine.get("8", "").strip()
            pic = pictures.get(layer[len(tplset.OLE_LAYER):]) if layer.startswith(tplset.OLE_LAYER) else None
            if pic:
                out += ["  0", "OLE2FRAME"]
                for code, val in pic["pairs"]:
                    if code == "5" and "5" in mine:
                        val = mine["5"]
                    elif code == "330" and "330" in mine:
                        val = mine["330"]
                    elif code == "8":
                        val = pic["layer"]
                    out += [code.rjust(3), val]
                i = j
                continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def fields(t):
    return {f["h"]: f for f in tplset.all_fields(t)}


def sheet_dxf(set_id, tid, texts, sheet, total, fmt="dxf"):
    """DXF text of one filled sheet."""
    doc, t, lock = template_doc(set_id, tid, fmt)
    info = fields(t)
    values = dict(texts)
    if t["sheetno"]:
        values[t["sheetno"]["h"]] = t["sheetno"]["fmt"].format(str(sheet).zfill(t["sheetno"]["digits"]))
        info[t["sheetno"]["h"]] = t["sheetno"]
    if t["frameTotal"]:
        values[t["frameTotal"]["h"]] = t["frameTotal"]["fmt"].format(str(total).zfill(t["frameTotal"]["digits"]))
        info[t["frameTotal"]["h"]] = t["frameTotal"]
    with lock:
        saved = []
        try:
            for handle, value in values.items():
                e = doc.entitydb.get(handle)
                if e is None or e.dxftype() != "TEXT":
                    raise RuntimeError(f"{tid}: text {handle} not found in the template drawing")
                saved.append((e, e.dxf.text, e.dxf.height, e.dxf.width))
                sx, sh = text_fit(value, info[handle])
                e.dxf.text = value
                e.dxf.width = e.dxf.width * sx
                e.dxf.height = e.dxf.height * sh
            stream = io.StringIO()
            doc.write(stream)
            return inject_ole(stream.getvalue(), ole_pictures(set_id, tid))
        finally:
            for e, text, height, width in saved:
                e.dxf.text, e.dxf.height, e.dxf.width = text, height, width


def _not_in_code_page(err):
    """A character the DWG code page has not: written the way AutoCAD stores it (backslash, U+, 4 hex digits)."""
    return "".join(chr(92) + f"U+{ord(c):04X}" for c in err.object[err.start:err.end]), err.end


codecs.register_error("dwg_unicode", _not_in_code_page)


def dxf_to_dwg(dxf_text, workdir, name):
    src, dst = workdir / f"{name}.dxf", workdir / f"{name}.dwg"
    # The DWG is AutoCAD 2000 (code page ANSI_1252, one byte per character). LibreDWG copies the bytes of the DXF: as UTF-8 the
    # '2' of mm2 and the R-in-circle became two characters in AutoCAD ('mmA2'), so the DXF is given in the code page.
    src.write_bytes(dxf_text.encode("cp1252", "dwg_unicode"))
    r = run("dxf2dwg.exe", "-y", "-o", dst, src)
    if not dst.exists() or dst.stat().st_size < 1000:
        raise RuntimeError(f"DWG conversion failed: {(r.stderr or r.stdout).strip()[-300:]}")
    return dst.read_bytes()


def safe(s):
    return re.sub(r'[\\/:*?"<>|]+', "_", str(s)).strip(" .") or "sheet"


def build(set_id, items, fmt, workers=6):
    """items: [(template id, texts, (sheet, total) or None, file stem)] -> [(file name, bytes)]"""
    n = len(items)
    for tid in {it[0] for it in items}:
        template_doc(set_id, tid, fmt)  # load the templates before the parallel part

    def one(k):
        tid, texts, numbering, stem = items[k]
        sheet, total = numbering or (k + 1, n)
        dxf = sheet_dxf(set_id, tid, texts, sheet, total, fmt)
        if fmt == "dxf":
            return f"{safe(stem)}.dxf", dxf.encode("utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            return f"{safe(stem)}.dwg", dxf_to_dwg(dxf, Path(tmp), "sheet")

    with ThreadPoolExecutor(max_workers=workers) as pool:
        files = list(pool.map(one, range(n)))
    seen = {}
    for i, (name, data) in enumerate(files):  # never two files with the same name in a zip
        stem, ext = name.rsplit(".", 1)
        seen[name] = seen.get(name, 0) + 1
        if seen[name] > 1:
            files[i] = (f"{stem} ({seen[name]}).{ext}", data)
    return files


def zip_files(files):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files:
            z.writestr(name, data)
    return buf.getvalue()
