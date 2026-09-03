/**
 * Fresh public SearchEngine.search() comparison:
 *   untouched v0.6.4  vs  PROD-1/2 candidate
 *
 * Default hybrid, no public toggle. Interleaved per query.
 *
 * Usage:
 *   node scripts/prod-search-bench.mjs \
 *     --baseline /home/sam/dev/software-land-search-v0.6.4-bench \
 *     --candidate /home/sam/dev/software-land-search-prod-1 \
 *     --sizes 25000,50000,100000
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { generateArticle, generateSettings } from "../benchmarks/memory/lib/generate.mjs";

const SCHEMA = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};
const SEED = 0x60d6e7ed;
const QUERIES = ["network", "search index", "searching", "searc", "serach", "tls", "integ"];
const SEARCH_OPTS = { limit: 10, relatedLimit: 5 };

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function mixedCorpus(n) {
  const specials = [
    {
      id: "network",
      title: "Network Guide",
      body: "network protocol notes search index document",
      lexicalFrequency: { network: 1, "search index": 1 },
    },
    {
      id: "search-index",
      title: "Search Index Guide",
      body: "search index search index",
      lexicalFrequency: { "search index": 2 },
    },
    {
      id: "search-index-prefix",
      title: "Searching Indexes",
      body: "searching indexes",
      lexicalFrequency: null,
    },
    {
      id: "searching",
      title: "Searching Documents",
      body: "searching the index",
      lexicalFrequency: { searching: 1 },
    },
    {
      id: "tls",
      title: "TLS 1.2 Vulnerability",
      body: "transport layer security handshake certificate pinning",
      lexicalFrequency: { "transport layer": 1 },
    },
    {
      id: "integrity",
      title: "Integrity Is Not Obedience",
      body: "integrity is a property of systems and people",
    },
  ];
  const rest = Math.max(0, n - specials.length);
  const settingsN = Math.floor(rest * 0.3);
  return [
    ...specials,
    ...generateSettings(settingsN, SEED ^ 0x11),
    ...generateArticle(rest - settingsN, {
      bodyTokens: 40,
      seed: SEED ^ 0x22,
      diverse: false,
    }),
  ];
}

function percentile(values, p) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}

function publicKey(rows) {
  return JSON.stringify(
    (rows || []).map((row) => ({
      id: row.id,
      rank: row.rank,
      score: row.score,
      relevanceKind: row.relevanceKind,
      directClass: row.directClass,
      relationship: row.relationship || null,
    }))
  );
}

async function loadPackage(root) {
  const require = createRequire(path.join(root, "package.json"));
  const pkg = require("./package.json");
  const indexUrl = pathToFileURL(path.join(root, "dist", "index.js")).href;
  const conceptsUrl = pathToFileURL(path.join(root, "dist", "configuredConcepts.js")).href;
  const lexicalUrl = pathToFileURL(path.join(root, "dist", "lexicalIndex.js")).href;
  const [{ SearchEngine, morphology }, { compileConfiguredConceptPlugin }, { compileLexicalIndex }] =
    await Promise.all([import(indexUrl), import(conceptsUrl), import(lexicalUrl)]);
  return { root, version: pkg.version, SearchEngine, morphology, compileConfiguredConceptPlugin, compileLexicalIndex };
}

async function makeEngine(api, documents) {
  const plugins = [
    api.morphology(),
    api.compileConfiguredConceptPlugin({
      configuredConcepts: [
        { key: "tls", aliases: [["transport", "layer", "security"]] },
        { key: "ide", aliases: [["integrated", "development", "environment"]] },
      ],
    }),
  ];
  const lexicalIndex = api.compileLexicalIndex(documents, { schema: SCHEMA, plugins });
  const engine = api.SearchEngine.create({
    schema: SCHEMA,
    plugins,
    lexicalIndex,
    retriever: "indexed",
  });
  await engine.index(documents);
  return engine;
}

function measurePair(baselineEngine, candidateEngine, query, iterations, warmup) {
  for (let i = 0; i < warmup; i++) {
    if ((i & 1) === 0) {
      baselineEngine.search(query, SEARCH_OPTS);
      candidateEngine.search(query, SEARCH_OPTS);
    } else {
      candidateEngine.search(query, SEARCH_OPTS);
      baselineEngine.search(query, SEARCH_OPTS);
    }
  }
  const baselineSamples = [];
  const candidateSamples = [];
  let baselineLast = null;
  let candidateLast = null;
  for (let i = 0; i < iterations; i++) {
    if ((i & 1) === 0) {
      const started = performance.now();
      baselineLast = baselineEngine.search(query, SEARCH_OPTS);
      baselineSamples.push(performance.now() - started);
      const startedCand = performance.now();
      candidateLast = candidateEngine.search(query, SEARCH_OPTS);
      candidateSamples.push(performance.now() - startedCand);
    } else {
      const startedCand = performance.now();
      candidateLast = candidateEngine.search(query, SEARCH_OPTS);
      candidateSamples.push(performance.now() - startedCand);
      const started = performance.now();
      baselineLast = baselineEngine.search(query, SEARCH_OPTS);
      baselineSamples.push(performance.now() - started);
    }
  }
  const baselineMeta = baselineEngine.lastSearchMeta || {};
  const candidateMeta = candidateEngine.lastSearchMeta || {};
  return {
    baseline: {
      p50: Number(percentile(baselineSamples, 0.5).toFixed(3)),
      p95: Number(percentile(baselineSamples, 0.95).toFixed(3)),
      candidates: baselineMeta.matchCount ?? baselineMeta.candidateCount ?? null,
      featureVectors: baselineMeta.featureVectorsConstructed ?? null,
      key: publicKey(baselineLast),
      winner: baselineLast?.[0]?.id || null,
    },
    candidate: {
      p50: Number(percentile(candidateSamples, 0.5).toFixed(3)),
      p95: Number(percentile(candidateSamples, 0.95).toFixed(3)),
      candidates: candidateMeta.matchCount ?? candidateMeta.candidateCount ?? null,
      eligibility: candidateMeta.rankingEvidence === "packed" ? "packed" : "legacy",
      featureVectors: candidateMeta.featureVectorsConstructed ?? null,
      directFeatureVectors: candidateMeta.directFeatureVectorsConstructed ?? null,
      relationshipOnlyFeatureVectors: candidateMeta.relationshipOnlyFeatureVectorsConstructed ?? null,
      key: publicKey(candidateLast),
      winner: candidateLast?.[0]?.id || null,
    },
  };
}

function rssMb() {
  return Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1));
}

function heapMb() {
  return Number((process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(1));
}

async function main() {
  const baselineRoot = arg("baseline", "/home/sam/dev/software-land-search-v0.6.4-bench");
  const candidateRoot = arg("candidate", "/home/sam/dev/software-land-search-prod-1");
  const sizes = arg("sizes", "25000,50000,100000")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(Boolean);
  const iterations = Number(arg("iterations", "24"));
  const warmup = Number(arg("warmup", "6"));

  const baselineApi = await loadPackage(baselineRoot);
  const candidateApi = await loadPackage(candidateRoot);
  const report = {
    node: process.version,
    baseline: { root: baselineRoot, version: baselineApi.version },
    candidate: { root: candidateRoot, version: candidateApi.version },
    iterations,
    warmup,
    relationshipStrategy: "hybrid (package default)",
    sizes: {},
  };

  for (const size of sizes) {
    const documents = mixedCorpus(size);
    const tIndexBase = performance.now();
    const baseline = await makeEngine(baselineApi, documents);
    const baselineIndexMs = Number((performance.now() - tIndexBase).toFixed(1));
    const tIndexCand = performance.now();
    const candidate = await makeEngine(candidateApi, documents);
    const candidateIndexMs = Number((performance.now() - tIndexCand).toFixed(1));

    const rows = [];
    for (const query of QUERIES) {
      const pair = measurePair(baseline, candidate, query, iterations, warmup);
      const identity = pair.baseline.key === pair.candidate.key;
      rows.push({
        query,
        eligibility: pair.candidate.eligibility,
        baselineP50: pair.baseline.p50,
        candidateP50: pair.candidate.p50,
        baselineP95: pair.baseline.p95,
        candidateP95: pair.candidate.p95,
        speedupP50: Number((pair.baseline.p50 / Math.max(pair.candidate.p50, 1e-9)).toFixed(3)),
        speedupP95: Number((pair.baseline.p95 / Math.max(pair.candidate.p95, 1e-9)).toFixed(3)),
        baselineCandidates: pair.baseline.candidates,
        candidateCandidates: pair.candidate.candidates,
        identity,
        winner: { baseline: pair.baseline.winner, candidate: pair.candidate.winner },
        featureVectors: {
          baseline: pair.baseline.featureVectors,
          candidate: pair.candidate.featureVectors,
          direct: pair.candidate.directFeatureVectors,
          relationshipOnly: pair.candidate.relationshipOnlyFeatureVectors,
        },
      });
    }

    const candidatePool = candidate._rankingEvidencePool?.memory?.() || null;
    const speedups = rows.map((row) => row.speedupP50);
    const geo = Math.exp(speedups.reduce((sum, value) => sum + Math.log(value), 0) / speedups.length);
    const aggregate = speedups.reduce((sum, value) => sum + value, 0) / speedups.length;
    const worst = rows.reduce((acc, row) => (row.speedupP50 < acc.speedupP50 ? row : acc), rows[0]);
    report.sizes[size] = {
      baselineIndexMs,
      candidateIndexMs,
      rssMb: rssMb(),
      heapMb: heapMb(),
      retainedOptimizedState: candidatePool,
      geometricMeanP50: Number(geo.toFixed(3)),
      aggregateP50: Number(aggregate.toFixed(3)),
      worstQuery: { query: worst.query, speedupP50: worst.speedupP50 },
      rows,
    };
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
