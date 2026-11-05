/**
 * Software.Land fixture integration tests.
 * Fixture configuration and relevance expectations are fixture-specific
 * and do not define the search engine's defaults.
 * Regression cases are compatibility coverage, not Core ranking policy.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import { frozenCorpusScenarioRows } from "./helpers/software-land-fixture.js";
import { assertExportedScenario } from "./helpers/scenario-assertions.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, "fixtures", "software-land");
const SEARCH_LIMIT = 10;

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
}

const documents = loadJson("documents.json");
const configuredConcepts = loadJson("configured-concepts.json");
const lemmas = loadJson("lemmas.json");
const relationshipMap = loadJson("relationship-map.json").map;
const relationships = loadJson("relationships.json");
const lexicalFrequency = loadJson("lexical-frequency.json");
const index = loadJson("scenarios.json");
const contracts = loadJson("strict-contracts.json");
const regressions = loadJson("regression-scenarios.json");
const historical = loadJson("historical-scenarios.json");

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

function createEngine({
  useLemmas = true,
  useDictionary = true,
  useRelationships = true,
  retriever = "full-scan",
} = {}) {
  const compiled = compileAuthoredRelevance({
    configuredConcepts: useDictionary ? configuredConcepts : [],
    relationshipMap: useDictionary && useRelationships ? relationshipMap : undefined,
  });
  return SearchEngine.create({
    schema,
    plugins: [
      morphology(useLemmas ? { lemmas } : {}),
      ...compiled.plugins,
    ],
    documentRelationships: useRelationships ? relationships : undefined,
    relationshipStrategy: useRelationships ? "hybrid" : undefined,
    retriever,
  });
}

async function indexEngine(engine, { useLexicalFrequency = true } = {}) {
  const indexed = useLexicalFrequency ? attachLexicalFrequency(documents, lexicalFrequency) : documents;
  await engine.index(indexed);
  return engine;
}

function titlesOf(engine, query, limit = SEARCH_LIMIT) {
  return engine.search(query, { limit }).map((hit) => hit.title);
}

function expectedTargetTitles(row) {
  const titles = new Set();
  if (row.exactFirst) titles.add(row.exactFirst);
  for (const req of row.requiredWithin || []) titles.add(req.title);
  for (const req of row.requiredAnyWithin || []) titles.add(req.title);
  if (row.requiredAnyTop) {
    for (const title of row.requiredAnyTop.titles) titles.add(title);
  }
  if (row.mustNotDominate?.primary) titles.add(row.mustNotDominate.primary);
  for (const pair of row.precedes || []) {
    titles.add(pair.earlier);
    if (pair.whenLaterVisible !== true) titles.add(pair.later);
  }
  for (const doc of row.requiredDocuments || []) titles.add(doc.title);
  if (row.relationship?.title) titles.add(row.relationship.title);
  return [...titles];
}

function measureCandidateSurvival(engine, rows) {
  const missing = [];
  const relatedMiss = [];
  const prefixMiss = [];
  const counts = [];
  for (const row of rows) {
    const detailed = engine.searchDetailed(row.query, { limit: SEARCH_LIMIT });
    const candidateTitles = new Set(detailed.meta.candidateTitles);
    counts.push(
      detailed.meta.representativeSelection?.retained ??
      detailed.meta.candidateCount
    );
    for (const title of expectedTargetTitles(row)) {
      if (!candidateTitles.has(title)) {
        missing.push({ query: row.query, name: row.name, title });
      }
    }
    if (row.requiredRelatedAny) {
      const hit = row.requiredRelatedAny.titles.filter((title) => candidateTitles.has(title)).length;
      if (hit < (row.requiredRelatedAny.minCount || 1)) {
        relatedMiss.push({ query: row.query, name: row.name, hit, need: row.requiredRelatedAny.minCount || 1 });
      }
    }
    if (row.titlePrefix) {
      const prefixed = [...candidateTitles].filter((title) => title.startsWith(row.titlePrefix)).length;
      if (prefixed < 1) {
        prefixMiss.push({ query: row.query, name: row.name, prefixed });
      }
    }
  }
  counts.sort((a, b) => a - b);
  const n = counts.length;
  return {
    n,
    missing,
    relatedMiss,
    prefixMiss,
    survivalRate: n === 0 ? 1 : (n - missing.length) / n,
    minC: counts[0] ?? 0,
    maxC: counts[n - 1] ?? 0,
    p50C: counts[Math.floor(n / 2)] ?? 0,
    meanC: n ? counts.reduce((sum, c) => sum + c, 0) / n : 0,
  };
}

function assertScenarioCase(engine, row) {
  const hits = engine.search(row.query, {
    limit: SEARCH_LIMIT,
    ...(row.resultCollector ? { resultCollector: row.resultCollector } : {}),
  });
  assertExportedScenario(hits, row);
  if (row.ambiguousExactFirstKeys) {
    const prepared = engine._prepareQuery(row.query);
    expect(prepared.configuredSequenceIntent).toBeNull();
    expect(prepared.configuredPrefixRecall ?? null).toBeNull();
    expect(prepared.concepts.some((concept) => concept.kind === "configured-concept")).toBe(false);
    const keys = (prepared.configuredPrefixRecallGroup || []).map((group) => group.key);
    for (const key of row.ambiguousExactFirstKeys) expect(keys).toContain(key);
  }
  if (row.relationship) {
    const detailed = engine.searchDetailed(row.query, { limit: SEARCH_LIMIT, explain: true });
    const hit = detailed.results.find((item) => item.title === row.relationship.title);
    expect(hit).toBeTruthy();
    expect(hit.relevanceKind).toBe(row.relationship.relevanceKind);
    expect(hit.relationship).toEqual(
      expect.objectContaining({
        type: row.relationship.type,
        provenance: row.relationship.provenance,
        sourceTitle: row.relationship.sourceTitle,
      })
    );
    expect(hit.retrievalSources).toContain("relationship");
  }
}

describe("software-land corpus fixture", () => {
  let engine;

  beforeAll(async () => {
    engine = await indexEngine(createEngine());
  });

  test("fixture inventory records documents, removed articles, and scenario coverage", () => {
    expect(documents).toHaveLength(123);
    expect(documents.some((doc) => doc.id === "ag" || doc.id === "I")).toBe(false);
    expect(contracts.cases).toHaveLength(135);
    expect(contracts.overlayCases.map((row) => row.query)).toEqual([
      "binary index",
      "binary index ",
      "binary index t",
      "binary index tr",
      "binary index tre",
      "binary index tree",
      "binary indexed t",
      "binary indexed tree",
    ]);
    expect(contracts.overlayCases.every((row) => row.origin === "overlay")).toBe(true);
    expect(documents.filter((doc) => doc.id === "cm")).toEqual([
      expect.objectContaining({ id: "cm", title: "Fenwick Tree" }),
    ]);
    expect(frozenCorpusScenarioRows(contracts).filter((row) => row.requiredAnyTop?.ids?.includes("cm"))).toHaveLength(
      contracts.overlayCases.length
    );
    expect(regressions.cases).toHaveLength(54);
    expect(regressions.overlayCases).toHaveLength(4);
    expect(historical.rows).toHaveLength(215);
    expect(historical.kind).toBe("historical-relevance-contracts");
    expect(historical.counts.historicalRelevanceApplicable).toBe(214);
    expect(index.counts.executableContracts).toBe(135);
    expect(index.counts.omittedBrowserUiOnly).toBe(3);
    expect(contracts.cases.some((row) => [
      "recent search transitions",
      "binary index typing progression",
      "institute of standards typing progression",
    ].includes(row.query))).toBe(false);
    const sessions = contracts.browserOnly.filter((item) => item.kind === "typing-session" || item.kind === "query-sequence");
    expect(sessions.map((item) => item.label)).toEqual([
      "binary index typing progression",
      "institute of standards typing progression",
      "recent search transitions",
    ]);
    expect(sessions.flatMap((item) => item.steps).some((step) => step.coverage === "browser-input" || step.coverage === "existing-executable-query" || step.coverage === "exported-step-query")).toBe(true);
    expect(sessions.find((item) => item.kind === "query-sequence").steps.filter((step) => step.coverage === "browser-input")).toEqual([
      { query: "q", coverage: "browser-input" },
      { query: "a", coverage: "browser-input" },
      { action: "clear", coverage: "browser-input" },
    ]);
    const ai = contracts.cases.find((row) => row.query === "ai" && row.origin === "v2-contract");
    expect(ai.absentWithin).toEqual({ titles: ["Fenwick Tree"], topN: 10 });
    expect(ai.precedes).toEqual([
      { earlier: "Software.Land's Alignment with Society", later: "LLM Model Conversion Correctness", topN: 10 },
      { earlier: "What is a Knowledge Graph?", later: "LLM Model Conversion Correctness", topN: 10 },
      { earlier: "LLM Model Conversion Correctness", later: "About this Blog", topN: 10 },
    ]);
    const machineLearning = contracts.cases.find((row) => row.query === "machine learning");
    expect(machineLearning.exactFirst).toBeUndefined();
    expect(machineLearning.mustNotDominate).toEqual({
      primary: "Linear vs Logistic Regression",
      titles: ["LinkedIn Learning Review"],
    });
    for (const query of ["institute ", "institute o", "institute of", "institute of s", "institute of standards"]) {
      expect(contracts.cases.find((row) => row.query === query).requiredDocuments).toEqual([
        { id: "ai", title: "TLS 1.2 Vulnerability", topN: 10 },
      ]);
    }
    expect(index.counts.executableRegressions).toBe(54);
    expect(index.counts.sourceScenarioRows).toBe(216);
    expect(index.counts.historicalRows).toBe(215);
    expect(index.counts.omittedOverlayOwned).toBe(1);
    expect(historical.rows.some((row) => row.query === "integ")).toBe(false);
    expect(contracts.cases.some((row) => row.query === "integ")).toBe(false);
    expect(regressions.overlayCases.map((row) => row.query)).toEqual([
      "integ",
      "open",
      "oauth",
      "open authorization",
    ]);
    expect(regressions.overlayCases[0].exactFirst).toBe("Integrity");
    expect(regressions.overlayCases[0].exactFirstId).toBe("cl");
    const open = regressions.overlayCases.find((row) => row.query === "open");
    expect(open.exactFirst).toBeUndefined();
    expect(open.requiredWithin).toEqual([{ id: "7", title: "SAML vs OAuth", topN: SEARCH_LIMIT }]);
    expect(open.ambiguousExactFirstKeys).toEqual(expect.arrayContaining(["opengl", "opengles"]));
    expect(configuredConcepts.filter((row) => open.ambiguousExactFirstKeys.includes(row.key)).map((row) => row.key).sort()).toEqual(
      [...open.ambiguousExactFirstKeys].sort()
    );
  });

  test("fixture README states site data is not Core policy", () => {
    const readme = readFileSync(path.join(FIXTURE, "README.md"), "utf8");
    const manifest = loadJson("manifest.json");
    expect(readme).toContain("not Core ranking policy");
    expect(readme).toContain(manifest.corpusSourceCommit);
    expect(readme).toContain(manifest.contentTree);
    expect(readme).toContain(manifest.uncommittedDiffSha256);
    expect(readme).toContain(`previous corpus HEAD was \`${manifest.previousCorpusSourceCommit}\``);
    expect(readme).toContain("dff24cf606967cb50b24d28d9142747c9203e053");
    expect(readme).toContain("3ad49e867f82db06aa06cd1c7f38dca8faecf246");
    expect(readme).toContain("e4507c54451814fcafb9598640bd2323faacefa5");
    expect(readme).toContain("0a8b33b7604b61e75e03a55b9c1e59d8571a3e19");
    expect(readme).toContain("62c51bad060fea9627f06c752341ea7434f86e46");
    expect(readme).toContain("eac7a90a15d772f0f0626a0fa9481eb9efa55521");
    expect(readme).toContain("db5a070dbc6ac112dfae403f38fdfd0fffbedbf6");
    expect(readme).toContain("df852eb4136dc5fb5b23cbf0bc22d45170e71423");
    expect(readme).toContain("dictionaryAcronymMapSoftwareLandCommit");
    expect(readme).not.toMatch(/df852eb \/ HEAD/);
  });

  test("historical inventory keeps intent-mining dispositions and marks relevance applicability", () => {
    const dispositions = new Set(historical.rows.map((row) => row.disposition));
    expect(dispositions).toEqual(
      new Set([
        "contract-a-intent",
        "omitted-duplicate-a-intent",
        "regression-b-intent",
        "omitted-duplicate-b-intent",
        "omitted-covered-by-v2-contract",
        "omitted-b-intent-not-current-v2",
        "omitted-empty-intent-observational-v1",
        "omitted-obsolete",
      ])
    );
    expect(historical.rows.filter((row) => row.disposition === "contract-a-intent")).toHaveLength(83);
    expect(historical.rows.filter((row) => row.disposition === "omitted-duplicate-a-intent")).toHaveLength(6);
    expect(historical.rows.filter((row) => row.disposition === "regression-b-intent")).toHaveLength(54);
    expect(historical.rows.filter((row) => row.disposition === "omitted-duplicate-b-intent")).toHaveLength(1);
    expect(historical.rows.filter((row) => row.disposition === "omitted-covered-by-v2-contract")).toHaveLength(26);
    expect(historical.rows.filter((row) => row.disposition === "omitted-obsolete")).toHaveLength(1);
    expect(historical.rows.filter((row) => row.disposition === "omitted-empty-intent-observational-v1")).toHaveLength(43);
    expect(historical.rows.filter((row) => row.disposition === "omitted-b-intent-not-current-v2").map((row) => row.query)).toEqual([
      "what is an appli",
    ]);
    for (const row of historical.rows) {
      expect(row.query).toBeTruthy();
      expect(row.classification).toMatch(/^[ABC]$/);
      expect(row.disposition).toBeTruthy();
      expect(row.note).toBeTruthy();
    }
    const emptyIntent = historical.rows.filter((row) => row.disposition === "omitted-empty-intent-observational-v1");
    expect(emptyIntent.every((row) => row.v1?.expectedTop || row.v1?.titlePrefix)).toBe(true);
    expect(emptyIntent.every((row) => row.historicalRelevance === true)).toBe(true);
    expect(historical.rows.filter((row) => row.historicalRelevance)).toHaveLength(214);
    expect(historical.rows.filter((row) => row.historicalRelevance === false).map((row) => row.query)).toEqual(["open"]);
    expect(contracts.cases.every((row) => row.kind === "contract" && !row.v1)).toBe(true);
    expect(regressions.cases.every((row) => row.kind === "regression" && row.classification === "B" && !row.v1)).toBe(true);
    expect(regressions.overlayCases.every((row) => row.kind === "regression" && row.origin === "overlay" && !row.v1 && !row.classification)).toBe(true);
  });

  test("recurse joins the frozen recursion result sequence", () => {
    const expected = titlesOf(engine, "recursion");
    expect(expected[0]).toBe("What is Recursion?");
    for (const query of ["recurs", "recurse", "recurses", "recursing", "recursive"]) {
      expect(titlesOf(engine, query)).toEqual(expected);
    }
  });

  test('query "2" is 200FPS then TLS 1.2 Vulnerability', () => {
    expect(titlesOf(engine, "2", 2)).toEqual([
      "200FPS: CSS vs Canvas vs WebGL vs WebGPU",
      "TLS 1.2 Vulnerability",
    ]);
  });

  test.each(frozenCorpusScenarioRows(contracts).map((row) => [row.name, row]))("contract %s", (_name, row) => {
    expect(row.kind).toBe("contract");
    assertScenarioCase(engine, row);
  });

  test.each(frozenCorpusScenarioRows(regressions).map((row) => [row.name, row]))("regression %s", (_name, row) => {
    expect(row.kind).toBe("regression");
    assertScenarioCase(engine, row);
  });
});

describe("software-land fixture inputs are load-bearing", () => {
  test("authored dfs relationship is the later tree correction", () => {
    const authored = loadJson("relationship-map.json");
    expect(authored.map.dfs).toEqual([{ kind: "related", to: { form: "tree" } }]);
    for (const edges of Object.values(authored.map)) {
      for (const edge of edges || []) {
        expect(edge?.to?.form).not.toBe("minimax");
      }
    }
    expect(authored.notes.join("\n")).toContain("not a new corpus export");
    const manifest = loadJson("manifest.json");
    expect(manifest.corpusSourceCommit).toBe("2f085e6789d30dc7bdfa26027e0e9ab15d489f85");
    expect(manifest.fixtureCorrections).toEqual([
      expect.objectContaining({
        file: "relationship-map.json",
        replaced: { source: "dfs", kind: "related", form: "minimax" },
        current: { source: "dfs", kind: "related", form: "tree" },
      }),
    ]);
  });

  test("sorting #3 depends on the site lemma table", async () => {
    const without = await indexEngine(createEngine({ useLemmas: false }));
    expect(without.search("sorting", { limit: 3 }).map((hit) => hit.title)).not.toEqual([
      "Python Custom Sorting",
      "Topological Sort",
      "Dynamic Programming Matrix",
    ]);
  });

  test("aplicationsecurity #1 depends on the fixture configured concepts", async () => {
    const without = await indexEngine(createEngine({ useDictionary: false }));
    const titles = without.search("aplicationsecurity", { limit: 10 }).map((hit) => hit.title);
    expect(titles[0]).not.toBe("App Sec");
  });

  test("machine learning compiled phrase counts come from lexical-frequency", async () => {
    const withFreq = await indexEngine(createEngine());
    const without = await indexEngine(createEngine(), { useLexicalFrequency: false });
    const title = "Linear vs Logistic Regression";
    const withHit = withFreq.searchDetailed("machine learning", { limit: 10, explain: true }).results.find((hit) => hit.title === title);
    const withoutHit = without.searchDetailed("machine learning", { limit: 10, explain: true }).results.find((hit) => hit.title === title);
    expect(withHit?.features.bodyPhraseCount).toBeGreaterThan(0);
    expect(withoutHit?.features.bodyPhraseCount || 0).toBe(0);
  });

  test("tls VPN related hit depends on the relationship graph", async () => {
    const without = await indexEngine(createEngine({ useRelationships: false }));
    const vpn = without.searchDetailed("tls", { limit: 10, explain: true }).results.find((hit) => hit.title === "What is VPN?");
    expect(vpn?.relevanceKind).not.toBe("related");
    expect(vpn?.relationship?.type).not.toBe("editorial");
  });
});

describe("software-land candidate-stage survival", () => {
  let fullScan;
  let indexed;

  beforeAll(async () => {
    fullScan = await indexEngine(createEngine({ retriever: "full-scan" }));
    indexed = await indexEngine(createEngine({ retriever: "indexed" }));
  });

  test("executable cases never depend on v1 expectedTop", () => {
    for (const row of [
      ...frozenCorpusScenarioRows(contracts),
      ...frozenCorpusScenarioRows(regressions),
    ]) {
      expect(row.v1).toBeUndefined();
      expect(row.expectedTop).toBeUndefined();
    }
  });

  test("full-scan retains contract and regression targets before ranking", () => {
    const contractStats = measureCandidateSurvival(fullScan, contracts.cases);
    const regressionStats = measureCandidateSurvival(fullScan, regressions.cases);
    expect(contractStats.n).toBe(135);
    expect(regressionStats.n).toBe(54);
    expect(contractStats.missing).toEqual([]);
    expect(regressionStats.missing).toEqual([]);
    expect(contractStats.relatedMiss).toEqual([]);
    expect(regressionStats.relatedMiss).toEqual([]);
    expect(contractStats.prefixMiss).toEqual([]);
    expect(regressionStats.prefixMiss).toEqual([]);
    expect(contractStats.maxC).toBeLessThanOrEqual(documents.length);
    expect(regressionStats.maxC).toBeLessThanOrEqual(documents.length);
    // Measured on this 123-document snapshot with the authored relationship map.
    expect(contractStats.maxC).toBe(117);
    expect(regressionStats.maxC).toBe(99);
  });

  test("indexed retains contract and regression targets before ranking", () => {
    const contractStats = measureCandidateSurvival(indexed, contracts.cases);
    const regressionStats = measureCandidateSurvival(indexed, regressions.cases);
    expect(contractStats.missing).toEqual([]);
    expect(regressionStats.missing).toEqual([]);
    expect(contractStats.relatedMiss).toEqual([]);
    expect(regressionStats.relatedMiss).toEqual([]);
    expect(contractStats.prefixMiss).toEqual([]);
    expect(regressionStats.prefixMiss).toEqual([]);
    expect(contractStats.maxC).toBeLessThanOrEqual(documents.length);
    expect(regressionStats.maxC).toBeLessThanOrEqual(documents.length);
    // Exact compiled retrieval enumerates every match, then ranks only the
    // required per-signature representatives. Within a signature that order
    // is rounded score, then the conditional weak-body and equivalent-body
    // occurrence counts, then document id.
    // The retained count is intentionally no longer the old BM25 candidate
    // envelope and is not a fixed product contract.
    expect(contractStats.maxC).toBeLessThan(117);
    expect(regressionStats.maxC).toBeLessThan(99);
  });

  test("representative queries report the measured full-scan candidate counts", () => {
    // Measured full-scan candidate counts for this snapshot. Topical recall
    // widens aplicationsecurity and machine learning. The AppSec security form widens aplicationsecurity further. The added conversion
    // article accounts for the one-document increase on "2", Edge Computing, and what.
    const expected = {
      2: 63,
      "Edge Computing": 62,
      aplicationsecurity: 36,
      tls: 6,
      "machine learning": 20,
      what: 80,
    };
    for (const [query, c] of Object.entries(expected)) {
      const detailed = fullScan.searchDetailed(query, { limit: SEARCH_LIMIT });
      expect(detailed.meta.candidateCount).toBe(c);
      expect(detailed.meta.candidateCount).toBeLessThanOrEqual(documents.length);
    }
  });

  test("query 2 keeps both correctness-critical titles in the candidate set", () => {
    const detailed = fullScan.searchDetailed("2", { limit: SEARCH_LIMIT });
    const titles = new Set(detailed.meta.candidateTitles);
    expect(titles.has("200FPS: CSS vs Canvas vs WebGL vs WebGPU")).toBe(true);
    expect(titles.has("TLS 1.2 Vulnerability")).toBe(true);
    expect(indexed.searchDetailed("2", { limit: SEARCH_LIMIT }).meta.candidateTitles).toEqual(
      expect.arrayContaining(["200FPS: CSS vs Canvas vs WebGL vs WebGPU", "TLS 1.2 Vulnerability"])
    );
  });
});

describe("conditional precedence candidate survival", () => {
  function engineWith(candidateTitles) {
    return {
      searchDetailed() {
        return { meta: { candidateTitles, candidateCount: candidateTitles.length } };
      },
    };
  }

  const APP_SEC = "App Sec";
  const ZERO = "Zero-Trust Security";
  const RBAC = "RBAC (Role Based Access Control)";
  const AUTHZ = "Authorization Middleware";
  const LLAMA = "Working with Llama.cpp Embeddings";

  test("a visible-later precedence does not require that article unless another assertion does", () => {
    const appsec = contracts.cases.find((row) => row.query === "appsec" && row.origin === "v2-contract");
    const withoutLlama = measureCandidateSurvival(engineWith([APP_SEC, ZERO, RBAC, AUTHZ]), [appsec]);
    expect(withoutLlama.missing).toEqual([]);

    expect(() => assertExportedScenario([
      { title: APP_SEC, id: "C" },
      { title: LLAMA, id: "ch" },
      { title: ZERO, id: "bj" },
      { title: RBAC, id: "3" },
      { title: AUTHZ, id: "D" },
    ], appsec)).toThrow(/Zero-Trust Security must precede Working with Llama.cpp Embeddings/);

    const unconditional = {
      query: "order",
      name: "unconditional order",
      precedes: [{ earlier: "Alpha", later: "Beta", topN: 10 }],
    };
    expect(measureCandidateSurvival(engineWith(["Alpha"]), [unconditional]).missing).toEqual([
      { query: "order", name: "unconditional order", title: "Beta" },
    ]);
    expect(measureCandidateSurvival(engineWith(["Beta"]), [unconditional]).missing).toEqual([
      { query: "order", name: "unconditional order", title: "Alpha" },
    ]);
    expect(measureCandidateSurvival(engineWith(["Alpha", "Beta"]), [unconditional]).missing).toEqual([]);

    const alsoRequired = {
      query: "appsec",
      name: "later required independently",
      requiredAnyTop: { titles: [LLAMA], topN: 10 },
      precedes: [{ earlier: ZERO, later: LLAMA, topN: 10, whenLaterVisible: true }],
    };
    expect(measureCandidateSurvival(engineWith([ZERO]), [alsoRequired]).missing).toEqual([
      { query: "appsec", name: "later required independently", title: LLAMA },
    ]);

    expect(() => assertExportedScenario([
      { title: APP_SEC, id: "C" },
      { title: RBAC, id: "3" },
      { title: "SAML vs OAuth", id: "7" },
      { title: ZERO, id: "bj" },
      { title: AUTHZ, id: "D" },
    ], appsec)).toThrow(/Missing required article "Zero-Trust Security" within the top 3/);
  });
});

describe("software-land fenwick corpus contracts", () => {
  test("Fenwick Tree appears once in the corpus", () => {
    const fenwick = documents.find((doc) => doc.id === "cm");
    expect(fenwick?.title).toBe("Fenwick Tree");
    expect(documents.filter((doc) => doc.id === "cm" || doc.title === "Fenwick Tree")).toHaveLength(1);
  });
});
