/**
 * Indexed retrieval must keep ranking-critical winners when ordinary
 * candidateLimit is smaller than the legitimate match set.
 *
 * These tests fail if the full-scan winner is dropped from the indexed pool.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/relationships/configuredConcepts.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, "fixtures", "software-land");
const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
}

function shortLiteralCorpus(matchN, backgroundN = 80) {
  const docs = [
    {
      id: "winner-short-literal",
      title: "Zzwinner unique ranking title analog",
      body: "unrelated body without the query token repeated",
    },
  ];
  for (let i = 0; i < matchN; i += 1) {
    docs.push({
      id: `flood-${String(i).padStart(5, "0")}`,
      title: `Unrelated filler ${i}`,
      body: Array.from({ length: 24 }, () => "zz").join(" "),
    });
  }
  for (let i = 0; i < backgroundN; i += 1) {
    docs.push({
      id: `bg-${String(i).padStart(5, "0")}`,
      title: `Background document ${i}`,
      body: "lorem ipsum dolor sit amet unrelated content",
    });
  }
  return docs;
}

async function pair(docs, extra = {}) {
  const plugins = extra.plugins || [
    morphology({ lemmas: extra.lemmas || {} }),
    compileConfiguredConceptPlugin({ configuredConcepts: extra.configuredConcepts || [] }),
  ];
  const common = {
    schema,
    plugins,
    documentRelationships: extra.relationships || null,
    relationshipStrategy: extra.relationshipStrategy || "none",
  };
  const full = SearchEngine.create({ ...common, retriever: "full-scan" });
  const indexed = SearchEngine.create({ ...common, retriever: "indexed", candidateLimit: extra.candidateLimit ?? 200 });
  await full.index(docs);
  await indexed.index(docs);
  return { full, indexed };
}

describe("indexed retrieval under candidate-budget pressure", () => {
  test("full-scan short-literal winner survives indexed k=200 body flood", async () => {
    const docs = shortLiteralCorpus(250);
    const { full, indexed } = await pair(docs);
    const fullTop = full.search("zz", { limit: 1 })[0];
    const indexedTop = indexed.search("zz", { limit: 1 })[0];
    const indexedDetailed = indexed.searchDetailed("zz", { limit: 1, candidateLimit: 200 });
    expect(fullTop.id).toBe("winner-short-literal");
    expect(indexedTop.id).toBe(fullTop.id);
    expect(indexedDetailed.meta.candidateTitles).toContain(fullTop.title);
  });

  test("query 2 still returns 200FPS first when Software.Land is body-flooded", async () => {
    const originals = attachLexicalFrequency(loadJson("documents.json"), loadJson("lexical-frequency.json"));
    const distractors = [];
    for (let i = 0; i < 400; i += 1) {
      distractors.push({
        id: `sl-flood-${String(i).padStart(5, "0")}`,
        title: "Unrelated filler notes",
        body: "2 2 2 2 2 testing search index document query title body token",
      });
    }
    const { full, indexed } = await pair([...originals, ...distractors], {
      lemmas: loadJson("lemmas.json"),
      configuredConcepts: loadJson("configured-concepts.json"),
      relationships: loadJson("relationships.json"),
      relationshipStrategy: "hybrid",
    });
    const fullTop = full.search("2", { limit: 1 })[0];
    const indexedTop = indexed.search("2", { limit: 1, candidateLimit: 200 })[0];
    expect(fullTop.title).toBe("200FPS: CSS vs Canvas vs WebGL vs WebGPU");
    expect(indexedTop.id).toBe(fullTop.id);
    expect(indexed.searchDetailed("2", { limit: 2, candidateLimit: 200 }).meta.candidateTitles).toEqual(
      expect.arrayContaining(["200FPS: CSS vs Canvas vs WebGL vs WebGPU", "TLS 1.2 Vulnerability"])
    );
  });
});
