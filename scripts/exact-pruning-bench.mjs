#!/usr/bin/env node
/**
 * Deterministic Stage-2A benchmark.
 *
 * Compares the internal exhaustive compiled oracle with exact document-feature
 * block pruning. This is a development measurement, not a CI timing gate.
 *
 *   node scripts/exact-pruning-bench.mjs
 *   node --expose-gc scripts/exact-pruning-bench.mjs --sizes 1000,5000,25000
 */
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";

import { SearchEngine } from "../dist/index.js";
import {
  compileLexicalIndex,
  documentBlockBoundaries,
} from "../dist/lexicalIndex.js";

const { values } = parseArgs({
  options: {
    sizes: { type: "string", default: "1000,5000,10000,25000" },
    iterations: { type: "string", default: "3" },
  },
});
const sizes = values.sizes
  .split(",")
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0);
const iterations = Math.max(1, Number(values.iterations) || 3);
const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

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

const queryFamilies = [
  ["rare-exact", "rare exact"],
  ["moderate-df", "mesh"],
  ["high-df-bounded", "the"],
  ["high-df-long-token", "search"],
  ["prefix", "mach"],
  ["phrase", "alpha beta"],
  ["late-exact", "open"],
];

function stable(value) {
  return JSON.stringify({
    results: value.results,
    related: value.related,
  });
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

function extensionBytes(documentCount, blockSize) {
  return Buffer.byteLength(JSON.stringify({
    revision: 1,
    unit: "document-ordinal",
    blockSize,
    boundaries: documentBlockBoundaries(documentCount, blockSize),
  }));
}

const rows = [];
for (const size of sizes) {
  const documents = documentsForSize(size);
  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const compileStart = performance.now();
  const lexicalIndex = compileLexicalIndex(documents, { schema });
  const compileMs = performance.now() - compileStart;
  const artifactBytes = Buffer.byteLength(JSON.stringify(lexicalIndex));
  const engine = SearchEngine.create({
    schema,
    lexicalIndex,
    retriever: "indexed",
    relationshipStrategy: "none",
  });
  const loadStart = performance.now();
  await engine.index(documents);
  const loadMs = performance.now() - loadStart;
  globalThis.gc?.();
  const hydratedHeapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;

  for (const [family, query] of queryFamilies) {
    const options = {
      limit: 10,
      relatedLimit: 0,
      relationshipStrategy: "none",
    };
    engine._searchDetailedSync(query, options, false, "exhaustive");
    engine._searchDetailedSync(query, options, false, "auto");
    const samples = { exhaustive: [], pruned: [] };
    let exhaustive;
    let pruned;
    for (let i = 0; i < iterations; i += 1) {
      exhaustive = engine._searchDetailedSync(
        query,
        options,
        false,
        "exhaustive"
      );
      samples.exhaustive.push(exhaustive.meta.totalMs);
      pruned = engine._searchDetailedSync(query, options, false, "auto");
      samples.pruned.push(pruned.meta.totalMs);
    }
    if (stable(exhaustive) !== stable(pruned)) {
      throw new Error(`Pruned output differs at N=${size}, query=${query}`);
    }
    rows.push({
      size,
      family,
      query,
      exact: true,
      matchCount: pruned.meta.matchCount,
      exhaustive: {
        postingEntriesVisited: exhaustive.meta.postingEntriesVisited,
        documentsFullyEvaluated: exhaustive.meta.documentsFullyEvaluated,
        featureMs: exhaustive.meta.featureMs,
        selectionMs: exhaustive.meta.selectionMs,
        totalMs: median(samples.exhaustive),
      },
      pruned: {
        postingEntriesVisited: pruned.meta.postingEntriesVisited,
        postingEntriesSkipped: pruned.meta.postingEntriesSkipped,
        documentBlocksVisited: pruned.meta.documentBlocksVisited,
        documentBlocksSkipped: pruned.meta.documentBlocksSkipped,
        documentsFullyEvaluated: pruned.meta.documentsFullyEvaluated,
        documentsBoundRejected: pruned.meta.documentsBoundRejected,
        featureMs: pruned.meta.featureMs,
        selectionMs: pruned.meta.selectionMs,
        totalMs: median(samples.pruned),
        fallbackReason: pruned.meta.pruningFallbackReason,
      },
    });
  }

  rows.push({
    size,
    family: "artifact",
    compileMs,
    loadMs,
    artifactBytes,
    hydratedHeapDeltaBytes,
    blockMetadataBytes: Object.fromEntries(
      [32, 64, 128, 256].map((blockSize) => [
        blockSize,
        extensionBytes(documents.length, blockSize),
      ])
    ),
  });
}

console.log(JSON.stringify({
  stage: "2A-exact-document-feature-block-pruning",
  iterations,
  rows,
}, null, 2));
