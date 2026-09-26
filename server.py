"""Loop drawing generator - local web server.

Start:  python server.py   (or double-click start.bat)  ->  http://127.0.0.1:8765
"""
import json
import os
import re
import shutil
import sys
import threading
import time
import uuid
import webbrowser
import zipfile
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

import pymupdf as fitz

import dwg_export
import tplset
from io_excel import read_io_excel

ROOT = Path(__file__).resolve().parent
HOST, PORT = "127.0.0.1", 8765
# Pages of other sites that may use this server (the Vercel site of this project; LOOP_ORIGIN_RE = another address, a regex)
ALLOWED_ORIGIN = re.compile(os.environ.get("LOOP_ORIGIN_RE", r"https://loopdrawing[\w-]*\.vercel\.app"))

A1_W, A1_H = 2383.94, 1683.78  # pt
CAP = tplset.CAP

_bases, _font, _lock = {}, None, threading.Lock()
_build = {"set": None, "log": [], "running": False, "error": None, "result": None}


def base_doc(set_id, tid):
    path = tplset.OUT / set_id / f"{tid}.pdf"
    stamp = path.stat().st_mtime_ns
    hit = _bases.get((set_id, tid))
    if not hit or hit[0] != stamp:
        _bases[(set_id, tid)] = hit = (stamp, fitz.open(path))
    return hit[1]


_clears = [0]  # counts "clear all": a background rebuild stops when it changes


def wait_build(seconds=240):
    """A template set is built in the background (at start, or after an import): wait until it is ready."""
    end = time.time() + seconds
    while _build["running"] and time.time() < end:
        time.sleep(0.5)
    if _build["running"]:
        raise ValueError("a template set is still being built - try again in a minute")


def release_set(set_id=None):
    """Close the cached blank-sheet PDFs of a set (all sets when None): Windows cannot replace or delete open files."""
    stop_pool()
    with _lock:
        for key in [k for k in _bases if set_id is None or k[0] == set_id]:
            try:
                _bases.pop(key)[1].close()
            except Exception:
                pass


def font():
    global _font
    if _font is None:
        # Helvetica has the same letter widths as Arial, and PDF readers can search / copy its text
        _font = fitz.Font("helv")
    return _font


def clean_text(s):
    return str(s).replace("\r", " ").replace("\n", " ").replace("\t", " ").strip()[:300]


def validate(set_id, items):
    if not isinstance(items, list) or not items:
        raise ValueError("no sheets to print")
    info, fields = tplset.load_set(set_id)
    out = []
    for it in items:
        tid = it.get("template")
        if tid not in fields:
            raise ValueError(f"unknown template {tid!r}")
        texts = it.get("texts") or {}
        bad = [h for h in texts if h not in fields[tid]]
        if bad:
            raise ValueError(f"template {tid}: unknown text {bad[0]}")
        missing = set(fields[tid]) - set(texts)
        if missing:  # these texts are not in the template PDF, so every one must be sent
            raise ValueError(f"template {tid}: text {sorted(missing)[0]} missing")
        sheet, total = it.get("sheet"), it.get("total")
        numbered = isinstance(sheet, int) and isinstance(total, int) and 1 <= sheet <= total
        out.append((tid, {h: clean_text(v) for h, v in texts.items()}, (sheet, total) if numbered else None))
    return info, out


def put_text(page, rect, box, info, text, batch=None):
    """Write one drawing text at its DXF position (same place as in the original drawing).

    batch: a TextWriter of the page - texts that need no squeezing are collected in it (written once per page by the
    caller, several times faster than one writer per text)."""
    if not text:
        return
    s = rect.width / (box[2] - box[0])
    f = font()
    sx, sh = dwg_export.text_fit(text, info)
    size = info["s"] * s / CAP * sh
    w = f.text_length(text, fontsize=size) * sx
    x = rect.x0 + (info["x"] - box[0]) * s
    y = rect.y0 + (box[3] - info["y"]) * s
    if info["ha"] in (1, 4):
        x -= w / 2
    elif info["ha"] == 2:
        x -= w
    if info["va"] == 2 or info["ha"] == 4:
        y += info["s"] * sh * s / 2
    elif info["va"] == 3:
        y += info["s"] * sh * s
    if batch is not None and sx == 1:
        batch.append((x, y), text, font=f, fontsize=size)
        return
    tw = fitz.TextWriter(page.rect)
    tw.append((x, y), text, font=f, fontsize=size)
    tw.write_text(page, color=(0, 0, 0), morph=(fitz.Point(x, y), fitz.Matrix(sx, 1)) if sx != 1 else None)


