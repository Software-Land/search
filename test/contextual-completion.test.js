import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { analyzeQuery } from "../dist/analyze.js";
import { typedForm } from "../dist/retrieve.js";
import { buildIndex } from "../dist/indexDocuments.js";
import { versionHit } from "../dist/retrieve.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

const dict = [
  { key: "ml", aliases: [["machine", "learning"]]},
  { key: "fps", aliases: [["frames", "per", "second"]]},
  { key: "http", aliases: [["hypertext", "transfer", "protocol"]]},
  { key: "https", aliases: [["hypertext", "transfer", "protocol", "secure"]]},
  { key: "appsec", aliases: [["application", "security"], ["app", "sec"]] },
  { key: "proto", aliases: [["protocol", "buffer"]]},
  { key: "protobuf", aliases: [["protocol", "buffer"]]},
];

const docs = [
  {
    id: "ml",
    title: "Linear vs Logistic Regression",
    body: "machine learning machine learning machine learning machine learning machine learning",
    lexicalFrequency: { "machine learn": 5, machine: 5, learn: 5 },
  },
  {
    id: "appsec",
    title: "App Sec",
    body: "application security app sec notes",
    lexicalFrequency: { "application security": 1, "app sec": 1 },
  },
  {
    id: "fps",
    title: "200FPS: CSS vs Canvas",
    body: "frames per second frames per second frames per second frames per second",
    lexicalFrequency: { "frame per": 4, "per second": 7, frame: 4, per: 4, second: 7 },
  },
  {
    id: "throughput",
    title: "Throughput vs Latency",
    body: "requests per second requests per second requests per second",
    lexicalFrequency: { "per second": 9, per: 9, second: 9 },
  },
  {
    id: "proto",
    title: "Protobuf Encoding",
    body: "protocol buffers protobuf encoding",
    lexicalFrequency: { "protocol buffer": 2, protocol: 3, protobuf: 2 },
  },
  {
    id: "http",
    title: "Request Response",
    body: "hypertext transfer protocol request response over http",
    lexicalFrequency: { "transfer protocol": 2, hypertext: 1, transfer: 2, protocol: 5, http: 7 },
  },
];

const plugins = [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: dict })];

function engine(retriever = "full-scan") {
  const e = SearchEngine.create({ schema, plugins, retriever });
  return e.index(docs).then(() => e);
}

function analyze(raw) {
  return analyzeQuery(raw, { plugins });
}

