import { SearchEngine, morphology } from "../dist/index.js";
import { tokenize } from "../dist/text/text.js";
import { analyzeQuery } from "../dist/query/analyze.js";
import { retrieveCandidates } from "../dist/retrieval/retrieve.js";
import { normalizeTopicalRecall } from "../dist/relationships/configuredConcepts.js";
import { bodyPostingPruningUnsupportedReason } from "../dist/retrieval/exactBlockSkip.js";
import { configuredConceptPluginFromLegacy } from "./helpers/authored.js";

const appsecDict = [
  {
    key: "appsec",
    aliases: [["application", "security"], ["app", "sec"]],
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
  return [morphology(), configuredConceptPluginFromLegacy(entries)];
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

    const plugin = configuredConceptPluginFromLegacy([
      {
        key: "appsec",
        aliases: [["application", "security"]],
        topicalRecall: [
          ["authentication"],
          ["authentication"],
          ["", "x"],
          "oauth",
          ["bearer", "token"],
        ],
      },
    ]);
    expect(plugin.topicalRecallByKey.get("appsec")).toEqual([["authentication"], ["bearer", "token"]]);
    expect(plugin.byKey.get("appsec")).not.toHaveProperty("topicalRecall");
  });

  test("non-array topicalRecall fails closed to empty", () => {
    const plugin = configuredConceptPluginFromLegacy([
      { key: "appsec", aliases: [["application", "security"]], topicalRecall: "authentication" },
    ]);
    expect(plugin.topicalRecallByKey.has("appsec")).toBe(false);
    expect(plugin.byKey.get("appsec")).not.toHaveProperty("topicalRecall");
  });
});

