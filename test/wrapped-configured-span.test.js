import { SearchEngine, morphology, dictionary } from "../dist/index.js";
import { analyzeQuery } from "../dist/analyze.js";
import { retrieveCandidates } from "../dist/retrieve.js";
import { resolveConfiguredSequence, resolveConfiguredSpans } from "../dist/configuredSequence.js";
import { stage3AUnsupportedReason } from "../dist/exactBlockSkip.js";
import { dictionaryFromLegacy } from "./helpers/authored.js";

const dict = [
  {
    key: "appsec",
    aliases: [["application", "security"], ["app", "sec"],
      ["application", "security"],
      ["security"],],
    topicalRecall: [
      ["authentication"],
      ["authorization"],
      ["bearer", "token"],
      ["oauth"],
    ],
  },
  {
    key: "oauth",
    aliases: [["open", "authorization"]], topicalRecall: [["openid"], ["redirect"]],
  },
  { key: "http", aliases: [["hypertext", "transfer", "protocol"]], standaloneRecall: ["hypertext"] },
  { key: "tls", aliases: [["transport", "layer", "security"]]},
  { key: "ml", aliases: [["machine", "learning"]]},
  { key: "fps", aliases: [["frames", "per", "second"]]},
  { key: "ab", aliases: [["alpha", "bravo"]]},
  { key: "bc", aliases: [["bravo", "charlie"]]},
  { key: "graphql", aliases: [["graph", "query", "language"]]},
  { key: "gql", aliases: [["graph", "query", "language"]]},
];

const docs = [
  { id: "direct", title: "Application Security", body: "application security overview" },
  { id: "authn", title: "Login Flow", body: "password authentication cookies" },
  { id: "authz", title: "Permission Gate", body: "authorization checks on routes" },
  { id: "phrase", title: "Token Primer", body: "send a bearer token header" },
  { id: "oauth-doc", title: "OAuth Dance", body: "oauth authorization code" },
  { id: "openid-only", title: "Connect Notes", body: "openid connect login notes" },
  { id: "http-body", title: "Request Notes", body: "http methods and status codes" },
  { id: "ml-doc", title: "Model Notes", body: "machine learning models" },
  { id: "unrelated", title: "Unrelated", body: "gardening tips" },
];

function plugins(entries = dict) {
  return [morphology(), dictionary(dictionaryFromLegacy(entries))];
}

async function engine(retriever) {
  const e = SearchEngine.create({
    schema: {
      title: { type: "text", role: "title" },
      body: { type: "text", role: "body" },
    },
    plugins: plugins(),
    ...(retriever ? { retriever } : {}),
  });
  await e.index(docs);
  return e;
}

describe("exact configured spans", () => {
  test("exact alias and expansion windows collapse same-key duplicate forms", () => {
    const alias = analyzeQuery("what is an app sec", { plugins: plugins() });
    expect(resolveConfiguredSpans(alias.tokens, plugins()[1])).toEqual([
      { key: "appsec", start: 3, end: 5, matchedKinds: ["alias"] },
    ]);
    const expansion = analyzeQuery("what is application security", { plugins: plugins() });
    const spans = resolveConfiguredSpans(expansion.tokens, plugins()[1]);
    expect(spans).toEqual([{ key: "appsec", start: 2, end: 4, matchedKinds: ["expansion"] }]);
  });

  test("incomplete and prefix tokens do not create spans", () => {
    for (const raw of ["what is app s", "what is application secu", "what is machine l", "what is frames per s", "what is hypertext t"]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      expect(q.configuredSpans.filter((s) => ["appsec", "ml", "http", "fps"].includes(s.key))).toEqual([]);
      expect(q.topicalRecall ?? null).toBeNull();
    }
  });

  test("whole-query prefix alignment still uses sequenceAligns, not exact spans", () => {
    const q = analyzeQuery("application secu", { plugins: plugins() });
    expect(resolveConfiguredSequence(q.tokens, plugins()[1]).status).toBe("unique");
    expect(q.configuredSequenceIntent?.key).toBe("appsec");
    expect(q.configuredSpans).toEqual([]);
    expect(q.topicalRecall?.key).toBe("appsec");
  });
});

