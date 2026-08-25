import { SearchEngine, morphology, dictionary } from "../dist/index.js";
import { analyzeQuery } from "../dist/analyze.js";
import { retrieveCandidates } from "../dist/retrieve.js";
import { dictionary as dictionaryPlugin, normalizeTopicalRecall } from "../dist/dictionary.js";
import { stage3AUnsupportedReason } from "../dist/exactBlockSkip.js";

const appsecDict = [
  {
    key: "appsec",
    expansion: ["application", "security"],
    aliases: [["app", "sec"]],
    topicalRecall: [
      ["authentication"],
      ["authorization"],
      ["bearer", "token"],
      ["oauth"],
    ],
  },
  {
    key: "oauth",
    expansion: ["open", "authorization"],
    topicalRecall: [["openid"], ["redirect"]],
  },
  { key: "http", expansion: ["hypertext", "transfer", "protocol"], standaloneRecall: ["hypertext"] },
];

const docs = [
  { id: "direct", title: "Application Security", body: "application security overview" },
  { id: "authn", title: "Login Flow", body: "password authentication cookies" },
  { id: "authz", title: "Permission Gate", body: "authorization checks on routes" },
  { id: "phrase", title: "Token Primer", body: "send a bearer token header" },
  { id: "oauth-doc", title: "OAuth Dance", body: "oauth authorization code" },
  { id: "openid-only", title: "Connect Notes", body: "openid connect login notes" },
  { id: "bearer-only", title: "Bearer Notes", body: "the bearer of bad news" },
  { id: "token-only", title: "Token Notes", body: "pagination token" },
  { id: "unrelated", title: "Unrelated", body: "gardening tips" },
  { id: "http-body", title: "Request Notes", body: "http methods and status codes" },
];

function plugins(entries = appsecDict) {
  return [morphology(), dictionary({ entries })];
}

async function engine(entries = appsecDict, extraDocs = docs, retriever) {
  const e = SearchEngine.create({
    schema: {
      title: { type: "text", role: "title" },
      body: { type: "text", role: "body" },
    },
    plugins: plugins(entries),
    ...(retriever ? { retriever } : {}),
  });
  await e.index(extraDocs);
  return e;
}

describe("topical recall lookup", () => {
  test("tokenized phrases compile, duplicates drop, malformed forms are rejected", () => {
    expect(
      normalizeTopicalRecall([
        ["Authentication"],
        ["authentication"],
        ["bearer", "token"],
        ["bearer token"],
        "oauth",
        [],
        ["  "],
        ["bearer", " token "],
      ])
    ).toEqual([["authentication"], ["bearer", "token"]]);

    const plugin = dictionaryPlugin({
      entries: [
        {
          key: "appsec",
          expansion: ["application", "security"],
          topicalRecall: [
            ["authentication"],
            ["authentication"],
            ["", "x"],
            "oauth",
            ["bearer", "token"],
          ],
        },
      ],
    });
    expect(plugin.entries[0].topicalRecall).toEqual([["authentication"], ["bearer", "token"]]);
    expect(plugin.topicalRecallByKey.get("appsec")).toEqual([["authentication"], ["bearer", "token"]]);
  });

  test("non-array topicalRecall fails closed to empty", () => {
    const plugin = dictionaryPlugin({
      entries: [{ key: "appsec", expansion: ["application", "security"], topicalRecall: "authentication" }],
    });
    expect(plugin.entries[0].topicalRecall).toEqual([]);
    expect(plugin.topicalRecallByKey.has("appsec")).toBe(false);
  });
});

describe("topical recall analysis", () => {
  test("configured identity activates topical forms without mutating query representation", () => {
    const withTopical = plugins();
    const withoutTopical = plugins([
      { key: "appsec", expansion: ["application", "security"], aliases: [["app", "sec"]] },
    ]);
    for (const raw of ["appsec", "app sec", "application security"]) {
      const q = analyzeQuery(raw, { plugins: withTopical });
      const baseline = analyzeQuery(raw, { plugins: withoutTopical });
      expect(q.configuredSequenceIntent?.key).toBe("appsec");
      expect(q.topicalRecall).toEqual({
        key: "appsec",
        forms: [["authentication"], ["authorization"], ["bearer", "token"], ["oauth"]],
      });
      expect(q.tokens.map((t) => t.surface)).toEqual(baseline.tokens.map((t) => t.surface));
      expect(q.tokens.map((t) => t.normalized)).toEqual(baseline.tokens.map((t) => t.normalized));
      expect(q.lexicalTokens.map((t) => t.normalized)).toEqual(baseline.lexicalTokens.map((t) => t.normalized));
      expect(q.lexicalPhraseKey).toBe(baseline.lexicalPhraseKey);
      expect(q.configuredSequenceIntent).toEqual(baseline.configuredSequenceIntent);
      expect(q.concepts.map((c) => ({ id: c.id, kind: c.kind }))).toEqual(
        baseline.concepts.map((c) => ({ id: c.id, kind: c.kind }))
      );
      expect(q.standaloneRecall ?? null).toBeNull();
    }
    expect(stage3AUnsupportedReason(analyzeQuery("app sec", { plugins: withTopical }))).toBe("topical-recall");
  });

  test("bare security and topical words do not reverse-activate appsec", () => {
    for (const raw of ["security", "authentication", "authorization", "bearer token"]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      expect(q.configuredSequenceIntent?.key ?? null).not.toBe("appsec");
      expect(q.topicalRecall?.key ?? null).not.toBe("appsec");
    }
    const oauth = analyzeQuery("oauth", { plugins: plugins() });
    expect(oauth.configuredSequenceIntent?.key).toBe("oauth");
    expect(oauth.topicalRecall).toEqual({ key: "oauth", forms: [["openid"], ["redirect"]] });
  });

  test("concept without topical config is unchanged", () => {
    const q = analyzeQuery("http", { plugins: plugins() });
    expect(q.configuredSequenceIntent?.key).toBe("http");
    expect(q.topicalRecall ?? null).toBeNull();
  });
});

