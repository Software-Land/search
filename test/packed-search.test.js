/**
 * Packed ranking evidence on ordinary SearchEngine.search().
 * searchDetailed and explain stay on the FeatureVector path.
 */
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/relationships/configuredConcepts.js";
import { compileLexicalIndex } from "../dist/indexing/lexicalIndex.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const dict = [{ key: "ide", aliases: [["integrated", "development", "environment"]] }];

const docs = [
  {
    id: "integrity",
    title: "Integrity Is Not Obedience",
    body: "integrity is a property of systems and people, not mere compliance",
  },
  {
    id: "framework",
    title: "Framework vs Library vs Package",
    body: "the framework may search for code and call it ide support",
  },
  {
    id: "network",
    title: "Network Guide",
    body: "network protocol notes search index document",
  },
  {
    id: "search-index",
    title: "Search Index Guide",
    body: "search index search index",
    lexicalFrequency: { "search index": 2 },
  },
  {
    id: "vpn",
    title: "VPN Settings",
    body: "virtual private network",
  },
];

const graph = {
  format: "search-relationships",
  version: 1,
  relationships: {
    network: [{ target: "vpn", type: "editorial", strength: 0.9, provenance: "test" }],
    integrity: [{ target: "framework", type: "editorial", strength: 0.4, provenance: "test" }],
  },
};

function publicRows(rows) {
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    rank: row.rank,
    score: row.score,
    relevanceKind: row.relevanceKind,
    directClass: row.directClass,
    relationship: row.relationship || null,
  }));
}

async function indexedEngine(extra = {}) {
  const plugins = [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: dict })];
  const lexicalIndex = compileLexicalIndex(docs, { schema, plugins });
  const engine = SearchEngine.create({
    schema,
    plugins,
    lexicalIndex,
    documentRelationships: graph,
    relationshipStrategy: "hybrid",
    retriever: "indexed",
    ...extra,
  });
  await engine.index(docs);
  return engine;
}

