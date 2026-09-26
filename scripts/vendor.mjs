// Copies the browser builds of the libraries (npm devDependencies) into web/vendor. The result is committed: the site needs no npm.
import fs from "node:fs";
import path from "node:path";

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(to);
};
const V = "web/vendor/", nm = "node_modules/";
copy(nm + "pdf-lib/dist/pdf-lib.esm.min.js", V + "pdf-lib.esm.min.js");
copy(nm + "jszip/dist/jszip.min.js", V + "jszip.min.js");
copy(nm + "opentype.js/dist/opentype.module.js", V + "opentype.module.js");
copy(nm + "cfb/dist/cfb.min.js", V + "cfb.min.js");
