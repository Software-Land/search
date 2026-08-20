import { SearchEngine, english, dictionary, isAbortError } from "../src/index.js";
import { analyzeQuery } from "../src/analyze.js";
import { retrieveCandidates } from "../src/retrieve.js";
import { rankCandidates } from "../src/rank.js";
import { buildIndex } from "../src/indexDocuments.js";
import { leftoverLooksLikeJunk } from "../src/analyzeRepair.js";
import {
  createLatestWinsSession,
  createWorkerRuntime,
  createLoopbackTransport,
  createSearchClient,
} from "../src/browser/index.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const dictEntries = [
  { key: "tls", expansion: ["transport", "layer", "security"] },
  { key: "http", expansion: ["hypertext", "transfer", "protocol"] },
  {
    key: "appsec",
    expansion: ["application", "security"],
    aliases: [["app", "sec"]],
  },
];

const plugins = [english(), dictionary({ entries: dictEntries })];

const graph = {
  format: "search-v2-relationships",
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
    const e = SearchEngine.create({ schema, plugins, relationships: graph });
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
        configuredEquivalenceMatch: false,
        canonicalKeyTitle: false,
        morphologyMatch: false,
        typoDistance: 0,
        versionMatch: false,
        shortLiteralLeadMatch: false,
        phraseAdjacency: 0,
        titleTokenCount: 2,
        expansionEvidence: 0,
        relationshipStrength: 0,
      },
    }));
    abortErrorGuard(() => rankCandidates(featured, { signal: abortAfter(2) }));
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
    expect(q.concepts.some((c) => c.id === "appsec" && c.kind === "acronym")).toBe(true);
    expect(q.concepts.some((c) => c.kind === "term")).toBe(false);
  });

  test("mixed alphanumeric typo uses leet only on long tokens", () => {
    const q = analyzeQuery("aplication s3curity", { plugins });
    expect(q.originalSurface).toEqual(["aplication", "s3curity"]);
    expect(q.alternatives.some((a) => a.source === "leet-decode")).toBe(true);
    expect(q.alternatives.some((a) => a.source === "typo-correction")).toBe(true);
    expect(q.tokens.map((t) => t.normalized)).toEqual(["application", "security"]);
    expect(q.concepts.some((c) => c.id === "appsec" && c.kind === "acronym")).toBe(true);
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

  test("http salvage from junk uses a dictionary key", () => {
    const q = analyzeQuery("asdfsafhttp", { plugins });
    expect(q.originalSurface).toEqual(["asdfsafhttp"]);
    expect(q.tokens.map((t) => t.normalized)).toEqual(["hypertext", "transfer", "protocol"]);
    expect(q.concepts.some((c) => c.id === "http" && c.provenance === "key")).toBe(true);
  });

  test("morphological tokens are not compound-split or over-corrected", () => {
    const intercepting = analyzeQuery("intercepting", { plugins, lexicon: ["interceptor", "testing", "interface"] });
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
    const runtime = createWorkerRuntime({ SearchEngine, english, dictionary });
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
      dictionaryEntries: dictEntries,
      relationships: graph,
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
    const runtime = createWorkerRuntime({ SearchEngine, english, dictionary });
    const transport = createLoopbackTransport(runtime);
    const published = [];
    const client = createSearchClient({
      worker: transport,
      onResult({ result }) {
        published.push(result.results[0]?.title);
      },
    });
    await client.init({ documents: relDocs, schema, dictionaryEntries: dictEntries });
    client.setQuery("tls");
    client.terminate();
    await sleep(40);
    expect(published).toEqual([]);
  });
});
