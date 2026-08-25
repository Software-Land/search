/**
 * Significant-symbol spoken retrieval. Synthetic only.
 * Reuses the existing + / # / * operator map; does not add synonyms.
 */
import { SearchEngine, morphology, synonyms } from "../dist/index.js";
import { analyzeQuery } from "../dist/analyze.js";
import { extractFeatures } from "../dist/features.js";
import { coverageConcepts, conceptMatchesTitle } from "../dist/retrieve.js";
import { buildIndex } from "../dist/indexDocuments.js";
import {
  tokenize,
  spokenSignificantSymbolTokens,
  speakSignificantSymbols,
} from "../dist/text.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const docs = [
  { id: "astar", title: "A-Star Pathfinding", body: "heuristic graph search notes" },
  { id: "star-only", title: "Star Charts", body: "constellation atlas" },
  { id: "path-only", title: "Pathfinding Basics", body: "grids and graphs without heuristics" },
  { id: "plus-doc", title: "C Plus Plus Primer", body: "language notes" },
  { id: "unrelated", title: "Gardening Tips", body: "tomatoes and soil" },
];

function ids(hits) {
  return hits.map((hit) => hit.id);
}

function plugins({ map } = {}) {
  const list = [morphology()];
  if (map) list.push(synonyms(map));
  return list;
}

async function engine({ retriever = "indexed", map } = {}) {
  const e = SearchEngine.create({
    schema,
    plugins: plugins({ map }),
    retriever,
    relationshipStrategy: "none",
  });
  await e.index(docs);
  return e;
}

describe("spoken significant-symbol map", () => {
  test("existing operator vocabulary is plus, sharp, and star", () => {
    expect(speakSignificantSymbols("+")).toBe(" plus ");
    expect(speakSignificantSymbols("#")).toBe(" sharp ");
    expect(speakSignificantSymbols("*")).toBe(" star ");
    expect(spokenSignificantSymbolTokens("a*")).toEqual(["a", "star"]);
    expect(spokenSignificantSymbolTokens("A*")).toEqual(["a", "star"]);
    expect(spokenSignificantSymbolTokens("c++")).toEqual(["c", "plus", "plus"]);
    expect(spokenSignificantSymbolTokens("c#")).toEqual(["c", "sharp"]);
    expect(spokenSignificantSymbolTokens("foo*")).toEqual(["foo", "star"]);
    expect(spokenSignificantSymbolTokens("*foo")).toEqual(["star", "foo"]);
  });

  test("bare operators and ordinary punctuation are not spoken-expanded", () => {
    expect(spokenSignificantSymbolTokens("*")).toBeNull();
    expect(spokenSignificantSymbolTokens("**")).toBeNull();
    expect(spokenSignificantSymbolTokens("+")).toBeNull();
    expect(spokenSignificantSymbolTokens("++")).toBeNull();
    expect(spokenSignificantSymbolTokens("#")).toBeNull();
    expect(spokenSignificantSymbolTokens("foo.bar")).toBeNull();
    expect(spokenSignificantSymbolTokens("foo/bar")).toBeNull();
    expect(spokenSignificantSymbolTokens("hello!")).toBeNull();
    expect(spokenSignificantSymbolTokens("x-y")).toBeNull();
    expect(spokenSignificantSymbolTokens("O(1)")).toBeNull();
  });
});