describe("packed ordinary search()", () => {
  test("integ keeps Integrity #1 on the FeatureVector prefix-recall path", async () => {
    const engine = await indexedEngine();
    const results = engine.search("integ", { limit: 6 });
    expect(results[0].id).toBe("integrity");
    expect(results[0].title).toBe("Integrity Is Not Obedience");
    expect(engine.lastSearchMeta.rankingEvidence).not.toBe("packed");
  });

  test("ordinary search matches searchDetailed public rows without candidate-wide FeatureVectors", async () => {
    const engine = await indexedEngine();
    for (const query of ["network", "search index", "integ", "tls"]) {
      const packed = engine.search(query, { limit: 10, relatedLimit: 5 });
      const packedMeta = { ...engine.lastSearchMeta };
      const detailed = engine.searchDetailed(query, { limit: 10, relatedLimit: 5 });
      expect(publicRows(packed)).toEqual(publicRows(detailed.results));
      expect(publicRows(engine.lastSearchMeta.related)).toEqual(publicRows(detailed.related));
      if (["network", "search index"].includes(query)) {
        expect(packedMeta.rankingEvidence).toBe("packed");
        expect(packedMeta.directFeatureVectorsConstructed).toBeLessThan(3);
        if (packedMeta.optimizedDirectCandidates > 3) {
          expect(packedMeta.directFeatureVectorsConstructed).toBeLessThan(
            packedMeta.optimizedDirectCandidates
          );
        }
      }
      if (query === "integ") {
        expect(packedMeta.rankingEvidence).not.toBe("packed");
      }
      expect(detailed.meta.rankingEvidence).not.toBe("packed");
    }
  });

  test("hybrid/none/mixed/separate public rows stay identical to the diagnostic path", async () => {
    const engine = await indexedEngine();
    for (const relationshipStrategy of ["hybrid", "none", "mixed", "separate"]) {
      const options = { limit: 8, relatedLimit: 4, relationshipStrategy };
      const packed = engine.search("network", options);
      const detailed = engine.searchDetailed("network", options);
      expect(publicRows(packed)).toEqual(publicRows(detailed.results));
      expect(publicRows(engine.lastSearchMeta.related)).toEqual(publicRows(detailed.related));
    }
  });

  test("sync and async ordinary search match", async () => {
    const engine = await indexedEngine();
    const sync = engine.search("search index", { limit: 8, relatedLimit: 3 });
    const asyncRows = await engine.searchAsync("search index", { limit: 8, relatedLimit: 3 });
    expect(publicRows(asyncRows)).toEqual(publicRows(sync));
    expect(engine.lastSearchMeta.rankingEvidence).toBe("packed");
  });

  test("packed ranking keeps a repeated weak direct ahead of a zero-term neighbor", async () => {
    const localDocs = [
      {
        id: "handbook",
        title: "Beacon Handbook",
        body: "beacon is the subject of this handbook",
      },
      {
        id: "bench",
        title: "Bench Notes",
        body: "beacon beacon appears as ordinary body evidence",
      },
      {
        id: "once",
        title: "Once Notes",
        body: "beacon appears a single time in the body",
      },
      {
        id: "distant",
        title: "Distant Note",
        body: "catalog text with no shared query term",
      },
    ];
    const localGraph = {
      format: "search-relationships",
      version: 1,
      relationships: {
        handbook: [{ target: "distant", type: "semantic", strength: 0.95, provenance: "embedding" }],
      },
    };
    const plugins = [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: dict })];
    const lexicalIndex = compileLexicalIndex(localDocs, { schema, plugins });
    const engine = SearchEngine.create({
      schema,
      plugins,
      lexicalIndex,
      documentRelationships: localGraph,
      relationshipStrategy: "hybrid",
      retriever: "indexed",
    });
    await engine.index(localDocs);
    const options = { limit: 10, relatedLimit: 5 };
    const packed = engine.search("beacon", options);
    const meta = { ...engine.lastSearchMeta };
    const detailed = engine.searchDetailed("beacon", options);
    expect(meta.rankingEvidence).toBe("packed");
    expect(publicRows(packed)).toEqual(publicRows(detailed.results));
    const order = packed.map((row) => row.id);
    expect(order.indexOf("handbook")).toBeLessThan(order.indexOf("bench"));
    expect(order.indexOf("bench")).toBeLessThan(order.indexOf("distant"));
    expect(order.indexOf("distant")).toBeLessThan(order.indexOf("once"));
    const distant = packed.find((row) => row.id === "distant");
    const bench = packed.find((row) => row.id === "bench");
    expect(distant.relevanceKind).toBe("related");
    expect(bench.relevanceKind).toBe("direct");
    expect(bench.directClass).toBe("weak");
    expect(distant.score).toBeGreaterThan(bench.score);
  });

  test("body-block skipping keeps a repeated weak direct that outranks a neighbor", async () => {
    const fillers = Array.from({ length: 12 }, (_, index) => ({
      id: `fill-${index}`,
      title: `Note ${index}`,
      body: "beacon appears once here",
    }));
    const localDocs = [
      {
        id: "handbook",
        title: "Amber Beacon Handbook",
        body: "amber beacon is the subject of this handbook",
      },
      ...fillers,
      {
        id: "bench",
        title: "Bench Notes",
        body: "beacon beacon in the notes",
      },
      {
        id: "distant",
        title: "Distant Note",
        body: "catalog text with no shared query term",
      },
    ];
    const localGraph = {
      format: "search-relationships",
      version: 1,
      relationships: {
        handbook: [{ target: "distant", type: "semantic", strength: 0.95, provenance: "embedding" }],
      },
    };
    const plugins = [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: dict })];
    const lexicalIndex = compileLexicalIndex(localDocs, { schema, plugins });
    const engine = SearchEngine.create({
      schema,
      plugins,
      lexicalIndex,
      documentRelationships: localGraph,
      relationshipStrategy: "hybrid",
      retriever: "indexed",
    });
    await engine.index(localDocs);
    const options = { limit: 10, relatedLimit: 5 };
    const packed = engine.search("amber beacon", options);
    const meta = { ...engine.lastSearchMeta };
    const detailed = engine.searchDetailed("amber beacon", options);
    expect(meta.stage3A).toBe("applied");
    expect(meta.rankingEvidence).toBe("packed");
    expect(publicRows(packed)).toEqual(publicRows(detailed.results));
    const order = packed.map((row) => row.id);
    expect(order).toContain("bench");
    expect(order.indexOf("bench")).toBeLessThan(order.indexOf("distant"));
    expect(packed.find((row) => row.id === "distant").relevanceKind).toBe("related");
  });

  test("explain and retrievalScoreWeight fail closed to the legacy path", async () => {
    const engine = await indexedEngine();
    engine.search("network", { limit: 5, explain: true });
    expect(engine.lastSearchMeta.rankingEvidence).not.toBe("packed");

    const weighted = await indexedEngine({ retrievalScoreWeight: 0.2 });
    weighted.search("network", { limit: 5 });
    expect(weighted.lastSearchMeta.rankingEvidence).not.toBe("packed");
    expect(weighted.lastSearchMeta.pruningFallbackReason).toBe("retrieval-score-weight");
  });
});
