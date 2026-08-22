/**
 * Software.Land-derived realistic integration tests.
 * Fixture data is not default package policy.
 * Regression cases are compatibility coverage, not Core ranking policy.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology, dictionary } from "../dist/index.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, "fixtures", "software-land");
const SEARCH_LIMIT = 10;

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
}

const manifest = loadJson("manifest.json");
const documents = loadJson("documents.json");
const dictionaryEntries = loadJson("dictionary.json");
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

function createEngine({ useLemmas = true, useDictionary = true, useRelationships = true } = {}) {
  return SearchEngine.create({
    schema,
    plugins: [
      morphology(useLemmas ? { lemmas } : {}),
      dictionary({ entries: useDictionary ? dictionaryEntries : [] }),
    ],
    relationships: useRelationships ? relationships : undefined,
    relationshipStrategy: useRelationships ? "hybrid" : undefined,
    retriever: "full-scan",
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
    expect(manifest.scenarioSourceCommit).toBe("08e1b735ae01a3815964360ef3b9141466176dc4");
    expect(manifest.softwareLandCommit).toBeUndefined();
    expect(manifest.searchPackageVersion).toBe("0.3.1");
    expect(manifest.documentCount).toBe(122);
    expect(documents).toHaveLength(122);
    expect(manifest.description).toMatch(/not default package policy/i);
    expect(manifest.scenarioCount).toBe(215);
    expect(manifest.historicalScenarioCount).toBe(215);
    expect(manifest.executableV2ScenarioCount).toBe(98);
    expect(manifest.executableRegressionCount).toBe(60);
    expect(manifest.omittedV1OnlyCount).toBe(126);
    expect(manifest.omittedEmptyIntentCount).toBe(44);
    expect(manifest.omittedBrowserUiOnlyCount).toBe(1);
    expect(manifest.sourceScenarioFiles).toEqual([
      "tests/search-scenarios.js",
      "tests/search-v2-contracts.js",
    ]);
    expect(contracts.cases).toHaveLength(98);
    expect(regressions.cases).toHaveLength(60);
    expect(historical.rows).toHaveLength(215);
    expect(index.counts.executableContracts).toBe(98);
    expect(index.counts.executableRegressions).toBe(60);
  });

  test("fixture README states site data is not Core policy", () => {
    const readme = readFileSync(path.join(FIXTURE, "README.md"), "utf8");
    expect(readme).toContain("Software.Land-derived realistic integration test data. It is not default package policy.");
    expect(readme).toContain("They must never become Core defaults.");
    expect(readme).toContain("not Core ranking policy");
    expect(readme).toContain("dff24cf606967cb50b24d28d9142747c9203e053");
    expect(readme).toContain("08e1b735ae01a3815964360ef3b9141466176dc4");
  });

  test("historical inventory is non-executable provenance with dispositions", () => {
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
    expect(historical.rows.filter((row) => row.disposition === "contract-a-intent")).toHaveLength(82);
    expect(historical.rows.filter((row) => row.disposition === "omitted-duplicate-a-intent")).toHaveLength(6);
    expect(historical.rows.filter((row) => row.disposition === "regression-b-intent")).toHaveLength(60);
    expect(historical.rows.filter((row) => row.disposition === "omitted-duplicate-b-intent")).toHaveLength(5);
    expect(historical.rows.filter((row) => row.disposition === "omitted-covered-by-v2-contract")).toHaveLength(16);
    expect(historical.rows.filter((row) => row.disposition === "omitted-obsolete")).toHaveLength(1);
    expect(historical.rows.filter((row) => row.disposition === "omitted-empty-intent-observational-v1")).toHaveLength(44);
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
    expect(contracts.cases.every((row) => row.kind === "contract" && !row.v1)).toBe(true);
    expect(regressions.cases.every((row) => row.kind === "regression" && row.classification === "B" && !row.v1)).toBe(true);
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
  test("sort recurses #1 depends on the site lemma table", async () => {
    const without = await indexEngine(createEngine({ useLemmas: false }));
    expect(without.search("sort recurses", { limit: 1 })[0].title).not.toBe("What is Recursion?");
  });

  test("aplicationsecurity #1 depends on the fixture dictionary", async () => {
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