def make_pdf(set_id, info, items, title):
    total = len(items)
    out = fitz.open()
    page_w, page_h = info["page"]
    box = info["box"]
    w, h = page_w * A1_H / page_h, A1_H
    rect = fitz.Rect((A1_W - w) / 2, 0, (A1_W + w) / 2, h)
    with _lock:
        for n, (tid, texts, numbering) in enumerate(items, start=1):
            t = info["templates"][tid]
            fields = {f["h"]: f for f in tplset.all_fields(t)}
            sheet, of = numbering or (n, total)  # SHT. number of the complete set, or of this PDF
            page = out.new_page(width=A1_W, height=A1_H)
            page.show_pdf_page(rect, base_doc(set_id, tid), 0, keep_proportion=False)
            batch = fitz.TextWriter(page.rect)
            for handle, value in texts.items():
                put_text(page, rect, box, fields[handle], value, batch)
            if t["sheetno"]:
                put_text(page, rect, box, t["sheetno"], t["sheetno"]["fmt"].format(str(sheet).zfill(t["sheetno"]["digits"])), batch)
            if t["frameTotal"]:
                put_text(page, rect, box, t["frameTotal"], t["frameTotal"]["fmt"].format(str(of).zfill(t["frameTotal"]["digits"])), batch)
            batch.write_text(page, color=(0, 0, 0))
    out.set_metadata({"title": title or "Loop drawings", "creator": "Loop drawing generator"})
    return out.tobytes(garbage=3, deflate=True)


def safe_name(name, ext):
    name = re.sub(r'[\\/:*?"<>|]+', "_", str(name or "loop_drawings")).strip(" .") or "loop_drawings"
    return name if name.lower().endswith("." + ext) else f"{name}.{ext}"


def disposition(name):
    ascii_name = name.encode("ascii", "replace").decode("ascii").replace("?", "_")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"


def default_set():
    """The set that was built last."""
    built = [s for s in tplset.list_sets() if s["built"]]
    return max(built, key=lambda s: s["builtAt"] or 0)["id"] if built else None


def templates_reply(set_id):
    sets = tplset.list_sets()
    ids = [s["id"] for s in sets if s["built"]]
    active = set_id if set_id in ids else default_set()
    info = tplset.load_set(active)[0] if active else None
    return {"sets": sets, "active": active, "set": info, "build": {k: _build[k] for k in ("set", "running", "error")}}


# ---------------------------------------------------------------------------------------------- big exports
# A set of any size (100 000 sheets and more) is not made in one request: the page sends the sheets in chunks to an
# export job. Every chunk is drawn in a worker process (all CPU cores work), its files are appended to a ZIP on disk and
# the finished ZIP is streamed to the browser - memory stays flat whatever the size.
EXPORTS = ROOT / "data" / "exports"
PART = 1000                                      # sheets per PDF file when a set does not fit in one PDF
WORKERS = max(2, (os.cpu_count() or 4) - 2)
JOB_KEEP = 12 * 3600                             # an export nobody collected is deleted after this many seconds
_pool, _pool_lock = None, threading.Lock()
_jobs, _jobs_lock = {}, threading.Lock()


