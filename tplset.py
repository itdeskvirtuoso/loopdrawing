"""Template sets: import any loop-drawing template DWG (with its FRAME) and read it automatically.

A *set* is one folder of DWG files:  source/sets/<id>/*.dwg   (the FRAME drawing + the loop templates)
Building a set writes                data/sets/<id>/
    set.json         what was found in every template (type, wiring, channels, every text that is filled from Excel)
    <tid>.dxf        the template with the frame bound in (used for the DWG / DXF download)
    <tid>.pdf/.svg   the blank sheet (used for the PDF download and the on-screen preview)

Nothing is hard coded to one drawing: a DWG with "CH1..CHn" texts is a template, anything else is the frame.
In a template the texts are recognised by what they say ("IOP :", "MODULE NAME:", "FIELD TAG:", "AITBXX",
"JB No.", the terminal numbers next to every channel ...), so a new project's templates work as they are.
"""
import binascii
import io
import json
import re
import shutil
import statistics
import struct
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import ezdxf
import pymupdf as fitz
from ezdxf import recover, xref
from ezdxf.addons.drawing import Frontend, RenderContext, config, layout, pymupdf as pdf_backend
from ezdxf.enums import TextEntityAlignment
from ezdxf.math import Vec3

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "source" / "sets"
OUT = ROOT / "data" / "sets"
LIBREDWG = ROOT / "tools" / "libredwg"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

VERSION = 14           # raise when the analysis changes: sets built with an older version are rebuilt at start
PAGE_H = 1683.78          # pt, A1 height; the width follows the aspect ratio of the frame
CAP = 0.716               # Arial cap height / em; DXF text height is the cap height
CHAR_W = 0.77             # average character width / cap height (Arial), only used to estimate label centres
SET_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,39}")

HEADER = [  # key, pattern of the text (the topmost match is the sheet header)
    ("iop", r"^IOP\s*:"),
    ("iota", r"^IOTA\s*:"),
    ("iotype", r"^IO\s*TYPE\s*:"),
    ("link", r"^(IO\s*)?LINK\s*(No\.?|NUMBER)?\s*:"),
    ("module", r"^MODULE\s*(NAME|NO\.?|NUMBER)\s*:"),
    ("iom", r"^IOM\s*(No\.?|NUMBER)?\s*:"),
    ("tbname", r"^([A-Z0-9]*(?<!R)TBX{2,}|[A-Z0-9]+(?<!R)TB\d{2,})$"),      # AITBXX (placeholder) or C1AITB01 (a real name); RTB is a relay base
    ("rtpname", r"^([A-Z0-9]*RT[BP]X{2,}|[A-Z0-9]+RT[BP]\d{2,}[A-Z]?)$"),   # DORTPXX, DORTP01A or DORTB01A (relay terminal base / panel)
    ("sysgroup", r"^TB\s?\d+$"),
    ("jbname", r"^JB\s*(No\.?|NUMBER|NAME)\s*:?$"),
]
COLUMN_LABELS = {"sysgroup": "sys", "tbname": "tb", "rtpname": "rtp", "jbname": "jb"}  # header key -> terminal role
IO_TYPE = re.compile(r"^[A-Z]{2,4}$")
TITLE_TYPES = [(r"ANALOG\s+INPUT", "AI"), (r"ANALOG\s+OUTPUT", "AO"), (r"\bRTD\b", "RTD"),
               (r"DIGITAL\s+INPUT", "DI"), (r"DIGITAL\s+OUTPUT", "DO")]
NOT_A_VALUE = re.compile(r"^(\d+|CH\d+|CHNL\s*NO\.?|CHANNEL.*)$", re.I)   # texts that are never the value of a 'LABEL:'


class TemplateError(Exception):
    pass


_lock = threading.RLock()


# ---------------------------------------------------------------------------------------------- files
def set_dir(set_id):
    if not SET_ID.fullmatch(str(set_id or "")):
        raise ValueError("set id may only use letters, digits, '.', '_' and '-'")
    return SRC / set_id


def slug(name):
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", str(name or "").strip()).strip("-.")[:40]
    return s or "templates"


