#!/usr/bin/env node
/**
 * Stage-2B posting-work audit and duplicate-list skip measurement.
 *
 * Compares exhaustive compiled posting walks with identical-array skip.
 * Development measurement only; not a CI latency gate.
 *
 *   node scripts/stage2b-posting-audit.mjs
 *   node --expose-gc scripts/stage2b-posting-audit.mjs --sizes 1000,5000,25000
 */
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { compileLexicalIndex } from "../dist/lexicalIndex.js";
import {
  auditCompiledPostingWork,
  postingAuditSummary,
  estimateTermLocalBlockMetadataBytes,
  estimateDocBlockSideIndexBytes,
} from "../dist/exactPostingAudit.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import { generateArticle, generateSettings } from "../benchmarks/memory/lib/generate.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "software-land");
const load = (name) => JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));

const { values } = parseArgs({
  options: {
    sizes: { type: "string", default: "1000,5000,10000,25000" },
    iterations: { type: "string", default: "3" },
  },
});
const sizes = values.sizes.split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
const iterations = Math.max(1, Number(values.iterations) || 3);
const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};
const SEED = 0x60d6e7ed;

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

function documentsForSize(n) {
  const documents = [
    { id: "000-rare", title: "Rare Exact", body: "rare" },
    { id: "001-the", title: "The", body: "" },
    { id: "002-mesh", title: "Mesh", body: "" },
    { id: "003-machine", title: "Machine Learning", body: "" },
    { id: "zzz-open", title: "Open", body: "" },
  ];
  for (let i = documents.length; i < n; i += 1) {
    documents.push({
      id: `doc-${String(i).padStart(7, "0")}`,
      title: `Utility Article ${i}`,
      body: [
        "the search common body",
        i % 10 === 0 ? "mesh" : "",
        i % 20 === 0 ? "alpha beta" : "",
        "open",
      ].filter(Boolean).join(" "),
    });
  }
  return documents;
}

function mixedCorpus(n) {
  const specials = [
    { id: "rare-exact", title: "ZX9 UniqueRareTitle", body: "unique rare title planted for exact retrieval" },
    { id: "tls", title: "TLS 1.2 Vulnerability", body: "transport layer security handshake certificate pinning" },
    { id: "vpn", title: "What is VPN?", body: "virtual private network tunnel bluetooth accessories" },
    { id: "iot", title: "What is IoT?", body: "internet of things sensors search index document" },
    { id: "io", title: "What is IO?", body: "input output streams latency throughput" },
    { id: "bluetooth", title: "Bluetooth Settings", body: "connect wireless accessories bluetooth pairing" },
    { id: "fps", title: "200FPS Canvas Notes", body: "css vs canvas rendering" },
  ];
  const rest = Math.max(0, n - specials.length);
  const settingsN = Math.floor(rest * 0.3);
  const articleN = rest - settingsN;
  return [...specials, ...generateSettings(settingsN, SEED ^ 0x11), ...generateArticle(articleN, { bodyTokens: 60, seed: SEED ^ 0x22, diverse: false })];
}

function softwareLandExpanded(n) {
  const originals = attachLexicalFrequency(load("documents.json"), load("lexical-frequency.json"));
  const extra = Array.from({ length: n }, (_, i) => ({
    id: `stage2b-sl-flood-${String(i).padStart(5, "0")}`,
    title: "Unrelated filler notes",
    body: "2 2 2 testing search the of and machine learning",
  }));
  return [...originals, ...extra];
}

const queryFamilies = [
  ["rare-exact", "rare exact"],
  ["moderate-df", "mesh"],
  ["high-df-bounded", "the"],
  ["high-df-long-token", "search"],
  ["prefix", "mach"],
  ["phrase", "alpha beta"],
  ["late-exact", "open"],
];

const mixedQueries = [
  ["rare-exact-title", "ZX9 UniqueRareTitle"],
  ["common-title-token", "bluetooth"],
  ["high-df", "the"],
  ["prefix", "virt"],
  ["morphology", "searching"],
  ["configured-concept", "tls"],
  ["short-literal", "io"],
  ["machine-l", "machine l"],
];

function timeSearch(engine, query, pruningMode, n, skipDuplicatePostingLists) {
  const options = { limit: 10, relatedLimit: 0, relationshipStrategy: "none" };
  engine._searchDetailedSync(query, options, false, pruningMode, skipDuplicatePostingLists);
  const samples = [];
  let last;
  for (let i = 0; i < n; i += 1) {
    last = engine._searchDetailedSync(query, options, false, pruningMode, skipDuplicatePostingLists);
    samples.push({
      totalMs: last.meta.totalMs,
      retrieveMs: last.meta.retrieveMs,
      featureMs: last.meta.featureMs,
      selectionMs: last.meta.selectionMs,
    });
  }
  return { last, samples };
}

function summarizeTiming(samples) {
  return {
    retrieveMs: median(samples.map((row) => row.retrieveMs)),
    featureMs: median(samples.map((row) => row.featureMs)),
    selectionMs: median(samples.map((row) => row.selectionMs)),
    totalMs: median(samples.map((row) => row.totalMs)),
  };
}

