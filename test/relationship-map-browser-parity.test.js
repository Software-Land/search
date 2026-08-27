/**
 * relationshipMap browser Worker parity with in-process authored relevance.
 * Exercises SearchClient.init + loopback Worker, not workerRuntime internals only.
 */
import {
  SearchEngine,
  morphology,
  compileAuthoredRelevance,
  mergeRelationships,
  InvalidConfigurationError,
} from "../dist/index.js";
import { compileRelationshipMap } from "../dist/relationshipMap.js";
import { createSearchClient, createWorkerRuntime, createLoopbackTransport } from "../dist/browser/index.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const documents = [
  { id: "qa-guide", title: "Quality Assurance Guide", body: "qa process handbook" },
  { id: "testing", title: "Testing in Software Engineering", body: "unit testing methods" },
  { id: "http-doc", title: "What is HTTP?", body: "http methods and status codes" },
  { id: "authn", title: "Login Flow", body: "password authentication cookies" },
  { id: "doc-a", title: "Krypton Primary", body: "krypton only body text" },
  { id: "doc-b", title: "Xenon Neighbor", body: "xenon only body text" },
];

const entries = [
  { key: "qa", aliases: [["quality", "assurance"]] },
  { key: "http", aliases: [["hypertext", "transfer", "protocol"]] },
  { key: "appsec", aliases: [["application", "security"]] },
];

const mixedMap = {
  qa: [{ kind: "equivalent", to: { form: "testing" } }],
  hypertext: [{ kind: "related", to: { concept: "http" } }],
  appsec: [{ kind: "related", to: { form: "authentication" } }],
  "doc-a": [{ kind: "related", to: { document: "doc-b" } }],
};

const baseRelationships = {
  format: "search-v2-relationships",
  version: 1,
  relationships: {
    "doc-a": [{ target: "qa-guide", type: "semantic", strength: 0.7, provenance: "generated" }],
  },
};

function publicView(detailed) {
  const related = detailed.related || [];
  return {
    ids: detailed.results.map((hit) => hit.id),
    scores: detailed.results.map((hit) => hit.score),
    relevanceKind: detailed.results.map((hit) => hit.relevanceKind),
    directClass: detailed.results.map((hit) => hit.directClass),
    retrievalSources: detailed.results.map((hit) => hit.retrievalSources || null),
    relatedIds: related.map((hit) => hit.id),
    relatedKind: related.map((hit) => hit.relevanceKind),
    relatedType: related.map((hit) => hit.explanation?.relationship?.type ?? null),
    relatedProvenance: related.map((hit) => hit.explanation?.relationship?.provenance ?? null),
  };
}

function viewFromWorker(payload) {
  return publicView({
    results: payload.results || [],
    related: payload.related || [],
  });
}

async function inProcessSearch({
  relationshipMap,
  retriever = "full-scan",
  relationshipStrategy = "hybrid",
  query,
  options = {},
}) {
  const authored = compileAuthoredRelevance({ configuredConcepts: entries,
    relationshipMap,
    documents,
  });
  const plugins = [morphology(), ...authored.plugins];
  const engine = SearchEngine.create({
    schema,
    plugins,
    documentRelationships: mergeRelationships(baseRelationships, authored.documentRelationships),
    relationshipStrategy,
    retriever,
  });
  await engine.index(documents);
  return publicView(
    await engine.searchDetailedAsync(query, {
      limit: 10,
      relatedLimit: 8,
      explain: true,
      relationshipStrategy,
      ...options,
    })
  );
}

async function workerSearch({
  relationshipMap,
  retriever = "full-scan",
  relationshipStrategy = "hybrid",
  query,
  options = {},
  compileAuthoredRelevance: compile,
  dictionary,
}) {
  const runtime = createWorkerRuntime({
    SearchEngine,
    english: morphology,
    ...(compile ? { compileAuthoredRelevance: compile } : {}),
    ...(dictionary ? { dictionary } : {}),
  });
  let settled;
  const got = new Promise((resolve) => {
    settled = resolve;
  });
  const client = createSearchClient({
    worker: createLoopbackTransport(runtime),
    onResult({ result }) {
      settled(result);
    },
    onError({ error }) {
      settled({ __error: error });
    },
  });
  await client.init({
    documents,
    schema,
    configuredConcepts: entries,
    relationshipMap,
    documentRelationships: baseRelationships,
    relationshipStrategy,
    retriever,
  });
  client.setQuery(query, {
    limit: 10,
    relatedLimit: 8,
    explain: true,
    relationshipStrategy,
    ...options,
  });
  const payload = await got;
  client.terminate();
  if (payload?.__error) {
    throw new Error(String(payload.__error?.message || payload.__error));
  }
  return viewFromWorker(payload);
}

