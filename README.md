# Loop Drawing Generator

Makes the loop drawings (A1 PDF, AutoCAD DWG / DXF) of a DCS project from its **IO ASSIGNMENT** workbook and the project's
**loop template DWG files**. It runs **completely in the browser** - there is no server, nothing is uploaded: the workbook, the
templates and the drawings stay on the computer.

Open the site, then:

1. **Templates** - import the loop template DWGs (and the project FRAME.dwg if the templates reference it). Any layout works: a DWG with
   `CH1, CH2 ...` and `FIELD TAG:` texts is a template, any other DWG is the frame. Each template is read on its own (IO type, wiring,
   channels, header texts, field tag / description, system TB / marshalling TB / RTP / JB terminals, sheet number / total) and kept in the
   browser (IndexedDB) as a *template set*.
2. **Import Excel** - pick the IO ASSIGNMENT `.xlsx`. Columns are found by name (MODULE NAME, CHANNEL, CHANNEL NAME / FIELD TAG,
   DESCRIPTION, SIGNAL TYPE, module part no., TB1 / TB2, TB NAME + terminals, RTB / RTP NAME + terminals, JB NAME + terminals ...). Rows are
   grouped into modules at every yellow row, or by MODULE NAME when there are none. In Chrome / Edge the file can be linked, so a save in
   Excel updates the drawings live.
3. **Drawings / Download** - look at every sheet (click a text to change it) and download PDF (one A1 page per sheet), DWG or DXF. Big
   sets work too: PDFs come in parts of 1000 sheets, DWG / DXF as one file per sheet, all in one ZIP that is written to disk while the
   sheets are made (memory stays flat); all CPU cores are used (web workers).

DWG files are AutoCAD 2000 format, written by LibreDWG (see `web/wasm/`). Logos inside a drawing (OLE bitmaps / metafiles) are read,
drawn on the sheet and kept in the DWG.

## Project layout

    web/                 the site (Vercel serves this folder, see vercel.json)
      index.html         the page (dashboard, drawings, templates, downloads)
      js/localapi.js     the "server" of the page: /api/... calls are answered in the browser
      js/core/           dxf, render, text, analyze, tplbuild, io_excel, xlsx, pdfexport, dwgexport, xref, logos, zipwriter, workers
      vendor/            pdf-lib, JSZip, opentype.js, cfb (browser builds; `npm run vendor` refreshes them from npm)
      wasm/              LibreDWG compiled to WebAssembly (GPL-3.0, source + build: wasm-build/)
      fonts/             Liberation Sans (metric compatible with Arial, SIL OFL) for the outlines of drawing texts
    tests/               `npm test` (unit tests, no customer data); tests/golden compares with the old Python program
    scripts/serve.mjs    tiny static server to try the site:  node scripts/serve.mjs  ->  http://127.0.0.1:8770/

The first version of this program was written in Python with a local server; it is kept in git (tag `python-version`).

## Deploy

Vercel: import the repository, preset **Other**, no build command - `vercel.json` publishes the folder `web/`.
Any static host works the same way (serve `web/`; `.wasm` must be sent as `application/wasm`).

## Licence notes

`web/wasm/libredwg.wasm` is GNU LibreDWG (GPL-3.0-or-later); its licence is `web/wasm/COPYING`, the exact source revision and the
build script are in `wasm-build/`. Liberation Sans is under the SIL Open Font License (`web/fonts/LICENSE-liberation.txt`).
