import * as publicApi from "../dist/index.js";
import { dictionary } from "../dist/dictionary.js";
import {
  SearchEngine,
  morphology,
  compileAuthoredRelevance,
  PUBLIC_EXPORTS,
  RETRIEVER_NAMES,
  InvalidConfigurationError,
  InvalidDocumentError,
  ArtifactVersionError,
  ArtifactValidationError,
  IndexStateError,
  isAbortError,
  parseRelationships,
} from "../dist/index.js";
import { createSearchClient, createWorkerRuntime, createLoopbackTransport } from "../dist/browser/index.js";
import { pluginByName } from "./helpers/authored.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const docs = [
  { id: "bluetooth", title: "Bluetooth", body: "Connect wireless accessories." },
  { id: "connected-devices", title: "Connected devices", body: "Bluetooth, NFC, USB." },
  { id: "nfc", title: "NFC", body: "Near-field communication." },
  { id: "vpn", title: "VPN", body: "Virtual private network." },
  { id: "wifi", title: "Wi-Fi", body: "Connect to wireless networks." },
];

const graph = {
  format: "search-v2-relationships",
  version: 1,
  relationships: {
    bluetooth: [{ target: "connected-devices", type: "editorial", strength: 1, provenance: "manual" }],
  },
};

const plugins = [
  morphology(),
  ...compileAuthoredRelevance({
    configuredConcepts: [{ key: "wifi", aliases: [["wi", "fi"]] }],
  }).plugins,
];

async function make(opts = {}) {
  const e = SearchEngine.create({ schema, plugins, documentRelationships: graph, ...opts });
  await e.index(docs);
  return e;
}

function ids(rows) {
  return rows.map((r) => r.id);
}

