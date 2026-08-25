/**
 * Software.Land historical expectedTop / titlePrefix relevance contracts.
 * Fixture-only. Not Core default ranking policy.
 * Separate from query-result-oracle.json exact-output identity.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology, dictionary, synonyms } from "../dist/index.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import {
  evaluateHistoricalRelevance,
  formatHistoricalRelevanceFailure,
  isHistoricalRelevanceApplicable,
} from "./historical-relevance.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, "fixtures", "software-land");

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
}

const documents = loadJson("documents.json");
const historical = loadJson("historical-scenarios.json");
const relevanceConfig = loadJson("relevance-config.json");
const synonymFixture = loadJson("synonym-map.json");
const omitKeys = new Set(relevanceConfig.omitDictionaryKeys || []);
const dictionaryEntries = loadJson("dictionary.json").filter((entry) => !omitKeys.has(entry.key));

const applicable = historical.rows.filter(isHistoricalRelevanceApplicable);
const recorded = [];

function createRelevanceEngine() {
  return SearchEngine.create({
    schema: {
      title: { type: "text", role: "title" },
      body: { type: "text", role: "body" },
    },
    plugins: [
      morphology({ lemmas: loadJson("lemmas.json") }),
      dictionary({ entries: dictionaryEntries }),
      synonyms(synonymFixture.map),
    ],
    relationships: loadJson("relationships.json"),
    relationshipStrategy: "hybrid",
    retriever: "full-scan",
  });
}

describe("Software.Land historical relevance contracts", () => {
  let engine;

  beforeAll(async () => {
    engine = createRelevanceEngine();
    await engine.index(attachLexicalFrequency(documents, loadJson("lexical-frequency.json")));
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

  test("query 12 historical contract stays 200FPS topN 1 and conflicts with V2 TLS primary", () => {
    const row = historical.rows.find((item) => item.query === "12");
    expect(row.historicalRelevance).toBe(true);
    expect(row.v1).toEqual({
      expectedTop: ["200FPS: CSS vs Canvas vs WebGL vs WebGPU"],
      topN: 1,
    });
    expect(row.intent.requiredPrimary).toEqual(["TLS 1.2 Vulnerability"]);
    const v2First = evaluateHistoricalRelevance(row, [
      "TLS 1.2 Vulnerability",
      "200FPS: CSS vs Canvas vs WebGL vs WebGPU",
    ]);
    expect(v2First.ok).toBe(false);
    expect(v2First.kinds).toContain("primary-not-first");
    expect(
      evaluateHistoricalRelevance(row, ["200FPS: CSS vs Canvas vs WebGL vs WebGPU"]).ok
    ).toBe(true);
  });

  test("fixture models current Software.Land 0.5 curated synonym configuration", () => {
    expect(relevanceConfig.softwareLandCommit).toBe("f72444b530ea44a4d3b9cd430c4db1568a24548c");
    expect(omitKeys.has("testing")).toBe(true);
    expect(dictionaryEntries.some((entry) => entry.key === "testing")).toBe(false);
    expect(loadJson("dictionary.json").some((entry) => entry.key === "testing")).toBe(true);
    expect(synonymFixture.map.qa).toEqual(["testing"]);
    expect(synonymFixture.map.bearer).toEqual(expect.arrayContaining(["token"]));
    expect(synonymFixture.map.token).toBeUndefined();
    expect(historical.counts.historicalRelevanceApplicable).toBe(214);
    expect(applicable).toHaveLength(214);
    expect(applicable.filter((row) => row.classification === "C")).toHaveLength(0);
    expect(historical.rows.filter((row) => row.classification === "C").map((row) => row.query)).toEqual(["sharde"]);
    expect(applicable.filter((row) => row.v1?.titlePrefix)).toHaveLength(1);
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
