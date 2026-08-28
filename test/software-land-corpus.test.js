/**
 * Software.Land-derived realistic integration tests.
 * Fixture data is not default package policy.
 * Regression cases are compatibility coverage, not Core ranking policy.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, "fixtures", "software-land");
const SEARCH_LIMIT = 10;

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
}

const manifest = loadJson("manifest.json");
const documents = loadJson("documents.json");
const configuredConcepts = loadJson("configured-concepts.json");
const lemmas = loadJson("lemmas.json");
const relationships = loadJson("relationships.json");
const lexicalFrequency = loadJson("lexical-frequency.json");
const index = loadJson("scenarios.json");
const contracts = loadJson("v2-contracts.json");
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
  return SearchEngine.create({
    schema,
    plugins: [
      morphology(useLemmas ? { lemmas } : {}),
      compileConfiguredConceptPlugin({ configuredConcepts: useDictionary ? configuredConcepts : [] }),
    ],
    documentRelationships: useRelationships ? relationships : undefined,
    relationshipStrategy: useRelationships ? "hybrid" : undefined,
    retriever,
  });
}

async function indexEngine(engine, { useLexicalFrequency = true } = {}) {
  const docs = useLexicalFrequency ? attachLexicalFrequency(documents, lexicalFrequency) : documents;
  await engine.index(docs);
  return engine;
}

function titlesOf(engine, query, limit = SEARCH_LIMIT) {
  return engine.search(query, { limit }).map((hit) => hit.title);
}

function indexOfTitle(titles, wanted) {
  return titles.findIndex((title) => title === wanted);
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
  const titles = titlesOf(engine, row.query);
  if (row.exactFirst) {
    expect(titles[0]).toBe(row.exactFirst);
  }
  for (const req of row.requiredWithin || []) {
    const idx = indexOfTitle(titles, req.title);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx + 1).toBeLessThanOrEqual(req.topN);
  }
  for (const req of row.requiredAnyWithin || []) {
    const idx = indexOfTitle(titles, req.title);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx + 1).toBeLessThanOrEqual(req.topN);
  }
  if (row.requiredAnyTop) {
    const window = titles.slice(0, row.requiredAnyTop.topN);
    for (const title of row.requiredAnyTop.titles) {
      expect(window).toContain(title);
    }
  }
  if (row.titlePrefix) {
    const topN = row.titlePrefixTopN ?? 10;
    for (const title of titles.slice(0, topN)) {
      expect(title.startsWith(row.titlePrefix)).toBe(true);
    }
  }
  if (row.mustNotDominate?.primary) {
    const primaryIdx = indexOfTitle(titles, row.mustNotDominate.primary);
    expect(primaryIdx).toBeGreaterThanOrEqual(0);
    for (const forbidden of row.mustNotDominate.titles) {
      const idx = indexOfTitle(titles, forbidden);
      if (idx >= 0) expect(idx).toBeGreaterThan(primaryIdx);
    }
  }
  if (row.requiredRelatedAny) {
    const window = titles.slice(0, row.requiredRelatedAny.topN || SEARCH_LIMIT);
    const matched = row.requiredRelatedAny.titles.filter((title) => window.includes(title));
    expect(matched.length).toBeGreaterThanOrEqual(row.requiredRelatedAny.minCount || 1);
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

  test("manifest records source commit, package version, document count, and scenario provenance", () => {
    expect(manifest.format).toBe("software-land-search-fixture");
    expect(manifest.version).toBe(1);
    expect(manifest.corpusSourceCommit).toBe("dff24cf606967cb50b24d28d9142747c9203e053");
    expect(manifest.scenarioSourceCommit).toBe("3ad49e867f82db06aa06cd1c7f38dca8faecf246");
    expect(manifest.softwareLandCommit).toBeUndefined();
    expect(manifest.relevanceSoftwareLandCommit).toBe("db5a070dbc6ac112dfae403f38fdfd0fffbedbf6");
    expect(manifest.dictionaryAcronymMapSoftwareLandCommit).toBe(
      "df852eb4136dc5fb5b23cbf0bc22d45170e71423"
    );
    expect(manifest.historicalRelevanceApplicable).toBe(214);
    expect(manifest.searchPackageVersion).toBe("0.3.1");
    expect(manifest.documentCount).toBe(122);
    expect(manifest.configuredConceptCount).toBe(192);
    expect(documents).toHaveLength(122);
    expect(manifest.description).toMatch(/not default package policy/i);
    expect(manifest.scenarioCount).toBe(215);
    expect(manifest.historicalScenarioCount).toBe(215);
    expect(manifest.executableV2ScenarioCount).toBe(99);
    expect(manifest.executableRegressionCount).toBe(60);
    expect(manifest.omittedV1OnlyCount).toBe(125);
    expect(manifest.omittedEmptyIntentCount).toBe(43);
    expect(manifest.omittedBrowserUiOnlyCount).toBe(1);
    expect(manifest.sourceScenarioFiles).toEqual([
      "tests/search-scenarios.js",
      "tests/search-v2-contracts.js",
    ]);
    expect(contracts.cases).toHaveLength(99);
    expect(regressions.cases).toHaveLength(60);
    expect(historical.rows).toHaveLength(215);
    expect(historical.kind).toBe("historical-relevance-contracts");
    expect(historical.counts.historicalRelevanceApplicable).toBe(214);
    expect(index.counts.executableContracts).toBe(99);
    expect(index.counts.executableRegressions).toBe(60);
  });

  test("fixture README states site data is not Core policy", () => {
    const readme = readFileSync(path.join(FIXTURE, "README.md"), "utf8");
    expect(readme).toContain("Software.Land-derived realistic integration test data. It is not default package policy.");
    expect(readme).toContain("They must never become Core defaults.");
    expect(readme).toContain("not Core ranking policy");
    expect(readme).toContain("dff24cf606967cb50b24d28d9142747c9203e053");
    expect(readme).toContain("3ad49e867f82db06aa06cd1c7f38dca8faecf246");
    expect(readme).toContain("eac7a90a15d772f0f0626a0fa9481eb9efa55521");
    expect(readme).toContain("db5a070dbc6ac112dfae403f38fdfd0fffbedbf6");
    expect(readme).toContain("df852eb4136dc5fb5b23cbf0bc22d45170e71423");
    expect(readme).toContain("dictionaryAcronymMapSoftwareLandCommit");
    expect(readme).not.toMatch(/df852eb \/ HEAD/);
  });

  test("configured-concepts.json bytes match the recorded manifest hash", () => {
    const rec = manifest.files["configured-concepts.json"];
    const buf = readFileSync(path.join(FIXTURE, "configured-concepts.json"));
    expect(buf.byteLength).toBe(rec.bytes);
    expect(createHash("sha256").update(buf).digest("hex")).toBe(rec.sha256);
    expect(rec.sha256).toBe("d0a4e72b54d7431233d5ebc7c9608c88922ddbeeabc52bfdb0a6015fef2f85f5");
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
    expect(historical.rows.filter((row) => row.disposition === "regression-b-intent")).toHaveLength(60);
    expect(historical.rows.filter((row) => row.disposition === "omitted-duplicate-b-intent")).toHaveLength(5);
    expect(historical.rows.filter((row) => row.disposition === "omitted-covered-by-v2-contract")).toHaveLength(16);
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

  test.each(contracts.cases.map((row) => [row.name, row]))("contract %s", (_name, row) => {
    expect(row.kind).toBe("contract");
    assertScenarioCase(engine, row);
  });

  test.each(regressions.cases.map((row) => [row.name, row]))("regression %s", (_name, row) => {
    expect(row.kind).toBe("regression");
    assertScenarioCase(engine, row);
  });
});

describe("software-land fixture inputs are load-bearing", () => {
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

  test("machine learning phrase ranking depends on lexical-frequency", async () => {
    const without = await indexEngine(createEngine(), { useLexicalFrequency: false });
    const titles = without.search("machine learning", { limit: 2 }).map((hit) => hit.title);
    expect(titles).not.toContain("Linear vs Logistic Regression");
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
    for (const row of [...contracts.cases, ...regressions.cases]) {
      expect(row.v1).toBeUndefined();
      expect(row.expectedTop).toBeUndefined();
    }
  });

  test("full-scan retains contract and regression targets before ranking", () => {
    const contractStats = measureCandidateSurvival(fullScan, contracts.cases);
    const regressionStats = measureCandidateSurvival(fullScan, regressions.cases);
    expect(contractStats.n).toBe(99);
    expect(regressionStats.n).toBe(60);
    expect(contractStats.missing).toEqual([]);
    expect(regressionStats.missing).toEqual([]);
    expect(contractStats.relatedMiss).toEqual([]);
    expect(regressionStats.relatedMiss).toEqual([]);
    expect(contractStats.prefixMiss).toEqual([]);
    expect(regressionStats.prefixMiss).toEqual([]);
    expect(contractStats.maxC).toBeLessThanOrEqual(documents.length);
    expect(regressionStats.maxC).toBeLessThanOrEqual(documents.length);
    expect(contractStats.maxC).toBe(116);
    expect(regressionStats.maxC).toBe(98);
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
    // required score/id representatives per builtin constraint signature.
    // The retained count is intentionally no longer the old BM25 candidate
    // envelope and is not a fixed product contract.
    expect(contractStats.maxC).toBeLessThan(116);
    expect(regressionStats.maxC).toBeLessThan(98);
  });

  test("representative queries report the measured full-scan candidate counts", () => {
    const expected = {
      2: 63,
      "Edge Computing": 62,
      aplicationsecurity: 4,
      tls: 7,
      "machine learning": 9,
      what: 79,
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