describe("public API", () => {
  test("public export list is frozen", async () => {
    expect(Object.keys(publicApi).filter((k) => k !== "__esModule").sort()).toEqual([...PUBLIC_EXPORTS].sort());
    expect(RETRIEVER_NAMES).toEqual(["full-scan", "indexed", "adaptive"]);
  });

  test("root does not export a synonyms() authoring constructor", () => {
    expect(publicApi).not.toHaveProperty("synonyms");
    expect(PUBLIC_EXPORTS).not.toContain("synonyms");
  });

  test("root does not export a dictionary() factory", () => {
    expect(publicApi).not.toHaveProperty("dictionary");
    expect(PUBLIC_EXPORTS).not.toContain("dictionary");
  });

  test("root does not export mergeEditorialRelationships", () => {
    expect(publicApi).not.toHaveProperty("mergeEditorialRelationships");
    expect(PUBLIC_EXPORTS).not.toContain("mergeEditorialRelationships");
  });

  test("mergeRelationships composes public relationship artifacts", () => {
    const authored = compileAuthoredRelevance({ configuredConcepts: [],
      relationshipMap: { bluetooth: [{ to: { document: "nfc" }, kind: "related" }] },
      documents: docs,
    });
    const merged = publicApi.mergeRelationships(graph, authored.documentRelationships);
    expect(merged.relationships.bluetooth).toEqual([
      { target: "connected-devices", type: "editorial", strength: 1, provenance: "manual" },
      { target: "nfc", type: "editorial", strength: 1, provenance: "manual" },
    ]);
  });

  test("compileAuthoredRelevance is the public authored-relevance compiler", async () => {
    const authored = compileAuthoredRelevance({ configuredConcepts: [{ key: "qa", aliases: [["quality", "assurance"]] }],
      relationshipMap: { qa: [{ to: { form: "testing" }, kind: "equivalent" }] },
    });
    expect(pluginByName(authored, "synonyms").expand("qa").map((row) => row.form)).toEqual(["testing"]);
    expect(authored.plugins.map((plugin) => plugin.name)).toEqual(["dictionary", "synonyms"]);
    expect(Object.keys(authored).sort()).toEqual(["documentRelationships", "plugins"]);
    const engine = SearchEngine.create({
      schema,
      plugins: [morphology(), ...authored.plugins],
      retriever: "full-scan",
      relationshipStrategy: "none",
    });
    await engine.index([
      { id: "qa-guide", title: "Quality Assurance Guide", body: "process quality assurance handbook" },
      { id: "load", title: "Load Testing", body: "performance load testing notes" },
    ]);
    expect(ids(engine.search("qa", { limit: 5 }))).toEqual(expect.arrayContaining(["qa-guide", "load"]));
    const explained = engine.searchDetailed("qa", { limit: 5, explain: true });
    const identity = explained.results.find((row) => row.id === "qa-guide");
    const recalled = explained.results.find((row) => row.id === "load");
    expect(identity.retrievalSources).toContain("configured-concept");
    expect(identity.retrievalSources).not.toContain("configured-equivalence");
    expect(recalled.retrievalSources).toContain("equivalent-recall");
    expect(recalled.retrievalSources).not.toContain("synonym-recall");
    expect(recalled.explanation.query.equivalentRecall).toEqual([{ source: "qa", target: "testing" }]);
    expect(recalled.explanation.query).not.toHaveProperty("synonymRecall");
    expect(recalled.features.equivalentRecallMatch).toBe(true);
    expect(recalled.features).not.toHaveProperty("synonymRecallMatch");
    expect(identity.features.configuredConceptMatch).toBe("expansion");
    expect(identity.features).not.toHaveProperty("configuredEquivalenceMatch");
    expect(recalled.features.configuredConceptMatch).toBe(false);
    expect(recalled.features).not.toHaveProperty("configuredEquivalenceMatch");
    expect(identity.explanation.query.concepts.some((concept) => concept.kind === "configured-concept" && concept.id === "qa")).toBe(true);
    expect(identity.explanation.query.concepts.every((concept) => concept.kind !== "acronym")).toBe(true);
    expect(recalled.explanation.query.concepts.every((concept) => concept.kind !== "acronym")).toBe(true);
    expect(recalled.explanation.query.concepts.some((concept) => concept.provenance === "equivalent-recall")).toBe(true);
    expect(recalled.explanation.query.concepts.every((concept) => concept.provenance !== "synonym")).toBe(true);
    expect(recalled.relevanceKind).toBe("direct");
    expect(identity.directClass).toBeTruthy();
    expect(ids(engine.search("qa", { limit: 5 }))).toEqual(ids(explained.results));
  });

  test("internal dictionary() does not compile relationshipMap as a complete authoring path", () => {
    const plugin = dictionary({
      entries: [{ key: "http", aliases: [["hypertext", "transfer", "protocol"]] }],
      relationshipMap: { hypertext: [{ to: { concept: "http" }, kind: "related" }] },
    });
    expect(plugin.standaloneRecallByToken.get("hypertext")).toBeUndefined();
    const authored = compileAuthoredRelevance({ configuredConcepts: [{ key: "http", aliases: [["hypertext", "transfer", "protocol"]] }],
      relationshipMap: { hypertext: [{ to: { concept: "http" }, kind: "related" }] },
    });
    expect(pluginByName(authored, "dictionary").standaloneRecallByToken.get("hypertext")).toBe("http");
  });

  test("root does not export parseSynonyms or a synonym artifact parser", () => {
    expect(publicApi).not.toHaveProperty("parseSynonyms");
    expect(PUBLIC_EXPORTS).not.toContain("parseSynonyms");
    expect(publicApi.ARTIFACT_FORMATS).not.toHaveProperty("synonyms");
  });

  test("root does not export internalized authoring names", () => {
    for (const name of [
      "parseEquivalences",
      "compileRelationshipMap",
      "normalizeSearchEquivalences",
      "MAX_SEARCH_EQUIVALENCE_TARGETS",
    ]) {
      expect(publicApi).not.toHaveProperty(name);
      expect(PUBLIC_EXPORTS).not.toContain(name);
    }
    expect(publicApi.ARTIFACT_FORMATS).not.toHaveProperty("equivalences");
  });

  test("malformed create() options throw InvalidConfigurationError", () => {
    expect(() => SearchEngine.create({ retriever: "bm25" })).toThrow(InvalidConfigurationError);
    expect(() => SearchEngine.create({ relationshipStrategy: "best" })).toThrow(InvalidConfigurationError);
    expect(() => SearchEngine.create({ candidateLimit: 0 })).toThrow(InvalidConfigurationError);
    expect(() => SearchEngine.create({ mystery: true })).toThrow(InvalidConfigurationError);
    expect(() => SearchEngine.create({ relationships: graph })).toThrow(InvalidConfigurationError);
    expect(() => SearchEngine.create({ schema: { title: { type: "text", role: "heading" } } })).toThrow(
      InvalidConfigurationError
    );
  });

  test("index requires ids and last-wins duplicates", async () => {
    const e = SearchEngine.create({ schema, plugins: [morphology()] });
    await expect(e.index([{ title: "No id" }])).rejects.toBeInstanceOf(InvalidDocumentError);
    const info = await e.index([
      { id: "a", title: "First", body: "x" },
      { id: "a", title: "Second", body: "y" },
    ]);
    expect(info.documentCount).toBe(1);
    expect(e.search("second")[0].title).toBe("Second");
  });

  test("search before index throws IndexStateError", () => {
    const e = SearchEngine.create({ schema });
    expect(() => e.search("x")).toThrow(IndexStateError);
  });

  test("artifact version and format fail closed", () => {
    expect(() => parseRelationships({ format: "search-v2-relationships", version: 2, relationships: {} })).toThrow(
      ArtifactVersionError
    );
    expect(() => parseRelationships({ relationships: {} })).toThrow(ArtifactValidationError);
  });

  test("search === searchDetailed.results for built-in retrievers and strategies", async () => {
    for (const retriever of ["full-scan", "indexed", "adaptive"]) {
      for (const relationshipStrategy of ["hybrid", "separate"]) {
        const e = await make({ retriever, relationshipStrategy, candidateLimit: 200 });
        const q = "bluetooth";
        const opts = { limit: 5, relatedLimit: 3 };
        const detailed = e.searchDetailed(q, opts);
        expect(ids(e.search(q, opts))).toEqual(ids(detailed.results));
      }
    }
  });

  test("sync and async produce identical ids and titles", async () => {
    const e = await make({ retriever: "indexed", candidateLimit: 200 });
    const sync = e.searchDetailed("nfc", { limit: 5, explain: true });
    const asyncd = await e.searchDetailedAsync("nfc", { limit: 5, explain: true });
    expect(ids(asyncd.results)).toEqual(ids(sync.results));
    expect(asyncd.results.map((r) => r.title)).toEqual(sync.results.map((r) => r.title));
    expect(asyncd.related.map((r) => r.id)).toEqual(sync.related.map((r) => r.id));
  });

  test("abort throws AbortError and not []", async () => {
    const e = await make();
    const ac = new AbortController();
    ac.abort();
    expect(() => e.search("bluetooth", { signal: ac.signal })).toThrow();
    try {
      e.search("bluetooth", { signal: ac.signal });
    } catch (err) {
      expect(isAbortError(err)).toBe(true);
    }
    expect(e.search("bluetooth")[0].id).toBe("bluetooth");
  });

  test("explanations and detailed results are JSON-serializable", async () => {
    const e = await make({ retriever: "indexed" });
    const detailed = e.searchDetailed("bluetooth", { explain: true, relatedLimit: 3 });
    expect(() => JSON.stringify(detailed)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(detailed));
    expect(parsed.results[0].explanation.retrievalSources.length).toBeGreaterThan(0);
    expect(parsed.related[0].relationship.type).toBe("editorial");
  });

  test("adaptive uses full-scan below threshold and indexed at or above", async () => {
    const small = SearchEngine.create({
      schema,
      plugins: [morphology()],
      retriever: "adaptive",
      adaptive: { documentThreshold: 100 },
    });
    await small.index(docs);
    expect(small.retriever.stats().active).toBe("full-scan");

    const many = Array.from({ length: 120 }, (_, i) => ({
      id: `d${i}`,
      title: i === 0 ? "Bluetooth" : `Item ${i}`,
      body: "noise",
    }));
    const large = SearchEngine.create({
      schema,
      plugins: [morphology()],
      retriever: "adaptive",
      adaptive: { documentThreshold: 100 },
      candidateLimit: 50,
    });
    await large.index(many);
    expect(large.retriever.stats().active).toBe("indexed-lexical");
    expect(large.search("bluetooth")[0].title).toBe("Bluetooth");
  });

  test("configured alias and short literals remain correct under indexed retrieval", async () => {
    const e = await make({ retriever: "indexed" });
    expect(e.search("wifi")[0].id).toBe("wifi");
    expect(e.search("NFC")[0].id).toBe("nfc");
  });

  test("Worker init accepts retriever names; latest-wins still publishes the last query", async () => {
    const runtime = createWorkerRuntime({ SearchEngine, english: morphology, dictionary });
    const transport = createLoopbackTransport(runtime);
    const published = [];
    const payloads = [];
    const client = createSearchClient({
      worker: transport,
      onResult({ query, result }) {
        published.push(query);
        payloads.push(result);
      },
    });
    await client.init({ documents: docs, schema, configuredConcepts: [], retriever: "indexed", candidateLimit: 50 });
    client.setQuery("n");
    client.setQuery("nfc");
    await new Promise((r) => setTimeout(r, 40));
    expect(published[published.length - 1]).toBe("nfc");
    expect(typeof payloads[payloads.length - 1].meta.candidateCount).toBe("number");
    expect(payloads[payloads.length - 1].meta.representativeSelection).toBeUndefined();
    client.terminate();
  });

  test("Worker explain rows match in-process results and expose only protocol diagnostics", async () => {
    const expectedEngine = await make({ retriever: "indexed", relationshipStrategy: "hybrid" });
    const expected = await expectedEngine.searchDetailedAsync("bluetooth", {
      limit: 5,
      relatedLimit: 3,
      explain: true,
    });
    const runtime = createWorkerRuntime({ SearchEngine, english: morphology, dictionary });
    const transport = createLoopbackTransport(runtime);
    let publish;
    const published = new Promise((resolve) => {
      publish = resolve;
    });
    const client = createSearchClient({
      worker: transport,
      onResult({ result }) {
        publish(result);
      },
    });
    await client.init({
      documents: docs,
      schema,
      configuredConcepts: [{ key: "wifi", aliases: [["wi", "fi"]]}],
      documentRelationships: graph,
      relationshipStrategy: "hybrid",
      retriever: "indexed",
    });
    client.setQuery("bluetooth", { limit: 5, relatedLimit: 3, explain: true });
    const actual = await published;
    expect(actual.results).toEqual(expected.results);
    expect(actual.related).toEqual(expected.related);
    expect(actual.results[0].explanation.constraintsVsNext).toBeTruthy();
    expect(Object.keys(actual.meta).sort()).toEqual([
      "candidateCount",
      "featureMs",
      "matchCount",
      "rankMs",
      "relatedCount",
      "relationshipStrategy",
      "retrieveMs",
      "selectionMs",
      "totalMs",
    ]);
    expect(actual.meta.representativeSelection).toBeUndefined();
    expect(actual.meta.postingBlocksVisited).toBeUndefined();
    expect(actual.meta.pruningFallbackReason).toBeUndefined();
    client.terminate();
  });

  test("Worker retrieval diagnostics stay opt-in and off the default protocol", async () => {
    const runtime = createWorkerRuntime({ SearchEngine, english: morphology, dictionary });
    const transport = createLoopbackTransport(runtime);
    let publish;
    const published = new Promise((resolve) => {
      publish = resolve;
    });
    const client = createSearchClient({
      worker: transport,
      onResult({ result }) {
        publish(result);
      },
    });
    await client.init({
      documents: docs,
      schema,
      configuredConcepts: [],
      retriever: "indexed",
      _includeRetrievalDiagnostics: true,
    });
    client.setQuery("nfc");
    const actual = await published;
    expect(actual.meta.representativeSelection).toEqual(expect.any(Object));
    expect(typeof actual.meta.postingBlocksVisited).toBe("number");
    expect(Object.prototype.hasOwnProperty.call(actual.meta, "pruningFallbackReason")).toBe(true);
    client.terminate();
  });

  test("Worker invalid lexical artifacts reject initialization instead of hanging", async () => {
    const runtime = createWorkerRuntime({ SearchEngine, english: morphology, dictionary });
    const client = createSearchClient({
      worker: createLoopbackTransport(runtime),
    });
    await expect(client.init({
      documents: docs,
      schema,
      retriever: "indexed",
      lexicalIndex: {
        format: "search-v2-lexical-index",
        version: 2,
      },
    })).rejects.toThrow(/version/i);
    client.terminate();
  });

  test("configured concepts are key plus aliases; explain rows include constraints and token surfaces", async () => {
    const authored = compileAuthoredRelevance({
      configuredConcepts: [{ key: "wifi", aliases: [["wi", "fi"]] }],
    });
    expect(authored.plugins[0].byKey.get("wifi").key).toBe("wifi");
    expect(authored.plugins[0].sequences.some((row) => row.tokens.join(" ") === "wi fi")).toBe(true);
    const e = await make();
    const row = e.searchDetailed("bluetooth", { explain: true }).results[0];
    expect(Array.isArray(row.constraints)).toBe(true);
    expect(Array.isArray(row.explanation.query.originalSurface)).toBe(true);
  });
});
