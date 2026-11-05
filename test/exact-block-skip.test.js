import { SearchEngine } from "../dist/index.js";
import {
  compileLexicalIndex,
  loadLexicalIndex,
  EXACT_PRUNING_BODY_TERM_MASKS_EXTENSION,
} from "../dist/indexing/lexicalIndex.js";
import { stableFingerprint } from "../dist/stableHash.js";
import { oneOfKBodyOnlyMaxRoundedScore } from "../dist/retrieval/exactBlockSkip.js";
import { scoreFeatures } from "../dist/ranking/rank.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

function pad(i, n = 5) {
  return String(i).padStart(n, "0");
}

function refreshIntegrity(artifact) {
  artifact.integrity = stableFingerprint({
    compatibility: artifact.compatibility,
    corpus: artifact.corpus,
    data: artifact.data,
  });
  return artifact;
}

async function compiledEngine(documents, options = {}) {
  const lexicalIndex = options.lexicalIndex || compileLexicalIndex(documents, { schema });
  const engine = SearchEngine.create({
    schema,
    lexicalIndex,
    retriever: "indexed",
    relationshipStrategy: "none",
    ...options,
  });
  await engine.index(documents);
  return engine;
}

function publicRows(hits) {
  return hits.map((hit) => ({
    id: hit.id,
    score: hit.score,
    rank: hit.rank,
  }));
}

function compareExact(optimized, exhaustive) {
  expect(publicRows(optimized.results)).toEqual(publicRows(exhaustive.results));
  expect(publicRows(optimized.related || [])).toEqual(publicRows(exhaustive.related || []));
}

function expectBodyPostingBlockInvariant(meta) {
  expect(meta.postingBlocksTotal).toBe(
    meta.postingBlocksDecoded + meta.postingBlocksClassifiedFromMasks
  );
  expect(meta.postingBlocksSkippedUnread).toBeLessThanOrEqual(meta.postingBlocksClassifiedFromMasks);
}

