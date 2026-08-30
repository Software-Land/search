/**
 * Directional search-equivalence / synonym recall.
 * Synthetic only. Does not change Software.Land expectedTop/oracle files.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SearchEngine,
  morphology,
  compileAuthoredRelevance,
  InvalidConfigurationError,
} from "../dist/index.js";
import { normalizeSearchEquivalences, MAX_SEARCH_EQUIVALENCE_TARGETS } from "../dist/synonyms.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { analyzeQuery } from "../dist/analyze.js";
import { stage3AUnsupportedReason } from "../dist/exactBlockSkip.js";
import { coverageConcepts, isSearchEquivalenceRecallConcept, searchEquivalenceRecallConcepts } from "../dist/retrieve.js";
import { compareConstraint } from "../dist/constraints.js";
import { synonyms, deriveMorphologyEquivalenceLookup } from "../dist/synonyms.js";
import { extractFeatures } from "../dist/features.js";
import { configuredConceptPluginFromLegacy } from "./helpers/authored.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, "fixtures", "software-land");
const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

const docs = [
  { id: "load", title: "Load Testing", body: "performance load testing notes" },
  { id: "software", title: "Software Testing", body: "software testing methods" },
  { id: "qa-guide", title: "Quality Assurance Guide", body: "process quality assurance handbook" },
  { id: "unrelated", title: "Gardening Tips", body: "tomatoes and soil" },
  { id: "verify", title: "Verification Methods", body: "verification of requirements" },
  { id: "software-only", title: "Software Notes", body: "compilers and runtimes" },
  { id: "reversed", title: "Testing Software", body: "order reversed phrase" },
];

function ids(hits) {
  return hits.map((hit) => hit.id);
}

function plugins({ dict = [{ key: "qa", aliases: [["quality", "assurance"]]}], map = { qa: ["testing"] }, lemmas } = {}) {
  const list = [morphology(lemmas ? { lemmas } : {}), configuredConceptPluginFromLegacy(dict)];
  if (map) list.push(synonyms(map));
  return list;
}

async function engine(opts = {}) {
  const e = SearchEngine.create({
    schema,
    plugins: plugins(opts),
    retriever: opts.retriever || "indexed",
    relationshipStrategy: "none",
  });
  await e.index(opts.docs || docs);
  return e;
}

function assertSearchParity(eng, query) {
  const searchHits = eng.search(query, { limit: 50 });
  const detailedHits = eng.searchDetailed(query, { limit: 50 }).results;
  expect(ids(searchHits)).toEqual(ids(detailedHits));
  return searchHits;
}

async function assertIndexedFullScan(query, pluginOpts = {}) {
  const indexed = await engine({ ...pluginOpts, retriever: "indexed" });
  const full = await engine({ ...pluginOpts, retriever: "full-scan" });
  const indexedHits = assertSearchParity(indexed, query);
  const fullHits = assertSearchParity(full, query);
  expect(ids(indexedHits)).toEqual(ids(fullHits));
  return { indexed, full, indexedHits, fullHits };
}

describe("normalizeSearchEquivalences", () => {
  test("normalizes, unions duplicate sources, dedupes targets, bounds fan-out", () => {
    const nine = Array.from({ length: MAX_SEARCH_EQUIVALENCE_TARGETS + 1 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    const out = normalizeSearchEquivalences({
      QA: ["Testing", "testing"],
      qa: ["exam"],
      "Quality Assurance": ["testing"],
      "": ["x"],
      blank: [],
      self: ["self"],
      tooMany: nine,
    });
    expect(out.entries.find((e) => e.source === "qa").targets).toEqual(["exam", "testing"]);
    expect(out.entries.find((e) => e.source === "quality assurance").targets).toEqual(["testing"]);
    expect(out.entries.find((e) => e.source === "toomany").targets).toHaveLength(MAX_SEARCH_EQUIVALENCE_TARGETS);
    expect(out.rejected.some((r) => r.reason === "empty-or-unsafe-source")).toBe(true);
    expect(out.rejected.some((r) => r.reason === "empty-targets")).toBe(true);
    expect(out.rejected.some((r) => r.reason === "source-equals-target")).toBe(true);
    expect(out.rejected.some((r) => r.reason === "target-limit")).toBe(true);
  });

  test("rejects whitespace-normalized prototype-pollution keys", () => {
    const out = normalizeSearchEquivalences({
      " constructor ": ["testing"],
      " __proto__ ": ["testing"],
      " prototype ": ["testing"],
      toString: ["testing"],
    });
    expect(out.rejected.filter((r) => r.reason === "forbidden-key").map((r) => r.source).sort()).toEqual([
      " __proto__ ",
      " constructor ",
      " prototype ",
    ]);
    expect(out.entries).toEqual([{ source: "tostring", targets: ["testing"] }]);
  });

  test("fails closed on tokenizer-destructive symbolic targets and keeps a*", () => {
    const out = normalizeSearchEquivalences({
      astar: ["a*"],
      cpp: ["c++"],
      csharp: ["c#"],
      bigo: ["O(1)"],
    });
    expect(out.entries).toEqual([{ source: "astar", targets: ["a*"] }]);
    expect(new Set(out.rejected.map((r) => r.source))).toEqual(new Set(["bigo", "cpp", "csharp"]));
    expect(out.entries.some((e) => e.targets.includes("c"))).toBe(false);
    expect(out.entries.some((e) => e.targets.includes("a"))).toBe(false);
  });
});

describe("directional search equivalences", () => {
  test("configured qa admits testing titles without rewriting identity", async () => {
    const { indexedHits } = await assertIndexedFullScan("qa");
    const q = analyzeQuery("qa", { plugins: plugins() });
    expect(q.tokens.map((t) => t.normalized)).toEqual(["qa"]);
    expect(q.tokens.map((t) => t.surfaceNormalized)).toEqual(["qa"]);
    expect(q.configuredSequenceIntent.key).toBe("qa");
    expect(q.lexicalPhraseKey).toBe("qa");
    expect(q.equivalentRecall).toEqual([{ source: "qa", target: "testing" }]);
    expect(q.topicalRecall).toBeFalsy();
    expect(q.standaloneRecall).toBeFalsy();
    expect(q.concepts.some((c) => c.kind === "configured-concept" && c.id === "qa")).toBe(true);
    expect(q.concepts.every((c) => c.kind !== "acronym")).toBe(true);
    expect(q.concepts.some((c) => c.kind === "term" && c.forms.includes("testing"))).toBe(true);
    expect(q.concepts.some((c) => c.provenance === "synonym" && c.forms.includes("testing"))).toBe(true);
    expect(ids(indexedHits)).toEqual(expect.arrayContaining(["load", "software"]));
    expect(stage3AUnsupportedReason(q)).not.toBeNull();

    const eng = await engine({ retriever: "indexed" });
    const explained = eng.searchDetailed("qa", { limit: 50, explain: true }).results[0];
    expect(explained.explanation.query.equivalentRecall).toEqual([{ source: "qa", target: "testing" }]);
    expect(explained.explanation.query).not.toHaveProperty("synonymRecall");
    expect(explained.explanation.query.raw).toBe("qa");
  });

  test("phrase source quality assurance admits testing titles", async () => {
    const map = { "quality assurance": ["testing"] };
    const { indexedHits } = await assertIndexedFullScan("quality assurance", { dict: [], map });
    const q = analyzeQuery("quality assurance", { plugins: plugins({ dict: [], map }) });
    expect(q.tokens.map((t) => t.normalized)).toEqual(["quality", "assurance"]);
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.equivalentRecall).toEqual([{ source: "quality assurance", target: "testing" }]);
    expect(ids(indexedHits)).toEqual(expect.arrayContaining(["load", "software"]));
    expect(stage3AUnsupportedReason(q)).toBe("concept-provenance");
  });

  test("directionality is authored, not automatic", async () => {
    const forward = await assertIndexedFullScan("testing", { dict: [], map: { qa: ["testing"] } });
    expect(ids(forward.indexedHits)).not.toContain("qa-guide");
    const q = analyzeQuery("testing", { plugins: plugins({ dict: [], map: { qa: ["testing"] } }) });
    expect(q.equivalentRecall || []).toEqual([]);

    const reverse = await assertIndexedFullScan("testing", {
      dict: [],
      map: { qa: ["testing"], testing: ["quality assurance"] },
    });
    expect(ids(reverse.indexedHits)).toEqual(expect.arrayContaining(["qa-guide"]));
  });

  test("one hop only: qa admits testing, not verification", async () => {
    const map = { qa: ["testing"], testing: ["verification"] };
    const { indexedHits } = await assertIndexedFullScan("qa", { map });
    expect(ids(indexedHits)).toEqual(expect.arrayContaining(["load", "software"]));
    expect(ids(indexedHits)).not.toContain("verify");
    const q = analyzeQuery("qa", { plugins: plugins({ map }) });
    expect(q.equivalentRecall).toEqual([{ source: "qa", target: "testing" }]);
    expect(q.equivalentRecall.some((p) => p.target === "verification")).toBe(false);
  });

  test("uncovered token source admits the target", async () => {
    const { indexedHits } = await assertIndexedFullScan("docker", {
      dict: [],
      map: { docker: ["container"] },
      docs: [
        { id: "c", title: "Container Runtime", body: "linux containers" },
        { id: "g", title: "Gardening Tips", body: "soil" },
      ],
    });
    expect(ids(indexedHits)).toEqual(expect.arrayContaining(["c"]));
  });

  test("multi-token target requires contiguous phrase, not bag matching", async () => {
    const map = { qa: ["software testing"] };
    const { indexedHits } = await assertIndexedFullScan("qa", { map });
    expect(ids(indexedHits)).toEqual(expect.arrayContaining(["software"]));
    expect(ids(indexedHits)).not.toContain("software-only");
    expect(ids(indexedHits)).not.toContain("reversed");
    expect(ids(indexedHits)).not.toContain("load");
  });

  test("ambiguous configured keys fail closed and do not pick qa for a synonym", async () => {
    const dict = [
      { key: "qa", aliases: [["quality", "assurance"]]},
      { key: "testing", aliases: [["quality", "assurance"]]},
    ];
    const map = { qa: ["testing"] };
    const q = analyzeQuery("quality assurance", { plugins: plugins({ dict, map }) });
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.equivalentRecall || []).toEqual([]);
    expect(q.concepts.some((c) => c.kind === "configured-concept")).toBe(false);
    const { indexedHits } = await assertIndexedFullScan("quality assurance", { dict, map });
    expect(ids(indexedHits)).toEqual(expect.arrayContaining(["qa-guide"]));
  });

  test("synonym recall does not activate topical or standalone even when those keys exist", async () => {
    const dict = [
      { key: "qa", aliases: [["quality", "assurance"]]},
      {
        key: "testing",
        aliases: [["test", "practice"]], topicalRecall: [["unit"]],
        standaloneRecall: ["testing"],
      },
    ];
    const q = analyzeQuery("qa", { plugins: plugins({ dict, map: { qa: ["testing"] } }) });
    expect(q.configuredSequenceIntent.key).toBe("qa");
    expect(q.equivalentRecall).toEqual([{ source: "qa", target: "testing" }]);
    expect(q.topicalRecall).toBeFalsy();
    expect(q.standaloneRecall).toBeFalsy();
  });

  test("does not prefix-match synonym sources from typed stubs", () => {
    const map = { security: ["safety"], quality: ["testing"], testing: ["verification"] };
    const plugin = plugins({ dict: [], map });
    expect(analyzeQuery("secu", { plugins: plugin }).equivalentRecall || []).toEqual([]);
    expect(analyzeQuery("qual", { plugins: plugin }).equivalentRecall || []).toEqual([]);
    expect(analyzeQuery("tes", { plugins: plugin }).equivalentRecall || []).toEqual([]);
  });

  test("bidirectional equivalent clique preserves old group reachability", () => {
    const plugin = [
      morphology(),
      synonyms({
        auth: ["authentication"],
        authentication: ["auth"],
      }),
    ];
    const auth = analyzeQuery("auth", { plugins: plugin });
    const authentication = analyzeQuery("authentication", { plugins: plugin });
    expect(auth.concepts.some((c) => c.forms.includes("authentication"))).toBe(true);
    expect(authentication.concepts.some((c) => c.forms.includes("auth"))).toBe(true);
    expect(auth.concepts.find((c) => c.forms.includes("auth")).provenance).toBe("synonym");
  });

  test("synonyms() rejects search-v2-synonyms artifacts", () => {
    expect(() =>
      synonyms({
        format: "search-v2-synonyms",
        version: 1,
        entries: [{ terms: ["auth", "authentication"] }],
      })
    ).toThrow(InvalidConfigurationError);
  });

  test("authored equivalent clique preserves three-term group reachability", () => {
    const authored = compileAuthoredRelevance({
      relationshipMap: {
        alpha: [
          { to: { form: "beta" }, kind: "equivalent" },
          { to: { form: "gamma" }, kind: "equivalent" },
        ],
        beta: [
          { to: { form: "alpha" }, kind: "equivalent" },
          { to: { form: "gamma" }, kind: "equivalent" },
        ],
        gamma: [
          { to: { form: "alpha" }, kind: "equivalent" },
          { to: { form: "beta" }, kind: "equivalent" },
        ],
      },
    });
    const plugin = [morphology(), ...authored.plugins];
    const reachability = {
      alpha: ["beta", "gamma"],
      beta: ["alpha", "gamma"],
      gamma: ["alpha", "beta"],
    };
    for (const [query, others] of Object.entries(reachability)) {
      const analyzed = analyzeQuery(query, { plugins: plugin });
      for (const other of others) {
        expect(analyzed.concepts.some((c) => c.forms.includes(other))).toBe(true);
      }
    }
  });

  test("empty synonyms plugin does not change results", async () => {
    const none = await engine({ map: null });
    const empty = await engine({ map: {} });
    for (const query of ["qa", "quality assurance", "testing", "gardening"]) {
      expect(ids(assertSearchParity(none, query))).toEqual(ids(assertSearchParity(empty, query)));
    }
  });

  test("synonyms() rejects non-objects", () => {
    expect(() => synonyms("qa")).toThrow(InvalidConfigurationError);
    expect(() => synonyms(["testing"])).toThrow(InvalidConfigurationError);
  });
});

describe("search-equivalence morphology / symbols", () => {
  test("suffix lemmas can look up an uncovered source without synonym+lemma explosion", async () => {
    const map = { test: ["probe"] };
    const extra = [
      { id: "probe", title: "Probe Guide", body: "instrumentation" },
      { id: "garden", title: "Gardening Tips", body: "soil" },
    ];
    const plugin = plugins({ dict: [], map });
    const cases = {
      test: analyzeQuery("test", { plugins: plugin }),
      tests: analyzeQuery("tests", { plugins: plugin }),
      testing: analyzeQuery("testing", { plugins: plugin }),
    };
    expect(cases.test.tokens[0].lemma).toBe("test");
    expect(cases.tests.tokens[0].lemma).toBe("test");
    expect(cases.testing.tokens[0].lemma).toBe("test");
    expect(cases.test.equivalentRecall).toEqual([{ source: "test", target: "probe" }]);
    expect(cases.tests.equivalentRecall).toEqual([{ source: "test", target: "probe" }]);
    expect(cases.testing.equivalentRecall).toEqual([{ source: "test", target: "probe" }]);
    expect(cases.testing.concepts.filter((c) => c.provenance === "synonym").length).toBeLessThanOrEqual(1);
    const { indexedHits } = await assertIndexedFullScan("tests", { dict: [], map, docs: extra });
    expect(ids(indexedHits)).toEqual(expect.arrayContaining(["probe"]));
  });
});

describe("search-equivalence regression controls without synonyms", () => {
  const regressionQueries = [
    "appsec",
    "application security",
    "what is an app sec",
    "what is an applicatio security",
    "hypertext",
    "machine l",
    "frames per sec",
    "12 vulnerability",
    "12 vuln",
  ];

  let baseline;
  let emptyPlugin;

  beforeAll(async () => {
    function loadJson(name) {
      return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
    }
    const documents = loadJson("documents.json");
    const common = {
      schema,
      documentRelationships: loadJson("relationships.json"),
      relationshipStrategy: "hybrid",
      retriever: "full-scan",
    };
    const basePlugins = [morphology({ lemmas: loadJson("lemmas.json") }), compileConfiguredConceptPlugin({ configuredConcepts: loadJson("configured-concepts.json") })];
    baseline = SearchEngine.create({ ...common, plugins: basePlugins });
    emptyPlugin = SearchEngine.create({ ...common, plugins: [...basePlugins, synonyms({})] });
    await baseline.index(documents);
    await emptyPlugin.index(documents);
  });

  test.each(regressionQueries)("%s is unchanged by an empty synonyms plugin", (query) => {
    const a = baseline.search(query, { limit: 20 });
    const b = emptyPlugin.search(query, { limit: 20 });
    expect(ids(b)).toEqual(ids(a));
    expect(ids(baseline.searchDetailed(query, { limit: 20 }).results)).toEqual(ids(a));
    expect(ids(emptyPlugin.searchDetailed(query, { limit: 20 }).results)).toEqual(ids(b));
  });
});

describe("search-equivalence memory envelope", () => {
  test("map lookup stays O(1) per source and memory is small at V1 / 500 / 1000 keys", () => {
    function measure(n, fanout) {
      const map = {};
      for (let i = 0; i < n; i++) {
        const targets = [];
        for (let j = 0; j < fanout; j++) targets.push(`t${i}_${j}`);
        map[`k${i}`] = targets;
      }
      const normalized = normalizeSearchEquivalences(map);
      const plugin = synonyms(map);
      const jsonBytes = Buffer.byteLength(JSON.stringify(normalized.entries), "utf8");
      expect(plugin.expand("k0").length).toBe(Math.min(fanout, MAX_SEARCH_EQUIVALENCE_TARGETS));
      expect(plugin.expand("missing")).toEqual([]);
      return { keys: n, edges: n * Math.min(fanout, MAX_SEARCH_EQUIVALENCE_TARGETS), jsonBytes };
    }
    const v1 = measure(76, 2);
    const mid = measure(500, 2);
    const large = measure(1000, 2);
    expect(v1.jsonBytes).toBeLessThan(20_000);
    expect(mid.jsonBytes).toBeLessThan(80_000);
    expect(large.jsonBytes).toBeLessThan(160_000);
  });
});

describe("extra synonym recall vs merged ordinary-term synonyms", () => {
  test("configured occupancy attaches extra synonym concepts that do not dilute typed coverage", async () => {
    const extraDocs = [
      { id: "rbac", title: "RBAC Guide", body: "role based access control overview" },
      { id: "react-auth", title: "React Authentication", body: "compares rbac versus abac in the client" },
      { id: "zero-trust", title: "Zero-Trust Security", body: "perimeter notes" },
      { id: "sec-body", title: "Garden Notes", body: "application security checklist without the key" },
      { id: "unrelated", title: "Tomatoes", body: "soil and water" },
    ];
    const dict = [{ key: "rbac", aliases: [["role", "based", "access", "control"]]}];
    const map = { rbac: ["security", "appsec", "vulnerability"] };
    const { indexed, indexedHits } = await assertIndexedFullScan("rbac", { dict, map, docs: extraDocs });
    expect(ids(indexedHits)).toEqual(expect.arrayContaining(["rbac", "react-auth", "zero-trust", "sec-body"]));

    const q = analyzeQuery("rbac", { plugins: plugins({ dict, map }) });
    expect(q.concepts.filter((c) => c.kind === "configured-concept" && c.id === "rbac")).toHaveLength(1);
    const extras = searchEquivalenceRecallConcepts(q);
    expect(extras.map((c) => c.id).sort()).toEqual(["appsec", "security", "vulnerability"]);
    expect(extras.every((c) => c.provenance === "synonym")).toBe(true);
    expect(q.concepts.filter((c) => isSearchEquivalenceRecallConcept(q, c))).toHaveLength(3);

    const detailed = indexed.searchDetailed("rbac", { limit: 50, explain: true });
    const byId = Object.fromEntries(detailed.results.map((row) => [row.id, row]));

    expect(byId["react-auth"].features.bodyLexicalMatch).toBe(1);
    expect(byId["react-auth"].features.queryCoverage).toBe(0);
    expect(byId["react-auth"].retrievalSources).toContain("body-lexical");
    expect(byId["react-auth"].retrievalSources).not.toContain("equivalent-recall");

    expect(byId["zero-trust"].retrievalSources).toContain("equivalent-recall");
    expect(byId["zero-trust"].retrievalSources).not.toContain("title-token");
    expect(byId["zero-trust"].features.queryCoverage).toBe(0);
    expect(byId["zero-trust"].features.bodyLexicalMatch).toBe(0);
    expect(byId["zero-trust"].features.configuredConceptMatch).toBe(false);
    expect(byId["zero-trust"].features.exactTitleTokenMatch).toBe(false);
    expect(byId["zero-trust"].features.equivalentRecallMatch).toBe(true);
    expect(byId["zero-trust"].features.equivalentRecallTitleMatch).toBe(true);
    expect(byId["zero-trust"].features.equivalentRecallBodyMatch).toBe(false);

    expect(byId["sec-body"].retrievalSources).toContain("equivalent-recall");
    expect(byId["sec-body"].retrievalSources).not.toContain("body-lexical");
    expect(byId["sec-body"].features.queryCoverage).toBe(0);
    expect(byId["sec-body"].features.bodyLexicalMatch).toBe(0);
    expect(byId["sec-body"].features.equivalentRecallMatch).toBe(true);
    expect(byId["sec-body"].features.equivalentRecallTitleMatch).toBe(false);
    expect(byId["sec-body"].features.equivalentRecallBodyMatch).toBe(true);

    expect(ids(detailed.results).indexOf("react-auth")).toBeLessThan(ids(detailed.results).indexOf("zero-trust"));
    expect(ids(detailed.results).indexOf("zero-trust")).toBeLessThan(ids(detailed.results).indexOf("sec-body"));

    const titleVsBody = compareConstraint(
      { document: { id: "zero-trust" }, features: byId["zero-trust"].features, retrievalSources: byId["zero-trust"].retrievalSources },
      { document: { id: "sec-body" }, features: byId["sec-body"].features, retrievalSources: byId["sec-body"].retrievalSources }
    );
    expect(titleVsBody.order).toBe(-1);
    expect(titleVsBody.applied.some((row) => row.id === "equivalent-title-over-equivalent-body")).toBe(true);

    const identityVsSynonym = compareConstraint(
      { document: { id: "react-auth" }, features: byId["react-auth"].features, retrievalSources: byId["react-auth"].retrievalSources },
      { document: { id: "zero-trust" }, features: byId["zero-trust"].features, retrievalSources: byId["zero-trust"].retrievalSources }
    );
    expect(identityVsSynonym.order).toBe(-1);
    expect(identityVsSynonym.applied.some((row) => row.id === "literal-over-equivalent-recall")).toBe(true);
  });

  test("qa extra testing recall stays retrievable and is not typed coverage", async () => {
    const extraDocs = [
      { id: "qa-title", title: "QA Handbook", body: "process notes" },
      { id: "testing-title", title: "Load Testing", body: "performance notes" },
      { id: "testing-body", title: "Garden Notes", body: "unit testing soil moisture" },
    ];
    const { indexedHits } = await assertIndexedFullScan("qa", { docs: extraDocs });
    expect(ids(indexedHits)).toEqual(expect.arrayContaining(["qa-title", "testing-title", "testing-body"]));
    const q = analyzeQuery("qa", { plugins: plugins() });
    expect(searchEquivalenceRecallConcepts(q).map((c) => c.id)).toEqual(["testing"]);
    const eng = await engine({ docs: extraDocs });
    const detailed = eng.searchDetailed("qa", { limit: 20, explain: true });
    const byId = Object.fromEntries(detailed.results.map((row) => [row.id, row]));
    expect(byId["qa-title"].features.configuredConceptMatch).toBe("key-in-title");
    expect(byId["qa-title"].features).not.toHaveProperty("configuredEquivalenceMatch");
    expect(byId["testing-title"].features.queryCoverage).toBe(0);
    expect(byId["testing-title"].features.configuredConceptMatch).toBe(false);
    expect(byId["testing-title"].features).not.toHaveProperty("configuredEquivalenceMatch");
    expect(byId["testing-title"].retrievalSources).toContain("equivalent-recall");
    expect(byId["testing-title"].features.equivalentRecallTitleMatch).toBe(true);
    expect(byId["testing-body"].retrievalSources).toContain("equivalent-recall");
    expect(byId["testing-body"].features.equivalentRecallBodyMatch).toBe(true);
    expect(stage3AUnsupportedReason(q)).not.toBeNull();
  });

  test("uncovered ordinary-term synonyms stay merged into the typed concept", async () => {
    const map = { authentication: ["vulnerability"], interceptor: ["middleware"] };
    const extraDocs = [
      { id: "auth", title: "Login Flow", body: "password authentication cookies" },
      { id: "vuln", title: "TLS 1.2 Vulnerability", body: "cipher notes" },
      { id: "mw", title: "Authorization Middleware", body: "request interceptors" },
    ];
    const pluginOpts = { dict: [], map, docs: extraDocs };
    const { indexedHits: authHits } = await assertIndexedFullScan("authentication", pluginOpts);
    const { indexedHits: interceptorHits } = await assertIndexedFullScan("interceptor", pluginOpts);
    expect(ids(authHits)).toEqual(expect.arrayContaining(["auth", "vuln"]));
    expect(ids(interceptorHits)).toEqual(expect.arrayContaining(["mw"]));

    const authQ = analyzeQuery("authentication", { plugins: plugins({ dict: [], map }) });
    const interceptorQ = analyzeQuery("interceptor", { plugins: plugins({ dict: [], map }) });
    expect(searchEquivalenceRecallConcepts(authQ)).toEqual([]);
    expect(searchEquivalenceRecallConcepts(interceptorQ)).toEqual([]);
    const authConcept = authQ.concepts.find((c) => c.kind === "term" && (c.id === "authentication" || c.forms.includes("authentication")));
    const interceptorConcept = interceptorQ.concepts.find((c) => c.kind === "term" && (c.id === "interceptor" || c.forms.includes("interceptor")));
    expect(authConcept.forms).toEqual(expect.arrayContaining(["authentication", "vulnerability"]));
    expect(["synonym", "morphology", "surface"]).toContain(authConcept.provenance);
    expect(isSearchEquivalenceRecallConcept(authQ, authConcept)).toBe(false);
    expect(interceptorConcept.forms).toEqual(expect.arrayContaining(["interceptor", "middleware"]));
    expect(isSearchEquivalenceRecallConcept(interceptorQ, interceptorConcept)).toBe(false);

    const authEng = await engine(pluginOpts);
    const vuln = authEng.searchDetailed("authentication", { limit: 20, explain: true }).results.find((row) => row.id === "vuln");
    expect(vuln.retrievalSources).toContain("title-token");
    expect(vuln.retrievalSources).not.toContain("equivalent-recall");
    expect(vuln.features.queryCoverage).toBeGreaterThan(0);
    expect(vuln.features.equivalentRecallMatch).toBeFalsy();
  });
});

function morphPlugins({ lemmas = {}, dict = [], map } = {}) {
  const list = [morphology({ lemmas }), compileConfiguredConceptPlugin({ configuredConcepts: dict })];
  if (map) list.push(synonyms(map));
  return list;
}

describe("morphology-aware directional search equivalences", () => {
  const jogDocs = [
    { id: "jog", title: "Outdoor Notes", body: "outdoor jogging form" },
      { id: "run", title: "Track Workouts", body: "track running workouts" },
    { id: "walk", title: "Walking Guide", body: "casual walking routes" },
    { id: "unrelated", title: "Gardening Tips", body: "tomatoes and soil" },
  ];

  test("authored inflected key activates from the canonical lemma", async () => {
    const lemmas = { running: "run" };
    const map = { running: ["jogging"] };
    const plugin = morphPlugins({ lemmas, dict: [], map });
    const q = analyzeQuery("run", { plugins: plugin });
    expect(q.tokens[0].surface).toBe("run");
    expect(q.tokens[0].normalized).toBe("run");
    expect(q.concepts).toHaveLength(1);
    expect(q.concepts[0].forms).toEqual(expect.arrayContaining(["run", "jogging"]));
    expect(searchEquivalenceRecallConcepts(q)).toEqual([]);
    expect(q.equivalentRecall).toEqual([{ source: "run", target: "jogging" }]);
    const { indexedHits } = await assertIndexedFullScan("run", {
      dict: [],
      map,
      lemmas,
      docs: jogDocs,
    });
    expect(ids(indexedHits)).toContain("jog");
    expect(ids(indexedHits)).not.toContain("unrelated");
  });

  test("exact authored key remains authoritative over a derived lemma alias", () => {
    const plugin = morphPlugins({
      lemmas: { running: "run" },
      dict: [],
      map: { run: ["sprinting"], running: ["jogging"] },
    });
    const q = analyzeQuery("run", { plugins: plugin });
    expect(q.concepts[0].forms).toEqual(expect.arrayContaining(["run", "sprinting"]));
    expect(q.concepts[0].forms).not.toContain("jogging");
    expect(q.equivalentRecall).toEqual([{ source: "run", target: "sprinting" }]);
  });

  test("derived canonical lookup keeps authored directionality", () => {
    const plugin = morphPlugins({
      lemmas: { running: "run" },
      dict: [],
      map: { running: ["jogging"] },
    });
    const forward = analyzeQuery("run", { plugins: plugin });
    const reverse = analyzeQuery("jogging", { plugins: plugin });
    expect(forward.equivalentRecall).toEqual([{ source: "run", target: "jogging" }]);
    expect(reverse.equivalentRecall || []).toEqual([]);
    expect(reverse.concepts[0].forms).not.toContain("running");
    expect(reverse.concepts[0].forms).not.toContain("run");
  });

  test("bidirectional equivalent groups also derive from canonical keys", () => {
    const plugin = [
      morphology({ lemmas: { running: "run" } }),
      synonyms({
        running: ["jogging"],
        jogging: ["running"],
      }),
    ];
    const run = analyzeQuery("run", { plugins: plugin });
    const jogging = analyzeQuery("jogging", { plugins: plugin });
    expect(run.concepts[0].forms).toEqual(expect.arrayContaining(["run", "jogging"]));
    expect(jogging.concepts[0].forms).toEqual(expect.arrayContaining(["jogging", "running"]));
  });

  test("identical target sets sharing a lemma may share the derived lookup", () => {
    const authored = new Map([
      ["running", ["jogging"]],
      ["ran", ["jogging"]],
    ]);
    const derived = deriveMorphologyEquivalenceLookup(authored, (token) =>
      token === "running" || token === "ran" ? "run" : null
    );
    expect([...derived.entries()]).toEqual([["run", ["jogging"]]]);
    const plugin = morphPlugins({
      lemmas: { running: "run", ran: "run" },
      dict: [],
      map: { running: ["jogging"], ran: ["jogging"] },
    });
    expect(analyzeQuery("run", { plugins: plugin }).equivalentRecall).toEqual([{ source: "run", target: "jogging" }]);
  });

  test("incompatible target sets for one lemma fail closed", () => {
    const authored = new Map([
      ["running", ["jogging"]],
      ["ran", ["walking"]],
    ]);
    const derived = deriveMorphologyEquivalenceLookup(authored, (token) =>
      token === "running" || token === "ran" ? "run" : null
    );
    expect(derived.size).toBe(0);
    const plugin = morphPlugins({
      lemmas: { running: "run", ran: "run" },
      dict: [],
      map: { running: ["jogging"], ran: ["walking"] },
    });
    expect(analyzeQuery("run", { plugins: plugin }).equivalentRecall || []).toEqual([]);
    expect(analyzeQuery("run", { plugins: plugin }).concepts[0].forms).not.toContain("jogging");
    expect(analyzeQuery("run", { plugins: plugin }).concepts[0].forms).not.toContain("walking");
  });

  test("no canonical table entry does not heuristic-fold the authored key", () => {
    const plugin = morphPlugins({
      lemmas: {},
      dict: [],
      map: { partitioning: ["sharding"] },
    });
    const morph = morphology();
    expect(morph.canonicalLemma("partitioning")).toBeNull();
    expect(morph.lemma("partitioning")).toBe("partition");
    const partition = analyzeQuery("partition", { plugins: plugin });
    const partit = analyzeQuery("partit", { plugins: plugin });
    expect(partition.equivalentRecall || []).toEqual([]);
    expect(partit.equivalentRecall || []).toEqual([]);
    expect(partition.concepts[0].forms).not.toContain("sharding");
    const exact = analyzeQuery("partitioning", { plugins: plugin });
    expect(exact.tokens[0].normalized).toBe("partitioning");
    expect(exact.equivalentRecall).toEqual([{ source: "partitioning", target: "sharding" }]);
  });

  test("query surface is preserved when a derived target activates", () => {
    const plugin = morphPlugins({
      lemmas: { running: "run" },
      dict: [],
      map: { running: ["jogging"] },
    });
    const run = analyzeQuery("run", { plugins: plugin });
    const running = analyzeQuery("running", { plugins: plugin });
    expect(run.tokens[0].surface).toBe("run");
    expect(run.originalSurface).toEqual(["run"]);
    expect(running.tokens[0].surface).toBe("running");
    expect(running.originalSurface).toEqual(["running"]);
    expect(running.tokens[0].normalized).toBe("run");
    expect(run.raw).toBe("run");
    expect(running.raw).toBe("running");
    expect(run.concepts[0].forms).not.toContain("running");
    expect(running.concepts[0].forms).toEqual(expect.arrayContaining(["running", "run", "jogging"]));
  });

  test("morphology-derived equivalence stays on the same coverage concept", async () => {
    const map = { running: ["jogging"] };
    const lemmas = { running: "run" };
    const plugin = morphPlugins({ lemmas, dict: [], map });
    const q = analyzeQuery("run", { plugins: plugin });
    expect(coverageConcepts(q, q.concepts)).toHaveLength(1);
    expect(q.concepts.filter((c) => c.kind === "term")).toHaveLength(1);
    expect(searchEquivalenceRecallConcepts(q)).toEqual([]);
    expect(isSearchEquivalenceRecallConcept(q, q.concepts[0])).toBe(false);
    const { indexed } = await assertIndexedFullScan("run", { dict: [], map, lemmas, docs: jogDocs });
    const jog = indexed.searchDetailed("run", { limit: 20, explain: true }).results.find((row) => row.id === "jog");
    expect(jog.retrievalSources).toContain("body-lexical");
    expect(jog.retrievalSources).not.toContain("equivalent-recall");
    expect(jog.features.bodyLexicalMatch).toBe(1);
    expect(jog.features.queryCoverage).toBe(0);
    expect(jog.features.coverageConceptCount).toBe(1);
    expect(jog.features.lexicalConceptCoverage).toBe(1);
    expect(jog.features.equivalentRecallMatch).toBeFalsy();
  });

  test("shard family reaches partitioning without an authored shard key", async () => {
    const map = { sharding: ["partitioning"], partitioning: ["sharding"] };
    const plugin = morphPlugins({ dict: [], map });
    expect(morphology().canonicalLemma("sharding")).toBe("shard");
    expect(morphology().canonicalLemma("shard")).toBeNull();
    const shardDocs = [
      { id: "cockroach", title: "CockroachDB vs Postgres", body: "geo partitioning native support" },
      { id: "sql", title: "SQL vs NoSQL", body: "advanced table partitioning" },
      { id: "grpc", title: "gRPC vs Kafka", body: "distributed brokers and partitioning" },
      { id: "shard", title: "Sharding", body: "database sharding overview" },
      { id: "unrelated", title: "Gardening Tips", body: "tomatoes and soil" },
    ];
    for (const query of ["shard", "shards", "sharded", "sharding", "shardin", "sharde", "shardsss"]) {
      const q = analyzeQuery(query, { plugins: plugin });
      expect(q.tokens[0].surface).toBe(query);
      expect(q.tokens[0].normalized).toBe("shard");
      expect(q.equivalentRecall).toEqual([{ source: "shard", target: "partitioning" }]);
      expect(q.concepts[0].forms).toContain("partitioning");
      expect(searchEquivalenceRecallConcepts(q)).toEqual([]);
      const { indexedHits } = await assertIndexedFullScan(query, { dict: [], map, docs: shardDocs });
      expect(ids(indexedHits)).toEqual(expect.arrayContaining(["cockroach", "sql", "grpc", "shard"]));
      expect(ids(indexedHits)).not.toContain("unrelated");
    }
    const proofEngine = await engine({ dict: [], map, docs: shardDocs, retriever: "full-scan" });
    const proof = proofEngine.searchDetailed("shard", { limit: 20, explain: true });
    for (const title of ["CockroachDB vs Postgres", "SQL vs NoSQL", "gRPC vs Kafka"]) {
      const hit = proof.results.find((row) => row.title === title);
      expect(hit).toBeDefined();
      expect(hit.features.ordinaryEquivalenceBodyMatch).toBe(true);
      expect(hit.features).not.toHaveProperty("configuredEquivalenceMatch");
      expect(hit.features.bodyPhraseCount).toBe(0);
      expect(hit.features.directClass).toBe("weak");
      expect(hit.score).toBe(0.25);
      expect(hit.rank).toBeLessThanOrEqual(6);
    }
    const reverse = analyzeQuery("partitioning", { plugins: plugin });
    expect(reverse.equivalentRecall).toEqual([{ source: "partitioning", target: "sharding" }]);
    expect(analyzeQuery("partition", { plugins: plugin }).equivalentRecall || []).toEqual([]);
  });

  test("derived partitioning evidence is not double-counted as extra recall", async () => {
    const map = { sharding: ["partitioning"] };
    const shardDocs = [
      { id: "cockroach", title: "CockroachDB vs Postgres", body: "geo partitioning native support" },
      { id: "shard", title: "Sharding", body: "database sharding overview" },
    ];
    const { indexed } = await assertIndexedFullScan("shard", { dict: [], map, docs: shardDocs });
    const detailed = indexed.searchDetailed("shard", { limit: 20, explain: true });
    const cockroach = detailed.results.find((row) => row.id === "cockroach");
    expect(cockroach.retrievalSources).toEqual(["body-lexical"]);
    expect(cockroach.features.bodyLexicalMatch).toBe(1);
    expect(cockroach.features.queryCoverage).toBe(0);
    expect(cockroach.features.coverageConceptCount).toBe(1);
    expect(cockroach.features.lexicalConceptCoverage).toBe(1);
    expect(cockroach.features.ordinaryEquivalenceBodyMatch).toBe(true);
    expect(cockroach.features.bodyPhraseCount).toBe(0);
    expect(cockroach.features.equivalentRecallMatch).toBeFalsy();
    expect(cockroach.features.equivalentRecallBodyMatch).toBeFalsy();
    const q = detailed.results[0].explanation.query;
    expect(coverageConcepts(q, q.concepts)).toHaveLength(1);
    expect(searchEquivalenceRecallConcepts(q)).toEqual([]);
  });

  test("ordinary equivalence body provenance is target-specific and directional", async () => {
    const docs = [
      { id: "target-body", title: "Target body", body: "jogging notes" },
      { id: "source-body", title: "Source body", body: "running notes" },
      { id: "neither", title: "Neither", body: "walking notes" },
      { id: "target-title", title: "Jogging title", body: "walking notes" },
      { id: "both", title: "Jogging title", body: "jogging notes" },
    ];
    const opts = { dict: [], map: { run: ["jogging"] }, docs };
    const { indexed } = await assertIndexedFullScan("run", opts);
    const query = indexed._prepareQuery("run");
    const byId = Object.fromEntries(indexed._index.documents.map((doc) => [doc.id, extractFeatures(query, doc)]));

    expect(byId["target-body"].ordinaryEquivalenceBodyMatch).toBe(true);
    expect(byId["source-body"].ordinaryEquivalenceBodyMatch).toBe(false);
    expect(byId["neither"].ordinaryEquivalenceBodyMatch).toBe(false);
    expect(byId["target-title"].ordinaryEquivalenceBodyMatch).toBe(false);
    expect(byId["both"].ordinaryEquivalenceBodyMatch).toBe(true);
    expect(byId["both"].bodyPhraseCount).toBe(0);

    const reverse = await engine({ ...opts, retriever: "full-scan" });
    expect(reverse._prepareQuery("jogging").equivalentRecall || []).toEqual([]);
    const reverseQuery = reverse._prepareQuery("jogging");
    const reverseTarget = reverse._index.documents.find((doc) => doc.id === "target-body");
    expect(extractFeatures(reverseQuery, reverseTarget).ordinaryEquivalenceBodyMatch).toBe(false);

    const bidirectional = await engine({
      dict: [],
      map: { run: ["jogging"], jogging: ["running"] },
      docs,
      retriever: "full-scan",
    });
    const explicitReverseQuery = bidirectional._prepareQuery("jogging");
    const explicitReverseSource = bidirectional._index.documents.find((doc) => doc.id === "source-body");
    expect(extractFeatures(explicitReverseQuery, explicitReverseSource).ordinaryEquivalenceBodyMatch).toBe(true);

    const ordinary = await engine({
      dict: [],
      map: null,
      docs: [{ id: "ordinary", title: "Ordinary", body: "running notes" }],
      retriever: "full-scan",
    });
    const ordinaryQuery = ordinary._prepareQuery("running");
    const ordinaryDoc = ordinary._index.documents[0];
    expect(extractFeatures(ordinaryQuery, ordinaryDoc).ordinaryEquivalenceBodyMatch).toBe(false);

    const extraRecall = await engine({
      dict: [{ key: "rbac", aliases: [["role", "based", "access", "control"]]}],
      map: { rbac: ["security"] },
      docs: [{ id: "security", title: "Guide", body: "security notes" }],
      retriever: "full-scan",
    });
    const security = extraRecall
      .searchDetailed("rbac", { limit: 20, explain: true })
      .results.find((row) => row.id === "security");
    expect(security.features.equivalentRecallBodyMatch).toBe(true);
    expect(security.features.ordinaryEquivalenceBodyMatch).toBe(false);
  });

  test("lookup map does not grow an authored shard key", () => {
    const plugin = synonyms({ sharding: ["partitioning"] });
    expect(plugin.lookup.has("sharding")).toBe(true);
    expect(plugin.lookup.has("shard")).toBe(false);
    const bound = morphPlugins({ dict: [], map: { sharding: ["partitioning"] } }).find((p) => p.name === "synonyms");
    analyzeQuery("shard", { plugins: morphPlugins({ dict: [], map: { sharding: ["partitioning"] } }) });
    expect(bound.lookup.has("shard")).toBe(false);
    expect(plugin.expand("shard")).toEqual([]);
  });
});
