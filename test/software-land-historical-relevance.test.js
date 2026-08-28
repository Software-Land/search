/**
 * Software.Land historical expectedTop / titlePrefix relevance contracts.
 * Fixture-only. Not Core default ranking policy.
 * Separate from query-result-oracle.json exact-output identity.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { compileRelationshipMap } from "../dist/relationshipMap.js";
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
      expectedTop: ["Load vs Stress Testing", "Testing in Software Engineering"],
      topN: 2,
    });
    expect(
      evaluateHistoricalRelevance(row, [
        "Testing in Software Engineering",
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
    expect(q?.topicalRecall).toEqual({ key: "appsec", forms: APPSEC_TOPICAL });
  });

  test("what is an app sec activates wrapped exact topicalRecall", () => {
    const detailed = engine.searchDetailed("what is an app sec", { limit: 10, explain: true });
    const q = detailed.results[0]?.explanation?.query;
    expect(detailed.results[0]?.title).toBe("App Sec");
    expect(q?.configuredSequenceIntent ?? null).toBeNull();
    expect(q?.topicalRecall).toEqual({ key: "appsec", forms: APPSEC_TOPICAL });
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
    expect(relevanceConfig.softwareLandCommit).toBe("7628a85166781d4ab42f60646e2f66da5f336eaa");
    expect(relevanceConfig.synonymMapKind).toBe("explicit-directional-curated-plus-generated");
    expect(omitKeys.has("testing")).toBe(true);
    expect(configuredConcepts.some((entry) => entry.key === "testing")).toBe(false);
    expect(loadSoftwareLandJson("configured-concepts.json").some((entry) => entry.key === "testing")).toBe(true);
    expect(loadSoftwareLandJson("configured-concepts.json").some((entry) => entry.key === "fps")).toBe(true);
    expect(configuredConcepts.find((entry) => entry.key === "fps")?.aliases).toEqual([["frames", "per", "second"]]);
    const frozenAppsec = loadSoftwareLandJson("configured-concepts.json").find((entry) => entry.key === "appsec");
    expect(frozenAppsec.aliases[0]).toEqual(["application", "security"]);
    expect(frozenAppsec.aliases).toEqual(expect.arrayContaining([["security"]]));
    expect(frozenAppsec.expansion).toBeUndefined();
    expect(frozenAppsec.primary).toBeUndefined();
    expect(frozenAppsec.topicalRecall).toBeUndefined();
    expect(frozenAppsec.standaloneRecall).toBeUndefined();
    const frozenNist = loadSoftwareLandJson("configured-concepts.json").find((entry) => entry.key === "nist");
    expect(frozenNist.aliases).toEqual([["national", "institute", "standards", "technology"]]);
    const nist = configuredConcepts.find((entry) => entry.key === "nist");
    expect(nist.aliases).toEqual([
      ["national", "institute", "standards", "technology"],
      ["institute"],
      ["institute", "standards"],
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
    ]);
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
    expect(titles.indexOf("Monotonic Stack")).toBeGreaterThan(titles.indexOf("React Performance Optimization"));
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

  test("API relationship neighborhood keeps Interface and Class vs Interface", () => {
    const whatIs = engine.search("what is an api", { limit: 6 }).map((hit) => hit.title);
    const whatAre = engine.search("what are apis", { limit: 6 }).map((hit) => hit.title);
    expect(whatIs.slice(0, 5)).toEqual([
      "What is an API?",
      "REST API vs GraphQL",
      "Working with APIs",
      "What is an Interface?",
      "Class vs Interface",
    ]);
    expect(whatAre.slice(0, 5)).toEqual([
      "What is an API?",
      "Working with APIs",
      "REST API vs GraphQL",
      "What is an Interface?",
      "Class vs Interface",
    ]);
  });

  test("dfs neighborhood keeps Minmax Tree in the accepted window", () => {
    const dfs = engine.search("dfs", { limit: 6 }).map((hit) => hit.title);
    const depth = engine.search("depth first search", { limit: 6 }).map((hit) => hit.title);
    expect(dfs[0]).toBe("DFS Backtracking");
    expect(dfs.slice(0, 6)).toContain("Minmax Tree");
    expect(depth[0]).toBe("DFS Backtracking");
    expect(depth.slice(0, 6)).toContain("Minmax Tree");
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
