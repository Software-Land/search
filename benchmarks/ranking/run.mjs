#!/usr/bin/env node
/**
 * Ranker envelope at a fixed candidate count C.
 *
 * Pairwise constraint ranking is Θ(C²). This harness builds C documents that
 * all match one rare token so retrieval C equals corpus size. It does not claim
 * that corpus size N is the ranker input; full-scan of a high-DF term can make
 * C grow toward N, which is the limitation this measures.
 *
 *   node benchmarks/ranking/run.mjs
 *   node benchmarks/ranking/run.mjs --c 100,200,500,1000
 *
 * Not packed in the npm tarball. Not a search-quality benchmark.
 */

import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { SearchEngine, english } from "../../dist/index.js";

const SCHEMA = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const QUERY = "rankprobe";

function parseSizes(raw) {
  const sizes = String(raw || "100,200,500,1000")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!sizes.length) throw new Error("--c must be a comma-separated list of positive integers");
  return sizes;
}

function generateFixedC(c) {
  const docs = [];
  for (let i = 0; i < c; i += 1) {
    docs.push({
      id: `d${String(i).padStart(5, "0")}`,
      title: `Note ${i} ${QUERY}`,
      body: `${QUERY} body`,
    });
  }
  return docs;
}

async function measure(c) {
  const docs = generateFixedC(c);
  const engine = SearchEngine.create({
    schema: SCHEMA,
    plugins: [english()],
    retriever: "full-scan",
    relationshipStrategy: "none",
  });
  await engine.index(docs);
  const t0 = performance.now();
  const detailed = engine.searchDetailed(QUERY, { limit: 10 });
  const wallMs = performance.now() - t0;
  const meta = detailed.meta || {};
  const candidateCount = meta.candidateCount;
  if (candidateCount !== c) {
    throw new Error(`expected C=${c}, got candidateCount=${candidateCount}`);
  }
  return {
    C: candidateCount,
    pairComparisons: (candidateCount * (candidateCount - 1)) / 2,
    retrieveMs: meta.retrieveMs,
    featureMs: meta.featureMs,
    rankMs: meta.rankMs,
    wallMs,
    retriever: meta.retriever,
  };
}

const { values } = parseArgs({
  options: {
    c: { type: "string", default: "100,200,500,1000" },
    json: { type: "boolean", default: false },
  },
  strict: true,
});

const sizes = parseSizes(values.c);
await measure(Math.min(sizes[0], 50));
const rows = [];
for (const c of sizes) {
  rows.push(await measure(c));
}

if (values.json) {
  console.log(JSON.stringify({ query: QUERY, rows }, null, 2));
} else {
  console.log("Fixed-C ranking envelope (full-scan retrieval of a rare token).");
  console.log("Ranking work is Θ(C²). Corpus scale is a retrieval problem.\n");
  console.log("C\tpairs\tretrieveMs\tfeatureMs\trankMs\twallMs");
  for (const row of rows) {
    console.log(
      `${row.C}\t${row.pairComparisons}\t${row.retrieveMs.toFixed(2)}\t${row.featureMs.toFixed(2)}\t${row.rankMs.toFixed(2)}\t${row.wallMs.toFixed(2)}`
    );
  }
}
