/**
 * Preflight ranking regressions: bound-token consumption, morphology-derived
 * lemma-prefix restriction, and weak single-token body-frequency tie-break.
 *
 * `frames` must enter the result window through those generic rules, without
 * one-token fps expansion-prefix recall or contextual completion.
 */
import { SearchEngine, morphology, dictionary } from "../dist/index.js";
import { analyzeQuery } from "../dist/analyze.js";
import { extractFeatures } from "../dist/features.js";
import { conceptMatchesTitle } from "../dist/retrieve.js";
import { buildIndex } from "../dist/indexDocuments.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

const fpsDict = [
  { key: "fps", expansion: ["frames", "per", "second"] },
  { key: "appsec", expansion: ["application", "security"], aliases: [["app", "sec"]] },
  { key: "http", expansion: ["hypertext", "transfer", "protocol"] },
  { key: "proto", expansion: ["protocol", "buffer"] },
  { key: "protobuf", expansion: ["protocol", "buffer"] },
];

const docs = [
  {
    id: "fps",
    title: "High Rate Rendering",
    body: "frames per second frames per second frames per second frames per second",
    lexicalFrequency: { "frame per": 4, "per second": 4, frame: 4, per: 4, second: 4 },
  },
  {
    id: "appsec",
    title: "App Sec",
    body: "application security app sec notes",
    lexicalFrequency: { "application security": 1, "app sec": 1, sec: 2 },
  },
  {
    id: "http",
    title: "Request Response",
    body: "hypertext transfer protocol request response over http",
    lexicalFrequency: { "transfer protocol": 2, hypertext: 1, transfer: 2, protocol: 5, http: 7 },
  },
  {
    id: "proto",
    title: "Protobuf Encoding",
    body: "protocol buffers protobuf encoding",
    lexicalFrequency: { "protocol buffer": 2, protocol: 3, protobuf: 2 },
  },
];

const frameworkDecoys = Array.from({ length: 12 }, (_, i) => ({
  id: `framework-${i}`,
  title: `Framework Guide ${i}`,
  body: "a software framework package and library comparison",
}));

const plugins = [morphology(), dictionary({ entries: fpsDict })];

function engine(extraDocs = [], retriever = "full-scan") {
  const e = SearchEngine.create({ schema, plugins, retriever });
  return e.index([...docs, ...extraDocs]).then(() => e);
}

function analyze(raw) {
  return analyzeQuery(raw, { plugins });
}

function conceptIds(q) {
  return q.concepts.filter((c) => c.kind === "acronym").map((c) => c.id);
}

describe("morphology-derived lemma prefix", () => {
  test("libraries still matches an independent library title token", () => {
    const morph = [morphology()];
    const index = buildIndex([{ id: "lib", title: "Library", body: "notes" }], schema, morph);
    const q = analyzeQuery("libraries", { plugins: morph });
    const features = extractFeatures(q, index.documents[0]);
    expect(q.tokens[0].lemma).toBe("library");
    expect(features.exactTitleTokenMatch).toBe(true);
    expect(conceptMatchesTitle(q.concepts.find((c) => c.kind === "term"), index.documents[0])).toBe("exact");
  });

  test("frames matches an independent frame title token", () => {
    const morph = [morphology()];
    const index = buildIndex([{ id: "frame", title: "Frame Timing", body: "notes" }], schema, morph);
    const q = analyzeQuery("frames", { plugins: morph });
    const features = extractFeatures(q, index.documents[0]);
    expect(q.tokens[0].surface).toBe("frames");
    expect(q.tokens[0].lemma).toBe("frame");
    expect(conceptMatchesTitle(q.concepts.find((c) => c.kind === "term"), index.documents[0])).toBe("exact");
    expect(features.queryCoverage).toBeGreaterThan(0);
  });

  test("derived lemma frame does not prefix title token framework", () => {
    const morph = [morphology()];
    const index = buildIndex([{ id: "fw", title: "Framework vs Library", body: "notes" }], schema, morph);
    const q = analyzeQuery("frames", { plugins: morph });
    expect(q.tokens[0].normalized).toBe("frames");
    expect(q.tokens[0].lemma).toBe("frame");
    const term = q.concepts.find((c) => c.kind === "term");
    expect(conceptMatchesTitle(term, index.documents[0])).toBeNull();
    const features = extractFeatures(q, index.documents[0]);
    expect(features.queryCoverage).toBe(0);
    expect(features.titlePrefixQuality).toBe(0);
    expect(features.typedSurfaceTitleMatch).toBe(false);
  });

  test("derived lemma port does not prefix title token portable", () => {
    const morph = [morphology()];
    const index = buildIndex([{ id: "port", title: "Portable Storage", body: "notes" }], schema, morph);
    const q = analyzeQuery("ports", { plugins: morph });
    expect(q.tokens[0].lemma).toBe("port");
    expect(conceptMatchesTitle(q.concepts.find((c) => c.kind === "term"), index.documents[0])).toBeNull();
    expect(extractFeatures(q, index.documents[0]).queryCoverage).toBe(0);
  });

  test("literal typed frame retains existing unique-prefix completion of framework", () => {
    const morph = [morphology()];
    const index = buildIndex([{ id: "fw", title: "Framework vs Library", body: "notes" }], schema, morph);
    const q = analyzeQuery("frame", {
      plugins: morph,
      prefixLexicon: index.documents[0].titleTokens,
    });
    const features = extractFeatures(q, index.documents[0]);
    expect(features.queryCoverage).toBeGreaterThan(0);
    expect(features.typedSurfaceTitleMatch || features.titlePrefixQuality > 0 || q.prefixCompletion?.completedToken).toBeTruthy();
  });
});

