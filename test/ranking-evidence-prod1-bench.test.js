/**
 * PROD-1 phase measurements. These are retrieval/evidence phases, not
 * SearchEngine.search() latency.
 */
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { compileLexicalIndex } from "../dist/lexicalIndex.js";
import { buildQueryPlan } from "../dist/queryPlan.js";
import {
  compileRankingEvidencePlan,
} from "../dist/rankingEvidencePlan.js";
import {
  RankingEvidenceSessionPool,
  rankingEvidenceStaticFor,
} from "../dist/rankingEvidenceState.js";
import {
  finalizeRankingEvidence,
} from "../dist/rankingEvidenceFinalize.js";
import {
  retrieveWithRankingEvidence,
} from "../dist/retrievers.js";
import { extractFeatures } from "../dist/features.js";
import { scoreFeatures } from "../dist/rank.js";
import { generateArticle, generateSettings } from "../benchmarks/memory/lib/generate.mjs";
import {
  diffFinalized,
  retrievalRows,
  retrievalStats,
} from "./helpers/ranking-evidence-prod1.js";

const SCHEMA = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};
const QUERIES = ["network", "search index", "searching", "searc", "serach", "tls"];
const SEED = 0x60d6e7ed;
const OPTIONS = {
  skipDuplicatePostingLists: true,
  exactBlockSkip: { requiredDepth: 10 },
};
const benchmarkTest = process.env.RUN_RANKING_EVIDENCE_BENCH === "1" ? test : test.skip;