const rows = [];
for (const size of sizes) {
  const documents = documentsForSize(size);
  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const lexicalIndex = compileLexicalIndex(documents, { schema });
  const engine = SearchEngine.create({
    schema,
    lexicalIndex,
    retriever: "indexed",
    relationshipStrategy: "none",
  });
  await engine.index(documents);
  globalThis.gc?.();
  const hydratedHeapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;
  const runtime = engine._index.compiledLexical;

  for (const [family, queryText] of queryFamilies) {
    const query = engine._prepareQuery(queryText);
    const audit = auditCompiledPostingWork(query, runtime, engine._index.documents, queryText);
    engine.retriever.retrieve(query, engine._index, { skipDuplicatePostingLists: false });
    const exhaustiveRetrieve = engine.retriever.stats();
    engine.retriever.retrieve(query, engine._index, { skipDuplicatePostingLists: true });
    const skippedRetrieve = engine.retriever.stats();
    const exhaustive = timeSearch(engine, queryText, "exhaustive", iterations, false);
    const stage2a = timeSearch(engine, queryText, "auto", iterations, false);
    const stage2b = timeSearch(engine, queryText, "auto", iterations, true);
    rows.push({
      corpus: "synthetic-stage2a",
      size,
      family,
      query: queryText,
      audit: postingAuditSummary(audit),
      retrieve: {
        exhaustive: exhaustiveRetrieve,
        duplicateListSkip: skippedRetrieve,
      },
      exhaustive: {
        postingEntriesVisited: exhaustive.last.meta.postingEntriesVisited,
        postingEntriesSkipped: exhaustive.last.meta.postingEntriesSkipped,
        documentsFullyEvaluated: exhaustive.last.meta.documentsFullyEvaluated,
        documentsBoundRejected: exhaustive.last.meta.documentsBoundRejected,
        ...summarizeTiming(exhaustive.samples),
      },
      stage2a: {
        postingEntriesVisited: stage2a.last.meta.postingEntriesVisited,
        postingEntriesSkipped: stage2a.last.meta.postingEntriesSkipped,
        documentsFullyEvaluated: stage2a.last.meta.documentsFullyEvaluated,
        documentsBoundRejected: stage2a.last.meta.documentsBoundRejected,
        ...summarizeTiming(stage2a.samples),
      },
      stage2b: {
        postingEntriesVisited: stage2b.last.meta.postingEntriesVisited,
        postingEntriesSkipped: stage2b.last.meta.postingEntriesSkipped,
        documentsFullyEvaluated: stage2b.last.meta.documentsFullyEvaluated,
        documentsBoundRejected: stage2b.last.meta.documentsBoundRejected,
        ...summarizeTiming(stage2b.samples),
      },
    });
  }

  rows.push({
    corpus: "synthetic-stage2a",
    size,
    family: "artifact-memory",
    hydratedHeapDeltaBytes,
    postingEntries: runtime.postingEntries,
    termLocalBlockMetadataBytes: estimateTermLocalBlockMetadataBytes(runtime.postingEntries),
    docBlockSideIndex: estimateDocBlockSideIndexBytes(documents.length, runtime.terms.length),
  });
}

if (sizes.includes(25000)) {
  const mixed = mixedCorpus(25000);
  const mixedIndex = compileLexicalIndex(mixed, {
    schema,
    plugins: [
      morphology({ lemmas: { searching: "search", searched: "search", searches: "search" } }),
      compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "tls", aliases: [["transport", "layer", "security"]] }] }),
    ],
  });
  const mixedEngine = SearchEngine.create({
    schema,
    lexicalIndex: mixedIndex,
    retriever: "indexed",
    relationshipStrategy: "none",
    plugins: [
      morphology({ lemmas: { searching: "search", searched: "search", searches: "search" } }),
      compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "tls", aliases: [["transport", "layer", "security"]] }] }),
    ],
  });
  await mixedEngine.index(mixed);
  for (const [family, queryText] of mixedQueries) {
    const query = mixedEngine._prepareQuery(queryText);
    const audit = auditCompiledPostingWork(
      query,
      mixedEngine._index.compiledLexical,
      mixedEngine._index.documents,
      queryText
    );
    mixedEngine.retriever.retrieve(query, mixedEngine._index, { skipDuplicatePostingLists: false });
    const exhaustiveRetrieve = mixedEngine.retriever.stats();
    mixedEngine.retriever.retrieve(query, mixedEngine._index, { skipDuplicatePostingLists: true });
    const skippedRetrieve = mixedEngine.retriever.stats();
    rows.push({
      corpus: "mixed-25k",
      family,
      query: queryText,
      audit: postingAuditSummary(audit),
      retrieve: { exhaustive: exhaustiveRetrieve, duplicateListSkip: skippedRetrieve },
    });
  }
}

for (const extra of [400, 1000, 5000]) {
  const documents = softwareLandExpanded(extra);
  const plugins = [
    morphology({ lemmas: load("lemmas.json") }),
    compileConfiguredConceptPlugin({ configuredConcepts: load("configured-concepts.json") }),
  ];
  const engine = SearchEngine.create({
    schema,
    plugins,
    retriever: "indexed",
    relationshipStrategy: "none",
    lexicalIndex: compileLexicalIndex(documents, { schema, plugins }),
  });
  await engine.index(documents);
  const mismatches = [];
  for (const row of load("query-result-oracle.json").rows) {
    const query = engine._prepareQuery(row.query);
    const exhaustive = engine.retriever
      .retrieve(query, engine._index, { skipDuplicatePostingLists: false })
      .map((hit) => hit.document.id)
      .sort();
    const skipped = engine.retriever
      .retrieve(query, engine._index, { skipDuplicatePostingLists: true })
      .map((hit) => hit.document.id)
      .sort();
    if (JSON.stringify(exhaustive) !== JSON.stringify(skipped)) {
      mismatches.push(row.query);
    }
  }
  rows.push({
    corpus: `software-land-plus-${extra}`,
    queries: load("query-result-oracle.json").rows.length,
    exactMembership: mismatches.length === 0,
    mismatches,
  });
}

console.log(JSON.stringify({
  stage: "2B-posting-work-audit",
  iterations,
  rows,
}, null, 2));
