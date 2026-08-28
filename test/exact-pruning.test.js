import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { extractFeatures } from "../dist/features.js";
import {
  compileLexicalIndex,
  documentBlockBoundaries,
  loadLexicalIndex,
} from "../dist/lexicalIndex.js";
import {
  exactBodyOnlySingleTokenBound,
  planExactFeaturePruning,
} from "../dist/exactPruning.js";
import { constraintSignature } from "../dist/rankSignature.js";
import { scoreFeatures } from "../dist/rank.js";
import { retrieveCandidates } from "../dist/retrieve.js";
import { stableFingerprint } from "../dist/stableHash.js";
import {
  createLoopbackTransport,
  createSearchClient,
  createWorkerRuntime,
} from "../dist/browser/index.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
const dictionary = ({ entries } = {}) => compileConfiguredConceptPlugin({ configuredConcepts: entries || [] });

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "software-land");
const load = (name) =>
  JSON.parse(fs.readFileSync(path.join(fixture, name), "utf8"));

function bodyFlood(n = 2_000) {
  const docs = [{
    id: "winner",
    title: "The",
    body: "",
  }];
  for (let i = 0; i < n; i += 1) {
    docs.push({
      id: `body-${String(i).padStart(6, "0")}`,
      title: `Article ${i}`,
      body: "the common body",
    });
  }
  return docs;
}

function softwareLandDistractors(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `stage2-sl-flood-${String(i).padStart(5, "0")}`,
    title: "Unrelated filler notes",
    body: [
      "2 2 2 2 2",
      "testing search index document query title body token",
      "what is the of and to in a for on with as by from",
      "tls vpn network protocol security machine learning",
    ].join(" "),
  }));
}

function deterministicCorpus(n) {
  let state = 0x51a9f00d;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  return Array.from({ length: n }, (_, i) => {
    const value = next();
    const token = value % 3 === 0 ? "open" : value % 3 === 1 ? "search" : "the";
    return {
      id: `random-${String(i).padStart(7, "0")}`,
      title: value % 97 === 0 ? `${token} Exact ${i}` : `Article ${i}`,
      body: `${token} common body`,
      lexicalFrequency: token === "the"
        ? null
        : { [token]: value % 11 === 0 ? 4 : value % 5 === 0 ? 1 : 0 },
    };
  });
}

async function compiledEngine(documents, options = {}) {
  const { relationships, lexicalIndex: suppliedIndex, ...rest } = options;
  const lexicalIndex = suppliedIndex || compileLexicalIndex(documents, {
    schema,
  });
  const engine = SearchEngine.create({
    schema,
    lexicalIndex,
    retriever: "indexed",
    relationshipStrategy: "none",
    documentRelationships: relationships,
    ...rest,
  });
  await engine.index(documents);
  return engine;
}

function publicSurface(value) {
  return {
    results: value.results,
    related: value.related,
  };
}

function refreshIntegrity(artifact) {
  artifact.integrity = stableFingerprint({
    compatibility: artifact.compatibility,
    corpus: artifact.corpus,
    data: artifact.data,
  });
  return artifact;
}

