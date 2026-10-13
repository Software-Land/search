/**
 * A typed prefix of a corpus surface term is not an edit-distance typo.
 * `index` prefixes `indexed` / `indexing` even when those words are body-only
 * and `ide` is a nearer configured key. Adding another token must not turn
 * that prefix into concept occupancy.
 */
import { morphology, SearchEngine } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/relationships/configuredConcepts.js";
import { analyzeQuery } from "../dist/query/analyze.js";

const schema = {
  title: { type: "text", role: "title" },
  summary: { type: "text", role: "summary" },
  body: { type: "text", role: "body" },
};

const concepts = [
  { key: "ide", aliases: [["integrated", "development", "environment"]] },
];

const PROGRESSION = [
  "binary",
  "binary ind",
  "binary index",
  "binary index ",
  "binary index t",
  "binary index tr",
  "binary index tre",
  "binary index tree",
  "binary indexed",
  "binary indexed t",
  "binary indexed tree",
  "bit",
  "fenwick",
];

function plugins() {
  return [
    morphology(),
    compileConfiguredConceptPlugin({ configuredConcepts: concepts }),
  ];
}

function documents() {
  const docs = [
    {
      id: "fenwick",
      title: "Fenwick Tree",
      summary: "prefix sums and binary indexing",
      body: "a fenwick tree also called a binary indexed tree bit maintains partial sums",
    },
    {
      id: "zebra",
      title: "Zebra Migration",
      summary: "herds",
      body: "zebra migration crosses open grassland",
    },
    {
      id: "secure",
      title: "Secure Systems",
      summary: "security",
      body: "secure systems resist tampering",
    },
  ];
  for (let i = 0; i < 12; i += 1) {
    docs.push({
      id: `ide-${i}`,
      title: `IDE Reference ${i}`,
      summary: "developer tools",
      body: "an ide is an integrated development environment for editing code",
    });
  }
  for (let i = 0; i < 8; i += 1) {
    docs.push({
      id: `binary-${i}`,
      title: `Binary Format ${i}`,
      summary: "encoding",
      body: "binary serialization for service payloads",
    });
  }
  return docs;
}

function rankOf(rows, title) {
  const idx = rows.findIndex((row) => row.title === title);
  return idx < 0 ? null : idx + 1;
}

describe("surface prefixes are not corrected into configured keys", () => {
  test("index stays index when it prefixes a body term and ide is distance 2", () => {
    const q = analyzeQuery("binary index t", {
      plugins: plugins(),
      lexicon: ["binary", "tree", "developer", "ide"],
      prefixLexicon: ["binary", "tree", "developer", "ide", "indexed", "indexing"],
    });
    expect(q.tokens.map((tok) => tok.normalized)).toEqual(["binary", "index", "t"]);
    expect(q.tokens[1].sources).not.toContain("typo-correction");
    expect(q.concepts.some((concept) => concept.id === "ide" && concept.kind === "configured-concept")).toBe(
      false
    );
  });

  test("a non-prefix misspelling still corrects against the title lexicon", () => {
    const q = analyzeQuery("securr", {
      plugins: [morphology()],
      lexicon: ["secure"],
      prefixLexicon: ["secure", "indexed", "indexing"],
    });
    expect(q.tokens[0].normalized).toBe("secure");
    expect(q.tokens[0].sources).toContain("typo-correction");
  });

  test.each(["full-scan", "indexed"])(
    "%s keeps Fenwick Tree in the visible top 10 through the typing progression",
    async (retriever) => {
      const engine = SearchEngine.create({
        schema,
        plugins: plugins(),
        retriever,
      });
      const docs = documents();
      await engine.index(docs);
      const prepared = engine._prepareQuery("binary index t");
      expect(prepared.tokens.map((tok) => tok.normalized)).toEqual(["binary", "index", "t"]);
      expect(prepared.concepts.some((concept) => concept.id === "ide" && concept.kind === "configured-concept")).toBe(
        false
      );

      for (const query of PROGRESSION) {
        const rows = engine.search(query, { limit: 10, resultCollector: "complete-interpretation" });
        const rank = rankOf(rows, "Fenwick Tree");
        expect(rank).not.toBeNull();
        expect(rank).toBeLessThanOrEqual(10);
      }

      const ide = engine.search("ide", { limit: 10, resultCollector: "complete-interpretation" });
      expect(ide[0].title.startsWith("IDE Reference")).toBe(true);
      expect(rankOf(ide, "Fenwick Tree")).toBeNull();

      const zebra = engine.search("zebra migration", {
        limit: 10,
        resultCollector: "complete-interpretation",
      });
      expect(zebra.map((row) => row.title)).toContain("Zebra Migration");
      expect(rankOf(zebra, "Fenwick Tree")).toBeNull();
    }
  );
});