describe("weak single-token body-frequency pack", () => {
  test("repeated body evidence outranks an otherwise-equivalent low-frequency weak body hit", async () => {
    const e = SearchEngine.create({ schema, plugins: [morphology()], retriever: "full-scan" });
    await e.index([
      {
        id: "a-rare",
        title: "Unrelated Alpha",
        body: "frame",
        lexicalFrequency: { frame: 1 },
      },
      {
        id: "z-common",
        title: "Unrelated Zeta",
        body: "frame frame frame frame frame frame frame frame",
        lexicalFrequency: { frame: 8 },
      },
    ]);
    const detailed = e.searchDetailed("frames", { limit: 10, explain: true });
    const rare = detailed.results.find((r) => r.id === "a-rare");
    const common = detailed.results.find((r) => r.id === "z-common");
    expect(rare.features.directClass).toBe("weak");
    expect(common.features.directClass).toBe("weak");
    expect(rare.score).toBe(common.score);
    expect(common.features.bodyPhraseCount).toBeGreaterThan(rare.features.bodyPhraseCount);
    expect(common.rank).toBeLessThan(rare.rank);
  });
});

describe("single-token frames ranking window", () => {
  test("frames does not require fps concept attachment or contextual completion", () => {
    const q = analyze("frames");
    expect(q.tokens.map((t) => t.surface)).toEqual(["frames"]);
    expect(q.contextualCompletion).toBeNull();
    expect(q.tokens.length).toBe(1);
    expect(q.concepts.some((c) => c.kind === "acronym" && c.id === "fps")).toBe(false);
  });

  test("frames per already attaches fps as a unique 2/3 expansion prefix", () => {
    const q = analyze("frames per");
    const fps = q.concepts.find((c) => c.kind === "acronym" && c.id === "fps");
    expect(fps).toBeTruthy();
    expect(fps.provenance).toBe("partial-expansion");
    expect(fps.matchedExpansionTokens).toBe(2);
    expect(fps.expansionCoverage).toBe(0.6667);
    expect(q.contextualCompletion).toBeNull();
  });

  test("frames ranks the fps document in the top 10 among framework-prefix decoys without acronym recall", async () => {
    const e = await engine(frameworkDecoys);
    const detailed = e.searchDetailed("frames", { limit: 20, explain: true });
    const q = detailed.results[0]?.explanation?.query;
    expect(q?.contextualCompletion == null).toBe(true);
    expect(q?.concepts?.some((c) => c.id === "fps")).toBe(false);
    const fps = detailed.results.find((r) => r.id === "fps");
    expect(fps).toBeTruthy();
    expect(fps.rank).toBeLessThanOrEqual(10);
    const frameworkHit = detailed.results.find((r) => r.id === "framework-0");
    if (frameworkHit) {
      expect(frameworkHit.features.queryCoverage).toBe(0);
      expect(frameworkHit.directClass).not.toBe("moderate");
    }
  });

  test("frames per ranks the fps document more specifically than plain frames", async () => {
    const e = await engine(frameworkDecoys);
    const one = e.searchDetailed("frames", { limit: 30, explain: true });
    const two = e.searchDetailed("frames per", { limit: 10, explain: true });
    const fpsOne = one.results.find((r) => r.id === "fps");
    const fpsTwo = two.results.find((r) => r.id === "fps");
    expect(fpsTwo).toBeTruthy();
    expect(fpsTwo.rank).toBe(1);
    expect(fpsTwo.explanation.query.concepts.some((c) => c.id === "fps")).toBe(true);
    expect(fpsOne).toBeTruthy();
    expect(fpsOne.explanation.query.concepts.some((c) => c.id === "fps")).toBe(false);
  });

  test("ambiguous first-token prefixes must not uniquely project one meaning", () => {
    const ambiguousPlugins = [
      morphology(),
      dictionary({
        entries: [
          { key: "ml", expansion: ["machine", "learning"] },
          { key: "mlang", expansion: ["machine", "language"] },
        ],
      }),
    ];
    const q = analyzeQuery("machine", { plugins: ambiguousPlugins });
    expect(q.contextualCompletion).toBeNull();
    expect(q.concepts.some((c) => c.kind === "acronym")).toBe(false);
    expect(conceptIds(q)).toEqual([]);
  });

  test("common token per is not a unique expansion-prefix recall of fps", () => {
    const q = analyze("per");
    expect(q.concepts.some((c) => c.id === "fps")).toBe(false);
    expect(q.contextualCompletion).toBeNull();
  });

  test("indexed and full-scan agree on frames and frames per sec", async () => {
    const extra = frameworkDecoys;
    const full = await engine(extra, "full-scan");
    const indexed = await engine(extra, "indexed");
    for (const query of ["frames", "frames per", "frames per sec", "hypertext transfer prot", "sec", "proto"]) {
      expect(indexed.search(query, { limit: 10 }).map((r) => r.id)).toEqual(
        full.search(query, { limit: 10 }).map((r) => r.id)
      );
    }
  });
});

