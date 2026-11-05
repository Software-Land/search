/**
 * A zero-term related neighbor stays behind a weak direct with at least two
 * compiled occurrences. Indexed and full-scan use the same order. Synthetic
 * documents only.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { HYBRID_CONSTRAINTS, compareConstraint } from "../dist/ranking/constraints.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const configuredDocs = [
  { id: "guide", title: "Auth", body: "authentication overview for the guide" },
  { id: "repeated", title: "Credentials", body: "authentication is checked. authentication is checked again." },
  { id: "single", title: "Session Notes", body: "authentication once in passing" },
  { id: "mixed", title: "Session Review", body: "authentication is checked. authentication is checked again." },
  { id: "neighbor", title: "Layout Kit", body: "widgets panels and frames" },
  { id: "equiv", title: "Login Kit", body: "login then login again" },
  { id: "topical", title: "Roles Primer", body: "format conversion notes" },
];

const phraseDocs = [
  { id: "guide", title: "Delta Token", body: "delta token overview" },
  { id: "repeated", title: "Field Notes", body: "delta token appears. delta token appears again." },
  { id: "single", title: "Aside", body: "delta once without the companion word" },
  { id: "neighbor", title: "Layout Kit", body: "widgets panels and frames" },
];

function configuredEngine(retriever) {
  const authored = compileAuthoredRelevance({
    configuredConcepts: [{ key: "auth", aliases: [["authentication"]] }],
    relationshipMap: {
      auth: [
        { to: { form: "login" }, kind: "equivalent" },
        { to: { form: "roles" }, kind: "related" },
      ],
    },
  });
  return SearchEngine.create({
    schema,
    plugins: [morphology(), ...authored.plugins],
    retriever,
    relationshipStrategy: "hybrid",
    documentRelationships: {
      format: "search-relationships",
      version: 1,
      relationships: {
        guide: [
          { target: "neighbor", type: "semantic", strength: 0.95, provenance: "embedding" },
          { target: "equiv", type: "semantic", strength: 0.5, provenance: "embedding" },
          { target: "mixed", type: "semantic", strength: 0.4, provenance: "embedding" },
        ],
      },
    },
  });
}

function phraseEngine(retriever) {
  return SearchEngine.create({
    schema,
    plugins: [morphology()],
    retriever,
    relationshipStrategy: "hybrid",
    documentRelationships: {
      format: "search-relationships",
      version: 1,
      relationships: {
        guide: [{ target: "neighbor", type: "semantic", strength: 0.95, provenance: "embedding" }],
      },
    },
  });
}

function pair(results, leftId, rightId) {
  const left = results.find((row) => row.id === leftId);
  const right = results.find((row) => row.id === rightId);
  return compareConstraint(
    { document: { id: left.id, title: left.title }, features: left.features },
    { document: { id: right.id, title: right.title }, features: right.features },
    HYBRID_CONSTRAINTS
  );
}

function expectRepeatedBeforeNeighbor(results) {
  const ids = results.map((row) => row.id);
  expect(ids.indexOf("guide")).toBe(0);
  expect(ids.indexOf("repeated")).toBeLessThan(ids.indexOf("neighbor"));
  expect(ids.indexOf("neighbor")).toBeLessThan(ids.indexOf("single"));
  expect(ids).toContain("neighbor");
  const repeated = results.find((row) => row.id === "repeated");
  const neighbor = results.find((row) => row.id === "neighbor");
  const single = results.find((row) => row.id === "single");
  expect(repeated.directClass).toBe("weak");
  expect(repeated.features.directBodyOccurrenceCount).toBeGreaterThanOrEqual(2);
  expect(neighbor.relevanceKind).toBe("related");
  expect(neighbor.retrievalSources).toEqual(["relationship"]);
  expect(neighbor.features.directBodyOccurrenceCount || 0).toBe(0);
  expect(neighbor.features.bodyLexicalMatch || 0).toBe(0);
  expect(single.features.directBodyOccurrenceCount).toBe(1);
  const cmp = pair(results, "repeated", "neighbor");
  expect(cmp.order).toBe(-1);
  expect(cmp.conflict).toBe(false);
  expect(cmp.applied.some((row) => row.id === "related-over-weak-direct" && row.result === "A>B")).toBe(true);
  const signs = new Set(cmp.applied.map((row) => row.result));
  expect(signs.size).toBe(1);
}

describe("repeated direct evidence over a zero-term neighbor", () => {
  test("configured unigram queries agree on indexed and full-scan", async () => {
    const orders = [];
    for (const retriever of ["full-scan", "indexed"]) {
      const engine = configuredEngine(retriever);
      await engine.index(configuredDocs);
      const detailed = engine.searchDetailed("auth", { limit: 20, explain: true });
      expectRepeatedBeforeNeighbor(detailed.results);
      const topical = detailed.results.find((row) => row.id === "topical");
      const single = detailed.results.find((row) => row.id === "single");
      const mixed = detailed.results.find((row) => row.id === "mixed");
      const equiv = detailed.results.find((row) => row.id === "equiv");
      expect(topical.features.topicalRecallTitleMatch).toBe(true);
      expect(topical.retrievalSources).toEqual(["topical-recall"]);
      expect(detailed.results.map((row) => row.id).indexOf("topical")).toBeLessThan(
        detailed.results.map((row) => row.id).indexOf("single")
      );
      expect(pair(detailed.results, "topical", "single").conflict).toBe(false);
      expect(mixed.relevanceKind).not.toBe("related");
      expect(mixed.retrievalSources).toEqual(expect.arrayContaining(["relationship"]));
      expect(mixed.features.directBodyOccurrenceCount).toBeGreaterThanOrEqual(2);
      expect(detailed.results.map((row) => row.id).indexOf("mixed")).toBeLessThan(
        detailed.results.map((row) => row.id).indexOf("neighbor")
      );
      expect(equiv.retrievalSources).toEqual(expect.arrayContaining(["equivalent-recall"]));
      expect(equiv.features.equivalentRecallMatch).toBe(true);
      expect(detailed.results.map((row) => row.id).indexOf("equiv")).toBeLessThan(
        detailed.results.map((row) => row.id).indexOf("repeated")
      );
      const equivCmp = pair(detailed.results, "repeated", "equiv");
      expect(equivCmp.applied.some((row) => row.id === "related-over-weak-direct" && row.result === "A>B")).toBe(false);
      orders.push(detailed.results.map((row) => row.id));
    }
    expect(orders[0]).toEqual(orders[1]);
  });

  test("a multi-token query keeps the same indexed and full-scan order", async () => {
    const orders = [];
    for (const retriever of ["full-scan", "indexed"]) {
      const engine = phraseEngine(retriever);
      await engine.index(phraseDocs);
      const detailed = engine.searchDetailed("delta token", { limit: 20, explain: true });
      expectRepeatedBeforeNeighbor(detailed.results);
      orders.push(detailed.results.map((row) => row.id));
    }
    expect(orders[0]).toEqual(orders[1]);
  });
});
