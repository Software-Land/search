/**
 * Optional summary field, exact phrase field provenance, and QueryPlan facts.
 * Result-set collapse is not QueryPlan policy.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { extractFeatures } from "../dist/features/features.js";
import { typedSurfacePhraseTokens } from "../dist/query/phraseEvidence.js";
import { executePhraseQuery } from "../dist/retrieval/positionalQueries.js";
import { buildQueryPlan, hasStructuredInterpretation, titleGradeSupportKinds } from "../dist/query/queryPlan.js";
import { collectCompleteInterpretations, COMPLETE_INTERPRETATION_COLLECTOR } from "../dist/completeInterpretationCollector.js";
import { querySemanticFacts } from "../dist/query/querySemantics.js";
import { rankCandidates } from "../dist/ranking/rank.js";
import { constraintsForStrategy } from "../dist/ranking/constraints.js";
import { retrievalSourcesForDocument } from "../dist/retrieval/retrieve.js";

const schema = {
  title: { type: "text", role: "title" },
  summary: { type: "text", role: "summary" },
  body: { type: "text", role: "body" },
};

const docs = [
  {
    id: "cloudfront",
    title: "CloudFront Signed Cookies",
    summary: "Use two-layer authorization at the edge.",
    body: "CDN cookies and cache behavior.",
  },
  {
    id: "auth-mw",
    title: "Authorization Middleware",
    summary: "Request guards.",
    body: "Checks a bearer token.",
  },
  {
    id: "build",
    title: "Build Time",
    summary: "Compile notes.",
    body: "A remote procedure call happens during compile.",
  },
  {
    id: "grpc",
    title: "gRPC vs REST",
    summary: "An RPC framework.",
    body: "Uses HTTP/2 streams.",
  },
  {
    id: "xss-react",
    title: "React Authentication",
    summary: "Login in the SPA.",
    body: "Session cookies in React.",
  },
  {
    id: "xss-bearer",
    title: "Bearer Token",
    summary: "Header credentials.",
    body: "Watch for cross site scripting in tokens.",
  },
  {
    id: "tls",
    title: "TLS 1.2 Vulnerability",
    summary: "Transport security.",
    body: "Also called hypertext transfer protocol secure.",
  },
  {
    id: "prose",
    title: "Process vs Thread",
    summary: "Scheduling.",
    body: "in many programming languages a series of a entire browser process management",
  },
];

function createEngine(relationshipMap) {
  const compiled = compileAuthoredRelevance({
    configuredConcepts: [
      { key: "rpc", aliases: [["remote", "procedure", "call"]] },
      { key: "xss", aliases: [["cross", "site", "scripting"]] },
      { key: "https", aliases: [["hypertext", "transfer", "protocol", "secure"]] },
      { key: "tls", aliases: [["transport", "layer", "security"]] },
    ],
    relationshipMap,
  });
  return SearchEngine.create({
    schema,
    plugins: [morphology(), ...compiled.plugins],
    relationshipStrategy: "hybrid",
    retriever: "full-scan",
  });
}

function phraseHits(engine, raw) {
  const tokens = typedSurfacePhraseTokens(engine._prepareQuery(raw));
  if (tokens.length < 2) return [];
  return executePhraseQuery({ kind: "phrase", tokens }, engine._index);
}

describe("optional summary field", () => {
  test("title/body-only schema ignores a summary property", async () => {
    const engine = SearchEngine.create({
      schema: { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } },
    });
    await engine.index([
      {
        id: "a",
        title: "Other",
        summary: "two-layer authorization",
        body: "unrelated body",
      },
    ]);
    const found = phraseHits(engine, "two-layer authorization");
    expect(found).toEqual([]);
    expect(engine._index.documents[0].summary).toBe("");
  });

  test("summary role indexes the third field without copying it into body", async () => {
    const engine = SearchEngine.create({ schema });
    await engine.index([docs[0]]);
    const doc = engine._index.documents[0];
    expect(doc.summary).toContain("two-layer");
    expect(doc.body).not.toContain("two-layer");
    expect(doc.title).not.toContain("two-layer");
  });

  test("indexed retriever hydrates summary phrase field identity", async () => {
    const engine = SearchEngine.create({ schema, retriever: "indexed" });
    await engine.index([docs[0]]);
    const found = phraseHits(engine, "two-layer authorization");
    expect(engine._index.schema.summaryField).toBe("summary");
    expect(found).toHaveLength(1);
    expect(found[0].summaryFrequency).toBe(1);
    expect(found[0].titleFrequency).toBe(0);
    expect(found[0].bodyFrequency).toBe(0);
  });
});

describe("exact phrase field evidence", () => {
  let engine;

  beforeAll(async () => {
    engine = createEngine({
      rpc: [{ kind: "equivalent", to: { form: "grpc" } }],
      https: [{ kind: "equivalent", to: { form: "tls" } }],
      xss: [{ kind: "related", to: { form: ["react", "authentication"] } }],
    });
    await engine.index(docs);
  });

  test("one-token queries have no phrase evidence", () => {
    expect(phraseHits(engine, "rpc")).toEqual([]);
  });

  test("per-field tf distinguishes title, summary, and body", () => {
    const summaryHits = phraseHits(engine, "two-layer authorization");
    expect(summaryHits).toHaveLength(1);
    expect(summaryHits[0].document.id).toBe("cloudfront");
    expect(summaryHits[0].titleFrequency).toBe(0);
    expect(summaryHits[0].summaryFrequency).toBe(1);
    expect(summaryHits[0].bodyFrequency).toBe(0);

    const titleHits = phraseHits(engine, "grpc vs rest");
    const titleHit = titleHits.find((hit) => hit.document.id === "grpc");
    expect(titleHit.titleFrequency).toBe(1);
    expect(titleHit.summaryFrequency).toBe(0);

    const bodyHits = phraseHits(engine, "remote procedure call");
    expect(bodyHits).toHaveLength(1);
    expect(bodyHits[0].document.id).toBe("build");
    expect(bodyHits[0].bodyFrequency).toBe(1);
    expect(bodyHits[0].titleFrequency).toBe(0);
    expect(bodyHits[0].summaryFrequency).toBe(0);
  });
});

describe("query-plan facts", () => {
  let engine;

  beforeAll(async () => {
    engine = createEngine({
      rpc: [{ kind: "equivalent", to: { form: "grpc" } }],
      https: [{ kind: "equivalent", to: { form: "tls" } }],
      xss: [{ kind: "related", to: { form: ["react", "authentication"] } }],
    });
    await engine.index(docs);
  });

  test("query plan records independent clauses without result policy", () => {
    const plan = buildQueryPlan(engine._prepareQuery("remote procedure call"), engine._index);
    expect(plan.clauses.lexical).toBe(true);
    expect(plan.clauses.exactPhrase).toBe(true);
    expect(plan.clauses.structuredIntent).toBe(true);
    expect(plan.clauses.equivalentRecall).toBe(true);
    expect(plan.clauses.versionIntent).toBe(false);
    expect("filterToPhraseCohort" in plan).toBe(false);
    expect("phraseIds" in plan).toBe(false);
    expect("filterReason" in plan).toBe(false);
  });

  test("occupancy and version are facts, not filter permission", () => {
    const rpc = buildQueryPlan(engine._prepareQuery("remote procedure call"), engine._index);
    expect(rpc.structuredKey).toBe("rpc");
    expect(rpc.versionIntent).toBe(false);
    const tls = buildQueryPlan(engine._prepareQuery("tls 1.2"), engine._index);
    expect(tls.versionIntent).toBe(true);
  });

  test("support kinds are title-grade only", () => {
    const query = engine._prepareQuery("remote procedure call");
    const grpc = engine._index.documents.find((doc) => doc.id === "grpc");
    const build = engine._index.documents.find((doc) => doc.id === "build");
    expect(titleGradeSupportKinds(extractFeatures(query, grpc))).toContain("equivalent-recall-title");
    expect(titleGradeSupportKinds(extractFeatures(query, build))).toEqual([]);
  });

  test("collector declines occupancy and version from plan facts", () => {
    const rpc = buildQueryPlan(engine._prepareQuery("remote procedure call"), engine._index);
    expect(
      collectCompleteInterpretations({
        occupancy: Boolean(rpc.structuredKey),
        version: rpc.versionIntent,
        exactHits: rpc.exactHits,
        prefixHits: rpc.prefixHits,
      }).reason
    ).toBe("occupancy");
    const tls = buildQueryPlan(engine._prepareQuery("tls 1.2"), engine._index);
    expect(
      collectCompleteInterpretations({
        occupancy: Boolean(tls.structuredKey),
        version: tls.versionIntent,
        exactHits: tls.exactHits,
        prefixHits: tls.prefixHits,
      }).reason
    ).toBe("version");
  });

  test("content identity fills plan identity without occupancy", () => {
    const query = engine._prepareQuery("what is rpc");
    const facts = querySemanticFacts(query);
    const plan = buildQueryPlan(query, engine._index);
    expect(facts.configured.occupiedKey).toBeNull();
    expect(facts.configured.contentIdentityKey).toBe("rpc");
    expect(facts.configured.hasRankingIdentity).toBe(true);
    expect(plan.structuredKey).toBeNull();
    expect(plan.configuredContentIdentity).toBe("rpc");
    expect(plan.clauses.structuredIntent).toBe(false);
    expect(
      collectCompleteInterpretations({
        occupancy: Boolean(plan.structuredKey),
        configuredContentIdentity: Boolean(plan.configuredContentIdentity),
        version: plan.versionIntent,
        exactHits: plan.exactHits,
        prefixHits: plan.prefixHits,
      }).reason
    ).toBe("configured-content-identity");
  });

  test("prefixEvidence is not vocabularyPrefix", () => {
    const query = engine._prepareQuery("rpc");
    const ambiguous = {
      ...query,
      prefixCompletion: {
        activePrefix: "lear",
        completedToken: null,
        canonicalToken: null,
        completedTokens: ["learn", "learning"],
        canonicalTokens: ["learn"],
        source: "final-token-prefix",
        ambiguous: true,
      },
      configuredPrefixSpans: [],
    };
    expect(querySemanticFacts(ambiguous).completion.vocabularyPrefix).toBe(false);
    expect(buildQueryPlan(ambiguous, engine._index).clauses.prefixEvidence).toBe(true);

    const spansOnly = {
      ...query,
      prefixCompletion: null,
      configuredSequenceIntent: null,
      configuredPrefixSpans: [
        { key: "rpc", start: 0, end: 1, matchedKinds: ["key"], usedPrefix: true },
      ],
    };
    expect(querySemanticFacts(spansOnly).completion.vocabularyPrefix).toBe(false);
    expect(querySemanticFacts(spansOnly).configured.occupiedKey).toBeNull();
    expect(hasStructuredInterpretation(spansOnly)).toBe(true);
    expect(buildQueryPlan(spansOnly, engine._index).clauses.prefixEvidence).toBe(true);
  });

  test("topical and equivalent plan clauses follow relatedRecall facts", () => {
    const equivalent = buildQueryPlan(engine._prepareQuery("remote procedure call"), engine._index);
    expect(querySemanticFacts(engine._prepareQuery("remote procedure call")).relatedRecall.equivalent).toBe(true);
    expect(equivalent.clauses.equivalentRecall).toBe(true);

    const withTopical = {
      ...engine._prepareQuery("rpc"),
      topicalRecall: { key: "rpc", forms: [["grpc"]] },
    };
    expect(querySemanticFacts(withTopical).relatedRecall.topical).toBe(true);
    expect(buildQueryPlan(withTopical, engine._index).clauses.topicalRecall).toBe(true);

    const emptyForms = {
      ...engine._prepareQuery("rpc"),
      topicalRecall: { key: "rpc", forms: [] },
    };
    expect(querySemanticFacts(emptyForms).relatedRecall.topical).toBe(false);
    expect(buildQueryPlan(emptyForms, engine._index).clauses.topicalRecall).toBe(false);
  });
});

describe("phrase ranking vs result-set policy", () => {
  let engine;

  beforeAll(async () => {
    engine = createEngine({
      rpc: [{ kind: "equivalent", to: { form: "grpc" } }],
      https: [{ kind: "equivalent", to: { form: "tls" } }],
      xss: [{ kind: "related", to: { form: ["react", "authentication"] } }],
    });
    await engine.index(docs);
  });

  test("summary exact phrase beats incidental one-token title overlap", () => {
    const titles = engine.search("two-layer authorization", { limit: 5 }).map((hit) => hit.title);
    expect(titles[0]).toBe("CloudFront Signed Cookies");
    expect(titles.length).toBeGreaterThan(1);
    const query = engine._prepareQuery("two layer authorization");
    const featured = engine._index.documents.map((document) => ({
      document,
      retrievalSources: retrievalSourcesForDocument(query, document),
      features: extractFeatures(query, document),
    }));
    const ranked = rankCandidates(featured, { constraints: constraintsForStrategy("hybrid") });
    expect(ranked[0].document.id).toBe("cloudfront");
    const auth = ranked.find((hit) => hit.document.id === "auth-mw");
    expect(extractFeatures(query, auth.document).exactTitleTokenMatch).toBe(true);
    expect(extractFeatures(query, ranked[0].document).exactTitleOrSummaryPhrase).toBe(true);
  });

  test("hyphen and case variants of the summary phrase match", () => {
    for (const q of ["two-layer authorization", "two layer authorization", "TWO-LAYER AUTHORIZATION"]) {
      expect(engine.search(q, { limit: 3 }).map((hit) => hit.title)[0]).toBe("CloudFront Signed Cookies");
    }
  });

  test("default search does not collapse occupancy phrase mentions", () => {
    const titles = engine.search("remote procedure call", { limit: 5 }).map((hit) => hit.title);
    expect(titles.length).toBeGreaterThan(1);
    expect(titles).toContain("gRPC vs REST");
    expect(titles).toContain("Build Time");
    const collectorOn = engine.search("remote procedure call", {
      limit: 5,
      resultCollector: COMPLETE_INTERPRETATION_COLLECTOR,
    }).map((hit) => hit.title);
    expect(collectorOn).toEqual(titles);
  });

  test("occupied markdown mention does not collapse XSS", () => {
    const titles = engine.search("cross site scripting", { limit: 5 }).map((hit) => hit.title);
    expect(titles.length).toBeGreaterThan(1);
    expect(titles).toContain("React Authentication");
    expect(titles).toContain("Bearer Token");
  });
});
