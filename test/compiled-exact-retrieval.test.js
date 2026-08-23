import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SearchEngine,
  dictionary,
  morphology,
} from "../dist/index.js";
import {
  attachLexicalFrequency,
  compileLexicalIndex,
} from "../tools/search-lexical/index.js";
import {
  createLoopbackTransport,
  createSearchClient,
  createWorkerRuntime,
} from "../dist/browser/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "software-land");
const load = (name) => JSON.parse(fs.readFileSync(path.join(fixture, name), "utf8"));
const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

function background(prefix, n = 400) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-bg-${String(i).padStart(5, "0")}`,
    title: `Background document ${i}`,
    body: "lorem ipsum dolor sit amet unrelated content",
  }));
}

function probezzCorpus(n = 600) {
  const docs = [{ id: "winner-probezz", title: "The Probezz", body: "notes" }];
  for (let i = 0; i < n; i += 1) {
    docs.push({
      id: `probezz-flood-${String(i).padStart(5, "0")}`,
      title: `Notes probezz extra extra extra ${i}`,
      body: Array.from({ length: 16 }, () => "probezz").join(" "),
    });
  }
  return [...docs, ...background("probezz")];
}

function tiezzCorpus(n = 600) {
  const docs = [{ id: "000-tiezz-winner", title: "Notes Tiezz", body: "tiezz" }];
  for (let i = 0; i < n; i += 1) {
    docs.push({
      id: `tiezz-flood-${String(i).padStart(5, "0")}`,
      title: "Notes Tiezz",
      body: Array.from({ length: 24 }, () => "tiezz").join(" "),
    });
  }
  return [...docs, ...background("tiezz")];
}

function equalTightnessCorpus(n = 600) {
  const docs = [{
    id: "winner-equal-tightness",
    title: "Notes Alpha Filler",
    body: "alpha beta",
  }];
  for (let i = 0; i < n; i += 1) {
    docs.push({
      id: `equal-tightness-flood-${String(i).padStart(5, "0")}`,
      title: "Notes Alpha Filler",
      body: `${"alpha ".repeat(12)}separator ${"beta ".repeat(12)}`,
    });
  }
  return [...docs, ...background("equal-tightness")];
}

function highDfTheCorpus(n = 5_000) {
  const docs = [{ id: "winner-the", title: "A The", body: "notes" }];
  for (let i = 0; i < n; i += 1) {
    docs.push({
      id: `the-flood-${String(i).padStart(5, "0")}`,
      title: `Notes the extra extra ${i}`,
      body: Array.from({ length: 20 }, () => "the").join(" "),
    });
  }
  return [...docs, ...background("the", 300)];
}

function softwareLandDistractors(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `sl-compiled-flood-${String(i).padStart(5, "0")}`,
    title: "Unrelated filler notes",
    body: [
      "2 2 2 2 2",
      "testing search index document query title body token",
      "what is the of and to in a for on with as by from",
      "tls vpn network protocol security machine learning",
    ].join(" "),
  }));
}

async function engines(documents, {
  lemmas = {},
  entries = [],
  relationships = null,
  relationshipStrategy = "none",
  precompiled = false,
} = {}) {
  const english = morphology({ lemmas });
  const plugins = [english, dictionary({ entries })];
  const common = { schema, plugins, relationships, relationshipStrategy };
  const full = SearchEngine.create({ ...common, retriever: "full-scan" });
  const lexicalIndex = precompiled
    ? compileLexicalIndex(documents, {
        schema,
        lemma: english.lemma,
        analyzerId: english.indexIdentity,
      })
    : undefined;
  const compiled = SearchEngine.create({
    ...common,
    retriever: "indexed",
    candidateLimit: 1,
    lexicalIndex,
  });
  await full.index(documents);
  await compiled.index(documents);
  return { full, compiled };
}

function publicSurface(value) {
  return {
    results: value.results,
    related: value.related,
  };
}

function explainedHitContract(row) {
  return {
    id: row.id,
    title: row.title,
    rank: row.rank,
    score: row.score,
    relevanceKind: row.relevanceKind,
    directClass: row.directClass,
    retrievalSources: row.retrievalSources,
    constraints: row.constraints,
    constraintsVsNext: row.explanation?.constraintsVsNext,
    constraintMeta: row.explanation?.constraintMeta,
  };
}

function explainedContractSurface(value) {
  return {
    results: value.results.map(explainedHitContract),
    related: value.related.map(explainedHitContract),
  };
}

function exactDiagnosticSurface(value) {
  return {
    candidateCount: value.meta.candidateCount,
    candidateTitles: value.meta.candidateTitles,
    relatedCount: value.meta.relatedCount,
    constraintCycles: value.meta.constraintCycles,
    constraintConflicts: value.meta.constraintConflicts,
    primaryId: value.meta.primaryId,
    primaryIds: value.meta.primaryIds,
  };
}

function expectExact(full, compiled, query, options = { limit: 10, relatedLimit: 5, explain: true }) {
  const expected = full.searchDetailed(query, options);
  const actual = compiled.searchDetailed(query, { ...options, candidateLimit: 1 });
  expect(publicSurface(actual)).toEqual(publicSurface(expected));
  if (options.explain) {
    expect(explainedContractSurface(actual)).toEqual(explainedContractSurface(expected));
  }
  expect(exactDiagnosticSurface(actual)).toEqual(exactDiagnosticSurface(expected));
  expect(compiled.retriever.stats().rawDocumentScans).toBe(0);
  return actual;
}

function workerStableMeta(value) {
  return {
    candidateCount: value.meta.candidateCount,
    matchCount: value.meta.matchCount,
    representativeSelection: value.meta.representativeSelection,
    postingEntriesVisited: value.meta.postingEntriesVisited,
    distinctDocumentsExamined: value.meta.distinctDocumentsExamined,
    rawDocumentScans: value.meta.rawDocumentScans,
    relationshipStrategy: value.meta.relationshipStrategy,
    relatedCount: value.meta.relatedCount,
  };
}

async function searchWorker(
  documents,
  lexicalIndex,
  query,
  options,
  { relationships = null, relationshipStrategy = "none" } = {}
) {
  const runtime = createWorkerRuntime({
    SearchEngine,
    english: morphology,
    dictionary,
  });
  let publish;
  let rejectPublish;
  const published = new Promise((resolve, reject) => {
    publish = resolve;
    rejectPublish = reject;
  });
  const client = createSearchClient({
    worker: createLoopbackTransport(runtime),
    onResult({ result }) {
      publish(result);
    },
    onError({ error }) {
      rejectPublish(error);
    },
  });
  try {
    await client.init({
      documents,
      schema,
      dictionaryEntries: [],
      retriever: "indexed",
      relationships,
      relationshipStrategy,
      lexicalIndex,
      _includeRetrievalDiagnostics: true,
    });
    client.setQuery(query, options);
    return await published;
  } finally {
    client.terminate();
  }
}

describe("Stage-1 exact compiled retrieval under pressure", () => {
  test("Stage 1A in-memory and Stage 1B hydrated indexes enumerate all 215 exact hit sets", async () => {
    const documents = attachLexicalFrequency(load("documents.json"), load("lexical-frequency.json"));
    const relationships = load("relationships.json");
    const { full, compiled } = await engines(documents, {
      lemmas: load("lemmas.json"),
      entries: load("dictionary.json"),
      relationships,
      relationshipStrategy: "hybrid",
      precompiled: true,
    });
    const fallback = SearchEngine.create({
      schema,
      plugins: full.plugins,
      relationships,
      relationshipStrategy: "hybrid",
      retriever: "indexed",
      candidateLimit: 1,
    });
    await fallback.index(documents);
    for (const row of load("query-result-oracle.json").rows) {
      const query = full._prepareQuery(row.query);
      const expected = full.retriever.retrieve(query, full._index)
        .map((hit) => [hit.document.id, hit.retrievalSources])
        .sort((a, b) => a[0].localeCompare(b[0]));
      const hydrated = compiled.retriever.retrieve(query, compiled._index)
        .map((hit) => [hit.document.id, hit.retrievalSources])
        .sort((a, b) => a[0].localeCompare(b[0]));
      const inMemory = fallback.retriever.retrieve(query, fallback._index)
        .map((hit) => [hit.document.id, hit.retrievalSources])
        .sort((a, b) => a[0].localeCompare(b[0]));
      expect(inMemory).toEqual(expected);
      expect(hydrated).toEqual(expected);
    }
  }, 120_000);

  test("probezz, tiezz, equal-tightness, and high-DF the equal full scan", async () => {
    for (const [query, documents, winner, precompiled] of [
      ["probezz", probezzCorpus(), "winner-probezz", true],
      ["tiezz", tiezzCorpus(), "000-tiezz-winner", false],
      ["alpha beta", equalTightnessCorpus(), "winner-equal-tightness", false],
      ["the", highDfTheCorpus(), "winner-the", false],
    ]) {
      const { full, compiled } = await engines(documents, { precompiled });
      const detailed = expectExact(full, compiled, query, {
        limit: 10,
        relatedLimit: 0,
        explain: true,
      });
      expect(detailed.results[0].id).toBe(winner);
      expect(detailed.meta.matchCount).toBeGreaterThan(200);
      expect(detailed.meta.representativeSelection.retained).toBeLessThan(detailed.meta.matchCount);
    }
  }, 120_000);

  test("normal search keeps representative ranking while searchDetailed restores full diagnostics", async () => {
    const { full, compiled } = await engines(probezzCorpus());
    const options = { limit: 3, relatedLimit: 0, explain: false };

    expect(compiled.search("probezz", options)).toEqual(full.search("probezz", options));
    expect(compiled.lastSearchMeta.representativeSelection.plannedFullRanking).toBe(false);

    const expected = full.searchDetailed("probezz", options);
    const actual = compiled.searchDetailed("probezz", options);
    expect(publicSurface(actual)).toEqual(publicSurface(expected));
    expect(exactDiagnosticSurface(actual)).toEqual(exactDiagnosticSurface(expected));
    expect(actual.meta.representativeSelection.plannedFullRanking).toBe(true);

    const asyncActual = await compiled.searchDetailedAsync("probezz", options);
    expect(publicSurface(asyncActual)).toEqual(publicSurface(expected));
    expect(exactDiagnosticSurface(asyncActual)).toEqual(exactDiagnosticSurface(expected));
  });

  test("precompiled, fallback, sync, and async paths preserve the full pressure explain contract", async () => {
    const documents = probezzCorpus();
    const { full, compiled: precompiled } = await engines(documents, { precompiled: true });
    const fallback = SearchEngine.create({
      schema,
      plugins: full.plugins,
      retriever: "indexed",
      relationshipStrategy: "none",
      candidateLimit: 1,
    });
    await fallback.index(documents);
    const options = { limit: 10, relatedLimit: 0, explain: true };
    const expected = full.searchDetailed("probezz", options);
    const precompiledSync = precompiled.searchDetailed("probezz", options);
    const precompiledAsync = await precompiled.searchDetailedAsync("probezz", options);
    const fallbackSync = fallback.searchDetailed("probezz", options);

    for (const actual of [precompiledSync, precompiledAsync, fallbackSync]) {
      expect(publicSurface(actual)).toEqual(publicSurface(expected));
      expect(explainedContractSurface(actual)).toEqual(explainedContractSurface(expected));
      expect(exactDiagnosticSurface(actual)).toEqual(exactDiagnosticSurface(expected));
    }
    expect(publicSurface(precompiledSync)).toEqual(publicSurface(fallbackSync));
    expect(precompiledSync.meta.representativeSelection.retained)
      .toBeLessThan(precompiledSync.meta.matchCount);
  });

  test("Worker representative search matches precompiled in-process async with and without explanations", async () => {
    const documents = [
      ...probezzCorpus(),
      { id: "probezz-neighbor", title: "Unrelated Neighbor", body: "unrelated" },
    ];
    const relationships = {
      format: "search-v2-relationships",
      version: 1,
      relationships: {
        "winner-probezz": [{
          target: "probezz-neighbor",
          type: "test",
          strength: 1,
        }],
      },
    };
    const english = morphology();
    const plugins = [english, dictionary({ entries: [] })];
    const lexicalIndex = compileLexicalIndex(documents, {
      schema,
      lemma: english.lemma,
      analyzerId: english.indexIdentity,
    });
    const inProcess = SearchEngine.create({
      schema,
      plugins,
      relationships,
      retriever: "indexed",
      relationshipStrategy: "separate",
      candidateLimit: 1,
      lexicalIndex,
    });
    await inProcess.index(documents);

    for (const explain of [false, true]) {
      const options = { limit: 10, relatedLimit: 1, explain };
      const publicAsync = await inProcess.searchDetailedAsync("probezz", options);
      const representativeAsync = await inProcess._searchDetailedAsync("probezz", options, false);
      const worker = await searchWorker(documents, lexicalIndex, "probezz", options, {
        relationships,
        relationshipStrategy: "separate",
      });

      expect(publicSurface(worker)).toEqual(publicSurface(publicAsync));
      expect(publicSurface(worker)).toEqual(publicSurface(representativeAsync));
      expect(workerStableMeta(worker)).toEqual(workerStableMeta(representativeAsync));
      expect(worker.related).toHaveLength(1);
      expect(worker.related[0].rank).toBe(publicAsync.related[0].rank);
      expect(worker.related[0].rank).toBeGreaterThan(options.limit);
      if (explain) {
        expect(explainedContractSurface(worker)).toEqual(explainedContractSurface(publicAsync));
      }
    }
  }, 120_000);

  test("Software.Land pressure preserves machine prefixes and full conflict diagnostics", async () => {
    const originals = attachLexicalFrequency(load("documents.json"), load("lexical-frequency.json"));
    const documents = [...originals, ...softwareLandDistractors(1_000)];
    const { full, compiled } = await engines(documents, {
      lemmas: load("lemmas.json"),
      entries: load("dictionary.json"),
      relationships: load("relationships.json"),
      relationshipStrategy: "hybrid",
      precompiled: true,
    });
    for (const query of ["machine l", "machine le"]) {
      const actual = expectExact(full, compiled, query, {
        limit: 10,
        relatedLimit: 5,
        explain: true,
      });
      expect(actual.meta.matchCount).toBeGreaterThan(200);
    }
    const conflict = expectExact(full, compiled, "what are apis", {
      limit: 10,
      relatedLimit: 5,
      explain: true,
    });
    expect(conflict.meta.constraintConflicts).toBeGreaterThan(0);
    expect(conflict.results[0].explanation.constraintMeta.conflictCount)
      .toBe(conflict.meta.constraintConflicts);
    expect(conflict.meta.representativeSelection.retained)
      .toBeLessThan(conflict.meta.candidateCount);
  }, 120_000);

  test.each([400, 1_000, 5_000])(
    "all 215 Software.Land queries preserve top1/top3/top5/top10 with +%i distractors",
    async (flood) => {
      const originals = attachLexicalFrequency(load("documents.json"), load("lexical-frequency.json"));
      const documents = [...originals, ...softwareLandDistractors(flood)];
      const { full, compiled } = await engines(documents, {
        lemmas: load("lemmas.json"),
        entries: load("dictionary.json"),
        relationships: load("relationships.json"),
        relationshipStrategy: "hybrid",
        precompiled: flood !== 1_000,
      });
      for (const row of load("query-result-oracle.json").rows) {
        const expected = full.searchDetailed(row.query, { limit: 10, relatedLimit: 5 });
        const actual = compiled.searchDetailed(row.query, {
          limit: 10,
          relatedLimit: 5,
          candidateLimit: 1,
        });
        expect(actual.results.map((hit) => hit.id)).toEqual(expected.results.map((hit) => hit.id));
        expect(actual.related.map((hit) => hit.id)).toEqual(expected.related.map((hit) => hit.id));
      }
    },
    180_000
  );

  test("relationship primary selection, related ranks, and constraintsVsNext survive representative reduction", async () => {
    const documents = [
      { id: "primary", title: "Exact Primary", body: "primary" },
      { id: "related", title: "Neighbor", body: "unrelated" },
      ...Array.from({ length: 80 }, (_, i) => ({
        id: `direct-${String(i).padStart(3, "0")}`,
        title: `Primary notes ${i}`,
        body: "primary primary",
      })),
    ];
    const relationships = {
      format: "search-v2-relationships",
      version: 1,
      relationships: {
        primary: [{ target: "related", type: "test", strength: 1 }],
      },
    };
    const { full, compiled } = await engines(documents, {
      relationships,
      relationshipStrategy: "hybrid",
    });
    expectExact(full, compiled, "exact primary", {
      limit: 3,
      relatedLimit: 1,
      explain: true,
    });
  });

  test("relationship target handling keeps the complete featured candidate map", async () => {
    const documents = [
      { id: "primary", title: "Primary", body: "primary" },
      { id: "strong-existing", title: "Primary Companion", body: "primary" },
      { id: "weak-existing", title: "Unrelated Existing", body: "primary" },
      { id: "missing-neighbor", title: "Neighbor Missing", body: "unrelated" },
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `body-${String(i).padStart(3, "0")}`,
        title: `Body note ${i}`,
        body: "primary",
      })),
    ];
    const relationships = {
      format: "search-v2-relationships",
      version: 1,
      relationships: {
        primary: [
          { target: "strong-existing", type: "test", strength: 1 },
          { target: "weak-existing", type: "test", strength: 0.9 },
          { target: "missing-neighbor", type: "test", strength: 0.8 },
        ],
      },
    };
    const { full, compiled } = await engines(documents, {
      relationships,
      relationshipStrategy: "hybrid",
    });

    const query = compiled._prepareQuery("primary");
    const retrieved = compiled.retriever.retrieve(query, compiled._index);
    const expanded = compiled._expandAndFeature(retrieved, query, "hybrid");
    const byId = new Map(expanded.featured.map((row) => [row.document.id, row]));
    expect(expanded.applied.primaries[0].document.id).toBe("primary");
    expect(byId.get("strong-existing").features.relevanceKind).toBe("direct");
    expect(byId.get("weak-existing").features.relevanceKind).toBe("related");
    expect(byId.get("missing-neighbor").features.relevanceKind).toBe("related");

    expectExact(full, compiled, "primary", {
      limit: 5,
      relatedLimit: 5,
      explain: true,
    });
  });

  test("precompiled top1, top-n, and all-strong relationship primaries equal full scan", async () => {
    const primaryDocuments = [
      { id: "z-exact", title: "Bluetooth", body: "wireless protocol" },
      { id: "a-guide", title: "Bluetooth Guide", body: "wireless setup" },
      { id: "b-setup", title: "Bluetooth Setup", body: "wireless setup" },
      { id: "c-reference", title: "Bluetooth Reference", body: "wireless reference" },
    ];
    const neighbors = primaryDocuments.map((source) => ({
      id: `${source.id}-neighbor`,
      title: `Unrelated Neighbor ${source.id}`,
      body: "unrelated",
    }));
    const documents = [...primaryDocuments, ...neighbors];
    const relationships = {
      format: "search-v2-relationships",
      version: 1,
      relationships: Object.fromEntries(primaryDocuments.map((source) => [
        source.id,
        [{ target: `${source.id}-neighbor`, type: "test", strength: 1 }],
      ])),
    };
    const { full, compiled } = await engines(documents, {
      relationships,
      relationshipStrategy: "separate",
      precompiled: true,
    });

    for (const [sourcePolicy, expectedCount] of [
      ["top1-strong", 1],
      ["top-n-strong", 3],
      ["all-strong", 4],
    ]) {
      const options = {
        limit: 4,
        relatedLimit: 10,
        relationshipStrategy: "separate",
        sourcePolicy,
        explain: true,
      };
      const expected = full.searchDetailed("bluetooth", options);
      const actual = compiled.searchDetailed("bluetooth", options);
      expect(publicSurface(actual)).toEqual(publicSurface(expected));
      expect(explainedContractSurface(actual)).toEqual(explainedContractSurface(expected));
      expect(exactDiagnosticSurface(actual)).toEqual(exactDiagnosticSurface(expected));
      expect(actual.meta.primaryId).toBe("z-exact");
      expect(actual.meta.primaryIds).toHaveLength(expectedCount);
    }
  });

  test("absolute related ranks retain the smallest uniform signature prefix through the channel output", async () => {
    const related = Array.from({ length: 120 }, (_, i) => ({
      id: `related-${String(i).padStart(3, "0")}`,
      title: `Neighbor ${i}`,
      body: "unrelated",
    }));
    const documents = [
      { id: "primary", title: "Exact Primary", body: "primary" },
      ...Array.from({ length: 120 }, (_, i) => ({
        id: `direct-${String(i).padStart(3, "0")}`,
        title: `Primary notes ${i}`,
        body: "primary primary",
      })),
      ...related,
    ];
    const relationships = {
      format: "search-v2-relationships",
      version: 1,
      relationships: {
        primary: related.map((document) => ({
          target: document.id,
          type: "test",
          strength: 1,
        })),
      },
    };
    const { full, compiled } = await engines(documents, {
      relationships,
      relationshipStrategy: "separate",
    });
    const actual = expectExact(full, compiled, "exact primary", {
      limit: 3,
      relatedLimit: 5,
      explain: false,
    });
    const stats = actual.meta.representativeSelection;
    expect(stats.requestedDepth).toBe(126);
    expect(stats.plannedFullRanking).toBe(true);
    expect(stats.retained).toBe(241);
    expect(actual.meta.relatedCount).toBe(120);
    expect(actual.related.map((row) => row.rank)).toEqual([122, 123, 124, 125, 126]);
  });
});
