// Template sets kept in the browser (IndexedDB): the DWG files that were imported and what was built from them.
// Nothing leaves the computer; "Clear data" empties the store.

const DB = "loopDrawingsSets", VERSION = 1;

function open() {
  return new Promise((ok, bad) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("sets");   // id -> { id, name, files: [{name, bytes}] }
      db.createObjectStore("built");  // id -> { info, dxf: {tid: text}, blank: {tid: {content, svg, logos}} }
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => bad(r.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  try {
    return await new Promise((ok, bad) => {
      const t = db.transaction(store, mode);
      let out;
      t.oncomplete = () => ok(out);
      t.onerror = () => bad(t.error);
      t.onabort = () => bad(t.error);
      out = fn(t.objectStore(store));
    });
  } finally { db.close(); }
}

const req = (r) => new Promise((ok, bad) => { r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });

export const store = {
  async listSets() {
    const db = await open();
    try {
      const t = db.transaction(["sets", "built"], "readonly");
      const sets = await req(t.objectStore("sets").getAll());
      const built = {};
      for (const s of sets) { const b = await req(t.objectStore("built").get(s.id)); if (b) built[s.id] = b.info; }
      return { sets, built };
    } finally { db.close(); }
  },
  async getSet(id) { return tx("sets", "readonly", (s) => req(s.get(id))).then(async (r) => r); },
  async putSet(set) { return tx("sets", "readwrite", (s) => { s.put(set, set.id); }); },
  async getBuilt(id) { const db = await open(); try { return await req(db.transaction("built").objectStore("built").get(id)); } finally { db.close(); } },
  async putBuilt(id, built) { return tx("built", "readwrite", (s) => { s.put(built, id); }); },
  async deleteSet(id) {
    const db = await open();
    try {
      await new Promise((ok, bad) => {
        const t = db.transaction(["sets", "built"], "readwrite");
        t.objectStore("sets").delete(id); t.objectStore("built").delete(id);
        t.oncomplete = ok; t.onerror = () => bad(t.error);
      });
    } finally { db.close(); }
  },
  async clear() {
    const db = await open();
    try {
      await new Promise((ok, bad) => {
        const t = db.transaction(["sets", "built"], "readwrite");
        t.objectStore("sets").clear(); t.objectStore("built").clear();
        t.oncomplete = ok; t.onerror = () => bad(t.error);
      });
    } finally { db.close(); }
  },
};