def render_chunk(kind, set_id, items, title, stem):
    """[(file name, bytes)] of one chunk of sheets. Runs in a worker process."""
    info, checked = validate(set_id, items)
    if kind == "pdf":
        return [(f"{stem}.pdf", make_pdf(set_id, info, checked, title))]
    names = [str((it or {}).get("name") or f"sheet {k + 1:06d}") for k, it in enumerate(items)]
    return dwg_export.build(set_id, [(*c, n) for c, n in zip(checked, names)], kind, workers=2)


def pool():
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = ProcessPoolExecutor(max_workers=WORKERS)
        return _pool


def stop_pool():
    """End the worker processes (they keep template files open, which Windows cannot replace or delete)."""
    global _pool
    with _pool_lock:
        p, _pool = _pool, None
    if p is not None:
        p.shutdown(wait=True)


def drop_job(jid):
    with _jobs_lock:
        job = _jobs.pop(jid, None)
    if job:
        with job["lock"]:
            job["closed"] = True
            try:
                job["zip"].close()
            except Exception:
                pass
        job["path"].unlink(missing_ok=True)
        if all(j["closed"] for j in _jobs.values()):
            stop_pool()


def clean_exports(older_than=0):
    if EXPORTS.exists():
        for p in EXPORTS.glob("*.zip"):
            if time.time() - p.stat().st_mtime >= older_than:
                p.unlink(missing_ok=True)


def job_start(kind, filename):
    if kind not in ("pdf", "dwg", "dxf"):
        raise ValueError("format must be pdf, dwg or dxf")
    EXPORTS.mkdir(parents=True, exist_ok=True)
    with _jobs_lock:
        for jid in [k for k, j in _jobs.items() if time.time() - j["t"] > JOB_KEEP]:
            threading.Thread(target=drop_job, args=(jid,), daemon=True).start()
    jid = uuid.uuid4().hex[:12]
    path = EXPORTS / f"{jid}.zip"
    job = {"id": jid, "kind": kind, "path": path, "lock": threading.Lock(), "names": {}, "sheets": 0, "files": 0,
           "closed": False, "name": safe_name(filename, "zip"), "t": time.time(), "zip": zipfile.ZipFile(path, "w", allowZip64=True)}
    with _jobs_lock:
        _jobs[jid] = job
    return {"job": jid, "workers": WORKERS, "part": PART}


def get_job(jid, is_open=True):
    job = _jobs.get(jid)
    if not job or job["closed"] == is_open:
        raise ValueError("this export is not open any more - start it again" if is_open else "this export is not ready (or was already downloaded)")
    return job


def job_add(jid, req, stem):
    job = get_job(jid)
    items = req.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("no sheets in this part")
    job["t"] = time.time()
    try:
        files = pool().submit(render_chunk, job["kind"], req["set"], items, req.get("title"), dwg_export.safe(stem)).result()
    except BrokenProcessPool:
        stop_pool()
        raise ValueError("a worker process stopped - start the export again") from None
    method = zipfile.ZIP_STORED if job["kind"] == "pdf" else zipfile.ZIP_DEFLATED   # PDF pages are compressed already
    with job["lock"]:
        if job["closed"]:
            raise ValueError("this export was cancelled")
        for name, data in files:
            stem_, ext = name.rsplit(".", 1)
            job["names"][name] = n = job["names"].get(name, 0) + 1
            if n > 1:  # never two files with the same name in a zip
                name = f"{stem_} ({n}).{ext}"
            zi = zipfile.ZipInfo(name, time.localtime()[:6])
            zi.compress_type, zi.external_attr = method, 0o644 << 16
            job["zip"].writestr(zi, data, compresslevel=1)
        job["sheets"] += len(items)
        job["files"] += len(files)
        return {"ok": True, "sheets": job["sheets"], "files": job["files"]}


