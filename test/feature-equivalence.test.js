/**
 * Fail-closed feature-vector identity vs the frozen extractFeatures oracle.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology } from "../dist/index.js";
import { dictionary } from "../dist/dictionary.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import { extractFeatures } from "../dist/features.js";
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
        dictionary({ entries: loadJson("dictionary.json") }),
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
    const mismatches = [];
    for (const row of historical.rows) {
      const query = engine._prepareQuery(row.query);
      for (const doc of index.documents) {
        const actual = featureSurface(extractFeatures(query, doc));
        const expected = featureSurface(extractFeaturesOracle(query, doc));
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          mismatches.push({ query: row.query, id: doc.id, actual, expected });
          if (mismatches.length >= 5) break;
        }
      }
      if (mismatches.length >= 5) break;
    }
    expect(mismatches).toEqual([]);
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
