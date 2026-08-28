#!/usr/bin/env node
/**
 * Stage-3A unread-block skip measurements. Not a CI latency gate.
 *
 *   node --expose-gc scripts/exact-block-skip-bench.mjs
 *   node --expose-gc scripts/exact-block-skip-bench.mjs --sizes 25000,100000
 *
 * Exhaustive vs auto on the same engine/artifact. Absolute ms are not
 * comparable across machines; compare counters from this process.
 */
import { parseArgs } from "node:util";
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { compileLexicalIndex } from "../dist/lexicalIndex.js";
import { EXACT_PRUNING_V2_EXTENSION } from "../dist/lexicalIndex.js";
import { generateArticle, generateSettings } from "../benchmarks/memory/lib/generate.mjs";

const SEED = 0x60d6e7ed;
const SCHEMA = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };
const QUERY = "virtual private network";

const { values } = parseArgs({
  options: {
    sizes: { type: "string", default: "25000" },
    warmup: { type: "string", default: "2" },
    iterations: { type: "string", default: "7" },
  },
});
const sizes = String(values.sizes).split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
const warmup = Math.max(0, Number(values.warmup) || 2);
const iterations = Math.max(1, Number(values.iterations) || 7);

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
  if (!sorted.length) return { n: 0, min: null, p50: null, p95: null, max: null };
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return {
    n: sorted.length,
    min: Number(sorted[0].toFixed(3)),
    p50: Number(at(0.5).toFixed(3)),
    p95: Number(at(0.95).toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}

function counters(meta) {
  return {
    matchCount: meta.matchCount,
    postingBlocksTotal: meta.postingBlocksTotal,
    postingBlocksDecoded: meta.postingBlocksDecoded,
    postingBlocksClassifiedFromMasks: meta.postingBlocksClassifiedFromMasks,
    postingBlocksSkippedUnread: meta.postingBlocksSkippedUnread,
    postingBlocksVisited: meta.postingBlocksVisited,
    postingBlocksSkipped: meta.postingBlocksSkipped,
    duplicatePostingBlocksAvoided: meta.duplicatePostingBlocksAvoided,
    postingEntriesDecoded: meta.postingEntriesDecoded ?? meta.postingEntriesVisited,
    candidateDocumentsMaterialized: meta.candidateDocumentsMaterialized ?? meta.candidateDocumentsMaterialized,
    provenanceDocumentsScanned: meta.provenanceDocumentsScanned ?? meta.provenanceDocumentsScanned,
    featureVectorsConstructed: meta.featureVectorsConstructed,
    signaturesDiscovered: meta.signaturesDiscovered,
    representativesInserted: meta.representativesInserted,
    stage3A: meta.stage3A,
    topId: meta.primaryId,
  };
}

function sample(engine, pruningMode) {
  const run = () =>
    engine._searchDetailedSync(QUERY, { limit: 10, relatedLimit: 0 }, false, pruningMode);
  for (let i = 0; i < warmup; i += 1) run();
  const total = [];
  let last;
  for (let i = 0; i < iterations; i += 1) {
    last = run();
    total.push(last.meta.totalMs);
  }
  return { ...counters(last.meta), ids: last.results.map((hit) => hit.id), scores: last.results.map((hit) => hit.score), latency: quantiles(total) };
}

function v2Stats(artifact) {
  const ext = artifact.data?.extensions?.[EXACT_PRUNING_V2_EXTENSION];
  const json = JSON.stringify(ext || null);
  const terms = ext?.terms || [];
  let nonempty = 0;
  for (const row of terms) nonempty += (row[1] || []).length;
  return {
    artifactBytes: Buffer.byteLength(JSON.stringify(artifact)),
    v2Bytes: Buffer.byteLength(json),
    termsWithMasks: terms.length,
    nonemptyBlockMasks: nonempty,
    avgBytesPerEligibleTerm: terms.length ? Buffer.byteLength(json) / terms.length : 0,
  };
}

const plugins = [
  morphology({ lemmas: { searching: "search", searched: "search", searches: "search" } }),
  compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "tls", aliases: [["transport", "layer", "security"]] }] }),
];

for (const size of sizes) {
  const docs = mixedCorpus(size);
  const artifact = compileLexicalIndex(docs, { schema: SCHEMA, plugins });
  const meta = v2Stats(artifact);
  const engine = SearchEngine.create({
    schema: SCHEMA,
    lexicalIndex: artifact,
    retriever: "indexed",
    relationshipStrategy: "none",
    plugins,
  });
  await engine.index(docs);
  const exhaustive = sample(engine, "exhaustive");
  const auto = sample(engine, "auto");
  const same =
    JSON.stringify(exhaustive.ids) === JSON.stringify(auto.ids) &&
    JSON.stringify(exhaustive.scores) === JSON.stringify(auto.scores);
  console.log(JSON.stringify({
    size,
    query: QUERY,
    exact: same,
    artifact: meta,
    exhaustive,
    auto,
  }, null, 2));
  if (!same) {
    console.error("STAGE 3A differential mismatch");
    process.exitCode = 1;
    break;
  }
}