describe("topical recall analysis", () => {
  test("configured concept activates topical forms without mutating query representation", () => {
    const withTopical = plugins();
    const withoutTopical = plugins([
      { key: "appsec", aliases: [["application", "security"], ["app", "sec"]] },
    ]);
    for (const raw of ["appsec", "app sec", "application security"]) {
      const q = analyzeQuery(raw, { plugins: withTopical });
      const baseline = analyzeQuery(raw, { plugins: withoutTopical });
      expect(q.configuredSequenceIntent?.key).toBe("appsec");
      expect(q.topicalRecall).toEqual({
        key: "appsec",
        forms: [["authentication"], ["authorization"], ["bearer", "token"], ["oauth"], ["open", "authorization"]],
        primaryForms: [],
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
    expect(bodyPostingPruningUnsupportedReason(analyzeQuery("app sec", { plugins: withTopical }))).toBe("topical-recall");
  });

  test("bare security and topical words do not reverse-activate appsec", () => {
    for (const raw of ["security", "authentication", "authorization", "bearer token"]) {
      const q = analyzeQuery(raw, { plugins: plugins() });
      expect(q.configuredSequenceIntent?.key ?? null).not.toBe("appsec");
      expect(q.topicalRecall?.key ?? null).not.toBe("appsec");
    }
    const oauth = analyzeQuery("oauth", { plugins: plugins() });
    expect(oauth.configuredSequenceIntent?.key).toBe("oauth");
    expect(oauth.topicalRecall).toEqual({ key: "oauth", forms: [["openid"], ["redirect"]], primaryForms: [] });
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
    expect(direct.retrievalSources).toContain("configured-concept");

    const detailed = e.searchDetailed("app sec", { limit: 10, explain: true });
    expect(detailed.results[0].id).toBe("direct");
    expect(detailed.results[0].explanation.query.configuredSequenceIntent.key).toBe("appsec");
    expect(detailed.results[0].explanation.query.topicalRecall).toEqual({
      key: "appsec",
      forms: [["authentication"], ["authorization"], ["bearer", "token"], ["oauth"], ["open", "authorization"]],
      primaryForms: [],
    });
    expect(detailed.results[0].explanation.query.tokens.map((t) => t.surface)).toEqual(["app", "sec"]);
    const topicalOnly = detailed.results.filter((row) => row.id !== "direct");
    expect(topicalOnly.length).toBeGreaterThan(0);
    expect(topicalOnly.every((row) => row.retrievalSources.includes("topical-recall"))).toBe(true);
    expect(topicalOnly.every((row) => row.features.topicalRecallMatch)).toBe(true);
    expect(detailed.results[0].features.configuredConceptMatch).toBeTruthy();
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

describe("topical concept forms against manufactured and incidental evidence", () => {
  const entries = [
    { key: "widget", aliases: [["widget", "concept"]], topicalRecall: [["large", "language", "model"]] },
    { key: "acme", aliases: [["large", "language", "model"]], topicalRecall: [["other", "thing"]] },
    { key: "other", aliases: [["other", "thing"]] },
  ];
  const docs = [
    { id: "0-incidental", title: "Notes", body: "widget appears once" },
    { id: "1-topical-body", title: "Overview", body: "a large language model overview" },
    { id: "2-topical-title", title: "Acme Primer", body: "format conversion notes" },
    { id: "3-words", title: "Large", body: "language and model appear apart" },
    { id: "4-recursive", title: "Other Thing", body: "unrelated notes" },
    { id: "8-repeated", title: "Repeats", body: "widget then later widget again" },
    { id: "9-strong", title: "Widget", body: "unrelated gardening" },
  ];

  test("bracket syntax does not manufacture a token", () => {
    expect(tokenize("A[i]")).toEqual(["a", "i"]);
    expect(tokenize("D[i] = A[i] - A[i - 1]")).not.toContain("ai");
    expect(tokenize("AI will be used")).toContain("ai");
  });

  test("a related phrase resolves its configured acronym without splitting the phrase", () => {
    const q = analyzeQuery("widget", { plugins: plugins(entries) });
    expect(q.topicalRecall).toEqual({
      key: "widget",
      forms: [["large", "language", "model"], ["acme"]],
      primaryForms: [],
    });
    expect(q.equivalentRecall || []).toEqual([]);
    expect(q.topicalRecall.forms).not.toEqual(expect.arrayContaining([["large"]]));
    expect(q.topicalRecall.forms).not.toEqual(expect.arrayContaining([["language"]]));
    expect(q.topicalRecall.forms).not.toEqual(expect.arrayContaining([["model"]]));
    expect(q.topicalRecall.forms).not.toEqual(expect.arrayContaining([["other"]]));
    expect(q.topicalRecall.forms).not.toEqual(expect.arrayContaining([["other", "thing"]]));
    expect(q.topicalRecall.forms).not.toEqual(expect.arrayContaining([["widget"]]));

    const reverse = analyzeQuery("acme", { plugins: plugins(entries) });
    expect(reverse.topicalRecall).toEqual({
      key: "acme",
      forms: [["other", "thing"], ["other"]],
      primaryForms: [],
    });
    expect(reverse.topicalRecall.forms).not.toEqual(expect.arrayContaining([["widget"]]));
    expect(reverse.equivalentRecall || []).toEqual([]);
  });

  test("an ambiguous concept owner stays the authored phrase", () => {
    const q = analyzeQuery("widget", {
      plugins: plugins([
        { key: "widget", aliases: [["widget", "concept"]], topicalRecall: [["shared", "phrase"]] },
        { key: "left", aliases: [["shared", "phrase"]] },
        { key: "right", aliases: [["shared", "phrase"]] },
      ]),
    });
    expect(q.topicalRecall.forms).toEqual([["shared", "phrase"]]);
  });

  test("topical title outranks one weak body mention and stays behind strong and repeated evidence", async () => {
    const make = (retriever) => engine(entries, docs, retriever);
    const full = await make("full-scan");
    const indexed = await make("indexed");
    for (const e of [full, indexed]) {
      const detailed = e.searchDetailed("widget", { limit: 20, explain: true });
      expect(detailed.results.map((row) => row.id)).toEqual([
        "9-strong",
        "8-repeated",
        "2-topical-title",
        "0-incidental",
        "1-topical-body",
      ]);
      const byId = Object.fromEntries(detailed.results.map((row) => [row.id, row]));
      expect(byId["9-strong"].directClass).toBe("strong");
      expect(byId["8-repeated"].directClass).toBe("weak");
      expect(byId["8-repeated"].features.bodyPhraseCount).toBe(0);
      expect(byId["8-repeated"].features.directBodyOccurrenceCount).toBe(2);
      expect(byId["0-incidental"].features.directBodyOccurrenceCount).toBe(1);
      expect(byId["0-incidental"].directClass).toBe("weak");
      expect(byId["2-topical-title"].retrievalSources).toEqual(["topical-recall"]);
      expect(byId["2-topical-title"].features.topicalRecallTitleMatch).toBe(true);
      expect(byId["2-topical-title"].features.queryCoverage).toBe(0);
      expect(byId["2-topical-title"].features.bodyLexicalMatch).toBe(0);
      expect(byId["2-topical-title"].features.equivalentRecallMatch).toBeFalsy();
      expect(byId["1-topical-body"].features.topicalRecallTitleMatch).toBe(false);
      expect(byId["1-topical-body"].features.topicalRecallPhraseMatch).toBe(true);
      expect(e.search("widget").map((row) => row.id)).toEqual(detailed.results.map((row) => row.id));
    }
    expect(indexed.search("widget").map((row) => row.id)).toEqual(full.search("widget").map((row) => row.id));

    const reverse = full.searchDetailed("acme", { limit: 20, explain: true });
    expect(reverse.results.map((row) => row.id)).not.toContain("0-incidental");
    expect(reverse.results.map((row) => row.id)).toContain("4-recursive");
    expect(reverse.results.find((row) => row.id === "4-recursive").retrievalSources).toEqual(["topical-recall"]);
    expect(full.search("widget").map((row) => row.id)).not.toContain("4-recursive");
    expect(full.search("widget").map((row) => row.id)).not.toContain("3-words");
  });
});