describe("relationshipMap compile projection", () => {
  test("compileRelationshipMap does not leak internal recall maps", () => {
    const compiled = compileRelationshipMap({
      qa: [{ kind: "equivalent", to: { form: "testing" } }],
      hypertext: [{ kind: "related", to: { concept: "http" } }],
    }, { concepts: entries });
    expect(Object.keys(compiled).sort()).toEqual(["editorialRelationships", "synonymMap"]);
    expect(compiled.standaloneRecallByKey).toBeUndefined();
    expect(compiled.topicalRecallByKey).toBeUndefined();
    expect(compiled.synonymMap.qa).toEqual(["testing"]);
  });
});

describe("editorial merge", () => {
  test("keeps generated semantic edges and appends distinct editorial edges", () => {
    const authored = compileAuthoredRelevance({ configuredConcepts: [],
      relationshipMap: { "doc-a": [{ kind: "related", to: { document: "doc-b" } }] },
      documents,
    });
    const original = JSON.parse(JSON.stringify(baseRelationships));
    const merged = mergeRelationships(baseRelationships, authored.documentRelationships);
    expect(baseRelationships).toEqual(original);
    expect(merged.relationships["doc-a"]).toEqual([
      { target: "qa-guide", type: "semantic", strength: 0.7, provenance: "generated" },
      { target: "doc-b", type: "editorial", strength: 1, provenance: "manual" },
    ]);
  });

  test("same source/target/type keeps the first edge", () => {
    const merged = mergeRelationships(
      {
        format: "search-v2-relationships",
        version: 1,
        relationships: {
          "doc-a": [{ target: "doc-b", type: "editorial", strength: 1, provenance: "manual" }],
        },
      },
      {
        format: "search-v2-relationships",
        version: 1,
        relationships: {
          "doc-a": [{ target: "doc-b", type: "editorial", strength: 1, provenance: "manual" }],
        },
      }
    );
    expect(merged.relationships["doc-a"]).toHaveLength(1);
  });

  test("semantic and editorial edges for the same pair stay distinct", () => {
    const merged = mergeRelationships(
      {
        format: "search-v2-relationships",
        version: 1,
        relationships: {
          "doc-a": [{ target: "doc-b", type: "semantic", strength: 0.4, provenance: "generated" }],
        },
      },
      {
        format: "search-v2-relationships",
        version: 1,
        relationships: {
          "doc-a": [{ target: "doc-b", type: "editorial", strength: 1, provenance: "manual" }],
        },
      }
    );
    expect(merged.relationships["doc-a"]).toEqual([
      { target: "doc-b", type: "semantic", strength: 0.4, provenance: "generated" },
      { target: "doc-b", type: "editorial", strength: 1, provenance: "manual" },
    ]);
  });
});

