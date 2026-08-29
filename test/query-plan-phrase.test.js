/**
 * Optional summary field, exact phrase field provenance, and query-plan
 * result-set permission. Token count is not a relevance policy.
 */
import { SearchEngine, morphology, compileAuthoredRelevance } from "../dist/index.js";
import { extractFeatures } from "../dist/features.js";
import { computeExactPhraseEvidence } from "../dist/phraseEvidence.js";
import { exclusivePhraseDocuments } from "../dist/phraseExclusivity.js";
import {
  buildQueryPlan,
  MAX_EXCLUSIVE_PHRASE_COHORT,
  phraseCohortFilterPermission,
  titleGradeSupportKinds,
} from "../dist/queryPlan.js";
import { rankCandidates } from "../dist/rank.js";
import { constraintsForStrategy } from "../dist/constraints.js";
import { retrievalSourcesForDocument } from "../dist/retrieve.js";

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
    const ev = computeExactPhraseEvidence(engine._prepareQuery("two-layer authorization"), engine._index);
    expect(ev.phraseDf).toBe(0);
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
    const ev = computeExactPhraseEvidence(engine._prepareQuery("two-layer authorization"), engine._index);
    expect(engine._index.schema.summaryField).toBe("summary");
    expect(ev.phraseDf).toBe(1);
    expect(ev.hits[0].summaryFrequency).toBe(1);
    expect(ev.hits[0].titleFrequency).toBe(0);
    expect(ev.hits[0].bodyFrequency).toBe(0);
  });
});

describe("exact phrase field evidence", () => {
  let engine;

  beforeAll(async () => {
    engine = createEngine({
      rpc: [{ kind: "equivalent", to: { form: "grpc" } }],
      // Synthetic equivalent support for the supportSet ⊆ P predicate only.
      // Not Software.Land authored data: HTTPS is not equivalent to TLS.
      https: [{ kind: "equivalent", to: { form: "tls" } }],
      xss: [{ kind: "related", to: { form: ["react", "authentication"] } }],
    });
    await engine.index(docs);
  });

  test("one-token queries have no phrase evidence", () => {
    expect(computeExactPhraseEvidence(engine._prepareQuery("rpc"), engine._index)).toBeNull();
  });

  test("per-field tf distinguishes title, summary, and body", () => {
    const summaryEv = computeExactPhraseEvidence(engine._prepareQuery("two-layer authorization"), engine._index);
    expect(summaryEv.phraseDf).toBe(1);
    expect(summaryEv.hits[0].document.id).toBe("cloudfront");
    expect(summaryEv.hits[0].titleFrequency).toBe(0);
    expect(summaryEv.hits[0].summaryFrequency).toBe(1);
    expect(summaryEv.hits[0].bodyFrequency).toBe(0);

    const titleEv = computeExactPhraseEvidence(engine._prepareQuery("grpc vs rest"), engine._index);
    const titleHit = titleEv.hits.find((hit) => hit.document.id === "grpc");
    expect(titleHit.titleFrequency).toBe(1);
    expect(titleHit.summaryFrequency).toBe(0);

    const bodyEv = computeExactPhraseEvidence(engine._prepareQuery("remote procedure call"), engine._index);
    expect(bodyEv.phraseDf).toBe(1);
    expect(bodyEv.hits[0].document.id).toBe("build");
    expect(bodyEv.hits[0].bodyFrequency).toBe(1);
    expect(bodyEv.hits[0].titleFrequency).toBe(0);
    expect(bodyEv.hits[0].summaryFrequency).toBe(0);
  });

  test("phrase cohort is independent of ordinary retrieval", () => {
    const query = engine._prepareQuery("two-layer authorization");
    const ev = computeExactPhraseEvidence(query, engine._index);
    expect(ev.hits.map((hit) => hit.document.id)).toEqual(["cloudfront"]);
    expect(ev.phraseDf).toBe(1);
  });
});