describe("wrapped span topical activation", () => {
  test("stopword remainder activates topical recall without rewriting identity", () => {
    const withTopical = plugins();
    const withoutTopical = plugins(
      dict.map((entry) =>
        entry.key === "appsec" ? { ...entry, topicalRecall: [] } : entry
      )
    );
    for (const raw of ["what is an app sec", "what is app sec", "what is application security"]) {
      const q = analyzeQuery(raw, { plugins: withTopical });
      const baseline = analyzeQuery(raw, { plugins: withoutTopical });
      expect(q.configuredSequenceIntent).toBeNull();
      expect(q.configuredSpans.length).toBe(1);
      expect(q.configuredSpans[0].key).toBe("appsec");
      expect(q.topicalRecall).toEqual({
        key: "appsec",
        forms: [["authentication"], ["authorization"], ["bearer", "token"], ["oauth"]],
      });
      expect(q.tokens.map((t) => t.surface)).toEqual(baseline.tokens.map((t) => t.surface));
      expect(q.tokens.map((t) => t.normalized)).toEqual(baseline.tokens.map((t) => t.normalized));
      expect(q.lexicalTokens.map((t) => t.normalized)).toEqual(baseline.lexicalTokens.map((t) => t.normalized));
      expect(q.lexicalPhraseKey).toBe(baseline.lexicalPhraseKey);
      expect(q.configuredSequenceIntent).toEqual(baseline.configuredSequenceIntent);
      expect(q.standaloneRecall ?? null).toBeNull();
      expect(stage3AUnsupportedReason(q)).toBe("topical-recall");
    }
  });

  test("whole-query configured intent remains the topical source", () => {
    for (const raw of ["appsec", "app sec", "application security"]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      expect(q.configuredSequenceIntent?.key).toBe("appsec");
      expect(q.topicalRecall?.key).toBe("appsec");
    }
  });

  test("non-stop remainders do not activate topical recall", () => {
    for (const raw of [
      "explain app sec",
      "learn app sec",
      "app sec tutorial",
      "basics of application security",
      "compare app sec with network security",
      "not app sec",
      "app sec is bad",
      "application security and performance",
      "application security vs authentication",
    ]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      expect(q.configuredSequenceIntent).toBeNull();
      expect(q.topicalRecall ?? null).toBeNull();
      expect(q.configuredSpans.some((s) => s.key === "appsec")).toBe(true);
    }
  });

  test("multiple distinct keys fail closed even with stop remainders", () => {
    for (const raw of [
      "app sec oauth",
      "what is app sec oauth",
      "what is alpha bravo charlie",
      "what is graph query language",
    ]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      expect(new Set(q.configuredSpans.map((s) => s.key)).size).toBeGreaterThan(1);
      expect(q.topicalRecall ?? null).toBeNull();
    }
  });

  test("overlapping distinct keys fail closed", () => {
    const q = analyzeQuery("alpha bravo charlie", { plugins: plugins() });
    expect(q.configuredSpans.map((s) => s.key).sort()).toEqual(["ab", "bc"]);
    expect(q.configuredSpans.some((s) => s.start === 0 && s.end === 2 && s.key === "ab")).toBe(true);
    expect(q.configuredSpans.some((s) => s.start === 1 && s.end === 3 && s.key === "bc")).toBe(true);
    expect(q.topicalRecall ?? null).toBeNull();
  });

  test("single-expansion-word aliases do not become appsec spans", () => {
    for (const raw of ["security", "what is security", "application", "app", "sec", "authentication", "authorization"]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      expect(q.configuredSpans.some((s) => s.key === "appsec")).toBe(false);
      if (raw !== "security") {
        expect(q.configuredSequenceIntent?.key ?? null).not.toBe("appsec");
        expect(q.topicalRecall?.key ?? null).not.toBe("appsec");
      }
    }
    const exact = analyzeQuery("security", { plugins: plugins() });
    expect(exact.configuredSequenceIntent?.key).toBe("appsec");
    expect(exact.configuredSpans).toEqual([]);
  });

  test("topical forms do not reverse-activate appsec", () => {
    for (const raw of ["what is authentication", "authentication"]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      expect(q.topicalRecall?.key ?? null).not.toBe("appsec");
    }
  });

  test("standalone recall stays exact one-token whole-query", () => {
    const hyper = analyzeQuery("hypertext", { plugins: plugins() });
    expect(hyper.standaloneRecall).toMatchObject({ key: "http", sourceToken: "hypertext" });
    expect(hyper.topicalRecall ?? null).toBeNull();
    for (const raw of ["what is hypertext", "explain hypertext", "hypertext guide"]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      expect(q.standaloneRecall ?? null).toBeNull();
      expect(q.topicalRecall ?? null).toBeNull();
    }
  });
});

describe("wrapped span retrieval", () => {
  test("reuses topical-recall provenance and keeps literal identity", async () => {
    const e = await engine();
    const q = e._prepareQuery("what is an app sec");
    expect(q.configuredSequenceIntent).toBeNull();
    expect(q.tokens.map((t) => t.surface)).toEqual(["what", "is", "an", "app", "sec"]);
    expect(q.lexicalPhraseKey).toBe("app sec");
    const hits = retrieveCandidates(q, e._index);
    const ids = hits.map((h) => h.document.id).sort();
    expect(ids).toEqual(["authn", "authz", "direct", "oauth-doc", "phrase"]);
    expect(ids).not.toContain("openid-only");
    expect(hits.find((h) => h.document.id === "authn").retrievalSources).toContain("topical-recall");
    const detailed = e.searchDetailed("what is an app sec", { limit: 10, explain: true });
    expect(detailed.results[0].explanation.query.configuredSequenceIntent).toBeNull();
    expect(detailed.results[0].explanation.query.configuredSpans).toEqual([
      { key: "appsec", start: 3, end: 5, matchedKinds: ["alias"] },
    ]);
    expect(detailed.results[0].explanation.query.topicalRecall.key).toBe("appsec");
    expect(detailed.results[0].explanation.query.tokens.map((t) => t.surface)).toEqual(["what", "is", "an", "app", "sec"]);
    expect(e.search("what is an app sec").map((row) => row.id)).toEqual(detailed.results.map((row) => row.id));
  });

  test("does not recursively activate oauth topical from an appsec form", async () => {
    const e = await engine();
    const hits = retrieveCandidates(e._prepareQuery("what is an app sec"), e._index);
    expect(hits.some((h) => h.document.id === "oauth-doc")).toBe(true);
    expect(hits.some((h) => h.document.id === "openid-only")).toBe(false);
  });

  test("indexed and full-scan agree", async () => {
    const full = await engine("full-scan");
    const indexed = await engine("indexed");
    expect(indexed.search("what is an app sec").map((row) => row.id)).toEqual(
      full.search("what is an app sec").map((row) => row.id)
    );
    expect(indexed.search("app sec").map((row) => row.id)).toEqual(full.search("app sec").map((row) => row.id));
  });

  test("multi-key queries do not fan out topical recall", async () => {
    const e = await engine();
    const q = e._prepareQuery("app sec oauth");
    expect(q.topicalRecall ?? null).toBeNull();
    const hits = retrieveCandidates(q, e._index);
    expect(hits.every((h) => !(h.retrievalSources || []).includes("topical-recall"))).toBe(true);
  });
});
