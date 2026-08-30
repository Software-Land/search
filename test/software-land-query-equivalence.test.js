/**
 * Fail-closed inventory of the 215 historical queries. Default Core search
 * (collector off) is not a complete-interpretation snapshot. Known #1 diffs
 * versus the frozen oracle are occupancy ranking, not collector policy.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
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
    expect(historical.rows).toHaveLength(215);
    expect(oracle.documentCount).toBe(documents.length);
    expect(oracle.resultLimit).toBe(RESULT_LIMIT);
    expect(oracle.relatedLimit).toBe(RELATED_LIMIT);
    expect(oracle.rows.map((row) => row.query)).toEqual(historical.rows.map((row) => row.query));
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
