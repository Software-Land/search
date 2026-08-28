/**
 * Exact configured-key precedence, one-token alias exact-only occupancy,
 * short-key vs prefix-guessing, and same-concept result equivalence.
 */
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import { analyzeQuery } from "../dist/analyze.js";
import { resolveConfiguredSequence } from "../dist/configuredSequence.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

function plugins(entries) {
  return [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: entries })];
}

function intentOf(raw, entries) {
  const q = analyzeQuery(raw, { plugins: plugins(entries) });
  return q.configuredSequenceIntent?.key ?? null;
}

function resolutionOf(raw, entries) {
  const plugin = compileConfiguredConceptPlugin({ configuredConcepts: entries });
  const q = analyzeQuery(raw, { plugins: [morphology(), plugin] });
  return resolveConfiguredSequence(q.tokens, plugin);
}

function publicView(engine, analyzePlugins, raw, limit = 20) {
  const analyzed = analyzeQuery(raw, { plugins: analyzePlugins });
  const detailed = engine.searchDetailed(raw, { limit, relatedLimit: 8 });
  return {
    key: analyzed.configuredSequenceIntent?.key ?? null,
    lexical: (analyzed.lexicalTokens || []).map((t) => t.normalized),
    surface: analyzed.tokens.map((t) => t.surface),
    candidateCount: detailed.meta.candidateCount,
    ids: detailed.results.map((h) => h.id),
    scores: detailed.results.map((h) => h.score),
    relevanceKind: detailed.results.map((h) => h.relevanceKind),
    directClass: detailed.results.map((h) => h.directClass),
    relatedIds: (detailed.related || []).map((h) => h.id),
    primary: detailed.results[0]?.id ?? null,
  };
}

function expectSameResults(a, b) {
  expect(a.key).toBe(b.key);
  expect(a.candidateCount).toBe(b.candidateCount);
  expect(a.ids).toEqual(b.ids);
  expect(a.scores).toEqual(b.scores);
  expect(a.relevanceKind).toEqual(b.relevanceKind);
  expect(a.directClass).toEqual(b.directClass);
  expect(a.relatedIds).toEqual(b.relatedIds);
  expect(a.primary).toBe(b.primary);
}

const collisionEntries = [
  { key: "ai", aliases: [["artificial", "intelligence"]] },
  { key: "aid", aliases: [["aid", "system"], ["ai"]] },
];

describe("exact configured key beats a foreign one-token alias", () => {
  test("query ai occupies ai, not aid or ambiguous", () => {
    expect(intentOf("ai", collisionEntries)).toBe("ai");
    const res = resolutionOf("ai", collisionEntries);
    expect(res.status).toBe("unique");
    expect(res.intent.key).toBe("ai");
    expect(res.intent.matchedKinds).toContain("key");
  });

  test("one-token foreign alias prefix does not occupy", () => {
    expect(intentOf("a", collisionEntries)).toBeNull();
    expect(resolutionOf("a", collisionEntries).status).toBe("none");
  });

  test("exact foreign alias still occupies when it does not collide with a key", () => {
    const entries = [
      { key: "aid", aliases: [["aid", "system"], ["helper"]] },
    ];
    expect(intentOf("helper", entries)).toBe("aid");
    expect(intentOf("hel", entries)).toBeNull();
  });

  test("two foreign one-token aliases of the same typed form fail closed", () => {
    const entries = [
      { key: "aid", aliases: [["aid", "system"], ["ai"]] },
      { key: "aim", aliases: [["aim", "model"], ["ai"]] },
    ];
    const res = resolutionOf("ai", entries);
    expect(res.status).toBe("ambiguous");
    expect(new Set(res.keys)).toEqual(new Set(["aid", "aim"]));
    expect(intentOf("ai", entries)).toBeNull();
  });

  test("two distinct exact keys are not collapsed by precedence", () => {
    const entries = [
      { key: "http", aliases: [["hypertext", "transfer", "protocol"]] },
      { key: "https", aliases: [["hypertext", "transfer", "protocol", "secure"]] },
    ];
    expect(intentOf("http", entries)).toBe("http");
    expect(intentOf("https", entries)).toBe("https");
    expect(intentOf("http", entries)).not.toBe("https");
  });

  test("two genuine exact key identities for the same typed form fail closed", () => {
    const plugin = compileConfiguredConceptPlugin({ configuredConcepts: [
        { key: "ai", aliases: [["artificial", "intelligence"]] },
        { key: "aid", aliases: [["aid", "system"]] },
      ],
    });
    const aid = plugin.byKey.get("aid");
    plugin.sequences.push({ kind: "key", tokens: ["ai"], concept: aid });
    const q = analyzeQuery("ai", { plugins: [morphology(), plugin] });
    const res = resolveConfiguredSequence(q.tokens, plugin);
    expect(res.status).toBe("ambiguous");
    expect(new Set(res.keys)).toEqual(new Set(["ai", "aid"]));
    expect(q.configuredSequenceIntent?.key ?? null).toBeNull();
  });
});

