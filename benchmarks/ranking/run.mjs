#!/usr/bin/env node
/**
 * Ranker envelope at a fixed candidate count C.
 *
 * Builtin ranking is sparse in the number of constraint signatures B.
 * The frozen all-pairs oracle remains available for comparison. Custom
 * constraint functions still take the pairwise path.
 *
 *   node benchmarks/ranking/run.mjs
 *   node benchmarks/ranking/run.mjs --c 100,200,500,1000
 *   node benchmarks/ranking/run.mjs --workload homogeneous,few-buckets,mixed
 *
 * Not packed in the npm tarball. Not a search-quality benchmark.
 */

import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SearchEngine, morphology } from "../../dist/index.js";
import { dictionary } from "../../dist/dictionary.js";
import { attachLexicalFrequency } from "../../tools/search-lexical/index.js";
import { lastRankStats, rankCandidates } from "../../dist/rank.js";
import { rankCandidatesPairwise } from "../../build/test/oracles/rankOracle.js";
import { HYBRID_CONSTRAINTS, DEFAULT_CONSTRAINTS } from "../../dist/constraints.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};
const QUERY = "rankprobe";

function parseList(raw, fallback) {
  const items = String(raw || fallback)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!items.length) throw new Error("expected a comma-separated list");
  return items;
}

function parseSizes(raw) {
  const sizes = parseList(raw, "100,200,500,1000").map((part) => Number(part));
  if (sizes.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error("--c must be a comma-separated list of positive integers");
  }
  return sizes;
}

