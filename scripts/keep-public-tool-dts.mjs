/**
 * Keep public tool barrels; drop declaration emit from tool impl modules.
 * Walks TypeScript-migrated tools only so handwritten semantic
 * declarations are left untouched.
 *
 * search-lexical/index.d.ts is generated and preserved.
 * search-relationships/index.d.ts and types.d.ts are handwritten v0.2.2 contracts.
 * search-corpus/index.d.ts and types.d.ts are handwritten v0.2.2 contracts.
 */
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Tool directories whose JS is generated from TypeScript. */
const migratedTools = ["search-lexical", "search-relationships", "search-corpus"];

const keep = new Set([
  "tools/search-lexical/index.d.ts",
  "tools/search-relationships/index.d.ts",
  "tools/search-relationships/types.d.ts",
  "tools/search-corpus/index.d.ts",
  "tools/search-corpus/types.d.ts",
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
