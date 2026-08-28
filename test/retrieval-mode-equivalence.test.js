/**
 * Indexed / adaptive retrieval must match current full-scan Software.Land
 * ordered results. The frozen query-result oracle remains the identity gate
 * on the explicit full-scan engine; this file additionally requires indexed
 * retrieval to reproduce that same public output on this 122-document corpus.
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

function createEngine(retriever) {
  return SearchEngine.create({
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
    retriever,
  });
}

describe("Software.Land retrieval-mode equivalence", () => {
  let fullScan;
  let indexed;
  let adaptive;

  beforeAll(async () => {
    const docs = attachLexicalFrequency(documents, loadJson("lexical-frequency.json"));
    fullScan = createEngine("full-scan");
    indexed = createEngine("indexed");
    adaptive = createEngine("adaptive");
    await fullScan.index(docs);
    await indexed.index(docs);
    await adaptive.index(docs);
  });

  test("explicit full-scan still matches the frozen 215-query oracle", () => {
    for (const frozen of oracle.rows) {
      const detailed = fullScan.searchDetailed(frozen.query, {
        limit: RESULT_LIMIT,
        relatedLimit: RELATED_LIMIT,
      });
      expect({
        index: frozen.index,
        query: frozen.query,
        candidateCount: detailed.meta.candidateCount,
        results: serializeHits(detailed.results),
        related: serializeHits(detailed.related),
      }).toEqual({
        index: frozen.index,
        query: frozen.query,
        candidateCount: frozen.candidateCount,
        results: frozen.results,
        related: frozen.related,
      });
    }
  });

  test("indexed matches full-scan ordered results on all 215 rows", () => {
    const changed = [];
    for (const frozen of oracle.rows) {
      const opts = { limit: RESULT_LIMIT, relatedLimit: RELATED_LIMIT };
      const full = fullScan.searchDetailed(frozen.query, opts);
      const idx = indexed.searchDetailed(frozen.query, opts);
      const fullSer = { results: serializeHits(full.results), related: serializeHits(full.related) };
      const idxSer = { results: serializeHits(idx.results), related: serializeHits(idx.related) };
      if (JSON.stringify(fullSer) !== JSON.stringify(idxSer) || full.meta.candidateCount !== idx.meta.candidateCount) {
        changed.push({
          index: frozen.index,
          query: frozen.query,
          fullC: full.meta.candidateCount,
          indexedC: idx.meta.candidateCount,
        });
      }
    }
    expect(changed).toEqual([]);
  });

  test("adaptive matches full-scan on Software.Land (N=122 < threshold 1500)", () => {
    expect(adaptive.retriever.stats().active).toBe("full-scan");
    const changed = [];
    for (const frozen of oracle.rows) {
      const opts = { limit: RESULT_LIMIT, relatedLimit: RELATED_LIMIT };
      const full = fullScan.searchDetailed(frozen.query, opts);
      const ad = adaptive.searchDetailed(frozen.query, opts);
      if (JSON.stringify(serializeHits(full.results)) !== JSON.stringify(serializeHits(ad.results))) {
        changed.push({ index: frozen.index, query: frozen.query });
      }
    }
    expect(changed).toEqual([]);
  });

  test("unspecified retriever is indexed and matches explicit indexed output", () => {
    const engine = SearchEngine.create({
      schema: {
        title: { type: "text", role: "title" },
        body: { type: "text", role: "body" },
      },
      plugins: [
        morphology({ lemmas: loadJson("lemmas.json") }),
        compileConfiguredConceptPlugin({ configuredConcepts: loadJson("configured-concepts.json") }),
      ],
    });
    expect(engine.retriever.name).toBe("indexed-lexical");
  });

  test("query 2 remains 200FPS then TLS 1.2 Vulnerability on indexed", () => {
    const expected = [
      "200FPS: CSS vs Canvas vs WebGL vs WebGPU",
      "TLS 1.2 Vulnerability",
    ];
    expect(fullScan.search("2", { limit: 2 }).map((h) => h.title)).toEqual(expected);
    expect(indexed.search("2", { limit: 2 }).map((h) => h.title)).toEqual(expected);
    expect(adaptive.search("2", { limit: 2 }).map((h) => h.title)).toEqual(expected);
  });

  test("explicit custom ExperimentalRetriever is unchanged by builtin defaults", async () => {
    const calls = [];
    const custom = {
      name: "custom-probe",
      retrieve(query, index) {
        calls.push(query.raw);
        const doc = index.documents[0];
        return [{ document: doc, retrievalSources: ["exact-title"] }];
      },
    };
    const engine = SearchEngine.create({
      schema: { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } },
      retriever: custom,
      relationshipStrategy: "none",
    });
    await engine.index([
      { id: "only", title: "Only Doc", body: "x" },
      { id: "other", title: "Other", body: "y" },
    ]);
    const hits = engine.search("zzzz-not-a-match", { limit: 5 });
    expect(calls).toEqual(["zzzz-not-a-match"]);
    expect(hits.map((h) => h.id)).toEqual(["only"]);
    expect(engine.retriever.name).toBe("custom-probe");
  });
});