describe("short configured keys occupy exactly; prefixes stay bounded", () => {
  const entries = [
    { key: "a", aliases: [["alpha"]] },
    { key: "ab", aliases: [["alpha", "beta"]] },
    { key: "abc", aliases: [["alpha", "beta", "gamma"]] },
    { key: "jwt", aliases: [["json", "web", "token"]] },
  ];

  test("exact 1/2/3-character keys occupy", () => {
    expect(intentOf("a", entries)).toBe("a");
    expect(intentOf("ab", entries)).toBe("ab");
    expect(intentOf("abc", entries)).toBe("abc");
  });

  test("one-character prefix of a longer key does not occupy that key", () => {
    const onlyJwt = [{ key: "jwt", aliases: [["json", "web", "token"]] }];
    expect(intentOf("j", onlyJwt)).toBeNull();
  });

  test("two-character prefix of a longer key stays behind the short-prefix bound", () => {
    const onlyJwt = [{ key: "jwt", aliases: [["json", "web", "token"]] }];
    expect(intentOf("jw", onlyJwt)).toBeNull();
    expect(intentOf("jwt", onlyJwt)).toBe("jwt");
  });
});

describe("n>=2 contextual last-prefix remains", () => {
  const entries = [
    { key: "cd", aliases: [["continuous", "deployment"]] },
    { key: "ci", aliases: [["continuous", "integration"]] },
    { key: "cicd", aliases: [["continuous", "integration", "continuous", "deployment"], ["ci", "cd"], ["ci"], ["cd"]] },
    { key: "api", aliases: [["application", "programming", "interface"]] },
  ];

  test("continuous d occupies cd and continuous i occupies ci", () => {
    expect(intentOf("continuous d", entries)).toBe("cd");
    expect(intentOf("continuous i", entries)).toBe("ci");
  });

  test("application p occupies api", () => {
    expect(intentOf("application p", entries)).toBe("api");
  });

  test("exact ci/cd occupy their keys despite cicd aliases", () => {
    expect(intentOf("ci", entries)).toBe("ci");
    expect(intentOf("cd", entries)).toBe("cd");
    expect(intentOf("c", entries)).toBeNull();
  });
});

describe("same-concept key/alias result equivalence", () => {
  const entries = [
    { key: "ai", aliases: [["artificial", "intelligence"], ["machine", "intellect"]] },
  ];
  const docs = [
    { id: "ai-short", title: "AI", body: "the letters a and i appear here" },
    { id: "ai-long", title: "Artificial Intelligence", body: "machine intellect research" },
    { id: "aid-trap", title: "AIDA", body: "aida prefix trap for two-character ai" },
    { id: "noise", title: "Authorization", body: "oauth tokens" },
  ];
  const plug = plugins(entries);

  async function make(retriever) {
    const engine = SearchEngine.create({ schema, plugins: plug, retriever });
    await engine.index(docs);
    return engine;
  }

  test("key, canonical alias, and alternate alias share ranked results", async () => {
    const engine = await make("full-scan");
    const key = publicView(engine, plug, "ai");
    const canonical = publicView(engine, plug, "artificial intelligence");
    const alternate = publicView(engine, plug, "machine intellect");
    expect(key.key).toBe("ai");
    expect(canonical.key).toBe("ai");
    expect(alternate.key).toBe("ai");
    expect(key.surface).toEqual(["ai"]);
    expect(canonical.surface).toEqual(["artificial", "intelligence"]);
    expectSameResults(key, canonical);
    expectSameResults(key, alternate);
    expect(key.ids[0]).toBe("ai-long");
  });

  test("indexed and adaptive preserve same-concept parity", async () => {
    for (const retriever of ["indexed", "adaptive"]) {
      const engine = await make(retriever);
      const key = publicView(engine, plug, "ai");
      const canonical = publicView(engine, plug, "artificial intelligence");
      expectSameResults(key, canonical);
    }
  });
});
