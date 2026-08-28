#!/usr/bin/env node
/**
 * Same-corpus phrase/high-DF/prefix/rare comparison across built checkouts.
 *
 *   node scripts/phrase-compare-bench.mjs --dist ./dist --label 2C
 *   node scripts/phrase-compare-bench.mjs --dist /tmp/sl-search-stage2b/dist --label 2B
 *
 * Not packed. Not a CI gate.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { generateArticle, generateSettings } from "../benchmarks/memory/lib/generate.mjs";

const SEED = 0x60d6e7ed;
const SCHEMA = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };
const WARMUP = 2;
const ITERATIONS = 7;

const { values } = parseArgs({
  options: {
    dist: { type: "string", default: "./dist" },
    label: { type: "string", default: "current" },
    sizes: { type: "string", default: "5000,10000,25000" },
    warmup: { type: "string", default: String(WARMUP) },
    iterations: { type: "string", default: String(ITERATIONS) },
  },
});

const distDir = path.resolve(values.dist);
const warmup = Math.max(0, Number(values.warmup) || WARMUP);
const iterations = Math.max(1, Number(values.iterations) || ITERATIONS);
const sizes = String(values.sizes)
  .split(",")
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0);

function mixedCorpus(n) {
  const specials = [
    { id: "rare-exact", title: "ZX9 UniqueRareTitle", body: "unique rare title planted for exact retrieval" },
    { id: "tls", title: "TLS 1.2 Vulnerability", body: "transport layer security handshake certificate pinning" },
    { id: "vpn", title: "What is VPN?", body: "virtual private network tunnel bluetooth accessories" },
    { id: "iot", title: "What is IoT?", body: "internet of things sensors search index document" },
    { id: "io", title: "What is IO?", body: "input output streams latency throughput" },
    { id: "bluetooth", title: "Bluetooth Settings", body: "connect wireless accessories bluetooth pairing" },
    { id: "fps", title: "200FPS Canvas Notes", body: "css vs canvas rendering" },
    { id: "probezz", title: "The Probezz", body: "notes" },
  ];
  const rest = Math.max(0, n - specials.length);
  const settingsN = Math.floor(rest * 0.3);
  const articleN = rest - settingsN;
  return [
    ...specials,
    ...generateSettings(settingsN, SEED ^ 0x11),
    ...generateArticle(articleN, { bodyTokens: 60, seed: SEED ^ 0x22, diverse: false }),
  ];
}

function quantiles(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (!sorted.length) return { n: 0, min: null, p50: null, p90: null, max: null };
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return {
    n: sorted.length,
    min: Number(sorted[0].toFixed(3)),
    p50: Number(at(0.5).toFixed(3)),
    p90: Number(at(0.9).toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

async function loadDist() {
  const href = (name) => pathToFileURL(path.join(distDir, name)).href;
  const root = await import(href("index.js"));
  const lexical = await import(href("lexicalIndex.js"));
  const dictMod = await import(href("configuredConcepts.js"));
  return {
    SearchEngine: root.SearchEngine,
    morphology: root.morphology,
    compileConfiguredConceptPlugin: dictMod.compileConfiguredConceptPlugin,
    compileLexicalIndex: lexical.compileLexicalIndex,
  };
}

const pluginsSpec = {
  lemmas: { searching: "search", searched: "search", searches: "search" },
  configuredConcepts: [{ key: "tls", aliases: [["transport", "layer", "security"]] }],
};

const queries = [
  ["rare", "ZX9 UniqueRareTitle"],
  ["high-df", "the"],
  ["prefix", "virt"],
  ["phrase", "virtual private network"],
];

function sample(engine, query) {
  const run = () => engine._searchDetailedSync(query, { limit: 10, relatedLimit: 0 }, false);
  for (let i = 0; i < warmup; i += 1) run();
  const total = [];
  const feature = [];
  const retrieve = [];
  let last;
  for (let i = 0; i < iterations; i += 1) {
    last = run();
    total.push(last.meta.totalMs);
    feature.push(last.meta.featureMs);
    retrieve.push(last.meta.retrieveMs);
  }
  return {
    matches: last.meta.matchCount,
    C: last.meta.candidateCount,
    documentsFullyEvaluated: last.meta.documentsFullyEvaluated,
    topId: last.results[0]?.id || null,
    totalMs: quantiles(total),
    featureMs: quantiles(feature),
    retrieveMs: quantiles(retrieve),
  };
}

const { SearchEngine, morphology, compileConfiguredConceptPlugin, compileLexicalIndex } = await loadDist();
const plugins = [morphology({ lemmas: pluginsSpec.lemmas }), compileConfiguredConceptPlugin({ configuredConcepts: pluginsSpec.configuredConcepts })];

const sizesOut = [];
for (const size of sizes) {
  const docs = mixedCorpus(size);
  const artifact = compileLexicalIndex(docs, { schema: SCHEMA, plugins });
  const engine = SearchEngine.create({
    schema: SCHEMA,
    plugins,
    lexicalIndex: artifact,
    retriever: "indexed",
    relationshipStrategy: "none",
  });
  await engine.index(docs);
  const queryRows = [];
  for (const [family, query] of queries) {
    queryRows.push({ family, query, ...sample(engine, query) });
  }
  sizesOut.push({ n: size, queries: queryRows });
}

console.log(JSON.stringify({
  ok: true,
  label: values.label,
  node: process.version,
  dist: distDir,
  warmup,
  iterations,
  sizes: sizesOut,
}, null, 2));
