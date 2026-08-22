/**
 * Transpile frozen test oracles without pulling production src into their program.
 * Runtime imports target dist/.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "test", "oracles");
const outDir = path.join(root, "test", "oracles-dist");
mkdirSync(outDir, { recursive: true });

const compilerOptions = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Node16,
};

for (const name of ["rankOracle.ts", "featuresOracle.ts"]) {
  const source = readFileSync(path.join(srcDir, name), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions, fileName: name });
  const rewritten = outputText.replaceAll("../../src/", "../../dist/");
  writeFileSync(path.join(outDir, name.replace(/\.ts$/, ".js")), rewritten);
}
