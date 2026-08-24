import { SearchEngine } from "../dist/index.js";
import {
  compileLexicalIndex,
  loadLexicalIndex,
  EXACT_PRUNING_V2_EXTENSION,
} from "../dist/lexicalIndex.js";
import { stableFingerprint } from "../dist/stableHash.js";
import { oneOfKBodyOnlyMaxRoundedScore } from "../dist/exactBlockSkip.js";
import { scoreFeatures } from "../dist/rank.js";

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

function expectStage3ABlockInvariant(meta) {
  expect(meta.postingBlocksTotal).toBe(
    meta.postingBlocksDecoded + meta.postingBlocksClassifiedFromMasks
  );
  expect(meta.postingBlocksSkippedUnread).toBeLessThanOrEqual(meta.postingBlocksClassifiedFromMasks);
}

describe("Stage-3A exact unread body-block skipping", () => {
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
    expectStage3ABlockInvariant(optimized.meta);
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
    expectStage3ABlockInvariant(optimized.meta);
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

  test("F: missing Stage-3 metadata fails closed to exhaustive compiled search", async () => {
    const documents = Array.from({ length: 260 }, (_, i) => ({
      id: `m-${pad(i)}`,
      title: `Doc ${i}`,
      body: i % 3 === 0 ? "alpha beta" : "alpha",
    }));
    const artifact = compileLexicalIndex(documents, { schema });
    expect(artifact.data.extensions[EXACT_PRUNING_V2_EXTENSION]).toBeTruthy();
    delete artifact.data.extensions[EXACT_PRUNING_V2_EXTENSION];
    refreshIntegrity(artifact);
    const engine = await compiledEngine(documents, { lexicalIndex: artifact });
    const optimized = engine._searchDetailedSync("alpha beta", { limit: 10, relatedLimit: 0 }, false, "auto");
    const exhaustive = engine._searchDetailedSync("alpha beta", { limit: 10, relatedLimit: 0 }, false, "exhaustive");
    compareExact(optimized, exhaustive);
    expect(engine.lastSearchMeta.stage3A === "off" || engine.lastSearchMeta.stage3A === "fallback").toBe(true);
    expect(engine.lastSearchMeta.postingBlocksSkippedUnread || 0).toBe(0);
  });

  test("G: malformed Stage-3 metadata is rejected on load", () => {
    const documents = Array.from({ length: 260 }, (_, i) => ({
      id: `g-${pad(i)}`,
      title: `Doc ${i}`,
      body: "alpha beta extra",
    }));
    const artifact = compileLexicalIndex(documents, { schema });
    artifact.data.extensions[EXACT_PRUNING_V2_EXTENSION].revision = 99;
    refreshIntegrity(artifact);
    expect(() => loadLexicalIndex(artifact, documents, schema)).toThrow(/exact-pruning-v2/);
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
      if (optimized.meta.stage3A === "applied") expectStage3ABlockInvariant(optimized.meta);
    }
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