function generateHomogeneous(c) {
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

function generateFewBuckets(c) {
  const exactN = Math.max(1, Math.floor(c * 0.1));
  const docs = [];
  for (let i = 0; i < c; i += 1) {
    if (i < exactN) {
      docs.push({ id: `e${String(i).padStart(5, "0")}`, title: QUERY, body: `${QUERY} exact` });
    } else {
      docs.push({
        id: `d${String(i).padStart(5, "0")}`,
        title: `Note ${i} ${QUERY}`,
        body: `${QUERY} body`,
      });
    }
  }
  return docs;
}

function generateMixed(c) {
  const docs = [];
  for (let i = 0; i < c; i += 1) {
    const id = `m${String(i).padStart(5, "0")}`;
    const kind = i % 7;
    if (kind === 0) docs.push({ id, title: QUERY, body: `${QUERY} exact title` });
    else if (kind === 1) docs.push({ id, title: `TLS 1.${i % 9} ${QUERY}`, body: `${QUERY} version` });
    else if (kind === 2) docs.push({ id, title: `${QUERY} companion extra words here`, body: `${QUERY} long` });
    else if (kind === 3) docs.push({ id, title: `200FPS ${QUERY}`, body: `${QUERY} literal` });
    else if (kind === 4) docs.push({ id, title: `Related neighbor ${i} ${QUERY}`, body: `unrelated body ${i}` });
    else if (kind === 5) docs.push({ id, title: `${QUERY} ${QUERY} ${QUERY}`, body: `${QUERY} ${QUERY} phrase` });
    else docs.push({ id, title: `Note ${i} ${QUERY}`, body: `${QUERY} weak` });
  }
  return docs;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function featuredFromDetailed(detailed) {
  return detailed.results.map((row) => ({
    document: { id: row.id, title: row.title },
    features: row.features,
    retrievalSources: row.retrievalSources,
  }));
}

function timeRankers(cands, constraints, repeats = 5) {
  rankCandidates(cands, { constraints });
  rankCandidatesPairwise(cands, { constraints });
  const neu = [];
  const old = [];
  for (let i = 0; i < repeats; i += 1) {
    const t0 = performance.now();
    rankCandidates(cands, { constraints });
    neu.push(performance.now() - t0);
    const t1 = performance.now();
    rankCandidatesPairwise(cands, { constraints });
    old.push(performance.now() - t1);
  }
  const stats = lastRankStats();
  return {
    newMs: median(neu),
    oldMs: median(old),
    speedup: median(old) / Math.max(median(neu), 1e-9),
    stats,
  };
}

async function measureSynthetic(kind, c) {
  const docs =
    kind === "few-buckets" ? generateFewBuckets(c) : kind === "mixed" ? generateMixed(c) : generateHomogeneous(c);
  const engine = SearchEngine.create({
    schema: SCHEMA,
    plugins: [morphology()],
    retriever: "full-scan",
    relationshipStrategy: "none",
  });
  await engine.index(docs);
  const t0 = performance.now();
  const detailed = engine.searchDetailed(QUERY, { limit: c, explain: true });
  const wallMs = performance.now() - t0;
  const meta = detailed.meta || {};
  const candidateCount = meta.candidateCount;
  if (candidateCount !== c) {
    throw new Error(`${kind}: expected C=${c}, got candidateCount=${candidateCount}`);
  }
  const timed = timeRankers(featuredFromDetailed(detailed), DEFAULT_CONSTRAINTS);
  return {
    workload: kind,
    C: candidateCount,
    retrieveMs: meta.retrieveMs,
    featureMs: meta.featureMs,
    rankMs: meta.rankMs,
    wallMs,
    retriever: meta.retriever,
    ...timed,
  };
}

async function measureSoftwareLand() {
  const fixture = path.join(ROOT, "test", "fixtures", "software-land");
  const load = (name) => JSON.parse(readFileSync(path.join(fixture, name), "utf8"));
  const documents = load("documents.json");
  const engine = SearchEngine.create({
    schema: SCHEMA,
    plugins: [
      morphology({ lemmas: load("lemmas.json") }),
      dictionary({ entries: load("dictionary.json") }),
    ],
    documentRelationships: load("relationships.json"),
    relationshipStrategy: "hybrid",
    retriever: "full-scan",
  });
  await engine.index(attachLexicalFrequency(documents, load("lexical-frequency.json")));
  const queries = ["2", "tls", "nfc", "vpn", "sort recurses", "machine learning", "aplicationsecurity"];
  const rows = [];
  for (const query of queries) {
    const t0 = performance.now();
    const detailed = engine.searchDetailed(query, { limit: 1000, explain: true });
    const wallMs = performance.now() - t0;
    const timed = timeRankers(featuredFromDetailed(detailed), HYBRID_CONSTRAINTS);
    rows.push({
      workload: "software-land",
      query,
      C: detailed.meta.candidateCount,
      retrieveMs: detailed.meta.retrieveMs,
      featureMs: detailed.meta.featureMs,
      rankMs: detailed.meta.rankMs,
      wallMs,
      retriever: detailed.meta.retriever,
      ...timed,
    });
  }
  return rows;
}

function printRow(row) {
  const stats = row.stats || {};
  const pairs = stats.candidatePairCompares ?? "";
  const B = stats.B ?? "";
  const edges = stats.bucketEdges ?? "";
  const speed = Number.isFinite(row.speedup) ? row.speedup.toFixed(1) : "";
  const label = row.query ? `${row.workload}:${row.query}` : row.workload;
  console.log(
    [
      label,
      row.C,
      B,
      pairs,
      edges,
      Number(row.featureMs).toFixed(2),
      Number(row.rankMs).toFixed(2),
      Number(row.newMs).toFixed(3),
      Number(row.oldMs).toFixed(3),
      speed,
      Number(row.wallMs).toFixed(2),
    ].join("\t")
  );
}

const { values } = parseArgs({
  options: {
    c: { type: "string", default: "100,200,500,1000" },
    workload: { type: "string", default: "homogeneous,few-buckets,mixed" },
    json: { type: "boolean", default: false },
    "software-land": { type: "boolean", default: false },
  },
  strict: true,
});

const sizes = parseSizes(values.c);
const workloads = parseList(values.workload, "homogeneous,few-buckets,mixed");
await measureSynthetic("homogeneous", Math.min(sizes[0], 50));
const rows = [];
for (const kind of workloads) {
  for (const c of sizes) {
    rows.push(await measureSynthetic(kind, c));
  }
}
if (values["software-land"] || workloads.includes("software-land")) {
  rows.push(...(await measureSoftwareLand()));
}

if (values.json) {
  console.log(JSON.stringify({ query: QUERY, rows }, null, 2));
} else {
  console.log("Fixed-C ranking envelope. Sparse builtin ranker vs frozen all-pairs oracle.");
  console.log("Corpus scale remains a retrieval problem. Rank-only newMs/oldMs are median of 5 runs.\n");
  console.log("workload\tC\tB\tpairs\tbucketEdges\tfeatureMs\trankMs\tnewMs\toldMs\tspeedup\twallMs");
  for (const row of rows) printRow(row);
}
