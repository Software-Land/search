import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { compileLexicalIndex } from "../dist/indexing/lexicalIndex.js";
import { RankingEvidenceSessionPool } from "../dist/rankingEvidenceState.js";
import {
  finalizeRankingEvidence,
  readRankingEvidenceFactsForTest,
} from "../dist/rankingEvidenceFinalize.js";
import { retrieveWithRankingEvidence } from "../dist/retrieval/retrievers.js";
import {
  prepareEvidence,
  releaseEvidence,
  retrievalRows,
  retrievalStats,
  runEvidence,
  runEvidenceAsync,
} from "./helpers/ranking-evidence-prod1.js";

const schema = {
  title: { type: "text", role: "title" },
  summary: { type: "text", role: "summary" },
  body: { type: "text", role: "body" },
};

function configuredPlugin(rows) {
  return compileConfiguredConceptPlugin({ configuredConcepts: rows });
}

async function compiledEngine(documents, configuredConcepts = []) {
  const plugins = [morphology(), configuredPlugin(configuredConcepts)];
  const lexicalIndex = compileLexicalIndex(documents, { schema, plugins });
  const engine = SearchEngine.create({
    schema,
    plugins,
    lexicalIndex,
    retriever: "indexed",
    relationshipStrategy: "none",
  });
  await engine.index(documents);
  return engine;
}

function expectClean(run) {
  expect(run.eligible).toBe(true);
  expect(run.diff).toEqual({
    candidates: run.hits.length,
    primitiveMismatches: 0,
    scoreMismatches: 0,
    samples: [],
  });
}

const targetedDocuments = [
  {
    id: "body-network-typo-title",
    title: "Netwrok Notes",
    summary: "",
    body: "network protocol",
    lexicalFrequency: { network: 1 },
  },
  {
    id: "network",
    title: "Network Guide",
    summary: "network overview",
    body: "network protocol notes",
    lexicalFrequency: { network: 1 },
  },
  {
    id: "network-repeated",
    title: "Network Network Network",
    summary: "",
    body: "network",
    lexicalFrequency: { network: 1 },
  },
  {
    id: "node-punctuation",
    title: "Node.js Guide",
    summary: "",
    body: "node runtime",
    lexicalFrequency: { node: 1 },
  },
  {
    id: "phrase-body",
    title: "Indexing Notes",
    summary: "",
    body: "search index search index",
    lexicalFrequency: { "search index": 2 },
  },
  {
    id: "phrase-prefix",
    title: "Searching Indexes",
    summary: "",
    body: "search index",
    lexicalFrequency: { "search index": 1 },
  },
  {
    id: "phrase-summary",
    title: "Catalog",
    summary: "search index",
    body: "search and index",
    lexicalFrequency: { search: 1, index: 1 },
  },
  {
    id: "search-lemma",
    title: "Search Guide",
    summary: "",
    body: "search documents",
    lexicalFrequency: { search: 1 },
  },
  {
    id: "searching",
    title: "Searching Documents",
    summary: "",
    body: "searching the index",
    lexicalFrequency: { searching: 1 },
  },
  {
    id: "tls-key",
    title: "TLS Guide",
    summary: "transport layer security",
    body: "tls handshake",
    lexicalFrequency: { tls: 1 },
  },
  {
    id: "tls-form",
    title: "Transport Layer Security",
    summary: "tls",
    body: "transport layer security handshake",
    lexicalFrequency: { "transport layer": 1 },
  },
  {
    id: "tls-body",
    title: "Handshake Notes",
    summary: "",
    body: "transport layer security",
    lexicalFrequency: { "transport layer": 1 },
  },
];

test("production evidence matches all represented targeted-family facts and F", async () => {
  const engine = await compiledEngine(targetedDocuments, [
    { key: "tls", aliases: [["transport", "layer", "security"]] },
  ]);
  const pool = new RankingEvidenceSessionPool();
  let candidates = 0;
  for (const query of [
    "network",
    "search index",
    "searching",
    "searc",
    "serach",
    "tls",
    "transport layer",
    "transport layer security",
    "node",
  ]) {
    const run = runEvidence(engine, query, { pool });
    try {
      expectClean(run);
      candidates += run.hits.length;
      expect(run.finalized.counters.postingEntriesObserved).toBe(
        run.retrievalStats.postingEntriesVisited
      );
    } finally {
      releaseEvidence(run);
    }
  }
  expect(candidates).toBeGreaterThan(0);
});

test("all-stopword title prefix quality remains exact", async () => {
  const engine = await compiledEngine([
    {
      id: "all-stopwords",
      title: "Is The And",
      summary: "",
      body: "is the",
    },
  ]);
  const run = runEvidence(engine, "is the");
  try {
    expectClean(run);
  } finally {
    releaseEvidence(run);
  }
});