describe("query tokenize vs spoken projection", () => {
  test("tokenizer preserves * so a* remains one typed token", () => {
    expect(tokenize("a*")).toEqual(["a*"]);
    expect(tokenize("*")).toEqual(["*"]);
    expect(tokenize("**")).toEqual(["**"]);
    expect(tokenize("foo*")).toEqual(["foo*"]);
    expect(tokenize("*foo")).toEqual(["*foo"]);
  });

  test("tokenizer still strips + and # and ordinary separators", () => {
    expect(tokenize("c++")).toEqual(["c"]);
    expect(tokenize("c#")).toEqual(["c"]);
    expect(tokenize("foo.bar")).toEqual(["foo", "bar"]);
    expect(tokenize("foo/bar")).toEqual(["foo", "bar"]);
    expect(tokenize("hello!")).toEqual(["hello"]);
    expect(tokenize("x-y")).toEqual(["x", "y"]);
  });

  test("typed a* keeps surface identity and adds spoken alternative", () => {
    const q = analyzeQuery("a*", { plugins: [morphology()] });
    expect(q.raw).toBe("a*");
    expect(q.tokens).toHaveLength(1);
    expect(q.tokens[0].surface).toBe("a*");
    expect(q.tokens[0].normalized).toBe("a*");
    expect(q.tokens[0].lemma).toBe("a*");
    expect(q.tokens[0].sources).toEqual(expect.arrayContaining(["surface", "significant-symbol"]));
    expect(q.alternatives).toEqual([
      { tokens: ["a", "star"], source: "significant-symbol", confidence: 1 },
    ]);
    const terms = q.concepts.filter((c) => c.kind === "term");
    expect(terms).toHaveLength(1);
    expect(terms[0].id).toBe("a*");
    expect(terms[0].forms).toEqual(expect.arrayContaining(["a*", "a star"]));
    expect(terms[0].forms.filter((form) => form === "a star")).toHaveLength(1);
    expect(coverageConcepts(q, q.concepts)).toHaveLength(1);
  });

  test("search-equivalence astar may coexist on the same typed concept", () => {
    const q = analyzeQuery("a*", { plugins: plugins({ map: { "a*": ["astar"] } }) });
    expect(q.tokens[0].surface).toBe("a*");
    expect(q.tokens[0].normalized).toBe("a*");
    const terms = q.concepts.filter((c) => c.kind === "term");
    expect(terms).toHaveLength(1);
    expect(terms[0].forms).toEqual(expect.arrayContaining(["a*", "astar", "a star"]));
    expect(q.synonymRecall).toEqual([{ source: "a*", target: "astar" }]);
    expect(q.alternatives.some((alt) => alt.source === "significant-symbol")).toBe(true);
    expect(coverageConcepts(q, q.concepts)).toHaveLength(1);
  });

  test("unsupported query punctuation does not mint spoken alternatives", () => {
    for (const query of ["*", "**", "foo.bar", "foo/bar", "hello!", "x-y"]) {
      const q = analyzeQuery(query, { plugins: [morphology()] });
      expect(q.alternatives.filter((alt) => alt.source === "significant-symbol")).toEqual([]);
      expect(q.tokens.every((tok) => !tok.sources.includes("significant-symbol"))).toBe(true);
    }
  });

  test("c++ is not a significant-symbol query token after tokenize", () => {
    const q = analyzeQuery("c++", { plugins: [morphology()] });
    expect(q.tokens.map((t) => t.normalized)).toEqual(["c"]);
    expect(q.alternatives.filter((alt) => alt.source === "significant-symbol")).toEqual([]);
  });
});

describe("spoken form reaches retrieval", () => {
  test("a* retrieves an A-Star-style title through the spoken phrase", async () => {
    const indexed = await engine({ retriever: "indexed" });
    const full = await engine({ retriever: "full-scan" });
    for (const eng of [indexed, full]) {
      const detailed = eng.searchDetailed("a*", { limit: 10, explain: true });
      expect(ids(eng.search("a*", { limit: 10 }))).toEqual(ids(detailed.results));
      expect(detailed.results[0].id).toBe("astar");
      expect(detailed.results[0].title).toBe("A-Star Pathfinding");
      expect(detailed.results[0].retrievalSources).toEqual(expect.arrayContaining(["title-token"]));
      expect(ids(detailed.results)).not.toContain("star-only");
      expect(detailed.meta.query.alternatives).toEqual(
        expect.arrayContaining([{ tokens: ["a", "star"], source: "significant-symbol", confidence: 1 }])
      );
      expect(detailed.results[0].features.queryCoverage).toBe(1);
      expect(detailed.results[0].features.queryTokenCount).toBe(1);
    }
    expect(indexed.searchDetailed("a*").meta.rawDocumentScans).toBe(0);
    expect(ids(indexed.search("a*"))).toEqual(ids(full.search("a*")));
  });

  test("equivalent representations do not inflate queryCoverage", () => {
    const list = plugins({ map: { "a*": ["astar"] } });
    const index = buildIndex(docs, schema, list);
    const q = analyzeQuery("a*", { plugins: list });
    expect(coverageConcepts(q, q.concepts)).toHaveLength(1);
    const astar = index.documents.find((d) => d.id === "astar");
    const starOnly = index.documents.find((d) => d.id === "star-only");
    const astarFeat = extractFeatures(q, astar);
    const starFeat = extractFeatures(q, starOnly);
    expect(astarFeat.queryCoverage).toBe(1);
    expect(astarFeat.queryTokenCount).toBe(1);
    expect(astarFeat.synonymRecallFormCount || 0).toBe(0);
    expect(starFeat.queryCoverage).toBe(0);
    expect(conceptMatchesTitle(q.concepts[0], astar)).toBe("exact");
    expect(conceptMatchesTitle(q.concepts[0], starOnly)).toBeNull();
  });
});
