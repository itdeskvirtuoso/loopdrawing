"""Rebuilds a template set from its DWG files (the web page does this itself when templates are imported).

    python build_template.py              rebuilds every set in source/sets
    python build_template.py <set id>     rebuilds one set

Needed only when a DWG file inside source/sets/<id>/ was changed by hand. See tplset.py.
"""
import sys

import tplset

if __name__ == "__main__":
    ids = sys.argv[1:] or [s["id"] for s in tplset.list_sets()]
    for sid in ids:
        print(f"== {sid}")
        info = tplset.build_set(sid, print)
        print(tplset.describe(info))
        for w in info["warnings"]:
            print("WARNING", w)
