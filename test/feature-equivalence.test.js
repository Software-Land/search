/**
 * Fail-closed feature-vector identity vs the frozen extractFeatures oracle.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/relationships/configuredConcepts.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import { extractFeatures } from "../dist/features/features.js";
import { extractFeaturesOracle } from "../build/test/oracles/featuresOracle.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, "fixtures", "software-land");

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
}

function featureSurface(f) {
  return JSON.parse(
    JSON.stringify(f, (_key, value) => {
      // The frozen extractor predates this internal provenance feature.
      if (_key === "ordinaryEquivalenceBodyMatch") return undefined;
      if (value instanceof Set) return [...value];
      if (value instanceof Map) return Object.fromEntries(value);
      return value;
    })
  );
}

const documents = loadJson("documents.json");
const historical = loadJson("historical-scenarios.json");
const APPROVED_OBJECT_COVERAGE = ["bb", "z"];

function withoutPrefixCoverage(surface) {
  const { configuredPrefixRecallScore, ...rest } = surface;
  return rest;
}

describe("feature extraction oracle", () => {
  let engine;

  beforeAll(async () => {
    engine = SearchEngine.create({
      schema: {
        title: { type: "text", role: "title" },
        body: { type: "text", role: "body" },
      },
      plugins: [
        morphology({ lemmas: loadJson("lemmas.json") }),
        compileConfiguredConceptPlugin({ configuredConcepts: loadJson("configured-concepts.json") }),
      ],
      documentRelationships: loadJson("relationships.json"),
      relationshipStrategy: "hybrid",
      retriever: "full-scan",
    });
    await engine.index(attachLexicalFrequency(documents, loadJson("lexical-frequency.json")));
  });

  test("every historical query × indexed document matches the frozen extractor", () => {
    const index = engine._index;
    expect(index.documents).toHaveLength(documents.length);
    const approved = new Map();
    const mismatches = [];
    let mismatchCount = 0;
    for (const row of historical.rows) {
      const query = engine._prepareQuery(row.query);
      for (const doc of index.documents) {
        const actual = featureSurface(extractFeatures(query, doc));
        const expected = featureSurface(extractFeaturesOracle(query, doc));
        if (row.query === "object" && APPROVED_OBJECT_COVERAGE.includes(doc.id)) {
          approved.set(doc.id, { actual, expected });
          continue;
        }
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          mismatchCount += 1;
          if (mismatches.length < 5) mismatches.push({ query: row.query, id: doc.id, actual, expected });
        }
      }
    }
    expect([...approved.keys()].sort()).toEqual([...APPROVED_OBJECT_COVERAGE].sort());
    for (const id of APPROVED_OBJECT_COVERAGE) {
      const row = approved.get(id);
      expect(row.expected.configuredPrefixRecallScore).toBe(0);
      expect(row.actual.configuredPrefixRecallScore).toBe(0.3333);
      expect(withoutPrefixCoverage(row.actual)).toEqual(withoutPrefixCoverage(row.expected));
    }
    expect(mismatches).toEqual([]);
    expect(mismatchCount).toBe(0);
  });

  test("relationship-tagged extraction matches the frozen extractor", () => {
    const index = engine._index;
    const relationship = {
      sourceId: "src",
      sourceTitle: "Source",
      type: "editorial",
      strength: 0.5,
      provenance: "manual",
    };
    const mismatches = [];
    for (const row of historical.rows.slice(0, 20)) {
      const query = engine._prepareQuery(row.query);
      for (const doc of index.documents) {
        const actual = featureSurface(extractFeatures(query, doc, { relationship, retrievalScore: 0.25 }));
        const expected = featureSurface(extractFeaturesOracle(query, doc, { relationship, retrievalScore: 0.25 }));
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          mismatches.push({ query: row.query, id: doc.id, actual, expected });
          if (mismatches.length >= 5) break;
        }
      }
      if (mismatches.length >= 5) break;
    }
    expect(mismatches).toEqual([]);
  });
});
