/**
 * An authored primary topical term is selected on a related concept-to-form
 * edge. A title match stays topical. It is not equivalence, query coverage,
 * or a body occurrence. Alias words are not selected automatically.
 *
 * Indexed and full-scan use the same order. Documents are synthetic.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { HYBRID_CONSTRAINTS, compareConstraint } from "../dist/ranking/constraints.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const concepts = [
  { key: "alpha", aliases: [["beta", "gamma", "delta"]] },
  { key: "beacon", aliases: [["marker"]] },
  { key: "signal", aliases: [["pulse"]] },
  { key: "walk", aliases: [["depth", "walk"]] },
  { key: "minimax", aliases: [["minmax"]] },
];

const relationshipMap = {
  alpha: [
    { to: { form: "delta" }, kind: "related", primaryTerm: true },
    { to: { form: "epsilon" }, kind: "related" },
  ],
  beacon: [{ to: { form: "signal" }, kind: "related", primaryTerm: true }],
  walk: [{ to: { form: "minimax" }, kind: "related" }],
};

const docs = [
  { id: "guide", title: "Alpha Handbook", body: "alpha overview" },
  { id: "repeated", title: "Storage Notes", body: "alpha is stored. alpha is stored again. alpha is stored once more." },
  { id: "single", title: "Aside", body: "alpha once in passing" },
  { id: "primary", title: "Delta Notes", body: "format conversion only" },
  { id: "ordinary", title: "Epsilon Notes", body: "format conversion only" },
  { id: "alias-word", title: "Beta Primer", body: "format conversion only" },
  { id: "mixed", title: "Delta Field Manual", body: "alpha is stored. alpha is stored again." },
  { id: "neighbor", title: "Layout Kit", body: "widgets panels and frames" },
  { id: "tree", title: "Tree Catalog", body: "many trees and branches" },
  { id: "pulse", title: "Pulse Manual", body: "format conversion only" },
  { id: "beacon-repeated", title: "Bench Notes", body: "beacon is set. beacon is set again." },
  { id: "walk-guide", title: "Walk Handbook", body: "walk overview" },
  { id: "walk-repeated", title: "Field Notes", body: "walk is used. walk is used again." },
  { id: "minmax", title: "Minmax Tree", body: "alternating min and max over choices" },
];

function engine(retriever) {
  const authored = compileAuthoredRelevance({
    configuredConcepts: concepts,
    relationshipMap,
    documents: docs,
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
        guide: [{ target: "neighbor", type: "semantic", strength: 0.95, provenance: "embedding" }],
      },
    },
  });
}

function ids(results) {
  return results.map((row) => row.id);
}

function hit(results, id) {
  return results.find((row) => row.id === id);
}

function pair(results, leftId, rightId) {
  const left = hit(results, leftId);
  const right = hit(results, rightId);
  return compareConstraint(
    { document: { id: left.id, title: left.title }, features: left.features },
    { document: { id: right.id, title: right.title }, features: right.features },
    HYBRID_CONSTRAINTS
  );
}

async function searchBoth(query) {
  const indexed = engine("indexed");
  const scanned = engine("full-scan");
  await indexed.index(docs);
  await scanned.index(docs);
  const opts = { limit: 20, explain: true, relationshipStrategy: "hybrid" };
  return {
    indexed: indexed.searchDetailed(query, opts).results,
    scanned: scanned.searchDetailed(query, opts).results,
  };
}

describe("authored primary topical term", () => {
  test("compiles only the selected form as a primary term", () => {
    const authored = compileAuthoredRelevance({ configuredConcepts: concepts, relationshipMap });
    const plugin = authored.plugins.find((item) => item.name === "configured-concepts");
    expect(plugin.topicalPrimaryByKey.get("alpha")).toEqual([["delta"]]);
    expect(plugin.topicalRecallByKey.get("alpha")).toEqual([["delta"], ["epsilon"]]);
    expect(plugin.topicalPrimaryByKey.has("walk")).toBe(false);
  });

  test("rejects primaryTerm off a related form edge", () => {
    const base = { configuredConcepts: concepts };
    expect(() =>
      compileAuthoredRelevance({
        ...base,
        relationshipMap: { alpha: [{ to: { form: "delta" }, kind: "equivalent", primaryTerm: true }] },
      })
    ).toThrow(/primaryTerm/);
    expect(() =>
      compileAuthoredRelevance({
        ...base,
        relationshipMap: { delta: [{ to: { concept: "alpha" }, kind: "related", primaryTerm: true }] },
      })
    ).toThrow(/primaryTerm/);
    expect(() =>
      compileAuthoredRelevance({
        ...base,
        relationshipMap: { guide: [{ to: { document: "neighbor" }, kind: "related", primaryTerm: true }] },
        documents: docs,
      })
    ).toThrow(/primaryTerm/);
    expect(() =>
      compileAuthoredRelevance({
        ...base,
        relationshipMap: { alpha: [{ to: { form: "delta" }, kind: "related", primaryTerm: false }] },
      })
    ).toThrow(/primaryTerm/);
  });

  test("primary-term title beats repeated body and a pure embedding neighbor", async () => {
    const { indexed, scanned } = await searchBoth("alpha");
    expect(ids(indexed)).toEqual(ids(scanned));
    const results = indexed;
    const order = ids(results);
    expect(order.indexOf("guide")).toBeLessThan(order.indexOf("primary"));
    expect(order.indexOf("mixed")).toBeLessThan(order.indexOf("primary"));
    expect(order.indexOf("primary")).toBeLessThan(order.indexOf("repeated"));
    expect(order.indexOf("repeated")).toBeLessThan(order.indexOf("neighbor"));
    expect(order.indexOf("repeated")).toBeLessThan(order.indexOf("ordinary"));
    expect(order.indexOf("ordinary")).toBeLessThan(order.indexOf("single"));
    expect(order).not.toContain("alias-word");
    expect(order).not.toContain("tree");

    const primary = hit(results, "primary");
    expect(primary.features.topicalPrimaryTitleMatch).toBe(true);
    expect(primary.features.topicalRecallTitleMatch).toBe(true);
    expect(primary.features.topicalRecallMatch).toBe(true);
    expect(primary.features.equivalentRecallMatch || false).toBe(false);
    expect(primary.features.queryCoverage || 0).toBe(0);
    expect(primary.features.titleCoverage || 0).toBe(0);
    expect(primary.features.directBodyOccurrenceCount || 0).toBe(0);
    expect(primary.features.bodyLexicalMatch || 0).toBe(0);
    expect(primary.relevanceKind).toBe("direct");
    expect(primary.directClass).toBe("none");
    expect(primary.retrievalSources).toContain("topical-recall");
    expect(primary.retrievalSources).not.toContain("equivalent-recall");

    const ordinary = hit(results, "ordinary");
    expect(ordinary.features.topicalRecallTitleMatch).toBe(true);
    expect(ordinary.features.topicalPrimaryTitleMatch).toBe(false);

    const repeated = hit(results, "repeated");
    expect(repeated.features.directBodyOccurrenceCount).toBeGreaterThanOrEqual(2);
    expect(repeated.features.topicalPrimaryTitleMatch || false).toBe(false);

    const neighbor = hit(results, "neighbor");
    expect(neighbor.relevanceKind).toBe("related");
    expect(neighbor.retrievalSources).toEqual(["relationship"]);

    for (const [left, right] of [
      ["guide", "primary"],
      ["mixed", "primary"],
      ["primary", "repeated"],
      ["primary", "neighbor"],
      ["repeated", "neighbor"],
      ["repeated", "ordinary"],
    ]) {
      const cmp = pair(results, left, right);
      expect(cmp.order).toBe(-1);
      expect(cmp.conflict).toBe(false);
    }
  });

  test("a primary term that names a concept also matches that concept's alias in the title", async () => {
    const { indexed, scanned } = await searchBoth("beacon");
    expect(ids(indexed)).toEqual(ids(scanned));
    const pulse = hit(indexed, "pulse");
    const repeated = hit(indexed, "beacon-repeated");
    expect(pulse.features.topicalPrimaryTitleMatch).toBe(true);
    expect(pulse.features.equivalentRecallMatch || false).toBe(false);
    expect(pulse.features.directBodyOccurrenceCount || 0).toBe(0);
    expect(ids(indexed).indexOf("pulse")).toBeLessThan(ids(indexed).indexOf("beacon-repeated"));
    expect(repeated.features.directBodyOccurrenceCount).toBeGreaterThanOrEqual(2);
    const cmp = pair(indexed, "pulse", "beacon-repeated");
    expect(cmp.order).toBe(-1);
    expect(cmp.conflict).toBe(false);
  });

  test("a non-primary concept relationship retrieves the alias title behind repeated query evidence", async () => {
    const { indexed, scanned } = await searchBoth("walk");
    expect(ids(indexed)).toEqual(ids(scanned));
    const order = ids(indexed);
    expect(order).toContain("minmax");
    expect(order).not.toContain("tree");
    expect(order.indexOf("walk-repeated")).toBeLessThan(order.indexOf("minmax"));
    const minmax = hit(indexed, "minmax");
    expect(minmax.features.topicalRecallTitleMatch).toBe(true);
    expect(minmax.features.topicalPrimaryTitleMatch).toBe(false);
    expect(minmax.features.equivalentRecallMatch || false).toBe(false);
    expect(minmax.features.directBodyOccurrenceCount || 0).toBe(0);
    expect(minmax.retrievalSources).toContain("topical-recall");
    const cmp = pair(indexed, "walk-repeated", "minmax");
    expect(cmp.order).toBe(-1);
    expect(cmp.conflict).toBe(false);

    const reverse = await searchBoth("minimax");
    expect(ids(reverse.indexed)).toEqual(ids(reverse.scanned));
    expect(ids(reverse.indexed)).toContain("minmax");
    expect(ids(reverse.indexed)).not.toContain("walk-guide");
    expect(ids(reverse.indexed)).not.toContain("walk-repeated");
  });
});