def list_sets():
    out = []
    for d in sorted(SRC.glob("*")) if SRC.exists() else []:
        if not d.is_dir():
            continue
        meta = read_json(d / "set.json") or {}
        info = read_json(OUT / d.name / "set.json") or {}
        out.append({
            "id": d.name, "name": meta.get("name") or d.name,
            "files": sorted(p.name for p in d.glob("*.dwg")),
            "built": bool(info), "builtAt": info.get("builtAt"),
            "templates": len(info.get("templates", {})), "types": info.get("types", []),
            "warnings": info.get("warnings", []),
        })
    return out


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def create_set(set_id, name=None):
    d = set_dir(set_id)
    d.mkdir(parents=True, exist_ok=True)
    meta = read_json(d / "set.json") or {}
    if name:
        meta["name"] = name.strip()[:80]
    meta.setdefault("name", set_id)
    (d / "set.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return d


def delete_set(set_id):
    d = set_dir(set_id)
    for p in (d, OUT / set_id):
        if p.exists():
            shutil.rmtree(p)
    _cache.pop(set_id, None)


def store_file(set_id, filename, data):
    name = re.sub(r'[\\/:*?"<>|]+', "_", Path(filename).name).strip(" .")
    if not name.lower().endswith(".dwg"):
        raise ValueError(f"{filename}: only .dwg files can be imported")
    if len(data) < 1000 or not data.startswith(b"AC10"):
        raise ValueError(f"{filename}: not a DWG drawing")
    d = create_set(set_id)
    (d / name).write_bytes(data)
    return name


def remove_file(set_id, filename):
    p = set_dir(set_id) / Path(filename).name
    if p.exists():
        p.unlink()


_cache = {}


def load_set(set_id):
    """The analysed set (data/sets/<id>/set.json), cached until the file changes."""
    path = OUT / set_id / "set.json"
    if not SET_ID.fullmatch(str(set_id or "")) or not path.exists():
        raise ValueError(f"template set {set_id!r} is not built")
    stamp = path.stat().st_mtime_ns
    hit = _cache.get(set_id)
    if not hit or hit[0] != stamp:
        info = json.loads(path.read_text(encoding="utf-8"))
        fields = {}
        for tid, t in info["templates"].items():
            fields[tid] = {f["h"]: f for f in all_fields(t)}
        _cache[set_id] = hit = (stamp, info, fields)
    return hit[1], hit[2]


def all_fields(t):
    return [*t["header"].values(), *t.get("jblines", []), *t.get("jbtags", []), *t["tags"], *t["descs"], *t["terms"]]


# ---------------------------------------------------------------------------------------------- DWG -> DXF
def run(tool, *args):
    return subprocess.run([str(LIBREDWG / tool), *map(str, args)], capture_output=True, text=True,
                          cwd=LIBREDWG, creationflags=NO_WINDOW)


def dwg_to_dxf(dwg, dxf):
    r = run("dwg2dxf.exe", "-y", "-o", dxf, dwg)
    if not Path(dxf).exists():
        raise TemplateError(f"{Path(dwg).name}: could not be read ({(r.stderr or r.stdout).strip()[-200:]})")


def read_dxf(path):
    doc, _ = recover.readfile(path)  # LibreDWG's DXF output needs small repairs
    return doc


# ---------------------------------------------------------------------------------------------- texts
def r2(v):
    return round(float(v), 2)


def plain(e):
    return e.dxf.text if e.dxftype() == "TEXT" else e.plain_text()


def text_info(e):
    ha, va = e.dxf.halign, e.dxf.valign
    p = e.dxf.align_point if (ha or va) else e.dxf.insert
    return {"h": e.dxf.handle, "t": e.dxf.text, "x": r2(p.x), "y": r2(p.y), "s": r2(e.dxf.height), "ha": ha, "va": va}


FIELDLIKE = re.compile(r"^(\d+|TB\s?\d+|JB.{0,12}|[A-Z]*(TB|RTP)X{2,}|CH\d+)$", re.I)
ATTACH = {1: (0, 3), 2: (1, 3), 3: (2, 3), 4: (0, 2), 5: (1, 2), 6: (2, 2), 7: (0, 1), 8: (1, 1), 9: (2, 1)}
ALIGN = {(0, 3): TextEntityAlignment.TOP_LEFT, (1, 3): TextEntityAlignment.TOP_CENTER, (2, 3): TextEntityAlignment.TOP_RIGHT,
         (0, 2): TextEntityAlignment.MIDDLE_LEFT, (1, 2): TextEntityAlignment.MIDDLE_CENTER, (2, 2): TextEntityAlignment.MIDDLE_RIGHT,
         (0, 1): TextEntityAlignment.BOTTOM_LEFT, (1, 1): TextEntityAlignment.BOTTOM_CENTER, (2, 1): TextEntityAlignment.BOTTOM_RIGHT}


def simple_mtext_to_text(doc):
    """Short single line MTEXTs that hold values ('TB1', a terminal number) become TEXT, so that they can be
    filled the same way as every other text (and are not lost when the drawing is written as DWG)."""
    msp = doc.modelspace()
    for e in list(msp.query("MTEXT")):
        s = e.plain_text().strip()
        if "\n" in s or not s or not FIELDLIKE.match(s) or abs(e.dxf.get("rotation", 0)) > 0.01:
            continue
        ha, va = ATTACH.get(e.dxf.get("attachment_point", 1), (0, 3))
        h = e.dxf.char_height
        t = msp.add_text(s, height=h, dxfattribs={
            "layer": e.dxf.layer, "style": e.dxf.get("style", "Standard"), "color": e.dxf.get("color", 256)})
        p = e.dxf.insert
        t.set_placement(p, align=ALIGN[(ha, va)])
        # Like AutoCAD, keep the insertion point at the baseline start next to the alignment point: LibreDWG's DWG
        # writer drops the alignment point when both are the same, and the text would end up at 0,0
        width = len(s) * CHAR_W * h
        t.dxf.insert = Vec3(p.x - width * ha / 2, p.y - {3: h, 2: h / 2, 1: 0}[va] - 0.01, p.z)
        msp.delete_entity(e)


SUPER = {"2": "²", "3": "³", "1": "¹"}


def superscripts_to_characters(doc):
    r"""'1.00mm{\H0.7x;\S2^;}' (a stacked, smaller '2'): renderers turn the stack into '2y}', so write the real
    character (mm²) instead."""
    for lay in [doc.modelspace(), *(b for b in doc.blocks if not b.block_record.is_any_layout and not b.block_record.is_xref)]:
        for e in lay.query("MTEXT"):
            new = re.sub(r"\{(?:\\H[\d.]+x;)?\\S([123])\^;\}", lambda m: SUPER[m.group(1)], e.text)
            if new != e.text:
                e.text = new


def wingdings_to_tick(doc):
    """The title block ticks its status box with a Wingdings character that CAD readers replace by a letter:
    draw the tick as lines instead."""
    for lay in [doc.modelspace(), *(b for b in doc.blocks if not b.block_record.is_any_layout and not b.block_record.is_xref)]:
        for e in list(lay.query("MTEXT")):
            if "wingdings" not in e.text.lower():
                continue
            h, p = e.dxf.char_height, e.dxf.insert
            pts = [(p.x + 0.10 * h, p.y - 0.55 * h), (p.x + 0.38 * h, p.y - 0.85 * h), (p.x + 0.92 * h, p.y - 0.14 * h)]
            lay.add_lwpolyline(pts, dxfattribs={"layer": e.dxf.layer, "const_width": 0.09 * h, "color": e.dxf.get("color", 256)})
            lay.delete_entity(e)


# ---------------------------------------------------------------------------------------------- frame
def walk_texts(doc, block_name):
    """TEXT entities of a block (with the blocks inserted in it), as [(entity, matrix)]; the matrix puts them in the drawing."""
    out = []

    def rec(layoutish, m, depth):
        for e in layoutish:
            k = e.dxftype()
            if k == "TEXT":
                out.append((e, m))
            elif k == "INSERT" and depth < 4 and e.dxf.name in doc.blocks:
                rec(doc.blocks.get(e.dxf.name), e.matrix44() @ m, depth + 1)

    for ins in doc.modelspace().query(f'INSERT[name=="{block_name}"]'):
        rec(doc.blocks.get(block_name), ins.matrix44(), 1)
    return out


def frame_text_info(e, m):
    ha, va = e.dxf.halign, e.dxf.valign
    p = e.dxf.align_point if (ha or va) else e.dxf.insert
    w = m.transform(Vec3(p))
    s = m.transform_direction(Vec3(0, e.dxf.height, 0)).magnitude
    return {"h": e.dxf.handle, "t": e.dxf.text, "x": r2(w.x), "y": r2(w.y), "s": r2(s), "ha": ha, "va": va}


def find_sheet_texts(texts, frame_texts):
    """Sheet number (a number in the template) and sheet total (a number in the frame), both found next to the
    'SHEET' / 'SHT.' label of the title block."""
    labels = [t for t in frame_texts + texts if re.fullmatch(r"(SHEET|SHT)\.?\s*:?", t["t"].strip(), re.I)]
    if not labels:
        return None, None
    lab = max(labels, key=lambda t: t["x"] - t["y"])  # title block is at the bottom right
    near = [t for t in texts if re.fullmatch(r"\d+", t["t"].strip()) and -80 <= t["x"] - lab["x"] <= 320 and -170 <= t["y"] - lab["y"] <= 70]
    if not near:
        return None, None
    no = min(near, key=lambda t: (t["x"] - lab["x"]) ** 2 + (t["y"] - lab["y"]) ** 2)
    totals = [t for t in frame_texts if re.fullmatch(r"\s*/?\s*\d+\s*", t["t"]) and t["s"] >= 0.8 * no["s"]
              and (t["x"] - no["x"]) ** 2 + (t["y"] - no["y"]) ** 2 < 160 ** 2]
    tot = min(totals, key=lambda t: (t["x"] - no["x"]) ** 2 + (t["y"] - no["y"]) ** 2) if totals else None
    return no, tot


def number_format(text):
    """'   /11' -> ('   /{}', 2);  '03' -> ('{}', 2)"""
    m = re.search(r"\d+", text)
    return (text[:m.start()] + "{}" + text[m.end():], len(m.group())) if m else ("{}", 2)


# ---------------------------------------------------------------------------------------------- logos (OLE pictures)
OLE_MAGIC = bytes.fromhex("D0CF11E0A1B11AE1")
OLE_LAYER = "OLE_"     # marks an OLE2FRAME entity of a drawing while it is processed (see mark_oles)


def extract_oles(dxf_path):
    """The OLE2FRAME entities (embedded pictures such as a company logo) of a LibreDWG DXF, as they are written there:
    {handle: {"pairs": [[group code, value], ...], "data": bytes}}. ezdxf does not keep their data."""
    text = Path(dxf_path).read_text(encoding="utf-8", errors="replace")
    if "OLE2FRAME" not in text:
        return {}
    lines = text.replace("\r", "").split("\n")
    out, i, n = {}, 0, len(lines)
    while i < n - 1:
        if lines[i].strip() == "0" and lines[i + 1].strip() == "OLE2FRAME":
            j, pairs, chunks, handle = i + 2, [], [], None
            while j < n - 1 and lines[j].strip() != "0":
                code, val = lines[j].strip(), lines[j + 1]
                if code == "5" and handle is None:
                    handle = val.strip()
                if code == "310":
                    try:
                        chunks.append(binascii.unhexlify(val.strip()))
                    except (binascii.Error, ValueError):
                        pass
                pairs.append([code, val])
                j += 2
            if handle:
                out[handle] = {"pairs": pairs, "data": b"".join(chunks)}
            i = j
        else:
            i += 1
    return out


def mark_oles(doc, oles, prefix):
    """Gives every OLE2FRAME of the drawing a layer 'OLE_<key>', so that it can be told apart after the frame has been
    bound into a template (handles change then). Returns {key: {"layer": original layer, "pairs", "data"}}."""
    marks, items = {}, []
    live, todo = set(), [doc.modelspace()]  # blocks that are really used: inserted in the drawing, however deep
    while todo:
        for e in todo.pop().query("INSERT"):
            if e.dxf.name in doc.blocks and e.dxf.name not in live:
                live.add(e.dxf.name)
                todo.append(doc.blocks.get(e.dxf.name))
    layouts = [("", doc.modelspace()), *((b.name, b) for b in doc.blocks if b.name in live and not b.block_record.is_xref)]
    order = {h: n for n, h in enumerate(oles)}  # order in the drawing file = drawing order (later ones are on top)
    for where, lay in layouts:
        for e in list(lay.query("OLE2FRAME")):
            if e.dxf.handle in oles:
                items.append((order[e.dxf.handle], where, e))
    for _, where, e in sorted(items, key=lambda x: x[0]):
        ole = oles[e.dxf.handle]
        key = f"{prefix}{len(marks)}"
        marks[key] = {"layer": e.dxf.get("layer", "0"), "where": where, **ole}
        if OLE_LAYER + key not in doc.layers:
            doc.layers.add(OLE_LAYER + key)
        e.dxf.layer = OLE_LAYER + key
    return marks


def place_oles(doc, frame_block, marks, warn):
    """ezdxf does not copy OLE2FRAME entities when it binds the frame into a template: add them again, empty and on
    their marker layer, where they were in the frame (its own space = the frame block, or one of its blocks)."""
    for key, mark in marks.items():
        if not key.startswith("F"):
            continue
        name = mark["where"] or frame_block
        if not name or name not in doc.blocks:
            warn.append("a logo of the frame could not be placed")
            continue
        doc.blocks.get(name).new_entity("OLE2FRAME", dxfattribs={"layer": OLE_LAYER + key})


def drop_mark_layers(doc, marks):
    for key in marks:
        try:
            doc.layers.discard(OLE_LAYER + key)
        except Exception:
            pass


def ole_picture(data):
    """PIL image of an OLE picture (bitmap, PNG / JPEG or EMF / WMF metafile), or None."""
    import olefile
    from PIL import Image, WmfImagePlugin  # noqa: F401  (registers the metafile reader)
    pos = data.find(OLE_MAGIC)
    if pos < 0:
        return None
    ole = olefile.OleFileIO(io.BytesIO(data[pos:]))
    for name in ("CONTENTS", "\x02OlePres000", "Ole10Native"):
        if not ole.exists(name):
            continue
        c = ole.openstream(name).read()
        try:
            if c[:2] == b"BM" or c[:8] == b"\x89PNG\r\n\x1a\n" or c[:2] == b"\xff\xd8":
                return Image.open(io.BytesIO(c)).convert("RGB")
            sig = c.find(b" EMF", 0, 64)
            if sig >= 40 or c[:4] == b"\xd7\xcd\xc6\x9a":
                emf = c[sig - 40:] if sig >= 40 else c
                im = Image.open(io.BytesIO(emf))
                w = im.info.get("wmf_bbox", (0, 0, 0, 0))[2] or 1
                dpi = im.info.get("dpi", (96, 96))[0] * min(4.0, max(1.0, 1400.0 / w))
                im.load(dpi=dpi)  # Windows only (GDI)
                return im.convert("RGB")
        except Exception:
            continue
    return None


def ole_logos(doc, marks, warn):
    """[(world rectangle (x0, y0, x1, y1), PNG bytes)] of the OLE pictures of the drawing, as they sit in it (frame bound in)."""
    from ezdxf.math import Matrix44
    found = []

    def rec(layout, m, depth):
        for e in layout:
            k = e.dxftype()
            if k == "OLE2FRAME" and e.dxf.get("layer", "").startswith(OLE_LAYER):
                found.append((e.dxf.layer[len(OLE_LAYER):], m))
            elif k == "INSERT" and depth < 5 and e.dxf.name in doc.blocks:
                rec(doc.blocks.get(e.dxf.name), e.matrix44() @ m, depth + 1)

    rec(doc.modelspace(), Matrix44(), 0)
    images, out = {}, []
    for key, m in found:
        mark = marks.get(key)
        if not mark or len(mark["data"]) < 128:
            continue
        try:
            v = struct.unpack_from("<12d", mark["data"], 2)
        except struct.error:
            continue
        pts = [m.transform(Vec3(v[i], v[i + 1], 0)) for i in (0, 3, 6, 9)]
        xs, ys = [p.x for p in pts], [p.y for p in pts]
        if abs(pts[0].y - pts[1].y) > 1e-3 * max(1.0, abs(pts[0].x - pts[1].x)):
            warn.append("a logo of the drawing is rotated - it is not shown")
            continue
        if key not in images:
            im = ole_picture(mark["data"])
            if im is None:
                warn.append("a logo of the drawing (OLE picture) could not be read - it is not shown")
            else:
                # white is paper: without it a logo does not hide the lines and texts of the frame behind it
                from PIL import ImageChops
                r, g, b = im.convert("RGB").split()
                im = im.convert("RGBA")
                im.putalpha(ImageChops.darker(ImageChops.darker(r, g), b).point(lambda v: 0 if v >= 250 else 255))
                buf = io.BytesIO()
                im.save(buf, "PNG")
                images[key] = buf.getvalue()
        if key in images:
            out.append(((min(xs), min(ys), max(xs), max(ys)), images[key]))
    return out


def add_logos(page, box, logos):
    x0, y0, x1, y1 = box
    s = page.rect.width / (x1 - x0)
    for (rx0, ry0, rx1, ry1), png in logos:
        r = fitz.Rect((rx0 - x0) * s, (y1 - ry1) * s, (rx1 - x0) * s, (y1 - ry0) * s)
        if not r.is_empty and r.intersects(page.rect):
            page.insert_image(r, stream=png, keep_proportion=False)


# ---------------------------------------------------------------------------------------------- geometry
def axis_segments(doc):
    """Horizontal and vertical line pieces of the drawing (frame included): ([(x, y0, y1)], [(y, x0, x1)])."""
    vert, horiz = [], []

    def add(a, b):
        if abs(a[0] - b[0]) < 0.3 and abs(a[1] - b[1]) > 0.3:
            vert.append((a[0], min(a[1], b[1]), max(a[1], b[1])))
        elif abs(a[1] - b[1]) < 0.3 and abs(a[0] - b[0]) > 0.3:
            horiz.append((a[1], min(a[0], b[0]), max(a[0], b[0])))

    def walk(entities, depth):
        for e in entities:
            k = e.dxftype()
            if k == "LINE":
                add((e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y))
            elif k == "LWPOLYLINE":
                pts = [(p[0], p[1]) for p in e.get_points("xy")]
                if e.closed and pts:
                    pts.append(pts[0])
                for a, b in zip(pts, pts[1:]):
                    add(a, b)
            elif k == "INSERT" and depth < 3:
                try:
                    walk(e.virtual_entities(), depth + 1)
                except Exception:  # a broken block must not stop the analysis
                    pass

    walk(doc.modelspace(), 0)
    return vert, horiz


def text_centre(t):
    """(x, y) of the middle of a text as it is drawn now."""
    w = len(t["t"].strip()) * CHAR_W * t["s"]
    x = t["x"] + {0: w / 2, 1: 0, 2: -w / 2, 4: 0}.get(t["ha"], w / 2)
    y = t["y"] + {0: 0.36, 1: 0.5, 2: 0, 3: -0.5}.get(t["va"], 0.36) * t["s"]
    return x, y


CENTRE = {0: TextEntityAlignment.CENTER, 1: TextEntityAlignment.BOTTOM_CENTER,
          2: TextEntityAlignment.MIDDLE_CENTER, 3: TextEntityAlignment.TOP_CENTER}


def recentre(e, t, cx):
    """Centre a TEXT entity (and its info) on x = cx, same height / baseline as before."""
    h, p = e.dxf.height, e.dxf.insert
    e.set_placement((cx, t["y"], p.z), align=CENTRE.get(t["va"], TextEntityAlignment.CENTER))
    # like simple_mtext_to_text: LibreDWG's DWG writer needs insert != alignment point
    width = len(t["t"].strip()) * CHAR_W * h
    e.dxf.insert = Vec3(cx - width / 2, t["y"] - {0: 0, 1: 0, 2: h / 2, 3: h}.get(t["va"], 0) - 0.01, p.z)
    t["x"], t["ha"] = r2(cx), 1


def cell_of(t, vert):
    """(left, right) of the box a text sits in: the nearest vertical lines on both sides that cross the text's height."""
    cx, cy = text_centre(t)
    xs = sorted(x for x, y0, y1 in vert if y0 - 1 <= cy <= y1 + 1)
    left = [x for x in xs if x < cx - 1]
    right = [x for x in xs if x > cx + 1]
    if not left or not right:
        return None
    return left[-1], right[0]


def fit_terminals_to_cells(doc, terms, vert):
    """Every terminal text ('TB01/1', '13') is centred in its own box and told the room the box gives it, so a longer
    text is squeezed to the box and never runs over its border or into the next box."""
    for t in terms:
        c = cell_of(t, vert)
        e = doc.entitydb.get(t["h"])
        if not c or e is None or e.dxftype() != "TEXT":
            continue
        width = c[1] - c[0]
        if not 25 <= width <= 260:
            continue
        recentre(e, t, (c[0] + c[1]) / 2)
        t["w"] = r2(width - 8)
        t["cell"] = [r2(c[0]), r2(c[1])]


def jb_lines(doc, header, texts, box, vert, horiz, warn):
    """The JB text sits in the narrow JB section of the drawing. It is centred there, and above it there are extra
    lines (same style) so that the JB names can be listed inside the section: 'JB No. :' and one JB per line."""
    jb = header.get("jbname")
    if not jb:
        return []
    e = doc.entitydb.get(jb["h"])
    tall = sorted(x for x, y0, y1 in vert if y1 - y0 >= 0.45 * (box[3] - box[1]))
    left = [x for x in tall if x <= jb["x"] + 5]
    right = [x for x in tall if x > jb["x"] + 5]
    if e is None or e.dxftype() != "TEXT" or not left or not right or not 150 <= right[0] - left[-1] <= 900:
        warn.append("JB section of the drawing not found - the JB text is not fitted into it")
        return []
    lo, hi = left[-1], right[0]
    above = [y for y, x0, x1 in horiz if y > jb["y"] + jb["s"] * 1.5 and x0 <= lo + 20 and x1 >= hi - 20]
    # ... and below the section's own title (JB SECTION) if it has one
    titles = [o["y"] - 0.3 * o["s"] for o in texts if o["t"].strip() and lo <= text_centre(o)[0] <= hi and o["y"] > jb["y"] + 1.5 * jb["s"]]
    y_top = min(above + titles) if above + titles else jb["y"] + 4 * 2 * jb["s"]
    pitch = r2(1.75 * jb["s"])
    slots = 1
    while jb["y"] + slots * pitch + 0.6 * jb["s"] < y_top - 6:
        slots += 1
    cx = (lo + hi) / 2
    recentre(e, jb, cx)
    jb["w"] = r2(hi - lo - 36)
    jb["cell"] = [r2(lo), r2(hi)]
    msp = doc.modelspace()
    extra = []
    for k in range(1, slots):
        c = msp.add_text("", height=e.dxf.height, dxfattribs={
            "layer": e.dxf.layer, "style": e.dxf.get("style", "Standard"), "color": e.dxf.get("color", 256),
            "width": e.dxf.get("width", 1.0)})
        c.dxf.text = "JB"  # placeholder: recentre() wants a text, the sheet always overwrites it
        y = jb["y"] + k * pitch
        c.set_placement((cx, y, 0), align=CENTRE.get(jb["va"], TextEntityAlignment.CENTER))
        h = e.dxf.height
        w0 = 2 * CHAR_W * h
        c.dxf.insert = Vec3(cx - w0 / 2, y - {0: 0, 1: 0, 2: h / 2, 3: h}.get(jb["va"], 0) - 0.01, 0)
        info = text_info(c)
        info.update({"t": "", "prefix": "", "w": jb["w"], "cell": jb["cell"], "slot": k})
        extra.append(info)
        c.dxf.text = ""
    return extra


def jb_tags(doc, header, terms, channels, horiz):
    """The JB name of every channel, written in the empty box between the two JB terminal boxes of the channel (one
    text per channel, so the same JB is written again at every box). The box is crossed by the wire lines and split in
    two halves, so the text goes in the free band next to the middle line and is drawn smaller to fit into it.
    Without a box between the terminals it is written left of the terminal box, between its two wire lines."""
    jb = header.get("jbname")
    e0 = doc.entitydb.get(jb["h"]) if jb else None
    side0 = [t for t in terms if t["role"] == "jb" and t["side"] == 0 and "cell" in t]
    side1 = [t for t in terms if t["role"] == "jb" and t["side"] == 1 and "cell" in t]
    if not jb or "cell" not in jb or e0 is None or not side0:
        return []
    if side1 and side1[0]["cell"][0] - side0[0]["cell"][1] >= 30:
        lo, hi, between = side0[0]["cell"][1], side1[0]["cell"][0], True
    else:
        lo, hi, between = jb["cell"][0], side0[0]["cell"][0], False
    if hi - lo < 30:
        return []
    cx, msp, out = (lo + hi) / 2, doc.modelspace(), []
    for ch in channels:
        mine = [t for t in side0 if t["ch"] == ch]
        if not mine:
            continue
        cy = statistics.mean(text_centre(t)[1] for t in mine)
        h = e0.dxf.height
        if between:
            lines = sorted({round(y, 1) for y, x0, x1 in horiz if x0 <= lo + 2 and x1 >= hi - 2 and abs(y - cy) < 60})
            bands = [(a, b) for a, b in zip(lines, lines[1:]) if b - a >= 12]
            if bands:  # the free band nearest to the middle of the box, the upper one when two are as near
                a, b = min(bands, key=lambda ab: (abs((ab[0] + ab[1]) / 2 - cy), -(ab[0] + ab[1])))
                cy, h = (a + b) / 2, max(8.0, min(0.7 * h, (b - a) - 5.0))
            else:
                h *= 0.6
        c = msp.add_text("", height=h, dxfattribs={
            "layer": e0.dxf.layer, "style": e0.dxf.get("style", "Standard"), "color": e0.dxf.get("color", 256),
            "width": e0.dxf.get("width", 1.0)})
        c.set_placement((cx, cy, 0), align=TextEntityAlignment.MIDDLE_CENTER)
        c.dxf.insert = Vec3(cx - h, cy - h / 2 - 0.01, 0)
        info = text_info(c)
        info.update({"t": "", "prefix": "", "w": r2(hi - lo - 6), "ch": ch, "cell": [r2(lo), r2(hi)]})
        out.append(info)
        c.dxf.text = ""
    return out


# ---------------------------------------------------------------------------------------------- analysis
def find(texts, pattern):
    return [t for t in texts if re.match(pattern, t["t"].strip(), re.I)]


def label_centre(t):
    return t["x"] if t["ha"] in (1, 4) else t["x"] + len(t["t"].strip()) * CHAR_W * t["s"] / 2


def text_span(t):
    """(left, right) x of a text as it is drawn now."""
    w = len(t["t"].strip()) * CHAR_W * t["s"]
    left = t["x"] - {0: 0, 1: w / 2, 2: w, 4: w / 2}.get(t["ha"], 0)
    return left, left + w


def with_value(label, texts):
    """A 'LABEL:' text with nothing behind the colon whose value is a text of its own on the same line, right of it
    ('FIELD TAG:' ... 'TAG', 'MODULE NO.:' ... 'C1L1AI01'): the value text, to be filled instead of the label (the label
    stays as drawn). Any other text is returned unchanged."""
    s = label["t"].strip()
    label = dict(label)
    mm = re.match(r"^(.*?:\s*)", label["t"])
    label["prefix"] = mm.group(1) if mm else ""
    if not s.endswith(":") or label["prefix"].strip() != s:
        return label
    cy = text_centre(label)[1]
    lo, hi = text_span(label)
    best = None
    for o in texts:
        v = o["t"].strip()
        if o["h"] == label["h"] or not v or v.endswith(":") or NOT_A_VALUE.match(v) or any(re.match(p, v, re.I) for _, p in HEADER):
            continue
        left = text_span(o)[0]
        if abs(text_centre(o)[1] - cy) <= 0.5 * label["s"] and lo + 0.6 * (hi - lo) <= left <= hi + 8 * label["s"]:
            if best is None or left < best[0]:
                best = (left, o)
    if best is None:
        return label
    return {**best[1], "prefix": "", "label": label["t"]}


def walk_all_texts(doc):
    """Texts of every block the drawing inserts (a title block drawn into the template itself), as walk_texts()."""
    out = []
    for name in {e.dxf.name for e in doc.modelspace().query("INSERT")}:
        if name in doc.blocks:
            out += walk_texts(doc, name)
    return out


def relay_terms(texts, label, ch):
    """The relay module of a DO loop: its name ('DORTB01A') above a box with 'R1' in the middle, two terminals on the left
    ('1+' '1-': the module side) and two on the right ('P1' 'O1': the RTP side). Returned as terminal texts of the channel:
    left = system terminals 1, 2 (second column of the 'sys' role), right = RTP terminals 3, 4. The polarity sign stays."""
    lc = label_centre(label)
    near = [t for t in texts if t["h"] != label["h"] and 0 < label["y"] - t["y"] <= 260 and abs(text_centre(t)[0] - lc) <= 200
            and re.fullmatch(r"[A-Z]?\d+[+-]?", t["t"].strip(), re.I)]
    centre = [t for t in near if re.fullmatch(r"R\d+", t["t"].strip(), re.I)]
    sides = [t for t in near if t not in centre]
    if len(centre) != 1 or len(sides) != 4:
        return []
    cx = text_centre(centre[0])[0]
    groups = [[t for t in sides if text_centre(t)[0] < cx], [t for t in sides if text_centre(t)[0] >= cx]]
    if any(len(g) != 2 for g in groups):
        return []
    out = [{**centre[0], "role": "rtp", "side": 2, "k": 0, "ch": ch, "prefix": "", "w": 60, "relay": True, "derive": "R"}]   # 'R1': the number of the RTP terminal 'P1'
    for side, group in enumerate(groups):
        for k, t in enumerate(sorted(group, key=lambda t: -t["y"])):
            sign = re.search(r"[+-]$", t["t"].strip())
            out.append({**t, "role": "sys" if side == 0 else "rtp", "side": 1 if side == 0 else 0, "k": k, "ch": ch, "prefix": "",
                        "sfx": sign.group() if sign else "", "w": 60, "relay": True})
    return out


TYPE_WORDS = {"AI": "ANALOG INPUT", "AO": "ANALOG OUTPUT", "DI": "DIGITAL INPUT", "DO": "DIGITAL OUTPUT"}


def type_votes(texts, header, title):
    """[(source, io type)] of every text of a template that names its IO type."""
    votes = []
    for src, pat, s in (
            ("module no.", r"(RTD|AI|AO|DI|DO)\d+$", header["module"]["t"].strip().upper() if "module" in header else ""),
            ("TB name", r"(RTD|AI|AO|DI|DO)(TB|RTP)", header["tbname"]["t"].strip().upper() if "tbname" in header else "")):
        m = re.search(pat, s)
        if m:
            votes.append((src, m.group(1)))
    for t in texts:  # part numbers: 'IOM :8C-PDILA1', 'IOTA : 8C-TAIXA1' (P / T + type)
        m = re.match(r"^IO(TA|M|P)\s*(No\.?)?\s*:.*?-[TP](AI|AO|DI|DO)[A-Z]", t["t"].strip(), re.I)
        if m:
            votes.append((m.group(0).split(":")[0].strip().upper() + " part no.", m.group(3).upper()))
    for p, k in TITLE_TYPES:
        if re.search(p, title, re.I):
            votes.append(("title", k))
    for t in texts:
        if re.fullmatch(r"(AI|AO|RTD|DI|DO)", t["t"].strip()):
            votes.append(("type label", t["t"].strip()))
    return votes


def vote_type(texts, header, title):
    """The IO type most texts agree on (a wrong title or label in a template is outvoted); ties go to the first vote."""
    votes = type_votes(texts, header, title)
    counts = {}
    for _, k in votes:
        counts[k] = counts.get(k, 0) + 1
    return max(counts, key=lambda k: (counts[k], -[v[1] for v in votes].index(k))) if counts else ""


def correct_labels(doc, info):
    """A template whose title or type label names another IO type than the rest of the drawing (a DI drawing titled
    'DIGITAL OUTPUT', a DO drawing with 'DI' above the field device) is corrected, so every sheet made from it is right."""
    typ = info["type"]
    if typ not in TYPE_WORDS:
        return
    for e in doc.modelspace().query("TEXT"):
        s = e.dxf.text.strip()
        if re.match(r"^LOOP\s+(TEMPLATE|DRAWING)", s, re.I):
            for p, k in TITLE_TYPES:
                if k != typ and k in TYPE_WORDS and re.search(p, s, re.I):
                    e.dxf.text = re.sub(p, TYPE_WORDS[typ], e.dxf.text, flags=re.I)
                    info["title"] = e.dxf.text.strip()
                    info["warnings"].append(f"the title said '{s}' but this is a {typ} loop: changed to '{info['title']}'")
                    break
        elif s in ("AI", "AO", "DI", "DO", "RTD") and s != typ:
            e.dxf.text = typ
            info["warnings"].append(f"the type label above the field device said '{s}' but this is a {typ} loop: changed to '{typ}'")


def analyze(doc, tid, frame_name, box, force_type=None):
    """Everything a template contains that changes from module to module (force_type: a variant made from another type)."""
    warn = []
    msp = doc.modelspace()
    texts = [text_info(e) for e in msp if e.dxftype() == "TEXT" and abs(e.dxf.rotation) < 0.01]
    # the frame of the set (an xref bound into the template), or - a drawing that has its own frame - every inserted block
    frame_texts = [frame_text_info(e, m) for e, m in (walk_texts(doc, frame_name) if frame_name else walk_all_texts(doc))]

    chs = sorted(find(texts, r"^CH\d+$"), key=lambda t: -t["y"])
    tags = sorted(find(texts, r"^FIELD\s*TAG\s*:"), key=lambda t: -t["y"])
    descs = sorted(find(texts, r"^DESCRIPTION\s*:"), key=lambda t: -t["y"])
    if not chs:
        raise TemplateError("no 'CH1, CH2 ...' channel labels found")
    if not (len(tags) == len(descs) == len(chs)):
        raise TemplateError(f"{len(chs)} channel labels but {len(tags)} 'FIELD TAG:' and {len(descs)} 'DESCRIPTION:' texts")
    channels = [int(c["t"].strip()[2:]) for c in chs]
    per_channel = len(channels) == 1   # a sheet of one channel: the workbook gives one such sheet per channel

    x1 = box[2]
    right_limit = x1 - 115  # inner border of the frame (x1 - 85) and a margin, so long texts never touch it
    header = {}
    for key, pat in HEADER:
        m = find(texts, pat)
        if m:
            header[key] = with_value(max(m, key=lambda t: t["y"]), texts)  # the sheet header is above the controller card
    # 'IOM : 8C-PAIHA1' is the module's part number (the IOP), 'IOM Number : 1' its number
    if "iom" in header and "iop" not in header and not re.fullmatch(r"[\dX\s]*", re.sub(r"^.*?:\s*", "", header["iom"]["t"]).upper()):
        header["iop"] = {**header.pop("iom"), "fromIOM": True}
    for key in ("iop", "module", "iom"):
        if key not in header and not (key == "iom" and "iop" in header):
            warn.append(f"no '{key.upper()}' text found - it is left as drawn")
    if "jbname" in header:
        header["jbname"]["prefix"] = header["jbname"]["t"].strip().rstrip(":").rstrip() + " : "

    # Header texts must not run into the text on their right
    hdr = list(header.values())
    for t in hdr:
        right = [o["x"] for o in hdr if o is not t and o["x"] > t["x"] + 50 and abs(o["y"] - t["y"]) < 60]
        left = [o["x"] for o in hdr if o is not t and o["x"] < t["x"] - 50 and abs(o["y"] - t["y"]) < 60]
        if t["ha"] in (1, 4):
            half = min([t["x"] - x for x in left] + [x - t["x"] for x in right] + [600]) / 2 - 10
            t["w"] = r2(2 * max(half, 60))
        else:
            t["w"] = r2((min(right) - 20 if right else right_limit) - t["x"])
    tags, descs = [with_value(t, texts) for t in tags], [with_value(t, texts) for t in descs]
    for t in tags + descs:
        t["limit"] = right_limit
        t["w"] = r2(right_limit - t["x"])

    # Sheet number / total
    sheetno, total = find_sheet_texts(texts, frame_texts)
    if not sheetno:
        cand = [t for t in texts if re.fullmatch(r"\d+", t["t"].strip()) and t["x"] > box[0] + 0.9 * (x1 - box[0]) and t["y"] < box[1] + 0.06 * (box[3] - box[1])]
        sheetno = cand[0] if len(cand) == 1 else None
    if not sheetno:
        warn.append("sheet number text not found - sheets will not be numbered")
    else:
        sheetno = dict(sheetno)
        sheetno["fmt"], sheetno["digits"] = number_format(sheetno["t"])
    if sheetno and not total:
        warn.append("sheet total text not found in the frame")
    if total:
        total = dict(total)
        total["fmt"], total["digits"] = number_format(total["t"])

    # Terminal numbers next to every channel: columns of numbers, told apart by the label above them
    terms = []
    pitch = statistics.median([a["y"] - b["y"] for a, b in zip(chs, chs[1:])]) if len(chs) > 1 else 100
    tag_x = min(t["x"] for t in tags)
    lo, hi = chs[-1]["y"] - 0.6 * pitch, chs[0]["y"] + 0.6 * pitch
    cand = [t for t in texts if re.fullmatch(r"\d+", t["t"].strip()) and t is not sheetno and t["x"] < tag_x - 20 and lo <= t["y"] <= hi
            and (not sheetno or t["h"] != sheetno["h"])]
    cols = []
    for t in sorted(cand, key=lambda t: t["x"]):
        if cols and t["x"] - cols[-1][-1]["x"] < 60:
            cols[-1].append(t)
        else:
            cols.append([t])
    cols = [c for c in cols if len(c) >= (2 if per_channel else max(3, 0.7 * len(chs)))]
    labels = [(role, label_centre(header[k])) for k, role in COLUMN_LABELS.items() if k in header]
    centres = [statistics.median(t["x"] for t in c) for c in cols]
    gaps = [b - a for a, b in zip(centres, centres[1:])]
    cell = r2(min(75, 0.5 * min(gaps))) if gaps else 75
    roles = []
    for cx in centres:
        role = min(labels, key=lambda l: abs(l[1] - cx)) if labels else None
        roles.append(role[0] if role and abs(role[1] - cx) <= 220 else None)
    # The system TB column sits in the module's box and often has no label of its own: the column(s) left of the
    # first labelled one belong to the system TB
    if "sys" not in roles and any(roles):
        first = min(cx for cx, r in zip(centres, roles) if r)
        roles = ["sys" if r is None and cx < first else r for cx, r in zip(centres, roles)]
    seen_side = {}
    for c, cx, role in zip(cols, centres, roles):
        if not role:
            warn.append(f"terminal column at x={cx:.0f} has no TB / RTP / JB label above it - left as drawn")
            continue
        side = seen_side[role] = seen_side.get(role, -1) + 1
        rows = {}
        for t in c:
            i = min(range(len(chs)), key=lambda i: abs(chs[i]["y"] - t["y"]))
            rows.setdefault(i, []).append(t)
        for i, ts in rows.items():
            for k, t in enumerate(sorted(ts, key=lambda t: -t["y"])):
                terms.append({**t, "role": role, "side": side, "k": k, "ch": channels[i], "prefix": "", "w": r2(cell * 0.85)})
    if per_channel and "rtpname" in header:  # a DO loop: the relay module between the system and the marshalling terminals
        terms += relay_terms(texts, header["rtpname"], channels[0])
    vert, horiz = axis_segments(doc)
    for t in header.values():  # a header text never runs over the border of its box (the next vertical line on its right)
        if t["ha"] == 0:
            cy = text_centre(t)[1]
            lines = [x for x, y0, y1 in vert if y0 - 1 <= cy <= y1 + 1 and x > t["x"] + 30]
            if lines:
                t["w"] = r2(max(40, min(t["w"], min(lines) - t["x"] - 8)))
    fit_terminals_to_cells(doc, terms, vert)
    jblines = jb_lines(doc, header, texts, box, vert, horiz, warn)
    jbtags = [] if per_channel else jb_tags(doc, header, terms, channels, horiz)  # a one-channel sheet lists its JB in the JB section only
    counts = {(x["role"], x["side"]): 0 for x in terms if not x.get("relay")}
    for x in terms:
        if not x.get("relay"):
            counts[(x["role"], x["side"])] += 1
    if len(set(counts.values())) > 1:
        warn.append("terminal columns do not have the same number of numbers: " +
                    ", ".join(f"{r}#{s + 1}={n}" for (r, s), n in sorted(counts.items())))

    # Type, wiring, title
    io_type = ""
    if "iotype" in header:
        io_type = re.sub(r"^.*?:\s*", "", header["iotype"]["t"]).strip().upper()
    if not IO_TYPE.match(io_type):
        m = [re.search(r"SIGNAL\s*TYPE\s*:\s*([A-Z]{2,4})", t["t"], re.I) for t in texts]
        io_type = next((x.group(1).upper() for x in m if x), "")
    title = next((t["t"].strip() for t in texts if re.match(r"^LOOP\s+(TEMPLATE|DRAWING)", t["t"].strip(), re.I)), "")
    if not IO_TYPE.match(io_type):  # no 'IO TYPE: AI' / 'SIGNAL TYPE: AI' text: every text that names the type votes
        io_type = vote_type(texts, header, title)
    io_type = force_type or io_type
    wire = next((f"{re.match(r'[2-4]', t['t'].strip()).group()} WIRE" for t in texts if re.fullmatch(r"[2-4]\s*-?\s*WIRE", t["t"].strip(), re.I)), "")
    if not wire and io_type == "AI" and terms:  # 2 terminals per channel and column = 2 wire, 4 = 4 wire
        n = max(x["k"] for x in terms) + 1
        wire = f"{n} WIRE" if n in (2, 4) else ""
    if per_channel:  # the channel label is written again on every sheet; it sits in a box of its own
        c = dict(chs[0])
        cell = cell_of(c, vert)
        cx = label_centre(c)
        c["prefix"] = "CH"
        c["w"] = r2(2 * (min(cx - cell[0], cell[1] - cx) - 4)) if cell and cell[0] < cx < cell[1] else 80
        header["chlabel"] = c
    return {"type": io_type, "wire": wire, "title": title, "channels": channels, "perChannel": per_channel, "header": header,
            "tags": tags, "descs": descs, "terms": terms, "jblines": jblines, "jbtags": jbtags, "sheetno": sheetno,
            "frameTotal": total, "warnings": warn}


def assign_ids(found):
    """found: [(file, info)] -> {template id: {file, ...info}}  (AI2W, AI4W, AO, RTD1, RTD2, DI1 ...)"""
    groups = {}
    for fname, info in found:
        base = (info["type"] or Path(fname).stem.upper().replace(" ", "")[:8]) + (info["wire"][0] + "W" if info["wire"] else "")
        groups.setdefault(base, []).append((fname, info))
    out, notes = {}, []
    for base, items in groups.items():
        # a one-channel-per-sheet template covers the whole IO type / wiring: the templates of channel ranges are not needed
        single = [it for it in items if it[1].get("perChannel")]
        if single and len(single) < len(items):
            keep_one = single[-1]
            for it in items:
                if it is not keep_one:
                    notes.append(f"{it[0]} is not used: {keep_one[0]} (one sheet per channel) covers {base}")
            items[:] = [keep_one]
        items.sort(key=lambda it: (it[1]["channels"][0], it[0].lower()))
        keep = []
        for it in items:
            if keep and keep[-1][1]["channels"][0] == it[1]["channels"][0]:
                notes.append(f"{keep[-1][0]} and {it[0]} are both {base} CH{it[1]['channels'][0]}-{it[1]['channels'][-1]}: {it[0]} is used")
                keep[-1] = it
            else:
                keep.append(it)
        for i, (fname, info) in enumerate(keep):
            tid = base if len(keep) == 1 else f"{base}{i + 1}"
            out[tid] = {"file": fname, "sheet": i + 1, **info}
    return out, notes


# ---------------------------------------------------------------------------------------------- render
def render_page(doc, box, logos=()):
    x0, y0, x1, y1 = box
    backend = pdf_backend.PyMuPdfBackend()
    cfg = config.Configuration(background_policy=config.BackgroundPolicy.WHITE, color_policy=config.ColorPolicy.BLACK,
                               lineweight_policy=config.LineweightPolicy.RELATIVE_FIXED)
    Frontend(RenderContext(doc), backend, config=cfg).draw_layout(doc.modelspace(), finalize=True)
    page_w = PAGE_H * (x1 - x0) / (y1 - y0)
    raw = backend.get_pdf_bytes(layout.Page(page_w, PAGE_H, layout.Units.pt, margins=layout.Margins.all(0)),
                                settings=layout.Settings(fit_page=True, fixed_stroke_width=0.0005),
                                render_box=ezdxf.math.BoundingBox2d([(x0, y0), (x1, y1)]))
    # ezdxf rounds the page size; put it on a page with the exact size so text positions stay exact
    src = fitz.open(stream=raw, filetype="pdf")
    out = fitz.open()
    page = out.new_page(width=page_w, height=PAGE_H)
    page.show_pdf_page(fitz.Rect(0, 0, page_w, PAGE_H), src, 0, keep_proportion=False)
    add_logos(page, box, logos)
    out.set_metadata({"title": "Loop drawing template", "creator": "Loop drawing generator"})
    return out


def drop_sort_tables(doc):
    """Draw order tables list entity handles under group code 5, which LibreDWG's DXF import takes for the table's
    own handle ("duplicate handle"); the drawing does not need them."""
    for obj in list(doc.objects):
        if obj.dxftype() == "SORTENTSTABLE":
            owner = doc.entitydb.get(obj.dxf.owner)
            if owner is not None and owner.dxftype() == "DICTIONARY":
                for key, value in list(owner.items()):
                    if value is obj:
                        owner.discard(key)
            doc.objects.delete_entity(obj)


def frame_extent(doc):
    lo, hi = doc.header.get("$EXTMIN"), doc.header.get("$EXTMAX")
    if lo and hi and hi[0] - lo[0] > 100 and hi[1] - lo[1] > 100 and abs(lo[0]) < 1e5 and abs(hi[0]) < 1e5:
        return [r2(lo[0]), r2(lo[1]), r2(hi[0]), r2(hi[1])]
    from ezdxf import bbox
    b = bbox.extents(doc.modelspace(), fast=True)
    return [r2(b.extmin.x), r2(b.extmin.y), r2(b.extmax.x), r2(b.extmax.y)]


DERIVED = {"AO": ("ANALOG OUTPUT", "same loop, the field device is an output device"),
           "DI": ("DIGITAL INPUT", "the instrument is replaced by a field contact"),
           "DO": ("DIGITAL OUTPUT", "the instrument is replaced by a contact; no relay module is drawn")}


def derive_variant(doc, typ):
    """Turns a one-channel AI loop into an AO / DI / DO loop of the same drawing: new title and IO type label; for DI / DO
    the instrument (circle with cross, + / - boxes) gives way to a dry contact."""
    msp = doc.modelspace()
    for e in msp.query("TEXT"):
        if re.match(r"^LOOP\s+(TEMPLATE|DRAWING)", e.dxf.text.strip(), re.I):
            e.dxf.text = f"LOOP DRAWING FOR {DERIVED[typ][0]}"
    lab = next((e for e in msp.query("TEXT") if e.dxf.text.strip() == "AI"), None)
    circles = [c for c in msp.query("CIRCLE") if lab is not None and abs(c.dxf.center.x - lab.dxf.insert.x) < 80 and c.dxf.center.y < lab.dxf.insert.y]
    if lab is None or not circles:
        raise TemplateError("the AI loop has no 'AI' label with an instrument symbol below it")
    circle = max(circles, key=lambda c: c.dxf.center.y)
    lab.dxf.text = typ
    if typ == "AO":
        return
    c, r = circle.dxf.center, circle.dxf.radius
    x0, x1, y0, y1 = c.x - 0.3 * r - 2.5 * r, c.x + r + 4, c.y - 1.7 * r, c.y + 1.7 * r   # instrument, cross and polarity boxes

    def inside(pts):
        return all(x0 <= x <= x1 and y0 <= y <= y1 for x, y in pts)

    ends, gone = [], []
    for e in msp:
        k = e.dxftype()
        if e is lab:
            continue
        if k == "LINE":
            a, b = (e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y)
            if inside([a, b]):
                gone.append(e)
            elif abs(a[1] - b[1]) < 0.3 and x0 - 5 <= max(a[0], b[0]) <= x0 + 20 and y0 <= a[1] <= y1 - 20:
                ends.append(e)   # the wires that ran into the instrument
        elif k == "LWPOLYLINE" and inside([(p[0], p[1]) for p in e.get_points("xy")]):
            gone.append(e)
        elif k == "CIRCLE" and inside([(e.dxf.center.x, e.dxf.center.y)]):
            gone.append(e)
        elif k == "TEXT" and e.dxf.text.strip() in ("+", "-") and inside([(e.dxf.insert.x, e.dxf.insert.y)]):
            gone.append(e)
    if len(ends) != 2:
        raise TemplateError("the two wires to the instrument were not found")
    for e in gone:
        msp.delete_entity(e)
    xe = max(max(e.dxf.start.x, e.dxf.end.x) for e in ends)
    yt, yb = sorted((e.dxf.start.y for e in ends), reverse=True)
    at = {"layer": ends[0].dxf.layer}
    add = lambda a, b: msp.add_line((a[0], a[1]), (b[0], b[1]), dxfattribs=at)
    add((xe, yt), (xe + 30, yt))
    msp.add_circle((xe + 34, yt), 4, dxfattribs=at)
    add((xe + 38, yt), (xe + 80, yt + 26))
    msp.add_circle((xe + 84, yt), 4, dxfattribs=at)
    add((xe + 88, yt), (xe + 120, yt))
    add((xe + 120, yt), (xe + 120, yb))
    add((xe + 120, yb), (xe, yb))


# ---------------------------------------------------------------------------------------------- build
def build_set(set_id, log=lambda msg: None):
    """(Re)builds data/sets/<id> from the DWG files of source/sets/<id>. Returns the set info."""
    with _lock:
        src = set_dir(set_id)
        files = sorted(src.glob("*.dwg"), key=lambda p: p.name.lower())
        if not files:
            raise TemplateError("the set has no DWG files")
        meta = read_json(src / "set.json") or {}
        out = OUT / set_id
        stage = OUT / f".{set_id}.building"
        if stage.exists():
            shutil.rmtree(stage)
        stage.mkdir(parents=True)
        warnings, rejected, found, frames = [], [], [], {}
        try:
            with tempfile.TemporaryDirectory() as tmp:
                tmp = Path(tmp)
                dxf_of, ole_cache = {}, {}
                for f in files:  # every DWG once: a template has channel labels, the others are frames
                    log(f"Reading {f.name}")
                    d = tmp / f"{len(dxf_of)}.dxf"
                    try:
                        dwg_to_dxf(f, d)
                        dxf_of[f.name] = d
                    except TemplateError as exc:
                        rejected.append({"file": f.name, "error": str(exc)})
                templ = []
                for name, d in dxf_of.items():
                    doc = read_dxf(d)
                    words = [e.dxf.text.strip() for e in doc.modelspace().query("TEXT")]
                    # a loop template has channel labels AND field tag texts; a frame may have a stray 'CH1' only
                    is_tpl = any(re.match(r"^CH\d+$", w) for w in words) and any(re.match(r"^FIELD\s*TAG\s*:", w, re.I) for w in words)
                    (templ if is_tpl else []).append(name)
                    if not is_tpl:
                        frames[name] = doc
                if not templ:
                    raise TemplateError("none of the DWG files is a loop template (a template has 'CH1', 'CH2' ... and 'FIELD TAG:' texts). A frame alone cannot be used: add it to a set that has the templates (\"Add to ...\")")
                # Which frame belongs to the templates: the one they reference (XREF), else the only one
                xref_stems = set()
                for name in templ:
                    for b in read_dxf(dxf_of[name]).blocks:
                        if b.block_record.is_xref:
                            xref_stems.add(Path(b.block.dxf.get("xref_path", "")).stem.upper())
                frame_name = next((n for n in frames if Path(n).stem.upper() in xref_stems), None) or (next(iter(frames)) if frames else None)
                if len(frames) > 1:
                    warnings.append(f"{len(frames)} frame drawings found, {frame_name} is used")
                box = frame_extent(frames[frame_name]) if frame_name else None
                frames.clear()

                def analyse(name, derive=None):
                    """Reads one template file (frame bound in, logos marked) and analyses it; derive = 'AO' / 'DI' / 'DO':
                    the drawing is turned into a loop of that IO type first (see derive_variant)."""
                    doc = read_dxf(dxf_of[name])
                    fdoc = read_dxf(dxf_of[frame_name]) if frame_name else None
                    fblock = None
                    # logos are OLE pictures that ezdxf does not keep: mark them now (they get new handles below)
                    marks = {}
                    if fdoc is not None:
                        marks.update(mark_oles(fdoc, ole_cache.setdefault(frame_name, extract_oles(dxf_of[frame_name])), "F"))
                    marks.update(mark_oles(doc, extract_oles(dxf_of[name]), "T"))
                    for b in list(doc.blocks):
                        if b.block_record.is_xref and fdoc is not None:
                            xref.embed(b, load_fn=lambda _p: fdoc, search_paths=[src], conflict_policy=xref.ConflictPolicy.KEEP)
                            fblock = b.name
                    # no FRAME drawing is fine for a template that carries its own frame, not for one that references it
                    gone = [Path(b.block.dxf.get("xref_path", "")).name for b in doc.blocks if b.block_record.is_xref] if fdoc is None else []
                    place_oles(doc, fblock, marks, warnings)
                    drop_sort_tables(doc)
                    simple_mtext_to_text(doc)
                    wingdings_to_tick(doc)
                    superscripts_to_characters(doc)
                    if derive:
                        derive_variant(doc, derive)
                    nonlocal box
                    if box is None:
                        box = frame_extent(doc)
                    info = analyze(doc, name, fblock, box, derive)
                    if not derive:
                        correct_labels(doc, info)
                    info["_doc"] = doc
                    info["_frame"] = fblock
                    info["_noframe"] = gone[0] if gone else ""
                    info["_marks"] = marks
                    return info

                for name in templ:
                    log(f"Analysing {name}")
                    try:
                        found.append((name, analyse(name)))
                    except TemplateError as exc:
                        rejected.append({"file": name, "error": str(exc)})
                    except Exception as exc:  # a broken drawing must not stop the others
                        rejected.append({"file": name, "error": f"{type(exc).__name__}: {exc}"})
                # IO types the set has no template for, while it has a one-channel AI loop: the loops of the other types
                # are the same drawing with another field device, so they are made from it (a real template of the
                # type, imported later, replaces them)
                have = {i["type"] for _, i in found}
                base = next((n for n, i in found if i["perChannel"] and i["type"] == "AI"), None)
                for typ in DERIVED if base else []:
                    if typ in have:
                        continue
                    label = f"{Path(base).stem} ({typ} derived).dwg"
                    log(f"Making the {typ} loop from {base}")
                    try:
                        info = analyse(base, typ)
                        info["derived"] = True
                        found.append((label, info))
                        warnings.append(f"No {typ} template in the set: the {typ} sheets are made from {base} ({DERIVED[typ][1]}). "
                                        f"Import a {typ} template of your own to replace them.")
                    except Exception as exc:
                        warnings.append(f"The {typ} sheets could not be made from {base}: {exc}")
                templates, notes = assign_ids([(n, i) for n, i in found])
                warnings += notes
                docs = {i["file"]: i.pop("_doc") for i in templates.values()}
                marks_of = {i["file"]: i.pop("_marks") for i in templates.values()}
                for i in templates.values():
                    i.pop("_frame", None)
                    if i.pop("_noframe", ""):
                        warnings.append(f"{i['file']} needs the frame drawing it references, which is not in the set - drawn without a frame")
                for tid, t in templates.items():
                    log(f"Rendering {tid}")
                    doc = docs[t["file"]]
                    blank = [f["h"] for f in all_fields(t)] + ([t["sheetno"]["h"]] if t["sheetno"] else []) + ([t["frameTotal"]["h"]] if t["frameTotal"] else [])
                    saved = []
                    for h in blank:
                        e = doc.entitydb.get(h)
                        if e is not None and e.dxftype() == "TEXT":
                            saved.append((e, e.dxf.text))
                            e.dxf.text = ""
                    marks = marks_of[t["file"]]
                    logos = ole_logos(doc, marks, t["warnings"]) if marks else []
                    t["logos"] = len(logos)
                    try:
                        page = render_page(doc, box, logos)
                    finally:
                        for e, text in saved:
                            e.dxf.text = text
                    page.save(stage / f"{tid}.pdf", garbage=3, deflate=True)
                    (stage / f"{tid}.svg").write_text(page[0].get_svg_image(text_as_path=True), encoding="utf-8")
                    drop_mark_layers(doc, marks)
                    doc.saveas(stage / f"{tid}.dxf")
                    if marks:  # the pictures themselves, put back into the DXF / DWG when a sheet is exported
                        (stage / f"{tid}.ole.json").write_text(json.dumps(
                            {k: {"layer": v["layer"], "pairs": v["pairs"]} for k, v in marks.items()}), encoding="utf-8")
                    t["page"] = [r2(PAGE_H * (box[2] - box[0]) / (box[3] - box[1])), PAGE_H]
                    for w in t["warnings"]:
                        warnings.append(f"{t['file']}: {w}")
            if not templates:
                raise TemplateError("; ".join(f"{r['file']}: {r['error']}" for r in rejected) or "no template could be read")
            for r in rejected:
                warnings.append(f"{r['file']} was not used: {r['error']}")
            info = {
                "id": set_id, "version": VERSION, "name": meta.get("name") or set_id, "builtAt": int(time.time() * 1000),
                "frame": frame_name, "box": box, "page": [r2(PAGE_H * (box[2] - box[0]) / (box[3] - box[1])), PAGE_H],
                "types": sorted({t["type"] for t in templates.values() if t["type"]}),
                "templates": templates, "rejected": rejected, "warnings": warnings,
            }
            (stage / "set.json").write_text(json.dumps(info, indent=1), encoding="utf-8")
            if out.exists():
                shutil.rmtree(out)
            OUT.mkdir(parents=True, exist_ok=True)
            stage.replace(out)
            _cache.pop(set_id, None)
            return info
        finally:
            if stage.exists():
                shutil.rmtree(stage, ignore_errors=True)


def describe(info):
    """Short text about the templates of a built set (for the command line)."""
    lines = []
    for tid, t in info["templates"].items():
        roles = {}
        for x in t["terms"]:
            roles.setdefault((x["role"], x["side"]), 0)
            roles[(x["role"], x["side"])] += 1
        lines.append(f"{tid:6} {t['file']:22} {t['type']:4} {t['wire'] or '-':7} CH{t['channels'][0]}-{t['channels'][-1]}  "
                     f"header={','.join(t['header'])}  terminals={dict((f'{r}{s + 1}', n) for (r, s), n in sorted(roles.items()))}  "
                     f"sheetno={'yes' if t['sheetno'] else 'NO'} total={'yes' if t['frameTotal'] else 'NO'}")
    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    sid = sys.argv[1] if len(sys.argv) > 1 else "default"
    result = build_set(sid, print)
    print(describe(result))
    for w in result["warnings"]:
        print("WARNING", w)
