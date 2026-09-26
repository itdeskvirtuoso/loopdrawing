// Tiny static file server for trying the site locally:  node scripts/serve.mjs [port]   (Vercel serves the same folder: web/)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve("web"), port = Number(process.argv[2] || 8770);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css", ".wasm": "application/wasm",
  ".svg": "image/svg+xml", ".json": "application/json", ".ttf": "font/ttf", ".woff": "font/woff", ".png": "image/png", ".txt": "text/plain" };
http.createServer((req, res) => {
  if (req.method === "POST" && req.url.startsWith("/_upload")) { // testing only: the browser test sends what it made, to compare it with the old program
    const name = path.basename(new URL(req.url, "http://x").searchParams.get("name") || "upload.bin");
    fs.mkdirSync(path.join(root, "_testdata", "out"), { recursive: true });
    const w = fs.createWriteStream(path.join(root, "_testdata", "out", name));
    req.pipe(w); w.on("finish", () => { res.writeHead(200); res.end("ok"); });
    return;
  }
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "Content-Type": types[path.extname(f).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(f).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/`));
