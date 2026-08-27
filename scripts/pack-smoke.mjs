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
  const packedEnrichment = packedRel.filter((rel) => rel.includes("search-enrichment"));
  if (packedEnrichment.length) {
    throw new Error(`tarball must not include search-enrichment: ${packedEnrichment.join(", ")}`);
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
  if (!/relationshipMap\?: import\("\.\.\/api\.js"\)\.RelationshipMap;/.test(browserApiDts) && !/relationshipMap\?: RelationshipMap;/.test(browserApiDts)) {
    throw new Error("packed SearchClient.init must type relationshipMap");
  }
  if (!browserApiDts.includes("configuredConcepts?:") || !browserApiDts.includes("documentRelationships?:")) {
    throw new Error("packed SearchClient.init must type configuredConcepts and documentRelationships");
  }
  if (browserApiDts.includes("dictionaryEntries?:") || /(?<!document)relationships\?:/.test(browserApiDts)) {
    throw new Error("packed SearchClient.init must not type dictionaryEntries or top-level relationships");
  }
  if (!browserApiDts.includes("init(payload: InitPayload)") && !browserApiDts.includes("init(payload: InitPayload):")) {
    throw new Error("packed SearchClient.init is missing InitPayload typing");
  }
  const apiDts = readFileSync(path.join(packedRoot, "dist/api.d.ts"), "utf8");
  if (!/\bexport interface ConfiguredConcept \{/.test(apiDts)) {
    throw new Error("packed api.d.ts missing ConfiguredConcept");
  }
  for (const leaked of [
    "EquivalenceEntry",
    "EquivalenceArtifact",
    "DictionaryPlugin",
    "SynonymPlugin",
    "SearchEquivalenceMap",
    "NormalizedSearchEquivalences",
    "CompiledRelationshipMap",
  ]) {
    if (new RegExp(`\\bexport (?:interface|type) ${leaked}\\b`).test(apiDts)) {
      throw new Error(`packed api.d.ts must not export ${leaked}`);
    }
  }
  const pluginBlockStart = apiDts.indexOf("export interface SearchPlugin");
  const pluginBlockEnd = apiDts.indexOf("export interface", pluginBlockStart + "export interface SearchPlugin".length);
  const pluginBlock = apiDts.slice(pluginBlockStart, pluginBlockEnd === -1 ? undefined : pluginBlockEnd);
  if (!pluginBlock.startsWith("export interface SearchPlugin")) {
    throw new Error("packed api.d.ts missing SearchPlugin");
  }
  if (/\bexpand\b/.test(pluginBlock)) {
    throw new Error("packed SearchPlugin must not expose expand");
  }
  if (/\bsequences\b/.test(pluginBlock) || /\bbyKey\b/.test(pluginBlock)) {
    throw new Error("packed SearchPlugin must not expose compiled configured-identity internals");
  }
  if (/\bstandaloneRecallByToken\b/.test(pluginBlock) || /\btopicalRecallByKey\b/.test(pluginBlock)) {
    throw new Error("packed SearchPlugin must not expose compiled related-recall maps");
  }
  if (apiDts.includes("synonymRecall")) {
    throw new Error("packed public types must not expose synonymRecall");
  }
  if (!apiDts.includes("equivalentRecall?:")) {
    throw new Error("packed SearchExplanation must type equivalentRecall");
  }
  const authoredBlock = apiDts.match(
    /export interface CompiledAuthoredRelevance \{[\s\S]*?\n\}/
  );
  if (!authoredBlock) throw new Error("packed api.d.ts missing CompiledAuthoredRelevance");
  for (const leaked of ["dictionary:", "synonyms:", "synonymMap:", "editorialRelationships:"]) {
    if (authoredBlock[0].includes(leaked)) {
      throw new Error(`packed CompiledAuthoredRelevance must not expose ${leaked.slice(0, -1)}`);
    }
  }
  if (!authoredBlock[0].includes("plugins:") || !authoredBlock[0].includes("documentRelationships:")) {
    throw new Error("packed CompiledAuthoredRelevance must expose plugins and documentRelationships");
  }
  if (/\brelationships\?:/.test(authoredBlock[0])) {
    throw new Error("packed CompiledAuthoredRelevance must not expose relationships as a public field");
  }
  const createBlock = readFileSync(path.join(packedRoot, "dist/api.d.ts"), "utf8").match(
    /export interface SearchEngineOptions \{[\s\S]*?\n\}/
  );
  if (!createBlock) throw new Error("packed api.d.ts missing SearchEngineOptions");
  if (!createBlock[0].includes("documentRelationships?:")) {
    throw new Error("packed SearchEngineOptions must type documentRelationships");
  }
  if (/\n  relationships\?:/.test(createBlock[0])) {
    throw new Error("packed SearchEngineOptions must not type relationships");
  }
  const corpusDts = readFileSync(path.join(packedRoot, "tools/search-corpus/index.d.ts"), "utf8");
  if (!corpusDts.includes("parseConfiguredConcepts")) {
    throw new Error("packed corpus dts missing parseConfiguredConcepts");
  }
  if (!corpusDts.includes("ConfiguredConceptArtifact")) {
    throw new Error("packed corpus dts missing ConfiguredConceptArtifact");
  }
  if (!corpusDts.includes("search-v2-configured-concepts")) {
    throw new Error("packed corpus dts missing search-v2-configured-concepts");
  }
  if (corpusDts.includes("configuredConceptsFromEquivalences")) {
    throw new Error("packed corpus dts must not export configuredConceptsFromEquivalences");
  }
  if (corpusDts.includes("dictionaryEntriesFromEquivalences")) {
    throw new Error("packed corpus dts must not export dictionaryEntriesFromEquivalences");
  }
  if (corpusDts.includes("parseEquivalences") || corpusDts.includes("EquivalenceArtifact")) {
    throw new Error("packed corpus dts must not export EquivalenceArtifact/parseEquivalences");
  }
  if (!corpusDts.includes("reconcileExternalConfiguredConcepts")) {
    throw new Error("packed corpus dts missing reconcileExternalConfiguredConcepts");
  }
  if (corpusDts.includes("normalizeExternalConfiguredConcepts")) {
    throw new Error("packed corpus dts must not export normalizeExternalConfiguredConcepts");
  }
  if (corpusDts.includes("classifyExpansionRelation")) {
    throw new Error("packed corpus dts must not export classifyExpansionRelation");
  }
  if (!corpusDts.includes("ExternalConfiguredConceptError")) {
    throw new Error("packed corpus dts missing ExternalConfiguredConceptError");
  }
  if (corpusDts.includes("normalizeExternalEquivalences")) {
    throw new Error("packed corpus dts must not export normalizeExternalEquivalences");
  }
  if (corpusDts.includes("ExternalEquivalenceError")) {
    throw new Error("packed corpus dts must not export ExternalEquivalenceError");
  }
  const rootDts = readFileSync(path.join(packedRoot, "dist/index.d.ts"), "utf8");
  if (!/\bmergeRelationships\b/.test(rootDts)) throw new Error("packed root dts missing mergeRelationships");
  if (/\bmergeEditorialRelationships\b/.test(rootDts)) {
    throw new Error("packed root dts must not export mergeEditorialRelationships");
  }
  if (/\bexport declare const dictionary\b/.test(rootDts)) {
    throw new Error("packed root dts must not export dictionary()");
  }
  if (/\bparseSynonyms\b/.test(rootDts)) {
    throw new Error("packed root dts must not export parseSynonyms");
  }
  if (/\bparseEquivalences\b/.test(rootDts)) {
    throw new Error("packed root dts must not export parseEquivalences");
  }
  if (/\bcompileRelationshipMap\b/.test(rootDts)) {
    throw new Error("packed root dts must not export compileRelationshipMap");
  }
  if (/\bnormalizeSearchEquivalences\b/.test(rootDts)) {
    throw new Error("packed root dts must not export normalizeSearchEquivalences");
  }
  if (/\bEquivalenceEntry\b/.test(rootDts)) {
    throw new Error("packed root dts must not export EquivalenceEntry");
  }
  if (/\bDictionaryPlugin\b/.test(rootDts) || /\bSynonymPlugin\b/.test(rootDts)) {
    throw new Error("packed root dts must not export DictionaryPlugin/SynonymPlugin");
  }
  if (!/\bConfiguredConcept\b/.test(rootDts)) {
    throw new Error("packed root dts missing ConfiguredConcept");
  }
  if (/\bSynonymArtifact\b/.test(rootDts)) {
    throw new Error("packed root dts must not export SynonymArtifact");
  }
  if (/\bARTIFACT_FORMATS[\s\S]*synonyms:/.test(rootDts)) {
    throw new Error("packed ARTIFACT_FORMATS must not list synonyms");
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
    `import { SearchEngine, morphology, compileAuthoredRelevance, mergeRelationships } from "@software-land/search";
import { createSearchClient, searchWorkerUrl } from "@software-land/search/browser";
import { compileCorpus, reconcileExternalConfiguredConcepts, parseConfiguredConcepts } from "@software-land/search/corpus";
import { compileRelationships } from "@software-land/search/relationships";
import { compileSemantic } from "@software-land/search/semantic";
import { compileLexicalFrequency } from "@software-land/search/lexical";

if (typeof SearchEngine.create !== "function") throw new Error("root SearchEngine missing");
if (typeof morphology !== "function") throw new Error("root morphology missing");
if (typeof compileAuthoredRelevance !== "function") throw new Error("root compileAuthoredRelevance missing");
if (typeof mergeRelationships !== "function") throw new Error("root mergeRelationships missing");
if (typeof createSearchClient !== "function") throw new Error("browser createSearchClient missing");
if (typeof compileCorpus !== "function") throw new Error("corpus compileCorpus missing");
if (typeof reconcileExternalConfiguredConcepts !== "function") throw new Error("corpus reconcileExternalConfiguredConcepts missing");
if (typeof parseConfiguredConcepts !== "function") throw new Error("corpus parseConfiguredConcepts missing");
if (typeof compileRelationships !== "function") throw new Error("relationships compileRelationships missing");
if (typeof compileSemantic !== "function") throw new Error("semantic compileSemantic missing");
if (typeof compileLexicalFrequency !== "function") throw new Error("lexical compileLexicalFrequency missing");

import * as packedRoot from "@software-land/search";
import * as packedCorpus from "@software-land/search/corpus";
if ("synonyms" in packedRoot) throw new Error("root synonyms() must not remain a public export");
if ("dictionary" in packedRoot) throw new Error("root dictionary() must not remain a public export");
if ("parseSynonyms" in packedRoot) throw new Error("root parseSynonyms must not remain a public export");
if ("parseEquivalences" in packedRoot) throw new Error("root parseEquivalences must not remain a public export");
if ("compileRelationshipMap" in packedRoot) throw new Error("root compileRelationshipMap must not remain a public export");
if ("normalizeSearchEquivalences" in packedRoot) throw new Error("root normalizeSearchEquivalences must not remain a public export");
if (packedRoot.PUBLIC_EXPORTS.includes("synonyms")) throw new Error("PUBLIC_EXPORTS must not list synonyms");
if (packedRoot.PUBLIC_EXPORTS.includes("dictionary")) throw new Error("PUBLIC_EXPORTS must not list dictionary");
if (packedRoot.PUBLIC_EXPORTS.includes("parseSynonyms")) throw new Error("PUBLIC_EXPORTS must not list parseSynonyms");
if (packedRoot.ARTIFACT_FORMATS && "synonyms" in packedRoot.ARTIFACT_FORMATS) {
  throw new Error("ARTIFACT_FORMATS must not list synonyms");
}
if (packedRoot.ARTIFACT_FORMATS && "equivalences" in packedRoot.ARTIFACT_FORMATS) {
  throw new Error("ARTIFACT_FORMATS must not list equivalences");
}
if (packedRoot.PUBLIC_EXPORTS.includes("mergeEditorialRelationships")) throw new Error("PUBLIC_EXPORTS must not list mergeEditorialRelationships");
if ("normalizeExternalEquivalences" in packedCorpus) throw new Error("corpus normalizeExternalEquivalences must not remain a public export");
if ("normalizeExternalConfiguredConcepts" in packedCorpus) throw new Error("corpus normalizeExternalConfiguredConcepts must not remain a public export");
if ("classifyExpansionRelation" in packedCorpus) throw new Error("corpus classifyExpansionRelation must not remain a public export");
if ("ExternalEquivalenceError" in packedCorpus) throw new Error("corpus ExternalEquivalenceError must not remain a public export");
if (typeof packedCorpus.ExternalConfiguredConceptError !== "function") {
  throw new Error("corpus ExternalConfiguredConceptError missing");
}
const generatedConcepts = reconcileExternalConfiguredConcepts([
  { key: "cpu", aliases: [["central", "processing", "unit"]] },
]);
if (generatedConcepts.format !== "search-corpus-external-configured-concept-reconciliation") {
  throw new Error("reconcileExternalConfiguredConcepts format mismatch");
}
if (!generatedConcepts.configuredConcepts.some((row) => row.key === "cpu")) {
  throw new Error("reconcileExternalConfiguredConcepts must keep generated configured concepts");
}
if (generatedConcepts.configuredConcepts.some((row) => "expansion" in row || "entries" in generatedConcepts)) {
  throw new Error("reconcileExternalConfiguredConcepts must project ConfiguredConcept[] not candidate entries");
}
compileAuthoredRelevance({ configuredConcepts: generatedConcepts.configuredConcepts });
try {
  await import("@software-land/search/synonyms");
  throw new Error("synonyms must not be a package export subpath");
} catch (err) {
  if (String(err?.message || err).includes("must not be a package export subpath")) throw err;
}
try {
  await import("@software-land/search/dictionary");
  throw new Error("dictionary must not be a package export subpath");
} catch (err) {
  if (String(err?.message || err).includes("must not be a package export subpath")) throw err;
}

const authored = compileAuthoredRelevance({
  configuredConcepts: [
    { key: "qa", aliases: [["quality", "assurance"]] },
    { key: "techdebt", aliases: [["tech", "debt"]] },
  ],
  relationshipMap: { qa: [{ to: { form: "testing" }, kind: "equivalent" }] },
});
const publicKeys = Object.keys(authored).sort();
if (publicKeys.join(",") !== "documentRelationships,plugins") {
  throw new Error(\`compileAuthoredRelevance public keys must be documentRelationships,plugins; got \${publicKeys.join(",")}\`);
}
for (const leaked of ["dictionary", "synonyms", "synonymMap", "editorialRelationships", "relationships", "entries"]) {
  if (leaked in authored) throw new Error(\`compileAuthoredRelevance must not expose \${leaked}\`);
}
const synonymsPlugin = authored.plugins.find((plugin) => plugin.name === "synonyms");
if (synonymsPlugin?.expand("qa")[0]?.form !== "testing") {
  throw new Error("compileAuthoredRelevance must produce one-hop recall");
}
if (authored.plugins.length !== 2 || authored.plugins.map((plugin) => plugin.name).join(",") !== "dictionary,synonyms") {
  throw new Error("compileAuthoredRelevance.plugins must be the compiler-owned plugin list");
}

const engine = SearchEngine.create({
  schema: { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } },
  plugins: [morphology(), ...authored.plugins],
  documentRelationships: authored.documentRelationships,
});
await engine.index([
  { id: "qa-guide", title: "Quality Assurance Guide", body: "process quality assurance handbook" },
  { id: "load", title: "Load Testing", body: "performance load testing notes" },
  { id: "debt", title: "Tech Debt Notes", body: "compound interest on shortcuts" },
]);
const ids = engine.search("qa", { limit: 5 }).map((hit) => hit.id);
if (!ids.includes("qa-guide") || !ids.includes("load")) {
  throw new Error("compileAuthoredRelevance engine search failed");
}
const explained = engine.searchDetailed("qa", { limit: 5, explain: true });
const identityHit = explained.results.find((hit) => hit.id === "qa-guide");
const recallHit = explained.results.find((hit) => hit.id === "load");
if (!identityHit?.retrievalSources?.includes("configured-concept")) {
  throw new Error("configured concept identity must emit configured-concept provenance");
}
if (identityHit.retrievalSources.includes("configured-equivalence")) {
  throw new Error("configured-equivalence must not remain public provenance");
}
if (!recallHit?.retrievalSources?.includes("equivalent-recall")) {
  throw new Error("relationshipMap equivalent recall must emit equivalent-recall");
}
if (recallHit.retrievalSources.includes("synonym-recall")) {
  throw new Error("synonym-recall must not remain public provenance");
}
if (!recallHit.explanation?.query?.equivalentRecall?.some((pair) => pair.source === "qa" && pair.target === "testing")) {
  throw new Error("explain query.equivalentRecall missing equivalent pair");
}
if (recallHit.explanation?.query?.synonymRecall) {
  throw new Error("query.synonymRecall must not remain public explain output");
}
if (recallHit.features?.synonymRecallMatch != null) {
  throw new Error("synonymRecall* features must not remain public explain output");
}
if (!recallHit.features?.equivalentRecallMatch) {
  throw new Error("equivalentRecallMatch must be present on equivalent-recall hits");
}
if (identityHit.features?.configuredEquivalenceMatch != null || recallHit.features?.configuredEquivalenceMatch != null) {
  throw new Error("configuredEquivalenceMatch must not remain public explain output");
}
if (identityHit.features?.configuredConceptMatch !== "expansion") {
  throw new Error("configuredConceptMatch must remain expansion on configured title identity");
}
if (recallHit.features?.configuredConceptMatch !== false) {
  throw new Error("equivalent-recall hits must keep configuredConceptMatch false");
}
const occupied = identityHit.explanation?.query?.concepts?.find((concept) => concept.id === "qa");
if (occupied?.kind !== "configured-concept") {
  throw new Error("occupied configured identity must explain kind configured-concept");
}
if (identityHit.explanation?.query?.concepts?.some((concept) => concept.kind === "acronym")) {
  throw new Error("query.concepts must not use historical kind acronym");
}
if (recallHit.explanation?.query?.concepts?.some((concept) => concept.kind === "acronym")) {
  throw new Error("query.concepts must not use historical kind acronym");
}
const debtExplained = engine.searchDetailed("tech debt", { limit: 5, explain: true });
const debtHit = debtExplained.results.find((hit) => hit.id === "debt");
const debtConcept = debtHit?.explanation?.query?.concepts?.find((concept) => concept.id === "techdebt");
if (debtConcept?.kind !== "configured-concept") {
  throw new Error("non-acronym configured identity must explain kind configured-concept");
}
if (debtHit?.explanation?.query?.concepts?.some((concept) => concept.kind === "acronym")) {
  throw new Error("query.concepts must not use historical kind acronym");
}
if (recallHit.explanation?.query?.concepts?.some((concept) => concept.provenance === "synonym")) {
  throw new Error("explain concepts must not serialize provenance synonym");
}
if (mergeRelationships(null, authored.documentRelationships) !== null) {
  throw new Error("null authored.documentRelationships must merge to null");
}

try {
  SearchEngine.create({
    relationships: { format: "search-v2-relationships", version: 1, relationships: {} },
  });
  throw new Error("old SearchEngine.create relationships option must be rejected");
} catch (err) {
  if (String(err?.message || err).includes("must be rejected")) throw err;
}

const compiledCorpus = compileCorpus({
  documents: [{ id: "a", title: "Central Processing Unit (CPU)", body: "The CPU fetches instructions." }],
});
if (!Array.isArray(compiledCorpus.configuredConcepts)) {
  throw new Error("compileCorpus must return configuredConcepts");
}
if ("dictionaryEntries" in compiledCorpus) {
  throw new Error("compileCorpus must not return dictionaryEntries");
}
if ("synonyms" in compiledCorpus) {
  throw new Error("compileCorpus must not return synonyms");
}
if (!compiledCorpus.relationshipMap || typeof compiledCorpus.relationshipMap !== "object") {
  throw new Error("compileCorpus must return relationshipMap");
}
const acceptedEquivalence = compileCorpus(
  { documents: [{ id: "a", title: "Auth notes", body: "auth and authentication appear often." }] },
  { decisions: { synonyms: [{ decision: "accept", terms: ["auth", "authentication"], relation: "alias" }] } }
);
if (acceptedEquivalence.relationshipMap.auth?.[0]?.to?.form !== "authentication") {
  throw new Error("compileCorpus must emit equivalent relationshipMap edges");
}
if (acceptedEquivalence.relationshipMap.authentication?.[0]?.to?.form !== "auth") {
  throw new Error("compileCorpus equivalent clique must be bidirectional");
}
if ("synonyms" in acceptedEquivalence) {
  throw new Error("compileCorpus must not return synonyms");
}
if ("equivalences" in compiledCorpus) {
  throw new Error("compileCorpus must not return equivalences");
}
if (!compiledCorpus.configuredConceptArtifact || compiledCorpus.configuredConceptArtifact.format !== "search-v2-configured-concepts") {
  throw new Error("compileCorpus must return configuredConceptArtifact");
}
const parsedConcepts = parseConfiguredConcepts(compiledCorpus.configuredConceptArtifact);
if (!Array.isArray(parsedConcepts.entries)) {
  throw new Error("parseConfiguredConcepts must return configured-concept entries");
}
try {
  parseConfiguredConcepts({ format: "search-v2-equivalences", version: 1, entries: [] });
  throw new Error("search-v2-equivalences must be rejected");
} catch (err) {
  if (String(err?.message || err).includes("must be rejected")) throw err;
}

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
