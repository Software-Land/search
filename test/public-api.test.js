import * as publicApi from "../dist/index.js";
import {
  SearchEngine,
  morphology,
  dictionary,
  PUBLIC_EXPORTS,
  RETRIEVER_NAMES,
  InvalidConfigurationError,
  InvalidDocumentError,
  ArtifactVersionError,
  ArtifactValidationError,
  IndexStateError,
  isAbortError,
  parseRelationships,
  parseEquivalences,
} from "../dist/index.js";
import { createSearchClient, createWorkerRuntime, createLoopbackTransport } from "../dist/browser/index.js";

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

const plugins = [morphology(), dictionary({ entries: [{ key: "wifi", expansion: ["wi", "fi"] }] })];

async function make(opts = {}) {
  const e = SearchEngine.create({ schema, plugins, relationships: graph, ...opts });
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

  test("malformed create() options throw InvalidConfigurationError", () => {
    expect(() => SearchEngine.create({ retriever: "bm25" })).toThrow(InvalidConfigurationError);
    expect(() => SearchEngine.create({ relationshipStrategy: "best" })).toThrow(InvalidConfigurationError);
    expect(() => SearchEngine.create({ candidateLimit: 0 })).toThrow(InvalidConfigurationError);
    expect(() => SearchEngine.create({ mystery: true })).toThrow(InvalidConfigurationError);
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
    await client.init({ documents: docs, schema, dictionaryEntries: [], retriever: "indexed", candidateLimit: 50 });
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
      dictionaryEntries: [{ key: "wifi", expansion: ["wi", "fi"] }],
      relationships: graph,
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
      dictionaryEntries: [],
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

  test("equivalence entries preserve primary; explain rows include constraints and token surfaces", async () => {
    const parsed = parseEquivalences({
      format: "search-v2-equivalences",
      version: 1,
      entries: [{ key: "wifi", expansion: ["wi", "fi"], primary: "Wi-Fi" }],
    });
    expect(parsed.entries[0].primary).toBe("Wi-Fi");
    const e = await make();
    const row = e.searchDetailed("bluetooth", { explain: true }).results[0];
    expect(Array.isArray(row.constraints)).toBe(true);
    expect(Array.isArray(row.explanation.query.originalSurface)).toBe(true);
  });
});
