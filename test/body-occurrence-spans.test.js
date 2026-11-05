/**
 * One body span is one occurrence even when several aliases or equivalent
 * forms match it through surface tokens and lemmas. Distinct spans still count.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { directBodyOccurrenceCount, equivalentRecallBodyOccurrenceCount } from "../dist/retrieval/retrieve.js";
import { HYBRID_CONSTRAINTS, compareConstraint } from "../dist/ranking/constraints.js";

const SINGULAR = ["large", "language", "model"];
const PLURAL = ["large", "language", "models"];
const SPAN = {
  bodyTokens: ["large", "language", "models"],
  bodyLemmas: ["large", "language", "model"],
};

function directQuery(aliases) {
  return {
    concepts: [
      {
        id: "llm",
        kind: "configured-concept",
        aliases,
        forms: ["llm"],
      },
    ],
  };
}

function equivalentQuery(forms) {
  return {
    equivalentRecall: forms.map((form) => ({ source: "llm", target: form })),
    concepts: forms.map((form) => ({
      id: form,
      kind: "term",
      provenance: "synonym",
      forms: [form],
    })),
  };
}

function doc(tokens, lemmas = tokens) {
  return { bodyTokens: tokens, bodyLemmas: lemmas };
}

function repeatedTokens(times) {
  const tokens = [];
  const lemmas = [];
  for (let i = 0; i < times; i++) {
    tokens.push(...SPAN.bodyTokens);
    lemmas.push(...SPAN.bodyLemmas);
  }
  return doc(tokens, lemmas);
}

describe("body occurrence spans", () => {
  test("singular and plural aliases count one surface/lemma span once, in either order", () => {
    const forward = [SINGULAR, PLURAL];
    const reverse = [PLURAL, SINGULAR];
    expect(directBodyOccurrenceCount(directQuery([SINGULAR]), SPAN)).toBe(1);
    expect(directBodyOccurrenceCount(directQuery([PLURAL]), SPAN)).toBe(1);
    expect(directBodyOccurrenceCount(directQuery(forward), SPAN)).toBe(1);
    expect(directBodyOccurrenceCount(directQuery(reverse), SPAN)).toBe(1);
    expect(equivalentRecallBodyOccurrenceCount(equivalentQuery(["large language model"]), SPAN)).toBe(1);
    expect(equivalentRecallBodyOccurrenceCount(equivalentQuery(["large language models"]), SPAN)).toBe(1);
    expect(equivalentRecallBodyOccurrenceCount(equivalentQuery(["large language model", "large language models"]), SPAN)).toBe(1);
    expect(equivalentRecallBodyOccurrenceCount(equivalentQuery(["large language models", "large language model"]), SPAN)).toBe(1);
  });

  test("separate and adjacent spans still count, and a covered token is not counted again", () => {
    const both = [SINGULAR, PLURAL];
    expect(directBodyOccurrenceCount(directQuery(both), repeatedTokens(2))).toBe(2);
    expect(equivalentRecallBodyOccurrenceCount(equivalentQuery(["large language model", "large language models"]), repeatedTokens(2))).toBe(2);
    const phraseAndToken = [PLURAL, ["models"]];
    expect(directBodyOccurrenceCount(directQuery(phraseAndToken), SPAN)).toBe(1);
    const extra = doc(
      ["large", "language", "models", "other", "models"],
      ["large", "language", "model", "other", "model"]
    );
    // "models" is a one-token member of the longer peer form, so body matching
    // does not treat it as configured-concept evidence even outside the phrase.
    expect(directBodyOccurrenceCount(directQuery(phraseAndToken), extra)).toBe(1);
    expect(directBodyOccurrenceCount(directQuery([["language", "models"], PLURAL]), SPAN)).toBe(1);
    const component = [["large", "language", "model"], ["model"]];
    expect(directBodyOccurrenceCount(directQuery(component), doc(["llm", "model"]))).toBe(1);
    expect(directBodyOccurrenceCount(directQuery(component), doc(["model", "model"]))).toBe(0);
    expect(directBodyOccurrenceCount(directQuery(component), doc(["llm", "llm"]))).toBe(2);
    expect(directBodyOccurrenceCount(directQuery(component), doc(
      ["large", "language", "model", "large", "language", "model"],
      ["large", "language", "model", "large", "language", "model"]
    ))).toBe(2);
    expect(directBodyOccurrenceCount(directQuery([["model"]]), doc(["model", "model"]))).toBe(2);
    expect(directBodyOccurrenceCount(
      { concepts: [{ id: "for", kind: "term", forms: ["for"] }] },
      doc(["for", "loops", "for"])
    )).toBe(2);
    expect(directBodyOccurrenceCount(
      { concepts: [{ id: "loop", kind: "configured-concept", aliases: [["for"]], forms: ["loop"] }] },
      doc(["for", "for"])
    )).toBe(0);
    expect(directBodyOccurrenceCount(
      { concepts: [{ id: "loop", kind: "configured-concept", aliases: [["for"]], forms: ["loop"] }] },
      doc(["loop", "for"])
    )).toBe(1);
    expect(directBodyOccurrenceCount(
      { concepts: [{ id: "for", kind: "configured-concept", aliases: [["the"]], forms: ["for"] }] },
      doc(["for", "for"])
    )).toBe(2);
    expect(directBodyOccurrenceCount(
      { concepts: [{ id: "iot", kind: "configured-concept", aliases: [["internet", "of", "things"]], forms: ["iot"] }] },
      doc(["internet", "of", "things"])
    )).toBe(1);
    expect(equivalentRecallBodyOccurrenceCount(
      equivalentQuery(["language models", "large language models", "models"]),
      extra
    )).toBe(2);
  });
});

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const precedenceDocs = [
  { id: "guide", title: "llm", body: "overview for the guide" },
  { id: "once", title: "Singular Span", body: "large language models" },
  { id: "twice", title: "Repeated Span", body: "large language models appear. large language models appear again." },
  { id: "neighbor", title: "Layout Kit", body: "widgets panels and frames" },
];

const equivalentDocs = [
  { id: "a-singular", title: "Notes", body: "large language model" },
  { id: "b-plural", title: "Notes", body: "large language models" },
  { id: "c-adjacent", title: "Notes", body: "large language models large language models" },
];

function precedenceEngine(retriever, aliases = [SINGULAR, PLURAL]) {
  const authored = compileAuthoredRelevance({
    configuredConcepts: [{ key: "llm", aliases }],
    documents: precedenceDocs,
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

function equivalentEngine(retriever) {
  const authored = compileAuthoredRelevance({
    configuredConcepts: [{ key: "llm", aliases: [] }],
    relationshipMap: {
      llm: [
        { to: { form: "large language model" }, kind: "equivalent" },
        { to: { form: "large language models" }, kind: "equivalent" },
      ],
    },
    documents: equivalentDocs,
  });
  return SearchEngine.create({
    schema,
    plugins: [morphology(), ...authored.plugins],
    retriever,
    relationshipStrategy: "hybrid",
  });
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

function publicRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    rank: row.rank,
    score: row.score,
    relevanceKind: row.relevanceKind,
    directClass: row.directClass,
  }));
}

const componentDocs = [
  { id: "guide", title: "LLM Guide", body: "overview" },
  { id: "single", title: "Field Notes", body: "llm model" },
  { id: "component-only", title: "Other Notes", body: "model model" },
  { id: "neighbor", title: "Garden Notes", body: "soil and flowers" },
];

const componentAliases = [["large", "language", "model"], ["model"]];

function componentEngine(retriever, aliases, documents = componentDocs) {
  const authored = compileAuthoredRelevance({
    configuredConcepts: [{ key: "llm", aliases }],
    documents,
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
        guide: [{ target: "neighbor", type: "semantic", strength: 0.9, provenance: "embedding" }],
      },
    },
  });
}

const stopDocs = [
  { id: "guide", title: "For Loop", body: "overview" },
  { id: "repeated", title: "Iteration Notes", body: "for loops use iterators. for loops visit items" },
  { id: "single", title: "Short Notes", body: "for loops use iterators" },
  { id: "neighbor", title: "Garden Notes", body: "soil and flowers" },
];

function stopRelationships() {
  return {
    format: "search-relationships",
    version: 1,
    relationships: {
      guide: [{ target: "neighbor", type: "semantic", strength: 0.9, provenance: "embedding" }],
    },
  };
}

function stopEngine(retriever, configuredConcepts) {
  const plugins = [morphology()];
  if (configuredConcepts) {
    plugins.push(...compileAuthoredRelevance({ configuredConcepts, documents: stopDocs }).plugins);
  }
  return SearchEngine.create({
    schema,
    plugins,
    retriever,
    relationshipStrategy: "hybrid",
    documentRelationships: stopRelationships(),
  });
}

describe("ordinary stopwords still count as direct body evidence", () => {
  test("query for keeps repeated-direct precedence over the related neighbor", async () => {
    const orders = [];
    for (const configuredConcepts of [undefined, [{ key: "for", aliases: [["the"]] }]]) {
      for (const retriever of ["full-scan", "indexed"]) {
        const engine = stopEngine(retriever, configuredConcepts);
        await engine.index(stopDocs);
        const detailed = engine.searchDetailed("for", { limit: 10, relatedLimit: 10, explain: true });
        const packed = engine.search("for", { limit: 10, relatedLimit: 10 });
        const exhaustive = engine._searchDetailedSync(
          "for",
          { limit: 10, relatedLimit: 10, explain: true },
          false,
          "exhaustive"
        );
        const ids = detailed.results.map((row) => row.id);
        expect(ids).toEqual(["guide", "repeated", "neighbor", "single"]);
        expect(hit(detailed.results, "repeated").features.directBodyOccurrenceCount).toBe(2);
        expect(hit(detailed.results, "single").features.directBodyOccurrenceCount).toBe(1);
        expect(hit(detailed.results, "neighbor").relevanceKind).toBe("related");
        expect(publicRows(packed)).toEqual(publicRows(detailed.results));
        expect(publicRows(exhaustive.results)).toEqual(publicRows(detailed.results));
        expect(exhaustive.results.map((row) => row.score)).toEqual(detailed.results.map((row) => row.score));
        orders.push(ids);
      }
    }
    expect(new Set(orders.map((ids) => ids.join(",")))).toEqual(new Set(["guide,repeated,neighbor,single"]));
  });

  test("a configured stopword alias is not body evidence and the concept key still is", async () => {
    const documents = [
      { id: "key-once", title: "Loop Notes", body: "loop for" },
      { id: "alias-only", title: "Alias Only", body: "for for" },
      { id: "neighbor", title: "Garden Notes", body: "soil and flowers" },
    ];
    const authored = compileAuthoredRelevance({
      configuredConcepts: [{ key: "loop", aliases: [["for"]] }],
      documents,
    });
    for (const retriever of ["full-scan", "indexed"]) {
      const engine = SearchEngine.create({
        schema,
        plugins: [morphology(), ...authored.plugins],
        retriever,
        relationshipStrategy: "none",
      });
      await engine.index(documents);
      const detailed = engine.searchDetailed("loop", { limit: 10, explain: true });
      const packed = engine.search("loop", { limit: 10 });
      const ids = detailed.results.map((row) => row.id);
      expect(ids).toContain("key-once");
      expect(ids).not.toContain("alias-only");
      expect(hit(detailed.results, "key-once").features.directBodyOccurrenceCount).toBe(1);
      expect(publicRows(packed)).toEqual(publicRows(detailed.results));
    }
  });
});

describe("excluded component aliases do not create repeated-body evidence", () => {
  test("llm model is one occurrence and model model is not a configured body hit", async () => {
    const orders = [];
    for (const aliases of [componentAliases, [["large", "language", "model"]]]) {
      for (const retriever of ["full-scan", "indexed"]) {
        const engine = componentEngine(retriever, aliases);
        await engine.index(componentDocs);
        const detailed = engine.searchDetailed("llm", { limit: 10, relatedLimit: 10, explain: true });
        const packed = engine.search("llm", { limit: 10, relatedLimit: 10 });
        const exhaustive = engine._searchDetailedSync(
          "llm",
          { limit: 10, relatedLimit: 10, explain: true },
          false,
          "exhaustive"
        );
        const ids = detailed.results.map((row) => row.id);
        expect(ids).toEqual(["guide", "neighbor", "single"]);
        expect(ids).not.toContain("component-only");
        expect(hit(detailed.results, "single").features.directBodyOccurrenceCount).toBe(1);
        expect(hit(detailed.results, "neighbor").relevanceKind).toBe("related");
        expect(publicRows(packed)).toEqual(publicRows(detailed.results));
        expect(publicRows(exhaustive.results)).toEqual(publicRows(detailed.results));
        expect(exhaustive.results.map((row) => row.score)).toEqual(detailed.results.map((row) => row.score));
        orders.push(ids);
      }
    }
    expect(new Set(orders.map((ids) => ids.join(",")))).toEqual(new Set(["guide,neighbor,single"]));

    const repeatedDocs = [
      ...componentDocs,
      { id: "repeated", title: "Repeat Notes", body: "large language model. large language model" },
    ];
    for (const retriever of ["full-scan", "indexed"]) {
      const engine = componentEngine(retriever, componentAliases, repeatedDocs);
      await engine.index(repeatedDocs);
      const detailed = engine.searchDetailed("llm", { limit: 10, relatedLimit: 10, explain: true });
      const packed = engine.search("llm", { limit: 10, relatedLimit: 10 });
      expect(hit(detailed.results, "repeated").features.directBodyOccurrenceCount).toBe(2);
      expect(hit(detailed.results, "single").features.directBodyOccurrenceCount).toBe(1);
      const ids = detailed.results.map((row) => row.id);
      expect(ids.indexOf("repeated")).toBeLessThan(ids.indexOf("neighbor"));
      expect(ids.indexOf("neighbor")).toBeLessThan(ids.indexOf("single"));
      expect(ids).not.toContain("component-only");
      expect(publicRows(packed)).toEqual(publicRows(detailed.results));
    }
  });
});

describe("alias spans through the engine", () => {
  test("one span does not trigger repeated-direct precedence; two spans still do", async () => {
    const orders = [];
    for (const retriever of ["full-scan", "indexed"]) {
      const engine = precedenceEngine(retriever);
      await engine.index(precedenceDocs);
      const detailed = engine.searchDetailed("llm", { limit: 20, relatedLimit: 20, explain: true });
      const packed = engine.search("llm", { limit: 20, relatedLimit: 20 });
      const results = detailed.results;
      const once = hit(results, "once");
      const twice = hit(results, "twice");
      const neighbor = hit(results, "neighbor");
      expect(once.features.directBodyOccurrenceCount).toBe(1);
      expect(twice.features.directBodyOccurrenceCount).toBe(2);
      expect(neighbor.relevanceKind).toBe("related");
      expect(neighbor.features.directBodyOccurrenceCount || 0).toBe(0);
      const ids = results.map((row) => row.id);
      expect(ids.indexOf("neighbor")).toBeLessThan(ids.indexOf("once"));
      expect(ids.indexOf("twice")).toBeLessThan(ids.indexOf("neighbor"));
      const repeated = pair(results, "twice", "neighbor");
      expect(repeated.order).toBe(-1);
      expect(repeated.applied.some((row) => row.id === "related-over-weak-direct" && row.result === "A>B")).toBe(true);
      const single = pair(results, "once", "neighbor");
      expect(single.order).toBe(1);
      expect(single.applied.some((row) => row.id === "related-over-weak-direct" && row.result === "A>B")).toBe(false);
      expect(publicRows(packed)).toEqual(publicRows(results));
      orders.push(ids);
    }
    expect(orders[0]).toEqual(orders[1]);

    const reversed = precedenceEngine("full-scan", [PLURAL, SINGULAR]);
    await reversed.index(precedenceDocs);
    const reversedResults = reversed.searchDetailed("llm", { limit: 20, relatedLimit: 20, explain: true }).results;
    expect(hit(reversedResults, "once").features.directBodyOccurrenceCount).toBe(1);
    expect(hit(reversedResults, "twice").features.directBodyOccurrenceCount).toBe(2);
  });

  test("equivalent forms count one span once and agree across retrievers and result modes", async () => {
    const orders = [];
    for (const retriever of ["full-scan", "indexed"]) {
      const engine = equivalentEngine(retriever);
      await engine.index(equivalentDocs);
      const detailed = engine.searchDetailed("llm", { limit: 10, explain: true });
      const packed = engine.search("llm", { limit: 10 });
      const singular = hit(detailed.results, "a-singular");
      const plural = hit(detailed.results, "b-plural");
      const adjacent = hit(detailed.results, "c-adjacent");
      expect(singular.features.equivalentRecallBodyOccurrenceCount).toBe(1);
      expect(plural.features.equivalentRecallBodyOccurrenceCount).toBe(1);
      expect(adjacent.features.equivalentRecallBodyOccurrenceCount).toBe(2);
      expect(singular.features.directBodyOccurrenceCount || 0).toBe(0);
      expect(plural.features.equivalentRecallFormCount).toBe(2);
      expect(singular.features.equivalentRecallFormCount).toBe(1);
      expect(plural.score).toBe(adjacent.score);
      expect(plural.score).toBeGreaterThan(singular.score);
      const ids = detailed.results.map((row) => row.id);
      expect(ids.indexOf("c-adjacent")).toBeLessThan(ids.indexOf("b-plural"));
      expect(publicRows(packed)).toEqual(publicRows(detailed.results));
      orders.push(detailed.results.map((row) => row.id));
    }
    expect(orders[0]).toEqual(orders[1]);
  });
});
