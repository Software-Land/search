/**
 * Stage 2C: compact compiled documents must match the fat IndexedDocument
 * feature/search surface. Heap numbers are observational, not CI gates.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SearchEngine,
  morphology,
} from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { extractFeatures } from "../dist/features.js";
import {
  compileLexicalIndex,
  loadLexicalIndex,
} from "../dist/lexicalIndex.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "software-land");
const load = (name) => JSON.parse(fs.readFileSync(path.join(fixture, name), "utf8"));
const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

function publicHits(value) {
  return {
    results: value.results,
    related: value.related,
  };
}

describe("compact compiled lexical runtime", () => {
  const documents = attachLexicalFrequency(load("documents.json"), load("lexical-frequency.json"));
  const plugins = [
    morphology({ lemmas: load("lemmas.json") }),
    compileConfiguredConceptPlugin({ configuredConcepts: load("configured-concepts.json") }),
  ];
  const relationships = load("relationships.json");
  const queries = ["2", "machine l", "the", "vpn", "nfc", "tls 1.2", "virtual private network"];
  let artifact;
  let fat;
  let compact;
  let fallback;
  let precompiled;

  beforeAll(async () => {
    artifact = compileLexicalIndex(documents, { schema, plugins });
    fat = SearchEngine.create({
      schema,
      plugins,
      documentRelationships: relationships,
      relationshipStrategy: "hybrid",
      retriever: "full-scan",
    });
    compact = SearchEngine.create({
      schema,
      plugins,
      documentRelationships: relationships,
      relationshipStrategy: "hybrid",
      retriever: "indexed",
      lexicalIndex: artifact,
    });
    fallback = SearchEngine.create({
      schema,
      plugins,
      documentRelationships: relationships,
      relationshipStrategy: "hybrid",
      retriever: "indexed",
    });
    await fat.index(documents);
    await compact.index(documents);
    await fallback.index(documents);
    precompiled = loadLexicalIndex(artifact, documents, schema, plugins);
  }, 60_000);

  test("compiled documents keep packed token/set/position views", () => {
    const doc = precompiled.documents[0];
    expect(Array.isArray(doc.titleTokens)).toBe(true);
    expect(doc.titleTokens.length).toBeGreaterThan(0);
    expect(doc.titleTokenSet instanceof Set).toBe(false);
    expect(doc.bodyTokenSet instanceof Set).toBe(false);
    expect(doc.bodyTokenPositions instanceof Map).toBe(false);
    expect(precompiled.titleTokenSet instanceof Set).toBe(true);
    expect(typeof doc.titleTokenSet.has).toBe("function");
    expect(doc.body).toBe("");
    expect(doc.raw.body).toBe("");
  });

  test("fallback indexed hydration uses the same compact query runtime", () => {
    const doc = fallback._index.documents[0];
    expect(doc.titleTokenSet instanceof Set).toBe(false);
    expect(doc.bodyTokenPositions instanceof Map).toBe(false);
    expect(fat._index.documents[0].titleTokenSet instanceof Set).toBe(true);
  });

  test("compact, fallback, and full-scan public results stay identical", () => {
    const opts = { limit: 10, relatedLimit: 5, relationshipStrategy: "hybrid" };
    for (const query of queries) {
      const expected = publicHits(fat.searchDetailed(query, opts));
      expect(publicHits(compact.searchDetailed(query, opts))).toEqual(expected);
      expect(publicHits(fallback.searchDetailed(query, opts))).toEqual(expected);
    }
  });

  test("FeatureVector matches fat full-scan documents on compact views", () => {
    for (const queryText of queries) {
      const query = fat._prepareQuery(queryText);
      for (let i = 0; i < fat._index.documents.length; i += 1) {
        expect(extractFeatures(query, precompiled.documents[i])).toEqual(
          extractFeatures(query, fat._index.documents[i])
        );
      }
    }
  });

  test("Stage 2A/2B counters remain observable on the compact path", () => {
    const detailed = compact._searchDetailedSync("the", { limit: 10, relatedLimit: 0 }, false);
    expect(typeof detailed.meta.postingEntriesVisited).toBe("number");
    expect(typeof detailed.meta.postingEntriesSkipped).toBe("number");
    expect(typeof detailed.meta.documentsFullyEvaluated).toBe("number");
    expect(typeof detailed.meta.documentsBoundRejected).toBe("number");
    expect(detailed.meta.postingEntriesVisited).toBeGreaterThan(0);
  });

  test("supplied artifact envelope is released after index()", () => {
    expect(compact.lexicalIndex).toBeNull();
    expect(compact.loadedLexicalIndex).toEqual({
      fingerprint: artifact.corpus.fingerprint,
      analyzer: artifact.compatibility.analyzer,
      schema: artifact.compatibility.schema,
    });
  });
});
