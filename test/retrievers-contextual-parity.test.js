import { morphology, SearchEngine, dictionary } from "../dist/index.js";
import { analyzeQuery } from "../dist/analyze.js";
import { buildIndex } from "../dist/indexDocuments.js";
import { retrieveCandidates, matchContextualTitlePrefix } from "../dist/retrieve.js";
import { createIndexedLexicalRetriever } from "../dist/retrievers.js";
import { extractFeatures } from "../dist/features.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

function contextualIds(hits) {
  return hits
    .filter((h) => (h.retrievalSources || []).includes("contextual-title-prefix"))
    .map((h) => h.document.id)
    .sort();
}

function bothRetrievers(docs, plugins) {
  const index = buildIndex(docs, schema, plugins);
  const indexed = createIndexedLexicalRetriever({ candidateLimit: 200, prefixCap: 800 });
  indexed.prepare(index);
  return { index, indexed };
}

describe("indexed vs full-scan contextual candidate parity", () => {
  const plugins = [morphology()];
  const docs = [
    { id: "code", title: "What is Code?", body: "source" },
    { id: "clean", title: "What is Clean Code?", body: "style" },
    { id: "api", title: "What is an API?", body: "interfaces" },
    { id: "container", title: "What is a Container?", body: "runtime" },
    { id: "compute", title: "Computing Code Notes", body: "edge" },
    { id: "tls", title: "TLS 1.2 Vulnerability", body: "transport" },
  ];

  test("exact preceding tokens", () => {
    const { index, indexed } = bothRetrievers(docs, plugins);
    const query = analyzeQuery("what is c", { plugins });
    expect(contextualIds(retrieveCandidates(query, index))).toEqual(
      contextualIds(indexed.retrieve(query, index))
    );
  });

  test("morphology/lemma preceding tokens", () => {
    const { index, indexed } = bothRetrievers(docs, plugins);
    const query = analyzeQuery("compute co", { plugins });
    const computeDoc = index.documents.find((d) => d.id === "compute");
    expect(matchContextualTitlePrefix(query, computeDoc)).not.toBeNull();
    expect(contextualIds(retrieveCandidates(query, index))).toEqual(
      contextualIds(indexed.retrieve(query, index))
    );
    expect(contextualIds(retrieveCandidates(query, index))).toContain("compute");
  });

  test("short final prefix", () => {
    const { index, indexed } = bothRetrievers(docs, plugins);
    const query = analyzeQuery("what is an ap", { plugins });
    expect(contextualIds(retrieveCandidates(query, index))).toEqual(
      contextualIds(indexed.retrieve(query, index))
    );
    expect(contextualIds(retrieveCandidates(query, index))).toContain("api");
  });

  test("numeric rejection", () => {
    const { index, indexed } = bothRetrievers(docs, plugins);
    const query = analyzeQuery("tls 1", { plugins });
    expect(contextualIds(retrieveCandidates(query, index))).toEqual([]);
    expect(contextualIds(indexed.retrieve(query, index))).toEqual([]);
  });
});

