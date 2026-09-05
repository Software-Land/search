#!/usr/bin/env node
/**
 * Same-run compact-runtime measurements. Not a CI latency gate.
 *
 *   node --expose-gc scripts/compact-runtime-bench.mjs
 *   node --expose-gc scripts/compact-runtime-bench.mjs --sizes 1000,5000,10000
 *
 * Reports p50/p90 after warmup. Absolute milliseconds are not comparable
 * across machines or days; compare modes from this process.
 */
import { parseArgs } from "node:util";
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/relationships/configuredConcepts.js";
import { compileLexicalIndex, parseLexicalIndex, loadLexicalIndex } from "../dist/indexing/lexicalIndex.js";
import { generateArticle, generateSettings } from "../benchmarks/memory/lib/generate.mjs";

const SEED = 0x60d6e7ed;
const SCHEMA = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };
const WARMUP = 2;
const ITERATIONS = 7;

const { values } = parseArgs({
  options: {
    sizes: { type: "string", default: "1000,5000,10000,25000" },
    warmup: { type: "string", default: String(WARMUP) },
    iterations: { type: "string", default: String(ITERATIONS) },
  },
});
const sizes = String(values.sizes)
  .split(",")
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0);
const warmup = Math.max(0, Number(values.warmup) || WARMUP);
const iterations = Math.max(1, Number(values.iterations) || ITERATIONS);

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

function snapshot() {
  if (typeof globalThis.gc === "function") globalThis.gc();
  const mu = process.memoryUsage();
  return { heapUsed: mu.heapUsed, rss: mu.rss };
}

function sample(engine, query, opts = {}) {
  const run = () => engine._searchDetailedSync(query, { limit: 10, relatedLimit: 0, ...opts }, false);
  for (let i = 0; i < warmup; i += 1) run();
  const total = [];
  const retrieve = [];
  const feature = [];
  let last;
  for (let i = 0; i < iterations; i += 1) {
    last = run();
    total.push(last.meta.totalMs);
    retrieve.push(last.meta.retrieveMs);
    feature.push(last.meta.featureMs);
  }
  return {
    matches: last.meta.matchCount,
    C: last.meta.candidateCount,
    postingEntriesVisited: last.meta.postingEntriesVisited,
    postingEntriesSkipped: last.meta.postingEntriesSkipped,
    documentsFullyEvaluated: last.meta.documentsFullyEvaluated,
    documentsBoundRejected: last.meta.documentsBoundRejected,
    topId: last.results[0]?.id || null,
    totalMs: quantiles(total),
    retrieveMs: quantiles(retrieve),
    featureMs: quantiles(feature),
  };
}

const plugins = [
  morphology({ lemmas: { searching: "search", searched: "search", searches: "search" } }),
  compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "tls", aliases: [["transport", "layer", "security"]] }] }),
];
const queries = [
  ["rare", "ZX9 UniqueRareTitle"],
  ["high-df", "the"],
  ["prefix", "virt"],
  ["phrase", "virtual private network"],
  ["probezz", "probezz"],
  ["machine-l", "machine l"],
  ["query-2", "2"],
];

const sizesOut = [];
for (const size of sizes) {
  const docs = mixedCorpus(size);
  const beforeCompile = snapshot();
  const compileStart = performance.now();
  const artifact = compileLexicalIndex(docs, { schema: SCHEMA, plugins });
  const compileMs = performance.now() - compileStart;
  const artifactBytes = Buffer.byteLength(JSON.stringify(artifact));
  const parseStart = performance.now();
  parseLexicalIndex(JSON.parse(JSON.stringify(artifact)));
  const parseMs = performance.now() - parseStart;
  const viewStart = performance.now();
  loadLexicalIndex(artifact, docs, SCHEMA, plugins);
  const viewMs = performance.now() - viewStart;

  const engine = SearchEngine.create({
    schema: SCHEMA,
    plugins,
    lexicalIndex: artifact,
    retriever: "indexed",
    relationshipStrategy: "none",
  });
  const loadStart = performance.now();
  await engine.index(docs);
  const loadMs = performance.now() - loadStart;
  const afterLoad = snapshot();

  const fallback = SearchEngine.create({
    schema: SCHEMA,
    plugins,
    retriever: "indexed",
    relationshipStrategy: "none",
  });
  const fallbackStart = performance.now();
  await fallback.index(docs);
  const fallbackMs = performance.now() - fallbackStart;

  const queryRows = [];
  for (const [family, query] of queries) {
    const compact = sample(engine, query);
    const fallbackRun = sample(fallback, query);
    if (compact.topId !== fallbackRun.topId) {
      throw new Error(`top-id mismatch at N=${size} query=${query}: ${compact.topId} vs ${fallbackRun.topId}`);
    }
    queryRows.push({ family, query, compact, fallback: fallbackRun });
  }

  sizesOut.push({
    n: size,
    artifactBytes,
    compileMs: Number(compileMs.toFixed(3)),
    parseValidationMs: Number(parseMs.toFixed(3)),
    runtimeViewMs: Number(viewMs.toFixed(3)),
    engineLoadMs: Number(loadMs.toFixed(3)),
    fallbackInitMs: Number(fallbackMs.toFixed(3)),
    memory: {
      heapUsedMb: Number((afterLoad.heapUsed / 1048576).toFixed(2)),
      rssMb: Number((afterLoad.rss / 1048576).toFixed(2)),
      compileHeapUsedMb: Number((beforeCompile.heapUsed / 1048576).toFixed(2)),
    },
    queries: queryRows,
  });
}

console.log(JSON.stringify({
  ok: true,
  node: process.version,
  warmup,
  iterations,
  gc: typeof globalThis.gc === "function",
  note: "Compare modes in this run. Absolute ms are not a semantic regression signal.",
  sizes: sizesOut,
}, null, 2));
