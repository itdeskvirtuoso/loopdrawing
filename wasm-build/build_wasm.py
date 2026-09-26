"""Builds LibreDWG's dwg2dxf and dxf2dwg as one WebAssembly module (emscripten), without autotools / make.

Run from a shell where emsdk_env is loaded:   python build_wasm.py
Output: out/libredwg.js + out/libredwg.wasm   (functions run_dwg2dxf(in, out) and run_dxf2dwg(in, out) on the virtual file system)
"""
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "libredwg"
OUT = ROOT / "out"
OBJ = ROOT / "obj"
OUT.mkdir(exist_ok=True)
OBJ.mkdir(exist_ok=True)

HAVE = """ALLOCA_H CTYPE_H ENDIAN_H BYTESWAP_H SYS_PARAM_H SYS_TIME_H FLOAT_H FLOOR GETTIMEOFDAY INTTYPES_H LIBGEN_H LIMITS_H MALLOC_H
MEMCHR MEMMOVE MEMORY_H REALLOC SETENV STDDEF_H STDINT_H STDLIB_H STRCASECMP STRCASESTR STRCHR STRINGS_H STRING_H STRNLEN STRRCHR
STRTOL STRTOUL STRTOULL SYS_TYPES_H UNISTD_H WCHAR_H WCSCMP WCSCPY WCSLEN WCSNLEN WCTYPE_H ICONV ICONV_H""".split()


def make_config():
    text = (SRC / "src" / "cmakeconfig.h.in").read_text(encoding="utf-8")
    def cmake(m):
        name = m.group(1)
        if name in ("DXF_PRECISION",):
            return "#define DXF_PRECISION 16"
        if name == "GEOJSON_PRECISION":
            return "#define GEOJSON_PRECISION 6"
        if name.startswith("HAVE_") and name[5:] in HAVE:
            return f"#define {name} 1"
        return f"/* #undef {name} */"
    text = re.sub(r"#cmakedefine (\w+)[^\n]*", cmake, text)
    for k, v in {"@PACKAGE_VERSION@": "0.13.4.9999", "@LIBREDWG_SO_VERSION@": "0:14:0", "@SIZE_T@": "4", "@WCHAR_T@": "4"}.items():
        text = text.replace(k, v)
    (SRC / "src" / "config.h").write_text(text, encoding="utf-8")


LIB = """dwg.c common.c codepages.c bits.c logging.c decode.c decode2.c decode_r11.c decode_r2007.c reedsolomon.c print.c free.c hash.c
dynapi.c classes.c dwg_api.c objects.c geom.c out_dxf.c out_dxfb.c encode.c encode2.c dxfclasses.c in_dxf.c""".split()

WRAP = r'''
#include <stdio.h>
extern int optind;
int dwg2dxf_main (int argc, char *argv[]);
int dxf2dwg_main (int argc, char *argv[]);
int run_dwg2dxf (const char *in, const char *out)
{ optind = 0; char *argv[] = { "dwg2dxf", "-y", "-o", (char *)out, (char *)in, NULL }; return dwg2dxf_main (5, argv); }
int run_dxf2dwg (const char *in, const char *out)
{ optind = 0; char *argv[] = { "dxf2dwg", "-y", "-o", (char *)out, (char *)in, NULL }; return dxf2dwg_main (5, argv); }
'''


def emcc(args):
    r = subprocess.run(["emcc", *args], capture_output=True, text=True, shell=(sys.platform == "win32"))
    if r.returncode:
        lines = [l for l in r.stderr.splitlines() if re.search(r"error|undefined|duplicate|wasm-ld", l, re.I)]
        print("FAILED:", args[1] if len(args) > 1 else args, "\n", "\n".join(l[:300] for l in lines[:25]))
    return r.returncode


def main():
    make_config()
    (ROOT / "wrap.c").write_text(WRAP)
    OPT = os.environ.get("OPT", "-Os")
    common = [OPT, "-DHAVE_CONFIG_H", "-DNDEBUG", "-I", str(SRC / "src"), "-I", str(SRC / "include"), "-I", str(SRC / "programs"),
              "-Wno-everything"]
    jobs = []
    for f in LIB:
        jobs.append(["-c", str(SRC / "src" / f), "-o", str(OBJ / (f[:-2] + ".o")), *common])
    for prog, ren in (("dwg2dxf", "dwg2dxf_main"), ("dxf2dwg", "dxf2dwg_main")):
        jobs.append(["-c", str(SRC / "programs" / f"{prog}.c"), "-o", str(OBJ / f"{prog}.o"), f"-Dmain={ren}", *common])
    jobs.append(["-c", str(ROOT / "wrap.c"), "-o", str(OBJ / "wrap.o"), *common])
    with ThreadPoolExecutor(max_workers=8) as pool:
        codes = list(pool.map(emcc, jobs))
    if any(codes):
        print("compile errors:", sum(1 for c in codes if c))
        return 1
    objs = [str(p) for p in sorted(OBJ.glob("*.o"))]
    link = [*objs, OPT, "-o", str(OUT / "libredwg.js"),
            "-sALLOW_MEMORY_GROWTH=1", "-sINITIAL_MEMORY=48MB", "-sMAXIMUM_MEMORY=1GB", "-sMODULARIZE=1", "-sEXPORT_ES6=1",
            "-sEXPORT_NAME=createLibreDWG", "-sENVIRONMENT=web,worker,node", "-sFORCE_FILESYSTEM=1", "-sEXIT_RUNTIME=0",
            "-sINVOKE_RUN=0", "-Wl,--allow-multiple-definition", "-sEXPORTED_FUNCTIONS=_run_dwg2dxf,_run_dxf2dwg,_malloc,_free",
            "-sEXPORTED_RUNTIME_METHODS=FS,ccall,cwrap,UTF8ToString", "-sSTACK_SIZE=5MB"]
    r = emcc(link)
    print("linked" if r == 0 else "LINK FAILED")
    return r


if __name__ == "__main__":
    sys.exit(main())
