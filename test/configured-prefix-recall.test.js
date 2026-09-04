/**
 * 0.6.6 configured partial-form correctness: occupancy vs weak prefix recall.
 */
import { SearchEngine, morphology, compileAuthoredRelevance, ARTIFACT_FORMATS, ARTIFACT_VERSION } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { analyzeQuery } from "../dist/analyze.js";
import { retrievalFormKindAllowsPrefix } from "../dist/retrieve.js";
import { COMPLETE_INTERPRETATION_COLLECTOR } from "../dist/completeInterpretationCollector.js";
import { compileLexicalIndex } from "../dist/lexicalIndex.js";
import { packedSearchFallbackReason } from "../dist/rankingEvidenceSearch.js";
import { rankingEvidenceEligibilityReason } from "../dist/rankingEvidencePlan.js";
import { rankingEvidenceStaticFor } from "../dist/rankingEvidenceState.js";
import { stage3AUnsupportedReason } from "../dist/exactBlockSkip.js";
import { createSearchClient, createWorkerRuntime, createLoopbackTransport } from "../dist/browser/index.js";
import { loadSoftwareLandRelevanceInputs } from "./helpers/software-land-fixture.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

const nistFamily = [
  { key: "nist", aliases: [["national", "institute", "standards", "technology"]] },
  { key: "gatech", aliases: [["georgia", "institute", "of", "technology"]] },
];

const slInputs = loadSoftwareLandRelevanceInputs();
const nistDocs = slInputs.documents.filter((doc) =>
  ["TLS 1.2 Vulnerability", "Information Asymmetry", "Udacity Review"].includes(doc.title)
);

function plugins(entries) {
  return [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: entries })];
}

async function engine(docs, entries, extra = {}) {
  const e = SearchEngine.create({
    schema,
    plugins: plugins(entries),
    relationshipStrategy: "none",
    ...extra,
  });
  await e.index(docs);
  return e;
}

async function compiledEngine(docs, entries) {
  const compiledPlugins = plugins(entries);
  const lexicalIndex = compileLexicalIndex(docs, { schema, plugins: compiledPlugins });
  const e = SearchEngine.create({
    schema,
    plugins: compiledPlugins,
    lexicalIndex,
    retriever: "indexed",
    relationshipStrategy: "none",
  });
  await e.index(docs);
  return e;
}

function analyze(raw, entries = nistFamily) {
  return analyzeQuery(raw, { plugins: plugins(entries) });
}

function tlsHit(results) {
  return results.find((row) => row.title === "TLS 1.2 Vulnerability" || row.id === "ai");
}