describe("bound-token consumption", () => {
  let e;

  beforeAll(async () => {
    e = await engine();
  });

  test("frames per sec keeps typed sec and completes to second", () => {
    const q = analyze("frames per sec");
    expect(q.tokens.map((t) => t.surface)).toEqual(["frames", "per", "sec"]);
    expect(q.tokens[2].normalized).toBe("sec");
    expect(q.lexicalTokens.map((t) => t.lemma || t.normalized)).toEqual(["frame", "per", "second"]);
    expect(q.lexicalPhraseKey).toBe("frame per second");
    expect(q.contextualCompletion).toMatchObject({
      activePrefix: "sec",
      completedToken: "second",
      canonicalToken: "second",
      source: "configured-expansion-prefix",
    });
  });

  test("bound sec must not independently keep App Sec in the result set", () => {
    const detailed = e.searchDetailed("frames per sec", { limit: 10, explain: true });
    const fps = detailed.results.find((r) => r.id === "fps");
    const appsec = detailed.results.find((r) => r.id === "appsec");
    expect(fps).toBeTruthy();
    expect(fps.rank).toBe(1);
    expect(appsec).toBeUndefined();
  });

  test("standalone sec and app sec still elect App Sec", () => {
    expect(e.search("sec")[0].id).toBe("appsec");
    expect(e.search("app sec")[0].id).toBe("appsec");
    expect(analyze("sec").contextualCompletion).toBeNull();
  });

  test("bound prot must not independently keep protobuf in the result set", () => {
    const q = analyze("hypertext transfer prot");
    expect(q.tokens[2].surface).toBe("prot");
    expect(q.tokens[2].normalized).toBe("prot");
    expect(q.contextualCompletion.completedToken).toBe("protocol");
    const detailed = e.searchDetailed("hypertext transfer prot", { limit: 10, explain: true });
    const http = detailed.results.find((r) => r.id === "http");
    const proto = detailed.results.find((r) => r.id === "proto");
    expect(http).toBeTruthy();
    expect(proto).toBeUndefined();
  });

  test("standalone proto and protobuf still elect Protobuf Encoding", () => {
    expect(e.search("proto")[0].id).toBe("proto");
    expect(e.search("protobuf")[0].id).toBe("proto");
    expect(analyze("prot").contextualCompletion).toBeNull();
  });
});
