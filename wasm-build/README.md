# Building libredwg.wasm

The WebAssembly module in `web/wasm/` is built from the unmodified LibreDWG sources with emscripten (no autotools / make needed):

    git clone https://github.com/LibreDWG/libredwg.git libredwg && git -C libredwg checkout 34f02f54b9aacb5708c1d3d2070efb3e4b2d8c43
    git clone https://github.com/emscripten-core/emsdk.git emsdk && emsdk/emsdk install latest && emsdk/emsdk activate latest
    # load the emsdk environment (emsdk_env), then, from a folder that holds `libredwg/`:
    python build_wasm.py          # writes out/libredwg.js + out/libredwg.wasm ; copy both to web/wasm/

`build_wasm.py` writes `src/config.h` (from `cmakeconfig.h.in`), compiles the library sources plus the `dwg2dxf` and `dxf2dwg` programs
(their `main` renamed) and a small wrapper that exports `run_dwg2dxf(in, out)` / `run_dxf2dwg(in, out)` working on the virtual file system.
