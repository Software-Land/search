import { morphology, SearchEngine, isAbortError } from "../dist/index.js";
import { setBeforePackedPublish, setCooperationProbe } from "../dist/execution/cooperate.js";
import { compileConfiguredConceptPlugin } from "../dist/relationships/configuredConcepts.js";
import { analyzeQuery } from "../dist/query/analyze.js";
import { retrieveCandidates } from "../dist/retrieval/retrieve.js";
import { DEFAULT_CONSTRAINTS } from "../dist/ranking/constraints.js";
import { rankCandidates } from "../dist/ranking/rank.js";
import { rankSparse, rankSparseAsync } from "../dist/ranking/rankSparse.js";
import { buildIndex } from "../dist/indexing/indexDocuments.js";
import { leftoverLooksLikeJunk } from "../dist/query/analyzeRepair.js";
import {
  createLatestWinsSession,
  createWorkerRuntime,
  createLoopbackTransport,
  createSearchClient,
} from "../dist/browser/index.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const dictEntries = [
  { key: "tls", aliases: [["transport", "layer", "security"]]},
  { key: "http", aliases: [["hypertext", "transfer", "protocol"]]},
  {
    key: "appsec",
    aliases: [["application", "security"], ["app", "sec"]],
  },
];

const plugins = [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: dictEntries })];

const graph = {
  format: "search-relationships",
  version: 1,
  relationships: {
    "tls-config": [{ target: "vpn", type: "semantic", strength: 0.8, provenance: "test" }],
  },
};

const relDocs = [
  { id: "tls-config", title: "TLS Configuration", body: "tls certificates" },
  { id: "vpn", title: "VPN Settings", body: "virtual private network" },
  { id: "noise", title: "Process vs Thread", body: "tls is mentioned once in passing" },
  { id: "unrelated", title: "Monotonic Stack", body: "stack algorithm" },
];

function abortAfter(n) {
  let calls = 0;
  return {
    get aborted() {
      return ++calls > n;
    },
  };
}

function abortErrorGuard(fn) {
  try {
    fn();
    throw new Error("expected AbortError");
  } catch (err) {
    expect(isAbortError(err)).toBe(true);
  }
}