describe("contextual expansion completion representation", () => {
  test.each(["machine l", "machine le"])("%s keeps typed identity and projects lexical intent separately", (raw) => {
    const stub = raw.split(" ")[1];
    const q = analyze(raw);
    expect(q.tokens.map((t) => t.surface)).toEqual(["machine", stub]);
    expect(q.tokens[1].surfaceNormalized).toBe(stub);
    expect(q.tokens[1].normalized).toBe(stub);
    expect(q.tokens[1].lemma).toBe(stub);
    expect(q.tokens[1].completedToken).toBeUndefined();
    expect(q.lexicalTokens.map((t) => t.lemma || t.normalized)).toEqual(["machine", "learn"]);
    expect(q.lexicalPhraseKey).toBe("machine learn");
    expect(q.contextualCompletion).toMatchObject({
      activePrefix: stub,
      completedToken: "learning",
      canonicalToken: "learn",
      source: "configured-expansion-prefix",
    });
    expect(q.lexicalTokens.some((t) => t.sources.includes("contextual-completion"))).toBe(true);
    expect(q.tokens.some((t) => t.sources.includes("contextual-completion"))).toBe(false);
  });

  test.each(["machine c", "machine v", "machine x"])("%s does not project machine-learning intent", (raw) => {
    const q = analyze(raw);
    expect(q.contextualCompletion).toBeNull();
    expect(q.tokens.map((t) => t.surface)).toEqual(raw.split(" "));
    expect(q.lexicalTokens.map((t) => t.surfaceNormalized || t.surface)).toEqual(raw.split(" "));
    expect(q.lexicalPhraseKey).not.toBe("machine learn");
  });

  test("ambiguous trusted expansions do not invent a unique completion", () => {
    const ambiguousPlugins = [
      morphology(),
      compileConfiguredConceptPlugin({ configuredConcepts: [
          { key: "ml", aliases: [["machine", "learning"]]},
          { key: "mlang", aliases: [["machine", "language"]]},
        ],
      }),
    ];
    const q = analyzeQuery("machine l", { plugins: ambiguousPlugins });
    expect(q.contextualCompletion).toBeNull();
    expect(q.tokens.map((t) => t.normalized)).toEqual(["machine", "l"]);
    expect(q.lexicalTokens.map((t) => t.normalized)).toEqual(["machine", "l"]);
    expect(q.lexicalPhraseKey).toBe("machine l");
  });

  test("shared expansion across two keys is one signature, not ambiguity", () => {
    const q = analyze("hypertext transfer prot");
    expect(q.tokens.map((t) => t.surface)).toEqual(["hypertext", "transfer", "prot"]);
    expect(q.tokens[2].normalized).toBe("prot");
    expect(q.lexicalTokens.map((t) => t.lemma || t.normalized)).toEqual([
      "hypertext",
      "transfer",
      "protocol",
    ]);
    expect(q.contextualCompletion.completedToken).toBe("protocol");
  });

  test("standalone stubs do not complete from configured expansions", () => {
    expect(analyze("l").contextualCompletion).toBeNull();
    expect(analyze("sec").contextualCompletion).toBeNull();
    expect(analyze("prot").contextualCompletion).toBeNull();
  });

  test("an exact alias token of the same entry is not treated as a prefix stub", () => {
    const q = analyze("application sec");
    expect(q.tokens.map((t) => t.surfaceNormalized || t.normalized)).toEqual(["application", "sec"]);
    expect(q.contextualCompletion).toBeNull();
    expect(q.configuredSequenceIntent).toMatchObject({ key: "appsec" });
    expect(q.lexicalPhraseKey).toMatch(/security$/);
  });
});

describe("contextual expansion completion ranking", () => {
  let e;

  beforeAll(async () => {
    e = await engine();
  });

  test("machine l / machine le rank the phrase document above incidental App Sec", () => {
    for (const query of ["machine l", "machine le"]) {
      const detailed = e.searchDetailed(query, { limit: 5, explain: true });
      expect(e.search(query, { limit: 5 }).map((r) => r.id)).toEqual(detailed.results.map((r) => r.id));
      const linear = detailed.results.find((r) => r.id === "ml");
      const appsec = detailed.results.find((r) => r.id === "appsec");
      expect(linear).toBeTruthy();
      expect(linear.rank).toBe(1);
      expect(linear.features.matchingPhraseKey).toBe("machine learn");
      expect(linear.features.bodyPhraseCount).toBe(5);
      expect(detailed.results[0].explanation.query.tokens[1].surface).toMatch(/^l/);
      expect(detailed.results[0].explanation.query.lexicalPhraseKey).toBe("machine learn");
      if (appsec) expect(appsec.rank).toBeGreaterThan(linear.rank);
    }
  });

  test("frames p / pe / per s / per sec rank the fps document above App Sec", () => {
    for (const query of ["frames p", "frames pe", "frames per s", "frames per sec"]) {
      const detailed = e.searchDetailed(query, { limit: 5, explain: true });
      const fps = detailed.results.find((r) => r.id === "fps");
      const appsec = detailed.results.find((r) => r.id === "appsec");
      const last = detailed.results[0].explanation.query.tokens.at(-1);
      expect(last.normalized).toMatch(/^(p|pe|s|sec)$/);
      expect(fps).toBeTruthy();
      expect(fps.rank).toBe(1);
      expect(fps.features.bodyPhraseCount).toBeGreaterThanOrEqual(2);
      if (appsec) expect(appsec.rank).toBeGreaterThan(fps.rank);
    }
  });

  test("sec and app sec still match App Sec", () => {
    expect(e.search("sec")[0].id).toBe("appsec");
    expect(e.search("app sec")[0].id).toBe("appsec");
  });

  test("hypertext transfer prot does not let prot independently elect Protobuf", () => {
    const detailed = e.searchDetailed("hypertext transfer prot", { limit: 5, explain: true });
    const http = detailed.results.find((r) => r.id === "http");
    const proto = detailed.results.find((r) => r.id === "proto");
    expect(http).toBeTruthy();
    expect(proto).toBeUndefined();
    expect(detailed.results[0].explanation.query.tokens[2].surface).toBe("prot");
    expect(detailed.results[0].explanation.query.lexicalPhraseKey).toBe("hypertext transfer protocol");
  });

  test("standalone proto/protobuf still match Protobuf Encoding", () => {
    expect(e.search("proto")[0].id).toBe("proto");
    expect(e.search("protobuf")[0].id).toBe("proto");
  });
});

