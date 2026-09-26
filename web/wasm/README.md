# libredwg.wasm

`libredwg.js` + `libredwg.wasm` are **GNU LibreDWG** (GPL-3.0-or-later, https://www.gnu.org/software/libredwg/) compiled to WebAssembly.
The page uses two of its programs: `dwg2dxf` (read a template DWG) and `dxf2dwg` (write a sheet as DWG, AutoCAD 2000 format).

- Source: https://github.com/LibreDWG/libredwg, revision `34f02f54b9aacb5708c1d3d2070efb3e4b2d8c43` (0.14.8597)
- Build: `wasm-build/build_wasm.py` (emscripten, no autotools) - see `wasm-build/README.md`
- Licence text: `COPYING` in this folder