async function abortErrorGuardAsync(fn) {
  try {
    await fn();
    throw new Error("expected AbortError");
  } catch (err) {
    expect(isAbortError(err)).toBe(true);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      const err = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

describe("relationship API", () => {
  async function engine() {
    const e = SearchEngine.create({ schema, plugins, documentRelationships: graph });
    await e.index(relDocs);
    return e;
  }

  test("default strategy is hybrid and search() matches searchDetailed().results", async () => {
    const e = await engine();
    expect(e.relationshipStrategy).toBe("hybrid");
    const detailed = e.searchDetailed("tls", { limit: 10, explain: true });
    const results = e.search("tls", { limit: 10, explain: true });
    expect(results.map((r) => r.id)).toEqual(detailed.results.map((r) => r.id));
    expect(results[0].title).toBe("TLS Configuration");
    expect(results.find((r) => r.id === "vpn")?.relevanceKind).toBe("related");
    const vpnRank = results.findIndex((r) => r.id === "vpn");
    const noiseRank = results.findIndex((r) => r.id === "noise");
    if (noiseRank !== -1) expect(vpnRank).toBeLessThan(noiseRank);
  });

  test("explicit mixed keeps related behind title-ish directs", async () => {
    const e = await engine();
    const { results } = e.searchDetailed("tls", { limit: 10, relationshipStrategy: "mixed", explain: true });
    expect(results[0].title).toBe("TLS Configuration");
    expect(results.find((r) => r.id === "vpn")?.relevanceKind).toBe("related");
  });

  test("explicit separate keeps related out of results", async () => {
    const e = await engine();
    const { results, related } = e.searchDetailed("tls", {
      limit: 10,
      explain: true,
      relationshipStrategy: "separate",
    });
    expect(results.every((r) => r.relevanceKind !== "related")).toBe(true);
    expect(related.some((r) => r.id === "vpn")).toBe(true);
    expect(related[0].relationship.sourceTitle).toBe("TLS Configuration");
    expect(related[0].relationship.type).toBe("semantic");
    expect(related[0].relationship.strength).toBe(0.8);
    expect(related[0].relationship.rank).toBe(1);
    expect(related[0].relationship.provenance).toBe("test");
  });

  test("none skips expansion", async () => {
    const e = await engine();
    const { results, related } = e.searchDetailed("tls", { relationshipStrategy: "none" });
    expect(related).toEqual([]);
    expect(results.every((r) => r.relevanceKind !== "related")).toBe(true);
  });

  test("no relationship artifact leaves related empty", async () => {
    const e = SearchEngine.create({ schema, plugins });
    await e.index(relDocs);
    const { results, related } = e.searchDetailed("tls");
    expect(results[0].title).toBe("TLS Configuration");
    expect(related).toEqual([]);
  });
});

describe("core cancellation", () => {
  const manyDocs = Array.from({ length: 48 }, (_, i) => ({
    id: `doc-${i}`,
    title: i === 0 ? "TLS Configuration" : `Widget ${i}`,
    body: "tls certificates and widget notes",
  }));

  async function engine() {
    const e = SearchEngine.create({ schema, plugins });
    await e.index(manyDocs);
    return e;
  }

  test("abort before search throws AbortError and is not an empty hit list", async () => {
    const e = await engine();
    const ac = new AbortController();
    ac.abort();
    abortErrorGuard(() => e.search("tls", { signal: ac.signal }));
    const ok = e.search("tls");
    expect(ok.length).toBeGreaterThan(0);
  });

  test("abort during candidate scan", () => {
    const query = analyzeQuery("tls", { plugins });
    const index = buildIndex(manyDocs, schema, plugins);
    abortErrorGuard(() => retrieveCandidates(query, index, { signal: abortAfter(2) }));
  });

  test("abort during ranking", () => {
    const query = analyzeQuery("tls", { plugins });
    const index = buildIndex(manyDocs, schema, plugins);
    const retrieved = retrieveCandidates(query, index);
    const featured = retrieved.map((hit) => ({
      ...hit,
      features: {
        exactTitleMatch: false,
        exactTitleTokenMatch: false,
        queryCoverage: 0.2,
        titleCoverage: 0.1,
        titlePrefixQuality: 0,
        bodyLexicalMatch: 1,
        relevanceKind: "direct",
        directClass: "weak",
        configuredConceptMatch: false,
        canonicalKeyTitle: false,
        morphologyMatch: false,
        typoDistance: 0,
        versionMatch: false,
        shortLiteralLeadMatch: false,
        phraseAdjacency: 0,
        titleTokenCount: 2,
        configuredFormEvidence: 0,
        relationshipStrength: 0,
      },
    }));
    abortErrorGuard(() => rankCandidates(featured, { signal: abortAfter(2) }));
  });

  test("abort after constraint-graph construction and order, before diagnosis", () => {
    const featured = [
      {
        document: { id: "b" },
        features: {
          exactTitleMatch: false,
          queryCoverage: 0,
          relevanceKind: "direct",
          directClass: "none",
        },
      },
      {
        document: { id: "a" },
        features: {
          exactTitleMatch: false,
          queryCoverage: 0,
          relevanceKind: "direct",
          directClass: "none",
        },
      },
    ];
    // C=2: aborted getter is polled at rank start, graph pair 0, orderFromGraph
    // start, then the diagnosis-boundary check that replaced the second graph.
    abortErrorGuard(() => rankCandidates(featured, { signal: abortAfter(3) }));
    const ranked = rankCandidates(featured, { signal: abortAfter(4) });
    expect(ranked.map((r) => r.document.id)).toEqual(["a", "b"]);
  });

  test("search succeeds after abort and does not keep cancelled meta", async () => {
    const e = await engine();
    e.search("tls");
    const goodMeta = e.lastSearchMeta;
    abortErrorGuard(() => e.search("tls", { signal: abortAfter(3) }));
    expect(e.lastSearchMeta).toBe(goodMeta);
    const again = e.search("widget 7");
    expect(again.some((r) => /Widget 7/i.test(r.title))).toBe(true);
    expect(e.lastSearchMeta.query.raw).toBe("widget 7");
  });

  test("async search observes abort between stages", async () => {
    const e = await engine();
    const ac = new AbortController();
    const pending = e.searchAsync("tls", { signal: ac.signal });
    ac.abort();
    await abortErrorGuardAsync(() => pending);
  });
});

describe("query analysis repair", () => {
  test("compound typo segmentation is general and inspectable", () => {
    const q = analyzeQuery("aplicationsecurity", { plugins });
    expect(q.raw).toBe("aplicationsecurity");
    expect(q.originalSurface).toEqual(["aplicationsecurity"]);
    expect(q.alternatives.some((a) => a.source === "compound-spell-segmentation")).toBe(true);
    expect(q.alternatives.some((a) => a.tokens[0] === "application" && a.tokens[1] === "security")).toBe(true);
    expect(q.tokens.map((t) => t.normalized)).toEqual(["application", "security"]);
    expect(q.concepts.some((c) => c.id === "appsec" && c.kind === "configured-concept")).toBe(true);
    expect(q.concepts.some((c) => c.kind === "term")).toBe(false);
  });

  test("mixed alphanumeric typo uses leet only on long tokens", () => {
    const q = analyzeQuery("aplication s3curity", { plugins });
    expect(q.originalSurface).toEqual(["aplication", "s3curity"]);
    expect(q.alternatives.some((a) => a.source === "leet-decode")).toBe(true);
    expect(q.alternatives.some((a) => a.source === "typo-correction")).toBe(true);
    expect(q.tokens.map((t) => t.normalized)).toEqual(["application", "security"]);
    expect(q.concepts.some((c) => c.id === "appsec" && c.kind === "configured-concept")).toBe(true);
  });

  test("short literals are not treated as spelling errors", () => {
    for (const q of ["s3", "h2", "k8"]) {
      const analyzed = analyzeQuery(q, { plugins });
      expect(analyzed.tokens).toHaveLength(1);
      expect(analyzed.tokens[0].normalized).toBe(q);
      expect(analyzed.alternatives.some((a) => a.source === "leet-decode")).toBe(false);
    }
  });

  test("garbage salvage recovers a rare contained term", () => {
    const q = analyzeQuery("asdfasdfcontainerasdfadfs", {
      plugins,
      lexicon: ["container", "docker"],
    });
    expect(q.tokens.map((t) => t.normalized)).toEqual(["container"]);
    expect(q.alternatives[0].source).toBe("junk-token-salvage");
  });

  test("http salvage from junk uses a configured-concept key", () => {
    const q = analyzeQuery("asdfsafhttp", { plugins });
    expect(q.originalSurface).toEqual(["asdfsafhttp"]);
    expect(q.tokens.map((t) => t.normalized)).toEqual(["http"]);
    expect(q.lexicalPhraseTokens).toEqual(["http"]);
    expect(q.configuredSequenceIntent?.key).toBe("http");
  });

  test("morphological tokens are not compound-split or over-corrected", () => {
    const intercepting = analyzeQuery("intercepting", {
      plugins: [morphology({ lemmas: { intercepting: "interceptor" } }), ...plugins.slice(1)],
      lexicon: ["interceptor", "testing", "interface"],
    });
    expect(intercepting.tokens).toHaveLength(1);
    expect(intercepting.tokens[0].surface).toBe("intercepting");
    expect(intercepting.tokens[0].normalized).toBe("interceptor");
    expect(intercepting.tokens[0].lemma).toBe("interceptor");
    const sorti = analyzeQuery("sorti", { plugins, lexicon: ["sort", "sorting"] });
    expect(sorti.tokens).toHaveLength(1);
    expect(sorti.tokens[0].surface).toBe("sorti");
    expect(sorti.tokens[0].normalized).toBe("sort");
    expect(sorti.tokens[0].completedToken).toBe("sorting");
  });

  test("common substrings do not salvage arbitrary words", () => {
    expect(leftoverLooksLikeJunk("mised")).toBe(false);
    expect(leftoverLooksLikeJunk("asdfasdf")).toBe(true);
    const q = analyzeQuery("miscontainered", {
      plugins,
      lexicon: ["container", "application"],
    });
    expect(q.tokens.map((t) => t.normalized)).toEqual(["miscontainered"]);
  });

  test("compound + leet search still ranks App Sec first", async () => {
    const e = SearchEngine.create({ schema, plugins });
    await e.index([
      { id: "app-sec", title: "App Sec", body: "application security practices" },
      { id: "zero", title: "Zero-Trust Security", body: "zero trust" },
      { id: "docker", title: "What is a Container?", body: "container runtime" },
    ]);
    expect(e.search("aplicationsecurity")[0].title).toBe("App Sec");
    expect(e.search("aplication s3curity")[0].title).toBe("App Sec");
    const recovered = e.search("asdfasdfcontainerasdfadfs", { limit: 3 }).map((r) => r.title);
    expect(recovered).toContain("What is a Container?");
  });
});

describe("latest-wins scheduling", () => {
  test("pending query is replaced and only the latest publishes", async () => {
    const executed = [];
    const published = [];
    const session = createLatestWinsSession({
      async search(query, { signal }) {
        executed.push(query);
        await sleep(25, signal);
        return { results: [{ title: query }] };
      },
      onResult({ query, result }) {
        published.push({ query, titles: result.results.map((r) => r.title) });
      },
      onClear() {
        published.push({ query: "", titles: [] });
      },
    });
    for (const q of ["a", "ap", "app", "appl", "applic", "application"]) {
      session.setQuery(q);
    }
    await sleep(80);
    expect(executed.length).toBeLessThanOrEqual(2);
    expect(executed.includes("application")).toBe(true);
    expect(["a", "ap", "app", "appl", "applic"].filter((q) => executed.includes(q)).length).toBeLessThanOrEqual(1);
    expect(published.filter((p) => p.query).map((p) => p.query)).toEqual(["application"]);
    expect(session.stats().coalesced).toBeGreaterThan(0);
    session.dispose();
  });

  test("input change invalidates before the replacement search starts", async () => {
    const published = [];
    let release;
    const first = new Promise((resolve) => {
      release = resolve;
    });
    const session = createLatestWinsSession({
      async search(query, { signal }) {
        if (query === "old") {
          await first;
          if (signal?.aborted) {
            const err = new Error("Aborted");
            err.name = "AbortError";
            throw err;
          }
          return { results: [{ title: "stale" }] };
        }
        return { results: [{ title: "fresh" }] };
      },
      onResult({ result }) {
        published.push(result.results[0].title);
      },
    });
    const gen1 = session.setQuery("old");
    const gen2 = session.setQuery("new");
    expect(gen2).toBeGreaterThan(gen1);
    release();
    await sleep(20);
    expect(published).toEqual(["fresh"]);
    session.dispose();
  });

  test("clearing the input invalidates in-flight results", async () => {
    const published = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const session = createLatestWinsSession({
      async search(query, { signal }) {
        await gate;
        if (signal?.aborted) {
          const err = new Error("Aborted");
          err.name = "AbortError";
          throw err;
        }
        return { results: [{ title: query }] };
      },
      onResult({ result }) {
        published.push(result.results.map((r) => r.title));
      },
      onClear() {
        published.push([]);
      },
    });
    session.setQuery("application");
    session.setQuery("");
    release();
    await sleep(20);
    expect(published).toEqual([[]]);
    session.dispose();
  });

  test("search after cancel behaves like a fresh engine", async () => {
    const e = SearchEngine.create({ schema, plugins });
    await e.index(relDocs);
    abortErrorGuard(() => e.search("tls", { signal: abortAfter(1) }));
    const results = e.search("tls");
    expect(results[0].title).toBe("TLS Configuration");
  });

  test("teardown drops pending work and ignores later results", async () => {
    const published = [];
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const session = createLatestWinsSession({
      async search() {
        await gate;
        return { results: [{ title: "late" }] };
      },
      onResult({ result }) {
        published.push(result.results[0].title);
      },
    });
    session.setQuery("application");
    session.dispose();
    release();
    await sleep(20);
    expect(published).toEqual([]);
  });
});

describe("worker adapter", () => {
  test("loopback worker inits once and latest-wins cancels stale work", async () => {
    const runtime = createWorkerRuntime({ SearchEngine, english: morphology, compileConfiguredConceptPlugin });
    const transport = createLoopbackTransport(runtime);
    const published = [];
    const client = createSearchClient({
      worker: transport,
      onResult({ query, result }) {
        published.push({ query, titles: result.results.map((r) => r.title) });
      },
      onClear() {
        published.push({ query: "", titles: [] });
      },
    });
    await client.init({
      documents: relDocs,
      schema,
      configuredConcepts: dictEntries,
      documentRelationships: graph,
    });
    expect(runtime.initialized).toBe(true);
    client.setQuery("t");
    client.setQuery("tl");
    client.setQuery("tls");
    await sleep(80);
    const publishedQueries = published.filter((p) => p.query).map((p) => p.query);
    expect(publishedQueries[publishedQueries.length - 1]).toBe("tls");
    expect(publishedQueries.filter((q) => q !== "tls").length).toBeLessThanOrEqual(1);
    client.terminate();
    expect(runtime.initialized).toBe(false);
  });

  test("worker teardown prevents later publishes", async () => {
    const runtime = createWorkerRuntime({ SearchEngine, english: morphology, compileConfiguredConceptPlugin });
    const transport = createLoopbackTransport(runtime);
    const published = [];
    const client = createSearchClient({
      worker: transport,
      onResult({ result }) {
        published.push(result.results[0]?.title);
      },
    });
    await client.init({ documents: relDocs, schema, configuredConcepts: dictEntries });
    client.setQuery("tls");
    client.terminate();
    await sleep(40);
    expect(published).toEqual([]);
  });
});

function taskTest(name, fn) {
  test(name, fn, 60_000);
}

describe("in-flight task cancellation", () => {
  afterEach(() => {
    setCooperationProbe(null);
    setBeforePackedPublish(null);
  });

  const schemaOnly = {
    title: { type: "text", role: "title" },
    body: { type: "text", role: "body" },
  };
  const taskPlugins = [morphology()];
  const packedDocs = Array.from({ length: 4000 }, (_, i) => ({
    id: `d${i}`,
    title: `Note ${i}`,
    body: `secure network policy ${i} secure network controls`,
  }));
  packedDocs.push({
    id: "only-zephyr",
    title: "Zephyr Beacon",
    body: "unique zephyrbeacon marker",
  });

  async function packedEngine() {
    const engine = SearchEngine.create({ schema: schemaOnly, plugins: taskPlugins });
    await engine.index(packedDocs);
    return engine;
  }

  function idsOf(results) {
    return results.map((row) => row.id);
  }

  taskTest("packed async search yields during the work and matches synchronous results", async () => {
    const engine = await packedEngine();
    const seen = [];
    setCooperationProbe((info) => seen.push(info.completedUnits));
    const asyncResults = await engine.searchAsync("secure network");
    const asyncMeta = engine.lastSearchMeta;
    const syncResults = engine.search("secure network");
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeGreaterThan(512);
    expect(idsOf(asyncResults)).toEqual(idsOf(syncResults));
    expect(asyncMeta.rankingEvidenceFallbackReason).toBeNull();
    expect(asyncMeta.retrievalStats.kind).toBe("compiled-indexed");
    expect(asyncResults.length).toBeGreaterThan(0);
  });

  taskTest("a timer aborts a packed search after substantial work and before it finishes", async () => {
    const engine = await packedEngine();
    const full = [];
    setCooperationProbe((info) => full.push(info.completedUnits));
    await engine.searchAsync("secure network");
    const good = engine.lastSearchMeta;
    setCooperationProbe(null);

    const seen = [];
    setCooperationProbe((info) => seen.push(info.completedUnits));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 0);
    const pending = engine.searchAsync("secure network", { signal: ac.signal });
    await abortErrorGuardAsync(() => pending);
    expect(ac.signal.aborted).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeLessThan(full[full.length - 1]);
    expect(full[full.length - 1]).toBeGreaterThan(512);
    expect(engine.lastSearchMeta).toBe(good);

    const again = await engine.searchAsync("zephyrbeacon");
    const fresh = SearchEngine.create({ schema: schemaOnly, plugins: taskPlugins });
    await fresh.index(packedDocs);
    expect(idsOf(again)).toEqual(idsOf(fresh.search("zephyrbeacon")));
    expect(again.map((row) => row.id)).toEqual(["only-zephyr"]);
  });

  taskTest("an abort during ranking-evidence finalization rejects before that stage finishes", async () => {
    const engine = await packedEngine();
    let fullStage = 0;
    setCooperationProbe((info) => {
      if (info.stage === "finalize") fullStage = info.stageUnits;
    });
    const finished = await engine.searchAsync("secure network");
    const good = engine.lastSearchMeta;
    expect(finished.length).toBeGreaterThan(0);
    expect(fullStage).toBeGreaterThan(200);
    setCooperationProbe(null);

    const ac = new AbortController();
    let abortedAt = 0;
    setCooperationProbe((info) => {
      if (abortedAt || info.stage !== "finalize" || info.stageUnits <= 200) return;
      abortedAt = info.stageUnits;
      setTimeout(() => ac.abort(), 0);
    });
    await abortErrorGuardAsync(() => engine.searchAsync("secure network", { signal: ac.signal }));
    expect(abortedAt).toBeGreaterThan(200);
    expect(abortedAt).toBeLessThan(fullStage);
    expect(engine.lastSearchMeta).toBe(good);
  });

  taskTest("detailed async search enters the feature path and aborts in that work", async () => {
    const engine = await packedEngine();
    let fullStage = 0;
    setCooperationProbe((info) => {
      if (info.stage === "features") fullStage = info.stageUnits;
    });
    const detailed = await engine.searchDetailedAsync("secure network", { limit: 5 });
    const asyncMeta = engine.lastSearchMeta;
    expect(asyncMeta.featureVectorsConstructed).toBeGreaterThan(0);
    expect(asyncMeta.rankingEvidenceFallbackReason).toBeUndefined();
    expect(detailed.results.length).toBeGreaterThan(0);
    expect(fullStage).toBeGreaterThan(200);
    setCooperationProbe(null);

    const ac = new AbortController();
    let abortedAt = 0;
    setCooperationProbe((info) => {
      if (abortedAt || info.stage !== "features" || info.stageUnits <= 200) return;
      abortedAt = info.stageUnits;
      setTimeout(() => ac.abort(), 0);
    });
    await abortErrorGuardAsync(() =>
      engine.searchDetailedAsync("secure network", { signal: ac.signal, limit: 5 })
    );
    expect(abortedAt).toBeGreaterThan(200);
    expect(abortedAt).toBeLessThan(fullStage);
    expect(engine.lastSearchMeta).toBe(asyncMeta);
  });

  taskTest("an abort across the packed publication boundary leaves the previous result in place", async () => {
    const engine = await packedEngine();
    const first = await engine.searchAsync("zephyrbeacon");
    expect(first.map((row) => row.id)).toEqual(["only-zephyr"]);
    const good = engine.lastSearchMeta;
    expect(engine._rankingEvidencePool.memory().activeSessions).toBe(0);

    let release;
    let entered = false;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    setBeforePackedPublish(() => {
      entered = true;
      return hold;
    });
    const ac = new AbortController();
    const pending = engine.searchAsync("secure network", { signal: ac.signal });
    const deadline = Date.now() + 20000;
    while (!entered) {
      if (Date.now() > deadline) throw new Error("publication gate was not reached");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    ac.abort();
    release();
    await abortErrorGuardAsync(() => pending);
    expect(engine.lastSearchMeta).toBe(good);
    expect(engine._rankingEvidencePool.memory().activeSessions).toBe(0);

    const again = await engine.searchAsync("zephyrbeacon");
    expect(again.map((row) => row.id)).toEqual(["only-zephyr"]);
  });

  taskTest("one-signature ranking yields and aborts before the candidate set is finished", async () => {
    const features = { relevanceKind: "direct", directClass: "none", queryCoverage: 0 };
    const many = Array.from({ length: 100000 }, (_, i) => ({
      document: { id: `c${String(i).padStart(6, "0")}` },
      features,
      score: 100000 - i,
    }));
    const ac = new AbortController();
    let abortedAt = 0;
    let finished = false;
    setCooperationProbe((info) => {
      if (abortedAt || info.stage !== "rank" || info.stageUnits <= 0) return;
      abortedAt = info.stageUnits;
      setTimeout(() => ac.abort(), 0);
    });
    const pending = rankSparseAsync(many, DEFAULT_CONSTRAINTS, { signal: ac.signal }).then((ranked) => {
      finished = true;
      return ranked;
    });
    await abortErrorGuardAsync(() => pending);
    expect(abortedAt).toBeGreaterThan(0);
    expect(finished).toBe(false);

    const small = Array.from({ length: 2000 }, (_, i) => ({
      document: { id: `s${String(i).padStart(4, "0")}` },
      features,
      score: (i * 17) % 97,
    }));
    const syncRanked = rankSparse(small, DEFAULT_CONSTRAINTS);
    const asyncRanked = await rankSparseAsync(small, DEFAULT_CONSTRAINTS);
    expect(asyncRanked.map((row) => [row.document.id, row.score, row.rank, row.constraintVsNext.order])).toEqual(
      syncRanked.map((row) => [row.document.id, row.score, row.rank, row.constraintVsNext.order])
    );
  });

  taskTest("full-scan async search scans documents and aborts during that scan", async () => {
    const docs = packedDocs.slice(0, 1200);
    const engine = SearchEngine.create({
      schema: schemaOnly,
      plugins: taskPlugins,
      retriever: "full-scan",
    });
    await engine.index(docs);
    const seen = [];
    setCooperationProbe((info) => seen.push(info.completedUnits));
    const results = await engine.searchAsync("secure network");
    expect(engine.lastSearchMeta.retrievalStats.kind).toBe("full-scan");
    expect(seen.length).toBeGreaterThan(1);
    expect(results.length).toBeGreaterThan(0);
    const fullUnits = seen[seen.length - 1];
    setCooperationProbe(null);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 0);
    const aborted = [];
    setCooperationProbe((info) => aborted.push(info.completedUnits));
    await abortErrorGuardAsync(() => engine.searchAsync("secure network", { signal: ac.signal }));
    expect(aborted[0]).toBeGreaterThan(200);
    expect(aborted[aborted.length - 1]).toBeLessThan(fullUnits);
  });

  taskTest("adaptive search below the threshold uses the full-scan async branch", async () => {
    const docs = packedDocs.slice(0, 800);
    const engine = SearchEngine.create({
      schema: schemaOnly,
      plugins: taskPlugins,
      retriever: "adaptive",
    });
    await engine.index(docs);
    const seen = [];
    setCooperationProbe((info) => seen.push(info.completedUnits));
    await engine.searchAsync("secure network");
    expect(engine.lastSearchMeta.retriever).toBe("adaptive");
    expect(engine.lastSearchMeta.retrievalStats.active).toBe("full-scan");
    expect(engine.lastSearchMeta.retrievalStats.kind).toBe("full-scan");
    expect(engine.lastSearchMeta.featureVectorsConstructed).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(1);
    const fullUnits = seen[seen.length - 1];
    setCooperationProbe(null);

    const ac = new AbortController();
    let abortedAt = 0;
    setCooperationProbe((info) => {
      if (!abortedAt && info.completedUnits > 200) {
        abortedAt = info.completedUnits;
        ac.abort();
      }
    });
    await abortErrorGuardAsync(() => engine.searchAsync("secure network", { signal: ac.signal }));
    expect(abortedAt).toBeGreaterThan(200);
    expect(abortedAt).toBeLessThan(fullUnits);
  });

  taskTest("aborting one overlapping search leaves the other result and metadata intact", async () => {
    const engine = await packedEngine();
    await engine.searchAsync("zephyrbeacon");
    const before = engine.lastSearchMeta;
    const ac = new AbortController();
    const cancelled = engine.searchAsync("secure network", { signal: ac.signal });
    const kept = engine.searchAsync("zephyrbeacon");
    setTimeout(() => ac.abort(), 0);
    const [cancelledResult, keptResult] = await Promise.allSettled([cancelled, kept]);
    expect(cancelledResult.status).toBe("rejected");
    expect(isAbortError(cancelledResult.reason)).toBe(true);
    expect(keptResult.status).toBe("fulfilled");
    expect(idsOf(keptResult.value)).toEqual(["only-zephyr"]);
    expect(engine.lastSearchMeta).not.toBe(before);
    expect(engine.lastSearchMeta.query.raw).toBe("zephyrbeacon");
    expect(idsOf(await engine.searchAsync("zephyrbeacon"))).toEqual(["only-zephyr"]);
  });

  taskTest("a pre-aborted async search rejects and preserves the previous metadata", async () => {
    const engine = await packedEngine();
    await engine.searchAsync("zephyrbeacon");
    const good = engine.lastSearchMeta;
    const ac = new AbortController();
    ac.abort();
    await abortErrorGuardAsync(() => engine.searchAsync("secure network", { signal: ac.signal }));
    expect(engine.lastSearchMeta).toBe(good);
  });
});
