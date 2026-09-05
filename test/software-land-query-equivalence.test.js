/**
 * Fail-closed inventory of the 215-query result oracle.
 *
 * The frozen query-result-oracle.json is the identity gate for default Core
 * #1 under this fixture wiring. Historical scenarios may be a strict
 * superset; the oracle freeze stays the original 215-row prefix.
 * Known #1 diffs versus that freeze are
 * occupancy ranking, not collector policy.
 *
 * Complete ordered lists, scores, relevanceKind, directClass, related rail,
 * and candidateCount versus the 0.5 freeze are not restored: that snapshot
 * encodes stale ranking tails, not accepted 0.6 architecture. Product 2–10
 * membership is the V1 historical top-N contract and historical relevance
 * (expectedTop within min(topN, 10)). Live full-scan vs indexed still pins
 * complete ordered results, related, and candidateCount in
 * retrieval-mode-equivalence.test.js.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/relationships/configuredConcepts.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, "fixtures", "software-land");

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
}

const documents = loadJson("documents.json");
const historical = loadJson("historical-scenarios.json");
const oracle = loadJson("query-result-oracle.json");
const RESULT_LIMIT = documents.length;
const RELATED_LIMIT = documents.length;

describe("Software.Land 215-query result oracle", () => {
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

  test("oracle covers every historical row and was frozen at the expected depth", () => {
    expect(oracle.format).toBe("software-land-query-result-oracle");
    expect(oracle.rowCount).toBe(215);
    expect(oracle.rows).toHaveLength(215);
    expect(historical.rows.length).toBeGreaterThanOrEqual(215);
    expect(oracle.documentCount).toBe(documents.length);
    expect(oracle.resultLimit).toBe(RESULT_LIMIT);
    expect(oracle.relatedLimit).toBe(RELATED_LIMIT);
    expect(oracle.rows.map((row) => row.query)).toEqual(
      historical.rows.slice(0, 215).map((row) => row.query)
    );
    expect(oracle.rows.filter((row) => row.results.length === 0).map((row) => row.query).sort()).toEqual([]);
  });

  test("query 2 remains 200FPS then TLS 1.2 Vulnerability", () => {
    const titles = engine.search("2", { limit: 2 }).map((hit) => hit.title);
    expect(titles).toEqual([
      "200FPS: CSS vs Canvas vs WebGL vs WebGPU",
      "TLS 1.2 Vulnerability",
    ]);
  });

  test("default Core #1 ids match the frozen oracle under this fixture wiring", () => {
    for (const row of oracle.rows) {
      expect(engine.search(row.query, { limit: 1 })[0]?.id).toBe(row.results[0]?.id);
    }
  });
});