describe("topical recall retrieval and ranking", () => {
  test("unions topical candidates, preserves phrase semantics, and keeps direct first", async () => {
    const e = await engine();
    const q = e._prepareQuery("app sec");
    const hits = retrieveCandidates(q, e._index);
    const ids = hits.map((h) => h.document.id).sort();
    expect(ids).toEqual(["authn", "authz", "direct", "oauth-doc", "phrase"]);
    expect(ids).not.toContain("openid-only");
    expect(ids).not.toContain("bearer-only");
    expect(ids).not.toContain("token-only");
    expect(ids).not.toContain("unrelated");

    const phrase = hits.find((h) => h.document.id === "phrase");
    const authn = hits.find((h) => h.document.id === "authn");
    const direct = hits.find((h) => h.document.id === "direct");
    expect(phrase.retrievalSources).toContain("topical-recall");
    expect(authn.retrievalSources).toContain("topical-recall");
    expect(direct.retrievalSources).toContain("configured-equivalence");

    const detailed = e.searchDetailed("app sec", { limit: 10, explain: true });
    expect(detailed.results[0].id).toBe("direct");
    expect(detailed.results[0].explanation.query.configuredSequenceIntent.key).toBe("appsec");
    expect(detailed.results[0].explanation.query.topicalRecall).toEqual({
      key: "appsec",
      forms: [["authentication"], ["authorization"], ["bearer", "token"], ["oauth"]],
    });
    expect(detailed.results[0].explanation.query.tokens.map((t) => t.surface)).toEqual(["app", "sec"]);
    const topicalOnly = detailed.results.filter((row) => row.id !== "direct");
    expect(topicalOnly.length).toBeGreaterThan(0);
    expect(topicalOnly.every((row) => row.retrievalSources.includes("topical-recall"))).toBe(true);
    expect(topicalOnly.every((row) => row.features.topicalRecallMatch)).toBe(true);
    expect(detailed.results[0].features.configuredEquivalenceMatch).toBeTruthy();
  });

  test("does not recursively activate another concept's topical map", async () => {
    const e = await engine();
    const hits = retrieveCandidates(e._prepareQuery("appsec"), e._index);
    expect(hits.some((h) => h.document.id === "oauth-doc")).toBe(true);
    expect(hits.some((h) => h.document.id === "openid-only")).toBe(false);
  });

  test("reverse queries do not inherit appsec topical provenance", async () => {
    const e = await engine();
    for (const raw of ["authentication", "authorization", "bearer token"]) {
      const q = e._prepareQuery(raw);
      expect(q.topicalRecall ?? null).toBeNull();
      const hits = retrieveCandidates(q, e._index);
      expect(hits.every((h) => !h.retrievalSources.includes("topical-recall"))).toBe(true);
    }
    const oauth = e._prepareQuery("oauth");
    expect(oauth.topicalRecall?.key).toBe("oauth");
    expect(oauth.topicalRecall?.forms).toEqual([["openid"], ["redirect"]]);
    const oauthHits = retrieveCandidates(oauth, e._index);
    expect(oauthHits.some((h) => h.document.id === "openid-only")).toBe(true);
    expect(oauthHits.every((h) => !((h.retrievalSources || []).includes("topical-recall") && h.document.id === "authn"))).toBe(true);
  });

  test("search and searchDetailed public ids match", async () => {
    const e = await engine();
    expect(e.search("app sec").map((row) => row.id)).toEqual(
      e.searchDetailed("app sec").results.map((row) => row.id)
    );
  });

  test("indexed and full-scan agree", async () => {
    const make = (retriever) =>
      SearchEngine.create({
        schema: { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } },
        plugins: plugins(),
        retriever,
      });
    const full = make("full-scan");
    const indexed = make("indexed");
    await full.index(docs);
    await indexed.index(docs);
    expect(indexed.search("app sec").map((row) => row.id)).toEqual(full.search("app sec").map((row) => row.id));
    expect(indexed.search("application security").map((row) => row.id)).toEqual(
      full.search("application security").map((row) => row.id)
    );
  });

  test("standalone recall remains independent", async () => {
    const e = await engine();
    const q = e._prepareQuery("hypertext");
    expect(q.standaloneRecall).toMatchObject({ key: "http", sourceToken: "hypertext" });
    expect(q.topicalRecall ?? null).toBeNull();
    const hits = retrieveCandidates(q, e._index);
    expect(hits.some((h) => h.document.id === "http-body")).toBe(true);
    expect(hits.every((h) => !h.retrievalSources.includes("topical-recall"))).toBe(true);
  });
});
