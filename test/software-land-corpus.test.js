/**
 * Software.Land-derived realistic integration tests.
 * Fixture data is not default package policy.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, english, dictionary } from "../dist/index.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, "fixtures", "software-land");

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
}

const manifest = loadJson("manifest.json");
const documents = loadJson("documents.json");
const dictionaryEntries = loadJson("dictionary.json");
const lemmas = loadJson("lemmas.json");
const relationships = loadJson("relationships.json");
const lexicalFrequency = loadJson("lexical-frequency.json");
const scenarios = loadJson("scenarios.json");

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

function createEngine({ useLemmas = true, useDictionary = true, useRelationships = true } = {}) {
  return SearchEngine.create({
    schema,
    plugins: [
      english(useLemmas ? { lemmas } : {}),
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

describe("software-land corpus fixture", () => {
  let engine;

  beforeAll(async () => {
    engine = await indexEngine(createEngine());
  });

  test("manifest records source commit, package version, and document count", () => {
    expect(manifest.format).toBe("software-land-search-fixture");
    expect(manifest.version).toBe(1);
    expect(manifest.softwareLandCommit).toBe("dff24cf606967cb50b24d28d9142747c9203e053");
    expect(manifest.searchPackageVersion).toBe("0.3.1");
    expect(manifest.documentCount).toBe(122);
    expect(documents).toHaveLength(122);
    expect(manifest.description).toMatch(/not default package policy/i);
  });

  test("fixture README states site data is not Core policy", () => {
    const readme = readFileSync(path.join(FIXTURE, "README.md"), "utf8");
    expect(readme).toContain("Software.Land-derived realistic integration test data. It is not default package policy.");
    expect(readme).toContain("They must never become Core defaults.");
  });

  test.each(scenarios.cases.filter((row) => Array.isArray(row.exact)).map((row) => [row.query, row]))(
    "query %j exact prefix",
    (_query, row) => {
      const titles = engine.search(row.query, { limit: 10 }).map((hit) => hit.title);
      expect(titles.slice(0, row.exact.length)).toEqual(row.exact);
    }
  );

  test.each(scenarios.cases.filter((row) => row.exactFirst && !row.relationship).map((row) => [row.query, row]))(
    "query %j exact #1",
    (_query, row) => {
      expect(engine.search(row.query, { limit: 1 })[0].title).toBe(row.exactFirst);
    }
  );

  test.each(scenarios.cases.filter((row) => row.withinTopN).map((row) => [row.query, row]))(
    "query %j includes expected title within top N",
    (_query, row) => {
      const titles = engine.search(row.query, { limit: row.withinTopN.topN }).map((hit) => hit.title);
      expect(titles).toContain(row.withinTopN.title);
    }
  );

  test("tls #1 is TLS 1.2 Vulnerability and VPN is an editorial related hit", () => {
    const row = scenarios.cases.find((item) => item.query === "tls");
    const detailed = engine.searchDetailed("tls", { limit: 10, explain: true });
    expect(detailed.results[0].title).toBe(row.exactFirst);
    const vpn = detailed.results.find((hit) => hit.title === row.relationship.title);
    expect(vpn).toBeTruthy();
    expect(vpn.relevanceKind).toBe(row.relationship.relevanceKind);
    expect(vpn.relationship).toEqual(
      expect.objectContaining({
        type: row.relationship.type,
        provenance: row.relationship.provenance,
        sourceTitle: row.relationship.sourceTitle,
      })
    );
    expect(vpn.retrievalSources).toContain("relationship");
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