describe("contextual MUST_KEEP bound", () => {
  test("contextual must-keep is capped; overflow stays budget-eligible without duplicates", () => {
    const prefixCap = 2;
    const candidateLimit = 4;
    const docs = [];
    for (let i = 0; i < 12; i += 1) {
      docs.push({
        id: `c${String(i).padStart(4, "0")}`,
        title: `What is Zz${"q".repeat(i)}ode extra extra extra extra`,
        body: "body",
      });
    }
    docs.push({
      id: "overflow-strong",
      title: "What is Zzqqqqqqqqqqode extra extra extra extra extra extra extra",
      body: "zz zz zz zz zz zz zz zz zz zz zz zz zz zz zz zz zz zz zz zz",
    });
    docs.push({ id: "exact", title: "what is zz", body: "exact title" });
    const plugins = [morphology()];
    const index = buildIndex(docs, schema, plugins);
    const indexed = createIndexedLexicalRetriever({ candidateLimit, prefixCap });
    indexed.prepare(index);
    const query = analyzeQuery("what is zz", { plugins });
    const hits = indexed.retrieve(query, index);
    const ids = hits.map((h) => h.document.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(hits.length).toBeLessThanOrEqual(prefixCap + candidateLimit + 2);

    const exactHit = hits.find((h) => h.document.id === "exact");
    expect(exactHit).toBeTruthy();
    expect(exactHit.retrievalSources).toContain("exact-title");

    const budgetOnly = createIndexedLexicalRetriever({ candidateLimit: 0, prefixCap });
    budgetOnly.prepare(index);
    const mustOnly = budgetOnly.retrieve(query, index);
    const contextualMust = mustOnly.filter((h) =>
      h.retrievalSources.includes("contextual-title-prefix") && !h.retrievalSources.includes("exact-title")
    );
    expect(contextualMust.length).toBeLessThanOrEqual(prefixCap);

    const overflow = hits.find((h) => h.document.id === "overflow-strong");
    expect(overflow).toBeTruthy();
    expect(overflow.retrievalSources).toContain("contextual-title-prefix");
    expect(contextualMust.some((h) => h.document.id === "overflow-strong")).toBe(false);
  });

  test("exact-title, configured-equivalence, and version remain unbounded must-keep", () => {
    const plugins = [
      morphology(),
      dictionary({ entries: [{ key: "ml", expansion: ["machine", "learning"] }] }),
    ];
    const docs = [
      { id: "exact", title: "quantum foam", body: "x" },
      { id: "cfg", title: "ML notes", body: "x" },
      { id: "ver", title: "TLS 1.2", body: "transport" },
      { id: "noise", title: "unrelated notes", body: "machine learning tls filler" },
    ];
    const index = buildIndex(docs, schema, plugins);
    const indexed = createIndexedLexicalRetriever({ candidateLimit: 0, prefixCap: 0 });
    indexed.prepare(index);

    const exactHits = indexed.retrieve(analyzeQuery("quantum foam", { plugins }), index);
    const exact = exactHits.find((h) => h.document.id === "exact");
    expect(exact).toBeTruthy();
    expect(exact.retrievalSources).toContain("exact-title");

    const cfgHits = indexed.retrieve(analyzeQuery("ml", { plugins }), index);
    const cfg = cfgHits.find((h) => h.document.id === "cfg");
    expect(cfg).toBeTruthy();
    expect(cfg.retrievalSources).toContain("configured-equivalence");

    const verHits = indexed.retrieve(analyzeQuery("tls 1.2", { plugins }), index);
    const ver = verHits.find((h) => h.document.id === "ver");
    expect(ver).toBeTruthy();
    expect(ver.retrievalSources).toContain("version");
  });
});

describe("frozen contextual regressions", () => {
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
      expansion: ["application", "security"],
      aliases: [
        ["app", "sec"],
        ["app", "security"],
      ],
    },
  ];

  async function engine() {
    const e = SearchEngine.create({
      schema,
      plugins: [morphology(), dictionary({ entries: appsecDict })],
      relationshipStrategy: "hybrid",
    });
    await e.index(docs);
    return e;
  }

  test("accepted contextual and prefix queries remain", async () => {
    const e = await engine();
    const whatIsC = e.search("what is c", { limit: 5 });
    expect(whatIsC[0].title).toBe("What is Code?");
    expect(whatIsC.slice(0, 3).map((r) => r.title)).toContain("What is Clean Code?");
    expect(e.search("what is an ap", { limit: 1 })[0].title).toBe("What is an API?");
    expect(e.search("what is a c", { limit: 1 })[0].title).toBe("What is a Container?");
    expect(e.search("what is a co", { limit: 1 })[0].title).toBe("What is a Container?");
    for (const q of ["machine learn", "machine learni", "machine learnin", "machine learning"]) {
      expect(e.search(q, { limit: 1 })[0].title).toBe("Linear vs Logistic Regression");
    }
    expect(e.search("appsecurity", { limit: 1 })[0].title).toBe("App Sec");
  });

  test("standalone stubs stay strict", async () => {
    const e = await engine();
    for (const q of ["c", "co", "ap"]) {
      const rows = e.searchDetailed(q, { limit: 8, explain: true }).results;
      for (const row of rows) {
        expect(row.features.contextualTitlePrefix).toBe(false);
      }
    }
    const index = buildIndex(docs, schema, [morphology()]);
    const machineC = analyzeQuery("machine c", { plugins: [morphology()] });
    const code = index.documents.find((d) => d.id === "code");
    expect(matchContextualTitlePrefix(machineC, code)).toBeNull();
    expect(extractFeatures(machineC, code).contextualTitlePrefix).toBe(false);
  });
});
