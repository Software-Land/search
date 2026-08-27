/**
 * Compact 0.2.0 compatibility tripwire for later JS → TS conversion.
 * Runs against emitted dist/ (the npm runtime), not src/.
 * Does not replace the existing 248-test suite.
 */
import { morphology, SearchEngine } from "../dist/index.js";
import { dictionary } from "../dist/dictionary.js";
import {
  createSearchClient,
  createWorkerRuntime,
  createLoopbackTransport,
  searchWorkerUrl,
} from "../dist/browser/index.js";
import { compileLexicalFrequency } from "../tools/search-lexical/index.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

function ids(rows) {
  return rows.map((r) => r.id);
}

function titles(rows) {
  return rows.map((r) => r.title);
}

function stableSurface(row) {
  return {
    id: row.id,
    title: row.title,
    matchingPhraseKey: row.features?.matchingPhraseKey ?? null,
    normalizedQueryPhrase: row.features?.normalizedQueryPhrase ?? null,
    configuredEquivalenceMatch: row.features?.configuredEquivalenceMatch ?? false,
    typedSurfaceTitleMatch: row.features?.typedSurfaceTitleMatch ?? false,
  };
}

async function index(engine, documents) {
  await engine.index(documents);
  return engine;
}

describe("0.2.0 migration parity", () => {
  test("configured-concept ml forms share ordered ids and stable explain fields", async () => {
    const mlDict = [{ key: "ml", aliases: [["machine", "learning"]]}];
    const docs = [
      {
        id: "strong-phrase",
        title: "Phrase Heavy Guide",
        body: "machine learning machine learning machine learning machine learning machine learning",
        lexicalFrequency: { "machine learn": 5, machine: 5, learn: 5 },
      },
      { id: "learn-only", title: "Learn Notes", body: "learn without the first expansion word" },
      { id: "key-only", title: "ML Notes", body: "ml ml ml without the expansion phrase" },
      { id: "machine-only", title: "Machine Shop", body: "machine without learn" },
      { id: "weak-incidental", title: "Unrelated Overview", body: "security notes" },
    ];
    const engine = await index(
      SearchEngine.create({ schema, plugins: [morphology(), dictionary({ entries: mlDict })] }),
      docs
    );
    const expectedIds = ["key-only", "strong-phrase", "machine-only", "learn-only"];
    const expectedTitles = ["ML Notes", "Phrase Heavy Guide", "Machine Shop", "Learn Notes"];
    for (const query of ["ml", "machine learning", "machine learn"]) {
      const rows = engine.search(query);
      expect(ids(rows)).toEqual(expectedIds);
      expect(titles(rows)).toEqual(expectedTitles);
      expect(ids(rows)).not.toContain("weak-incidental");
    }

    const ml = engine.searchDetailed("ml", { explain: true }).results;
    expect(stableSurface(ml[0])).toEqual({
      id: "key-only",
      title: "ML Notes",
      matchingPhraseKey: null,
      normalizedQueryPhrase: "machine learn",
      configuredEquivalenceMatch: "key-in-title",
      typedSurfaceTitleMatch: false,
    });
    expect(stableSurface(ml[1])).toEqual({
      id: "strong-phrase",
      title: "Phrase Heavy Guide",
      matchingPhraseKey: "machine learn",
      normalizedQueryPhrase: "machine learn",
      configuredEquivalenceMatch: false,
      typedSurfaceTitleMatch: false,
    });
  });

  test("shards ranks Hot Shards above Sharding with surface evidence; shardsss matches shards", async () => {
    const docs = [
      { id: "/sharding/", title: "Sharding", body: "Sharding is partitioning." },
      {
        id: "/hot-shards/",
        title: "Hot Shards",
        body: "Hot shards happen when a subset of shards receive traffic.",
      },
    ];
    const engine = await index(SearchEngine.create({ schema, plugins: [morphology()] }), docs);
    const shards = engine.searchDetailed("shards", { explain: true }).results;
    expect(ids(shards)).toEqual(["/hot-shards/", "/sharding/"]);
    expect(titles(shards)).toEqual(["Hot Shards", "Sharding"]);
    expect(stableSurface(shards[0])).toMatchObject({
      id: "/hot-shards/",
      typedSurfaceTitleMatch: true,
      normalizedQueryPhrase: "shard",
    });
    expect(stableSurface(shards[1])).toMatchObject({
      id: "/sharding/",
      typedSurfaceTitleMatch: false,
      normalizedQueryPhrase: "shard",
    });

    const shardsss = engine.search("shardsss");
    expect(ids(shardsss)).toEqual(ids(shards));
    expect(titles(shardsss)).toEqual(titles(shards));
  });

  test("sharde preserves the captured 0.2.0 ordered result", async () => {
    const docs = [
      { id: "/sharding/", title: "Sharding", body: "Sharding is partitioning." },
      {
        id: "/hot-shards/",
        title: "Hot Shards",
        body: "Hot shards happen when a subset of shards receive traffic.",
      },
    ];
    const engine = await index(SearchEngine.create({ schema, plugins: [morphology()] }), docs);
    const sharde = engine.searchDetailed("sharde", { explain: true }).results;
    expect(ids(sharde)).toEqual(["/sharding/", "/hot-shards/"]);
    expect(titles(sharde)).toEqual(["Sharding", "Hot Shards"]);
    expect(stableSurface(sharde[0])).toMatchObject({
      id: "/sharding/",
      typedSurfaceTitleMatch: true,
      normalizedQueryPhrase: "shard",
    });
    expect(stableSurface(sharde[1])).toMatchObject({
      id: "/hot-shards/",
      typedSurfaceTitleMatch: true,
      normalizedQueryPhrase: "shard",
    });
  });

  test("http configured-expansion forms preserve ranked ids", async () => {
    const httpDict = [{ key: "http", aliases: [["hypertext", "transfer", "protocol"]]}];
    const docs = [
      { id: "http", title: "HTTP", body: "status codes and methods" },
      { id: "expansion-title", title: "Hypertext Transfer Protocol", body: "the protocol" },
      { id: "transfer-only", title: "Transfer Rates", body: "transfer transfer transfer" },
      { id: "protocol-only", title: "Network Protocol", body: "a protocol overview" },
    ];
    const engine = await index(
      SearchEngine.create({ schema, plugins: [morphology(), dictionary({ entries: httpDict })] }),
      docs
    );
    const httpIds = ["expansion-title", "http", "protocol-only", "transfer-only"];
    expect(ids(engine.search("http"))).toEqual(httpIds);
    expect(ids(engine.search("hypertext transfer protocol"))).toEqual(httpIds);
    // Partial expansion occupancy still projects the HTTP expansion, so protocol-only is legitimate weak-direct evidence.
    expect(ids(engine.search("hypertext transfer"))).toEqual(httpIds);

    const exact = engine.searchDetailed("http", { explain: true }).results;
    expect(stableSurface(exact[0])).toMatchObject({
      id: "expansion-title",
      configuredEquivalenceMatch: "expansion",
      normalizedQueryPhrase: "hypertext transfer protocol",
    });
    expect(stableSurface(exact[1])).toMatchObject({
      id: "http",
      configuredEquivalenceMatch: "key-in-title",
      normalizedQueryPhrase: "hypertext transfer protocol",
    });

    const siblingDict = [
      { key: "http", aliases: [["hypertext", "transfer", "protocol"]]},
      { key: "https", aliases: [["hypertext", "transfer", "protocol", "secure"]]},
    ];
    const siblingDocs = [
      { id: "http-title", title: "HTTP", body: "methods and status codes" },
      { id: "http-body", title: "Request Response", body: "http methods and status codes" },
      { id: "tls", title: "TLS 1.2 Vulnerability", body: "hypertext mention in a tls article" },
      { id: "transfer-only", title: "Transfer Rates", body: "transfer transfer transfer" },
    ];
    const sibling = await index(
      SearchEngine.create({ schema, plugins: [morphology(), dictionary({ entries: siblingDict })] }),
      siblingDocs
    );
    const siblingIds = ["http-title", "transfer-only", "http-body"];
    expect(ids(sibling.search("http"))).toEqual(siblingIds);
    expect(ids(sibling.search("hypertext transfer protocol"))).toEqual(siblingIds);
    expect(ids(sibling.search("hypertext transfer"))).toEqual(siblingIds);
  });

  test("wifi configured alias ranks the wifi document", async () => {
    const engine = await index(
      SearchEngine.create({
        schema,
        plugins: [morphology(), dictionary({ entries: [{ key: "wifi", aliases: [["wi", "fi"]]}] })],
      }),
      [
        { id: "wifi", title: "Wi-Fi", body: "Connect to wireless networks." },
        { id: "bluetooth", title: "Bluetooth", body: "Connect wireless accessories." },
      ]
    );
    const rows = engine.searchDetailed("wifi", { explain: true }).results;
    expect(ids(rows)).toEqual(["wifi"]);
    expect(stableSurface(rows[0])).toMatchObject({
      id: "wifi",
      title: "Wi-Fi",
      configuredEquivalenceMatch: "expansion",
      normalizedQueryPhrase: "wi fi",
    });
  });

  test("contextual prefix, morphology, and compound repair keep ordered ids", async () => {
    const docs = [
      { id: "api", title: "What is an API?", body: "interfaces" },
      { id: "code", title: "What is Code?", body: "source" },
      { id: "clean", title: "What is Clean Code?", body: "style" },
      { id: "container", title: "What is a Container?", body: "runtime" },
      { id: "cicd", title: "CI/CD", body: "c pipelines continuous integration c" },
      { id: "edge", title: "Edge Computing", body: "c computing at the edge c" },
      {
        id: "ml",
        title: "Linear vs Logistic Regression",
        body: "machine learning machine learning machine learning machine learning machine learning",
        lexicalFrequency: { "machine learn": 5, machine: 5, learn: 5 },
      },
      { id: "learn", title: "LinkedIn Learning Review", body: "courses" },
      { id: "appsec", title: "App Sec", body: "application security practices" },
    ];
    const appsecDict = [
      {
        key: "appsec",
        aliases: [["application", "security"], ["app", "sec"],
          ["app", "security"],],
      },
    ];
    const engine = await index(
      SearchEngine.create({
        schema,
        plugins: [morphology(), dictionary({ entries: appsecDict })],
        relationshipStrategy: "hybrid",
      }),
      docs
    );

    expect(ids(engine.search("what is an ap", { limit: 5 }))).toEqual([
      "api",
      "appsec",
      "clean",
      "code",
      "container",
    ]);
    expect(ids(engine.search("what is c", { limit: 5 }))).toEqual([
      "code",
      "clean",
      "cicd",
      "edge",
      "api",
    ]);
    expect(ids(engine.search("what is a co", { limit: 5 }))).toEqual([
      "container",
      "api",
      "clean",
      "code",
      "edge",
    ]);
    expect(ids(engine.search("appsecurity"))).toEqual(["appsec"]);
    expect(ids(engine.search("machine learning", { limit: 5 }))).toEqual(["ml", "learn"]);
  });

  test("worker latest-wins publishes the last query and searchWorkerUrl keeps the filename", async () => {
    expect(searchWorkerUrl().pathname.endsWith("/searchWorker.js")).toBe(true);

    const docs = [
      { id: "nfc", title: "NFC", body: "Near-field communication." },
      { id: "vpn", title: "VPN", body: "Virtual private network." },
    ];
    const runtime = createWorkerRuntime({ SearchEngine, english: morphology, dictionary });
    const transport = createLoopbackTransport(runtime);
    const published = [];
    const client = createSearchClient({
      worker: transport,
      onResult({ query }) {
        published.push(query);
      },
    });
    await client.init({
      documents: docs,
      schema,
      configuredConcepts: [],
      retriever: "indexed",
      candidateLimit: 50,
    });
    client.setQuery("n");
    client.setQuery("nfc");
    await new Promise((r) => setTimeout(r, 40));
    expect(published[published.length - 1]).toBe("nfc");
    client.terminate();
  });

  test("compileLexicalFrequency freezes format, policy, and deterministic n-grams", () => {
    const artifact = compileLexicalFrequency(
      [
        { id: "a", title: "Alpha", body: "machine learning machine learning" },
        { id: "b", title: "Beta", body: "machine learning notes" },
        { id: "c", title: "Gamma", body: "unrelated security notes" },
      ],
      { lemma: morphology().lemma }
    );
    expect(artifact.format).toBe("search-v2-lexical-frequency");
    expect(artifact.version).toBe(1);
    expect(artifact.policy).toEqual({ minN: 1, maxN: 2, minCollectionCount: 2 });
    expect(Object.keys(artifact.documents).sort()).toEqual(["a", "b", "c"]);
    expect(artifact.documents.a.ngrams).toEqual({
      learn: 2,
      machine: 2,
      "machine learn": 2,
    });
    expect(artifact.documents.b.ngrams["machine learn"]).toBe(1);
    expect(artifact.documents.c.ngrams).toEqual({ note: 1 });
  });
});
