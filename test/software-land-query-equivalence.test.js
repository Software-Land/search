/**
 * Fail-closed identity: every Software.Land historical query must keep the
 * pre-optimization 0.4.0 ordered result list. Not a new Core ranking contract.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology, dictionary } from "../dist/index.js";
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

function serializeHits(hits) {
  return hits.map((hit) => ({
    id: hit.id,
    title: hit.title,
    rank: hit.rank,
    score: hit.score,
    relevanceKind: hit.relevanceKind,
    directClass: hit.directClass ?? null,
  }));
}

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
        dictionary({ entries: loadJson("dictionary.json") }),
      ],
      relationships: loadJson("relationships.json"),
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
    expect(oracle.rows.filter((row) => row.results.length === 0).map((row) => row.query).sort()).toEqual([
      "a*",
      "recurssing",
    ]);
  });

  test("query 2 remains 200FPS then TLS 1.2 Vulnerability", () => {
    const titles = engine.search("2", { limit: 2 }).map((hit) => hit.title);
    expect(titles).toEqual([
      "200FPS: CSS vs Canvas vs WebGL vs WebGPU",
      "TLS 1.2 Vulnerability",
    ]);
  });

  test.each(oracle.rows.map((row) => [row.index, row.query, row]))(
    "row %s query %s matches frozen ordered results",
    (_index, _query, frozen) => {
      const detailed = engine.searchDetailed(frozen.query, {
        limit: RESULT_LIMIT,
        relatedLimit: RELATED_LIMIT,
      });
      expect({
        query: frozen.query,
        candidateCount: detailed.meta.candidateCount,
        results: serializeHits(detailed.results),
        related: serializeHits(detailed.related),
      }).toEqual({
        query: frozen.query,
        candidateCount: frozen.candidateCount,
        results: frozen.results,
        related: frozen.related,
      });
    }
  );
});
