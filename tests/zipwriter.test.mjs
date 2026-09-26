import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { ZipWriter, MemorySink } from "../web/js/core/zipwriter.js";

test("streamed ZIP is readable: names, contents, duplicate names, umlauts", async () => {
  const sink = new MemorySink();
  const z = new ZipWriter(sink);
  const a = new TextEncoder().encode("hello"), b = new Uint8Array(100000).map((_, i) => i % 251);
  await z.add("a.txt", a); await z.add("dir/b.bin", b); await z.add("a.txt", a); await z.add("K\u00f6ln \u00e4.dwg", a);
  const info = await z.close();
  assert.equal(info.files, 4);
  const zip = await JSZip.loadAsync(await sink.blob.arrayBuffer());
  assert.deepEqual(Object.keys(zip.files).sort(), ["K\u00f6ln \u00e4.dwg", "a (2).txt", "a.txt", "dir/b.bin"]);
  assert.equal(await zip.file("a.txt").async("string"), "hello");
  assert.deepEqual([...(await zip.file("dir/b.bin").async("uint8array"))], [...b]);
});
