#!/usr/bin/env node
/**
 * Node CLI for the optional Python semantic compiler.
 *
 *   node tools/search-semantic/build.mjs --input corpus.json --output graph.json --method combined
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileSemantic, DEFAULT_METHOD, DEFAULT_MIN_SCORE, DEFAULT_MODEL, DEFAULT_REPRESENTATION, DEFAULT_TOP_K } from "./index.js";

/** @param {string} flag @param {string | null} [fallback] */
function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  return process.argv[i + 1] || fallback;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(`Usage:
  node tools/search-semantic/build.mjs --input corpus.json --output graph.json [--method embedding] [--precision-gate] [--mutual]

Runs the packaged Python builder. Search Core never imports this tool.
`);
    return;
  }
  const input = arg("--input");
  const output = arg("--output");
  if (!input || !output) {
    console.error("required: --input and --output");
    process.exitCode = 1;
    return;
  }
  const result = await compileSemantic(input, {
    outputPath: output,
    method: /** @type {"lexical" | "embedding" | "combined"} */ (arg("--method", DEFAULT_METHOD) || DEFAULT_METHOD),
    representation: arg("--representation", DEFAULT_REPRESENTATION) || DEFAULT_REPRESENTATION,
    topK: Number(arg("--top-k", String(DEFAULT_TOP_K))),
    minScore: Number(arg("--min-score", String(DEFAULT_MIN_SCORE))),
    model: arg("--model", DEFAULT_MODEL) || DEFAULT_MODEL,
    cacheDir: arg("--cache-dir") || undefined,
    venvDir: arg("--venv-dir") || undefined,
    pythonPath: arg("--python") || undefined,
    reportPath: arg("--report") || undefined,
    precisionGate: process.argv.includes("--precision-gate"),
    mutual: process.argv.includes("--mutual"),
  });
  console.log(
    JSON.stringify(
      {
        output: result.outputPath,
        method: result.report?.method || null,
        edgeCount: result.report?.edgeCount || null,
        sourceCount: result.report?.sourceCount || null,
      },
      null,
      2
    )
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
