/**
 * Software.Land historical expectedTop / titlePrefix relevance contracts.
 * Fixture-only. Not Core default ranking policy.
 * Separate from query-result-oracle.json exact-output identity.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { packedSearchFallbackReason } from "../dist/ranking/evidence/rankingEvidenceSearch.js";
import { assertExportedScenario } from "./helpers/scenario-assertions.js";
import { compileRelationshipMap } from "../dist/relationships/relationshipMap.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import {
  evaluateHistoricalRelevance,
  formatHistoricalRelevanceFailure,
  isHistoricalRelevanceApplicable,
} from "./historical-relevance.js";
import { loadSoftwareLandJson, loadSoftwareLandRelevanceInputs } from "./helpers/software-land-fixture.js";

const {
  documents,
  configuredConcepts,
  lemmas,
  relationshipMap,
  relationships,
  lexicalFrequency,
  historical,
  applicable,
  relevanceConfig,
  schema,
} = loadSoftwareLandRelevanceInputs();
const synonymFixture = loadSoftwareLandJson("synonym-map.json");
const omitKeys = new Set(relevanceConfig.omitConfiguredConceptKeys || []);
const recorded = [];
const APPSEC_TOPICAL = [
  ["authentication"],
  ["authorization"],
  ["rbac"],
  ["saml"],
  ["oauth"],
  ["bearer", "token"],
  ["vulnerability"],
  ["signed", "cookies"],
  ["security"],
];
const APPSEC_QUERY_TOPICAL = [
  ["authentication"],
  ["authorization"],
  ["rbac"],
  ["role", "based", "access", "control"],
  ["saml"],
  ["security", "assertion", "markup", "language"],
  ["oauth"],
  ["open", "authorization"],
  ["bearer", "token"],
  ["vulnerability"],
  ["signed", "cookies"],
  ["security"],
];

function createRelevanceEngine() {
  const compiled = compileAuthoredRelevance({ configuredConcepts: configuredConcepts,
    relationshipMap,
  });
  return SearchEngine.create({
    schema,
    plugins: [
      morphology({ lemmas }),
      ...compiled.plugins,
    ],
    documentRelationships: relationships,
    relationshipStrategy: "hybrid",
    retriever: "full-scan",
  });
}

describe("Software.Land historical relevance contracts", () => {
  let engine;

  beforeAll(async () => {
    engine = createRelevanceEngine();
    await engine.index(attachLexicalFrequency(documents, lexicalFrequency));
  });

  afterAll(() => {
    const failed = recorded.filter((row) => !row.ok);
    const uniqueFailing = [...new Set(failed.map((row) => row.query))];
    const kinds = {};
    for (const row of failed) {
      for (const kind of row.kinds.length ? row.kinds : ["unclassified"]) {
        kinds[kind] = (kinds[kind] || 0) + 1;
      }
    }
    // Compact aggregate. Individual test.each failures remain the source of truth.
    console.log(
      [
        "historical relevance:",
        `  ${recorded.filter((row) => row.ok).length} / ${recorded.length} pass`,
        `  ${failed.length} fail`,
        `  ${uniqueFailing.length} unique failing queries`,
        `  kinds ${JSON.stringify(kinds)}`,
      ].join("\n")
    );
  });

  test("quality ass membership-within-topN does not require expectedTop array order", () => {
    const row = historical.rows.find((item) => item.query === "quality ass");
    expect(row.v1).toEqual({
      expectedTop: ["Load vs Stress Testing"],
      topN: 2,
    });
    expect(
      evaluateHistoricalRelevance(row, [
        "What is an API?",
        "Load vs Stress Testing",
      ]).ok
    ).toBe(true);
  });

  test("expectedTop requires normalized title identity, not substring", () => {
    const row = {
      query: "sharde",
      index: 0,
      v1: { expectedTop: ["Sharding"], topN: 5 },
    };
    expect(
      evaluateHistoricalRelevance(row, [
        "Advanced Sharding Guide",
        "Hot Shards",
        "Throughput vs Latency",
        "CockroachDB vs Postgres",
        "SQL vs NoSQL",
      ]).ok
    ).toBe(false);
    expect(
      evaluateHistoricalRelevance(row, [
        "Sharding",
        "Hot Shards",
        "Throughput vs Latency",
        "CockroachDB vs Postgres",
        "SQL vs NoSQL",
      ]).ok
    ).toBe(true);
    expect(
      evaluateHistoricalRelevance(row, [
        "  SHARDING  ",
        "Hot Shards",
        "Throughput vs Latency",
        "CockroachDB vs Postgres",
        "SQL vs NoSQL",
      ]).ok
    ).toBe(true);
  });

  test("query 12 historical contract is TLS 1.2 Vulnerability #1", () => {
    const row = historical.rows.find((item) => item.query === "12");
    expect(row.historicalRelevance).toBe(true);
    expect(row.v1).toEqual({
      expectedTop: ["TLS 1.2 Vulnerability"],
      topN: 1,
    });
    expect(row.intent.requiredPrimary).toEqual(["TLS 1.2 Vulnerability"]);
    expect(evaluateHistoricalRelevance(row, ["TLS 1.2 Vulnerability"]).ok).toBe(true);
    expect(
      evaluateHistoricalRelevance(row, [
        "200FPS: CSS vs Canvas vs WebGL vs WebGPU",
        "TLS 1.2 Vulnerability",
      ]).ok
    ).toBe(false);
  });

  test("appsec uses topicalRecall for neighbors and only oath as synonym recall", () => {
    const detailed = engine.searchDetailed("appsec", { limit: documents.length, explain: true });
    const q = detailed.results[0]?.explanation?.query;
    expect(detailed.results[0]?.title).toBe("App Sec");
    expect(q?.configuredSequenceIntent?.key).toBe("appsec");
    expect(q?.equivalentRecall).toEqual([{ source: "appsec", target: "oath" }]);
    expect(q?.topicalRecall).toEqual({ key: "appsec", forms: APPSEC_QUERY_TOPICAL, primaryForms: [] });
  });

  test("security supplies topical title evidence without direct coverage or equivalence", async () => {
    const previousMap = structuredClone(relationshipMap);
    previousMap.appsec = previousMap.appsec.filter((edge) => edge.to?.form !== "security");
    const compiled = compileAuthoredRelevance({ configuredConcepts, relationshipMap: previousMap });
    const previous = SearchEngine.create({
      schema,
      plugins: [morphology({ lemmas }), ...compiled.plugins],
      documentRelationships: relationships,
      relationshipStrategy: "hybrid",
      retriever: "full-scan",
    });
    const indexedCompiled = compileAuthoredRelevance({ configuredConcepts, relationshipMap });
    const indexed = SearchEngine.create({
      schema,
      plugins: [morphology({ lemmas }), ...indexedCompiled.plugins],
      documentRelationships: relationships,
      relationshipStrategy: "hybrid",
      retriever: "indexed",
    });
    const indexedDocuments = attachLexicalFrequency(documents, lexicalFrequency);
    await previous.index(indexedDocuments);
    await indexed.index(indexedDocuments);

    const order = {
      query: "appsec",
      exactFirst: "App Sec",
      requiredAnyTop: {
        titles: ["RBAC (Role Based Access Control)", "Authorization Middleware"],
        topN: 10,
      },
      requiredWithin: [{ title: "Zero-Trust Security", topN: 3 }],
      precedes: [{
        earlier: "Zero-Trust Security",
        later: "Working with Llama.cpp Embeddings",
        topN: 10,
        whenLaterVisible: true,
      }],
    };
    const previousHits = previous.search("appsec", { limit: 10, relatedLimit: 0 });
    const currentHits = engine.search("appsec", { limit: 10, relatedLimit: 0 });
    expect(() => assertExportedScenario(previousHits, order)).toThrow(
      /Missing required article "Zero-Trust Security" within the top 3/
    );
    const fourth = currentHits.filter((hit) => hit.title !== "Zero-Trust Security");
    fourth.splice(3, 0, currentHits.find((hit) => hit.title === "Zero-Trust Security"));
    expect(fourth[3].title).toBe("Zero-Trust Security");
    expect(fourth.map((hit) => hit.title)).toContain("Zero-Trust Security");
    expect(() => assertExportedScenario(fourth, order)).toThrow(
      /Missing required article "Zero-Trust Security" within the top 3/
    );
    expect(() => assertExportedScenario(currentHits, order)).not.toThrow();
    expect(currentHits[0].title).toBe("App Sec");
    expect(currentHits.map((hit) => hit.title)).not.toEqual(previousHits.map((hit) => hit.title));

    for (const query of ["security", "dfs", "ml"]) {
      expect(engine.search(query, { limit: 10, relatedLimit: 0 }).map((hit) => hit.title)).toEqual(
        previous.search(query, { limit: 10, relatedLimit: 0 }).map((hit) => hit.title)
      );
    }

    const detailed = engine.searchDetailed("appsec", {
      limit: 15,
      explain: true,
      resultCollector: "complete-interpretation",
    });
    const zero = detailed.results.find((hit) => hit.title === "Zero-Trust Security");
    expect(zero.features.topicalRecallTitleMatch).toBe(true);
    expect(zero.features.topicalPrimaryTitleMatch).toBe(false);
    expect(zero.features.directClass).toBe("none");
    expect(zero.features.queryCoverage).toBe(0);
    expect(zero.features.titleCoverage).toBe(0);
    expect(zero.features.bodyLexicalMatch).toBe(0);
    expect(zero.features.directBodyOccurrenceCount).toBe(0);
    expect(zero.features.equivalentRecallMatch).toBeFalsy();
    expect(zero.relevanceKind).toBe("related");
    expect(detailed.results[0].explanation.query.equivalentRecall).toEqual([{ source: "appsec", target: "oath" }]);
    expect(detailed.meta.rankingEvidence).not.toBe("packed");

    const analyzed = indexed._prepareQuery("appsec");
    const gate = {
      exactDiagnostics: false,
      pruningMode: "auto",
      retrievalScoreWeight: indexed.retrievalScoreWeight,
      sourcePolicy: "top1-strong",
      query: analyzed,
      index: indexed._index,
    };
    expect(packedSearchFallbackReason({
      ...gate,
      retriever: engine.retriever,
      opts: { resultCollector: "complete-interpretation" },
    })).toBe("complete-interpretation");
    expect(packedSearchFallbackReason({
      ...gate,
      retriever: engine.retriever,
      opts: {},
    })).toBe("unsupported-retriever");
    expect(packedSearchFallbackReason({
      ...gate,
      retriever: indexed.retriever,
      opts: {},
    })).toBe("topical-recall");

    const packedLibrary = indexed.search("library", { limit: 10, relatedLimit: 0 });
    expect(indexed.lastSearchMeta.rankingEvidence).toBe("packed");
    const detailedLibrary = indexed.searchDetailed("library", { limit: 10, relatedLimit: 0, explain: true });
    expect(detailedLibrary.meta.rankingEvidence).not.toBe("packed");
    expect(detailedLibrary.results.map((hit) => hit.id)).toEqual(packedLibrary.map((hit) => hit.id));

    for (const query of ["appsec", "app sec", "application security", "application se", "aplicationsecurity"]) {
      const live = engine.search(query, {
        limit: 10,
        relatedLimit: 0,
        resultCollector: "complete-interpretation",
      });
      expect(engine.lastSearchMeta.rankingEvidence).not.toBe("packed");
      const explained = engine.searchDetailed(query, {
        limit: 10,
        explain: true,
        resultCollector: "complete-interpretation",
      });
      expect(explained.results.map((hit) => hit.id)).toEqual(live.map((hit) => hit.id));
      expect(indexed.search(query, { limit: 10, relatedLimit: 0 }).map((hit) => hit.id)).toEqual(
        live.map((hit) => hit.id)
      );
    }
  });

  test("what is an app sec activates wrapped exact topicalRecall", () => {
    const detailed = engine.searchDetailed("what is an app sec", { limit: 10, explain: true });
    const q = detailed.results[0]?.explanation?.query;
    expect(detailed.results[0]?.title).toBe("App Sec");
    expect(q?.configuredSequenceIntent ?? null).toBeNull();
    expect(q?.topicalRecall).toEqual({ key: "appsec", forms: APPSEC_QUERY_TOPICAL, primaryForms: [] });
  });

  test("what is an applicatio security stays bounded prefix without topicalRecall", () => {
    const detailed = engine.searchDetailed("what is an applicatio security", { limit: 10, explain: true });
    const q = detailed.results[0]?.explanation?.query;
    expect(detailed.results[0]?.title).toBe("App Sec");
    expect(q?.configuredSequenceIntent ?? null).toBeNull();
    expect(q?.configuredPrefixSpans).toEqual([expect.objectContaining({ key: "appsec", usedPrefix: true })]);
    expect(q?.topicalRecall ?? null).toBeNull();
    expect(detailed.results.every((hit) => !(hit.retrievalSources || []).includes("topical-recall"))).toBe(true);
  });

  test("fixture models current Software.Land 0.5 curated synonym and AppSec topical configuration", () => {
    expect(relevanceConfig.softwareLandCommit).toBe("acf8fbf24bf417af6639838f07ec2246d35c0ed9");
    expect(relevanceConfig.synonymMapKind).toBe("explicit-directional-curated-plus-generated");
    expect(omitKeys.has("testing")).toBe(true);
    expect(configuredConcepts.some((entry) => entry.key === "testing")).toBe(false);
    expect(loadSoftwareLandJson("configured-concepts.json").some((entry) => entry.key === "testing")).toBe(false);
    expect(loadSoftwareLandJson("configured-concepts.json").some((entry) => entry.key === "fps")).toBe(true);
    expect(configuredConcepts.find((entry) => entry.key === "fps")?.aliases).toEqual([["frames", "per", "second"]]);
    const frozenAppsec = loadSoftwareLandJson("configured-concepts.json").find((entry) => entry.key === "appsec");
    expect(frozenAppsec.aliases[0]).toEqual(["application", "security"]);
    expect(frozenAppsec.aliases).not.toEqual(expect.arrayContaining([["security"]]));
    expect(frozenAppsec.expansion).toBeUndefined();
    expect(frozenAppsec.primary).toBeUndefined();
    expect(frozenAppsec.topicalRecall).toBeUndefined();
    expect(frozenAppsec.standaloneRecall).toBeUndefined();
    const frozenNist = loadSoftwareLandJson("configured-concepts.json").find((entry) => entry.key === "nist");
    expect(frozenNist.aliases).toEqual([
      ["national", "institute", "standards", "technology"],
      ["institute", "standards"],
      ["institute", "of", "standards"],
    ]);
    const nist = configuredConcepts.find((entry) => entry.key === "nist");
    expect(nist.aliases).toEqual([
      ["national", "institute", "standards", "technology"],
      ["institute", "standards"],
      ["institute", "of", "standards"],
    ]);
    const gatech = configuredConcepts.find((entry) => entry.key === "gatech");
    expect(gatech.aliases).toEqual([["georgia", "institute", "of", "technology"]]);
    const appsec = configuredConcepts.find((entry) => entry.key === "appsec");
    expect(appsec.aliases).toEqual([
      ["application", "security"],
      ["app", "sec"],
      ["app", "security"],
      ["application", "sec"],
    ]);
    expect(appsec.topicalRecall).toBeUndefined();
    expect(relevanceConfig.relationshipMapFile).toBe("relationship-map.json");
    expect(relationshipMap.appsec.filter((edge) => edge.kind === "related").map((edge) => edge.to.form)).toEqual([
      "authentication",
      "authorization",
      "rbac",
      "saml",
      "oauth",
      ["bearer", "token"],
      "vulnerability",
      ["signed", "cookies"],
      "security",
    ]);
    expect(relationshipMap.appsec.find((edge) => edge.to.form === "security")).toEqual({
      kind: "related",
      to: { form: "security" },
    });
    expect(relationshipMap.appsec.some((edge) => edge.primaryTerm === true)).toBe(false);
    const compiled = compileAuthoredRelevance({ configuredConcepts: configuredConcepts, relationshipMap });
    const plugin = compiled.plugins.find((plugin) => plugin.name === "configured-concepts");
    expect(plugin.topicalRecallByKey.get("appsec")).toEqual(APPSEC_TOPICAL);
    const map = compileRelationshipMap(relationshipMap, { concepts: configuredConcepts });
    expect(map.synonymMap.appsec).toEqual(["oath"]);
    expect(map.synonymMap.qa).toEqual(["testing"]);
    expect(synonymFixture.softwareLandCommit).toBe("db5a070dbc6ac112dfae403f38fdfd0fffbedbf6");
    expect(synonymFixture.stats).toEqual({ sources: 119, edges: 146, jsonBytes: 3081 });
    expect(synonymFixture.map.qa).toEqual(["testing"]);
    expect(synonymFixture.map.testing).toBeUndefined();
    expect(synonymFixture.map.appsec).toEqual(["oath"]);
    expect(synonymFixture.map["i o"]).toEqual(["io"]);
    expect(synonymFixture.map["tech debt"]).toBeUndefined();
    expect(synonymFixture.map["ai assisted coding"]).toBeUndefined();
    expect(synonymFixture.map.vpn).toEqual(["tls"]);
    expect(synonymFixture.map.tls).toEqual(["ssl"]);
    expect(synonymFixture.map.tls).not.toEqual(expect.arrayContaining(["vpn"]));
    expect(synonymFixture.map.authentication).toEqual(expect.arrayContaining(["vulnerability"]));
    expect(synonymFixture.map.vulnerability).toEqual(expect.arrayContaining(["authentication"]));
    expect(synonymFixture.map.bearer).toEqual(["token"]);
    expect(synonymFixture.map.token).toBeUndefined();
    expect(synonymFixture.map.rbac).toBeUndefined();
    expect(synonymFixture.map.architecture).toBeUndefined();
    expect(historical.counts.historicalRelevanceApplicable).toBe(214);
    expect(applicable).toHaveLength(214);
    expect(applicable.filter((row) => row.classification === "C")).toHaveLength(0);
    expect(historical.rows.filter((row) => row.classification === "C").map((row) => row.query)).toEqual(["open"]);
    expect(applicable.filter((row) => row.v1?.titlePrefix)).toHaveLength(1);
  });

  test("one-token recursion family ranks lexical neighbors ahead of relationship-only false friends", () => {
    const titles = engine.search("recursion", { limit: 8 }).map((hit) => hit.title);
    expect(titles.slice(0, 5)).toEqual([
      "What is Recursion?",
      "DFS Backtracking",
      "InOrder vs PreOrder vs PostOrder",
      "Dynamic Programming Matrix",
      "React Performance Optimization",
    ]);
    expect(titles).not.toContain("Monotonic Stack");
    for (const query of ["recursing", "recursed", "recursive", "recursiv", "recurssing"]) {
      const window = engine.search(query, { limit: 5 }).map((hit) => hit.title);
      expect(window).toEqual(titles.slice(0, 5));
    }
  });

  test("sort-recursion family ranks full-body two-concept documents in the accepted window", () => {
    for (const query of ["sort recursion", "sort recursing", "sort recurses"]) {
      const titles = engine.search(query, { limit: 8 }).map((hit) => hit.title);
      expect(titles[0]).toBe("What is Recursion?");
      expect(titles[1]).toBe("Topological Sort");
      const window = titles.slice(0, 4);
      expect(window).toContain("React Performance Optimization");
      expect(window).toContain("Dynamic Programming Matrix");
      expect(titles.indexOf("Python Custom Sorting")).toBeGreaterThanOrEqual(4);
    }
  });

  test("API relationship neighborhood keeps Interface ahead of the zero-term Class vs Interface neighbor", () => {
    for (const query of ["what is an api", "what are apis", "application programming interface"]) {
      const detailed = engine.searchDetailed(query, { limit: 30, explain: true });
      const titles = detailed.results.map((hit) => hit.title);
      expect(titles[0]).toBe("What is an API?");
      expect(titles).toContain("What is an Interface?");
      expect(titles).toContain("Class vs Interface");
      const iface = detailed.results.find((hit) => hit.title === "What is an Interface?");
      const neighbor = detailed.results.find((hit) => hit.title === "Class vs Interface");
      expect(iface.relevanceKind).not.toBe("related");
      expect(iface.features.directBodyOccurrenceCount).toBeGreaterThanOrEqual(2);
      expect(neighbor.relevanceKind).toBe("direct");
      expect(neighbor.directClass).toBe("none");
      expect(neighbor.retrievalSources).toEqual(["topical-recall"]);
      expect(neighbor.features.directBodyOccurrenceCount || 0).toBe(0);
      expect(titles.indexOf("What is an Interface?")).toBeLessThan(titles.indexOf("Class vs Interface"));
    }
  });

  test("what is an appli keeps the strong API titles in the top five and gRPC within ten", () => {
    const row = historical.rows.find((item) => item.query === "what is an appli");
    expect(row.v1.expectedTop).toEqual([
      "What is an API?",
      "REST API vs GraphQL",
      "Working with APIs",
    ]);
    expect(row.v1.topN).toBe(5);
    expect(row.v1.within).toEqual([{ title: "gRPC vs REST", topN: 10 }]);
    const titles = engine.search(row.query, { limit: 10 }).map((hit) => hit.title);
    const evaluation = evaluateHistoricalRelevance(row, titles);
    if (!evaluation.ok) throw new Error(formatHistoricalRelevanceFailure(evaluation));
  });

  test("API phrase windows require Class vs Interface from the authored primary-term edge", () => {
    const indexes = [101, 103, 104, 105, 106, 107];
    for (const index of indexes) {
      const row = historical.rows.find((item) => item.index === index);
      expect(row.v1.expectedTop).toEqual([
        "What is an API?",
        "REST API vs GraphQL",
        "Working with APIs",
        "What is an Interface?",
        "Class vs Interface",
      ]);
      expect(row.v1.topN).toBe(6);
      expect(row.v1.within).toBeUndefined();
      const titles = engine.search(row.query, { limit: 10 }).map((hit) => hit.title);
      const evaluation = evaluateHistoricalRelevance(row, titles);
      if (!evaluation.ok) throw new Error(formatHistoricalRelevanceFailure(evaluation));
    }
  });

  test("dfs neighborhood keeps Minmax Tree as a candidate behind repeated direct evidence", () => {
    for (const query of ["dfs", "depth first search"]) {
      const detailed = engine.searchDetailed(query, { limit: 12, explain: true });
      const titles = detailed.results.map((hit) => hit.title);
      expect(titles[0]).toBe("DFS Backtracking");
      const repeated = detailed.results.find((hit) => hit.title === "A-Star Pathfinding");
      const neighbor = detailed.results.find((hit) => hit.title === "Minmax Tree");
      expect(repeated.relevanceKind).not.toBe("related");
      expect(repeated.features.directBodyOccurrenceCount).toBeGreaterThanOrEqual(2);
      expect(neighbor.relevanceKind).toBe("direct");
      expect(neighbor.directClass).toBe("none");
      expect(neighbor.retrievalSources).toEqual(["topical-recall"]);
      expect(neighbor.features.directBodyOccurrenceCount || 0).toBe(0);
      expect(titles.indexOf("A-Star Pathfinding")).toBeLessThan(titles.indexOf("Minmax Tree"));
      const visible = engine.search(query, { limit: 10 }).map((hit) => hit.title);
      expect(visible).toContain("Minmax Tree");
      const row = historical.rows.find((item) => item.query === query);
      expect(row.v1.expectedTop).toEqual([
        "DFS Backtracking",
        "InOrder vs PreOrder vs PostOrder",
        "What is Recursion?",
        "Topological Sort",
        "Maximum Flow Algorithm",
      ]);
      expect(row.v1.topN).toBe(6);
      expect(row.v1.within).toEqual([{ title: "Minmax Tree", topN: 10 }]);
      expect(evaluateHistoricalRelevance(row, visible).ok).toBe(true);
    }
  });

  test("devops relationship neighborhood still ranks CI/CD with DevOps", () => {
    const titles = engine.search("devops", { limit: 6 }).map((hit) => hit.title);
    expect(titles[0]).toBe("What is DevOps?");
    expect(titles).toContain("CI/CD");
    expect(titles.indexOf("CI/CD")).toBeLessThan(titles.indexOf("Build Time"));
  });

  test.each(applicable.map((row) => [row.index, row.query, row]))(
    "row %s query %s historical relevance",
    (_index, _query, row) => {
      const titles = engine.search(row.query, { limit: documents.length }).map((hit) => hit.title);
      const evaluation = evaluateHistoricalRelevance(row, titles);
      recorded.push(evaluation);
      if (!evaluation.ok) {
        throw new Error(formatHistoricalRelevanceFailure(evaluation));
      }
    }
  );
});
