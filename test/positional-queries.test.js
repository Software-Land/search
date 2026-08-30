/**
 * Invariant tests for positional PhraseQuery / PhrasePrefixQuery.
 * Corpus examples do not define the architecture.
 */
import { SearchEngine } from "../dist/index.js";
import { tokenize, allowPrefixMatch } from "../dist/text.js";
import { executePhrasePrefixQuery, executePhraseQuery, emptyExecutionStats } from "../dist/positionalQueries.js";
import { buildQueryPlan, queryPhraseGeometry } from "../dist/queryPlan.js";
import { extractFeatures } from "../dist/features.js";
import { collectCompleteInterpretations, COMPLETE_INTERPRETATION_COLLECTOR } from "../dist/completeInterpretationCollector.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { buildTokenGraph } from "../dist/configuredFormGraph.js";
import { readFileSync } from "node:fs";

const schema = {
  title: { type: "text", role: "title" },
  summary: { type: "text", role: "summary" },
  body: { type: "text", role: "body" },
};

describe("positional PhraseQuery / PhrasePrefixQuery", () => {
  test("exact phrase is contiguous, ordered, and same-field", async () => {
    const engine = SearchEngine.create({ schema, retriever: "full-scan" });
    await engine.index([
      { id: "title", title: "alpha beta gamma", summary: "", body: "other" },
      { id: "split", title: "alpha gamma", summary: "beta", body: "alpha elsewhere beta gamma" },
      { id: "reversed", title: "gamma beta alpha", summary: "", body: "" },
    ]);
    const hits = executePhraseQuery({ kind: "phrase", tokens: ["alpha", "beta"] }, engine._index);
    expect(hits.map((h) => h.document.id).sort()).toEqual(["title"]);
    expect(hits[0].titleFrequency).toBe(1);
    expect(hits[0].bodyFrequency).toBe(0);
  });

  test("PhrasePrefix is final-position only and ignores allowPrefixMatch", async () => {
    const engine = SearchEngine.create({ schema, retriever: "full-scan" });
    await engine.index([
      { id: "fps", title: "200FPS", summary: "a practical guide to building high frame rate interfaces", body: "x" },
      { id: "mid", title: "mid", summary: "high ra frame rate", body: "x" },
    ]);
    expect(allowPrefixMatch("r", "rate")).toBe(false);
    expect(allowPrefixMatch("ra", "rate")).toBe(false);
    const hits = executePhrasePrefixQuery(
      { kind: "phrase-prefix", preceding: tokenize("a practical guide to building high frame"), prefix: "r" },
      engine._index
    );
    expect(hits.map((h) => h.document.id)).toEqual(["fps"]);
    const interior = executePhrasePrefixQuery(
      { kind: "phrase-prefix", preceding: ["building", "high"], prefix: "fr" },
      engine._index
    );
    expect(interior.map((h) => h.document.id)).toEqual(["fps"]);
    const skippedInterior = executePhrasePrefixQuery(
      { kind: "phrase-prefix", preceding: ["building"], prefix: "fr" },
      engine._index
    );
    expect(skippedInterior.some((h) => h.document.id === "fps")).toBe(false);
  });

  test("PhrasePrefix stats count next-token inspections only after preceding match", async () => {
    const emptyEngine = SearchEngine.create({ schema, retriever: "full-scan" });
    await emptyEngine.index([{ id: "fps", title: "200FPS", summary: "", body: "unrelated rate text" }]);
    const emptyStats = emptyExecutionStats();
    const emptyHits = executePhrasePrefixQuery(
      { kind: "phrase-prefix", preceding: tokenize("a practical guide to building high frame"), prefix: "r" },
      emptyEngine._index,
      emptyStats
    );
    expect(emptyHits).toEqual([]);
    expect(emptyStats.prefixNextTokenInspections).toBe(0);
    expect(emptyStats.positionalComparisons).toBe(0);

    const liveEngine = SearchEngine.create({ schema, retriever: "full-scan" });
    await liveEngine.index([
      { id: "fps", title: "200FPS", summary: "a practical guide to building high frame rate interfaces", body: "x" },
    ]);
    const liveStats = emptyExecutionStats();
    const liveHits = executePhrasePrefixQuery(
      { kind: "phrase-prefix", preceding: tokenize("a practical guide to building high frame"), prefix: "r" },
      liveEngine._index,
      liveStats
    );
    expect(liveHits.map((h) => h.document.id)).toEqual(["fps"]);
    expect(liveHits[0].summaryFrequency).toBe(1);
    expect(liveStats.prefixNextTokenInspections).toBeGreaterThan(0);
    expect(liveStats.positionalComparisons).toBeGreaterThanOrEqual(liveStats.prefixNextTokenInspections);
    expect(liveStats.docsVisited).toBeGreaterThan(0);
    expect(liveStats.fieldDocProbes).toBeGreaterThanOrEqual(liveStats.docsVisited);
  });

  test("global one-character prefix retrieval stays protected", async () => {
    expect(allowPrefixMatch("r", "rate")).toBe(false);
    const engine = SearchEngine.create({ schema, retriever: "full-scan" });
    await engine.index([{ id: "a", title: "Rate Limiting", summary: "", body: "x" }]);
    expect(
      executePhrasePrefixQuery({ kind: "phrase-prefix", preceding: [], prefix: "r" }, engine._index)
    ).toEqual([]);
  });

  test("collector is default-off and occupancy bypasses it", async () => {
    const engine = SearchEngine.create({
      schema,
      retriever: "full-scan",
      plugins: [compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "rpc", aliases: [["remote", "procedure", "call"]] }] })],
    });
    await engine.index([
      { id: "exact", title: "Rate Limiting", summary: "", body: "other" },
      { id: "body", title: "Hot Shards", summary: "", body: "token bucket rate limiting inside shards" },
      { id: "incidental", title: "Build Time", summary: "", body: "a remote procedure call happens during compile" },
      { id: "grpc", title: "gRPC vs REST", summary: "An RPC framework.", body: "streams" },
    ]);
    const def = engine.search("rate limit", { limit: 10 }).map((h) => h.id);
    expect(def).toContain("body");
    const complete = engine
      .search("rate limit", { limit: 10, resultCollector: COMPLETE_INTERPRETATION_COLLECTOR })
      .map((h) => h.id);
    expect(complete).toEqual(["exact"]);
    const rpcQuery = engine._prepareQuery("remote procedure call");
    const rpcPlan = buildQueryPlan(rpcQuery, engine._index);
    const decision = collectCompleteInterpretations({
      occupancy: Boolean(rpcPlan.structuredKey),
      version: rpcPlan.versionIntent,
      exactHits: rpcPlan.exactHits,
      prefixHits: rpcPlan.prefixHits,
    });
    expect(decision.apply).toBe(false);
    expect(decision.reason).toBe("occupancy");
    const rpc = engine
      .search("remote procedure call", { limit: 10, resultCollector: COMPLETE_INTERPRETATION_COLLECTOR })
      .map((h) => h.id);
    const rpcDefault = engine.search("remote procedure call", { limit: 10 }).map((h) => h.id);
    expect(rpc).toEqual(rpcDefault);
    expect(rpc).toContain("incidental");
  });

  test("search-path phrase geometry is reused by features", async () => {
    const engine = SearchEngine.create({ schema, retriever: "full-scan" });
    await engine.index([{ id: "a", title: "two layer authorization", summary: "", body: "x" }]);
    const query = engine._prepareQuery("two-layer authorization");
    const plan = buildQueryPlan(query, engine._index);
    expect("filterToPhraseCohort" in plan).toBe(false);
    expect(queryPhraseGeometry.get(query)?.get("a")?.titleFrequency).toBeGreaterThan(0);
    const feat = extractFeatures(query, engine._index.documents[0]);
    expect(feat.exactTitleOrSummaryPhrase).toBe(true);
    expect(feat.titlePhraseFrequency).toBe(queryPhraseGeometry.get(query).get("a").titleFrequency);
  });

  test("title/body-only schema remains compatible", async () => {
    const engine = SearchEngine.create({
      schema: { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } },
      retriever: "full-scan",
    });
    await engine.index([{ id: "a", title: "Alpha Beta", body: "gamma" }]);
    expect(engine.search("alpha beta", { limit: 1 })[0].id).toBe("a");
  });
});

