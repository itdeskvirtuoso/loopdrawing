// The "server" of the page: everything the old Python server did runs here in the browser. The page keeps calling /api/... with fetch();
// install() puts a fetch that answers those calls from this module (template sets in IndexedDB, exports in web workers).
import opentype from "../vendor/opentype.module.js";
import { store } from "./core/store.js";
import { TextEngine } from "./core/text.js";
import { buildSet, VERSION } from "./core/tplbuild.js";
import { readIoExcel } from "./core/io_excel.js";
import { WorkerPool } from "./core/workerpool.js";
import { ZipWriter, MemorySink, FileSink } from "./core/zipwriter.js";

const FONT_URL = new URL("../fonts/LiberationSans-Regular.ttf", import.meta.url).href;
const WORKER_URL = new URL("./core/export.worker.js", import.meta.url).href;
const PART = 1000; // sheets per PDF file when a set does not fit in one PDF

const build = { set: null, log: [], running: false, error: null };
const builtCache = new Map();      // set id -> { info, dxf, blank }
const svgUrls = new Map();         // "set/tid/builtAt" -> blob URL of the blank sheet (screen preview)
const jobs = new Map();
let engine = null, pool = null, poolKey = null;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
const disposition = (name) => `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
const safeName = (name, ext) => {
  const n = String(name || "loop_drawings").replace(/[\\/:*?"<>|]+/g, "_").trim().replace(/^[ .]+|[ .]+$/g, "") || "loop_drawings";
  return n.toLowerCase().endsWith("." + ext) ? n : `${n}.${ext}`;
};
const fileResponse = (data, ctype, name) => new Response(data, { status: 200, headers: { "Content-Type": ctype, "Content-Disposition": disposition(name) } });

async function getEngine() {
  if (!engine) engine = new TextEngine(opentype.parse(await (await fetch(FONT_URL)).arrayBuffer()));
  return engine;
}

async function getBuilt(id) {
  if (!builtCache.has(id)) {
    const b = await store.getBuilt(id);
    if (!b) throw new Error(`template set ${JSON.stringify(id)} is not built`);
    builtCache.set(id, b);
  }
  return builtCache.get(id);
}

async function getPool(id, built) {
  const key = `${id}/${built.info.builtAt}`;
  if (!pool) pool = new WorkerPool(Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)), WORKER_URL);
  if (poolKey !== key) {
    poolKey = null;
    await pool.init({ set: built.info, dxf: built.dxf, blank: built.blank, fontUrl: FONT_URL });
    poolKey = key;
  }
  return pool;
}

function dropPool() { if (pool) { pool.terminate(); pool = null; poolKey = null; } }

// ---------------------------------------------------------------------------------------------- template sets
function setEntry(s, info) {
  return { id: s.id, name: s.name || s.id, files: (s.files || []).map((f) => f.name).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    built: !!info, builtAt: info ? info.builtAt : null, templates: info ? Object.keys(info.templates).length : 0, types: info ? info.types : [], warnings: info ? info.warnings : [] };
}

async function runBuild(id, title) {
  if (build.running) throw new Error(`template set ${build.set} is being built - wait until it is ready`);
  const set = await store.getSet(id);
  if (!set || !set.files.length) throw new Error("the set has no DWG files");
  if (title) { set.name = title.trim().slice(0, 80); await store.putSet(set); }
  Object.assign(build, { set: id, log: [], running: true, error: null });
  (async () => {
    try {
      const eng = await getEngine();
      const result = await buildSet(id, set.name, set.files, { engine: eng, CFB: globalThis.CFB, log: (m) => build.log.push(m) });
      await store.putBuilt(id, result);
      builtCache.set(id, result);
      for (const k of [...svgUrls.keys()]) if (k.startsWith(id + "/")) { URL.revokeObjectURL(svgUrls.get(k)); svgUrls.delete(k); }
      if (poolKey && poolKey.startsWith(id + "/")) dropPool();
    } catch (e) { build.error = e.message || e.name; }
    finally { build.running = false; }
  })();
  return { ok: true, set: id };
}

/** Sets built by an older version of the analysis are built again from their files. */
async function rebuildStale() {
  const { sets, built } = await store.listSets();
  for (const s of sets) {
    const info = built[s.id];
    if (info && (info.version || 0) < VERSION && s.files.length) {
      const eng = await getEngine();
      try {
        const result = await buildSet(s.id, s.name, s.files, { engine: eng, CFB: globalThis.CFB, log: () => {} });
        await store.putBuilt(s.id, result); builtCache.set(s.id, result);
      } catch { /* leave the old build */ }
    }
  }
}
let staleDone = false;

async function templatesReply(setId) {
  if (!staleDone) { staleDone = true; await rebuildStale(); }
  const { sets, built } = await store.listSets();
  const list = sets.map((s) => setEntry(s, built[s.id]));
  const ids = list.filter((s) => s.built).map((s) => s.id);
  const latest = list.filter((s) => s.built).sort((a, b) => (b.builtAt || 0) - (a.builtAt || 0))[0];
  const active = ids.includes(setId) ? setId : latest ? latest.id : null;
  let info = null;
  if (active) {
    const b = await getBuilt(active);
    info = b.info;
    for (const [tid, x] of Object.entries(b.blank)) {
      const key = `${active}/${tid}/${info.builtAt}`;
      if (!svgUrls.has(key)) svgUrls.set(key, URL.createObjectURL(new Blob([x.svg], { type: "image/svg+xml" })));
    }
  }
  return { sets: list, active, set: info, build: { set: build.set, running: build.running, error: build.error } };
}

// ---------------------------------------------------------------------------------------------- exports
function checkItems(built, items) {
  if (!Array.isArray(items) || !items.length) throw new Error("no sheets to print");
  const t = built.info.templates;
  for (const it of items) {
    if (!t[it.template]) throw new Error(`unknown template ${JSON.stringify(it.template)}`);
    const tt = t[it.template];
    const have = new Set([...Object.values(tt.header), ...(tt.jblines || []), ...(tt.jbtags || []), ...(tt.chlabels || []), ...tt.tags, ...tt.descs, ...tt.terms].map((f) => f.h));
    const texts = it.texts || {};
    const bad = Object.keys(texts).find((h) => !have.has(h));
    if (bad) throw new Error(`template ${it.template}: unknown text ${bad}`);
    const missing = [...have].filter((h) => !(h in texts)).sort()[0];
    if (missing) throw new Error(`template ${it.template}: text ${missing} missing`);
  }
}

async function jobStart(kind, filename) {
  if (!["pdf", "dwg", "dxf"].includes(kind)) throw new Error("format must be pdf, dwg or dxf");
  const name = safeName(filename, "zip");
  let sink = null, streamed = false;
  if (typeof window.showSaveFilePicker === "function") { // a file on disk: memory stays flat whatever the size
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }] });
      sink = new FileSink(await h.createWritable());
      streamed = true;
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("cancelled");
      sink = null; // not allowed here: the ZIP is collected in memory
    }
  }
  if (!sink) sink = new MemorySink();
  const id = Math.random().toString(36).slice(2, 14);
  const p = pool || { size: Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)) };
  jobs.set(id, { id, kind, name, sink, streamed, zip: new ZipWriter(sink), sheets: 0, files: 0, closed: false });
  return { job: id, workers: p.size, part: PART };
}

function getJob(id, open = true) {
  const j = jobs.get(id);
  if (!j || j.closed === open) throw new Error(open ? "this export is not open any more - start it again" : "this export is not ready (or was already downloaded)");
  return j;
}

async function jobAdd(id, req, stem) {
  const job = getJob(id);
  const built = await getBuilt(req.set);
  checkItems(built, req.items);
  const p = await getPool(req.set, built);
  const r = await p.run(job.kind === "pdf" ? { cmd: "pdf", items: req.items, title: req.title, stem } : { cmd: "cad", kind: job.kind, items: req.items });
  if (job.closed) throw new Error("this export was cancelled");
  for (const f of r.files) await job.zip.add(f.name, f.bytes);
  job.sheets += req.items.length; job.files += r.files.length;
  return { ok: true, sheets: job.sheets, files: job.files };
}

async function jobFinish(id) {
  const job = getJob(id);
  const info = await job.zip.close();
  job.closed = true;
  if (!job.streamed) job.url = URL.createObjectURL(job.sink.blob);
  return { ok: true, size: info.size, files: job.files, sheets: job.sheets, name: job.name, streamed: job.streamed };
}

async function jobCancel(id) {
  const job = jobs.get(id);
  if (!job) return;
  job.closed = true;
  if (job.sink && job.sink.abort) await job.sink.abort();
  jobs.delete(id);
}

// ---------------------------------------------------------------------------------------------- the routes
export async function handle(url, init = {}) {
  const u = new URL(url, location.href);
  const path = u.pathname.slice(u.pathname.indexOf("/api/"));
  const q = Object.fromEntries(u.searchParams);
  const method = (init.method || "GET").toUpperCase();
  const body = init.body;
  const asJson = async () => JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
  const asBytes = async () => (body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : body instanceof ArrayBuffer ? new Uint8Array(body) : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : new TextEncoder().encode(String(body ?? "")));
  try {
    if (path === "/api/health") return json({ ok: true });
    if (path === "/api/templates" && method === "GET") return json(await templatesReply(q.set));
    if (path === "/api/templates/log") return json({ log: build.log, running: build.running, error: build.error });
    if (method !== "POST") return json({ error: "not found" }, 404);
    if (path === "/api/io") {
      const b = await getBuilt(q.set).catch(() => { throw new Error("no template set is built yet - import the template drawings first"); });
      const res = await readIoExcel(globalThis.JSZip, await asBytes(), q.name || "", b.info);
      return json(res);
    }
    if (path === "/api/pdf") {
      const req = await asJson();
      const built = await getBuilt(req.set);
      checkItems(built, req.items);
      const p = await getPool(req.set, built);
      const r = await p.run({ cmd: "pdf", items: req.items, title: req.title, stem: "loop_drawings" });
      return fileResponse(new Blob([r.files[0].bytes], { type: "application/pdf" }), "application/pdf", safeName(req.filename, "pdf"));
    }
    if (path === "/api/cad") {
      const req = await asJson();
      if (!["dwg", "dxf"].includes(req.format)) throw new Error("format must be dwg or dxf");
      const built = await getBuilt(req.set);
      checkItems(built, req.items);
      const p = await getPool(req.set, built);
      const r = await p.run({ cmd: "cad", kind: req.format, items: req.items.map((it, k) => ({ ...it, name: String((it || {}).name || `sheet ${String(k + 1).padStart(3, "0")}`) })) });
      if (r.files.length === 1) return fileResponse(new Blob([r.files[0].bytes]), req.format === "dwg" ? "application/acad" : "application/dxf", r.files[0].name);
      const sink = new MemorySink(), zip = new ZipWriter(sink);
      for (const f of r.files) await zip.add(f.name, f.bytes);
      await zip.close();
      return fileResponse(sink.blob, "application/zip", safeName(req.filename, "zip"));
    }
    if (path === "/api/export/start") return json(await jobStart(q.kind, q.filename));
    if (path === "/api/export/add") return json(await jobAdd(q.job, await asJson(), (q.stem || "part").replace(/[\\/:*?"<>|]+/g, "_")));
    if (path === "/api/export/finish") return json(await jobFinish(q.job));
    if (path === "/api/export/cancel") { await jobCancel(q.job); return json({ ok: true }); }
    if (path === "/api/templates/upload") {
      const data = await asBytes();
      const name = String(q.name || "").replace(/[\\/:*?"<>|]+/g, "_").replace(/^[ .]+|[ .]+$/g, "");
      if (!name.toLowerCase().endsWith(".dwg")) throw new Error(`${q.name}: only .dwg files can be imported`);
      if (data.length < 1000 || String.fromCharCode(...data.subarray(0, 4)) !== "AC10") throw new Error(`${q.name}: not a DWG drawing`);
      let set = await store.getSet(q.set);
      if (!set) set = { id: q.set, name: q.title || q.set, files: [] };
      else if (q.title && q.name) set.name = q.title;
      set.files = set.files.filter((f) => f.name !== name);
      set.files.push({ name, bytes: data });
      await store.putSet(set);
      return json({ ok: true, file: name });
    }
    if (path === "/api/templates/build") return json(await runBuild(q.set, q.title));
    if (path === "/api/templates/remove") {
      const set = await store.getSet(q.set);
      if (set) { set.files = set.files.filter((f) => f.name !== q.name); await store.putSet(set); }
      return json({ ok: true });
    }
    if (path === "/api/templates/delete") { await store.deleteSet(q.set); builtCache.delete(q.set); dropPool(); return json({ ok: true }); }
    if (path === "/api/templates/clear") {
      const { sets } = await store.listSets();
      await store.clear(); builtCache.clear(); dropPool();
      for (const u2 of svgUrls.values()) URL.revokeObjectURL(u2);
      svgUrls.clear();
      Object.assign(build, { set: null, log: [], running: false, error: null });
      return json({ ok: true, removed: sets.length });
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: e && e.message ? e.message : String(e) }, 400);
  }
}

/** URL of the blank sheet (SVG) of a template, for the on-screen drawing. */
export function svgUrl(setId, tid, builtAt) { return svgUrls.get(`${setId}/${tid}/${builtAt}`) || ""; }
/** URL of a finished export that was collected in memory. */
export function jobUrl(id) { const j = jobs.get(id); return j && j.url ? j.url : ""; }