describe("body posting pruning", () => {
  test("1-of-k upper bound matches production scoreFeatures rounding", () => {
    expect(oneOfKBodyOnlyMaxRoundedScore(3)).toBe(
      Number((Number((1 / 3).toFixed(4)) * 0.25).toFixed(6))
    );
    expect(
      scoreFeatures({ bodyLexicalMatch: Number((1 / 3).toFixed(4)) }).toFixed(6)
    ).toBe(String(oneOfKBodyOnlyMaxRoundedScore(3)));
  });

  test("A/D: later conjunction and phrase-class docs are evaluated, not skipped", async () => {
    const documents = [];
    for (let i = 0; i < 300; i += 1) {
      documents.push({
        id: `early-${pad(i)}`,
        title: `Filler ${i}`,
        body: "alpha unrelated notes",
      });
    }
    documents.push({
      id: "late-conjunction",
      title: "Later notes",
      body: "alpha beta gamma sit together. alpha beta gamma again.",
      lexicalFrequency: { "alpha beta": 2, "beta gamma": 2, "alpha beta gamma": 2 },
    });
    const engine = await compiledEngine(documents);
    const optimized = engine._searchDetailedSync("alpha beta gamma", { limit: 10, relatedLimit: 0 }, false, "auto");
    const exhaustive = engine._searchDetailedSync("alpha beta gamma", { limit: 10, relatedLimit: 0 }, false, "exhaustive");
    compareExact(optimized, exhaustive);
    expect(optimized.results[0].id).toBe("late-conjunction");
    expect(optimized.meta.stage3A).toBe("applied");
    expectBodyPostingBlockInvariant(optimized.meta);
    expect(optimized.meta.postingBlocksSkippedUnread).toBeGreaterThan(0);
    expect(optimized.meta.candidateDocumentsMaterialized).toBeLessThan(301);
  });

  test("B/E: equal-score later 1-of-k ids lose the tie and unread blocks skip", async () => {
    const documents = [];
    for (let i = 0; i < 400; i += 1) {
      documents.push({
        id: `weak-${pad(i)}`,
        title: `Note ${i}`,
        body: i % 2 === 0 ? "alpha only here" : "beta only here",
      });
    }
    const engine = await compiledEngine(documents);
    const optimized = engine._searchDetailedSync("alpha beta", { limit: 5, relatedLimit: 0 }, false, "auto");
    const exhaustive = engine._searchDetailedSync("alpha beta", { limit: 5, relatedLimit: 0 }, false, "exhaustive");
    compareExact(optimized, exhaustive);
    expect(optimized.meta.stage3A).toBe("applied");
    expectBodyPostingBlockInvariant(optimized.meta);
    expect(optimized.meta.postingBlocksSkippedUnread).toBeGreaterThan(0);
    expect(optimized.meta.candidateDocumentsMaterialized).toBeLessThan(documents.length);
    expect(optimized.meta.featureVectorsConstructed).toBeLessThan(documents.length);
  });

  test("C: a later unseen 2-of-k signature is still discovered", async () => {
    const documents = [];
    for (let i = 0; i < 250; i += 1) {
      documents.push({
        id: `one-${pad(i)}`,
        title: `Solo ${i}`,
        body: "alpha filler",
      });
    }
    documents.push({
      id: "zz-pair",
      title: "Pair later",
      body: "alpha beta adjacent pair alpha beta",
      lexicalFrequency: { "alpha beta": 2 },
    });
    const engine = await compiledEngine(documents);
    const optimized = engine._searchDetailedSync("alpha beta gamma", { limit: 10, relatedLimit: 0 }, false, "auto");
    const exhaustive = engine._searchDetailedSync("alpha beta gamma", { limit: 10, relatedLimit: 0 }, false, "exhaustive");
    compareExact(optimized, exhaustive);
    expect(optimized.results.some((hit) => hit.id === "zz-pair")).toBe(true);
  });

  test("F: missing body-term mask metadata fails closed to exhaustive compiled search", async () => {
    const documents = Array.from({ length: 260 }, (_, i) => ({
      id: `m-${pad(i)}`,
      title: `Doc ${i}`,
      body: i % 3 === 0 ? "alpha beta" : "alpha",
    }));
    const artifact = compileLexicalIndex(documents, { schema });
    expect(artifact.data.extensions[EXACT_PRUNING_BODY_TERM_MASKS_EXTENSION]).toBeTruthy();
    delete artifact.data.extensions[EXACT_PRUNING_BODY_TERM_MASKS_EXTENSION];
    refreshIntegrity(artifact);
    const engine = await compiledEngine(documents, { lexicalIndex: artifact });
    const optimized = engine._searchDetailedSync("alpha beta", { limit: 10, relatedLimit: 0 }, false, "auto");
    const exhaustive = engine._searchDetailedSync("alpha beta", { limit: 10, relatedLimit: 0 }, false, "exhaustive");
    compareExact(optimized, exhaustive);
    expect(engine.lastSearchMeta.stage3A === "off" || engine.lastSearchMeta.stage3A === "fallback").toBe(true);
    expect(engine.lastSearchMeta.postingBlocksSkippedUnread || 0).toBe(0);
  });

  test("G: malformed body-term mask metadata is rejected on load", () => {
    const documents = Array.from({ length: 260 }, (_, i) => ({
      id: `g-${pad(i)}`,
      title: `Doc ${i}`,
      body: "alpha beta extra",
    }));
    const artifact = compileLexicalIndex(documents, { schema });
    artifact.data.extensions[EXACT_PRUNING_BODY_TERM_MASKS_EXTENSION].revision = 99;
    refreshIntegrity(artifact);
    expect(() => loadLexicalIndex(artifact, documents, schema)).toThrow(/exact-pruning-body-term-masks/);
  });

  test("H: searchDetailed stays exhaustive; search() matches exhaustive compiled results", async () => {
    const documents = Array.from({ length: 300 }, (_, i) => ({
      id: `h-${pad(i)}`,
      title: i === 10 ? "alpha beta gamma title" : `Doc ${i}`,
      body: i % 5 === 0 ? "alpha beta gamma" : i % 2 === 0 ? "alpha" : "beta",
    }));
    const engine = await compiledEngine(documents);
    const searchHits = engine.search("alpha beta gamma", { limit: 10, relatedLimit: 0 });
    const detailed = engine.searchDetailed("alpha beta gamma", { limit: 10, relatedLimit: 0 });
    const exhaustive = engine._searchDetailedSync("alpha beta gamma", { limit: 10, relatedLimit: 0 }, false, "exhaustive");
    expect(publicRows(searchHits)).toEqual(publicRows(exhaustive.results));
    expect(publicRows(detailed.results)).toEqual(publicRows(exhaustive.results));
    expect(detailed.meta.stage3A === "off" || detailed.meta.postingBlocksSkippedUnread === 0).toBe(true);
  });

  test("I: limits and relatedLimit do not change exact public order", async () => {
    const documents = Array.from({ length: 320 }, (_, i) => ({
      id: `i-${pad(i)}`,
      title: `Doc ${i}`,
      body: i % 7 === 0 ? "alpha beta" : "alpha",
    }));
    const engine = await compiledEngine(documents);
    for (const opts of [
      { limit: 1, relatedLimit: 0 },
      { limit: 3, relatedLimit: 0 },
      { limit: 10, relatedLimit: 5 },
    ]) {
      const optimized = engine._searchDetailedSync("alpha beta", opts, false, "auto");
      const exhaustive = engine._searchDetailedSync("alpha beta", opts, false, "exhaustive");
      compareExact(optimized, exhaustive);
      if (optimized.meta.stage3A === "applied") expectBodyPostingBlockInvariant(optimized.meta);
    }
  });

  test("repeated class-1 bodies stay pruned when no related neighbor can apply", async () => {
    const documents = [];
    for (let i = 0; i < 1000; i += 1) {
      documents.push({
        id: `body${pad(i, 4)}`,
        title: `Notes ${i}`,
        body: i % 2 === 0 ? "amber amber only here" : "beacon beacon only here",
      });
    }
    const lexicalIndex = compileLexicalIndex(documents, { schema });
    const engine = await compiledEngine(documents, {
      lexicalIndex,
      relationshipStrategy: "none",
    });
    const optimized = engine.search("amber beacon", { limit: 10, relatedLimit: 0 });
    const meta = engine.lastSearchMeta;
    const exhaustive = engine._searchDetailedSync(
      "amber beacon",
      { limit: 10, relatedLimit: 0 },
      false,
      "exhaustive"
    );
    expect(optimized.map((hit) => hit.id)).toEqual(exhaustive.results.map((hit) => hit.id));
    expect(optimized.map((hit) => hit.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `body${pad(i, 4)}`)
    );
    expect(meta.stage3A).toBe("applied");
    expectBodyPostingBlockInvariant(meta);
    expect(meta.candidateDocumentsMaterialized).toBe(10);
    expect(meta.optimizedDirectCandidates).toBe(10);
    expect(meta.postingBlocksSkippedUnread).toBe(8);
  });

  test("a repeated body hit after the weak prefix stays ahead of a zero-term neighbor", async () => {
    const documents = [
      { id: "a-guide", title: "amber beacon", body: "overview notes" },
    ];
    for (let i = 0; i < 300; i += 1) {
      documents.push({
        id: `b${pad(i, 4)}`,
        title: `Notes ${i}`,
        body: i % 2 === 0 ? "amber only here" : "beacon only here",
      });
    }
    documents.push(
      { id: "c-repeated", title: "Field Notes", body: "amber amber only here" },
      { id: "z-neighbor", title: "Layout Kit", body: "widgets panels and frames" }
    );
    const lexicalIndex = compileLexicalIndex(documents, { schema });
    const engine = await compiledEngine(documents, {
      lexicalIndex,
      relationshipStrategy: "hybrid",
      documentRelationships: {
        format: "search-relationships",
        version: 1,
        relationships: {
          "a-guide": [
            { target: "z-neighbor", type: "semantic", strength: 0.95, provenance: "embedding" },
          ],
        },
      },
    });
    const opts = { limit: 10, relatedLimit: 5 };
    const optimized = engine.search("amber beacon", opts);
    const meta = engine.lastSearchMeta;
    const exhaustive = engine._searchDetailedSync("amber beacon", opts, false, "exhaustive");
    const detailed = engine.searchDetailed("amber beacon", { ...opts, explain: true });
    expect(optimized.map((hit) => hit.id)).toEqual(exhaustive.results.map((hit) => hit.id));
    expect(detailed.results.map((hit) => hit.id)).toEqual(exhaustive.results.map((hit) => hit.id));
    expect(publicRows(detailed.related || [])).toEqual(publicRows(exhaustive.related || []));
    const ids = optimized.map((hit) => hit.id);
    expect(ids.indexOf("a-guide")).toBe(0);
    expect(ids).toContain("c-repeated");
    expect(ids).toContain("z-neighbor");
    expect(ids.indexOf("c-repeated")).toBeLessThan(ids.indexOf("z-neighbor"));
    expect(ids.indexOf("z-neighbor")).toBeLessThan(ids.indexOf("b0000"));
    const repeated = detailed.results.find((hit) => hit.id === "c-repeated");
    const neighbor = detailed.results.find((hit) => hit.id === "z-neighbor");
    expect(repeated.directClass).toBe("weak");
    expect(repeated.features.directBodyOccurrenceCount).toBeGreaterThanOrEqual(2);
    expect(neighbor.relevanceKind).toBe("related");
    expect(neighbor.retrievalSources).toEqual(["relationship"]);
    expect(neighbor.features.directBodyOccurrenceCount || 0).toBe(0);
    expect(meta.stage3A).toBe("applied");
    expectBodyPostingBlockInvariant(meta);
    expect(meta.postingBlocksSkippedUnread).toBeGreaterThan(0);
    expect(meta.candidateDocumentsMaterialized).toBeLessThan(documents.length);
    expect(meta.optimizedDirectCandidates).toBeLessThan(documents.length);
    expect(meta.candidateDocumentsMaterialized).toBeGreaterThan(10);
  });

  test("prefix and single-token queries fail closed", async () => {
    const documents = Array.from({ length: 260 }, (_, i) => ({
      id: `p-${pad(i)}`,
      title: i === 0 ? "machine learning" : `Doc ${i}`,
      body: "machine learning frames",
    }));
    const engine = await compiledEngine(documents);
    engine.search("machine l", { limit: 10, relatedLimit: 0 });
    expect(engine.lastSearchMeta.stage3A === "off" || engine.lastSearchMeta.stage3A === "fallback").toBe(true);
    engine.search("frames", { limit: 10, relatedLimit: 0 });
    expect(engine.lastSearchMeta.stage3A === "off" || engine.lastSearchMeta.stage3A === "fallback").toBe(true);
  });
});