def job_finish(jid):
    job = get_job(jid)
    with job["lock"]:
        job["zip"].close()
        job["closed"] = True
    if all(j["closed"] for j in _jobs.values()):
        stop_pool()  # nothing more to draw: the worker processes leave (and release the template files)
    return {"ok": True, "size": job["path"].stat().st_size, "files": job["files"], "sheets": job["sheets"], "name": job["name"]}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        origin = self.headers.get("Origin", "")
        if origin and ALLOWED_ORIGIN.fullmatch(origin):   # the page on Vercel talks to this server through the tunnel
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        super().end_headers()

    def do_OPTIONS(self):   # the browser asks before a POST with JSON from another site
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        path, q = url.path, parse_qs(url.query)
        # Only serve the page and the sheet previews, not the tools or python sources
        if path in ("/", "/index.html") or re.fullmatch(r"/data/sets/[\w.-]+/\w+\.svg", path):
            return super().do_GET()
        if path == "/api/health":
            return self.send_json({"ok": True})
        if path == "/api/templates":
            return self.send_json(templates_reply((q.get("set") or [""])[0]))
        if path == "/api/templates/log":
            return self.send_json({k: _build[k] for k in ("set", "log", "running", "error")} | {"done": not _build["running"]})
        if path == "/api/export/get":  # the finished ZIP of a big export, streamed from disk (then deleted)
            jid = (q.get("job") or [""])[0]
            try:
                job = get_job(jid, is_open=False)
            except ValueError as exc:
                return self.send_json({"error": str(exc)}, status=404)
            try:
                with open(job["path"], "rb") as f:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/zip")
                    self.send_header("Content-Length", str(os.fstat(f.fileno()).st_size))
                    self.send_header("Content-Disposition", disposition(job["name"]))
                    self.end_headers()
                    shutil.copyfileobj(f, self.wfile, 1 << 20)
            finally:
                drop_job(jid)
            return
        self.send_error(404)

    def do_POST(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length)  # no size limit: a whole workbook of sheets goes in one request
            if url.path == "/api/io":
                info = tplset.load_set(q["set"])[0] if q.get("set") else None
                if info is None:
                    raise ValueError("no template set is built yet - import the template drawings first")
                return self.send_json(read_io_excel(body, q.get("name", ""), info))
            if url.path == "/api/pdf":
                req = json.loads(body.decode("utf-8"))
                info, items = validate(req.get("set"), req.get("items"))
                data = make_pdf(req["set"], info, items, req.get("title"))
                return self.send_file(data, "application/pdf", safe_name(req.get("filename"), "pdf"))
            if url.path == "/api/cad":
                req = json.loads(body.decode("utf-8"))
                fmt = req.get("format")
                if fmt not in ("dwg", "dxf"):
                    raise ValueError("format must be dwg or dxf")
                info, checked = validate(req.get("set"), req.get("items"))
                names = [str((it or {}).get("name") or f"sheet {k + 1:03d}") for k, it in enumerate(req["items"])]
                files = dwg_export.build(req["set"], [(*c, n) for c, n in zip(checked, names)], fmt)
                if len(files) == 1:
                    name, data = files[0]
                    ctype = "application/acad" if fmt == "dwg" else "application/dxf"
                else:
                    data, ctype = dwg_export.zip_files(files), "application/zip"
                    name = safe_name(req.get("filename"), "zip")
                return self.send_file(data, ctype, name)
            if url.path == "/api/export/start":
                return self.send_json(job_start(q.get("kind", ""), q.get("filename", "")))
            if url.path == "/api/export/add":
                return self.send_json(job_add(q["job"], json.loads(body.decode("utf-8")), q.get("stem") or "part"))
            if url.path == "/api/export/finish":
                return self.send_json(job_finish(q["job"]))
            if url.path == "/api/export/cancel":
                drop_job(q["job"])
                return self.send_json({"ok": True})
            if url.path == "/api/templates/upload":  # one DWG file into a set (the set is created if needed)
                if q.get("name") and q.get("title"):
                    tplset.create_set(q["set"], q["title"])
                name = tplset.store_file(q["set"], q["name"], body)
                return self.send_json({"ok": True, "file": name})
            if url.path == "/api/templates/build":
                return self.send_json(self.start_build(q["set"], q.get("title")))
            if url.path == "/api/templates/remove":
                tplset.remove_file(q["set"], q["name"])
                return self.send_json({"ok": True})
            if url.path == "/api/templates/delete":
                wait_build()
                release_set(q["set"])
                tplset.delete_set(q["set"])
                return self.send_json({"ok": True})
            if url.path == "/api/templates/clear":  # every template set, DWG files and built data
                _clears[0] += 1  # a rebuild at start stops after the set it is building
                wait_build()
                release_set()
                n = 0
                for d in [*(tplset.SRC.glob("*") if tplset.SRC.exists() else []), *(tplset.OUT.glob("*") if tplset.OUT.exists() else [])]:
                    if d.is_dir():
                        shutil.rmtree(d)
                        n += 1
                tplset._cache.clear()
                _build.update(set=None, log=[], running=False, error=None, result=None)
                return self.send_json({"ok": True, "removed": n})
            self.send_error(404)
        except KeyError as exc:
            self.send_json({"error": f"missing parameter {exc}"}, status=400)
        except Exception as exc:  # report the reason to the page
            self.send_json({"error": str(exc)}, status=400)

    def start_build(self, set_id, title=None):
        if _build["running"]:
            raise ValueError(f"template set {_build['set']} is being built - wait until it is ready")
        if title:
            tplset.create_set(set_id, title)
        _build.update(set=set_id, log=[], running=True, error=None, result=None)

        def work():
            try:
                release_set(set_id)
                _build["result"] = tplset.build_set(set_id, lambda msg: _build["log"].append(msg))
                # Texts of the new build must be bound before the first download
            except Exception as exc:
                _build["error"] = str(exc) or type(exc).__name__
            finally:
                _build["running"] = False

        threading.Thread(target=work, daemon=True).start()
        return {"ok": True, "set": set_id}

    def send_file(self, data, ctype, name):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", disposition(name))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def set_is_stale(s):
    """A built set needs building again when it comes from an older analysis or a file of it is missing."""
    info = tplset.read_json(tplset.OUT / s["id"] / "set.json") or {}
    if info.get("version") != tplset.VERSION:
        return True
    d = tplset.OUT / s["id"]
    return any(not (d / f"{tid}.{ext}").exists() for tid in info.get("templates", {}) for ext in ("dxf", "pdf", "svg"))