test("configured summary-only inflection uses authoritative summary lemmas", async () => {
  const engine = await compiledEngine(
    [
      {
        id: "summary-lemma",
        title: "Catalog",
        summary: "software libraries",
        body: "sdk reference",
      },
    ],
    [{ key: "sdk", aliases: [["software", "library"]] }]
  );
  const run = runEvidence(engine, "sdk");
  try {
    expectClean(run);
    const facts = readRankingEvidenceFactsForTest(run.finalized, 0);
    expect(facts.features.configuredConceptFieldEvidence.summary).toBe("form");
  } finally {
    releaseEvidence(run);
  }
});

test("integ first-form prefix fails packed closed and ranks Integrity first", async () => {
  const engine = await compiledEngine(
    [
      {
        id: "integrity",
        title: "Integrity Is Not Obedience",
        summary: "",
        body: "integrity is a property of systems",
      },
      {
        id: "framework",
        title: "Framework vs Library vs Package",
        summary: "",
        body: "the framework may search for ide support",
      },
      {
        id: "refactoring",
        title: "What is Refactoring?",
        summary: "",
        body: "ide tools help propagate a method rename",
      },
      {
        id: "cicd",
        title: "CI/CD",
        summary: "",
        body: "a large codebase takes longer to index in developer ides",
      },
      {
        id: "generative",
        title: "Generative Coding",
        summary: "",
        body: "autocomplete directly in your ide from an llm",
      },
      {
        id: "idempotency",
        title: "Idempotency Keys",
        summary: "",
        body: "retry the same logical operation",
      },
    ],
    [{ key: "ide", aliases: [["integrated", "development", "environment"]] }]
  );
  const run = runEvidence(engine, "integ");
  try {
    expect(run.eligible).toBe(false);
    expect(run.reason).toBe("configured-prefix-recall");
    expect(engine.search("integ", { limit: 1 })[0].id).toBe("integrity");
  } finally {
    releaseEvidence(run);
  }
});

test("evidence retrieval is identical to legacy retrieval including Stage 2B/3A stats", async () => {
  const engine = await compiledEngine(targetedDocuments, [
    { key: "tls", aliases: [["transport", "layer", "security"]] },
  ]);
  const options = {
    skipDuplicatePostingLists: true,
    exactBlockSkip: { requiredDepth: 10 },
  };
  for (const rawQuery of ["network", "search index", "searching", "searc", "serach", "tls"]) {
    const baselineQuery = engine._prepareQuery(rawQuery);
    const baseline = engine.retriever.retrieve(baselineQuery, engine._index, options);
    const baselineStats = retrievalStats(engine.retriever.stats());
    const run = runEvidence(engine, rawQuery, { retrievalOptions: options });
    try {
      expect(retrievalRows(run.hits)).toEqual(retrievalRows(baseline));
      expect(retrievalStats(run.retrievalStats)).toEqual(baselineStats);
      expectClean(run);
    } finally {
      releaseEvidence(run);
    }
  }
});

test("scaled multi-block Stage 3A retrieval remains identical with unread blocks", async () => {
  const strong = Array.from({ length: 16 }, (_, index) => ({
    id: `strong-${index}`,
    title: `Alpha Strong Document ${index}`,
    summary: "",
    body: "search index",
  }));
  const weak = Array.from({ length: 368 }, (_, index) => ({
    id: `weak-${index}`,
    title: `Beta Weak Document ${index}`,
    summary: "",
    body: "search",
  }));
  const engine = await compiledEngine([...strong, ...weak]);
  const options = {
    skipDuplicatePostingLists: true,
    exactBlockSkip: { requiredDepth: 10 },
  };
  const baselineQuery = engine._prepareQuery("search index");
  const baseline = engine.retriever.retrieve(baselineQuery, engine._index, options);
  const baselineStats = retrievalStats(engine.retriever.stats());
  const run = runEvidence(engine, "search index", { retrievalOptions: options });
  try {
    expect(retrievalRows(run.hits)).toEqual(retrievalRows(baseline));
    expect(retrievalStats(run.retrievalStats)).toEqual(baselineStats);
    expectClean(run);
    expect(run.retrievalStats.stage3A).toBe("applied");
    expect(run.retrievalStats.postingBlocksTotal).toBeGreaterThan(1);
    expect(run.retrievalStats.postingBlocksSkippedUnread).toBeGreaterThan(0);
    expect(run.finalized.counters.postingEntriesObserved).toBe(
      run.retrievalStats.postingEntriesVisited
    );
  } finally {
    releaseEvidence(run);
  }
});

