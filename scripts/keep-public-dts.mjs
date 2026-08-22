/**
 * Keep generated public facades; drop declaration emit pulled in from JS impl modules.
 */
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const keep = new Set([
  "index.d.ts",
  "api.d.ts",
  "browser/index.d.ts",
  "browser/api.d.ts",
  // Emitted helpers imported by packed lexical tooling (directly or via dist/lexicalNormalize.js).
  "documentId.d.ts",
  "saturatingFrequency.d.ts",
  "text.d.ts",
  "lexicalNormalize.d.ts",
]);

function walk(dir, rel = "") {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const key = rel ? `${rel}/${name}` : name;
    if (statSync(full).isDirectory()) {
      walk(full, key);
      continue;
    }
    if ((key.endsWith(".d.ts") || key.endsWith(".d.ts.map")) && !keep.has(key.replace(/\.map$/, ""))) {
      unlinkSync(full);
    }
  }
}

if (existsSync(dist)) walk(dist);

for (const name of ["rankOracle.js", "featuresOracle.js", "rankOracle.d.ts", "featuresOracle.d.ts"]) {
  const stale = path.join(dist, name);
  if (existsSync(stale)) unlinkSync(stale);
}
