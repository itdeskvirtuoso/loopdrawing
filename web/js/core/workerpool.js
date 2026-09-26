// A pool of export workers. Every task runs in one worker; the workers of a pool all know the same template set.
export class WorkerPool {
  constructor(size, url) {
    this.size = size;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.seq = 0;
    this.pending = new Map();
    this.url = url;
  }

  _spawn() {
    const w = new Worker(this.url, { type: "module" });
    w.onmessage = (ev) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      if (ev.data.error) p.reject(new Error(ev.data.error)); else p.resolve(ev.data);
    };
    w.onerror = (ev) => {
      for (const [id, p] of this.pending) if (p.worker === w) { this.pending.delete(id); p.reject(new Error(ev.message || "a worker stopped")); }
    };
    return w;
  }

  /** (Re)starts the workers with a template set: { set, dxf, blank, fontUrl }. */
  async init(data) {
    this.terminate();
    this.workers = Array.from({ length: this.size }, () => this._spawn());
    this.idle = [...this.workers];
    await Promise.all(this.workers.map((w) => this._post(w, { cmd: "init", ...data })));
  }

  _post(w, msg, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, worker: w }); w.postMessage({ ...msg, id }, transfer); });
  }

  /** Runs a task ({cmd, ...}) in a free worker; resolves with the reply. */
  run(msg) {
    return new Promise((resolve, reject) => { this.queue.push({ msg, resolve, reject }); this._next(); });
  }

  _next() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop(), t = this.queue.shift();
      this._post(w, t.msg).then(t.resolve, t.reject).finally(() => { this.idle.push(w); this._next(); });
    }
  }

  terminate() {
    for (const w of this.workers) w.terminate();
    this.workers = []; this.idle = []; this.queue = [];
    for (const p of this.pending.values()) p.reject(new Error("cancelled"));
    this.pending.clear();
  }
}
