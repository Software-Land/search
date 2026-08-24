#!/usr/bin/env node
/**
 * Freeze current Software.Land query→result orderings for all 215 historical rows.
 * Run from repo root after `npm run build`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology, dictionary } from "../dist/index.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "test", "fixtures", "software-land");

function load(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
}

const documents = load("documents.json");
const historical = load("historical-scenarios.json");
const engine = SearchEngine.create({
  schema: { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } },
  plugins: [
    morphology({ lemmas: load("lemmas.json") }),
    dictionary({ entries: load("dictionary.json") }),
  ],
  relationships: load("relationships.json"),
  relationshipStrategy: "hybrid",
  retriever: "full-scan",
});
await engine.index(attachLexicalFrequency(documents, load("lexical-frequency.json")));

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

const rows = historical.rows.map((row) => {
  const detailed = engine.searchDetailed(row.query, {
    limit: RESULT_LIMIT,
    relatedLimit: RELATED_LIMIT,
  });
  return {
    index: row.index,
    query: row.query,
    disposition: row.disposition,
    candidateCount: detailed.meta?.candidateCount ?? null,
    results: serializeHits(detailed.results),
    related: serializeHits(detailed.related),
  };
});

const out = {
  format: "software-land-query-result-oracle",
  version: 1,
  note: "Identity freeze after configured-sequence intent: unique complete-query key/expansion/alias alignment projects canonical expansion as lexical ranking intent while preserving typed tokens. Distinct keys fail closed. Package version remains 0.5.0. Not a Core ranking contract.",
  head: "d598451db4098ab79d4f226b82683a975d2b9b78",
  resultLimit: RESULT_LIMIT,
  relatedLimit: RELATED_LIMIT,
  documentCount: documents.length,
  rowCount: rows.length,
  rows,
};

const dest = path.join(FIXTURE, "query-result-oracle.json");
writeFileSync(dest, `${JSON.stringify(out)}\n`);
console.log(`wrote ${dest} rows=${rows.length} queries=${new Set(rows.map((r) => r.query)).size}`);
