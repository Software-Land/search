/**
 * Keep generated public tool barrels; drop declaration emit from tool impl modules.
 * Only walks TypeScript-migrated tools so handwritten corpus/semantic
 * declarations are left untouched.
 */
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Tool directories whose JS/DTS are generated from TypeScript. */
const migratedTools = ["search-lexical", "search-relationships"];

const keep = new Set([
  "tools/search-lexical/index.d.ts",
  "tools/search-relationships/index.d.ts",
  "tools/search-relationships/types.d.ts",
]);

function walk(dir, rel) {
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

for (const name of migratedTools) {
  const dir = path.join(root, "tools", name);
  if (existsSync(dir)) walk(dir, `tools/${name}`);
}