describe("indexed and full-scan stay equivalent for contextual completion", () => {
  test("new fixtures match across retrievers", async () => {
    const full = await engine("full-scan");
    const indexed = await engine("indexed");
    for (const query of [
      "machine l",
      "machine le",
      "machine c",
      "frames p",
      "frames per sec",
      "hypertext transfer prot",
    ]) {
      expect(indexed.search(query, { limit: 5 }).map((r) => r.id)).toEqual(
        full.search(query, { limit: 5 }).map((r) => r.id)
      );
    }
  });
});

describe("version/compact companion does not regain inferred-completion as typed", () => {
  const tlsDict = [{ key: "tls", aliases: [["transport", "layer", "security"]]}];
  const tlsDocs = [
    {
      id: "/tls/",
      title: "TLS 1.2 Vulnerability",
      body: "TLS 1.2 protocol vulnerability and AES-128 cipher suites.",
    },
    { id: "/d3d/", title: "Direct3D 12 Guide", body: "A guide to Direct3D 12." },
  ];

  test("12 vuln stays weak compact companion and 12 v stays unboosted", async () => {
    const plugins = [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: tlsDict })];
    const e = SearchEngine.create({ schema, plugins });
    await e.index(tlsDocs);
    const index = buildIndex(tlsDocs, schema, plugins);
    const tlsDoc = index.documents.find((d) => d.id === "/tls/");

    const vulnQuery = analyzeQuery("12 vuln", {
      plugins,
      lexicon: index.titleTokenSet,
      prefixLexicon: index.surfaceVocabulary || index.titleTokenSet,
    });
    const stub = vulnQuery.tokens.find((t) => t.surface === "vuln");
    expect(typedForm(stub)).toBe("vuln");
    expect(stub.surfaceNormalized).toBe("vuln");
    expect(vulnQuery.contextualCompletion).toBeNull();
    expect(versionHit(vulnQuery, tlsDoc)?.companion).toBe("weak");

    const vQuery = analyzeQuery("12 v", {
      plugins,
      lexicon: index.titleTokenSet,
      prefixLexicon: index.surfaceVocabulary || index.titleTokenSet,
    });
    expect(vQuery.tokens.find((t) => t.surface === "v").normalized).toBe("v");
    expect(vQuery.contextualCompletion).toBeNull();
    expect(versionHit(vQuery, tlsDoc)?.companion).toBe("absent");

    const vuln = e.searchDetailed("12 vuln", { limit: 5, explain: true });
    expect(vuln.results[0].title).toBe("Direct3D 12 Guide");
    const tls = vuln.results.find((r) => r.id === "/tls/");
    expect(tls.features.versionMatch).toBe("compact-weak");

    expect(e.search("12 v")[0].title).toBe("Direct3D 12 Guide");
    expect(e.search("12 vulnerability")[0].title).toBe("TLS 1.2 Vulnerability");
    expect(e.search("12 vulnerabilit")[0].title).toBe("TLS 1.2 Vulnerability");
  });
});