describe("configured prefix recall vs occupancy", () => {
  test("national is unique NIST recall at 1/4, not occupancy", () => {
    const q = analyze("national");
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.concepts.some((c) => c.kind === "configured-concept")).toBe(false);
    expect(q.configuredPrefixRecall).toMatchObject({
      key: "nist",
      form: ["national", "institute", "standards", "technology"],
      exactCount: 1,
      formLength: 4,
      coverage: 0.25,
      lastExact: true,
      partialCompleteness: 0,
    });
    expect(q.configuredFormCoverage ?? 0).toBeFalsy();
    expect(retrievalFormKindAllowsPrefix("configured-prefix-recall")).toBe(false);
  });

  test("graded NIST prefix evidence is monotonic through occupancy", () => {
    const nationa = analyze("nationa").configuredPrefixRecall;
    const national = analyze("national").configuredPrefixRecall.coverage;
    const nationalI = analyze("national i").configuredPrefixRecall.coverage;
    const nationalIn = analyze("national in").configuredPrefixRecall.coverage;
    const nationalInst = analyze("national inst").configuredPrefixRecall.coverage;
    expect(analyze("nationa").configuredSequenceIntent).toBeNull();
    expect(nationa).toMatchObject({
      key: "nist",
      exactCount: 0,
      formLength: 4,
      lastExact: false,
      coverage: Number(((7 / 8) / 4).toFixed(4)),
      partialCompleteness: Number((7 / 8).toFixed(4)),
    });
    expect(national).toBe(0.25);
    expect(nationa.coverage).toBeLessThan(national);
    expect(nationalI).toBe(Number(((1 + 1 / 9) / 4).toFixed(4)));
    expect(nationalIn).toBe(Number(((1 + 2 / 9) / 4).toFixed(4)));
    expect(nationalInst).toBe(Number(((1 + 4 / 9) / 4).toFixed(4)));
    expect(national).toBeLessThan(nationalI);
    expect(nationalI).toBeLessThan(nationalIn);
    expect(nationalIn).toBeLessThan(nationalInst);
    const occupied = analyze("national institute");
    expect(occupied.configuredSequenceIntent?.key).toBe("nist");
    expect(occupied.configuredPrefixRecall).toBeNull();
    expect(analyze("national institute s").configuredSequenceIntent?.key).toBe("nist");
    expect(analyze("nist").configuredSequenceIntent?.key).toBe("nist");
  });

  test("exact occupancy requires coverage of at least 1/2", () => {
    expect(analyze("national institute").configuredSequenceIntent?.key).toBe("nist");
    expect(
      analyze("basically available", [
        { key: "base", aliases: [["basically", "available", "soft", "state", "eventual", "consistency"]] },
      ]).configuredSequenceIntent
    ).toBeNull();
    expect(
      analyze("basically available", [
        { key: "base", aliases: [["basically", "available", "soft", "state", "eventual", "consistency"]] },
      ]).configuredPrefixRecall?.key
    ).toBe("base");
    expect(
      analyze("conflict free", [{ key: "crdt", aliases: [["conflict", "free", "replicated", "data", "type"]] }])
        .configuredPrefixRecall?.key
    ).toBe("crdt");
  });

  test("1/5 and 1/6 exact prefixes are nonzero and ordered", () => {
    const five = analyze("alpha", [{ key: "five", aliases: [["alpha", "bravo", "charlie", "delta", "echo"]] }]);
    const six = analyze("alpha", [
      { key: "six", aliases: [["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]] },
    ]);
    expect(five.configuredPrefixRecall.coverage).toBe(0.2);
    expect(six.configuredPrefixRecall.coverage).toBe(Number((1 / 6).toFixed(4)));
    expect(five.configuredPrefixRecall.coverage).toBeGreaterThan(0);
    expect(six.configuredPrefixRecall.coverage).toBeGreaterThan(0);
    expect(five.configuredPrefixRecall.coverage).toBeGreaterThan(six.configuredPrefixRecall.coverage);
  });

  test("a longer same-concept form does not reduce shorter-form prefix evidence", () => {
    const shortOnly = analyze("national", [
      { key: "nist", aliases: [["national", "institute", "standards", "technology"]] },
    ]);
    const withLonger = analyze("national", [
      {
        key: "nist",
        aliases: [
          ["national", "institute", "standards", "technology"],
          ["national", "institute", "of", "standards", "and", "technology"],
        ],
      },
    ]);
    expect(shortOnly.configuredPrefixRecall.coverage).toBe(0.25);
    expect(withLonger.configuredPrefixRecall.coverage).toBe(0.25);
    expect(withLonger.configuredPrefixRecall.formLength).toBe(4);
  });

  test("stop-final identity and is IAM recall, not occupancy", () => {
    const q = analyze("identity and", [
      { key: "iam", aliases: [["identity", "and", "access", "management"]] },
    ]);
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.configuredPrefixRecall?.key).toBe("iam");
    expect(q.configuredPrefixRecall.coverage).toBe(0.5);
  });

  test("national institute of is NIST recall; of stan remains occupancy", () => {
    const ofQuery = analyze("national institute of");
    expect(ofQuery.configuredSequenceIntent).toBeNull();
    expect(ofQuery.configuredPrefixRecall?.key).toBe("nist");
    expect(analyze("national institute of stan").configuredSequenceIntent?.key).toBe("nist");
  });

  test("HTTP family sibling protections and one-token fail closed", () => {
    const httpFamily = [
      { key: "html", aliases: [["hypertext", "markup", "language"]] },
      { key: "http", aliases: [["hypertext", "transfer", "protocol"]] },
      { key: "https", aliases: [["hypertext", "transfer", "protocol", "secure"]] },
      { key: "ci", aliases: [["continuous", "integration"]] },
      { key: "cicd", aliases: [["continuous", "integration", "continuous", "deployment"]] },
      { key: "ip", aliases: [["internet", "protocol"]] },
      { key: "ipsec", aliases: [["internet", "protocol", "security"]] },
      { key: "opengl", aliases: [["open", "graphics", "library"]] },
      { key: "opengles", aliases: [["open", "graphics", "library", "embedded", "systems"]] },
    ];
    expect(analyze("hypertext", httpFamily).configuredPrefixRecall).toBeNull();
    expect(analyze("hypertext", httpFamily).configuredSequenceIntent).toBeNull();
    expect(analyze("hypertex", httpFamily).configuredPrefixRecall).toBeNull();
    expect(analyze("hypertex", httpFamily).configuredSequenceIntent).toBeNull();
    expect(analyze("hypertext t", httpFamily).configuredSequenceIntent?.key).toBe("http");
    expect(analyze("hypertext transfer", httpFamily).configuredSequenceIntent?.key).toBe("http");
    expect(analyze("hypertext transfer protocol", httpFamily).configuredSequenceIntent?.key).toBe("http");
    expect(analyze("continuous integration", httpFamily).configuredSequenceIntent?.key).toBe("ci");
    expect(analyze("internet protocol", httpFamily).configuredSequenceIntent?.key).toBe("ip");
    expect(analyze("open graphics", httpFamily).configuredSequenceIntent?.key).toBe("opengl");
  });

  test("configured KEY prefixes stay off the form-recall path", () => {
    expect(analyze("nist").configuredSequenceIntent?.key).toBe("nist");
    expect(analyze("nist").configuredPrefixRecall).toBeNull();
    expect(analyze("nis").configuredPrefixRecall).toBeNull();
    expect(analyze("nis").concepts.some((c) => c.kind === "configured-concept" && c.id === "nist")).toBe(true);
    expect(analyze("nationa").configuredSequenceIntent).toBeNull();
    expect(analyze("nationa").configuredPrefixRecall?.key).toBe("nist");
  });

  test("cross-concept ambiguous prefixes fail closed", () => {
    const family = [
      { key: "rtp", aliases: [["real", "time", "transport", "protocol"]] },
      { key: "rtmp", aliases: [["real", "time", "messaging", "protocol"]] },
      { key: "rtsp", aliases: [["real", "time", "streaming", "protocol"]] },
      { key: "sla", aliases: [["service", "level", "agreement"]] },
      { key: "slo", aliases: [["service", "level", "objective"]] },
      { key: "saas", aliases: [["software", "as", "a", "service"]] },
      { key: "swe", aliases: [["software", "engineer"]] },
      { key: "swd", aliases: [["software", "developer"]] },
    ];
    for (const raw of ["real", "real t", "real time", "service", "service l", "service level", "software"]) {
      const q = analyze(raw, family);
      expect(q.configuredSequenceIntent).toBeNull();
      expect(q.configuredPrefixRecall).toBeNull();
    }
    expect(analyze("software a", family).configuredPrefixRecall?.key).toBe("saas");
    expect(analyze("software as", family).configuredSequenceIntent).toBeNull();
    expect(analyze("software as", family).configuredPrefixRecall?.key).toBe("saas");
    expect(analyze("role based", [{ key: "rbac", aliases: [["role", "based", "access", "control"]] }]).configuredSequenceIntent?.key).toBe(
      "rbac"
    );
    expect(analyze("role b", [{ key: "rbac", aliases: [["role", "based", "access", "control"]] }]).configuredPrefixRecall?.key).toBe(
      "rbac"
    );
  });
});

describe("configured prefix recall retrieval and scoring", () => {
  test("NIST 3-document reproduction: TLS appears with prefix-only score", async () => {
    const e = await engine(nistDocs, nistFamily);
    const national = e.searchDetailed("national", { limit: 10, relatedLimit: 0, explain: true });
    const tls = tlsHit(national.results);
    expect(tls).toBeTruthy();
    expect(national.results[0].title).toBe("Information Asymmetry");
    expect(tls.rank).toBeGreaterThan(1);
    expect(tls.directClass).toBe("none");
    expect(tls.retrievalSources).toEqual(["configured-prefix-recall"]);
    expect(tls.features.configuredPrefixRecallScore).toBe(0.25);
    expect(tls.features.queryCoverage).toBe(0);
    expect(Number((tls.features.configuredPrefixRecallScore * 0.25).toFixed(4))).toBe(0.0625);

    const ia = national.results.find((row) => row.title === "Information Asymmetry");
    expect(ia.features.configuredPrefixRecallScore).toBe(0);
    expect(ia.retrievalSources).not.toEqual(["configured-prefix-recall"]);
    expect(ia.features.bodyLexicalMatch).toBeGreaterThan(0);

    const nationalI = e.searchDetailed("national i", { limit: 10, relatedLimit: 0, explain: true });
    const tlsI = tlsHit(nationalI.results);
    expect(tlsI).toBeTruthy();
    expect(tlsI.features.configuredPrefixRecallScore).toBeGreaterThan(0.25);
    expect(tlsI.features.configuredPrefixRecallScore).toBe(Number(((1 + 1 / 9) / 4).toFixed(4)));

    const nationalIn = e.searchDetailed("national in", { limit: 10, relatedLimit: 0, explain: true });
    const nationalInst = e.searchDetailed("national inst", { limit: 10, relatedLimit: 0, explain: true });
    expect(tlsHit(nationalIn.results)).toBeTruthy();
    const tlsInst = tlsHit(nationalInst.results);
    expect(tlsInst).toBeTruthy();
    expect(tlsInst.retrievalSources).toEqual(["configured-prefix-recall"]);
    expect(tlsInst.features.configuredPrefixRecallScore).toBeGreaterThan(tlsI.features.configuredPrefixRecallScore);
    expect(tlsInst.features.configuredPrefixRecallScore).toBe(Number(((1 + 4 / 9) / 4).toFixed(4)));

    const occupied = e.searchDetailed("national institute", { limit: 10, relatedLimit: 0, explain: true });
    expect(occupied.results[0].title).toBe("TLS 1.2 Vulnerability");
    expect(tlsHit(occupied.results).directClass).not.toBe("none");
    expect(tlsHit(occupied.results).features.configuredPrefixRecallScore).toBe(0);

    expect(e.searchDetailed("national institute s", { limit: 10, relatedLimit: 0 }).results[0].title).toBe(
      "TLS 1.2 Vulnerability"
    );
    expect(e.searchDetailed("nist", { limit: 10, relatedLimit: 0 }).results[0].title).toBe("TLS 1.2 Vulnerability");
  });

  test("lexical+key overlap does not receive the prefix score; prefix-only does", async () => {
    const e = await engine(
      [
        { id: "lex", title: "National Notes", body: "national news and nist mention" },
        { id: "tls", title: "TLS 1.2 Vulnerability", body: "nist is investigating post quantum cryptography" },
      ],
      nistFamily
    );
    const detailed = e.searchDetailed("national", { limit: 10, relatedLimit: 0, explain: true });
    const mixed = detailed.results.find((row) => row.id === "lex");
    const only = detailed.results.find((row) => row.id === "tls");
    expect(mixed.retrievalSources.sort()).toEqual(expect.arrayContaining(["body-lexical"]));
    expect(mixed.features.configuredPrefixRecallScore).toBe(0);
    expect(mixed.directClass).not.toBe("none");
    expect(only.retrievalSources).toEqual(["configured-prefix-recall"]);
    expect(only.features.configuredPrefixRecallScore).toBe(0.25);
    expect(only.directClass).toBe("none");
  });

  test("key-only hits with feature-level lexical class do not stack the prefix addend", async () => {
    const e = await engine(
      [
        { id: "key", title: "App Sec", body: "base of available tooling" },
        { id: "lex", title: "Notes", body: "basically people write about availability" },
      ],
      [{ key: "base", aliases: [["basically", "available", "soft", "state", "eventual", "consistency"]] }]
    );
    const detailed = e.searchDetailed("basically ava", { limit: 10, relatedLimit: 0, explain: true });
    const keyOnly = detailed.results.find((row) => row.id === "key");
    const typed = detailed.results.find((row) => row.id === "lex");
    expect(keyOnly).toBeTruthy();
    expect(keyOnly.retrievalSources).toEqual(["configured-prefix-recall"]);
    expect(keyOnly.directClass).not.toBe("none");
    expect(keyOnly.features.bodyLexicalMatch).toBeGreaterThan(0);
    expect(keyOnly.features.configuredPrefixRecallScore).toBe(0);
    expect(typed.features.configuredPrefixRecallScore).toBe(0);
    expect(typed.rank).toBeLessThan(keyOnly.rank);
  });

  test("complete-interpretation collector keeps configured-prefix-recall candidates", async () => {
    const docs = [
      { id: "phrase", title: "role based walkthrough", body: "unrelated filler" },
      { id: "rbac", title: "RBAC (Role Based Access Control)", body: "rbac permissions without the typed prefix tokens" },
      { id: "noise", title: "Unrelated", body: "no configured key here" },
    ];
    const e = await engine(docs, [{ key: "rbac", aliases: [["role", "based", "access", "control"]] }]);
    const off = e.search("role b", { limit: 10, relatedLimit: 0 }).map((row) => row.id);
    expect(off).toContain("rbac");
    const on = e.search("role b", { limit: 10, relatedLimit: 0, resultCollector: COMPLETE_INTERPRETATION_COLLECTOR });
    expect(on.map((row) => row.id)).toContain("rbac");
  });

  test("packed ranking evidence is ineligible and search matches searchDetailed", async () => {
    const e = await compiledEngine(nistDocs, nistFamily);
    const query = e._prepareQuery("national");
    expect(query.configuredPrefixRecall?.key).toBe("nist");
    expect(rankingEvidenceEligibilityReason(query, rankingEvidenceStaticFor(e._index))).toBe("configured-prefix-recall");
    const two = e._prepareQuery("national in");
    expect(stage3AUnsupportedReason(query)).toBe("token-count");
    expect(stage3AUnsupportedReason(two)).toBe("configured-prefix-recall");
    expect(
      packedSearchFallbackReason({
        exactDiagnostics: false,
        pruningMode: "auto",
        retrievalScoreWeight: 0,
        sourcePolicy: "top1-strong",
        retriever: e.retriever,
        opts: {},
        query,
        index: e._index,
      })
    ).toBe("configured-prefix-recall");
    const search = e.search("national", { limit: 10, relatedLimit: 0 });
    const detailed = e.searchDetailed("national", { limit: 10, relatedLimit: 0 }).results;
    expect(e.lastSearchMeta.rankingEvidence).not.toBe("packed");
    expect(search.map((row) => row.id)).toEqual(detailed.map((row) => row.id));
    expect(search.map((row) => row.score)).toEqual(detailed.map((row) => row.score));
    expect(search.map((row) => row.directClass)).toEqual(detailed.map((row) => row.directClass));
    expect(tlsHit(search)).toBeTruthy();
  });

  test("indexed retrieval keeps exact key lemma identity without prefix-walking the key", async () => {
    const docs = [
      { id: "lemma-key", title: "React Data Fetching", body: "oops without the typed prefix tokens" },
      { id: "surface-key", title: "OOP Notes", body: "oop mentioned once" },
      { id: "prefix-surface", title: "Prefix Only", body: "oopsservice vendor class" },
    ];
    const compiledPlugins = [
      morphology({ lemmas: { oops: "oop" } }),
      compileConfiguredConceptPlugin({ configuredConcepts: [{ key: "oop", aliases: [["object", "oriented", "programming"]] }] }),
    ];
    const lexicalIndex = compileLexicalIndex(docs, { schema, plugins: compiledPlugins });
    const e = SearchEngine.create({
      schema,
      plugins: compiledPlugins,
      lexicalIndex,
      retriever: "indexed",
      relationshipStrategy: "none",
    });
    await e.index(docs);
    const query = e._prepareQuery("object");
    expect(query.configuredPrefixRecall?.key).toBe("oop");
    const hits = e.retriever.retrieve(query, e._index).map((hit) => hit.document.id).sort();
    expect(hits).toEqual(expect.arrayContaining(["lemma-key", "surface-key"]));
    expect(hits).not.toContain("prefix-surface");
    const detailed = e.searchDetailed("object", { limit: 10, relatedLimit: 0, explain: true });
    expect(detailed.results.map((row) => row.id)).toEqual(expect.arrayContaining(["lemma-key", "surface-key"]));
    expect(detailed.results.find((row) => row.id === "lemma-key").retrievalSources).toEqual(["configured-prefix-recall"]);
  });

  test("Worker loopback matches in-process TLS recall", async () => {
    const runtime = createWorkerRuntime({
      SearchEngine,
      english: morphology,
      compileAuthoredRelevance,
    });
    const published = [];
    let notify;
    let got = new Promise((resolve) => {
      notify = resolve;
    });
    const client = createSearchClient({
      worker: createLoopbackTransport(runtime),
      onResult({ result }) {
        published.push(result);
        notify();
      },
      onError({ error }) {
        notify({ __error: error });
      },
    });
    await client.init({
      documents: nistDocs,
      schema,
      configuredConcepts: nistFamily,
      retriever: "full-scan",
      relationshipStrategy: "none",
    });
    client.setQuery("national", { limit: 10, relatedLimit: 0 });
    const payload = await got;
    client.terminate();
    if (payload?.__error) throw new Error(String(payload.__error?.message || payload.__error));
    const titles = published[0]?.results?.map((row) => row.title) || [];
    expect(titles).toContain("TLS 1.2 Vulnerability");
    expect(titles[0]).toBe("Information Asymmetry");
  });
});

describe("Software.Land frozen contracts after prefix recall", () => {
  let sl;

  beforeAll(async () => {
    const inputs = slInputs;
    sl = SearchEngine.create({
      schema: inputs.schema,
      plugins: [morphology({ lemmas: inputs.lemmas }), compileConfiguredConceptPlugin({ configuredConcepts: inputs.configuredConcepts })],
      documentRelationships: inputs.relationships,
    });
    await sl.index(inputs.documents);
  });

  test("integ remains Integrity Is Not Obedience #1 without first-token occupancy", () => {
    const q = sl._prepareQuery("integ");
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.configuredPrefixRecall).toMatchObject({
      key: "ide",
      exactCount: 0,
      formLength: 3,
      lastExact: false,
    });
    expect(q.configuredPrefixRecall.coverage).toBe(Number(((5 / 10) / 3).toFixed(4)));
    expect(sl.search("integ", { limit: 10, relatedLimit: 0 })[0].title).toBe("Integrity Is Not Obedience");
  });

  test("watchlist queries keep fail-closed or unique-recall contracts", () => {
    expect(sl._prepareQuery("hypertext").configuredPrefixRecall).toBeNull();
    expect(sl._prepareQuery("hypertex").configuredPrefixRecall).toBeNull();
    expect(sl._prepareQuery("hypertex").configuredSequenceIntent).toBeNull();
    expect(sl._prepareQuery("real").configuredPrefixRecall).toBeNull();
    expect(sl._prepareQuery("software").configuredPrefixRecall).toBeNull();
    expect(sl._prepareQuery("identity and").configuredSequenceIntent).toBeNull();
    expect(sl._prepareQuery("identity and").configuredPrefixRecall?.key).toBe("iam");
    expect(sl._prepareQuery("software a").configuredPrefixRecall?.key).toBe("saas");
    expect(sl._prepareQuery("software as").configuredSequenceIntent).toBeNull();
    expect(sl._prepareQuery("software as").configuredPrefixRecall?.key).toBe("saas");
    expect(sl._prepareQuery("basically available").configuredSequenceIntent).toBeNull();
    expect(sl._prepareQuery("basically available").configuredPrefixRecall?.key).toBe("base");
    expect(sl._prepareQuery("national institute").configuredSequenceIntent?.key).toBe("nist");
    expect(sl._prepareQuery("create read").configuredSequenceIntent?.key).toBe("crud");
    expect(sl._prepareQuery("conflict free").configuredPrefixRecall?.key).toBe("crdt");
    expect(sl.search("national", { limit: 50, relatedLimit: 0 }).some((row) => row.title === "TLS 1.2 Vulnerability")).toBe(
      true
    );
  });

  test("national in keeps TLS in the public top 10 on the real fixture", () => {
    const ranks = [];
    for (const raw of ["national", "national i", "national in", "national ins", "national inst"]) {
      const q = sl._prepareQuery(raw);
      expect(q.configuredSequenceIntent).toBeNull();
      expect(q.configuredPrefixRecall?.key).toBe("nist");
      const results = sl.search(raw, { limit: 10, relatedLimit: 0 });
      const tls = results.find((row) => row.title === "TLS 1.2 Vulnerability");
      expect(tls).toBeTruthy();
      ranks.push(tls.rank);
    }
    expect(sl.search("national institute", { limit: 10, relatedLimit: 0 })[0].title).toBe("TLS 1.2 Vulnerability");
    expect(ranks[2]).toBeLessThanOrEqual(ranks[1]);
  });
});

