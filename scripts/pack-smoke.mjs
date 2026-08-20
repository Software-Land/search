/**
 * Pack the package, install it in isolation, and import all six public specifiers.
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

  const consumer = path.join(tmp, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    path.join(consumer, "package.json"),
    `${JSON.stringify({ name: "search-pack-smoke-consumer", private: true, type: "module" }, null, 2)}\n`
  );
  run("npm", ["install", "--omit=dev", tarball], consumer);

  writeFileSync(
    path.join(consumer, "probe.mjs"),
    `import { SearchEngine } from "@software-land/search";
import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";
import { compileCorpus } from "@software-land/search/corpus";
import { compileRelationships } from "@software-land/search/relationships";
import { compileSemantic } from "@software-land/search/semantic";
import { compileLexicalFrequency } from "@software-land/search/lexical";

if (typeof SearchEngine.create !== "function") throw new Error("root SearchEngine missing");
if (typeof createSearchClient !== "function") throw new Error("browser createSearchClient missing");
if (typeof compileCorpus !== "function") throw new Error("corpus compileCorpus missing");
if (typeof compileRelationships !== "function") throw new Error("relationships compileRelationships missing");
if (typeof compileSemantic !== "function") throw new Error("semantic compileSemantic missing");
if (typeof compileLexicalFrequency !== "function") throw new Error("lexical compileLexicalFrequency missing");

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