function mixedCorpus(n) {
  const specials = [
    {
      id: "network",
      title: "Network Guide",
      body: "network protocol notes search index document",
      lexicalFrequency: { network: 1, "search index": 1 },
    },
    {
      id: "network-typo",
      title: "Netwrok Notes",
      body: "network protocol typo",
      lexicalFrequency: { network: 1 },
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
      id: "tls-form",
      title: "Transport Layer Security",
      body: "transport layer security",
      lexicalFrequency: { "transport layer": 1 },
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

async function indexedEngine(documents) {
  const plugins = [
    morphology(),
    compileConfiguredConceptPlugin({
      configuredConcepts: [
        { key: "tls", aliases: [["transport", "layer", "security"]] },
      ],
    }),
  ];
  const lexicalIndex = compileLexicalIndex(documents, { schema: SCHEMA, plugins });
  const engine = SearchEngine.create({
    schema: SCHEMA,
    plugins,
    lexicalIndex,
    retriever: "indexed",
    relationshipStrategy: "none",
  });
  await engine.index(documents);
  return engine;
}

function percentile(values, p) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] || 0;
}

function timing(values) {
  return {
    p50: Number(percentile(values, 0.5).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
  };
}

function timed(fn) {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

function phaseRow(engine, rawQuery, iterations, pool) {
  for (let warmup = 0; warmup < 2; warmup++) {
    const query = engine._prepareQuery(rawQuery);
    engine.retriever.retrieve(query, engine._index, OPTIONS);
    const state = rankingEvidenceStaticFor(engine._index);
    const compiled = compileRankingEvidencePlan(state, query);
    if (!compiled.eligible) throw new Error(`${rawQuery}: ${compiled.reason}`);
    const session = pool.acquire(compiled.plan);
    try {
      const hits = retrieveWithRankingEvidence(
        engine.retriever,
        query,
        engine._index,
        session,
        OPTIONS
      );
      finalizeRankingEvidence(session, hits, buildQueryPlan(query, engine._index));
    } finally {
      session.release();
    }
  }

  const samples = {
    A: [],
    plan: [],
    acquire: [],
    B: [],
    C: [],
    D: [],
    current: [],
    replacementNoSetup: [],
    replacementWithSetup: [],
  };
  let sink = 0;
  let candidates = 0;
  let baselineStats = null;
  let fusedStats = null;
  let evidenceCounters = null;
  let memory = null;
  let identity = true;

  for (let iteration = 0; iteration < iterations; iteration++) {
    const baselineQuery = engine._prepareQuery(rawQuery);
    buildQueryPlan(baselineQuery, engine._index);
    const query = engine._prepareQuery(rawQuery);
    const queryPlan = buildQueryPlan(query, engine._index);
    const staticState = rankingEvidenceStaticFor(engine._index);
    const planRun = timed(() => compileRankingEvidencePlan(staticState, query));
    if (!planRun.value.eligible) {
      throw new Error(`${rawQuery}: ${planRun.value.reason}`);
    }
    const acquireRun = timed(() => pool.acquire(planRun.value.plan));
    const session = acquireRun.value;
    try {
      let baselineRun;
      let fusedRun;
      if ((iteration & 1) === 0) {
        baselineRun = timed(() =>
          engine.retriever.retrieve(baselineQuery, engine._index, OPTIONS)
        );
        baselineStats = engine.retriever.stats();
        fusedRun = timed(() =>
          retrieveWithRankingEvidence(
            engine.retriever,
            query,
            engine._index,
            session,
            OPTIONS
          )
        );
        fusedStats = engine.retriever.stats();
      } else {
        fusedRun = timed(() =>
          retrieveWithRankingEvidence(
            engine.retriever,
            query,
            engine._index,
            session,
            OPTIONS
          )
        );
        fusedStats = engine.retriever.stats();
        baselineRun = timed(() =>
          engine.retriever.retrieve(baselineQuery, engine._index, OPTIONS)
        );
        baselineStats = engine.retriever.stats();
      }
      const baselineHits = baselineRun.value;
      const hits = fusedRun.value;
      identity &&= JSON.stringify(retrievalRows(hits)) === JSON.stringify(retrievalRows(baselineHits));
      identity &&=
        JSON.stringify(retrievalStats(fusedStats)) ===
        JSON.stringify(retrievalStats(baselineStats));
      const nativeRun = timed(() => {
        for (const hit of baselineHits) {
          sink += scoreFeatures(
            extractFeatures(baselineQuery, hit.document, {
              relationship: null,
              retrievalScore: 0,
            })
          );
        }
      });
      const finalizeRun = timed(() =>
        finalizeRankingEvidence(session, hits, queryPlan)
      );
      const finalized = finalizeRun.value;
      if (iteration === 0) {
        const diff = diffFinalized(query, hits, finalized);
        if (diff.primitiveMismatches || diff.scoreMismatches) {
          throw new Error(`${rawQuery}: ${JSON.stringify(diff.samples)}`);
        }
      }
      candidates = hits.length;
      evidenceCounters = finalized.counters;
      memory = finalized.memory;
      samples.A.push(baselineRun.ms);
      samples.plan.push(planRun.ms);
      samples.acquire.push(acquireRun.ms);
      samples.B.push(fusedRun.ms);
      samples.C.push(nativeRun.ms);
      samples.D.push(finalizeRun.ms);
      samples.current.push(baselineRun.ms + nativeRun.ms);
      samples.replacementNoSetup.push(fusedRun.ms + finalizeRun.ms);
      samples.replacementWithSetup.push(
        planRun.ms + acquireRun.ms + fusedRun.ms + finalizeRun.ms
      );
    } finally {
      session.release();
    }
  }
  if (!Number.isFinite(sink)) throw new Error("benchmark sink is not finite");

  const A = timing(samples.A);
  const B = timing(samples.B);
  const current = timing(samples.current);
  const replacementNoSetup = timing(samples.replacementNoSetup);
  const replacementWithSetup = timing(samples.replacementWithSetup);
  return {
    query: rawQuery,
    candidates,
    A,
    plan: timing(samples.plan),
    acquire: timing(samples.acquire),
    B,
    C: timing(samples.C),
    D: timing(samples.D),
    current,
    replacementNoSetup,
    replacementWithSetup,
    retrievalOverheadMs: Number((B.p50 - A.p50).toFixed(3)),
    retrievalOverheadPct: Number(
      (((B.p50 - A.p50) / Math.max(A.p50, 1e-9)) * 100).toFixed(2)
    ),
    phaseSpeedupNoSetup: Number(
      (current.p50 / Math.max(replacementNoSetup.p50, 1e-9)).toFixed(2)
    ),
    phaseSpeedupWithSetup: Number(
      (current.p50 / Math.max(replacementWithSetup.p50, 1e-9)).toFixed(2)
    ),
    identity,
    noSecondPostingPass:
      evidenceCounters.postingEntriesObserved === fusedStats.postingEntriesVisited &&
      evidenceCounters.postingEntriesScattered <= fusedStats.postingEntriesVisited,
    postingEntriesDecoded: baselineStats.postingEntriesDecoded,
    postingEntriesVisited: baselineStats.postingEntriesVisited,
    duplicatePostingEntriesAvoided: baselineStats.duplicatePostingEntriesAvoided,
    stage3A: {
      mode: baselineStats.stage3A,
      blocksTotal: baselineStats.postingBlocksTotal,
      blocksDecoded: baselineStats.postingBlocksDecoded,
      blocksClassifiedFromMasks: baselineStats.postingBlocksClassifiedFromMasks,
      blocksSkippedUnread: baselineStats.postingBlocksSkippedUnread,
    },
    evidence: evidenceCounters,
    memory: {
      ...memory,
      staticBytesPerDocument: memory.staticBytes / engine._index.documents.length,
      sessionBytesPerDocument: memory.sessionBytes / engine._index.documents.length,
      evidenceBytesPerTouchedCandidate:
        memory.evidenceBytes / Math.max(evidenceCounters.slots, 1),
      finalizedBytesPerCandidate: memory.finalizedBytes / Math.max(candidates, 1),
    },
  };
}

async function corpusReport(corpus, iterations) {
  const memoryBefore = process.memoryUsage();
  const engine = await indexedEngine(mixedCorpus(corpus));
  const memoryAfterIndex = process.memoryUsage();
  const pool = new RankingEvidenceSessionPool();
  const rows = QUERIES.map((query) => phaseRow(engine, query, iterations, pool));
  const memoryAfterQueries = process.memoryUsage();
  return {
    corpus,
    iterations,
    rows,
    retainedPool: pool.memory(),
    processMemory: {
      before: memoryBefore,
      afterIndex: memoryAfterIndex,
      afterQueries: memoryAfterQueries,
    },
  };
}

benchmarkTest("PROD-1 retrieval/evidence phases at 25k", async () => {
  const report = await corpusReport(25_000, 9);
  expect(report.rows.every((row) => row.identity && row.noSecondPostingPass)).toBe(true);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ rankingEvidenceBench25k: report }));
}, 900_000);

benchmarkTest("PROD-1 retrieval/evidence phases at 50k", async () => {
  const report = await corpusReport(50_000, 7);
  expect(report.rows.every((row) => row.identity && row.noSecondPostingPass)).toBe(true);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ rankingEvidenceBench50k: report }));
}, 1_200_000);

benchmarkTest("PROD-1 retrieval/evidence phases at 100k", async () => {
  const report = await corpusReport(100_000, 7);
  expect(report.rows.every((row) => row.identity && row.noSecondPostingPass)).toBe(true);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ rankingEvidenceBench100k: report }));
}, 1_800_000);