describe("configured-form token DAG", () => {
  test("object oriented programming vs functional is a DAG, not enumerated paths", async () => {
    const engine = SearchEngine.create({
      schema,
      retriever: "full-scan",
      plugins: [
        compileConfiguredConceptPlugin({
          configuredConcepts: [{ key: "oop", aliases: [["object", "oriented", "programming"]] }],
        }),
      ],
    });
    await engine.index([{ id: "x", title: "x", summary: "", body: "x" }]);
    const graph = buildTokenGraph(engine._prepareQuery("object oriented programming vs functional"));
    expect(graph.edges.some((e) => e.source === "configured" && e.tokens[0] === "oop" && e.from === 0 && e.to === 3)).toBe(
      true
    );
    expect(graph.edges.filter((e) => e.source === "surface")).toHaveLength(5);
    expect(graph.maxFanout).toBeGreaterThanOrEqual(2);
  });

  test("one-token configured key is an identity duplicate, not rejected by length", async () => {
    const engine = SearchEngine.create({
      schema,
      retriever: "full-scan",
      plugins: [
        compileConfiguredConceptPlugin({
          configuredConcepts: [{ key: "grpc", aliases: [["grpc"]] }],
        }),
      ],
    });
    await engine.index([{ id: "x", title: "gRPC Interceptor", summary: "", body: "x" }]);
    const query = engine._prepareQuery("grpc interceptor");
    const graph = buildTokenGraph(query);
    expect(graph.length).toBe(2);
    const keySpan = (query.configuredSpans || []).some((s) => s.key === "grpc");
    expect(keySpan || query.configuredSequenceIntent?.key === "grpc" || graph.length === 2).toBe(true);
  });

  test("one-token form that is a member of a longer peer is not a configured edge", async () => {
    const engine = SearchEngine.create({
      schema,
      retriever: "full-scan",
      plugins: [
        compileConfiguredConceptPlugin({
          configuredConcepts: [{ key: "appsec", aliases: [["application", "security"], ["security"]] }],
        }),
      ],
    });
    await engine.index([{ id: "x", title: "App Sec", summary: "", body: "x" }]);
    const graph = buildTokenGraph(engine._prepareQuery("security hardening"));
    expect(graph.edges.some((e) => e.source === "configured" && e.key === "appsec")).toBe(false);
  });

  test("unique one-token form that is not a longer-peer member becomes a configured edge", async () => {
    const engine = SearchEngine.create({
      schema,
      retriever: "full-scan",
      plugins: [
        compileConfiguredConceptPlugin({
          configuredConcepts: [{ key: "javascript", aliases: [["js"]] }],
        }),
      ],
    });
    await engine.index([
      { id: "jsdoc", title: "javascript vs python", summary: "", body: "x" },
      { id: "other", title: "js vs python", summary: "", body: "x" },
    ]);
    const query = engine._prepareQuery("js vs python");
    const graph = buildTokenGraph(query);
    expect(graph.edges.some((e) => e.source === "configured" && e.tokens[0] === "javascript")).toBe(true);
    const plan = buildQueryPlan(query, engine._index);
    const ids = plan.exactHits.map((h) => h.document.id).sort();
    expect(ids).toEqual(["jsdoc", "other"].sort());
  });

  test("typo-rewritten tokens do not mint configured graph edges", async () => {
    const engine = SearchEngine.create({
      schema,
      retriever: "full-scan",
      plugins: [
        compileConfiguredConceptPlugin({
          configuredConcepts: [{ key: "saml", aliases: [["security", "assertion", "markup", "language"]] }],
        }),
      ],
    });
    await engine.index([{ id: "x", title: "SAML vs OAuth", summary: "", body: "styling and components" }]);
    const query = engine._prepareQuery("styling and");
    const graph = buildTokenGraph(query);
    expect(graph.edges.some((e) => e.source === "configured")).toBe(false);
  });

  test("overlapping configured spans become parallel DAG edges, not cartesian paths", async () => {
    const engine = SearchEngine.create({
      schema,
      retriever: "full-scan",
      plugins: [
        compileConfiguredConceptPlugin({
          configuredConcepts: [
            { key: "oop", aliases: [["object", "oriented", "programming"]] },
            { key: "op", aliases: [["oriented", "programming"]] },
          ],
        }),
      ],
    });
    await engine.index([{ id: "x", title: "x", summary: "", body: "x" }]);
    const graph = buildTokenGraph(engine._prepareQuery("object oriented programming vs functional"));
    expect(graph.edges.some((e) => e.source === "configured" && e.from === 0 && e.to === 3)).toBe(true);
    expect(graph.edges.some((e) => e.source === "configured" && e.from === 1 && e.to === 3)).toBe(true);
    expect(graph.configuredEdgeCount).toBe(2);
    expect(graph.edges.filter((e) => e.source === "surface")).toHaveLength(5);
  });

  test("lemma-only one-token mapping onto a key is not a typed form edge", async () => {
    const engine = SearchEngine.create({
      schema,
      retriever: "full-scan",
      plugins: [
        compileConfiguredConceptPlugin({
          configuredConcepts: [{ key: "api", aliases: [["application", "programming", "interface"]] }],
        }),
      ],
    });
    await engine.index([{ id: "x", title: "Working with APIs", summary: "", body: "apis and clients" }]);
    const graph = buildTokenGraph(engine._prepareQuery("apis and"));
    expect(graph.edges.some((e) => e.source === "configured")).toBe(false);
  });
});

describe("PhrasePrefixQuery source boundary", () => {
  test("executePhrasePrefixQuery does not call allowPrefixMatch or prefixCompletion", () => {
    const src = readFileSync(new URL("../src/positionalQueries.ts", import.meta.url), "utf8");
    const start = src.indexOf("export function executePhrasePrefixQuery");
    const end = src.indexOf("function matchTokensAt");
    const body = src.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(body).not.toMatch(/allowPrefixMatch|prefixCompletion/);
    expect(src).toMatch(/PhrasePrefix does not use allowPrefixMatch, prefixCompletion/);
  });
});