describe("relationshipMap browser parity with in-process authored relevance", () => {
  test("equivalent form, standalone, topical, and editorial survive one Worker init", async () => {
    const queries = [
      { query: "qa", expectIds: ["qa-guide", "testing"], expectSources: "equivalent-recall" },
      { query: "hypertext", expectIds: ["http-doc"], expectSources: "standalone-recall" },
      { query: "appsec", expectIds: ["authn"], expectSources: "topical-recall" },
      {
        query: "krypton primary",
        relationshipStrategy: "separate",
        expectIds: ["doc-a"],
        expectRelated: ["doc-b", "qa-guide"],
      },
    ];
    for (const row of queries) {
      const reference = await inProcessSearch({
        relationshipMap: mixedMap,
        relationshipStrategy: row.relationshipStrategy || "hybrid",
        query: row.query,
      });
      const actual = await workerSearch({
        relationshipMap: mixedMap,
        relationshipStrategy: row.relationshipStrategy || "hybrid",
        query: row.query,
      });
      expect({ query: row.query, actual }).toEqual({ query: row.query, actual: reference });
      expect(reference.ids).toEqual(row.expectIds);
      if (row.expectSources) {
        expect(reference.retrievalSources.some((sources) => (sources || []).includes(row.expectSources))).toBe(true);
      }
      if (row.expectRelated) {
        expect(reference.relatedIds).toEqual(row.expectRelated);
        expect(reference.relatedType).toEqual(["editorial", "semantic"]);
        expect(reference.relatedProvenance).toEqual(["manual", "generated"]);
      }
    }
  });

  test.each([
    ["equivalent", { qa: [{ kind: "equivalent", to: { form: "testing" } }] }, "qa", "full-scan", "hybrid"],
    ["equivalent", { qa: [{ kind: "equivalent", to: { form: "testing" } }] }, "qa", "indexed", "hybrid"],
    ["standalone", { hypertext: [{ kind: "related", to: { concept: "http" } }] }, "hypertext", "full-scan", "none"],
    ["standalone", { hypertext: [{ kind: "related", to: { concept: "http" } }] }, "hypertext", "indexed", "none"],
    ["topical", { appsec: [{ kind: "related", to: { form: "authentication" } }] }, "appsec", "full-scan", "hybrid"],
    ["topical", { appsec: [{ kind: "related", to: { form: "authentication" } }] }, "appsec", "indexed", "hybrid"],
    ["editorial", { "doc-a": [{ kind: "related", to: { document: "doc-b" } }] }, "krypton primary", "full-scan", "separate"],
    ["editorial", { "doc-a": [{ kind: "related", to: { document: "doc-b" } }] }, "krypton primary", "indexed", "hybrid"],
    ["mixed", mixedMap, "qa", "indexed", "hybrid"],
  ])("%s %s/%s matches in-process", async (_kind, relationshipMap, query, retriever, relationshipStrategy) => {
    const reference = await inProcessSearch({ relationshipMap, retriever, relationshipStrategy, query });
    const actual = await workerSearch({ relationshipMap, retriever, relationshipStrategy, query });
    expect(actual).toEqual(reference);
  });

  test("compiles relationshipMap once at init, not per query, and does not call dictionary()", async () => {
    let compiles = 0;
    const compile = (opts) => {
      compiles += 1;
      return compileAuthoredRelevance(opts);
    };
    const runtime = createWorkerRuntime({
      SearchEngine,
      english: morphology,
      compileAuthoredRelevance: compile,
      dictionary: () => {
        throw new Error("dictionary factory must not run");
      },
    });
    const published = [];
    let notify;
    let got = new Promise((resolve) => {
      notify = resolve;
    });
    const client = createSearchClient({
      worker: createLoopbackTransport(runtime),
      onResult({ result }) {
        published.push(viewFromWorker(result));
        notify();
      },
    });
    await client.init({
      documents,
      schema,
      configuredConcepts: entries,
      relationshipMap: mixedMap,
      documentRelationships: baseRelationships,
      relationshipStrategy: "hybrid",
      retriever: "full-scan",
    });
    expect(compiles).toBe(1);
    client.setQuery("qa", { limit: 10, explain: true });
    await got;
    got = new Promise((resolve) => {
      notify = resolve;
    });
    client.setQuery("hypertext", { limit: 10, explain: true });
    await got;
    client.terminate();
    expect(compiles).toBe(1);
    expect(published[0].ids).toContain("testing");
    expect(published[1].ids).toEqual(["http-doc"]);
  });

  test.each([
    ["invalid kind", { qa: [{ kind: "nearby", to: { form: "testing" } }] }, /unsupported relationship kind/],
    ["invalid concept", { hypertext: [{ kind: "related", to: { concept: "missing" } }] }, /unknown concept/],
    ["invalid form", { appsec: [{ kind: "related", to: { form: ["bearer token"] } }] }, /malformed form/],
    ["invalid document", { "doc-a": [{ kind: "related", to: { document: "missing" } }] }, /unknown document/],
    ["forbidden key", { constructor: [{ kind: "equivalent", to: { form: "testing" } }] }, /forbidden relationshipMap key/],
    ["normalized forbidden key", { " constructor ": [{ kind: "equivalent", to: { form: "testing" } }] }, /forbidden relationshipMap key/],
  ])("Worker init fails closed on %s", async (_label, relationshipMap, pattern) => {
    const runtime = createWorkerRuntime({ SearchEngine, english: morphology });
    const client = createSearchClient({
      worker: createLoopbackTransport(runtime),
    });
    await expect(
      client.init({
        documents,
        schema,
        configuredConcepts: entries,
        relationshipMap,
      })
    ).rejects.toThrow(pattern);
    expect(() =>
      compileAuthoredRelevance({ configuredConcepts: entries, relationshipMap, documents })
    ).toThrow(InvalidConfigurationError);
    client.terminate();
  });
});