describe("configured-prefix recall relationship overlay", () => {
  const dict = [{ key: "nist", aliases: [["national", "institute", "standards", "technology"]] }];
  const docs = [
    { id: "A", title: "National Notes", body: "national news without the key" },
    { id: "B", title: "TLS Advisory", body: "nist appears only as the key" },
    { id: "C", title: "Unrelated", body: "nothing relevant here" },
  ];
  const graph = {
    format: ARTIFACT_FORMATS.relationships,
    version: ARTIFACT_VERSION,
    relationships: {
      A: [{ target: "B", type: "semantic", strength: 0.9, provenance: "test" }],
    },
  };

  async function overlayEngine(strategy) {
    const e = SearchEngine.create({
      schema,
      plugins: plugins(dict),
      documentRelationships: graph,
      relationshipStrategy: strategy,
    });
    await e.index(docs);
    return e;
  }

  test("prefix-recall stays direct when a relationship is also present", async () => {
    const e = await overlayEngine("hybrid");
    const detailed = e.searchDetailed("national", { limit: 10, relatedLimit: 5, explain: true });
    const b = detailed.results.find((row) => row.id === "B");
    expect(b).toBeTruthy();
    expect(b.retrievalSources).toEqual(expect.arrayContaining(["configured-prefix-recall", "relationship"]));
    expect(b.directClass).toBe("none");
    expect(b.relevanceKind).toBe("direct");
    expect(b.features.configuredPrefixRecallScore).toBe(0.25);
    expect(detailed.related.some((row) => row.id === "B")).toBe(false);
  });

  test("separate keeps an independently recalled hit in primary results", async () => {
    const e = await overlayEngine("separate");
    const detailed = e.searchDetailed("national", { limit: 10, relatedLimit: 5, explain: true });
    expect(detailed.results.map((row) => row.id)).toContain("B");
    expect(detailed.related.map((row) => row.id)).not.toContain("B");
    const b = detailed.results.find((row) => row.id === "B");
    expect(b.relevanceKind).toBe("direct");
    expect(b.retrievalSources).toEqual(expect.arrayContaining(["configured-prefix-recall", "relationship"]));
  });

  test("pure relationship neighbors remain related", async () => {
    const e = await overlayEngine("separate");
    const detailed = e.searchDetailed("national notes", { limit: 10, relatedLimit: 5, explain: true });
    const neighbor = detailed.related.find((row) => row.id === "B");
    expect(neighbor).toBeTruthy();
    expect(neighbor.retrievalSources).toEqual(["relationship"]);
    expect(neighbor.relevanceKind).toBe("related");
    expect(neighbor.directClass).toBe("none");
    expect(detailed.results.map((row) => row.id)).not.toContain("B");
  });

  test("none leaves prefix-recall direct without relationship overlay", async () => {
    const e = await overlayEngine("none");
    const detailed = e.searchDetailed("national", { limit: 10, relatedLimit: 5, explain: true });
    const b = detailed.results.find((row) => row.id === "B");
    expect(b.retrievalSources).toEqual(["configured-prefix-recall"]);
    expect(b.relevanceKind).toBe("direct");
    expect(b.relationship).toBeFalsy();
    expect(detailed.related).toEqual([]);
  });
});