def rebuild_stale():
    """Template sets built by an older analysis (tplset.VERSION), or with a missing file, are built again in the
    background at start, so that a new version of the program never works with outdated set data. A set that can no
    longer be built (e.g. a frame alone) is taken out of use; its DWG files stay."""
    stale = [s["id"] for s in tplset.list_sets() if s["built"] and set_is_stale(s)]
    if not stale:
        return

    gen = _clears[0]

    def work():
        for set_id in stale:
            if _clears[0] != gen or not tplset.set_dir(set_id).exists():
                break
            _build.update(set=set_id, log=[], running=True, error=None, result=None)
            try:
                _build["result"] = tplset.build_set(set_id, lambda msg: _build["log"].append(msg))
            except tplset.TemplateError as exc:
                shutil.rmtree(tplset.OUT / set_id, ignore_errors=True)
                tplset._cache.pop(set_id, None)
                _build["error"] = f"{set_id}: {exc}"
            except Exception as exc:
                _build["error"] = str(exc) or type(exc).__name__
            finally:
                _build["running"] = False

    threading.Thread(target=work, daemon=True).start()


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second copy bind the same port; we want it to fail instead
    allow_reuse_address = False
    daemon_threads = True


def main():
    global PORT
    if "--port" in sys.argv:
        PORT = int(sys.argv[sys.argv.index("--port") + 1])
    try:
        server = Server((HOST, PORT), Handler)
    except OSError:
        # Already running (e.g. shortcut clicked twice) - just open the page
        webbrowser.open(f"http://{HOST}:{PORT}/")
        return
    url = f"http://{HOST}:{PORT}/"
    print(f"Loop drawing generator running at {url}  (close this window to stop)")
    clean_exports()  # ZIP files of exports that were never downloaded
    rebuild_stale()
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, webbrowser.open, args=(url,)).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