test("overlapping sessions, abort, and sequential reuse do not contaminate slots", async () => {
  const engine = await compiledEngine(targetedDocuments, [
    { key: "tls", aliases: [["transport", "layer", "security"]] },
  ]);
  const pool = new RankingEvidenceSessionPool();
  const [network, tls] = await Promise.all([
    runEvidenceAsync(engine, "network", pool),
    runEvidenceAsync(engine, "tls", pool),
  ]);
  try {
    expectClean(network);
    expectClean(tls);
    expect(network.session).not.toBe(tls.session);
    expect(pool.memory().activeSessions).toBe(2);
  } finally {
    releaseEvidence(network);
    releaseEvidence(tls);
  }
  expect(pool.memory().activeSessions).toBe(0);
  expect(pool.memory().idleSessionBytes).toBeGreaterThan(0);

  const reused = runEvidence(engine, "network", { pool });
  try {
    expectClean(reused);
  } finally {
    releaseEvidence(reused);
  }

  const prepared = prepareEvidence(engine, "network", pool);
  expect(prepared.compiled.eligible).toBe(true);
  const aborted = pool.acquire(prepared.compiled.plan);
  aborted.abort();
  expect(pool.memory().activeSessions).toBe(0);

  const controller = new AbortController();
  controller.abort();
  await expect(
    runEvidenceAsync(engine, "network", pool, {
      ...{
        skipDuplicatePostingLists: true,
        exactBlockSkip: { requiredDepth: 10 },
      },
      signal: controller.signal,
    })
  ).rejects.toThrow();
  expect(pool.memory().activeSessions).toBe(0);

  const abortEngine = await compiledEngine(
    Array.from({ length: 160 }, (_, index) => ({
      id: `abort-${index}`,
      title: "Network Abort Fixture",
      summary: "",
      body: "network",
    }))
  );
  const partial = prepareEvidence(abortEngine, "network", pool);
  expect(partial.compiled.eligible).toBe(true);
  const partialSession = pool.acquire(partial.compiled.plan);
  const midFlight = new AbortController();
  const writeTitle = partialSession.writeTitlePosting.bind(partialSession);
  partialSession.writeTitlePosting = (...args) => {
    writeTitle(...args);
    midFlight.abort();
  };
  expect(() =>
    retrieveWithRankingEvidence(
      abortEngine.retriever,
      partial.query,
      abortEngine._index,
      partialSession,
      {
        skipDuplicatePostingLists: true,
        exactBlockSkip: { requiredDepth: 10 },
        signal: midFlight.signal,
      }
    )
  ).toThrow();
  partialSession.abort();
  expect(pool.memory().activeSessions).toBe(0);
});

test("a second finalization invalidates an earlier finalized view", async () => {
  const engine = await compiledEngine(targetedDocuments);
  const run = runEvidence(engine, "network");
  try {
    expectClean(run);
    expect(run.hits.length).toBeGreaterThan(1);
    const firstView = run.finalized;
    const reversedHits = [...run.hits].reverse();
    const secondView = finalizeRankingEvidence(
      run.session,
      reversedHits,
      run.queryPlan
    );
    expect(() => readRankingEvidenceFactsForTest(firstView, 0)).toThrow(
      "ranking evidence finalized view is no longer live"
    );
    expect(readRankingEvidenceFactsForTest(secondView, 0).ordinal).toBe(
      reversedHits[0].documentOrdinal
    );
  } finally {
    releaseEvidence(run);
  }
});

test("generation wrap and index replacement invalidate pooled mappings safely", async () => {
  const first = await compiledEngine(targetedDocuments, [
    { key: "tls", aliases: [["transport", "layer", "security"]] },
  ]);
  const pool = new RankingEvidenceSessionPool();
  const prepared = prepareEvidence(first, "network", pool);
  expect(prepared.compiled.eligible).toBe(true);
  const wrapping = pool.acquire(prepared.compiled.plan);
  wrapping.generation = 0xffffffff;
  wrapping.release();

  const wrapped = runEvidence(first, "network", { pool });
  try {
    expectClean(wrapped);
    expect(wrapped.session.generation).toBe(1);
  } finally {
    releaseEvidence(wrapped);
  }

  const second = await compiledEngine(
    [...targetedDocuments, { id: "replacement", title: "Network Replacement", body: "" }],
    [{ key: "tls", aliases: [["transport", "layer", "security"]] }]
  );
  const replacement = runEvidence(second, "network", { pool });
  try {
    expectClean(replacement);
    expect(replacement.session.static.index).toBe(second._index);
    expect(replacement.session.static.index).not.toBe(first._index);
  } finally {
    releaseEvidence(replacement);
  }
  expect(pool.memory().activeSessions).toBe(0);
});

test("deferred short-literal and dotted-version shapes fail closed", async () => {
  const engine = await compiledEngine(targetedDocuments, [
    { key: "tls", aliases: [["transport", "layer", "security"]] },
  ]);
  const dotted = runEvidence(engine, "tls 1.2");
  const short = runEvidence(engine, "n");
  expect(dotted.eligible).toBe(false);
  expect(dotted.reason).toBe("version-number-dotted");
  expect(short.eligible).toBe(false);
  expect(short.reason).toBe("short-literal");
});