describe("Stage-2A exact document-feature block pruning", () => {
  test("block boundaries are deterministic for every supported layout", () => {
    expect(documentBlockBoundaries(0, 32)).toEqual([0]);
    expect(documentBlockBoundaries(1, 64)).toEqual([0, 1]);
    expect(documentBlockBoundaries(256, 128)).toEqual([0, 128, 256]);
    expect(documentBlockBoundaries(257, 256)).toEqual([0, 256, 257]);
    expect(() => documentBlockBoundaries(10, 16)).toThrow(/blockSize/);
  });

  test("known pruning metadata validates strictly while old v1 artifacts remain exhaustive", async () => {
    const documents = bodyFlood(300);
    const artifact = compileLexicalIndex(documents, { schema });
    expect(artifact.data.extensions["exact-pruning-v1"]).toEqual({
      revision: 1,
      unit: "document-ordinal",
      blockSize: 128,
      boundaries: [0, 128, 256, 301],
    });

    for (const mutate of [
      (extension) => {
        extension.revision = 2;
      },
      (extension) => {
        extension.boundaries = [0, 127, 301];
      },
      (extension) => {
        extension.blockSize = 16;
      },
      (extension) => {
        extension.blockSize = "128";
      },
      (extension) => {
        extension.unit = "term-posting";
      },
    ]) {
      const corrupted = JSON.parse(JSON.stringify(artifact));
      mutate(corrupted.data.extensions["exact-pruning-v1"]);
      refreshIntegrity(corrupted);
      expect(() => loadLexicalIndex(corrupted, documents, schema)).toThrow(
        /exact-pruning-v1/
      );
    }

    const old = JSON.parse(JSON.stringify(artifact));
    delete old.data.extensions["exact-pruning-v1"];
    refreshIntegrity(old);
    const engine = await compiledEngine(documents, { lexicalIndex: old });
    const actual = engine._searchDetailedSync(
      "the",
      { limit: 10, relatedLimit: 0 },
      false
    );
    expect(actual.meta.documentsBoundRejected).toBe(0);
    expect(actual.meta.documentsFullyEvaluated).toBe(actual.meta.matchCount);
    expect(actual.meta.pruningFallbackReason).toBe("missing-pruning-extension");
  });

  test("every admitted local bound equals the complete feature signature and rounded score", async () => {
    const tokens = ["the", "open", "mesh", "search"];
    const documents = [];
    for (let i = 0; i < 600; i += 1) {
      const token = tokens[i % tokens.length];
      documents.push({
        id: `random-${String(i).padStart(5, "0")}`,
        title: i % 19 === 0 ? `${token} Lead ${i}` : `Article ${i}`,
        body: `${token} common body`,
        lexicalFrequency: token === "the"
          ? null
          : { [token]: i % 7 === 0 ? 4 : i % 5 === 0 ? 1 : 0 },
      });
    }
    documents.push({
      id: "search-typo-title",
      title: "Searhc",
      body: "search",
    });
    const engine = await compiledEngine(documents);

    let admitted = 0;
    for (const text of tokens) {
      const query = engine._prepareQuery(text);
      const retrieved = engine.retriever.retrieve(query, engine._index);
      for (const hit of retrieved) {
        const bound = exactBodyOnlySingleTokenBound(
          query,
          hit,
          hit.documentOrdinal
        );
        if (!bound) continue;
        admitted += 1;
        const features = extractFeatures(query, hit.document);
        expect(bound.signature).toBe(constraintSignature(features));
        expect(bound.roundedScore).toBe(
          Number(scoreFeatures(features).toFixed(6))
        );
      }
    }
    expect(admitted).toBeGreaterThan(500);
    const searchQuery = engine._prepareQuery("search");
    const typoHit = engine.retriever
      .retrieve(searchQuery, engine._index)
      .find((hit) => hit.document.id === "search-typo-title");
    expect(typoHit.retrievalSources).toEqual(["body-lexical"]);
    expect(exactBodyOnlySingleTokenBound(
      searchQuery,
      typoHit,
      typoHit.documentOrdinal
    )).toBeNull();
    expect(extractFeatures(searchQuery, typoHit.document).typoDistance).toBeGreaterThan(0);
  });

  test("all Software.Land queries satisfy every admitted signature/score bound", async () => {
    const documents = attachLexicalFrequency(
      load("documents.json"),
      load("lexical-frequency.json")
    );
    const english = morphology({ lemmas: load("lemmas.json") });
    const plugins = [
      english,
      compileConfiguredConceptPlugin({ configuredConcepts: load("configured-concepts.json") }),
    ];
    const lexicalIndex = compileLexicalIndex(documents, {
      schema,
      plugins,
    });
    const engine = await compiledEngine(documents, {
      lexicalIndex,
      plugins,
    });
    let admitted = 0;
    for (const row of load("query-result-oracle.json").rows) {
      const query = engine._prepareQuery(row.query);
      const retrieved = engine.retriever.retrieve(query, engine._index);
      for (const hit of retrieved) {
        const bound = exactBodyOnlySingleTokenBound(
          query,
          hit,
          hit.documentOrdinal
        );
        if (!bound) continue;
        admitted += 1;
        const features = extractFeatures(query, hit.document);
        expect(bound.signature).toBe(constraintSignature(features));
        expect(bound.roundedScore).toBe(
          Number(scoreFeatures(features).toFixed(6))
        );
      }
    }
    expect(admitted).toBeGreaterThan(0);
  }, 120_000);

  test("all Software.Land normal result/explanation rows equal the exhaustive compiled oracle", async () => {
    const documents = attachLexicalFrequency(
      load("documents.json"),
      load("lexical-frequency.json")
    );
    const english = morphology({ lemmas: load("lemmas.json") });
    const plugins = [
      english,
      compileConfiguredConceptPlugin({ configuredConcepts: load("configured-concepts.json") }),
    ];
    const lexicalIndex = compileLexicalIndex(documents, {
      schema,
      plugins,
    });
    const engine = await compiledEngine(documents, {
      lexicalIndex,
      plugins,
      relationships: load("relationships.json"),
      relationshipStrategy: "hybrid",
    });
    for (const row of load("query-result-oracle.json").rows) {
      const options = {
        limit: 10,
        relatedLimit: 5,
        explain: true,
        relationshipStrategy: "hybrid",
      };
      const actual = engine._searchDetailedSync(
        row.query,
        options,
        false,
        "auto"
      );
      const expected = engine._searchDetailedSync(
        row.query,
        options,
        false,
        "exhaustive"
      );
      expect(publicSurface(actual)).toEqual(publicSurface(expected));
    }
  }, 120_000);

  test.each([400, 1_000, 5_000])(
    "expanded Software.Land +%i stays equal to exhaustive compiled output",
    async (flood) => {
      const originals = attachLexicalFrequency(
        load("documents.json"),
        load("lexical-frequency.json")
      );
      const documents = [
        ...originals,
        ...softwareLandDistractors(flood),
      ];
      const english = morphology({ lemmas: load("lemmas.json") });
      const plugins = [
        english,
        compileConfiguredConceptPlugin({ configuredConcepts: load("configured-concepts.json") }),
      ];
      const lexicalIndex = compileLexicalIndex(documents, {
        schema,
        plugins,
      });
      const engine = await compiledEngine(documents, {
        lexicalIndex,
        plugins,
        relationships: load("relationships.json"),
        relationshipStrategy: "hybrid",
      });
      let rejected = 0;
      for (const row of load("query-result-oracle.json").rows) {
        const options = {
          limit: 10,
          relatedLimit: 5,
          explain: true,
          relationshipStrategy: "hybrid",
        };
        const actual = engine._searchDetailedSync(
          row.query,
          options,
          false,
          "auto"
        );
        const expected = engine._searchDetailedSync(
          row.query,
          options,
          false,
          "exhaustive"
        );
        expect(publicSurface(actual)).toEqual(publicSurface(expected));
        rejected += actual.meta.documentsBoundRejected;
      }
      expect(rejected).toBeGreaterThan(0);
    },
    180_000
  );

  test.each([500, 1_000, 2_000, 5_000, 10_000, 25_000])(
    "deterministic randomized corpus N=%i stays exact",
    async (size) => {
      const documents = deterministicCorpus(size);
      const engine = await compiledEngine(documents);
      for (const query of ["the", "open", "search"]) {
        const options = {
          limit: 10,
          relatedLimit: 0,
          explain: true,
          relationshipStrategy: "none",
        };
        const actual = engine._searchDetailedSync(
          query,
          options,
          false,
          "auto"
        );
        const expected = engine._searchDetailedSync(
          query,
          options,
          false,
          "exhaustive"
        );
        expect(publicSurface(actual)).toEqual(publicSurface(expected));
      }
    },
    120_000
  );

  test("the exact block predicate retains the same per-signature score/id prefixes", async () => {
    const documents = Array.from({ length: 700 }, (_, i) => ({
      id: `doc-${String(i).padStart(5, "0")}`,
      title: `Article ${i}`,
      body: "open",
      lexicalFrequency: { open: i % 11 === 0 ? 4 : i % 3 === 0 ? 1 : 0 },
    }));
    const engine = await compiledEngine(documents);
    const query = engine._prepareQuery("open");
    const retrieved = engine.retriever.retrieve(query, engine._index);
    const runtime = engine._index.compiledLexical;
    const plan = planExactFeaturePruning({
      retrieved,
      query,
      requiredDepth: 7,
      extension: runtime.exactPruning,
    });
    const expected = new Map();
    for (const candidate of plan.bounded) {
      const features = extractFeatures(query, candidate.hit.document);
      const signature = constraintSignature(features);
      const current = expected.get(signature) || [];
      current.push({
        id: candidate.hit.document.id,
        score: Number(scoreFeatures(features).toFixed(6)),
      });
      expected.set(signature, current);
    }
    const expectedIds = [...expected.values()].flatMap((rows) =>
      rows
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, 7)
        .map((row) => row.id)
    ).sort();
    expect(plan.retainedBounded.map((hit) => hit.document.id).sort()).toEqual(
      expectedIds
    );
    expect(plan.stats.documentBlocksSkipped).toBeGreaterThan(0);
    expect(plan.stats.documentsBoundRejected).toBe(
      documents.length - expectedIds.length
    );
  });

  test("pruned, exhaustive compiled, full-scan, sync, async, and explain rows are exact", async () => {
    const documents = bodyFlood(5_000);
    const compiled = await compiledEngine(documents);
    const full = SearchEngine.create({
      schema,
      retriever: "full-scan",
      relationshipStrategy: "none",
    });
    await full.index(documents);

    for (const explain of [false, true]) {
      const options = {
        limit: 10,
        relatedLimit: 0,
        relationshipStrategy: "none",
        explain,
      };
      const pruned = compiled._searchDetailedSync(
        "the",
        options,
        false,
        "auto"
      );
      const exhaustive = compiled._searchDetailedSync(
        "the",
        options,
        false,
        "exhaustive"
      );
      const asyncPruned = await compiled._searchDetailedAsync(
        "the",
        options,
        false,
        "auto"
      );
      const reference = full.searchDetailed("the", options);
      expect(publicSurface(pruned)).toEqual(publicSurface(exhaustive));
      expect(publicSurface(pruned)).toEqual(publicSurface(asyncPruned));
      expect(publicSurface(pruned)).toEqual(publicSurface(reference));
      expect(pruned.results[0].id).toBe("winner");
      expect(pruned.meta.documentsFullyEvaluated).toBeLessThan(25);
      expect(pruned.meta.documentsBoundRejected).toBeGreaterThan(4_900);
      expect(pruned.meta.documentBlocksSkipped).toBeGreaterThan(30);
      expect(pruned.meta.postingEntriesSkipped).toBeGreaterThan(0);
      expect(exhaustive.meta.postingEntriesSkipped).toBe(0);
      expect(pruned.meta.postingEntriesVisited).toBeLessThan(
        exhaustive.meta.postingEntriesVisited
      );
      expect(exhaustive.meta.documentsFullyEvaluated).toBe(
        exhaustive.meta.matchCount
      );
      expect(exhaustive.meta.pruningFallbackReason).toBe(
        "explicit-exhaustive"
      );
    }

    const diagnostic = compiled.searchDetailed("the", {
      limit: 10,
      relatedLimit: 0,
    });
    expect(diagnostic.meta.documentsBoundRejected).toBe(0);
    expect(diagnostic.meta.documentsFullyEvaluated).toBe(
      diagnostic.meta.matchCount
    );
    expect(diagnostic.meta.pruningFallbackReason).toBe("exact-diagnostics");
  }, 120_000);

  test("precompiled and runtime-fallback indexes build the same pruning capability", async () => {
    const documents = bodyFlood(1_500);
    const precompiled = await compiledEngine(documents);
    const fallback = SearchEngine.create({
      schema,
      retriever: "indexed",
      relationshipStrategy: "none",
    });
    await fallback.index(documents);
    const options = {
      limit: 10,
      relatedLimit: 0,
      explain: true,
      relationshipStrategy: "none",
    };
    const expected = precompiled._searchDetailedSync(
      "the",
      options,
      false
    );
    const actual = fallback._searchDetailedSync(
      "the",
      options,
      false
    );
    expect(publicSurface(actual)).toEqual(publicSurface(expected));
    expect(actual.meta.documentsFullyEvaluated).toBe(
      expected.meta.documentsFullyEvaluated
    );
    expect(actual.meta.documentsBoundRejected).toBe(
      expected.meta.documentsBoundRejected
    );
    expect(actual.meta.pruningFallbackReason).toBeNull();
  });

  test("unseen stronger signatures are evaluated even in the final block", async () => {
    const documents = [
      ...Array.from({ length: 800 }, (_, i) => ({
        id: `a-body-${String(i).padStart(5, "0")}`,
        title: `Article ${i}`,
        body: "the",
      })),
      { id: "z-winner", title: "The", body: "" },
    ];
    const engine = await compiledEngine(documents);
    const actual = engine._searchDetailedSync(
      "the",
      { limit: 1, relatedLimit: 0, relationshipStrategy: "none" },
      false
    );
    expect(actual.results[0].id).toBe("z-winner");
    expect(actual.meta.documentsFullyEvaluated).toBeGreaterThanOrEqual(2);
    expect(actual.meta.documentsBoundRejected).toBeGreaterThan(790);
  });

  test.each([
    ["first", "a-exact"],
    ["middle", "b00350-exact"],
    ["final", "z-exact"],
  ])("an exact-title winner in the %s id block is never hidden", async (_label, winnerId) => {
    const documents = Array.from({ length: 700 }, (_, i) => ({
      id: `b${String(i).padStart(5, "0")}`,
      title: `Article ${i}`,
      body: "open",
    }));
    documents.push({
      id: winnerId,
      title: "Open",
      body: "",
    });
    const engine = await compiledEngine(documents);
    const auto = engine._searchDetailedSync(
      "open",
      { limit: 1, relatedLimit: 0 },
      false,
      "auto"
    );
    const exhaustive = engine._searchDetailedSync(
      "open",
      { limit: 1, relatedLimit: 0 },
      false,
      "exhaustive"
    );
    expect(auto.results).toEqual(exhaustive.results);
    expect(auto.results[0].id).toBe(winnerId);
  });

  test("late input order cannot hide a smaller equal-score id or unseen phrase band", async () => {
    const documents = Array.from({ length: 600 }, (_, i) => ({
      id: `m-body-${String(i).padStart(5, "0")}`,
      title: `Article ${i}`,
      body: "open",
      lexicalFrequency: null,
    }));
    documents.push({
      id: "a-smallest-id-supplied-last",
      title: "Article smallest",
      body: "open",
      lexicalFrequency: null,
    });
    documents.push({
      id: "z-new-phrase-signature",
      title: "Article phrase",
      body: "open open open open",
      lexicalFrequency: { open: 4 },
    });
    const engine = await compiledEngine(documents);
    const query = engine._prepareQuery("open");
    const retrieved = engine.retriever.retrieve(query, engine._index);
    const runtime = engine._index.compiledLexical;
    const plan = planExactFeaturePruning({
      retrieved,
      query,
      requiredDepth: 1,
      extension: runtime.exactPruning,
    });
    const retained = plan.retainedBounded.map((hit) => hit.document.id);
    expect(retained).toContain("a-smallest-id-supplied-last");
    expect(retained).toContain("z-new-phrase-signature");
  });

  test("multi-term, retrieval-score, all-strong, and active relationships fail closed", async () => {
    const documents = bodyFlood(500);
    const unsupported = await compiledEngine(documents);
    const multi = unsupported._searchDetailedSync(
      "the body",
      { limit: 5, relatedLimit: 0 },
      false
    );
    expect(multi.meta.documentsBoundRejected).toBe(0);
    expect(multi.meta.pruningFallbackReason).toBe("no-provable-candidates");

    const scored = await compiledEngine(documents, {
      retrievalScoreWeight: 0.1,
    });
    const scoredResult = scored._searchDetailedSync(
      "the",
      { limit: 5, relatedLimit: 0 },
      false
    );
    expect(scoredResult.meta.pruningFallbackReason).toBe(
      "retrieval-score-weight"
    );

    const customRetriever = {
      name: "custom-reference",
      retrieve: retrieveCandidates,
    };
    const custom = await compiledEngine(documents, {
      retriever: customRetriever,
    });
    const customResult = custom._searchDetailedSync(
      "the",
      { limit: 5, relatedLimit: 0 },
      false
    );
    expect(customResult.meta.pruningFallbackReason).toBe(
      "unsupported-retriever"
    );
    expect(customResult.meta.documentsFullyEvaluated).toBe(
      customResult.meta.matchCount
    );

    const relationships = {
      format: "search-v2-relationships",
      version: 1,
      relationships: {
        winner: [{
          target: "body-000000",
          type: "test",
          strength: 1,
        }],
      },
    };
    const active = await compiledEngine(documents, {
      relationships,
      relationshipStrategy: "hybrid",
    });
    for (const [sourcePolicy, reason] of [
      ["top1-strong", "active-relationships"],
      ["top-n-strong", "active-relationships"],
      ["all-strong", "all-strong-relationships"],
    ]) {
      const options = {
        limit: 5,
        relatedLimit: 1,
        relationshipStrategy: "hybrid",
        sourcePolicy,
      };
      const activeResult = active._searchDetailedSync(
        "the",
        options,
        false,
        "auto"
      );
      const activeExhaustive = active._searchDetailedSync(
        "the",
        options,
        false,
        "exhaustive"
      );
      expect(publicSurface(activeResult)).toEqual(
        publicSurface(activeExhaustive)
      );
      expect(activeResult.meta.pruningFallbackReason).toBe(reason);
      expect(activeResult.meta.documentsFullyEvaluated).toBe(
        activeResult.meta.matchCount
      );
    }
  });

  test("Worker uses the same exact pruned representative path", async () => {
    const documents = bodyFlood(1_000);
    const english = morphology();
    const lexicalIndex = compileLexicalIndex(documents, {
      schema,
      plugins: [english],
    });
    const engine = await compiledEngine(documents, {
      lexicalIndex,
      plugins: [english],
    });
    const expected = await engine._searchDetailedAsync(
      "the",
      { limit: 10, relatedLimit: 0, explain: true },
      false
    );
    const runtime = createWorkerRuntime({
      SearchEngine,
      english: morphology,
      dictionary,
    });
    let publish;
    const published = new Promise((resolve) => {
      publish = resolve;
    });
    const client = createSearchClient({
      worker: createLoopbackTransport(runtime),
      onResult({ result }) {
        publish(result);
      },
    });
    await client.init({
      documents,
      schema,
      lexicalIndex,
      retriever: "indexed",
      relationshipStrategy: "none",
      _includeRetrievalDiagnostics: true,
    });
    client.setQuery("the", {
      limit: 10,
      relatedLimit: 0,
      explain: true,
    });
    const actual = await published;
    expect(actual.results).toEqual(expected.results);
    expect(actual.related).toEqual(expected.related);
    expect(actual.meta.documentsFullyEvaluated).toBe(
      expected.meta.documentsFullyEvaluated
    );
    expect(actual.meta.documentsBoundRejected).toBe(
      expected.meta.documentsBoundRejected
    );
    expect(actual.meta.documentBlocksSkipped).toBe(
      expected.meta.documentBlocksSkipped
    );
    expect(actual.meta.boundedBlocksSkipped).toBe(
      expected.meta.boundedBlocksSkipped
    );
    client.terminate();
  }, 120_000);

  test("Worker internal exhaustive pruning switch still selects exhaustive mode", async () => {
    const documents = bodyFlood(1_000);
    const english = morphology();
    const lexicalIndex = compileLexicalIndex(documents, {
      schema,
      plugins: [english],
    });
    const engine = await compiledEngine(documents, {
      lexicalIndex,
      plugins: [english],
    });
    const expected = await engine._searchDetailedAsync(
      "the",
      { limit: 10, relatedLimit: 0, explain: true },
      false,
      "exhaustive"
    );
    const runtime = createWorkerRuntime({
      SearchEngine,
      english: morphology,
      dictionary,
    });
    let publish;
    const published = new Promise((resolve) => {
      publish = resolve;
    });
    const client = createSearchClient({
      worker: createLoopbackTransport(runtime),
      onResult({ result }) {
        publish(result);
      },
    });
    await client.init({
      documents,
      schema,
      lexicalIndex,
      retriever: "indexed",
      relationshipStrategy: "none",
      _exactPruningMode: "exhaustive",
      _includeRetrievalDiagnostics: true,
    });
    client.setQuery("the", {
      limit: 10,
      relatedLimit: 0,
      explain: true,
    });
    const actual = await published;
    expect(actual.results).toEqual(expected.results);
    expect(actual.related).toEqual(expected.related);
    expect(actual.meta.documentsFullyEvaluated).toBe(expected.meta.documentsFullyEvaluated);
    expect(actual.meta.documentsFullyEvaluated).toBe(actual.meta.matchCount);
    client.terminate();
  }, 120_000);
});
