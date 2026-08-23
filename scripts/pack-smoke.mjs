/**
 * Pack the package, install it in isolation, and import all seven public specifiers.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function walkFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walkFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
  throw new Error("production dependencies must remain empty");
}
if (!pkg.engines || pkg.engines.node !== ">=18") {
  throw new Error(`engines.node must remain >=18 (got ${JSON.stringify(pkg.engines)})`);
}

run("npm", ["run", "build"]);

const tmp = mkdtempSync(path.join(os.tmpdir(), "search-pack-smoke-"));
try {
  run("npm", ["pack", "--pack-destination", tmp]);
  const tarballName = readdirSync(tmp).find((name) => name.endsWith(".tgz"));
  if (!tarballName) throw new Error("npm pack produced no tarball");
  const tarball = path.join(tmp, tarballName);

  const extractDir = path.join(tmp, "extracted");
  mkdirSync(extractDir);
  run("tar", ["-xzf", tarball, "-C", extractDir]);
  const packedRoot = path.join(extractDir, "package");
  if (!existsSync(path.join(packedRoot, "package.json"))) {
    throw new Error("extracted tarball missing package/package.json");
  }

  const packedRel = walkFiles(packedRoot).map((file) => path.relative(packedRoot, file).split(path.sep).join("/"));

  for (const [subpath, exp] of Object.entries(pkg.exports)) {
    if (!exp || typeof exp !== "object") throw new Error(`invalid export ${subpath}`);
    const typesRel = String(exp.types).replace(/^\.\//, "");
    const importRel = String(exp.import).replace(/^\.\//, "");
    if (!packedRel.includes(typesRel)) throw new Error(`packed tarball missing exports.types for ${subpath}: ${exp.types}`);
    if (!packedRel.includes(importRel)) throw new Error(`packed tarball missing exports.import for ${subpath}: ${exp.import}`);
  }

  const packedSrcJs = packedRel.filter((rel) => rel.startsWith("src/") && rel.endsWith(".js"));
  if (packedSrcJs.length) throw new Error(`tarball must not include runtime src JS: ${packedSrcJs.join(", ")}`);

  const packedToolTs = packedRel.filter((rel) => rel.startsWith("tools/") && rel.endsWith(".ts") && !rel.endsWith(".d.ts"));
  if (packedToolTs.length) throw new Error(`tarball must not include tool TypeScript source: ${packedToolTs.join(", ")}`);
  const packedMaps = packedRel.filter((rel) => rel.endsWith(".map"));
  if (packedMaps.length) throw new Error(`tarball must not include source maps: ${packedMaps.join(", ")}`);
  const packedOracles = packedRel.filter((rel) => /(^|\/)(rankOracle|featuresOracle)(\.|$)/.test(rel));
  if (packedOracles.length) {
    throw new Error(`tarball must not include test-only oracles: ${packedOracles.join(", ")}`);
  }
  for (const required of [
    "tools/search-lexical/index.js",
    "tools/search-lexical/index.d.ts",
    "tools/search-lexical/lib/compile.js",
  ]) {
    if (!packedRel.includes(required)) throw new Error(`packed tarball missing ${required}`);
  }
  if (packedRel.includes("tools/search-lexical/lib/compile.d.ts")) {
    throw new Error("tarball must not include lexical implementation declarations");
  }
  for (const required of [
    "tools/search-relationships/index.js",
    "tools/search-relationships/index.d.ts",
    "tools/search-relationships/types.d.ts",
    "tools/search-relationships/build.mjs",
    "tools/search-relationships/build.js",
    "tools/search-relationships/lib/pipeline.js",
  ]) {
    if (!packedRel.includes(required)) throw new Error(`packed tarball missing ${required}`);
  }
  const packedRelImplDts = packedRel.filter(
    (rel) => rel.startsWith("tools/search-relationships/lib/") && rel.endsWith(".d.ts")
  );
  if (packedRelImplDts.length) {
    throw new Error(`tarball must not include relationships implementation declarations: ${packedRelImplDts.join(", ")}`);
  }
  for (const required of [
    "tools/search-corpus/index.js",
    "tools/search-corpus/index.d.ts",
    "tools/search-corpus/types.d.ts",
    "tools/search-corpus/build.mjs",
    "tools/search-corpus/build.js",
    "tools/search-corpus/lib/pipeline.js",
  ]) {
    if (!packedRel.includes(required)) throw new Error(`packed tarball missing ${required}`);
  }
  const packedCorpusImplDts = packedRel.filter(
    (rel) => rel.startsWith("tools/search-corpus/lib/") && rel.endsWith(".d.ts")
  );
  if (packedCorpusImplDts.length) {
    throw new Error(`tarball must not include corpus implementation declarations: ${packedCorpusImplDts.join(", ")}`);
  }
  for (const required of [
    "tools/search-enrichment/index.js",
    "tools/search-enrichment/index.d.ts",
    "tools/search-enrichment/types.d.ts",
    "tools/search-enrichment/build.mjs",
    "tools/search-enrichment/build.js",
    "tools/search-enrichment/lib/enrich.js",
  ]) {
    if (!packedRel.includes(required)) throw new Error(`packed tarball missing ${required}`);
  }
  const packedEnrichmentImplDts = packedRel.filter(
    (rel) => rel.startsWith("tools/search-enrichment/lib/") && rel.endsWith(".d.ts")
  );
  if (packedEnrichmentImplDts.length) {
    throw new Error(`tarball must not include enrichment implementation declarations: ${packedEnrichmentImplDts.join(", ")}`);
  }

  const packedBenchmarks = packedRel.filter((rel) => rel === "benchmarks" || rel.startsWith("benchmarks/"));
  if (packedBenchmarks.length) {
    throw new Error(`tarball must not include benchmark datasets: ${packedBenchmarks.join(", ")}`);
  }

  const packedFixtures = packedRel.filter(
    (rel) => rel.startsWith("test/") || rel.includes("fixtures/software-land")
  );
  if (packedFixtures.length) {
    throw new Error(`tarball must not include test fixtures: ${packedFixtures.join(", ")}`);
  }
  for (const required of ["SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md"]) {
    if (!packedRel.includes(required)) throw new Error(`packed tarball missing ${required}`);
  }

  const forbidden = packedRel.filter(
    (rel) =>
      rel.includes("node_modules/") ||
      rel.includes(".venv/") ||
      rel.includes("/.cache/") ||
      rel.endsWith(".tgz") ||
      /(^|\/)\.env($|\.)/.test(rel)
  );
  if (forbidden.length) throw new Error(`tarball contains forbidden paths: ${forbidden.join(", ")}`);

  if (!packedRel.includes("dist/browser/searchWorker.js")) {
    throw new Error("packed tarball missing dist/browser/searchWorker.js");
  }
  if (!packedRel.some((rel) => rel.startsWith("tools/search-semantic/") && rel.endsWith(".py"))) {
    throw new Error("packed tarball missing Python semantic files");
  }
  for (const required of [
    "tools/search-semantic/index.js",
    "tools/search-semantic/index.d.ts",
    "tools/search-semantic/build.mjs",
    "tools/search-semantic/build.js",
    "tools/search-semantic/build.py",
    "tools/search-semantic/lib/embedding.py",
    "tools/search-semantic/requirements.txt",
    "tools/search-semantic/requirements-embed.txt",
  ]) {
    if (!packedRel.includes(required)) throw new Error(`packed tarball missing ${required}`);
  }
  if (packedRel.includes("tools/search-semantic/index.ts") || packedRel.includes("tools/search-semantic/build.ts")) {
    throw new Error("tarball must not include semantic TypeScript source");
  }
  if (packedRel.includes("tools/search-semantic/build.d.ts")) {
    throw new Error("tarball must not include semantic implementation declarations");
  }

  const importRe = /(?:from|import)\s+["']([^"']+)["']/g;
  for (const rel of packedRel.filter((file) => file.startsWith("dist/") && file.endsWith(".js"))) {
    const text = readFileSync(path.join(packedRoot, rel), "utf8");
    let match;
    while ((match = importRe.exec(text))) {
      const spec = match[1];
      if (spec.includes("/src/") || /(^|\/)src\//.test(spec)) {
        throw new Error(`${rel} imports omitted src path ${spec}`);
      }
      if (spec.startsWith(".")) {
        const resolved = path.posix.normalize(`${path.posix.dirname(rel)}/${spec}`);
        if (resolved === "src" || resolved.startsWith("src/")) {
          throw new Error(`${rel} resolves ${spec} to omitted ${resolved}`);
        }
      }
    }
  }

  const dtsImportRe = /(?:from|import)\s+["']([^"']+)["']/g;
  for (const rel of packedRel.filter((file) => file.startsWith("dist/") && file.endsWith(".d.ts"))) {
    const text = readFileSync(path.join(packedRoot, rel), "utf8");
    let match;
    while ((match = dtsImportRe.exec(text))) {
      const spec = match[1];
      if (spec.startsWith(".")) {
        const resolved = path.posix.normalize(`${path.posix.dirname(rel)}/${spec.replace(/\.js$/, ".d.ts")}`);
        if (!packedRel.includes(resolved) && !packedRel.includes(resolved.replace(/\.d\.ts$/, ".js"))) {
          throw new Error(`${rel} references omitted declaration ${spec} -> ${resolved}`);
        }
      }
    }
  }

  if (packedRel.includes("src/index.d.ts") || packedRel.includes("src/browser/index.d.ts")) {
    throw new Error("tarball must not include handwritten root/browser src declarations");
  }
  if (packedRel.includes("dist/browser/types.d.ts")) {
    throw new Error("tarball must not include internal browser protocol declarations");
  }
  const browserApiDts = readFileSync(path.join(packedRoot, "dist/browser/api.d.ts"), "utf8");
  const browserIndexDts = readFileSync(path.join(packedRoot, "dist/browser/index.d.ts"), "utf8");
  for (const leaked of ["_exactPruningMode", "_includeRetrievalDiagnostics", "postingBlocksVisited", "pruningFallbackReason", "representativeSelection"]) {
    if (browserApiDts.includes(leaked) || browserIndexDts.includes(leaked)) {
      throw new Error(`packed browser declarations leak ${leaked}`);
    }
  }
  for (const exported of ["InitPayload", "WorkerSearchPayload", "WorkerSearchMeta"]) {
    if (browserIndexDts.includes(`export type {`) && new RegExp(`\\b${exported}\\b`).test(browserIndexDts.split("from")[0])) {
      throw new Error(`packed browser entry re-exports ${exported}`);
    }
    if (new RegExp(`export type \\{[^}]*\\b${exported}\\b`, "s").test(browserIndexDts)) {
      throw new Error(`packed browser entry exports ${exported}`);
    }
    if (new RegExp(`export (?:interface|type) ${exported}\\b`).test(browserIndexDts)) {
      throw new Error(`packed browser entry declares ${exported}`);
    }
    if (new RegExp(`export (?:interface|type) ${exported}\\b`).test(browserApiDts)) {
      throw new Error(`packed browser api declarations export ${exported}`);
    }
  }
  if (!browserApiDts.includes("init(payload: InitPayload)") && !browserApiDts.includes("init(payload: InitPayload):")) {
    throw new Error("packed SearchClient.init is missing InitPayload typing");
  }
  if (browserApiDts.includes("ExperimentalRetriever")) {
    throw new Error("packed browser InitPayload must not accept ExperimentalRetriever");
  }
  if (!/retriever\?: RetrieverName \| "indexed-lexical";/.test(browserApiDts)) {
    throw new Error("packed browser InitPayload must accept only Worker-safe retriever names");
  }

  const consumer = path.join(tmp, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    path.join(consumer, "package.json"),
    `${JSON.stringify({ name: "search-pack-smoke-consumer", private: true, type: "module" }, null, 2)}\n`
  );
  run("npm", ["install", "--omit=dev", tarball], consumer);

  writeFileSync(
    path.join(consumer, "probe.mjs"),
    `import { SearchEngine, morphology } from "@software-land/search";
import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";
import { compileCorpus } from "@software-land/search/corpus";
import { compileRelationships } from "@software-land/search/relationships";
import { compileSemantic } from "@software-land/search/semantic";
import { compileLexicalFrequency } from "@software-land/search/lexical";
import { enrichCorpus } from "@software-land/search/enrichment";

if (typeof SearchEngine.create !== "function") throw new Error("root SearchEngine missing");
if (typeof morphology !== "function") throw new Error("root morphology missing");
if (typeof createSearchClient !== "function") throw new Error("browser createSearchClient missing");
if (typeof compileCorpus !== "function") throw new Error("corpus compileCorpus missing");
if (typeof compileRelationships !== "function") throw new Error("relationships compileRelationships missing");
if (typeof compileSemantic !== "function") throw new Error("semantic compileSemantic missing");
if (typeof compileLexicalFrequency !== "function") throw new Error("lexical compileLexicalFrequency missing");
if (typeof enrichCorpus !== "function") throw new Error("enrichment enrichCorpus missing");

const workerUrl = String(searchWorkerUrl());
if (!workerUrl.endsWith("searchWorker.js")) throw new Error(\`worker URL must end in searchWorker.js: \${workerUrl}\`);
if (!workerUrl.includes("/dist/browser/searchWorker.js")) {
  throw new Error(\`worker URL must resolve under dist/browser: \${workerUrl}\`);
}

console.log(JSON.stringify({ ok: true, workerUrl }, null, 2));
`
  );
  const probe = run("node", ["probe.mjs"], consumer);
  process.stdout.write(probe.stdout);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