describe("query-plan clause agreement and filter permission", () => {
  let engine;

  beforeAll(async () => {
    engine = createEngine({
      rpc: [{ kind: "equivalent", to: { form: "grpc" } }],
      // Synthetic equivalent support for the supportSet ⊆ P predicate only.
      // Not Software.Land authored data: HTTPS is not equivalent to TLS.
      https: [{ kind: "equivalent", to: { form: "tls" } }],
      xss: [{ kind: "related", to: { form: ["react", "authentication"] } }],
    });
    await engine.index(docs);
  });

  test("query plan records independent clauses without a public DSL", () => {
    const plan = buildQueryPlan(engine._prepareQuery("remote procedure call"), engine._index);
    expect(plan.clauses.lexical).toBe(true);
    expect(plan.clauses.exactPhrase).toBe(true);
    expect(plan.clauses.structuredIntent).toBe(true);
    expect(plan.clauses.equivalentRecall).toBe(true);
    expect(plan.clauses.versionIntent).toBe(false);
    expect(plan.clauses.topicalRecall).toBe(false);
  });

  test("MAX_EXCLUSIVE_PHRASE_COHORT is a result-set bound of 2", () => {
    expect(MAX_EXCLUSIVE_PHRASE_COHORT).toBe(2);
  });

  test("supportSet ⊆ P allows filter", () => {
    const plan = buildQueryPlan(engine._prepareQuery("hypertext transfer protocol secure"), engine._index);
    expect(plan.supportIds).toContain("tls");
    expect(plan.phraseIds).toEqual(["tls"]);
    expect(plan.filterToPhraseCohort).toBe(true);
    expect(plan.filterReason).toBe("support-subset-of-rare-phrase");
  });

  test("support outside P forbids filter", () => {
    const plan = buildQueryPlan(engine._prepareQuery("remote procedure call"), engine._index);
    expect(plan.phraseIds).toEqual(["build"]);
    expect(plan.supportIds).toContain("grpc");
    expect(plan.filterToPhraseCohort).toBe(false);
    expect(plan.filterReason).toBe("support-outside-phrase-cohort");
    expect(exclusivePhraseDocuments(engine._prepareQuery("remote procedure call"), engine._index)).toBeNull();
  });

  test("empty support + title/summary phrase allows filter", () => {
    const plan = buildQueryPlan(engine._prepareQuery("two-layer authorization"), engine._index);
    expect(plan.supportIds).toEqual([]);
    expect(plan.filterToPhraseCohort).toBe(true);
    expect(plan.filterReason).toBe("unoccupied-title-or-summary-rare-phrase");
  });

  test("empty support + body-only phrase forbids filter", () => {
    const plan = buildQueryPlan(engine._prepareQuery("in many programming languages"), engine._index);
    expect(plan.filterToPhraseCohort).toBe(false);
    expect(plan.filterReason).toBe("body-only-phrase-without-support");
  });

  test("version intent forbids filter even with a title phrase", () => {
    const plan = buildQueryPlan(engine._prepareQuery("tls 1.2"), engine._index);
    expect(plan.versionIntent).toBe(true);
    expect(plan.filterToPhraseCohort).toBe(false);
    expect(plan.filterReason).toBe("version-clause-present");
    const permission = phraseCohortFilterPermission({
      versionIntent: true,
      phraseIds: ["tls"],
      supportIds: ["tls"],
      hits: plan.exactPhrase.hits,
    });
    expect(permission.filter).toBe(false);
  });

  test("support kinds are title-grade only, with distinct provenance", () => {
    const query = engine._prepareQuery("remote procedure call");
    const grpc = engine._index.documents.find((doc) => doc.id === "grpc");
    const build = engine._index.documents.find((doc) => doc.id === "build");
    expect(titleGradeSupportKinds(extractFeatures(query, grpc))).toContain("equivalent-recall-title");
    expect(titleGradeSupportKinds(extractFeatures(query, build))).toEqual([]);
    const plan = buildQueryPlan(query, engine._index);
    const grpcSupport = plan.support.find((row) => row.id === "grpc");
    expect(grpcSupport.provenance).toContain("equivalent");
    expect(grpcSupport.provenance).not.toContain("topical");
  });
});

describe("phrase ranking vs result-set policy", () => {
  let engine;

  beforeAll(async () => {
    engine = createEngine({
      rpc: [{ kind: "equivalent", to: { form: "grpc" } }],
      // Synthetic equivalent support for the supportSet ⊆ P predicate only.
      // Not Software.Land authored data: HTTPS is not equivalent to TLS.
      https: [{ kind: "equivalent", to: { form: "tls" } }],
      xss: [{ kind: "related", to: { form: ["react", "authentication"] } }],
    });
    await engine.index(docs);
  });

  test("summary exact phrase beats incidental one-token title overlap", () => {
    const titles = engine.search("two-layer authorization", { limit: 5 }).map((hit) => hit.title);
    expect(titles).toEqual(["CloudFront Signed Cookies"]);
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
      expect(engine.search(q, { limit: 3 }).map((hit) => hit.title)).toEqual(["CloudFront Signed Cookies"]);
    }
  });

  test("body-only phrase does not beat conflicting structured/equivalent support", () => {
    expect(exclusivePhraseDocuments(engine._prepareQuery("remote procedure call"), engine._index)).toBeNull();
    const titles = engine.search("remote procedure call", { limit: 5 }).map((hit) => hit.title);
    expect(titles.length).toBeGreaterThan(1);
    expect(titles).toContain("gRPC vs REST");
    expect(titles).toContain("Build Time");
  });

  test("occupied markdown mention does not exclusive-collapse XSS", () => {
    expect(exclusivePhraseDocuments(engine._prepareQuery("cross site scripting"), engine._index)).toBeNull();
    const titles = engine.search("cross site scripting", { limit: 5 }).map((hit) => hit.title);
    expect(titles.length).toBeGreaterThan(1);
    expect(titles).toContain("React Authentication");
    expect(titles).toContain("Bearer Token");
  });
});
